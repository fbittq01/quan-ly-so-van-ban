'use strict';

const { db } = require('./db');
const { badRequest } = require('./util');

const SEGMENT_TYPES = ['seq', 'year', 'yy', 'text'];
const MAX_SEGMENTS = 12;
const MAX_TEXT_LEN = 24;

/** Ghép số văn bản từ cấu trúc thành phần. Số thứ tự KHÔNG bao giờ đệm 0 ở đầu. */
function buildNumber(segments, seq, year) {
  return segments
    .map((sg) => {
      if (sg.type === 'seq') return String(seq);
      if (sg.type === 'year') return String(year);
      if (sg.type === 'yy') return String(year).slice(2);
      return sg.text || '';
    })
    .join('');
}

/**
 * Kiểm tra và chuẩn hóa cấu hình lấy số do quản trị gửi lên.
 * Ném lỗi 400 kèm thông báo tiếng Việt hiển thị được cho người dùng.
 */
function validateNumbering(input) {
  if (!input || typeof input !== 'object') throw badRequest('Thiếu cấu hình lấy số.');

  const raw = Array.isArray(input.segments) ? input.segments : null;
  if (!raw) throw badRequest('Thiếu cấu trúc số.');
  if (raw.length === 0) throw badRequest('Cấu trúc số phải có ít nhất một thành phần.');
  if (raw.length > MAX_SEGMENTS) {
    throw badRequest('Cấu trúc số không được quá ' + MAX_SEGMENTS + ' thành phần.');
  }

  const segments = raw.map((sg) => {
    const type = sg && typeof sg.type === 'string' ? sg.type : '';
    if (!SEGMENT_TYPES.includes(type)) throw badRequest('Thành phần không hợp lệ: ' + type);
    if (type !== 'text') return { type };
    // Bỏ ký tự điều khiển; giữ nguyên phần còn lại để không đổi ý người dùng.
    const text = String(sg.text == null ? '' : sg.text)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .slice(0, MAX_TEXT_LEN);
    if (text.trim() === '') {
      throw badRequest(
        'Có ô “Ký tự cố định” đang để trống — điền dấu phân cách hoặc bỏ thành phần đó.'
      );
    }
    return { type: 'text', text };
  });

  const seqCount = segments.filter((sg) => sg.type === 'seq').length;
  if (seqCount === 0) {
    throw badRequest(
      'Cấu trúc phải có đúng một thành phần “Số thứ tự” — nếu không, mọi văn bản sẽ mang cùng một số.'
    );
  }
  if (seqCount > 1) {
    throw badRequest('Chỉ được một thành phần “Số thứ tự”. Bỏ các thành phần trùng.');
  }

  const start = Number.parseInt(input.start, 10);
  if (!Number.isFinite(start) || start < 1 || start > 1000000) {
    throw badRequest('“Bắt đầu từ” phải là số nguyên từ 1 trở lên.');
  }

  return { segments, start, resetYearly: input.resetYearly !== false };
}

/** Phạm vi đếm: theo năm khi reset đầu năm, dùng chung khi tăng liên tục. */
function scopeFor(cfg, year) {
  return cfg.resetYearly ? String(year) : 'all';
}

/**
 * Một chuỗi số có được phép lặp lại ở năm sổ khác không.
 *
 * Chỉ được phép khi bộ đếm reset đầu năm MÀ cấu trúc số không có thành phần
 * năm — lúc đó sổ 2026 và sổ 2027 đều có “1”, “2”… và đó là đúng nghiệp vụ.
 * Ngược lại, hễ cấu trúc có năm ('1/2026') hoặc bộ đếm tăng liên tục, chuỗi số
 * là duy nhất trên toàn sổ đi, không riêng gì một năm.
 */
function numbersRepeatYearly(cfg) {
  const hasYear = cfg.segments.some((sg) => sg.type === 'year' || sg.type === 'yy');
  return cfg.resetYearly !== false && !hasYear;
}

