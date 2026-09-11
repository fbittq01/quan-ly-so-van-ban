# Hướng dẫn deploy trên máy chủ LAN — Windows Server 2012, không có Internet

Dành cho trường hợp: **một máy chủ Windows Server 2012 đặt trong phòng, không nối
Internet**, các máy trong mạng nội bộ vào bằng địa chỉ IP.

Hai điều kiện đó đổi khá nhiều thứ so với cách deploy thông thường:

- **Không có Internet** → `npm install` trên máy chủ sẽ không chạy được. Phải
  chuẩn bị sẵn một *gói mang tay* trên máy khác rồi copy qua USB (mục 1). Không
  lấy được chứng chỉ HTTPS của Let's Encrypt, nên hệ thống chạy HTTP trong LAN
  (mục 10).
- **Windows Server 2012** → không có systemd; app chạy như **Windows Service**
  (mục 8), sao lưu bằng **Task Scheduler** (mục 9), tường lửa bằng
  `netsh advfirewall` (mục 7). Và trước hết, cần đọc kỹ mục 0 — bản 2012 không
  phải nền tảng được Node hỗ trợ chính thức.

Bản thân ứng dụng chạy được trên Windows: mọi đường dẫn trong mã nguồn dựng bằng
`path.join` / `path.sep` chứ không nối chuỗi bằng `/`, không có bước build, và
lúc chạy không tải gì từ Internet — font và script đều nằm trong `public/` do
chính máy chủ phục vụ.

Nếu máy chủ là Linux hoặc có Internet, xem mục *Deploy lên máy chủ* trong
[README.md](../README.md) thay cho tài liệu này.

---

## 0. Trước khi bắt đầu: xác định đúng phiên bản Windows

**Bắt buộc làm trước tiên.** "Windows Server 2012" và "Windows Server 2012 R2" là
hai hệ điều hành khác nhau, và Node.js đối xử với chúng khác nhau. Trên máy chủ,
mở `cmd` và chạy:

```bat
systeminfo | findstr /B /C:"OS Name" /C:"OS Version" /C:"System Type"
```

| Kết quả | Nghĩa là | Đường đi |
| --- | --- | --- |
| `OS Version: 6.3.xxxx` — "Server 2012 R2" | **R2** | Cài Node bằng bản `.msi` như bình thường (mục 2A) |
| `OS Version: 6.2.xxxx` — "Server 2012" | **không phải R2** | Bản `.msi` sẽ **từ chối cài**. Dùng bản `.zip` (mục 2B) |
| `System Type: x86-based PC` | Windows 32-bit | Dừng lại: chỉ có bản Node x64 dùng được ở đây |

Trên bản 2012 non-R2, bộ cài `.msi` của Node dừng với thông báo *"Node.js is only
supported on Windows 8.1, Windows Server 2012 R2, or higher"* — đó là điều kiện
chặn trong chính bộ cài. Bản `.zip` không có điều kiện đó nên vẫn giải nén và
chạy được, và mục 2B kèm một bước kiểm tra để biết chắc nó chạy thật.

Cần biết trước hai giới hạn, để quyết định có deploy ở đây hay không:

- Trong bảng nền tảng của Node.js, `Windows 8.1/Server 2012` ở mức
  **Experimental** — hệ thống kiểm thử tự động của Node không chạy trên nó, nên
  không ai bảo đảm mọi bản Node mới đều còn chạy. Mức Tier 1 (được bảo đảm) là
  từ **Windows 10 / Server 2016** trở lên. Ứng dụng này cần Node 18 trở lên
  (Express 5 khai `node >= 18`, mã nguồn dùng `require('node:fs')`), nên **không
  có đường lùi về Node 16** cho bản Windows cũ hơn.
- Windows Server 2012 đã **hết hạn hỗ trợ bảo mật từ 10/10/2023** — không còn bản
  vá. Máy không nối Internet nên rủi ro thấp hơn nhiều, nhưng đây là lý do nên có
  kế hoạch chuyển sang Server 2016+ hoặc một máy Linux, và là lý do phải giữ
  đúng nguyên tắc "máy này không ra Internet".

