'use strict';

const express = require('express');
const { db, getSetting, setSetting, DEFAULT_NUMBERING, audit } = require('../db');
const auth = require('../auth');
const numbering = require('../numbering');
const { badRequest, isIsoDate, strip, intOr } = require('../util');

const router = express.Router();

// Toàn bộ router này chỉ dành cho quản trị viên. Đây là ranh giới quyền thật;
// việc giao diện ẩn tab “Cài đặt” chỉ là cho gọn mắt.
router.use(auth.requireAuth, auth.requirePasswordSettled, auth.requireRole('admin'));

function currentYear() {
  return new Date().getFullYear();
}

/** Ảnh chụp trạng thái lấy số: cấu hình, số kế tiếp, xem trước, bộ đếm. */
function snapshot() {
  const stored = getSetting('numbering', DEFAULT_NUMBERING);
  const cfg = stored.value;
  const year = currentYear();
  const scope = numbering.scopeFor(cfg, year);

  const next = numbering.peekNext(cfg, year);
  const preview = [];
  for (let k = 0; k < 5; k += 1) {
    preview.push({
      offset: k,
      seq: next.seq + k,
      soVanBan: numbering.buildNumber(cfg.prefix, next.seq + k, cfg.suffix),
    });
  }
  const nextYearSeq = cfg.resetYearly ? Math.max(1, cfg.start) : next.seq + 5;
  const nextYear = {
    year: year + 1,
    seq: nextYearSeq,
    soVanBan: numbering.buildNumber(cfg.prefix, nextYearSeq, cfg.suffix),
  };

  const counterRow = db.prepare(`SELECT next_seq FROM counters WHERE scope = ?`).get(scope);
  const issued = db
    .prepare(
      `SELECT COUNT(*) AS n FROM documents
        WHERE book = 'di' AND year = ? AND deleted_at IS NULL`
    )
    .get(year).n;
  // Chỉ tính văn bản còn trong sổ: xóa một văn bản là nhả số của nó ra, nên số
  // đó không còn là "số lớn nhất đã dùng" và không còn là sàn của bộ đếm.
  const maxSeq = db
    .prepare(
      `SELECT COALESCE(MAX(seq), 0) AS m FROM documents
        WHERE seq_scope = ? AND deleted_at IS NULL`
    )
    .get(scope).m;

  return {
    numbering: cfg,
    updatedAt: stored.updatedAt,
    updatedByName: stored.updatedByName,
    year,
    scope,
    next: { seq: next.seq, soVanBan: next.soVanBan, skipped: next.skipped },
    preview,
    nextYear,
    counter: {
      value: counterRow ? counterRow.next_seq : Math.max(1, cfg.start),
      issuedThisYear: issued,
      maxSeqUsed: maxSeq,
    },
  };
}

router.get('/numbering', (req, res) => {
  res.json(snapshot());
});

router.put('/numbering', (req, res, next) => {
  let cfg;
  try {
    cfg = numbering.validateNumbering(req.body && req.body.numbering);
  } catch (err) {
    return next(err);
  }
  const before = getSetting('numbering', DEFAULT_NUMBERING).value;
  setSetting('numbering', cfg, req.user.id);
  audit(
    req.user,
    'sua_cai_dat_lay_so',
    'mặc định ' +
      numbering.buildNumber(before.prefix, 1, before.suffix) +
      ' → ' +
      numbering.buildNumber(cfg.prefix, 1, cfg.suffix) +
      ' · bắt đầu từ ' + cfg.start +
      ' · reset đầu năm: ' + (cfg.resetYearly ? 'có' : 'không')
  );
  return res.json(snapshot());
});

/**
 * Đặt lại bộ đếm.
 * Trả về số THỰC TẾ sẽ được cấp — nếu giá trị yêu cầu đã bị chiếm bởi văn bản
 * đã ghi trong sổ, hệ thống nhảy tới số trống kế tiếp thay vì cấp trùng.
 */
router.post('/numbering/reset-counter', (req, res, next) => {
  const cfg = getSetting('numbering', DEFAULT_NUMBERING).value;
  const year = currentYear();
  let effective;
  try {
    effective = numbering.resetCounter(cfg, year, req.body && req.body.nextSeq);
  } catch (err) {
    return next(err);
  }
  audit(
    req.user,
    'dat_lai_bo_dem',
    'yêu cầu ' + req.body.nextSeq + ' · thực tế sẽ cấp ' + effective.soVanBan +
      (effective.clamped ? ' · bị chặn, bộ đếm không lùi dưới ' + effective.floor : '')
  );
  return res.json({
    ...snapshot(),
    requestedSeq: effective.requested,
    effectiveSeq: effective.seq,
    adjusted: effective.skipped,
    clamped: effective.clamped,
    floor: effective.floor,
  });
});

const AUDIT_PAGE = 200;

