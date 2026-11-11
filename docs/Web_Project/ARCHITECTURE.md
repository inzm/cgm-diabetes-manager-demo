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
        Worker -->|パース結果一括書込| LocalDB
    end

    subgraph EdgeLayer ["2. エッジ・ホスティング層 (Cloudflare)"]
        CF_Pages["Cloudflare Pages\n(グローバル超高速静的配信)"]
        CF_Workers["Cloudflare Workers (BFF)\n(Gemini API 安全中継プロキシ)"]
    end

    subgraph CloudLayer ["3. クラウドデータベース & BaaS層 (Supabase)"]
        S_Auth["Supabase Auth\n(JWT認証 / 二要素認証)"]
        S_DB[("PostgreSQL\n(Single Source of Truth / RLS保護)")]
        S_Realtime["Supabase Realtime\n(別端末更新のWebSocket検知)"]
        S_Storage["Supabase Storage\n(リブレCSV原本ファイル保管)"]
    end

    subgraph ExternalService ["4. 外部AI基盤"]
        Gemini["Google Gemini REST API\n(糖質量自動推定 / 臨床助言)"]
    end

    CF_Pages -.->|アプリ配信| UI
    UI <-->|差分同期 (Delta Sync)| S_DB
    UI <-->|ユーザー認証| S_Auth
    S_Realtime -.->|更新通知| UI
    Worker -->|CSV原本アップロード| S_Storage
    UI -->|AI推定リクエスト| CF_Workers
    CF_Workers -->|APIキー秘匿通信| Gemini