Nếu mục 2B không chạy được, ba lựa chọn theo thứ tự dễ làm: nâng máy chủ lên
Server 2016+; hoặc cài Node trên một máy Windows khác trong phòng đã đủ mới; hoặc
dựng một máy ảo Linux nhỏ trên chính máy chủ này (khi đó dùng README).

**Chuẩn bị thêm:**

| | |
| --- | --- |
| Địa chỉ IP | **IP tĩnh**. IP đổi là cả phòng mất đường vào |
| Đồng hồ máy chủ | Phải đúng **ngày, năm và múi giờ** — số văn bản cấp theo năm (mục 11) |
| Tài khoản Windows | Một tài khoản để chạy dịch vụ, có quyền ghi vào thư mục dữ liệu |
| Nơi sao lưu | Ổ chia sẻ / NAS / ổ cắm ngoài — **không** sao lưu vào chính máy chủ |
| USB | Để mang gói cài từ máy có Internet sang |

---

## 1. Chuẩn bị gói mang tay (trên máy CÓ Internet)

Làm bước này trên một máy **Windows 64-bit** có Internet. Phải là máy Windows:
thư viện `better-sqlite3` chứa một file nhị phân biên dịch riêng cho từng hệ điều
hành, nên `node_modules` lấy từ máy Linux hoặc macOS mang sang Windows sẽ **không
chạy**.

**1.1 — Tải Node.js** từ <https://nodejs.org/dist/> (chọn bản LTS, ví dụ 22.x):

- Máy chủ là **2012 R2** → tải `node-v22.x.x-x64.msi`
- Máy chủ là **2012 non-R2** → tải `node-v22.x.x-win-x64.zip`

Ghi nhớ **số phiên bản lớn** đã tải (ví dụ 22). Máy chuẩn bị gói phải cài đúng
cùng số phiên bản lớn đó, nếu không file nhị phân ở bước 1.2 sẽ lệch phiên bản
và máy chủ báo lỗi `NODE_MODULE_VERSION`.

**1.2 — Cài thư viện.** Copy mã nguồn vào một thư mục trên máy này, rồi:

```bat
cd C:\goi-van-ban
npm install --omit=dev
```

`--omit=dev` bỏ Playwright (chỉ dùng để kiểm thử, rất nặng). Kiểm tra file nhị
phân đã có đúng bản Windows:

```bat
dir node_modules\better-sqlite3\build\Release\better_sqlite3.node
node -e "require('better-sqlite3'); console.log('ok')"
```

**1.3 — Tải NSSM** (để chạy app như một Windows Service) từ
<https://nssm.cc/download> — `nssm-2.24.zip`, dùng `win64\nssm.exe`.

**1.4 — Gom vào USB** đúng cây thư mục sau:

```
USB:\van-ban\
  node-v22.x.x-win-x64.zip   (hoặc .msi)
  nssm.exe
  app\
    server\                  mã nguồn
    public\                  giao diện, font
    node_modules\            đã cài ở bước 1.2 — thư mục nặng nhất
    package.json
    package-lock.json
    .env.example
```

Không cần mang: `test\`, `data\`, các file `*.dc.html`, `canvas.json` — đó là file
kiểm thử và thiết kế.

> Quét virus USB trước khi cắm vào máy chủ. Đây là đường duy nhất dữ liệu từ
> ngoài vào máy này, nên cũng là đường duy nhất mã độc có thể đi vào.

---

## 2. Cài Node.js trên máy chủ

### 2A. Bản 2012 R2 — dùng .msi

Chạy file `.msi`, giữ mọi tùy chọn mặc định. Bỏ qua mục "Tools for Native
Modules" (chỉ cần khi biên dịch, mà ta đã mang sẵn bản biên dịch rồi). Mở `cmd`
**mới** rồi kiểm tra:

```bat
node -v
```

### 2B. Bản 2012 non-R2 — dùng .zip

PowerShell 3.0 trên Server 2012 chưa có `Expand-Archive`, nên giải nén bằng
Explorer: bấm phải file `.zip` → *Extract All*. Sau đó:

```bat
:: 1. Đặt vào C:\nodejs (bên trong phải thấy node.exe, npm.cmd)
move C:\Temp\node-v22.x.x-win-x64 C:\nodejs
dir C:\nodejs\node.exe

