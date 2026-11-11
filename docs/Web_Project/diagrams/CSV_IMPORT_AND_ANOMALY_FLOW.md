# リブレCSV取込 & 異常値イベント自動登録 処理フロー仕様書 (CSV_IMPORT_AND_ANOMALY_FLOW.md)

本ドキュメントは、8.4万件超のFreeStyleリブレ生データ（CSV）をWebブラウザ上でミリ秒単位で処理し、低血糖・高血糖イベントを自律的に抽出・登録するパイプライン処理の設計図（SSOT）です。

---

## 1. 全体処理アーキテクチャ (パイプライン概要)

大容量CSVパースおよび時系列ステートマシン判定をUIメインスレッドから完全分離し、**Web Worker** に委譲することで、画面描画（60fps）を一切カクつかせずに高速実行します。

```mermaid
flowchart TD
    classDef ui fill:#e0f2fe,stroke:#0284c7,stroke-width:2px;
    classDef worker fill:#fef3c7,stroke:#d97706,stroke-width:2px;
    classDef db fill:#dcfce7,stroke:#16a34a,stroke-width:2px;
    classDef cloud fill:#f3e8ff,stroke:#9333ea,stroke-width:2px;

    subgraph UI_Thread ["【UIメインスレッド】 (ユーザー体験 & 描画)"]
        A["ユーザー: CSVドラッグ&ドロップ / 選択"]:::ui --> B["ファイル検証 & プレビュー表示"]:::ui
        B --> C["Web Worker 起動 & Fileオブジェクト転送"]:::ui
        M["進捗バー更新 (0% → 100%)"]:::ui
        N["カレンダー & サマリー即時再描画 (50ms)"]:::ui
    end

    subgraph Web_Worker ["【Web Worker (バックグラウンド並列処理)】"]
        C --> D["CSVストリーミング読み込み (Chunk Parse)"]:::worker
        D --> E["リブレ生データ正規化 (ISO 8601変換)"]:::worker
        E --> F{"時系列ソート済みデータ列"}:::worker
        F --> G["リブレ測定レコード生成 (LibreReading[])"]:::worker
        F --> H["異常値抽出ステートマシン (Episode Extractor)"]:::worker
        H --> I["低血糖エピソード判定 (<70 mg/dL, 最低値・継続時間)"]:::worker
        H --> J["高血糖エピソード判定 (>180 mg/dL, ピーク値・継続時間)"]:::worker
        I & J --> K["健康イベント生成 (HealthEvent[])"]:::worker
        D -.->|定期 progress 通知| M
    end

    subgraph Local_Storage ["【ローカルデータベース (Local-First)】"]
        G --> L1["Dexie.js: libre_readings.bulkPut()"]:::db
        K --> L2["Dexie.js: events.bulkPut() (異常イベント)"]:::db
        L1 & L2 --> N
    end

    subgraph Cloud_Sync ["【クラウド非同期同期 (バックグラウンド)】"]
        L1 & L2 -.->|オンライン時差分プッシュ| O["Supabase PostgreSQL (RLS保護)"]:::cloud
    end
```

---

## 2. 処理シーケンス図 (UI ↔ Web Worker ↔ Dexie.js)

```mermaid
sequenceDiagram
    autonumber
    actor User as 👤 ユーザー (患者)
    participant UI as 🖥️ UIメインスレッド (React)
    participant Worker as ⚙️ Web Worker (並列処理)
    participant DB as 💾 IndexedDB (Dexie.js)
    participant State as 📊 PatientContext / AppState

    User->>UI: リブレCSVファイルをドロップ
    UI->>UI: プログレスモーダル展開 (0%)
    UI->>Worker: postMessage({ file, patientId, thresholds })
    
    rect rgb(255, 251, 235)
        Note over Worker: メインスレッドを占有せず並列実行
        Worker->>Worker: CSVヘッダー検証 (FreeStyleリブレ標準形式)
        loop チャンク分割パース (5,000行単位)
            Worker->>Worker: 日時正規化 & 血糖値パース
            Worker->>Worker: 低血糖・高血糖ステートマシン走査
            Worker-->>UI: postMessage({ type: 'PROGRESS', percent: 35 })
            UI->>UI: プログレスバー更新 (35%)
        end
        Worker->>Worker: エピソード集計完了 (低血糖X回, 高血糖Y回)
    end

    Worker->>DB: db.libre_readings.bulkPut(parsedReadings)
    Worker->>DB: db.events.bulkPut(extractedEpisodes)
    DB-->>Worker: 書込完了通知 (トランザクションコミット)

    Worker-->>UI: postMessage({ type: 'COMPLETE', summary: { totalReadings, hypoCount, hyperCount } })
    UI->>State: ローカルデータ更新トリガー発火
    State->>DB: 当月分集計クエリ実行 (50ms)
    DB-->>State: 集計結果返却
    UI->>UI: カレンダーグリッド・日別スパークライン・アラートバッジ即時反映
    UI->>User: 取込完了トースト通知 (例:「8,400件取込、低血糖3件自動登録」)
```

