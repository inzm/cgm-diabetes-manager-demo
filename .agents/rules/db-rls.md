---
trigger: model_decision
description: Supabase PostgreSQL 連番マイグレーション、RLS・app_private 関数分離、Dexie.js ローカルDB、双方向同期エンジン (syncEngine.ts)、または src/types/database.ts を編集・監査するときに適用する。
---

# ルール: DBスキーマ・RLS・Local-First 同期 (`db-rls`)

## 1. 6層スキーマ整合性 (単一真実源の同期)
スキーマ・カラム・型・制約を変更する場合は、以下の全層を同一サイクルで一致させる（`scripts/gates/schema-parity.ts` が自動検証する）。
1. 連番マイグレーション: `supabase/migrations/*.sql`（既存マイグレーションを破壊的に書き換えず、新規の連番 `.sql` を追加する）
2. 累積スナップショット: `supabase/schema_snapshot.json`
3. 仕様書カタログ: `docs/Web_Project/ARCHITECTURE.md` §5（全文SQLの重複転記は行わず、テーブル・RLS・マイグレーション索引カタログを更新する）
4. TypeScript 型定義: `src/types/database.ts`（`MAX_CATEGORY_NAME_LENGTH` 等の定数長も含め完全一致させる）
5. ローカルDB定義: `src/lib/db.ts`（最新 `this.version(N).stores(...)` のインデックス列）
6. ER図・シーケンス図: `docs/Web_Project/diagrams/SEQUENCE_AND_ERD.md`

## 2. Supabase RLS・`app_private` 特権関数分離
- 全8テーブル（`family_permissions`, `libre_readings`, `events`, `meal_details`, `categories`, `food_master`, `event_master`, `user_settings`）で `ENABLE ROW LEVEL SECURITY` を必須とする。
- **Lint `0029` 対策（`SECURITY DEFINER` の非公開スキーマ隔離）**:
  - `SECURITY DEFINER` 関数（`is_system_owner`, `is_authorized_system_user`, `can_view_patient_data`, `can_edit_patient_data`, `verify_user_authorization`, `enforce_invited_or_owner_signup`）はすべて Data API 非公開の `app_private` スキーマに配置し、`SET search_path = app_private, public, auth, pg_temp` を明示する（`auth.users` 上の既存トリガー関数移行時はテーブル所有者制約を回避するため `ALTER FUNCTION ... SET SCHEMA app_private` で OID を保持したまま移動する）。
  - `public` スキーマに `SECURITY DEFINER` 関数を露出させてはならない。フロントエンド RPC 用の `public.verify_user_authorization()` は引数なしの `SECURITY INVOKER` ラッパー関数として定義し、内部で `app_private.verify_user_authorization()` を呼ぶ。
- **Lint `0006` & InitPlan 対策**:
  - 同一テーブル・同一ロール・同一コマンド（`SELECT` / `INSERT` / `UPDATE` / `DELETE`）に対して複数の Permissive ポリシーを重複定義しない（`FOR ALL` と個別 `FOR UPDATE` の併用禁止）。
  - ポリシー条件内の `auth.uid()` / `auth.jwt()` は `(select auth.uid())` の InitPlan 形式で記述し、行ごとの再評価を防ぐ。

## 3. Local-First 環境分離・UUID・論理削除
- **環境分離**: 画面描画時に Supabase へ直接クエリしない。本番（`personal`）は IndexedDB（`Dexie`）＋メモリキャッシュから即時描画して `syncPatientDataWithCloud` で差分同期し、公開デモ（`portfolio`）は物理 IndexedDB に一切書き込まずオンメモリの `InMemoryTable` のみで動作させる。
- **正規 UUID 主キー**: 手動作成レコードは `crypto.randomUUID()`、CGM測定値・自動抽出異常値・初期シード等の冪等レコードは `src/lib/uuidUtils.ts` の `deterministicUuid` を使う。
- **削除方式**: 同期対象の業務5テーブル（`events`, `meal_details`, `food_master`, `event_master`, `categories`）の通常削除は `is_deleted = true` の論理削除とし、食事イベント削除時は関連 `meal_details` も連動して論理削除する（自動抽出異常値の再計算置換・家族招待解除・データ全消去のみ物理削除）。
