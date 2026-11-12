# Web版 システム全体アーキテクチャ & 詳細技術仕様書 (ARCHITECTURE.md)

本ドキュメントは、Excel VBAシステム（`main.xlsm`）から刷新されるWebアプリケーションのシステム全体設計、Local-First同期アーキテクチャ、高難度機能の代替実装方針、およびセキュリティ仕様を定義した基本設計書です。

---

## 1. システム全体アーキテクチャ

本システムは、**「React (Local-First) ＋ Cloudflare ＋ Supabase」** を中核アーキテクチャとして採用します。

```mermaid
flowchart TD
    subgraph ClientLayer ["1. クライアント層 (PC / スマートフォン / PWA)"]
        UI["React 18+ / TypeScript\n(Tailwind CSS + shadcn/ui)"]
        Charts["Apache ECharts\n(24H散布図 / 複合グラフ / マイクロチャート)"]
        LocalDB[("IndexedDB (Dexie.js)\nローカル高速データストア")]
        Worker["Web Worker\n(CSVパース / 異常値抽出ステートマシン)"]
        
        UI <--> Charts
        UI <--> LocalDB
        UI -->|重い計算の委譲| Worker
        Worker -->|パース・異常値抽出結果返却| UI
    end

    subgraph EdgeLayer ["2. エッジ・ホスティング層 (Cloudflare)"]
        CF_Pages["Cloudflare Pages\n(グローバル超高速静的配信)"]
        CF_Workers["Cloudflare Workers (BFF)\n(Gemini API 安全中継 & JWT/同一Origin検証)"]
    end

    subgraph CloudLayer ["3. クラウドデータベース & BaaS層 (Supabase)"]
        S_Auth["Supabase Auth\n(JWT認証 / 二要素認証)"]
        S_DB[("PostgreSQL\n(Single Source of Truth / RLS保護)")]
        S_Realtime["Supabase Realtime\n(別端末更新のWebSocket検知)"]
        S_Storage["Supabase Storage\n(リブレCSV原本ファイル保管 ※未実装)"]
    end

    subgraph ExternalService ["4. 外部AI基盤"]
        Gemini["Google Gemini REST API\n(糖質量自動推定 / 臨床助言)"]
    end

    CF_Pages -.->|アプリ配信| UI
    UI <-->|差分同期 (Delta Sync)| S_DB
    UI <-->|ユーザー認証| S_Auth
    S_Realtime -.->|更新通知| UI
    UI -.->|CSV原本アップロード (未実装)| S_Storage
    UI -->|AI推定リクエスト (JWT / 同一Origin)| CF_Workers
    CF_Workers -->|APIキー秘匿通信| Gemini
```

---

## 2. Local-First & マルチデバイス同期設計仕様

本システムの中核は、**「Supabase（クラウド）をマスター保管庫 ＋ IndexedDB（ブラウザ）をローカル高速キャッシュ」** とする **Local-First（オフラインファースト）アーキテクチャ** です。

### 2.1 データ同期の基本原則
> **【実装フェーズ注記】**: 現在のクライアント実装は、ブラウザ内 `IndexedDB (Dexie.js)`（`src/lib/db.ts`）、JSON バックアップ出力・正規UUIDマイグレーション復元サービス（`src/lib/backupRestore.ts` / `src/components/settings/DataBackupSection.tsx`）、および Supabase 双方向同期エンジン（`src/lib/syncEngine.ts`）による Local-First 基盤で動作しており、全7テーブルの主キー・外部キーは決定論的UUID（`src/lib/uuidUtils.ts`）で正規化済みです。

1. **Single Source of Truth (SSOT)**:
   - クラウド接続後の真のデータ原本は **Supabase (PostgreSQL)** であり、ローカル単体運用時は **IndexedDB (Dexie.js) ＋ JSON バックアップ** が原本となります。
   - IndexedDBは「端末側で瞬時に描画・集計するためのローカル高速データベース」と位置付け、端末初期化やブラウザキャッシュ削除時でもJSONバックアップまたはSupabaseから完全に復元可能とします。
2. **ゼロレイテンシ描画**:
   - 画面遷移（カレンダー ⇄ 日次詳細 ⇄ 分析）時は、ネットワーク通信を一切待たず、ローカルのIndexedDBから **0.01秒未満でデータを即時取得・描画** します。
   - クラウド接続時はバックグラウンドでSupabaseと差分同期を行い、変更があればUIへ静かに反映します。

### 2.2 データ種別ごとの同期戦略

| データ種別 | 特性 | 同期方式 | コンフリクト解消ルール |
| :--- | :--- | :--- | :--- |
| **血糖値生データ (`libre_readings`)** | 追記専用 (Append-only) 約8.4万〜10万件 | 差分バルクインサート | `(user_id, timestamp)` のユニーク制約により重複時はスキップ（`ON CONFLICT DO NOTHING`）。競合は原理的に発生しない。 |
| **食事・活動記録 (`events`, `meal_details`)** | 追加・編集・削除 | 差分同期 (Delta Sync) | **論理削除 (`is_deleted = true`)** を徹底。`updated_at` が新しい方を優先採用する **Last-Write-Wins (LWW)**。 |
| **食品・活動マスタ (`food_master`, `event_master`)** | 追加・編集・削除 | 差分同期 (Delta Sync) | 論理削除 ＋ LWW。システム保護カテゴリ「未分類」はクライアント・DB双方で削除禁止。 |
| **臨床設定 (`user_settings`)** | 低血糖/高血糖閾値等 | 即時同期 | 1ユーザー1レコード。LWW。 |

