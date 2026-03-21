# アーキテクチャ

システムは **統括コア**・**外部探索ユニット**・**自己解析エンジン** の3層が Git と知識DB を介して連携する。

## 全体構成

```
┌──────────────────────────────────────────────────┐
│                  統括コア (main.js)               │
│  TaskManager (EventEmitter) ─ タスクキュー管理     │
│  LLM自律判断ループ ─ 毎サイクルLLMが行動を決定     │
│  APIサーバー ─ /status, /logs, /chat, /knowledge  │
│  Dream Phase スケジューラ ─ 毎日 AM 5:00           │
│  Activity Phase Tracker ─ UI進捗表示用             │
├──────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌──────────────┐  ┌─────────┐ │
│  │ 探索ユニット │  │エージェント   │  │自己解析  │ │
│  │ crawler.js  │  │ agent-loop.js│  │engine   │ │
│  │ searcher.js │  │ 2フェーズ構成 │  │analyzer │ │
│  │ verifier.js │  │ gather→sum   │  │sandbox  │ │
│  └──────┬──────┘  └──────┬───────┘  └────┬────┘ │
├──────────────────────────────────────────────────┤
│  brain/research (JSONL)  │  brain/analysis (JSONL)│
│  brain/modules (JS)      │  brain/visited-urls.json│
│  brain/work-logs         │  Git (.git/)           │
├──────────────────────────────────────────────────┤
│  prompt-loader.js ─ prompts/ テンプレート管理      │
│  ollama-client.js ─ マルチURL フェイルオーバー      │
└──────────────────────────────────────────────────┘
```

## 1. 統括コア (Core Loop)

**ファイル**: `main.js`, `core/task-manager.js`, `core/evolution.js`

### LLM自律判断ループ

- `TaskManager` が `EventEmitter` ベースでタスクキューを管理
- タスク完了時に `idle` イベントを発火し、LLM に次の行動を決定させる
- LLM が7種類のアクションから最適な行動を選択:
  - `research` — Web検索による情報収集
  - `deep_research` — 特定トピックの深掘り調査
  - `organize` — 知識DBの圧縮・整理
  - `generate_script` — 蓄積知識からモジュール生成
  - `analyze_code` — コードベースの解析
  - `improve_code` — targetFolders内コードの改善
  - `idle` — 次のサイクルまで待機

### 2層検索プロンプト

- **ユーザー指定 `searchPrompt`**: ユーザーのチャットから検出し、`settings.json` に永続化
- **LLM自律 `autoSearchPrompt`**: LLMが自ら決定する探索方向（メモリ上のみ、再起動で消失）
- ユーザーの意図とLLMの自律探索が独立に管理される

### Activity Phase Tracking

- 現在の処理フェーズ（planning, searching, saving, organizing, generating, analyzing, improving, idle）を追跡
- `/status` API で `activity` フィールドとして公開
- UIのアクティビティバーでリアルタイム表示

### 割り込み

- ユーザー入力（API / CLI）があった場合のみ、`prioritize()` でキューの先頭にタスクを挿入
- 現在実行中のタスクは完了まで待機し、次の処理で割り込みタスクを実行
- 検索中にユーザーチャットが割り込んだ場合、空結果は「失敗」としてログに残さない

### Dream Phase (AM 5:00)

- 直近24時間の Git コミットログと差分を抽出
- knowledge-db の新規エントリを収集
- Ollama に学習・分析指示を送信
- 結果を `brain/research/dreams.jsonl` に記録
- **スクリプトレビュー**: 生成済みスクリプトの構文検証・サンドボックス実行・LLM有用性判定を実施し、不要なものを自動削除

### スマートチャット

- ユーザーの質問に対して、直近72時間の知識DB（最大10件）から即座に回答
- 回答が不十分な場合、バックグラウンドで補足検索を自動実行
- ユーザーのチャットからリサーチ意図を検出し、`searchPrompt` を動的に更新

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
   - 訪問済みURLをスキップ（`brain/visited-urls.json` で管理）
   - 類似トピックの重複検出と検索ワード分岐
2. **Summarize Phase**: 収集データを LLM で構造化要約
   - データ未収集（中断含む）時は `{ empty: true }` を返し、知識DBを汚染しない

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

### スクリプトレビュー (evolution.js: reviewScripts)

Dream Phase で1日1回実行:

1. `brain/modules/` 内の全 `.js` ファイルを走査
2. 各ファイルに対し `validateSyntax` + `runInSandbox` で検証
3. 結果をLLMに送信し、有用性を判定（`review-scripts.system` プロンプト使用）
4. LLMが `keep: false` と判定したファイルを自動削除（`.summary.json` も含む）
5. 削除があればGitで自動コミット

## 4. 知識DB管理

### 分離ストレージ

- `brain/research/` — Web検索・リサーチ結果（JSONL形式）
- `brain/analysis/` — コードベース解析結果（JSONL形式）
- 各エントリは `topic`, `insights`, `summary` を含む（タイムスタンプ・ステップ情報は除外）

### 訪問URL追跡

- `brain/visited-urls.json` で訪問済みURLを一元管理
- エージェントループが自動的にスキップし、新しい情報源を優先探索

### 知識圧縮

- エントリ数が20を超えたJSONLファイルを対象
- LLMが重複・類似エントリを統合し、情報量を維持しながらファイルサイズを削減
- `organize` アクション時に自動実行

## 5. プロンプトテンプレート

**ファイル**: `lib/prompt-loader.js`, `prompts/*.txt`

- プロンプトを `.txt` ファイルとして `prompts/` ディレクトリに外部化
- `loadPrompt(name)` でファイルを読み込み
- `fillPrompt(name, vars)` で `{{variable}}` プレースホルダを置換
- コードからプロンプト文字列を分離し、保守性を向上

## 6. Ollama クライアント

**ファイル**: `lib/ollama-client.js`

- 複数URLのフェイルオーバーをサポート
- 各URLで **3回連続失敗** した場合のみ次のURLに切り替え
- 生成タイムアウト: 120秒
- `getStatus()` で現在のURL、失敗カウント、利用可能URLリストを取得

## 7. セキュリティガード

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
