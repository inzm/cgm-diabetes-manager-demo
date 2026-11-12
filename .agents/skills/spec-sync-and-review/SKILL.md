---
name: spec-sync-and-review
description: デザイン・仕様の意図検証（ユーザーレビュー）、4軸自律評価（セキュリティ・拡張性・保守性・ユーザビリティ）、ユーザー目線用語と引き算の法則の適用、ハリボテ実装・虚偽表示の排除、およびコード変更時の仕様書（docs/Web_Project/SPEC_*.md）最新化・同期を確実に遂行するワークフロー。画面デザイン修正、機能追加、仕様変更、またはドキュメント整合性検証を行う際に必ず使用する。
---

# 仕様・デザイン検証 & 4軸自律評価・ドキュメント同期強制スキル (spec-sync-and-review)

このスキルは、ユーザーの意図通りにデザイン・仕様が実装されているかを検証し、AIが自律的に「セキュリティ・拡張性・保守性・ユーザビリティ（徹底したユーザー目線と引き算の法則）」を評価してユーザーへ相談・提案を行い、ハリボテ（外観のみ）実装や虚偽表示を排除し、変更のたびに仕様書（SSOT: `docs/Web_Project/*.md`）を100%最新状態に保つための標準手順を定めます。

---

## 1. 絶対原則 (Spec-Code Atomic Synchronization & User-Centric UX Rules)

1. **仕様書なきコード変更の禁止**:
   - UIデザイン（配置、ボタン構成、レスポンシブ挙動、色、ラベル）や機能ロジックを変更する際は、**必ず対応する `docs/Web_Project/SPEC_*.md` を同じ変更セット（同一コミット/PR）内で更新すること**。
2. **Webプロジェクト設計優先の原則**:
   - Webプロジェクトで追加された仕様が `docs/Web_Project/*.md` に記されている場合、または WebプロジェクトのDB設計（`ARCHITECTURE.md` / `src/types/database.ts` / `src/lib/db.ts`）と旧VBAプロジェクトのマスタ等のデータ構造が異なる場合は、**常にWebプロジェクトの設計を優先すること**。
3. **徹底したユーザー目線（開発者用語のUI露出禁止）と「引き算の法則」**:
   - 画面上のテキストに「マスタ」「IndexedDB」「Dexie.js」「Web Worker」「並列パース」「バインド」「物理テーブル名（`libre_readings`等）」などの開発者目線用語を決して露出させないこと（例：「マスタから選択」ではなく「登録済みから選ぶ」、「イベント管理」ではなく「食品・活動」）。
   - 見れば分かる説明文・サブタイトル、セレクトボックス上の冗長な番号ラベル（「①」「②」）、不要なバッジや枠線を引き算し、主役（血糖値・異常値・合計糖質・保存アクション）が際立つ視覚的メリハリを維持すること。
4. **ハリボテ実装・虚偽セキュリティ表示の絶対禁止と「（未実装）」明示ルール**:
   - 実装されていない機能があたかも動いているかのように見せるハリボテUI（架空のハードコード人物一覧等）は完全に排除すること。
   - 今後実装予定の領域は「○○を実装予定」と明記し、未実装機能を呼び出すボタンを置く場合は必ずボタンテキストに **`（未実装）`** を含め `disabled` にすること。
   - ブラウザの `localStorage` 等にAPIキーや秘密情報を保存すること、および事実と異なる「安全に保管」等の表示を行うことを固く禁止する（Gemini API連携は方式1: BFFプロキシ `/api/gemini` ＋内蔵標準辞書フォールバックに統一）。
5. **AIによる4軸自律評価と事前相談の義務**:
   - 変更・実装の前後において、必ず **①セキュリティ、②拡張性、③保守性、④ユーザビリティ（ユーザー目線・引き算）** の4軸で対象機能を自律評価し、問題点やトレードオフがあればユーザーに相談すること。