### 2.3 環境別起動データ戦略 & ポートフォリオ用 Memory-First 3段階段階的同期 (`src/lib/realGlucoseLoader.ts`, `src/lib/demoMealGenerator.ts`)
- **本番モード (`VITE_APP_MODE=personal`) におけるクリーン起動・データ保護**:
  - 本番モードでは `public/data/real_glucose_recent.json` および `public/data/real_glucose_readings.json` のプリフェッチ・ハイドレーションや既存ユーザーデータの削除を一切行いません（ビルド時にも `vite.config.ts` のプラグインにより `dist/data/real_glucose_*.json` を出力から完全除外）。
  - 初回起動時は `seedFoodMasterIfEmpty(patientId)`（`src/lib/foodSeed.ts`）のみを実行してよく使う食品・活動・カテゴリの初期プリセット（決定論的UUID：`src/lib/uuidUtils.ts`）を投入し、血糖・食事・活動記録は0件のクリーンな状態からユーザー本人の手動記録およびFreeStyleリブレCSV取込を開始します。
- **ポートフォリオモード (`VITE_APP_MODE=portfolio`) における Memory-First 3段階段階的同期**:
  - デモ公開環境での初回アクセスやリロード時に、2年分（79,479件・2.14MB）の全データを一括ダウンロードして IndexedDB の B-Tree インデックスへ書き込むのを待ってから画面を描画すると初期表示に10〜18秒を要してしまうため、献立・イベント生成ドメインロジックを `src/lib/demoMealGenerator.ts` に分離した上で、以下の **「Memory-First 3段階段階的同期」** により初期表示を **0.3〜0.8秒以内** に完結させます。

1. **Stage 1：Memory-First 即時初期描画（0.3〜0.8秒・IndexedDB I/O 待ちゼロ・`portfolio` モード専用）**:
   - `vite.config.ts` が `portfolio` ビルド時のみ注入する `<link rel="preload" href="/data/real_glucose_recent.json" as="fetch" crossorigin="anonymous">` および `src/lib/realGlucoseLoader.ts` モジュール評価時のプリフェッチ（`isPortfolioMode()` 時のみ実行）により、JSバンドルのダウンロードと並行して直近42日分データ（`public/data/real_glucose_recent.json`：3,482件・約91KB / gzip 18KB）を取得。
   - 取得した直近タプルからメモリ上で測定データ・異常値エピソード・食事/活動記録・食事明細を正規UUID（`deterministicUuid`：`src/lib/uuidUtils.ts`）で生成（約15ms）し、オンメモリキャッシュ（`inMemoryRecentCache`）に格納して即座に `ensureRealGlucoseDataLoaded` を完了させる。
   - `src/components/calendar/CalendarView.tsx`（`getInMemoryRecentSlice`）および `src/components/daily/DailyDetailDrawer.tsx`（`getInMemoryRecentMealDetails`）は、書き込み完了を待たずにメモリから 0ms でデータを読み取って初期カレンダー（2026年8月）を描画する。
2. **Stage 2：直近データ＆初期食品データの非同期永続化（First Paint 完了後）**:
   - 初期カレンダーの DOM 描画が完了した直後（60ms 待機後）、裏側で `seedFoodMasterIfEmpty`（`src/lib/foodSeed.ts`）および直近データの保存を実行する。
   - 永続化完了と同時に `inMemoryRecentCache.persisted = true` へ切り替え、以降のユーザー操作（記録追加・編集・削除）はすべて `src/lib/db.ts` の複合インデックス（`[user_id+timestamp]`, `[user_id+event_datetime]`, `[user_id+event_id]`）を参照する。
3. **Stage 3：過去7.6万件データのチャンク分割バックグラウンド同期**:
   - さらに待機した後、全期間データ（`public/data/real_glucose_readings.json`：79,479件、2024年9月〜2026年8月）をバックグラウンド取得し、2026年7月15日以前の過去イベントと過去測定値（75,997件）をメインスレッドをブロックしないよう **6,000件ずつの小チャンク（チャンク間に40msの休止）** で新しい月順に段階投入する。
   - ユーザーが設定画面で「記録データを初期化」または「バックアップから復元」を実行した場合は、`cancelBackgroundHydration` および `markPatientManuallyCleared` により実行中のバックグラウンド投入を即時停止し、同一セッション内でカレンダーや分析画面へ遷移してもデモデータが勝手に再ハイドレーションされないよう保護する（`resetDemoDataToInitialState` 実行時のみ解除）。
   - 全件投入完了時に `cgm-background-hydration-complete` カスタムイベントを発火し、カレンダーの過去月キャッシュや分析画面（`src/components/analysis/AnalysisView.tsx`）の最古記録日・月別選択肢を自動更新する。

### 2.4 ブラウザによる勝手なデータ消去への対策 (Eviction防止)
- **問題**: iOS Safari等のブラウザは、ストレージ逼迫時や7日間アクセスがない場合にIndexedDBを自動削除（Eviction）する制限がある。
- **対策**:
  - アプリ初回起動時に **Persistent Storage API** をリクエストする：
    ```typescript
    if (navigator.storage && navigator.storage.persist) {
      const isPersisted = await navigator.storage.persist();
      console.log(`Persistent storage granted: ${isPersisted}`);
    }
    ```
  - 万が一IndexedDBがクリアされた場合でも、ログイン時にSupabaseから自動再同期するリカバリ処理を常設。

