'use strict';

const express = require('express');
const { db, audit } = require('../db');
const auth = require('../auth');
const { text, badRequest, nowIso, HttpError, ROLES, ROLE_LABEL } = require('../util');

const router = express.Router();

// Chỉ quản trị viên. Người dùng không tự đăng ký được ở bất cứ đâu trong hệ thống.
router.use(auth.requireAuth, auth.requirePasswordSettled, auth.requireRole('admin'));

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

function rowToJson(r) {
  return {
    id: r.id,
    username: r.username,
    fullName: r.full_name,
    title: r.title,
    email: r.email,
    role: r.role,
    roleLabel: ROLE_LABEL[r.role],
    locked: !!r.locked,
    mustChangePassword: !!r.must_change_password,
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
  };
}

function listUsers() {
  return db
    .prepare(
      `SELECT * FROM users
        ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'vanthu' THEN 1 ELSE 2 END, username`
    )
    .all()
    .map(rowToJson);
}

function getUserOr404(id) {
  const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, 'Không tìm thấy tài khoản.', 'not_found');
  return row;
}

/**
 * Không cho phép hành động khiến hệ thống không còn quản trị viên nào đăng
 * nhập được. Nếu không có chốt này, một lần bấm nhầm là mất cả đường vào.
 */
function assertNotLastAdmin(target, what) {
  if (target.role !== 'admin' || target.locked) return;
  if (auth.activeAdminCount(target.id) === 0) {
    throw badRequest(
      'Đây là tài khoản Quản trị duy nhất đang hoạt động — không thể ' +
        what +
        '. Hãy cấp quyền Quản trị cho một tài khoản khác trước.',
      'last_admin'
    );
  }
}

router.get('/', (req, res) => {
  res.json({ users: listUsers(), me: req.user.id });
});

/** Mật khẩu tạm thời gợi ý cho hộp thoại thêm tài khoản. */
router.get('/suggest-password', (req, res) => {
  res.json({ password: auth.generatePassword() });
});

router.post('/', (req, res, next) => {
  try {
    const b = req.body || {};
    const username = text(b.username, 32).toLowerCase();
    if (!USERNAME_RE.test(username)) {
      throw badRequest(
        'Tên đăng nhập chỉ gồm chữ thường, số, dấu . _ - và dài từ 3 đến 32 ký tự.'
      );
    }
    if (db.prepare(`SELECT 1 FROM users WHERE username = ?`).get(username)) {
      throw badRequest('Tên đăng nhập “' + username + '” đã tồn tại.', 'duplicate');
    }
    const fullName = text(b.fullName, 120);
    if (!fullName) throw badRequest('Chưa nhập họ và tên.');

    const role = String(b.role || '');
    if (!ROLES.includes(role)) throw badRequest('Vai trò không hợp lệ.');

    const password = auth.checkPasswordStrength(b.password);

    const info = db
      .prepare(
        `INSERT INTO users
           (username, full_name, title, email, role, password_hash,
            must_change_password, locked, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        username,
        fullName,
        text(b.title, 160),
        text(b.email, 160),
        role,
        auth.hashPassword(password),
        b.mustChangePassword === false ? 0 : 1,
        nowIso(),
        req.user.id
      );

    audit(req.user, 'them_tai_khoan', username + ' · vai trò ' + ROLE_LABEL[role]);
    return res.status(201).json({
      user: rowToJson(getUserOr404(info.lastInsertRowid)),
      users: listUsers(),
    });
  } catch (err) {
    return next(err);
  }
});

router.put('/:id', (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const target = getUserOr404(id);
    const b = req.body || {};

    const fullName = text(b.fullName, 120);
    if (!fullName) throw badRequest('Chưa nhập họ và tên.');

    const role = String(b.role || target.role);
    if (!ROLES.includes(role)) throw badRequest('Vai trò không hợp lệ.');

    // Tự hạ quyền của mình là cách nhanh nhất để tự khóa mình ra ngoài.
    if (id === req.user.id && role !== target.role) {
      throw badRequest('Không thể tự đổi vai trò của chính mình.', 'self_role');
    }
    if (role !== 'admin' && target.role === 'admin') {
      assertNotLastAdmin(target, 'hạ quyền');
    }

    db.prepare(
      `UPDATE users SET full_name = ?, title = ?, email = ?, role = ? WHERE id = ?`
    ).run(fullName, text(b.title, 160), text(b.email, 160), role, id);

    audit(
      req.user,
      'sua_tai_khoan',
      target.username +
        (role !== target.role ? ' · vai trò ' + ROLE_LABEL[target.role] + ' → ' + ROLE_LABEL[role] : '')
    );
    return res.json({ user: rowToJson(getUserOr404(id)), users: listUsers() });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/lock', (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const target = getUserOr404(id);
    const locked = !!(req.body && req.body.locked);

    if (id === req.user.id && locked) {
      throw badRequest('Không thể tự khóa tài khoản của chính mình.', 'self_lock');
    }
    if (locked) assertNotLastAdmin(target, 'khóa');

    db.prepare(`UPDATE users SET locked = ? WHERE id = ?`).run(locked ? 1 : 0, id);
    // Khóa tài khoản phải cắt luôn phiên đang mở, không đợi phiên hết hạn.
    if (locked) db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(id);

    audit(req.user, locked ? 'khoa_tai_khoan' : 'mo_khoa_tai_khoan', target.username);
    return res.json({ user: rowToJson(getUserOr404(id)), users: listUsers() });
  } catch (err) {
    return next(err);
  }
});

/** Quản trị đặt lại mật khẩu: sinh mật khẩu tạm và buộc đổi ở lần đăng nhập sau. */
router.post('/:id/reset-password', (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const target = getUserOr404(id);
    const password = auth.generatePassword();

    db.prepare(
      `UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?`
    ).run(auth.hashPassword(password), id);
    db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(id);

    audit(req.user, 'dat_lai_mat_khau', target.username);
    // Mật khẩu tạm chỉ hiện một lần ở đây; hệ thống không lưu lại bản rõ.
    return res.json({ username: target.username, password, users: listUsers() });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const target = getUserOr404(id);

    if (id === req.user.id) {
      throw badRequest('Không thể tự xóa tài khoản của chính mình.', 'self_delete');
    }
    assertNotLastAdmin(target, 'xóa');

    const wrote = db
      .prepare(
        `SELECT COUNT(*) AS n FROM documents WHERE created_by = ? OR updated_by = ?`
      )
      .get(id, id).n;

    // Người đã từng ghi sổ thì khóa, không xóa: xóa sẽ làm mất dấu ai ghi văn bản.
    if (wrote > 0) {
      throw badRequest(
        'Tài khoản này đã ghi ' +
          wrote +
          ' văn bản trong sổ. Hãy khóa tài khoản thay vì xóa, để giữ dấu vết ai đã ghi sổ.',
        'has_history'
      );
    }

    db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
    audit(req.user, 'xoa_tai_khoan', target.username);
    return res.json({ ok: true, users: listUsers() });
  } catch (err) {
    return next(err);
  }
});

module.exports = { router, listUsers };
