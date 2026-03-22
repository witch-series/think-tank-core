# Think Tank Core

自律的に情報収集・コード開発・自己改善を24時間ノンストップで繰り返す汎用自律エージェント。

## コンセプト

- **完全自律** — タスク終了後も次の「問い」を自ら生成し、処理を継続する。人間の介入を待たない。
- **ゴール駆動** — ユーザーが設定した最終目標をサブタスクに分解し、段階的に達成する。
- **汎用性** — リサーチだけでなく、コード生成・編集・コマンド実行・テストを自律的に行う。
- **標準化** — Node.js 標準ライブラリのみ使用。外部依存ゼロで可搬性と堅牢性を確保。
- **批判的知性** — 外部情報は2重チェック（抽出 → 別コンテキストで検証）を経て、確度の高い知識のみ蓄積。
- **安全性** — 多層セキュリティ（コード検閲・サンドボックス・パス制限・コマンドブロック）で自律動作を安全に制御。

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

`http://localhost:2510` でサーバー状態・タスクキュー・ナレッジグラフ・ログをリアルタイム監視。

### API

```bash
# システム状態
curl http://localhost:2500/status

# ログ取得
curl http://localhost:2500/logs?count=20

# フォルダ解析
curl -X POST http://localhost:2500/analyze -d '{"folder":"./brain/modules"}'

# ゴール進捗
curl http://localhost:2500/goals

# アクション実績
curl http://localhost:2500/feedback

# ナレッジグラフ
curl http://localhost:2500/knowledge-graph
```

## 自律アクション

システムは以下のアクションをLLM判断で自律的に切り替える:

| アクション | 説明 |
|-----------|------|
| `research` | Web検索による情報収集 |
| `deep_research` | 特定トピックの深掘り調査 |
| `develop` | コード作成・編集（ゴール駆動） |
| `execute` | コマンド実行・テスト・検証 |
| `organize` | 知識DB・ナレッジグラフの整理 |
| `generate_script` | 蓄積知識からモジュール生成 |
| `analyze_code` | コードベースの解析 |
| `improve_code` | 既存コードの改善 |

## セキュリティ

自律生成コードは以下の多層セキュリティで保護される:

1. **コード検閲** — `eval()`, `child_process`, `new Function()`, `vm` コード実行、データ送信パターンを検出・ブロック
2. **構文検証** — `vm.Script` + `node -c` による二重の構文チェック
3. **サンドボックス実行** — `vm.createContext` で隔離実行、`child_process` 除外、タイムアウト10秒
4. **パス制限** — 書き込みは `brain/`, `scripts/`, `output/` のみ許可
5. **コマンドブロック** — `rm -rf`, `powershell`, `curl|sh`, `git push`, `npm publish` 等21パターンをブロック
6. **コマンド隔離** — `exec_command` は `brain/output/` ディレクトリで実行
7. **機密データ検出** — IP, パスワード, APIキー, トークンを検出しコミットをブロック