:: 2. Thêm vào PATH của máy (cần cmd chạy bằng Administrator)
setx /M PATH "%PATH%;C:\nodejs"
```

Đóng `cmd` và mở lại (PATH chỉ áp dụng cho tiến trình mới), rồi:

```bat
node -v
```

**Nếu `node -v` báo lỗi** dạng *"is not a valid Win32 application"*, *"The
procedure entry point ... could not be located"* hoặc thoát ngay không in gì thì
bản Node đó không chạy được trên hệ điều hành này. Thử lần lượt: bản Node 18.20.x
(`node-v18.20.x-win-x64.zip`) → nếu vẫn không được thì quay lại ba lựa chọn ở
mục 0. Đừng đi tiếp các bước sau khi `node -v` chưa in ra số phiên bản.

---

## 3. Đặt ứng dụng và phân quyền thư mục

Copy thư mục `app\` từ USB vào `C:\apps\quan-ly-so-van-ban` (copy cả
`node_modules`, không cần cài gì thêm).

**Kiểm tra ngay hai thứ quan trọng nhất** — đây là chỗ hay gãy nhất của cả quy
trình:

```bat
cd C:\apps\quan-ly-so-van-ban
node -e "require('better-sqlite3'); console.log('thu vien: ok')"
```

| Lỗi | Nguyên nhân | Xử lý |
| --- | --- | --- |
| `NODE_MODULE_VERSION 115 ... requires 127` | máy chuẩn bị gói và máy chủ khác phiên bản Node lớn | Cài lại `node_modules` ở bước 1.2 bằng đúng bản Node lớn của máy chủ |
| `not a valid Win32 application` | `node_modules` lấy từ máy Linux/macOS | Làm lại bước 1.2 trên máy **Windows x64** |
| `Cannot find module` | thiếu `node_modules` khi copy | Copy lại, thư mục này rất nhiều file nên dễ copy dở |

Ứng dụng sẽ tự tạo `C:\apps\quan-ly-so-van-ban\data` để chứa cơ sở dữ liệu và
file đính kèm. Tài khoản chạy dịch vụ (mục 8) **phải có quyền ghi** vào đó:

```bat
icacls "C:\apps\quan-ly-so-van-ban\data" /grant "DOMAIN\svc-vanban":(OI)(CI)F
```

Thiếu quyền ghi thì app khởi động và chết ngay với lỗi mở cơ sở dữ liệu
(`SQLITE_CANTOPEN`) — không phải lỗi cấu hình, chỉ là quyền NTFS.

---

## 4. Tạo file cấu hình `.env`

Đây là bước có nhiều bẫy nhất trên Windows, nên **đừng tạo file này bằng
Notepad**. Ba cái bẫy dưới đây đều làm hệ thống chạy sai mà **không báo lỗi gì**
— đã thử trực tiếp với `server/env.js` để biết chính xác từng trường hợp hỏng ra
sao:

- **Tên file thành `.env.txt`** — Notepad tự thêm phần mở rộng, mà Windows mặc
  định lại ẩn phần mở rộng nên nhìn trong Explorer vẫn thấy là `.env`. File bị bỏ
  qua hoàn toàn. Bật *View → File name extensions* để thấy tên thật.
- **Lưu dạng "Unicode" (UTF-16)** — nguy hiểm nhất: **mọi biến đều bị bỏ qua**, app
  im lặng chạy bằng giá trị mặc định. Tên phòng thành "Phòng 1", `PORT` quay về
  3000, `DATA_DIR` bị lờ đi — trông như file `.env` không hề tồn tại.
- **Lưu dạng "ANSI"** — app vẫn đọc được `PORT` và `HOST`, chỉ riêng chữ có dấu
  bị hỏng: `Phòng Hành chính` hiện lên thành `Pho?ng Ha?nh chi?nh`.

Hai điều **không** phải vấn đề, nói rõ để không mất thời gian: UTF-8 **có BOM
vẫn chạy đúng** (mỗi dòng được `trim()` trước khi phân tích, và BOM bị xóa cùng
khoảng trắng), và **dòng CRLF của Windows cũng không sao**. Đường dẫn Windows
viết nguyên văn một dấu `\`, không cần nhân đôi.

Cách chắc chắn — dán cả khối này vào PowerShell (chạy như Administrator), nó ghi
đúng UTF-8:

```powershell
$lines = @(
  '# Cau hinh - khong bao gia tri trong dau nhay',
  'ORG_NAME=Phòng Hành chính — Văn thư',
  'PORT=3000',
  'HOST=0.0.0.0'
)
$path = 'C:\apps\quan-ly-so-van-ban\.env'
[IO.File]::WriteAllLines($path, $lines, (New-Object Text.UTF8Encoding($false)))
Get-Content $path
```

Dùng `[IO.File]::WriteAllLines` vì nó ghi UTF-8 và không phụ thuộc cấu hình bảng
mã của cửa sổ PowerShell. (`Set-Content -Encoding utf8` của PowerShell 5 trở
xuống ghi kèm BOM — ở đây vô hại, nhưng `Out-File` mặc định thì ghi UTF-16 và sẽ
rơi đúng vào cái bẫy nguy hiểm nhất ở trên.)

Ý nghĩa các giá trị:

- `HOST=0.0.0.0` — để các máy khác trong phòng vào được. Đặt `127.0.0.1` là chỉ
  mở được trên chính máy chủ.
- `PORT=3000` — cứ để trên 1024. Kiểm tra chưa ai chiếm: `netstat -ano | findstr :3000`.
- `ORG_NAME` — tên hiện trên đầu trang, viết có dấu bình thường, **không bọc nháy**.
- **Không** đặt `TRUST_PROXY` — biến đó chỉ dành cho khi có proxy (IIS/nginx)
  đứng trước. Bật sai làm việc chặn dò mật khẩu theo IP đếm nhầm.
- Muốn để dữ liệu ở ổ khác thì thêm `DATA_DIR=D:\van-ban\data` — viết đường dẫn
  Windows nguyên văn, không cần nhân đôi dấu `\`.

Kiểm tra app đọc đúng cấu hình:

```bat
node -e "require('./server/env'); console.log(process.env.ORG_NAME, process.env.PORT, process.env.HOST)"
```

Phải in ra tên phòng **có dấu đầy đủ**, kèm `3000` và `0.0.0.0`. In ra
`undefined` cả ba là file sai tên, sai vị trí, hoặc đang lưu dạng UTF-16; ra chữ
lỗi mã là đang lưu dạng ANSI. Đừng bỏ qua bước kiểm tra này — cả hai trường hợp
đó đều **không** làm app báo lỗi khi khởi động.

---

## 5. Tạo tài khoản quản trị đầu tiên

```bat
cd C:\apps\quan-ly-so-van-ban
node server\bin\init-admin.js --username admin --name "Lê Quốc Bảo" --title "Chánh Văn phòng"
```

Lệnh in ra một **mật khẩu tạm thời — chỉ hiện một lần**. Ghi lại ngay và đưa trực
tiếp cho người quản trị; hệ thống bắt đổi mật khẩu ở lần đăng nhập đầu tiên.

Đây là đường duy nhất tạo tài khoản mà không cần đăng nhập trước, và chỉ chạy
được từ dòng lệnh trên chính máy chủ. Mọi tài khoản còn lại (văn thư, chỉ xem) do
quản trị viên tạo trong giao diện — không ai tự đăng ký được.

Nếu tên hiện trong giao diện bị lỗi dấu (do bảng mã của cửa sổ `cmd`), cứ vào
Cài đặt → Tài khoản sửa lại tên; không cần chạy lại lệnh.

Mất mật khẩu quản trị về sau: `node server\bin\init-admin.js --username admin --reset-password`.

> Đừng chạy `npm run seed-demo` trên máy dùng thật: nó đổ dữ liệu mẫu và mọi mật
> khẩu trong đó là mật khẩu mẫu ai cũng biết.

---

## 6. Chạy thử bằng tay

Trước khi dựng dịch vụ, chạy tay để thấy lỗi ngay trên màn hình:

```bat
cd C:\apps\quan-ly-so-van-ban
node server\index.js
```

Mở một cửa sổ PowerShell khác, kiểm tra trên chính máy chủ:

```powershell
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/).StatusCode
```

Phải ra `200`. (`-UseBasicParsing` là bắt buộc trên Server 2012 — không có nó,
PowerShell gọi Internet Explorer để phân tích trang và sẽ treo hoặc lỗi.)

Để cửa sổ `node` đó chạy, sang mục 7 mở tường lửa rồi thử từ máy khác. Xong thì
`Ctrl+C` để tắt trước khi sang mục 8.

---

## 7. Mở cổng trên tường lửa cho đúng dải mạng của phòng

```bat
netsh advfirewall firewall add rule name="Quan ly so van ban (LAN)" ^
  dir=in action=allow protocol=TCP localport=3000 remoteip=10.0.0.0/24

