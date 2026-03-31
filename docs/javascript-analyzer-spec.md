# JavaScript Analyzer 仕様書

## 1. 開発環境

- **ランタイム**: Node.js >= 22.0.0
- **モジュール形式**: CommonJS (`'use strict'`)
- **非同期処理**: async/await ベース
- **依存**: 外部パッケージ不使用（Node.js 標準ライブラリ + プロジェクト内 lib のみ）
- **LLM連携**: `lib/ollama-client.js` の `OllamaClient` を使用

## 2. コードフォーマッター (`core/analyze-result/formatter.js`)

ソースコードを自動整形し、プロジェクト規約に準拠させる。

### 変換ルール

| 対象 | 変換 | 例 |
|------|------|-----|
| `var` 宣言 | → `const`（再代入あり → `let`） | `var x = 1` → `const x = 1` |
| `function` 宣言 | → `const + アロー関数` | `function foo(a) { ... }` → `const foo = (a) => { ... }` |
| メソッド定義 | 変換しない（クラス構文・オブジェクトリテラル内は除外） | — |
| `module.exports` 内の関数 | 変換しない | — |
| コンストラクタ関数 | 変換しない（`new` で呼ばれる関数） | — |

### 安全性ルール

- AST を使わず正規表現ベースで変換する（外部パッケージ不使用のため）
- 変換前に `vm.Script` で構文チェック → 変換後も構文チェック → 失敗時はロールバック
- 文字列リテラル内・コメント内のパターンは変換しない
- `arguments` キーワードを使用する関数はアロー関数に変換しない
- `this` を使用する非メソッド関数はアロー関数に変換しない
- ジェネレータ関数 (`function*`) は変換しない

### 出力

- フォーマット済みコードを文字列で返す
- 変換ログ（何を変換したか）をオブジェクトで返す

## 3. 二段階解析エンジン

### 3.1 Unit Analysis (`core/analyze-result/unit-analyzer.js`)

ファイル内の各関数を個別に解析する。

**入力**: ファイルパス
**処理**:
1. `lib/analyzer.js` の `extractFunctions` で関数一覧を取得
2. 各関数について `extractFunctionBody` で本体を抽出
3. LLM に以下を問い合わせ:
   - 関数の目的（1文）
   - 入力パラメータの意味
   - 戻り値の説明
   - 副作用の有無と内容
   - 呼び出している他の関数
   - エラーハンドリングの有無
4. セキュリティチェック: `lib/configurator.js` の `validateCode` を実行

**出力** (関数ごと):
```json
{
  "name": "functionName",
  "params": "a, b",
  "purpose": "...",
  "inputs": { "a": "...", "b": "..." },
  "returns": "...",
  "sideEffects": ["file write", "network call"],
  "calls": ["otherFunc", "helperFunc"],
  "errorHandling": true,
  "security": { "valid": true, "issues": [] }
}
```

### 3.2 Structural Analysis (`core/analyze-result/structural-analyzer.js`)

ファイル全体の構造を解析する。Unit Analysis の結果を入力として受け取る。

**入力**: ファイルパス + Unit Analysis 結果
**処理**:
1. ファイルの `require`/`module.exports` を静的解析
2. Unit Analysis 結果を集約
3. LLM に以下を問い合わせ:
   - ファイル全体の役割（1-2文）
   - モジュール間の依存関係の評価
   - 設計上の問題点（循環依存、過度な結合など）
   - リファクタリング提案（あれば）

**出力** (`.summary.md` として `analyze-result/` ディレクトリに Markdown 形式で保存):

```markdown
<!-- @analysis-data
{...JSONデータ（機械読み取り用）...}
-->

# core/evolution.js

| 項目 | 値 |
|------|-----|
| 解析日時 | 2026-03-30T12:00:00.000Z |
| 行数 | 450 |
| 役割 | 自己修正と進化を管理するモジュール |
| 依存健全性 | good |

## require
- `fs`
- `path`
- `./knowledge-graph`

## exports
- `dreamPhase`
- `chat`
- `generateModule`

## 関数一覧

### `dreamPhase(...)`
目的の説明文

- **入力**: `client` — OllamaClientインスタンス
- **戻り値**: 実行結果オブジェクト
- **副作用**: file write
- **呼び出し**: `compressKnowledge`, `generateModule`
- **エラーハンドリング**: あり

## 問題点
- （あれば列挙）

## リファクタリング提案
- （あれば列挙）
```

> **Note**: HTMLコメント `<!-- @analysis-data ... -->` 内にJSON形式の構造化データを埋め込んでおり、`parseSummaryMarkdown()` で機械的に読み取り可能。

