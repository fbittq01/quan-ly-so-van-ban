'use strict';

/**
 * Nạp biến môi trường từ .env nếu có, trước khi bất cứ module nào đọc
 * process.env. Biến đã đặt sẵn từ shell hay systemd luôn thắng .env.
 *
 * Tự phân tích thay vì dùng process.loadEnvFile (chỉ có từ Node 21) hay thư
 * viện ngoài, để chạy được từ Node 18 và không thêm phụ thuộc.
 */

const fs = require('node:fs');
const path = require('node:path');

const file = process.env.ENV_FILE
  ? path.resolve(process.env.ENV_FILE)
  : path.join(__dirname, '..', '.env');

if (fs.existsSync(file)) {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error('Không đọc được ' + file + ': ' + err.message);
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    // Cho phép bọc nháy để giữ khoảng trắng ở hai đầu; không bắt buộc.
    if (
      value.length >= 2 &&
      ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
