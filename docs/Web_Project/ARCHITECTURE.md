# Web版 システム全体アーキテクチャ & 詳細技術仕様書 (ARCHITECTURE.md)

本ドキュメントは、Excel VBAシステム（`main.xlsm`）から刷新されるWebアプリケーションのシステム全体設計、Local-First同期アーキテクチャ、高難度機能の代替実装方針、およびセキュリティ仕様を定義した基本設計書です。

---

## 文書メタ情報

- 役割: システム全体構成・同期方式・セキュリティ・DB物理スキーマの設計書 (SSOT)。
- 優先: コードと食い違う場合は本書を正とする。
- 読み方: 下の節索引から該当節だけ読む。物理DDL全文の単一真実源は連番マイグレーション `supabase/migrations/*.sql` と宣言的スナップショット `supabase/schema_snapshot.json` にある。

| 節 | 内容 | 読む場面 |
| :--- | :--- | :--- |
| 1 | 全体構成図(クライアント / Cloudflare / Supabase / Gemini) | 構成要素の関係を知りたいとき |
| 2.1〜2.2 | Local-First の原則、データ種別ごとの同期方式と競合解消 | 同期仕様の変更 |
| 2.3 | 本番モードとデモモードの起動データ、Memory-First 3段階展開 | デモ初期表示・データ投入の変更 |
| 2.4 | ブラウザによるIndexedDB自動削除(Eviction)対策 | 永続化の変更 |
| 3.1〜3.5 | 高難度機能の設計(散布図、42日表示、CSV取込、再判定、食前・食後血糖の探索) | 該当機能の変更 |
| 4 | ロール、家族共有、RLS、Auth Gate、BFF、ログアウト時の消去 | 認証・権限・秘密情報の変更 |
| 5 | Supabase 物理スキーマ一覧・連番マイグレーション構成・RLS要約 | テーブル・RLSの変更 |
| 5.1 | Dexie.js のテーブル定義と複合インデックス | ローカルDBのクエリ追加 |
| 6 | 本番(`personal`)とデモ(`portfolio`)の分離、2系統デプロイ | モード差・デプロイの変更 |
| 7 | 同期エンジンとBFFの実装仕様 | `syncEngine.ts` / `functions/api/gemini.ts` の変更 |

---

## 1. システム全体アーキテクチャ

本システムは、「React (Local-First) ＋ Cloudflare ＋ Supabase」 を中核アーキテクチャとして採用します。

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

本システムの中核は、「Supabase（クラウド）をマスター保管庫 ＋ IndexedDB（ブラウザ）をローカル高速キャッシュ」 とする Local-First（オフラインファースト）アーキテクチャ です。

### 2.1 データ同期の基本原則
> 【実装フェーズ注記】: 現在のクライアント実装は、ブラウザ内 `IndexedDB (Dexie.js)`（`src/lib/db.ts`）、JSON バックアップ出力・正規UUIDマイグレーション復元サービス（`src/lib/backupRestore.ts` / `src/components/settings/DataBackupSection.tsx`）、および Supabase 双方向同期エンジン（`src/lib/syncEngine.ts`）による Local-First 基盤で動作しており、全7テーブルの主キー・外部キーは決定論的UUID（`src/lib/uuidUtils.ts`）で正規化済みです。

1. Single Source of Truth (SSOT):
   - クラウド接続後の真のデータ原本は Supabase (PostgreSQL) であり、ローカル単体運用時は IndexedDB (Dexie.js) ＋ JSON バックアップ が原本となります。
   - IndexedDBは「端末側で瞬時に描画・集計するためのローカル高速データベース」と位置付け、端末初期化やブラウザキャッシュ削除時でもJSONバックアップまたはSupabaseから復元可能とします。
2. ゼロレイテンシ描画:
   - 画面遷移（カレンダー ⇄ 日次詳細 ⇄ 分析）時は、ネットワーク通信を一切待たず、ローカルのIndexedDBから 0.01秒未満でデータを即時取得・描画 します。
   - クラウド接続時はバックグラウンドでSupabaseと差分同期を行い、変更があればUIへ静かに反映します。
3. 同期のきっかけ（`src/lib/syncEngine.ts` の `syncPatientDataWithCloud`。同一患者への同時実行は直列化）:
   - 記録の保存・削除、食品・活動・カテゴリの編集、設定変更、CSV取込の直後（`triggerBackgroundCloudSync`）。オフライン時は失敗し、再試行はしない。
   - アプリ起動・再読み込み・ログイン（`src/contexts/PatientContext.tsx` の `getSession` / `SIGNED_IN`）。
   - 他端末によるクラウド更新の Realtime 通知（600ms デバウンス）。オフライン中に届かなかった通知は再送されない。
   - 設定画面の「今すぐ同期」（`syncNow`）。
   - オンライン復帰時（`online` イベント）と、オンライン状態で画面が再表示されたとき（`visibilitychange` で `visible`）（詳細は [SPEC_PWA.md](SPEC_PWA.md) 4.3）。
   - 同期は毎回全レコードを比較し直す方式（送信待ちキューを持たない）のため、オフライン中に保存した変更は、次にいずれかのきっかけが発生した時点でまとめて送受信される。
4. 別端末での同じ食事区分の重複:
   - 新規登録の記録には端末ごとに別の UUID が付くため、LWW は同じ記録を両端末で編集した場合にしか働かない。別端末で同じ日・同じ食事区分（朝食・昼食・夕食）を新規登録すると、同期後に2件並ぶ。
   - 自動では削除・統合しない。カレンダーの日付マスの色と日次詳細で重複を知らせ、利用者の操作で1つにまとめる（[SPEC_MEAL_RECORD.md](SPEC_MEAL_RECORD.md) 3.7）。

### 2.2 データ種別ごとの同期戦略

| データ種別 | 特性 | 同期方式 | コンフリクト解消ルール |
| :--- | :--- | :--- | :--- |
| 血糖値生データ (`libre_readings`) | 追記専用 (Append-only) 約8.4万〜10万件 | 差分バルクインサート | `(user_id, timestamp)` のユニーク制約により重複時はスキップ（`ON CONFLICT DO NOTHING`）。競合は原理的に発生しない。 |
| 食事・活動記録 (`events`, `meal_details`) | 追加・編集・削除 | 差分同期 (Delta Sync) | 論理削除 (`is_deleted = true`) を徹底。`updated_at` が新しい方を優先採用する Last-Write-Wins (LWW)。 |
| 食品・活動マスタ (`food_master`, `event_master`) | 追加・編集・削除 | 差分同期 (Delta Sync) | 論理削除 ＋ LWW。システム保護カテゴリ「未分類」はクライアント・DB双方で削除禁止。 |
| 臨床設定 (`user_settings`) | 低血糖/高血糖閾値等 | 即時同期 | 1ユーザー1レコード。LWW。 |

