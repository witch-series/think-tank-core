# 技術仕様

## LLM自律判断ループ

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

`idle` イベント発火時に `scheduleAutonomousTasks()` が呼ばれ、LLMに次の行動を決定させる。

### LLM自律行動計画

各サイクルで `autonomous:plan` タスクが1つエンキューされる。LLMが現在の状態（サイクル数、知識数、モジュール数、訪問URL数、ゴール進捗、フィードバック実績等）を分析し、以下の9アクションから最適な行動を選択する:

| アクション | 説明 |
|-----------|------|
| `research` | ユーザー指定プロンプトによるWeb検索・情報収集 |
| `deep_research` | 特定トピックに絞った深掘り調査 |
| `develop` | コード作成・編集（ゴール駆動、開発ツール群を使用） |
| `execute` | コマンド実行・テスト・検証 |
| `organize` | 知識DBの圧縮・整理（エントリ数>20のファイルが対象） |
| `generate_script` | 蓄積知識からNode.jsモジュール生成 |
| `analyze_code` | targetFolders内のコードベース解析 |
| `improve_code` | targetFolders内コードのリファクタリング |
| `idle` | 次のサイクルまで待機 |

アクション選択の優先順位:
1. ゴールのサブタスクが提示されている場合は、対応するアクションを最優先
2. 最終目標の達成に直接貢献するアクション
3. 開発タスクがある場合は research より develop を優先
4. 情報不足の場合のみ research を選択

### ゴール分解

各自律サイクルの冒頭で以下を実行:

1. `searchPrompt` が変更されていれば、dreamModel でサブタスクに分解
2. 各サブタスクにタイプ（research/develop/test/analyze）と依存関係を設定
3. 5サイクルごとに `evaluateProgress()` で進捗を再評価
4. 失敗タスク（3回試行）にはLLMが代替案を生成
5. `getNextSubtask()` が依存関係を尊重して次の実行可能タスクを返す

### フィードバック追跡

全アクションの実行結果を `recordOutcome()` で記録:

- アクション種別、トピック、成功/失敗、理由を記録
- `isActionUnreliable()` で直近5回の失敗率60%超を検出 → 自動回避
- `getFeedbackSummary()` でLLMプランニングにフィードバックを提示

### トピック多様性の強制

- LLMが選択したトピックを直近10件と比較（先頭15文字の部分一致）
- 重複検出時は `getUnderExplored()` からランダムに代替トピックを選択
- カテゴリ多様性（各カテゴリ最大2件）を尊重

### Activity Phase Tracking

`activityPhase` オブジェクト (`{ phase, detail, startedAt }`) で現在の処理フェーズを追跡:

| フェーズ | 説明 |
|---------|------|
| `planning` | LLMが次の行動を決定中 |
| `searching` | Web検索・情報収集中 |
| `developing` | コード開発中 |
| `executing` | コマンド実行中 |
| `saving` | リサーチ結果の保存中 |
| `organizing` | 知識DBの圧縮・整理中 |
| `generating` | スクリプト生成中 |
| `analyzing` | コードベース解析中 |
| `improving` | コード改善中 |
| `idle` | 待機中 |

`/status` APIの `activity` フィールドで公開され、UIのアクティビティバーに表示される。

### 割り込み処理

```
通常: enqueue(task) → キュー末尾に追加
割り込み: prioritize(task) → キュー先頭に挿入
```

ユーザーからの API リクエスト（`POST /analyze`）は `prioritize()` を使用する。

## 4モードエージェント (agent-loop.js)

### research モード

1. LLM に検索クエリを生成させる（3〜5個）
   - `visitedNote`: 訪問済みURLリストを渡し重複回避
   - `similarNote`: 類似トピック検出時に分岐を促す
   - `goalNote`: 最終目標に関連する検索を促す
2. 各クエリで Web 検索（Brave → DDG フォールバック）
3. 上位結果のページを HTTP フェッチしてテキスト抽出（訪問済みURLはスキップ）
4. arxiv API で学術論文を検索（英語クエリのみ）
5. 新規訪問URLを収集して返却
6. LLMで構造化要約

### analyze モード

1. プロジェクト構造を `fs.readdirSync` でスキャン
2. targetFolders内の `.js` ファイルを解析（最大5件）
3. 直近Gitコミットを取得
4. LLMで構造化要約

### develop モード

最大10ステップのLLM駆動開発ループ:

1. タスク説明 + ゴール進捗をLLMに提示
2. LLMがツールを選択（read_file, write_file, edit_file, exec_command, search_code, search_web 等）
3. ツール結果をLLMに返し、次のアクションを決定
4. `{"action": "done"}` で完了
5. dreamModel を使用

### generic モード

最大6ステップのLLM駆動汎用ループ（develop モードの簡易版）。

