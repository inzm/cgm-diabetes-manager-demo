# プロジェクト開発ルール & AIドキュメント駆動開発規約 (AGENTS.md)

このドキュメントは、本リポジトリ（血糖値・食事・インスリン統合管理システム Web版）において、AI（Antigravity）および各種サブエージェントが **「ドキュメント駆動開発（Document-Driven Development: DDD）」** を徹底し、自律協調しながら開発を進めるための基本原則、コーディング規約、および開発プロセスを定めた最優先ルールです。

---

## 1. プロジェクト概要 & 技術スタック

本システムは、CGM（持続血糖測定器: FreeStyleリブレ）の生データと患者・家族の記録を統合管理する **Local-First マルチデバイスWebアプリケーション（PWA）** です。

| レイヤー | 採用技術 | 役割・責務 |
| :--- | :--- | :--- |
| **フロントエンド** | **React 18+ / TypeScript / Vite** | コンポーネント指向UI、厳格な型安全性、PWA対応 |
| **デザインシステム** | **Tailwind CSS + shadcn/ui** | モダンなダッシュボードUI（Slate, Emerald, Sky, Rose, Amber基調） |
| **ローカルデータベース** | **IndexedDB (Dexie.js)** | 8.4万件リブレ生データのローカル保持、0.01秒描画、完全オフライン対応 |
| **バックグラウンド処理** | **Web Worker** | 大容量CSVパース、異常値抽出ステートマシンをUIスレッドから完全分離 |
| **グラフ可視化** | **Apache ECharts** | 24H血糖散布図（垂直ドロップ破線・食事/異常重畳）、複合グラフ、マイクロSVG |
| **エッジ & BFF** | **Cloudflare Pages + Workers** | エッジ高速配信、Google Gemini APIキーの安全な秘匿プロキシ（`/api/gemini`） |
| **クラウド BaaS & DB** | **Supabase (PostgreSQL + Auth)** | Row Level Security (RLS) による医療データ保護、家族見守り権限、Realtime同期 |
| **外部AI連携** | **Google Gemini REST API (BFF経由)** | 食品名からの糖質量自動推定（BFF未接続時は内蔵の日本食品標準成分辞書で推論） |

---

## 2. ドキュメント駆動開発 (DDD) の絶対原則

本プロジェクトでは、**「仕様書（ドキュメント）がコードの上位に立ち、コードは仕様書の忠実な具現化に過ぎない」** という原則を厳格に適用します。

### 2.1 Single Source of Truth (SSOT: 真実の単一情報源) と優先順位ルール
- システムのすべての要件、データモデル、APIインターフェース、画面振る舞いは、[`docs/Web_Project/`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/docs/Web_Project) 配下のドキュメント群が唯一の真実（SSOT）です。
- **コードと仕様書に乖離がある場合、いかなる場合も仕様書の記述が正とみなされます。**
- **Webプロジェクト設計優先の原則（重要）**:
  - Webプロジェクトで追加・定義された仕様がドキュメント（`docs/Web_Project/*.md`）に記されている場合、または **Webプロジェクトのデータベース設計（`ARCHITECTURE.md` / `src/types/database.ts` / `src/lib/db.ts` の UUID主キー・`categories` の `target_type` 区分・論理削除・マルチテナント構造等）と旧VBAプロジェクト（`legacy_vba/`）のマスタ・データ構造が異なる場合は、例外なくWebプロジェクトの設計・データ構造を最優先すること**。
  - 旧VBA資産（`legacy_vba/vba_exported/`）は、臨床計算ロジック（異常値抽出ステートマシン、食前/食後ピーク探索、4時間帯集計等）、画面間のデータ連携要件（マスタ選択連動、設定閾値連動等）、および不要な装飾の排除を確認するためのリファレンスとして活用し、データベーススキーマはWeb版正規化設計を維持する。

