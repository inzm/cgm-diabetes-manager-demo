---
name: spec-sync-and-review
description: 画面デザイン修正・機能追加・仕様変更の際に、4軸評価、ユーザー目線の用語、ハリボテ排除、ソースと仕様書(docs/Web_Project)の同期を行う。変更ファイルから更新すべき仕様書を引く単一真実源を参照する。
---

# spec-sync-and-review

目的: コード変更の前に仕様書 (SSOT: `docs/Web_Project/`) を先行更新・コミット (`docs(spec): ...`) し、続く実装コミット (`feat: ...` / `fix: ...`) との2段階記録によって Git 履歴上で「仕様先行」と完全同期を証明する。

## 原則
1. UIデザイン (配置・ボタン構成・レスポンシブ・色・ラベル) や機能ロジックを変更するときは、対応する `SPEC_*.md` 等を先に更新して `docs(spec): ...` コミットを記録し、その後コードを実装して `feat: ...` コミットを記録する（実装中に仕様の微調整が生じた場合は `feat` コミットに仕様書の追補を含めてよい）。
2. Web版DB設計 (`docs/Web_Project/ARCHITECTURE.md`, `supabase/migrations/`, `supabase/schema_snapshot.json`, `src/types/database.ts`, `src/lib/db.ts`) と旧VBAのデータ構造が異なる場合、Web版を優先する。
3. 画面テキストに開発者用語を出さない。
   - 禁止語: マスタ / IndexedDB / Dexie.js / Web Worker / 並列パース / バインド / 物理テーブル名 (`libre_readings` 等)
   - 代替例: 「マスタから選択」→「登録済みから選ぶ」、「イベント管理」→「食品・活動」
4. 引き算: 見れば分かる説明文・サブタイトル、「①」「②」などの番号ラベル、不要なバッジ・枠線を削る。主役 (血糖値・異常値・合計糖質・保存ボタン) を目立たせる。
5. ハリボテ・テストバックドア禁止。
   - 架空データ (ハードコードの人物一覧など) や `window.__CGM_E2E_*` フラグを本番クライアントコードに置かない。
   - 未実装領域には「○○を実装予定」、未実装機能のボタンには「（未実装）」＋ `disabled` を付ける。
   - `localStorage` 等に APIキー・秘密情報を保存しない。「安全に保管」など事実と異なる表示をしない。
   - Gemini API連携は BFFプロキシ `/api/gemini` と内蔵の標準辞書フォールバックに統一する。
6. 変更の前後で関連する Open Issue (`gh issue list --repo inzm/cgm-diabates-manager-web --state open`) を確認のうえ4軸 (セキュリティ・拡張性・保守性・ユーザビリティ) を評価する。仕様書内に `【未決事項】` / `【要確認】` / `【改修予定】` / `【実装予定】` / `【将来案】` タグや内部 `Issue #XX` 番号を書かず、未着手項目は Private Issue のみで管理する。
7. `npm run test:docs` (`scripts/verify-docs-sync.mjs` → `scripts/gates/*.ts`) を通す。

## ソース ⇔ 仕様書マッピング (単一真実源)
重複による陳腐化を防ぐため、ソースファイルと更新対象仕様書・必須仕様書 (`requiredSpecs`) の対応関係は **[`scripts/gates/module-coverage.ts`](../../../scripts/gates/module-coverage.ts) の `SOURCE_TO_SPEC_RULES`** に一元管理している。新しいモジュールを追加する際は `SOURCE_TO_SPEC_RULES` に1箇所だけ追加すれば Check 3・Check 4・Smoke エンドポイント自動導出がすべて連動する。

## 手順 (2段階記録: Spec-First の証明)
1. Open Issue の確認と4軸評価。未決の論点・トレードオフがあれば編集前にユーザーと合意する。
2. `scripts/gates/module-coverage.ts` の `SOURCE_TO_SPEC_RULES` に従い、仕様書・図面 (`diagrams/*`)・`USER_GUIDE.md`・`TEST_PLAN.md` を先に更新して合意を得る。
3. 第1コミット (仕様先行の証明): `git add docs/Web_Project && git commit -m "docs(spec): <仕様変更の要約>"`（純粋ドキュメント変更時は `.githooks/pre-commit` の高速パスで ~2秒で完了）。
4. 実装と、単体・統合・E2Eテストの追加（スキーマ変更時は連番マイグレーション `supabase/migrations/*.sql` と `supabase/schema_snapshot.json` を同時更新）。
5. 検証: `npm run pipeline:verify`（`dist-portfolio` + `dist-personal` 分離ビルド＆2プロジェクト Playwright 実行、Verify Stamp 記録）。
6. 第2コミットと出荷: 変更ファイルを明示的に `git add <files>` した上で `npm run pipeline:ship:personal -- --message "feat(personal): <実装の要約>"` または `npm run pipeline:ship:demo` を実行する。
