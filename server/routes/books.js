'use strict';

const express = require('express');

const { db, audit } = require('../db');
const auth = require('../auth');
const books = require('../books');
const numbering = require('../numbering');
const { badRequest } = require('../util');

const router = express.Router();

function currentYear() {
  return new Date().getFullYear();
}

/**
 * Một sổ kèm những gì giao diện cần để vẽ: số văn bản đang có, và — với sổ đi —
 * số kế tiếp sẽ cấp.
 *
 * Số kế tiếp tính riêng cho từng sổ, nên danh sách sổ tự nó đã trả lời được
 * “bấm Lấy số ở sổ này thì ra số mấy” mà không phải gọi thêm.
 */
function decorate(book, countMap, year) {
  const out = Object.assign({}, book, { count: countMap.get(book.id) || 0 });
  if (book.kind === 'di') {
    const next = numbering.peekNext(book, year);
    out.next = { seq: next.seq, soVanBan: next.soVanBan, skipped: next.skipped };
  } else {
    out.next = null;
  }
  return out;
}

function listFor(user) {
  const year = currentYear();
  const countMap = books.counts();
  // Sổ đã ngừng dùng chỉ quản trị thấy: với văn thư nó không còn là chỗ ghi sổ
  // nữa, để lại chỉ làm rối danh sách.
  const admin = user && user.role === 'admin';
  return books
    .all()
    .filter((b) => admin || !b.hidden)
    .map((b) => decorate(b, countMap, year));
}

router.get('/', auth.requireAuth, (req, res) => {
  res.json({ books: listFor(req.user), year: currentYear() });
});

// Mọi đường GHI dưới đây chỉ dành cho quản trị. Đây là ranh giới quyền thật;
// việc giao diện ẩn mục “Sổ” chỉ là cho gọn mắt.
const adminOnly = [auth.requireAuth, auth.requirePasswordSettled, auth.requireRole('admin')];

router.post('/', ...adminOnly, (req, res, next) => {
  try {
    const book = books.create(req.body, req.user);
    return res.status(201).json({ book: decorate(book, books.counts(), currentYear()) });
  } catch (err) {
    return next(err);
  }
});

router.put('/:id', ...adminOnly, (req, res, next) => {
  try {
    const book = books.update(req.params.id, req.body, req.user);
    return res.json({ book: decorate(book, books.counts(), currentYear()) });
  } catch (err) {
    return next(err);
  }
});

/** Ngừng dùng / dùng lại. Bộ đếm không bị đụng tới, xem books.setHidden. */
router.post('/:id/hidden', ...adminOnly, (req, res, next) => {
  try {
    const hidden = !!(req.body && req.body.hidden);
    const book = books.setHidden(req.params.id, hidden, req.user);
    return res.json({ book: decorate(book, books.counts(), currentYear()) });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', ...adminOnly, (req, res, next) => {
  try {
    const book = books.remove(req.params.id, req.user);
    return res.json({ ok: true, deleted: { id: book.id, name: book.name } });
  } catch (err) {
    return next(err);
  }
});

/**
 * Đặt lại bộ đếm của một sổ.
 *
 * Trả về số THỰC TẾ sẽ được cấp: nếu giá trị yêu cầu đã bị một văn bản trong sổ
 * chiếm, hệ thống nhảy tới số trống kế tiếp thay vì cấp trùng.
 */
router.post('/:id/reset-counter', ...adminOnly, (req, res, next) => {
  try {
    const book = books.require(req.params.id, false);
    if (book.kind !== 'di') throw badRequest('Sổ đến không có bộ đếm.', 'no_counter');
    const year = currentYear();
    const effective = numbering.resetCounter(book, year, req.body && req.body.nextSeq);
    audit(
      req.user,
      'dat_lai_bo_dem',
      book.name + ' · yêu cầu ' + (req.body && req.body.nextSeq) +
        ' · thực tế sẽ cấp ' + effective.soVanBan +
        (effective.clamped ? ' · bị chặn, bộ đếm không lùi dưới ' + effective.floor : ''),
      null
    );
    return res.json({
      book: decorate(books.get(book.id), books.counts(), year),
      requestedSeq: effective.requested,
      effectiveSeq: effective.seq,
      adjusted: effective.skipped,
      clamped: effective.clamped,
      floor: effective.floor,
    });
  } catch (err) {
    return next(err);
  }
});

/** Bộ đếm hiện tại của một sổ, cho ô “Đặt lại bộ đếm” điền sẵn đúng giá trị. */
router.get('/:id/counter', ...adminOnly, (req, res, next) => {
  try {
    const book = books.require(req.params.id, false);
    if (book.kind !== 'di') return res.json({ counter: null });
    const year = currentYear();
    const scope = numbering.scopeFor(book, year);
    const row = db.prepare(`SELECT next_seq FROM counters WHERE scope = ?`).get(scope);
    const maxSeq = db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS m FROM documents
          WHERE seq_scope = ? AND deleted_at IS NULL`
      )
      .get(scope).m;
    return res.json({
      counter: {
        scope,
        year,
        value: row ? row.next_seq : Math.max(1, book.start),
        maxSeqUsed: maxSeq,
        floor: maxSeq + 1,
      },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = { router };
