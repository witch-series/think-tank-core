# ディレクトリ構造

```
/think-tank-core
├── package.json            # npm scripts (start, setup, analyze, ui)
├── main.js                 # エントリポイント: APIサーバ、タスクループ、Dreamスケジューラ、CLI
├── config/
│   ├── settings.json       # ユーザー設定（gitignore対象）
│   └── settings.default.json # デフォルト設定テンプレート
├── core/
│   ├── agent-loop.js       # 2フェーズ情報収集エージェント（gather→summarize）
│   ├── evolution.js        # 自己修正: Git差分分析、Dream Phase、リファクタ提案、モジュール生成
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
│   └── extract-insights.user.txt
├── brain/
│   ├── modules/            # LLMが生成・改善するJSコード群
│   ├── knowledge-db/       # 評価済み知識 (JSONL形式)
│   └── work-logs/          # エージェントの作業ログ
├── ui/
│   ├── server.js           # Express UIサーバー（ポート3001）
│   ├── public/index.html   # ダッシュボードUI
│   └── package.json        # UI依存パッケージ（express）
└── docs/                   # 実装ドキュメント
```

## 各ディレクトリの役割

### `config/`

設定ファイルを格納。`settings.json` でシステム全体の動作を制御する。`settings.default.json` はデフォルト値のテンプレート。

### `core/`

システムの中核ロジック。タスク管理、2フェーズエージェント、自己進化の仕組みを担う。

### `explorers/`

外部知見の獲得を担当。Web検索（Brave/DDG/arxiv）、HTTPフェッチ、情報の抽出と批判的検証の2段階パイプライン。

### `lib/`

共通ユーティリティ。ファイル解析、コード検閲、サンドボックス実行、Ollamaクライアント、プロンプト管理を提供。

### `prompts/`

LLMに送信するプロンプトテンプレートを `.txt` ファイルとして格納。`{{変数名}}` でパラメータ化されている。

### `brain/`

システムが自律的に管理するデータ領域。

- `modules/` — システムが生成・改善するJSコード（純粋なNode.js、外部パッケージ不使用）
- `knowledge-db/` — 検証済み知識を JSONL 形式で蓄積
- `work-logs/` — エージェントの実行ログ

### `ui/`

Express ベースのダッシュボードUI。ステータス表示、チャット、ナレッジDB閲覧、ログ表示機能を持つ。
