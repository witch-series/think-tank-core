# 技術仕様

## 継続的LLM処理 (Infinite Loop)

### イベント駆動

`TaskManager` は `EventEmitter` を継承し、以下のイベントを発火する:

| イベント | タイミング | データ |
|---------|-----------|-------|
| `task:enqueued` | タスクがキューに追加された時 | task |
| `task:prioritized` | タスクがキュー先頭に挿入された時 | task |
| `task:start` | タスク実行開始時 | task |
| `task:complete` | タスク正常完了時 | { task, result } |
| `task:error` | タスク失敗時 | { task, error } |
| `idle` | キューが空になった時 | — |
| `started` / `stopped` / `paused` / `resumed` | 状態変更時 | — |

`idle` イベント発火時に `scheduleAutonomousTasks()` が呼ばれ、自律タスクを自動挿入する。

### タスクスケジューリング

各サイクルで以下のタスクがエンキューされる:

| タスク | 頻度 | 説明 |
|-------|------|------|
| `agent:research` | 毎サイクル | Web検索・情報収集・要約 |
| `agent:analyze` | 60サイクル毎 | コードベース解析（約1時間に1回） |
| `generate:module` | 毎サイクル | 蓄積知識からモジュール生成 |
| `self:improve` | 毎サイクル | targetFolders内コードの改善 |

`taskInterval`（デフォルト60秒）× 60 = 約1時間でコード解析が1回実行される。

### 割り込み処理

```
通常: enqueue(task) → キュー末尾に追加
割り込み: prioritize(task) → キュー先頭に挿入
```

ユーザーからの API リクエスト（`POST /analyze`）は `prioritize()` を使用する。

## 2フェーズエージェント (agent-loop.js)

### Gather Phase

1. LLM に検索クエリを生成させる（3〜5個）
2. 各クエリで Web 検索（Brave → DDG フォールバック）
3. 上位結果のページを HTTP フェッチしてテキスト抽出
4. arxiv API で学術論文を検索（英語クエリのみ）
5. 収集データを LLM に渡して「もっと調べるか」判断

### Summarize Phase

収集した全データを LLM に渡し、以下を構造化抽出:

- **課題** (issues)
- **行動** (actions)
- **残課題** (remaining)
- **可能性** (possibilities)
- **要約** (summary)

## Web検索エンジン (searcher.js)

### Brave Search（プライマリ）

- HTMLページをスクレイピングして検索結果を抽出
- APIキー不要
- 結果: `{ title, url, snippet }` の配列

### DuckDuckGo（フォールバック）

- Brave 検索が0件の場合に使用
- HTMLページのスクレイピング

### arxiv API

- Atom XML フィードを使用した学術論文検索
- `http://export.arxiv.org/api/query` エンドポイント
- 結果: `{ title, url, snippet(=summary) }` の配列

## HTTPフェッチ (crawler.js)

- リダイレクト自動追従: 301, 302, 303, 307, 308（最大5回）
- 303/301/302 でメソッドを GET に変更
- Content-Length ヘッダを自動付与（POSTリクエスト）
- タイムアウト: デフォルト15秒（設定可能）
- User-Agent: Mozilla互換文字列

## Ollamaクライアント (ollama-client.js)

### マルチURLフェイルオーバー

- `ollama.url` にスペース区切りで複数URLを指定可能
- 各URLで **3回連続失敗** した場合に次のURLに切り替え
- 成功時にカウンタをリセット
- 全URL試行後も失敗した場合はエラーを返す
- 生成タイムアウト: 120秒

### ステータス取得

`getStatus()` で以下を返す:

```json
{
  "currentUrl": "http://localhost:11434",
  "model": "llama3",
  "failCount": 0,
  "urls": ["http://localhost:11434", "http://backup:11434"]
}
```

## 逐次自己解析 (Sequential Summary)

### 再帰的スキャン

`lib/analyzer.js` の `scanDirectory()` は以下のルールでファイルを走査する:

- `fs.readdirSync` で深さ優先探索
- `node_modules/` と `.git/` は除外
- `.summary.json` で終わるファイルは除外（生成物との衝突回避）
- デフォルトでは `.js` ファイルのみ対象

### 関数抽出

以下のパターンを正規表現で検出:

- `function name(params) {`
- `name = function(params) {`
- `name = (params) =>`
- `name(params) {` （メソッド構文）

制御構文 (`if`, `for`, `while`, `switch`, `catch`) は除外。

### Summary ファイル形式

各 `.js` ファイルに対応する `.summary.json` を同ディレクトリに生成:

```json
{
  "file": "brain/modules/example.js",
  "lines": 42,
  "functions": [
    { "name": "processData", "params": "input, options" }
  ],
  "requires": ["fs", "path"],
  "exports": ["processData"],
  "analyzedAt": "2026-03-21T12:00:00.000Z"
}
```

## Sandbox検証 (sandbox.js)

### validateSyntax(code)

- `vm.Script` で構文チェック（実行なし）
- SyntaxError 時にエラーメッセージを返す

### runInSandbox(code, timeoutMs)

