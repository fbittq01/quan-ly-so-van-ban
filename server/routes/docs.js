'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { db, UPLOAD_DIR, audit } = require('../db');
const auth = require('../auth');
const numbering = require('../numbering');
const books = require('../books');
const fields = require('../fields');
const files = require('../files');
const {
  strip,
  noLeadZero,
  today,
  nowIso,
  isIsoDate,
  text,
  badRequest,
  HttpError,
  issuesNumber,
  numberOptional,
} = require('../util');

const router = express.Router();

const { MAX_FILE_BYTES, VIEWABLE_EXT, upload, removeFile, preConvert } = files;

function currentYear() {
  return new Date().getFullYear();
}

/**
 * SQLite báo vi phạm UNIQUE theo tên CỘT, không theo tên index — nên nhận diện
 * theo mã lỗi cộng với cột, đừng bắt theo tên index.
 */
function isDuplicateSeq(err) {
  return (
    err && err.code === 'SQLITE_CONSTRAINT_UNIQUE' && String(err.message).includes('.seq')
  );
}

// Cột tìm kiếm: lõi + mọi giá trị trong extra — công thức ở fields.js, vì bước
// chuyển đổi trong db.js cũng phải dựng đúng chuỗi này.
const searchTextFor = fields.docSearchText;

function rowToJson(r) {
  return {
    id: r.id,
    // book = LOẠI sổ ('den' | 'di' | 'noibo'), bookId = sổ cụ thể. Giao diện cần cả hai:
    // loại quyết định hình dạng hộp thoại, sổ quyết định mở lại đúng chỗ nào.
    book: r.book,
    bookId: r.book_id,
    soVanBan: r.so_van_ban,
    seq: r.seq,
    year: r.year,
    ngayGui: r.ngay_gui,
    tenVanBan: r.ten_van_ban,
    // Giá trị các trường riêng của sổ, theo khóa trong book.fields. Ba cột cũ
    // nguoi_gui / do_bao_mat / ghi_chu không còn ra JSON: nội dung của chúng
    // nằm trong đây dưới khóa nguoiGui / doBaoMat / ghiChu.
    extra: fields.parseExtra(r.extra),
    ...files.fileFlags(r),
    createdAt: r.created_at,
    createdByName: r.created_by_name || null,
    updatedAt: r.updated_at,
    updatedByName: r.updated_by_name || null,
  };
}

/**
 * Đọc và kiểm tra các trường của một văn bản từ body (JSON hoặc multipart).
 *
 * Phần lõi (ngày gửi, tên văn bản) là của mọi sổ; phần còn lại kiểm theo bộ
 * trường CỦA ĐÚNG SỔ ĐÓ — ở máy chủ, không phải ở trình duyệt. `existingExtra`
 * khi sửa: giữ giá trị của trường đã ẩn, xem fields.readExtra.
 */
function readFields(body, book, existingExtra) {
  const ngayGui = String((body && body.ngayGui) || '').trim();
  if (!isIsoDate(ngayGui)) throw badRequest('Ngày gửi không hợp lệ.');

  const tenVanBan = text(body && body.tenVanBan, 500);
  if (!tenVanBan) throw badRequest('Chưa nhập tên văn bản.');

  return {
    ngayGui,
    tenVanBan,
    extra: fields.readExtra(book ? book.fields : [], body, existingExtra),
    year: Number.parseInt(ngayGui.slice(0, 4), 10),
    book: book ? book.kind : null,
  };
}

/**
 * Số văn bản nhập tay — sổ đến và sổ nội bộ.
 * Giữ nguyên như người ghi gõ, không chuẩn hóa gì. Sổ đến bắt buộc có số (số
 * của cơ quan gửi); sổ nội bộ thì không — để trống là văn bản không đánh số.
 * Sổ văn bản đi không có đường nhập tay: mọi số đều do hệ thống cấp (bỏ nút
 * “Ghi thủ công” ngày 11/09/2026).
 */
