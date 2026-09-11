# Quản lý số văn bản

Sổ văn bản đến / văn bản đi cho một Phòng 1, chạy trên một máy
chủ trong mạng nội bộ. Cấp số văn bản đi tự động, phân quyền theo vai trò, tài
khoản do quản trị viên cấp.

## Chạy lần đầu

Cần Node.js 18 trở lên.

Muốn xem được tệp Word/Excel ngay trên web thì cần thêm LibreOffice headless —
ứng dụng dùng nó để chuyển `.doc .docx .odt .rtf .xls .xlsx .ods` sang PDF. Ba
gói font kia là bản thay thế ĐÚNG METRIC của Calibri, Cambria và
Arial/Times New Roman; thiếu chúng thì bản chuyển bị lệch canh lề và sai phân
trang so với bản gốc:

```bash
sudo apt install --no-install-recommends \
  libreoffice-writer libreoffice-calc \
  fonts-crosextra-carlito fonts-crosextra-caladea fonts-liberation
```

Khoảng 270 MB. **Không bắt buộc**: thiếu LibreOffice thì mọi thứ khác vẫn chạy
bình thường, chỉ là tệp Office chuyển sang chế độ tải về thay vì xem trên web.

```bash
npm install --omit=dev          # bỏ playwright, chỉ cài phần để chạy thật
npm run init-admin -- --username admin --name "Lê Quốc Bảo" --title "Chánh Văn phòng"
npm start
```

`init-admin` in ra một mật khẩu tạm thời — ghi lại, nó chỉ hiện một lần. Đăng
nhập bằng mật khẩu đó, hệ thống sẽ bắt đổi mật khẩu ngay.

Mở `http://<ip-máy-chủ>:3000` từ các máy trong phòng. Xem IP bằng `hostname -I`
(Linux) hoặc `ipconfig` (Windows).

Muốn xem thử với sổ đã có dữ liệu: `npm run seed-demo` (đừng chạy trên máy dùng
thật — mọi mật khẩu trong đó là mật khẩu mẫu).

## Cấu hình

Đặt qua biến môi trường; xem `.env.example`.

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `PORT` | `3000` | Cổng lắng nghe |
| `HOST` | `0.0.0.0` | `0.0.0.0` cho cả mạng LAN, `127.0.0.1` nếu chỉ máy này |
| `ORG_NAME` | Phòng 1 | Tên đơn vị hiện trên đầu trang |
| `DATA_DIR` | `./data` | Nơi chứa cơ sở dữ liệu và file đính kèm |
| `TRUST_PROXY` | tắt | Đặt `1` khi có nginx/IIS phía trước |

## Deploy lên máy chủ

Bản đã kiểm chứng trên Ubuntu 20.04 + Node 22, chạy như dịch vụ systemd.

Máy chủ đặt trong phòng, chạy **Windows Server 2012 và không nối Internet**? Cách
làm khác hẳn phần dưới đây (không có systemd, `npm install` không chạy được trên
máy chủ) — xem hướng dẫn riêng:
[deploy/HUONG-DAN-LAN.md](deploy/HUONG-DAN-LAN.md).

```bash
# 1. Đưa mã nguồn lên máy chủ (chỉ cần những thứ để chạy)
APP=/opt/quan-ly-so-van-ban        # hoặc ~/apps/quan-ly-so-van-ban
mkdir -p "$APP" && cd "$APP"
# copy: server/ public/ package.json package-lock.json

# 2. Chỉ cài deps để chạy thật (không kéo theo playwright)
npm install --omit=dev

# 3. Cấu hình
cp .env.example .env && nano .env      # đặt PORT, ORG_NAME…

# 4. Tài khoản quản trị đầu tiên
node server/bin/init-admin.js --username admin --name "Lê Quốc Bảo" --title "Chánh Văn phòng"
```

`.env` được `server/env.js` đọc lúc khởi động. Giá trị **không cần bọc nháy**,
kể cả khi có khoảng trắng hay dấu tiếng Việt. Biến đã đặt sẵn từ shell hoặc
systemd luôn thắng `.env`.

