'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const { strip, AUDIT_ACTION_LABEL } = require('./util');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'vanban.db');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(DB_PATH);

// WAL cho phép đọc song song với ghi — nhiều người dùng cùng lúc không chặn nhau.
db.pragma('journal_mode = WAL');
// FULL thay vì NORMAL: một sổ văn bản không được mất giao dịch đã báo thành công,
// kể cả khi máy mất điện. Đổi lại mỗi lần ghi chậm hơn vài ms.
db.pragma('synchronous = FULL');
db.pragma('foreign_keys = ON');
// Chờ tối đa 5s khi có người khác đang ghi, thay vì báo lỗi SQLITE_BUSY ngay.
db.pragma('busy_timeout = 5000');

db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

/**
 * Bù các cột thêm sau cho cơ sở dữ liệu đã tồn tại.
 *
 * schema.sql chạy toàn bộ bằng CREATE TABLE IF NOT EXISTS, nên với một cơ sở
 * dữ liệu đã có, việc thêm cột vào file đó KHÔNG có tác dụng gì — phải ALTER
 * TABLE. Hàm này chạy được nhiều lần mà không hỏng, và PHẢI chạy trước khi bất
 * kỳ module nào prepare câu lệnh, nếu không câu lệnh sẽ tham chiếu cột chưa có.
 */
function addMissingColumns() {
  const added = [];
  const wanted = [
    ['documents', 'deleted_at', 'TEXT'],
    ['documents', 'deleted_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'],
    ['audit_log', 'doc_id', 'INTEGER'],
    ['audit_log', 'search_text', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [table, column, decl] of wanted) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (cols.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    added.push(table + '.' + column);
  }
  // Index nằm trong schema.sql nhưng chỉ tạo được sau khi cột đã tồn tại.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_deleted
             ON documents(deleted_at) WHERE deleted_at IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_doc
             ON audit_log(doc_id) WHERE doc_id IS NOT NULL`);

  // Hai bảo đảm "không trùng số" của sổ đi. Cả hai CHỈ tính văn bản còn trong
  // sổ: xóa một văn bản là nhả số của nó ra cho văn bản khác lấy (quy tắc chốt
  // 11/09/2026), nên hàng đã xóa mềm không được giữ chỗ số nữa.
  //
  // Hai tên index cũ (không có '_live') là bản KHÔNG lọc deleted_at, chặt hơn
  // bản mới. Phải DROP hẳn chứ không dựa vào IF NOT EXISTS: cùng tên thì SQLite
  // giữ nguyên định nghĩa cũ và số sẽ vẫn bị giữ chỗ sau khi xóa. Đổi tên để
  // một cơ sở dữ liệu nửa cũ nửa mới là chuyện không thể xảy ra.
  db.exec(`DROP INDEX IF EXISTS idx_documents_di_so`);
  db.exec(`DROP INDEX IF EXISTS idx_documents_di_seq`);
  // 1. Không hai văn bản đi nào trong sổ trùng số trong cùng một năm sổ.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_di_so_live
             ON documents(year, so_van_ban) WHERE book = 'di' AND deleted_at IS NULL`);
  // 2. Không hai văn bản đi nào trong sổ trùng số thứ tự trong cùng phạm vi đếm.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_di_seq_live
             ON documents(seq_scope, seq) WHERE seq IS NOT NULL AND deleted_at IS NULL`);
  return added;
}

/**
 * Cột tìm kiếm của một dòng nhật ký.
 *
 * Có cả tên tiếng Việt của việc, không chỉ mã: người dùng gõ đúng chữ họ nhìn
 * thấy trên màn hình (“xóa văn bản”), chứ không gõ 'xoa_van_ban'.
 */
function auditSearchText(username, action, detail) {
  return strip([username, action, AUDIT_ACTION_LABEL[action] || '', detail].join(' '));
}

// Tăng số này mỗi khi công thức auditSearchText đổi, để các dòng cũ được dựng lại.
const AUDIT_SEARCH_VERSION = 2;

/** Điền lại search_text cho các dòng nhật ký ghi theo công thức cũ. */
function backfillAuditSearch() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get('auditSearchVersion');
  let have = 0;
  if (row) {
    try {
      have = Number.parseInt(JSON.parse(row.value), 10) || 0;
    } catch {
      have = 0;
    }
  }
  if (have >= AUDIT_SEARCH_VERSION) return 0;

  const rows = db.prepare(`SELECT id, username, action, detail FROM audit_log`).all();
  const upd = db.prepare(`UPDATE audit_log SET search_text = ? WHERE id = ?`);
  db.transaction(() => {
    for (const r of rows) {
      upd.run(auditSearchText(r.username, r.action, r.detail), r.id);
    }
    db.prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, NULL)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run('auditSearchVersion', JSON.stringify(AUDIT_SEARCH_VERSION), new Date().toISOString());
  })();
  return rows.length;
}

const migrated = addMissingColumns();
const backfilled = backfillAuditSearch();
if (migrated.length > 0 || backfilled > 0) {
  console.log(
    '  cập nhật    : ' +
      (migrated.length > 0 ? 'thêm cột ' + migrated.join(', ') : '') +
      (migrated.length > 0 && backfilled > 0 ? ' · ' : '') +
      (backfilled > 0 ? 'điền tìm kiếm cho ' + backfilled + ' dòng nhật ký' : '')
  );
}

const DEFAULT_NUMBERING = {
  segments: [{ type: 'seq' }, { type: 'text', text: '/' }, { type: 'year' }],
  start: 1,
  resetYearly: true,
};

/** Đọc một mục cài đặt (JSON) kèm thông tin ai sửa lần cuối. */
function getSetting(key, fallback) {
  const row = db
    .prepare(
      `SELECT s.value, s.updated_at, u.full_name AS updated_by_name
         FROM settings s
         LEFT JOIN users u ON u.id = s.updated_by
        WHERE s.key = ?`
    )
    .get(key);
  if (!row) return { value: fallback, updatedAt: null, updatedByName: null };
  let value;
  try {
    value = JSON.parse(row.value);
  } catch {
    value = fallback;
  }
  return { value, updatedAt: row.updated_at, updatedByName: row.updated_by_name };
}

function setSetting(key, value, userId) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`
  ).run(key, JSON.stringify(value), new Date().toISOString(), userId ?? null);
}

/**
 * Ghi một việc vào nhật ký.
 * docId nối dòng nhật ký với văn bản bị tác động — đó là thứ cho phép quản trị
 * khôi phục lại một văn bản đã xóa từ chính trang Nhật ký.
 */
function audit(user, action, detail, docId) {
  const username = user ? user.username : 'hệ thống';
  const text = detail || '';
  db.prepare(
    `INSERT INTO audit_log (at, user_id, username, action, detail, doc_id, search_text)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    new Date().toISOString(),
    user ? user.id : null,
    username,
    action,
    text,
    docId == null ? null : docId,
    auditSearchText(username, action, text)
  );
}

module.exports = {
  db,
  DATA_DIR,
  UPLOAD_DIR,
  DB_PATH,
  DEFAULT_NUMBERING,
  getSetting,
  setSetting,
  audit,
};