function readSoVanBan(body, kind) {
  const raw = text(body && body.soVanBan, 100);
  if (!raw && !numberOptional(kind)) throw badRequest('Chưa nhập số văn bản.');
  return raw;
}

/** Số văn bản để ghi nhật ký — văn bản nội bộ không số thì nói rõ. */
function soForLog(so) {
  return so || '(không số)';
}

/**
 * Tiền tố / hậu tố cho một lượt lấy số.
 *
 * Người lấy số tự đặt cho từng văn bản; bỏ trống thì dùng mặc định CỦA SỔ ĐÓ.
 * Chúng chỉ đổi phần chữ quanh số thứ tự, không đụng được vào chính số thứ tự
 * nên không ảnh hưởng tính duy nhất.
 */
function readAffixes(body, book) {
  const has = (k) => body && body[k] != null;
  return {
    prefix: has('prefix') ? numbering.cleanAffix(body.prefix) : book.prefix,
    suffix: has('suffix') ? numbering.cleanAffix(body.suffix) : book.suffix,
  };
}

// ------------------------------------------------------------------- đọc sổ

/** Số kế tiếp dự kiến của MỘT sổ trong năm nay. Chỉ để hiển thị, không chiếm số. */
router.get('/next-number', auth.requireAuth, (req, res, next) => {
  try {
    const book = books.require(req.query.book, false);
    if (!issuesNumber(book.kind)) throw badRequest('Sổ “' + book.name + '” không cấp số.', 'no_counter');
    const year = currentYear();
    const peek = numbering.peekNext(book, year);
    return res.json({
      bookId: book.id,
      year,
      seq: peek.seq,
      soVanBan: peek.soVanBan,
      prefix: book.prefix,
      suffix: book.suffix,
      resetYearly: book.resetYearly,
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/', auth.requireAuth, (req, res, next) => {
  let book;
  try {
    // Đọc thì sổ đã ngừng dùng vẫn mở được — quản trị còn phải tra cứu trong đó.
    book = books.require(req.query.book, false);
  } catch (err) {
    return next(err);
  }

  // Văn bản đã xóa mềm không còn thuộc sổ; chỉ trang Nhật ký nhìn thấy chúng.
  const where = ['d.book_id = ?', 'd.deleted_at IS NULL'];
  const args = [book.id];

  const year = String(req.query.year || '').trim();
  if (year) {
    if (!/^\d{4}$/.test(year)) return next(badRequest('Năm sổ không hợp lệ.'));
    where.push('d.year = ?');
    args.push(Number.parseInt(year, 10));
  }

  // Lọc theo trường “chọn một” của sổ: ?f.<key>=<lựa chọn>. Khóa phải là
  // trường select đang dùng của đúng sổ này, giá trị phải nằm trong lựa chọn —
  // không có đường nào nhét chuỗi lạ vào json_extract.
  for (const qk of Object.keys(req.query)) {
    if (!qk.startsWith('f.')) continue;
    const key = qk.slice(2);
    const def = fields.visible(book.fields).find((d) => d.key === key && d.type === 'select');
    if (!def) return next(badRequest('Không lọc được theo trường “' + key + '” ở sổ này.', 'bad_filter'));
    const val = String(req.query[qk] || '').trim();
    if (!val) continue;
    if (!def.options.includes(val)) return next(badRequest('“' + def.label + '” không có lựa chọn này.', 'bad_filter'));
    where.push('json_extract(d.extra, ?) = ?');
    args.push('$.' + key, val);
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
        WHERE book_id = ? AND deleted_at IS NULL${year ? ' AND year = ?' : ''}`
    )
    .get(...(year ? [book.id, Number.parseInt(year, 10)] : [book.id])).n;

  res.json({ book, documents: rows.map(rowToJson), shown: rows.length, totalInBook });
});

/** Số lượng văn bản theo từng năm, cho trang “Sổ theo năm”. */
router.get('/years', auth.requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT year,
              SUM(CASE WHEN book = 'den' THEN 1 ELSE 0 END) AS den,
              SUM(CASE WHEN book = 'di'  THEN 1 ELSE 0 END) AS di,
              SUM(CASE WHEN book = 'noibo' THEN 1 ELSE 0 END) AS noibo
         FROM documents WHERE deleted_at IS NULL GROUP BY year ORDER BY year DESC`
    )
    .all();
  const years = rows.map((r) => ({ year: r.year, den: r.den, di: r.di, noibo: r.noibo }));
  const y = currentYear();
  if (!years.some((r) => r.year === y)) years.unshift({ year: y, den: 0, di: 0, noibo: 0 });
  res.json({ years });
});

// ------------------------------------------------------------------ ghi sổ

const WRITE_ROLES = ['admin', 'vanthu'];

const insertStmt = db.prepare(
  `INSERT INTO documents
     (book, book_id, so_van_ban, seq, seq_scope, year, ngay_gui, ten_van_ban, extra,
      file_name, file_path, file_size, search_text, created_at, created_by)
   VALUES
     (@book, @book_id, @so_van_ban, @seq, @seq_scope, @year, @ngay_gui, @ten_van_ban, @extra,
      @file_name, @file_path, @file_size, @search_text, @created_at, @created_by)`
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
      // Ghi thì sổ đã ngừng dùng bị chặn hẳn — đó là ý nghĩa của "ngừng dùng".
      const book = books.require(req.body && req.body.book, true);
      const numbered = issuesNumber(book.kind);
      const issue = numbered && String((req.body && req.body.mode) || '') === 'issue';
      if (numbered && !issue) {
        // Ranh giới thật, không chỉ là chuyện giao diện đã bỏ nút: sổ văn
        // bản đi chỉ có một đường vào sổ là hệ thống cấp số.
        throw badRequest(
          'Sổ “' + book.name + '” không nhận số ghi tay — dùng nút “Lấy số ở sổ này”.',
          'manual_disabled'
        );
      }

      const f = readFields(req.body, book, null);
      const affix = readAffixes(req.body, book);

      // Chỉ đúng những khóa mà câu INSERT khai báo: better-sqlite3 từ chối
      // tham số có tên lạ.
      const base = {
        book: book.kind,
        book_id: book.id,
        year: f.year,
        so_van_ban: null,
        seq: null,
        seq_scope: null,
        ngay_gui: f.ngayGui,
        ten_van_ban: f.tenVanBan,
        extra: JSON.stringify(f.extra),
        file_name: req.file ? path.basename(req.file.originalname).slice(0, 260) : null,
        file_path: req.file ? req.file.filename : null,
        file_size: req.file ? req.file.size : null,
        created_at: nowIso(),
        created_by: req.user.id,
      };

      const run = db.transaction(() => {
        let allocated = null;
        if (issue) {
          allocated = numbering.allocate(book, f.year, affix.prefix, affix.suffix);
          base.so_van_ban = allocated.soVanBan;
          base.seq = allocated.seq;
          base.seq_scope = allocated.scope;
        } else {
          base.so_van_ban = readSoVanBan(req.body, book.kind);
        }
        base.search_text = searchTextFor(base);
        const info = insertStmt.run(base);
        return { id: info.lastInsertRowid, allocated };
      });

      let out;
      try {
        out = run();
      } catch (err) {
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
        book.name + ' · ' + soForLog(row.so_van_ban) + ' · ' + row.ten_van_ban,
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

      const existingBook = books.get(existing.book_id);
      const f = readFields(req.body, existingBook, fields.parseExtra(existing.extra));
      // Số của sổ đi giữ nguyên, kể cả hàng cũ ghi tay từ trước 11/09/2026:
      // sửa số đã phát hành là sai nghiệp vụ, và giờ không còn đường nhập tay
      // nào để sửa qua. Hàng nào đã có số thứ tự do hệ thống cấp cũng vậy, dù
      // nằm ở sổ nào. Số của sổ đến và sổ nội bộ thì nhập lại được — đó là số
      // người ghi gõ tay, ghi nhầm thì phải sửa được.
      const locked = issuesNumber(existing.book) || existing.seq != null;
      const soVanBan = locked ? existing.so_van_ban : readSoVanBan(req.body, existing.book);

      const dropFile = String((req.body && req.body.dropFile) || '') === '1';
      const oldPath = existing.file_path;
      const next2 = {
        id,
        so_van_ban: soVanBan,
        year: locked ? existing.year : f.year,
        ngay_gui: f.ngayGui,
        ten_van_ban: f.tenVanBan,
        extra: JSON.stringify(f.extra),
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
             ten_van_ban = @ten_van_ban, extra = @extra,
             file_name = @file_name, file_path = @file_path, file_size = @file_size,
             search_text = @search_text, updated_at = @updated_at, updated_by = @updated_by
           WHERE id = @id`
        ).run(next2);
      } catch (err) {
        if (isDuplicateSeq(err)) {
          throw badRequest(
            'Số thứ tự này vừa bị người khác lấy. Mở lại văn bản rồi thử lại.',
            'duplicate_seq'
          );
        }
        throw err;
      }

      if (req.file || dropFile) removeFile(oldPath);
      preConvert(req.file);
      const row = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id);
      audit(
        req.user,
        'sua_van_ban',
        (existingBook ? existingBook.name : existing.book) + ' · ' + soForLog(row.so_van_ban),
        id
      );
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
    // Bộ đếm được nhả về là bộ đếm CỦA SỔ CHỨA văn bản này, không phải của sổ
    // người dùng đang mở — xóa một văn bản ở sổ Đảng ủy không được kéo bộ đếm
    // của sổ chính quyền.
    const book = books.get(row.book_id);
    db.transaction(() => {
      db.prepare(
        `UPDATE documents SET deleted_at = ?, deleted_by = ?
          WHERE id = ? AND deleted_at IS NULL`
      ).run(nowIso(), req.user.id, id);
      if (book) numbering.release(book, row.seq_scope, row.seq);
      audit(
        req.user,
        'xoa_van_ban',
        (book ? book.name : row.book) + ' · ' + soForLog(row.so_van_ban) + ' · ' + row.ten_van_ban,
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

    const book = books.get(row.book_id);
    let renumbered = null;
    try {
      db.transaction(() => {
        if (!numbering.oldNumberFree(row)) {
          const taker = db
            .prepare(
              `SELECT ten_van_ban FROM documents
                WHERE seq_scope = ? AND seq = ? AND deleted_at IS NULL`
            )
            .get(row.seq_scope, row.seq);
          // Không đặt tên biến này là `next`: đó là hàm chuyển lỗi của Express
          // ở scope ngoài, và che nó đi thì nhánh bắt lỗi bên dưới câm lặng.
          // Số mới lấy từ bộ đếm của chính sổ cũ của văn bản này.
          const issued = numbering.allocate(book, row.year);
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
          (book ? book.name : row.book) + ' · ' + soForLog(row.so_van_ban) + ' · ' + row.ten_van_ban +
            (renumbered ? ' · số cũ đã có chủ, cấp lại số ' + renumbered.to : ''),
          id
        );
      })();
    } catch (err) {
      // Một văn thư vừa lấy đúng số đó trong lúc lệnh này đang chạy. Transaction
      // đã cuộn lại nên văn bản vẫn nằm ngoài sổ; bấm lại là xong.
      if (isDuplicateSeq(err)) {
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
  return files.sendAttachment(req, res, next, row);
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
  return files.sendViewPdf(req, res, next, row);
});

module.exports = { router, MAX_FILE_BYTES, VIEWABLE_EXT };
