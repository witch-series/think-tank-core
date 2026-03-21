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

### 割り込み処理

```
通常: enqueue(task) → キュー末尾に追加
割り込み: prioritize(task) → キュー先頭に挿入
```

ユーザーからの API リクエスト（`POST /analyze`）は `prioritize()` を使用する。

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

## API サーバー

`http` モジュールによるミニマルな HTTP サーバー。

### エンドポイント

#### `GET /status`

```json
{
  "taskManager": {
    "running": true,
    "paused": false,
    "currentTask": "analyze:./brain/modules",
    "queueLength": 1,
    "queuedTasks": ["self:scan-knowledge"]
  },
  "knowledge": { "files": 2, "entries": 15 },
  "uptime": 3600.5,
  "timestamp": "2026-03-21T12:00:00.000Z"
}
```

#### `GET /logs?count=N`

直近 N 件のログエントリを配列で返す（デフォルト50件、最大保持500件）。

#### `POST /analyze`

リクエストボディ:
```json
{ "folder": "./brain/modules" }
```

指定フォルダの解析タスクをキュー先頭に挿入し、即座にレスポンスを返す。

## 設定ファイル (`config/settings.json`)

| キー | 型 | デフォルト | 説明 |
|-----|-----|----------|------|
| `ollama.url` | string | `http://localhost:11434` | Ollama エンドポイント |
| `ollama.model` | string | `llama3` | 通常処理用モデル |
| `ollama.dreamModel` | string | `llama3` | Dream Phase 用モデル |
| `server.port` | number | `3000` | API サーバーポート |
| `targetFolders` | string[] | `["./brain/modules"]` | 自己解析の対象フォルダ |
| `dreamHour` | number | `5` | Dream Phase の実行時刻（時） |
| `knowledgeDb` | string | `./brain/knowledge-db` | 知識DB のパス |
| `summaryExtension` | string | `.summary.json` | 要約ファイルの拡張子 |
