# アーキテクチャ

システムは **統括コア**・**外部探索ユニット**・**自己解析エンジン** の3層が Git と知識DB を介して連携する。

## 全体構成

```
┌──────────────────────────────────────────────────┐
│                  統括コア (main.js)               │
│  TaskManager (EventEmitter) ─ タスクキュー管理     │
│  APIサーバー ─ /status, /logs, /analyze           │
│  Dream Phase スケジューラ ─ 毎日 AM 5:00           │
├──────────────────────────────────────────────────┤
│          ┌─────────────┐   ┌─────────────────┐   │
│          │ 探索ユニット │   │ 自己解析エンジン  │   │
│          │ crawler.js  │   │ analyzer.js     │   │
│          │ verifier.js │   │ configurator.js │   │
│          └──────┬──────┘   │ sandbox.js      │   │
│                 │          └────────┬────────┘   │
├──────────────────────────────────────────────────┤
│     knowledge-db (JSONL)    │    Git (.git/)     │
│     brain/modules (JS)      │    .summary.json   │
└──────────────────────────────────────────────────┘
```

## 1. 統括コア (Core Loop)

**ファイル**: `main.js`, `core/task-manager.js`, `core/evolution.js`

### 継続実行

- `TaskManager` が `EventEmitter` ベースでタスクキューを管理
- タスク完了時に `idle` イベントを発火し、自律タスク（コード解析・リサーチ）を自動挿入
- LLM を遊ばせない無限ループを実現

### 割り込み

- ユーザー入力（API / CLI）があった場合のみ、`prioritize()` でキューの先頭にタスクを挿入
- 現在実行中のタスクは完了まで待機し、次の処理で割り込みタスクを実行

### Dream Phase (AM 5:00)

- 直近24時間の Git コミットログと差分を抽出
- knowledge-db の新規エントリを収集
- Ollama に学習・分析指示を送信
- 結果を `knowledge-db/dreams.jsonl` に記録

## 2. 外部探索ユニット (Explorer)

**ファイル**: `explorers/crawler.js`, `explorers/verifier.js`

### 4項目抽出

外部ソースのテキストから Ollama を使って以下を構造化抽出:

- **課題** (issues)
- **行動** (actions)
- **残課題** (remaining)
- **可能性** (possibilities)

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

- `child_process.execFile` で隔離された Node.js プロセス内でコードを実行
- タイムアウト付き（デフォルト10秒）
- 構文チェック (`node -c`) もサポート
