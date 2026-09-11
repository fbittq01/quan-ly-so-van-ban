# Trình tự bàn giao — đưa mã nguồn vào máy chủ nội bộ bằng cách copy

Bối cảnh đã chốt: máy chủ **Windows Server 2012 trong LAN, không nối Internet**,
**bắt đầu với dữ liệu sạch** (không mang `data/` của máy hiện tại sang), và mã
nguồn đi bằng **copy** chứ không `git clone` — máy chủ không ra được Internet mà
kho mã cũng chưa nằm trên máy chủ git nội bộ nào.

Tài liệu này chỉ sắp thứ tự việc và nói phần riêng của hướng đi copy. Các bước
cài đặt chi tiết nằm trong [HUONG-DAN-LAN.md](HUONG-DAN-LAN.md), gọi tắt là
*HD* bên dưới.

---

## Giai đoạn A — trên máy này (Linux, đang phát triển)

**A1. Hỏi trước ba thông tin về máy chủ**, vì chúng đổi cả đường đi:

- `systeminfo | findstr /B /C:"OS Name" /C:"OS Version" /C:"System Type"` —
  phân biệt 2012 R2 (`6.3`) với 2012 non-R2 (`6.2`), và x64 hay x86 (*HD* mục 0).
  **2012 non-R2 hoặc Windows 32-bit là rủi ro thật, có thể phải đổi máy chủ** —
  biết sớm còn kịp, biết lúc đang cắm USB thì hỏng cả buổi.
- IP tĩnh của máy chủ, và dải mạng của phòng (để mở tường lửa đúng dải).
- Chỗ sao lưu: ổ chia sẻ / NAS / ổ cắm ngoài — không sao lưu vào chính máy chủ.

**A2. Đóng gói mã nguồn:**

```bash
bash deploy/dong-goi-ma-nguon.sh
# -> ../van-ban-manguon-YYYYMMDD.zip  +  file .sha256 đi kèm
```

Gói chỉ có `server/ public/ package.json package-lock.json .env.example
README.md deploy/`. Cố ý **không** có: `node_modules/` (cài trên Windows ở B2),
`data/` và `.env` (dữ liệu và cấu hình của máy này), file thiết kế `*.dc.html`.

**A3. Kiểm tra gói trước khi giao** — mở `.zip` xem đúng 51 file, không có
`.env`, không có `data/`. Giữ lại file `.sha256` để đối chiếu sau khi copy qua
USB; USB hỏng âm thầm là chuyện có thật.

---

## Giai đoạn B — trên một máy **Windows 64-bit có Internet**

Bắt buộc là máy Windows: `better-sqlite3` chứa một file nhị phân biên dịch riêng
cho từng hệ điều hành. `node_modules` lấy từ Linux mang sang Windows sẽ không
chạy, và `node_modules` ở máy này còn là bản aarch64 nữa.

**B1.** Tải Node.js LTS đúng dạng cho máy chủ — `.msi` cho 2012 R2, `.zip` cho
2012 non-R2 (*HD* mục 1.1). Máy làm gói này phải cài **cùng số phiên bản lớn**,
nếu không máy chủ sẽ báo `NODE_MODULE_VERSION`.

**B2.** Giải nén gói ở A2 rồi `npm install --omit=dev`, và kiểm tra ngay:

```bat
node -e "require('better-sqlite3'); console.log('ok')"
```

**B3.** Tải NSSM (*HD* mục 1.3), gom tất cả vào USB theo cây thư mục ở *HD*
mục 1.4, quét virus USB.

---

## Giai đoạn C — trên máy chủ

Theo *HD* tuần tự, không nhảy cóc: mục 2 (cài Node) → 3 (đặt thư mục, phân
quyền) → 4 (`.env`) → 5 (`npm run init-admin`) → 6 (chạy thử tay) → 7 (tường
lửa) → 8 (Windows Service + **bắt buộc khởi động lại máy để kiểm tra**) → 9
(sao lưu tự động) → 11 (đồng hồ máy chủ).

Vì bắt đầu sạch nên **không chạy `npm run seed-demo`** trên máy chủ — nó tạo tài
khoản demo có mật khẩu in sẵn trong mã nguồn.

Kết thúc bằng danh sách kiểm tra ở cuối *HD* ("Danh sách kiểm tra khi bàn giao").

---

## Giai đoạn D — nói trước với phòng

Ngoài hai điều ở *HD* mục 10, thêm một điều nữa của môi trường Windows:

> **Tệp Word/Excel đính kèm sẽ không xem được ngay trên web, chỉ tải về.**
> Chức năng xem trước dựa vào LibreOffice headless và hiện chỉ dò tìm trên
> Linux (`server/convert.js`). Trên Windows ứng dụng tự biết là không có và hiện
> nút tải về — không lỗi, nhưng khác với những gì phòng thấy lúc demo. Tệp PDF
> vẫn xem trực tiếp bình thường.

---

## Cập nhật bản mới về sau

Vẫn theo đường copy, và đây là lý do nên giữ `deploy/dong-goi-ma-nguon.sh`:

1. Máy này: chạy lại script đóng gói.
2. Máy Windows có Internet: giải nén, `npm install --omit=dev` lại **nếu
   `package.json` có đổi**; không đổi thì mang mỗi `server/` và `public/`.
3. Máy chủ: theo *HD* mục "Cập nhật lên bản mới" — dừng service, sao lưu `data/`
   trước, chép đè `server/` `public/`, chạy lại service.

**Không bao giờ chép đè `data/` và `.env`** — đó là toàn bộ dữ liệu thật và cấu
hình riêng của máy chủ.

Về lâu dài, nếu nội bộ có máy chủ Git thì đẩy kho mã lên đó và giai đoạn A rút
còn một lệnh `git archive`. Chừng nào chưa có, script đóng gói là thứ giữ cho
mỗi lần giao đều ra đúng một bộ file như nhau.
