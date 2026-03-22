# ディレクトリ構造

```
/think-tank-core
├── package.json            # npm scripts (start, setup, analyze, ui)
├── main.js                 # エントリポイント: APIサーバ、LLM自律ループ、Dreamスケジューラ、CLI
├── config/
│   ├── settings.json       # ユーザー設定（gitignore対象）
│   └── settings.default.json # デフォルト設定テンプレート
├── core/
│   ├── agent-loop.js       # 4モードエージェント（research/analyze/develop/generic）
│   ├── evolution.js        # 自己修正: Git差分分析、Dream Phase、リファクタ、モジュール生成、スクリプトレビュー、知識圧縮
│   ├── goal-manager.js     # ゴール分解エンジン: 目標→サブタスク分解、依存関係管理、進捗追跡
│   ├── feedback-tracker.js # フィードバック追跡: アクション成功/失敗記録、信頼性評価
│   ├── knowledge-graph.js  # ナレッジグラフ: キーワード管理、スコア計算、プルーニング
│   └── task-manager.js     # EventEmitterベースのタスクキュー管理
├── explorers/
│   ├── crawler.js          # HTTPフェッチ（リダイレクト追従対応）+ Ollama連携で4項目抽出
│   ├── searcher.js         # Web検索エンジン（Brave/DuckDuckGo/arxiv）
│   └── verifier.js         # 2重チェック: 別コンテキストでの批判的検証
├── lib/
│   ├── analyzer.js         # 再帰的ファイルスキャン + 関数抽出 + .summary.json 生成
│   ├── cli.js              # インタラクティブCLIインターフェース
│   ├── configurator.js     # 設定読み込み + コードセキュリティ検閲
│   ├── ollama-client.js    # Ollamaクライアント（マルチURLフェイルオーバー、2モデル対応）
│   ├── prompt-loader.js    # プロンプトテンプレート読み込み（{{変数}}置換対応）
│   ├── sandbox.js          # vm.Scriptによる構文検証 + vm.createContextによる隔離実行
│   ├── setup.js            # 初回セットアップウィザード
│   └── watcher.js          # ファイル変更監視（ホットリロード用）
├── prompts/                # LLMプロンプトテンプレート（.txtファイル）
│   ├── plan-next-action.system.txt / .user.txt  # LLM自律行動計画（9アクション）
│   ├── decompose-goal.system.txt / .user.txt    # ゴール分解
│   ├── evaluate-goal.user.txt                   # ゴール進捗評価・代替案生成
│   ├── gather-develop.system.txt                # 開発エージェント用ツール定義
│   ├── gather-generic.system.txt                # 汎用エージェント用ツール定義
│   ├── generate-module.user.txt                 # モジュール生成
│   ├── dream-phase.user.txt                     # Dream Phase 分析
│   ├── propose-refactor.user.txt                # リファクタ提案
│   ├── search-queries.user.txt                  # 検索クエリ生成
│   ├── search-fallback-urls.user.txt            # 検索フォールバック
│   ├── summarize-findings.user.txt              # データ要約
│   ├── extract-keywords.user.txt                # キーワード抽出
│   ├── extract-insights.user.txt                # インサイト抽出
│   ├── prune-graph.user.txt                     # グラフプルーニング
│   ├── review-graph.user.txt                    # グラフレビュー
│   ├── compress-knowledge.user.txt              # 知識圧縮
│   ├── verify.user.txt                          # 情報検証
│   ├── chat.system.txt                          # チャット応答
│   ├── detect-research-intent.system.txt        # リサーチ意図検出
│   └── review-scripts.system.txt                # スクリプトレビュー
├── brain/
│   ├── modules/            # LLMが生成・改善するJSコード群
│   ├── scripts/            # 開発モードで生成されるスクリプト
│   ├── output/             # コマンド実行の隔離ディレクトリ
│   ├── research/           # リサーチ結果の知識DB (JSONL形式)
│   ├── analysis/           # コード解析・開発結果の知識DB (JSONL形式)
│   ├── work-logs/          # エージェントの作業ログ
│   ├── visited-urls.json   # 訪問済みURL一覧（重複検索回避）
│   ├── knowledge-graph.json # ナレッジグラフ（ノード・エッジ）
│   ├── graph-score-history.json # グラフスコア履歴
│   ├── goals.json          # ゴール分解結果（サブタスク・進捗）
│   ├── feedback.json       # アクション実績（成功/失敗記録）
│   └── chat-history.json   # チャット履歴
├── scripts/
│   └── reset.js            # brain/ データの全削除
├── ui/
│   ├── server.js           # Express UIサーバー（ポート2510）
│   ├── public/index.html   # ダッシュボードUI（タブ切替・ナレッジグラフ・検索機能付き）
│   └── package.json        # UI依存パッケージ（express）
└── docs/                   # 実装ドキュメント
```

## 各ディレクトリの役割

### `config/`

設定ファイルを格納。`settings.json` でシステム全体の動作を制御する。`settings.default.json` はデフォルト値のテンプレート。`searchPrompt` はシステムの最終目標として機能し、ゴール分解・リサーチ・開発すべてに影響する。

### `core/`

システムの中核ロジック。LLM自律判断、4モードエージェント、ゴール分解、フィードバック追跡、ナレッジグラフ管理、自己進化の仕組みを担う。

### `explorers/`

外部知見の獲得を担当。Web検索（Brave/DDG/arxiv）、HTTPフェッチ、情報の抽出と批判的検証の2段階パイプライン。

### `lib/`

共通ユーティリティ。ファイル解析、コード検閲、サンドボックス実行、Ollamaクライアント、プロンプト管理を提供。

### `prompts/`

LLMに送信するプロンプトテンプレートを `.txt` ファイルとして格納。`{{変数名}}` でパラメータ化されている。プレーンテキスト形式（マークダウン不使用）でトークン効率を重視。

### `brain/`

システムが自律的に管理するデータ領域。

- `modules/` — システムが生成・改善するJSコード（純粋なNode.js、外部パッケージ不使用）
- `scripts/` — 開発モードでLLMが作成するスクリプト
- `output/` — `exec_command` の隔離実行ディレクトリ
- `research/` — Web検索・リサーチで得た知識を JSONL 形式で蓄積
- `analysis/` — コードベース解析・開発結果を JSONL 形式で蓄積
- `work-logs/` — エージェントの実行ログ（72時間で自動削除）
- `goals.json` — ゴール分解結果とサブタスクの進捗状態
- `feedback.json` — アクション実績の成功/失敗記録（最大200件）
- `knowledge-graph.json` — キーワードと関係性のナレッジグラフ
- `visited-urls.json` — 訪問済みURLの一覧（重複検索を回避し新しい情報源を優先）

### `ui/`

Express ベースのダッシュボードUI。Chat, Summary, Knowledge DB, Graph, Logs, Status の各タブでシステムの状態を可視化。ナレッジグラフの力学レイアウト表示、キーワード検索、ノード削除機能を提供。
