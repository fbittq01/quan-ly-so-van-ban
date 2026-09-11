'use strict';

// Quản lý số văn bản — giao diện thuần, không cần bước build.
// Mọi dữ liệu người dùng đi qua textContent, không bao giờ qua innerHTML.

// ------------------------------------------------------------------ helpers

/** el('div', {class:'x', onclick:fn}, 'chữ', elKhac) */
function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') node[k] = !!v;
      else if (k === 'fk') node.dataset.fk = v;
      else node.setAttribute(k, v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const ICONS = {
  lock: '<rect x="4" y="10" width="16" height="10" rx="1.5"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path>',
  plus: '<path d="M12 5v14"></path><path d="M5 12h14"></path>',
  left: '<path d="M15 5l-7 7 7 7"></path>',
  right: '<path d="M9 5l7 7-7 7"></path>',
  x: '<path d="M6 6l12 12"></path><path d="M18 6L6 18"></path>',
  check: '<path d="M20 6 9 17l-5-5"></path>',
  alert: '<circle cx="12" cy="12" r="9"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path>',
  warn: '<path d="M12 4 2.5 20h19L12 4Z"></path><path d="M12 10v4"></path><path d="M12 17h.01"></path>',
  paper: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"></path><path d="M14 3v5h5"></path>',
  rotate: '<path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 4v5h5"></path>',
};

/** Icon nét, dựng từ hằng số trong tệp này — không có dữ liệu người dùng. */
function icon(name, size, color) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size || 16);
  svg.setAttribute('height', size || 16);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', color || 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

/**
 * render() dựng lại DOM, nên ô đang gõ sẽ bị thay bằng ô mới và mất focus.
 * Hai hàm này ghi lại rồi trả về đúng ô (theo data-fk) cùng vị trí con trỏ.
 */
function captureFocus() {
  const a = document.activeElement;
  if (!a || !a.dataset || !a.dataset.fk) return null;
  const out = { fk: a.dataset.fk, start: null, end: null };
  try {
    out.start = a.selectionStart;
    out.end = a.selectionEnd;
  } catch {
    // input type=number/date không cho đọc vị trí con trỏ — bỏ qua.
  }
  return out;
}

function restoreFocus(saved) {
  if (!saved) return;
  const node = document.querySelector('[data-fk="' + saved.fk + '"]');
  if (!node) return;
  node.focus();
  if (saved.start !== null) {
    try {
      node.setSelectionRange(saved.start, saved.end);
    } catch {
      // như trên
    }
  }
}

function viDate(iso) {
  if (!iso) return '—';
  const p = String(iso).split('-');
  return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : iso;
}

/** 'yyyy-mm-dd' -> 'dd/mm/yyyy' cho ô nhập (rỗng khi chưa có ngày). */
function viDateInput(iso) {
  if (!iso) return '';
  const p = String(iso).split('-');
  return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : String(iso);
}

/** 'dd/mm/yyyy' -> 'yyyy-mm-dd'; '' nếu chưa đủ hoặc ngày không có thật (31/02). */
function isoFromViDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim());
  if (!m) return '';
  const pad = (n) => (n.length === 1 ? '0' + n : n);
  const iso = m[3] + '-' + pad(m[2]) + '-' + pad(m[1]);
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return '';
  return iso;
}

/** Chèn dấu / trong lúc gõ: 01012026 -> 01/01/2026 */
function maskViDate(s) {
  const n = String(s).replace(/\D/g, '').slice(0, 8);
  if (n.length <= 2) return n;
  if (n.length <= 4) return n.slice(0, 2) + '/' + n.slice(2);
  return n.slice(0, 2) + '/' + n.slice(2, 4) + '/' + n.slice(4);
}

/**
 * Ô ngày dd/mm/yyyy. Dùng input text thay cho type=date vì type=date hiển thị
 * theo ngôn ngữ của máy người dùng (mm/dd/yyyy trên máy tiếng Anh).
 * onvalue nhận 'yyyy-mm-dd' hoặc '' khi ô trống; gõ sai thì trả về giá trị cũ.
 */
function viDateField(opts) {
  return el('input', {
    class: 'input ' + (opts.class || ''),
    type: 'text',
    fk: opts.fk,
    inputmode: 'numeric',
    maxlength: '10',
    autocomplete: 'off',
    placeholder: 'dd/mm/yyyy',
    value: viDateInput(opts.value),
    oninput: (e) => {
      // Chỉ tự chèn '/' khi con trỏ ở cuối, để sửa giữa chuỗi không bị nhảy.
      if (e.target.selectionStart !== e.target.value.length) return;
      e.target.value = maskViDate(e.target.value);
    },
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.target.blur();
      }
    },
    onchange: (e) => {
      const raw = e.target.value.trim();
      const iso = raw === '' ? '' : isoFromViDate(raw);
      if (raw !== '' && !iso) {
        e.target.value = viDateInput(opts.value);
        return;
      }
      opts.onvalue(iso);
    },
  });
}

function viDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return (
    p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  );
}

function todayIso() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function fileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * Đường dẫn tệp đính kèm: xem ngay trên web, hoặc tải xuống.
 *
 * Gắn thêm tên tệp vào cuối đường dẫn để thanh công cụ của trình xem PDF hiện
 * tên văn bản thật. Máy chủ bỏ qua đoạn này, tệp vẫn tìm theo id.
 */
function fileUrl(id, xem, name) {
  const slug = name ? '/' + encodeURIComponent(name) : '';
  return '/api/documents/' + id + '/file' + slug + (xem ? '?xem=1' : '');
}

/**
 * Đường lấy bản PDF để xem: PDF gốc hoặc tệp Office đã được máy chủ chuyển.
 *
 * CỐ Ý không có đuôi tệp và không có tham số truy vấn — tiện ích chặn quảng cáo
 * chặn dạng “…/ten.pdf?xem=1”. Đừng thêm gì vào đây.
 */
function xemPdfUrl(id) {
  return '/api/documents/' + id + '/xem-pdf';
}

/**
 * Ô đính kèm trong bảng: bấm tên tệp là xem ngay, khỏi phải tải về mở rồi xóa.
 *
 * Loại tệp trình duyệt không dựng được (.docx, .xlsx, .tif…) thì máy chủ đã
 * đặt fileViewable = false; những tệp đó vẫn là đường tải xuống như trước, chứ
 * không mở ra một khung trắng rồi người dùng không hiểu vì sao.
 */
function fileCell(d) {
  const size = d.fileSize ? el('span', { class: 'hint', text: ' · ' + fileSize(d.fileSize) }) : null;
  if (!d.fileViewable) {
    return el('a', { href: fileUrl(d.id), title: 'Tải ' + d.fileName + ' (loại tệp này phải mở bằng máy)' },
      d.fileName, size);
  }
  return el('span', { class: 'file-cell' },
    el('button', {
      class: 'btn-link file-open', type: 'button',
      title: 'Xem ' + d.fileName + ' ngay trên web',
      onclick: () => openFileViewer(d),
    }, d.fileName, size),
    el('a', { class: 'file-dl', href: fileUrl(d.id), title: 'Tải ' + d.fileName + ' về máy', text: 'Tải' })
  );
}

const SEC_CLASS = {
  'Thường': 'badge',
  'Mật': 'badge badge-blue',
  'Tối Mật': 'badge badge-orange',
  'Tuyệt Mật': 'badge badge-red',
};
const ROLE_CLASS = { admin: 'badge badge-orange', vanthu: 'badge badge-blue', xem: 'badge' };
const SEGMENT_LABELS = [
  ['seq', 'Số thứ tự'],
  ['year', 'Năm — 4 chữ số'],
  ['yy', 'Năm — 2 chữ số'],
  ['text', 'Ký tự cố định'],
];

// ---------------------------------------------------------------------- api

class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(method, url, body, isForm) {
  const headers = { 'X-VB-Request': '1' };
  let payload;
  if (isForm) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, 'Không kết nối được máy chủ. Kiểm tra mạng nội bộ rồi thử lại.', 'offline');
  }
  let data = null;
  if (res.status !== 204) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = new ApiError(res.status, (data && data.error) || 'Lỗi không rõ.', data && data.code);
    // Phiên hết hạn hoặc bị cắt: đưa về màn đăng nhập thay vì báo lỗi khô khan.
    if (res.status === 401) {
      state.user = null;
      render();
    }
    if (err.code === 'must_change_password') {
      if (state.user) state.user.mustChangePassword = true;
      render();
    }
    throw err;
  }
  return data;
}

// -------------------------------------------------------------------- state

const state = {
  config: null,
  user: null,
  page: 'so',
  book: 'den',
  settingsTab: 'layso',
  filters: { year: String(new Date().getFullYear()), q: '', security: '', from: '', to: '' },
  documents: [],
  shown: 0,
  totalInBook: 0,
  counts: { den: 0, di: 0 },
  nextNumber: null,
  years: [],
  numbering: null,
  draftNumbering: null,
  numberingSavedAt: '',
  resetOpen: false,
  resetToRaw: '1',
  users: [],
  audit: [],
  auditFilters: { q: '', action: '', onlyDeletes: false },
  auditMeta: { hasMore: false, total: 0, restorable: 0 },
  auditLimit: 200,
  loading: false,
  dialog: null,
  loginError: '',
  loginForm: { username: '', password: '', showPw: false },
  pwError: '',
  pwForm: { current: '', next1: '', next2: '' },
};

const toasts = [];

function toast(message, kind) {
  const node = el('div', { class: 'toast ' + (kind || ''), text: message });
  document.getElementById('toasts').append(node);
  toasts.push(node);
  setTimeout(() => {
    node.remove();
  }, kind === 'err' ? 9000 : 5000);
}

function showError(err) {
  if (err instanceof ApiError && err.status === 401) return;
  toast(err && err.message ? err.message : 'Lỗi không rõ.', 'err');
}

const isAdmin = () => state.user && state.user.role === 'admin';
const canWrite = () => state.user && (state.user.role === 'admin' || state.user.role === 'vanthu');

// ------------------------------------------------------------ tải dữ liệu

async function loadBook() {
  const f = state.filters;
  const qs = new URLSearchParams({ book: state.book });
  if (f.year) qs.set('year', f.year);
  if (f.q) qs.set('q', f.q);
  if (f.security) qs.set('security', f.security);
  if (f.from) qs.set('from', f.from);
  if (f.to) qs.set('to', f.to);
  const data = await api('GET', '/api/documents?' + qs.toString());
  state.documents = data.documents;
  state.shown = data.shown;
  state.totalInBook = data.totalInBook;
}

async function loadCounts() {
  const data = await api('GET', '/api/documents/years');
  state.years = data.years;
  state.counts = data.years.reduce(
    (acc, y) => ({ den: acc.den + y.den, di: acc.di + y.di }),
    { den: 0, di: 0 }
  );
}

async function loadNextNumber() {
  state.nextNumber = await api('GET', '/api/documents/next-number');
}

async function loadNumbering() {
  const data = await api('GET', '/api/settings/numbering');
  state.numbering = data;
  state.draftNumbering = {
    segments: data.numbering.segments.map((s) => ({ type: s.type, text: s.text || '' })),
    startRaw: String(data.numbering.start),
    resetYearly: data.numbering.resetYearly,
  };
  state.resetToRaw = String(data.counter.value);
}

async function loadUsers() {
  const data = await api('GET', '/api/users');
  state.users = data.users;
}

async function loadAudit() {
  const f = state.auditFilters;
  const qs = new URLSearchParams({ limit: String(state.auditLimit) });
  if (f.q) qs.set('q', f.q);
  // “Chỉ việc xóa văn bản” là lối tắt của bộ lọc loại việc, nên hai thứ dùng
  // chung một tham số; công tắc thắng khi cả hai đang bật.
  const action = f.onlyDeletes ? 'xoa_van_ban' : f.action;
  if (action) qs.set('action', action);
  const data = await api('GET', '/api/settings/audit?' + qs.toString());
  state.audit = data.entries;
  state.auditMeta = {
    hasMore: !!data.hasMore,
    total: data.total || 0,
    restorable: data.restorable || 0,
  };
}

async function refresh() {
  state.loading = true;
  render();
  try {
    if (state.page === 'so') {
      await Promise.all([loadBook(), loadCounts(), loadNextNumber()]);
    } else if (state.settingsTab === 'layso') {
      await Promise.all([loadNumbering(), loadCounts()]);
    } else if (state.settingsTab === 'taikhoan') {
      await Promise.all([loadUsers(), loadCounts()]);
    } else if (state.settingsTab === 'sonam') {
      await loadCounts();
    } else if (state.settingsTab === 'nhatky') {
      await Promise.all([loadAudit(), loadCounts()]);
    }
  } catch (err) {
    showError(err);
  } finally {
    state.loading = false;
    render();
  }
}

// -------------------------------------------------------- màn hình đăng nhập