### 2.3 環境別起動データ戦略 & ポートフォリオ用 Memory-First 3段階段階的オンメモリ展開 (`src/lib/realGlucoseLoader.ts`, `src/lib/demoMealGenerator.ts`)
- 本番モード (`VITE_APP_MODE=personal`) におけるクリーン起動・データ保護:
  - 本番モードでは `public/data/real_glucose_recent.json` および `public/data/real_glucose_readings.json` のプリフェッチ・ハイドレーションや既存ユーザーデータの削除を一切行いません（ビルド時にも `vite.config.ts` の `configResolved` 動的 `outDir` 解決プラグインにより `dist-personal/data/real_glucose_*.json` を出力から完全除外）。
  - 初回起動時は `seedFoodMasterIfEmpty(patientId)`（`src/lib/foodSeed.ts`）のみを実行してよく使う食品・活動・カテゴリの初期プリセット（決定論的UUID：`src/lib/uuidUtils.ts`）を投入し、血糖・食事・活動記録は0件のクリーンな状態からユーザー本人の手動記録およびFreeStyleリブレCSV取込を開始します。
- ポートフォリオモード (`VITE_APP_MODE=portfolio`) における Memory-First 3段階段階的同期:
  - デモ公開環境での初回アクセスやリロード時に、2年分（79,479件・2.14MB）の全データを一括ダウンロードして全件をインデックス付きデータストアへ書き込むのを待ってから画面を描画すると初期表示に10〜18秒を要してしまうため、献立・イベント生成ドメインロジックを `src/lib/demoMealGenerator.ts` に分離した上で、以下の 「Memory-First 3段階段階的同期」 により初期表示を 0.3〜0.8秒以内 に完結させます。

1. Stage 1：Memory-First 即時初期描画（0.3〜0.8秒・IndexedDB I/O 待ちゼロ・`portfolio` モード専用）:
   - `vite.config.ts` が `portfolio` ビルド時のみ注入する `<link rel="preload" href="/data/real_glucose_recent.json" as="fetch" crossorigin="anonymous">` および `src/lib/realGlucoseLoader.ts` モジュール評価時のプリフェッチ（`isPortfolioMode()` 時のみ実行）により、JSバンドルのダウンロードと並行して直近42日分データ（`public/data/real_glucose_recent.json`：3,482件・約91KB / gzip 18KB）を取得。
   - 取得した直近タプルからメモリ上で測定データ・異常値エピソード・食事/活動記録・食事明細を正規UUID（`deterministicUuid`：`src/lib/uuidUtils.ts`）で生成（約15ms）し、オンメモリキャッシュ（`inMemoryRecentCache`）に格納して即座に `ensureRealGlucoseDataLoaded` を完了させる。
   - `src/components/calendar/CalendarView.tsx`（`getInMemoryRecentSlice`）および `src/components/daily/DailyDetailDrawer.tsx`（`getInMemoryRecentMealDetails`）は、書き込み完了を待たずにメモリから 0ms でデータを読み取って初期カレンダー（2026年8月）を描画する。
2. Stage 2：直近データ＆初期食品データのデータストア書込（First Paint 完了後）:
   - 【重要・端末ストレージ非使用】 ポートフォリオモードでは `isDemoMemoryOnlyMode()`（`src/lib/db.ts`）が `true` となり、以下の Stage 2・Stage 3 で呼ぶ `db.*` の読み書きはすべて RAM 上の `InMemoryTable` に対して行われます。閲覧者の端末の物理 IndexedDB（`cgm_diabetes_manager_db`）・`localStorage`・Cache Storage には一切書き込まず、過去の残存分も起動時・`pagehide` 時・手動リセット時に `purgeDemoPhysicalIndexedDB` で削除します。以下で言う「永続化」「投入」は、ページ表示中のオンメモリDBへの格納を指し、リロードで消えます（物理 IndexedDB を使うのは `personal` モードのみであり、クライアント本番コード内にテスト用ウィンドウフラグは一切置きません）。
   - 初期カレンダーの DOM 描画が完了した直後（60ms 待機後）、裏側で `seedFoodMasterIfEmpty`（`src/lib/foodSeed.ts`）および直近データの保存を実行する。
   - 永続化完了と同時に `inMemoryRecentCache.persisted = true` へ切り替え、以降のユーザー操作（記録追加・編集・削除）はすべて `src/lib/db.ts` の複合インデックス（`[user_id+timestamp]`, `[user_id+event_datetime]`, `[user_id+event_id]`）を参照する。
3. Stage 3：過去7.6万件データのチャンク分割バックグラウンド展開（オンメモリDBへ）:
   - Stage 2 完了後さらに 1,800ms 待機した後（オフライン時は実行しない）、全期間データ（`public/data/real_glucose_readings.json`：79,479件、2024年9月〜2026年8月）をバックグラウンド取得し、2026年7月15日より前の過去イベント（1,500件ずつ）・食事明細（2,000件ずつ、いずれもチャンク間30ms休止）と過去測定値（75,997件）をメインスレッドをブロックしないよう段階投入する。測定値は 6,000件ずつの小チャンク（チャンク間に40msの休止） で新しい月順に投入する。なお直近データ取得失敗時は全件ファイルを直接取得し 2026-07-15 以降のみを Stage 1 に使うフォールバックがある。
   - ユーザーが設定画面で「記録データを初期化」または「バックアップから復元」を実行した場合は、`cancelBackgroundHydration` および `markPatientManuallyCleared` により実行中のバックグラウンド投入を即時停止し、同一セッション内でカレンダーや分析画面へ遷移してもデモデータが勝手に再ハイドレーションされないよう保護する（`resetDemoDataToInitialState` 実行時のみ解除）。
   - 全件投入完了時に `cgm-background-hydration-complete` カスタムイベントを発火し、カレンダーの過去月キャッシュや分析画面（`src/components/analysis/AnalysisView.tsx`）の最古記録日・月別選択肢を自動更新する。

### 2.4 ブラウザによる勝手なデータ消去への対策 (Eviction防止)
- 問題: iOS Safari等のブラウザは、ストレージ逼迫時や7日間アクセスがない場合にIndexedDBを自動削除（Eviction）する制限がある。
- 対策:
  - アプリ初回起動時に Persistent Storage API をリクエストする：
    ```typescript
    if (navigator.storage && navigator.storage.persist) {
      const isPersisted = await navigator.storage.persist();
      console.log(`Persistent storage granted: ${isPersisted}`);
    }
    ```
  - 万が一IndexedDBがクリアされた場合でも、ログイン時にSupabaseから自動再同期するリカバリ処理を常設。
  - 上記の自動再同期はログイン済み（クラウド接続）の場合に限る。クラウド未接続の運用では、復旧手段は手動のJSONバックアップのみである。

---

## 3. 実現難易度が高い機能のWeb移行・代替設計仕様

Excel固有の仕様や大量データ処理など、Web化において技術的ハードルが高い機能の解決設計です。

