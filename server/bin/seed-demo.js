#!/usr/bin/env node
'use strict';

/**
 * Nạp dữ liệu thử giống bản thiết kế, để xem thử giao diện với sổ đã có dữ liệu.
 * KHÔNG chạy trên máy chủ dùng thật — mọi mật khẩu ở đây đều là mật khẩu mẫu.
 *
 *   npm run seed-demo
 *   npm run seed-demo -- --force     (nạp dù cơ sở dữ liệu đã có dữ liệu)
 */

require('../env');

const { db } = require('../db');
const auth = require('../auth');
const numbering = require('../numbering');
const { strip, nowIso } = require('../util');

const force = process.argv.includes('--force');

const docCount = db.prepare(`SELECT COUNT(*) AS n FROM documents`).get().n;
const userCount = db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
if ((docCount > 0 || userCount > 0) && !force) {
  console.error(
    'Cơ sở dữ liệu đã có ' + userCount + ' tài khoản và ' + docCount + ' văn bản.'
  );
  console.error('Thêm --force nếu vẫn muốn nạp thêm dữ liệu thử.');
  process.exit(1);
}

const USERS = [
  ['admin', 'Lê Quốc Bảo', 'Chánh Văn phòng', 'admin', 'admin@2026', 0],
  ['hant', 'Nguyễn Thị Hà', 'Văn thư — Phòng Hành chính', 'vanthu', 'vanthu@123', 0],
  ['minhtv', 'Trần Văn Minh', 'Phó Chánh Văn phòng', 'xem', 'chixem@123', 0],
  ['thuptt', 'Phạm Thị Thu', 'Văn thư — Bộ phận một cửa', 'vanthu', 'vanthu@456', 1],
];

const DEN = [
  ['2145/UBND-VP', '2026-09-02', 'UBND Tỉnh — Văn phòng', 'Về việc triển khai kế hoạch chuyển đổi số quý IV', 'Thường', 'Chuyển phòng Kế hoạch xử lý trước 10/09'],
  ['87/SNV-TCCB', '2026-08-28', 'Sở Nội vụ', 'Hướng dẫn rà soát biên chế năm 2026', 'Mật', 'Đã trình lãnh đạo ngày 29/08'],
  ['19/CA-PA03', '2026-08-21', 'Công an Tỉnh — PA03', 'Yêu cầu phối hợp bảo đảm an ninh mạng nội bộ', 'Tối Mật', 'Lưu tủ hồ sơ mật, không sao chụp'],
  ['3312/BTC-NSNN', '2026-08-14', 'Bộ Tài chính', 'Thông báo phân bổ dự toán ngân sách bổ sung', 'Thường', ''],
  ['05/TTr-TCT', '2026-07-30', 'Công ty CP Xây dựng Thành Đạt', 'Tờ trình đề nghị nghiệm thu hạng mục nhà điều hành', 'Thường', 'Số do cơ quan gửi ghi — giữ nguyên, không bỏ số 0'],
  ['4120/UBND-KT', '2025-12-09', 'UBND Tỉnh — Phòng Kinh tế', 'Về việc quyết toán kinh phí hoạt động năm 2025', 'Thường', 'Sổ 2025 — đã lưu hồ sơ quyết toán'],
];

// Văn bản đi: seq là số thứ tự thật, số hiển thị do cấu hình lấy số ghép ra.
const DI = [
  [6, '2026-09-05', 'Nguyễn Thị Hà — Văn thư', 'Báo cáo kết quả thực hiện nhiệm vụ tháng 8/2026', 'Thường', 'Gửi UBND Tỉnh, bản giấy + bản điện tử'],
  [5, '2026-08-27', 'Trần Văn Minh — Phó Chánh VP', 'Công văn trả lời Sở Nội vụ về rà soát biên chế', 'Mật', 'Phúc đáp văn bản đến 87/SNV-TCCB'],
  [4, '2026-08-12', 'Nguyễn Thị Hà — Văn thư', 'Giấy mời họp giao ban quý III', 'Thường', 'Gửi 14 đơn vị trực thuộc'],
  [3, '2026-07-19', 'Lê Quốc Bảo — Chánh Văn phòng', 'Kế hoạch bảo vệ bí mật nhà nước năm 2026', 'Tuyệt Mật', 'Chỉ phát hành 03 bản có đánh số'],
  [42, '2025-12-18', 'Lê Quốc Bảo — Chánh Văn phòng', 'Báo cáo tổng kết công tác văn thư lưu trữ năm 2025', 'Thường', 'Sổ 2025 — đã đóng sổ ngày 31/12/2025'],
  [41, '2025-11-04', 'Nguyễn Thị Hà — Văn thư', 'Công văn đề nghị cấp bổ sung trang thiết bị lưu trữ', 'Thường', 'Gửi Sở Tài chính'],
];

