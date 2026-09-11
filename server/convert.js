'use strict';

/**
 * Chuyển tệp Office sang PDF để xem ngay trên web.
 *
 * Trình duyệt không có bộ dựng Word/Excel nào, nên .docx muốn xem được trong
 * trang thì phải thành PDF trước — rồi dùng lại đúng trình xem pdf.js đã có.
 * LibreOffice headless làm việc đó, và dựng gần như bản in: letterhead, bảng,
 * chữ ký, canh lề, phân trang.
 *
 * Ba điều phải nhớ khi sửa tệp này:
 *
 *   1. CHẬM. Trên máy này một lần chuyển mất ~10 giây, phần lớn là thời gian
 *      LibreOffice khởi động. Vì vậy bản PDF được NHỚ ĐỆM ra đĩa, và tệp mới
 *      tải lên được chuyển sẵn ngay lúc đó (xem convertInBackground) để tới lúc
 *      có người bấm xem thì đã có sẵn.
 *
 *   2. LibreOffice ĐỌC TỆP DO NGƯỜI DÙNG TẢI LÊN. Đó là một mặt tấn công thật.
 *      Nên mỗi lần chạy đều: có hạn thời gian, dùng profile riêng trong thư mục
 *      tạm rồi xóa, chạy với HOME riêng, và bị giới hạn bộ nhớ/CPU.
 *
 *   3. Mỗi tiến trình soffice phải có UserInstallation RIÊNG. Dùng chung một
 *      profile thì hai lần chuyển song song sẽ giành nhau và một bên treo.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { DATA_DIR } = require('./db');

// Thư mục nhớ đệm bản PDF đã chuyển. Nằm trong DATA_DIR nên được sao lưu cùng
// dữ liệu và nằm trong ReadWritePaths của systemd.
const VIEW_DIR = path.join(DATA_DIR, 'xem-pdf');
fs.mkdirSync(VIEW_DIR, { recursive: true });

/** Định dạng LibreOffice dựng được. .pdf không có ở đây vì không cần chuyển. */
const CONVERT_EXT = new Set(['.doc', '.docx', '.odt', '.rtf', '.xls', '.xlsx', '.ods']);

/**
 * Tìm soffice trên máy, một lần lúc nạp module.
 *
 * LibreOffice là phụ thuộc KHÔNG bắt buộc: máy chủ nào không cài thì tệp Office
 * chỉ tải về được, còn mọi thứ khác chạy như thường. Nhờ kiểm ở đây mà giao diện
 * biết trước là không xem được và hiện đường tải về, thay vì mời người dùng bấm
 * “Xem” rồi đập vào mặt họ một dòng lỗi đỏ.
 *
 * Quét PATH chứ không chạy `soffice --version`: gọi nó mất vài giây, mà đây là
 * lúc máy chủ đang khởi động.
 */
function timSoffice() {
  if (process.env.SOFFICE_BIN) {
    return fs.existsSync(process.env.SOFFICE_BIN) ? process.env.SOFFICE_BIN : null;
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'soffice');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // thư mục không có soffice — thử tiếp
    }
  }
  return null;
}

const SOFFICE = timSoffice();
if (!SOFFICE) {
  console.log('  LibreOffice : chưa cài — tệp Word/Excel chỉ tải về được, không xem trên web');
}

// Hạn thời gian một lần chuyển. nginx đặt proxy_read_timeout 120s, nên phải nhỏ
// hơn con số đó để người dùng nhận được thông báo của mình chứ không phải 504.
const TIMEOUT_MS = 100 * 1000;
// Bản PDF phình to quá thì chặn: một tệp .docx nhỏ có thể sinh ra PDF khổng lồ.
const MAX_PDF_BYTES = 200 * 1024 * 1024;
// Hai CPU, mà LibreOffice ăn trọn một CPU mỗi lần chạy. Cho quá số này thì cả
// máy chậm theo và ai cũng phải chờ.
const MAX_SONG_SONG = 1;

let dangChay = 0;
const hangCho = [];
// Cùng một tệp mà hai người bấm xem một lúc thì chỉ chuyển MỘT lần, cả hai chờ
// chung một promise.
const dangLam = new Map();

function canConvert(storedName) {
  if (!SOFFICE) return false;
  return CONVERT_EXT.has(path.extname(String(storedName || '')).toLowerCase());
}

/** Đường dẫn bản PDF đã chuyển của một tệp đính kèm (có thể chưa tồn tại). */
function viewPdfPath(storedName) {
  const base = path.basename(String(storedName || ''));
  if (!base || base === '.' || base === '..') return null;
  const full = path.join(VIEW_DIR, base + '.pdf');
  if (!full.startsWith(VIEW_DIR + path.sep)) return null;
  return full;
}

function hasViewPdf(storedName) {
  const p = viewPdfPath(storedName);
  return !!(p && fs.existsSync(p));
}

/** Xóa bản đã chuyển — gọi khi tệp đính kèm bị xóa hoặc bị thay. */
function removeViewPdf(storedName) {
  const p = viewPdfPath(storedName);
  if (p) fs.rm(p, { force: true }, () => {});
}

function xepHang(fn) {
  return new Promise((resolve, reject) => {
    hangCho.push({ fn, resolve, reject });
    chayTiep();
  });
}

function chayTiep() {
  if (dangChay >= MAX_SONG_SONG || hangCho.length === 0) return;
  const job = hangCho.shift();
  dangChay += 1;
  job.fn().then(job.resolve, job.reject).finally(() => {
    dangChay -= 1;
    chayTiep();
  });
}

