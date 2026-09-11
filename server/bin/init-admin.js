#!/usr/bin/env node
'use strict';

/**
 * Tạo tài khoản quản trị đầu tiên, hoặc cấp lại mật khẩu cho một quản trị viên
 * đã có. Đây là đường duy nhất để có tài khoản mà không cần đăng nhập trước —
 * và nó chỉ chạy được từ dòng lệnh trên chính máy chủ.
 *
 *   npm run init-admin -- --username admin --name "Lê Quốc Bảo" --title "Chánh Văn phòng"
 *   npm run init-admin -- --username admin --reset-password
 */

require('../env');

const { db, audit } = require('../db');
const auth = require('../auth');
const { nowIso, text } = require('../util');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function fail(message) {
  console.error('Lỗi: ' + message);
  process.exit(1);
}

const username = text(arg('username', 'admin'), 32).toLowerCase();
if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
  fail('Tên đăng nhập chỉ gồm chữ thường, số, dấu . _ - và dài từ 3 đến 32 ký tự.');
}

const existing = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username);
const resetOnly = arg('reset-password', false) === true;
const password = typeof arg('password', null) === 'string' ? arg('password', null) : auth.generatePassword(14);

try {
  auth.checkPasswordStrength(password);
} catch (err) {
  fail(err.message);
}

if (existing) {
  if (!resetOnly) {
    fail(
      'Tài khoản “' + username + '” đã tồn tại. Thêm --reset-password nếu muốn cấp lại mật khẩu.'
    );
  }
  db.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = 1, locked = 0, role = 'admin'
      WHERE id = ?`
  ).run(auth.hashPassword(password), existing.id);
  db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(existing.id);
  audit(null, 'init_admin_reset', username + ' (từ dòng lệnh)');
  console.log('Đã cấp lại mật khẩu và mở khóa quản trị viên.');
} else {
  if (resetOnly) fail('Không có tài khoản “' + username + '” để cấp lại mật khẩu.');
  const fullName = text(arg('name', 'Quản trị hệ thống'), 120);
  db.prepare(
    `INSERT INTO users
       (username, full_name, title, email, role, password_hash,
        must_change_password, locked, created_at, created_by)
     VALUES (?, ?, ?, ?, 'admin', ?, 1, 0, ?, NULL)`
  ).run(
    username,
    fullName,
    text(arg('title', ''), 160),
    text(arg('email', ''), 160),
    auth.hashPassword(password),
    nowIso()
  );
  audit(null, 'init_admin_create', username + ' (từ dòng lệnh)');
  console.log('Đã tạo tài khoản quản trị.');
}

console.log('');
console.log('  tên đăng nhập : ' + username);
console.log('  mật khẩu tạm  : ' + password);
console.log('');
console.log('Mật khẩu này chỉ hiện một lần và không được lưu ở dạng đọc được.');
console.log('Hệ thống sẽ bắt đổi mật khẩu ngay ở lần đăng nhập đầu tiên.');
