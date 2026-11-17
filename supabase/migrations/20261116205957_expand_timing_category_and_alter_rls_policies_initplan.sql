-- ==============================================================================
-- Migration: 20261116205957_expand_timing_category_and_alter_rls_policies_initplan.sql
-- Production schema_migrations alignment: expand events.timing_category to VARCHAR(50)
-- and apply InitPlan ((SELECT auth.uid())) RLS optimization across patient tables.
-- ==============================================================================

ALTER TABLE public.events ALTER COLUMN timing_category TYPE VARCHAR(50);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        GRANT EXECUTE ON FUNCTION public.enforce_invited_or_owner_signup() TO supabase_auth_admin;
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'rls_auto_enable' AND p.pronargs = 0
    ) THEN
        EXECUTE 'REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated';
    END IF;
END $$;

DO $$
DECLARE
    tbl text;
    tables text[] := ARRAY['categories', 'food_master', 'event_master', 'libre_readings', 'events', 'meal_details', 'user_settings'];
    owner_pred text := '(user_id = (SELECT auth.uid()) AND (SELECT public.is_system_owner((SELECT auth.uid()), COALESCE((SELECT auth.jwt()) ->> ''email'', ''''))))';
BEGIN
    FOREACH tbl IN ARRAY tables LOOP
        EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON public.%I;', tbl, tbl);
        EXECUTE format('CREATE POLICY "%s_select" ON public.%I FOR SELECT TO authenticated USING (%s OR public.can_view_patient_data(user_id));', tbl, tbl, owner_pred);

        EXECUTE format('DROP POLICY IF EXISTS "%s_insert" ON public.%I;', tbl, tbl);
        EXECUTE format('CREATE POLICY "%s_insert" ON public.%I FOR INSERT TO authenticated WITH CHECK (%s OR public.can_edit_patient_data(user_id));', tbl, tbl, owner_pred);

        EXECUTE format('DROP POLICY IF EXISTS "%s_update" ON public.%I;', tbl, tbl);
        EXECUTE format('CREATE POLICY "%s_update" ON public.%I FOR UPDATE TO authenticated USING (%s OR public.can_edit_patient_data(user_id)) WITH CHECK (%s OR public.can_edit_patient_data(user_id));', tbl, tbl, owner_pred, owner_pred);

        EXECUTE format('DROP POLICY IF EXISTS "%s_delete" ON public.%I;', tbl, tbl);
        EXECUTE format('CREATE POLICY "%s_delete" ON public.%I FOR DELETE TO authenticated USING (%s OR public.can_edit_patient_data(user_id));', tbl, tbl, owner_pred);
    END LOOP;
END $$;