6. **機械的検証ゲート (`npm run test:docs`) の通過必須**:
   - `scripts/verify-docs-sync.mjs` により、ソースファイルと仕様書の対応関係、および禁止パターン（`localStorage` へのAPIキー保存、虚偽文言、`window.confirm`、UIへの開発者用語露出）が機械的に監視されている。

---

## 2. ソースコード ⇔ 仕様書 対応マトリクス

変更対象のファイルに応じて、必ず右記の仕様書を同時に点検・更新すること：

| 変更対象ソースパス | 同時更新が必須の仕様書 (SSOT) |
| :--- | :--- |
| `src/components/calendar/*`<br>`src/components/common/Header.tsx`<br>`src/components/common/BottomNav.tsx` | `docs/Web_Project/SPEC_CALENDAR.md` |
| `src/components/common/AuthGateScreen.tsx`<br>`src/App.tsx` | `docs/Web_Project/SPEC_CALENDAR.md` / `SPEC_SETTINGS.md` / `ARCHITECTURE.md` / `USER_GUIDE.md` |
| `src/components/daily/*` | `docs/Web_Project/SPEC_CALENDAR.md` または `docs/Web_Project/SPEC_MEAL_RECORD.md` |
| `src/components/common/OfflineBanner.tsx`<br>`src/lib/pwa.ts` | `docs/Web_Project/SPEC_PWA.md`（および必要に応じ `SPEC_SETTINGS.md`） |
| `src/components/analysis/*`<br>`src/lib/analysisCalculators.ts` | `docs/Web_Project/SPEC_ANALYSIS.md`（および必要に応じ `USER_GUIDE.md`） |
| `src/components/foods/*`<br>`src/lib/foodSeed.ts`<br>`src/lib/gemini.ts`<br>`functions/api/gemini.ts` | `docs/Web_Project/SPEC_FOOD_MASTER.md` / `SPEC_SETTINGS.md` / `ARCHITECTURE.md` / `diagrams/system_architecture.drawio`（および必要に応じ `USER_GUIDE.md`） |
| `src/components/import/*`<br>`src/workers/csvParser.worker.ts`<br>`src/lib/anomalyExtractor.ts` | `docs/Web_Project/SPEC_CSV_IMPORT.md` / `diagrams/CSV_IMPORT_AND_ANOMALY_FLOW.md` / `diagrams/SEQUENCE_AND_ERD.md`（および必要に応じ `USER_GUIDE.md`） |
| `src/components/records/*` | `docs/Web_Project/SPEC_MEAL_RECORD.md`（および必要に応じ `USER_GUIDE.md`） |
| `src/components/settings/*`<br>`src/contexts/PatientContext.tsx`<br>`src/lib/syncEngine.ts`<br>`src/lib/supabase.ts`<br>`supabase/migrations/*` | `docs/Web_Project/SPEC_SETTINGS.md` / `ARCHITECTURE.md` / `USER_GUIDE.md` / `diagrams/SEQUENCE_AND_ERD.md` / `diagrams/system_architecture.drawio` |
| `src/lib/db.ts`<br>`src/types/database.ts`<br>`src/lib/uuidUtils.ts`<br>`src/lib/backupRestore.ts` | `docs/Web_Project/ARCHITECTURE.md` / `SPEC_SETTINGS.md` / `diagrams/SEQUENCE_AND_ERD.md` |
| 新規仕様書の追加・名称変更時 | `docs/Web_Project/README.md` |

---

## 3. デザイン・仕様変更の実行ステップ

1. **Step 1: 4軸自律評価 & ユーザー相談（問題・選択肢がある場合）**
2. **Step 2: 仕様書 (`docs/Web_Project/SPEC_*.md`、図面 `diagrams/*`、および操作・招待手順変更時は `USER_GUIDE.md`) の先行・同時更新**
3. **Step 3: コード実装 & 単体/統合テスト追加**
4. **Step 4: 品質ゲート + ドキュメント・DDL・図面同期検証の実行 (`npm run verify:all` または `npm run pipeline:verify`)**
5. **Step 5: アトミックコミット & 出荷パイプライン実行 (`npm run pipeline:ship:personal` / `npm run pipeline:ship:demo`)**