### 2.2 ドキュメント体系の階層構造
開発は以下の3層のドキュメント構造に従って進められます：
- **Level 1: 全体アーキテクチャ & 共通基盤**
  - [`ARCHITECTURE.md`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/docs/Web_Project/ARCHITECTURE.md): システム構成、Local-First同期、認証・権限、本番DDL
  - [`SEQUENCE_AND_ERD.md`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/docs/Web_Project/diagrams/SEQUENCE_AND_ERD.md): 認可・同期シーケンス、Mermaid ER図
  - [`system_architecture.drawio`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/docs/Web_Project/diagrams/system_architecture.drawio): GUI編集可能な全体構成図
- **Level 2: 画面・機能別詳細仕様書 & ユーザーガイド (実装前・変更時更新必須)**
  - 各画面（カレンダー、日次詳細、食品、イベント、分析、ログイン画面等）の実装や仕様変更に着手する際は、必ず `docs/Web_Project/SPEC_*.md` および患者・家族向け操作手順書 [`USER_GUIDE.md`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/docs/Web_Project/USER_GUIDE.md) を策定・同時更新し、受け入れ基準（DoD）を定義すること。
- **Level 3: 実装コード & テスト**
  - Level 1およびLevel 2に100%合致するソースコード、型定義、マイグレーションSQL。

### 2.3 暗黙仕様・虚偽表示・ハリボテ実装の絶対禁止（重要）
1. **ハリボテ（外観のみ）実装の完全排除**:
   - **機能が実装されていないのに実装されているかのような外観（モック配列による架空人物表示、保存されないダミー入力欄、機能しないリンク等）を作ることを固く禁止します。** ユーザーがどこまで実装されているかを正確に把握する妨げになるためです。
2. **未実装領域・未実装ボタンの明示ルール**:
   - 将来実装予定の領域を設ける場合は、コンテンツ領域内に **「○○を実装予定」** 等と事実通りに明記すること。
   - 実装されていない機能を呼び出すボタンを配置する場合は、**必ずボタンテキストに `（未実装）` を追加し、`disabled` 状態にすること**。
3. **事実と異なるセキュリティ・機能表示の厳禁**:
   - ブラウザの平文ストレージ（`localStorage` 等）にAPIキーや機密情報を保存すること、およびそれを「安全に保管されます」等と事実と異なる表現で画面や仕様書に記載することを重大な違反として禁止します。

### 2.4 ダイアグラム（Mermaid / draw.io）の第一級市民化
- テキストだけでなく、Mermaidのシーケンス図・ER図、およびdraw.ioの構成図も「コードと同等の設計原本（First-class citizen）」として扱います。
- テーブル変更やアーキテクチャ変更が発生した場合は、**必ず図面（Mermaid / draw.io）も同時に更新すること**。

### 2.5 AIによる4軸自律評価（セキュリティ・拡張性・保守性・ユーザビリティ）とユーザー相談義務
AI（および全サブエージェント）は、設計・実装・レビューのすべての工程において、以下の **4つの評価軸** でシステムを自律的に点検・評価し、**問題点・トレードオフ・不整合・不要な情報を発見した場合は、独断で進めず必ずユーザーに報告・相談して合意を得ること** を徹底します。

