-- ==============================================================================
-- 血糖値・食事・インスリン統合管理システム 本番用データベーススキーマ (完全版)
-- 実行方法: Supabase Dashboard -> SQL Editor -> New Query に貼り付けて「Run」をクリック
-- ==============================================================================

-- 拡張機能の有効化
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ------------------------------------------------------------------------------
-- 1. 家族共有・権限管理テーブル (UUID直接指定 & メールアドレス招待の双方に対応)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS family_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    family_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    family_email VARCHAR(255),
    role VARCHAR(20) NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'editor')),
    invited_at TIMESTAMPTZ DEFAULT NOW(),
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_family_uid
    ON family_permissions (patient_id, family_user_id)
    WHERE family_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_family_email
    ON family_permissions (patient_id, LOWER(family_email))
    WHERE family_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_family_lookup ON family_permissions (family_user_id, patient_id);
CREATE INDEX IF NOT EXISTS idx_family_email_lookup ON family_permissions (LOWER(family_email), patient_id);

-- ------------------------------------------------------------------------------
-- 2. 権限判定・未招待第三者遮断ヘルパー関数 (RLS & Auth Gate 用)
-- ------------------------------------------------------------------------------

-- システムのオーナー（患者本人）であるかを判定する（招待されただけの家族は FALSE）
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

    -- 1. 既にオーナーとして招待を発行しているか、または自身の患者データが存在する場合はオーナーと判定
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

    -- 2. 他オーナーから招待された家族メンバーである場合はオーナーではない
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

    -- 3. 初回セットアップ時（業務テーブルにまだ1件もオーナーデータが存在しない場合）:
    --    auth.users の最初に登録されたアカウントのみをシステムオーナーとして許可する
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- システムの利用を許可されたユーザー（初期オーナー本人 または 招待済み家族）であるかを判定する
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

    IF public.is_system_owner(check_uid, check_email) THEN
        RETURN TRUE;
    END IF;

    -- 招待済み家族（family_user_id または family_email が一致）であれば許可
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- クライアント（Auth Gate）から呼び出し可能な認可確認 RPC
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

GRANT EXECUTE ON FUNCTION public.verify_user_authorization() TO authenticated, anon;

-- 未招待の第三者による勝手なアカウント作成（Sign Up）を DB 層で遮断するトリガー関数
CREATE OR REPLACE FUNCTION public.enforce_invited_or_owner_signup()
RETURNS TRIGGER AS $$
DECLARE
    normalized_new_email TEXT := LOWER(NULLIF(BTRIM(COALESCE(NEW.email, '')), ''));
BEGIN
    -- 1人目のユーザー（患者オーナー本人の初回登録）は許可
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id <> NEW.id) THEN
        RETURN NEW;
    END IF;

    -- 2人目以降のサインアップは、family_permissions に事前招待された有効なメールアドレスのみ許可
    IF normalized_new_email IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.family_permissions
        WHERE family_email IS NOT NULL
          AND LOWER(NULLIF(BTRIM(family_email), '')) = normalized_new_email
    ) THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'このメールアドレスは招待されていません。患者本人からの招待登録が必要です。';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DO $$
BEGIN
    DROP TRIGGER IF EXISTS trg_enforce_invited_or_owner_signup ON auth.users;
    CREATE TRIGGER trg_enforce_invited_or_owner_signup
        BEFORE INSERT ON auth.users
        FOR EACH ROW
        EXECUTE FUNCTION public.enforce_invited_or_owner_signup();
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'Skipped auth.users trigger creation due to privilege level; RLS and RPC guards remain active.';
END $$;

