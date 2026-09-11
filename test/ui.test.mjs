// Kiểm thử giao diện bằng Chromium thật: đi đúng các luồng người dùng sẽ đi.
import { chromium } from 'playwright';

const B = process.env.B || 'http://localhost:3111';
const SHOT = process.env.SHOT || new URL('./shots', import.meta.url).pathname;

let pass = 0;
let fail = 0;
const problems = [];
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log('  ok   ' + name);
  } else {
    fail += 1;
    problems.push(name + (detail ? ' → ' + detail : ''));
    console.log('  FAIL ' + name + (detail ? '  → ' + detail : ''));
  }
}

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
);
const errors = [];

async function session(label) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Bỏ qua log của các response 4xx mà chính bộ test cố tình gây ra.
    if (/Failed to load resource/.test(m.text())) return;
    errors.push(label + ': ' + m.text());
  });
  page.on('pageerror', (e) => errors.push(label + ' pageerror: ' + e.message));
  return { ctx, page };
}

/**
 * Một tệp PDF HỢP LỆ, dựng tại chỗ, có chữ để vẽ ra được.
 *
 * Phải hợp lệ thật (đủ xref và trailer) chứ không phải mấy byte '%PDF' giả:
 * trình xem PDF của ứng dụng tự phân tích tệp bằng pdf.js, tệp giả sẽ không vẽ
 * ra gì và phép thử mất hết ý nghĩa.
 */