function renderGate() {
  const org = state.config ? state.config.orgName : '';
  const year = state.config ? state.config.currentYear : new Date().getFullYear();
  const lf = state.loginForm;

  const submit = async () => {
    state.loginError = '';
    if (!lf.username.trim() || !lf.password) {
      state.loginError = 'Nhập tên đăng nhập và mật khẩu.';
      render();
      return;
    }
    try {
      const data = await api('POST', '/api/login', { username: lf.username.trim(), password: lf.password });
      state.user = data.user;
      state.loginError = '';
      state.loginForm = { username: '', password: '', showPw: false };
      render();
      refresh();
    } catch (err) {
      state.loginError = err.message;
      render();
    }
  };

  const pwInput = el('input', {
    class: 'input',
    type: lf.showPw ? 'text' : 'password',
    value: lf.password,
    placeholder: '••••••••',
    autocomplete: 'current-password',
    fk: 'login-pass',
    oninput: (e) => {
      lf.password = e.target.value;
    },
    onkeydown: (e) => {
      if (e.key === 'Enter') submit();
    },
  });

  return el('div', { class: 'gate' },
    el('div', { class: 'gate-inner' },
      el('div', { class: 'gate-brand' },
        el('div', { class: 'brand' },
          el('span', { class: 'brand-dot' }),
          el('span', { class: 'brand-name', text: 'Quản lý số văn bản' })
        ),
        el('span', { class: 'muted', text: org + ' · Sổ ' + year })
      ),
      el('div', { class: 'gate-card' },
        el('div', { class: 'gate-form' },
          el('span', { class: 'label label-accent', text: 'Đăng nhập hệ thống' }),
          state.loginError
            ? el('div', { class: 'note note-error' }, icon('alert', 16), el('span', { text: state.loginError }))
            : null,
          el('label', { class: 'field' },
            el('span', { class: 'label', text: 'Tên đăng nhập' }),
            el('input', {
              class: 'input',
              type: 'text',
              value: lf.username,
              placeholder: 'vd: hant',
              autocomplete: 'username',
              autofocus: 'autofocus',
              fk: 'login-user',
              oninput: (e) => {
                lf.username = e.target.value;
              },
              onkeydown: (e) => {
                if (e.key === 'Enter') submit();
              },
            })
          ),
          el('label', { class: 'field' },
            el('span', { class: 'label', text: 'Mật khẩu' }),
            el('span', { class: 'pw-wrap' },
              pwInput,
              el('button', {
                class: 'pw-toggle',
                type: 'button',
                onclick: (e) => {
                  lf.showPw = !lf.showPw;
                  pwInput.type = lf.showPw ? 'text' : 'password';
                  e.currentTarget.textContent = lf.showPw ? 'Ẩn' : 'Hiện';
                  pwInput.focus();
                },
                text: lf.showPw ? 'Ẩn' : 'Hiện',
              })
            )
          ),
          el('button', { class: 'btn btn-primary', type: 'button', onclick: submit, text: 'Đăng nhập' })
        ),
        el('div', { class: 'gate-foot' },
          icon('lock', 16, '#37505c'),
          el('p', {},
            'Hệ thống không cho tự đăng ký. Tài khoản do ',
            el('strong', { text: 'quản trị viên' }),
            ' cấp — liên hệ quản trị để được mở tài khoản hoặc cấp lại mật khẩu.'
          )
        )
      )
    )
  );
}

function renderPasswordGate() {
  const pf = state.pwForm;
  const min = state.config ? state.config.minPasswordLength : 8;

  const submit = async () => {
    state.pwError = '';
    if (pf.next1 !== pf.next2) {
      state.pwError = 'Hai lần nhập mật khẩu mới không giống nhau.';
      render();
      return;
    }
    try {
      await api('POST', '/api/change-password', { currentPassword: pf.current, newPassword: pf.next1 });
      state.user.mustChangePassword = false;
      state.pwError = '';
      state.pwForm = { current: '', next1: '', next2: '' };
      toast('Đã đổi mật khẩu.', 'ok');
      render();
      refresh();
    } catch (err) {
      state.pwError = err.message;
      render();
    }
  };

  const field = (label, autocomplete, key) =>
    el('label', { class: 'field' },
      el('span', { class: 'label', text: label }),
      el('input', {
        class: 'input',
        type: 'password',
        autocomplete,
        fk: 'pw-' + key,
        value: pf[key],
        oninput: (e) => { pf[key] = e.target.value; },
        onkeydown: (e) => {
          if (e.key === 'Enter') submit();
        },
      })
    );

  return el('div', { class: 'gate' },
    el('div', { class: 'gate-inner' },
      el('div', { class: 'gate-brand' },
        el('div', { class: 'brand' },
          el('span', { class: 'brand-dot' }),
          el('span', { class: 'brand-name', text: 'Đổi mật khẩu' })
        ),
        el('span', { class: 'muted', text: state.user.fullName + ' · ' + state.user.username })
      ),
      el('div', { class: 'gate-card' },
        el('div', { class: 'gate-form' },
          el('span', { class: 'label label-accent', text: 'Bắt buộc trước khi dùng hệ thống' }),
          el('div', { class: 'note' }, icon('alert', 16),
            el('span', { text: 'Bạn đang dùng mật khẩu tạm thời do quản trị viên cấp. Đặt mật khẩu riêng để tiếp tục.' })),
          state.pwError
            ? el('div', { class: 'note note-error' }, icon('alert', 16), el('span', { text: state.pwError }))
            : null,
          field('Mật khẩu tạm thời hiện tại', 'current-password', 'current'),
          field('Mật khẩu mới (ít nhất ' + min + ' ký tự)', 'new-password', 'next1'),
          field('Nhập lại mật khẩu mới', 'new-password', 'next2'),
          el('button', { class: 'btn btn-primary', type: 'button', onclick: submit, text: 'Đổi mật khẩu và tiếp tục' }),
          el('button', {
            class: 'btn-link',
            type: 'button',
            onclick: async () => {
              await api('POST', '/api/logout').catch(() => { });
              state.user = null;
              render();
            },
            text: 'Đăng xuất',
          })
        )
      )
    )
  );
}

// ------------------------------------------------------------------ khung

function renderHeader() {
  const u = state.user;
  return el('header', { class: 'topbar' },
    el('div', { class: 'brand' },
      el('span', { class: 'brand-dot' }),
      el('span', { class: 'brand-name', text: 'Quản lý số văn bản' })
    ),
    el('span', { class: 'muted', text: state.config.orgName }),
    el('span', { class: 'hint', text: 'Sổ văn bản ' + state.config.currentYear }),
    el('div', { class: 'topbar-right' },
      el('span', { class: 'muted', text: u.fullName }),
      el('span', { class: ROLE_CLASS[u.role], text: u.roleLabel }),
      el('button', {
        class: 'btn btn-sm',
        type: 'button',
        onclick: async () => {
          try {
            await api('POST', '/api/logout');
          } catch { }
          state.user = null;
          state.page = 'so';
          render();
        },
        text: 'Đăng xuất',
      })
    )
  );
}

function renderTabs() {
  const tab = (label, count, active, onClick, extra) =>
    el('button', { class: 'tab' + (active ? ' active' : ''), type: 'button', onclick: onClick },
      label,
      count !== null && count !== undefined ? el('span', { class: 'tab-count', text: String(count) }) : null,
      extra || null
    );

  return el('div', { class: 'tabs' },
    tab('1. Văn bản đến', state.counts.den, state.page === 'so' && state.book === 'den', () => {
      state.page = 'so';
      state.book = 'den';
      refresh();
    }),
    tab('2. Văn bản đi', state.counts.di, state.page === 'so' && state.book === 'di', () => {
      state.page = 'so';
      state.book = 'di';
      refresh();
    }),
    // Tab Cài đặt chỉ hiện với quản trị. Máy chủ vẫn chặn riêng, đây chỉ là cho gọn mắt.
    isAdmin()
      ? tab('Cài đặt', null, state.page === 'settings', () => {
        state.page = 'settings';
        refresh();
      }, icon('lock', 13, '#cc4600'))
      : null
  );
}

// -------------------------------------------------------------- trang sổ

let searchTimer = null;

function renderFilters() {
  const f = state.filters;
  const years = state.years.map((y) => String(y.year));
  if (!years.includes(String(state.config.currentYear))) years.unshift(String(state.config.currentYear));

  const set = (key, value, immediate) => {
    f[key] = value;
    if (immediate) refresh();
  };

  return el('section', { class: 'section section-tight' },
    el('div', { class: 'filters' },
      el('label', { class: 'field' },
        el('span', { class: 'label', text: 'Sổ năm' }),
        el('select', {
          class: 'select',
          onchange: (e) => set('year', e.target.value, true),
        },
          el('option', { value: '', text: 'Tất cả các năm', selected: f.year === '' }),
          years.map((y) => el('option', { value: y, text: 'Sổ ' + y, selected: f.year === y }))
        )
      ),
      el('label', { class: 'field grow' },
        el('span', { class: 'label', text: 'Tìm kiếm' }),
        el('input', {
          class: 'input',
          type: 'search',
          fk: 'filter-q',
          value: f.q,
          placeholder: 'Tên văn bản · số · người gửi · ghi chú',
          oninput: (e) => {
            f.q = e.target.value;
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
              loadBook().then(render).catch(showError);
            }, 250);
          },
        })
      ),
      el('label', { class: 'field' },
        el('span', { class: 'label', text: 'Độ bảo mật' }),
        el('select', { class: 'select', onchange: (e) => set('security', e.target.value, true) },
          el('option', { value: '', text: 'Tất cả', selected: f.security === '' }),
          state.config.securityLevels.map((s) =>
            el('option', { value: s, text: s, selected: f.security === s })
          )
        )
      ),
      el('label', { class: 'field' },
        el('span', { class: 'label', text: 'Từ ngày' }),
        viDateField({ fk: 'filter-from', value: f.from, onvalue: (v) => set('from', v, true) })
      ),
      el('label', { class: 'field' },
        el('span', { class: 'label', text: 'Đến ngày' }),
        viDateField({ fk: 'filter-to', value: f.to, onvalue: (v) => set('to', v, true) })
      ),
      el('button', {
        class: 'btn',
        type: 'button',
        onclick: () => {
          state.filters = { year: String(state.config.currentYear), q: '', security: '', from: '', to: '' };
          refresh();
        },
        text: 'Xóa lọc',
      })
    ),
    el('div', { class: 'filters-foot' },
      el('span', {
        class: 'muted',
        text:
          'Hiển thị ' + state.shown + ' / ' + state.totalInBook +
          (state.book === 'den' ? ' văn bản đến' : ' văn bản đi') +
          ' · ' + (f.year ? 'sổ ' + f.year : 'tất cả các năm'),
      }),
      f.year && f.year !== String(state.config.currentYear)
        ? el('span', { class: 'note' },
          el('span', { text: 'Bạn đang xem sổ ' + f.year + '. Số cấp mới vẫn thuộc sổ ' + state.config.currentYear + '.' }),
          el('button', {
            class: 'btn-link',
            type: 'button',
            onclick: () => {
              f.year = String(state.config.currentYear);
              refresh();
            },
            text: 'Về sổ năm nay',
          })
        )
        : null,
      canWrite()
        ? el('div', { class: 'filters-actions' },
          el('button', {
            class: 'btn btn-secondary',
            type: 'button',
            onclick: () => openDocDialog({ book: state.book, mode: 'manual' }),
            text: state.book === 'den' ? '+ Ghi văn bản đến' : '+ Ghi thủ công',
          }),
          el('button', {
            class: 'btn btn-primary',
            type: 'button',
            onclick: () => openDocDialog({ book: 'di', mode: 'issue' }),
          },
            'Lấy số gửi văn bản đi',
            state.nextNumber
              ? el('span', { class: 'mono next-num', text: state.nextNumber.soVanBan })
              : null
          )
        )
        : el('span', { class: 'push muted inline-icon' },
          icon('lock', 14, '#9b9d96'),
          'Vai trò Chỉ xem — không ghi sổ, không lấy số'
        )
    )
  );
}

