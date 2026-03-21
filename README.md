# Think Tank Core

自律的に外部知見の獲得とコードの自己改善を24時間ノンストップで繰り返す思考エンジン。

## コンセプト

- **完全自律** — タスク終了後も次の「問い」を自ら生成し、処理を継続する。人間の介入を待たない。
- **標準化** — Node.js 標準ライブラリのみ使用。外部依存ゼロで可搬性と堅牢性を確保。
- **批判的知性** — 外部情報は2重チェック（抽出 → 別コンテキストで検証）を経て、確度の高い知識のみ蓄積。

3層構造（統括コア・外部探索ユニット・自己解析エンジン）が Git と知識DB を介して連携し、コードの自己改善と知識獲得を無限ループで回し続ける。

詳細な仕様は [`docs/`](./docs/) を参照。

## クイックスタート

### 前提条件

- Node.js 18+
- [Ollama](https://ollama.com/) が起動済み（デフォルト: `http://localhost:11434`）

### 起動

```bash
node main.js
```

初回実行時は対話型セットアップが起動し、Ollama の接続先・モデル・検索プロンプト等を設定する。
設定は `config/settings.json` に保存される（Git 管理外）。

```bash
# 設定をやり直す
node main.js --setup

# 特定フォルダを手動で解析
node main.js --analyze ./brain/modules
```

起動後はコードファイルの変更を自動検知して再起動する（ホットリロード）。

### 対話型CLI

TTY で起動するとインタラクティブモードが有効になる。

```
think-tank> help        # コマンド一覧
think-tank> status      # タスクマネージャの状態
think-tank> inject <質問> # 研究タスクを割り込み投入
think-tank> prompt <文>  # 検索プロンプトを更新
think-tank> pause / resume
think-tank> restart     # コード・設定を再読み込み
```

### ダッシュボード UI

```bash
cd ui && npm install && node server.js
```

`http://localhost:2510` でサーバー状態・タスクキュー・ログをリアルタイム監視。

### API

```bash
curl http://localhost:2500/status
curl http://localhost:2500/logs?count=20
curl -X POST http://localhost:2500/analyze -d '{"folder":"./brain/modules"}'
```