function pdfThat(soTrang) {
  const objs = new Map();
  const kids = [];
  for (let i = 0; i < soTrang; i += 1) kids.push(3 + i * 2 + ' 0 R');
  const fontId = 3 + soTrang * 2;
  objs.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objs.set(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${soTrang} >>`);
  for (let i = 0; i < soTrang; i += 1) {
    const id = 3 + i * 2;
    const noiDung =
      `BT /F1 28 Tf 60 740 Td (TRANG ${i + 1} / ${soTrang}) Tj ` +
      `0 -50 Td /F1 16 Tf (Quyet dinh so 1234/QD-UBND) Tj ET`;
    objs.set(id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${id + 1} 0 R >>`);
    objs.set(id + 1, `<< /Length ${noiDung.length} >>\nstream\n${noiDung}\nendstream`);
  }
  objs.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let out = '%PDF-1.4\n';
  const offs = new Map();
  for (const id of [...objs.keys()].sort((a, b) => a - b)) {
    offs.set(id, out.length);
    out += `${id} 0 obj\n${objs.get(id)}\nendobj\n`;
  }
  const xref = out.length;
  const max = Math.max(...objs.keys());
  out += `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= max; id += 1) {
    out += String(offs.get(id) || 0).padStart(10, '0') + ' 00000 n \n';
  }
  out += `trailer\n<< /Size ${max + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * Một tệp .docx HỢP LỆ, dựng tại chỗ, để LibreOffice chuyển được sang PDF.
 *
 * Tự gói ZIP thay vì nhét sẵn một tệp nhị phân vào repo: bộ thử phải đọc được,
 * và ba tệp XML dưới đây là mức tối thiểu mà LibreOffice chấp nhận.
 */
function docxThat(chu) {
  const files = [
    ['[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>'],
    ['_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Target="word/document.xml" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"/>' +
      '</Relationships>'],
    ['word/document.xml',
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      // Cỡ chữ lớn để trang có nhiều mực, phép thử đếm điểm ảnh mới chắc ăn.
      '<w:p><w:pPr><w:rPr><w:sz w:val="72"/></w:rPr></w:pPr>' +
      '<w:r><w:rPr><w:sz w:val="72"/></w:rPr><w:t xml:space="preserve">' + chu + '</w:t></w:r></w:p>' +
      '<w:p><w:r><w:rPr><w:sz w:val="48"/></w:rPr><w:t>Quyet dinh so 1234/QD-UBND</w:t></w:r></w:p>' +
      '</w:body></w:document>'],
  ];

  const bang = [];
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    bang[i] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = bang[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  // ZIP không nén (method 0): đủ đúng chuẩn, và khỏi phải lo deflate.
  const locals = [];
  const central = [];
  let off = 0;
  for (const [ten, noi] of files) {
    const name = Buffer.from(ten, 'utf8');
    const data = Buffer.from(noi, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8); // method = store
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(off, 42);
    central.push(cd, name);
    off += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

async function login(page, username, password) {
  await page.goto(B, { waitUntil: 'networkidle' });
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[autocomplete="current-password"]', password);
  await page.click('button:has-text("Đăng nhập")');
}

// ------------------------------------------------------------------ đăng nhập
console.log('\n== đăng nhập ==');
{
  const { page } = await session('login');
  await page.goto(B, { waitUntil: 'networkidle' });
  check('hiện màn đăng nhập', await page.locator('text=Đăng nhập hệ thống').isVisible());
  check('nói rõ không tự đăng ký', await page.locator('text=không cho tự đăng ký').isVisible());
  await page.screenshot({ path: SHOT + '/01-dang-nhap.png' });

  // sai mật khẩu: phải giữ lại tên đăng nhập đã gõ
  await page.fill('input[autocomplete="username"]', 'admin');
  await page.fill('input[autocomplete="current-password"]', 'sai-mat-khau');
  await page.click('button:has-text("Đăng nhập")');
  await page.waitForSelector('.note-error');
  check('báo sai mật khẩu', (await page.locator('.note-error').innerText()).includes('không đúng'));
  check('giữ lại tên đăng nhập đã gõ', (await page.inputValue('input[autocomplete="username"]')) === 'admin',
    await page.inputValue('input[autocomplete="username"]'));

  // hiện/ẩn mật khẩu
  await page.click('.pw-toggle');
  check('nút Hiện đổi ô thành text', (await page.getAttribute('input[autocomplete="current-password"]', 'type')) === 'text');
  await page.screenshot({ path: SHOT + '/02-sai-mat-khau.png' });
}

// -------------------------------------------------------------------- văn thư
console.log('\n== vai trò Nhân viên ==');
const vt = await session('vanthu');
{
  const page = vt.page;
  await login(page, 'hant', 'vanthu@123');
  await page.waitForSelector('.topbar');
  check('vào được sổ', await page.locator('.brand-name').isVisible());
  check('hiện tên và vai trò', (await page.locator('.topbar-right').innerText()).includes('Nhân viên'));
  check('KHÔNG có tab Cài đặt', (await page.locator('.tab:has-text("Cài đặt")').count()) === 0);
  check('có nút lấy số', await page.locator('button:has-text("Lấy số gửi văn bản đi")').isVisible());
  const nut = await page.locator('button:has-text("Lấy số gửi văn bản đi")').innerText();
  check('nút lấy số có số dự kiến, không 0 ở đầu', /\d+\/\d{4}/.test(nut) && !/\s0\d/.test(nut), nut);
  check('bảng sổ đến có dữ liệu', (await page.locator('tbody tr').count()) > 0);
  await page.screenshot({ path: SHOT + '/03-so-van-ban-den.png', fullPage: true });

  // tìm không dấu
  await page.fill('input[type="search"]', 'chuyen doi so');
  await page.waitForTimeout(600);
  check('tìm không dấu ra kết quả', (await page.locator('tbody tr').count()) === 1, String(await page.locator('tbody tr').count()));
  await page.fill('input[type="search"]', '');
  await page.waitForTimeout(600);

  // lấy số
  await page.click('button:has-text("Lấy số gửi văn bản đi")');
  await page.waitForSelector('.dialog');
  const duKien = await page.locator('.issued-value').innerText();
  check('hộp thoại hiện số dự kiến', /\d+\/\d{4}/.test(duKien), duKien);
  await page.screenshot({ path: SHOT + '/04-lay-so.png' });

  // lưu thiếu tên văn bản -> báo lỗi trong hộp thoại
  await page.click('.dialog button:has-text("Cấp số & lưu vào sổ")');
  await page.waitForSelector('.dialog-error:not(:empty)');
  check('chặn thiếu tên văn bản', (await page.locator('.dialog-error').innerText()).includes('tên văn bản'));

  await page.fill('.dialog input[placeholder="Trích yếu nội dung văn bản"]', 'Công văn thử qua giao diện');
  await page.fill('.dialog input[placeholder="Đơn vị hoặc cá nhân"]', 'Nguyễn Thị Hà — Văn thư');
  await page.click('.dialog button:has-text("Cấp số & lưu vào sổ")');
  await page.waitForSelector('.toast');
  const t = await page.locator('.toast').first().innerText();
  check('cấp số xong và báo lại', t.includes('Đã cấp số ' + duKien), t);
  await page.waitForSelector('.dialog', { state: 'detached' });
  check('chuyển sang tab văn bản đi', (await page.locator('.tab.active').innerText()).includes('Văn bản đi'));
  check('văn bản mới có trong sổ', (await page.locator('tbody tr:has-text("Công văn thử qua giao diện")').count()) === 1);
  const soMoi = await page.locator('tbody tr:has-text("Công văn thử qua giao diện") .cell-num').innerText();
  check('số ghi trong sổ khớp số đã cấp', soMoi === duKien, soMoi + ' vs ' + duKien);
  await page.screenshot({ path: SHOT + '/05-so-van-ban-di.png', fullPage: true });

  // ghi thủ công số có 0 ở đầu
  await page.click('button:has-text("+ Ghi thủ công")');
  await page.waitForSelector('.dialog');
  await page.fill('.dialog input[placeholder="VD: 142/CV-SNV"]', '077/2026');
  await page.fill('.dialog input[placeholder="Trích yếu nội dung văn bản"]', 'Ghi tay có 0 ở đầu');
  await page.click('.dialog button:has-text("Lưu")');
  await page.waitForSelector('.dialog', { state: 'detached' });
  const soTay = await page.locator('tbody tr:has-text("Ghi tay có 0 ở đầu") .cell-num').innerText();
  check('077/2026 lưu thành 77/2026', soTay === '77/2026', soTay);

  // sửa: số hệ thống cấp thì khóa
  await page.click('tbody tr:has-text("Công văn thử qua giao diện") button:has-text("Sửa")');
  await page.waitForSelector('.dialog');
  check('số do hệ thống cấp bị khóa không sửa', await page.locator('.dialog input.mono[disabled]').isVisible());
  await page.click('.dialog button:has-text("Hủy")');
  await page.waitForSelector('.dialog', { state: 'detached' });

  // người khác lấy mất số trong lúc mình đang nhập -> phải popup báo, không toast
  await page.click('button:has-text("Lấy số gửi văn bản đi")');
  await page.waitForSelector('.dialog');
  const duKien2 = await page.locator('.issued-value').innerText();

  const { page: pKhac } = await session('lay-so-truoc');
  await login(pKhac, 'admin', 'admin@2026');
  await pKhac.waitForSelector('.topbar');
  await pKhac.click('button:has-text("Lấy số gửi văn bản đi")');
  await pKhac.waitForSelector('.issued-value');
  check('hai người cùng thấy một số dự kiến',
    (await pKhac.locator('.issued-value').innerText()) === duKien2, duKien2);
  await pKhac.fill('.dialog input[placeholder="Trích yếu nội dung văn bản"]', 'Người khác lấy số trước');
  await pKhac.click('.dialog button:has-text("Cấp số & lưu vào sổ")');
  await pKhac.waitForSelector('.dialog', { state: 'detached' });

  await page.fill('.dialog input[placeholder="Trích yếu nội dung văn bản"]', 'Nhận số kế tiếp qua giao diện');
  await page.click('.dialog button:has-text("Cấp số & lưu vào sổ")');
  await page.waitForSelector('.num-change');
  check('popup báo số khác dự kiến',
    (await page.locator('.dialog-title').innerText()).includes('khác với dự kiến'),
    await page.locator('.dialog-title').innerText());
  check('popup hiện số dự kiến cũ', (await page.locator('.num-change-old').innerText()) === duKien2,
    await page.locator('.num-change-old').innerText());
  const soThat = await page.locator('.num-change-new').innerText();
  check('popup hiện số đã cấp, khác số cũ', soThat !== duKien2, soThat + ' vs ' + duKien2);
  check('popup nhắc sửa bản giấy',
    (await page.locator('.dialog .note').innerText()).includes('bản giấy'));
  await page.screenshot({ path: SHOT + '/18-so-khac-du-kien.png' });
  await page.click('.dialog button:has-text("Đã hiểu")');
  await page.waitForSelector('.dialog', { state: 'detached' });
  const soTrongSo = await page.locator('tbody tr:has-text("Nhận số kế tiếp qua giao diện") .cell-num').innerText();
  check('văn bản vào sổ đúng số đã báo', soTrongSo === soThat, soTrongSo + ' vs ' + soThat);
  await pKhac.close();
}

// -------------------------------------------------------------------- chỉ xem
console.log('\n== vai trò Chỉ xem ==');
{
  const { page } = await session('xem');
  await login(page, 'minhtv', 'chixem@123');
  await page.waitForSelector('.topbar');
  check('KHÔNG có tab Cài đặt', (await page.locator('.tab:has-text("Cài đặt")').count()) === 0);
  check('KHÔNG có nút lấy số', (await page.locator('button:has-text("Lấy số gửi văn bản đi")').count()) === 0);
  check('KHÔNG có nút ghi sổ', (await page.locator('button:has-text("Ghi văn bản đến")').count()) === 0);
  check('KHÔNG có nút Sửa/Xóa trên dòng', (await page.locator('tbody button:has-text("Sửa")').count()) === 0);
  check('nói rõ vai trò chỉ xem', await page.locator('text=Vai trò Chỉ xem').isVisible());
  await page.screenshot({ path: SHOT + '/06-chi-xem.png', fullPage: true });
}

// ------------------------------------------------------------------ quản trị
console.log('\n== vai trò Quản trị · cài đặt lấy số ==');
const ad = await session('admin');
{
  const page = ad.page;
  await login(page, 'admin', 'admin@2026');
  await page.waitForSelector('.topbar');
  check('CÓ tab Cài đặt', (await page.locator('.tab:has-text("Cài đặt")').count()) === 1);
  await page.click('.tab:has-text("Cài đặt")');
  await page.waitForSelector('.segments');
  check('hiện nhãn chỉ quản trị', await page.locator('.admin-chip').isVisible());
  check('có 3 thành phần mặc định', (await page.locator('.segment').count()) === 3);
  check('quy tắc không 0 ở đầu là cố định', (await page.locator('.rule').innerText()).includes('Cố định'));
  check('không còn ô "Số chữ số"', (await page.locator('text=Số chữ số').count()) === 0);

  const truoc = await page.locator('.next-number-value').innerText();
  check('có số kế tiếp', /\d+\/\d{4}/.test(truoc), truoc);
  check('xem trước có 6 dòng', (await page.locator('.section:has-text("3 · Xem trước") tbody tr').count()) === 6);
  await page.screenshot({ path: SHOT + '/07-cai-dat-lay-so.png', fullPage: true });

  // bỏ thành phần "Số thứ tự" -> phải chặn lưu
  await page.locator('.segment.is-seq .icon-btn.danger').click();
  await page.waitForSelector('.note-error');
  check('bỏ Số thứ tự thì báo lỗi', (await page.locator('.note-error').innerText()).includes('đúng một thành phần'));
  check('nút Lưu bị tắt khi cấu trúc sai', await page.locator('button:has-text("Lưu cài đặt")').isDisabled());
  check('số kế tiếp thành —', (await page.locator('.next-number-value').innerText()) === '—');
  await page.screenshot({ path: SHOT + '/08-cau-truc-sai.png' });

  await page.click('button:has-text("Hủy thay đổi")');
  await page.waitForTimeout(200);
  check('hủy thay đổi trả lại 3 thành phần', (await page.locator('.segment').count()) === 3);

  // đổi mẫu bằng preset rồi lưu
  await page.click('.preset:has-text("-CV")');
  await page.waitForTimeout(150);
  check('trạng thái báo chưa lưu', (await page.locator('.savebar-status').innerText()).includes('chưa lưu'));
  await page.click('button:has-text("Lưu cài đặt")');
  await page.waitForSelector('.toast');
  const tt = await page.locator('.toast').first().innerText();
  check('lưu cài đặt thành công', tt.includes('Đã lưu cài đặt'), tt);
  check('số kế tiếp theo mẫu mới', /^\d+-CV$/.test(await page.locator('.next-number-value').innerText()),
    await page.locator('.next-number-value').innerText());
  await page.screenshot({ path: SHOT + '/09-doi-mau-so.png', fullPage: true });

  // trả về mẫu cũ <số>/<năm>
  await page.locator('.preset').filter({ hasText: /^\d+\/2026$/ }).click();
  await page.waitForTimeout(150);
  await page.click('button:has-text("Lưu cài đặt")');
  await page.waitForTimeout(500);
  check('trả lại mẫu <số>/<năm>', /^\d+\/2026$/.test(await page.locator('.next-number-value').innerText()),
    await page.locator('.next-number-value').innerText());

  // đặt lại bộ đếm
  await page.click('button:has-text("Đặt lại bộ đếm")');
  await page.waitForSelector('.danger-zone');
  check('vùng nguy hiểm có cảnh báo', (await page.locator('.danger-zone p').innerText()).includes('không sửa số của văn bản đã ghi'));
  await page.fill('.danger-zone input[type="number"]', '5');
  await page.click('button:has-text("Xác nhận đặt lại")');
  await page.waitForTimeout(500);
  const tr = await page.locator('.toast').last().innerText();
  check('đặt lại về số đã dùng thì bị chặn, không lùi', /không lùi được/i.test(tr), tr);
  const conLai = (await page.locator('.next-number-value').innerText()).trim();
  check('bộ đếm không tụt xuống số vừa nhập', conLai !== '5/2026', conLai);
  await page.screenshot({ path: SHOT + '/10-dat-lai-bo-dem.png' });
}

console.log('\n== gõ rồi bấm ngay, và giữ focus khi gõ ==');
{
  const page = ad.page;
  // Ô "Ký tự cố định": gõ nhiều ký tự liền phải không mất focus giữa chừng.
  await page.click('.subtab:has-text("Lấy số")');
  await page.waitForSelector('.segments');
  await page.locator('.segment input').first().click();
  await page.keyboard.type('-ABC');
  const val = await page.locator('.segment input').first().inputValue();
  check('gõ liên tục không mất ký tự', val === '/-ABC', JSON.stringify(val));
  const stillFocused = await page.evaluate(() => document.activeElement?.dataset?.fk || null);
  check('ô vẫn còn focus sau khi gõ', stillFocused === 'seg-text-1', String(stillFocused));
  const caret = await page.evaluate(() => document.activeElement.selectionStart);
  check('con trỏ ở cuối chuỗi vừa gõ', caret === 5, String(caret));
  await page.click('button:has-text("Hủy thay đổi")');
  await page.waitForTimeout(200);

  // Gõ vào ô số rồi bấm nút ngay: click PHẢI ăn ngay lần đầu.
  await page.click('button:has-text("Đặt lại bộ đếm")');
  await page.waitForSelector('.danger-zone');
  await page.locator('.danger-zone input[type="number"]').fill('3');
  await page.click('button:has-text("Xác nhận đặt lại")');
  await page.waitForTimeout(800);
  const ts = await page.locator('.toast').allInnerTexts();
  check('gõ rồi bấm ngay: click ăn lần đầu', ts.some((t) => t.includes('bộ đếm') || t.includes('bị chiếm')),
    JSON.stringify(ts));
}

console.log('\n== vai trò Quản trị · tài khoản ==');
{
  const page = ad.page;
  await page.click('.subtab:has-text("Tài khoản")');
  await page.waitForSelector('.role-cards');
  check('có bảng tài khoản', (await page.locator('tbody tr').count()) >= 4);
  check('có giải thích vai trò', (await page.locator('.role-card').count()) === 3);
  check('tài khoản của mình được đánh dấu', (await page.locator('tbody tr:has-text("(bạn)")').count()) === 1);
  check('không tự khóa được mình', await page.locator('tbody tr:has-text("(bạn)") button:has-text("Khóa")').isDisabled());
  check('không tự xóa được mình', await page.locator('tbody tr:has-text("(bạn)") button:has-text("Xóa")').isDisabled());
  await page.screenshot({ path: SHOT + '/11-tai-khoan.png', fullPage: true });

  // thêm tài khoản
  await page.click('button:has-text("Thêm tài khoản")');
  await page.waitForSelector('.dialog');
  await page.waitForTimeout(300);
  const goiY = await page.inputValue('.dialog input.mono[placeholder="Ít nhất 8 ký tự"]');
  check('gợi ý mật khẩu tạm sẵn', goiY.length >= 12, goiY);
  await page.fill('.dialog input[placeholder="vd: hant"]', 'ktoan');
  await page.fill('.dialog input[placeholder="Nguyễn Thị Hà"]', 'Đỗ Thu Trang');
  await page.fill('.dialog input[placeholder="Văn thư — Phòng Hành chính"]', 'Kế toán trưởng');
  await page.click('.dialog .role-option:has-text("Chỉ xem")');
  await page.screenshot({ path: SHOT + '/12-them-tai-khoan.png' });
  await page.click('.dialog button:has-text("Tạo tài khoản")');
  await page.waitForSelector('.temp-password');
  const mkTam = await page.locator('.temp-password').innerText();
  check('hiện mật khẩu tạm một lần', mkTam === goiY, mkTam + ' vs ' + goiY);
  check('nói rõ chỉ hiện một lần', (await page.locator('.dialog').innerText()).includes('chỉ hiện một lần'));
  await page.screenshot({ path: SHOT + '/13-mat-khau-tam.png' });
  await page.click('.dialog button:has-text("Đã ghi lại")');
  await page.waitForSelector('.dialog', { state: 'detached' });
  check('tài khoản mới có trong bảng', (await page.locator('tbody tr:has-text("ktoan")').count()) === 1);
  check('tài khoản mới chờ đổi mật khẩu', (await page.locator('tbody tr:has-text("ktoan")').innerText()).includes('chờ đổi mật khẩu'));

  // trùng tên
  await page.click('button:has-text("Thêm tài khoản")');
  await page.waitForSelector('.dialog');
  await page.fill('.dialog input[placeholder="vd: hant"]', 'ktoan');
  await page.fill('.dialog input[placeholder="Nguyễn Thị Hà"]', 'Trùng tên');
  await page.click('.dialog button:has-text("Tạo tài khoản")');
  await page.waitForSelector('.dialog-error:not(:empty)');
  check('chặn tên đăng nhập trùng', (await page.locator('.dialog-error').innerText()).includes('đã tồn tại'));
  await page.click('.dialog button:has-text("Hủy")');

  // khóa rồi xóa
  await page.click('tbody tr:has-text("ktoan") button:has-text("Khóa")');
  await page.waitForSelector('tbody tr:has-text("ktoan") .badge-red');
  check('khóa tài khoản', (await page.locator('tbody tr:has-text("ktoan")').innerText()).includes('Đã khóa'));
  await page.click('tbody tr:has-text("ktoan") button:has-text("Xóa")');
  await page.waitForSelector('.dialog');
  await page.click('.dialog button:has-text("Xóa tài khoản")');
  await page.waitForSelector('.dialog', { state: 'detached' });
  check('xóa tài khoản chưa ghi sổ', (await page.locator('tbody tr:has-text("ktoan")').count()) === 0);

  // người đã ghi sổ thì không xóa được
  await page.click('tbody tr:has-text("hant") button:has-text("Xóa")');
  await page.waitForSelector('.dialog');
  await page.click('.dialog button:has-text("Xóa tài khoản")');
  await page.waitForSelector('.dialog-error:not(:empty)');
  check('không xóa người đã ghi sổ', (await page.locator('.dialog-error').innerText()).includes('Hãy khóa tài khoản'));
  await page.click('.dialog button:has-text("Hủy")');
}

console.log('\n== sổ theo năm và nhật ký ==');
{
  const page = ad.page;
  await page.click('.subtab:has-text("Sổ theo năm")');
  await page.waitForSelector('table');
  check('bảng sổ theo năm có 2025 và 2026', (await page.locator('tbody').innerText()).includes('2025'));
  await page.click('tbody tr:has-text("2025") button:has-text("Mở sổ")');
  await page.waitForSelector('.filters');
  check('mở sổ 2025 thì lọc theo năm đó', (await page.locator('.filters-foot').innerText()).includes('sổ 2025'));
  check('có cảnh báo đang xem sổ năm khác', await page.locator('text=Số cấp mới vẫn thuộc sổ').isVisible());
  await page.screenshot({ path: SHOT + '/14-so-2025.png', fullPage: true });

  await page.click('.tab:has-text("Cài đặt")');
  await page.waitForSelector('.subtabs');
  await page.click('.subtab:has-text("Nhật ký")');
  await page.waitForSelector('.audit-list');
  const nk = await page.locator('.audit-list').innerText();
  check('nhật ký ghi việc sửa cài đặt', nk.includes('Sửa cài đặt lấy số'));
  check('nhật ký ghi việc đặt lại bộ đếm', nk.includes('Đặt lại bộ đếm'));
  check('nhật ký ghi việc cấp số', nk.includes('Cấp số văn bản đi'));
  check('nhật ký ghi ai làm', nk.includes('admin') && nk.includes('hant'));
  await page.screenshot({ path: SHOT + '/15-nhat-ky.png', fullPage: true });
}

console.log('\n== xóa rồi khôi phục từ nhật ký ==');
{
  const page = ad.page;

  // Xóa một văn bản đến khỏi sổ, rồi khôi phục lại từ trang Nhật ký.
  await page.click('.tab:has-text("Văn bản đến")');
  await page.waitForSelector('tbody tr');
  await page.waitForTimeout(300);

  const target = page.locator('tbody tr').first();
  const targetText = await target.innerText();
  const soVanBan = (targetText.match(/\S+/) || [''])[0];

  await target.locator('button:has-text("Xóa")').click();
  await page.waitForSelector('.dialog');
  const loiVan = await page.locator('.dialog').innerText();
  check('hộp thoại xóa nói khôi phục được từ Nhật ký', /khôi phục lại được/i.test(loiVan), loiVan.slice(0, 90));
  check('hộp thoại xóa KHÔNG còn nói "không hoàn lại được"',
    !/không hoàn lại được/i.test(loiVan));
  check('hộp thoại xóa KHÔNG còn nói file bị xóa', !/File đính kèm cũng bị xóa/i.test(loiVan));
  check('hộp thoại xóa KHÔNG còn nói số bị giữ chỗ', !/không cấp lại/i.test(loiVan));
  await page.screenshot({ path: SHOT + '/19-hop-thoai-xoa.png' });

  await page.click('.dialog button:has-text("Xóa khỏi sổ")');
  await page.waitForTimeout(600);
  const sauKhiXoa = await page.locator('tbody').innerText();
  check('văn bản đã ra khỏi sổ', !sauKhiXoa.includes(soVanBan), soVanBan);

  await page.click('.tab:has-text("Cài đặt")');
  await page.waitForSelector('.subtabs');
  await page.click('.subtab:has-text("Nhật ký")');
  await page.waitForSelector('.audit-list');

  check('nhật ký báo còn văn bản khôi phục được',
    await page.locator('.restorable-count').isVisible());
  check('dòng xóa có nút Khôi phục',
    (await page.locator('.restore-box button:has-text("Khôi phục")').count()) >= 1);
  await page.screenshot({ path: SHOT + '/20-nhat-ky-khoi-phuc.png', fullPage: true });

  // Tìm kiếm không dấu trong nhật ký.
  await page.fill('[data-fk="audit-q"]', 'xoa van ban');
  await page.waitForTimeout(600);
  const locRoi = await page.locator('.audit-list').innerText();
  check('tìm nhật ký không dấu ra việc xóa', locRoi.includes('Xóa văn bản'), locRoi.slice(0, 80));

  await page.fill('[data-fk="audit-q"]', '');
  await page.waitForTimeout(600);
  await page.locator('.checkline:has-text("Chỉ việc xóa văn bản") input').check();
  await page.waitForTimeout(600);
  const chiXoa = await page.locator('.audit-list').innerText();
  check('lọc chỉ việc xóa văn bản',
    chiXoa.includes('Xóa văn bản') && !chiXoa.includes('Đăng nhập'), chiXoa.slice(0, 80));

  await page.click('.restore-box button:has-text("Khôi phục")');
  await page.waitForSelector('.dialog');
  const hopThoai = await page.locator('.dialog').innerText();
  check('hộp thoại khôi phục nói số cũ còn trống', /vẫn còn trống/i.test(hopThoai), hopThoai.slice(0, 120));
  check('hộp thoại khôi phục nói giữ nguyên số của mình', /giữ nguyên số/i.test(hopThoai));
  await page.screenshot({ path: SHOT + '/21-hop-thoai-khoi-phuc.png' });

  await page.click('.dialog button:has-text("Khôi phục về sổ")');
  await page.waitForTimeout(700);

  // Bỏ lọc, nếu không dòng “Khôi phục văn bản” vừa sinh ra bị lọc mất.
  await page.locator('.checkline:has-text("Chỉ việc xóa văn bản") input').uncheck();
  await page.waitForTimeout(700);
  const sauKhoiPhuc = await page.locator('.audit-list').innerText();
  check('nhật ký ghi việc khôi phục', sauKhoiPhuc.includes('Khôi phục văn bản'), sauKhoiPhuc.slice(0, 80));
  check('dòng xóa đổi thành đã khôi phục',
    (await page.locator('.restore-box:has-text("Đã khôi phục")').count()) >= 1);

  await page.click('.tab:has-text("Văn bản đến")');
  await page.waitForSelector('tbody tr');
  await page.waitForTimeout(300);
  const troLai = await page.locator('tbody').innerText();
  check('văn bản trở lại sổ với đúng số cũ', troLai.includes(soVanBan), soVanBan);

  // Trả trang về Cài đặt cho các phần kiểm thử sau.
  await page.click('.tab:has-text("Cài đặt")');
  await page.waitForSelector('.subtabs');
}

console.log('\n== buộc đổi mật khẩu lần đầu ==');
{
  const page = ad.page;
  await page.click('.subtab:has-text("Tài khoản")');
  await page.waitForSelector('tbody');
  await page.click('tbody tr:has-text("thuptt") button:has-text("Mở khóa")');
  await page.waitForTimeout(300);
  await page.click('tbody tr:has-text("thuptt") button:has-text("Đổi mật khẩu")');
  await page.waitForSelector('.dialog');
  await page.click('.dialog button:has-text("Cấp mật khẩu tạm")');
  await page.waitForSelector('.temp-password');
  const mk = await page.locator('.temp-password').innerText();
  await page.click('.dialog button:has-text("Đã ghi lại")');

  const { page: p2 } = await session('thu');
  await login(p2, 'thuptt', mk);
  await p2.waitForSelector('text=Bắt buộc trước khi dùng hệ thống');
  check('vào thẳng màn buộc đổi mật khẩu', (await p2.locator('.brand-name').innerText()) === 'Đổi mật khẩu',
    await p2.locator('.brand-name').innerText());
  await p2.screenshot({ path: SHOT + '/16-buoc-doi-mat-khau.png' });

  await p2.fill('input[autocomplete="current-password"]', mk);
  const news = p2.locator('input[autocomplete="new-password"]');
  await news.nth(0).fill('MatKhauRieng@2026');
  await news.nth(1).fill('KhacNhau@2026');
  await p2.click('button:has-text("Đổi mật khẩu và tiếp tục")');
  await p2.waitForSelector('.note-error');
  check('chặn hai lần nhập khác nhau', (await p2.locator('.note-error').innerText()).includes('không giống nhau'));

  await news.nth(1).fill('MatKhauRieng@2026');
  await p2.click('button:has-text("Đổi mật khẩu và tiếp tục")');
  await p2.waitForSelector('.topbar');
  check('đổi xong thì vào được sổ', await p2.locator('.brand-name').isVisible());
  check('vào với vai trò Nhân viên', (await p2.locator('.topbar-right').innerText()).includes('Nhân viên'));
}

// ---------------------------------------------------------------- đính kèm
// Lỗi cũ: ô chọn tệp là input mặc định của trình duyệt, và mỗi lần hộp thoại
// được dựng lại thì ô mới hiện “No file chosen” dù tệp đã chọn — văn thư tưởng
// đính kèm không ăn. Bộ thử này khóa lại: chọn xong phải thấy tên tệp bằng
// tiếng Việt, tên tệp còn nguyên sau khi gõ tiếp, và tệp thật sự lên máy chủ.
console.log('\n== đính kèm tệp ==');
{
  const { page } = await session('dinh-kem');
  const tmpFile = { name: 'quyet-dinh.pdf', mimeType: 'application/pdf', buffer: pdfThat(1) };
  await login(page, 'admin', 'admin@2026');
  await page.waitForSelector('.topbar');

  // --- sổ đến: ghi văn bản kèm tệp
  await page.click('button:has-text("Ghi văn bản đến")');
  await page.waitForSelector('.file-drop');
  check('nút chọn tệp bằng tiếng Việt',
    (await page.locator('.file-drop .btn-pick').innerText()).includes('Chọn tệp'));
  check('không còn nút mặc định tiếng Anh của trình duyệt',
    !(await page.locator('.file-drop').innerText()).includes('No file chosen'));
  check('chưa chọn thì nói rõ là chưa chọn',
    (await page.locator('.file-status').innerText()).includes('Chưa chọn tệp'));

  // Bấm đúng nút tiếng Việt, không thao tác thẳng vào input bị ẩn.
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('.file-drop .btn-pick'),
  ]);
  await chooser.setFiles(tmpFile);
  await page.waitForSelector('.file-status.ok');
  check('chọn xong thì hiện tên tệp',
    (await page.locator('.file-status').innerText()).includes('quyet-dinh.pdf'));

  // Gõ tiếp vào các ô khác: render() dựng lại hộp thoại, tên tệp phải còn.
  await page.fill('[data-fk="doc-soVanBan"]', '888/UBND-VP');
  await page.fill('[data-fk="doc-nguoiGui"]', 'UBND tỉnh');
  await page.fill('[data-fk="doc-tenVanBan"]', 'Văn bản có tệp đính kèm');
  check('gõ tiếp không làm mất tệp đã chọn',
    (await page.locator('.file-status').innerText()).includes('quyet-dinh.pdf'));
  await page.screenshot({ path: SHOT + '/18-dinh-kem.png' });

  await page.click('.dialog button:has-text("Lưu")');
  await page.waitForSelector('.overlay', { state: 'detached' });
  const row = page.locator('tr:has-text("888/UBND-VP")');
  await row.waitFor();
  check('tệp vào sổ đến, hiện ở cột đính kèm',
    (await row.innerText()).includes('quyet-dinh.pdf'));
  const dl = await page.request.get(B + (await row.locator('.cell-file a').getAttribute('href')));
  check('tải lại được tệp vừa đính kèm', dl.ok() && (await dl.text()).includes('%PDF-1.4'));

  // --- sổ đi: lấy số kèm tệp
  await page.click('button:has-text("Lấy số gửi văn bản đi")');
  await page.waitForSelector('.file-drop');
  const [ch2] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('.file-drop .btn-pick'),
  ]);
  await ch2.setFiles(tmpFile);
  await page.fill('[data-fk="doc-nguoiGui"]', 'Giám đốc');
  await page.fill('[data-fk="doc-tenVanBan"]', 'Công văn đi có tệp');
  await page.click('.dialog button:has-text("Lưu")');
  await page.waitForSelector('.overlay', { state: 'detached' });
  await page.waitForSelector('tr:has-text("Công văn đi có tệp")');
  check('lấy số kèm tệp cũng lưu được tệp',
    (await page.locator('tr:has-text("Công văn đi có tệp")').innerText()).includes('quyet-dinh.pdf'));

  // --- sửa: thay tệp rồi bỏ tệp
  await page.click('.tabs button:has-text("Văn bản đến")');
  await page.locator('tr:has-text("888/UBND-VP") button:has-text("Sửa")').click();
  await page.waitForSelector('.file-drop');
  check('mở sửa thì thấy tệp đang có',
    (await page.locator('.file-status').innerText()).includes('Đang có'));
  await page.click('.file-drop .btn-link.danger');
  check('bấm bỏ tệp thì báo sẽ bỏ khi lưu',
    (await page.locator('.file-status.warn').innerText()).includes('Sẽ bỏ tệp đính kèm'));
  await page.click('.file-status .btn-link');
  check('bấm giữ lại thì quay về tệp đang có',
    (await page.locator('.file-status').innerText()).includes('Đang có'));
  await page.click('.file-drop .btn-link.danger');
  await page.click('.dialog button:has-text("Lưu")');
  await page.waitForSelector('.overlay', { state: 'detached' });
  await page.waitForTimeout(300);
  check('bỏ tệp khi lưu thì cột đính kèm trống',
    !(await page.locator('tr:has-text("888/UBND-VP")').innerText()).includes('quyet-dinh.pdf'));
}

