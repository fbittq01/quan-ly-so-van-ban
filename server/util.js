'use strict';

/** Bỏ dấu tiếng Việt và hạ chữ thường, để tìm kiếm không phụ thuộc dấu. */
function strip(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .toLowerCase();
}

/**
 * Bỏ số 0 ở đầu mỗi nhóm chữ số: '06/2026' -> '6/2026', 'CV-08' -> 'CV-8'.
 * Năm và các số nhiều chữ số giữ nguyên ('2026', '10' không đổi).
 */
function noLeadZero(s) {
  return String(s == null ? '' : s).replace(/(^|[^0-9])0+(\d)/g, '$1$2');
}

/** Ngày hôm nay theo giờ địa phương, dạng yyyy-mm-dd. */
function today() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function nowIso() {
  return new Date().toISOString();
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(s) {
  if (!ISO_DATE.test(String(s || ''))) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Tên tiếng Việt của từng việc trong nhật ký.
 *
 * Đây là nguồn duy nhất: máy chủ dùng để dựng cột tìm kiếm (gõ “xóa văn bản”
 * phải ra dòng có action 'xoa_van_ban'), và giao diện lấy đúng bảng này qua
 * /api/config để hiện. Hai bản sao sẽ lệch nhau sớm thôi.
 */
const AUDIT_ACTION_LABEL = {
  dang_nhap: 'Đăng nhập',
  dang_xuat: 'Đăng xuất',
  doi_mat_khau: 'Đổi mật khẩu',
  cap_so: 'Cấp số văn bản',
  ghi_so: 'Ghi văn bản vào sổ',
  sua_van_ban: 'Sửa văn bản',
  xoa_van_ban: 'Xóa văn bản',
  khoi_phuc_van_ban: 'Khôi phục văn bản',
  sua_cai_dat_lay_so: 'Sửa cài đặt lấy số',
  dat_lai_bo_dem: 'Đặt lại bộ đếm',
  tao_so: 'Tạo sổ',
  sua_so: 'Sửa sổ',
  ngung_dung_so: 'Ngừng dùng sổ',
  dung_lai_so: 'Dùng lại sổ',
  xoa_so: 'Xóa sổ',
  them_tai_khoan: 'Thêm tài khoản',
  sua_tai_khoan: 'Sửa tài khoản',
  khoa_tai_khoan: 'Khóa tài khoản',
  mo_khoa_tai_khoan: 'Mở khóa tài khoản',
  dat_lai_mat_khau: 'Đặt lại mật khẩu',
  xoa_tai_khoan: 'Xóa tài khoản',
  khai_khen_thuong: 'Khai báo khen thưởng',
  sua_khen_thuong: 'Sửa khen thưởng',
  rut_khen_thuong: 'Rút / xóa khen thưởng',
  duyet_khen_thuong: 'Duyệt khen thưởng',
  tra_khen_thuong: 'Trả lại khen thưởng',
  xuat_khen_thuong: 'Xuất tổng hợp khen thưởng',
  cai_dat_khen_thuong: 'Cài đặt khen thưởng',
  init_admin_create: 'Tạo quản trị từ dòng lệnh',
  init_admin_reset: 'Cấp lại mật khẩu quản trị từ dòng lệnh',
};

const SECURITY_LEVELS = ['Thường', 'Mật', 'Tối Mật', 'Tuyệt Mật'];
const ROLES = ['admin', 'vanthu', 'xem'];

/**
 * Loại sổ. Ba loại, khác nhau ở chỗ ai đặt số văn bản:
 *   'den'   — số do cơ quan gửi ghi, văn thư nhập lại nguyên văn, bắt buộc
 *   'di'    — hệ thống cấp số, văn bản gửi ra ngoài
 *   'noibo' — văn bản ban hành trong đơn vị, không gửi đi đâu (16/10/2026).
 *             KHÔNG cấp số: nhiều văn bản nội bộ (biên bản, kế hoạch) không
 *             đánh số, nên ô số/ký hiệu ghi tay và được để trống.
 *
 * Mọi chỗ cần hỏi “sổ này có cấp số không” gọi issuesNumber, và “số có được
 * để trống không” gọi numberOptional — đừng so `kind` trực tiếp.
 */
const BOOK_KINDS = ['den', 'di', 'noibo'];
const KIND_LABEL = { den: 'văn bản đến', di: 'văn bản đi', noibo: 'văn bản nội bộ' };

function issuesNumber(kind) {
  return kind === 'di';
}

function numberOptional(kind) {
  return kind === 'noibo';
}
const ROLE_LABEL = { admin: 'Quản trị', vanthu: 'Nhân viên', xem: 'Chỉ xem' };

/** Chuẩn hóa chuỗi người dùng nhập: gộp khoảng trắng, cắt hai đầu, chặn độ dài. */
function text(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Giữ nguyên xuống dòng (dùng cho ghi chú), chỉ cắt hai đầu và chặn độ dài. */
function multiline(v, max) {
  return String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max);
}

function intOr(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || null;
  }
}

/** Lỗi 400 kèm thông báo hiển thị được cho người dùng. */
function badRequest(message, code) {
  return new HttpError(400, message, code);
}

module.exports = {
  strip,
  noLeadZero,
  today,
  nowIso,
  isIsoDate,
  text,
  multiline,
  intOr,
  HttpError,
  badRequest,
  SECURITY_LEVELS,
  ROLES,
  ROLE_LABEL,
  BOOK_KINDS,
  KIND_LABEL,
  issuesNumber,
  numberOptional,
  AUDIT_ACTION_LABEL,
};
