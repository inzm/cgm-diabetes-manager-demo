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
-- 2. 権限判定用ヘルパー関数 (RLS用)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION can_view_patient_data(target_patient_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN (
        auth.uid() = target_patient_id
        OR EXISTS (
            SELECT 1 FROM family_permissions
            WHERE patient_id = target_patient_id
              AND (
                  family_user_id = auth.uid()
                  OR (
                      family_email IS NOT NULL
                      AND LOWER(family_email) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
                  )
              )
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION can_edit_patient_data(target_patient_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN (
        auth.uid() = target_patient_id
        OR EXISTS (
            SELECT 1 FROM family_permissions
            WHERE patient_id = target_patient_id
              AND role = 'editor'
              AND (
                  family_user_id = auth.uid()
                  OR (
                      family_email IS NOT NULL
                      AND LOWER(family_email) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
                  )
              )
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

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

-- 家族権限テーブル: 本人のみ招待・管理可能、家族は自分宛ての権限レコードを参照可能
DROP POLICY IF EXISTS "family_permissions_select" ON family_permissions;
CREATE POLICY "family_permissions_select" ON family_permissions
    FOR SELECT USING (
        auth.uid() = patient_id
        OR auth.uid() = family_user_id
        OR (
            family_email IS NOT NULL
            AND LOWER(family_email) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
        )
    );

DROP POLICY IF EXISTS "family_permissions_all" ON family_permissions;
CREATE POLICY "family_permissions_all" ON family_permissions
    FOR ALL USING (auth.uid() = patient_id)
    WITH CHECK (auth.uid() = patient_id);

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