const CFG = { prefix: '', suffix: '/' + new Date().getFullYear(), start: 1, resetYearly: true };

function viDate(iso) {
  const p = iso.split('-');
  return p[2] + '/' + p[1] + '/' + p[0];
}

function searchText(parts, ngayGui) {
  return strip(parts.concat([ngayGui, viDate(ngayGui)]).join(' '));
}

const insertUser = db.prepare(
  `INSERT INTO users (username, full_name, title, email, role, password_hash,
                      must_change_password, locked, created_at, created_by)
   VALUES (?, ?, ?, '', ?, ?, 0, ?, ?, NULL)
   ON CONFLICT(username) DO NOTHING`
);

const insertDoc = db.prepare(
  `INSERT INTO documents (book, so_van_ban, seq, seq_scope, year, ngay_gui, nguoi_gui,
                          ten_van_ban, do_bao_mat, ghi_chu, search_text, created_at, created_by)
   VALUES (@book, @so, @seq, @scope, @year, @ngay, @nguoi, @ten, @bao_mat, @ghi_chu,
           @search, @created, @by)`
);

db.transaction(() => {
  for (const [username, name, title, role, password, locked] of USERS) {
    insertUser.run(username, name, title, role, auth.hashPassword(password), locked, nowIso());
  }
  const adminId = db.prepare(`SELECT id FROM users WHERE username = 'admin'`).get().id;
  const haId = db.prepare(`SELECT id FROM users WHERE username = 'hant'`).get().id;

  db.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('numbering', ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(JSON.stringify(CFG), nowIso(), adminId);

  for (const [so, ngay, nguoi, ten, baoMat, ghiChu] of DEN) {
    insertDoc.run({
      book: 'den', so, seq: null, scope: null,
      year: Number.parseInt(ngay.slice(0, 4), 10), ngay, nguoi, ten,
      bao_mat: baoMat, ghi_chu: ghiChu,
      search: searchText([so, nguoi, ten, ghiChu, baoMat], ngay),
      created: nowIso(), by: haId,
    });
  }

  const maxByScope = new Map();
  for (const [seq, ngay, nguoi, ten, baoMat, ghiChu] of DI) {
    const year = Number.parseInt(ngay.slice(0, 4), 10);
    const scope = numbering.scopeFor(CFG, year);
    // Dữ liệu mẫu trải nhiều năm, nên hậu tố dựng theo năm của chính văn bản
    // chứ không dùng hậu tố mặc định của năm nay.
    const so = numbering.buildNumber(CFG.prefix, seq, '/' + year);
    insertDoc.run({
      book: 'di', so, seq, scope, year, ngay, nguoi, ten,
      bao_mat: baoMat, ghi_chu: ghiChu,
      search: searchText([so, nguoi, ten, ghiChu, baoMat], ngay),
      created: nowIso(), by: haId,
    });
    maxByScope.set(scope, Math.max(maxByScope.get(scope) || 0, seq));
  }

  // Bộ đếm phải đứng sau số lớn nhất đã dùng, nếu không lần lấy số đầu tiên
  // sẽ phải nhảy qua một loạt số đã chiếm.
  for (const [scope, max] of maxByScope) {
    db.prepare(
      `INSERT INTO counters (scope, next_seq) VALUES (?, ?)
       ON CONFLICT(scope) DO UPDATE SET next_seq = excluded.next_seq`
    ).run(scope, max + 1);
  }
})();

const year = new Date().getFullYear();
console.log('Đã nạp dữ liệu thử.');
console.log('  văn bản đến : ' + DEN.length);
console.log('  văn bản đi  : ' + DI.length);
console.log('  số kế tiếp  : ' + numbering.peekNext(CFG, year).soVanBan);
console.log('');
console.log('Tài khoản thử (mật khẩu chỉ dùng để xem thử, đổi ngay nếu dùng thật):');
for (const [username, name, , role, password, locked] of USERS) {
  console.log(
    '  ' + username.padEnd(8) + ' ' + password.padEnd(12) + ' ' + role.padEnd(7) +
      ' ' + name + (locked ? ' (đã khóa)' : '')
  );
}