function renderBookTable() {
  const write = canWrite();
  const head = el('tr', {},
    el('th', { class: 'w110', text: 'Số văn bản' }),
    el('th', { class: 'w96', text: 'Ngày gửi' }),
    el('th', { class: 'w160', text: 'Người gửi' }),
    el('th', { text: 'Tên văn bản' }),
    el('th', { class: 'w110', text: 'Độ bảo mật' }),
    el('th', { class: 'w140', text: 'Đính kèm' }),
    el('th', { class: 'w190', text: 'Ghi chú' }),
    write ? el('th', { class: 'w96' }) : null
  );

  const rows = state.documents.map((d) =>
    el('tr', {},
      el('td', { class: 'cell-num', text: d.soVanBan }),
      el('td', { class: 'cell-mono', text: viDate(d.ngayGui) }),
      el('td', { text: d.nguoiGui || '—' }),
      el('td', { class: 'cell-title', text: d.tenVanBan }),
      el('td', {}, el('span', { class: SEC_CLASS[d.doBaoMat] || 'badge', text: d.doBaoMat })),
      el('td', { class: 'cell-file' + (d.hasFile ? '' : ' empty') },
        d.hasFile ? fileCell(d) : '— chưa có —'
      ),
      el('td', { class: 'cell-note', text: d.ghiChu || '—' }),
      write
        ? el('td', { class: 'cell-actions' },
          el('button', { class: 'btn-link', type: 'button', onclick: () => openDocDialog({ book: d.book, mode: 'edit', doc: d }), text: 'Sửa' }),
          el('button', {
            class: 'btn-link danger',
            type: 'button',
            onclick: () => confirmDelete(d),
            text: 'Xóa',
          })
        )
        : null
    )
  );

  return el('section', { class: 'table-wrap' },
    el('table', {}, el('thead', {}, head), el('tbody', {}, rows)),
    state.documents.length === 0
      ? el('div', { class: 'empty-state', text: state.loading ? 'Đang tải…' : 'Không có văn bản nào khớp với điều kiện lọc.' })
      : null
  );
}

function renderBookPage() {
  return [
    renderFilters(),
    renderBookTable(),
    state.nextNumber
      ? el('p', { class: 'hint m0' },
        'Định dạng số văn bản đi: ' + (state.nextNumber.resetYearly ? 'tự tăng theo năm, reset đầu năm' : 'tự tăng liên tục qua các năm') + ' · không có 0 ở đầu')
      : null,
  ];
}

// ------------------------------------------------------- trang cài đặt

function renderSettingsTabs() {
  const tabs = [
    ['layso', 'Lấy số'],
    ['taikhoan', 'Tài khoản'],
    ['sonam', 'Sổ theo năm'],
    ['nhatky', 'Nhật ký'],
  ];
  return el('div', { class: 'subtabs' },
    tabs.map(([key, label]) =>
      el('button', {
        class: 'subtab' + (state.settingsTab === key ? ' active' : ''),
        type: 'button',
        onclick: () => {
          state.settingsTab = key;
          refresh();
        },
        text: label,
      })
    )
  );
}

