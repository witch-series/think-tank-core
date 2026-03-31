# アーキテクチャ

システムは **統括コア**・**外部探索ユニット**・**自己解析エンジン** の3層が Git と知識DB を介して連携する。

## 全体構成

```
┌──────────────────────────────────────────────────┐
│                  統括コア (main.js)               │
│  TaskManager (EventEmitter) ─ タスクキュー管理     │
│  LLM自律判断ループ ─ 毎サイクルLLMが行動を決定     │
│  GoalManager ─ ゴール分解・サブタスク管理          │
│  FeedbackTracker ─ アクション成功/失敗の追跡       │
│  APIサーバー ─ /status, /logs, /chat, /goals, etc │
│  Dream Phase スケジューラ ─ 毎日 AM 5:00           │
│  Activity Phase Tracker ─ UI進捗表示用             │
├──────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌──────────────┐  ┌─────────┐ │
│  │ 探索ユニット │  │エージェント   │  │自己解析  │ │
│  │ crawler.js  │  │ agent-loop.js│  │engine   │ │
│  │ searcher.js │  │ 4モード構成   │  │analyzer │ │
│  │ verifier.js │  │ research     │  │sandbox  │ │
│  │             │  │ analyze      │  │         │ │
│  │             │  │ develop      │  │         │ │
│  │             │  │ generic      │  │         │ │
│  └──────┬──────┘  └──────┬───────┘  └────┬────┘ │
├──────────────────────────────────────────────────┤
│  brain/research (JSONL)  │  brain/analysis (JSONL)│
│  brain/modules (JS)      │  brain/scripts (JS)    │
│  brain/output            │  brain/work-logs       │
│  brain/goals.json        │  brain/feedback.json   │
│  brain/visited-urls.json │  Git (.git/)           │
├──────────────────────────────────────────────────┤
│  prompt-loader.js ─ prompts/ テンプレート管理      │
│  ollama-client.js ─ マルチURL フェイルオーバー      │
│  knowledge-graph.js ─ ナレッジグラフ管理            │
│  goal-manager.js ─ ゴール分解エンジン               │
│  feedback-tracker.js ─ フィードバック追跡           │
└──────────────────────────────────────────────────┘
```

## 1. 統括コア (Core Loop)

**ファイル**: `main.js`, `core/task-manager.js`, `core/evolution.js`

### LLM自律判断ループ

- `TaskManager` が `EventEmitter` ベースでタスクキューを管理
- タスク完了時に `idle` イベントを発火し、LLM に次の行動を決定させる
- LLM が9種類のアクションから最適な行動を選択:
  - `research` — Web検索による情報収集
  - `deep_research` — 特定トピックの深掘り調査
  - `develop` — コード作成・編集（ゴール駆動）
  - `execute` — コマンド実行・テスト・検証
  - `organize` — 知識DBの圧縮・整理
  - `generate_script` — 蓄積知識からモジュール生成
  - `analyze_code` — コードベースの解析
  - `improve_code` — targetFolders内コードの改善
  - `idle` — 次のサイクルまで待機

### ゴール分解エンジン

**ファイル**: `core/goal-manager.js`

- `searchPrompt` に設定された最終目標をLLM（dreamModel）で5〜10個のサブタスクに分解
- 各サブタスクにタイプ（research/develop/test/analyze）と依存関係を設定
- 依存関係を尊重し、実行可能なサブタスクを順に提示
- 5サイクルごとにゴール進捗を再評価
- 失敗タスク（3回試行）にはLLMが代替案を自動生成
- 状態は `brain/goals.json` に永続化

### フィードバック追跡

**ファイル**: `core/feedback-tracker.js`

- 全アクションの成功/失敗を `brain/feedback.json` に記録
- アクション別の成功率を計算
- 失敗率60%超のアクションを自動回避
- LLMのプランニングプロンプトにフィードバックサマリーを提示

### 検索プロンプト

- **ユーザー指定 `searchPrompt`**: システムの最終目標。ユーザーのチャットから検出し、`settings.json` に永続化
- ゴール分解エンジンがこの目標をサブタスクに分解し、全アクションがこの目標に向けて実行される

### Activity Phase Tracking

- 現在の処理フェーズ（planning, searching, saving, organizing, generating, analyzing, improving, developing, executing, idle）を追跡
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

### 4モードエージェント

`agent-loop.js` による情報収集・開発:

1. **research モード**: Web検索 → ページ取得 → arxiv検索 → 生データ収集 → LLM要約
2. **analyze モード**: プロジェクト構造スキャン → ソースコード解析 → Git履歴収集
3. **develop モード**: LLM駆動の開発ループ（最大10ステップ）
   - ファイル読み書き・コード検索・コマンド実行・Web検索を組み合わせ
   - ゴール進捗をコンテキストとして提示
   - dreamModel を使用
4. **generic モード**: LLM がツールを自由に選択（フォールバック）

### 利用可能なツール