### 3.1 24時間血糖値散布図 ＋ 垂直ドロップライン・異常マーカーの重畳描画
- 課題: Excelの `ErrorBars`（+250 mg/dLの垂直破線）やカスタム図形マーカーをWeb上でスマホ対応も含めて再現する必要がある。
- 解決方針 (Apache ECharts の採用 & `src/lib/echartsCore.ts` によるツリーシェイク):
  - ECharts部分インポート & 遅延ロード: `src/lib/echartsCore.ts` で `echarts/core` と `echarts-for-react/lib/core` を用い、必要なチャート（`LineChart`, `BarChart`, `ScatterChart`）・コンポーネント（`GridComponent`, `TooltipComponent`, `LegendComponent`, `MarkLineComponent`, `MarkAreaComponent`）・レンダラー（`CanvasRenderer`, `SVGRenderer`）のみを登録。さらに初期画面（カレンダー）に不要なドロワーや分析画面・モーダル群を `React.lazy()` でチャンク分割し、初回ロード時間を最小化する。
  - 主系列（血糖曲線）: `type: 'line'`, `smooth: true`, 00:00〜24:00の15分間隔実測値を描画。
  - 目標範囲帯: `markLine` または `markArea` を用いて、70 mg/dL（赤点線）〜 180 mg/dL（橙点線）の背景ガイド帯をレイヤー描画。
  - 食事マーカー: 食事発生時刻のX座標に対して `markLine`（垂直ドット線）を引き、上部または下部にカスタムSVGアイコン（🍽️）と糖質/インスリンラベルを配置。
  - 異常値マーカー: 低血糖（▼）・高血糖（▲）の発生箇所に `markPoint` をプロットし、最低値・ピーク値をバッジ表示。
  - レスポンシブ衝突回避: EChartsの `avoidLabelOverlap: true` を有効化し、狭い画面でもラベルが重ならないよう自動オフセット。

### 3.2 カレンダー画面の「42日分スパークライン」軽量化代替
- 課題: 42日（6週×7日）分のセル内に独立した折れ線グラフを愚直にレンダリングすると、仮想DOMとCanvas生成の負荷で月送り時にカクつき（Jank）が発生する。
- 解決方針（マイクロSVGまたは代替表現への刷新）:
  - アプローチA (マイクロSVG / 採用済み: `src/components/calendar/Sparkline.tsx`):
    重いチャートコンポーネントを置くのではなく、事前集計された日次配列（時間別平均の24点、欠損はnull）から 軽量な単一 `<svg><path d="..." /></svg>` のパス文字列を文字列演算で生成。1日あたり数KB、DOM負荷ゼロで42日分を一瞬で描画。
  - アプローチB (UI洗練・臨床視認性重視の代替 / 不採用):
    スパークラインの代わりに、以下のいずれか（またはユーザー選択式）に仕様変更：
    1. TIRミニプログレスバー: 目標範囲内（緑）、低血糖（青）、高血糖（赤）の比率を示すスタックバー。
    2. 最高/最低レンジバー: 当日の血糖レンジ（Min〜Max）を棒グラフで表示。

### 3.3 大容量CSV（8.4万行）パース ＆ 異常値自動抽出（ステートマシン）
- 課題: 8.4万行のCSVパースと、CGM臨床標準ルール（正常復帰28分継続ルール、45分ギャップ判定）に基づくエピソード抽出処理をサーバー（Cloudflare Workers 10ms CPU制限）で同期実行するとタイムアウトする。
- 解決方針（ブラウザ側 Web Worker 分散実行 & 決定論的UUID採番）:
  - CSVファイルをブラウザで選択後、メインスレッド（`src/components/import/CsvImportModal.tsx`）から Web Worker（`src/workers/csvParser.worker.ts`）にファイルテキストを渡す。
  - Web Worker 内の 独自高速ストリーム行分割CSVパーサー（外部ライブラリ非依存・FreeStyleリブレLink日英ヘッダー自動検出）を用いてパースし、`src/lib/uuidUtils.ts` の `deterministicUuid(`${patientId}_${isoTime}`)` により冪等な正規UUIDを採番。
  - 続けて共通ステートマシン（`src/lib/anomalyExtractor.ts`）を実行して異常値エピソード（`deterministicUuid(`${patientId}_anomaly_${event_type}_${start}`)`）を抽出。
  - 抽出結果（低血糖/高血糖イベント）と生データを IndexedDB へバルク保存し、登録済みの食事記録に対して食前・食後ピーク血糖値を自動バインド（`bindMealGlucoseFromReadings`）した後、Supabase接続時は非同期バックグラウンド送信（バッチチャンク: 1,000件ずつ）を行う。
  - 結果: サーバー側のCPU制限を受けない。プログレスバーを表示しながら数秒でインポートが完了する。

### 3.4 臨床閾値変更時の「全過去データ再判定（リバリュエーション）」
- 課題: 設定画面で低血糖閾値（70→75）等を変更した際、全期間のデータから異常値イベントを全件再計算・再同期する必要がある。
- 解決方針:
  - ローカルのIndexedDBに全期間の生データが存在するため、`src/lib/anomalyExtractor.ts` の `reevaluatePatientAnomalyEvents` により全期間のステートマシンを再実行。
  - 手動登録イベント（食事・活動）を残し、自動抽出イベント（低血糖・高血糖）のみを正規UUID（`deterministicUuid`）で差し替え。
  - Supabase（`src/lib/syncEngine.ts` の `replaceRemoteAnomalies: true` 同期時）へは、新しい異常値イベントを先にチャンク単位で `upsert`（`upsertRowsInChunks`）し、登録がすべて成功した後でのみ新しい集合に含まれない旧自動抽出イベント（低血糖・高血糖）の ID 群をチャンク削除（`deleteRowsByIdsInChunks`）する（登録→削除の順）。UUIDは決定論的なので `upsert` は冪等であり、途中で通信エラー等により失敗しても旧データは失われずに残り、再実行で確実に最新集合へ収束する。

### 3.5 食前・食後ピーク血糖値の近傍探索 ＆ 後続記録干渉打ち切りロジック (`src/lib/anomalyExtractor.ts`)
- 課題: 食事開始時刻 $T$ に対する食前血糖値、および食後ピーク血糖値を実測CGMデータから高速かつ正確に探索・補完し、食後3時間以内に次の食事や追加インスリンがある場合の混入を防ぐ。
- 解決方針:
  - ローカル側 (`computeBoundGlucoseForMeal` / `isPostMealInterferingEvent` / `bindMealGlucoseFromReadings` in `src/lib/anomalyExtractor.ts` / `src/lib/analysisCalculators.ts` / `src/components/records/MealRecordModal.tsx`):
    - 単一真実源（SSOT）関数 `computeBoundGlucoseForMeal` により、保存時・削除時・CSV取込時・日次詳細表示時・食品インパクト分析時の全箇所で同一の近傍探索および後続干渉判定ロジックを共通利用する：
    - 食前血糖値 (`pre_meal_glucose`): $[T - 15\text{分},\ T + 5\text{分}]$ の範囲内で、食事時刻 $T$ との時間差の絶対値が最小となる測定値を採用。
    - 食後ピーク血糖値 (`post_meal_glucose`) と干渉打ち切り判定 (`isPostMealReference`):
      - 通常時は $[T + 60\text{分},\ T + 180\text{分}]$（食後1〜3時間）の範囲内における最高血糖値（Max）を採用する。
      - ただし $(T,\ T + 180\text{分}]$ の範囲内に後続の「食事記録（`event_type === '食事'`）」または「持効型を除く追加インスリン投与（`insulin_units > 0`）」が存在する場合は、`isPostMealReference = true`（参考値）と判定し、最初の後続イベント時刻 $T_{\text{int}}$ の直前 $[T + 60\text{分},\ T_{\text{int}})$ で探索窓を打ち切って最大値を算出する（$T_{\text{int}} \le T + 60\text{分}$ 等で有効窓内に測定値がない場合はピーク値を未設定 `undefined` とする）。
      - 参考値（`isPostMealReference === true`）となった記録は日次詳細および食品別履歴一覧に「参考値」と明示し、食品別インパクト分析の平均ピーク値・平均上昇幅（Δ）の母集団からは除外する。
    - 食事・活動（インスリン含む）の保存・編集・統合・論理削除時には、対象日の前後1日の食事イベント群に対して `bindMealGlucoseFromReadings` を局所実行し、先行する食事への干渉有無の変化も即座に再反映する。
  - クラウド同期との責務分担:
    食前・食後ピーク血糖値の探索・補完は Local-First 原則に基づきクライアント側（`bindMealGlucoseFromReadings`）で一元実行し、算出済みの `pre_meal_glucose` / `post_meal_glucose` を含む `events` レコードを `syncPatientDataWithCloud`（`src/lib/syncEngine.ts`）で Supabase へ双方向同期する（サーバーサイドでの重複バッチSQLは実行しない）。

