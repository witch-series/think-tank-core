# アーキテクチャ

システムは **統括コア**・**外部探索ユニット**・**自己解析エンジン** の3層が Git と知識DB を介して連携する。

## 全体構成

```
┌──────────────────────────────────────────────────┐
│                  統括コア (main.js)               │
│  TaskManager (EventEmitter) ─ タスクキュー管理     │
│  APIサーバー ─ /status, /logs, /chat, /knowledge  │
│  Dream Phase スケジューラ ─ 毎日 AM 5:00           │
├──────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌──────────────┐  ┌─────────┐ │
│  │ 探索ユニット │  │エージェント   │  │自己解析  │ │
│  │ crawler.js  │  │ agent-loop.js│  │engine   │ │
│  │ searcher.js │  │ 2フェーズ構成 │  │analyzer │ │
│  │ verifier.js │  │ gather→sum   │  │sandbox  │ │
│  └──────┬──────┘  └──────┬───────┘  └────┬────┘ │
├──────────────────────────────────────────────────┤
│     knowledge-db (JSONL)    │    Git (.git/)     │
│     brain/modules (JS)      │    .summary.json   │
├──────────────────────────────────────────────────┤
│  prompt-loader.js ─ prompts/ テンプレート管理      │
│  ollama-client.js ─ マルチURL フェイルオーバー      │
└──────────────────────────────────────────────────┘
```

## 1. 統括コア (Core Loop)

**ファイル**: `main.js`, `core/task-manager.js`, `core/evolution.js`

### 継続実行

- `TaskManager` が `EventEmitter` ベースでタスクキューを管理
- タスク完了時に `idle` イベントを発火し、自律タスク（リサーチ・コード解析・モジュール生成）を自動挿入
- LLM を遊ばせない無限ループを実現

### タスク優先度

- **リサーチ（Web検索・情報要約）**: 毎サイクル実行（最優先）
- **コード解析**: 60サイクルに1回（約1時間に1回）
- **モジュール生成**: 毎サイクル（蓄積知識から生成）
- **自己改善**: 毎サイクル（targetFolders内のコードのみ対象）

### 割り込み

- ユーザー入力（API / CLI）があった場合のみ、`prioritize()` でキューの先頭にタスクを挿入
- 現在実行中のタスクは完了まで待機し、次の処理で割り込みタスクを実行

### Dream Phase (AM 5:00)

- 直近24時間の Git コミットログと差分を抽出
- knowledge-db の新規エントリを収集
- Ollama に学習・分析指示を送信
- 結果を `knowledge-db/dreams.jsonl` に記録

## 2. 外部探索ユニット (Explorer)

**ファイル**: `explorers/crawler.js`, `explorers/searcher.js`, `explorers/verifier.js`

### Web検索

`searcher.js` が複数の検索エンジンに対応:

1. **Brave Search** (プライマリ) — HTMLスクレイピングによる検索
2. **DuckDuckGo** (フォールバック) — Brave失敗時に使用
3. **arxiv API** — 学術論文の検索（Atom XML パース）

### HTTPフェッチ

`crawler.js` の `fetch()` 関数:

- Node.js `http`/`https` モジュールベース
- リダイレクト自動追従（301/302/303/307/308、最大5回）
- Content-Length ヘッダ付きリクエスト
- タイムアウト制御（デフォルト15秒）

### 2フェーズエージェント

`agent-loop.js` による情報収集:

1. **Gather Phase**: Web検索 → ページ取得 → arxiv検索 → 生データ収集
2. **Summarize Phase**: 収集データを LLM で構造化要約（課題・行動・残課題・可能性）

### 2重チェック

1. `crawler.js` の `extractInsights()` で1回目の抽出
2. `verifier.js` の `verify()` で別コンテキストから批判的検証
3. 信頼度 0.7 未満または矛盾検出時は棄却
4. 検証を通過した知識のみ knowledge-db に蓄積

## 3. 自己解析エンジン (Self-Reflection)

**ファイル**: `lib/analyzer.js`, `lib/configurator.js`, `lib/sandbox.js`

### 逐次要約処理

- `fs.readdirSync` で対象フォルダを深さ優先で再帰スキャン
- 各 `.js` ファイルから関数名・パラメータ・require・exports を抽出
- ファイル単位で `.summary.json` を生成

### コード検閲

`configurator.js` が以下をチェック:

- `eval()` / `new Function()` の使用 → critical
- 不審な `child_process` 参照 → warning
- `process.exit()` 呼び出し → warning
- 行長超過 → info

### Sandbox 検証

`sandbox.js` が2段階のコード検証を提供:

1. **構文チェック** (`validateSyntax`): `vm.Script` による構文検証（実行なし）
2. **サンドボックス実行** (`runInSandbox`): `vm.createContext` による隔離実行
   - ホワイトリスト方式の `require`（fs, path, http, https, url, util, stream, os, crypto, child_process, events, buffer, querystring, zlib）
   - `codeGeneration: { strings: false, wasm: false }` で eval/new Function をブロック
   - タイムアウト付き（デフォルト10秒）
3. **ファイル構文検証** (`testFile`): `node -c` による構文チェック

## 4. プロンプトテンプレート

**ファイル**: `lib/prompt-loader.js`, `prompts/*.txt`

- プロンプトを `.txt` ファイルとして `prompts/` ディレクトリに外部化
- `loadPrompt(name)` でファイルを読み込み
- `fillPrompt(name, vars)` で `{{variable}}` プレースホルダを置換
- コードからプロンプト文字列を分離し、保守性を向上

## 5. Ollama クライアント

**ファイル**: `lib/ollama-client.js`

- 複数URLのフェイルオーバーをサポート
- 各URLで **3回連続失敗** した場合のみ次のURLに切り替え
- 生成タイムアウト: 120秒
- `getStatus()` で現在のURL、失敗カウント、利用可能URLリストを取得

## 6. セキュリティガード

### targetFolders 制限

- LLM による自動編集は `targetFolders`（デフォルト: `brain/modules`）内のファイルのみ許可
- `applyRefactor()` がパスガードを実施: `path.relative()` でチェック
- `autoCommit()` も `allowedPaths` のみステージング
- プロジェクトコア（`core/`, `lib/`, `explorers/`）は自動編集対象外

### 機密データ検出

- コミット前に `containsSensitiveData()` でIPアドレス、パスワード、APIキー、トークンを検出
- 検出時はコミットをブロック
- `sanitizeText()` でコミットメッセージからも機密情報を除去

### UI XSS 対策

- `sanitizeHtml()` で script/iframe タグ、イベントハンドラ、javascript: URLを除去
- LLM出力のMarkdownレンダリング時に適用
