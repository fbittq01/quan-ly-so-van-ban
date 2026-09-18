'use strict';

const { db, audit } = require('./db');
const { badRequest, text, nowIso } = require('./util');
const { cleanAffix, MAX_AFFIX_LEN } = require('./numbering');

const MAX_NAME_LEN = 80;
const KINDS = ['den', 'di'];

/**
 * Hàng `books` thô → đối tượng sổ dùng khắp máy chủ.
 *
 * Tên trường trùng với JSON trả ra cho trình duyệt, nên chỉ có MỘT hình dạng
 * “sổ” trong cả hệ thống. numbering.js nhận đúng đối tượng này thay cho cấu
 * hình lấy số dùng chung ngày trước.
 */
function toBook(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    prefix: r.prefix || '',
    suffix: r.suffix || '',
    start: r.start_seq,
    resetYearly: !!r.reset_yearly,
    hidden: !!r.hidden,
    sortOrder: r.sort_order,
  };
}

const allStmt = db.prepare(`SELECT * FROM books ORDER BY sort_order, id`);
const oneStmt = db.prepare(`SELECT * FROM books WHERE id = ?`);

function all() {
  return allStmt.all().map(toBook);
}

function get(id) {
  const n = Number.parseInt(id, 10);
  if (!Number.isFinite(n)) return null;
  return toBook(oneStmt.get(n));
}

/**
 * Sổ cho một yêu cầu, hoặc ném lỗi.
 *
 * `forWrite` dùng cho mọi đường GHI: một sổ đã ngừng dùng vẫn tra cứu được
 * nhưng không nhận văn bản mới. Đây là ranh giới thật ở máy chủ, không phải
 * chuyện giao diện ẩn nút — ẩn nút không chặn được ai gọi thẳng API.
 */
function require_(id, forWrite) {
  const book = get(id);
  if (!book) throw badRequest('Sổ không tồn tại.', 'no_book');
  if (forWrite && book.hidden) {
    throw badRequest(
      'Sổ “' + book.name + '” đã ngừng dùng nên không ghi thêm được. Quản trị viên bật lại ở Cài đặt → Sổ.',
      'book_hidden'
    );
  }
  return book;
}

/** Số văn bản CÒN TRONG SỔ của từng sổ, để hiện bên cạnh tên sổ. */
function counts() {
  const rows = db
    .prepare(
      `SELECT book_id AS id, COUNT(*) AS n FROM documents
        WHERE deleted_at IS NULL AND book_id IS NOT NULL GROUP BY book_id`
    )
    .all();
  const out = new Map();
  rows.forEach((r) => out.set(r.id, r.n));
  return out;
}

/** Kể cả văn bản đã xóa mềm: sổ còn giữ hàng đã xóa thì chưa phải sổ rỗng. */
function totalEverCount(bookId) {
  return db
    .prepare(`SELECT COUNT(*) AS n FROM documents WHERE book_id = ?`)
    .get(bookId).n;
}

/**
 * Kiểm tra và chuẩn hóa dữ liệu một sổ do quản trị gửi lên.
 *
 * `existing` có khi đang sửa. Hai thứ không đổi được khi sổ đã có văn bản:
 * loại sổ (đổi 'di' thành 'den' thì đống số đã cấp mất chỗ dựa) — còn tiền tố,
 * hậu tố và cách reset thì đổi thoải mái, chúng chỉ ảnh hưởng số cấp từ giờ
 * trở đi, không sửa số đã in ra giấy.
 */
function validate(input, existing) {
  if (!input || typeof input !== 'object') throw badRequest('Thiếu thông tin sổ.');

  const name = text(input.name, MAX_NAME_LEN);
  if (name.length < 3) throw badRequest('Tên sổ cần ít nhất 3 ký tự.');

  const kind = String(input.kind || (existing ? existing.kind : ''));
  if (!KINDS.includes(kind)) throw badRequest('Loại sổ phải là “đến” hoặc “đi”.');
  if (existing && kind !== existing.kind && totalEverCount(existing.id) > 0) {
    throw badRequest(
      'Sổ đã có văn bản nên không đổi được loại. Tạo sổ mới nếu cần loại khác.',
      'kind_locked'
    );
  }

  const clash = db
    .prepare(`SELECT id FROM books WHERE name = ? AND id IS NOT ?`)
    .get(name, existing ? existing.id : null);
  if (clash) throw badRequest('Đã có sổ mang tên “' + name + '”.', 'dup_name');

  // Sổ đến không cấp số nên mọi thứ về đánh số đều vô nghĩa với nó; ép về mặc
  // định thay vì lưu giá trị chết mà giao diện không bao giờ hiện.
  if (kind === 'den') {
    return { name, kind, prefix: '', suffix: '', start: 1, resetYearly: true };
  }

  const start = Number.parseInt(input.start, 10);
  if (!Number.isFinite(start) || start < 1 || start > 1000000) {
    throw badRequest('“Bắt đầu từ” phải là số nguyên từ 1 trở lên.');
  }

  return {
    name,
    kind,
    prefix: cleanAffix(input.prefix),
    suffix: cleanAffix(input.suffix),
    start,
    resetYearly: input.resetYearly !== false,
  };
}