---

## 4. セキュリティ・認証・ロール管理（家族共有）仕様

クラウド環境で患者の生体・健康データ（PHD）を安全に保護しつつ、家族による閲覧・見守りをセキュアに実現するための仕様です。

### 4.1 ユーザーロールと権限モデル
本システムでは、以下の3つのロールを定義します。初期フェーズでは「患者本人」と「家族（閲覧専用）」の2区分を最小構成としてサポートします。

| ロール | 想定ユーザー | 権限範囲 |
| :--- | :--- | :--- |
| `patient`（患者本人） | 糖尿病患者本人 | 自身の全データに対する完全なアクセス権（閲覧・登録・編集・削除・CSV取込・家族招待） |
| `viewer`（家族・閲覧専用） | 患者の家族・保護者・介護者 | 許可された患者のデータに対する 閲覧のみ（カレンダー、日次詳細、分析画面の参照）。編集・削除・インポート・設定変更は不可 |
| `editor`（家族・代理入力） | 小児・高齢者患者の保護者等 | 許可された患者の食事記録や活動記録の代理登録・編集が可能（コード上のロール型 `UserRole` は `patient` / `viewer` / `editor`） |

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

### 4.3 Supabase RLS (Row Level Security) & 招待専用アクセスガード設計 (`supabase/migrations/`)
データベース層で不正アクセスや未招待第三者のサインアップ・利用・招待メール推測を遮断し、かつ 8.4万行の `libre_readings` 取得時にも高速に応答させるため、非公開スキーマ `app_private` への `SECURITY DEFINER` 関数隔離、`public.verify_user_authorization()` の `SECURITY INVOKER` ラッパー化、`auth.users` トリガー、および InitPlan 最適化された単一アクション RLS ポリシーを連番マイグレーション（`supabase/migrations/*.sql`）で管理します。

- 招待専用アクセス判定と公開サインアップ運用 (`app_private.is_authorized_system_user`, `public.verify_user_authorization`, `trg_enforce_invited_or_owner_signup`):
  - システムを操作・閲覧できるのは ①オーナー（最初に登録された患者本人、または既に全7業務テーブルのいずれかにレコードを有する患者本人） と、②そのオーナーが `family_permissions` テーブルに招待登録した家族（`family_user_id` または `LOWER(family_email)` が一致するユーザー） のみに厳格制限する。
  - Supabase Auth のメールサインアップ設定自体は招待家族の自己登録導線を維持するため有効（メール確認必須）とした上で、`auth.users` に対する `BEFORE INSERT` トリガー（`trg_enforce_invited_or_owner_signup` → `app_private.enforce_invited_or_owner_signup()`）により、既にオーナーが存在する状態で `family_permissions` に招待されていないメールアドレスがサインアップを試みた場合は PostgreSQL レベルで即座にロールバック遮断する。
  - クライアント側でもログイン・セッション復元時に `verifyUserAccessWithCloud`（`src/lib/syncEngine.ts`）を実行し、未招待の第三者アカウントであった場合は同期やローカルデータ移行を一切行わず即座に `signOut()` してローカルキャッシュを全消去する。
- 非公開スキーマ `app_private` 隔離と Data API (`public`) からの `SECURITY DEFINER` 露出ゼロ化:
  - RLS 内部ヘルパー関数群（`is_system_owner`, `is_authorized_system_user`, `can_view_patient_data`, `can_edit_patient_data`, `verify_user_authorization`, `enforce_invited_or_owner_signup`）はすべて PostgREST 非公開の `app_private` スキーマに `STABLE SECURITY DEFINER SET search_path = app_private, public, auth` として配置し、`public` スキーマ上の同名 `SECURITY DEFINER` 関数は削除する。これにより `/rest/v1/rpc/*` 経由での任意引数呼び出し・招待メール推測オラクルを物理的に根絶する（Supabase Security Advisor Lint `0029` 警告ゼロ）。
  - フロントエンド（ログイン後の Auth Gate）から呼び出す `public.verify_user_authorization()` は引数なしの `STABLE SECURITY INVOKER` SQL ラッパーとして `app_private.verify_user_authorization()` へ委譲し、`authenticated` ロールのみに `EXECUTE` を許可する（`PUBLIC` / `anon` からは `REVOKE`）。
- 大量データ（8.4万行）に対する `STABLE` 宣言 ＆ RLS InitPlan・単一ポリシー最適化:
  - 認可判定関数群をすべて `STABLE` として宣言し、`app_private.can_view_patient_data` / `app_private.can_edit_patient_data` 内の重複オーナー判定を単一評価に統合する。
  - `family_permissions` を含む全8テーブルの RLS ポリシーはアクション別（`SELECT` / `INSERT` / `UPDATE` / `DELETE`）の単一 Permissive ポリシーに統合（旧 `family_permissions_all` / `family_permissions_accept_invite` の重複評価 Lint `0006` を排除）し、`((user_id = (SELECT auth.uid()) AND (SELECT app_private.is_system_owner())) OR app_private.can_view_patient_data(user_id))` 形式および外部キーインデックス（`idx_food_master_category`, `idx_event_master_category`）により、8.4万行取得時も複合インデックス（`idx_libre_user_time`）を直接利用させる。

```sql
-- 非公開スキーマ app_private 内の閲覧権限チェック関数 (Data API 非露出・STABLE InitPlan 対応)
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
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app_private, public, auth;

-- 公開スキーマ側の認可確認 RPC は引数なし SECURITY INVOKER ラッパーのみ配置
CREATE OR REPLACE FUNCTION public.verify_user_authorization()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = app_private, public
AS $$
    SELECT app_private.verify_user_authorization();
$$;
```