/** Đọc ô số: giữ nguyên chuỗi đang gõ, chỉ quy về số nguyên khi cần dùng. */
function num(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/** Bản sao logic ghép số ở phía trình duyệt, chỉ để xem trước tức thời.
    Máy chủ vẫn là nơi quyết định số thật. */
function buildLocal(segments, seq, year) {
  return segments
    .map((s) =>
      s.type === 'seq' ? String(seq)
        : s.type === 'year' ? String(year)
          : s.type === 'yy' ? String(year).slice(2)
            : s.text || ''
    )
    .join('');
}

function draftProblem(segments) {
  const n = segments.filter((s) => s.type === 'seq').length;
  if (n === 0) return 'Cấu trúc phải có đúng một thành phần “Số thứ tự” — nếu không, mọi văn bản sẽ mang cùng một số.';
  if (n > 1) return 'Chỉ được một thành phần “Số thứ tự”. Bỏ các thành phần trùng.';
  if (segments.some((s) => s.type === 'text' && !(s.text || '').trim())) {
    return 'Có ô “Ký tự cố định” đang để trống — điền dấu phân cách hoặc bỏ thành phần đó.';
  }
  return '';
}

const PRESETS = [
  [{ type: 'seq' }, { type: 'text', text: '/' }, { type: 'year' }],
  [{ type: 'seq' }, { type: 'text', text: '/P1' }],
  [{ type: 'seq' }, { type: 'text', text: '/' }, { type: 'year' }, { type: 'text', text: '/P1' }],
  [{ type: 'seq' }, { type: 'text', text: '-CV' }],
  [{ type: 'text', text: 'CV-' }, { type: 'seq' }, { type: 'text', text: '/' }, { type: 'year' }],
  [{ type: 'seq' }],
];

const sameSegments = (a, b) =>
  a.length === b.length &&
  a.every((s, i) => s.type === b[i].type && (s.text || '') === (b[i].text || ''));

function renderNumberingPage() {
  const snap = state.numbering;
  if (!snap) return el('section', { class: 'section' }, el('span', { class: 'muted', text: 'Đang tải…' }));

  const draft = state.draftNumbering;
  const year = snap.year;
  const seq = snap.next.seq;
  const problem = draftProblem(draft.segments);
  const start = num(draft.startRaw, 1);
  const dirty = !sameSegments(draft.segments, snap.numbering.segments) ||
    start !== snap.numbering.start ||
    draft.resetYearly !== snap.numbering.resetYearly;

  const touch = () => {
    state.numberingSavedAt = '';
    render();
  };

  const segmentCard = (sg, i) =>
    el('div', { class: 'segment' + (sg.type === 'seq' ? ' is-seq' : '') },
      el('div', { class: 'segment-head' },
        el('span', { class: 'segment-pos', text: String(i + 1) }),
        el('div', { class: 'segment-tools' },
          el('button', {
            class: 'icon-btn', type: 'button', title: 'Chuyển sang trái', disabled: i === 0,
            onclick: () => {
              const s = draft.segments;
              [s[i - 1], s[i]] = [s[i], s[i - 1]];
              touch();
            },
          }, icon('left', 12)),
          el('button', {
            class: 'icon-btn', type: 'button', title: 'Chuyển sang phải', disabled: i === draft.segments.length - 1,
            onclick: () => {
              const s = draft.segments;
              [s[i + 1], s[i]] = [s[i], s[i + 1]];
              touch();
            },
          }, icon('right', 12)),
          el('button', {
            class: 'icon-btn danger', type: 'button', title: 'Bỏ thành phần',
            onclick: () => {
              draft.segments.splice(i, 1);
              touch();
            },
          }, icon('x', 12))
        )
      ),
      el('select', {
        onchange: (e) => {
          sg.type = e.target.value;
          if (sg.type !== 'text') sg.text = '';
          touch();
        },
      }, SEGMENT_LABELS.map(([v, l]) => el('option', { value: v, text: l, selected: sg.type === v }))),
      sg.type === 'text'
        ? el('input', {
          type: 'text', value: sg.text || '', placeholder: '/',
          fk: 'seg-text-' + i,
          oninput: (e) => {
            sg.text = e.target.value;
            touch();
          },
        })
        : null,
      el('div', {
        class: 'segment-preview',
        text: sg.type === 'seq' ? String(seq)
          : sg.type === 'year' ? String(year)
            : sg.type === 'yy' ? String(year).slice(2)
              : (sg.text || '␣'),
      })
    );

  const save = async () => {
    if (problem) return;
    try {
      const data = await api('PUT', '/api/settings/numbering', {
        numbering: { segments: draft.segments, start, resetYearly: draft.resetYearly },
      });
      state.numbering = data;
      state.numberingSavedAt = viDateTime(new Date().toISOString()).slice(-5);
      toast('Đã lưu cài đặt lấy số. Số kế tiếp: ' + data.next.soVanBan, 'ok');
      render();
    } catch (err) {
      showError(err);
    }
  };

  const previewRows = [];
  for (let k = 0; k < 5; k += 1) {
    previewRows.push(
      el('tr', {},
        el('td', { class: 'label lane' + (k === 0 ? ' label-accent' : ' label-dim'), text: k === 0 ? 'Kế tiếp' : String(k + 1) }),
        el('td', {
          class: 'cell-num ' + (k === 0 ? 'num-next' : 'num-later'),
          text: problem ? '—' : buildLocal(draft.segments, seq + k, year),
        }),
        el('td', { class: 'muted', text: k === 0 ? 'Cấp khi bấm “Lấy số gửi văn bản đi”' : '' })
      )
    );
  }
  const nextYearSeq = draft.resetYearly ? start : seq + 5;
  previewRows.push(
    el('tr', { class: 'row-turn' },
      el('td', { class: 'label label-dim lane', text: 'Sổ ' + (year + 1) }),
      el('td', { class: 'cell-num', text: problem ? '—' : buildLocal(draft.segments, nextYearSeq, year + 1) }),
      el('td', { class: 'muted', text: draft.resetYearly ? 'Bộ đếm về đầu vào 01/01/' + (year + 1) : 'Bộ đếm chạy tiếp qua năm mới' })
    )
  );

  return [
    el('div', { class: 'row-top' },
      el('div', { class: 'stack' },
        el('div', { class: 'row' },
          el('span', { class: 'page-title', text: 'Cài đặt lấy số' }),
          el('span', { class: 'admin-chip' }, icon('lock', 12, '#cc4600'), el('span', { text: 'Chỉ quản trị viên' }))
        ),
        el('span', { class: 'muted' },
          'Quy định cách hệ thống sinh số cho ',
          el('strong', { text: 'văn bản đi' }),
          '. Thay đổi ở đây không sửa số của văn bản đã ghi vào sổ.'
        )
      ),
      el('div', { class: 'push stack ta-right' },
        el('span', { class: 'label label-dim', text: 'Cập nhật lần cuối' }),
        el('span', { class: 'muted', text: snap.updatedAt ? viDateTime(snap.updatedAt) : 'chưa từng sửa' }),
        el('span', { class: 'muted', text: snap.updatedByName || '' })
      )
    ),

    el('section', { class: 'section' },
      el('div', { class: 'stack' },
        el('span', { class: 'label label-accent', text: '1 · Cấu trúc số' }),
        el('span', { class: 'muted', text: 'Ghép các thành phần theo thứ tự từ trái sang phải. Dùng ô Ký tự cố định cho dấu gạch, mã phòng ban hay chữ viết tắt.' })
      ),
      el('div', { class: 'segments' },
        draft.segments.map(segmentCard),
        el('button', {
          class: 'segment-add', type: 'button',
          onclick: () => {
            draft.segments.push({ type: 'text', text: '' });
            touch();
          },
        }, icon('plus', 18), el('span', { text: 'Thêm thành phần' }))
      ),
      problem ? el('div', { class: 'note note-error' }, icon('alert', 16), el('span', { text: problem })) : null,
      el('div', { class: 'next-number' },
        el('span', { class: 'label label-on-tint', text: 'Số kế tiếp' }),
        el('span', { class: 'next-number-value', text: problem ? '—' : buildLocal(draft.segments, seq, year) }),
        el('span', { class: 'muted', text: problem ? 'Sửa cấu trúc để xem số kế tiếp' : 'Cấp cho văn bản đi tiếp theo trong sổ ' + year })
      ),
      el('div', { class: 'presets' },
        el('span', { class: 'muted', text: 'Mẫu có sẵn' }),
        PRESETS.map((p) =>
          el('button', {
            class: 'preset' + (sameSegments(p, draft.segments) ? ' active' : ''),
            type: 'button',
            onclick: () => {
              draft.segments = p.map((s) => ({ type: s.type, text: s.text || '' }));
              touch();
            },
            text: buildLocal(p, seq, year),
          })
        )
      )
    ),

    el('section', { class: 'section' },
      el('span', { class: 'label label-accent', text: '2 · Quy tắc đánh số' }),
      el('div', { class: 'row-fields' },
        el('label', { class: 'field' },
          el('span', { class: 'label', text: 'Bắt đầu từ' }),
          el('input', {
            class: 'input mono w120', type: 'number', min: '1', value: draft.startRaw,
            fk: 'cfg-start',
            oninput: (e) => {
              draft.startRaw = e.target.value;
              touch();
            },
          }),
          el('span', { class: 'hint', text: 'Số nhỏ nhất được cấp' })
        ),
        el('div', { class: 'field' },
          el('span', { class: 'label', text: 'Reset đầu năm' }),
          el('div', { class: 'toggle' },
            el('button', {
              class: draft.resetYearly ? 'active' : '', type: 'button',
              onclick: () => { draft.resetYearly = true; touch(); }, text: 'Có',
            }),
            el('button', {
              class: !draft.resetYearly ? 'active' : '', type: 'button',
              onclick: () => { draft.resetYearly = false; touch(); }, text: 'Không',
            })
          ),
          el('span', { class: 'hint', text: draft.resetYearly ? 'Ngày 01/01 số quay về ' + start : 'Số tăng liên tục qua các năm' })
        )
      ),
      el('div', { class: 'rule' },
        el('span', { class: 'rule-icon' }, icon('lock', 15, '#37505c')),
        el('div', { class: 'rule-body' },
          el('div', { class: 'rule-title' },
            el('strong', { text: 'Không có số 0 ở đầu' }),
            el('span', { class: 'badge', text: 'Cố định' })
          ),
          el('p', {},
            'Số thứ tự luôn ở dạng ngắn nhất — ',
            el('span', { class: 'mono', text: '1' }), ', ',
            el('span', { class: 'mono', text: '2' }), ', … ',
            el('span', { class: 'mono', text: '10' }),
            ' — không phải ', el('del', { text: '01' }), ', ', el('del', { text: '02' }),
            '. Số nhập tay vào sổ văn bản đi cũng được chuẩn hóa khi lưu (',
            el('del', { text: '06/2026' }), ' → ', el('span', { class: 'mono', text: '6/2026' }),
            '). Số của ', el('strong', { text: 'văn bản đến' }), ' giữ nguyên như cơ quan gửi ghi.'
          )
        )
      )
    ),

    el('section', { class: 'section' },
      el('div', { class: 'stack' },
        el('span', { class: 'label label-accent', text: '3 · Xem trước' }),
        el('span', { class: 'muted', text: 'Các số sẽ được cấp lần lượt nếu giữ cài đặt hiện tại.' })
      ),
      el('div', { class: 'table-wrap mw680' },
        el('table', {},
          el('thead', {}, el('tr', {},
            el('th', { class: 'w104', text: 'Lần cấp' }),
            el('th', { class: 'w190', text: 'Số văn bản' }),
            el('th', { text: 'Ghi chú' })
          )),
          el('tbody', {}, previewRows)
        )
      )
    ),

    el('section', { class: 'section' },
      el('span', { class: 'label label-accent', text: '4 · Bộ đếm sổ ' + year }),
      el('div', { class: 'row' },
        el('span', { class: 'muted' }, 'Đã ghi ', el('strong', { class: 'mono', text: String(snap.counter.issuedThisYear) }), ' văn bản đi'),
        el('span', { class: 'muted' }, 'Số lớn nhất đã dùng ', el('strong', { class: 'mono', text: String(snap.counter.maxSeqUsed) })),
        el('span', { class: 'muted' }, 'Bộ đếm đang ở ', el('strong', { class: 'mono', text: String(snap.counter.value) })),
        !state.resetOpen
          ? el('button', {
            class: 'btn btn-danger push', type: 'button',
            onclick: () => {
              state.resetOpen = true;
              state.resetToRaw = String(snap.counter.value);
              render();
            },
            text: 'Đặt lại bộ đếm…',
          })
          : null
      ),
      state.resetOpen
        ? el('div', { class: 'danger-zone' },
          el('div', { class: 'warn-row' },
            icon('warn', 16, '#cc0000'),
            el('p', { text: 'Đặt lại bộ đếm không sửa số của văn bản đã ghi vào sổ. Nếu đặt về một giá trị đã dùng, hệ thống sẽ nhảy tới số trống kế tiếp thay vì cấp trùng. Hành động được ghi vào nhật ký kèm tên quản trị viên.' })
          ),
          el('div', { class: 'row' },
            el('label', { class: 'field' },
              el('span', { class: 'label', text: 'Số kế tiếp sẽ là' }),
              el('input', {
                class: 'input mono w140', type: 'number', min: '1', value: state.resetToRaw,
                fk: 'reset-to',
                oninput: (e) => {
                  state.resetToRaw = e.target.value;
                  render();
                },
              })
            ),
            el('span', { class: 'muted reset-arrow' },
              '→ ',
              el('span', { class: 'mono reset-val', text: buildLocal(snap.numbering.segments, num(state.resetToRaw, 1), year) })
            ),
            el('div', { class: 'savebar-actions' },
              el('button', { class: 'btn', type: 'button', onclick: () => { state.resetOpen = false; render(); }, text: 'Hủy' }),
              el('button', {
                class: 'btn btn-solid-danger', type: 'button',
                onclick: async () => {
                  try {
                    const data = await api('POST', '/api/settings/numbering/reset-counter', { nextSeq: num(state.resetToRaw, 1) });
                    state.numbering = data;
                    state.resetOpen = false;
                    toast(
                      data.clamped
                        ? 'Bộ đếm không lùi được: số ' + data.requestedSeq +
                        ' đã có văn bản trong sổ dùng, nên bộ đếm giữ ở ' + data.next.soVanBan + '.'
                        : data.adjusted
                          ? 'Số ' + data.requestedSeq + ' đã bị chiếm — bộ đếm đặt tới ' + data.next.soVanBan + '.'
                          : 'Đã đặt lại bộ đếm. Số kế tiếp: ' + data.next.soVanBan,
                      data.clamped ? 'err' : 'ok'
                    );
                    render();
                  } catch (err) {
                    showError(err);
                  }
                },
                text: 'Xác nhận đặt lại',
              })
            )
          )
        )
        : null
    ),

    el('div', { class: 'section savebar-card' },
      el('div', { class: 'savebar flat' },
        el('span', {
          class: 'savebar-status' + (problem ? ' blocked' : dirty ? ' dirty' : ''),
          text: state.numberingSavedAt ? 'Đã lưu lúc ' + state.numberingSavedAt
            : problem ? 'Cấu trúc chưa hợp lệ — chưa thể lưu'
              : dirty ? 'Có thay đổi chưa lưu'
                : 'Cài đặt đang khớp với bản đã lưu',
        }),
        el('div', { class: 'savebar-actions' },
          el('button', {
            class: 'btn', type: 'button', disabled: !dirty,
            onclick: () => {
              state.draftNumbering = {
                segments: snap.numbering.segments.map((s) => ({ type: s.type, text: s.text || '' })),
                startRaw: String(snap.numbering.start),
                resetYearly: snap.numbering.resetYearly,
              };
              state.numberingSavedAt = '';
              render();
            },
            text: 'Hủy thay đổi',
          }),
          el('button', { class: 'btn btn-primary', type: 'button', disabled: !dirty || !!problem, onclick: save, text: 'Lưu cài đặt' })
        )
      )
    ),
  ];
}

const ROLE_ITEMS = {
  admin: [['Xem và ghi cả hai sổ', 1], ['Lấy số văn bản đi', 1], ['Cài đặt lấy số', 2], ['Thêm và khóa tài khoản', 2]],
  vanthu: [['Xem và ghi cả hai sổ', 1], ['Lấy số văn bản đi', 1], ['Cài đặt lấy số', 0], ['Thêm và khóa tài khoản', 0]],
  xem: [['Xem cả hai sổ', 1], ['Lấy số văn bản đi', 0], ['Cài đặt lấy số', 0], ['Thêm và khóa tài khoản', 0]],
};

function renderUsersPage() {
  const roleLabels = state.config.roleLabels;
  const activeAdmins = state.users.filter((u) => u.role === 'admin' && !u.locked).length;

  const rows = state.users.map((u) => {
    const lastAdmin = u.role === 'admin' && activeAdmins <= 1;
    const isMe = u.id === state.user.id;
    return el('tr', {},
      el('td', { class: 'cell-num', text: u.username }),
      el('td', {},
        el('div', { class: 'user-name', text: u.fullName + (isMe ? ' (bạn)' : '') }),
        el('div', { class: 'muted user-title', text: u.title || '—' })
      ),
      el('td', {}, el('span', { class: ROLE_CLASS[u.role], text: u.roleLabel })),
      el('td', {},
        el('span', { class: u.locked ? 'badge badge-red' : 'badge badge-blue', text: u.locked ? 'Đã khóa' : 'Hoạt động' }),
        u.mustChangePassword && !u.locked
          ? el('div', { class: 'hint status-sub', text: 'chờ đổi mật khẩu' })
          : null
      ),
      el('td', { class: 'cell-mono cell-dim', text: u.lastLoginAt ? viDateTime(u.lastLoginAt) : '— chưa đăng nhập' }),
      el('td', { class: 'cell-actions' },
        el('button', { class: 'btn-link', type: 'button', onclick: () => openUserDialog(u), text: 'Sửa' }),
        el('button', {
          class: 'btn-link', type: 'button',
          onclick: () => confirmResetPassword(u),
          text: 'Đổi mật khẩu',
        }),
        el('button', {
          class: 'btn-link', type: 'button',
          disabled: isMe || (lastAdmin && !u.locked),
          onclick: async () => {
            try {
              const data = await api('POST', '/api/users/' + u.id + '/lock', { locked: !u.locked });
              state.users = data.users;
              toast(u.locked ? 'Đã mở khóa ' + u.username + '.' : 'Đã khóa ' + u.username + ' và đóng phiên đang mở.', 'ok');
              render();
            } catch (err) {
              showError(err);
            }
          },
          text: u.locked ? 'Mở khóa' : 'Khóa',
        }),
        el('button', {
          class: 'btn-link danger', type: 'button', disabled: isMe || lastAdmin,
          onclick: () => confirmDeleteUser(u),
          text: 'Xóa',
        })
      )
    );
  });

  return [
    el('div', { class: 'row-top' },
      el('div', { class: 'stack' },
        el('div', { class: 'row' },
          el('span', { class: 'page-title', text: 'Tài khoản' }),
          el('span', { class: 'admin-chip' }, icon('lock', 12, '#cc4600'), el('span', { text: 'Chỉ quản trị viên' }))
        ),
        el('span', { class: 'muted', text: 'Người dùng không tự đăng ký. Quản trị viên tạo tài khoản, đặt vai trò và cấp mật khẩu tạm thời.' })
      ),
      el('button', { class: 'btn btn-primary push', type: 'button', onclick: () => openUserDialog(null) },
        icon('plus', 16), 'Thêm tài khoản')
    ),
    el('section', { class: 'table-wrap' },
      el('table', {},
        el('thead', {}, el('tr', {},
          el('th', { class: 'w140', text: 'Tên đăng nhập' }),
          el('th', { text: 'Họ tên · chức vụ' }),
          el('th', { class: 'w118', text: 'Vai trò' }),
          el('th', { class: 'w136', text: 'Trạng thái' }),
          el('th', { class: 'w158', text: 'Đăng nhập gần nhất' }),
          el('th', { class: 'w270' })
        )),
        el('tbody', {}, rows)
      )
    ),
    el('section', { class: 'section' },
      el('span', { class: 'label label-accent', text: 'Vai trò làm được gì' }),
      el('div', { class: 'role-cards' },
        ['admin', 'vanthu', 'xem'].map((k) =>
          el('div', { class: 'role-card' + (k === 'admin' ? ' is-admin' : '') },
            el('span', { class: ROLE_CLASS[k], text: roleLabels[k] }),
            el('ul', {}, ROLE_ITEMS[k].map(([label, lvl]) =>
              el('li', { class: lvl === 0 ? 'no' : lvl === 2 ? 'yes-admin' : '', text: lvl === 0 ? label + ' — không' : label })
            ))
          )
        )
      ),
      el('p', { class: 'muted m0' },
        'Không thể tự hạ vai trò hay tự khóa tài khoản của mình, và hệ thống luôn giữ tối thiểu một Quản trị đang hoạt động. Người đã ghi sổ thì chỉ khóa được, không xóa — để giữ dấu vết ai đã ghi văn bản.')
    ),
  ];
}

function renderYearsPage() {
  return el('section', { class: 'section' },
    el('div', { class: 'stack' },
      el('span', { class: 'label label-accent', text: 'Sổ theo năm' }),
      el('span', { class: 'muted', text: 'Văn bản các năm trước vẫn nằm trong hệ thống. Bấm “Mở sổ” để tra cứu.' })
    ),
    el('div', { class: 'table-wrap mw640' },
      el('table', {},
        el('thead', {}, el('tr', {},
          el('th', { text: 'Năm' }), el('th', { text: 'Văn bản đến' }),
          el('th', { text: 'Văn bản đi' }), el('th', {})
        )),
        el('tbody', {}, state.years.map((y) =>
          el('tr', {},
            el('td', { class: 'cell-mono', text: String(y.year) }),
            el('td', { class: 'cell-mono', text: String(y.den) }),
            el('td', { class: 'cell-mono', text: String(y.di) }),
            el('td', {}, el('button', {
              class: 'btn-link', type: 'button',
              onclick: () => {
                state.page = 'so';
                state.filters.year = String(y.year);
                refresh();
              },
              text: 'Mở sổ →',
            }))
          )
        ))
      )
    )
  );
}


/** Tên việc, lấy từ /api/config để không có bản sao thứ hai lệch đi. */
function auditLabel(action) {
  const map = (state.config && state.config.auditLabels) || {};
  return map[action] || action;
}

// Chỉ những việc đáng lọc riêng, theo thứ tự hay dùng; nhãn lấy từ máy chủ.
const AUDIT_FILTER_ACTIONS = [
  'xoa_van_ban', 'khoi_phuc_van_ban', 'cap_so', 'ghi_so',
  'sua_van_ban', 'sua_cai_dat_lay_so', 'dat_lai_bo_dem', 'dang_nhap',
];

/** Ô lọc của trang Nhật ký. */
function renderAuditFilters() {
  const f = state.auditFilters;
  return el('section', { class: 'section section-tight' },
    el('div', { class: 'filters' },
      el('label', { class: 'field grow' },
        el('span', { class: 'label', text: 'Tìm trong nhật ký' }),
        el('input', {
          class: 'input', type: 'search', fk: 'audit-q', value: f.q,
          placeholder: 'số văn bản, tên văn bản, người làm…',
          // oninput, không dùng onchange: render() dựng lại toàn bộ DOM nên
          // onchange sẽ ăn mất cú bấm đầu tiên sau khi gõ.
          oninput: (e) => {
            f.q = e.target.value;
            scheduleAuditSearch();
          },
        }),
      ),
      el('label', { class: 'field' },
        el('span', { class: 'label', text: 'Loại việc' }),
        el('select', {
          class: 'select', fk: 'audit-action',
          disabled: f.onlyDeletes,
          onchange: (e) => {
            f.action = e.target.value;
            state.auditLimit = 200;
            refresh();
          },
        },
          el('option', {
            value: '', text: 'Tất cả loại việc',
            selected: !f.onlyDeletes && f.action === '',
          }),
          AUDIT_FILTER_ACTIONS.map((a) =>
            el('option', {
              value: a, text: auditLabel(a),
              selected: (f.onlyDeletes ? 'xoa_van_ban' : f.action) === a,
            })
          )
        )
      ),
      el('label', { class: 'checkline audit-only' },
        el('input', {
          type: 'checkbox', checked: f.onlyDeletes,
          onchange: (e) => {
            f.onlyDeletes = e.target.checked;
            state.auditLimit = 200;
            refresh();
          },
        }),
        el('span', { text: 'Chỉ việc xóa văn bản' })
      )
    ),
    el('div', { class: 'filters-foot' },
      el('span', { class: 'muted' },
        'Hiện ', el('strong', { class: 'mono', text: String(state.audit.length) }),
        ' trong ' + state.auditMeta.total + ' việc'
      ),
      f.q || f.action || f.onlyDeletes
        ? el('div', { class: 'filters-actions' },
          el('button', {
            class: 'btn-link', type: 'button',
            onclick: () => {
              state.auditFilters = { q: '', action: '', onlyDeletes: false };
              state.auditLimit = 200;
              refresh();
            },
            text: 'Bỏ lọc',
          })
        )
        : null
    )
  );
}

// Gõ tới đâu tìm tới đó, nhưng chờ người dùng ngừng gõ để không gọi máy chủ
// sau mỗi ký tự.
let auditSearchTimer = null;
function scheduleAuditSearch() {
  if (auditSearchTimer) clearTimeout(auditSearchTimer);
  auditSearchTimer = setTimeout(() => {
    auditSearchTimer = null;
    state.auditLimit = 200;
    refresh();
  }, 250);
  render();
}

/** Khối văn bản đã xóa nằm dưới một dòng nhật ký, kèm nút khôi phục. */
function renderRestoreBlock(entry) {
  const r = entry.restore;
  if (!r) return null;

  if (r.state === 'gone') {
    return el('div', { class: 'restore-box is-gone' },
      el('span', { class: 'badge', text: 'Không còn dữ liệu' }),
      el('span', { class: 'hint' },
        'Văn bản này bị xóa trước khi có tính năng khôi phục — nhật ký chỉ còn dòng mô tả, không còn nội dung để dựng lại.'
      )
    );
  }

  if (r.state === 'restored') {
    return el('div', { class: 'restore-box' },
      el('span', { class: 'badge badge-blue' }, icon('check', 12), ' Đã khôi phục'),
      el('span', { class: 'hint', text: 'Văn bản đang có trong sổ.' })
    );
  }

  const d = r.doc;
  return el('div', { class: 'restore-box' },
    el('span', {
      class: 'badge ' + (d.book === 'di' ? 'badge-orange' : 'badge-blue'),
      text: d.book === 'di' ? 'Văn bản đi' : 'Văn bản đến',
    }),
    el('span', { class: 'restore-num mono', text: d.soVanBan }),
    el('div', { class: 'restore-main' },
      el('span', { class: 'restore-title', text: d.tenVanBan }),
      el('span', {
        class: 'hint',
        text: 'Ngày gửi ' + viDate(d.ngayGui) + ' · ' +
          (d.fileName ? 'đính kèm ' + d.fileName : 'không có đính kèm') +
          (d.numberFree === false
            ? ' · số ' + d.soVanBan + ' đã có chủ, khôi phục sẽ cấp số ' + (d.nextNumber || 'khác')
            : ''),
      })
    ),
    isAdmin()
      ? el('button', {
        class: 'btn btn-sm btn-secondary', type: 'button',
        onclick: () => confirmRestore(d),
      }, icon('rotate', 14), ' Khôi phục')
      : null
  );
}

function renderAuditPage() {
  const meta = state.auditMeta;
  return el('section', { class: 'audit-page' },
    el('div', { class: 'audit-head' },
      el('div', { class: 'stack' },
        el('span', { class: 'label label-accent', text: 'Nhật ký thao tác' }),
        el('span', { class: 'muted' },
          'Ai làm gì, lúc nào. Văn bản bị xóa vẫn nằm lại trong nhật ký — tìm ở đây rồi khôi phục về sổ, kèm cả file đính kèm.'
        )
      ),
      meta.restorable > 0
        ? el('div', { class: 'restorable-count' },
          el('span', { class: 'label label-accent', text: 'Còn khôi phục được' }),
          el('div', { class: 'restorable-value' },
            el('span', { class: 'mono', text: String(meta.restorable) }),
            el('span', { text: 'văn bản đã xóa' })
          )
        )
        : null
    ),
    renderAuditFilters(),
    state.audit.length === 0
      ? el('div', { class: 'empty-state', text: 'Không có việc nào khớp. Thử bỏ lọc hoặc gõ ít chữ hơn.' })
      : el('div', { class: 'section' },
        el('div', { class: 'audit-list' }, state.audit.map((a) =>
          el('div', { class: 'audit-row' },
            el('span', { class: 'audit-when', text: viDateTime(a.at) }),
            el('span', { class: 'audit-who', text: a.username }),
            el('div', { class: 'audit-what-col' },
              el('span', {
                class: 'audit-what' +
                  (a.action === 'xoa_van_ban' ? ' is-delete' : '') +
                  (a.action === 'khoi_phuc_van_ban' ? ' is-restore' : ''),
                text: auditLabel(a.action) + (a.detail ? ' · ' + a.detail : ''),
              }),
              renderRestoreBlock(a)
            )
          )
        )),
        meta.hasMore
          ? el('div', { class: 'audit-more' },
            el('button', {
              class: 'btn', type: 'button',
              onclick: () => {
                state.auditLimit += 200;
                refresh();
              },
              text: 'Xem thêm việc cũ hơn',
            }),
            el('span', { class: 'hint', text: 'Nhật ký lưu toàn bộ; màn hình này nạp dần từng đợt 200 dòng.' })
          )
          : null
      )
  );
}

// ---------------------------------------------------------------- hộp thoại

function closeDialog() {
  state.dialog = null;
  renderDialogs();
}

// ------------------------------------------------------------ xem đính kèm

function openFileViewer(doc) {
  state.dialog = { kind: 'file', doc };
  renderDialogs();
}

const PDFJS_DIR = '/vendor/pdfjs/';
let pdfLibPromise = null;
let pdfLibVersion = '';
// Hàm dọn của khung xem PDF đang mở (nếu có). renderDialogs gọi trước khi xóa DOM.
let viewerCleanup = null;

/**
 * Nạp pdf.js — chỉ lần đầu có người mở một tệp PDF.
 *
 * 2,6 MB nên KHÔNG nhúng bằng thẻ <script> ở index.html: người chỉ tra sổ sẽ
 * phải tải một thứ không bao giờ dùng. import() động tải lúc cần, rồi trình
 * duyệt nhớ đệm cho những lần sau.
 */
function loadPdfLib() {
  if (!pdfLibPromise) {
    pdfLibPromise = import(PDFJS_DIR + 'pdf.min.mjs').then((lib) => {
      // Worker phải là đường dẫn cùng origin: CSP là worker-src 'self'.
      lib.GlobalWorkerOptions.workerSrc = PDFJS_DIR + 'pdf.worker.min.mjs';
      pdfLibVersion = lib.version || '';
      return lib;
    });
    // Tải lỗi (mất mạng giữa đường) thì cho phép thử lại lần sau, đừng nhớ
    // mãi một promise đã fail.
    pdfLibPromise.catch(() => { pdfLibPromise = null; });
  }
  return pdfLibPromise;
}

/**
 * Trình xem PDF tự vẽ.
 *
 * VÌ SAO KHÔNG dùng <iframe> để trình duyệt tự dựng: Edge và Chrome có tùy chọn
 * “Always download PDF files”, và máy do IT quản lý còn bị áp chính sách
 * AlwaysOpenPdfExternally. Khi đó trình duyệt TẢI PDF VỀ thay vì dựng trong
 * trang, kể cả khi máy chủ đã trả Content-Disposition: inline — người dùng thấy
 * tệp rơi xuống thanh tải và một khung trắng. Đã gặp đúng lỗi đó trên máy thật
 * (Edge 152). Tự vẽ từng trang lên canvas thì không còn phụ thuộc cài đặt của
 * từng máy, và cũng chạy được trong mạng nội bộ không có Internet.
 *
 * Vẽ theo kiểu cuộn liên tục, mỗi trang một canvas, và CHỈ vẽ trang đang lọt
 * vào khung nhìn: sổ văn bản có những bản scan vài chục trang, vẽ hết ngay từ
 * đầu thì treo máy.
 */
function pdfViewer(doc) {
  const pages = el('div', { class: 'pdf-pages' });
  // Tệp Office chưa có bản chuyển thì lần xem đầu phải chờ LibreOffice chạy
  // (khoảng mươi giây). Nói trước, đừng để người dùng ngồi trước chữ chung chung.
  const status = el('div', {
    class: 'pdf-status',
    text: doc.fileNeedsConvert
      ? 'Đang chuyển tệp sang PDF để xem. Lần đầu mỗi tệp mất khoảng mươi giây…'
      : 'Đang mở tệp…',
  });
  const box = el('div', { class: 'pdf-box' }, status, pages);

  const zoomLabel = el('span', { class: 'pdf-zoom', text: '—' });
  const pageLabel = el('span', { class: 'muted', text: '' });
  let zoom = 1;
  let pdf = null;
  let observer = null;
  // Mỗi lần đổi mức phóng là một "lượt vẽ" mới; canvas của lượt cũ vẽ xong thì
  // bỏ đi, nếu không trang sẽ nhoè do lẫn hai tỷ lệ.
  let round = 0;

  const zoomOut = el('button', { class: 'btn btn-sm', type: 'button', text: '−', title: 'Thu nhỏ' });
  const zoomIn = el('button', { class: 'btn btn-sm', type: 'button', text: '+', title: 'Phóng to' });
  const zoomFit = el('button', { class: 'btn btn-sm', type: 'button', text: 'Vừa khung', title: 'Vừa bề rộng khung' });
  const bar = el('div', { class: 'pdf-bar' }, pageLabel, el('span', { class: 'push' }), zoomOut, zoomLabel, zoomIn, zoomFit);

  function setZoom(z) {
    zoom = Math.min(Math.max(z, 0.25), 4);
    zoomLabel.textContent = Math.round(zoom * 100) + '%';
    if (pdf) layout();
  }
  zoomOut.addEventListener('click', () => setZoom(zoom - 0.25));
  zoomIn.addEventListener('click', () => setZoom(zoom + 0.25));
  zoomFit.addEventListener('click', () => setZoom(1));

  /** Bề rộng dành cho một trang, trừ padding hai bên. */
  function availWidth() {
    return Math.max((box.clientWidth || 800) - 32, 200);
  }

  /**
   * Dựng sẵn một canvas trắng đúng tỷ lệ cho từng trang, rồi để
   * IntersectionObserver vẽ trang nào người dùng cuộn tới.
   *
   * Cỡ trang đặt bằng THUỘC TÍNH width/height của canvas, không bằng style=:
   * CSP của máy chủ là style-src 'self' nên không dùng inline style được. CSS
   * cho canvas là width:100%; height:auto, nên số điểm ảnh trong thuộc tính có
   * thể lớn hơn cỡ hiển thị — đó chính là cách ăn được màn hình HiDPI mà không
   * cần tính bằng style.
   */
  function layout() {
    round += 1;
    const myRound = round;
    if (observer) observer.disconnect();
    pages.textContent = '';

    // Vẽ đúng số điểm ảnh thật của màn hình, nếu không chữ trên bản scan sẽ rỗ.
    // Chặn ở 2 để một trang A4 phóng 400% không sinh canvas quá lớn.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = availWidth() * zoom;
    const items = [];

    // Cỡ thật từng trang phải hỏi pdf.js, và bản scan thì mỗi trang một cỡ là
    // chuyện thường. Hỏi xong cả tập rồi mới gắn vào DOM, để thanh cuộn không
    // nhảy giật lúc đang đọc.
    const asked = [];
    for (let n = 1; n <= pdf.numPages; n += 1) {
      asked.push(pdf.getPage(n).then((page) => {
        if (myRound !== round) return null;
        const base = page.getViewport({ scale: 1 });
        const scale = (width / base.width) * dpr;
        const view = page.getViewport({ scale });
        const canvas = el('canvas', {
          class: 'pdf-canvas',
          width: String(Math.round(view.width)),
          height: String(Math.round(view.height)),
        });
        return { page, view, canvas, slot: el('div', { class: 'pdf-page' }, canvas) };
      }));
    }

    Promise.all(asked).then((got) => {
      if (myRound !== round) return;
      const byEl = new Map();
      for (const it of got) {
        if (!it) continue;
        pages.append(it.slot);
        byEl.set(it.slot, it);
        items.push(it);
      }
      if (!items.length) return;

      // Hai trang đầu vẽ NGAY, không chờ IntersectionObserver.
      //
      // Phần lớn văn bản trong sổ chỉ một hai trang, nên gần như luôn là vẽ hết.
      // Quan trọng hơn: nếu vì lý do gì mà observer không kích hoạt (khung bị
      // tính ra chiều cao 0, trình duyệt lạ, hay người dùng không cuộn), thì vẫn
      // còn trang để đọc thay vì một khung trắng — chính là kiểu lỗi khó đoán mà
      // người dùng chỉ biết báo là “không xem được”.
      for (const it of items.slice(0, 2)) {
        it.drawn = true;
        draw(it, myRound);
      }

      if (items.length > 2 && typeof IntersectionObserver === 'function') {
        observer = new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            const it = byEl.get(e.target);
            if (!it || it.drawn) continue;
            it.drawn = true;
            draw(it, myRound);
          }
          // Vẽ trước cả một quãng dài trên/dưới khung nhìn, để cuộn bình thường là
          // trang đã có sẵn, không phải chờ.
        }, { root: box, rootMargin: '1200px 0px' });
        items.slice(2).forEach((it) => observer.observe(it.slot));
      } else if (items.length > 2) {
        // Không có IntersectionObserver: vẽ hết, chậm nhưng đọc được.
        for (const it of items.slice(2)) {
          it.drawn = true;
          draw(it, myRound);
        }
      }
    }).catch(fail);
  }

  function draw(it, myRound) {
    const ctx = it.canvas.getContext('2d');
    it.page.render({ canvasContext: ctx, viewport: it.view }).promise.then(() => {
      if (myRound !== round) return;
      it.slot.classList.add('drawn');
    }).catch(() => {
      if (myRound !== round) return;
      it.slot.classList.add('failed');
    });
  }

  /**
   * Báo lỗi kèm ĐỦ chi tiết để lần sau không phải hỏi lại người dùng.
   *
   * Tên lớp lỗi của pdf.js nói thẳng ra vấn đề: InvalidPDFException là tệp hỏng,
   * UnexpectedResponseException là máy chủ trả sai, PasswordException là tệp có
   * mật khẩu, còn “Setting up fake worker failed” là worker không chạy được. Chỉ
   * hiện một câu chung chung thì người dùng và người sửa đều mù.
   */
  function fail(err) {
    const ten = (err && (err.name || err.constructor && err.constructor.name)) || 'Lỗi';
    const loi = (err && err.message) ? err.message : String(err || 'không rõ');
    let goi = 'Vẫn tải được về máy bằng nút “Tải xuống” bên dưới.';
    if (ten === 'BiChan') goi = 'Nếu có tiện ích chặn quảng cáo, hãy tắt nó cho riêng trang này rồi tải lại.';
    else if (/password/i.test(ten + loi)) goi = 'Tệp này có mật khẩu bảo vệ nên không mở được trong trang.';
    else if (/InvalidPDF|corrupt/i.test(ten + loi)) goi = 'Tệp PDF này hỏng hoặc không đúng chuẩn. Thử tải về mở bằng phần mềm trên máy.';
    else if (/worker/i.test(loi)) goi = 'Trình duyệt không chạy được bộ giải mã PDF. Hãy báo lại nguyên văn dòng lỗi này.';

    status.textContent = '';
    status.append(
      el('div', { class: 'pdf-fail' },
        el('strong', { text: 'Không mở được tệp PDF này trong trang.' }),
        el('code', { class: 'pdf-err', text: ten + ': ' + loi }),
        el('span', { class: 'muted', text: goi }),
        el('span', { class: 'muted', text: 'pdf.js ' + (pdfLibVersion || '?') })
      )
    );
    status.classList.add('shown');
  }

  /**
   * Tự tải byte của tệp rồi đưa cho pdf.js, thay vì để pdf.js tự gọi URL.
   *
   * VÌ SAO: tiện ích chặn quảng cáo trong trình duyệt chặn thẳng request mà
   * pdf.js tự phát (net::ERR_BLOCKED_BY_CLIENT) — đã gặp trên Edge của người
   * dùng thật. Bộ lọc bắt vào dạng URL có đuôi “.pdf” trong đường dẫn kèm tham
   * số truy vấn. Ở đây dùng ĐÚNG endpoint trơn /api/documents/:id/file mà cả
   * ứng dụng vẫn gọi bình thường: không tên tệp trong đường dẫn, không ?xem=1,
   * nên không còn khớp bộ lọc nào.
   *
   * Content-Disposition: attachment của endpoint đó KHÔNG gây tải xuống: fetch()
   * bỏ qua header này hoàn toàn, chỉ điều hướng hay iframe mới đọc tới nó.
   */
  function tepBytes() {
    return fetch(xemPdfUrl(doc.id), { credentials: 'same-origin' }).then((res) => {
      if (!res.ok) {
        // Máy chủ đã có thông báo tiếng Việt cho trường hợp không chuyển được.
        return res.json().catch(() => null).then((data) => {
          const e = new Error((data && data.error) || 'Máy chủ trả về HTTP ' + res.status);
          e.name = 'LoiMayChu';
          throw e;
        });
      }
      return res.arrayBuffer();
    }, () => {
      // fetch() chỉ reject khi request không đi được: mất mạng, hoặc bị tiện
      // ích trong trình duyệt chặn. Nói rõ cả hai khả năng.
      const e = new Error(
        'Không tải được tệp về để dựng. Thường là do một tiện ích mở rộng ' +
        '(chặn quảng cáo, bảo mật) trong trình duyệt đã chặn, hoặc mất kết nối.'
      );
      e.name = 'BiChan';
      throw e;
    });
  }

  Promise.all([loadPdfLib(), tepBytes()]).then(([lib, buf]) => lib.getDocument({
    data: new Uint8Array(buf),
    standardFontDataUrl: PDFJS_DIR + 'standard_fonts/',
  }).promise).then((loaded) => {
    pdf = loaded;
    status.remove();
    pageLabel.textContent = pdf.numPages + ' trang';
    setZoom(1);
  }).catch(fail);

  // Đổi bề rộng cửa sổ (hoặc xoay điện thoại) thì tỷ lệ “vừa khung” khác đi.
  let resizeTimer = null;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (pdf) layout(); }, 200);
  };
  window.addEventListener('resize', onResize);

  // Đóng hộp thoại phải tháo listener và giải phóng worker của pdf.js, không thì
  // mở/đóng vài tệp là còn đó vài worker cùng cả tập canvas. renderDialogs gọi
  // hàm này trước khi xóa DOM.
  viewerCleanup = () => {
    clearTimeout(resizeTimer);
    window.removeEventListener('resize', onResize);
    if (observer) observer.disconnect();
    if (pdf) pdf.destroy();
    pdf = null;
  };

  return el('div', { class: 'pdf-wrap' }, bar, box);
}