## 4. 自律ループ (`core/analyze-result/analyze-loop.js`)

### 動作フロー

```
起動
  ↓
ディレクトリ監視開始 (lib/watcher.js ベース)
  ↓
ファイル変更検知
  ↓
フォーマッター実行 → 変換あり？ → ファイル上書き
  ↓
Unit Analysis 実行
  ↓
Structural Analysis 実行
  ↓
.summary.md を analyze-result/ に保存
  ↓
待機（次の変更 or スケジュールイベント）
```

### 監視対象

- `core/` — 中核ロジック
- `lib/` — 共通ユーティリティ
- `explorers/` — 外部知見取得
- `brain/modules/` — LLM 生成コード

### 除外対象

- `node_modules/`, `.git/`, `ui/`, `brain/` (modules以外), `analyze-result/`
- `.summary.md` ファイル
- `.json` ファイル（設定ファイル等）

### 初回起動時の全スキャン

起動時に監視対象ディレクトリの全 `.js` ファイルをスキャンし、`.summary.md` が存在しないか古い（ソースより古い）ファイルを解析キューに追加する。

### 日次学習データ生成 (05:00)

毎日 05:00 に以下を実行:
1. `analyze-result/` 内の全 `.summary.md` を読み込み
2. ファイル間の依存関係グラフを構築
3. 全体的な設計問題を LLM で分析
4. 学習データとして `brain/analysis/` に JSONL 形式で保存
5. repair list 内の未修復ファイルを再試行

### キュー管理

- 変更検知されたファイルはキューに追加
- キューは FIFO で処理（同一ファイルの重複はスキップ）
- LLM クエリは `priority: false`（自律処理として実行、ユーザーチャット優先）

## 5. エラーハンドリング

### 基本方針

- すべての処理を try-catch で囲む
- エラー発生時はスキップして次のファイル/関数へ進む
- システム全体を停止させない

### 修復リスト (`analyze-result/repair-list.json`)

フォーマッターや解析で失敗したファイルを記録する:

```json
{
  "files": [
    {
      "path": "core/evolution.js",
      "error": "SyntaxError after formatting",
      "failedAt": "2026-03-30T12:00:00.000Z",
      "retryCount": 0,
      "lastRetry": null
    }
  ]
}
```

- 日次学習データ生成時に再試行（最大3回）
- 3回失敗したファイルはフォーマットをスキップし、解析のみ実行
- 修復成功時はリストから削除

### LLM クエリエラー

- タイムアウト/接続エラー → 3回リトライ（OllamaClient のフェイルオーバーに委任）
- JSON パース失敗 → `lib/json-parser.js` の `parseJsonSafe` でベストエフォート
- 解析不能 → 静的解析結果のみで `.summary.md` を生成（LLM 部分は空）

## 6. ディレクトリ構造

```
core/analyze-result/
├── formatter.js           # コードフォーマッター
├── unit-analyzer.js       # Unit Analysis（関数単位）
├── structural-analyzer.js # Structural Analysis（ファイル単位）
└── analyze-loop.js        # 自律ループ（監視・キュー・スケジュール）

analyze-result/                   # 解析出力ディレクトリ（自動生成）
├── core/
│   ├── evolution.summary.md
│   ├── agent-loop.summary.md
│   └── ...
├── lib/
│   ├── analyzer.summary.md
│   └── ...
└── repair-list.json       # 修復対象リスト

prompts/
├── analyze-unit.system.txt   # Unit Analysis 用システムプロンプト
├── analyze-unit.user.txt     # Unit Analysis 用ユーザープロンプト
├── analyze-struct.system.txt # Structural Analysis 用システムプロンプト
└── analyze-struct.user.txt   # Structural Analysis 用ユーザープロンプト
```

### 既存コードとの関係

| 既存ファイル | 役割 | 新システムでの利用 |
|---|---|---|
| `lib/analyzer.js` | 関数抽出、静的解析 | `extractFunctions`, `extractFunctionBody`, `scanDirectory` を再利用 |
| `lib/watcher.js` | ファイル監視 | `startWatcher` を監視基盤として利用 |
| `lib/configurator.js` | セキュリティ検閲 | `validateCode` をセキュリティチェックに利用 |
| `lib/ollama-client.js` | LLM クライアント | `query`, `queryForJson` を LLM 解析に利用 |
| `lib/json-parser.js` | JSON パーサー | `parseJsonSafe` をレスポンスパースに利用 |