### Dịch vụ systemd

Đặt vào `~/.config/systemd/user/van-ban.service` (phạm vi user, không cần sudo):

```ini
[Unit]
Description=Quản lý số văn bản
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/quan-ly-so-van-ban
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=3
ProtectSystem=full
PrivateTmp=true
NoNewPrivileges=true
ReadWritePaths=/opt/quan-ly-so-van-ban/data

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now van-ban.service
systemctl --user status van-ban.service
journalctl --user -u van-ban -f          # xem log
loginctl enable-linger $USER             # để dịch vụ sống qua reboot
```

Muốn chạy ở phạm vi hệ thống thì đặt cùng nội dung vào
`/etc/systemd/system/van-ban.service`, thêm `User=` và `Group=`, rồi dùng
`systemctl` (không có `--user`) — khi đó không cần `enable-linger`.

### Đưa ra ngoài qua nginx (khuyến nghị hơn mở thêm cổng)

Nếu máy chủ đã có nginx, cho nginx làm đường vào duy nhất thì không phải mở thêm
cổng nào trên tường lửa, và có sẵn đường lên HTTPS.

Khi đó **app chỉ nghe localhost** — đặt trong `.env`:

```ini
HOST=127.0.0.1
TRUST_PROXY=1
```

`TRUST_PROXY=1` là bắt buộc: ứng dụng dựa vào `X-Forwarded-Proto` để biết đang
chạy sau HTTPS mà đặt cờ `Secure` cho cookie phiên, và dựa vào `X-Forwarded-For`
để đếm đúng số lần nhập sai mật khẩu theo từng IP thật.

Cấu hình nginx mẫu có trong [deploy/nginx-van-ban.conf](deploy/nginx-van-ban.conf).
Ba dòng dễ bị bỏ sót:

- `proxy_set_header X-Forwarded-Proto $scheme;` — thiếu thì cookie phiên **không
  bao giờ** được đánh `Secure`, kể cả khi đã có HTTPS.
- `client_max_body_size 25m;` — mặc định 1m của nginx nhỏ hơn giới hạn 20 MB của
  file đính kèm, nên nginx sẽ chặn trước khi request tới app.
- `proxy_set_header Host $host;` — để app dựng đúng đường dẫn tải file.

Trình tự cài:

```bash
# 1. Đặt file cấu hình rồi bật site
sudo cp deploy/nginx-van-ban.conf /etc/nginx/sites-available/van-ban.example.vn
sudo ln -s /etc/nginx/sites-available/van-ban.example.vn /etc/nginx/sites-enabled/

# 2. LUÔN kiểm tra trước khi reload — một lỗi cú pháp làm gãy mọi site trên máy
sudo nginx -t && sudo systemctl reload nginx

# 3. Trỏ DNS: thêm bản ghi A  van-ban.example.vn -> <IP máy chủ>

# 4. Sau khi DNS đã phân giải, lấy chứng chỉ; certbot tự thêm khối 443
#    và chuyển hướng 80 -> 443
sudo certbot --nginx -d van-ban.example.vn
```

Kiểm tra trước khi DNS kịp phân giải, bằng cách tự trỏ tên miền về máy:

```bash
curl -I http://van-ban.example.vn/ --resolve van-ban.example.vn:80:127.0.0.1
```

### Mở cổng trên tường lửa

Máy chủ chỉ nghe trên cổng đã cấu hình; các máy khác trong phòng vào được khi
tường lửa cho qua. Nên giới hạn đúng dải mạng nội bộ thay vì mở cho mọi nơi:

```bash
sudo ufw allow from 10.0.0.0/24 to any port 3080 proto tcp    # chỉ mạng nội bộ
sudo ufw status verbose
```

### Phục hồi sau sự cố

Quy trình này đã được thử: xóa sạch `data/` rồi dựng lại từ bản sao lưu, dữ liệu
trở về đầy đủ (tài khoản, mật khẩu đã đổi, văn bản, file đính kèm, vị trí bộ đếm).

