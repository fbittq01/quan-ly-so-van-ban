#!/usr/bin/env node
'use strict';

/**
 * Sao lưu sổ văn bản.
 *
 * Dùng `VACUUM INTO` chứ không copy trần file .db: ở chế độ WAL, các giao dịch
 * vừa xong còn nằm trong vanban.db-wal, nên copy trần file chính có thể ra bản
 * thiếu giao dịch hoặc bản lỗi. VACUUM INTO để SQLite tự dựng một file mới
 * nhất quán, chạy được ngay lúc đang có người dùng hệ thống.
 *
 *   npm run backup
 *   npm run backup -- --out /mnt/nas/sao-luu-van-ban
 */

require('../env');

const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR, UPLOAD_DIR } = require('../db');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

const outRoot = path.resolve(arg('out', path.join(DATA_DIR, '..', 'backups')));
const stamp = new Date()
  .toISOString()
  .replace(/[:]/g, '-')
  .replace('T', '_')
  .slice(0, 16);
const dest = path.join(outRoot, stamp);

if (fs.existsSync(dest)) {
  console.error('Lỗi: thư mục sao lưu đã tồn tại: ' + dest);
  process.exit(1);
}
fs.mkdirSync(dest, { recursive: true });

const dbTarget = path.join(dest, 'vanban.db');
db.prepare('VACUUM INTO ?').run(dbTarget);

let files = 0;
let bytes = 0;
if (fs.existsSync(UPLOAD_DIR)) {
  const entries = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true }).filter((e) => e.isFile());
  if (entries.length > 0) {
    fs.cpSync(UPLOAD_DIR, path.join(dest, 'uploads'), { recursive: true });
    for (const e of entries) {
      files += 1;
      bytes += fs.statSync(path.join(UPLOAD_DIR, e.name)).size;
    }
  }
}

const dbBytes = fs.statSync(dbTarget).size;
const mb = (n) => (n / (1024 * 1024)).toFixed(2) + ' MB';

console.log('Đã sao lưu vào: ' + dest);
console.log('  vanban.db : ' + mb(dbBytes) + ' (toàn bộ sổ, tài khoản, cài đặt, nhật ký)');
console.log('  uploads/  : ' + files + ' file đính kèm, ' + mb(bytes));
console.log('');
console.log('Để phục hồi: dừng ứng dụng, copy hai mục trên vào thư mục data/, chạy lại.');
