-- Quản lý số văn bản — lược đồ dữ liệu
-- Mọi mốc thời gian lưu dạng ISO 8601 (UTC) trừ ngay_gui là ngày thuần yyyy-mm-dd.

CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  username             TEXT    NOT NULL UNIQUE,
  full_name            TEXT    NOT NULL,
  title                TEXT    NOT NULL DEFAULT '',
  email                TEXT    NOT NULL DEFAULT '',
  role                 TEXT    NOT NULL CHECK (role IN ('admin', 'vanthu', 'xem')),
  password_hash        TEXT    NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  locked               INTEGER NOT NULL DEFAULT 0,
  last_login_at        TEXT,
  created_at           TEXT    NOT NULL,
  created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Sổ văn bản. Trước 18/09/2026 chỉ có đúng hai sổ, viết cứng thành hằng số
-- 'den' | 'di' trong mã; nay sổ là dữ liệu nên một phòng mở được bao nhiêu sổ
-- tùy ý (hai sổ đi song song là ca có thật: sổ chính quyền và sổ Đảng ủy).
--
-- kind quyết định cách đánh số và không đổi được khi sổ đã có văn bản:
--   'den' — số do cơ quan gửi ghi, hệ thống không cấp số, không có bộ đếm
--   'di'  — hệ thống cấp số; prefix/suffix/start_seq/reset_yearly là của
--           RIÊNG sổ này, mỗi sổ một bộ đếm không dính gì nhau
--
-- hidden = ngừng dùng: sổ biến khỏi danh sách của văn thư và không cấp số nữa,
-- nhưng văn bản trong đó còn nguyên và quản trị vẫn tra cứu được. Đó là thứ
-- thay cho việc xóa — xóa một sổ đã phát hành số là xóa mất dấu vết của những
-- số ấy, nên chỉ sổ rỗng mới xóa được.
CREATE TABLE IF NOT EXISTS books (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('den', 'di')),
  prefix       TEXT    NOT NULL DEFAULT '',
  suffix       TEXT    NOT NULL DEFAULT '',
  start_seq    INTEGER NOT NULL DEFAULT 1,
  reset_yearly INTEGER NOT NULL DEFAULT 1,
  hidden       INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);
-- Trùng tên sổ là lỗi nhập liệu chứ không phải nhu cầu: hai dòng "Văn bản đi"
-- trong danh sách thì văn thư không biết đang lấy số ở sổ nào.
CREATE UNIQUE INDEX IF NOT EXISTS idx_books_name ON books(name);

CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- LOẠI sổ, không phải sổ nào. Sổ cụ thể nằm ở book_id (thêm trong db.js).
  -- Giữ lại cột này thay vì dựng lại bảng chỉ để bỏ ràng buộc CHECK: mọi cơ sở
  -- dữ liệu đang chạy đều có nó, và 'den' | 'di' vẫn đúng với mọi hàng vì đó
  -- là kind của sổ chứa hàng đó. Truy vấn theo loại (thống kê đến/đi) đọc cột
  -- này; truy vấn theo sổ đọc book_id.
  book         TEXT    NOT NULL CHECK (book IN ('den', 'di')),
  so_van_ban   TEXT    NOT NULL,
  -- seq/seq_scope chỉ có với văn bản đi do hệ thống cấp số.
  -- seq_scope = '2026' khi reset đầu năm, 'all' khi tăng liên tục.
  seq          INTEGER,
  seq_scope    TEXT,
  year         INTEGER NOT NULL,
  ngay_gui     TEXT    NOT NULL,
  nguoi_gui    TEXT    NOT NULL DEFAULT '',
  ten_van_ban  TEXT    NOT NULL,
  do_bao_mat   TEXT    NOT NULL DEFAULT 'Thường'
                       CHECK (do_bao_mat IN ('Thường', 'Mật', 'Tối Mật', 'Tuyệt Mật')),
  ghi_chu      TEXT    NOT NULL DEFAULT '',
  file_name    TEXT,
  file_path    TEXT,
  file_size    INTEGER,
  -- bản không dấu, chữ thường của các cột tìm kiếm, để LIKE bỏ qua dấu
  search_text  TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TEXT,
  updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Xóa mềm: hàng và file đính kèm được giữ lại để quản trị khôi phục được.
  -- Mọi đường đọc sổ phải lọc deleted_at IS NULL.
  deleted_at   TEXT,
  deleted_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_book_date ON documents(book, ngay_gui DESC);
CREATE INDEX IF NOT EXISTS idx_documents_book_year ON documents(book, year);
-- idx_documents_deleted (partial trên deleted_at) tạo trong db.js, KHÔNG ở đây:
-- file này chạy trước bước ALTER TABLE, nên với cơ sở dữ liệu đã có thì cột
-- deleted_at chưa tồn tại và câu CREATE INDEX sẽ làm máy chủ không khởi động nổi.

-- Hai bảo đảm ở tầng dữ liệu (không hai văn bản đi nào trùng số trong cùng
-- năm sổ, và không trùng số thứ tự trong cùng phạm vi đếm) nằm ở db.js chứ
-- KHÔNG ở đây: từ 11/09/2026 cả hai index đều có "AND deleted_at IS NULL" để
-- xóa một văn bản là nhả số của nó ra, mà cột deleted_at chỉ tồn tại sau bước
-- ALTER TABLE trong db.js. Cùng lý do như idx_documents_deleted ở trên.

CREATE TABLE IF NOT EXISTS counters (
  scope    TEXT    PRIMARY KEY,
  next_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT NOT NULL PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT    NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username    TEXT    NOT NULL,
  action      TEXT    NOT NULL,
  detail      TEXT    NOT NULL DEFAULT '',
  -- Văn bản mà việc này tác động tới, để nối dòng nhật ký với văn bản đã xóa.
  -- Không đặt khóa ngoại: dòng nhật ký phải sống lâu hơn mọi thay đổi bảng khác.
  doc_id      INTEGER,
  -- bản không dấu, chữ thường của username + hành động + chi tiết, để tìm kiếm
  search_text TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
-- idx_audit_doc tạo trong db.js, cùng lý do như idx_documents_deleted.
