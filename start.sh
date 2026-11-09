#!/bin/bash


tools/make-cert.sh              # 처음 한 번, 그리고 Wi-Fi가 바뀌어 IP가 달라졌을 때만
node server/call-server.mjs     # 서버 켜기. 끄려면 Ctrl+C