// ------------------------------------------------------- xem đính kèm trên web
console.log('\n== xem đính kèm ngay trên web ==');
{
  const { page } = await session('xem-dinh-kem');
  const pdf = { name: 'Quyết định 1234 phê duyệt.pdf', mimeType: 'application/pdf', buffer: pdfThat(3) };
  // .tif là loại KHÔNG xem được: trình duyệt không dựng được, mà LibreOffice
  // cũng không nằm trong danh sách chuyển đổi. Dùng nó để kiểm nhánh chỉ-tải-về.
  const tif = { name: 'bản scan.tif', mimeType: 'image/tiff', buffer: Buffer.from('II*\x00 gia lap') };
  const txt = { name: 'ghi chú họp.txt', mimeType: 'text/plain', buffer: Buffer.from('Kết luận họp giao ban', 'utf8') };

  await login(page, 'admin', 'admin@2026');
  await page.waitForSelector('.topbar');

  async function ghi(file, so, ten) {
    await page.click('button:has-text("Ghi văn bản đến")');
    await page.waitForSelector('.file-drop');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('.file-drop .btn-pick')]);
    await fc.setFiles(file);
    await page.fill('[data-fk="doc-soVanBan"]', so);
    await page.fill('[data-fk="doc-nguoiGui"]', 'UBND tỉnh');
    await page.fill('[data-fk="doc-tenVanBan"]', ten);
    await page.click('.dialog button:has-text("Lưu")');
    await page.waitForSelector('.overlay', { state: 'detached' });
    return page.locator('tr:has-text("' + so + '")');
  }

  // Tên tệp có dấu: multer mặc định đọc multipart theo latin1, để mặc định thì
  // tên tệp vào cơ sở dữ liệu thành “Quyáº¿t Ä‘á»‹nh…”.
  const rPdf = await ghi(pdf, '801/PDF', 'Quyết định kèm PDF');
  check('tên tệp tiếng Việt không bị hỏng font',
    (await rPdf.locator('.file-open').innerText()).includes('Quyết định 1234 phê duyệt.pdf'));

  const rTif = await ghi(tif, '802/TIF', 'Bản scan TIFF');
  check('loại tệp xem được thì tên tệp là nút bấm', await rPdf.locator('.file-open').count() === 1);
  check('loại tệp xem được có thêm đường tải riêng', await rPdf.locator('.file-dl').count() === 1);
  check('loại tệp không xem được thì chỉ có đường tải',
    await rTif.locator('.file-open').count() === 0 && await rTif.locator('a').count() === 1);

  // PDF: ứng dụng TỰ vẽ bằng pdf.js, không giao cho trình duyệt.
  //
  // Vì sao không dùng <iframe>: Edge/Chrome có tùy chọn “Always download PDF
  // files” (và chính sách AlwaysOpenPdfExternally trên máy do IT quản lý). Bật
  // lên thì trình duyệt tải PDF về thay vì dựng trong trang, dù máy chủ đã trả
  // Content-Disposition: inline — văn thư thấy tệp rơi xuống thanh tải và một
  // khung trắng. Đã gặp đúng lỗi đó trên máy thật (Edge 152).
  //
  // Hai phép thử quan trọng nhất ở đây: KHÔNG có tải xuống nào bị kích hoạt, và
  // canvas có mực thật chứ không phải một tờ trắng.
  let taiXuong = false;
  page.on('download', () => { taiXuong = true; });

  await rPdf.locator('.file-open').click();
  await page.waitForSelector('.dialog-wide .pdf-wrap');
  check('khung xem mang tên tệp làm tiêu đề',
    (await page.locator('.dialog-title').innerText()).includes('Quyết định 1234 phê duyệt.pdf'));
  check('PDF không giao cho trình duyệt dựng (không có iframe)',
    await page.locator('.dialog .viewer-frame').count() === 0);

  await page.waitForSelector('.pdf-page.drawn', { timeout: 20000 });
  await page.waitForTimeout(800);
  check('dựng đủ chỗ cho mọi trang', await page.locator('.pdf-page').count() === 3);
  check('nhãn số trang đúng', (await page.locator('.pdf-bar .muted').innerText()).includes('3 trang'));
  check('không trang nào vẽ lỗi', await page.locator('.pdf-page.failed').count() === 0);

  // Đọc thẳng điểm ảnh trên canvas: chỉ kiểm “có canvas” thì một tờ trắng cũng
  // lọt, mà trắng đúng là triệu chứng của lỗi cũ.
  const muc = await page.evaluate(() => {
    const c = document.querySelector('.pdf-canvas');
    if (!c) return -1;
    const d = c.getContext('2d').getImageData(0, 0, c.width, Math.min(c.height, 400)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 200) n += 1;
    return n;
  });
  check('trang PDF có mực thật, không phải tờ trắng', muc > 500, 'đếm được ' + muc + ' điểm ảnh');
  check('KHÔNG kích hoạt tải xuống khi xem', taiXuong === false);

  const box = await page.locator('.pdf-box').boundingBox();
  check('khung xem đủ lớn để đọc', box.width > 600 && box.height > 400);

  // Phóng to phải vẽ lại, không chỉ đổi con số.
  await page.click('.pdf-bar button[title="Phóng to"]');
  await page.waitForTimeout(1500);
  check('phóng to đổi mức hiển thị', (await page.locator('.pdf-zoom').innerText()) === '125%');
  check('phóng to rồi vẫn vẽ được trang', await page.locator('.pdf-page.drawn').count() >= 1);
  await page.click('.pdf-bar button:has-text("Vừa khung")');
  await page.waitForTimeout(1200);
  check('“Vừa khung” trả về 100%', (await page.locator('.pdf-zoom').innerText()) === '100%');
  await page.screenshot({ path: SHOT + '/19-xem-dinh-kem.png' });

  // Máy chủ vẫn phải trả inline: nút “Mở tab mới” dựa vào đó. Đường dẫn phải
  // trơn — không đuôi tệp, không tham số — để tiện ích chặn quảng cáo không bắt.
  const src = await page.locator('.dialog-foot a:has-text("Mở tab mới")').getAttribute('href');
  check('nút mở tab mới trỏ đường xem trơn, không .pdf và không tham số',
    /\/xem-pdf$/.test(src), src);
  const head = await page.request.get(B + src);
  check('máy chủ trả PDF dạng inline',
    head.headers()['content-type'] === 'application/pdf' &&
    (head.headers()['content-disposition'] || '').startsWith('inline'));
  check('cho phép chính trang này nhúng, không cho ngoài nhúng',
    head.headers()['x-frame-options'] === 'SAMEORIGIN' &&
    (head.headers()['content-security-policy'] || '').includes("frame-ancestors 'self'"));
  check('vẫn cấm trình duyệt tự đoán lại loại tệp',
    head.headers()['x-content-type-options'] === 'nosniff');

  // pdf.js chạy worker cùng origin; thiếu worker-src trong CSP là chặn im lặng.
  const trang = await page.request.get(B + '/');
  check('CSP cho phép worker cùng origin',
    (trang.headers()['content-security-policy'] || '').includes("worker-src 'self'"));

  // pdf.js phải lấy byte qua ĐÚNG endpoint trơn. Lỗi thật đã gặp: tiện ích chặn
  // quảng cáo trong Edge chặn thẳng URL có đuôi “.pdf” kèm tham số truy vấn
  // (net::ERR_BLOCKED_BY_CLIENT), nên khung xem trắng còn máy chủ thì vô can.
  const goi = [];
  page.on('request', (r) => { if (/\/xem-pdf$|\/file/.test(r.url())) goi.push(r.url()); });
  await page.click('.dialog button:has-text("Đóng")');
  check('đóng khung xem thì về lại sổ', await page.locator('.overlay').count() === 0);

  await rPdf.locator('.file-open').click();
  await page.waitForSelector('.pdf-page.drawn', { timeout: 20000 });
  check('pdf.js gọi đúng endpoint trơn, không .pdf và không ?xem=1 trong URL',
    goi.length > 0 && goi.every((u) => /\/xem-pdf$/.test(u)), goi.join(' '));
  await page.click('.dialog button:has-text("Đóng")');

  // .txt: dựng được luôn, và phải ra tiếng Việt chứ không phải ký tự lạ.
  const rTxt = await ghi(txt, '803/TXT', 'Ghi chú họp');
  await rTxt.locator('.file-open').click();
  await page.waitForSelector('.viewer-frame');
  await page.waitForTimeout(500);
  check('xem .txt ra đúng tiếng Việt',
    (await page.frameLocator('.viewer-frame').locator('body').innerText()).includes('Kết luận họp giao ban'));
  await page.click('.dialog button:has-text("Đóng")');

  // Đường tải xuống vẫn phải là tải xuống, không đổi thành xem.
  const dl = await page.request.get(B + (await rTif.locator('a').getAttribute('href')));
  check('tệp không xem được vẫn tải xuống bình thường',
    (dl.headers()['content-disposition'] || '').startsWith('attachment'));
  // Cố tình xin xem một tệp không thuộc loại xem được: phải quay về tải xuống,
  // đừng dựng nó trong origin của ứng dụng.
  const forced = await page.request.get(B + (await rTif.locator('a').getAttribute('href')) + '?xem=1');
  check('xin xem .tif thì máy chủ vẫn bắt tải xuống',
    (forced.headers()['content-disposition'] || '').startsWith('attachment'));
}

