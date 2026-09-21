'use strict';

/**
 * Trường riêng của từng sổ.
 *
 * Từ 18/09/2026 một sổ không chỉ có tên và cách đánh số mà còn có BỘ TRƯỜNG
 * của riêng nó: sổ đến cần “Cơ quan gửi · Hạn xử lý”, sổ hợp đồng cần “Đối tác
 * · Giá trị”, sổ đi cần “Người ký”. Trước đó những thứ này là cột cứng
 * (nguoi_gui, do_bao_mat, ghi_chu) và lặp lại ở bốn chỗ; giờ chúng là dữ liệu:
 *
 *   books.fields    — mảng JSON định nghĩa trường (hình dạng ở normalizeDefs)
 *   documents.extra — JSON { <key>: giá_trị } của từng văn bản
 *
 * Phần LÕI vẫn là cột cứng và không sổ nào bỏ được: số văn bản, số thứ tự,
 * năm, ngày gửi, tên văn bản, đính kèm, xóa mềm. Đó là những gì máy chủ cần
 * để cấp số, chống trùng số, lọc theo năm và khôi phục — đẩy chúng vào JSON
 * là tự tay phá bộ đếm.
 *
 * Module này THUẦN: không đụng cơ sở dữ liệu, chỉ kiểm tra và chuẩn hóa. Việc
 * kiểm tra có dính dữ liệu (đổi kiểu khi đã có giá trị, bỏ trường đang dùng)
 * nằm ở books.js, nơi có db.
 */

const crypto = require('node:crypto');
const { strip, text, multiline, isIsoDate, badRequest, SECURITY_LEVELS } = require('./util');

const TYPES = ['text', 'textarea', 'date', 'number', 'select', 'checkbox'];
const TYPE_LABEL = {
  text: 'Chữ một dòng',
  textarea: 'Chữ nhiều dòng',
  date: 'Ngày',
  number: 'Số',
  select: 'Chọn một',
  checkbox: 'Có / không',
};

const MAX_FIELDS = 30;
const MAX_TABLE = 4;
const MAX_LABEL = 60;
const MAX_OPTIONS = 30;
const MAX_TEXT = 500;
const MAX_TEXTAREA = 4000;
// Khóa là mã ổn định, sinh một lần. Chữ và số và gạch dưới, để nhét được vào
// json_extract('$.<key>') mà không cần thoát ký tự.
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

function newKey() {
  return 'f_' + crypto.randomBytes(3).toString('hex');
}

/**
 * Bộ trường mặc định của hai loại sổ có sẵn.
 *
 * Khóa ở đây CỐ Ý không phải mã ngẫu nhiên mà là tên cũ của ba cột cứng: bước
 * chuyển đổi trong db.js chép nguoi_gui → extra.nguoiGui, v.v. Mọi sổ tạo
 * trước 18/09/2026 đều mang đúng ba trường này, và sổ tạo về sau chọn “Mặc
 * định” cũng vậy — nên tên trường trên giao diện và trong kiểm thử không đổi.
 */
function defaultFields(kind) {
  return [
    {
      key: 'nguoiGui',
      label: kind === 'di' ? 'Người ký / đơn vị soạn' : 'Cơ quan gửi',
      type: 'text',
      required: false,
      table: true,
      hidden: false,
    },
    {
      key: 'doBaoMat',
      label: 'Độ bảo mật',
      type: 'select',
      options: SECURITY_LEVELS.slice(),
      required: false,
      table: true,
      hidden: false,
    },
    { key: 'ghiChu', label: 'Ghi chú', type: 'textarea', required: false, table: true, hidden: false },
  ];
}