netsh advfirewall firewall show rule name="Quan ly so van ban (LAN)"
```

`remoteip` giới hạn đúng dải mạng nội bộ, đừng để `any`. Xem dải thật của phòng
bằng `ipconfig` (ví dụ IP `10.0.0.244` với mask `255.255.255.0` → dải
`10.0.0.0/24`). Phòng dùng nhiều dải (mạng dây và Wi-Fi khác nhau) thì liệt kê
cách nhau bằng dấu phẩy: `remoteip=10.0.0.0/24,10.0.1.0/24`.

Thử từ một máy khác trong phòng, bằng trình duyệt hoặc:

```bat
curl -I http://10.0.0.244:3000/
```

---

## 8. Chạy như một Windows Service

Để app tự chạy lại sau khi lỗi và tự lên sau khi máy chủ khởi động lại.

> **Đừng dùng `sc create` trỏ trực tiếp vào `node.exe`.** `node.exe` không phải
> chương trình dịch vụ, nó không "bắt tay" với Service Control Manager, nên
> Windows sẽ coi là dịch vụ khởi động thất bại rồi tắt đi. Phải có một lớp bọc —
> đó là việc của NSSM.

### 8A. NSSM (khuyến nghị)

Copy `nssm.exe` từ USB vào `C:\nssm\nssm.exe`, rồi trong `cmd` **Administrator**:

```bat
set APP=C:\apps\quan-ly-so-van-ban
set NODE=C:\nodejs\node.exe
:: bản 2012 R2 cài bằng .msi thì NODE là C:\Program Files\nodejs\node.exe