```bash
systemctl --user stop van-ban
rm -rf "$APP/data" && mkdir -p "$APP/data"
cp  backups/<ngày_giờ>/vanban.db  "$APP/data/"
cp -r backups/<ngày_giờ>/uploads  "$APP/data/"
systemctl --user start van-ban
```

Nên đặt sao lưu tự động chạy hằng ngày:

```bash
# crontab -e — 6 giờ sáng mỗi ngày
0 6 * * * cd /opt/quan-ly-so-van-ban && node server/bin/backup.js --out /mnt/nas/sao-luu >> /var/log/van-ban-backup.log 2>&1
```

## Vai trò

| | Quản trị | Văn thư | Chỉ xem |
| --- | --- | --- | --- |
| Xem hai sổ | có | có | có |
| Ghi sổ, lấy số, sửa, xóa | có | có | **không** |
| Khôi phục văn bản đã xóa | **có** | không | không |
| Cài đặt lấy số | **có** | không | không |
| Thêm / khóa tài khoản | **có** | không | không |

Phân quyền được chặn ở máy chủ trên từng route, không chỉ ẩn tab trên giao diện.
Người dùng không tự đăng ký ở bất cứ đâu — chỉ quản trị viên tạo tài khoản.

Hệ thống không cho phép các hành động khiến không còn quản trị viên nào đăng nhập
được: không tự hạ quyền mình, không tự khóa mình, không xóa hay khóa tài khoản
quản trị cuối cùng đang hoạt động. Người đã từng ghi sổ thì chỉ khóa được chứ
không xóa được, để giữ dấu vết ai đã ghi văn bản.

## Cấp số văn bản đi

Số văn bản đi là **tiền tố + số thứ tự + hậu tố** — chỉ vậy. Số thứ tự do hệ
thống cấp và tăng đều một đơn vị; hai ô chữ hai bên do **người lấy số tự đặt cho
từng văn bản** ngay trong hộp thoại cấp số. Trang Cài đặt → Lấy số chỉ đặt giá
trị **điền sẵn** cho hai ô đó, kèm "Bắt đầu từ" và "Reset đầu năm".

Sổ văn bản đi **không có đường nhập số bằng tay**: mọi số đều đi qua nút "Lấy số
gửi văn bản đi", và số đã cấp thì không sửa được nữa. Máy chủ từ chối luôn mọi
lệnh ghi tay vào sổ đi, không chỉ là giao diện ẩn nút đi.

**Số không bao giờ có 0 ở đầu** — `6/2026`, không phải `06/2026`. Đây là quy tắc
cố định, không có tùy chọn tắt. Số của **văn bản đến** thì giữ nguyên như cơ quan
gửi ghi (`05/TTr-TCT` không bị đổi), vì đó là số của người khác — và sổ đến vẫn
ghi tay bình thường.

Việc chiếm số và ghi văn bản vào sổ nằm trong **cùng một transaction**. Hai văn
thư bấm "Lấy số" cùng lúc sẽ nhận hai số khác nhau, và không bao giờ có số bị
chiếm mà văn bản không vào sổ.

### Trùng số chỉ xét số thứ tự

Từ 11/09/2026, thứ duy nhất hệ thống bảo đảm không trùng là **số thứ tự trong
cùng phạm vi đếm** — một ràng buộc UNIQUE ở tầng dữ liệu. Tiền tố và hậu tố
**không** được xét tới.

Đó là hệ quả bắt buộc của việc cho người lấy số tự đặt hai ô đó: nếu vẫn khóa
theo chuỗi số ghép ra, thì hai lượt cấp hoàn toàn hợp lệ — số 7 của sổ 2025 với
hậu tố `/2026`, và số 7 của sổ 2026 — sẽ cùng ra `7/2026` và bị chặn oan ở tầng
dữ liệu, ngay giữa lúc văn thư đang lưu. Ngược lại, vì hai ô chữ không đụng được
vào phần số, hai văn bản đi trong cùng một sổ **không bao giờ** mang cùng số thứ
tự dù ai gõ gì vào tiền tố hậu tố.