/**
 * Khung xem đính kèm.
 *
 * PDF do chính ứng dụng vẽ (xem pdfViewer). Ảnh dựng bằng <img>. .txt dùng
 * <iframe> — trình duyệt không có tùy chọn nào bắt tải text/plain về, nên ở đây
 * iframe vẫn đáng tin.
 */
function renderFileDialog(d) {
  const doc = d.doc;
  const name = doc.fileName || '';
  const src = fileUrl(doc.id, true, doc.fileName);
  const isImage = /\.(jpe?g|png)$/i.test(name);

  const body = doc.fileAsPdf
    ? pdfViewer(doc)
    : el('div', { class: 'viewer full' },
      isImage
        ? el('img', { class: 'viewer-img', src, alt: 'Đính kèm của ' + doc.soVanBan })
        : el('iframe', {
          class: 'viewer-frame',
          src,
          title: 'Đính kèm của ' + doc.soVanBan,
          referrerpolicy: 'no-referrer',
        })
    );

  // Tệp Office: cả khung xem và “Mở tab mới” đều dùng bản PDF đã chuyển, chứ
  // mở tệp .docx gốc trong tab mới thì trình duyệt chỉ tải nó về.
  const laChuyenDoi = doc.fileAsPdf && !/\.pdf$/i.test(name);
  const srcXem = doc.fileAsPdf ? xemPdfUrl(doc.id) : src;

  return dialogShell(
    'Đính kèm · ' + doc.soVanBan,
    doc.fileName,
    body,
    el('span', { class: 'muted' },
      doc.tenVanBan,
      laChuyenDoi
        ? el('span', { class: 'hint', text: ' · đang xem bản PDF chuyển từ tệp gốc; tải xuống vẫn là tệp gốc' })
        : null
    ),
    [
      el('a', { class: 'btn', href: srcXem, target: '_blank', rel: 'noopener', text: 'Mở tab mới' }),
      el('a', { class: 'btn', href: fileUrl(doc.id), text: 'Tải xuống' }),
      el('button', { class: 'btn btn-primary', type: 'button', onclick: closeDialog, text: 'Đóng' }),
    ],
    false,
    'dialog-wide'
  );
}

