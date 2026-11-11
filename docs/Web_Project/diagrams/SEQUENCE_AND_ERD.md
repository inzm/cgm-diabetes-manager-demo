# Web版 シーケンス図 & データベースER図 (SEQUENCE_AND_ERD.md)

本ドキュメントは、システム内の重要処理フロー（家族共有認可、Local-First同期、CSVインポート）およびデータベースのエンティティ関係（ER図）をMermaid記法で可視化した仕様書です。
（※Phase 1 時点では IndexedDB (Dexie.js) ＋ 決定論的UUID (`src/lib/uuidUtils.ts`) ＋ Web Worker CSV取込 ＋ JSONバックアップ/復元が稼働中であり、Supabase Auth・PostgreSQL RLS・Delta Sync はクラウド接続フェーズで有効化されるターゲットシーケンスです。）

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
        string category_name "カテゴリ名 (WHERE is_deleted = false 部分ユニーク)"
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

## 2. 専用ログイン画面（Auth Gate）・招待専用ガード ＆ Supabase RLS 認可シーケンス

本番環境（`VITE_APP_MODE=personal` かつ Supabase 有効時）において、未ログイン時は `AuthGateScreen.tsx` のみを表示して第三者の閲覧を遮断し、ログイン時にオーナー本人または招待済み家族であることを検証した上でデータ同期を行い、ログアウト時にローカルキャッシュを全消去するフローです。

```mermaid
sequenceDiagram
    autonumber
    actor User as アクセス者 (患者本人 / 招待家族 / 第三者)
    participant Gate as AuthGateScreen.tsx (App.tsx)
    participant Context as PatientContext / syncEngine.ts
    participant LocalDB as IndexedDB (7テーブル) & メモリキャッシュ
    participant SupaAuth as Supabase Auth (trg_enforce_invited_or_owner_signup)
    participant SupaDB as Supabase PostgreSQL (RLS & verify_user_authorization)

    User->>Gate: 1. アプリURLへアクセス (未ログイン時)
    Note over Gate: isAuthRequired === true && !authUser<br/>カレンダー・メニュー等を一切描画せずログイン画面のみ表示

    User->>Gate: 2. ログイン / 招待家族サインアップ送信
    Gate->>SupaAuth: signInWithPassword / signUp
    Note over SupaAuth: サインアップ時は BEFORE INSERT トリガーで<br/>オーナーまたは family_permissions 招待済みを検証
    SupaAuth-->>Context: JWT セッション返却 (auth.uid, email)

    Context->>SupaDB: 3. 家族連携照会 (family_permissions) & verify_user_authorization()
    alt 未招待の第三者アカウントの場合
        SupaDB-->>Context: authorized = false
        Context->>SupaAuth: 即座に強制 signOut()
        Context->>LocalDB: purgeAllLocalPatientCaches() (全テーブル・メモリ消去)
        Context-->>Gate: アクセス権限エラー表示 (Auth Gate 維持)
    else オーナー本人 または 招待済み家族の場合
        SupaDB-->>Context: authorized = true (owner または invited family)
        Context->>Context: isAccessAuthorized = true, currentPatientId / userRole 設定
        Context->>SupaDB: 4. 双方向差分同期 (syncPatientDataWithCloud)
        SupaDB-->>LocalDB: 最新データ反映 (bulkPut)
        Context-->>User: 5. カレンダー画面・各機能をアンロックして描画
    end

    User->>Context: 6. ログアウト実行 (signOut)
    Context->>SupaAuth: セッション破棄
    Context->>LocalDB: 7. purgeAllLocalPatientCaches() (IndexedDB全7テーブル & 全4種メモリキャッシュ完全消去)
    Context-->>Gate: 8. 専用ログイン画面 (Auth Gate) へ戻る
```

---

## 3. Local-First マルチデバイス同期 ＆ CSV取込シーケンス

PCでリブレCSVを取り込み、スマホへリアルタイム同期されるまでのバックグラウンド並列処理フローです。

```mermaid
sequenceDiagram
    autonumber
    actor Patient as 患者本人 (PC)
    participant UI_PC as React UI (PC)
    participant Worker as Web Worker (csvParser.worker.ts)
    participant LocalDB_PC as IndexedDB (PC)
    participant Supabase as Supabase (PostgreSQL / Storage / Realtime)
    participant UI_Mobile as React UI (スマホ)
    participant LocalDB_Mobile as IndexedDB (スマホ)

    Patient->>UI_PC: 1. リブレCSVファイル選択 (8.4万行)
    UI_PC->>Worker: 2. ファイルバッファ転送 (メインスレッド分離)
    Note over UI_PC: プログレスバー表示 (UIは軽快に操作可能)

    Note over Worker: 3. 独自ストリームCSVパーサー + deterministicUuid (uuidUtils.ts)<br/>4. ステートマシン実行 (異常値エピソード抽出)<br/>5. 食前(-15〜+5分)・食後(60〜180分ピーク)血糖の探索バインド

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

## 4. ポートフォリオモード初回起動・リロード時の Memory-First 3段階段階的同期シーケンス (`src/lib/realGlucoseLoader.ts`)

ポートフォリオ公開モード（`VITE_APP_MODE=portfolio`）での初回アクセスおよびリロード時に、IndexedDB のディスクI/O待ちをバイパスして **0.5秒以内** にカレンダーを初期描画し、裏側で段階的に全79,479件をハイドレーションするデータフローです。
（※本番モード `VITE_APP_MODE=personal` では本シーケンスのデモJSON取得・ハイドレーションは一切実行されず、`seedFoodMasterIfEmpty(patientId)` のみが実行されます。）

```mermaid
sequenceDiagram
    autonumber
    actor User as 閲覧者 (Portfolio Mode)
    participant Browser as ブラウザ (index.html)
    participant Loader as realGlucoseLoader.ts (inMemoryRecentCache)
    participant Calendar as CalendarView / DailyDetailDrawer
    participant LocalDB as InMemoryDemoDB / IndexedDB
    participant CDN as Cloudflare Pages CDN

    User->>Browser: 1. ページアクセス / リロード (VITE_APP_MODE=portfolio)
    par JSバンドルと直近データの並列プリロード
        Browser->>CDN: index.js / vendor-*.js 取得
        Browser->>CDN: <link rel="preload"> /data/real_glucose_recent.json (gzip 18KB)
    end
    CDN-->>Loader: 2. 直近42日タプル (3,482件) 到着

    Note over Loader: 【Stage 1: Memory-First 即時展開 (約15ms)】<br/>直近測定値・異常値・食事/活動・明細を決定論的UUID (uuidUtils.ts) でメモリ生成し<br/>inMemoryRecentCache に保持 (DB書込は待たない)

    Calendar->>Loader: 3. getInMemoryRecentSlice() で42日グリッド分を0ms取得
    Loader-->>Calendar: メモリ上の readings & events を即時返却
    Calendar-->>User: 4. 初期カレンダー (最新実データ月) を即座に描画完了！ (< 0.5秒)

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