---

## 3. 実現難易度が高い機能のWeb移行・代替設計仕様

Excel固有の仕様や大量データ処理など、Web化において技術的ハードルが高い機能の解決設計です。

### 3.1 24時間血糖値散布図 ＋ 垂直ドロップライン・異常マーカーの重畳描画
- **課題**: Excelの `ErrorBars`（+250 mg/dLの垂直破線）やカスタム図形マーカーをWeb上で美しく、かつスマホ対応で再現する必要がある。
- **解決方針 (Apache ECharts の採用 & `src/lib/echartsCore.ts` によるツリーシェイク)**:
  - **ECharts部分インポート & 遅延ロード**: `src/lib/echartsCore.ts` で `echarts/core` と `echarts-for-react/lib/core` を用い、必要なチャート（`LineChart`, `BarChart`, `ScatterChart`）・コンポーネント（`GridComponent`, `TooltipComponent`, `LegendComponent`, `MarkLineComponent`, `MarkAreaComponent`）・レンダラー（`CanvasRenderer`, `SVGRenderer`）のみを登録。さらに初期画面（カレンダー）に不要なドロワーや分析画面・モーダル群を `React.lazy()` でチャンク分割し、初回ロード時間を最小化する。
  - **主系列（血糖曲線）**: `type: 'line'`, `smooth: true`, 00:00〜24:00の15分間隔実測値を描画。
  - **目標範囲帯**: `markLine` または `markArea` を用いて、70 mg/dL（赤点線）〜 180 mg/dL（橙点線）の背景ガイド帯をレイヤー描画。
  - **食事マーカー**: 食事発生時刻のX座標に対して `markLine`（垂直ドット線）を引き、上部または下部にカスタムSVGアイコン（🍽️）と糖質/インスリンラベルを配置。
  - **異常値マーカー**: 低血糖（▼）・高血糖（▲）の発生箇所に `markPoint` をプロットし、最低値・ピーク値をバッジ表示。
  - **レスポンシブ衝突回避**: EChartsの `avoidLabelOverlap: true` を有効化し、狭い画面でもラベルが重ならないよう自動オフセット。

### 3.2 カレンダー画面の「42日分スパークライン」軽量化代替
- **課題**: 42日（6週×7日）分のセル内に独立した折れ線グラフを愚直にレンダリングすると、仮想DOMとCanvas生成の負荷で月送り時にカクつき（Jank）が発生する。
- **解決方針（マイクロSVGまたは代替表現への刷新）**:
  - **アプローチA (マイクロSVG / 採用推奨)**:
    重いチャートコンポーネントを置くのではなく、事前集計された日次配列（96点）から **軽量な単一 `<svg><path d="..." /></svg>` のパス文字列を文字列演算で生成**。1日あたり数KB、DOM負荷ゼロで42日分を一瞬で描画。
  - **アプローチB (UI洗練・臨床視認性重視の代替)**:
    スパークラインの代わりに、以下のいずれか（またはユーザー選択式）に仕様変更：
    1. **TIRミニプログレスバー**: 目標範囲内（緑）、低血糖（青）、高血糖（赤）の比率を示すスタックバー。
    2. **最高/最低レンジバー**: 当日の血糖レンジ（Min〜Max）を棒グラフで表示。

### 3.3 大容量CSV（8.4万行）パース ＆ 異常値自動抽出（ステートマシン）
- **課題**: 8.4万行のCSVパースと、CGM臨床標準ルール（正常復帰28分継続ルール、45分ギャップ判定）に基づくエピソード抽出処理をサーバー（Cloudflare Workers 10ms CPU制限）で同期実行するとタイムアウトする。
- **解決方針（ブラウザ側 Web Worker 分散実行 & 決定論的UUID採番）**:
  - CSVファイルをブラウザで選択後、メインスレッド（`src/components/import/CsvImportModal.tsx`）から **Web Worker**（`src/workers/csvParser.worker.ts`）にファイルテキストを渡す。
  - Web Worker 内の **独自高速ストリーム行分割CSVパーサー**（外部ライブラリ非依存・FreeStyleリブレLink日英ヘッダー自動検出）を用いてパースし、`src/lib/uuidUtils.ts` の `deterministicUuid(`${patientId}_${isoTime}`)` により冪等な正規UUIDを採番。
  - 続けて共通ステートマシン（`src/lib/anomalyExtractor.ts`）を実行して異常値エピソード（`deterministicUuid(`${patientId}_anomaly_${event_type}_${start}`)`）を抽出。
  - 抽出結果（低血糖/高血糖イベント）と生データを IndexedDB へバルク保存し、登録済みの食事記録に対して食前・食後ピーク血糖値を自動バインド（`bindMealGlucoseFromReadings`）した後、Supabase接続時は非同期バックグラウンド送信（バッチチャンク: 1,000件ずつ）を行う。
  - **結果**: サーバーコスト・CPU制限ゼロ、ユーザーを待たせずにプログレスバーを表示しながら数秒でインポート完了。