/**
 * Chạy soffice một lần, trong thư mục tạm dùng một lần rồi bỏ.
 *
 * ulimit -v giới hạn bộ nhớ ảo: một tệp dựng riêng để làm LibreOffice ngốn hết
 * RAM sẽ bị chính nhân hệ điều hành chặn, không phải chờ máy chủ chết. Phải qua
 * `sh -c` vì ulimit là lệnh của shell.
 */
function chaySoffice(input, outDir, profileDir) {
  return new Promise((resolve, reject) => {
    const args = [
      '--headless',
      '--norestore',
      '--nolockcheck',
      '--nodefault',
      '--nofirststartwizard',
      '--invisible',
      '-env:UserInstallation=file://' + profileDir,
      '--convert-to', 'pdf:writer_pdf_Export',
      '--outdir', outDir,
      input,
    ];
    // 3 GB ảo: đủ cho tài liệu vài trăm trang, chặn được trường hợp ngốn vô hạn.
    const cmd = 'ulimit -v 3145728; exec "$SOFFICE_BIN" "$@"';
    const child = spawn('/bin/sh', ['-c', cmd, 'sh', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        // HOME riêng: LibreOffice không được chạm vào ~/.config của người chạy.
        HOME: profileDir,
        TMPDIR: profileDir,
        PATH: process.env.PATH,
        SOFFICE_BIN: SOFFICE,
        // Tắt mọi thứ cần màn hình; nếu còn sót, soffice sẽ cố mở X và treo.
        SAL_USE_VCLPLUGIN: 'svp',
        SAL_DISABLE_OPENCL: '1',
      },
    });

    let err = '';
    child.stderr.on('data', (d) => { err += String(d).slice(0, 2000); });
    child.stdout.on('data', () => {});

    const hetGio = setTimeout(() => {
      // SIGKILL chứ không SIGTERM: soffice treo thì không phản ứng với TERM.
      child.kill('SIGKILL');
      reject(new Error('Chuyển đổi quá ' + Math.round(TIMEOUT_MS / 1000) + ' giây nên đã dừng.'));
    }, TIMEOUT_MS);

    child.on('error', (e) => {
      clearTimeout(hetGio);
      reject(new Error('Không chạy được LibreOffice: ' + e.message));
    });
    child.on('close', (code, signal) => {
      clearTimeout(hetGio);
      if (signal === 'SIGKILL') return; // reject đã gọi ở trên
      if (code !== 0) {
        reject(new Error('LibreOffice thoát với mã ' + code + (err ? ': ' + err.trim().slice(0, 300) : '')));
        return;
      }
      resolve();
    });
  });
}

async function chuyen(srcPath, storedName) {
  const dest = viewPdfPath(storedName);
  if (!dest) throw new Error('Tên tệp không hợp lệ.');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-conv-'));
  const profileDir = path.join(work, 'profile');
  const outDir = path.join(work, 'out');
  fs.mkdirSync(profileDir);
  fs.mkdirSync(outDir);

  // Copy vào thư mục tạm với đúng đuôi: soffice chọn bộ đọc theo đuôi tệp, và
  // như vậy nó cũng không thấy đường tới thư mục uploads.
  const ext = path.extname(storedName).toLowerCase();
  const input = path.join(work, 'nguon' + ext);

  try {
    fs.copyFileSync(srcPath, input);
    await chaySoffice(input, outDir, profileDir);

    const ra = path.join(outDir, 'nguon.pdf');
    if (!fs.existsSync(ra)) {
      throw new Error('LibreOffice không tạo được PDF từ tệp này.');
    }
    const kichThuoc = fs.statSync(ra).size;
    if (kichThuoc === 0) throw new Error('Bản PDF chuyển ra rỗng.');
    if (kichThuoc > MAX_PDF_BYTES) throw new Error('Bản PDF chuyển ra quá lớn.');

    // Ghi tạm rồi đổi tên: người khác đọc thư mục nhớ đệm sẽ không bao giờ bắt
    // gặp một tệp PDF ghi dở.
    const tam = dest + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    fs.copyFileSync(ra, tam);
    fs.renameSync(tam, dest);
    return dest;
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => {});
  }
}

/**
 * Trả về đường dẫn bản PDF để xem, chuyển đổi nếu chưa có.
 *
 * Chuyển xong thì lần sau lấy ngay từ nhớ đệm.
 */
function ensureViewPdf(srcPath, storedName) {
  const dest = viewPdfPath(storedName);
  if (!dest) return Promise.reject(new Error('Tên tệp không hợp lệ.'));
  if (fs.existsSync(dest)) return Promise.resolve(dest);

  const dangCo = dangLam.get(dest);
  if (dangCo) return dangCo;

  const p = xepHang(() => chuyen(srcPath, storedName)).finally(() => dangLam.delete(dest));
  dangLam.set(dest, p);
  return p;
}

/**
 * Chuyển sẵn ngay sau khi tải lên, không bắt người tải lên phải chờ.
 *
 * Đây là thứ làm cho việc chuyển đổi ~10 giây gần như vô hình: tới lúc văn thư
 * bấm xem thì bản PDF đã nằm trong nhớ đệm. Lỗi ở đây chỉ ghi log — không được
 * làm việc ghi văn bản vào sổ thất bại chỉ vì không dựng được bản xem trước.
 */
function convertInBackground(srcPath, storedName) {
  if (!canConvert(storedName)) return;
  ensureViewPdf(srcPath, storedName).catch((err) => {
    console.error('[xem-pdf] không chuyển sẵn được ' + storedName + ': ' + err.message);
  });
}

module.exports = {
  CONVERT_EXT,
  SOFFICE,
  VIEW_DIR,
  canConvert,
  ensureViewPdf,
  convertInBackground,
  hasViewPdf,
  removeViewPdf,
  viewPdfPath,
};