| 評価軸 | 自律評価・チェックすべき具体的観点 |
| :--- | :--- |
| **1. セキュリティ (Security)** | ・APIキー（Gemini API等）やシークレットをブラウザの `localStorage` / `sessionStorage` やフロントエンドコードに保持しない（必ずCloudflare Workers BFF `/api/gemini` 経由とし、虚偽の「安全保管」表示をしない）<br>・本番モード（`VITE_APP_MODE=personal` かつ Supabase 有効時）における未ログイン時の専用ログイン画面（Auth Gate）強制ロック、未招待第三者のサインアップ/アクセス遮断、およびログアウト時のローカルキャッシュ完全消去<br>・家族閲覧ロール（`isReadOnly`）における登録・編集・削除・設定変更の完全ロック<br>・患者ID（`user_id`）によるデータ分離とRLS整合性 |
| **2. 拡張性 (Extensibility)** | ・Web版DBスキーマ（UUID、`categories.target_type`、`event_master`、`user_settings` 等）を活かした疎結合な設計<br>・ハードコードされた選択肢や固定閾値（`70`/`180`等）を排除し、マスタや設定テーブルから動的に読み込む構造<br>・将来のSupabaseクラウド同期や新カテゴリ追加時に破綻しないインターフェース |
| **3. 保守性 (Maintainability)** | ・「1つのロジック＝1つのSingle Source of Truth（関数・モジュール）」の徹底（例: 異常値抽出ステートマシン `anomalyExtractor.ts` をWorker・デモデータ生成・再判定で共通化）<br>・タイムゾーン処理（ローカル時刻とUTCの混同防止 `dateUtils.ts`）の統一ヘルパー化<br>・自動統合テストによる画面間データ整合性（マスタ ⇔ 記録 ⇔ カレンダー ⇔ 分析）の機械的保証 |
| **4. ユーザビリティ (Usability)** | ・**徹底したユーザー目線（開発者用語の排除）**: 画面表示文言に「マスタ」「IndexedDB」「Dexie」「Web Worker」「物理テーブル名（`libre_readings`等）」などの開発者目線用語を一切露出させず、「登録済みから選ぶ」「よく使う食品・活動」など日常の言葉に統一する<br>・**引き算の法則と視覚的メリハリ**: 見れば分かる説明文・サブタイトル・不要な番号ラベル（①/②）を削ぎ落とし、主役（血糖値・異常値・合計糖質・保存ボタン）を目立たせ脇役を控えめにする<br>・実際には機能しない外観のみ（ハリボテ）のUIの完全排除（未実装ボタンには必ず `（未実装）` を表記）<br>・グラフ・一覧・サマリー間で数値や件数が100%一致する高い信頼性と視認性 |

---

## 3. AIオーケストレーション & サブエージェント協調原則

複数のAIエージェントが協調動作し、コード修正からスクリーンショットデザイン検証・仕様書更新・Git Push・Cloudflare Pagesデプロイまでをノンストップで自動遂行する際は、以下の責務分担とスキル連携ルールを遵守すること：

1. **専門サブエージェントの役割分担 (`define_subagent` / `invoke_subagent`)**:
   - **Orchestrator Agent (親エージェント)**: ユーザー要件の4軸自律評価、サブエージェントへのタスク分割・ファイル境界割り当て、および最終パイプライン（`npm run pipeline:verify` / `npm run pipeline:ship`）の統括。
   - **Spec & Docs Agent**: コード変更に対応する `docs/Web_Project/SPEC_*.md`・`USER_GUIDE.md`・`ARCHITECTURE.md`・図面（Mermaid / draw.io）の先行・同時更新（`spec-sync-and-review` スキル準拠）。
   - **Frontend / Logic Agent**: 仕様書に準拠したReactコンポーネント、Tailwindスタイル、ECharts描画、Dexie.js / Web Worker 処理、および単体・統合テストの実装。
   - **Visual QA & E2E Agent**: Playwrightによる全11画面（デスクトップ `1280x800` ＆モバイル `375x812`）の自動スクリーンショット撮影（`npm run test:visual`）、DOMレイアウト監査（横スクロール・開発者用語ゼロ検証）、および `read_file` によるPNG画像のマルチモーダル視覚検査（`visual-design-test` スキル準拠）。
   - **Release & Deploy Agent**: 全品質ゲート通過後のアトミックコミット、Git Push、および Cloudflare Pages への自動デプロイ実行（`ai-orchestrator-pipeline` スキル準拠）。
2. **一気通貫ノンストップ・オーケストレーションパイプライン (`scripts/orchestrate-pipeline.mjs`)**:
   - 検証＋スクリーンショット撮影を一括実行する場合は `npm run pipeline:verify` を使用する。
   - コード修正からテスト・仕様書更新・コミット・Git Push・Cloudflare Pagesデプロイまでをノンストップで完全自動実行する場合は `npm run pipeline:ship:personal -- --message "<commit message>"`（本番）または `npm run pipeline:ship:demo -- --message "<commit message>"`（公開デモ）を使用する。
   - エージェントのターン終了時には `.agents/hooks.json`（`.agents/hooks/stop-guard.mjs`）が自動発動し、仕様書の更新漏れやUX/セキュリティ違反が残っている場合は停止をブロックして自律修正を継続させる。
