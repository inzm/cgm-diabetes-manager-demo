# AGENTS.md
project: 血糖値・食事・インスリン統合管理 Web版 (Local-First PWA)
load: 常時。詳細は「参照」の該当ファイルを必要時のみ読む。

## 優先順位 (競合時は上位を採用)
1. ユーザーの明示指示
2. docs/Web_Project/ の仕様書 (SSOT)
3. 本ファイル
4. 既存コード
5. legacy_vba/ (参照専用)

## 参照 (トリガー → 読むもの)
- 仕様・データモデル・DDL → docs/Web_Project/ARCHITECTURE.md, docs/Web_Project/SPEC_*.md, docs/Web_Project/USER_GUIDE.md
- 図面 → docs/Web_Project/diagrams/SEQUENCE_AND_ERD.md, docs/Web_Project/diagrams/system_architecture.drawio
- テスト計画 → docs/Web_Project/TEST_PLAN.md
- 仕様変更 / デザイン変更 / ソース⇔仕様書の対応 → skill: spec-sync-and-review
- 検証 / コミット / Push / デプロイ / ブランチ / サブエージェント分担 → skill: ai-orchestrator-pipeline
- 画面撮影 / デザイン検査 → skill: visual-design-test

## 技術スタック
- frontend: React 18+, TypeScript(strict), Vite, Tailwind CSS, shadcn/ui
- local_db: IndexedDB (Dexie.js)
- worker: 大容量CSV処理・異常値抽出は Web Worker
- chart: Apache ECharts
- edge/BFF: Cloudflare Pages + Workers。Gemini API は /api/gemini 経由のみ
- cloud: Supabase (PostgreSQL + Auth)。RLS で医療データを保護

## ルール: 仕様
- 仕様書とコードが食い違う場合、仕様書を正とする。
- 仕様変更・実装では、仕様書を先に更新する。
- UUID主キー / categories.target_type / 論理削除 / マルチテナント構造は Web版を採用する。旧VBA資産と異なる場合も同様。
- legacy_vba/ は参照専用。臨床計算ロジックと画面動線の確認にのみ使う。編集しない。Excel COM を実行しない。

## ルール: 画面表示
- 禁止: 動かないUI (保存されない入力欄、架空データの表示)。
- 未実装領域: 「○○を実装予定」と明記する。
- 未実装機能のボタン: テキストに「（未実装）」を付け、disabled にする。
- 禁止: 事実と異なる「安全に保管」等の表示。
- 禁止: 開発者用語の画面表示 (マスタ / IndexedDB / Dexie / Web Worker / 物理テーブル名)。
- 代替: 「登録済みから選ぶ」「食品・活動」など日常語。
- 削る: 見れば分かる説明文、不要な番号・バッジ。
- 強調する: 血糖値、異常値、合計糖質、保存ボタン。

## ルール: 4軸評価 (設計・実装・レビューの全工程)
- security: 秘密情報は「ルール: 秘密情報」に従う。VITE_APP_MODE=personal かつ Supabase有効で未ログインなら Auth Gate で強制ロックする。未招待の第三者を遮断する。ログアウト時にローカルを全消去する。isReadOnly (家族閲覧) では登録・編集・削除・取込を無効にする。
- extensibility: 固定値 (血糖値 70/180 など) をハードコードしない。設定またはマスタから読む。
- maintainability: 1ロジックは1か所に置く (異常値抽出は src/lib/anomalyExtractor.ts を Worker・デモデータ・再判定で共通利用)。日時は src/lib/dateUtils.ts に統一する。画面間の数値整合性は自動テストで担保する。
- usability: 「ルール: 画面表示」を守る。グラフ・一覧・サマリーの数値と件数を一致させる。
- 問題・トレードオフ・不整合・不要な情報を見つけた場合: 独断で進めず、ユーザーに報告して合意を得る。