### Summarize Phase（全モード共通）

収集した全データを LLM に渡し、構造化抽出:

- **要約** (summary)
- **インサイト** (insights)
- **情報源** (sources)

データ未収集時（中断含む）は `{ empty: true }` を返し、知識DBへの保存をスキップする。

## 開発ツールのセキュリティ

### write_file

1. パス解決 → `repoPath` 外のアクセスを拒否
2. 相対パスが `brain/`, `scripts/`, `output/` で始まることを確認
3. `containsSensitiveData()` で機密データチェック
4. `.js` ファイルの場合:
   - `validateSyntax()` で構文検証
   - `validateCode()` でセキュリティ検閲（eval, child_process, データ送信等）
5. ディレクトリ自動作成 → ファイル書き込み

### edit_file

1. write_file と同様のパスチェック
2. 検索文字列の存在確認
3. 置換実行後、`.js` ファイルの場合は構文検証 + セキュリティ検閲
4. 検閲NGの場合は編集を拒否（ファイルは変更されない）

### exec_command

1. コマンド文字列を21パターンのブロックリストと照合:
   - ファイル破壊: `rm -rf`, `del`, `format`, `mkfs`, `dd`
   - プロセス制御: `shutdown`, `reboot`
   - リモート実行: `curl|sh`, `wget|sh`, `ssh`, `scp`
   - Windows固有: `powershell`, `cmd /c`, `net user`, `reg add/delete`, `schtasks`
   - 権限操作: `chmod +s`, `chown root`
   - 公開操作: `npm publish`, `git push`
2. `brain/output/` を作業ディレクトリとして隔離実行
3. タイムアウト: 30秒
4. 出力バッファ: 256KB

## スマートチャット

1. ユーザーの質問を受信
2. 直近72時間の知識DB（research + analysis、最大10件）をコンテキストとして付与
3. LLMで即座に回答を生成・返却
4. バックグラウンドで以下をfire-and-forget実行:
   - `detectAndUpdateSearchPrompt`: リサーチ意図の検出と `searchPrompt` 更新
   - `supplementChatWithSearch`: 回答の十分性をチェックし、不十分なら追加検索を実行

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

### 2モデル体制

| モデル | 用途 |
|-------|------|
| `model` | 通常のリサーチ・要約・チャット応答 |
| `dreamModel` | ゴール分解、グラフ再編成、開発タスク、Dream Phase |

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

## 知識DB管理

### 分離ストレージ

| ディレクトリ | 用途 | カテゴリ |
|------------|------|---------|
| `brain/research/` | Web検索・リサーチ結果 | research, dreams |
| `brain/analysis/` | コードベース解析・開発結果 | analysis, development |

各エントリのJSONL形式:
```json
{"timestamp":"...","topic":"...","insights":["..."],"summary":"..."}
```

### 訪問URL追跡

- `brain/visited-urls.json` にJSON配列として保存
- `loadVisitedUrls()` / `addVisitedUrls()` で読み書き
- エージェントループで自動スキップ、新しい情報源を優先探索

### 知識圧縮 (compressKnowledge)

- エントリ数が20を超えたJSONLファイルを対象
- LLMが重複・類似エントリを統合
- `compress-knowledge.system/user` プロンプトを使用
- `organize` アクション実行時に research/analysis 両方を処理

## ナレッジグラフ (knowledge-graph.js)

### データ構造

`brain/knowledge-graph.json`:
```json
{
  "nodes": { "key": { "label": "...", "category": "...", "count": 1, "connections": 2 } },
  "edges": [{ "from": "key1", "to": "key2", "relation": "..." }]
}
```

### グラフスコア

`score = nodes×10 + edges×5 + min(density,5)×10 + categories×20`

- `brain/graph-score-history.json` にスコア履歴を保存
- 3サイクルで変化5%未満の場合に停滞を検出

### プルーニング (pruneGraph)

1. プログラム的前処理（4つの正規化関数で重複検出）
2. トークンベースクラスタリング（共有単語でBFS展開）
3. LLM判定（dreamModel使用、5ラウンド、変更なしで早期終了）
4. マージ・削除されたキーワードの知識DBエントリも自動クリーンアップ

## ゴール分解 (goal-manager.js)

### データ構造

`brain/goals.json`:
```json
{
  "finalGoal": "最終目標テキスト",
  "subtasks": [
    {
      "id": "goal-1",
      "description": "具体的なタスク",
      "type": "research|develop|test|analyze",
      "status": "pending|in_progress|completed",
      "dependencies": ["goal-N"],
      "attempts": 0,
      "result": "完了時の結果"
    }
  ],
  "decomposedAt": "2026-03-22T..."
}
```

### ライフサイクル

