---
name: spec-sync-and-review
description: 画面デザイン修正・機能追加・仕様変更の際に、4軸評価、ユーザー目線の用語、ハリボテ排除、ソースと仕様書(docs/Web_Project)の同期を行う。変更ファイルから更新すべき仕様書を引く対応表を持つ。
---

# spec-sync-and-review

目的: コード変更のたびに、仕様書 (SSOT: docs/Web_Project/) を同一変更セットで更新する。

## 原則
1. UIデザイン (配置・ボタン構成・レスポンシブ・色・ラベル) や機能ロジックを変更したら、対応する SPEC_*.md を同じコミットで更新する。
2. Web版DB設計 (docs/Web_Project/ARCHITECTURE.md, src/types/database.ts, src/lib/db.ts) と旧VBAのデータ構造が異なる場合、Web版を優先する。
3. 画面テキストに開発者用語を出さない。
   - 禁止語: マスタ / IndexedDB / Dexie.js / Web Worker / 並列パース / バインド / 物理テーブル名 (libre_readings 等)
   - 代替例: 「マスタから選択」→「登録済みから選ぶ」、「イベント管理」→「食品・活動」
4. 引き算: 見れば分かる説明文・サブタイトル、「①」「②」などの番号ラベル、不要なバッジ・枠線を削る。主役 (血糖値・異常値・合計糖質・保存ボタン) を目立たせる。
5. ハリボテ禁止。
   - 架空データ (ハードコードの人物一覧など) を表示しない。
   - 未実装領域には「○○を実装予定」と書く。
   - 未実装機能のボタンは、テキストに「（未実装）」を含めて disabled にする。
   - localStorage 等に APIキー・秘密情報を保存しない。「安全に保管」など事実と異なる表示をしない。
   - Gemini API連携は BFFプロキシ /api/gemini と内蔵の標準辞書フォールバックに統一する。
6. 変更の前後で4軸 (セキュリティ・拡張性・保守性・ユーザビリティ) を評価する。問題やトレードオフがあればユーザーに相談する。
7. npm run test:docs (scripts/verify-docs-sync.mjs) を通す。検出対象: ソースと仕様書の対応、localStorageへのAPIキー保存、虚偽文言、window.confirm、UIへの開発者用語。

## 対応表: 変更したソース → 同時に更新する仕様書
(特記のない仕様書は docs/Web_Project/ 配下)

| 変更したソース | 更新する仕様書 |
| :--- | :--- |
| src/components/calendar/*, src/components/common/Header.tsx, src/components/common/BottomNav.tsx | SPEC_CALENDAR.md |
| src/components/common/AuthGateScreen.tsx, src/App.tsx | SPEC_CALENDAR.md, SPEC_SETTINGS.md, ARCHITECTURE.md, USER_GUIDE.md |
| src/components/daily/* | SPEC_CALENDAR.md または SPEC_MEAL_RECORD.md |
| src/components/common/OfflineBanner.tsx, src/lib/pwa.ts | SPEC_PWA.md (必要なら SPEC_SETTINGS.md) |
| src/components/analysis/*, src/lib/analysisCalculators.ts | SPEC_ANALYSIS.md (必要なら USER_GUIDE.md) |
| src/components/foods/*, src/lib/foodSeed.ts, src/lib/gemini.ts, functions/api/gemini.ts | SPEC_FOOD_MASTER.md, SPEC_SETTINGS.md, ARCHITECTURE.md, diagrams/system_architecture.drawio (必要なら USER_GUIDE.md) |
| src/components/import/*, src/workers/csvParser.worker.ts, src/lib/anomalyExtractor.ts | SPEC_CSV_IMPORT.md, diagrams/CSV_IMPORT_AND_ANOMALY_FLOW.md, diagrams/SEQUENCE_AND_ERD.md (必要なら USER_GUIDE.md) |
| src/components/records/* | SPEC_MEAL_RECORD.md (必要なら USER_GUIDE.md) |
| src/components/settings/*, src/contexts/PatientContext.tsx, src/lib/syncEngine.ts, src/lib/supabase.ts, supabase/migrations/* | SPEC_SETTINGS.md, ARCHITECTURE.md, USER_GUIDE.md, diagrams/SEQUENCE_AND_ERD.md, diagrams/system_architecture.drawio |
| src/lib/db.ts, src/types/database.ts, src/lib/uuidUtils.ts, src/lib/backupRestore.ts | ARCHITECTURE.md, SPEC_SETTINGS.md, diagrams/SEQUENCE_AND_ERD.md |
| 新規仕様書の追加・名称変更 | README.md |

## 手順
1. 4軸評価。問題があればユーザーに相談する。
2. 仕様書、図面 (diagrams/*)、操作・招待手順を変えた場合は USER_GUIDE.md を先に更新する。
3. 実装と、単体・統合テストの追加。
4. 検証: npm run verify:all または npm run pipeline:verify。
5. 同一コミットにして出荷: npm run pipeline:ship:personal / npm run pipeline:ship:demo (詳細は skill: ai-orchestrator-pipeline)。
