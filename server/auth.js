'use strict';

const crypto = require('node:crypto');
const { db, audit } = require('./db');
const { HttpError, badRequest, nowIso } = require('./util');

const COOKIE = 'vbsid';
const SESSION_HOURS = 12;
const MIN_PASSWORD = 8;

// scrypt: chậm có chủ ý, để dò mật khẩu bằng vét cạn không khả thi.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(plain, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

function verifyPassword(plain, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  let actual;
  try {
    actual = crypto.scryptSync(plain, salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function checkPasswordStrength(plain) {
  const s = String(plain == null ? '' : plain);
  if (s.length < MIN_PASSWORD) {
    throw badRequest('Mật khẩu cần ít nhất ' + MIN_PASSWORD + ' ký tự.');
  }
  if (s.length > 200) throw badRequest('Mật khẩu quá dài.');
  return s;
}

/** Mật khẩu tạm thời dễ đọc: bỏ các ký tự dễ nhìn lẫn (0/O, 1/l/I). */
function generatePassword(len = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += chars[crypto.randomInt(chars.length)];
  }
  return out;
}

// ---------------------------------------------------------------- sessions

function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const i = part.indexOf('=');
      if (i < 0) return;
      const k = part.slice(0, i).trim();
      if (!k) return;
      try {
        out[k] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        out[k] = part.slice(i + 1).trim();
      }
    });
  return out;
}

function createSession(res, userId, secureCookie) {
  const id = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000);
  db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
  ).run(id, userId, nowIso(), expires.toISOString());

  const bits = [
    COOKIE + '=' + id,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=' + SESSION_HOURS * 3600,
  ];
  if (secureCookie) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
  return id;
}

function destroySession(res, sessionId, secureCookie) {
  if (sessionId) db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
  const bits = [COOKIE + '=', 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secureCookie) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

function purgeExpiredSessions() {
  db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(nowIso());
}

const userBySessionStmt = db.prepare(
  `SELECT u.id, u.username, u.full_name, u.title, u.email, u.role,
          u.must_change_password, u.locked, u.last_login_at,
          s.id AS session_id, s.expires_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
    WHERE s.id = ?`
);

/** Gắn req.user nếu cookie phiên còn hợp lệ. Không chặn request. */
function attachUser(req, res, next) {
  req.cookiesParsed = parseCookies(req.headers.cookie);
  const sid = req.cookiesParsed[COOKIE];
  req.sessionId = sid || null;
  req.user = null;
  if (!sid) return next();

  const row = userBySessionStmt.get(sid);
  if (!row) return next();
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
    return next();
  }
  // Tài khoản bị khóa trong lúc đang đăng nhập: chấm dứt phiên ngay.
  if (row.locked) {
    db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(row.id);
    return next();
  }
  req.user = {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    title: row.title,
    email: row.email,
    role: row.role,
    mustChangePassword: !!row.must_change_password,
    lastLoginAt: row.last_login_at,
  };
  return next();
}

function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Chưa đăng nhập.', 'unauthenticated'));
  return next();
}

/**
 * Chặn ở phía máy chủ theo vai trò. Việc ẩn tab trên giao diện chỉ là tiện lợi;
 * đây mới là ranh giới quyền thật sự.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Chưa đăng nhập.', 'unauthenticated'));
    if (!roles.includes(req.user.role)) {
      return next(
        new HttpError(403, 'Tài khoản của bạn không có quyền thực hiện việc này.', 'forbidden')
      );
    }
    return next();
  };
}

/** Buộc đổi mật khẩu trước khi dùng các chức năng khác. */
function requirePasswordSettled(req, res, next) {
  if (req.user && req.user.mustChangePassword) {
    return next(
      new HttpError(403, 'Bạn cần đổi mật khẩu trước khi tiếp tục.', 'must_change_password')
    );
  }
  return next();
}

/**
 * Chặn CSRF: trình duyệt không thể đặt header tự chọn cho request khác nguồn
 * mà không qua preflight CORS, và máy chủ này không bật CORS. Cộng với cookie
 * SameSite=Strict là đủ cho triển khai trong mạng nội bộ.
 */
function requireSameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.get('X-VB-Request') !== '1') {
    return next(new HttpError(403, 'Yêu cầu không hợp lệ.', 'csrf'));
  }
  return next();
}

// ------------------------------------------------------- chống dò mật khẩu

const attempts = new Map();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;

function loginKey(req, username) {
  return (req.ip || 'ip?') + '|' + String(username || '').toLowerCase();
}

function tooManyAttempts(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function noteFailedAttempt(key) {
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
    return;
  }
  rec.count += 1;
}

function clearAttempts(key) {
  attempts.delete(key);
}

setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [k, v] of attempts) if (v.first < cutoff) attempts.delete(k);
  purgeExpiredSessions();
}, 10 * 60 * 1000).unref();

// -------------------------------------------------------------------------

/** Số quản trị viên đang hoạt động — dùng để không bao giờ khóa hết cửa. */
function activeAdminCount(excludeUserId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM users
        WHERE role = 'admin' AND locked = 0 AND id IS NOT ?`
    )
    .get(excludeUserId ?? null);
  return row.n;
}

module.exports = {
  COOKIE,
  MIN_PASSWORD,
  hashPassword,
  verifyPassword,
  checkPasswordStrength,
  generatePassword,
  createSession,
  destroySession,
  purgeExpiredSessions,
  attachUser,
  requireAuth,
  requireRole,
  requirePasswordSettled,
  requireSameOrigin,
  loginKey,
  tooManyAttempts,
  noteFailedAttempt,
  clearAttempts,
  activeAdminCount,
  audit,
};