### 4.4 フロントエンドにおける「専用ログイン画面（Auth Gate）」と「患者コンテキスト（PatientContext）」設計 (`src/components/common/AuthGateScreen.tsx`, `src/contexts/PatientContext.tsx`, `src/App.tsx`)
1. 本番モードでの未ログイン時「専用ログイン画面（Auth Gate）」強制ロック:
   - 本番環境（`VITE_APP_MODE=personal` かつ Supabase 設定有効時、すなわち `isAuthRequired === true`）では、未ログイン状態（`!authUser`）または権限検証未完了/不許可（`!isAccessAuthorized`）のとき、`src/App.tsx` がヘッダー・カレンダー・分析・設定・ボトムナビ等を一切レンダリングせず、フルスクリーンの専用ログイン画面 `src/components/common/AuthGateScreen.tsx` のみを表示して完全にブロックする（URLを知っている第三者がアクセスしてもアプリ画面を一切閲覧・操作できない）。
   - ※公開デモモード（`VITE_APP_MODE=portfolio`）およびローカル専用のE2Eテスト環境では従来通りログイン不要で動作する。
2. 強固なパスワード複雑性ポリシー（`validateStrongPassword`：`src/lib/supabase.ts`, `src/components/common/PasswordStrengthChecklist.tsx`）:
   - 新規アカウント登録（オーナーおよび招待家族の初回登録）時には、8文字以上かつ「英大文字 (`A-Z`)」「英小文字 (`a-z`)」「数字 (`0-9`)」「記号（英数字・空白以外のASCII記号文字）」の4種類すべてを含むこと を必須要件とする。
   - 共通チェックリストコンポーネント `src/components/common/PasswordStrengthChecklist.tsx` により `AuthGateScreen.tsx` および `src/components/settings/CloudSyncFamilySection.tsx`（`SettingsView.tsx`）のUI上で5条件の達成状況をリアルタイム表示し、`PatientContext.tsx` の `signUpWithEmail`（および Supabase Auth 側の `Minimum password length: 8` / `Lowercase, uppercase letters, digits and symbols` 設定）により未達成パスワードでの登録を確実に遮断する。
3. 患者コンテキスト（`PatientContext`）による一元管理:
   - コンポーネントが直接 `auth.user.id` を参照してデータを取得する設計を禁止し、「現在選択中の患者ID（`currentPatientId`）」「その患者に対するロール（`currentRole`）」「認証ゲート要件（`isAuthRequired` / `isAccessAuthorized`）」「臨床目標閾値（`hypoThreshold` / `hyperThreshold`）」を配信する Context（`src/contexts/PatientContext.tsx`）で一元管理する。

### 4.5 Cloudflare Workers BFF (`POST /api/gemini`) による Gemini API キーの完全秘匿 & 認証・同一Origin検証 (`functions/api/gemini.ts`, `src/lib/gemini.ts`)
- Google Gemini API キーはクライアント（React）や `localStorage` には一切保持せず、Cloudflare Pages Functions / Workers の Secrets（環境変数） に保存。
- React（`src/lib/gemini.ts` の `estimateCarbsWithGemini` / `buildBffRequestHeaders`）からは、Supabase セッションが存在する場合は自動的に `Authorization: Bearer <access_token>` を付与し、`credentials: 'same-origin'` で同一オリジンの `POST /api/gemini` プロキシエンドポイントへリクエストを送信する。BFF未接続時やオフライン時は内蔵の「日本食品標準成分辞書（約80品目＋部分一致推論）」へ自動フォールバックする。
- Workers側（`functions/api/gemini.ts` の `verifyBffRequestAuth`）では、APIキー漏洩・外部タダ乗り・CSRFを防止するため以下の多層検証を強制する：
  1. Cross-Origin / Cross-Site 即時遮断 (`HTTP 403 Forbidden`): `Sec-Fetch-Site: cross-site`、またはリクエスト先オリジンと一致しない `Origin` / `Referer` ヘッダーを持つリクエストを即座に拒否する。
  2. Supabase JWT 検証 (`HTTP 401 Unauthorized`): `Authorization: Bearer <token>` が送信された場合、JWT 構造・`sub` クレーム・有効期限（`exp`）を検証し、さらに `SUPABASE_URL` および `SUPABASE_ANON_KEY` が環境変数に設定されている場合は Supabase Auth（`/auth/v1/user`）へ照会してトークンの正当性を検証する（不正・期限切れトークンは同一オリジンであっても 401 で拒否）。
  3. 本番モード（`APP_MODE !== 'portfolio'` かつ `VITE_APP_MODE !== 'portfolio'`）では、Supabase Auth で検証済みの有効な Supabase JWT を必須とする（未送信・不正・期限切れ・署名未検証時はすべて `HTTP 401 Unauthorized`）。同一 Origin 検証は Cross-Origin の遮断を目的とする補助的な検査とし、本番モードでは単独の認証として扱わない（`Origin` / `Referer` / `Sec-Fetch-Site` はブラウザ以外のクライアントが任意に設定できるため）。
  4. Workers メモリ内スライディングウィンドウ方式（`checkBffUserRateLimit`）によりユーザー（JWT の `sub`、デモモード時は接続元IP）単位のレート制限を行い、超過時は `Retry-After` ヘッダー付きで `HTTP 429 Too Many Requests` を返す。上限回数とウィンドウ秒数は環境変数（`BFF_RATE_LIMIT_MAX` / `BFF_RATE_LIMIT_WINDOW_SEC`）で設定し、未指定時は安全側既定値（`DEFAULT_BFF_RATE_LIMIT_MAX` / `DEFAULT_BFF_RATE_LIMIT_WINDOW_SEC`）を使用する。
  5. `SUPABASE_URL` と `SUPABASE_ANON_KEY`（または `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`）が Cloudflare Pages Functions の Runtime 環境変数に未設定の場合、JWT は構造と有効期限しか検証されず署名が検証されないため、`remoteVerified === false` として本番モードでは通過させない。本番 Cloudflare Pages（`cgm-diabetes-manager-personal`）では Runtime 環境変数への両設定を必須要件とする。
  6. リクエスト処理順序として、`onRequestPost` の最先頭で必ず `verifyBffRequestAuth`（`403` / `401`）および `checkBffUserRateLimit`（`429`）を実行し、その後に `GEMINI_API_KEY` の設定有無（未設定時は `503` でクライアント内蔵辞書へフォールバック）を判定する。これにより `GEMINI_API_KEY` 未設定環境であっても未認証・偽造 JWT リクエストを常に `401` / `403` で確実に遮断する。