C:\nssm\nssm.exe install van-ban "%NODE%" "server\index.js"
C:\nssm\nssm.exe set van-ban AppDirectory "%APP%"
C:\nssm\nssm.exe set van-ban DisplayName "Quan ly so van ban"
C:\nssm\nssm.exe set van-ban Start SERVICE_AUTO_START

:: Ghi log ra file và tự cắt file khi quá 10 MB
C:\nssm\nssm.exe set van-ban AppStdout "%APP%\logs\van-ban.log"
C:\nssm\nssm.exe set van-ban AppStderr "%APP%\logs\van-ban.err.log"
C:\nssm\nssm.exe set van-ban AppRotateFiles 1
C:\nssm\nssm.exe set van-ban AppRotateBytes 10485760

:: Tự chạy lại sau 5 giây nếu tiến trình chết
C:\nssm\nssm.exe set van-ban AppExit Default Restart
C:\nssm\nssm.exe set van-ban AppRestartDelay 5000

:: Chạy bằng tài khoản có quyền ghi vào data\ (mục 3)
C:\nssm\nssm.exe set van-ban ObjectName "DOMAIN\svc-vanban" "<mật khẩu>"

mkdir "%APP%\logs"
C:\nssm\nssm.exe start van-ban
sc query van-ban
```

`sc query van-ban` phải báo `STATE : 4 RUNNING`. Log ứng dụng nằm ở
`C:\apps\quan-ly-so-van-ban\logs\van-ban.log` — **đây là chỗ xem đầu tiên mỗi khi
có sự cố**.

Về sau: `nssm restart van-ban`, `nssm stop van-ban`, `nssm edit van-ban` (mở cửa
sổ cấu hình), `nssm remove van-ban confirm` (xóa dịch vụ).

### 8B. Không muốn thêm công cụ ngoài — Task Scheduler

Kém hơn 8A ở chỗ khó theo dõi log và phản ứng với crash chậm hơn, nhưng không cần
tải gì:

*Task Scheduler → Create Task*

- **General**: chọn tài khoản chạy ở *Change User or Group*; bật **Run whether
  user is logged on or not**; bật **Run with highest privileges**. Tài khoản đó
  cần quyền *Log on as a batch job* (Local Security Policy → User Rights
  Assignment).
- **Triggers**: *At startup*.
- **Actions**: *Start a program* → Program: `C:\nodejs\node.exe`;
  Arguments: `server\index.js`; **Start in**: `C:\apps\quan-ly-so-van-ban`
  (bỏ trống ô "Start in" là app không tìm thấy `.env` và `data\`).
- **Settings**: bật *If the task fails, restart every 1 minute*, up to 3 times;
  tắt *Stop the task if it runs longer than* (mặc định 3 ngày sẽ tự tắt app).

### Kiểm tra bắt buộc: khởi động lại máy chủ

Dù chọn 8A hay 8B, **khởi động lại máy chủ ngay bây giờ** rồi vào lại từ một máy
khác trong phòng. Đây là bước hay bị bỏ qua, và cũng là lỗi hay xuất hiện nhất
sau lần mất điện đầu tiên.

---

## 9. Sao lưu tự động

Sao lưu chạy được **ngay khi đang có người dùng hệ thống** — script dùng
`VACUUM INTO` của SQLite chứ không copy trần file, nên không bao giờ ra bản thiếu
giao dịch. Không cần dừng dịch vụ.

Chạy thử bằng tay trước:

```bat
cd C:\apps\quan-ly-so-van-ban
node server\bin\backup.js --out D:\sao-luu-van-ban
```

Mỗi lần chạy tạo một thư mục `<ngày_giờ>\` gồm `vanban.db` (toàn bộ sổ, tài khoản,
cài đặt, nhật ký) và `uploads\` (file đính kèm).

Đặt lịch hằng ngày — tạo `C:\apps\quan-ly-so-van-ban\sao-luu.bat`:

```bat
@echo off
cd /d C:\apps\quan-ly-so-van-ban
C:\nodejs\node.exe server\bin\backup.js --out \\NAS\sao-luu-van-ban >> C:\apps\quan-ly-so-van-ban\logs\sao-luu.log 2>&1
```

Rồi *Task Scheduler → Create Task*: trigger *Daily* 06:00, action chạy file
`.bat` trên, và **Run whether user is logged on or not**.

Ba chỗ hay sai:

- **Sao lưu ra đường mạng (`\\NAS\...`)**: task chạy dưới `SYSTEM` **không có
  quyền** vào chia sẻ mạng, và ổ đã `net use` trong phiên đăng nhập cũng **không
  thấy** trong phiên dịch vụ. Phải chạy task bằng một tài khoản domain/user có
  quyền trên chia sẻ đó, và luôn ghi đường dẫn UNC đầy đủ chứ đừng dùng ký tự ổ.
- **Đường dẫn tuyệt đối**: task không có `PATH` như cửa sổ `cmd`, nên gọi
  `C:\nodejs\node.exe` chứ đừng gọi `node`.
- **Đích phải nằm ngoài máy chủ**: sao lưu cùng ổ với dữ liệu gốc thì mất ổ là
  mất cả hai.

Sáng hôm sau mở `logs\sao-luu.log` và mở thư mục đích để xác nhận đã có bản mới.

**Phục hồi** — đã thử: xóa sạch `data\` rồi dựng lại từ bản sao lưu, dữ liệu trở
về đầy đủ kể cả mật khẩu đã đổi và vị trí bộ đếm số:

```bat
nssm stop van-ban
cd /d C:\apps\quan-ly-so-van-ban
rmdir /s /q data
mkdir data
copy    "\\NAS\sao-luu-van-ban\<ngày_giờ>\vanban.db" data\
xcopy   "\\NAS\sao-luu-van-ban\<ngày_giờ>\uploads"   data\uploads\ /E /I
nssm start van-ban
```

---

## 10. Nói trước với phòng về hai điều

**Đường vào.** Gửi anh chị em trong phòng:

> Sổ văn bản dùng chung: **http://10.0.0.244:3000** — mở bằng Chrome hoặc Edge
> rồi lưu vào thanh dấu trang. Tài khoản do quản trị viên cấp; lần đầu đăng nhập
> hệ thống sẽ bắt đổi mật khẩu. Trang chỉ vào được từ mạng trong phòng.

Nếu máy trạm nào còn dùng Internet Explorer thì phải đổi sang Chrome/Edge/Firefox
— giao diện dùng JavaScript hiện đại, IE không chạy được.

**Nhãn "Không bảo mật".** Trình duyệt sẽ ghi như vậy cạnh thanh địa chỉ, vì đây là
HTTP trong mạng nội bộ chứ không phải HTTPS. Nói trước để không ai lo, nhưng nói
đúng cả hai mặt: mật khẩu vẫn được băm bằng scrypt và không lưu bản đọc được ở
đâu, còn đường truyền trong LAN thì không mã hóa — ai bắt được gói tin trong mạng
nội bộ sẽ đọc được mật khẩu lúc đăng nhập. Chấp nhận được với một mạng nội bộ tin
cậy.

Muốn mã hóa cả đường truyền thì không dùng được Let's Encrypt (cần Internet); phải
phát chứng chỉ từ CA nội bộ (AD CS) rồi cho IIS + Application Request Routing làm
đường vào. Khi đó `.env` phải đổi thành `HOST=127.0.0.1` và thêm `TRUST_PROXY=1`,
và IIS phải chuyển tiếp `X-Forwarded-Proto` — thiếu nó thì cookie phiên không bao
giờ được đánh cờ `Secure` dù đã có HTTPS.

---

## 11. Đồng hồ máy chủ — việc nhỏ nhưng hậu quả lớn

Số văn bản đi được cấp **theo năm của ngày gửi**, và bộ đếm reset đầu năm. Máy chủ
sai năm là sổ sai năm, và số đã phát hành ra ngoài thì không rút lại được.

Máy không có Internet nên không đồng bộ được với `time.windows.com`. Hai đường:

```bat
:: Trong domain: đồng bộ với domain controller
w32tm /resync
w32tm /query /status

