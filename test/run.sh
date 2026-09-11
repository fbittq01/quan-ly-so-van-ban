#!/usr/bin/env bash
# Dựng một cơ sở dữ liệu tạm, chạy máy chủ trên cổng riêng, chạy cả hai bộ
# kiểm thử, rồi dọn. Không đụng tới data/ của bản đang dùng.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=${TEST_PORT:-3111}
TMP=$(mktemp -d)
trap 'kill "${SRV:-}" 2>/dev/null || true; rm -rf "$TMP"' EXIT

DATA_DIR="$TMP" node server/bin/seed-demo.js > /dev/null
DATA_DIR="$TMP" PORT="$PORT" node server/index.js > "$TMP/server.log" 2>&1 &
SRV=$!

for _ in $(seq 1 40); do
  curl -sf "http://localhost:$PORT/api/config" > /dev/null && break
  sleep 0.25
done

echo "===== API ====="
B="http://localhost:$PORT" node test/api.test.mjs

echo
echo "===== GIAO DIỆN ====="
B="http://localhost:$PORT" node test/ui.test.mjs

echo
if grep -q '\[loi\]' "$TMP/server.log"; then
  echo "Máy chủ có ghi lỗi:"
  grep -A4 '\[loi\]' "$TMP/server.log"
  exit 1
fi
echo "Máy chủ không ghi lỗi nào."
