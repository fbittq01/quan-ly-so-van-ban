'use strict';

/**
 * Khen thưởng của phòng (16/10/2026).
 *
 * KHÔNG phải một sổ văn bản, dù cũng là “quyết định có số”. Bốn chỗ khác hẳn
 * sổ, nên có bảng và đường riêng thay vì nhét vào books/documents:
 *
 *   - ai ghi: MỌI tài khoản tự khai khen thưởng của mình, kể cả vai trò Chỉ
 *     xem — trong khi sổ chỉ admin/vanthu ghi được
 *   - thuộc về ai: mỗi dòng gắn với MỘT người được khen (users.id), để tổng
 *     hợp theo người không lệch vì gõ sai tên
 *   - duyệt: bản tự khai chờ Quản trị đối chiếu với quyết định gốc; CHỈ Quản
 *     trị duyệt hoặc trả lại
 *   - tổng hợp: chỉ đếm bản đã duyệt
 *
 * Dùng chung với sổ: tài khoản, tệp đính kèm (files.js), nhật ký, sao lưu.
 */

const express = require('express');

const { db, audit, getSetting, setSetting } = require('../db');
const auth = require('../auth');
const files = require('../files');
const { isIsoDate, text, multiline, nowIso, strip, badRequest, HttpError } = require('../util');

const router = express.Router();

// Danh mục danh hiệu / hình thức: Quản trị sửa ở Cài đặt → Khen thưởng (lưu ở
// settings.awardForms). Đây chỉ là bộ mặc định khi chưa ai sửa. Danh mục vừa là
// lựa chọn trong hộp thoại khai báo, vừa là các cột của bảng tổng hợp.
const DEFAULT_FORMS = ['Lao động tiên tiến', 'Chiến sĩ thi đua cơ sở', 'Giấy khen', 'Bằng khen', 'Khác'];
const MAX_FORMS = 40;
const MAX_FORM_LEN = 80;
const STATUS = ['cho', 'duyet', 'tra'];
const STATUS_LABEL = { cho: 'Chờ duyệt', duyet: 'Đã duyệt', tra: 'Trả lại' };

// Một quyết định khen cả phòng là chuyện thường; chặn trên cho chắc.
const MAX_PEOPLE = 200;

const isAdmin = (user) => user.role === 'admin';
// Quản trị và nhân viên (vanthu) nhập hộ được; Chỉ xem chỉ khai cho mình.
const canProxy = (user) => user.role === 'admin' || user.role === 'vanthu';

/** Danh mục đang dùng. Giá trị hỏng trong settings thì về bộ mặc định. */
function forms() {
  const v = getSetting('awardForms', DEFAULT_FORMS).value;
  if (!Array.isArray(v)) return DEFAULT_FORMS.slice();
  const out = v.filter((x) => typeof x === 'string' && x.trim());
  return out.length ? out : DEFAULT_FORMS.slice();
}

/** Người Chỉ xem có được xem tổng hợp cả phòng không — Quản trị bật/tắt. */
function summaryAll() {
  return getSetting('awardsSummaryAll', true).value !== false;
}

function canSeeSummary(user) {
  return canProxy(user) || summaryAll();
}

/** Dòng này là của người dùng: họ được khen, hoặc họ đã nhập nó. */
function isOwn(row, user) {
  return row.user_id === user.id || row.created_by === user.id;
}

/** Sửa / rút: Quản trị mọi lúc; người khai chỉ khi chưa duyệt. */
function canEdit(row, user) {
  return isAdmin(user) || (row.status !== 'duyet' && isOwn(row, user));
}

function canSee(row, user) {
  return isAdmin(user) || isOwn(row, user) || (row.status === 'duyet' && canSeeSummary(user));
}

const SELECT = `
  SELECT a.*, u.full_name AS user_name, u.title AS user_title,
         cu.full_name AS created_by_name, ru.full_name AS reviewed_by_name
    FROM awards a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN users cu ON cu.id = a.created_by
    LEFT JOIN users ru ON ru.id = a.reviewed_by`;