:: Không có domain: kiểm tra và đặt tay
w32tm /query /status
control timedate.cpl
```

Đưa việc kiểm tra ngày giờ máy chủ vào lịch định kỳ (mỗi quý, và bắt buộc **trước
mỗi đầu năm**). Đồng hồ CMOS của máy cũ chạy lệch dần, thường lệch nhiều nhất sau
mỗi lần mất điện.

Nếu máy chủ có phần mềm diệt virus, loại `C:\apps\quan-ly-so-van-ban\data` khỏi
danh sách quét thời gian thực. Cơ sở dữ liệu SQLite ghi liên tục vào
`vanban.db-wal`, phần mềm quét từng lần ghi sẽ làm hệ thống chậm rõ rệt.

---

## Cập nhật lên bản mới (cũng qua USB)

```bat
:: 1. Sao lưu trước khi đổi gì
cd /d C:\apps\quan-ly-so-van-ban
node server\bin\backup.js --out D:\sao-luu-van-ban

:: 2. Dừng dịch vụ
nssm stop van-ban

:: 3. Chỉ ghi đè hai thư mục mã nguồn — KHÔNG chạm .env và data\
xcopy E:\van-ban\app\server C:\apps\quan-ly-so-van-ban\server /E /Y
xcopy E:\van-ban\app\public C:\apps\quan-ly-so-van-ban\public /E /Y