/** Đọc cột books.fields. Cột hỏng thì coi như sổ không có trường riêng, không sập. */
function parseDefs(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Đọc cột documents.extra. */
function parseExtra(raw) {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * Kiểm tra và chuẩn hóa mảng định nghĩa do quản trị gửi lên.
 *
 * Trả về mảng sạch, mỗi phần tử đúng hình dạng:
 *   { key, label, type, required, table, hidden, options? }
 *
 * Trường chưa có `key` là trường mới: sinh mã. Trường có `key` phải khớp mẫu
 * và không trùng nhau trong cùng sổ. Việc kiểm “key này đã có dữ liệu chưa”
 * để lại cho books.js.
 */
function normalizeDefs(input) {
  if (input == null) return null;
  if (!Array.isArray(input)) throw badRequest('Danh sách trường không đúng dạng.', 'bad_fields');
  if (input.length > MAX_FIELDS) {
    throw badRequest('Một sổ có tối đa ' + MAX_FIELDS + ' trường.', 'too_many_fields');
  }

  const seen = new Set();
  const out = [];
  input.forEach((f, i) => {
    if (!f || typeof f !== 'object') throw badRequest('Trường thứ ' + (i + 1) + ' không đúng dạng.', 'bad_fields');

    const label = text(f.label, MAX_LABEL);
    if (!label) throw badRequest('Trường thứ ' + (i + 1) + ' chưa có tên.', 'field_no_label');

    const type = String(f.type || 'text');
    if (!TYPES.includes(type)) throw badRequest('Trường “' + label + '” có kiểu không hợp lệ.', 'bad_field_type');

    let key = f.key == null || f.key === '' ? newKey() : String(f.key);
    if (!KEY_RE.test(key)) throw badRequest('Trường “' + label + '” có mã không hợp lệ.', 'bad_field_key');
    // Cực hiếm, nhưng hai trường mới trong cùng lượt có thể va mã.
    while (seen.has(key)) key = newKey();
    seen.add(key);

    const def = {
      key,
      label,
      type,
      required: !!f.required,
      table: !!f.table,
      hidden: !!f.hidden,
    };
    if (type === 'select') {
      const raw = Array.isArray(f.options) ? f.options : [];
      const opts = [];
      for (const o of raw) {
        const s = text(o, MAX_LABEL);
        if (s && !opts.includes(s)) opts.push(s);
      }
      if (opts.length === 0) {
        throw badRequest('Trường “' + label + '” kiểu chọn một cần ít nhất một lựa chọn.', 'select_no_options');
      }
      if (opts.length > MAX_OPTIONS) {
        throw badRequest('Trường “' + label + '” có quá nhiều lựa chọn (tối đa ' + MAX_OPTIONS + ').', 'too_many_options');
      }
      def.options = opts;
    }
    out.push(def);
  });

  // Bảng sổ đã có bảy cột; thả cửa thì tràn ngang và mất tính tra cứu. Trường
  // không lên bảng vẫn xem và sửa được trong hộp thoại.
  const onTable = out.filter((d) => d.table && !d.hidden).length;
  if (onTable > MAX_TABLE) {
    throw badRequest('Tối đa ' + MAX_TABLE + ' trường hiện trên bảng sổ. Bỏ chọn “Hiện trên bảng” ở vài trường.', 'too_many_table');
  }
  return out;
}

/** Trường đang dùng: hiện trên form, nhận giá trị mới. */
function visible(defs) {
  return defs.filter((d) => !d.hidden);
}

/** Đối tượng giá trị gửi lên: JSON chuỗi (multipart) hoặc object (JSON body). */
function readRawExtra(body) {
  const v = body ? body.extra : undefined;
  if (v == null || v === '') return {};
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      throw badRequest('Dữ liệu các trường không đọc được.', 'bad_extra');
    }
  }
  return typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/** Giá trị “trống” theo nghĩa của từng kiểu — để kiểm bắt buộc và để tìm kiếm. */
function isEmpty(def, v) {
  if (v == null) return true;
  if (def.type === 'checkbox') return v !== true;
  if (def.type === 'number') return typeof v !== 'number';
  return String(v).trim() === '';
}

/**
 * Kiểm tra và chuẩn hóa giá trị của MỘT văn bản theo định nghĩa của sổ.
 *
 * `existing` là extra đang lưu (khi sửa). Trường đã ẩn hoặc đã bỏ khỏi định
 * nghĩa KHÔNG bị xóa giá trị: chúng được giữ nguyên từ `existing` — sửa tên
 * văn bản không được làm mất “Hạn xử lý” chỉ vì quản trị vừa ẩn trường đó.
 */
function readExtra(defs, body, existing) {
  const raw = readRawExtra(body);
  const out = Object.assign({}, existing || {});

  for (const def of visible(defs)) {
    let v = raw[def.key];
    switch (def.type) {
      case 'text':
        v = text(v, MAX_TEXT);
        break;
      case 'textarea':
        v = multiline(v, MAX_TEXTAREA);
        break;
      case 'date':
        v = String(v == null ? '' : v).trim();
        if (v && !isIsoDate(v)) throw badRequest('“' + def.label + '” không phải ngày hợp lệ.', 'bad_date');
        break;
      case 'number': {
        const s = String(v == null ? '' : v).trim().replace(',', '.');
        if (s === '') {
          v = null;
        } else {
          const n = Number(s);
          if (!Number.isFinite(n)) throw badRequest('“' + def.label + '” phải là số.', 'bad_number');
          v = n;
        }
        break;
      }
      case 'select':
        v = String(v == null ? '' : v).trim();
        if (v && !def.options.includes(v)) {
          throw badRequest('“' + def.label + '” không nằm trong các lựa chọn.', 'bad_option');
        }
        break;
      case 'checkbox':
        v = v === true || v === 'true' || v === '1' || v === 1 || v === 'on';
        break;
      default:
        v = null;
    }
    if (def.required && isEmpty(def, v)) {
      throw badRequest('Chưa nhập “' + def.label + '”.', 'field_required');
    }
    if (isEmpty(def, v) && def.type !== 'checkbox') {
      // Không lưu khóa trống: json_extract trả NULL cho cả hai, và extra gọn hơn.
      delete out[def.key];
    } else {
      out[def.key] = v;
    }
  }
  return out;
}

/**
 * Phần chữ của extra để nhét vào search_text.
 *
 * Không cần định nghĩa: mọi giá trị chữ và số đều đáng tìm, kể cả của trường
 * đã ẩn — văn thư nhớ “hợp đồng với Thành Đạt” chứ không nhớ trường đó còn
 * hiện hay không. Ngày kèm bản dd/mm/yyyy như ngày gửi.
 */
function searchParts(extra) {
  const parts = [];
  for (const v of Object.values(extra || {})) {
    if (typeof v === 'string') {
      parts.push(v);
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      if (m) parts.push(m[3] + '/' + m[2] + '/' + m[1]);
    } else if (typeof v === 'number') {
      parts.push(String(v));
    }
  }
  return parts;
}

/**
 * Cột tìm kiếm của một văn bản: lõi + mọi giá trị trong extra, bỏ dấu.
 * Nhận hàng thô (tên cột) vì cả docs.js lẫn bước chuyển đổi trong db.js đều
 * cầm hàng thô trong tay.
 */
function docSearchText(d) {
  const p = String(d.ngay_gui || '').split('-');
  const viDate = p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : '';
  const extra = typeof d.extra === 'string' ? parseExtra(d.extra) : d.extra || {};
  return strip(
    [d.so_van_ban, d.ten_van_ban, d.ngay_gui, viDate].concat(searchParts(extra)).join(' ')
  );
}

module.exports = {
  TYPES,
  TYPE_LABEL,
  MAX_FIELDS,
  MAX_TABLE,
  KEY_RE,
  defaultFields,
  parseDefs,
  parseExtra,
  normalizeDefs,
  visible,
  readExtra,
  isEmpty,
  searchParts,
  docSearchText,
};