### 3.4 臨床閾値変更時の「全過去データ再判定（リバリュエーション）」
- **課題**: 設定画面で低血糖閾値（70→75）等を変更した際、全期間のデータから異常値イベントを全件再計算・再同期する必要がある。
- **解決方針**:
  - ローカルのIndexedDBに全期間の生データが存在するため、`src/lib/anomalyExtractor.ts` の `reevaluatePatientAnomalyEvents` により全期間のステートマシンを再実行。
  - 手動登録イベント（食事・活動）を残し、自動抽出イベント（低血糖・高血糖）のみを正規UUID（`deterministicUuid`）で差し替え。
  - Supabaseへは「旧異常値イベントの削除」と「新異常値イベントのバルク登録」を1トランザクションで送信。

### 3.5 食前・食後ピーク血糖値の近傍探索ロジック (`src/lib/anomalyExtractor.ts`)
- **課題**: 食事開始時刻 $T$ に対する食前血糖値、および食後ピーク血糖値を実測CGMデータから高速かつ正確に探索・補完する。
- **解決方針**:
  - **ローカル側 (`computeBoundGlucoseForMeal` & `bindMealGlucoseFromReadings` in `src/lib/anomalyExtractor.ts` / `src/lib/analysisCalculators.ts` / `src/components/records/MealRecordModal.tsx`)**:
    - 単一真実源（SSOT）関数 `computeBoundGlucoseForMeal(mealMs, candidateReadings)` により、保存時・CSV取込時・食品インパクト分析時の全箇所で同一の近傍探索ロジックを共通利用する：
    - **食前血糖値 (`pre_meal_glucose`)**: $[T - 15\text{分},\ T + 5\text{分}]$ の範囲内で、食事時刻 $T$ との時間差の絶対値が最小となる測定値を採用。
    - **食後ピーク血糖値 (`post_meal_glucose`)**: $[T + 60\text{分},\ T + 180\text{分}]$（食後1〜3時間）の範囲内における **最高血糖値（Max）** を採用。
  - **クラウド側 (Supabase / PostgreSQL)**:
    CSV一括インポート時などのサーバーサイド補完には、PostgreSQLの `LATERAL JOIN` を用いて食前（$-15\text{min} \sim +5\text{min}$ 最寄り値）および食後ピーク（$+60\text{min} \sim +180\text{min}$ 最高値）の高速バッチ更新を実行：
    ```sql
    UPDATE events e
    SET pre_meal_glucose = pre_q.glucose_value,
        post_meal_glucose = post_q.max_glucose
    FROM (
      SELECT DISTINCT ON (e2.id) e2.id, lr.glucose_value
      FROM events e2
      JOIN libre_readings lr ON lr.user_id = e2.user_id
        AND lr.timestamp BETWEEN (e2.event_datetime - INTERVAL '15 minutes')
                             AND (e2.event_datetime + INTERVAL '5 minutes')
      ORDER BY e2.id, ABS(EXTRACT(EPOCH FROM (lr.timestamp - e2.event_datetime)))
    ) AS pre_q
    LEFT JOIN LATERAL (
      SELECT MAX(lr2.glucose_value) AS max_glucose
      FROM libre_readings lr2
      WHERE lr2.user_id = e.user_id
        AND lr2.timestamp BETWEEN (e.event_datetime + INTERVAL '60 minutes')
                              AND (e.event_datetime + INTERVAL '180 minutes')
    ) AS post_q ON TRUE
    WHERE e.id = pre_q.id AND e.event_type = '食事';
    ```

---

## 4. セキュリティ・認証・ロール管理（家族共有）仕様

クラウド環境で患者の生体・健康データ（PHD）を安全に保護しつつ、家族による閲覧・見守りをセキュアに実現するための仕様です。

### 4.1 ユーザーロールと権限モデル
本システムでは、以下の3つのロールを定義します。初期フェーズでは「患者本人」と「家族（閲覧専用）」の2区分を最小構成としてサポートします。

| ロール | 想定ユーザー | 権限範囲 |
| :--- | :--- | :--- |
| **`patient`（患者本人）** | 糖尿病患者本人 | 自身の全データに対する完全なアクセス権（閲覧・登録・編集・削除・CSV取込・家族招待） |
| **`family_viewer`（家族・閲覧専用）** | 患者の家族・保護者・介護者 | 許可された患者のデータに対する **閲覧のみ**（カレンダー、日次詳細、分析画面の参照）。編集・削除・インポート・設定変更は不可 |
| **`family_editor`（家族・代理入力）** | 小児・高齢者患者の保護者等（将来拡張） | 許可された患者の食事記録や活動記録の代理登録・編集が可能 |

### 4.2 家族共有・権限管理モデル (`family_permissions`)
「ログインしたユーザー」と「表示・管理対象の患者」を分離し、かつ事前招待されたメールアドレスのみサインアップ・連携を許可するため、患者と家族を紐付ける中間テーブルを設けます（`supabase/migrations/0001_initial_schema.sql` と完全一致）。

```sql
-- 家族共有・権限管理テーブル (UUID直接指定 & メールアドレス招待の双方に対応)
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
```

### 4.3 Supabase RLS (Row Level Security) & 招待専用アクセスガード設計 (`supabase/migrations/0001_initial_schema.sql`)
データベース層で不正アクセスや未招待第三者のサインアップ・利用を完全に遮断するため、PostgreSQLの `SECURITY DEFINER SET search_path = public, auth` 関数、`auth.users` トリガー、およびRLSを活用します。