// Chặn request kiểu tiện ích mở rộng: hai tình huống, một phải vẫn xem được,
// một phải báo lỗi cho ra lỗi.
// -------------------------------------------------------- xem .docx / Office
// Trình duyệt không có bộ dựng Word nào, nên máy chủ chuyển tệp Office sang PDF
// bằng LibreOffice rồi dùng lại đúng trình xem pdf.js. Bộ thử này đi hết đường
// đó: tải lên → chuyển → vẽ ra mực thật, và tải xuống vẫn ra TỆP GỐC.
console.log('\n== xem tệp Word (.docx) ==');
{
  const { page } = await session('xem-docx');
  const docx = {
    name: 'Báo cáo tổng kết.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: docxThat('BAO CAO TONG KET'),
  };
  let taiXuong = false;
  page.on('download', () => { taiXuong = true; });

  await login(page, 'admin', 'admin@2026');
  await page.waitForSelector('.topbar');

  const luc = Date.now();
  await page.click('button:has-text("Ghi văn bản đến")');
  await page.waitForSelector('.file-drop');
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('.file-drop .btn-pick')]);
  await fc.setFiles(docx);
  await page.fill('[data-fk="doc-soVanBan"]', '901/DOCX');
  await page.fill('[data-fk="doc-nguoiGui"]', 'Sở Nội vụ');
  await page.fill('[data-fk="doc-tenVanBan"]', 'Báo cáo dạng Word');
  await page.click('.dialog button:has-text("Lưu")');
  await page.waitForSelector('.overlay', { state: 'detached' });
  // Chuyển đổi mất ~10 giây nhưng chạy nền: ghi vào sổ không được chờ nó.
  check('lưu vào sổ không phải chờ chuyển đổi', Date.now() - luc < 5000,
    ((Date.now() - luc) / 1000).toFixed(1) + 's');

  const row = page.locator('tr:has-text("901/DOCX")');
  await row.waitFor();
  check('.docx hiện là xem được', await row.locator('.file-open').count() === 1);

  await row.locator('.file-open').click();
  await page.waitForSelector('.pdf-wrap');
  // Chờ dài: lần đầu phải để LibreOffice chạy xong.
  await page.waitForSelector('.pdf-page.drawn', { timeout: 130000 });
  check('không trang nào vẽ lỗi', await page.locator('.pdf-page.failed').count() === 0);
  const muc = await page.evaluate(() => {
    const c = document.querySelector('.pdf-canvas');
    if (!c) return -1;
    const d = c.getContext('2d').getImageData(0, 0, c.width, Math.min(c.height, 500)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 200) n += 1;
    return n;
  });
  check('trang Word dựng ra có mực thật', muc > 500, 'đếm được ' + muc + ' điểm ảnh');
  check('nói rõ đang xem bản chuyển, tải xuống là tệp gốc',
    (await page.locator('.dialog-foot .muted').innerText()).includes('bản PDF chuyển từ tệp gốc'));
  check('KHÔNG kích hoạt tải xuống khi xem .docx', taiXuong === false);
  await page.screenshot({ path: SHOT + '/20-xem-docx.png' });

  // Đường /xem-pdf phải trơn: không đuôi tệp, không tham số — nếu không thì
  // tiện ích chặn quảng cáo lại chặn như đã từng xảy ra.
  const goi = [];
  page.on('request', (r) => { if (/xem-pdf|\/file/.test(r.url())) goi.push(r.url()); });
  await page.click('.dialog button:has-text("Đóng")');
  await row.locator('.file-open').click();
  await page.waitForSelector('.pdf-page.drawn', { timeout: 60000 });
  check('đường lấy bản xem không có đuôi tệp và không có tham số',
    goi.length > 0 && goi.every((u) => /\/xem-pdf$/.test(u)), goi.join(' '));

  // Bản đã chuyển được nhớ đệm ra đĩa: lần sau không chạy LibreOffice lại nữa.
  // Ngưỡng 8 giây đặt dưới thời gian một lần chuyển thật (~10 giây trên máy này).
  const t2 = Date.now();
  const pdfRes = await page.request.get(goi[0]);
  check('bản đã chuyển trả về đúng dạng PDF',
    pdfRes.headers()['content-type'] === 'application/pdf'
    && (pdfRes.headers()['content-disposition'] || '').startsWith('inline'));
  check('lần xem sau lấy từ nhớ đệm, không chuyển lại', Date.now() - t2 < 8000,
    ((Date.now() - t2) / 1000).toFixed(1) + 's');

  // Tải xuống phải ra TỆP GỐC .docx, không phải bản PDF.
  const goc = await page.request.get(B + (await row.locator('.file-dl').getAttribute('href')));
  const disp = goc.headers()['content-disposition'] || '';
  check('tải xuống vẫn là tệp .docx gốc',
    disp.startsWith('attachment') && /\.docx/i.test(disp)
    && (goc.headers()['content-type'] || '').includes('wordprocessingml'), disp.slice(0, 80));
  await page.click('.dialog button:has-text("Đóng")');
}