function create(input, user) {
  const v = validate(input, null);
  const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM books`).get().m;
  const info = db
    .prepare(
      `INSERT INTO books (name, kind, prefix, suffix, start_seq, reset_yearly, hidden, sort_order, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    )
    .run(
      v.name,
      v.kind,
      v.prefix,
      v.suffix,
      v.start,
      v.resetYearly ? 1 : 0,
      maxOrder + 1,
      nowIso(),
      user.id
    );
  const book = get(info.lastInsertRowid);
  audit(
    user,
    'tao_so',
    book.name + ' · ' + (book.kind === 'di' ? 'văn bản đi' : 'văn bản đến') +
      (book.kind === 'di' ? ' · số đầu tiên ' + book.prefix + book.start + book.suffix : ''),
    null
  );
  return book;
}

function update(id, input, user) {
  const existing = require_(id, false);
  const v = validate(input, existing);
  db.prepare(
    `UPDATE books SET name = ?, kind = ?, prefix = ?, suffix = ?, start_seq = ?, reset_yearly = ?
      WHERE id = ?`
  ).run(v.name, v.kind, v.prefix, v.suffix, v.start, v.resetYearly ? 1 : 0, existing.id);
  const book = get(existing.id);

  const changes = [];
  if (existing.name !== book.name) changes.push('tên: ' + existing.name + ' → ' + book.name);
  if (existing.prefix !== book.prefix) changes.push('tiền tố: “' + existing.prefix + '” → “' + book.prefix + '”');
  if (existing.suffix !== book.suffix) changes.push('hậu tố: “' + existing.suffix + '” → “' + book.suffix + '”');
  if (existing.start !== book.start) changes.push('bắt đầu từ: ' + existing.start + ' → ' + book.start);
  if (existing.resetYearly !== book.resetYearly) {
    changes.push('reset đầu năm: ' + (book.resetYearly ? 'có' : 'không'));
  }
  audit(user, 'sua_so', book.name + (changes.length ? ' · ' + changes.join(' · ') : ' · không đổi gì'), null);
  return book;
}

/**
 * Ngừng dùng / dùng lại một sổ.
 *
 * Ngừng dùng KHÔNG đụng tới bộ đếm: dùng lại thì số tiếp tục từ chỗ đã dừng,
 * không nhảy lùi về đè lên số đã phát hành.
 */
function setHidden(id, hidden, user) {
  const book = require_(id, false);
  if (book.hidden === hidden) return book;

  // Phải còn ít nhất một sổ dùng được, nếu không văn thư mở ứng dụng ra thấy
  // trống trơn và không tự sửa được (mục Sổ chỉ quản trị vào).
  if (hidden) {
    const live = db.prepare(`SELECT COUNT(*) AS n FROM books WHERE hidden = 0`).get().n;
    if (live <= 1) {
      throw badRequest('Đây là sổ đang dùng cuối cùng — ngừng dùng nốt thì không còn sổ nào để ghi.', 'last_book');
    }
  }

  db.prepare(`UPDATE books SET hidden = ? WHERE id = ?`).run(hidden ? 1 : 0, book.id);
  audit(user, hidden ? 'ngung_dung_so' : 'dung_lai_so', book.name, null);
  return get(book.id);
}

/**
 * Xóa hẳn một sổ — CHỈ khi sổ chưa từng có văn bản nào.
 *
 * Kể cả văn bản đã xóa mềm cũng chặn: những hàng đó là bằng chứng số đã từng
 * được phát hành, và quản trị còn khôi phục lại được. Sổ đã dùng thì đường ra
 * duy nhất là “ngừng dùng”.
 */
function remove(id, user) {
  const book = require_(id, false);
  const ever = totalEverCount(book.id);
  if (ever > 0) {
    throw badRequest(
      'Sổ “' + book.name + '” đã có ' + ever + ' văn bản nên không xóa được. Dùng “Ngừng dùng” để thôi dùng sổ này.',
      'book_in_use'
    );
  }
  const live = db.prepare(`SELECT COUNT(*) AS n FROM books`).get().n;
  if (live <= 1) throw badRequest('Không xóa được sổ cuối cùng.', 'last_book');

  db.transaction(() => {
    // Bộ đếm của sổ rỗng chưa cấp số nào thật, nhưng quản trị có thể đã bấm
    // "đặt lại bộ đếm"; dọn luôn để tên sổ mới trùng id cũ không thừa hưởng nó.
    db.prepare(`DELETE FROM counters WHERE scope LIKE ?`).run(book.id + ':%');
    db.prepare(`DELETE FROM books WHERE id = ?`).run(book.id);
    audit(user, 'xoa_so', book.name + ' · sổ rỗng, chưa phát hành số nào', null);
  })();
  return book;
}

module.exports = {
  all,
  get,
  require: require_,
  counts,
  totalEverCount,
  validate,
  create,
  update,
  setHidden,
  remove,
  toBook,
  MAX_NAME_LEN,
  MAX_AFFIX_LEN,
};
