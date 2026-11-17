-- ==============================================================================
-- Migration: 20261116205848_harden_rls_functions_and_fk_indexes.sql
-- Production schema_migrations alignment: STABLE RLS helpers, caller UID guard,
-- PUBLIC/anon EXECUTE revocation, and FK indexes on food_master / event_master.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.is_system_owner(
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
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

CREATE OR REPLACE FUNCTION public.is_authorized_system_user(
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

    IF public.is_system_owner(check_uid, check_email) THEN
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
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

CREATE OR REPLACE FUNCTION public.verify_user_authorization()
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
        is_owner := public.is_system_owner(uid, uemail);
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
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

CREATE OR REPLACE FUNCTION public.can_view_patient_data(target_patient_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    uid UUID := auth.uid();
    uemail TEXT := COALESCE(auth.jwt() ->> 'email', '');
    normalized_email TEXT := LOWER(NULLIF(BTRIM(COALESCE(auth.jwt() ->> 'email', '')), ''));
BEGIN
    IF uid IS NULL THEN
        RETURN FALSE;
    END IF;
    IF uid = target_patient_id AND public.is_system_owner(uid, uemail) THEN
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
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

CREATE OR REPLACE FUNCTION public.can_edit_patient_data(target_patient_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    uid UUID := auth.uid();
    uemail TEXT := COALESCE(auth.jwt() ->> 'email', '');
    normalized_email TEXT := LOWER(NULLIF(BTRIM(COALESCE(auth.jwt() ->> 'email', '')), ''));
BEGIN
    IF uid IS NULL THEN
        RETURN FALSE;
    END IF;
    IF uid = target_patient_id AND public.is_system_owner(uid, uemail) THEN
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
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.is_system_owner(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_system_owner(UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.is_authorized_system_user(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_authorized_system_user(UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.verify_user_authorization() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_user_authorization() TO authenticated;
REVOKE ALL ON FUNCTION public.can_view_patient_data(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_patient_data(UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.can_edit_patient_data(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_edit_patient_data(UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.enforce_invited_or_owner_signup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_invited_or_owner_signup() TO service_role;

CREATE INDEX IF NOT EXISTS idx_food_master_category ON public.food_master (category_id);
CREATE INDEX IF NOT EXISTS idx_event_master_category ON public.event_master (category_id);