1. `decomposeGoal()`: 目標が変更された場合のみLLMで再分解（完了済みタスクは保持）
2. `getNextSubtask()`: 依存関係を尊重して次の実行可能タスクを返す
3. `updateSubtask()`: アクション結果に応じてステータスを更新
4. `evaluateProgress()`: 失敗タスクにLLMで代替案を生成

## フィードバック追跡 (feedback-tracker.js)

### データ構造

`brain/feedback.json`:
```json
[
  { "action": "research", "topic": "...", "success": true, "reason": "...", "timestamp": "..." }
]
```

最大200件保持。

### 機能

- `recordOutcome()`: 各アクションの結果を記録
- `getStats()`: アクション別成功率、直近24時間の失敗一覧
- `getFeedbackSummary()`: LLMプロンプト用の要約文字列
- `isActionUnreliable()`: 直近5回の失敗率60%超を検出

## 逐次自己解析 (Sequential Summary)

### 再帰的スキャン

`lib/analyzer.js` の `scanDirectory()` は以下のルールでファイルを走査する:

- `fs.readdirSync` で深さ優先探索
- `node_modules/` と `.git/` は除外
- `.summary.md` で終わるファイルは除外（生成物との衝突回避）
- デフォルトでは `.js` ファイルのみ対象

### 関数抽出

以下のパターンを正規表現で検出:

- `function name(params) {`
- `name = function(params) {`
- `name = (params) =>`
- `name(params) {` （メソッド構文）

制御構文 (`if`, `for`, `while`, `switch`, `catch`) は除外。

### Summary ファイル形式

各 `.js` ファイルに対応する `.summary.md` を同ディレクトリに生成:

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
- ホワイトリスト方式の `require`: fs, path, http, https, url, util, stream, os, crypto, events, buffer, querystring, zlib
- `child_process` は意図的に除外（生成コードからのプロセス生成を防止）
- `module.exports` / `exports` を提供
- `console.log` / `console.error` をキャプチャ
- `codeGeneration: { strings: false, wasm: false }` で eval/new Function をブロック
- タイムアウト: デフォルト10秒

### testFile(filePath, timeoutMs)

- `node --no-warnings -c <file>` で構文チェック
- 子プロセスとして実行（サンドボックス外）

## コード検閲 (configurator.js: validateCode)

| パターン | レベル | 説明 |
|---------|--------|------|
| `eval()` | critical | 文字列コード実行 |
| `new Function()` | critical | 動的関数生成 |
| `vm.runInNewContext` 等 | critical | VMコード実行 |
| `child_process` | critical | プロセス生成 |
| `.exec()` + `require` | critical | コマンド実行 |
| HTTP + write/send/post/fetch | critical | データ送信 |
| `process.exit()` | warning | プロセス終了 |
| `process.env` | warning | 環境変数アクセス |
| `fs.unlink/rmdir/rm` | warning | ファイル削除 |
| 200文字超の行 | info | スタイル違反 |

critical レベルが検出されると `valid: false` を返し、コードの書き込み・適用が拒否される。

## スクリプトレビュー (evolution.js: reviewScripts)

Dream Phase で1日1回実行:

1. `brain/modules/` 内の全 `.js` ファイルを走査
2. 各ファイルに対し `validateSyntax` + `runInSandbox` で検証
3. 結果リストをLLMに送信（`review-scripts.system` プロンプト使用）
4. LLMが各ファイルについて `keep: true/false` と理由を返却
5. `keep: false` のファイルを自動削除（`.summary.md` も含む）
6. 削除があればGitで自動コミット

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
- Node.js 組み込みモジュールのみ利用可能（child_process除く）

## 再学習フェーズ (05:00 Dream)

### 実行フロー

1. `setTimeout` で毎日 AM 5:00 にスケジュール
2. `getRecentCommits()` で直近24時間のコミットを取得
3. `getDiff()` で各コミットの差分を取得（上限10件、各2000文字）
4. `getNewKnowledge()` で knowledge-db の新規エントリを収集（research + analysis）
5. Ollama（dreamModel）にまとめて分析依頼
6. 結果を `brain/research/dreams.jsonl` に追記
7. スクリプトレビューを実行し不要なスクリプトを削除

### ハルシネーション抑制

- 学習プロンプトに「既存の安定したコード構造（JSDoc規約）を維持」の制約を付与
- リファクタ提案時は `configurator.js` でセキュリティ検閲を実施
- 提案コードを `sandbox.js` で構文検証し、パスしなければ棄却

## セキュリティ

### 多層防御

