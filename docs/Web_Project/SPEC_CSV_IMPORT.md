# リブレCSV取込 & 異常値イベント自動登録・食事血糖値紐づけ 詳細仕様書 (SPEC_CSV_IMPORT.md)

本ドキュメントは、血糖値・食事・インスリン統合管理システム Web版における **「リブレCSV取込（`src/components/import/CsvImportModal.tsx`）」および「低血糖・高血糖イベント自動抽出・登録 / 既存食事イベントへの食前・食後血糖値自動紐づけ（`src/workers/csvParser.worker.ts`, `src/lib/anomalyExtractor.ts`）」** の機能要件、バックグラウンド並列アーキテクチャ、臨床ステートマシンアルゴリズム、UI設計、および受け入れ条件（DoD）を定めた仕様書（SSOT）です。

---

## 1. 機能概要 & 目的

FreeStyleリブレから出力された血糖測定データ（CSVファイル）を取り込み、低血糖・高血糖の記録を自動抽出するとともに、日々記録していた食事イベントへ食前・食後の血糖値を自動で紐づけます。
画面表示においては「Web Worker」「並列パース」「バインド」といった開発者用語を一切露出させず、誰にとっても分かりやすい簡潔な案内文で表示します。

### 1.1 主な役割
1. **大容量CSVの高速取込**: バックグラウンド処理により、大量データも画面が固まることなくスムーズに読み込み。
2. **FreeStyleリブレ標準形式の柔軟な判定**: 日本語・英語ヘッダーや各種リブレモデルのCSV形式に自動対応。
3. **異常値エピソードの自動抽出（設定基準値連動）**: `PatientContext` で保持するユーザーの目標基準値（`hypoThreshold` / `hyperThreshold`）に基づき、28分継続復帰ルールおよび45分センサー欠損ギャップルールで低血糖・高血糖エピソードを自動生成。
4. **既存食事イベントへの食前・食後血糖値自動紐づけ (`bindMealGlucoseFromReadings`)**: 食事記録時点では未取込だった当日の血糖データを、CSV取込完了時に既存の食事イベントへ自動反映。
5. **重複防止 & 全画面連動**: 取込完了後、カレンダー画面・推移グラフ・分析画面の数値と件数が100%一致して更新。

---

## 2. CSV入力仕様 & ヘッダー形式

FreeStyleリブレの出力CSVは通常以下の形式です（日本語・英語の両方をサポート）：

### 2.1 想定カラム構成
| カラム名 (日 / 英) | 型 | 役割 | 例 |
| :--- | :--- | :--- | :--- |
| **日時 / Meter Timestamp** | string | 測定日時（`YYYY/MM/DD HH:mm` または `YYYY-MM-DD HH:mm:ss`） | `2026/08/15 08:15` |
| **記録タイプ / Scan Type** | number / string | 0: 履歴測定値 (Historic), 1: スキャン測定値 (Scan) | `0` または `Historic` |
| **履歴グルコース / Historic Glucose** | number | 15分間隔の自動測定血糖値 (mg/dL) | `118` |
| **スキャングルコース / Scan Glucose** | number | 端末をかざした時の測定血糖値 (mg/dL) | `125` |

### 2.2 パース & 正規化ルール
- 日時文字列はウォールクロック時刻を保持した標準の ISO 8601 形式（`YYYY-MM-DDTHH:mm:00.000Z`）に変換（`src/lib/dateUtils.ts` と完全整合）。
- `Historic Glucose` が存在する場合は優先採用し、欠損時は `Scan Glucose` を参照。
- 空行やヘッダー以外の不要行（メタデータ等）は安全にスキップ。

---

## 3. バックグラウンド処理 & メッセージ通信プロトコル (`src/workers/csvParser.worker.ts`)

### 3.1 メッセージインターフェース
```typescript
export interface CsvImportStartMessage {
  type: 'START_IMPORT';
  fileText: string;
  patientId: string;
  hypoThreshold?: number;
  hyperThreshold?: number;
}

export interface CsvImportProgressMessage {
  type: 'PROGRESS';
  processedLines: number;
  totalLines: number;
  percent: number;
  readingCount: number;
  hypoCount: number;
  hyperCount: number;
}

export interface CsvImportCompleteMessage {
  type: 'COMPLETE';
  readings: LibreReading[];
  events: HealthEvent[];
  stats: {
    totalReadings: number;
    startDate: string;
    endDate: string;
    hypoCount: number;
    hyperCount: number;
    durationMs: number;
  };
}

export interface CsvImportErrorMessage {
  type: 'ERROR';
  error: string;
}
```

---

## 4. 異常値抽出ステートマシン & 決定論的UUID採番・食事血糖値紐づけ (`src/lib/anomalyExtractor.ts`, `src/lib/uuidUtils.ts` — Single Source of Truth)

CSV取込Worker（`src/workers/csvParser.worker.ts`）では、各測定値レコードに `src/lib/uuidUtils.ts` の `deterministicUuid(`${patientId}_${isoTime}`)` で冪等な正規UUIDを採番します。また、CSV取込時および設定画面での目標値変更時再判定は、すべて `extractAnomalyEventsFromReadings` 関数を共通利用し、異常値イベントIDも `deterministicUuid(`${patientId}_anomaly_${event_type}_${start}`)` により正規UUID形式で採番します。

### 4.1 低血糖エピソード (`< hypoThreshold` mg/dL)
- **開始**: 血糖値が `< hypoThreshold` に達した最初の測定時刻を開始日時（`lowStart`）、初期最低値（`minVal`）とする。
- **追跡**: 閾値未満が続く間、終了候補時刻（`lowEnd`）を更新し、`minVal = min(minVal, currVal)` を追跡。
- **確定条件**:
  1. 正常値（$\ge \text{hypoThreshold}$）に回復し、その正常状態が **28分以上（約2回の測定周期）** 持続した時点で1つのエピソードとしてクローズ。
  2. 前回測定から **45分を超えるセンサー欠損ギャップ** が発生した場合も、進行中のエピソードを一旦クローズ。
