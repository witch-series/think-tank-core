# ワークフロー

Think Tank の自律サイクル全体の処理フローを記述する。

## 1. 起動シーケンス

```
main() → start()
  ├─ config/settings.json 読み込み
  ├─ OllamaClient 初期化（複数URL フェイルオーバー対応）
  ├─ brain/ 配下ディレクトリ作成
  │    research, analysis, modules, scripts, output, work-logs
  ├─ TaskManager 初期化（キュー型タスク実行エンジン）
  ├─ Dream Phase スケジュール登録（毎日 dreamHour 時）
  ├─ processUnindexedEntries() → 未処理ナレッジをグラフに反映
  ├─ scheduleAutonomousTasks() → 自律サイクル開始
  ├─ HTTPサーバー起動（UI + API）
  └─ AnalyzeLoop 開始（コード解析バックグラウンド）
```

## 2. 自律サイクル概要

`scheduleAutonomousTasks()` が毎サイクル呼ばれ、`autonomous:plan` タスクをキューに投入する。
タスク完了後、TaskManager の `idle` イベントが次サイクルをトリガーする。

```
┌────────────────────────────────────────────────────┐
│              自律サイクル（1ループ）                  │
│                                                    │
│  1. コンテキスト収集                                │
│  2. LLM が次のアクションを決定                      │
│  3. アクション実行                                  │
│  4. 結果保存 + ナレッジグラフ更新                    │
│  5. フィードバック記録                              │
│  6. サブタスク進捗更新                              │
│  7. (余裕があれば) Curiosity 探索                   │
│  8. 次サイクルへ                                    │
└────────────────────────────────────────────────────┘
```

## 3. コンテキスト収集（計画フェーズ）

`main.js` の `autonomous:plan` タスク内で以下を収集し、LLM に渡す。

| 情報源 | 関数 | 内容 |
|--------|------|------|
| ファイル状態 | `collectContext()` | ファイル数、関数リスト、解析Issues |
| 直近ナレッジ | `getNewKnowledge(48h)` | 最近の調査・解析結果 |
| グラフ統計 | `getGraphStats()` | ノード数、エッジ数、密度、未探索キーワード |
| ゴール進捗 | `getNextSubtask()` | 現在のサブタスクと完了状況 |
| フィードバック | `getFeedbackSummary()` | アクション成功率の統計 |

5サイクルに1回、`evaluateProgress()` でゴール進捗の再評価も行う。

## 4. アクション決定

LLM が `plan-next-action` プロンプトに基づき `{ action, topic, reason }` を返す。

```
LLM決定
  │
  ├─ トピック重複チェック
  │    直近10トピックと重複 → getUnderExplored() で代替トピック
  │
  ├─ 信頼性チェック
  │    isActionUnreliable() → 直近5回で失敗続き → research にフォールバック
  │
  └─ サブタスク状態更新
       pending → in_progress に変更
```

## 5. アクション一覧と実行フロー

### 5.1 research / deep_research

Web検索 → ページ取得 → LLM要約 → ナレッジ保存 → グラフ更新。

```
runAgentLoop(mode: 'research')
  │
  ├─ gatherResearch()
  │    ├─ 即時検索（タスク説明で並行実行）
  │    │    searchWeb() + searchArxiv() + searchGitHub()
  │    ├─ LLM がクエリ生成（search-queries.user プロンプト）
  │    ├─ LLM クエリで追加Web検索
  │    ├─ 全結果をマージ、信頼度でソート
  │    │    academic > github > docs > blogs
  │    └─ 上位7ページを取得（fetchPage）
  │
  ├─ summarizeFindings()
  │    └─ LLM が要約 + インサイト抽出
  │         ソース品質判定: 見出しのみ/ホームページ概要は LLM が除外
  │
  ├─ ソースURL品質フィルタ
  │    ├─ credibility=0 のソースを除外
  │    ├─ コンテンツ未取得（paywall/JS限定）のURLを除外
  │    └─ ホームページ（サイトルート）のURLを除外
  │
  ├─ saveKnowledge() → brain/research/*.jsonl
  │
  ├─ updateGraph() → キーワード抽出 + エッジ生成
  │    └─ ソースURLを filterSources() で品質フィルタしてからノードに登録
  │
  └─ postChatReport() → チャットに調査報告を投稿
```

### 5.2 develop / execute

LLM がツールを使って開発タスクを実行する。

