---
name: supabase-drift-audit
description: Read-Only の Supabase MCP ツールを用いて、本番 Supabase スキーマ・マイグレーション履歴・RLS・SECURITY DEFINER 分離状態とリポジトリの supabase/schema_snapshot.json のドリフトおよび Advisor 警告を監査する。DB変更前後やセキュリティ監査時に使う。
---

# supabase-drift-audit

目的: 患者の実測医療データに一切触れず、メタデータと Advisor 診断のみで「本番 Supabase 環境 ⇔ `supabase/migrations/*.sql` & `supabase/schema_snapshot.json`」の整合性を監査する。

## 1. 安全制約 (厳守)
- **患者データのクエリ禁止**: `libre_readings`, `events`, `meal_details`, `food_master`, `event_master`, `categories`, `user_settings`, `family_permissions` の行データを `execute_sql` で `SELECT` してはならない。
- **変更系ツールの無断実行禁止**: 監査フェーズでは `list_projects`, `list_migrations`, `list_tables`, `get_advisors`（および必要な場合のみ `pg_catalog` メタデータ参照）の Read-Only 操作のみを行う（変更系 MCP は `.agents/hooks/pre-tool-guard.mjs` により `force_ask` 保護される）。

## 2. 監査手順

1. **対象プロジェクト ID の特定**:
   - `supabase` MCP の `list_projects` で対象プロジェクト ID を確認する。
2. **マイグレーション適用履歴の照合**:
   - `list_migrations` の結果と、リポジトリの `supabase/migrations/*.sql` ファイル一覧および `supabase/schema_snapshot.json` の `migrations` 配列を比較し、未適用マイグレーションまたはリポジトリ未追跡の本番先行マイグレーションを洗い出す。
3. **8テーブル構造・RLS 有効化状態の照合**:
   - `list_tables`（`schemas: ["public"]`, `verbose: true`）を取得し、`supabase/schema_snapshot.json` の全8テーブル・カラム型・`rls_enabled: true` と一致しているか確認する。
4. **Supabase Security / Performance Advisor 診断**:
   - `get_advisors(type: "security")` および `get_advisors(type: "performance")` を実行する。
   - 重点確認項目:
     - **Lint `0029` (`exposed_security_definer_functions`)**: `public` スキーマに `SECURITY DEFINER` 関数が残っていないか（特権ヘルパー6種はすべて `app_private` スキーマに隔離され、`public.verify_user_authorization()` のみが `SECURITY INVOKER` ラッパーであること）。
     - **Lint `0006` (`multiple_permissive_policies`)**: `public.family_permissions` 等に重複する Permissive ポリシーが存在しないか。
     - **Lint `auth_leaked_password_protection`**: Supabase Dashboard（Authentication > Providers > Email / Password Security）での手動有効化が必要な項目であり、SQL マイグレーションだけでは変更できないため、未有効の場合は人の作業項目（Private GitHub Issue）として扱う。
5. **ローカル静的ゲートとの突合**:
   - `npm run test:docs`（`scripts/gates/schema-parity.ts`）を実行し、6層スキーマ整合性がすべて PASS することを確認する。