```

---

## 2. Local-First & マルチデバイス同期設計仕様

本システムの中核は、**「Supabase（クラウド）をマスター保管庫 ＋ IndexedDB（ブラウザ）をローカル高速キャッシュ」** とする **Local-First（オフラインファースト）アーキテクチャ** です。

### 2.1 データ同期の基本原則
1. **Single Source of Truth (SSOT)**:
   - 真のデータ原本は常に **Supabase (PostgreSQL)** です。
   - IndexedDBは「端末側で瞬時に描画・集計するためのローカルキャッシュ」と位置付け、端末初期化やブラウザキャッシュ削除時でもSupabaseから完全に復元可能とします。
2. **ゼロレイテンシ描画**:
   - 画面遷移（カレンダー ⇄ 日次詳細 ⇄ 分析）時は、ネットワーク通信を一切待たず、ローカルのIndexedDBから **0.01秒未満でデータを即時取得・描画** します。
   - バックグラウンドでSupabaseと差分同期を行い、変更があればUIへ静かに反映します。

### 2.2 データ種別ごとの同期戦略

| データ種別 | 特性 | 同期方式 | コンフリクト解消ルール |
| :--- | :--- | :--- | :--- |
| **血糖値生データ (`libre_readings`)** | 追記専用 (Append-only) 約8.4万〜10万件 | 差分バルクインサート | `(user_id, timestamp)` のユニーク制約により重複時はスキップ（`ON CONFLICT DO NOTHING`）。競合は原理的に発生しない。 |
| **食事・活動記録 (`events`, `meal_details`)** | 追加・編集・削除 | 差分同期 (Delta Sync) | **論理削除 (`is_deleted = true`)** を徹底。`updated_at` が新しい方を優先採用する **Last-Write-Wins (LWW)**。 |
| **食品・活動マスタ (`food_master`, `event_master`)** | 追加・編集・削除 | 差分同期 (Delta Sync) | 論理削除 ＋ LWW。システム保護カテゴリ「未分類」はクライアント・DB双方で削除禁止。 |
| **臨床設定 (`user_settings`)** | 低血糖/高血糖閾値等 | 即時同期 | 1ユーザー1レコード。LWW。 |

### 2.3 初回ロード・リロード高速化：Memory-First 3段階段階的同期 (`src/lib/realGlucoseLoader.ts`)
初回アクセスやポートフォリオモードでのリロード時に、2年分（79,479件・2.14MB）の全データを一括ダウンロードして IndexedDB の B-Tree インデックスへ書き込むのを待ってから画面を描画すると、初期表示に10〜18秒を要してしまうため、以下の **「Memory-First 3段階段階的同期」** により初期表示を **0.3〜0.8秒以内** に完結させます。

1. **Stage 1：Memory-First 即時初期描画（0.3〜0.8秒・IndexedDB I/O 待ちゼロ）**:
   - `index.html` の `<link rel="preload" href="/data/real_glucose_recent.json" as="fetch" crossorigin="anonymous">` および `src/lib/realGlucoseLoader.ts` モジュール評価時の即時プリフェッチにより、JSバンドルのダウンロードと並行して直近42日分データ（`public/data/real_glucose_recent.json`：3,482件・約91KB / gzip 18KB）を取得。
   - 取得した直近タプルからメモリ上で測定データ・異常値エピソード・食事/活動記録・食事明細を生成（約15ms）し、オンメモリキャッシュ（`inMemoryRecentCache`）に格納して即座に `ensureRealGlucoseDataLoaded` を完了させる。
   - `src/components/calendar/CalendarView.tsx`（`getInMemoryRecentSlice`）および `src/components/daily/DailyDetailDrawer.tsx`（`getInMemoryRecentMealDetails`）は、IndexedDB の書き込みトランザクション完了を一切待たずにメモリから 0ms でデータを読み取って初期カレンダー（2026年8月）を描画する。
2. **Stage 2：直近データ＆初期食品データの非同期 IndexedDB 永続化（First Paint 完了後）**:
   - 初期カレンダーの DOM 描画が完了した直後（60ms 待機後）、裏側で `seedFoodMasterIfEmpty`（`src/lib/foodSeed.ts`）および直近データの IndexedDB 保存を実行する。
   - ポートフォリオモード（`VITE_APP_MODE=portfolio`）での2回目以降のリロード時は、すでに79,479件の `db.libre_readings` が IndexedDB に存在する場合、重い `libre_readings` の削除・再投入を完全にスキップし、`db.events`・`db.meal_details`・`db.user_settings` のみを高速リセットする。
   - 永続化完了と同時に `inMemoryRecentCache.persisted = true` へ切り替え、以降のユーザー操作（記録追加・編集・削除）はすべて IndexedDB（Dexie.js）の複合インデックス（`[user_id+timestamp]`, `[user_id+event_datetime]`, `[user_id+event_id]`）を参照する。
3. **Stage 3：過去7.6万件データのチャンク分割バックグラウンド同期**:
   - さらに 350ms 待機した後、全期間データ（`public/data/real_glucose_readings.json`：79,479件、2024年9月〜2026年8月）をバックグラウンド取得し、2026年7月15日以前の過去イベントと過去測定値（75,997件）をメインスレッドをブロックしないよう **6,000件ずつの小チャンク（チャンク間に40msの休止）** で新しい月順に段階投入する。なお、オフライン切断時はバックグラウンド取得をスキップし、ユーザーが設定画面で「記録データを初期化」または「バックアップから復元」を実行した場合は `cancelBackgroundHydration` により実行中のバックグラウンド投入を即時停止する。
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
- **課題**: 8.4万行のCSVパースと、CGM臨床標準ルール（正常復帰30分継続ルール、45分ギャップ判定、15分丸め）に基づくエピソード抽出処理をサーバー（Cloudflare Workers 10ms CPU制限）で同期実行するとタイムアウトする。
- **解決方針（ブラウザ側 Web Worker 分散実行）**:
  - CSVファイルをブラウザで選択後、メインスレッドから **Web Worker** にファイルバッファを渡す。
  - Web Worker 内で PapaParse（高速CSVパーサー）を用いてパースし、メモリ上で状態遷移マシン（ステートマシン）を実行して異常値エピソードを抽出。
  - 抽出結果（低血糖/高血糖イベント）と生データを IndexedDB へバルク保存した後、Supabaseへ非同期バックグラウンド送信（バッチチャンク: 2,000件ずつ）。
  - **結果**: サーバーコスト・CPU制限ゼロ、ユーザーを待たせずにプログレスバーを表示しながら数秒でインポート完了。

### 3.4 臨床閾値変更時の「全過去データ再判定（リバリュエーション）」
- **課題**: 設定画面で低血糖閾値（70→75）等を変更した際、3年分のデータから異常値イベントを全件再計算・再同期する必要がある。
- **解決方針**:
  - ローカルのIndexedDBに全期間の生データが存在するため、**Web Worker 内で全期間のステートマシンを再実行**（所要時間: 約1〜2秒）。
  - 手動登録イベント（食事・活動）を残し、自動抽出イベント（低血糖・高血糖）のみをIndexedDB上で差し替え。
  - Supabaseへは「旧異常値イベントの論理削除」と「新異常値イベントのバルク登録」を1トランザクションで送信。

### 3.5 食前・食後血糖値の近傍探索ロジック
- **課題**: 食事開始時刻の前後15分（食前）、および食事2時間後の前後15分（食後）の最寄りグルコース値を高速に探索・補完する。
- **解決方針**:
  - **ローカル側 (Dexie.js)**:
    IndexedDBの `timestamp` 複合インデックスを活用し、`db.libre_readings.where('timestamp').between(target - 15min, target + 15min)` で最大数件のみを取り出し、時間差の絶対値が最小のレコードをO(1)でバインド。
  - **クラウド側 (Supabase / PostgreSQL)**:
    CSV一括インポート時などのサーバーサイド補完には、PostgreSQLの `LATERAL JOIN` を用いて高速バッチ更新を実行：
    ```sql
    UPDATE events e
    SET pre_meal_glucose = closest.glucose
    FROM (
      SELECT DISTINCT ON (e2.id) e2.id, lr.glucose
      FROM events e2
      JOIN libre_readings lr ON lr.user_id = e2.user_id
        AND lr.timestamp BETWEEN (e2.event_datetime - INTERVAL '15 minutes') 
                             AND (e2.event_datetime + INTERVAL '15 minutes')
      ORDER BY e2.id, ABS(EXTRACT(EPOCH FROM (lr.timestamp - e2.event_datetime)))
    ) AS closest
    WHERE e.id = closest.id AND e.event_type = '食事';
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
「ログインしたユーザー」と「表示・管理対象の患者」を分離するため、患者と家族を紐付ける中間テーブルを設けます。

