'use strict';

/**
 * Tệp đính kèm — phần dùng chung của văn bản và khen thưởng.
 *
 * Tách khỏi routes/docs.js ngày 16/10/2026 khi khen thưởng cần đúng những thứ
 * này (tải lên, xem trên web, chuyển Office sang PDF). Hai bản sao của bộ lọc
 * đuôi tệp hay của header xem inline sẽ lệch nhau sớm thôi, mà đó là chỗ giữ
 * an toàn cho cả ứng dụng.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');

const { UPLOAD_DIR } = require('./db');
const convert = require('./convert');
const { HttpError } = require('./util');

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_EXT = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.odt', '.ods',
  '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.txt',
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    // Tên file trên đĩa do máy chủ sinh: tên gốc của người dùng không bao giờ
    // đi vào đường dẫn hệ thống tệp.
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, crypto.randomBytes(16).toString('hex') + (ALLOWED_EXT.has(ext) ? ext : '.bin'));
    },
  }),
  // BẮT BUỘC. Multer mặc định đọc tên tệp trong multipart theo latin1, còn
  // trình duyệt luôn gửi UTF-8 — để mặc định thì “Quyết định.pdf” vào cơ sở dữ
  // liệu thành “Quyáº¿t Äá»nh.pdf”, hỏng tên mọi tệp có dấu.
  defParamCharset: 'utf8',
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 40 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      cb(new HttpError(400, 'Định dạng file không được phép: ' + (ext || 'không rõ'), 'bad_file'));
      return;
    }
    cb(null, true);
  },
});

/**
 * Loại tệp xem được ngay trên web, và loại MIME trả về cho từng đuôi.
 *
 * Chỉ những gì trình duyệt tự dựng được. CỐ Ý bỏ .tif/.tiff (trình duyệt không
 * dựng được, sẽ tải xuống hoặc hiện trang trắng) và toàn bộ .doc/.docx/.xls/
 * .xlsx/.odt/.ods (phải có Office/Google Docs mới mở được). Những loại đó vẫn
 * tải xuống bình thường.
 *
 * .svg và .html KHÔNG có ở đây và không được phép tải lên: dựng chúng trong
 * origin của ứng dụng là mở đường cho script lạ.
 */
const VIEWABLE_EXT = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

function inlineType(storedName) {
  return VIEWABLE_EXT[path.extname(String(storedName || '')).toLowerCase()] || null;
}

/**
 * Tệp này xem được trên web dưới dạng PDF không.
 *
 * Gồm cả PDF gốc và những thứ LibreOffice dựng được (.doc, .docx, .xls…). Giao
 * diện dùng chung một trình xem cho cả hai: đường /xem-pdf trả PDF gốc hoặc bản
 * đã chuyển, phía trình duyệt không cần biết khác nhau.
 */
function viewableAsPdf(storedName) {
  const ext = path.extname(String(storedName || '')).toLowerCase();
  return ext === '.pdf' || convert.canConvert(storedName);
}

/** Các cờ về tệp mà giao diện cần, dựng từ file_path (tên do máy chủ sinh). */
function fileFlags(r) {
  return {
    fileName: r.file_name,
    fileSize: r.file_size,
    hasFile: !!r.file_path,
    // Đuôi lấy từ file_path chứ không từ file_name: đó là đuôi đã qua kiểm tra
    // của fileFilter, còn tên gốc thì người dùng đặt sao cũng được.
    fileViewable: !!(r.file_path && (inlineType(r.file_path) || viewableAsPdf(r.file_path))),
    // Xem bằng trình xem PDF (PDF gốc, hoặc Office đã chuyển sang PDF).
    fileAsPdf: !!(r.file_path && viewableAsPdf(r.file_path)),
    // Tệp Office phải chuyển đổi; lần đầu mất mấy giây nên giao diện báo trước.
    fileNeedsConvert: !!(r.file_path && convert.canConvert(r.file_path) && !convert.hasViewPdf(r.file_path)),
  };
}

/** “Bao-cao.docx” → “Bao-cao.docx.pdf”: tên bản xem nói rõ đây là bản chuyển. */
function pdfName(name) {
  const ten = String(name || 'dinh-kem');
  return /\.pdf$/i.test(ten) ? ten : ten + '.pdf';
}

/**
 * Header Content-Disposition với tên tệp tiếng Việt.
 *
 * filename= chỉ chở được ASCII nên phải kèm filename*= (RFC 5987) cho tên có
 * dấu. Lọc sạch dấu nháy, dấu gạch chéo và ký tự điều khiển: tên tệp do người
 * dùng đặt, không được để nó chèn thêm header.
 */
