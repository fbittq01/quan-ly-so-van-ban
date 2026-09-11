'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');

const { db, UPLOAD_DIR, getSetting, DEFAULT_NUMBERING, audit } = require('../db');
const auth = require('../auth');
const numbering = require('../numbering');
const convert = require('../convert');
const {
  strip,
  noLeadZero,
  today,
  nowIso,
  isIsoDate,
  text,
  multiline,
  badRequest,
  HttpError,
  SECURITY_LEVELS,
} = require('../util');

const router = express.Router();

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

/**
 * Header Content-Disposition với tên tệp tiếng Việt.
 *
 * filename= chỉ chở được ASCII nên phải kèm filename*= (RFC 5987) cho tên có
 * dấu. Lọc sạch dấu nháy, dấu gạch chéo và ký tự điều khiển: tên tệp do người
 * dùng đặt, không được để nó chèn thêm header.
 */
/** “Bao-cao.docx” → “Bao-cao.docx.pdf”: tên bản xem nói rõ đây là bản chuyển. */
function pdfName(name) {
  const ten = String(name || 'dinh-kem');
  return /\.pdf$/i.test(ten) ? ten : ten + '.pdf';
}

function contentDisposition(kind, name) {
  const safe = String(name).replace(/[\r\n"\\]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '');
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_') || 'dinh-kem';
  return kind + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(safe);
}

function numberingConfig() {
  return getSetting('numbering', DEFAULT_NUMBERING).value;
}

function currentYear() {
  return new Date().getFullYear();
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

/**
 * SQLite báo vi phạm UNIQUE theo tên CỘT, không theo tên index — nên nhận diện
 * theo mã lỗi cộng với cột, đừng bắt theo tên index.
 */
function isDuplicateNumber(err) {
  return (
    err &&
    err.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    String(err.message).includes('so_van_ban')
  );
}

function isDuplicateSeq(err) {
  return (
    err && err.code === 'SQLITE_CONSTRAINT_UNIQUE' && String(err.message).includes('.seq')
  );
}

function searchTextFor(d) {
  const p = String(d.ngay_gui || '').split('-');
  const viDate = p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : '';
  return strip(
    [d.so_van_ban, d.nguoi_gui, d.ten_van_ban, d.ghi_chu, d.do_bao_mat, d.ngay_gui, viDate].join(' ')
  );
}

function rowToJson(r) {
  return {
    id: r.id,
    book: r.book,
    soVanBan: r.so_van_ban,
    seq: r.seq,
    year: r.year,
    ngayGui: r.ngay_gui,
    nguoiGui: r.nguoi_gui,
    tenVanBan: r.ten_van_ban,
    doBaoMat: r.do_bao_mat,
    ghiChu: r.ghi_chu,
    fileName: r.file_name,
    fileSize: r.file_size,
    hasFile: !!r.file_path,
    // Đuôi lấy từ file_path (tên do máy chủ sinh) chứ không từ file_name: đó là
    // đuôi đã qua kiểm tra của fileFilter, còn tên gốc thì người dùng đặt sao cũng được.
    fileViewable: !!(r.file_path && (inlineType(r.file_path) || viewableAsPdf(r.file_path))),
    // Xem bằng trình xem PDF (PDF gốc, hoặc Office đã chuyển sang PDF).
    fileAsPdf: !!(r.file_path && viewableAsPdf(r.file_path)),
    // Tệp Office phải chuyển đổi; lần đầu mất mấy giây nên giao diện báo trước.
    fileNeedsConvert: !!(r.file_path && convert.canConvert(r.file_path) && !convert.hasViewPdf(r.file_path)),
    createdAt: r.created_at,
    createdByName: r.created_by_name || null,
    updatedAt: r.updated_at,
    updatedByName: r.updated_by_name || null,
  };
}

/** Đọc và kiểm tra các trường của một văn bản từ body (JSON hoặc multipart). */
function readFields(body, book) {
  const ngayGui = String((body && body.ngayGui) || '').trim();
  if (!isIsoDate(ngayGui)) throw badRequest('Ngày gửi không hợp lệ.');

  const tenVanBan = text(body && body.tenVanBan, 500);
  if (!tenVanBan) throw badRequest('Chưa nhập tên văn bản.');

  const doBaoMat = String((body && body.doBaoMat) || 'Thường');
  if (!SECURITY_LEVELS.includes(doBaoMat)) throw badRequest('Độ bảo mật không hợp lệ.');

  return {
    ngayGui,
    tenVanBan,
    doBaoMat,
    nguoiGui: text(body && body.nguoiGui, 200),
    ghiChu: multiline(body && body.ghiChu, 2000),
    year: Number.parseInt(ngayGui.slice(0, 4), 10),
    book,
  };
}

/**
 * Số văn bản nhập tay.
 * Với sổ văn bản đi, bỏ số 0 ở đầu — đó là số của chính đơn vị này nên áp quy
 * tắc được. Với sổ văn bản đến thì giữ nguyên: số đó do cơ quan gửi đặt.
 */
function readSoVanBan(body, book) {
  const raw = text(body && body.soVanBan, 100);
  if (!raw) throw badRequest('Chưa nhập số văn bản.');
  return book === 'di' ? noLeadZero(raw) : raw;
}

/**
 * Chặn ghi tay một số đã có trong sổ đi.
 *
 * Hai unique index chỉ khóa được cặp (năm sổ, số văn bản), mà năm sổ suy ra từ
 * NGÀY GỬI chứ không phải từ năm nằm trong chính chuỗi số. Nên số '5/2026' đề
 * ngày 30/12/2025 rơi vào năm sổ 2025 và lọt qua index — sang 2026 hệ thống
 * cấp lại đúng số đó cho văn bản khác. numberTakenBy tra đúng phạm vi mà cấu
 * hình lấy số quy định, nên bịt được ca này; index vẫn giữ nguyên làm chốt cuối.
 *
 * Sổ đến không kiểm: số đó do cơ quan gửi đặt, trùng nhau là chuyện bình thường.
 */
function ensureNumberFree(cfg, book, year, soVanBan, excludeId) {
  if (book !== 'di') return;
  const takenYear = numbering.numberTakenBy(cfg, year, soVanBan, excludeId);
  if (takenYear === null) return;
  throw badRequest(
    'Số “' + soVanBan + '” đã có trong sổ văn bản đi năm ' + takenYear + '.',
    'duplicate'
  );
}

// ------------------------------------------------------------------- đọc sổ

/** Số kế tiếp dự kiến của sổ năm nay. Chỉ để hiển thị, không chiếm số. */
router.get('/next-number', auth.requireAuth, (req, res) => {
  const cfg = numberingConfig();
  const year = currentYear();
  const next = numbering.peekNext(cfg, year);
  res.json({
    year,
    seq: next.seq,
    soVanBan: next.soVanBan,
    resetYearly: cfg.resetYearly,
  });
});

router.get('/', auth.requireAuth, (req, res, next) => {
  const book = String(req.query.book || 'den');
  if (book !== 'den' && book !== 'di') return next(badRequest('Sổ không hợp lệ.'));

  // Văn bản đã xóa mềm không còn thuộc sổ; chỉ trang Nhật ký nhìn thấy chúng.
  const where = ['d.book = ?', 'd.deleted_at IS NULL'];
  const args = [book];

  const year = String(req.query.year || '').trim();
  if (year) {
    if (!/^\d{4}$/.test(year)) return next(badRequest('Năm sổ không hợp lệ.'));
    where.push('d.year = ?');
    args.push(Number.parseInt(year, 10));
  }

  const security = String(req.query.security || '').trim();
  if (security) {
    if (!SECURITY_LEVELS.includes(security)) return next(badRequest('Độ bảo mật không hợp lệ.'));
    where.push('d.do_bao_mat = ?');
    args.push(security);
  }

  const from = String(req.query.from || '').trim();
  if (from) {
    if (!isIsoDate(from)) return next(badRequest('“Từ ngày” không hợp lệ.'));
    where.push('d.ngay_gui >= ?');
    args.push(from);
  }

  const to = String(req.query.to || '').trim();
  if (to) {
    if (!isIsoDate(to)) return next(badRequest('“Đến ngày” không hợp lệ.'));
    where.push('d.ngay_gui <= ?');
    args.push(to);
  }

  // Tìm không phụ thuộc dấu: so khớp trên cột search_text đã bỏ dấu.
  const q = strip(String(req.query.q || '').trim());
  if (q) {
    where.push('d.search_text LIKE ? ESCAPE ?');
    args.push('%' + q.replace(/[\\%_]/g, '\\$&') + '%', '\\');
  }

  const rows = db
    .prepare(
      `SELECT d.*, cu.full_name AS created_by_name, uu.full_name AS updated_by_name
         FROM documents d
         LEFT JOIN users cu ON cu.id = d.created_by
         LEFT JOIN users uu ON uu.id = d.updated_by
        WHERE ${where.join(' AND ')}
        ORDER BY d.ngay_gui DESC, d.id DESC
        LIMIT 2000`
    )
    .all(...args);

  const totalInBook = db
    .prepare(
      `SELECT COUNT(*) AS n FROM documents
        WHERE book = ? AND deleted_at IS NULL${year ? ' AND year = ?' : ''}`
    )
    .get(...(year ? [book, Number.parseInt(year, 10)] : [book])).n;

  res.json({ documents: rows.map(rowToJson), shown: rows.length, totalInBook });
});

/** Số lượng văn bản theo từng năm, cho trang “Sổ theo năm”. */
router.get('/years', auth.requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT year,
              SUM(CASE WHEN book = 'den' THEN 1 ELSE 0 END) AS den,
              SUM(CASE WHEN book = 'di'  THEN 1 ELSE 0 END) AS di
         FROM documents WHERE deleted_at IS NULL GROUP BY year ORDER BY year DESC`
    )
    .all();
  const years = rows.map((r) => ({ year: r.year, den: r.den, di: r.di }));
  const y = currentYear();
  if (!years.some((r) => r.year === y)) years.unshift({ year: y, den: 0, di: 0 });
  res.json({ years });
});

// ------------------------------------------------------------------ ghi sổ

const WRITE_ROLES = ['admin', 'vanthu'];

const insertStmt = db.prepare(
  `INSERT INTO documents
     (book, so_van_ban, seq, seq_scope, year, ngay_gui, nguoi_gui, ten_van_ban,
      do_bao_mat, ghi_chu, file_name, file_path, file_size, search_text,
      created_at, created_by)
   VALUES
     (@book, @so_van_ban, @seq, @seq_scope, @year, @ngay_gui, @nguoi_gui, @ten_van_ban,
      @do_bao_mat, @ghi_chu, @file_name, @file_path, @file_size, @search_text,
      @created_at, @created_by)`
);

/**
 * Ghi một văn bản vào sổ.
 *
 * mode=issue (chỉ sổ đi): hệ thống cấp số. Việc chiếm số và ghi văn bản nằm
 * trong CÙNG một transaction, nên hai văn thư bấm “Lấy số” cùng lúc nhận hai
 * số khác nhau, và không bao giờ có số bị chiếm mà văn bản không vào sổ.
 */
router.post(
  '/',
  auth.requireAuth,
  auth.requirePasswordSettled,
  auth.requireRole(...WRITE_ROLES),
  upload.single('file'),
  (req, res, next) => {
    try {
      const book = String((req.body && req.body.book) || '');
      if (book !== 'den' && book !== 'di') throw badRequest('Sổ không hợp lệ.');
      const issue = book === 'di' && String((req.body && req.body.mode) || '') === 'issue';

      const f = readFields(req.body, book);
      const cfg = numberingConfig();

      // Chỉ đúng những khóa mà câu INSERT khai báo: better-sqlite3 từ chối
      // tham số có tên lạ.
      const base = {
        book,
        year: f.year,
        so_van_ban: null,
        seq: null,
        seq_scope: null,
        ngay_gui: f.ngayGui,
        nguoi_gui: f.nguoiGui,
        ten_van_ban: f.tenVanBan,
        do_bao_mat: f.doBaoMat,
        ghi_chu: f.ghiChu,
        file_name: req.file ? path.basename(req.file.originalname).slice(0, 260) : null,
        file_path: req.file ? req.file.filename : null,
        file_size: req.file ? req.file.size : null,
        created_at: nowIso(),
        created_by: req.user.id,
      };

      const run = db.transaction(() => {
        let allocated = null;
        if (issue) {
          allocated = numbering.allocate(cfg, f.year);
          base.so_van_ban = allocated.soVanBan;
          base.seq = allocated.seq;
          base.seq_scope = allocated.scope;
        } else {
          base.so_van_ban = readSoVanBan(req.body, book);
          ensureNumberFree(cfg, book, f.year, base.so_van_ban);
        }
        base.search_text = searchTextFor(base);
        const info = insertStmt.run(base);
        return { id: info.lastInsertRowid, allocated };
      });

      let out;
      try {
        out = run();
      } catch (err) {
        if (isDuplicateNumber(err)) {
          throw badRequest(
            'Số “' + base.so_van_ban + '” đã có trong sổ văn bản đi năm ' + f.year + '.',
            'duplicate'
          );
        }
        if (isDuplicateSeq(err)) {
          throw badRequest(
            'Số thứ tự này vừa bị người khác lấy. Bấm lại để nhận số kế tiếp.',
            'duplicate_seq'
          );
        }
        throw err;
      }

      preConvert(req.file);
      const row = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(out.id);
      audit(
        req.user,
        issue ? 'cap_so' : 'ghi_so',
        book + ' · ' + row.so_van_ban + ' · ' + row.ten_van_ban,
        row.id
      );
      // Số dự kiến hiện lúc mở hộp thoại có thể lệch với số thực cấp: người
      // khác vừa lấy đúng số đó, hoặc văn bản được ghi cho một năm sổ khác.
      // Máy khách phải báo rõ cho văn thư — số có thể đã ghi lên bản giấy.
      const expected = text(req.body && req.body.expectedSoVanBan, 100);
      const numberChanged = !!(out.allocated && expected && expected !== row.so_van_ban);

      return res.status(201).json({
        document: rowToJson(row),
        issued: !!out.allocated,
        expectedDiffers: numberChanged,
        numberChange: numberChanged
          ? {
              expected,
              actual: row.so_van_ban,
              year: row.year,
              reason: row.year !== currentYear() ? 'year' : 'taken',
            }
          : null,
      });
    } catch (err) {
      if (req.file) removeFile(req.file.filename);
      return next(err);
    }
  }
);

router.put(
  '/:id',
  auth.requireAuth,
  auth.requirePasswordSettled,
  auth.requireRole(...WRITE_ROLES),
  upload.single('file'),
  (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      const existing = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id);
      if (!existing) throw new HttpError(404, 'Không tìm thấy văn bản.', 'not_found');
      if (existing.deleted_at) {
        throw new HttpError(
          404,
          'Văn bản này đã bị xóa khỏi sổ. Quản trị viên khôi phục lại từ trang Nhật ký trước khi sửa.',
          'deleted'
        );
      }

      const f = readFields(req.body, existing.book);
      // Số do hệ thống cấp thì giữ nguyên: sửa số đã phát hành là sai nghiệp vụ.
      const soVanBan =
        existing.seq != null ? existing.so_van_ban : readSoVanBan(req.body, existing.book);
      const cfg = numberingConfig();
      if (existing.seq == null) {
        ensureNumberFree(cfg, existing.book, f.year, soVanBan, id);
      }

      const dropFile = String((req.body && req.body.dropFile) || '') === '1';
      const oldPath = existing.file_path;
      const next2 = {
        id,
        so_van_ban: soVanBan,
        year: existing.seq != null ? existing.year : f.year,
        ngay_gui: f.ngayGui,
        nguoi_gui: f.nguoiGui,
        ten_van_ban: f.tenVanBan,
        do_bao_mat: f.doBaoMat,
        ghi_chu: f.ghiChu,
        file_name: req.file
          ? path.basename(req.file.originalname).slice(0, 260)
          : dropFile
            ? null
            : existing.file_name,
        file_path: req.file ? req.file.filename : dropFile ? null : existing.file_path,
        file_size: req.file ? req.file.size : dropFile ? null : existing.file_size,
        updated_at: nowIso(),
        updated_by: req.user.id,
      };
      next2.search_text = searchTextFor(next2);

      try {
        db.prepare(
          `UPDATE documents SET
             so_van_ban = @so_van_ban, year = @year, ngay_gui = @ngay_gui,
             nguoi_gui = @nguoi_gui, ten_van_ban = @ten_van_ban,
             do_bao_mat = @do_bao_mat, ghi_chu = @ghi_chu,
             file_name = @file_name, file_path = @file_path, file_size = @file_size,
             search_text = @search_text, updated_at = @updated_at, updated_by = @updated_by
           WHERE id = @id`
        ).run(next2);
      } catch (err) {
        if (isDuplicateNumber(err)) {
          throw badRequest(
            'Số “' + soVanBan + '” đã có trong sổ văn bản đi năm ' + next2.year + '.',
            'duplicate'
          );
        }
        throw err;
      }

      if (req.file || dropFile) removeFile(oldPath);
      preConvert(req.file);
      const row = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id);
      audit(req.user, 'sua_van_ban', existing.book + ' · ' + row.so_van_ban, id);
      return res.json({ document: rowToJson(row) });
    } catch (err) {
      if (req.file) removeFile(req.file.filename);
      return next(err);
    }
  }
);

router.delete(
  '/:id',
  auth.requireAuth,
  auth.requirePasswordSettled,
  auth.requireRole(...WRITE_ROLES),
  (req, res, next) => {
    const id = Number.parseInt(req.params.id, 10);
    const row = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id);
    if (!row || row.deleted_at) {
      return next(new HttpError(404, 'Không tìm thấy văn bản.', 'not_found'));
    }

    // Xóa MỀM: hàng và file đính kèm được giữ nguyên, chỉ đánh dấu đã xóa, nên
    // quản trị khôi phục lại được từ trang Nhật ký.
    //
    // Nhưng số thì ĐƯỢC NHẢ RA: hai unique index chỉ tính văn bản còn trong sổ,
    // và bộ đếm bị kéo về chính số vừa xóa, nên người lấy số kế tiếp nhận lại
    // đúng số đó. Đổi lại, khôi phục không còn chắc chắn giữ được số cũ — xem
    // nhánh /restore bên dưới.
    const cfg = numberingConfig();
    db.transaction(() => {
      db.prepare(
        `UPDATE documents SET deleted_at = ?, deleted_by = ?
          WHERE id = ? AND deleted_at IS NULL`
      ).run(nowIso(), req.user.id, id);
      numbering.release(cfg, row.seq_scope, row.seq);
      audit(
        req.user,
        'xoa_van_ban',
        row.book + ' · ' + row.so_van_ban + ' · ' + row.ten_van_ban,
        id
      );
    })();
    return res.json({ ok: true, numberReleased: row.seq != null });
  }
);

/**
 * Khôi phục một văn bản đã xóa. Chỉ quản trị viên — văn thư xóa được nhưng
 * không tự khôi phục được.
 *
 * Số cũ được trả lại NẾU còn trống. Nếu trong lúc văn bản nằm ngoài sổ mà số đó
 * đã được cấp cho văn bản khác thì không có cách nào trả lại — sổ không cho hai
 * văn bản cùng số — nên hệ thống cấp cho nó số trống kế tiếp và báo rõ số mới,
 * kèm số cũ nay thuộc về ai. Khôi phục vẫn chạy: mất số cũ còn hơn mất cả dòng
 * sổ, và quản trị cần nhìn thấy nội dung để quyết định.
 */
router.post(
  '/:id/restore',
  auth.requireAuth,
  auth.requirePasswordSettled,
  auth.requireRole('admin'),
  (req, res, next) => {
    const id = Number.parseInt(req.params.id, 10);
    const row = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id);
    if (!row) return next(new HttpError(404, 'Không tìm thấy văn bản.', 'not_found'));
    if (!row.deleted_at) {
      return next(badRequest('Văn bản này chưa bị xóa nên không cần khôi phục.', 'not_deleted'));
    }

    const cfg = numberingConfig();
    let renumbered = null;
    try {
      db.transaction(() => {
        if (!numbering.oldNumberFree(cfg, row)) {
          const taker = db
            .prepare(
              `SELECT ten_van_ban FROM documents
                WHERE book = 'di' AND year = ? AND so_van_ban = ? AND deleted_at IS NULL`
            )
            .get(row.year, row.so_van_ban);
          // Không đặt tên biến này là `next`: đó là hàm chuyển lỗi của Express
          // ở scope ngoài, và che nó đi thì nhánh bắt lỗi bên dưới câm lặng.
          const issued = numbering.allocate(cfg, row.year);
          renumbered = {
            from: row.so_van_ban,
            to: issued.soVanBan,
            takenBy: taker ? taker.ten_van_ban : null,
          };
          db.prepare(
            `UPDATE documents SET so_van_ban = @so_van_ban, seq = @seq, seq_scope = @seq_scope,
               search_text = @search_text
             WHERE id = @id`
          ).run({
            id,
            so_van_ban: issued.soVanBan,
            seq: issued.seq,
            seq_scope: issued.scope,
            search_text: searchTextFor({ ...row, so_van_ban: issued.soVanBan }),
          });
        }
        db.prepare(
          `UPDATE documents SET deleted_at = NULL, deleted_by = NULL
            WHERE id = ? AND deleted_at IS NOT NULL`
        ).run(id);
        audit(
          req.user,
          'khoi_phuc_van_ban',
          row.book + ' · ' + row.so_van_ban + ' · ' + row.ten_van_ban +
            (renumbered ? ' · số cũ đã có chủ, cấp lại số ' + renumbered.to : ''),
          id
        );
      })();
    } catch (err) {
      // Một văn thư vừa lấy đúng số đó trong lúc lệnh này đang chạy. Transaction
      // đã cuộn lại nên văn bản vẫn nằm ngoài sổ; bấm lại là xong.
      if (isDuplicateNumber(err) || isDuplicateSeq(err)) {
        return next(
          badRequest(
            'Số của văn bản này vừa bị người khác lấy mất. Bấm khôi phục lại — hệ thống sẽ cấp số khác.',
            'duplicate'
          )
        );
      }
      throw err;
    }

    // File có thể đã bị dọn khỏi đĩa bằng tay. Vẫn khôi phục văn bản — mất file
    // còn hơn mất cả dòng sổ — nhưng phải báo cho quản trị biết.
    const fileMissing = !!(
      row.file_path &&
      !fs.existsSync(path.join(UPLOAD_DIR, path.basename(row.file_path)))
    );
    const fresh = db
      .prepare(
        `SELECT d.*, cu.full_name AS created_by_name, uu.full_name AS updated_by_name
           FROM documents d
           LEFT JOIN users cu ON cu.id = d.created_by
           LEFT JOIN users uu ON uu.id = d.updated_by
          WHERE d.id = ?`
      )
      .get(id);
    return res.json({ document: rowToJson(fresh), fileMissing, renumbered });
  }
);

/**
 * Tải hoặc xem tệp đính kèm.
 *
 * Hai đường dẫn cùng một việc. Đoạn tên tệp ở cuối KHÔNG được dùng để tìm tệp
 * (tệp tìm theo id), nó chỉ để trình xem PDF của trình duyệt hiện đúng tên văn
 * bản trên thanh công cụ và khi in, thay vì hiện trơ trọi chữ “file”.
 */
const fileHandler = (req, res, next) => {
  const id = Number.parseInt(req.params.id, 10);
  const row = db
    .prepare(`SELECT file_name, file_path, deleted_at FROM documents WHERE id = ?`)
    .get(id);
  if (!row || !row.file_path) {
    return next(new HttpError(404, 'Văn bản này không có file đính kèm.', 'not_found'));
  }
  // Đính kèm của văn bản đã xóa chỉ quản trị xem được, để soi lại trước khi khôi phục.
  if (row.deleted_at && req.user.role !== 'admin') {
    return next(new HttpError(404, 'Văn bản này không có file đính kèm.', 'not_found'));
  }
  const full = path.join(UPLOAD_DIR, path.basename(row.file_path));
  if (!full.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(full)) {
    return next(new HttpError(404, 'File đính kèm không còn trên máy chủ.', 'not_found'));
  }

  const name = row.file_name || 'dinh-kem';
  const type = inlineType(row.file_path);
  // ?xem=1 để xem ngay trong trình duyệt; không có thì tải xuống như trước.
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
};

router.get('/:id/file', auth.requireAuth, fileHandler);
router.get('/:id/file/:ten', auth.requireAuth, fileHandler);

/**
 * Bản PDF để xem trên web: PDF gốc thì trả thẳng, tệp Office thì chuyển.
 *
 * Đường dẫn CỐ Ý không có đuôi tệp và không có tham số truy vấn. Tiện ích chặn
 * quảng cáo trong trình duyệt người dùng chặn thẳng dạng URL “…/TAt9.pdf?xem=1”
 * (net::ERR_BLOCKED_BY_CLIENT) làm khung xem trắng; dạng đường dẫn trơn như
 * đây thì không khớp bộ lọc nào. ĐỪNG thêm tên tệp hay ?tham-số vào đây.
 */
router.get('/:id/xem-pdf', auth.requireAuth, (req, res, next) => {
  const id = Number.parseInt(req.params.id, 10);
  const row = db
    .prepare(`SELECT file_name, file_path, deleted_at FROM documents WHERE id = ?`)
    .get(id);
  if (!row || !row.file_path) {
    return next(new HttpError(404, 'Văn bản này không có file đính kèm.', 'not_found'));
  }
  if (row.deleted_at && req.user.role !== 'admin') {
    return next(new HttpError(404, 'Văn bản này không có file đính kèm.', 'not_found'));
  }
  const full = path.join(UPLOAD_DIR, path.basename(row.file_path));
  if (!full.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(full)) {
    return next(new HttpError(404, 'File đính kèm không còn trên máy chủ.', 'not_found'));
  }
  if (!viewableAsPdf(row.file_path)) {
    return next(new HttpError(400, 'Loại tệp này không xem được trên web.', 'khong_xem_duoc'));
  }

  // Header giống đường xem inline: xem phần ghi chú dài ở fileHandler.
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
});

module.exports = { router, MAX_FILE_BYTES, VIEWABLE_EXT };