Số hiện trên nút "Lấy số" là **số dự kiến**. Số thật được chốt lúc bấm lưu. Nếu
số cấp ra khác số dự kiến, giao diện **bật hộp thoại** bắt người dùng xác nhận —
không dùng toast, vì toast tự tắt còn số dự kiến có thể đã được ghi hoặc in lên
bản giấy. Hộp thoại hiện số dự kiến (gạch ngang) cạnh số đã cấp, nói rõ lý do, và
nhắc sửa lại bản giấy. Hai lý do có thể xảy ra:

- **Người khác lấy trước** — trong lúc bạn nhập, số ấy đã bị chiếm; hệ thống
  chuyển sang số trống kế tiếp để không cấp trùng.
- **Khác năm sổ** — ngày gửi rơi vào năm khác, nên số được cấp theo sổ năm đó
  chứ không theo số dự kiến của năm hiện tại.

Khi số cấp ra đúng bằng số dự kiến thì chỉ báo bằng toast như thường.

### Xóa văn bản là nhả số ra

Số chỉ bị giữ chừng nào còn một văn bản **trong sổ** mang nó. Xóa văn bản đó đi
là số được trả lại (quy tắc chốt 11/09/2026):

- **Xóa văn bản** kéo bộ đếm về đúng số vừa xóa, nên người bấm "Lấy số" tiếp
  theo nhận lại chính số ấy. Đây là ca hay gặp nhất: văn thư lấy nhầm số, xóa
  đi, lấy lại — sổ không thủng một lỗ. Ghi tay lại số đó cũng được.
- **Khôi phục thì không chắc giữ được số cũ.** Nếu trong lúc văn bản nằm ngoài
  sổ mà số của nó đã sang tay văn bản khác, hệ thống cấp cho nó **số trống kế
  tiếp** và báo rõ số cũ → số mới (đã ghi số cũ lên bản giấy thì phải sửa). Số
  cũ còn trống thì văn bản giữ nguyên số của mình. Trang Nhật ký nói trước điều
  này ngay trên dòng "Xóa văn bản", trước khi bấm.
- **Đặt lại bộ đếm** vẫn bị chặn dưới bởi số thứ tự lớn nhất **đang có văn bản
  trong sổ** dùng, cộng một. Lùi vào vùng đó vô nghĩa: bộ đếm sẽ bò ngay trở lại
  chỗ cũ vì phải nhảy qua các số đang dùng. Vẫn sửa được ca nhập nhầm (gõ 500
  lúc chưa phát hành số nào ở đó thì kéo về được).
- Nếu số kế tiếp tình cờ đã bị một văn bản nhập tay chiếm chuỗi số, hệ thống nhảy
  tới số trống kế tiếp và nói rõ số thực tế sẽ cấp, thay vì cấp trùng.

Hai ràng buộc UNIQUE ở tầng dữ liệu đều có `AND deleted_at IS NULL` và nằm trong
`db.js` chứ không phải `schema.sql` — cột `deleted_at` chỉ tồn tại sau bước
`ALTER TABLE`. Bỏ điều kiện đó đi là quay về quy tắc cũ "số giữ chỗ vĩnh viễn".

## Sao lưu

```bash
npm run backup                              # vào ./backups/<ngày_giờ>/
npm run backup -- --out /mnt/nas/sao-luu    # hoặc nơi khác
```

Mỗi lần sao lưu tạo một thư mục gồm:

- `vanban.db` — **toàn bộ** sổ văn bản, tài khoản, cài đặt và nhật ký, trong một
  file duy nhất.
- `uploads/` — các file đính kèm (bản scan PDF, ảnh…).

Script dùng `VACUUM INTO` của SQLite chứ không copy trần file `.db`, và **chạy
được ngay lúc đang có người dùng hệ thống**. Đây là điểm quan trọng: ở chế độ WAL,
các giao dịch vừa xong còn nằm trong `vanban.db-wal` bên cạnh, nên `cp vanban.db`
có thể ra bản thiếu giao dịch hoặc bản lỗi. `VACUUM INTO` để SQLite tự dựng một
file mới nhất quán.