| ツール | 説明 | 利用可能モード |
|-------|------|--------------|
| `search_web` | Web検索 | research, develop, generic |
| `fetch_page` | Webページ取得 | research, develop, generic |
| `read_file` | ファイル読み込み | develop, generic |
| `list_files` | ディレクトリ一覧 | develop, generic |
| `write_file` | ファイル作成・上書き | develop |
| `edit_file` | ファイル部分編集 | develop |
| `exec_command` | コマンド実行 | develop |
| `search_code` | コード内検索 | develop, generic |
| `analyze_code` | コード構造分析 | develop, generic |
| `git_log` | Gitログ取得 | develop, generic |

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
- ファイル単位で `.summary.md` を生成

### コード検閲

`configurator.js` の `validateCode()` が以下をチェック:

| パターン | レベル | 説明 |
|---------|--------|------|
| `eval()` | critical | 文字列コード実行 |
| `new Function()` | critical | 動的関数生成 |
| `vm.runInNewContext` 等 | critical | VMコード実行 |
| `child_process` | critical | プロセス生成 |
| `.exec()` + `require` | critical | コマンド実行 |
| HTTP write/send/post/fetch | critical | データ送信（外部通信） |
| `process.exit()` | warning | プロセス終了 |
| `process.env` | warning | 環境変数アクセス |
| `fs.unlink/rmdir/rm` | warning | ファイル削除 |
| 200文字超の行 | info | スタイル違反 |

### Sandbox 検証

`sandbox.js` が2段階のコード検証を提供:

1. **構文チェック** (`validateSyntax`): `vm.Script` による構文検証（実行なし）
2. **サンドボックス実行** (`runInSandbox`): `vm.createContext` による隔離実行
   - ホワイトリスト方式の `require`（fs, path, http, https, url, util, stream, os, crypto, events, buffer, querystring, zlib）
   - `child_process` は除外（生成コードからのプロセス生成を防止）
   - `codeGeneration: { strings: false, wasm: false }` で eval/new Function をブロック
   - タイムアウト付き（デフォルト10秒）
3. **ファイル構文検証** (`testFile`): `node -c` による構文チェック

### スクリプトレビュー (evolution.js: reviewScripts)

Dream Phase で1日1回実行:

1. `brain/modules/` 内の全 `.js` ファイルを走査
2. 各ファイルに対し `validateSyntax` + `runInSandbox` で検証
3. 結果をLLMに送信し、有用性を判定（`review-scripts.system` プロンプト使用）
4. LLMが `keep: false` と判定したファイルを自動削除（`.summary.md` も含む）
5. 削除があればGitで自動コミット

## 4. 知識DB管理

### 分離ストレージ

- `brain/research/` — Web検索・リサーチ結果（JSONL形式）
- `brain/analysis/` — コードベース解析・開発結果（JSONL形式）
- 各エントリは `topic`, `insights`, `summary` を含む（タイムスタンプ・ステップ情報は除外）

### ナレッジグラフ

**ファイル**: `core/knowledge-graph.js`

- キーワード（ノード）とその関係性（エッジ）で知識を構造化
- リサーチ結果からLLMがキーワードを自動抽出
- グラフスコア（ノード×10 + エッジ×5 + 密度×10 + カテゴリ×20）で品質を定量化
- 停滞検出: 3サイクルでスコア変化5%未満の場合に警告
- 多段階プルーニング: プログラム的正規化 → トークンベースクラスタリング → LLM判定（5ラウンド）
- dreamModel を使用したグラフ再編成

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
- `model`（通常処理） と `dreamModel`（重要判断・ゴール分解・グラフ再編成） の2モデル体制
- `getStatus()` で現在のURL、失敗カウント、利用可能URLリストを取得

## 7. セキュリティガード

### 多層防御

| レイヤー | 対策 | 適用箇所 |
|---------|------|---------|
| コード検閲 | `validateCode()` — eval, child_process, データ送信等を検出 | write_file, edit_file, generateModule, applyRefactor |
| 構文検証 | `validateSyntax()` + `testFile()` — 二重の構文チェック | write_file, edit_file, generateModule |
| サンドボックス | `runInSandbox()` — 隔離実行、child_process除外、タイムアウト | generateModule, reviewScripts |
| パス制限 | `brain/`, `scripts/`, `output/` のみ書き込み許可 | write_file, edit_file |
| コマンドブロック | 21パターン（rm -rf, powershell, curl\|sh, git push, npm publish 等） | exec_command |
| コマンド隔離 | `brain/output/` ディレクトリで実行 | exec_command |
| 機密データ検出 | IP, パスワード, APIキー, トークンを検出 | autoCommit, write_file |
| targetFolders制限 | `applyRefactor()` がパスガード | improve_code |

### UI XSS 対策

- `sanitizeHtml()` で script/iframe タグ、イベントハンドラ、javascript: URLを除去
- LLM出力のMarkdownレンダリング時に適用