3. **過去資産（`legacy_vba/`）の参照限定ルール**:
   - `legacy_vba/` 配下のファイル（`main.xlsm`, `data.csv`, `vba_exported/` 等）は、**「臨床計算アルゴリズムの正解ロジックやUX動線を確認するための参照専用」** とする。
   - Webプロジェクトの仕様書（`docs/Web_Project/*.md`）やWeb版DB設計とVBA側のデータ構造が異なる場合は、**常にWebプロジェクトの設計を優先する**。
   - VBAコードの直接編集やExcel COMの実行は行わない。

---

## 4. コーディング規約 & 品質基準

1. **文字コード・改行コード**:
   - すべてのファイルは **UTF-8（BOMなし）** で作成・保存すること。（旧VBAのShift-JIS/CP932は完全廃止）
   - 改行コードは `LF`（またはWindows環境における統一された `CRLF`）。
2. **TypeScript 厳格準拠**:
   - `tsconfig.json` の `strict: true` を前提とし、`any` 型の安易な使用を禁止する。
   - すべてのAPIリクエスト/レスポンス、DBエンティティ、コンポーネントPropsに明確な型定義を付与すること。
3. **Local-First & パフォーマンス規約**:
   - 画面描画時に毎回Supabaseへ直接ネットワークリクエストを送るコードを書いてはならない。必ず **IndexedDB（Dexie.js）から即座にデータを取得して描画** し、バックグラウンドで差分同期を行うこと。
   - 8.4万行のCSVパースや異常値ステートマシン等の重いループ処理は、メインスレッドをブロックしないよう必ず **Web Worker** に委譲すること。
4. **秘密情報（シークレット）の保護**:
   - Google Gemini API キーや Supabase Service Role Key などの秘密情報をフロントエンドコードやブラウザの `localStorage` / `sessionStorage` に保存・埋め込むことを厳禁とする。
   - 必ず Cloudflare Workers の環境変数（Secrets）を経由するサーバーサイドプロキシ（`/api/gemini`）方式とすること。

---

## 5. データ整合性・セキュリティ規約（重要）

1. **Supabase RLS（行レベルセキュリティ）と招待専用アクセスの完全遵守**:
   - すべてのテーブルで RLS を強制有効化し、`is_authorized_system_user` / `can_view_patient_data(user_id)` / `can_edit_patient_data(user_id)` および `auth.users` トリガー（`trg_enforce_invited_or_owner_signup`）を適用すること。
   - オーナー（患者本人）およびオーナーが `family_permissions` に招待した家族以外の第三者によるサインアップ・データ閲覧をデータベース層とアプリ層（Auth Gate）の両方で100%遮断する。
2. **家族閲覧ロール（`family_viewer`）の不可侵性**:
   - 家族アカウントでログインしている場合（`isReadOnly === true`）、UI上で登録・編集・削除・CSV取込ボタンを物理的に非表示または非活性化（disabled）すること。
3. **主キーとオフライン採番の保証**:
   - 主キーはすべて **UUID**（`gen_random_uuid()` / `crypto.randomUUID()`）を採用し、オフライン時の端末側採番によるID衝突を原理的に防止すること。
4. **統合日時（`event_datetime`）のローカルタイムゾーン統一**:
   - 日時文字列の生成・比較・切り出しは `src/lib/dateUtils.ts` のローカル日時ヘルパー（`YYYY-MM-DDTHH:mm:00`）に統一し、`toISOString()` による9時間のUTC時刻ズレを100%防止すること。
5. **論理削除（Soft Delete）とカスケード処理**:
   - 食事や活動の削除時は `is_deleted = true` による論理削除を徹底し、マルチデバイス同期での削除漏れを防止すること。食事イベント削除時は関連する `meal_details` も連動して論理削除すること。

