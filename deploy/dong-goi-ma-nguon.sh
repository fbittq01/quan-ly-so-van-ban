#!/usr/bin/env bash
# Đóng gói mã nguồn để mang sang máy chủ nội bộ (hướng copy code, không dùng git).
#
# Gói ra là .zip vì Windows Server 2012 mở được .zip bằng Explorer, còn tar.gz
# thì phải cài thêm 7-Zip. Gói CHỈ chứa mã nguồn: node_modules cài trên máy
# Windows (better-sqlite3 có file nhị phân riêng theo hệ điều hành), dữ liệu và
# .env không bao giờ đi kèm.
set -euo pipefail

goc="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ra="${1:-$goc/../van-ban-manguon-$(date +%Y%m%d).zip}"

python3 - "$goc" "$ra" <<'PY'
import os, sys, zipfile

goc, ra = sys.argv[1], sys.argv[2]

# Chỉ những thứ cần để chạy, cộng tài liệu vận hành.
MANG = [
    'server', 'public',
    'package.json', 'package-lock.json', '.env.example',
    'README.md', 'deploy',
]
# Không mang: node_modules (cài lại trên Windows), data/ và .env (dữ liệu và
# cấu hình của máy này), test/shots (ảnh chụp), *.dc.html + canvas.json +
# *.html ở gốc (file thiết kế).
BO_TEN = {'dong-goi-ma-nguon.sh'}

n = 0
with zipfile.ZipFile(ra, 'w', zipfile.ZIP_DEFLATED) as z:
    for muc in MANG:
        p = os.path.join(goc, muc)
        if not os.path.exists(p):
            sys.exit('Thiếu ' + muc)
        if os.path.isfile(p):
            z.write(p, os.path.join('app', muc)); n += 1
            continue
        for thumuc, _, files in os.walk(p):
            for f in sorted(files):
                if f in BO_TEN:
                    continue
                day = os.path.join(thumuc, f)
                z.write(day, os.path.join('app', os.path.relpath(day, goc)))
                n += 1
print('%d file -> %s' % (n, ra))
PY

sha256sum "$ra" | tee "$ra.sha256"