### 4.6 ローカル端末（IndexedDB & メモリキャッシュ）の保護とログアウト時完全消去 (`src/lib/syncEngine.ts`, `src/contexts/PatientContext.tsx`, `src/components/settings/CloudSyncFamilySection.tsx`)
- 共有端末やスマホ・PCでの情報漏洩を防止するため、ユーザーが「ログアウト」を実行した際（または未招待アカウントが遮断された際）は、`purgeAllLocalPatientCaches`（`src/lib/syncEngine.ts`）により IndexedDB 内の全7テーブル（`user_settings`, `categories`, `food_master`, `event_master`, `events`, `meal_details`, `libre_readings`）および全4種のメモリキャッシュ（カレンダー月次集計・分析集計・期間局所スライス・直近メモリキャッシュ）を完全消去してログイン画面（`AuthGateScreen`）へ戻す。
- 通常のログアウト実行時（`PatientContext.tsx` の `signOut` → `executeSafeLogoutWithFinalSync`）は、編集権限のあるロール（`patient` / `editor`）である場合、端末データを消去する前にクラウドへの最終同期（`syncPatientDataWithCloud`）を試みる。最終同期に成功した場合（または送信対象を持たない `viewer` ロールの場合）のみ、そのままセッション破棄とローカル全消去を実行する。
- オフラインや通信障害等で最終同期に失敗した場合は、消去を行わずに `{ completed: false, requiresForceConfirm: true }`（`SignOutOutcome`）を返し、設定画面（`CloudSyncFamilySection.tsx`）の共通確認ダイアログ（`ConfirmDialog`）で未送信の変更が失われる可能性があることを警告して「消去してログアウト」（`signOut({ force: true })`）か「キャンセル」（ログアウトを中止し端末内データを保持）を選ばせる。
- 未招待アカウントの遮断時は、従来どおり同期せずに即座に消去する。

---

## 5. データベース物理スキーマ（連番マイグレーション & スナップショット管理）

物理 DDL 全文の単一真実源（SSOT）は `supabase/migrations/` 配下の連番 SQL マイグレーション群および自動検証用スナップショット [`supabase/schema_snapshot.json`](../../supabase/schema_snapshot.json) に集約し、本書への SQL 全文重複転記は行いません（`scripts/gates/schema-parity.ts` が全マイグレーションを順番に解析し、`supabase/schema_snapshot.json`・[`src/types/database.ts`](../../src/types/database.ts)・[`src/lib/db.ts`](../../src/lib/db.ts)・[`diagrams/SEQUENCE_AND_ERD.md`](diagrams/SEQUENCE_AND_ERD.md) の完全一致を強制検証します）。

### 5.0.1 連番マイグレーション履歴 (`supabase/migrations/`)
1. [`0001_initial_schema.sql`](../../supabase/migrations/0001_initial_schema.sql): 全8テーブル・複合/部分ユニークインデックス・基本 RLS 定義。
2. [`20261116205848_harden_rls_functions_and_fk_indexes.sql`](../../supabase/migrations/20261116205848_harden_rls_functions_and_fk_indexes.sql): 認可関数の `STABLE` 化・他者 UID 探索拒否・匿名 `EXECUTE` 剥奪・外部キーインデックス追加。
3. [`20261116205957_expand_timing_category_and_alter_rls_policies_initplan.sql`](../../supabase/migrations/20261116205957_expand_timing_category_and_alter_rls_policies_initplan.sql): `events.timing_category` の `VARCHAR(50)` 拡張および InitPlan (`(SELECT auth.uid())`) 最適化。
4. [`20261117030000_isolate_security_definer_helpers_and_consolidate_family_rls.sql`](../../supabase/migrations/20261117030000_isolate_security_definer_helpers_and_consolidate_family_rls.sql): 内部 `SECURITY DEFINER` 関数群の非公開スキーマ `app_private` 隔離（Lint `0029` 解消、`SET search_path = app_private, public, auth, pg_temp` 固定、および `ALTER FUNCTION ... SET SCHEMA app_private` による `auth.users` トリガー OID 無停止移行）、`public.verify_user_authorization()` の `SECURITY INVOKER` ラッパー化、ならびに `family_permissions` 単一アクション RLS 統合（Lint `0006` 解消）。

### 5.0.2 PostgreSQL 全8テーブル・RLS 設計一覧

| 物理テーブル名 | 対応TS型 (`src/types/database.ts`) | 主キー / 主要制約・上限 | 主要インデックス | RLS ポリシー設計 (`TO authenticated`) |
| :--- | :--- | :--- | :--- | :--- |
| `family_permissions` | `FamilyPermission` | `id UUID` / `role IN ('viewer','editor')`, `family_email VARCHAR(255)` | `uq_patient_family_uid`, `uq_patient_family_email`, `idx_family_lookup`, `idx_family_email_lookup` | 4単一ポリシー (`_select` / `_insert` / `_update` / `_delete`): オーナー管理＋招待家族の参照・初回承認のみ許可 |
| `categories` | `Category` | `id UUID` / `target_type IN ('food','event')`, `category_name VARCHAR(50)`, 論理削除 | `uq_user_type_cat_active` (`WHERE is_deleted = false`), `idx_categories_user` | オーナー InitPlan 判定 `OR app_private.can_view_patient_data(user_id)` / `app_private.can_edit_patient_data(user_id)` |
| `food_master` | `FoodMaster` | `id UUID` / `food_name VARCHAR(100)`, `unit VARCHAR(20)`, 論理削除 | `idx_food_master_user`, `idx_food_master_category` | 同上（閲覧: 本人+招待家族 / 更新: 本人+`editor`） |
| `event_master` | `EventMaster` | `id UUID` / `event_name VARCHAR(100)`, 論理削除 | `idx_event_master_user`, `idx_event_master_category` | 同上 |
| `libre_readings` | `LibreReading` | `id UUID` / `UNIQUE (user_id, timestamp)`, `scan_type VARCHAR(20)`, 追記専用 | `idx_libre_user_time (user_id, timestamp DESC)` | 同上（8.4万行範囲検索で複合インデックス直接利用） |
| `events` | `HealthEvent` | `id UUID` / `event_type IN ('食事','活動','低血糖','高血糖')`, `timing_category VARCHAR(50)` (`MAX_CATEGORY_NAME_LENGTH` 一致), 論理削除 | `idx_events_user_time (user_id, event_datetime DESC)`, `idx_events_sync` | 同上 |
| `meal_details` | `MealDetail` | `id UUID` / `event_id REFERENCES events(id) ON DELETE CASCADE`, `food_name VARCHAR(100)`, `unit VARCHAR(20)`, 論理削除 | `idx_meal_details_event`, `idx_meal_details_sync` | 同上 |
| `user_settings` | `UserSettings` | `user_id UUID` / 目標閾値・区分別デフォルトインスリン | 主キー `(user_id)` | 同上 |

---

### 5.1 クライアント側 IndexedDB (Dexie.js) 複合インデックス & 期間局所取得仕様 (`src/lib/db.ts`)

ブラウザ内の IndexedDB（`cgm_diabetes_manager_db` Version 2）では、全件スキャン（`.toArray()`）を完全に排除し、指定されたカレンダー月（42日グリッド）や分析期間（7日/14日/30日/90日/月別/全期間）のみを $O(\log N + K)$ でピンポイント取得するため、以下の複合インデックスを定義しています：