```sql
-- 家族共有・権限管理テーブル
CREATE TABLE family_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    family_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL DEFAULT 'viewer', -- 'viewer' (閲覧のみ) / 'editor' (代理入力)
    invited_at TIMESTAMPTZ DEFAULT NOW(),
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_patient_family UNIQUE (patient_id, family_user_id)
);
CREATE INDEX idx_family_lookup ON family_permissions (family_user_id, patient_id);
```

### 4.3 Supabase RLS (Row Level Security) ポリシー設計
データベース層で不正アクセスを完全に遮断するため、PostgreSQLの関数とRLSを活用します。

```sql
-- 1. 閲覧権限チェック用セキュリティ関数
CREATE OR REPLACE FUNCTION can_view_patient_data(target_patient_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN (
        auth.uid() = target_patient_id -- 本人
        OR EXISTS (
            SELECT 1 FROM family_permissions
            WHERE patient_id = target_patient_id
              AND family_user_id = auth.uid()
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. 編集・登録権限チェック用セキュリティ関数
CREATE OR REPLACE FUNCTION can_edit_patient_data(target_patient_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN (
        auth.uid() = target_patient_id -- 本人
        OR EXISTS (
            SELECT 1 FROM family_permissions
            WHERE patient_id = target_patient_id
              AND family_user_id = auth.uid()
              AND role = 'editor'
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- テーブル別ポリシー適用例: libre_readings
ALTER TABLE libre_readings ENABLE ROW LEVEL SECURITY;

-- 閲覧: 本人および許可された家族
CREATE POLICY "本人および家族は血糖データを参照可能"
ON libre_readings FOR SELECT
USING (can_view_patient_data(user_id));

-- 登録/更新/削除: 本人（または代理入力者）のみ
CREATE POLICY "登録・更新は本人またはeditorのみ"
ON libre_readings FOR INSERT
WITH CHECK (can_edit_patient_data(user_id));

CREATE POLICY "削除は本人またはeditorのみ"
ON libre_readings FOR DELETE
USING (can_edit_patient_data(user_id));
```

### 4.4 フロントエンドにおける「患者コンテキスト（PatientContext）」設計
フロントエンド（React）側で、コンポーネントが直接 `auth.user.id` を参照してデータを取得する設計を禁止します。
**「現在選択中の患者ID（`currentPatientId`）」と「その患者に対するロール（`currentRole`）」を配信する Context** を導入します。

