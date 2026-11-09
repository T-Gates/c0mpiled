#!/usr/bin/env bash
# mkcert로 통화 서버용 인증서(certs/cert.pem, certs/key.pem)를 만든다.
# localhost, 127.0.0.1, ::1, 현재 LAN IP 포함. `mkcert -install`은 하지 않는다.
# Wi-Fi(LAN IP)가 바뀌면 다시 실행해야 한다.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v mkcert >/dev/null 2>&1; then
  echo "mkcert가 없습니다. 'brew install mkcert'로 설치해 주세요." >&2
  exit 1
fi

ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
if [ -z "$ip" ]; then
  ip="$(ipconfig getifaddr en1 2>/dev/null || true)"
fi
if [ -z "$ip" ]; then
  echo "LAN IP를 찾지 못했습니다 (en0, en1). Wi-Fi 연결을 확인해 주세요." >&2
  exit 1
fi

mkdir -p certs
mkcert -cert-file certs/cert.pem -key-file certs/key.pem localhost 127.0.0.1 ::1 "$ip"

echo "인증서 생성 완료: certs/cert.pem, certs/key.pem (LAN IP: $ip)"
echo "실행: node server/call-server.mjs  →  https://$ip:8443/call.html"