console.log('\n== tiện ích chặn quảng cáo chặn request ==');
{
  const { page } = await session('bi-chan');
  await login(page, 'admin', 'admin@2026');
  await page.waitForSelector('.topbar');
  const row = page.locator('tr:has-text("801/PDF")');

  // 1. Bộ lọc bắt vào URL có “.pdf?” — đúng dạng đã chặn người dùng thật.
  await page.route('**/*', (route) =>
    (/\.pdf\?/.test(route.request().url()) ? route.abort('blockedbyclient') : route.continue()));
  await row.locator('.file-open').click();
  await page.waitForSelector('.pdf-wrap');
  let veDuoc = true;
  try {
    await page.waitForSelector('.pdf-page.drawn', { timeout: 20000 });
  } catch { veDuoc = false; }
  check('bộ lọc chặn URL dạng “.pdf?” không còn làm hỏng khung xem', veDuoc);
  await page.click('.dialog button:has-text("Đóng")');

  // 2. Chặn cả endpoint trơn: không cứu được, nhưng phải nói rõ nguyên nhân
  // thay vì để người dùng ngồi trước một khung trắng.
  await page.unroute('**/*');
  await page.route('**/*', (route) =>
    (/\/xem-pdf$|\/file/.test(route.request().url()) ? route.abort('blockedbyclient') : route.continue()));
  await row.locator('.file-open').click();
  await page.waitForSelector('.pdf-err', { timeout: 20000 });
  const chuDo = await page.locator('.pdf-err').innerText();
  check('bị chặn hoàn toàn thì nói rõ là do tiện ích mở rộng',
    chuDo.includes('tiện ích mở rộng'), chuDo.replace(/\n/g, ' '));
  check('vẫn còn đường tải xuống khi không dựng được',
    await page.locator('.dialog-foot a:has-text("Tải xuống")').count() === 1);
  await page.unroute('**/*');
}

console.log('\n== màn hình hẹp (điện thoại) ==');
{
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('mobile pageerror: ' + e.message));
  await login(page, 'admin', 'admin@2026');
  await page.waitForSelector('.topbar');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('không tràn ngang ở 400px', overflow <= 1, 'tràn ' + overflow + 'px');
  await page.screenshot({ path: SHOT + '/17-dien-thoai.png', fullPage: true });
  await ctx.close();
}

await browser.close();

console.log('\n== lỗi console ==');
if (errors.length === 0) console.log('  không có lỗi JS nào');
else errors.slice(0, 12).forEach((e) => console.log('  ' + e));

console.log('\n' + (fail === 0 && errors.length === 0
  ? 'TẤT CẢ ' + pass + ' PHÉP THỬ ĐỀU ĐẠT, KHÔNG LỖI JS'
  : pass + ' đạt, ' + fail + ' KHÔNG ĐẠT, ' + errors.length + ' lỗi JS'));
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