| テーブル名 | 主キー & 複合インデックス定義 (`src/lib/db.ts` Version 2) | 主な局所クエリ用途 |
| :--- | :--- | :--- |
| `libre_readings` | `id, [user_id+timestamp], timestamp, user_id` | カレンダー月間取得・分析期間スライス取得・食前/食後近傍探索（`.where('[user_id+timestamp]').between(...)`） |
| `events` | `id, [user_id+event_datetime], [user_id+event_type], user_id, event_datetime, event_type, is_deleted, updated_at` | 指定期間のイベント範囲取得（`.where('[user_id+event_datetime]').between(...)`）および異常値再判定時の種別抽出 |
| `meal_details` | `id, [user_id+event_id], event_id, user_id, is_deleted, updated_at` | 日次ドロワー・分析画面における対象食事イベントID群からの明細一括取得（`.where('event_id').anyOf(mealEventIds)`） |
| `food_master` | `id, [user_id+category_id], user_id, category_id, food_name, is_deleted, updated_at` | カテゴリ別食品一覧・カテゴリ削除時の未分類付け替え |
| `event_master` | `id, [user_id+category_id], user_id, category_id, event_name, is_deleted, updated_at` | カテゴリ別活動一覧・カテゴリ削除時の未分類付け替え |
| `categories` | `id, user_id, target_type, [user_id+target_type], is_deleted` | 食品カテゴリ（`food`）と活動カテゴリ（`event`）の区分別高速取得 |
| `user_settings` | `user_id, updated_at` | 患者ごとの低血糖/高血糖目標閾値・デフォルトインスリン設定のO(1)取得 |

---

## 6. 本番環境 (`personal`) とポートフォリオ環境 (`portfolio`) のデータ完全分離戦略

本システムでは、個人本番環境（`VITE_APP_MODE=personal`）とポートフォリオ公開環境（`VITE_APP_MODE=portfolio`）でUIコンポーネント・臨床計算アルゴリズム・正規UUID採番（`src/lib/uuidUtils.ts`）を共通化しつつ、初期データ投入の振る舞いを厳格に分離しています。

- 個人本番環境 (`VITE_APP_MODE=personal` / デフォルト) の完全クリーン起動 & 永続保存:
  - 本番環境ではデモ用データファイル（`public/data/real_glucose_recent.json` / `public/data/real_glucose_readings.json`）のプリフェッチやハイドレーション、および既存ユーザーデータの削除を一切行いません。
  - `vite.config.ts` のビルドプラグイン（`configResolved` 動的 `outDir` 参照）により、出力先を `dist-personal` と `dist-portfolio` に完全分離し、`mode === 'personal'` ビルド時には `dist-personal/data/real_glucose_*.json` を出力ディレクトリから完全除外します。
  - 初回起動時は `seedFoodMasterIfEmpty(patientId)`（`src/lib/foodSeed.ts`）のみを実行し、カレンダーは常に「今日（当月・当日）」を表示して患者本人および家族による実データ登録・FreeStyleリブレCSV取込を永続保存します。
- ポートフォリオ環境 (`VITE_APP_MODE=portfolio`) における実測CGMデモデータの自動生成 (`src/lib/realGlucoseLoader.ts`):
  - ポートフォリオ公開環境では、FreeStyleリブレの実測血糖値データ（`public/data/real_glucose_readings.json`：79,479件、2024年9月〜2026年8月）および実測の低血糖・高血糖エピソードを使用します。
  - 実測CGMデータの2026年1月〜2026年8月に対し、各日の実測血糖波形の谷（食前血糖値 `pre_meal_glucose`）と食後ピーク（食後血糖値 `post_meal_glucose`）を解析して以下を自動紐づけします：
    1. 1日3食＋週末の間食（夜食）: 毎日「朝食」「昼食」「夕食」の3食を記録し、週末（土曜・日曜）には午後の血糖変動や夜間の小ピークに合わせてランダムで「間食」（おやつ・夜食）を記録します。
    2. 糖質制限（基本100g以内）と高血糖スパイク時の規定超過（最大1.5倍程度）: 1回の食事は糖質100g以内（40g〜92g）を基本としつつ、実測CGMデータで食後高血糖スパイクが観測された食事では105g〜145gのメニューを割り当て、血糖値の変動と食事内容が臨床的・視覚的に整合するようにします。
    3. 食べ合わせ（献立の自然さ）の徹底: ごはん・パン・麺類などの主食重複を禁止し、自然な定食・洋食・麺セットを構成します。
    4. 糖質量に基づく理論的なインスリン単位数: 超速効型インスリン量は食事の合計糖質量（`total_carbs`）と食前血糖値に基づき、糖質インスリン比（ICR: 約10g/U）＋補正インスリンから理論的に算出します。あわせて毎晩の持効型インスリン（10U）および運動イベントを決定論的UUID（`src/lib/uuidUtils.ts`）で記録します。
- ポートフォリオモード (`VITE_APP_MODE=portfolio`) の完全オンメモリDB化・物理IndexedDB自動パージ・セキュリティ＆UIハードニング:
  - ポートフォリオ公開環境では、複数の採用担当者・閲覧者が「食事記録」「よく使う食品の登録・編集・削除」「よく使う活動の登録・編集・削除」「カテゴリ管理」「目標閾値・デフォルトインスリンの設定変更」をすべてインタラクティブに試すことができます。
  - 同時に、閲覧者のスマートフォンやPCの端末ストレージを一切圧迫しないよう、デモモード（`isDemoMemoryOnlyMode()`）では `src/lib/db.ts` が全7テーブルの読み書きをオンメモリマップ（`InMemoryTable`）で処理し、物理 IndexedDB（`cgm_diabetes_manager_db`）には一切データを書き込みません。また、過去アクセス時に残存していた物理 IndexedDB も起動時・`pagehide` 時・手動リセット時に `indexedDB.deleteDatabase('cgm_diabetes_manager_db')` で自動消去し、Service Worker（`public/sw.js`）でも `/data/*.json` の Cache Storage 保存を行いません。
  - 閲覧者による追加・編集・削除はそのページの閲覧セッション中のみオンメモリ上で有効であり、ブラウザを再読み込み（リロード）するか、設定画面の「デモ環境のデータ管理」カードにある「デモデータを初期状態に戻す」ボタンを押すと、食品・活動・カテゴリ・記録・設定のすべてが初期シード状態へリセットされます。
  - さらに、デモアプリとしての完成度とセキュリティを担保するため、設定画面の未実装・通常バックアップ・クライアント側ロール切替セクションおよび食事記録・食品登録モーダル内の糖質自動推定ボタンを非表示とし、ECharts カスタムツールチップの動的文字列は `escapeHtml`（`src/lib/utils.ts`）でサニタイズし、Cloudflare Pages 配信ヘッダー（`public/_headers`）で標準セキュリティヘッダーを強制します。
