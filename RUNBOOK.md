# 当日運用手順書

## 構成

| 端末 | 用途 | URL |
|---|---|---|
| 受付PC (Mac/Windows) | サーバー本体 | (起動するだけ) |
| iPad ×4 | 受付タップ | `http://{PCのIP}:3000/` |
| 有人机PC | 名前のない人対応 | `http://{PCのIP}:3000/` または `http://{PCのIP}:3000/dashboard.html` |
| 管理者スマホ ×2 | リアルタイム監視 | `http://{PCのIP}:3000/dashboard.html` |
| 全端末（事前） | WiFi接続テスト | `http://{PCのIP}:3000/test.html` |

## 前日までの準備

```bash
# 1. リポジトリを取得
git clone git@github.com:neo-k-furuno/rotary.git
cd rotary
npm install

# 2. 動作確認（ダミー名簿が無いので空状態でOK）
./scripts/start.sh
# → http://localhost:3000/ で確認
```

## 当日朝の手順

### ① 受付PCをWiFiに接続して固定IPを確認

```bash
ipconfig getifaddr en0   # Mac の Wi-Fi の場合
```
出てきたIP（例 `192.168.1.50`）を **全端末で覚える**。

### ② サーバー起動

```bash
./scripts/start.sh
```
起動メッセージに iPad受付 / ダッシュボード / 接続テスト の URL が表示されます。

### ③ 本番名簿を投入

別ターミナルから:
```bash
./scripts/reset_and_import.sh ~/Downloads/CLLS出欠一覧.xlsx
```
※ 既存の出欠データはすべてリセットされます。

### ④ 各端末で接続確認

各 iPad / スマホ から `http://{PCのIP}:3000/test.html` を開き、**成功率 99%以上 / 平均レイテンシ 200ms以下** を確認。会場の各位置（受付・ステージ・客席）で1分ずつ動作確認するのを推奨。

### ⑤ 受付開始

| 端末 | 開くURL |
|---|---|
| iPad ×4 | `http://{PCのIP}:3000/` |
| 有人机PC | 同上 |
| 管理者スマホ | `http://{PCのIP}:3000/dashboard.html` |

### ⑥ 終了後

```bash
# CSVエクスポート
curl http://localhost:3000/api/export -o attendance_export.csv

# サーバー停止
Ctrl + C
```

## トラブルシューティング

### iPadが「オフライン中」になった
- 自動的にローカルキューに溜まり、復帰すれば自動再送信されます
- そのまま受付を継続して大丈夫です
- WiFiルーターを再起動する場合は受付を一時止めてもらうとベター

### 出席が二重登録された
- サーバー側で先勝ちタイムスタンプ運用のため、二度目以降は無視されます
- ダッシュボードで該当者の「出席取消」→ 再登録すれば修正可能

### サーバーが落ちた
```bash
./scripts/start.sh   # 再起動するだけでDB含めて復旧
```
SQLiteは `attendance.db` に永続化されているのでデータは消えません。

### 名簿に間違いがあった
1. 受付PCで Excel を修正
2. `./scripts/reset_and_import.sh path/to/修正後.xlsx`
3. ⚠️ **出欠状態は全リセットされる** ので、既に登録済みの出席がある場合は事前にエクスポートしてから

## アーキテクチャ

- **サーバー**: Node.js + Express + SQLite (`better-sqlite3`) + SSE
- **クライアント**: 単一HTMLファイル + バニラJS（依存ライブラリなし）
- **オフライン対応**: localStorageにスナップショットキャッシュ + 送信キュー
- **冪等性**: `/api/attend` は `COALESCE(attended_at, ?)` で先勝ち

## ポート変更
```bash
PORT=8080 ./scripts/start.sh
```

## CSV インポート/エクスポート形式

```
グループ,クラブ,名前,役職,大タグ,出欠,出席時刻
```

`大タグ` は以下のいずれか（または空）:
- `2026-27年度・三役`
- `ゲスト・講演者`
- `2026-27年度・ガバナー補佐`
- `協議会主導・委員長`
- `支援室`