// Chỉ tra văn bản CÒN TRONG SỔ: số của văn bản đã xóa được nhả ra, ai lấy số
// tiếp theo hoặc ghi tay đều chiếm lại được.
const soTakenInYearStmt = db.prepare(
  `SELECT id, year FROM documents
    WHERE book = 'di' AND year = ? AND so_van_ban = ? AND deleted_at IS NULL`
);
const soTakenAnyYearStmt = db.prepare(
  `SELECT id, year FROM documents
    WHERE book = 'di' AND so_van_ban = ? AND deleted_at IS NULL`
);

/**
 * Năm sổ đang giữ chuỗi số này, hoặc null nếu còn trống.
 *
 * Phạm vi tra cứu KHÔNG phải lúc nào cũng là năm của ngày gửi: khi cấu trúc số
 * đã mang sẵn năm ('5/2026'), chuỗi đó phải là duy nhất trên toàn sổ. Nếu chỉ
 * tra theo năm của ngày gửi thì một văn bản ghi tay số '5/2026' nhưng đề ngày
 * 30/12/2025 sẽ nằm ở năm sổ 2025, lọt qua mọi kiểm tra, rồi sang 2026 hệ thống
 * cấp lại đúng '5/2026' cho văn bản khác — sổ có hai văn bản cùng số.
 *
 * excludeId để lúc sửa một văn bản, chính nó không tự coi là trùng với mình.
 */
function numberTakenBy(cfg, year, soVanBan, excludeId) {
  const rows = numbersRepeatYearly(cfg)
    ? soTakenInYearStmt.all(year, soVanBan)
    : soTakenAnyYearStmt.all(soVanBan);
  for (const r of rows) {
    if (excludeId != null && r.id === excludeId) continue;
    return r.year;
  }
  return null;
}

const seqTakenStmt = db.prepare(
  `SELECT id FROM documents WHERE seq_scope = ? AND seq = ? AND deleted_at IS NULL`
);

/** Số thứ tự này có đang bị một văn bản trong sổ giữ không. */
function seqTaken(scope, seq, excludeId) {
  if (seq == null || !scope) return false;
  const row = seqTakenStmt.get(scope, seq);
  if (!row) return false;
  return excludeId == null || row.id !== excludeId;
}

const counterStmt = db.prepare(`SELECT next_seq FROM counters WHERE scope = ?`);

/**
 * Số kế tiếp sẽ được cấp, KHÔNG ghi gì vào cơ sở dữ liệu.
 *
 * Bỏ qua những số thứ tự hoặc chuỗi số đang bị một văn bản TRONG SỔ giữ —
 * chuyện này xảy ra khi văn thư ghi tay một văn bản đi, khi quản trị đặt lại bộ
 * đếm về một giá trị đã dùng, hoặc khi bộ đếm vừa bị kéo lùi về chỗ một số đã
 * xóa. Nhảy tới số trống kế tiếp an toàn hơn là cấp trùng số.
 */
function peekNext(cfg, year) {
  const scope = scopeFor(cfg, year);
  const row = counterStmt.get(scope);
  let seq = Math.max(row ? row.next_seq : cfg.start, cfg.start);
  let soVanBan = '';
  let skipped = false;
  for (let guard = 0; guard < 100000; guard += 1) {
    soVanBan = buildNumber(cfg.segments, seq, year);
    if (numberTakenBy(cfg, year, soVanBan) === null && !seqTaken(scope, seq)) break;
    seq += 1;
    skipped = true;
  }
  return { seq, scope, soVanBan, skipped };
}

const saveCounterStmt = db.prepare(
  `INSERT INTO counters (scope, next_seq) VALUES (?, ?)
   ON CONFLICT(scope) DO UPDATE SET next_seq = excluded.next_seq`
);

/**
 * Chiếm số kế tiếp và đẩy bộ đếm lên.
 * PHẢI gọi bên trong một transaction cùng với lệnh INSERT văn bản, nếu không
 * số sẽ bị chiếm mà văn bản không được ghi vào sổ.
 */
function allocate(cfg, year) {
  const next = peekNext(cfg, year);
  saveCounterStmt.run(next.scope, next.seq + 1);
  return next;
}

const lowerCounterStmt = db.prepare(
  `INSERT INTO counters (scope, next_seq) VALUES (?, ?)
   ON CONFLICT(scope) DO UPDATE SET next_seq = MIN(next_seq, excluded.next_seq)`
);