function dialogShell(eyebrow, title, body, footLeft, footRight, narrow, extraClass) {
  const overlay = el('div', {
    class: 'overlay',
    onclick: (e) => {
      if (e.target === overlay) closeDialog();
    },
  },
    el('div', { class: 'dialog' + (narrow ? ' dialog-narrow' : '') + (extraClass ? ' ' + extraClass : '') },
      el('div', { class: 'dialog-head' },
        el('div', { class: 'label label-accent', text: eyebrow }),
        el('div', { class: 'dialog-title', text: title })
      ),
      el('div', { class: 'dialog-body' }, body),
      el('div', { class: 'dialog-foot' }, footLeft || el('span'), el('div', { class: 'savebar-actions' }, footRight))
    )
  );
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') {
      closeDialog();
      document.removeEventListener('keydown', esc);
    }
  });
  return overlay;
}

function openDocDialog({ book, mode, doc }) {
  const isIssue = mode === 'issue';
  const isEdit = mode === 'edit';
  state.dialog = {
    kind: 'doc',
    book: isEdit ? doc.book : book,
    mode,
    error: '',
    file: null,
    dropFile: false,
    expected: isIssue && state.nextNumber ? state.nextNumber.soVanBan : '',
    form: {
      soVanBan: isEdit ? doc.soVanBan : '',
      ngayGui: isEdit ? doc.ngayGui : todayIso(),
      nguoiGui: isEdit ? doc.nguoiGui : '',
      tenVanBan: isEdit ? doc.tenVanBan : '',
      doBaoMat: isEdit ? doc.doBaoMat : 'Thường',
      ghiChu: isEdit ? doc.ghiChu : '',
    },
    doc: doc || null,
  };
  renderDialogs();
}

// Đuôi tệp máy chủ nhận (server/routes/docs.js giữ danh sách gốc). Đưa vào
// accept để hộp chọn tệp lọc sẵn, đỡ chọn xong mới bị máy chủ từ chối.
const ACCEPT_EXT =
  '.pdf,.doc,.docx,.xls,.xlsx,.odt,.ods,.jpg,.jpeg,.png,.tif,.tiff,.txt';

/**
 * Ô chọn tệp đính kèm.
 *
 * Không dùng nút mặc định của trình duyệt: chữ của nó là tiếng Anh
 * (“Choose File / No file chosen”) và không dịch được. Quan trọng hơn: dựng
 * lại hộp thoại sẽ thay ô input bằng ô mới — ô mới luôn hiện “No file chosen”
 * dù tệp đã được chọn, nên văn thư tưởng là đính kèm không ăn. Vì vậy ô này tự
 * vẽ lại phần chữ ngay trong DOM (paint) chứ không gọi renderDialogs().
 */