- **招待専用アクセス判定関数 (`public.is_authorized_system_user` & `public.verify_user_authorization`)**:
  - システムを操作・閲覧できるのは **①オーナー（最初に登録された患者本人、または既に全7業務テーブルのいずれかにレコードを有する患者本人）** と、**②そのオーナーが `family_permissions` テーブルに招待登録した家族（`family_user_id` または `LOWER(family_email)` が一致するユーザー）** のみに厳格制限する。
  - `auth.users` に対する `BEFORE INSERT` トリガー（`trg_enforce_invited_or_owner_signup`）により、既にオーナーが存在する状態で `family_permissions` に招待されていないメールアドレスがサインアップを試みた場合は PostgreSQL レベルで即座に拒否する。
  - クライアント側でもログイン・セッション復元時に `verifyUserAccessWithCloud`（`src/lib/syncEngine.ts`）を実行し、未招待の第三者アカウントであった場合は同期やローカルデータ移行を一切行わず即座に `signOut()` してローカルキャッシュを全消去する。

```sql
-- 1. 閲覧権限チェック用セキュリティ関数 (未招待第三者は FALSE)
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

-- 2. 編集・登録権限チェック用セキュリティ関数
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

-- テーブル別ポリシー適用例: libre_readings
ALTER TABLE libre_readings ENABLE ROW LEVEL SECURITY;

-- 閲覧: 本人および許可された家族
CREATE POLICY "libre_readings_select"
ON libre_readings FOR SELECT
USING (can_view_patient_data(user_id));

-- 登録/更新/削除: 本人（または代理入力者）のみ
CREATE POLICY "libre_readings_insert"
ON libre_readings FOR INSERT
WITH CHECK (can_edit_patient_data(user_id));

CREATE POLICY "libre_readings_delete"
ON libre_readings FOR DELETE
USING (can_edit_patient_data(user_id));
```

### 4.4 フロントエンドにおける「専用ログイン画面（Auth Gate）」と「患者コンテキスト（PatientContext）」設計 (`src/components/common/AuthGateScreen.tsx`, `src/contexts/PatientContext.tsx`, `src/App.tsx`)
1. **本番モードでの未ログイン時「専用ログイン画面（Auth Gate）」強制ロック**:
   - 本番環境（`VITE_APP_MODE=personal` かつ Supabase 設定有効時、すなわち `isAuthRequired === true`）では、未ログイン状態（`!authUser`）または権限検証未完了/不許可（`!isAccessAuthorized`）のとき、`src/App.tsx` がヘッダー・カレンダー・分析・設定・ボトムナビ等を一切レンダリングせず、フルスクリーンの専用ログイン画面 **`src/components/common/AuthGateScreen.tsx`** のみを表示して完全にブロックする（URLを知っている第三者がアクセスしてもアプリ画面を一切閲覧・操作できない）。
   - ※公開デモモード（`VITE_APP_MODE=portfolio`）およびローカル専用のE2Eテスト環境では従来通りログイン不要で動作する。
2. **強固なパスワード複雑性ポリシー（`validateStrongPassword`：`src/lib/supabase.ts`, `src/components/common/PasswordStrengthChecklist.tsx`）**:
   - 新規アカウント登録（オーナーおよび招待家族の初回登録）時には、**8文字以上かつ「英大文字 (`A-Z`)」「英小文字 (`a-z`)」「数字 (`0-9`)」「記号（英数字・空白以外のASCII記号文字）」の4種類すべてを含むこと** を必須要件とする。
   - 共通チェックリストコンポーネント `src/components/common/PasswordStrengthChecklist.tsx` により `AuthGateScreen.tsx` および `src/components/settings/CloudSyncFamilySection.tsx`（`SettingsView.tsx`）のUI上で5条件の達成状況をリアルタイム表示し、`PatientContext.tsx` の `signUpWithEmail`（および Supabase Auth 側の `Minimum password length: 8` / `Lowercase, uppercase letters, digits and symbols` 設定）により未達成パスワードでの登録を確実に遮断する。
3. **患者コンテキスト（`PatientContext`）による一元管理**:
   - コンポーネントが直接 `auth.user.id` を参照してデータを取得する設計を禁止し、**「現在選択中の患者ID（`currentPatientId`）」「その患者に対するロール（`userRole`）」「認証ゲート要件（`isAuthRequired` / `isAccessAuthorized`）」「臨床目標閾値（`hypoThreshold` / `hyperThreshold`）」を配信する Context**（`src/contexts/PatientContext.tsx`）で一元管理する。