- Git デュアルリモート管理 & 2系統 CI/CD パイプライン (`scripts/orchestrate-pipeline.mjs`, `.github/workflows/deploy-pages.yml`):
  - ランタイム統一・明示ステージング必須化・CI Artifact 受け渡し一本化:
    - 開発環境とリモートCI/CDを Node.js 24 LTS（`.nvmrc` および `package.json` の `engines`）に統一します。Git 履歴上で「仕様先行（Spec-First）」を証明するため、①仕様書・図面・テスト計画を先に更新して記録する先行コミット（`docs(spec): ...`）と、②合意後に実装・テストを記録する実装コミット（`feat(...): ...` / `fix(...): ...`）の **2段階記録** を標準とします。`pipeline:ship:*` では未検査ファイル巻き込みを防ぐため `git add -A` を廃止し、明示的に `git add` された変更のみをコミットします（未ステージ変更・未追跡ファイル残存時はエラー停止）。Cloudflare Pages へのデプロイは GitHub Actions の `deploy` ジョブ（`verify` ジョブで実ブラウザ E2E 検証を通過したビルド Artifact をそのまま受け取ってデプロイ）に一本化します。
  - 本番開発リポジトリ (`origin`: Private):
    - ローカルでは `.githooks/pre-commit`（ステージ済み Index Blob 直接検査）および `.githooks/pre-push`（未検証・Force Push 遮断）で保護し、`main` ブランチへの Push 時、GitHub Actions の `verify` ジョブ通過後に `deploy` ジョブが Supabase 環境変数完備を確認の上、検証済み `dist-personal` アーティファクトを本番用 Cloudflare Pages へ自動デプロイします。
  - デモ公開リポジトリ (`public-demo`: Public・GitHub Ruleset 保護適合):
    - ワーキングツリーを一切切り替えず一時インデックス（`GIT_INDEX_FILE`）と `git commit-tree -p refs/heads/demo-public` で旧VBA資産・個人PCパス・内部 Issue 番号を完全除外した Fast-Forward 子コミットを生成する `scripts/rebuild-demo-branch.mjs` により、履歴保護（`non_fast_forward`）と必須ステータスチェック（`Verify Quality Gates (DDD / Types / Vitest / Smoke / Playwright E2E)`）が有効な `public-demo` Ruleset を100%満たして公開します（ステージングブランチ `release/demo` へ Push → CI 通過確認後に `main` へ Fast-Forward 反映 → GitHub Actions が検証済み `dist-portfolio` アーティファクトをデモ用 Cloudflare Pages へ自動デプロイ）。

---

## 7. Local-First 双方向クラウド同期エンジン & BFF 実装仕様 (`src/lib/supabase.ts`, `src/lib/syncEngine.ts`, `functions/api/gemini.ts`)

1. Supabase クライアント初期化とテストバックドアゼロの環境分離 (`src/lib/supabase.ts`):
   - `isPortfolioMode() === false` かつ環境変数 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` が設定されている場合のみ `@supabase/supabase-js` クライアントを初期化します。
   - 本番クライアントコード内に E2E 用 `window.__CGM_E2E_*` フラグは一切保持せず、`portfolio` モード・環境変数未設定時・Vitest 単体テスト（`MODE === 'test'`）では自動的にローカル専用モードへフォールバックし、Playwright E2E では分離された実バンドル（`dist-portfolio` と `dist-personal`）の2プロジェクト構成で直接検証します。
2. 双方向クラウド同期エンジン (`src/lib/syncEngine.ts`):
   - 7テーブル一括 Push & Pull と汎用LWW差分計算 (`computeLwwDiff`): `user_settings`, `categories`, `food_master`, `event_master`, `events`, `meal_details`, `libre_readings` の全7テーブルについて、ジェネリック純粋関数 `computeLwwDiff<T>` によりローカル（Dexie.js）とクラウド（Supabase PostgreSQL）の Last-Write-Wins (LWW) 差分を算出し、双方向同期を実行します。
   - 24文字ウォールクロックISO時刻正規化（課題 #7 対応）: Supabase (`TIMESTAMPTZ`) から Pull した `timestamp` および `event_datetime`（`+00:00` オフセット等）は、`src/lib/dateUtils.ts` に一元化された `normalizeToWallClockIso`（`src/lib/syncEngine.ts` からも再エクスポート、スラッシュ区切り等のフォールバック時も `toISOString()` による -9時間 UTC 変換を行わずローカル時刻要素をそのまま保持）により必ず24文字の `"YYYY-MM-DDTHH:mm:ss.000Z"` 形式へ正規化してからローカルDBへ格納し、複合インデックス `.between()` 検索の整合性を担保します。
   - 1,000件単位のバッチチャンク処理 (`chunkArray`): `libre_readings` 等の大量レコードは 1,000件単位のチャンクに分割して `upsert` およびページネーション取得します。
   - 異常値エピソードのクラウド再計算整合性（課題 #6 対応）: 目標血糖閾値の変更時やCSV取込時には `replaceRemoteAnomalies: true` を指定し、最新の異常値エピソード集合を先に冪等 `upsert` した上で、新集合に含まれないクラウド側の旧自動抽出エピソード（`低血糖` / `高血糖`）のみを `deleteRowsByIdsInChunks` で後削除します（登録→削除の順によるデータ消失防止：§3.4）。
   - 未ログイン時ローカルデータの自動引き継ぎ (`migrateAnonymousLocalDataToUser`): 未ログイン状態（`DEFAULT_PATIENT_ID`）で記録されたローカルデータは、初回ログイン時に自動的に認証済み `auth.uid()` へマイグレーションされ、そのままクラウドへ同期されます。
   - 家族共有権限の自動解決 & Realtime 同期 (`resolveUserAccessFromPermissions`, `subscribeToPatientRealtime`): `family_permissions` テーブルを `family_user_id = auth.uid()` または `LOWER(family_email) = LOWER(user.email)` で照会し、招待元の `patient_id` とロール（`viewer` は閲覧専用ロック `isReadOnly = true`、`editor` は代理記録可能）を解決します。初回ログイン時に `family_user_id` が未設定の場合は自身の `auth.uid()` と `accepted_at` を自動紐づけし、Realtime 購読および同期完了時に全4種メモリキャッシュを即時破棄してUIを更新します。
3. Cloudflare Pages Functions BFF (`functions/api/gemini.ts`):
   - `POST /api/gemini` エンドポイント（`onRequestPost`）を提供し、最先頭で `verifyBffRequestAuth` による Cross-Origin 遮断（`403 Forbidden`）および本番モード時の検証済み Supabase JWT 必須化（同一 Origin 単独は不許可、未充足時は `401 Unauthorized`）と、`checkBffUserRateLimit` による Workers メモリ内スライディングウィンドウのユーザー単位レート制限（環境変数 `BFF_RATE_LIMIT_MAX` / `BFF_RATE_LIMIT_WINDOW_SEC` 対応、超過時は `429 Too Many Requests`）を実行します（§4.5）。さらに `foodName`（1〜100文字）および `unit`（20文字以内）の厳格な入力長バリデーションを実行した上で、サーバーサイド環境変数 `GEMINI_API_KEY` が設定されている場合は Google Gemini REST API を呼び出して糖質量推定結果（`{ carbs_g, confidence, note }`）を返却し、`GEMINI_API_KEY` 未設定時は `503` を返してクライアント（`src/lib/gemini.ts`）の内蔵日本食品標準成分表辞書（`estimateCarbsLocally`）へシームレスにフォールバックします。