## ルール: 実装
- TypeScript: strict: true。any を安易に使わない。API・DB・Props に型を付ける。
- 文字コード: UTF-8 (BOMなし)。
- Local-First: 画面描画時に Supabase へ問い合わせない。IndexedDB から即時取得して描画する。差分同期はバックグラウンドで行う。
- 重い処理: 8.4万行CSVパースと異常値ステートマシンは Web Worker で実行する。メインスレッドを止めない。
- 主キー: UUID (crypto.randomUUID() / gen_random_uuid())。
- 削除: is_deleted = true の論理削除。食事イベント削除時は関連 meal_details も論理削除する。
- RLS: 全テーブルで有効化する。オーナーと招待された家族以外のサインアップ・閲覧を、DBとアプリの両方で遮断する。
- 臨床計算・データ連携を変更した場合: docs/Web_Project/TEST_PLAN.md に基づき src/lib/__tests__/ に単体・統合テストを追加する。

## ルール: 秘密情報
- 禁止: Gemini APIキー / Supabase Service Role Key をフロントエンドコード・localStorage・sessionStorage に置くこと。
- 代替: Cloudflare Workers の環境変数 (Secrets) 経由のプロキシ。

## ルール: 日時
- 禁止: toISOString() での日付切り出し・保存。
- 代替: src/lib/dateUtils.ts の formatLocalDate / buildWallClockIso / buildLocalDateTimeString / extractLocalDateStr / extractLocalTimeStr。
- 形式: event_datetime = YYYY-MM-DDTHH:mm:00.000Z (24文字ウォールクロックISO)。
- 理由: UTC変換で9時間ずれる。また Dexie 複合インデックス ([user_id+event_datetime] 等) の .between() 範囲検索で24文字境界と完全一致させるため。

## ルール: 人の手が必要な項目
- 対象: AIが実行できず、人の作業や判断が必要な項目。
  - 例: Supabase / Cloudflare の設定、権限・秘密情報の設定、臨床上の判断、外部サービスの操作、ユーザーの合意待ちの未決事項、実環境での確認・計測。
- 行動: 見つけたら GitHub Issue に記録する。作成前に既存Issueを検索して重複を避ける。
- 作成先: origin (Private) のみ。
- 禁止: public-demo (Public) への作成。
- 禁止: 秘密情報・実測データ・個人情報をIssueに書くこと。
- 報告: 作成したIssue番号をユーザーに報告する。
- 連携: 仕様書の「【未決事項】」「【要確認】」にはIssue番号を併記する。
- 形式とコマンド: skill: ai-orchestrator-pipeline

## ルール: サブエージェント
- 指定されたスコープ外のファイルを修正しない。

## 手順: 開発 (この順序を守る。コードを先に書かない)
1. 4軸で評価する。仕様書・USER_GUIDE.md・型定義・受け入れ条件・図面を先に更新する。
2. 評価結果と更新した仕様書をユーザーに提示し、合意を得る。
3. 合意した仕様のとおりに実装する。推測コードとハリボテを入れない。
4. 検証: npm run pipeline:verify。
5. 出荷: 仕様書・テスト・コードを同一コミットにする。npm run pipeline:ship:personal -- --message "<メッセージ>" で検証・コミット・Pushし、GitHub Actions で Cloudflare Pages へ自動デプロイする（公開デモは pipeline:ship:demo）。ブランチ運用は skill: ai-orchestrator-pipeline に従う。

## 完了条件 (すべて成功すること)
- npm run test:docs
- npm run typecheck
- npm test
- npm run test:smoke
- npm run test:visual (UI変更時)

## 自動検証 (AIの外で実行される。通ることを完了条件とする)
- npm run test:docs (scripts/verify-docs-sync.mjs): ソースと仕様書・図面・DDL・型定義の同期。禁止パターン (localStorageへのAPIキー保存、虚偽文言、UIへの開発者用語、旧VBA資料のGit追跡) を検出する。
- .git/hooks/pre-commit: コミット時に test:docs --staged、typecheck、npm test を実行する。
- .agents/hooks.json -> .agents/hooks/stop-guard.mjs: 仕様書の更新漏れ・UX違反・セキュリティ違反が残る間、ターン終了をブロックする。
- npm run test:smoke: Vite開発サーバーが全エンドポイントでエラーなく応答することを検証する。
