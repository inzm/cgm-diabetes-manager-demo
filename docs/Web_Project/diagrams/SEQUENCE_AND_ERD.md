# Web版 シーケンス図 & データベースER図 (SEQUENCE_AND_ERD.md)

本ドキュメントは、システム内の重要処理フロー（家族共有認可、Local-First同期、CSVインポート）およびデータベースのエンティティ関係（ER図）をMermaid記法で可視化した仕様書です。

---

## 1. データベース ER図 (Entity Relationship Diagram)

本システムの PostgreSQL（Supabase）および IndexedDB（Dexie.js）で管理される全エンティティの関連図です。

```mermaid
erDiagram
    users ||--o{ family_permissions : "patient"
    users ||--o{ family_permissions : "family_user"
    users ||--o{ libre_readings : "owns"
    users ||--o{ events : "owns"
    users ||--o{ meal_details : "owns"
    users ||--o{ food_master : "owns"
    users ||--o{ event_master : "owns"
    users ||--o{ categories : "owns"
    users ||--|| user_settings : "configures"

    categories ||--o{ food_master : "classifies"
    categories ||--o{ event_master : "classifies"
    events ||--o{ meal_details : "has_items"

    users {
        uuid id PK "Supabase auth.users"
        string email
        timestamptz created_at
    }

    family_permissions {
        uuid id PK
        uuid patient_id FK "患者ID"
        uuid family_user_id FK "家族ID"
        string role "viewer / editor"
        timestamptz created_at
    }

    libre_readings {
        uuid id PK
        uuid user_id FK "患者ID"
        timestamptz timestamp "測定日時"
        numeric glucose_value "血糖値 (mg/dL)"
        string scan_type "Historic / Scan"
    }

    events {
        uuid id PK "UUID (オフライン競合ゼロ)"
        uuid user_id FK "患者ID"
        timestamptz event_datetime "統合日時 (タイムゾーン対応)"
        string event_type "食事 / 活動 / 低血糖 / 高血糖"
        string timing_category "朝 / 昼 / 夕 / 間食 / 就寝前"
        numeric total_carbs "糖質合計(g)"
        numeric insulin_units "インスリン量(単位)"
        numeric pre_meal_glucose "食前血糖値"
        numeric post_meal_glucose "食後血糖値"
        int duration_minutes "実施/継続時間(分)"
        text memo "メモ / 異常値詳細"
        boolean is_deleted "論理削除フラグ"
        timestamptz updated_at "最終更新日時"
    }

    meal_details {
        uuid id PK "UUID"
        uuid user_id FK "患者ID"
        uuid event_id FK "イベントID"
        string food_name "食品名"
        numeric amount "数量"
        string unit "単位"
        numeric carbs "糖質量(g)"
        boolean is_deleted "論理削除フラグ"
        timestamptz updated_at
    }

    categories {
        uuid id PK "UUID"
        uuid user_id FK "患者ID"
        string target_type "food / event"
        string category_name "カテゴリ名"
        int display_order "並び順"
        boolean is_protected "システム保護('未分類')"
        boolean is_deleted "論理削除フラグ"
        timestamptz updated_at
    }

    food_master {
        uuid id PK "UUID"
        uuid user_id FK "患者ID"
        uuid category_id FK "カテゴリID (SET NULL)"
        string food_name "食品名"
        numeric base_amount "基準量"
        string unit "単位"
        numeric carbs_per_unit "基準糖質(g)"
        boolean is_deleted "論理削除フラグ"
        timestamptz updated_at
    }

    event_master {
        uuid id PK "UUID"
        uuid user_id FK "患者ID"
        uuid category_id FK "カテゴリID (SET NULL)"
        string event_name "活動名"
        int default_duration "標準時間(分)"
        text memo "備考"
        boolean is_deleted "論理削除フラグ"
        timestamptz updated_at
    }

    user_settings {
        uuid user_id PK,FK "患者ID"
        numeric hypo_threshold "低血糖閾値 (70)"
        numeric hyper_threshold "高血糖閾値 (180)"
        numeric target_tir_min "TIR下限 (70)"
        numeric target_tir_max "TIR上限 (180)"
        boolean enable_default_insulin "インスリン初期値有効化"
        numeric default_insulin_breakfast "朝食デフォルト単位"
        numeric default_insulin_lunch "昼食デフォルト単位"
        numeric default_insulin_dinner "夕食デフォルト単位"
        numeric default_insulin_snack "間食デフォルト単位"
        timestamptz updated_at
    }
```

---

## 2. 家族閲覧ロール ＆ Supabase RLS 認可シーケンス

家族がログインして患者の血糖値・食事データを閲覧する際の認可と表示制御のフローです。

```mermaid
sequenceDiagram
    autonumber
    actor Family as 家族ユーザー (Viewer)
    participant UI as React UI (PatientContext)
    participant LocalDB as IndexedDB (Dexie.js)
    participant SupaAuth as Supabase Auth
    participant SupaDB as Supabase PostgreSQL (RLS)

    Family->>UI: 1. ログイン (email / password)
    UI->>SupaAuth: 認証リクエスト
    SupaAuth-->>UI: JWT トークン返却 (UID: family_user_id)

    UI->>SupaDB: 家族連携テーブル確認 (family_permissions)
    SupaDB-->>UI: 患者リスト返却 (例: 患者A, role: 'viewer')

    UI->>UI: PatientContext 更新 (currentPatientId = 患者A, isReadOnly = true)
    Note over UI: UIラッパーが全画面で「登録・編集・削除・CSV取込」ボタンを非表示化

    alt ローカルキャッシュに患者Aのデータが存在する場合
        UI->>LocalDB: 患者Aのデータを即時取得
        LocalDB-->>UI: キャッシュ返却 (所要時間: 5ms)
        UI-->>Family: カレンダー画面をゼロ遅延で描画
    end

    UI->>SupaDB: 最新差分リクエスト (user_id = 患者A, updated_at > lastSync)
    Note over SupaDB: RLSポリシー実行: can_view_patient_data()<br/>family_permissions に存在するため【許可】
    SupaDB-->>UI: 差分データ返却
    UI->>LocalDB: IndexedDB へ反映 (bulkPut)
    UI-->>Family: 最新データに静かに同期描画
```