Phục hồi: dừng ứng dụng, copy `vanban.db` và `uploads/` vào `data/`, chạy lại.

Nếu muốn sao lưu đúng nghĩa **một file**, có thể chuyển file đính kèm vào lưu
trong cơ sở dữ liệu dạng BLOB — đánh đổi là cơ sở dữ liệu phình theo dung lượng
scan và bản chụp sao lưu chậm dần theo năm.

## Kiểm thử

```bash
npm install            # cần cả devDependencies (playwright)
npm test
```

`npm test` dựng một cơ sở dữ liệu tạm, chạy máy chủ trên cổng riêng, rồi chạy hai
bộ: `test/api.test.mjs` (98 phép thử qua HTTP thật — phân quyền, cấp số đồng thời,
bỏ số 0 ở đầu, ràng buộc tài khoản, xóa mềm và khôi phục, nhả số khi xóa) và
`test/ui.test.mjs` (93 phép thử qua
Chromium thật — cả ba vai trò, các luồng bấm, màn hình 400px). `data/` của bản
đang dùng không bị đụng tới.

Nếu Playwright không tải được Chromium cho máy này, trỏ vào bản có sẵn:

```bash
CHROME_PATH=~/.cache/ms-playwright/chromium-1234/chrome-linux/chrome npm test
```

## Cấu trúc mã nguồn

```
server/
  index.js        máy chủ Express, header bảo mật, xử lý lỗi
  db.js           mở SQLite (WAL, synchronous=FULL), migration cột thêm sau, cài đặt, nhật ký
  schema.sql      lược đồ dữ liệu và các ràng buộc chống trùng số
  auth.js         băm mật khẩu scrypt, phiên, chặn theo vai trò, chống dò mật khẩu
  numbering.js    ghép số, kiểm tra cấu hình, chiếm số nguyên tử
  routes/         auth · docs · settings · users
  bin/            init-admin · backup · seed-demo
public/
  index.html      vỏ trang
  app.css         bảng màu và thang đo lấy từ bản thiết kế
  app.js          giao diện thuần, không cần bước build
data/             vanban.db và uploads/ (không đưa vào git)
```

Không có bước build, không có framework phía trình duyệt. Giao diện dựng DOM bằng
`el()`; mọi dữ liệu người dùng đi qua `textContent`, không bao giờ qua `innerHTML`.

## Ghi chú kỹ thuật

- **Mật khẩu**: scrypt (N=16384, r=8, p=1) với muối riêng từng người, so sánh
  bằng `timingSafeEqual`. Không lưu bản đọc được ở bất cứ đâu.
- **Phiên**: id ngẫu nhiên 32 byte trong cookie `HttpOnly` `SameSite=Strict`, hạn
  12 giờ, lưu trong cơ sở dữ liệu. Khóa tài khoản hay đặt lại mật khẩu sẽ cắt
  ngay mọi phiên đang mở của người đó.
- **CSRF**: mọi request thay đổi dữ liệu phải có header `X-VB-Request: 1`. Trình
  duyệt không đặt được header tự chọn cho request khác nguồn mà không qua
  preflight CORS, và máy chủ này không bật CORS.
- **CSP**: `default-src 'self'`, không có ngoại lệ nào cho `unsafe-inline`. Vì
  vậy **không được** dùng thuộc tính `style=` trong `app.js` — thêm class vào
  `app.css` thay vì đặt style trực tiếp, nếu không style sẽ bị chặn âm thầm.
- **Dựng lại DOM và ô đang gõ**: `render()` thay toàn bộ DOM, nên các ô nhập chỉ
  dùng `oninput` (không dùng `onchange`) và có `fk` để khôi phục focus cùng vị
  trí con trỏ. Nếu dùng `onchange`, lúc người dùng gõ xong rồi bấm nút thì
  `change` kích hoạt render giữa mousedown và mouseup, và cú bấm đầu tiên bị mất.
- **Không tải gì từ Internet**: không webfont, không CDN. Chạy được trong mạng nội
  bộ không có đường ra ngoài. Đổi lại, giao diện dùng font hệ thống thay vì font
  riêng như trong bản thiết kế.