:: 4. Nếu package.json có thay đổi thư viện: mang cả node_modules mới từ
::    bước 1.2 sang, đừng chạy npm install trên máy chủ (không có mạng)

:: 5. Chạy lại và xem log
nssm start van-ban
type logs\van-ban.log
```

Hai điều đáng biết:

- Đổi file trong `public\` **không cần** khởi động lại (máy chủ đọc từ đĩa mỗi
  request), còn đổi bất cứ gì trong `server\` thì bắt buộc restart.
- `app.css` và `app.js` được đặt `maxAge: '1h'`, nên trình duyệt có thể còn dùng
  bản cũ tới một giờ sau khi cập nhật; `index.html` là `no-cache` nên đổi ngay.
  Ai cần thấy bản mới lập tức thì `Ctrl+Shift+R`.

## Sự cố thường gặp

| Triệu chứng | Nguyên nhân thường gặp | Xử lý |
| --- | --- | --- |
| `node -v` không in gì / lỗi entry point | bản Node không chạy trên Server 2012 non-R2 | Thử Node 18.20.x bản `.zip`; xem mục 0 |
| `NODE_MODULE_VERSION ... does not match` | `node_modules` cài bằng bản Node lớn khác | Cài lại `node_modules` (bước 1.2) bằng đúng bản Node của máy chủ |
| `not a valid Win32 application` | `node_modules` mang từ máy Linux/macOS | Cài lại trên máy **Windows x64** |
| Dịch vụ báo "started then stopped" | dùng `sc create` trỏ thẳng `node.exe` | Dùng NSSM (mục 8A) |
| `SQLITE_CANTOPEN` trong log | tài khoản chạy dịch vụ không ghi được `data\` | `icacls` cấp quyền (mục 3) |
| Tên phòng mặc định, `PORT`/`DATA_DIR` bị lờ đi | `.env` lưu dạng UTF-16, hoặc file tên `.env.txt`, hoặc chưa restart | Tạo lại `.env` bằng PowerShell (mục 4) |
| Chữ tiếng Việt trong tên phòng bị lỗi | `.env` lưu dạng ANSI | Lưu lại dạng UTF-8 (mục 4) |
| Máy khác không vào được, trên máy chủ thì được | `HOST=127.0.0.1`, hoặc chưa mở tường lửa | Đặt `HOST=0.0.0.0` + restart; `netsh ... show rule` (mục 7) |
| `EADDRINUSE` | cổng đang bị chiếm (thường là bản chạy tay ở mục 6 chưa tắt) | `netstat -ano \| findstr :3000` → `taskkill /PID <pid> /F` |
| Đính kèm file scan lớn bị lỗi | file quá 20 MB | Nén / chia nhỏ bản scan |
| Dịch vụ không lên sau reboot | Task Scheduler thiếu *Run whether user is logged on or not*, hoặc NSSM chưa `SERVICE_AUTO_START` | Sửa lại rồi reboot thử lần nữa |
| Sao lưu không ra file | task chạy dưới `SYSTEM` không vào được `\\NAS\...` | Đổi tài khoản chạy task (mục 9) |
| Không rõ vì sao | — | `logs\van-ban.log` và `logs\van-ban.err.log` là chỗ xem đầu tiên |

## Danh sách kiểm tra khi bàn giao

- [ ] `node -v` in ra phiên bản, và `require('better-sqlite3')` chạy không lỗi
- [ ] `sc query van-ban` → `RUNNING`
- [ ] Vào được từ **một máy khác** trong phòng bằng IP
- [ ] Đã khởi động lại máy chủ và app tự lên
- [ ] IP máy chủ là IP tĩnh
- [ ] **Ngày, năm và múi giờ trên máy chủ đúng**
- [ ] Tường lửa chỉ mở cho dải mạng của phòng (`remoteip` không phải `any`)
- [ ] Tên phòng hiện đúng, đủ dấu, trên đầu trang
- [ ] Quản trị viên đã đăng nhập và đổi mật khẩu tạm
- [ ] Đã tạo tài khoản văn thư và chỉ xem, thử đúng quyền từng vai
- [ ] Cài đặt → Lấy số đã đặt đúng tiền tố / hậu tố mặc định của phòng và "Bắt đầu từ"
- [ ] Task sao lưu đã chạy thật ít nhất một lần, đích nằm ngoài máy chủ
- [ ] Đã thử phục hồi từ bản sao lưu (trên máy khác, không phải máy đang dùng)
- [ ] Mật khẩu quản trị, tài khoản chạy dịch vụ và đường dẫn sao lưu được lưu ở
      nơi phòng cùng biết
- [ ] Giữ lại USB gói cài (Node + `node_modules`) — không có Internet thì đây là
      thứ duy nhất dựng lại được máy chủ