/**
 * Nhật ký thao tác: ai đổi gì lúc nào, tìm được và khôi phục được.
 *
 * Mỗi dòng “xóa văn bản” kèm trạng thái khôi phục, lấy bằng cách nối doc_id
 * sang bảng documents:
 *   restorable — văn bản còn đó, đang bị xóa mềm: hiện nút Khôi phục
 *   restored   — đã được khôi phục sau lần xóa này
 *   gone       — xóa trước khi có tính năng này, dữ liệu đã mất thật
 */
router.get('/audit', (req, res, next) => {
  const where = [];
  const args = [];

  const action = String(req.query.action || '').trim();
  if (action) {
    if (!/^[a-z_]{1,40}$/.test(action)) return next(badRequest('Loại việc không hợp lệ.'));
    where.push('a.action = ?');
    args.push(action);
  }

  const from = String(req.query.from || '').trim();
  if (from) {
    if (!isIsoDate(from)) return next(badRequest('“Từ ngày” không hợp lệ.'));
    where.push('a.at >= ?');
    args.push(from);
  }

  const to = String(req.query.to || '').trim();
  if (to) {
    if (!isIsoDate(to)) return next(badRequest('“Đến ngày” không hợp lệ.'));
    // at là mốc ISO đầy đủ, nên “đến ngày” phải phủ hết ngày đó.
    where.push('a.at <= ?');
    args.push(to + 'T23:59:59.999Z');
  }

  const q = strip(String(req.query.q || '').trim());
  if (q) {
    where.push('a.search_text LIKE ? ESCAPE ?');
    args.push('%' + q.replace(/[\\%_]/g, '\\$&') + '%', '\\');
  }

  const sql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(Math.max(intOr(req.query.limit, AUDIT_PAGE), 1), 500);
  const offset = Math.max(intOr(req.query.offset, 0), 0);

  // Lấy thêm một dòng để biết còn nữa hay không, không cần đếm lại.
  const rows = db
    .prepare(
      `SELECT a.id, a.at, a.username, a.action, a.detail, a.doc_id,
              d.id AS doc_exists, d.book, d.so_van_ban, d.ten_van_ban, d.ngay_gui,
              d.file_name, d.seq, d.seq_scope, d.year, d.deleted_at,
              du.full_name AS deleted_by_name
         FROM audit_log a
         LEFT JOIN documents d ON d.id = a.doc_id
         LEFT JOIN users du ON du.id = d.deleted_by
         ${sql}
        ORDER BY a.at DESC, a.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(...args, limit + 1, offset);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM audit_log a ${sql}`)
    .get(...args).n;

  // Xóa → khôi phục → xóa lại sinh ra hai dòng “xóa”, mà chỉ lần xóa gần nhất
  // là lần đang có hiệu lực. Chỉ dòng đó được phép hiện nút Khôi phục.
  const docIds = [...new Set(page.filter((r) => r.doc_id).map((r) => r.doc_id))];
  const latestDelete = new Map();
  if (docIds.length > 0) {
    db.prepare(
      `SELECT doc_id, MAX(id) AS last_id FROM audit_log
        WHERE action = 'xoa_van_ban' AND doc_id IN (${docIds.map(() => '?').join(',')})
        GROUP BY doc_id`
    )
      .all(...docIds)
      .forEach((r) => latestDelete.set(r.doc_id, r.last_id));
  }

  // Số của văn bản đã xóa được nhả ra, nên tới lúc khôi phục nó có thể đã thuộc
  // về văn bản khác. Tính sẵn cho từng dòng để hộp thoại khôi phục nói trước
  // được sẽ giữ số cũ hay phải cấp số mới, thay vì để quản trị biết sau khi bấm.
  const cfg = getSetting('numbering', DEFAULT_NUMBERING).value;

  const entries = page.map((r) => {
    const e = {
      id: r.id,
      at: r.at,
      username: r.username,
      action: r.action,
      detail: r.detail,
      docId: r.doc_id || null,
    };
    if (r.action !== 'xoa_van_ban') return e;

    if (!r.doc_id || !r.doc_exists) {
      e.restore = { state: 'gone' };
    } else if (!r.deleted_at || latestDelete.get(r.doc_id) !== r.id) {
      e.restore = { state: 'restored' };
    } else {
      const free = numbering.oldNumberFree(cfg, {
        id: r.doc_exists,
        book: r.book,
        year: r.year,
        so_van_ban: r.so_van_ban,
        seq: r.seq,
        seq_scope: r.seq_scope,
      });
      e.restore = {
        state: 'restorable',
        doc: {
          id: r.doc_exists,
          book: r.book,
          soVanBan: r.so_van_ban,
          tenVanBan: r.ten_van_ban,
          ngayGui: r.ngay_gui,
          fileName: r.file_name,
          deletedAt: r.deleted_at,
          deletedByName: r.deleted_by_name || null,
          // Số cũ còn trả lại được không, và nếu không thì sẽ cấp số nào.
          numberFree: free,
          nextNumber: free ? null : numbering.peekNext(cfg, r.year).soVanBan,
        },
      };
    }
    return e;
  });

  const restorable = db
    .prepare(`SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NOT NULL`)
    .get().n;

  res.json({ entries, hasMore, total, restorable, limit, offset });
});

module.exports = { router, snapshot };