```typescript
// PatientContext の型定義イメージ
interface PatientContextType {
  currentPatientId: string; // 閲覧・操作対象の患者ID
  currentRole: 'patient' | 'editor' | 'viewer'; // 操作権限
  isReadOnly: boolean;      // currentRole === 'viewer' の場合 true
  accessiblePatients: Array<{ patientId: string; patientName: string; role: string }>; // 家族が閲覧可能な患者リスト
  switchPatient: (patientId: string) => void;
}
```
- **メリット**:
  - 本人利用時（`currentPatientId = auth.uid`, `isReadOnly = false`）と、家族利用時（`currentPatientId = 対象患者ID`, `isReadOnly = true`）で、カレンダー・詳細・分析コンポーネントのロジックやIndexedDBキャッシュ空間を100%共通化できます。
  - `isReadOnly === true` の場合、共通のUIラッパーが「食事記録ボタン」「編集・削除ボタン」「CSV取込ボタン」を自動的に非表示または非活性（disabled）化します。

### 4.5 Cloudflare Workers による Gemini API キーの完全秘匿
- Google Gemini API キーはクライアント（React）には一切配布せず、**Cloudflare Workers の Secrets（環境変数）** に保存。
- Reactからは `POST /api/ai/estimate-carb` や `POST /api/ai/clinical-advice` へリクエストを送信。
- Workers側でリクエスト元のSupabase JWTトークンを検証した上でGemini APIを呼び出す（不正利用・なりすまし防止）。

### 4.6 ローカル端末（IndexedDB）の保護とログアウト制御
- 共有端末での利用を考慮し、ユーザーが「ログアウト」をクリックした際は、IndexedDB内の該当ユーザーの全データを確実に消去（`Dexie.delete()`）する。
- セッションタイムアウト時の自動画面ロック（PINコード入力による再開等）の拡張に対応可能な設計とする。

---

## 5. データベース物理スキーマ（Supabase PostgreSQL 本番完全版）

以下のDDLスクリプトは、マルチデバイスオフライン採番（UUID）、高速近傍探索（`event_datetime TIMESTAMPTZ`）、カテゴリ参照整合性、および全テーブルのRow Level Security (RLS) を完備した本番直結スクリプトです。SupabaseのSQLエディタでそのまま実行可能です。

