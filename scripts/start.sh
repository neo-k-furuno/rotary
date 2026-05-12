#!/usr/bin/env bash
# 本番起動スクリプト
# 使い方: ./scripts/start.sh
#         PORT=3000 ./scripts/start.sh    (ポート変更)
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"

if [ ! -d node_modules ]; then
  echo "▶ 依存関係をインストール中..."
  npm install
fi

# 自機IPアドレスを表示
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null \
        || ipconfig getifaddr en1 2>/dev/null \
        || hostname -I 2>/dev/null | awk '{print $1}' \
        || echo 'localhost')

echo
echo "════════════════════════════════════════════════════════"
echo "  ロータリー出欠管理システム 起動中"
echo "  iPad受付:      http://${LOCAL_IP}:${PORT}/"
echo "  ダッシュボード: http://${LOCAL_IP}:${PORT}/dashboard.html"
echo "  接続テスト:    http://${LOCAL_IP}:${PORT}/test.html"
echo "════════════════════════════════════════════════════════"
echo

PORT="$PORT" exec node server.js
