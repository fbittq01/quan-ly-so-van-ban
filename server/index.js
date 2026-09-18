'use strict';

require('./env');

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { db } = require('./db');
const authLib = require('./auth');
const { HttpError, SECURITY_LEVELS, ROLE_LABEL, AUDIT_ACTION_LABEL } = require('./util');

const authRoutes = require('./routes/auth');
const docRoutes = require('./routes/docs');
const settingsRoutes = require('./routes/settings');
const bookRoutes = require('./routes/books');
const books = require('./books');
const userRoutes = require('./routes/users');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
// 0.0.0.0 để các máy khác trong mạng nội bộ vào được; đặt HOST=127.0.0.1 nếu
// chỉ muốn chạy trên chính máy này.
const HOST = process.env.HOST || '0.0.0.0';
const ORG_NAME = process.env.ORG_NAME || 'Phòng 1';

const app = express();
app.disable('x-powered-by');

// Bật khi đứng sau nginx/IIS làm proxy, để req.ip và req.secure đọc đúng.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.use((req, res, next) => {
  // Không tải gì từ bên ngoài: chạy được trong mạng nội bộ không có Internet,
  // và không có đường cho script lạ chen vào.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // blob: cho ảnh nhúng trong PDF mà pdf.js giải mã ra trước khi vẽ.
      "img-src 'self' data: blob:",
      "style-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "font-src 'self'",
      // Trình xem PDF tự vẽ chạy pdf.worker.min.mjs trong một Worker; nó nằm
      // ngay trong public/vendor/pdfjs nên 'self' là đủ, blob: để pdf.js dựng
      // worker dự phòng khi cần.
      "worker-src 'self' blob:",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(authLib.attachUser);
app.use(authLib.requireSameOrigin);

/** Hằng số cho giao diện: tên đơn vị, mức bảo mật, nhãn vai trò. */
app.get('/api/config', (req, res) => {
  res.json({
    orgName: ORG_NAME,
    securityLevels: SECURITY_LEVELS,
    roleLabels: ROLE_LABEL,
    auditLabels: AUDIT_ACTION_LABEL,
    maxFileBytes: docRoutes.MAX_FILE_BYTES,
    minPasswordLength: authLib.MIN_PASSWORD,
    currentYear: new Date().getFullYear(),
  });
});

app.use('/api', authRoutes.router);
app.use('/api/documents', docRoutes.router);
app.use('/api/settings', settingsRoutes.router);
app.use('/api/books', bookRoutes.router);
app.use('/api/users', userRoutes.router);

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// app.css/app.js được nhớ đệm 1 giờ, nên sau khi cập nhật người dùng vẫn có thể
// dùng bản cũ. index.html là no-cache, nên gắn ?v=<vân tay tệp> vào đường dẫn
// tài nguyên ngay trong index.html: đổi tệp là đổi đường dẫn, trình duyệt tải lại.
const ASSETS = ['fonts.css', 'app.css', 'app.js'];

function assetStamp(name) {
  try {
    const st = fs.statSync(path.join(PUBLIC_DIR, name));
    return Math.round(st.mtimeMs).toString(36) + '-' + st.size.toString(36);
  } catch {
    return '0';
  }
}

let indexCache = null;
function indexHtml() {
  const stamps = ASSETS.map(assetStamp);
  const key = stamps.join('|');
  if (!indexCache || indexCache.key !== key) {
    let html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    ASSETS.forEach((name, i) => {
      html = html.split('"/' + name + '"').join('"/' + name + '?v=' + stamps[i] + '"');
    });
    indexCache = { key, html };
  }
  return indexCache.html;
}

function sendIndex(req, res) {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(indexHtml());
}

app.get('/', sendIndex);

app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    etag: true,
    maxAge: '1h',
  })
);

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Không có API này.', code: 'not_found' });
});

// Mọi đường còn lại trả về trang chính; điều hướng nằm ở phía trình duyệt.
app.use(sendIndex);

app.use((err, req, res, _next) => {
  // Lỗi từ multer: đổi sang thông báo tiếng Việt hiểu được.
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      error:
        'File đính kèm vượt quá ' +
        Math.round(docRoutes.MAX_FILE_BYTES / (1024 * 1024)) +
        ' MB.',
      code: 'file_too_large',
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  if (err && err.status === 400 && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Dữ liệu gửi lên không đọc được.', code: 'bad_json' });
  }
  console.error('[loi]', err);
  return res.status(500).json({ error: 'Lỗi máy chủ. Xem log để biết chi tiết.', code: 'internal' });
});

function describeStartup() {
  const users = db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
  const admins = authLib.activeAdminCount();
  const docs = db.prepare(`SELECT COUNT(*) AS n FROM documents`).get().n;
  const list = books.all();
  const counts = books.counts();

  console.log('Quản lý số văn bản');
  console.log('  đơn vị      : ' + ORG_NAME);
  console.log('  địa chỉ     : http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
  console.log('  tài khoản   : ' + users + ' (quản trị đang hoạt động: ' + admins + ')');
  console.log('  văn bản     : ' + docs);
  // Mỗi sổ một dòng: mẫu số là của riêng từng sổ nên không gộp được thành một
  // dòng "mẫu số" chung như trước.
  list.forEach((b, i) => {
    const head = i === 0 ? '  sổ          : ' : '                ';
    const mau = b.kind === 'di'
      ? b.prefix + '<số>' + b.suffix + (b.resetYearly ? ' · reset đầu năm' : ' · tăng liên tục')
      : 'số theo cơ quan gửi';
    console.log(head + b.name + ' — ' + mau + ' · ' + (counts.get(b.id) || 0) + ' văn bản' +
      (b.hidden ? ' · NGỪNG DÙNG' : ''));
  });
  if (users === 0) {
    console.log('');
    console.log('  Chưa có tài khoản nào. Chạy:  npm run init-admin');
  } else if (admins === 0) {
    console.log('');
    console.log('  CẢNH BÁO: không còn quản trị viên nào hoạt động. Chạy:  npm run init-admin');
  }
}

if (require.main === module) {
  authLib.purgeExpiredSessions();
  app.listen(PORT, HOST, () => describeStartup());
}

module.exports = app;