| レイヤー | 対策 | 適用箇所 |
|---------|------|---------|
| コード検閲 | `validateCode()` — eval, child_process, データ送信等を検出 | write_file, edit_file, generateModule, applyRefactor |
| 構文検証 | `validateSyntax()` + `testFile()` — 二重の構文チェック | write_file, edit_file, generateModule |
| サンドボックス | `runInSandbox()` — 隔離実行、child_process除外、タイムアウト | generateModule, reviewScripts |
| パス制限 | `brain/`, `scripts/`, `output/` のみ書き込み許可 | write_file, edit_file |
| targetFolders制限 | `applyRefactor()` がパスガード | improve_code |
| コマンドブロック | 21パターンのブロックリスト | exec_command |
| コマンド隔離 | `brain/output/` ディレクトリで実行 | exec_command |
| 機密データ検出 | IP, パスワード, APIキー, トークンを検出 | autoCommit, write_file |
| コミットガード | 許可パスのみステージング + 差分の機密スキャン | autoCommit |

### UI XSS対策

`sanitizeHtml()` で以下を除去:
- `<script>` / `<iframe>` タグ
- `onXxx=` イベントハンドラ属性
- `javascript:` URL
- `<link>`, `<meta>`, `<base>`, `<object>`, `<embed>`, `<form>` 等の危険なタグ

## プロンプトテンプレート (prompt-loader.js)

### テンプレート形式

`prompts/` ディレクトリに `.txt` ファイルとして配置。プレーンテキスト形式（マークダウン不使用）:

```
あなたは{{role}}です。
以下のデータを分析してください:
{{data}}
```

### API

- `loadPrompt(name)`: `prompts/{name}.txt` を読み込み（キャッシュあり）
- `fillPrompt(name, vars)`: 読み込み + `{{key}}` を値で置換
- `clearPromptCache()`: キャッシュクリア（ホットリロード時に使用）

## API サーバー

`http` モジュールによるミニマルな HTTP サーバー（デフォルトポート: 2500）。

### エンドポイント

| メソッド | パス | 説明 |
|---------|------|------|
| `GET` | `/status` | システム状態（タスク、Ollama、知識DB、最終コミット、アクティビティフェーズ） |
| `GET` | `/logs?count=N` | 直近N件のログ（デフォルト50件、最大保持500件） |
| `GET` | `/chat-history` | チャット履歴 |
| `GET` | `/knowledge?count=N&category=X&source=Y` | 知識DBエントリの取得 |
| `GET` | `/knowledge-graph` | ナレッジグラフデータ |
| `GET` | `/goals` | ゴール進捗・サブタスク状態 |
| `GET` | `/feedback` | アクション実績統計 |
| `POST` | `/analyze` | フォルダ解析タスクをキュー先頭に挿入 |
| `POST` | `/chat` | LLMとの対話（知識DBコンテキスト付き、補足検索あり） |
| `POST` | `/knowledge-graph/reorganize` | ナレッジグラフの再編成を実行 |
| `POST` | `/knowledge-graph/delete` | ナレッジグラフのノードを削除 |

### UI サーバー

`ui/server.js` が Express ベースのダッシュボードUIを提供（デフォルトポート: 2510）。

### UI構成

タブ構成のフルスクリーンダッシュボード:

| タブ | 機能 |
|-----|------|
| Chat | LLMとの対話（Markdown対応）|
| Summary | リサーチ結果の要約・インサイト一覧（10秒自動更新）|
| Knowledge DB | insightsのキーワード検索（AND検索、10秒自動更新）|
| Graph | ナレッジグラフの力学レイアウト表示（ノード詳細・削除・再編成）|
| Logs | システムログのリアルタイム表示（5秒自動更新）|
| Status | サーバー・Ollama・知識DB・最終コミットの詳細状態（5秒自動更新）|

ヘッダーにミニステータス（状態・稼働時間・エントリ数）、アクティビティバーで現在の処理フェーズをリアルタイム表示。

## 設定ファイル (`config/settings.json`)

| キー | 型 | デフォルト | 説明 |
|-----|-----|----------|------|
| `ollama.url` | string | `http://localhost:11434` | Ollama エンドポイント（スペース区切りで複数指定可） |
| `ollama.model` | string | `llama3` | 通常処理用モデル |
| `ollama.dreamModel` | string | `gpt-oss:20b` | 重要判断用モデル（ゴール分解・グラフ再編成・開発） |
| `server.port` | number | `2500` | API サーバーポート |
| `targetFolders` | string[] | `["./brain/modules", "./brain/scripts"]` | 自己解析・自動編集の対象フォルダ |
| `dreamHour` | number | `5` | Dream Phase の実行時刻（時） |
| `taskInterval` | number | `60000` | 自律タスクの間隔（ミリ秒） |
| `summaryExtension` | string | `.summary.md` | 要約ファイルの拡張子 |
| `searchPrompt` | string | (リサーチ指示) | システムの最終目標（ゴール分解・全アクションに影響） |
