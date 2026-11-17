-- ==============================================================================
-- Migration: 20261117030000_isolate_security_definer_helpers_and_consolidate_family_rls.sql
-- Resolves Supabase Security Advisor Lint 0029 (authenticated_security_definer_function_executable)
-- and Performance Advisor Lint 0006 (multiple_permissive_policies on family_permissions):
--   1. Moves all internal SECURITY DEFINER helpers into non-exposed `app_private` schema
--      so PostgREST (/rest/v1/rpc/*) never exposes privileged helper functions.
--   2. Converts `public.verify_user_authorization()` into a zero-parameter SECURITY INVOKER
--      wrapper delegating to `app_private.verify_user_authorization()`.
--   3. Consolidates `public.family_permissions` policies into 4 single-action policies
--      (`_select`, `_insert`, `_update`, `_delete`), dropping duplicate permissive policies.
--   4. Drops the 5 legacy `public` SECURITY DEFINER functions cleanly after updating
--      all RLS policies and triggers.
-- ==============================================================================

CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA app_private TO authenticated, service_role;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        GRANT USAGE ON SCHEMA app_private TO supabase_auth_admin;
    END IF;
END $$;

-- 1. Non-exposed internal SECURITY DEFINER helpers in `app_private`
CREATE OR REPLACE FUNCTION app_private.is_system_owner(
    check_uid UUID DEFAULT auth.uid(),
    check_email TEXT DEFAULT COALESCE(auth.jwt() ->> 'email', '')
)
RETURNS BOOLEAN AS $$
DECLARE
    normalized_email TEXT := LOWER(NULLIF(BTRIM(COALESCE(check_email, '')), ''));
    has_any_owner_data BOOLEAN;
    first_auth_user_id UUID;
BEGIN
    IF check_uid IS NULL THEN
        RETURN FALSE;
    END IF;

    IF auth.uid() IS NOT NULL AND check_uid IS DISTINCT FROM auth.uid() THEN
        RETURN FALSE;
    END IF;

    IF EXISTS (SELECT 1 FROM public.family_permissions WHERE patient_id = check_uid)
       OR EXISTS (SELECT 1 FROM public.user_settings WHERE user_id = check_uid)
       OR EXISTS (SELECT 1 FROM public.categories WHERE user_id = check_uid)
       OR EXISTS (SELECT 1 FROM public.food_master WHERE user_id = check_uid)
       OR EXISTS (SELECT 1 FROM public.event_master WHERE user_id = check_uid)
       OR EXISTS (SELECT 1 FROM public.events WHERE user_id = check_uid)
       OR EXISTS (SELECT 1 FROM public.libre_readings WHERE user_id = check_uid)
    THEN
        RETURN TRUE;
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.family_permissions
        WHERE patient_id <> check_uid
          AND (
              family_user_id = check_uid
              OR (
                  normalized_email IS NOT NULL
                  AND family_email IS NOT NULL
                  AND LOWER(NULLIF(BTRIM(family_email), '')) = normalized_email
              )
          )
    ) THEN
        RETURN FALSE;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.user_settings
        UNION ALL
        SELECT 1 FROM public.family_permissions
        UNION ALL
        SELECT 1 FROM public.categories
        UNION ALL
        SELECT 1 FROM public.food_master
        UNION ALL
        SELECT 1 FROM public.event_master
        UNION ALL
        SELECT 1 FROM public.events
        UNION ALL
        SELECT 1 FROM public.libre_readings
    ) INTO has_any_owner_data;

    IF NOT has_any_owner_data THEN
        SELECT id INTO first_auth_user_id
        FROM auth.users
        ORDER BY created_at ASC, id ASC
        LIMIT 1;

        IF first_auth_user_id IS NULL OR first_auth_user_id = check_uid THEN
            RETURN TRUE;
        END IF;
    END IF;

    RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app_private, public, auth, pg_temp;

CREATE OR REPLACE FUNCTION app_private.is_authorized_system_user(
    check_uid UUID DEFAULT auth.uid(),
    check_email TEXT DEFAULT COALESCE(auth.jwt() ->> 'email', '')
)
RETURNS BOOLEAN AS $$
DECLARE
    normalized_email TEXT := LOWER(NULLIF(BTRIM(COALESCE(check_email, '')), ''));
BEGIN
    IF check_uid IS NULL THEN
        RETURN FALSE;
    END IF;

    IF auth.uid() IS NOT NULL AND check_uid IS DISTINCT FROM auth.uid() THEN
        RETURN FALSE;
    END IF;

    IF app_private.is_system_owner(check_uid, check_email) THEN
        RETURN TRUE;
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.family_permissions
        WHERE family_user_id = check_uid
           OR (
               normalized_email IS NOT NULL
               AND family_email IS NOT NULL
               AND LOWER(NULLIF(BTRIM(family_email), '')) = normalized_email
           )
    ) THEN
        RETURN TRUE;
    END IF;

    RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app_private, public, auth, pg_temp;

CREATE OR REPLACE FUNCTION app_private.verify_user_authorization()
RETURNS JSONB AS $$
DECLARE
    uid UUID := auth.uid();
    uemail TEXT := COALESCE(auth.jwt() ->> 'email', '');
    normalized_email TEXT := LOWER(NULLIF(BTRIM(COALESCE(auth.jwt() ->> 'email', '')), ''));
    is_owner BOOLEAN := FALSE;
    is_invited BOOLEAN := FALSE;
    is_auth BOOLEAN := FALSE;
BEGIN
    IF uid IS NOT NULL THEN
        is_owner := app_private.is_system_owner(uid, uemail);
        SELECT EXISTS (
            SELECT 1 FROM public.family_permissions
            WHERE patient_id <> uid
              AND (
                  family_user_id = uid
                  OR (
                      normalized_email IS NOT NULL
                      AND family_email IS NOT NULL
                      AND LOWER(NULLIF(BTRIM(family_email), '')) = normalized_email
                  )
              )
        ) INTO is_invited;
        is_auth := (is_owner OR is_invited);
    END IF;

    RETURN jsonb_build_object(
        'authorized', is_auth,
        'is_owner', is_owner,
        'is_invited_family', is_invited,
        'user_id', uid,
        'email', uemail
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app_private, public, auth, pg_temp;

CREATE OR REPLACE FUNCTION app_private.can_view_patient_data(target_patient_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    uid UUID := auth.uid();
    uemail TEXT := COALESCE(auth.jwt() ->> 'email', '');
    normalized_email TEXT := LOWER(NULLIF(BTRIM(COALESCE(auth.jwt() ->> 'email', '')), ''));
BEGIN
    IF uid IS NULL THEN
        RETURN FALSE;
    END IF;
    IF uid = target_patient_id AND app_private.is_system_owner(uid, uemail) THEN
        RETURN TRUE;
    END IF;
    RETURN EXISTS (
        SELECT 1 FROM public.family_permissions
        WHERE patient_id = target_patient_id
          AND (
              family_user_id = uid
              OR (
                  normalized_email IS NOT NULL
                  AND family_email IS NOT NULL
                  AND LOWER(NULLIF(BTRIM(family_email), '')) = normalized_email
              )
          )
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app_private, public, auth, pg_temp;

CREATE OR REPLACE FUNCTION app_private.can_edit_patient_data(target_patient_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    uid UUID := auth.uid();
    uemail TEXT := COALESCE(auth.jwt() ->> 'email', '');
    normalized_email TEXT := LOWER(NULLIF(BTRIM(COALESCE(auth.jwt() ->> 'email', '')), ''));
BEGIN
    IF uid IS NULL THEN
        RETURN FALSE;
    END IF;
    IF uid = target_patient_id AND app_private.is_system_owner(uid, uemail) THEN
        RETURN TRUE;
    END IF;
    RETURN EXISTS (
        SELECT 1 FROM public.family_permissions
        WHERE patient_id = target_patient_id
          AND role = 'editor'
          AND (
              family_user_id = uid
              OR (
                  normalized_email IS NOT NULL
                  AND family_email IS NOT NULL
                  AND LOWER(NULLIF(BTRIM(family_email), '')) = normalized_email
              )
          )
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app_private, public, auth, pg_temp;

-- Move existing `public.enforce_invited_or_owner_signup()` in-place via ALTER FUNCTION SET SCHEMA
-- so `trg_enforce_invited_or_owner_signup` on `auth.users` (owned by `supabase_auth_admin`)
-- retains its exact `pg_proc.oid` reference without requiring `DROP TRIGGER` table ownership.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'enforce_invited_or_owner_signup' AND p.pronargs = 0
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app_private' AND p.proname = 'enforce_invited_or_owner_signup' AND p.pronargs = 0
    ) THEN
        ALTER FUNCTION public.enforce_invited_or_owner_signup() SET SCHEMA app_private;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION app_private.enforce_invited_or_owner_signup()
RETURNS TRIGGER AS $$
DECLARE
    normalized_new_email TEXT := LOWER(NULLIF(BTRIM(COALESCE(NEW.email, '')), ''));
BEGIN
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id <> NEW.id) THEN
        RETURN NEW;
    END IF;

    IF normalized_new_email IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.family_permissions
        WHERE family_email IS NOT NULL
          AND LOWER(NULLIF(BTRIM(family_email), '')) = normalized_new_email
    ) THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'このメールアドレスは招待されていません。患者本人からの招待登録が必要です。';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = app_private, public, auth, pg_temp;

REVOKE ALL ON FUNCTION app_private.is_system_owner(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_private.is_system_owner(UUID, TEXT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.is_authorized_system_user(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_private.is_authorized_system_user(UUID, TEXT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.verify_user_authorization() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_private.verify_user_authorization() TO authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.can_view_patient_data(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_private.can_view_patient_data(UUID) TO authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.can_edit_patient_data(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_private.can_edit_patient_data(UUID) TO authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.enforce_invited_or_owner_signup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.enforce_invited_or_owner_signup() TO service_role;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        GRANT EXECUTE ON FUNCTION app_private.enforce_invited_or_owner_signup() TO supabase_auth_admin;
    END IF;
END $$;

-- 2. Public RPC wrapper (`SECURITY INVOKER` — zero SECURITY DEFINER functions in `public`)
CREATE OR REPLACE FUNCTION public.verify_user_authorization()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = app_private, public, pg_temp
AS $$
    SELECT app_private.verify_user_authorization();
$$;

REVOKE ALL ON FUNCTION public.verify_user_authorization() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_user_authorization() TO authenticated;

-- 3. Ensure signup guard trigger exists on `auth.users` pointing to `app_private.enforce_invited_or_owner_signup()`
--    (Existing triggers already follow the OID moved via `ALTER FUNCTION ... SET SCHEMA app_private` above.)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'auth'
          AND c.relname = 'users'
          AND t.tgname = 'trg_enforce_invited_or_owner_signup'
          AND NOT t.tgisinternal
    ) THEN
        CREATE TRIGGER trg_enforce_invited_or_owner_signup
            BEFORE INSERT ON auth.users
            FOR EACH ROW
            EXECUTE FUNCTION app_private.enforce_invited_or_owner_signup();
    END IF;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'Skipped auth.users trigger creation due to privilege level; RLS and RPC guards remain active.';
END $$;

-- 4. Consolidate `family_permissions` into 4 single-action policies (resolves Lint 0006)
DROP POLICY IF EXISTS "family_permissions_all" ON public.family_permissions;
DROP POLICY IF EXISTS "family_permissions_accept_invite" ON public.family_permissions;
DROP POLICY IF EXISTS "family_permissions_select" ON public.family_permissions;
DROP POLICY IF EXISTS "family_permissions_insert" ON public.family_permissions;
DROP POLICY IF EXISTS "family_permissions_update" ON public.family_permissions;
DROP POLICY IF EXISTS "family_permissions_delete" ON public.family_permissions;

CREATE POLICY "family_permissions_select" ON public.family_permissions
    FOR SELECT TO authenticated USING (
        (SELECT app_private.is_authorized_system_user((SELECT auth.uid()), COALESCE((SELECT auth.jwt()) ->> 'email', '')))
        AND (
            (SELECT auth.uid()) = patient_id
            OR (SELECT auth.uid()) = family_user_id
            OR (
                family_email IS NOT NULL
                AND LOWER(NULLIF(BTRIM(family_email), '')) = LOWER(NULLIF(BTRIM(COALESCE((SELECT auth.jwt()) ->> 'email', '')), ''))
            )
        )
    );

CREATE POLICY "family_permissions_insert" ON public.family_permissions
    FOR INSERT TO authenticated WITH CHECK (
        (SELECT auth.uid()) = patient_id
        AND (SELECT app_private.is_system_owner((SELECT auth.uid()), COALESCE((SELECT auth.jwt()) ->> 'email', '')))
    );

CREATE POLICY "family_permissions_update" ON public.family_permissions
    FOR UPDATE TO authenticated
    USING (
        (
            (SELECT auth.uid()) = patient_id
            AND (SELECT app_private.is_system_owner((SELECT auth.uid()), COALESCE((SELECT auth.jwt()) ->> 'email', '')))
        )
        OR (
            family_email IS NOT NULL
            AND LOWER(NULLIF(BTRIM(family_email), '')) = LOWER(NULLIF(BTRIM(COALESCE((SELECT auth.jwt()) ->> 'email', '')), ''))
        )
    )
    WITH CHECK (
        (
            (SELECT auth.uid()) = patient_id
            AND (SELECT app_private.is_system_owner((SELECT auth.uid()), COALESCE((SELECT auth.jwt()) ->> 'email', '')))
        )
        OR (
            family_email IS NOT NULL
            AND LOWER(NULLIF(BTRIM(family_email), '')) = LOWER(NULLIF(BTRIM(COALESCE((SELECT auth.jwt()) ->> 'email', '')), ''))
            AND family_user_id = (SELECT auth.uid())
        )
    );

CREATE POLICY "family_permissions_delete" ON public.family_permissions
    FOR DELETE TO authenticated USING (
        (SELECT auth.uid()) = patient_id
        AND (SELECT app_private.is_system_owner((SELECT auth.uid()), COALESCE((SELECT auth.jwt()) ->> 'email', '')))
    );

-- 5. Rebind all 7 patient tables' RLS policies to `app_private.*`
DO $$
DECLARE
    tbl text;
    tables text[] := ARRAY['categories', 'food_master', 'event_master', 'libre_readings', 'events', 'meal_details', 'user_settings'];
    owner_pred text := '(user_id = (SELECT auth.uid()) AND (SELECT app_private.is_system_owner((SELECT auth.uid()), COALESCE((SELECT auth.jwt()) ->> ''email'', ''''))))';
BEGIN
    FOREACH tbl IN ARRAY tables LOOP
        EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON public.%I;', tbl, tbl);
        EXECUTE format('CREATE POLICY "%s_select" ON public.%I FOR SELECT TO authenticated USING (%s OR app_private.can_view_patient_data(user_id));', tbl, tbl, owner_pred);

        EXECUTE format('DROP POLICY IF EXISTS "%s_insert" ON public.%I;', tbl, tbl);
        EXECUTE format('CREATE POLICY "%s_insert" ON public.%I FOR INSERT TO authenticated WITH CHECK (%s OR app_private.can_edit_patient_data(user_id));', tbl, tbl, owner_pred);

        EXECUTE format('DROP POLICY IF EXISTS "%s_update" ON public.%I;', tbl, tbl);
        EXECUTE format('CREATE POLICY "%s_update" ON public.%I FOR UPDATE TO authenticated USING (%s OR app_private.can_edit_patient_data(user_id)) WITH CHECK (%s OR app_private.can_edit_patient_data(user_id));', tbl, tbl, owner_pred, owner_pred);

        EXECUTE format('DROP POLICY IF EXISTS "%s_delete" ON public.%I;', tbl, tbl);
        EXECUTE format('CREATE POLICY "%s_delete" ON public.%I FOR DELETE TO authenticated USING (%s OR app_private.can_edit_patient_data(user_id));', tbl, tbl, owner_pred);
    END LOOP;
END $$;

-- 6. Drop legacy exposed SECURITY DEFINER functions from `public`
DROP FUNCTION IF EXISTS public.can_view_patient_data(UUID);
DROP FUNCTION IF EXISTS public.can_edit_patient_data(UUID);
DROP FUNCTION IF EXISTS public.is_authorized_system_user(UUID, TEXT);
DROP FUNCTION IF EXISTS public.is_system_owner(UUID, TEXT);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'enforce_invited_or_owner_signup' AND p.pronargs = 0
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_proc p ON p.oid = t.tgfoid
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'enforce_invited_or_owner_signup'
    ) THEN
        DROP FUNCTION public.enforce_invited_or_owner_signup();
    END IF;
END $$;
