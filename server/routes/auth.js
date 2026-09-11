'use strict';

const express = require('express');
const { db } = require('../db');
const auth = require('../auth');
const { text, badRequest, nowIso, HttpError, ROLE_LABEL } = require('../util');

const router = express.Router();

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    fullName: u.fullName,
    title: u.title,
    email: u.email,
    role: u.role,
    roleLabel: ROLE_LABEL[u.role],
    mustChangePassword: u.mustChangePassword,
    lastLoginAt: u.lastLoginAt,
  };
}

/** Ai đang đăng nhập. Trả về null thay vì 401 để trang tải được rồi mới hỏi. */
router.get('/me', (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.post('/login', (req, res, next) => {
  const username = text(req.body && req.body.username, 60).toLowerCase();
  const password = String((req.body && req.body.password) || '');
  const key = auth.loginKey(req, username);

  if (auth.tooManyAttempts(key)) {
    return next(
      new HttpError(
        429,
        'Đã nhập sai quá nhiều lần. Thử lại sau 10 phút hoặc liên hệ quản trị viên.',
        'rate_limited'
      )
    );
  }
  if (!username || !password) {
    return next(badRequest('Nhập tên đăng nhập và mật khẩu.'));
  }

  const row = db
    .prepare(
      `SELECT id, username, full_name, title, email, role, password_hash,
              must_change_password, locked, last_login_at
         FROM users WHERE username = ?`
    )
    .get(username);

  // Cùng một thông báo cho "không có tài khoản" và "sai mật khẩu", để không
  // tiết lộ tên đăng nhập nào tồn tại.
  const wrong = () => {
    auth.noteFailedAttempt(key);
    return next(new HttpError(401, 'Tên đăng nhập hoặc mật khẩu không đúng.', 'bad_credentials'));
  };

  if (!row) {
    // Vẫn tiêu tốn thời gian băm để hai nhánh mất thời gian tương đương.
    auth.verifyPassword(password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
    return wrong();
  }
  if (!auth.verifyPassword(password, row.password_hash)) return wrong();

  if (row.locked) {
    auth.noteFailedAttempt(key);
    return next(
      new HttpError(403, 'Tài khoản đã bị khóa. Liên hệ quản trị viên để mở lại.', 'locked')
    );
  }

  auth.clearAttempts(key);
  db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(nowIso(), row.id);
  auth.createSession(res, row.id, req.secure);
  auth.audit({ id: row.id, username: row.username }, 'dang_nhap', '');

  return res.json({
    user: publicUser({
      id: row.id,
      username: row.username,
      fullName: row.full_name,
      title: row.title,
      email: row.email,
      role: row.role,
      mustChangePassword: !!row.must_change_password,
      lastLoginAt: row.last_login_at,
    }),
  });
});

router.post('/logout', (req, res) => {
  if (req.user) auth.audit(req.user, 'dang_xuat', '');
  auth.destroySession(res, req.sessionId, req.secure);
  res.json({ ok: true });
});

/**
 * Tự đổi mật khẩu. Đây cũng là đường đi của cờ "bắt buộc đổi mật khẩu lần đầu",
 * nên route này KHÔNG đi qua requirePasswordSettled.
 */
router.post('/change-password', auth.requireAuth, (req, res, next) => {
  const current = String((req.body && req.body.currentPassword) || '');
  const next1 = String((req.body && req.body.newPassword) || '');

  const row = db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(req.user.id);
  if (!row || !auth.verifyPassword(current, row.password_hash)) {
    return next(badRequest('Mật khẩu hiện tại không đúng.'));
  }
  let fresh;
  try {
    fresh = auth.checkPasswordStrength(next1);
  } catch (err) {
    return next(err);
  }
  if (auth.verifyPassword(fresh, row.password_hash)) {
    return next(badRequest('Mật khẩu mới phải khác mật khẩu hiện tại.'));
  }

  db.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`
  ).run(auth.hashPassword(fresh), req.user.id);

  // Đăng xuất mọi phiên khác của chính người này; giữ lại phiên đang dùng.
  db.prepare(`DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?`).run(
    req.user.id,
    req.sessionId
  );
  auth.audit(req.user, 'doi_mat_khau', 'tự đổi');
  return res.json({ ok: true });
});

module.exports = { router, publicUser };