- `vm.createContext` で隔離コンテキストを生成
- ホワイトリスト方式の `require`: fs, path, http, https, url, util, stream, os, crypto, child_process, events, buffer, querystring, zlib
- `module.exports` / `exports` を提供
- `console.log` / `console.error` をキャプチャ
- `codeGeneration: { strings: false, wasm: false }` で eval/new Function をブロック
- タイムアウト: デフォルト10秒

### testFile(filePath, timeoutMs)

- `node --no-warnings -c <file>` で構文チェック
- 子プロセスとして実行（サンドボックス外）

## モジュール生成 (evolution.js)

### generateModule()

1. LLM に JSON形式 `{ "filename": "...", "code": "..." }` でモジュールを提案させる
2. ファイル名をサニタイズ（英数字・ハイフン・アンダースコアのみ、最大40文字）
3. `validateCode()` でセキュリティ検閲
4. `containsSensitiveData()` で機密データチェック
5. `validateSyntax()` で構文検証
6. `runInSandbox()` でランタイム検証
7. ファイル書き込み → `autoCommit()` でコミット

### コード生成の制約

- 純粋な Node.js コードのみ（TypeScript不可）
- 外部パッケージ（npm）不使用
- Node.js 組み込みモジュールのみ利用可能

## 再学習フェーズ (05:00 Dream)

### 実行フロー

1. `setTimeout` で毎日 AM 5:00 にスケジュール
2. `getRecentCommits()` で直近24時間のコミットを取得
3. `getDiff()` で各コミットの差分を取得（上限10件、各2000文字）
4. `getNewKnowledge()` で knowledge-db の新規エントリを収集
5. Ollama にまとめて分析依頼
6. 結果を `knowledge-db/dreams.jsonl` に追記

### ハルシネーション抑制

- 学習プロンプトに「既存の安定したコード構造（JSDoc規約）を維持」の制約を付与
- リファクタ提案時は `configurator.js` でセキュリティ検閲を実施
- 提案コードを `sandbox.js` で構文検証し、パスしなければ棄却

## セキュリティ

### targetFolders制限

- LLM による自動編集は `targetFolders`（デフォルト: `./brain/modules`）内のファイルのみ
- `applyRefactor()` が `path.relative()` でパスガードを実施
- `autoCommit()` も `allowedPaths` のみステージング
- プロジェクトコア（`core/`, `lib/`, `explorers/`）は自動編集対象外

### 機密データ検出

検出パターン:
- IPv4 / IPv6 アドレス
- `password = "..."` 形式のパスワードリテラル
- `api_key = "..."` / `api-key = "..."` 形式のAPIキー
- `secret = "..."` / `token = "..."` 形式のシークレット

検出時:
- コミットをブロック（`autoCommit` が `git reset HEAD` で取り消し）
- リファクタ適用を拒否
- `sanitizeText()` でコミットメッセージからも除去

### UI XSS対策

`sanitizeHtml()` で以下を除去:
- `<script>` / `<iframe>` タグ
- `onXxx=` イベントハンドラ属性
- `javascript:` URL
- `<link>`, `<meta>`, `<base>`, `<object>`, `<embed>`, `<form>` 等の危険なタグ

## プロンプトテンプレート (prompt-loader.js)

### テンプレート形式

`prompts/` ディレクトリに `.txt` ファイルとして配置:

```
あなたは{{role}}です。
以下のデータを分析してください:
{{data}}
```

### API

- `loadPrompt(name)`: `prompts/{name}.txt` を読み込み
- `fillPrompt(name, vars)`: 読み込み + `{{key}}` を値で置換

## API サーバー

`http` モジュールによるミニマルな HTTP サーバー（デフォルトポート: 3000）。

### エンドポイント

| メソッド | パス | 説明 |
|---------|------|------|
| `GET` | `/status` | システム状態（タスク、Ollama、知識DB、最終コミット） |
| `GET` | `/logs?count=N` | 直近N件のログ（デフォルト50件、最大保持500件） |
| `POST` | `/analyze` | フォルダ解析タスクをキュー先頭に挿入 |
| `POST` | `/chat` | LLMとの対話（知識DBコンテキスト付き） |
| `GET` | `/knowledge?count=N&category=X` | 知識DBエントリの取得 |

### UI サーバー

`ui/server.js` が Express ベースのダッシュボードUIを提供（デフォルトポート: 3001）。

## 設定ファイル (`config/settings.json`)

| キー | 型 | デフォルト | 説明 |
|-----|-----|----------|------|
| `ollama.url` | string | `http://localhost:11434` | Ollama エンドポイント（スペース区切りで複数指定可） |
| `ollama.model` | string | `llama3` | 通常処理用モデル |
| `ollama.dreamModel` | string | `llama3` | Dream Phase 用モデル |
| `server.port` | number | `3000` | API サーバーポート |
| `targetFolders` | string[] | `["./brain/modules"]` | 自己解析・自動編集の対象フォルダ |
| `dreamHour` | number | `5` | Dream Phase の実行時刻（時） |
| `taskInterval` | number | `60000` | 自律タスクの間隔（ミリ秒） |
| `knowledgeDb` | string | `./brain/knowledge-db` | 知識DB のパス |
| `summaryExtension` | string | `.summary.json` | 要約ファイルの拡張子 |
| `searchPrompt` | string | (リサーチ指示) | デフォルトのリサーチプロンプト |