function rowToJson(r, user) {
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    userTitle: r.user_title || '',
    hinhThuc: r.hinh_thuc,
    cap: r.cap,
    nam: r.nam,
    soQd: r.so_qd,
    ngayQd: r.ngay_qd,
    coQuan: r.co_quan,
    ghiChu: r.ghi_chu,
    status: r.status,
    statusLabel: STATUS_LABEL[r.status],
    lyDoTra: r.ly_do_tra,
    ...files.fileFlags(r),
    createdAt: r.created_at,
    createdById: r.created_by,
    createdByName: r.created_by_name || null,
    reviewedAt: r.reviewed_at,
    reviewedByName: r.reviewed_by_name || null,
    updatedAt: r.updated_at,
    canEdit: canEdit(r, user),
  };
}

function getRow(id) {
  const n = Number.parseInt(id, 10);
  if (!Number.isFinite(n)) return null;
  return db.prepare(SELECT + ` WHERE a.id = ?`).get(n) || null;
}

/** Dòng còn sống, hoặc 404. Dòng đã rút/xóa coi như không còn. */
function requireRow(id) {
  const row = getRow(id);
  if (!row || row.deleted_at) throw new HttpError(404, 'Không tìm thấy khen thưởng này.', 'not_found');
  return row;
}

/**
 * Đọc và kiểm phần nội dung của một khen thưởng (JSON hoặc multipart).
 * Năm thi đua bỏ trống thì lấy năm của ngày quyết định.
 */
function readAward(body, keepForm) {
  const b = body || {};
  const hinhThuc = text(b.hinhThuc, MAX_FORM_LEN);
  // Sửa một dòng cũ mà danh hiệu của nó đã bị bỏ khỏi danh mục: vẫn lưu được
  // nếu giữ nguyên danh hiệu đó, chỉ không chọn mới được nữa.
  if (!hinhThuc || (!forms().includes(hinhThuc) && hinhThuc !== keepForm)) {
    throw badRequest('Chọn danh hiệu hoặc hình thức khen thưởng trong danh mục.', 'bad_form');
  }

  // Cấp khen là chữ tự do (16/10/2026): mỗi đơn vị gọi cấp một kiểu.
  const cap = text(b.cap, 120);

  const soQd = text(b.soQd, 100);
  if (!soQd) throw badRequest('Chưa nhập số quyết định.', 'no_so_qd');

  const ngayQd = String(b.ngayQd || '').trim();
  if (!isIsoDate(ngayQd)) throw badRequest('Ngày quyết định không hợp lệ.', 'bad_date');

  const maxYear = new Date().getFullYear() + 1;
  const rawNam = String(b.nam == null ? '' : b.nam).trim();
  const nam = rawNam ? Number.parseInt(rawNam, 10) : Number.parseInt(ngayQd.slice(0, 4), 10);
  if (!Number.isFinite(nam) || nam < 1990 || nam > maxYear) {
    throw badRequest('Năm thi đua phải từ 1990 đến ' + maxYear + '.', 'bad_year');
  }

  return {
    hinh_thuc: hinhThuc,
    cap,
    nam,
    so_qd: soQd,
    ngay_qd: ngayQd,
    co_quan: text(b.coQuan, 200),
    ghi_chu: multiline(b.ghiChu, 1000),
  };
}

/**
 * Những người được khen trong một lượt khai.
 *
 * Chỉ xem: luôn đúng mình, bỏ qua mọi thứ gửi lên — ranh giới ở máy chủ chứ
 * không phải giao diện ẩn ô chọn người. Quản trị / nhân viên: danh sách id
 * (mảng JSON, hoặc chuỗi JSON khi gửi multipart).
 */