- **生成イベント**:
  - `id`: `deterministicUuid(`${patientId}_anomaly_低血糖_${lowStart}`)`
  - `event_type`: `'低血糖'`
  - `event_datetime`: `lowStart`
  - `memo`: `最低 ${minVal} mg/dL (継続 ${durationMinutes}分間)`

### 4.2 高血糖エピソード (`> hyperThreshold` mg/dL)
- **開始**: 血糖値が `> hyperThreshold` に達した最初の測定時刻を開始日時（`highStart`）、初期ピーク値（`maxVal`）とする。
- **追跡**: 閾値超が続く間、終了候補時刻（`highEnd`）を更新し、`maxVal = max(maxVal, currVal)` を追跡。
- **確定条件**: 正常値（$\le \text{hyperThreshold}$）への回復が **28分以上** 持続した時点、または **45分超のセンサー欠損ギャップ** 発生時点でクローズ。
- **生成イベント**:
  - `id`: `deterministicUuid(`${patientId}_anomaly_高血糖_${highStart}`)`
  - `event_type`: `'高血糖'`
  - `event_datetime`: `highStart`
  - `memo`: `最高 ${maxVal} mg/dL (継続 ${durationMinutes}分間)`

### 4.3 既存食事イベントへの食前・食後血糖値一括自動紐づけ (`bindMealGlucoseFromReadings`)
- 食事記録は食事の都度リアルタイムに行われ、CGM履歴データ（CSV）は後からまとめて取り込まれるため、CSV取込完了時に `bindMealGlucoseFromReadings(patientId)` を実行する。
- 対象患者の全食事イベント（`event_type === '食事' && !is_deleted`）を走査し、食事日時（$T$）に対して：
  1. **食前血糖値 (`pre_meal_glucose`)**: $T - 15\text{分} \le t \le T + 5\text{分}$ の範囲で最も時刻が近い測定値をセット。
  2. **食後ピーク血糖値 (`post_meal_glucose`)**: $T + 60\text{分} \le t \le T + 180\text{分}$（食後1〜3時間）の範囲の最大測定値をセット。

---

## 5. UIコンポーネント仕様 (`src/components/import/CsvImportModal.tsx`)

- 見出しはシンプルに「リブレCSVデータの取込」とし、「Web Worker」「並列パース」「バインド」などの技術用語は画面上に表示しない。
- **デモアプリ（ポートフォリオモード）における非活性化制御**: デモアプリ環境（`isPortfolioMode()`）では、PCサブナビ（`src/App.tsx`）およびモバイル下部ナビのスピードダイヤル（`src/components/common/BottomNav.tsx`）のCSV取込ボタンを `disabled`（非活性化）にし、**「デモアプリでは利用できません」** というメッセージを明示する（万一モーダル内でファイル処理が呼ばれた場合も `isDemoCsvImportDisabled()` により「デモアプリでは利用できません」と表示して中断する）。
- オープン・クローズ時は2段階マウント制御により、背景オーバーレイのフェードイン/アウトとモーダル本体のズーム＆フェードトランジションを滑らかに実行する。
- `usePatient()` から現在の `hypoThreshold` および `hyperThreshold` を取得し、Worker の `START_IMPORT` メッセージへ引き渡す。
- 取込完了時は、`[user_id+event_datetime]` 複合インデックスの `between()` で対象期間内の既存自動抽出異常値イベントを高速置換して二重登録を防止するとともに、日付バケット化された `bindMealGlucoseFromReadings(currentPatientId)` を実行して既存の食事イベントに食前・食後血糖値を $O(N + M)$ で自動反映し、クラウド接続時は `triggerBackgroundCloudSync(currentPatientId, { replaceRemoteAnomalies: true, includeReadings: true })`（`src/lib/syncEngine.ts`）により1,000件単位チャンクで `libre_readings` と最新の異常値イベントをクラウドへ自動同期する。

---

## 6. 受け入れ基準 (Definition of Done: DoD)

- [x] **DoD-1: バックグラウンド処理による高速取込・ユーザー目線UI・デモアプリ非活性化**
  - 大容量CSV取込中もUIがスムーズに動作し、画面内に「Web Worker」等の技術用語が露出していないこと。また、デモアプリ（`isPortfolioMode()`）ではCSV取込ボタンが非活性化（`disabled`）され、「デモアプリでは利用できません」と表示されること。
- [x] **DoD-2: リブレCSVの正確なパース**
  - 日時（`YYYY/MM/DD HH:mm`）が正確にウォールクロックISO 8601に変換され、血糖値が数値として保持されること。
- [x] **DoD-3: 共通ステートマシン (`src/lib/anomalyExtractor.ts`) と設定基準値の連動**
  - 28分継続ルール・45分ギャップルールおよびユーザー設定の低血糖/高血糖基準値に基づき、異常値エピソードが正確に抽出・登録されること。
- [x] **DoD-4: CSV取込完了時の既存食事イベントへの食前・食後血糖値自動紐づけ**
  - 先行して登録されていた食事イベントに対し、CSV取込完了時に `pre_meal_glucose` および `post_meal_glucose` が自動反映されること。
- [x] **DoD-5: カレンダー画面・24H推移グラフ・分析画面との件数100%一致 & ビルド品質**
  - 取込完了後、カレンダーセルの▼/▲表示、選択日サマリー、日次詳細ドロワー、分析画面で異常値件数が完全一致し、`npm run verify:all` がパスすること。
