# AGENTS.md
project: 血糖値・食事・インスリン統合管理 Web版 (Local-First PWA)
load: 常時コア規約。領域別詳細ルールと手順は「参照」の該当ファイルのみを読む（Progressive Disclosure）。

## 優先順位 (競合時は上位を採用)
1. ユーザーの明示指示
2. `docs/Web_Project/` の仕様書 (SSOT)
3. 本ファイルおよび `.agents/rules/*.md`
4. 既存コード
5. `legacy_vba/` (参照専用・編集禁止・Excel COM 実行禁止)

## 参照 (トリガー → 読むもの)
- 仕様・画面動線・テスト計画 → `docs/Web_Project/README.md`, `docs/Web_Project/ARCHITECTURE.md`, `docs/Web_Project/SPEC_*.md`, `docs/Web_Project/USER_GUIDE.md`, `docs/Web_Project/TEST_PLAN.md`
- 図面 → `docs/Web_Project/diagrams/SEQUENCE_AND_ERD.md`, `docs/Web_Project/diagrams/CSV_IMPORT_AND_ANOMALY_FLOW.md`, `docs/Web_Project/diagrams/system_architecture.drawio`
- DB・マイグレーション・RLS・Dexie・クラウド同期 → `.agents/rules/db-rls.md` + skill: `supabase-drift-audit`
- BFF (`/api/gemini`)・秘密情報・バンドル分離・CI/CD → `.agents/rules/bff-gemini.md`
- 日時生成・カレンダー日付・タイムゾーン正規化 → `.agents/rules/wallclock-date.md`
- 仕様変更 / デザイン変更 / ソース⇔仕様書対応 → skill: `spec-sync-and-review`
- 検証 / 明示ステージング / Push / デプロイ / サブエージェント分担 → skill: `ai-orchestrator-pipeline`
- 画面撮影 / デザイン検査 → skill: `visual-design-test`
- 出荷後の GitHub Actions 監視 / 実 URL 疎通確認 → skill: `post-deploy-verify`

## 技術スタック
- frontend: React 18+, TypeScript (`strict: true`), Vite, Tailwind CSS, Apache ECharts
- local_db & worker: IndexedDB (`Dexie`) / デモ用 `InMemoryTable`、大容量CSV処理・異常値抽出は Web Worker
- edge & cloud: Cloudflare Pages + Functions (`/api/gemini` BFF)、Supabase (PostgreSQL + Auth + RLS + `app_private` スキーマ隔離)

## ルール: 仕様 (DDD・Spec-First)
- 仕様書とコードが食い違う場合は仕様書を正とする。
- 仕様変更を伴う実装では先に仕様書・図面を更新してユーザー合意を得てから、第1コミット `docs(spec): <要約>` → 第2コミット `feat` / `fix` の2段階で記録し同一出荷サイクルで完結させる。
- 禁止: 仕様書 (`docs/Web_Project/`) への未完了ステータスタグ (`【未決事項】` / `【要確認】` / `【改修予定】` / `【実装予定】` / `【将来案】`)、内部 Issue 番号、およびローカル端末パス (`file:///` 等) の記載。仕様書には確定動作と必須環境要件のみを断定形で書く。

## ルール: 画面表示・UX
- 禁止: 動かないハリボテ UI、架空データの表示、虚偽のセキュリティ文言、ネイティブ `window.confirm()`（`ConfirmDialog` を使う）、モバイルを含む横スクロールの発生。
- 未実装・デモ制限表示: 本番の未実装ボタンは `（未実装）`＋`disabled` とする。公開デモ (`portfolio`) では未実装・開発用セクションを非表示とし、デモ制限操作は「デモアプリでは利用できません」＋`disabled` を明示する。
- 禁止: 開発者用語の画面表示（マスタ / IndexedDB / Dexie / Web Worker / 物理テーブル名）。「よく使う食品」「登録済みから選ぶ」等の日常語を使う。

## ルール: 4軸評価・実装不変条件
- **security**: 秘密キーのフロントエンド・Git追跡混入禁止（詳細は `.agents/rules/bff-gemini.md`）。本番未ログイン時は `AuthGateScreen` で遮断し、UI (`isReadOnly`)・BFF (JWT検証＋レート制限)・DB (RLS＋`app_private`) の全層で保護する。
- **extensibility**: 臨床閾値 (70/180 等) や区分をハードコードせず設定・登録データから読む。`dist-personal` と `dist-portfolio` を物理分離し、クライアント内にテスト用バックドアフラグを置かない。
- **maintainability**: TypeScript `strict: true`、UTF-8 (BOMなし)。1ロジック・1仕様は1か所に集約する（異常値抽出 `src/lib/anomalyExtractor.ts`、24文字壁時計日時 `src/lib/dateUtils.ts` — 詳細は `.agents/rules/wallclock-date.md`、6層スキーマ同期は `.agents/rules/db-rls.md`）。
- **usability**: グラフ・一覧・サマリーの数値と件数を一致させ、自動テスト (`src/lib/__tests__/`) で担保する。問題・トレードオフを発見した場合は独断で進めずユーザーへ報告して合意を得る。

## ルール: 人の手が必要な項目とサブエージェント統制
- AI が実行できない外部設定・秘密情報登録・臨床判断は、重複確認の上で Private リポジトリ (`origin`) の GitHub Issue にのみ記録し（公開 `public-demo` への作成および個人情報・実測値の記載は禁止）、Issue番号をユーザーへ報告する。
- 並列サブエージェントを起動する際は対象ファイル境界（または独立 `git worktree`）を分離して同時編集競合を防ぎ、最終検証・明示 `git add`（`git add -A` 禁止）・コミット・Push は親エージェントが統括する（詳細: skill `ai-orchestrator-pipeline`）。

## 完了条件と外部自動ゲート (すべて成功すること)
- 実装中の中間確認 (`npm run pipeline:verify:quick`): `npm run test:docs` (Strict) + 4プロジェクト並列 `npm run typecheck` + `npm test` (`src` + `scripts`) + 8並列 `npm run test:smoke`
- 出荷前・UI変更時 (`npm run pipeline:verify`): 上記 ＋ `npm run audit:prod` ＋ `dist-portfolio` / `dist-personal` 分離ビルド ＋ 2プロジェクト隔離 `npm run test:e2e:regression` ＋ `npm run test:visual`（UI変更時は撮影 PNG の目視確認を含む）
- 多層防衛ゲート: `.agents/hooks.json` (`SessionStart` / `PreToolUse` / `Stop`)、`.githooks/pre-commit` (Staged Index Blob 検査 & Partial Staging 遮断)、`.githooks/pre-push` (Force Push & 未検証 Push 遮断)、および `.github/workflows/deploy-pages.yml`。