CREATE OR REPLACE FUNCTION can_view_patient_data(target_patient_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    uid UUID := auth.uid();
    uemail TEXT := COALESCE(auth.jwt() ->> 'email', '');
    normalized_email TEXT := LOWER(NULLIF(BTRIM(COALESCE(auth.jwt() ->> 'email', '')), ''));
BEGIN
    IF NOT public.is_authorized_system_user(uid, uemail) THEN
        RETURN FALSE;
    END IF;
    RETURN (
        (uid = target_patient_id AND public.is_system_owner(uid, uemail))
        OR EXISTS (
            SELECT 1 FROM family_permissions
            WHERE patient_id = target_patient_id
              AND (
                  family_user_id = uid
                  OR (
                      normalized_email IS NOT NULL
                      AND family_email IS NOT NULL
                      AND LOWER(NULLIF(BTRIM(family_email), '')) = normalized_email
                  )
              )
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

CREATE OR REPLACE FUNCTION can_edit_patient_data(target_patient_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    uid UUID := auth.uid();
    uemail TEXT := COALESCE(auth.jwt() ->> 'email', '');
    normalized_email TEXT := LOWER(NULLIF(BTRIM(COALESCE(auth.jwt() ->> 'email', '')), ''));
BEGIN
    IF NOT public.is_authorized_system_user(uid, uemail) THEN
        RETURN FALSE;
    END IF;
    RETURN (
        (uid = target_patient_id AND public.is_system_owner(uid, uemail))
        OR EXISTS (
            SELECT 1 FROM family_permissions
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
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 3. カテゴリマスタ (論理削除対応の部分ユニークインデックス + 決定論的UUID)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    target_type VARCHAR(20) NOT NULL CHECK (target_type IN ('food', 'event')),
    category_name VARCHAR(50) NOT NULL,
    display_order INTEGER DEFAULT 0,
    is_protected BOOLEAN DEFAULT FALSE,
    is_deleted BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_type_cat_active
    ON categories (user_id, target_type, category_name)
    WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_categories_user ON categories (user_id, target_type);

-- ------------------------------------------------------------------------------
-- 4. 食品マスタ
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS food_master (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    food_name VARCHAR(100) NOT NULL,
    base_amount NUMERIC(6,1) NOT NULL DEFAULT 1,
    unit VARCHAR(20) NOT NULL DEFAULT '個',
    carbs_per_unit NUMERIC(6,1) NOT NULL,
    is_deleted BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_food_master_user ON food_master (user_id, is_deleted);

-- ------------------------------------------------------------------------------
-- 5. 活動マスタ
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_master (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    event_name VARCHAR(100) NOT NULL,
    default_duration INTEGER NOT NULL DEFAULT 30,
    memo TEXT,
    is_deleted BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_event_master_user ON event_master (user_id, is_deleted);

-- ------------------------------------------------------------------------------
-- 6. リブレ生データ (8.4万〜10万行/人)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS libre_readings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    timestamp TIMESTAMPTZ NOT NULL,
    glucose_value NUMERIC(5,1) NOT NULL,
    scan_type VARCHAR(20) DEFAULT 'Historic',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_user_libre_time UNIQUE (user_id, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_libre_user_time ON libre_readings (user_id, timestamp DESC);

-- ------------------------------------------------------------------------------
-- 7. イベント記録 (親テーブル) ★UUID化 & 統合日時
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    event_datetime TIMESTAMPTZ NOT NULL,
    event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('食事', '活動', '低血糖', '高血糖')),
    timing_category VARCHAR(20),
    total_carbs NUMERIC(6,1),
    insulin_units NUMERIC(5,1),
    pre_meal_glucose NUMERIC(5,1),
    post_meal_glucose NUMERIC(5,1),
    duration_minutes INTEGER,
    memo TEXT,
    is_deleted BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_user_time ON events (user_id, event_datetime DESC);
CREATE INDEX IF NOT EXISTS idx_events_sync ON events (user_id, updated_at);

-- ------------------------------------------------------------------------------
-- 8. 食事明細 (子テーブル)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meal_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    food_name VARCHAR(100) NOT NULL,
    amount NUMERIC(6,1) NOT NULL,
    unit VARCHAR(20) NOT NULL,
    carbs NUMERIC(6,1) NOT NULL,
    is_deleted BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meal_details_event ON meal_details (event_id);
CREATE INDEX IF NOT EXISTS idx_meal_details_sync ON meal_details (user_id, updated_at);

-- ------------------------------------------------------------------------------
-- 9. ユーザー設定
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_settings (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    hypo_threshold NUMERIC(5,1) DEFAULT 70.0,
    hyper_threshold NUMERIC(5,1) DEFAULT 180.0,
    target_tir_min NUMERIC(5,1) DEFAULT 70.0,
    target_tir_max NUMERIC(5,1) DEFAULT 180.0,
    enable_default_insulin BOOLEAN DEFAULT FALSE,
    default_insulin_breakfast NUMERIC(5,1),
    default_insulin_lunch NUMERIC(5,1),
    default_insulin_dinner NUMERIC(5,1),
    default_insulin_snack NUMERIC(5,1),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==============================================================================
-- 全テーブルの Row Level Security (RLS) ポリシー一括設定
-- ==============================================================================

ALTER TABLE family_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE libre_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

-- 家族権限テーブル: 認可されたオーナー本人のみ招待・管理可能、招待された家族は自分宛ての権限レコードを参照・初回承認可能
DROP POLICY IF EXISTS "family_permissions_select" ON family_permissions;
CREATE POLICY "family_permissions_select" ON family_permissions
    FOR SELECT USING (
        public.is_authorized_system_user(auth.uid(), COALESCE(auth.jwt() ->> 'email', ''))
        AND (
            auth.uid() = patient_id
            OR auth.uid() = family_user_id
            OR (
                family_email IS NOT NULL
                AND LOWER(NULLIF(BTRIM(family_email), '')) = LOWER(NULLIF(BTRIM(COALESCE(auth.jwt() ->> 'email', '')), ''))
            )
        )
    );

DROP POLICY IF EXISTS "family_permissions_all" ON family_permissions;
CREATE POLICY "family_permissions_all" ON family_permissions
    FOR ALL USING (
        auth.uid() = patient_id
        AND public.is_system_owner(auth.uid(), COALESCE(auth.jwt() ->> 'email', ''))
    )
    WITH CHECK (
        auth.uid() = patient_id
        AND public.is_system_owner(auth.uid(), COALESCE(auth.jwt() ->> 'email', ''))
    );

DROP POLICY IF EXISTS "family_permissions_accept_invite" ON family_permissions;
CREATE POLICY "family_permissions_accept_invite" ON family_permissions
    FOR UPDATE USING (
        family_email IS NOT NULL
        AND LOWER(NULLIF(BTRIM(family_email), '')) = LOWER(NULLIF(BTRIM(COALESCE(auth.jwt() ->> 'email', '')), ''))
    )
    WITH CHECK (
        family_email IS NOT NULL
        AND LOWER(NULLIF(BTRIM(family_email), '')) = LOWER(NULLIF(BTRIM(COALESCE(auth.jwt() ->> 'email', '')), ''))
        AND family_user_id = auth.uid()
    );

-- 各業務テーブル: 閲覧（本人+家族）、編集（本人+代理入力）
DO $$
DECLARE
    tbl text;
    tables text[] := ARRAY['categories', 'food_master', 'event_master', 'libre_readings', 'events', 'meal_details', 'user_settings'];
BEGIN
    FOREACH tbl IN ARRAY tables LOOP
        EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON %I;', tbl, tbl);
        EXECUTE format('CREATE POLICY "%s_select" ON %I FOR SELECT USING (can_view_patient_data(user_id));', tbl, tbl);

        EXECUTE format('DROP POLICY IF EXISTS "%s_insert" ON %I;', tbl, tbl);
        EXECUTE format('CREATE POLICY "%s_insert" ON %I FOR INSERT WITH CHECK (can_edit_patient_data(user_id));', tbl, tbl);

        EXECUTE format('DROP POLICY IF EXISTS "%s_update" ON %I;', tbl, tbl);
        EXECUTE format('CREATE POLICY "%s_update" ON %I FOR UPDATE USING (can_edit_patient_data(user_id)) WITH CHECK (can_edit_patient_data(user_id));', tbl, tbl);

        EXECUTE format('DROP POLICY IF EXISTS "%s_delete" ON %I;', tbl, tbl);
        EXECUTE format('CREATE POLICY "%s_delete" ON %I FOR DELETE USING (can_edit_patient_data(user_id));', tbl, tbl);
    END LOOP;
END $$;

