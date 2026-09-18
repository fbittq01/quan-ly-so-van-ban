// Kiểm thử API qua HTTP thật, dùng cookie như trình duyệt.
const B = process.env.B || 'http://localhost:3111';
const jars = new Map();

async function req(who, method, url, body) {
  const headers = { 'X-VB-Request': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const cookie = jars.get(who);
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(B + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of set) {
    const kv = c.split(';')[0];
    if (kv.startsWith('vbsid=') && kv !== 'vbsid=') jars.set(who, kv);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log('  ok   ' + name);
  } else {
    fail += 1;
    console.log('  FAIL ' + name + (detail ? '  → ' + detail : ''));
  }
}

const login = (who, username, password) =>
  req(who, 'POST', '/api/login', { username, password });

console.log('\n== chuẩn bị ==');
await login('admin', 'admin', 'admin@2026');
await login('vanthu', 'hant', 'vanthu@123');
await login('xem', 'minhtv', 'chixem@123');
check('ba phiên đăng nhập', jars.size === 3, [...jars.keys()].join(','));

// Sổ là dữ liệu từ 18/09/2026, nên mọi lời gọi phải mang id sổ chứ không còn
// mang hằng 'den' | 'di'. Lấy id từ chính máy chủ để kiểm thử không gắn cứng.
const bookList = (await req('admin', 'GET', '/api/books')).data.books;
const DEN = bookList.find((b) => b.kind === 'den').id;
const DI = bookList.find((b) => b.name === 'Văn bản đi').id;
const DU = bookList.find((b) => b.name === 'Văn bản đi — Đảng ủy').id;
check('ba sổ từ dữ liệu mẫu', !!DEN && !!DI && !!DU, JSON.stringify(bookList.map((b) => b.name)));

console.log('\n== sổ đi chỉ vào sổ bằng đường lấy số ==');
{
  const r = await req('vanthu', 'POST', '/api/documents', {
    book: DI, ngayGui: '2026-06-01', tenVanBan: 'Ghi tay số văn bản đi', soVanBan: '099/2026',
  });
  check('sổ đi: chặn ghi số tay', r.status === 400 && r.data?.code === 'manual_disabled',
    r.status + ' ' + r.data?.error);
}
{
  const r = await req('vanthu', 'POST', '/api/documents', {
    book: DEN, ngayGui: '2026-06-02', tenVanBan: 'Số của cơ quan gửi', soVanBan: '05/TTr-ABC',
  });
  check('sổ đến: 05/TTr-ABC giữ nguyên', r.data?.document?.soVanBan === '05/TTr-ABC',
    r.data?.document?.soVanBan);
}

console.log('\n== tiền tố/hậu tố đặt riêng từng lượt ==');
{
  const a = await req('vanthu', 'POST', '/api/documents', {
    book: DI, mode: 'issue', ngayGui: '2026-06-03', tenVanBan: 'Lượt có tiền tố riêng',
    prefix: 'CV-', suffix: '/2026/P1',
  });
  const b = await req('vanthu', 'POST', '/api/documents', {
    book: DI, mode: 'issue', ngayGui: '2026-06-03', tenVanBan: 'Lượt bỏ trống hai ô',
    prefix: '', suffix: '',
  });
  const c = await req('vanthu', 'POST', '/api/documents', {
    book: DI, mode: 'issue', ngayGui: '2026-06-03', tenVanBan: 'Lượt dùng mặc định của phòng',
  });
  const sa = a.data?.document, sb = b.data?.document, sc = c.data?.document;
  check('tiền tố/hậu tố của lượt được dùng', sa?.soVanBan === 'CV-' + sa?.seq + '/2026/P1', sa?.soVanBan);
  check('bỏ trống cả hai ô thì số là số trần', sb?.soVanBan === String(sb?.seq), sb?.soVanBan);
  check('không gửi gì thì lấy mặc định của phòng', sc?.soVanBan === sc?.seq + '/2026', sc?.soVanBan);
  check('số thứ tự vẫn tăng đều qua ba lượt',
    sb?.seq === sa?.seq + 1 && sc?.seq === sb?.seq + 1,
    JSON.stringify([sa?.seq, sb?.seq, sc?.seq]));
}

console.log('\n== trùng số chỉ xét số thứ tự ==');
{
  // Hai năm sổ khác nhau, cùng hậu tố '/2026' thì ghép ra CHUỖI giống hệt nhau.
  // Trước 11/09/2026 ca này bị chặn; giờ chuỗi không còn là thứ được bảo đảm
  // duy nhất, chỉ số thứ tự trong cùng phạm vi đếm mới là.
  const cu = await req('vanthu', 'POST', '/api/documents', {
    book: DI, mode: 'issue', ngayGui: '2025-12-30', tenVanBan: 'Sổ năm cũ, hậu tố 2026',
    suffix: '/2026',
  });
  check('cấp được số cho sổ năm cũ', cu.status === 201, cu.status + ' ' + cu.data?.error);
  const seqCu = cu.data?.document?.seq;
  const moi = await req('vanthu', 'POST', `/api/books/${DI}/reset-counter`, { nextSeq: seqCu });
  const same = await req('vanthu', 'GET', `/api/documents?book=${DI}&year=2025`);
  check('chuỗi số trùng nhau qua hai năm sổ vẫn hợp lệ',
    cu.status === 201 && same.status === 200, String(same.status));

  // Số thứ tự đã có chủ thì bộ đếm phải nhảy qua, không cấp trùng.
  const mine = await req('vanthu', 'POST', '/api/documents', {
    book: DI, mode: 'issue', ngayGui: '2026-06-04', tenVanBan: 'Giữ chỗ số thứ tự',
  });
  const seqMine = mine.data?.document?.seq;
  const reset = await req('admin', 'POST', `/api/books/${DI}/reset-counter`, { nextSeq: seqMine });
  // Số đó đang có văn bản giữ nên bộ đếm không hạ xuống được: hoặc bị sàn chặn
  // (clamped), hoặc peekNext bò qua (adjusted) — cách nào cũng ra số kế tiếp.
  check('đặt lại bộ đếm về số đã dùng thì nhảy qua',
    reset.data?.effectiveSeq === seqMine + 1 &&
      (reset.data?.adjusted === true || reset.data?.clamped === true),
    JSON.stringify({ eff: reset.data?.effectiveSeq, adj: reset.data?.adjusted, clamp: reset.data?.clamped }));
  const after = await req('vanthu', 'POST', '/api/documents', {
    book: DI, mode: 'issue', ngayGui: '2026-06-04', tenVanBan: 'Sau khi đặt lại',
  });
  check('số cấp sau khi đặt lại không trùng số cũ',
    after.data?.document?.seq === seqMine + 1, String(after.data?.document?.seq));
}

console.log('\n== số của sổ đi không sửa được ==');
{
  const made = await req('vanthu', 'POST', '/api/documents', {
    book: DI, mode: 'issue', ngayGui: '2026-06-05', tenVanBan: 'Sửa thử số đã cấp',
  });
  const id = made.data?.document?.id;
  const so = made.data?.document?.soVanBan;
  const upd = await req('vanthu', 'PUT', '/api/documents/' + id, {
    ngayGui: '2026-06-05', tenVanBan: 'Sửa thử số đã cấp (đã sửa)', soVanBan: 'TU-GO-VAO/9999',
  });
  check('sửa văn bản đi vẫn được', upd.status === 200, upd.status + ' ' + upd.data?.error);
  check('số gửi kèm bị bỏ qua, giữ nguyên số đã cấp', upd.data?.document?.soVanBan === so,
    upd.data?.document?.soVanBan);
}

console.log('\n== báo khi số cấp lệch số dự kiến ==');
{
  const peek = await req('vanthu', 'GET', `/api/documents/next-number?book=${DI}`);
  const duKien = peek.data?.soVanBan;

  // Người khác lấy đúng số đang hiện trên màn hình của mình.
  await req('admin', 'POST', '/api/documents', {
    book: DI, mode: 'issue', ngayGui: '2026-06-06', tenVanBan: 'Người khác lấy trước',
  });

  const r = await req('vanthu', 'POST', '/api/documents', {
    book: DI, mode: 'issue', ngayGui: '2026-06-06', tenVanBan: 'Bị đẩy sang số kế tiếp',
    expectedSoVanBan: duKien,
  });
  check('số bị người khác lấy → báo lệch', r.data?.numberChange?.reason === 'taken',
    JSON.stringify(r.data?.numberChange));
  check('báo lệch kèm số dự kiến và số thật',
    r.data?.numberChange?.expected === duKien && r.data?.numberChange?.actual === r.data?.document?.soVanBan,
    JSON.stringify(r.data?.numberChange));

  // Ghi cho năm sổ khác: số cấp theo sổ năm đó, không theo số dự kiến năm nay.
  const peek2 = await req('vanthu', 'GET', `/api/documents/next-number?book=${DI}`);
  const r2 = await req('vanthu', 'POST', '/api/documents', {
    book: DI, mode: 'issue', ngayGui: '2025-12-31', tenVanBan: 'Cấp số cho sổ năm cũ',
    expectedSoVanBan: peek2.data?.soVanBan,
  });
  check('ghi cho năm khác → báo lệch vì năm', r2.data?.numberChange?.reason === 'year',
    JSON.stringify(r2.data?.numberChange));

  // Đúng như dự kiến thì không báo gì.
  const peek3 = await req('vanthu', 'GET', `/api/documents/next-number?book=${DI}`);
  const r3 = await req('vanthu', 'POST', '/api/documents', {
    book: DI, mode: 'issue', ngayGui: '2026-06-07', tenVanBan: 'Đúng số dự kiến',
    expectedSoVanBan: peek3.data?.soVanBan,
  });
  check('số đúng dự kiến thì không báo', r3.data?.numberChange === null && r3.data?.expectedDiffers === false,
    JSON.stringify(r3.data?.numberChange));
}

console.log('\n== sổ: quản lý (chỉ quản trị) ==');
{
  const r = await req('vanthu', 'POST', '/api/books', { name: 'Sổ của văn thư', kind: 'di' });
  check('văn thư không tạo được sổ', r.status === 403, String(r.status));
  const u = await req('vanthu', 'PUT', `/api/books/${DI}`, { name: 'Đổi tên trộm', kind: 'di', start: 1 });
  check('văn thư không sửa được sổ', u.status === 403, String(u.status));
  const list = await req('xem', 'GET', '/api/books');
  check('ai cũng đọc được danh sách sổ', list.status === 200 && list.data.books.length >= 3,
    String(list.data?.books?.length));
}
for (const [name, body] of [
  ['tên quá ngắn', { name: 'AB', kind: 'di', start: 1 }],
  ['loại sổ lạ', { name: 'Sổ loại lạ', kind: 'ngang', start: 1 }],
  ['bắt đầu từ 0', { name: 'Sổ bắt đầu 0', kind: 'di', start: 0 }],
  ['bắt đầu từ chữ', { name: 'Sổ bắt đầu chữ', kind: 'di', start: 'một' }],
  ['trùng tên sổ có sẵn', { name: 'Văn bản đi', kind: 'di', start: 1 }],
]) {
  const r = await req('admin', 'POST', '/api/books', body);
  check('chặn tạo sổ sai: ' + name, r.status === 400, r.status + ' ' + JSON.stringify(r.data));
}

console.log('\n== hai sổ đi đếm số độc lập ==');
{
  // Đây là lý do cả việc tách sổ tồn tại: bộ đếm phải thuộc về từng sổ, nếu
  // không sổ này lấy số sẽ đẩy số của sổ kia nhảy theo.
  const before = {
    di: (await req('admin', 'GET', `/api/documents/next-number?book=${DI}`)).data.seq,
    du: (await req('admin', 'GET', `/api/documents/next-number?book=${DU}`)).data.seq,
  };
  const cap = await req('vanthu', 'POST', '/api/documents', {
    book: DU, mode: 'issue', ngayGui: '2026-06-08', tenVanBan: 'Lấy số ở sổ Đảng ủy',
  });
  check('lấy được số ở sổ đi thứ hai', cap.status === 201, cap.status + ' ' + cap.data?.error);
  check('số của sổ Đảng ủy mang hậu tố riêng', /-CV\/ĐU$/.test(cap.data?.document?.soVanBan || ''),
    cap.data?.document?.soVanBan);
  const after = {
    di: (await req('admin', 'GET', `/api/documents/next-number?book=${DI}`)).data.seq,
    du: (await req('admin', 'GET', `/api/documents/next-number?book=${DU}`)).data.seq,
  };
  check('bộ đếm sổ Đảng ủy tiến lên', after.du === before.du + 1, before.du + ' → ' + after.du);
  check('bộ đếm sổ đi chính KHÔNG bị kéo theo', after.di === before.di, before.di + ' → ' + after.di);

  // Cùng một số thứ tự tồn tại song song ở hai sổ mà không vi phạm gì.
  const dup = await req('admin', 'POST', `/api/books/${DU}/reset-counter`, { nextSeq: before.di });
  const ok = dup.status === 200;
  check('đặt bộ đếm sổ Đảng ủy về đúng số sổ kia sắp cấp', ok, dup.status + ' ' + dup.data?.error);
  const a = await req('vanthu', 'POST', '/api/documents', {
    book: DI, mode: 'issue', ngayGui: '2026-06-08', tenVanBan: 'Số X ở sổ chính quyền',
  });
  const b = await req('vanthu', 'POST', '/api/documents', {
    book: DU, mode: 'issue', ngayGui: '2026-06-08', tenVanBan: 'Số X ở sổ Đảng ủy',
  });
  check('hai sổ cùng mang một số thứ tự vẫn hợp lệ',
    a.status === 201 && b.status === 201 && a.data.document.seq === b.data.document.seq,
    JSON.stringify({ a: a.data?.document?.seq, b: b.data?.document?.seq, sa: a.status, sb: b.status }));
}

console.log('\n== sổ: sửa, ngừng dùng, xóa ==');
{
  const made = await req('admin', 'POST', '/api/books', {
    name: 'Sổ đi thử nghiệm', kind: 'di', prefix: 'TN-', suffix: '/T', start: 5, resetYearly: true,
  });
  check('tạo sổ mới', made.status === 201, made.status + ' ' + made.data?.error);
  const id = made.data?.book?.id;
  check('số đầu tiên theo "bắt đầu từ"', made.data?.book?.next?.soVanBan === 'TN-5/T',
    made.data?.book?.next?.soVanBan);

  const upd = await req('admin', 'PUT', '/api/books/' + id, {
    name: 'Sổ đi thử nghiệm', kind: 'di', prefix: '', suffix: '-TN', start: 5, resetYearly: false,
  });
  check('sửa tiền tố/hậu tố của sổ', upd.data?.book?.next?.soVanBan === '5-TN',
    upd.data?.book?.next?.soVanBan);

  // Sổ rỗng thì xóa được.
  const del = await req('admin', 'DELETE', '/api/books/' + id);
  check('xóa được sổ rỗng', del.status === 200, del.status + ' ' + del.data?.error);

  // Sổ đã có văn bản thì không.
  const delUsed = await req('admin', 'DELETE', '/api/books/' + DI);
  check('không xóa được sổ đã có văn bản',
    delUsed.status === 400 && delUsed.data?.code === 'book_in_use', JSON.stringify(delUsed.data));

  // Ngừng dùng: đọc vẫn được, ghi thì không.
  const hide = await req('admin', 'POST', `/api/books/${DU}/hidden`, { hidden: true });
  check('ngừng dùng được sổ đã có văn bản', hide.status === 200, hide.status + ' ' + hide.data?.error);
  const readHidden = await req('admin', 'GET', `/api/documents?book=${DU}`);
  check('sổ ngừng dùng vẫn tra cứu được', readHidden.status === 200, String(readHidden.status));
  const writeHidden = await req('vanthu', 'POST', '/api/documents', {
    book: DU, mode: 'issue', ngayGui: '2026-06-09', tenVanBan: 'Ghi vào sổ đã ngừng dùng',
  });
  check('sổ ngừng dùng thì chặn ghi',
    writeHidden.status === 400 && writeHidden.data?.code === 'book_hidden', JSON.stringify(writeHidden.data));
  const hiddenForClerk = (await req('vanthu', 'GET', '/api/books')).data.books.some((b) => b.id === DU);
  check('văn thư không thấy sổ đã ngừng dùng', hiddenForClerk === false, String(hiddenForClerk));

  // Dùng lại: bộ đếm tiếp tục từ chỗ cũ, không nhảy lùi.
  const seqTruoc = (await req('admin', 'GET', `/api/documents/next-number?book=${DU}`)).data.seq;
  await req('admin', 'POST', `/api/books/${DU}/hidden`, { hidden: false });
  const seqSau = (await req('admin', 'GET', `/api/documents/next-number?book=${DU}`)).data.seq;
  check('dùng lại thì bộ đếm không nhảy lùi', seqSau === seqTruoc, seqTruoc + ' → ' + seqSau);
}

console.log('\n== tìm kiếm không dấu ==');
for (const [q, expect] of [['chuyen doi so', true], ['CHUYỂN ĐỔI SỐ', true], ['khong-co-gi-nhu-the-nay', false]]) {
  const r = await req('xem', 'GET', `/api/documents?book=${DEN}&q=` + encodeURIComponent(q));
  check('tìm "' + q + '"', (r.data?.documents?.length > 0) === expect, 'thấy ' + r.data?.documents?.length);
}

console.log('\n== tài khoản (chỉ quản trị) ==');
{
  const r = await req('admin', 'POST', '/api/users', {
    username: 'ktoan', fullName: 'Đỗ Thu Trang', title: 'Kế toán trưởng', role: 'xem', password: 'TamThoi@2026',
  });
  check('thêm tài khoản', r.status === 201 && r.data?.user?.username === 'ktoan', r.status + ' ' + JSON.stringify(r.data?.error));
  check('mặc định buộc đổi mật khẩu', r.data?.user?.mustChangePassword === true, String(r.data?.user?.mustChangePassword));
}
for (const [name, body, code] of [
  ['tên trùng', { username: 'ktoan', fullName: 'X', role: 'xem', password: 'TamThoi@2026' }, 'duplicate'],
  ['tên có dấu cách', { username: 'ke toan', fullName: 'X', role: 'xem', password: 'TamThoi@2026' }, null],
  ['thiếu họ tên', { username: 'abcd', fullName: '', role: 'xem', password: 'TamThoi@2026' }, null],
  ['vai trò lạ', { username: 'abcd', fullName: 'X', role: 'giamdoc', password: 'TamThoi@2026' }, null],
  ['mật khẩu ngắn', { username: 'abcd', fullName: 'X', role: 'xem', password: 'ngan' }, null],
]) {
  const r = await req('admin', 'POST', '/api/users', body);
  check('chặn thêm tk sai: ' + name, r.status === 400 && (!code || r.data?.code === code), r.status + ' ' + r.data?.error);
}
{
  const users = (await req('admin', 'GET', '/api/users')).data.users;
  const me = users.find((u) => u.username === 'admin');
  const ktoan = users.find((u) => u.username === 'ktoan');

  let r = await req('admin', 'POST', `/api/users/${me.id}/lock`, { locked: true });
  check('không tự khóa mình', r.status === 400 && r.data?.code === 'self_lock', r.status + ' ' + r.data?.code);

  r = await req('admin', 'PUT', `/api/users/${me.id}`, { fullName: me.fullName, role: 'xem' });
  check('không tự hạ quyền mình', r.status === 400 && r.data?.code === 'self_role', r.status + ' ' + r.data?.code);

  r = await req('admin', 'DELETE', `/api/users/${me.id}`);
  check('không tự xóa mình', r.status === 400 && r.data?.code === 'self_delete', r.status + ' ' + r.data?.code);

  // Đưa ktoan lên quản trị rồi thử hạ quyền admin duy nhất còn lại
  await req('admin', 'PUT', `/api/users/${ktoan.id}`, { fullName: ktoan.fullName, role: 'admin' });
  r = await req('admin', 'POST', `/api/users/${ktoan.id}/lock`, { locked: true });
  check('khóa được quản trị thứ hai', r.status === 200, String(r.status));
  r = await req('admin', 'POST', `/api/users/${ktoan.id}/lock`, { locked: false });

  r = await req('admin', 'POST', `/api/users/${ktoan.id}/reset-password`);
  check('đặt lại mật khẩu trả về mật khẩu tạm', typeof r.data?.password === 'string' && r.data.password.length >= 12, JSON.stringify(r.data?.password));
  const pw = r.data.password;
  const li = await login('ktoan', 'ktoan', pw);
  check('đăng nhập bằng mật khẩu tạm', li.status === 200 && li.data?.user?.mustChangePassword === true, String(li.status));

  r = await req('ktoan', 'GET', '/api/users');
  check('buộc đổi mật khẩu thì chặn chức năng khác', r.status === 403 && r.data?.code === 'must_change_password', r.status + ' ' + r.data?.code);
  r = await req('ktoan', 'POST', '/api/change-password', { currentPassword: pw, newPassword: 'MoiHoanToan@2026' });
  check('đổi mật khẩu thành công', r.status === 200, r.status + ' ' + r.data?.error);
  r = await req('ktoan', 'GET', '/api/users');
  check('sau khi đổi thì vào được', r.status === 200, String(r.status));

  // dọn: hạ quyền và xóa ktoan
  await req('admin', 'PUT', `/api/users/${ktoan.id}`, { fullName: ktoan.fullName, role: 'xem' });
  r = await req('admin', 'DELETE', `/api/users/${ktoan.id}`);
  check('xóa tài khoản chưa ghi sổ', r.status === 200, r.status + ' ' + r.data?.error);
}
{
  const users = (await req('admin', 'GET', '/api/users')).data.users;
  const ha = users.find((u) => u.username === 'hant');
  const r = await req('admin', 'DELETE', `/api/users/${ha.id}`);
  check('không xóa được người đã ghi sổ', r.status === 400 && r.data?.code === 'has_history', r.status + ' ' + r.data?.code);

  await req('admin', 'POST', `/api/users/${ha.id}/lock`, { locked: true });
  const li = await req('vanthu', 'GET', '/api/users');
  check('khóa tài khoản thì cắt phiên đang mở', li.status === 401, String(li.status));
  await req('admin', 'POST', `/api/users/${ha.id}/lock`, { locked: false });
  // Phiên cũ đã bị cắt khi khóa tài khoản — phải đăng nhập lại để dùng tiếp.
  await login('vanthu', 'hant', 'vanthu@123');
  check('mở khóa rồi đăng nhập lại được', jars.has('vanthu'), 'không có cookie');
}

console.log('\n== dữ liệu vào không hợp lệ ==');
for (const [name, body] of [
  ['ngày sai', { book: DEN, soVanBan: '1/X', ngayGui: '2026-02-31', tenVanBan: 'X' }],
  ['thiếu tên văn bản', { book: DEN, soVanBan: '1/X', ngayGui: '2026-09-10', tenVanBan: '  ' }],
  ['độ bảo mật lạ', { book: DEN, soVanBan: '1/X', ngayGui: '2026-09-10', tenVanBan: 'X', doBaoMat: 'Siêu Mật' }],
  ['sổ lạ', { book: 999999, soVanBan: '1/X', ngayGui: '2026-09-10', tenVanBan: 'X' }],
  ['thiếu số văn bản', { book: DEN, ngayGui: '2026-09-10', tenVanBan: 'X' }],
]) {
  const r = await req('vanthu', 'POST', '/api/documents', body);
  check('chặn: ' + name, r.status === 400, r.status + ' ' + r.data?.error);
}
{
  const r = await req('vanthu', 'GET', `/api/documents?book=${DI}&from=hom-qua`);
  check('chặn lọc ngày sai', r.status === 400, String(r.status));
}

console.log('\n== xóa mềm và khôi phục ==');
{
  // Ghi một văn bản đi có cấp số, rồi xóa nó và khôi phục lại.
  const made = await req('vanthu', 'POST', '/api/documents', {
    book: DI, mode: 'issue', ngayGui: '2026-09-10',
    tenVanBan: 'Văn bản để thử khôi phục', nguoiGui: 'Kiểm thử',
  });
  check('ghi văn bản để thử', made.status === 201, String(made.status));
  const doc = made.data.document;
  const soVanBan = doc.soVanBan;

  const before = await req('vanthu', 'GET', `/api/documents?book=${DI}&year=2026`);
  const beforeTotal = before.data.totalInBook;

  const del = await req('vanthu', 'DELETE', '/api/documents/' + doc.id);
  check('văn thư xóa được', del.status === 200, String(del.status));

  const after = await req('vanthu', 'GET', `/api/documents?book=${DI}&year=2026`);
  check('xóa rồi thì không còn trong sổ',
    !after.data.documents.some((d) => d.id === doc.id));
  check('tổng số trong sổ giảm đi một',
    after.data.totalInBook === beforeTotal - 1,
    beforeTotal + ' → ' + after.data.totalInBook);

  // /years đếm theo LOẠI sổ, nên cột 'di' gộp mọi sổ đi — cộng tay để so.
  const years = await req('vanthu', 'GET', '/api/documents/years');
  const y2026 = years.data.years.find((y) => y.year === 2026);
  const diTrongNam = (
    await Promise.all([DI, DU].map((b) => req('vanthu', 'GET', `/api/documents?book=${b}&year=2026`)))
  ).reduce((n, r) => n + r.data.totalInBook, 0);
  check('không tính vào sổ theo năm', y2026 && y2026.di === diTrongNam,
    JSON.stringify({ y2026, diTrongNam }));

  const edit = await req('vanthu', 'PUT', '/api/documents/' + doc.id, {
    ngayGui: '2026-09-10', tenVanBan: 'Sửa văn bản đã xóa',
  });
  check('không sửa được văn bản đã xóa', edit.status === 404 && edit.data.code === 'deleted',
    edit.status + ' ' + (edit.data && edit.data.code));

  // Xóa là NHẢ SỐ: số đó quay lại thành số kế tiếp sẽ cấp.
  const nn = await req('vanthu', 'GET', `/api/documents/next-number?book=${DI}`);
  check('số của văn bản đã xóa được cấp lại', nn.data.soVanBan === soVanBan,
    nn.data.soVanBan + ' vs ' + soVanBan);

  const nope = await req('vanthu', 'POST', '/api/documents/' + doc.id + '/restore');
  check('văn thư KHÔNG khôi phục được', nope.status === 403, String(nope.status));
  const nope2 = await req('xem', 'POST', '/api/documents/' + doc.id + '/restore');
  check('chỉ xem KHÔNG khôi phục được', nope2.status === 403, String(nope2.status));

  // Chưa ai lấy số đó thì khôi phục trả lại đúng số cũ.
  const back = await req('admin', 'POST', '/api/documents/' + doc.id + '/restore');
  check('quản trị khôi phục được', back.status === 200, String(back.status));
  check('số cũ còn trống thì khôi phục giữ nguyên số',
    back.data.document.soVanBan === soVanBan && back.data.renumbered === null,
    back.data.document.soVanBan + ' vs ' + soVanBan);

  const again = await req('admin', 'POST', '/api/documents/' + doc.id + '/restore');
  check('khôi phục lần hai bị từ chối',
    again.status === 400 && again.data.code === 'not_deleted',
    again.status + ' ' + (again.data && again.data.code));

  const restored = await req('vanthu', 'GET', `/api/documents?book=${DI}&year=2026`);
  check('văn bản trở lại sổ', restored.data.documents.some((d) => d.id === doc.id));
  check('tổng số trong sổ trở lại như trước',
    restored.data.totalInBook === beforeTotal,
    String(restored.data.totalInBook));

  const missing = await req('admin', 'POST', '/api/documents/999999/restore');
  check('khôi phục văn bản không tồn tại → 404', missing.status === 404, String(missing.status));

  // Ca thật của quy tắc mới: X bị xóa, số a sang tay văn bản Y, rồi mới khôi phục X.
  await req('vanthu', 'DELETE', '/api/documents/' + doc.id);
  const y = await req('vanthu', 'POST', '/api/documents', {
    book: DI, mode: 'issue', ngayGui: '2026-09-10', tenVanBan: 'Văn bản Y lấy lại số đã nhả',
  });
  check('văn bản khác nhận đúng số vừa nhả', y.data.document.soVanBan === soVanBan,
    y.data.document.soVanBan + ' vs ' + soVanBan);

  // Nhật ký phải báo TRƯỚC là số cũ đã có chủ, để quản trị biết trước khi bấm.
  const nk = await req('admin', 'GET', '/api/settings/audit?action=xoa_van_ban');
  const dongXoa = nk.data.entries.find((e) => e.docId === doc.id && e.restore &&
    e.restore.state === 'restorable');
  check('nhật ký báo số cũ đã có chủ',
    dongXoa && dongXoa.restore.doc.numberFree === false,
    JSON.stringify(dongXoa && dongXoa.restore.doc.numberFree));
  check('nhật ký nói trước số mới sẽ cấp',
    dongXoa && typeof dongXoa.restore.doc.nextNumber === 'string' &&
      dongXoa.restore.doc.nextNumber !== soVanBan,
    dongXoa && dongXoa.restore.doc.nextNumber);

  const lai = await req('admin', 'POST', '/api/documents/' + doc.id + '/restore');
  check('mất số cũ thì khôi phục vẫn chạy', lai.status === 200, String(lai.status));
  check('khôi phục cấp số khác', lai.data.document.soVanBan !== soVanBan,
    lai.data.document.soVanBan + ' vs ' + soVanBan);
  check('khôi phục báo rõ số cũ → số mới',
    lai.data.renumbered && lai.data.renumbered.from === soVanBan &&
      lai.data.renumbered.to === lai.data.document.soVanBan,
    JSON.stringify(lai.data.renumbered));

  const caHai = await req('vanthu', 'GET', `/api/documents?book=${DI}&year=2026`);
  const soTrongSo = caHai.data.documents.map((d) => d.soVanBan);
  check('sổ không có hai văn bản cùng số',
    new Set(soTrongSo).size === soTrongSo.length, String(soTrongSo.length));
  check('cả X và Y đều ở trong sổ',
    caHai.data.documents.some((d) => d.id === doc.id) &&
      caHai.data.documents.some((d) => d.id === y.data.document.id));

  // Dọn Y để các phép thử sau đếm đúng số dòng như trước.
  await req('vanthu', 'DELETE', '/api/documents/' + y.data.document.id);
  const donXong = await req('vanthu', 'GET', `/api/documents?book=${DI}&year=2026`);
  check('dọn xong thì sổ trở lại như trước', donXong.data.totalInBook === beforeTotal,
    String(donXong.data.totalInBook));
}

console.log('\n== nhật ký: tìm kiếm và trạng thái khôi phục ==');
{
  const mine = await req('vanthu', 'POST', '/api/documents', {
    book: DEN, ngayGui: '2026-09-10', soVanBan: '9999/NK-TEST',
    tenVanBan: 'Giấy triệu tập kiểm kê kho lưu trữ',
  });
  const doc = mine.data.document;
  await req('vanthu', 'DELETE', '/api/documents/' + doc.id);

  const r = await req('admin', 'GET', '/api/settings/audit');
  check('nhật ký trả về mảng entries', Array.isArray(r.data.entries), typeof r.data.entries);
  check('nhật ký báo số văn bản còn khôi phục được', r.data.restorable >= 1,
    String(r.data.restorable));

  const row = r.data.entries.find((e) => e.docId === doc.id && e.action === 'xoa_van_ban');
  check('dòng xóa có docId', !!row, JSON.stringify(row && row.docId));
  check('dòng xóa khôi phục được', row && row.restore && row.restore.state === 'restorable',
    row && row.restore && row.restore.state);
  check('kèm thông tin văn bản để hiện trong nhật ký',
    row && row.restore.doc && row.restore.doc.soVanBan === '9999/NK-TEST',
    row && row.restore.doc && row.restore.doc.soVanBan);

  // Tìm không phụ thuộc dấu, đúng như tìm trong sổ.
  const found = await req('admin', 'GET', '/api/settings/audit?q=' + encodeURIComponent('kiem ke kho'));
  check('tìm nhật ký không cần dấu',
    found.data.entries.some((e) => e.docId === doc.id),
    String(found.data.entries.length));

  const byAction = await req('admin', 'GET', '/api/settings/audit?action=xoa_van_ban');
  check('lọc theo loại việc',
    byAction.data.entries.length > 0 &&
      byAction.data.entries.every((e) => e.action === 'xoa_van_ban'),
    String(byAction.data.entries.length));

  const bad = await req('admin', 'GET', '/api/settings/audit?action=KHONG@HOP-LE');
  check('chặn loại việc không hợp lệ', bad.status === 400, String(bad.status));

  const paged = await req('admin', 'GET', '/api/settings/audit?limit=2');
  check('phân trang trả đúng số dòng', paged.data.entries.length === 2,
    String(paged.data.entries.length));
  check('phân trang báo còn nữa', paged.data.hasMore === true, String(paged.data.hasMore));
  const page2 = await req('admin', 'GET', '/api/settings/audit?limit=2&offset=2');
  check('trang sau khác trang trước',
    page2.data.entries[0] && paged.data.entries[0] &&
      page2.data.entries[0].id !== paged.data.entries[0].id);

  await req('admin', 'POST', '/api/documents/' + doc.id + '/restore');
  const after = await req('admin', 'GET', '/api/settings/audit?action=xoa_van_ban');
  const row2 = after.data.entries.find((e) => e.docId === doc.id);
  check('khôi phục rồi thì dòng xóa đổi trạng thái',
    row2 && row2.restore.state === 'restored', row2 && row2.restore.state);
  const restoreRow = after.data.entries.length >= 0 &&
    (await req('admin', 'GET', '/api/settings/audit?action=khoi_phuc_van_ban')).data.entries
      .find((e) => e.docId === doc.id);
  check('việc khôi phục được ghi vào nhật ký', !!restoreRow,
    JSON.stringify(restoreRow && restoreRow.action));

  const forbidden = await req('vanthu', 'GET', '/api/settings/audit');
  check('văn thư không đọc được nhật ký', forbidden.status === 403, String(forbidden.status));

  // Dọn lại: bộ kiểm thử giao diện chạy trên cùng cơ sở dữ liệu này và có
  // những phép thử đếm đúng số dòng trong sổ.
  await req('vanthu', 'DELETE', '/api/documents/' + doc.id);
}

console.log('\n== bộ đếm không lùi qua số đang dùng ==');
{
  const snap = await req('admin', 'GET', `/api/books/${DI}/counter`);
  const maxUsed = snap.data.counter.maxSeqUsed;
  check('có số lớn nhất đang dùng', typeof maxUsed === 'number', String(maxUsed));

  const down = await req('admin', 'POST', `/api/books/${DI}/reset-counter`, { nextSeq: 1 });
  check('đặt bộ đếm về 1 bị chặn', down.data.clamped === true, String(down.data.clamped));
  check('sàn là số lớn nhất đã dùng + 1', down.data.floor === maxUsed + 1,
    down.data.floor + ' vs ' + (maxUsed + 1));
  check('bộ đếm không xuống dưới sàn', down.data.effectiveSeq >= maxUsed + 1,
    String(down.data.effectiveSeq));

  const up = await req('admin', 'POST', `/api/books/${DI}/reset-counter`, {
    nextSeq: maxUsed + 500,
  });
  check('đẩy bộ đếm lên thì không bị chặn', up.data.clamped === false, String(up.data.clamped));
  check('bộ đếm nhận giá trị cao hơn', up.data.effectiveSeq === maxUsed + 500,
    String(up.data.effectiveSeq));

  const backDown = await req('admin', 'POST', `/api/books/${DI}/reset-counter`, {
    nextSeq: maxUsed + 1,
  });
  check('vẫn sửa lại được về sát sàn khi nhập nhầm',
    backDown.data.effectiveSeq === maxUsed + 1 && backDown.data.clamped === false,
    String(backDown.data.effectiveSeq));
}

console.log('\n== đăng xuất ==');
{
  await req('xem', 'POST', '/api/logout');
  const r = await req('xem', 'GET', `/api/documents?book=${DEN}`);
  check('phiên hết hiệu lực sau đăng xuất', r.status === 401, String(r.status));
}

console.log('\n' + (fail === 0 ? 'TẤT CẢ ' + pass + ' PHÉP THỬ ĐỀU ĐẠT' : pass + ' đạt, ' + fail + ' KHÔNG ĐẠT'));
process.exit(fail === 0 ? 0 : 1);