```
runAgentLoop(mode: 'develop')
  │
  ├─ gatherDevelop()
  │    ├─ LLM がツールコールを生成（act-develop.user プロンプト）
  │    ├─ executeTool() でツール実行（ループ）
  │    │    search_web, fetch_page, read_file, list_files,
  │    │    git_log, git_diff, analyze_code,
  │    │    write_file, edit_file, exec_command
  │    └─ ツール結果を蓄積
  │
  ├─ summarizeFindings()
  │
  └─ saveKnowledge() → brain/research/*.jsonl
```

### 5.3 organize

ナレッジとグラフの整理・最適化。

```
organize
  ├─ compressKnowledge(research) → 重複エントリ統合
  ├─ compressKnowledge(analysis) → 同上
  ├─ pruneGraph()   → 低品質ノード・エッジ削除
  ├─ reviewGraph()  → LLM がノード関連性を評価、接続提案
  └─ autoConnect()  → 共通トピック・同カテゴリでエッジ補完
```

### 5.4 generate_script

調査結果からコードを自動生成する。

```
generate_script
  ├─ 直近48h のナレッジからトピック選択
  ├─ generateModule() → LLM がJSコード生成
  ├─ 構文検証 + セキュリティチェック
  └─ brain/modules/{name}.js に保存 + autoCommit
```

### 5.5 analyze_code

対象フォルダのコードを解析する。

```
analyze_code
  ├─ AnalyzeLoop にファイルをキュー投入
  │    ├─ formatCode()     → 自動整形
  │    ├─ analyzeUnits()   → 関数・依存・複雑度の抽出
  │    └─ analyzeStructure() → 設計パターン分析
  └─ 結果を brain/analysis/ に保存
```

### 5.6 improve_code

既存コードのリファクタリング。

```
improve_code
  ├─ 対象フォルダからランダムにファイル選択
  ├─ proposeRefactor() → LLM が改善提案
  ├─ applyRefactor()   → 検証 + 書き込み
  └─ autoCommit()      → refactor: auto-improve {filename}
```

### 5.7 idle

何もせず、Curiosity 探索に移行する。

## 6. Curiosity システム

ユーザーがチャットで言及した話題や、idle 時に探索される未調査トピック。

```
Curiosity 登録
  ├─ ユーザーチャット → detectAndStoreCuriosity() で自動検出
  └─ brain/curiosities.json に保存（最大100件）

Curiosity 探索（idle 時 または 5サイクルごと）
  ├─ getNextCuriosity() → 未探索トピック取得
  ├─ runAgentLoop(mode: 'research') で調査
  └─ markCuriosityExplored() → 探索済みに
```

## 7. ゴール管理

`config/settings.json` の `finalGoal` を起点に、サブタスクに分解して追跡する。

```
decomposeGoal()           → LLM がゴールをサブタスクに分解
  │                          (research, develop, analyze, test, deploy)
  │
getNextSubtask()          → 依存関係を満たすpendingタスクを返す
  │                          (max 3回リトライ)
  │
updateSubtask(id, status) → in_progress / completed に更新
  │
evaluateProgress()        → 5サイクルごとに失敗タスクを再評価
                             3回失敗 → LLM が代替アプローチ提案
```

サブタスクの依存は直列チェーン。前のタスクが completed にならないと次に進まない。

## 8. ナレッジグラフ

調査結果からキーワードを抽出し、関連性のグラフを構築する。

### 品質管理

グラフの品質は **LLMによる判定** と **構造的フィルタ** の2層で管理される。

LLM判定（プロンプトで制御）:
- ソース品質: 記事本文に基づくか、見出し/サイト説明だけかを LLM が判定
- キーワード関連性: トピックと無関係なキーワードを LLM が除外
- description品質: サイト紹介ではなく技術そのものの説明かを LLM が判定

構造的フィルタ（コードで制御）:
- `isLowQualitySource()`: ホームページURL、低信頼度（credibility<0.2）、ブロック対象を除外
- `filterSources()`: ノードに登録するソースURLを品質フィルタ
- `isGenericLabel()`: 汎用語辞書による機械的フィルタ

### グラフ操作