function readPeople(body, user) {
  if (!canProxy(user)) return [user.id];
  let raw = body ? body.userIds : null;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  if (!Array.isArray(raw)) raw = raw == null ? [] : [raw];
  const ids = [...new Set(raw.map((v) => Number.parseInt(v, 10)).filter(Number.isFinite))];
  if (ids.length === 0) throw badRequest('Chọn ít nhất một người được khen.', 'no_people');
  if (ids.length > MAX_PEOPLE) throw badRequest('Một lượt nhập tối đa ' + MAX_PEOPLE + ' người.', 'too_many');
  const found = db
    .prepare(`SELECT id FROM users WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids)
    .map((r) => r.id);
  if (found.length !== ids.length) throw badRequest('Có người được chọn không còn trong danh sách tài khoản.', 'bad_people');
  return ids;
}

/**
 * Cùng người, cùng danh hiệu, cùng số quyết định = đã có rồi. Hay gặp nhất khi
 * nhân viên nhập hộ cả quyết định mà một người trong đó đã tự khai trước.
 */
function duplicates(userIds, a, exceptId) {
  return db
    .prepare(
      `SELECT u.full_name AS name FROM awards x JOIN users u ON u.id = x.user_id
        WHERE x.deleted_at IS NULL AND x.hinh_thuc = ? AND x.so_qd = ? AND x.id IS NOT ?
          AND x.user_id IN (${userIds.map(() => '?').join(',')})`
    )
    .all(a.hinh_thuc, a.so_qd, exceptId == null ? null : exceptId, ...userIds)
    .map((r) => r.name);
}

/**
 * Một tệp quyết định dùng chung cho mọi dòng của cùng một lượt nhập hộ. Chỉ
 * xóa khỏi đĩa khi KHÔNG còn dòng nào (kể cả dòng đã rút) trỏ tới nó.
 */
function releaseFile(storedName) {
  if (!storedName) return;
  const n = db.prepare(`SELECT COUNT(*) AS n FROM awards WHERE file_path = ?`).get(storedName).n;
  if (n === 0) files.removeFile(storedName);
}

function describe(row) {
  return '#' + row.id + ' · ' + row.user_name + ' · ' + row.hinh_thuc + ' · QĐ ' + row.so_qd;
}

// ------------------------------------------------------------------- đọc

/** Danh mục, quyền của người đang xem, danh sách người để nhập hộ. */
router.get('/meta', auth.requireAuth, (req, res) => {
  const u = req.user;
  res.json({
    forms: forms(),
    statusLabels: STATUS_LABEL,
    summaryAll: summaryAll(),
    canProxy: canProxy(u),
    canReview: isAdmin(u),
    canSummary: canSeeSummary(u),
    mineCount: db
      .prepare(`SELECT COUNT(*) AS n FROM awards WHERE deleted_at IS NULL AND (user_id = ? OR created_by = ?)`)
      .get(u.id, u.id).n,
    pendingCount: isAdmin(u)
      ? db.prepare(`SELECT COUNT(*) AS n FROM awards WHERE status = 'cho' AND deleted_at IS NULL`).get().n
      : 0,
    people: canProxy(u)
      ? db
        .prepare(`SELECT id, full_name, title, locked FROM users`)
        .all()
        .sort((a, b) => a.locked - b.locked || byVietnameseName(a.full_name, b.full_name))
        .map((r) => ({ id: r.id, fullName: r.full_name, title: r.title || '', locked: !!r.locked }))
      : [],
  });
});

/**
 * ?view=mine    khen thưởng của tôi + bản tôi nhập hộ (mặc định)
 * ?view=pending bản chờ duyệt, gửi trước xếp trước — chỉ Quản trị
 */
router.get('/', auth.requireAuth, (req, res, next) => {
  const u = req.user;
  const view = String(req.query.view || 'mine');
  let rows;
  if (view === 'pending') {
    if (!isAdmin(u)) return next(new HttpError(403, 'Chỉ Quản trị duyệt khen thưởng.', 'forbidden'));
    rows = db
      .prepare(SELECT + ` WHERE a.deleted_at IS NULL AND a.status = 'cho' ORDER BY a.created_at, a.id`)
      .all();
  } else if (view === 'mine') {
    rows = db
      .prepare(
        SELECT +
          ` WHERE a.deleted_at IS NULL AND (a.user_id = ? OR a.created_by = ?)
            ORDER BY a.ngay_qd DESC, a.id DESC`
      )
      .all(u.id, u.id);
  } else {
    return next(badRequest('Không có cách xem này.', 'bad_view'));
  }
  res.json({ awards: rows.map((r) => rowToJson(r, u)) });
});

/** Tên để xếp kiểu Việt Nam: theo tên (chữ cuối), rồi mới tới cả họ tên. */
function nameKey(full) {
  const parts = String(full || '').trim().split(/\s+/);
  return [parts[parts.length - 1] || '', full || ''];
}

function byVietnameseName(a, b) {
  const [ta, fa] = nameKey(a);
  const [tb, fb] = nameKey(b);
  return ta.localeCompare(tb, 'vi') || fa.localeCompare(fb, 'vi');
}

/**
 * Tổng hợp: CHỈ bản đã duyệt. Bảng người × danh hiệu tính sẵn ở đây để màn
 * hình và tệp xuất ra luôn khớp nhau.
 */
function buildSummary(yearRaw) {
  const year = String(yearRaw || '').trim();
  if (year && !/^\d{4}$/.test(year)) throw badRequest('Năm thi đua không hợp lệ.');
  const where = [`a.deleted_at IS NULL`, `a.status = 'duyet'`];
  const args = [];
  if (year) {
    where.push('a.nam = ?');
    args.push(Number.parseInt(year, 10));
  }
  const rows = db.prepare(SELECT + ` WHERE ${where.join(' AND ')} ORDER BY a.ngay_qd DESC, a.id DESC`).all(...args);

  // Mọi tài khoản đang dùng có một dòng, kể cả người chưa có khen thưởng nào —
  // bình xét cần thấy cả những ô trống. Tài khoản đã khóa chỉ hiện khi có số.
  const people = new Map();
  for (const p of db.prepare(`SELECT id, full_name, title FROM users WHERE locked = 0`).all()) {
    people.set(p.id, { id: p.id, name: p.full_name, title: p.title || '', counts: {}, total: 0 });
  }
  for (const r of rows) {
    if (!people.has(r.user_id)) {
      people.set(r.user_id, { id: r.user_id, name: r.user_name, title: r.user_title || '', counts: {}, total: 0 });
    }
    const p = people.get(r.user_id);
    p.counts[r.hinh_thuc] = (p.counts[r.hinh_thuc] || 0) + 1;
    p.total += 1;
  }
  // Cột = danh mục, cộng thêm danh hiệu đã bị bỏ khỏi danh mục mà vẫn còn bản
  // đã duyệt: bỏ khỏi danh mục không được làm mất số trong tổng hợp.
  const list = forms();
  const extra = [...new Set(rows.map((r) => r.hinh_thuc))].filter((f) => !list.includes(f)).sort((a, b) => a.localeCompare(b, 'vi'));
  const cols = list.concat(extra);
  const totals = {};
  for (const f of cols) totals[f] = rows.filter((r) => r.hinh_thuc === f).length;

  const pending = db
    .prepare(
      `SELECT COUNT(*) AS n FROM awards WHERE deleted_at IS NULL AND status = 'cho'` +
        (year ? ' AND nam = ?' : '')
    )
    .get(...(year ? [Number.parseInt(year, 10)] : [])).n;

  const years = db
    .prepare(`SELECT DISTINCT nam FROM awards WHERE deleted_at IS NULL ORDER BY nam DESC`)
    .all()
    .map((r) => r.nam);

  return {
    year: year || null,
    forms: cols,
    // Cột nào không còn trong danh mục, để giao diện đánh dấu.
    offList: extra,
    people: [...people.values()].sort((a, b) => byVietnameseName(a.name, b.name)),
    totals,
    total: rows.length,
    pendingCount: pending,
    years,
    rows,
  };
}

router.get('/summary', auth.requireAuth, (req, res, next) => {
  try {
    if (!canSeeSummary(req.user)) {
      throw new HttpError(403, 'Quản trị chưa mở tổng hợp khen thưởng cho vai trò của bạn.', 'forbidden');
    }
    const s = buildSummary(req.query.year);
    res.json({ ...s, rows: s.rows.map((r) => rowToJson(r, req.user)) });
  } catch (err) {
    next(err);
  }
});

/**
 * Ô CSV an toàn khi mở bằng Excel: bọc nháy, và chặn công thức — một ô bắt đầu
 * bằng = + - @ sẽ bị Excel chạy như công thức (CSV injection).
 */
function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

/** Tệp Excel (CSV có BOM để Excel đọc đúng tiếng Việt). ?view=matrix|list */
router.get('/summary.csv', auth.requireAuth, (req, res, next) => {
  try {
    if (!canProxy(req.user)) throw new HttpError(403, 'Tài khoản của bạn không xuất được tổng hợp.', 'forbidden');
    const s = buildSummary(req.query.year);
    const list = String(req.query.view || '') === 'list';
    const lines = [];
    if (list) {
      lines.push(['Họ tên', 'Chức danh', 'Danh hiệu / hình thức', 'Cấp', 'Năm thi đua', 'Số QĐ', 'Ngày QĐ', 'Cơ quan ban hành', 'Ghi chú']);
      const sorted = s.rows.slice().sort((a, b) => byVietnameseName(a.user_name, b.user_name) || b.ngay_qd.localeCompare(a.ngay_qd));
      for (const r of sorted) {
        const d = r.ngay_qd;
        lines.push([r.user_name, r.user_title, r.hinh_thuc, r.cap, r.nam, r.so_qd,
          d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4), r.co_quan, r.ghi_chu]);
      }
    } else {
      lines.push(['Họ tên', 'Chức danh', ...s.forms, 'Cộng']);
      for (const p of s.people) lines.push([p.name, p.title, ...s.forms.map((f) => p.counts[f] || 0), p.total]);
      lines.push(['Cộng cả phòng', '', ...s.forms.map((f) => s.totals[f]), s.total]);
    }
    const body = '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const name = 'tong-hop-khen-thuong-' + (s.year || 'tat-ca') + (list ? '-chi-tiet' : '') + '.csv';
    audit(req.user, 'xuat_khen_thuong', (s.year ? 'năm ' + s.year : 'tất cả các năm') + ' · ' + (list ? 'chi tiết' : 'theo người') + ' · ' + s.total + ' dòng', null);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', files.contentDisposition('attachment', name));
    res.send(body);
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------------- ghi

const insertStmt = db.prepare(
  `INSERT INTO awards
     (user_id, hinh_thuc, cap, nam, so_qd, ngay_qd, co_quan, ghi_chu,
      file_name, file_path, file_size, status, ly_do_tra,
      created_at, created_by, reviewed_at, reviewed_by)
   VALUES
     (@user_id, @hinh_thuc, @cap, @nam, @so_qd, @ngay_qd, @co_quan, @ghi_chu,
      @file_name, @file_path, @file_size, @status, '',
      @created_at, @created_by, @reviewed_at, @reviewed_by)`
);

/**
 * Khai báo (mọi tài khoản) hoặc nhập hộ (Quản trị, nhân viên).
 *
 * Một quyết định khen nhiều người = nhiều dòng, mỗi người một dòng, cùng một
 * tệp quyết định. Quản trị ghi thì vào thẳng Đã duyệt: không có ai khác để
 * duyệt lại cho Quản trị.
 */
router.post(
  '/',
  auth.requireAuth,
  auth.requirePasswordSettled,
  files.upload.single('file'),
  (req, res, next) => {
    try {
      const u = req.user;
      const a = readAward(req.body);
      const people = readPeople(req.body, u);
      const dup = duplicates(people, a, null);
      if (dup.length) {
        throw badRequest(
          'Đã có ' + a.hinh_thuc + ' theo QĐ ' + a.so_qd + ' của: ' + dup.join(', ') + '. Bỏ chọn những người này rồi lưu lại.',
          'duplicate'
        );
      }
      const now = nowIso();
      const admin = isAdmin(u);
      const ids = db.transaction(() =>
        people.map((pid) => insertStmt.run({
          ...a,
          user_id: pid,
          file_name: req.file ? files.originalName(req.file) : null,
          file_path: req.file ? req.file.filename : null,
          file_size: req.file ? req.file.size : null,
          status: admin ? 'duyet' : 'cho',
          created_at: now,
          created_by: u.id,
          reviewed_at: admin ? now : null,
          reviewed_by: admin ? u.id : null,
        }).lastInsertRowid)
      )();
      files.preConvert(req.file);

      const rows = ids.map((id) => getRow(id));
      const names = rows.map((r) => r.user_name);
      audit(
        u,
        'khai_khen_thuong',
        a.hinh_thuc + ' · QĐ ' + a.so_qd + ' · ' + names.join(', ') + (admin ? ' · Quản trị ghi, đã duyệt' : ' · chờ duyệt'),
        null
      );
      return res.status(201).json({ awards: rows.map((r) => rowToJson(r, u)), approved: admin });
    } catch (err) {
      if (req.file) files.removeFile(req.file.filename);
      return next(err);
    }
  }
);

// ------------------------------------------------- danh mục danh hiệu (Quản trị)

/** Số khen thưởng (còn sống) theo từng danh hiệu. */
function formUsage() {
  const m = new Map();
  for (const r of db.prepare(`SELECT hinh_thuc AS f, COUNT(*) AS n FROM awards WHERE deleted_at IS NULL GROUP BY hinh_thuc`).all()) {
    m.set(r.f, r.n);
  }
  return m;
}

function formsPayload() {
  const used = formUsage();
  const list = forms();
  return {
    forms: list.map((name) => ({ name, used: used.get(name) || 0 })),
    // Danh hiệu còn trong dữ liệu nhưng không còn trong danh mục.
    orphans: [...used.keys()].filter((f) => !list.includes(f)).sort((a, b) => a.localeCompare(b, 'vi'))
      .map((name) => ({ name, used: used.get(name) })),
  };
}

router.get('/forms', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  res.json(formsPayload());
});

/**
 * Lưu danh mục: { forms: [{ name, from }] } theo đúng thứ tự hiển thị.
 *
 * `from` = tên cũ của mục đó (null nếu là mục mới). Đổi tên thì MỌI khen
 * thưởng đang mang tên cũ đổi theo, trong cùng transaction — nếu không, bản
 * đã ghi rơi ra khỏi cột của mình trong tổng hợp. Bỏ một mục thì các khen
 * thưởng đã ghi giữ nguyên tên, chỉ không chọn mới được nữa.
 */
router.put(
  '/forms',
  auth.requireAuth,
  auth.requirePasswordSettled,
  auth.requireRole('admin'),
  (req, res, next) => {
    try {
      const input = req.body && Array.isArray(req.body.forms) ? req.body.forms : null;
      if (!input) throw badRequest('Thiếu danh mục.');
      if (input.length === 0) throw badRequest('Danh mục cần ít nhất một danh hiệu.', 'empty');
      if (input.length > MAX_FORMS) throw badRequest('Danh mục tối đa ' + MAX_FORMS + ' mục.', 'too_many');

      const known = new Set([...forms(), ...formUsage().keys()]);
      const seen = new Map();
      const items = input.map((it, i) => {
        const name = text(it && it.name, MAX_FORM_LEN);
        if (!name) throw badRequest('Dòng ' + (i + 1) + ' chưa có tên.', 'empty_name');
        const k = strip(name);
        if (seen.has(k)) throw badRequest('“' + name + '” bị trùng với “' + seen.get(k) + '”.', 'dup_name');
        seen.set(k, name);
        const from = it && typeof it.from === 'string' && known.has(it.from) ? it.from : null;
        return { name, from };
      });

      const renames = items.filter((it) => it.from && it.from !== it.name);
      const fromSet = new Set(renames.map((r) => r.from));
      if (renames.length !== fromSet.size) throw badRequest('Một danh hiệu cũ không đổi thành hai tên được.', 'dup_from');

      const before = forms();
      const after = items.map((it) => it.name);
      let moved = 0;
      db.transaction(() => {
        if (renames.length) {
          // Một câu CASE thay cho từng câu UPDATE: đổi chéo hai tên (A↔B) vẫn
          // đúng, vì mỗi dòng chỉ được đọc giá trị cũ của chính nó một lần.
          const cases = renames.map(() => 'WHEN ? THEN ?').join(' ');
          const args = renames.flatMap((r) => [r.from, r.name]);
          moved = db.prepare(
            `UPDATE awards SET hinh_thuc = CASE hinh_thuc ${cases} END
              WHERE hinh_thuc IN (${renames.map(() => '?').join(',')})`
          ).run(...args, ...renames.map((r) => r.from)).changes;
        }
        setSetting('awardForms', after, req.user.id);
      })();

      const changes = [];
      for (const r of renames) changes.push('đổi “' + r.from + '” → “' + r.name + '”');
      const renamedTo = new Set(renames.map((r) => r.name));
      for (const n of after) if (!before.includes(n) && !renamedTo.has(n)) changes.push('thêm “' + n + '”');
      for (const n of before) if (!after.includes(n) && !fromSet.has(n)) changes.push('bỏ “' + n + '”');
      if (!changes.length) changes.push('đổi thứ tự');
      audit(req.user, 'cai_dat_khen_thuong', 'Danh mục danh hiệu: ' + changes.join(' · ') + (moved ? ' · ' + moved + ' khen thưởng đổi tên theo' : ''), null);
      res.json({ ...formsPayload(), moved });
    } catch (err) {
      next(err);
    }
  }
);

// Đứng TRƯỚC PUT /:id, nếu không '/settings' bị hiểu là id.
router.put(
  '/settings',
  auth.requireAuth,
  auth.requirePasswordSettled,
  auth.requireRole('admin'),
  (req, res) => {
    const on = !(req.body && req.body.summaryAll === false);
    setSetting('awardsSummaryAll', on, req.user.id);
    audit(req.user, 'cai_dat_khen_thuong', 'Chỉ xem ' + (on ? 'được' : 'không được') + ' xem tổng hợp khen thưởng', null);
    res.json({ summaryAll: on });
  }
);

/**
 * Sửa một dòng. Người khai sửa xong thì dòng quay về Chờ duyệt (kể cả bản bị
 * trả lại — đó chính là “sửa & gửi lại”). Quản trị sửa thì giữ trạng thái.
 * Người được khen không đổi được: sai người thì rút và khai lại.
 */
router.put(
  '/:id',
  auth.requireAuth,
  auth.requirePasswordSettled,
  files.upload.single('file'),
  (req, res, next) => {
    try {
      const u = req.user;
      const row = requireRow(req.params.id);
      if (!canEdit(row, u)) {
        throw new HttpError(403, row.status === 'duyet'
          ? 'Khen thưởng đã duyệt — chỉ Quản trị sửa được.'
          : 'Bạn không sửa được khen thưởng của người khác.', 'forbidden');
      }
      const a = readAward(req.body, row.hinh_thuc);
      if (duplicates([row.user_id], a, row.id).length) {
        throw badRequest('Người này đã có ' + a.hinh_thuc + ' theo QĐ ' + a.so_qd + '.', 'duplicate');
      }
      const dropFile = String((req.body && req.body.dropFile) || '') === '1';
      const admin = isAdmin(u);
      const now = nowIso();
      const next2 = {
        ...a,
        id: row.id,
        file_name: req.file ? files.originalName(req.file) : dropFile ? null : row.file_name,
        file_path: req.file ? req.file.filename : dropFile ? null : row.file_path,
        file_size: req.file ? req.file.size : dropFile ? null : row.file_size,
        status: admin ? row.status : 'cho',
        ly_do_tra: admin ? row.ly_do_tra : '',
        reviewed_at: admin ? row.reviewed_at : null,
        reviewed_by: admin ? row.reviewed_by : null,
        updated_at: now,
        updated_by: u.id,
      };
      db.prepare(
        `UPDATE awards SET
           hinh_thuc = @hinh_thuc, cap = @cap, nam = @nam, so_qd = @so_qd, ngay_qd = @ngay_qd,
           co_quan = @co_quan, ghi_chu = @ghi_chu,
           file_name = @file_name, file_path = @file_path, file_size = @file_size,
           status = @status, ly_do_tra = @ly_do_tra, reviewed_at = @reviewed_at, reviewed_by = @reviewed_by,
           updated_at = @updated_at, updated_by = @updated_by
         WHERE id = @id`
      ).run(next2);
      if (req.file || dropFile) releaseFile(row.file_path);
      files.preConvert(req.file);

      const fresh = getRow(row.id);
      audit(
        u,
        'sua_khen_thuong',
        describe(fresh) + (row.status === 'tra' && !admin ? ' · gửi lại sau khi bị trả lại' : '') +
          (row.status === 'duyet' && admin ? ' · sửa bản đã duyệt' : ''),
        null
      );
      return res.json({ award: rowToJson(fresh, u) });
    } catch (err) {
      if (req.file) files.removeFile(req.file.filename);
      return next(err);
    }
  }
);

/** Rút (người khai, khi chưa duyệt) hoặc xóa (Quản trị). Xóa mềm, giữ tệp. */
router.delete('/:id', auth.requireAuth, auth.requirePasswordSettled, (req, res, next) => {
  try {
    const u = req.user;
    const row = requireRow(req.params.id);
    if (!canEdit(row, u)) {
      throw new HttpError(403, row.status === 'duyet'
        ? 'Khen thưởng đã duyệt — chỉ Quản trị xóa được.'
        : 'Bạn không rút được khen thưởng của người khác.', 'forbidden');
    }
    db.prepare(`UPDATE awards SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL`)
      .run(nowIso(), u.id, row.id);
    audit(u, 'rut_khen_thuong', describe(row) + ' · ' + STATUS_LABEL[row.status], null);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

router.post(
  '/:id/approve',
  auth.requireAuth,
  auth.requirePasswordSettled,
  auth.requireRole('admin'),
  (req, res, next) => {
    try {
      const row = requireRow(req.params.id);
      if (row.status !== 'cho') {
        throw badRequest('Bản này không còn chờ duyệt (' + STATUS_LABEL[row.status] + ').', 'not_pending');
      }
      db.prepare(
        `UPDATE awards SET status = 'duyet', ly_do_tra = '', reviewed_at = ?, reviewed_by = ?
          WHERE id = ? AND status = 'cho'`
      ).run(nowIso(), req.user.id, row.id);
      audit(req.user, 'duyet_khen_thuong', describe(row), null);
      return res.json({ award: rowToJson(getRow(row.id), req.user) });
    } catch (err) {
      return next(err);
    }
  }
);

router.post(
  '/:id/return',
  auth.requireAuth,
  auth.requirePasswordSettled,
  auth.requireRole('admin'),
  (req, res, next) => {
    try {
      const row = requireRow(req.params.id);
      if (row.status !== 'cho') {
        throw badRequest('Bản này không còn chờ duyệt (' + STATUS_LABEL[row.status] + ').', 'not_pending');
      }
      const reason = text(req.body && req.body.reason, 300);
      if (!reason) throw badRequest('Ghi lý do để người khai biết phải sửa gì.', 'no_reason');
      db.prepare(
        `UPDATE awards SET status = 'tra', ly_do_tra = ?, reviewed_at = ?, reviewed_by = ?
          WHERE id = ? AND status = 'cho'`
      ).run(reason, nowIso(), req.user.id, row.id);
      audit(req.user, 'tra_khen_thuong', describe(row) + ' · lý do: ' + reason, null);
      return res.json({ award: rowToJson(getRow(row.id), req.user) });
    } catch (err) {
      return next(err);
    }
  }
);

// --------------------------------------------------------------- tệp quyết định

function fileRow(req) {
  const row = getRow(req.params.id);
  if (!row || row.deleted_at || !row.file_path || !canSee(row, req.user)) {
    throw new HttpError(404, 'Khen thưởng này không có file quyết định.', 'not_found');
  }
  return row;
}

const fileHandler = (req, res, next) => {
  try {
    return files.sendAttachment(req, res, next, fileRow(req));
  } catch (err) {
    return next(err);
  }
};

router.get('/:id/file', auth.requireAuth, fileHandler);
router.get('/:id/file/:ten', auth.requireAuth, fileHandler);
// Không đuôi, không tham số — lý do ở files.sendViewPdf.
router.get('/:id/xem-pdf', auth.requireAuth, (req, res, next) => {
  try {
    return files.sendViewPdf(req, res, next, fileRow(req));
  } catch (err) {
    return next(err);
  }
});

module.exports = { router, DEFAULT_FORMS, STATUS, STATUS_LABEL, forms };