```sql
-- ==============================================================================
-- 血糖値・食事・インスリン統合管理システム 本番用データベーススキーマ (完全版)
-- ==============================================================================

-- 拡張機能の有効化
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ------------------------------------------------------------------------------
-- 1. 家族共有・権限管理テーブル
-- ------------------------------------------------------------------------------
CREATE TABLE family_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    family_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'editor')),
    invited_at TIMESTAMPTZ DEFAULT NOW(),
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_patient_family UNIQUE (patient_id, family_user_id)
);
CREATE INDEX idx_family_lookup ON family_permissions (family_user_id, patient_id);

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
              AND family_user_id = auth.uid()
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
              AND family_user_id = auth.uid()
              AND role = 'editor'
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ------------------------------------------------------------------------------
-- 3. カテゴリマスタ
-- ------------------------------------------------------------------------------
CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    target_type VARCHAR(20) NOT NULL CHECK (target_type IN ('food', 'event')),
    category_name VARCHAR(50) NOT NULL,
    display_order INTEGER DEFAULT 0,
    is_protected BOOLEAN DEFAULT FALSE,
    is_deleted BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_user_type_cat UNIQUE (user_id, target_type, category_name)
);
CREATE INDEX idx_categories_user ON categories (user_id, target_type);

-- ------------------------------------------------------------------------------
-- 4. 食品マスタ
-- ------------------------------------------------------------------------------
CREATE TABLE food_master (
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
CREATE INDEX idx_food_master_user ON food_master (user_id, is_deleted);

-- ------------------------------------------------------------------------------
-- 5. 活動マスタ
-- ------------------------------------------------------------------------------
CREATE TABLE event_master (
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
CREATE INDEX idx_event_master_user ON event_master (user_id, is_deleted);

-- ------------------------------------------------------------------------------
-- 6. リブレ生データ (8.4万〜10万行/人)
-- ------------------------------------------------------------------------------
CREATE TABLE libre_readings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    timestamp TIMESTAMPTZ NOT NULL,
    glucose_value NUMERIC(5,1) NOT NULL,
    scan_type VARCHAR(20) DEFAULT 'Historic',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_user_libre_time UNIQUE (user_id, timestamp)
);
CREATE INDEX idx_libre_user_time ON libre_readings (user_id, timestamp DESC);

-- ------------------------------------------------------------------------------
-- 7. イベント記録 (親テーブル) ★UUID化 & 統合日時
-- ------------------------------------------------------------------------------
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    event_datetime TIMESTAMPTZ NOT NULL, -- 統合日時 (タイムゾーン対応・高速探索)
    event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('食事', '活動', '低血糖', '高血糖')),
    timing_category VARCHAR(20),        -- 朝食/昼食/夕食/間食/就寝前等
    total_carbs NUMERIC(6,1),          -- 糖質合計 (g)
    insulin_units NUMERIC(5,1),        -- インスリン量 (単位)
    pre_meal_glucose NUMERIC(5,1),     -- 食前血糖値 (mg/dL)
    post_meal_glucose NUMERIC(5,1),    -- 食後血糖値 (mg/dL)
    duration_minutes INTEGER,          -- 実施時間/継続時間 (分)
    memo TEXT,                         -- メモ/異常値詳細
    is_deleted BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_events_user_time ON events (user_id, event_datetime DESC);
CREATE INDEX idx_events_sync ON events (user_id, updated_at);

-- ------------------------------------------------------------------------------
-- 8. 食事明細 (子テーブル)
-- ------------------------------------------------------------------------------
CREATE TABLE meal_details (
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
CREATE INDEX idx_meal_details_event ON meal_details (event_id);

-- ------------------------------------------------------------------------------
-- 9. ユーザー設定
-- ------------------------------------------------------------------------------
CREATE TABLE user_settings (
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

-- RLSの有効化
ALTER TABLE family_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE libre_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

-- 家族権限テーブル: 本人のみ招待・管理可能
CREATE POLICY "family_permissions_select" ON family_permissions FOR SELECT USING (auth.uid() = patient_id OR auth.uid() = family_user_id);
CREATE POLICY "family_permissions_all" ON family_permissions FOR ALL USING (auth.uid() = patient_id);

-- 各業務テーブル: 閲覧（本人+家族）、編集（本人+代理入力）
DO $$
DECLARE
    tbl text;
    tables text[] := ARRAY['categories', 'food_master', 'event_master', 'libre_readings', 'events', 'meal_details', 'user_settings'];
BEGIN
    FOREACH tbl IN ARRAY tables LOOP
        EXECUTE format('CREATE POLICY "%s_select" ON %I FOR SELECT USING (can_view_patient_data(user_id));', tbl, tbl);
        EXECUTE format('CREATE POLICY "%s_insert" ON %I FOR INSERT WITH CHECK (can_edit_patient_data(user_id));', tbl, tbl);
        EXECUTE format('CREATE POLICY "%s_update" ON %I FOR UPDATE USING (can_edit_patient_data(user_id)) WITH CHECK (can_edit_patient_data(user_id));', tbl, tbl);
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

## 6. 本番・ポートフォリオ共通のリアル血糖値データ基盤 & 環境分離戦略

本システムでは、合成された架空のデモデータ（サイン波血糖値など）を一切使用せず、**個人本番環境（`VITE_APP_MODE=personal`）とポートフォリオ公開環境（`VITE_APP_MODE=portfolio`）の双方において、FreeStyleリブレの実測血糖値データ（`public/data/real_glucose_readings.json`：79,479件、2024年9月〜2026年8月）およびそこからステートマシン抽出した実測の低血糖・高血糖エピソードを使用します。**

- **実測血糖値曲線に連動したリアルな食事・インスリン・活動データの生成 (`src/lib/realGlucoseLoader.ts`)**:
  - 実測CGMデータの直近期間（2026年6月〜2026年8月）に対し、各日の実測血糖波形の谷（食前血糖値 `pre_meal_glucose`）と食後60〜180分のピーク（食後血糖値 `post_meal_glucose`）を解析して以下を自動紐づけします：
    1. **1日3食＋週末の間食（夜食）**: 毎日「朝食」「昼食」「夕食」の3食を記録し、週末（土曜・日曜）には午後の血糖変動や夜間の小ピークに合わせてランダムで「間食」（おやつ・夜食）を記録します。
    2. **糖質制限（基本100g以内）と高血糖スパイク時の規定超過（最大1.5倍程度）**: 1回の食事は糖質100g以内（40g〜92g）を基本としつつ、実測CGMデータで食後高血糖スパイク（ピーク ≥ 195 mg/dL または上昇幅 Δ ≥ 85 mg/dL）が観測された食事では、ランダムに規定量の1.1〜1.5倍程度（105g〜145g）のメニューを割り当て、血糖値の変動と食事内容が臨床的・視覚的に100%整合するようにします。
    3. **食べ合わせ（献立の自然さ）の徹底**: ごはん・パン・麺類などの主食重複を禁止し、「パンとみそ汁」「パスタと納豆」などの不自然な食べ合わせを排除した自然な定食・洋食・麺セットを構成します。
    4. **糖質量に基づく理論的なインスリン単位数**: 超速効型インスリン量は食事の合計糖質量（`total_carbs`）と食前血糖値に基づき、糖質インスリン比（ICR: 約10g/U）＋補正インスリンから理論的に算出します。あわせて毎晩の持効型インスリン（10U）および運動イベントを記録します。
- **ポートフォリオモード (`VITE_APP_MODE=portfolio`) の完全オンメモリDB化・物理IndexedDB自動パージ・セキュリティ＆UIハードニング**:
  - ポートフォリオ公開環境では、複数の採用担当者・閲覧者が「食事記録」「よく使う食品の登録・編集・削除」「よく使う活動の登録・編集・削除」「カテゴリ管理」「目標閾値・デフォルトインスリンの設定変更」をすべてインタラクティブに試すことができます。
  - 同時に、閲覧者のスマートフォンやPCの端末ストレージを一切圧迫しないよう、デモモード（`isDemoMemoryOnlyMode()`）では `src/lib/db.ts` が全7テーブルの読み書きをオンメモリマップ（`InMemoryTable`）で処理し、物理 IndexedDB（`cgm_diabetes_manager_db`）には一切データを書き込みません。また、過去アクセス時に残存していた物理 IndexedDB も起動時・`pagehide` 時・手動リセット時に `indexedDB.deleteDatabase('cgm_diabetes_manager_db')` で自動消去し、Service Worker（`public/sw.js`）でも `/data/*.json` の Cache Storage 保存を行いません。
  - 閲覧者による追加・編集・削除はそのページの閲覧セッション中のみオンメモリ上で有効であり、ブラウザを再読み込み（リロード）するか、設定画面の「デモ環境のデータ管理」カードにある「デモデータを初期状態に戻す」ボタンを押すと、食品・活動・カテゴリ・記録・設定のすべてが初期シード状態へ100%クリーンにリセットされます。
  - さらに、デモアプリとしての完成度とセキュリティを担保するため、設定画面の未実装・通常バックアップ・クライアント側ロール切替セクションおよび食事記録・食品登録モーダル内の糖質自動推定ボタンを非表示とし、ECharts カスタムツールチップの動的文字列は `escapeHtml`（`src/lib/utils.ts`）でサニタイズし、Cloudflare Pages 配信ヘッダー（`public/_headers`）で標準セキュリティヘッダーを強制します。
- **個人本番環境 (`VITE_APP_MODE=personal` / デフォルト) の永続保存**:
  - 同一のUIコンポーネント・臨床計算アルゴリズム・実測血糖値データを100%共有しつつ、個人本番環境ではクライアント端末の IndexedDB（および将来接続時の Supabase）へ永続保存されます。
- **Git デュアルリモート管理 & 2系統 CI/CD パイプライン (`scripts/orchestrate-pipeline.mjs`)**:
  - **本番開発リポジトリ (`origin`: Private)**:
    - `main` ブランチを拠点とし、`npm run pipeline:ship:personal`（`--target=personal`）により `VITE_APP_MODE=personal` でビルド・検証し、Private リポジトリ（`origin`）への Push および本番用 Cloudflare Pages（`cgm-diabetes-manager-personal`）へのデプロイを実行します。
  - **デモ公開リポジトリ (`public-demo`: Public)**:
    - 過去コミット履歴および `legacy_vba/` 資産を除外したクリーンな孤立ブランチ `demo-public` を用い、`npm run pipeline:ship:demo`（`--target=demo`）により `VITE_APP_MODE=portfolio` でビルド・検証し、Public リポジトリ（`public-demo` の `main` ブランチ）への Push およびデモ公開用 Cloudflare Pages（`cgm-diabetes-manager-demo`）へのデプロイを実行します。
    - 本番開発中に生まれた共通UI改善・デザイン修正・バグ修正は、`git cherry-pick <commit-sha>` により `main` から `demo-public` へ選択的に移植することで、本番専用の非公開コードを一切露出させずにデモアプリへ反映します。