---

## 3. 異常値抽出ステートマシンの臨床ロジック (State Machine Diagram)

旧VBA資産（`modAbnormalEvents.txt`）で培われた臨床エピソード判定アルゴリズムを忠実に再現します。単発の1測定だけでなく、**「エピソードとしての継続時間」および「最低値/ピーク値」** を追跡します。

```mermaid
stateDiagram-v2
    [*] --> 正常範囲 (70〜180 mg/dL)

    state 正常範囲 (70〜180 mg/dL) {
        [*] --> 監視待機
        監視待機 --> 監視待機: 70 <= 血糖値 <= 180
    }

    正常範囲 (70〜180 mg/dL) --> 低血糖エピソード検知中: 血糖値 < 70 mg/dL
    正常範囲 (70〜180 mg/dL) --> 高血糖エピソード検知中: 血糖値 > 180 mg/dL

    state 低血糖エピソード検知中 {
        低血糖開始: 開始時刻記録, 最低値=初期値
        低血糖開始 --> 低血糖追跡: 次の測定値
        低血糖追跡 --> 低血糖追跡: 血糖値 < 70 (終了時刻更新, 最低値を更新)
        低血糖追跡 --> 低血糖回復監視: 血糖値 >= 70
        低血糖回復監視 --> 低血糖追跡: 血糖値 < 70 (再低下)
        低血糖回復監視 --> エピソード確定: 正常範囲が28分以上持続
    }

    state 高血糖エピソード検知中 {
        高血糖開始: 開始時刻記録, ピーク値=初期値
        高血糖開始 --> 高血糖追跡: 次の測定値
        高血糖追跡 --> 高血糖追跡: 血糖値 > 180 (終了時刻更新, ピーク値を更新)
        高血糖追跡 --> 高血糖回復監視: 血糖値 <= 180
        高血糖回復監視 --> 高血糖追跡: 血糖値 > 180 (再上昇)
        高血糖回復監視 --> エピソード確定: 正常範囲が28分以上持続
    }

    エピソード確定 --> 正常範囲 (70〜180 mg/dL): HealthEvent としてDB登録 (開始日時, 終了日時, 最低/最高値, 継続時間)
```

### 3.1 臨床判定基準のまとめ
| 異常値種別 | 開始トリガー | 継続・更新条件 | 終了確定条件 | 登録されるイベントデータ |
| :--- | :--- | :--- | :--- | :--- |
| **低血糖イベント** | 血糖値 `< 70 mg/dL` | `< 70 mg/dL` が続く間、終了時刻を更新し最低値（`minVal`）を記録 | 正常範囲（$\ge 70$）に復帰後、**28分以上（約2測定）** 正常値が持続 | ・種別: `低血糖`<br>・開始日時: 最初の下落時刻<br>・終了日時: 回復直前時刻<br>・メモ: `最低 58 mg/dL (継続 45分間)` |
| **高血糖イベント** | 血糖値 `> 180 mg/dL` | `> 180 mg/dL` が続く間、終了時刻を更新しピーク値（`maxVal`）を記録 | 正常範囲（$\le 180$）に復帰後、**28分以上（約2測定）** 正常値が持続 | ・種別: `高血糖`<br>・開始日時: 最初の上昇時刻<br>・終了日時: 回復直前時刻<br>・メモ: `最高 242 mg/dL (継続 90分間)` |

---

## 4. 既存データとの重複排除（冪等性保証）

同じCSVファイルを複数回取り込んだ場合や、日付が重複する過去データを取り込んだ場合でも、二重登録されないよう以下のキーで冪等性を保証します：

1. **測定値（`libre_readings`）**:
   - 複合インデックス: `[user_id + timestamp]`
   - `bulkPut()` を用いることで、同一患者・同一日時のレコードは上書き（Upsert）され、件数が無駄に重複しません。
2. **異常値イベント（`events`）**:
   - エピソードIDルール: `${patientId}_${eventType}_${startTimestamp}` のハッシュまたは確定的UUID
   - 既存イベントと同一開始日時の異常値はスキップまたは更新され、二重登録を防止します。
