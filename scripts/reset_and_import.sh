#!/usr/bin/env bash
# 名簿を Excel から再投入するスクリプト
# 使い方: ./scripts/reset_and_import.sh path/to/CLLS出欠一覧.xlsx
#         (引数なしならデフォルトパス: ~/Downloads/CLLS出欠一覧.xlsx)
set -euo pipefail

cd "$(dirname "$0")/.."

XLSX="${1:-$HOME/Downloads/CLLS出欠一覧.xlsx}"
PORT="${PORT:-3000}"

if [ ! -f "$XLSX" ]; then
  echo "✗ Excelファイルが見つかりません: $XLSX" >&2
  exit 1
fi

if ! curl -fsS -m 2 "http://localhost:${PORT}/api/ping" > /dev/null; then
  echo "✗ サーバーが起動していません (localhost:${PORT})。先に scripts/start.sh を実行してください。" >&2
  exit 1
fi

echo "▶ Excel → CSV 変換中..."
mkdir -p data
python3 scripts/import_excel.py "$XLSX" data/members_real.csv

echo "▶ サーバーへインポート中..."
RESULT=$(curl -fsS -X POST -F "file=@data/members_real.csv" "http://localhost:${PORT}/api/import")
echo "  $RESULT"

echo "▶ 投入後の件数:"
curl -fsS "http://localhost:${PORT}/api/snapshot" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'  members={len(d[\"members\"])} clubs={len(d[\"clubs\"])} groups={len(d[\"groups\"])}')
"

echo
echo "✓ インポート完了"
echo "  正規化マッピング: data/club_mapping.tsv"
echo "  重複統合ログ:    data/duplicates_log.tsv"