### 4.5 Cloudflare Workers BFF (`POST /api/gemini`) による Gemini API キーの完全秘匿 & 認証・同一Origin検証 (`functions/api/gemini.ts`, `src/lib/gemini.ts`)
- Google Gemini API キーはクライアント（React）や `localStorage` には一切保持せず、**Cloudflare Pages Functions / Workers の Secrets（環境変数）** に保存。
- React（`src/lib/gemini.ts` の `estimateCarbsWithGemini` / `buildBffRequestHeaders`）からは、Supabase セッションが存在する場合は自動的に `Authorization: Bearer <access_token>` を付与し、`credentials: 'same-origin'` で同一オリジンの `POST /api/gemini` プロキシエンドポイントへリクエストを送信する。BFF未接続時やオフライン時は内蔵の「日本食品標準成分辞書（約80品目＋部分一致推論）」へ自動フォールバックする。
- Workers側（`functions/api/gemini.ts` の `verifyBffRequestAuth`）では、APIキー漏洩・外部タダ乗り・CSRFを防止するため以下の多層検証を強制する：
  1. **Cross-Origin / Cross-Site 即時遮断 (`HTTP 403 Forbidden`)**: `Sec-Fetch-Site: cross-site`、またはリクエスト先オリジンと一致しない `Origin` / `Referer` ヘッダーを持つリクエストを即座に拒否する。
  2. **Supabase JWT 検証 (`HTTP 401 Unauthorized`)**: `Authorization: Bearer <token>` が送信された場合、JWT 構造・`sub` クレーム・有効期限（`exp`）を検証し、さらに `SUPABASE_URL` および `SUPABASE_ANON_KEY` が環境変数に設定されている場合は Supabase Auth（`/auth/v1/user`）へ照会してトークンの正当性を検証する（不正・期限切れトークンは同一オリジンであっても 401 で拒否）。
  3. **本番モードでの認証または同一 Origin 必須化 (`HTTP 401 Unauthorized`)**: 本番モード（`APP_MODE !== 'portfolio'`）では、「有効な Supabase JWT」または「同一 Origin 検証（`Origin` / `Sec-Fetch-Site: same-origin` / `Referer`）」のいずれかを必須とし、どちらも満たさない外部直叩きリクエストを 401 で遮断する。

### 4.6 ローカル端末（IndexedDB & メモリキャッシュ）の保護とログアウト時完全消去 (`src/lib/syncEngine.ts`)
- 共有端末やスマホ・PCでの情報漏洩を防止するため、ユーザーが「ログアウト」を実行した際（または未招待アカウントが遮断された際）は、`purgeAllLocalPatientCaches`（`src/lib/syncEngine.ts`）により **IndexedDB 内の全7テーブル（`user_settings`, `categories`, `food_master`, `event_master`, `events`, `meal_details`, `libre_readings`）および全4種のメモリキャッシュ（カレンダー月次集計・分析集計・期間局所スライス・直近メモリキャッシュ）を即座に完全消去** してログイン画面（`AuthGateScreen`）へ戻す。

---

## 5. データベース物理スキーマ（Supabase PostgreSQL 本番完全版: `supabase/migrations/0001_initial_schema.sql`）

以下のDDLスクリプトは、マルチデバイスオフライン採番（UUID）、高速近傍探索（`event_datetime TIMESTAMPTZ`）、カテゴリ参照整合性、招待専用サインアップトリガー、および全テーブルのRow Level Security (RLS) を完備した本番直結スクリプト（[`supabase/migrations/0001_initial_schema.sql`](../../supabase/migrations/0001_initial_schema.sql) と100%同一のSSOT）です。SupabaseのSQLエディタでそのまま実行可能です。

```sql
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
```


---

## 5.5 クライアント側 IndexedDB (Dexie.js) 複合インデックス & 期間局所取得仕様 (`src/lib/db.ts`)

ブラウザ内の IndexedDB（`cgm_diabetes_manager_db` Version 2）では、全件スキャン（`.toArray()`）を完全に排除し、指定されたカレンダー月（42日グリッド）や分析期間（7日/14日/30日/90日/月別/全期間）のみを $O(\log N + K)$ でピンポイント取得するため、以下の複合インデックスを定義しています：

| テーブル名 | 主キー & 複合インデックス定義 (`src/lib/db.ts` Version 2) | 主な局所クエリ用途 |
| :--- | :--- | :--- |
| **`libre_readings`** | `id, [user_id+timestamp], timestamp, user_id` | カレンダー月間取得・分析期間スライス取得・食前/食後近傍探索（`.where('[user_id+timestamp]').between(...)`） |
| **`events`** | `id, [user_id+event_datetime], [user_id+event_type], user_id, event_datetime, event_type, is_deleted, updated_at` | 指定期間のイベント範囲取得（`.where('[user_id+event_datetime]').between(...)`）および異常値再判定時の種別抽出 |
| **`meal_details`** | `id, [user_id+event_id], event_id, user_id, is_deleted, updated_at` | 日次ドロワー・分析画面における対象食事イベントID群からの明細一括取得（`.where('event_id').anyOf(mealEventIds)`） |
| **`food_master`** | `id, [user_id+category_id], user_id, category_id, food_name, is_deleted, updated_at` | カテゴリ別食品一覧・カテゴリ削除時の未分類付け替え |
| **`event_master`** | `id, [user_id+category_id], user_id, category_id, event_name, is_deleted, updated_at` | カテゴリ別活動一覧・カテゴリ削除時の未分類付け替え |
| **`categories`** | `id, user_id, target_type, [user_id+target_type], is_deleted` | 食品カテゴリ（`food`）と活動カテゴリ（`event`）の区分別高速取得 |
| **`user_settings`** | `user_id, updated_at` | 患者ごとの低血糖/高血糖目標閾値・デフォルトインスリン設定のO(1)取得 |

---

## 6. 本番環境 (`personal`) とポートフォリオ環境 (`portfolio`) のデータ完全分離戦略

