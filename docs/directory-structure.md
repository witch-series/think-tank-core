# ディレクトリ構造

```
/think-tank-core
├── main.js                 # エントリポイント: APIサーバ、タスクループ、Dreamスケジューラ、CLI
├── config/
│   └── settings.json       # Ollama URL, ポート, 対象フォルダ等の設定
├── core/
│   ├── evolution.js        # 自己修正: Git差分分析、Dream Phase、リファクタ提案
│   └── task-manager.js     # EventEmitterベースのタスクキュー管理
├── explorers/
│   ├── crawler.js          # 外部情報取得 + Ollama連携で4項目抽出
│   └── verifier.js         # 2重チェック: 別コンテキストでの批判的検証
├── lib/
│   ├── analyzer.js         # 再帰的ファイルスキャン + 関数抽出 + .summary.json 生成
│   ├── configurator.js     # 設定読み込み + コードセキュリティ検閲
│   └── sandbox.js          # child_processによる隔離実行・構文検証
├── brain/
│   ├── modules/            # 進化するJSコード群（自己解析の対象）
│   └── knowledge-db/       # 評価済み知識 (JSONL形式)
└── docs/                   # 実装ドキュメント
```

## 各ディレクトリの役割

### `config/`

設定ファイルを格納。`settings.json` でシステム全体の動作を制御する。

### `core/`

システムの中核ロジック。タスク管理と自己進化の仕組みを担う。

### `explorers/`

外部知見の獲得を担当。情報の抽出と批判的検証の2段階パイプライン。

### `lib/`

共通ユーティリティ。ファイル解析、コード検閲、サンドボックス実行を提供。

### `brain/`

システムが自律的に管理するデータ領域。

- `modules/` — システムが生成・改善するJSコード
- `knowledge-db/` — 検証済み知識を JSONL 形式で蓄積（`.gitignore` 対象）