---

## 6. ドキュメント駆動開発 (DDD) 開発プロセス・ライフサイクル

すべての機能実装および仕様変更は、以下の **5段階のDDDライフサイクル** を厳格に遵守して進行します。コードを先に書くことは例外なく許可されません。

```text
  [Step 1: 4軸自律評価 & 仕様定義・更新 (Spec-First)]
    セキュリティ・拡張性・保守性・ユーザビリティを自律評価し、
    docs/Web_Project/ 配下の仕様書・USER_GUIDE.md・型定義・受け入れ条件(DoD)・図面を先行作成/更新
           ▼
  [Step 2: 設計レビュー & ユーザー相談・合意]
    評価結果・懸念点・選択肢と更新した仕様書の内容をユーザーへ提示し、合意を形成
           ▼
  [Step 3: 仕様準拠実装 (Spec-to-Code)]
    合意された仕様書の内容に100%忠実にコードを実装 (推測コード・ハリボテUI・虚偽表示の混入ゼロ)
           ▼
  [Step 4: 受け入れ基準に基づく検証 (Verification & Quality Gateway)]
    ・仕様書・ユーザーガイド・ソース同期＆セキュリティ検査 (npm run test:docs)
    ・TypeScript型検査 (npm run typecheck)
    ・本番バンドル整合性検査 (npm run build)
    ・臨床計算・データ整合性単体/統合テスト (npm test: 全件Green必須)
    ・開発サーバーランタイム検証 (npm run test:smoke: エラーオーバーレイゼロ必須)
    ・スクリーンショット自動撮影＆マルチモーダルデザイン検査 (npm run test:visual)
           ▼
  [Step 5: 同期コミット・Push & 自動デプロイ (npm run pipeline:ship)]
    仕様書、テストコード、実装コードを同一のGitコミットに記録し、リモートPushおよびCloudflare Pagesデプロイまで完遂する
```

---

## 7. 2系統ブランチ & オーケストレーション出荷運用規約 (`main` / `demo-public`)

本プロジェクトでは、**「患者・家族向け本番環境（Private リポジトリ `origin` / `main` ブランチ）」** と **「採用・ポートフォリオ向け公開デモ環境（Public リポジトリ `public-demo` / `demo-public` ブランチ）」** の2系統を安全かつ高速に運用するため、ドキュメント駆動開発（DDD）と一気通貫パイプライン（`scripts/orchestrate-pipeline.mjs`）を連動させます。

### 7.1 2系統ブランチの役割と隔離原則
| ブランチ名 | リモート / デプロイ先 | 用途とセキュリティ制約 |
| :--- | :--- | :--- |
| **`main`** | Private: `origin/main`<br>Cloudflare Pages: `cgm-diabetes-manager-personal` | **日常の開発・検証・個人本番運用の主軸ブランチ**。仕様書・図面・テスト・実装コードを同一コミットで管理し、`npm run pipeline:ship:personal` で全品質ゲート（`test:docs`, `typecheck`, `test`, `test:smoke`, `test:e2e:regression`, `test:visual`）通過後に直接コミット・Push・本番デプロイを行う。 |
| **`demo-public`** | Public: `public-demo/main`<br>Cloudflare Pages: `cgm-diabetes-manager-demo` | **公開ポートフォリオ専用のクリーンブランチ**。`legacy_vba/` 配下の旧資産ファイルをGitインデックスから完全除外し、`main` で検証済みのコミットを `git cherry-pick` で取り込んだ上で `npm run pipeline:ship:demo`（`PHASE-0-GUARD` 付き）により出荷する。 |
| **`feature/*`, `fix/*`, `docs/*`, `refactor/*`** | 任意（大規模改修・並行実験時） | 複数機能を並行開発する場合やPRレビューを挟む場合に任意で作成するトピックブランチ。 |