- **Tìm kiếm không phụ thuộc dấu**: mỗi văn bản có thêm cột `search_text` đã bỏ
  dấu và hạ chữ thường; tìm "chuyen doi so" ra "Chuyển đổi số". Nhật ký cũng có
  cột như vậy, và nó chứa cả **tên tiếng Việt** của việc chứ không chỉ mã, để gõ
  "xoa van ban" ra dòng có `action = 'xoa_van_ban'`. Tên việc định nghĩa một chỗ
  duy nhất trong `util.js` rồi gửi cho giao diện qua `/api/config`.
- **Migration**: `schema.sql` chạy bằng `CREATE TABLE IF NOT EXISTS`, nên với cơ
  sở dữ liệu đã có thì thêm cột vào file đó **không có tác dụng gì** — phải
  `ALTER TABLE`. `db.js` làm việc đó lúc khởi động, chạy nhiều lần không hỏng, và
  phải chạy trước khi bất kỳ module nào `prepare` câu lệnh. Vì thế index dạng
  partial trên cột thêm sau (`idx_documents_deleted`, `idx_audit_doc`) **không**
  đặt trong `schema.sql`: file đó chạy trước bước ALTER, câu `CREATE INDEX` sẽ
  tham chiếu cột chưa tồn tại và làm máy chủ không khởi động nổi.
- **File đính kèm**: tối đa 20 MB, giới hạn theo phần mở rộng. Tên file trên đĩa
  do máy chủ sinh ngẫu nhiên; tên gốc của người dùng không bao giờ đi vào đường
  dẫn hệ thống tệp.
- **`synchronous = FULL`**: mỗi lần ghi chậm hơn vài ms, đổi lại sổ văn bản không
  mất giao dịch đã báo thành công kể cả khi máy mất điện.

## Nhật ký và khôi phục văn bản đã xóa

Trang Cài đặt → Nhật ký ghi lại mọi việc: đăng nhập, cấp số, ghi/sửa/xóa/khôi
phục văn bản, sửa cài đặt lấy số, đặt lại bộ đếm, và mọi thay đổi tài khoản —
kèm tên người làm và thời điểm. Tìm được theo từ khóa (không cần dấu, như tìm
trong sổ), lọc theo loại việc, và nạp dần từng đợt 200 dòng.

**Xóa văn bản là xóa mềm.** Hàng và file đính kèm được giữ nguyên, chỉ đánh dấu
`deleted_at`. Văn bản ra khỏi sổ và khỏi mọi thống kê, nhưng vẫn nằm trong nhật
ký — quản trị viên tìm dòng "Xóa văn bản" rồi bấm **Khôi phục** để đưa nó trở
lại sổ cùng file đính kèm. Văn thư xóa được nhưng không tự khôi phục được.

Việc này không bao giờ thất bại vì trùng số, nhưng **có thể đổi số**: xóa là nhả
số ra, nên số cũ có thể đã thuộc về văn bản khác lúc khôi phục. Xem mục
"Xóa văn bản là nhả số ra" ở trên.

Mỗi dòng "Xóa văn bản" có một trong ba trạng thái:

| Trạng thái | Nghĩa |
| --- | --- |
| có nút **Khôi phục** | văn bản còn đó, đang bị xóa mềm |
| **Đã khôi phục** | đã được đưa trở lại sổ sau lần xóa này |
| **Không còn dữ liệu** | xóa trước khi có tính năng này (khi đó là xóa hẳn) — nhật ký chỉ còn dòng mô tả |

Văn bản đã xóa vẫn chiếm dung lượng đĩa vì file đính kèm được giữ lại. Hiện chưa
có bước xóa vĩnh viễn; nếu làm thì nó chỉ cần dọn file và nội dung — số đã được
nhả ra ngay từ lúc xóa mềm, nên không còn ràng buộc nào bắt phải giữ lại hàng.
Chỉ nhớ rằng `DELETE` hẳn hàng thì mất luôn đường khôi phục từ nhật ký.