function fileField(d) {
  const input = el('input', {
    type: 'file',
    class: 'file-native',
    accept: ACCEPT_EXT,
    onchange: (e) => {
      d.file = e.target.files && e.target.files[0] ? e.target.files[0] : null;
      if (d.file) d.dropFile = false;
      paint();
    },
  });

  const pick = el('button', { class: 'btn btn-pick', type: 'button', onclick: () => input.click() });
  const status = el('span', { class: 'file-status' });
  const maxMb = Math.round(state.config.maxFileBytes / (1024 * 1024));
  const hasOld = !!(d.doc && d.doc.hasFile);

  function paint() {
    status.textContent = '';
    status.className = 'file-status';

    if (d.file) {
      pick.textContent = 'Chọn tệp khác…';
      status.classList.add('ok');
      status.append(
        el('span', { class: 'file-name' }, icon('check', 14), el('strong', { text: d.file.name })),
        el('span', { class: 'hint', text: ' · ' + fileSize(d.file.size) + ' · sẽ tải lên khi lưu' }),
        el('button', {
          class: 'btn-link', type: 'button',
          text: hasOld ? 'Hủy, giữ tệp cũ' : 'Bỏ chọn',
          onclick: () => {
            d.file = null;
            // Xóa cả FileList của ô input, nếu không chọn lại đúng tệp vừa bỏ
            // sẽ không sinh sự kiện change.
            input.value = '';
            paint();
          },
        })
      );
      return;
    }

    if (hasOld && !d.dropFile) {
      pick.textContent = 'Chọn tệp khác…';
      status.append(
        el('span', { class: 'muted', text: 'Đang có: ' }),
        el('a', { href: fileUrl(d.doc.id), text: d.doc.fileName }),
        d.doc.fileSize ? el('span', { class: 'hint', text: ' · ' + fileSize(d.doc.fileSize) }) : null,
        // Xem ngay để đối chiếu trước khi thay bằng tệp khác. Mở tab mới chứ
        // không mở khung xem: khung xem là một hộp thoại, mở lên sẽ đè mất
        // hộp thoại sửa cùng mọi thứ đang gõ dở.
        d.doc.fileViewable
          ? el('a', { class: 'btn-link', href: fileUrl(d.doc.id, true, d.doc.fileName), target: '_blank', rel: 'noopener', text: 'Xem' })
          : null,
        el('button', {
          class: 'btn-link danger', type: 'button', text: 'Bỏ tệp này',
          onclick: () => { d.dropFile = true; paint(); },
        })
      );
      return;
    }

    pick.textContent = 'Chọn tệp…';
    if (d.dropFile) {
      status.classList.add('warn');
      status.append(
        el('span', { text: 'Sẽ bỏ tệp đính kèm khi lưu' }),
        el('button', {
          class: 'btn-link', type: 'button', text: 'Giữ lại',
          onclick: () => { d.dropFile = false; paint(); },
        })
      );
      return;
    }
    status.append(el('span', {
      class: 'muted',
      text: 'Chưa chọn tệp · PDF, DOC, DOCX, XLS, ảnh scan · tối đa ' + maxMb + ' MB',
    }));
  }

  paint();
  return el('div', { class: 'file-drop' }, input, pick, status);
}

function renderDocDialog(d) {
  const f = d.form;
  const book = d.book;
  // Số do hệ thống cấp thì không cho sửa: sửa số đã phát hành là sai nghiệp vụ.
  const numberLocked = d.mode === 'edit' && d.doc && d.doc.seq !== null;

  const field = (label, key, attrs) =>
    el('label', { class: 'field' + (attrs && attrs.full ? ' full' : '') },
      el('span', { class: 'label', text: label }),
      el('input', Object.assign({
        class: 'input' + (attrs && attrs.mono ? ' mono' : ''),
        type: (attrs && attrs.type) || 'text',
        fk: 'doc-' + key,
        value: f[key] || '',
        placeholder: (attrs && attrs.placeholder) || '',
        oninput: (e) => { f[key] = e.target.value; },
      }, attrs && attrs.type === 'date' ? { onchange: (e) => { f[key] = e.target.value; } } : {})),
      attrs && attrs.hint ? el('span', { class: 'hint', text: attrs.hint }) : null
    );

  const submit = async () => {
    const fd = new FormData();
    fd.set('book', book);
    if (d.mode === 'issue') fd.set('mode', 'issue');
    if (d.expected) fd.set('expectedSoVanBan', d.expected);
    if (d.mode !== 'issue' && !numberLocked) fd.set('soVanBan', f.soVanBan);
    fd.set('ngayGui', f.ngayGui);
    fd.set('nguoiGui', f.nguoiGui);
    fd.set('tenVanBan', f.tenVanBan);
    fd.set('doBaoMat', f.doBaoMat);
    fd.set('ghiChu', f.ghiChu);
    if (d.dropFile) fd.set('dropFile', '1');
    if (d.file) fd.set('file', d.file);

    try {
      const res = d.mode === 'edit'
        ? await api('PUT', '/api/documents/' + d.doc.id, fd, true)
        : await api('POST', '/api/documents', fd, true);
      closeDialog();
      state.book = book;
      if (res.numberChange) {
        // Số lệch so với dự kiến: bắt người dùng xác nhận bằng hộp thoại, đừng
        // dùng toast — toast tự tắt và văn thư có thể đã ghi số cũ lên bản giấy.
        showNumberChanged(res.numberChange);
      } else if (res.issued) {
        toast('Đã cấp số ' + res.document.soVanBan + ' và ghi vào sổ.', 'ok');
      } else {
        toast(d.mode === 'edit' ? 'Đã lưu thay đổi.' : 'Đã ghi vào sổ.', 'ok');
      }
      refresh();
    } catch (err) {
      if (err.status === 401) return;
      d.error = err.message;
      renderDialogs();
    }
  };

  const body = [
    d.mode === 'issue'
      ? el('div', { class: 'issued' },
        el('span', { class: 'label label-on-tint', text: 'Số dự kiến' }),
        el('span', { class: 'issued-value', text: d.expected || '—' }),
        el('span', { class: 'muted push', text: 'Số được chốt lúc bạn lưu. Nếu người khác vừa lấy số đó, bạn sẽ nhận số kế tiếp.' })
      )
      : null,
    numberLocked
      ? el('div', { class: 'field' },
        el('span', { class: 'label', text: 'Số văn bản' }),
        el('input', { class: 'input mono', type: 'text', value: f.soVanBan, disabled: true }),
        el('span', { class: 'hint', text: 'Số do hệ thống cấp — không sửa được' })
      )
      : d.mode === 'issue'
        ? null
        : field('Số văn bản', 'soVanBan', {
          mono: true,
          placeholder: book === 'den' ? 'VD: 2145/UBND-VP' : 'VD: 142/CV-SNV',
          hint: book === 'di' ? 'Số 0 ở đầu sẽ được bỏ khi lưu' : 'Giữ nguyên số của cơ quan gửi',
        }),
    field('Ngày gửi', 'ngayGui', { type: 'date' }),
    field(book === 'di' ? 'Người gửi (người ký / trình)' : 'Người gửi (nơi gửi đến)', 'nguoiGui', {
      placeholder: 'Đơn vị hoặc cá nhân',
    }),
    el('label', { class: 'field' },
      el('span', { class: 'label', text: 'Độ bảo mật' }),
      el('select', { class: 'select', onchange: (e) => { f.doBaoMat = e.target.value; } },
        state.config.securityLevels.map((s) => el('option', { value: s, text: s, selected: f.doBaoMat === s }))
      )
    ),
    field('Tên văn bản', 'tenVanBan', { full: true, placeholder: 'Trích yếu nội dung văn bản' }),
    el('label', { class: 'field full' },
      el('span', { class: 'label', text: 'Ghi chú' }),
      el('textarea', {
        class: 'textarea', rows: '3', placeholder: 'Nơi nhận, hạn xử lý, ghi chú nội bộ…',
        fk: 'doc-ghiChu',
        oninput: (e) => { f.ghiChu = e.target.value; },
      }, f.ghiChu || '')
    ),
    el('div', { class: 'field full' },
      el('span', { class: 'label', text: 'File đính kèm' }),
      fileField(d)
    ),
  ];

  const eyebrow = d.mode === 'issue' ? 'Lấy số văn bản đi' : book === 'den' ? 'Sổ văn bản đến' : 'Sổ văn bản đi';
  const title = d.mode === 'edit' ? 'Sửa thông tin văn bản'
    : d.mode === 'issue' ? 'Cấp số cho văn bản gửi đi' : 'Ghi văn bản vào sổ';

  return dialogShell(eyebrow, title, body,
    el('span', { class: 'dialog-error', text: d.error }),
    [
      el('button', { class: 'btn', type: 'button', onclick: closeDialog, text: 'Hủy' }),
      el('button', {
        class: 'btn btn-primary', type: 'button', onclick: submit,
        text: d.mode === 'issue' ? 'Cấp số & lưu vào sổ' : 'Lưu',
      }),
    ]
  );
}

function openUserDialog(user) {
  state.dialog = {
    kind: 'user',
    error: '',
    editing: user || null,
    form: {
      username: user ? user.username : '',
      fullName: user ? user.fullName : '',
      title: user ? user.title : '',
      email: user ? user.email : '',
      role: user ? user.role : 'vanthu',
      password: '',
      mustChangePassword: true,
    },
  };
  renderDialogs();
  if (!user) {
    api('GET', '/api/users/suggest-password')
      .then((data) => {
        if (state.dialog && state.dialog.kind === 'user' && !state.dialog.editing) {
          state.dialog.form.password = data.password;
          renderDialogs();
        }
      })
      .catch(() => { });
  }
}

function renderUserDialog(d) {
  const f = d.form;
  const editing = !!d.editing;
  const roleLabels = state.config.roleLabels;
  const roleHints = {
    admin: 'Toàn quyền, gồm Cài đặt lấy số',
    vanthu: 'Ghi sổ và lấy số văn bản đi',
    xem: 'Chỉ tra cứu, không sửa sổ',
  };

  const submit = async () => {
    try {
      const data = editing
        ? await api('PUT', '/api/users/' + d.editing.id, {
          fullName: f.fullName, title: f.title, email: f.email, role: f.role,
        })
        : await api('POST', '/api/users', {
          username: f.username, fullName: f.fullName, title: f.title, email: f.email,
          role: f.role, password: f.password, mustChangePassword: f.mustChangePassword,
        });
      state.users = data.users;
      const created = !editing ? f.password : null;
      closeDialog();
      if (created) {
        showTempPassword(f.username, created, 'Đã tạo tài khoản');
      } else {
        toast('Đã lưu tài khoản ' + d.editing.username + '.', 'ok');
      }
      render();
    } catch (err) {
      if (err.status === 401) return;
      d.error = err.message;
      renderDialogs();
    }
  };

  const body = [
    editing
      ? el('div', { class: 'field' },
        el('span', { class: 'label', text: 'Tên đăng nhập' }),
        el('input', { class: 'input mono', type: 'text', value: f.username, disabled: true }),
        el('span', { class: 'hint', text: 'Không đổi được tên đăng nhập' })
      )
      : el('label', { class: 'field' },
        el('span', { class: 'label', text: 'Tên đăng nhập' }),
        el('input', {
          class: 'input mono', type: 'text', value: f.username, placeholder: 'vd: hant',
          oninput: (e) => { f.username = e.target.value; },
        }),
        el('span', { class: 'hint', text: 'Chữ thường, số, dấu . _ - · từ 3 ký tự' })
      ),
    el('label', { class: 'field' },
      el('span', { class: 'label', text: 'Họ và tên' }),
      el('input', {
        class: 'input', type: 'text', value: f.fullName, placeholder: 'Nguyễn Thị Hà',
        oninput: (e) => { f.fullName = e.target.value; },
      })
    ),
    el('label', { class: 'field' },
      el('span', { class: 'label', text: 'Chức vụ · đơn vị' }),
      el('input', {
        class: 'input', type: 'text', value: f.title, placeholder: 'Văn thư — Phòng Hành chính',
        oninput: (e) => { f.title = e.target.value; },
      })
    ),
    el('label', { class: 'field' },
      el('span', { class: 'label', text: 'Email cơ quan' }),
      el('input', {
        class: 'input', type: 'text', value: f.email, placeholder: 'ha.nt@donvi.gov.vn',
        oninput: (e) => { f.email = e.target.value; },
      })
    ),
    el('div', { class: 'field full' },
      el('span', { class: 'label', text: 'Vai trò' }),
      el('div', { class: 'role-picker' },
        ['admin', 'vanthu', 'xem'].map((k) =>
          el('button', {
            class: 'role-option' + (f.role === k ? ' active' : ''), type: 'button',
            onclick: () => { f.role = k; renderDialogs(); },
          },
            el('strong', { text: roleLabels[k] }),
            el('em', { text: roleHints[k] })
          )
        )
      ),
      editing && d.editing.id === state.user.id
        ? el('span', { class: 'hint', text: 'Không thể tự đổi vai trò của chính mình.' })
        : null
    ),
    !editing
      ? el('div', { class: 'field full' },
        el('span', { class: 'label', text: 'Mật khẩu tạm thời' }),
        el('div', { class: 'row' },
          el('input', {
            class: 'input mono grow-240', type: 'text', value: f.password, placeholder: 'Ít nhất 8 ký tự',
            oninput: (e) => { f.password = e.target.value; },
          }),
          el('button', {
            class: 'btn btn-secondary', type: 'button',
            onclick: async () => {
              try {
                const data = await api('GET', '/api/users/suggest-password');
                f.password = data.password;
                renderDialogs();
              } catch (err) {
                showError(err);
              }
            },
            text: 'Tạo tự động',
          })
        )
      )
      : null,
    !editing
      ? el('label', { class: 'checkline full' },
        el('input', {
          type: 'checkbox', checked: f.mustChangePassword,
          onchange: (e) => { f.mustChangePassword = e.target.checked; },
        }),
        el('span', { text: 'Bắt buộc đổi mật khẩu ở lần đăng nhập đầu tiên' })
      )
      : null,
  ];

  return dialogShell('Quản trị · Tài khoản', editing ? 'Sửa tài khoản' : 'Thêm tài khoản mới', body,
    el('span', { class: 'dialog-error', text: d.error }),
    [
      el('button', { class: 'btn', type: 'button', onclick: closeDialog, text: 'Hủy' }),
      el('button', { class: 'btn btn-primary', type: 'button', onclick: submit, text: editing ? 'Lưu' : 'Tạo tài khoản' }),
    ],
    true
  );
}