/**
 * Nhả số của một văn bản vừa bị xóa khỏi sổ, để nó được cấp lại.
 *
 * Bỏ hai unique index ra thôi thì chưa đủ: số được “trống” nhưng bộ đếm vẫn ở
 * phía trên nó, nên người lấy số kế tiếp vẫn nhận số mới chứ không nhận lại số
 * vừa xóa — đúng ca hay gặp nhất là văn thư lấy nhầm số rồi xóa đi lấy lại.
 * Nên kéo bộ đếm về chính số vừa nhả, và chỉ kéo XUỐNG (MIN): xóa một số cũ ở
 * giữa sổ không được phép kéo bộ đếm lùi qua hàng loạt số đang dùng — peekNext
 * sẽ tự bò lên, bỏ qua mọi số còn văn bản giữ.
 *
 * PHẢI gọi trong cùng transaction với lệnh đánh dấu đã xóa.
 */
function release(cfg, seqScope, seq) {
  if (seq == null || !seqScope) return false;
  lowerCounterStmt.run(seqScope, Math.max(seq, cfg.start));
  return true;
}

/**
 * Số cũ của một văn bản đã xóa có còn trống để trả lại cho chính nó không.
 *
 * Phải hỏi CẢ HAI: chuỗi số ('5/2026') và số thứ tự. Chúng lệch nhau được — sau
 * khi quản trị đổi cấu trúc số, một văn bản khác có thể đang giữ số thứ tự 5 mà
 * chuỗi số lại là '5/CV-2026'. Chỉ kiểm một trong hai thì lệnh khôi phục sẽ vỡ
 * vì unique index.
 *
 * row là một hàng documents thô (cần id, book, year, so_van_ban, seq, seq_scope).
 */
function oldNumberFree(cfg, row) {
  if (row.book !== 'di') return true;
  return (
    numberTakenBy(cfg, row.year, row.so_van_ban, row.id) === null &&
    !seqTaken(row.seq_scope, row.seq, row.id)
  );
}

// Sàn của bộ đếm chỉ tính văn bản CÒN TRONG SỔ, cùng lý do như hai câu trên:
// số của văn bản đã xóa không còn là “số đã dùng”.
const maxSeqStmt = db.prepare(
  `SELECT COALESCE(MAX(seq), 0) AS m FROM documents
    WHERE seq_scope = ? AND deleted_at IS NULL`
);

/**
 * Đặt lại bộ đếm; trả về số thực tế sẽ được cấp sau khi đặt lại.
 *
 * Giá trị lưu bị chặn dưới bởi số thứ tự lớn nhất của văn bản CÒN TRONG SỔ ở
 * phạm vi đếm, cộng một. Văn bản đã xóa không tính: số của nó đã được nhả ra,
 * nên đặt bộ đếm về đó là hợp lệ.
 *
 * Sàn MAX+1 vẫn cho phép sửa ca nhập nhầm — gõ 500 lúc chưa phát hành số nào ở
 * đó thì vẫn kéo về được — mà chặn ca kéo lùi qua một vùng số đang có văn bản
 * dùng, vì lùi vào đó chỉ làm peekNext bò lại lên đúng chỗ cũ.
 */
function resetCounter(cfg, year, nextSeq) {
  const n = Number.parseInt(nextSeq, 10);
  if (!Number.isFinite(n) || n < 1 || n > 1000000) {
    throw badRequest('Số kế tiếp phải là số nguyên từ 1 trở lên.');
  }
  const scope = scopeFor(cfg, year);
  const floor = maxSeqStmt.get(scope).m + 1;
  const stored = Math.max(n, floor, cfg.start);
  saveCounterStmt.run(scope, stored);
  const out = peekNext(cfg, year);
  out.requested = n;
  out.floor = floor;
  out.clamped = stored !== n;
  return out;
}

module.exports = {
  buildNumber,
  validateNumbering,
  scopeFor,
  numbersRepeatYearly,
  numberTakenBy,
  seqTaken,
  oldNumberFree,
  peekNext,
  allocate,
  release,
  resetCounter,
  SEGMENT_TYPES,
};