function contentDisposition(kind, name) {
  const safe = String(name).replace(/[\r\n"\\]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '');
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_') || 'dinh-kem';
  return kind + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(safe);
}

function removeFile(storedName) {
  if (!storedName) return;
  const full = path.join(UPLOAD_DIR, path.basename(storedName));
  // path.basename + kiểm tra tiền tố: không cho đường dẫn ra ngoài thư mục uploads.
  if (!full.startsWith(UPLOAD_DIR + path.sep)) return;
  fs.rm(full, { force: true }, () => {});
  // Bỏ luôn bản PDF đã chuyển, nếu không thư mục nhớ đệm sẽ phình mãi.
  convert.removeViewPdf(storedName);
}

/** Chuyển sẵn tệp Office vừa tải lên sang PDF, không bắt người lưu phải chờ. */
function preConvert(file) {
  if (!file) return;
  convert.convertInBackground(path.join(UPLOAD_DIR, file.filename), file.filename);
}

/** Đường dẫn đầy đủ của tệp đã lưu, hoặc lỗi 404 nếu tệp không còn trên đĩa. */
function storedPath(storedName) {
  const full = path.join(UPLOAD_DIR, path.basename(storedName));
  if (!full.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(full)) {
    throw new HttpError(404, 'File đính kèm không còn trên máy chủ.', 'not_found');
  }
  return full;
}

/**
 * Trả một tệp đính kèm: tải xuống, hoặc ?xem=1 để xem ngay trong trình duyệt.
 * `row` có file_name và file_path; quyền xem do nơi gọi kiểm trước.
 */
function sendAttachment(req, res, next, row) {
  let full;
  try {
    full = storedPath(row.file_path);
  } catch (err) {
    return next(err);
  }

  const name = row.file_name || 'dinh-kem';
  const type = inlineType(row.file_path);
  // Chỉ mở sẵn những loại trình duyệt tự dựng được — .docx mà trả inline thì
  // trình duyệt cũng chỉ tải xuống, nhưng mất tên tệp gốc.
  if (String(req.query.xem || '') !== '1' || !type) {
    return res.download(full, name);
  }

  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', contentDisposition('inline', name));
  // Chỉ đúng một directive. ĐỪNG thêm 'sandbox', 'object-src' hay 'script-src'
  // vào đây: cả ba đều làm Chrome chặn luôn trình xem PDF của chính nó
  // (“This page has been blocked by Chromium”) — đã thử và thấy. Thứ giữ an
  // toàn cho tệp dựng trong origin của ứng dụng là ba lớp khác:
  //   1. fileFilter chỉ nhận đuôi trong ALLOWED_EXT — không bao giờ có .svg,
  //      .html, .js, nên không có tệp nào chạy được script trong origin này.
  //   2. Chỉ VIEWABLE_EXT được trả inline, kèm Content-Type khai rõ.
  //   3. X-Content-Type-Options: nosniff (đặt cho toàn ứng dụng) — trình duyệt
  //      không được tự đoán lại loại tệp, .txt mãi là text/plain.
  // JavaScript nhúng trong PDF thì chạy trong tiến trình riêng của trình xem,
  // không với được vào DOM hay cookie phiên của trang.
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  // Mặc định DENY của toàn ứng dụng chặn cả iframe của chính chúng ta.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  return res.sendFile(full, (err) => {
    if (err && !res.headersSent) next(err);
  });
}

/**
 * Bản PDF để xem trên web: PDF gốc thì trả thẳng, tệp Office thì chuyển.
 *
 * Đường dẫn gọi tới đây CỐ Ý không có đuôi tệp và không có tham số truy vấn.
 * Tiện ích chặn quảng cáo trong trình duyệt người dùng chặn thẳng dạng URL
 * “…/TAt9.pdf?xem=1” (net::ERR_BLOCKED_BY_CLIENT) làm khung xem trắng; dạng
 * đường dẫn trơn thì không khớp bộ lọc nào. ĐỪNG thêm tên tệp hay ?tham-số.
 */
function sendViewPdf(req, res, next, row) {
  let full;
  try {
    full = storedPath(row.file_path);
  } catch (err) {
    return next(err);
  }
  if (!viewableAsPdf(row.file_path)) {
    return next(new HttpError(400, 'Loại tệp này không xem được trên web.', 'khong_xem_duoc'));
  }

  // Header giống đường xem inline: xem phần ghi chú dài ở sendAttachment.
  const sendPdf = (duongDan) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition('inline', pdfName(row.file_name)));
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    return res.sendFile(duongDan, (err) => {
      if (err && !res.headersSent) next(err);
    });
  };

  if (!convert.canConvert(row.file_path)) return sendPdf(full);

  return convert.ensureViewPdf(full, row.file_path).then(sendPdf, (err) => {
    console.error('[xem-pdf] ' + row.file_path + ': ' + err.message);
    next(new HttpError(
      500,
      'Không chuyển được tệp này sang PDF để xem. Tệp vẫn tải về được bình thường.',
      'khong_chuyen_duoc'
    ));
  });
}

/** Tên gốc của tệp vừa tải lên, cắt cho vừa cột. */
function originalName(file) {
  return path.basename(file.originalname).slice(0, 260);
}

module.exports = {
  MAX_FILE_BYTES,
  ALLOWED_EXT,
  VIEWABLE_EXT,
  upload,
  inlineType,
  viewableAsPdf,
  fileFlags,
  pdfName,
  contentDisposition,
  removeFile,
  preConvert,
  sendAttachment,
  sendViewPdf,
  originalName,
};