本システムでは、**個人本番環境（`VITE_APP_MODE=personal`）とポートフォリオ公開環境（`VITE_APP_MODE=portfolio`）でUIコンポーネント・臨床計算アルゴリズム・正規UUID採番（`src/lib/uuidUtils.ts`）を100%共通化しつつ、初期データ投入の振る舞いを厳格に分離しています。**

- **個人本番環境 (`VITE_APP_MODE=personal` / デフォルト) の完全クリーン起動 & 永続保存**:
  - 本番環境ではデモ用データファイル（`public/data/real_glucose_recent.json` / `public/data/real_glucose_readings.json`）のプリフェッチやハイドレーション、および既存ユーザーデータの削除を一切行いません。
  - `vite.config.ts` のビルドプラグインにより、`mode === 'personal'` ビルド時には `dist/data/real_glucose_*.json` を出力ディレクトリから完全除外します。
  - 初回起動時は `seedFoodMasterIfEmpty(patientId)`（`src/lib/foodSeed.ts`）のみを実行し、カレンダーは常に「今日（当月・当日）」を表示して患者本人および家族による実データ登録・FreeStyleリブレCSV取込を永続保存します。
- **ポートフォリオ環境 (`VITE_APP_MODE=portfolio`) における実測CGMデモデータの自動生成 (`src/lib/realGlucoseLoader.ts`)**:
  - ポートフォリオ公開環境では、FreeStyleリブレの実測血糖値データ（`public/data/real_glucose_readings.json`：79,479件、2024年9月〜2026年8月）および実測の低血糖・高血糖エピソードを使用します。
  - 実測CGMデータの2026年1月〜2026年8月に対し、各日の実測血糖波形の谷（食前血糖値 `pre_meal_glucose`）と食後ピーク（食後血糖値 `post_meal_glucose`）を解析して以下を自動紐づけします：
    1. **1日3食＋週末の間食（夜食）**: 毎日「朝食」「昼食」「夕食」の3食を記録し、週末（土曜・日曜）には午後の血糖変動や夜間の小ピークに合わせてランダムで「間食」（おやつ・夜食）を記録します。
    2. **糖質制限（基本100g以内）と高血糖スパイク時の規定超過（最大1.5倍程度）**: 1回の食事は糖質100g以内（40g〜92g）を基本としつつ、実測CGMデータで食後高血糖スパイクが観測された食事では105g〜145gのメニューを割り当て、血糖値の変動と食事内容が臨床的・視覚的に100%整合するようにします。
    3. **食べ合わせ（献立の自然さ）の徹底**: ごはん・パン・麺類などの主食重複を禁止し、自然な定食・洋食・麺セットを構成します。
    4. **糖質量に基づく理論的なインスリン単位数**: 超速効型インスリン量は食事の合計糖質量（`total_carbs`）と食前血糖値に基づき、糖質インスリン比（ICR: 約10g/U）＋補正インスリンから理論的に算出します。あわせて毎晩の持効型インスリン（10U）および運動イベントを決定論的UUID（`src/lib/uuidUtils.ts`）で記録します。
- **ポートフォリオモード (`VITE_APP_MODE=portfolio`) の完全オンメモリDB化・物理IndexedDB自動パージ・セキュリティ＆UIハードニング**:
  - ポートフォリオ公開環境では、複数の採用担当者・閲覧者が「食事記録」「よく使う食品の登録・編集・削除」「よく使う活動の登録・編集・削除」「カテゴリ管理」「目標閾値・デフォルトインスリンの設定変更」をすべてインタラクティブに試すことができます。
  - 同時に、閲覧者のスマートフォンやPCの端末ストレージを一切圧迫しないよう、デモモード（`isDemoMemoryOnlyMode()`）では `src/lib/db.ts` が全7テーブルの読み書きをオンメモリマップ（`InMemoryTable`）で処理し、物理 IndexedDB（`cgm_diabetes_manager_db`）には一切データを書き込みません。また、過去アクセス時に残存していた物理 IndexedDB も起動時・`pagehide` 時・手動リセット時に `indexedDB.deleteDatabase('cgm_diabetes_manager_db')` で自動消去し、Service Worker（`public/sw.js`）でも `/data/*.json` の Cache Storage 保存を行いません。
  - 閲覧者による追加・編集・削除はそのページの閲覧セッション中のみオンメモリ上で有効であり、ブラウザを再読み込み（リロード）するか、設定画面の「デモ環境のデータ管理」カードにある「デモデータを初期状態に戻す」ボタンを押すと、食品・活動・カテゴリ・記録・設定のすべてが初期シード状態へ100%クリーンにリセットされます。
  - さらに、デモアプリとしての完成度とセキュリティを担保するため、設定画面の未実装・通常バックアップ・クライアント側ロール切替セクションおよび食事記録・食品登録モーダル内の糖質自動推定ボタンを非表示とし、ECharts カスタムツールチップの動的文字列は `escapeHtml`（`src/lib/utils.ts`）でサニタイズし、Cloudflare Pages 配信ヘッダー（`public/_headers`）で標準セキュリティヘッダーを強制します。