```
updateGraph(entry)
  ├─ filterSources() でソースURL品質フィルタ
  ├─ LLM がキーワード抽出（extract-keywords.user プロンプト）
  │    ├─ ソース品質チェック（見出しのみ/ホームページ → 抽出スキップ）
  │    ├─ トピック関連性チェック（無関係キーワード → 除外）
  │    └─ description品質チェック（サイト説明 → 除外）
  ├─ 汎用ワードフィルター（isGenericLabel）
  ├─ ノード作成/更新（count, sources, topics, category）
  │    └─ 既存ノードのソースも filterSources() で再フィルタ
  ├─ LLM 抽出の relations からエッジ生成
  └─ 同一リサーチ内キーワード間の自動エッジ
       (小規模グラフ: count>=1, 大規模: count>=3)

reviewGraph()
  ├─ ラベル伝播でカテゴリ自動補完
  ├─ コミュニティベースのバッチ分割
  ├─ LLM がバッチごとにノード関連性を評価
  │    ├─ 重複概念のマージ（DSU による一括適用）
  │    ├─ カテゴリ修正
  │    ├─ エッジ追加/削除提案
  │    └─ サイト説明/見出しのみキーワードの削除
  ├─ 全ノードのソースURL洗浄（filterSources）
  └─ 低関連ノードの削除（ソース付きノードは保護）

pruneGraph()
  ├─ ファジーマッチで明らかな重複をマージ
  ├─ 汎用/ジャンクノードの自動削除
  └─ LLM による詳細な整理（バッチ処理）

autoConnect()
  ├─ 共通トピックを持つノード間にエッジ生成
  └─ 同カテゴリ内の孤立ノードを接続
       (ノード数 < 80: 全ノード対象)
       (ノード数 >= 80: count>=3 のみ)
```

## 9. Dream Phase（日次合成）

毎日 `dreamHour`（デフォルト AM 5:00）に実行。

```
Dream Phase
  ├─ cleanupVisitedUrls() → 30日以上の低品質URL削除
  ├─ dreamPhase()
  │    ├─ 直近24hのコミット収集
  │    ├─ 直近48hのナレッジ収集
  │    └─ LLM が振り返り + 次の方向性を提案
  ├─ dream:refactor → インサイトに基づくリファクタリング
  ├─ dream:research → doubleCheck() で調査結果の検証
  ├─ reviewScripts() → 生成スクリプトの検証・削除
  └─ autoCommit()
```

## 10. チャット（ユーザー対話）

チャットは調査結果に基づく議論専用。システム内部の話題には応答しない。
グラフの操作指示にも対応する。

```
POST /chat
  ├─ 直近72hのナレッジを読み込み
  ├─ LLM がアクション判定（select-chat-knowledge プロンプト）
  │    ├─ answer     → 関連エントリで回答
  │    ├─ investigate → 情報不足、調査開始
  │    ├─ chat        → 雑談応答
  │    └─ graph_command → グラフ操作実行
  │         ├─ reorganize → prune + review + autoConnect
  │         ├─ prune      → 重複統合のみ
  │         └─ review     → カテゴリ/接続修正のみ
  │
  ├─ graph_command の場合:
  │    ├─ 既存グラフタスク実行中チェック（重複防止）
  │    ├─ taskManager.prioritize() で非同期実行
  │    └─ 開始報告をチャットコンテキストに注入
  │
  ├─ chat() → LLM が知識コンテキスト付きで応答
  ├─ detectAndStoreCuriosity() → 調査意図を自動検出
  └─ supplementChatWithSearch() → 知識不足なら自動調査開始
```

## 11. 障害復旧

```
Watchdog（2分間隔）
  ├─ ループ停止検出: タスクなし + キュー空 → scheduleAutonomousTasks()
  └─ タスク停滞検出: 10分以上実行中 → キュー強制クリア + 再開

TaskManager idle イベント → 次サイクル自動トリガー
```

## 12. API エンドポイント一覧

| パス | メソッド | 用途 |
|------|----------|------|
| `/status` | GET | 稼働状態、キュー、フェーズ |
| `/logs` | GET | 直近ログ |
| `/chat-history` | GET | チャット履歴 |
| `/chat` | POST | ユーザーメッセージ送信 |
| `/knowledge` | GET | ナレッジDB検索 |
| `/knowledge-graph` | GET | グラフ構造（ノード+エッジ） |
| `/knowledge-graph/reorganize` | POST | グラフ手動整理 |
| `/knowledge-graph/delete` | POST | ノード削除 |
| `/goals` | GET | ゴール + サブタスク進捗 |
| `/feedback` | GET | アクション成功率統計 |
| `/curiosities` | GET | 未探索トピック一覧 |
| `/settings` | GET/POST | 設定読み書き |
| `/analyze` | POST | コード解析キュー投入 |
| `/pause` | POST | 自律ループ一時停止 |
| `/resume` | POST | 自律ループ再開 |
| `/inject` | POST | 手動リサーチタスク注入 |