---

## 3. Local-First マルチデバイス同期 ＆ CSV取込シーケンス

PCでリブレCSVを取り込み、スマホへリアルタイム同期されるまでのバックグラウンド並列処理フローです。

```mermaid
sequenceDiagram
    autonumber
    actor Patient as 患者本人 (PC)
    participant UI_PC as React UI (PC)
    participant Worker as Web Worker
    participant LocalDB_PC as IndexedDB (PC)
    participant Supabase as Supabase (PostgreSQL / Storage / Realtime)
    participant UI_Mobile as React UI (スマホ)
    participant LocalDB_Mobile as IndexedDB (スマホ)

    Patient->>UI_PC: 1. リブレCSVファイル選択 (8.4万行)
    UI_PC->>Worker: 2. ファイルバッファ転送 (メインスレッド分離)
    Note over UI_PC: プログレスバー表示 (UIは軽快に操作可能)

    Note over Worker: 3. PapaParse 高速パース<br/>4. ステートマシン実行 (異常値エピソード抽出)<br/>5. 食前・食後血糖の探索バインド

    Worker->>LocalDB_PC: 6. 生データ & 異常値イベントを一括保存 (bulkPut)
    LocalDB_PC-->>UI_PC: 完了通知 (カレンダー・日次グラフ即時更新)

    Worker->>Supabase: 7. CSV原本を Supabase Storage にアップロード
    Worker->>Supabase: 8. 抽出済みエピソード & 生データをバッチ同期 (2,000件/chunk)
    Supabase-->>Worker: 同期完了

    Note over Supabase: 9. Supabase Realtime イベント発火 (events / libre_readings)
    Supabase-->>UI_Mobile: 10. WebSocket更新通知を受信
    UI_Mobile->>Supabase: 11. 差分データ取得 (Delta Fetch)
    Supabase-->>UI_Mobile: 差分JSON返却
    UI_Mobile->>LocalDB_Mobile: 12. IndexedDB更新
    UI_Mobile-->>Patient: スマホ側の画面も自動で最新化！
```

---

## 4. 初回起動・リロード時の Memory-First 3段階段階的同期シーケンス (`src/lib/realGlucoseLoader.ts`)

初回アクセスおよびポートフォリオモードでのリロード時に、IndexedDB のディスクI/O待ちをバイパスして **0.5秒以内** にカレンダーを初期描画し、裏側で段階的に全79,479件を永続化するデータフローです。

```mermaid
sequenceDiagram
    autonumber
    actor User as ユーザー / 閲覧者
    participant Browser as ブラウザ (index.html)
    participant Loader as realGlucoseLoader.ts (inMemoryRecentCache)
    participant Calendar as CalendarView / DailyDetailDrawer
    participant LocalDB as IndexedDB (Dexie.js)
    participant CDN as Cloudflare Pages CDN

    User->>Browser: 1. ページアクセス / リロード
    par JSバンドルと直近データの並列プリロード
        Browser->>CDN: index.js / vendor-*.js 取得
        Browser->>CDN: <link rel="preload"> /data/real_glucose_recent.json (gzip 18KB)
    end
    CDN-->>Loader: 2. 直近42日タプル (3,482件) 到着

    Note over Loader: 【Stage 1: Memory-First 即時展開 (約15ms)】<br/>直近測定値・異常値・食事/活動・明細をメモリ生成し<br/>inMemoryRecentCache に保持 (IndexedDB書込は待たない)

    Calendar->>Loader: 3. getInMemoryRecentSlice() で42日グリッド分を0ms取得
    Loader-->>Calendar: メモリ上の readings & events を即時返却
    Calendar-->>User: 4. 初期カレンダー (2026年8月) を即座に描画完了！ (< 0.5秒)

    Note over Loader,LocalDB: 【Stage 2: 直近データ & 初期食品の非同期永続化 (描画60ms後)】
    Loader->>LocalDB: 5. seedFoodMasterIfEmpty() + 直近イベント・明細を bulkPut<br/>(※既存7.9万件がある場合は libre_readings の再書込をスキップ)
    LocalDB-->>Loader: 永続化完了 (inMemoryRecentCache.persisted = true に切替)

    Note over Loader,LocalDB: 【Stage 3: 過去7.6万件のチャンク分割背景同期 (350ms後)】
    Loader->>CDN: 6. /data/real_glucose_readings.json (全79,479件) を背景取得
    CDN-->>Loader: 全期間タプル返却
    Loader->>LocalDB: 7. 過去イベント (< 2026-07-15) を bulkPut
    loop 6,000件チャンク × 40ms休止 (UIブロッキングゼロ)
        Loader->>LocalDB: 8. 過去測定値を新しい月順に段階 bulkPut
    end
    Loader->>Calendar: 9. 'cgm-background-hydration-complete' イベント通知 (過去月キャッシュ・分析最古日を更新)
```