- **Git デュアルリモート管理 & 2系統 CI/CD パイプライン (`scripts/orchestrate-pipeline.mjs`)**:
  - **本番開発リポジトリ (`origin`: Private)**:
    - `main` ブランチを拠点とし、`npm run pipeline:ship:personal`（`--target=personal`）により `VITE_APP_MODE=personal` でビルド・検証し、Private リポジトリ（`origin`）への Push および本番用 Cloudflare Pages（`cgm-diabetes-manager-personal`）へのデプロイを実行します。
  - **デモ公開リポジトリ (`public-demo`: Public)**:
    - 過去コミット履歴および `legacy_vba/` 資産を除外したクリーンな孤立ブランチ `demo-public` を用い、`npm run pipeline:ship:demo`（`--target=demo`）により `VITE_APP_MODE=portfolio` でビルド・検証し、Public リポジトリ（`public-demo` の `main` ブランチ）への Push およびデモ公開用 Cloudflare Pages（`cgm-diabetes-manager-demo`）へのデプロイを実行します。
    - 本番開発中に生まれた共通UI改善・デザイン修正・バグ修正は、`git cherry-pick <commit-sha>` により `main` から `demo-public` へ選択的に移植することで、本番専用の非公開コードを一切露出させずにデモアプリへ反映します。

---

## 7. Local-First 双方向クラウド同期エンジン & BFF 実装仕様 (`src/lib/supabase.ts`, `src/lib/syncEngine.ts`, `functions/api/gemini.ts`)

1. **Supabase クライアント初期化とクリーンなローカルフォールバック (`src/lib/supabase.ts`)**:
   - `isPortfolioMode() === false` かつ環境変数 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` が設定されている場合のみ `@supabase/supabase-js` クライアントを初期化します。
   - `portfolio` モード、環境変数未設定時、Vitest 単体テスト、および Playwright E2E テスト環境（`__CGM_E2E_FORCE_LOCAL_ONLY__` / `__CGM_E2E_ALLOW_CSV_IMPORT__`）では自動的にローカル専用モードへフォールバックし、オフライン単体動作およびE2E回帰テストの100%決定論的動作を保証します。
2. **双方向クラウド同期エンジン (`src/lib/syncEngine.ts`)**:
   - **7テーブル一括 Push & Pull と汎用LWW差分計算 (`computeLwwDiff`)**: `user_settings`, `categories`, `food_master`, `event_master`, `events`, `meal_details`, `libre_readings` の全7テーブルについて、ジェネリック純粋関数 `computeLwwDiff<T>` によりローカル（Dexie.js）とクラウド（Supabase PostgreSQL）の Last-Write-Wins (LWW) 差分を算出し、双方向同期を実行します。
   - **24文字ウォールクロックISO時刻正規化（課題 #7 対応）**: Supabase (`TIMESTAMPTZ`) から Pull した `timestamp` および `event_datetime`（`+00:00` オフセット等）は、`normalizeToWallClockIso` により必ず24文字の `"YYYY-MM-DDTHH:mm:ss.000Z"` 形式へ正規化してからローカルDBへ格納し、複合インデックス `.between()` 検索の整合性を100%保証します。
   - **1,000件単位のバッチチャンク処理 (`chunkArray`)**: `libre_readings` 等の大量レコードは 1,000件単位のチャンクに分割して `upsert` およびページネーション取得します。
   - **異常値エピソードのクラウド再計算整合性（課題 #6 対応）**: 目標血糖閾値の変更時やCSV取込時には `replaceRemoteAnomalies: true` を指定し、Supabase 側の古い自動抽出エピソード（`低血糖` / `高血糖`）をクリーンアップした上で最新の異常値エピソードへ置き換えます。
   - **未ログイン時ローカルデータの自動引き継ぎ (`migrateAnonymousLocalDataToUser`)**: 未ログイン状態（`DEFAULT_PATIENT_ID`）で記録されたローカルデータは、初回ログイン時に自動的に認証済み `auth.uid()` へマイグレーションされ、そのままクラウドへ同期されます。
   - **家族共有権限の自動解決 & Realtime 同期 (`resolveUserAccessFromPermissions`, `subscribeToPatientRealtime`)**: `family_permissions` テーブルを `family_user_id = auth.uid()` または `LOWER(family_email) = LOWER(user.email)` で照会し、招待元の `patient_id` とロール（`viewer` は閲覧専用ロック `isReadOnly = true`、`editor` は代理記録可能）を解決します。初回ログイン時に `family_user_id` が未設定の場合は自身の `auth.uid()` と `accepted_at` を自動紐づけし、Realtime 購読および同期完了時に全4種メモリキャッシュを即時破棄してUIを更新します。
3. **Cloudflare Pages Functions BFF (`functions/api/gemini.ts`)**:
   - `POST /api/gemini` エンドポイント（`onRequestPost`）を提供し、`verifyBffRequestAuth` による Cross-Origin 遮断（`403 Forbidden`）および本番モード時の Supabase JWT（`Authorization: Bearer <token>`）または同一 Origin 検証（`Origin` / `Sec-Fetch-Site: same-origin` / `Referer`）の必須化（未充足時は `401 Unauthorized`）を実行します。さらに `foodName`（1〜100文字）および `unit`（20文字以内）の厳格な入力長バリデーションを実行した上で、サーバーサイド環境変数 `GEMINI_API_KEY` が設定されている場合は Google Gemini REST API を呼び出して糖質量推定結果（`{ carbs_g, confidence, note }`）を返却します。`GEMINI_API_KEY` 未設定時は HTTP 503 を返し、クライアント（`src/lib/gemini.ts`）の内蔵日本食品標準成分表辞書（`estimateCarbsLocally`）へシームレスにフォールバックします。