### 7.2 コミット & 出荷ゲート規約
1. **アトミックコミット（Spec + Code + Test 同時記録）**:
   - 実装コード（`src/`, `functions/`, `supabase/`）、仕様書・図面（`docs/Web_Project/`）、およびテストコードを必ず同一のGitコミットにまとめ、コミットメッセージには変更種別を明記する（例: `feat(personal): enforce BFF JWT/Same-Origin auth and DDL parity gate`）。
   - サブエージェントは、**親エージェントから指定されたタスクのスコープ外のファイルを勝手に修正してはならない**。
2. **全品質ゲート通過による自動出荷保証**:
   - `git commit` 時は `.git/hooks/pre-commit`（`npm run test:docs` + `npm run typecheck`）が自動実行され、出荷時は `npm run pipeline:verify` / `npm run pipeline:ship:personal` / `npm run pipeline:ship:demo` によって単体テスト・Viteスモークテスト・Playwright E2E 全14スイート・11画面ビジュアル監査が100% PASS した状態でのみリモートPushおよびデプロイが行われる。

---

## 8. 品質ゲートウェイ & 再発防止規約 (Quality Gateway)

静的解析（`tsc` / `build`）のすり抜けやモジュール解決キャッシュによる画面クラッシュ、および仕様書の更新漏れ・危険なストレージ使用を100%防止するため、以下の規約を強制します。

### 8.1 開発サーバー・ランタイムスモークテストの義務化 (`npm run test:smoke`)
- 静的バンドルが成功しても、Vite開発サーバーのメモリ内キャッシュやHMRにより `Failed to resolve import` や `Internal server error` が発生するケースがある。
- AIエージェントは、機能実装・共通コンポーネント追加・リファクタリング完了時、**`npm run test:smoke`（`npm run verify:all` および `npm run pipeline:verify` に統合済み）を実行し、全56エンドポイントが HTTP 200 かつエラーパターンなし（clean response）であることを機械的に検証しなければならない**。

### 8.2 臨床計算アルゴリズム & 画面間データ整合性の単体・統合テスト必須化 (`npm test`)
- 医療・臨床データ（血糖上昇幅Δ、ステートマシン異常値判定、時間帯4区分、糖質合算等）の計算ロジックおよびマスタ・設定・記録・分析間のデータ連携を変更・追加する場合、必ず [`docs/Web_Project/TEST_PLAN.md`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/docs/Web_Project/TEST_PLAN.md) に基づき `src/lib/__tests__/` 配下に単体・統合テストを作成すること。

### 8.3 タイムゾーン安全規約 (`src/lib/dateUtils.ts`)
- 日時・期間集計やカレンダー日付生成・前後日移動・イベント保存において、`toISOString()` による日付切り出しや時刻保存は UTC 変換による9時間ズレを引き起こすため厳禁とする。
- 必ず `src/lib/dateUtils.ts` のローカルタイムゾーン安全関数（`formatLocalDate`, `buildLocalDateTimeString`, `extractLocalDateStr`, `extractLocalTimeStr`）を使用すること。

### 8.4 ドキュメント・図面・DDL同期 & セキュリティ・ハリボテ・開発者用語防止強制ゲート (`npm run test:docs`)
- ソースコード（`src/components/*`, `src/contexts/*`, `src/lib/*`, `src/types/*`, `src/workers/*`, `functions/*`, `supabase/migrations/*`）を変更した際、対応する仕様書・図面（`docs/Web_Project/SPEC_*.md`, `ARCHITECTURE.md`, `USER_GUIDE.md`, `docs/Web_Project/diagrams/*`）が同一変更セット内で更新されていること、`supabase/migrations/0001_initial_schema.sql` と `ARCHITECTURE.md` Section 5 のDDLが100%一致していること、全モジュールがマッピング＆スモークテスト登録されていること、ブラウザの `localStorage` にAPIキーを保存する危険なコードや虚偽の「安全保管」文言が存在しないこと、およびUIコンポーネント内に「マスタ」「IndexedDB」「Dexie.js」「Web Worker」等の開発者用語が露出していないことを [`scripts/verify-docs-sync.mjs`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/scripts/verify-docs-sync.mjs) により機械的に検証する。
