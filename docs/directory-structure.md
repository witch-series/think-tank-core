# ディレクトリ構造

```
/think-tank-core
├── package.json            # npm scripts (start, setup, analyze, ui)
├── main.js                 # エントリポイント: APIサーバ、LLM自律ループ、Dreamスケジューラ、CLI
├── config/
│   ├── settings.json       # ユーザー設定（gitignore対象）
│   └── settings.default.json # デフォルト設定テンプレート
├── core/
│   ├── agent-loop.js       # 2フェーズ情報収集エージェント（gather→summarize）
│   ├── evolution.js        # 自己修正: Git差分分析、Dream Phase、リファクタ、モジュール生成、スクリプトレビュー、知識圧縮
│   └── task-manager.js     # EventEmitterベースのタスクキュー管理
├── explorers/
│   ├── crawler.js          # HTTPフェッチ（リダイレクト追従対応）+ Ollama連携で4項目抽出
│   ├── searcher.js         # Web検索エンジン（Brave/DuckDuckGo/arxiv）
│   └── verifier.js         # 2重チェック: 別コンテキストでの批判的検証
├── lib/
│   ├── analyzer.js         # 再帰的ファイルスキャン + 関数抽出 + .summary.json 生成
│   ├── cli.js              # インタラクティブCLIインターフェース
│   ├── configurator.js     # 設定読み込み + コードセキュリティ検閲
│   ├── ollama-client.js    # Ollamaクライアント（マルチURLフェイルオーバー）
│   ├── prompt-loader.js    # プロンプトテンプレート読み込み（{{変数}}置換対応）
│   ├── sandbox.js          # vm.Scriptによる構文検証 + vm.createContextによる隔離実行
│   ├── setup.js            # 初回セットアップウィザード
│   └── watcher.js          # ファイル変更監視（ホットリロード用）
├── prompts/                # LLMプロンプトテンプレート（.txtファイル）
│   ├── generate-module.user.txt / .system.txt
│   ├── generate-next-question.user.txt / .system.txt
│   ├── dream-phase.user.txt / .system.txt
│   ├── propose-refactor.user.txt
│   ├── chat.system.txt
│   ├── search-queries.user.txt / .system.txt
│   ├── search-fallback-urls.user.txt / .system.txt
│   ├── gather-generic.system.txt
│   ├── summarize-findings.user.txt / .system.txt
│   ├── verify.user.txt / .system.txt
│   ├── extract-insights.user.txt
│   ├── detect-research-intent.system.txt    # ユーザーチャットからリサーチ意図を検出
│   ├── compress-knowledge.system.txt / .user.txt  # 知識DB圧縮
│   ├── next-search-direction.system.txt     # LLM自律探索方向の決定
│   ├── plan-next-action.system.txt / .user.txt    # LLM自律行動計画（7アクション）
│   └── review-scripts.system.txt            # スクリプト有用性レビュー
├── brain/
│   ├── modules/            # LLMが生成・改善するJSコード群
│   ├── research/           # リサーチ結果の知識DB (JSONL形式)
│   ├── analysis/           # コード解析結果の知識DB (JSONL形式)
│   ├── work-logs/          # エージェントの作業ログ
│   └── visited-urls.json   # 訪問済みURL一覧（重複検索回避）
├── ui/
│   ├── server.js           # Express UIサーバー（ポート3001）
│   ├── public/index.html   # ダッシュボードUI（タブ切替・進捗表示・検索機能付き）
│   └── package.json        # UI依存パッケージ（express）
└── docs/                   # 実装ドキュメント
```

## 各ディレクトリの役割

### `config/`

設定ファイルを格納。`settings.json` でシステム全体の動作を制御する。`settings.default.json` はデフォルト値のテンプレート。

### `core/`

システムの中核ロジック。LLM自律判断によるタスク管理、2フェーズエージェント、自己進化の仕組みを担う。

### `explorers/`

外部知見の獲得を担当。Web検索（Brave/DDG/arxiv）、HTTPフェッチ、情報の抽出と批判的検証の2段階パイプライン。

### `lib/`

共通ユーティリティ。ファイル解析、コード検閲、サンドボックス実行、Ollamaクライアント、プロンプト管理を提供。

### `prompts/`

LLMに送信するプロンプトテンプレートを `.txt` ファイルとして格納。`{{変数名}}` でパラメータ化されている。

### `brain/`

システムが自律的に管理するデータ領域。

- `modules/` — システムが生成・改善するJSコード（純粋なNode.js、外部パッケージ不使用）
- `research/` — Web検索・リサーチで得た知識を JSONL 形式で蓄積
- `analysis/` — コードベース解析結果を JSONL 形式で蓄積
- `work-logs/` — エージェントの実行ログ
- `visited-urls.json` — 訪問済みURLの一覧（重複検索を回避し新しい情報源を優先）

### `ui/`

Express ベースのダッシュボードUI。5タブ構成（Chat, Summary, Knowledge DB, Logs, Status）。アクティビティバーで現在の処理フェーズをリアルタイム表示。Knowledge DBはinsightsのキーワード検索が可能。