function showTempPassword(username, password, heading) {
  state.dialog = { kind: 'temp-password', username, password, heading };
  renderDialogs();
}

function renderTempPasswordDialog(d) {
  return dialogShell('Quản trị · Tài khoản', d.heading + ' ' + d.username,
    [
      el('div', { class: 'full stack' },
        el('span', { class: 'label', text: 'Mật khẩu tạm thời' }),
        el('div', { class: 'temp-password', text: d.password }),
        el('span', { class: 'muted', text: 'Chuyển mật khẩu này cho người dùng. Nó chỉ hiện một lần — hệ thống không lưu bản đọc được. Người dùng sẽ phải đổi mật khẩu ở lần đăng nhập đầu tiên.' })
      ),
    ],
    null,
    [
      el('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(d.password);
            toast('Đã copy mật khẩu.', 'ok');
          } catch {
            toast('Trình duyệt không cho copy tự động — chọn và copy tay.', 'err');
          }
        },
        text: 'Copy',
      }),
      el('button', { class: 'btn btn-primary', type: 'button', onclick: closeDialog, text: 'Đã ghi lại' }),
    ],
    true
  );
}

/**
 * Báo cho người dùng khi số được cấp lệch với số dự kiến lúc mở hộp thoại.
 * Đây là hộp thoại chứ không phải toast: văn bản đã vào sổ với số mới, và nếu
 * số dự kiến đã được ghi hoặc in lên bản giấy thì phải sửa lại.
 */
function showNumberChanged(change) {
  state.dialog = { kind: 'number-changed', change };
  renderDialogs();
}

function renderNumberChangedDialog(d) {
  const c = d.change;
  const why =
    c.reason === 'year'
      ? 'Văn bản này ghi cho năm ' + c.year + ', nên hệ thống cấp số theo sổ năm ' +
      c.year + ' chứ không theo số dự kiến của năm hiện tại.'
      : 'Trong lúc bạn nhập, số ' + c.expected +
      ' đã bị lấy mất — hệ thống chuyển sang số trống kế tiếp để không cấp trùng.';

  return dialogShell('Sổ văn bản đi', 'Số thứ tự khác với dự kiến',
    [
      el('div', { class: 'full num-change' },
        el('div', { class: 'num-change-cell' },
          el('span', { class: 'label', text: 'Số dự kiến' }),
          el('span', { class: 'num-change-old', text: c.expected })
        ),
        el('span', { class: 'num-change-arrow' }, icon('right', 20)),
        el('div', { class: 'num-change-cell' },
          el('span', { class: 'label', text: 'Số đã cấp' }),
          el('span', { class: 'num-change-new', text: c.actual })
        )
      ),
      el('p', { class: 'full confirm-text', text: why }),
      el('div', { class: 'full note' }, icon('warn', 16),
        el('span', {
          text: 'Văn bản đã vào sổ với số ' + c.actual +
            '. Nếu bạn đã ghi hoặc in số ' + c.expected +
            ' lên bản giấy, hãy sửa lại thành ' + c.actual + '.',
        })
      ),
    ],
    null,
    [
      el('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(c.actual);
            toast('Đã copy số ' + c.actual + '.', 'ok');
          } catch {
            toast('Trình duyệt không cho copy tự động — chọn và copy tay.', 'err');
          }
        },
        text: 'Copy số mới',
      }),
      el('button', { class: 'btn btn-primary', type: 'button', onclick: closeDialog, text: 'Đã hiểu' }),
    ],
    true
  );
}

function confirmDialog({ eyebrow, title, message, confirmLabel, danger, onConfirm }) {
  state.dialog = { kind: 'confirm', eyebrow, title, message, confirmLabel, danger, onConfirm, error: '' };
  renderDialogs();
}

function renderConfirmDialog(d) {
  return dialogShell(d.eyebrow, d.title,
    [el('p', { class: 'full confirm-text', text: d.message })],
    el('span', { class: 'dialog-error', text: d.error }),
    [
      el('button', { class: 'btn', type: 'button', onclick: closeDialog, text: 'Hủy' }),
      el('button', {
        class: 'btn ' + (d.danger ? 'btn-solid-danger' : 'btn-primary'), type: 'button',
        onclick: async () => {
          try {
            await d.onConfirm();
          } catch (err) {
            if (err.status === 401) return;
            d.error = err.message;
            renderDialogs();
          }
        },
        text: d.confirmLabel,
      }),
    ],
    true
  );
}

function confirmDelete(doc) {
  confirmDialog({
    eyebrow: doc.book === 'den' ? 'Sổ văn bản đến' : 'Sổ văn bản đi',
    title: 'Xóa văn bản khỏi sổ?',
    message:
      'Xóa “' + doc.soVanBan + ' — ' + doc.tenVanBan + '” khỏi sổ. ' +
      (doc.seq !== null
        ? 'Số ' + doc.soVanBan + ' được trả lại cho sổ — người lấy số tiếp theo có thể nhận đúng số này. ' +
        'Nếu sau đó khôi phục văn bản mà số đã có chủ, hệ thống sẽ cấp cho nó một số khác. '
        : '') +
      'Quản trị viên khôi phục lại được từ trang Cài đặt → Nhật ký, kèm cả file đính kèm.',
    confirmLabel: 'Xóa khỏi sổ',
    danger: true,
    onConfirm: async () => {
      await api('DELETE', '/api/documents/' + doc.id);
      closeDialog();
      toast('Đã xóa ' + doc.soVanBan + ' khỏi sổ.', 'ok');
      refresh();
    },
  });
}

function confirmRestore(doc) {
  confirmDialog({
    eyebrow: doc.book === 'den' ? 'Sổ văn bản đến' : 'Sổ văn bản đi',
    title: 'Khôi phục văn bản về sổ?',
    message:
      '“' + doc.soVanBan + ' — ' + doc.tenVanBan + '” trở lại sổ' +
      (doc.fileName ? ', kèm file đính kèm ' + doc.fileName : '') + '. ' +
      (doc.numberFree === false
        ? 'Số ' + doc.soVanBan + ' nay đã thuộc về một văn bản khác nên không trả lại được — ' +
        'văn bản này sẽ nhận số mới ' + (doc.nextNumber || 'kế tiếp') +
        '. Nếu đã ghi số cũ lên bản giấy thì phải sửa lại. '
        : 'Số cũ ' + doc.soVanBan + ' vẫn còn trống nên văn bản giữ nguyên số của mình. ') +
      'Việc khôi phục được ghi vào nhật ký.',
    confirmLabel: 'Khôi phục về sổ',
    onConfirm: async () => {
      const data = await api('POST', '/api/documents/' + doc.id + '/restore');
      closeDialog();
      const r = data.renumbered;
      toast(
        (r
          ? 'Đã khôi phục về sổ với số MỚI ' + r.to + ' — số cũ ' + r.from +
          ' nay thuộc về văn bản khác' + (r.takenBy ? ' (“' + r.takenBy + '”)' : '') + '.'
          : 'Đã khôi phục ' + doc.soVanBan + ' về sổ.') +
        (data.fileMissing ? ' Lưu ý: file đính kèm không còn trên máy chủ.' : ''),
        r || data.fileMissing ? 'err' : 'ok'
      );
      refresh();
    },
  });
}

function confirmDeleteUser(user) {
  confirmDialog({
    eyebrow: 'Quản trị · Tài khoản',
    title: 'Xóa tài khoản ' + user.username + '?',
    message:
      'Xóa hẳn tài khoản của ' + user.fullName + '. Nếu người này đã từng ghi sổ, hệ thống sẽ từ chối và bạn nên khóa tài khoản thay vì xóa, để giữ dấu vết ai đã ghi văn bản.',
    confirmLabel: 'Xóa tài khoản',
    danger: true,
    onConfirm: async () => {
      const data = await api('DELETE', '/api/users/' + user.id);
      state.users = data.users;
      closeDialog();
      toast('Đã xóa tài khoản ' + user.username + '.', 'ok');
      render();
    },
  });
}

function confirmResetPassword(user) {
  confirmDialog({
    eyebrow: 'Quản trị · Tài khoản',
    title: 'Cấp lại mật khẩu cho ' + user.username + '?',
    message:
      'Hệ thống sinh một mật khẩu tạm thời mới, đóng mọi phiên đang mở của ' + user.fullName +
      ', và bắt đổi mật khẩu ở lần đăng nhập sau. Mật khẩu cũ sẽ không dùng được nữa.',
    confirmLabel: 'Cấp mật khẩu tạm',
    onConfirm: async () => {
      const data = await api('POST', '/api/users/' + user.id + '/reset-password');
      state.users = data.users;
      showTempPassword(data.username, data.password, 'Đã cấp lại mật khẩu cho');
      render();
    },
  });
}

function renderDialogs() {
  const saved = captureFocus();
  const host = document.getElementById('dialogs');
  // Khung xem PDF giữ worker và listener riêng; phải tháo trước khi xóa DOM.
  if (viewerCleanup) {
    const fn = viewerCleanup;
    viewerCleanup = null;
    fn();
  }
  host.textContent = '';
  const d = state.dialog;
  if (!d) return;
  if (d.kind === 'doc') host.append(renderDocDialog(d));
  else if (d.kind === 'file') host.append(renderFileDialog(d));
  else if (d.kind === 'user') host.append(renderUserDialog(d));
  else if (d.kind === 'temp-password') host.append(renderTempPasswordDialog(d));
  else if (d.kind === 'confirm') host.append(renderConfirmDialog(d));
  else if (d.kind === 'number-changed') host.append(renderNumberChangedDialog(d));
  restoreFocus(saved);
}

// -------------------------------------------------------------------- render

function render() {
  const saved = captureFocus();
  const app = document.getElementById('app');
  app.textContent = '';

  if (!state.config) {
    app.append(el('div', { class: 'gate' }, el('span', { class: 'muted', text: 'Đang tải…' })));
    return;
  }
  if (!state.user) {
    app.append(renderGate());
    renderDialogs();
    restoreFocus(saved);
    return;
  }
  if (state.user.mustChangePassword) {
    app.append(renderPasswordGate());
    renderDialogs();
    restoreFocus(saved);
    return;
  }

  app.append(renderHeader(), renderTabs());

  let content;
  if (state.page === 'settings' && isAdmin()) {
    const inner =
      state.settingsTab === 'layso' ? renderNumberingPage()
        : state.settingsTab === 'taikhoan' ? renderUsersPage()
          : state.settingsTab === 'sonam' ? renderYearsPage()
            : renderAuditPage();
    content = [renderSettingsTabs(), inner];
  } else {
    // Không phải quản trị mà lạc vào trang cài đặt: đưa về sổ.
    if (state.page === 'settings') state.page = 'so';
    content = renderBookPage();
  }
  app.append(el('main', {}, content));
  renderDialogs();
  restoreFocus(saved);
}

// ---------------------------------------------------------------------- boot

(async function boot() {
  try {
    const [config, me] = await Promise.all([api('GET', '/api/config'), api('GET', '/api/me')]);
    state.config = config;
    state.user = me.user;
    state.filters.year = String(config.currentYear);
  } catch (err) {
    document.getElementById('app').append(
      el('div', { class: 'gate' }, el('div', { class: 'note note-error' }, icon('alert', 16),
        el('span', { text: (err && err.message) || 'Không tải được cấu hình.' })))
    );
    return;
  }
  render();
  if (state.user && !state.user.mustChangePassword) refresh();
})();
