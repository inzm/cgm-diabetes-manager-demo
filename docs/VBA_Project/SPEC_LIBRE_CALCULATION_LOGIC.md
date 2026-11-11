# リブレデータ計算処理ロジック仕様書 (SPEC_LIBRE_CALCULATION_LOGIC.md)

本ドキュメントは、Excel VBA 血糖値・食事・インスリン統合管理システム（`main.xlsm`）における**リブレ（FreeStyle Libre）生データおよび血糖値に関連する計算処理ロジック**の全体構造を、大分類（画面・コンテキスト）および小分類（機能）ごとに構造化して網羅的に定義した仕様書です。

---

## 全体アーキテクチャ・計算処理マップ

```mermaid
flowchart TD
    subgraph DataInput ["1. データ取込・共通基盤層"]
        CSV[FreeStyleリブレ CSV] -->|ImportLibreCSV| SheetLibre[(Libreデータ シート\n15分値 約8.4万行)]
        SheetLibre -->|ExtractGlucoseAbnormalEvents\n状態遷移マシン| EventLog[(イベント記録 シート\n低血糖/高血糖エピソード)]
        SheetLibre -->|BatchUpdateGlucose\n近傍15分探索| EventMeal[イベント記録\n食前/食後血糖補完]
    end

    subgraph CalendarView ["2. カレンダー画面"]
        SheetLibre -->|UpdateCalendarData\n配列一括集計| SparkCache[(SparklineData シート\nキャッシュ)]
        SparkCache -->|スパークライン描画| CalCells[カレンダー 日別セル]
        SparkCache -->|UpdateCalendarSideMenu\n高速キャッシュ参照| CalSide[サイドバー 日次サマリ]
        EventLog -->|アイコン描画 ▲/▼| CalCells
    end

    subgraph DailyDetailView ["3. 日次詳細画面"]
        SheetLibre -->|UpdateDailyDetailView\n当日分抽出| ChartData[(ChartData シート)]
        ChartData -->|DrawDailyGlucoseChart| ScatterChart[24時間血糖散布図グラフ]
        ChartData -->|日次統計計算| DailyCards[平均血糖・サマリカード]
        EventLog -->|マーカー抽出| ScatterChart
    end

    subgraph AnalysisView ["4. 分析画面"]
        SheetLibre & EventLog -->|AnalyzePeriodTrends| TrendChart[糖質・インスリン積層グラフ\n時間帯別異常集計]
        EventLog -->|AnalyzeSelectedFood| FoodImpact[食品別血糖上昇分析\n食前食後ΔBG]
        EventLog -->|AnalyzeWeekdayTrends| WeekdayChart[曜日別傾向分析]
        EventLog -->|AnalyzeAbnormalDayCharacteristics| RiskCluster[異常日特性分析\n糖質10g比率 & インサイト]
        AnalysisView -->|modGeminiAPI| AIDoctor[Gemini AI 臨床助言]
    end

    subgraph SettingsModal ["5. 設定画面"]
        SettingsSheet[(設定 シート\n閾値 D7/D8)] -->|GetHypoThreshold/GetHyperThreshold| DataInput
        SettingsModalUI[frmSettings] -->|ReevaluateAllAbnormalEvents| EventLog
    end
```

---

## 1. データ取込・共通基盤層 (Data Loading & Core Engine)

### 1.1 CSVインポート & データ保持期間管理
- **概要**: FreeStyle LibreViewからエクスポートされたCSVファイルを取り込み、データ型変換および長期データの自動パージを行います。
- **対象プロシージャ**: [`ImportLibreCSV`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modCalendar.txt#L646) (`modCalendar`)
- **入力データ**:
  - 外部CSVファイル（UTF-8形式）
  - 定数: `Public Const LIBRE_KEEP_YEARS As Integer = 3`
- **計算・処理ロジック**:
  1. **QueryTableによるUTF-8取込**: `TextFilePlatform = 65001` を指定して `Libreデータ` シートへ一括展開。
  2. **冗長ヘッダーの除去**: 先頭行がメタデータ（`Left(Range("A1").Value, 9) = "データ"` 等）の場合に1行目を削除。
  3. **シリアル値変換**: C列（タイムスタンプ）を `yyyy/mm/dd hh:mm` 形式のExcel日付シリアル値へパース。
  4. **データ保持期間フィルタリング（パージ計算）**:
     - C列の最大日時（最新タイムスタンプ: $T_{max}$）を探索。
     - 基準カットオフ日時の算出:
       $$T_{cutoff} = \text{DateAdd}("yyyy", -3, T_{max})$$
     - $C\text{列} \ge T_{cutoff}$ を満たすレコードのみをメモリ内配列に抽出し、3年以上前の古い過去ログを自動切り捨て削除。
  5. **後続バッチ連動**: `BatchUpdateGlucose`（食前食後血糖補完）および `ExtractGlucoseAbnormalEvents`（異常値抽出）を自動連続実行。

---

### 1.2 異常値（低血糖・高血糖）自動抽出エンジン
- **概要**: 15分間隔のグルコース測定値から、連続する低血糖および高血糖エピソードをステートマシンによって検出し、臨床記録として `イベント記録` シートへ自動登録します。
- **対象プロシージャ**: [`ExtractGlucoseAbnormalEvents`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modAbnormalEvents.txt#L15), [`RecordEpisode`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modAbnormalEvents.txt#L407) (`modAbnormalEvents`)
- **判定閾値**:
  - 低血糖閾値 ($Th_{low}$): `modSettings.GetHypoThreshold()`（初期値: $70\text{ mg/dL}$）
  - 高血糖閾値 ($Th_{high}$): `modSettings.GetHyperThreshold()`（初期値: $180\text{ mg/dL}$）
- **状態遷移アルゴリズム (Finite State Machine)**:
  1. **データ読み込み**: `Libreデータ` のC列（測定日時）およびE列（グルコース値）をVariant配列に一括読み込み。
  2. **欠損・ギャップ検出**:
     - 前後レコードの測定間隔 $\Delta t = t_{curr} - t_{prev}$ を監視。
     - $\Delta t > \frac{45}{1440}\text{日}$（45分超のセンサー外れ/欠損）が発生した場合、進行中のエピソードを強制クローズして記録。
  3. **低血糖エピソード判定 (CGM臨床標準: 正常復帰30分継続ルール)**:
     - 開始条件: $G_{curr} < Th_{low}$ かつ 非低血糖状態
     - 継続条件: $G_{curr} < Th_{low}$（最小値 $G_{min} = \min(G_{min}, G_{curr})$ および終了候補日時 $t_{end}$ を更新）
     - 終了条件: **正常範囲（$G_{curr} \ge Th_{low}$）が30分以上（実測間隔誤差を考慮し28分以上、連続2ポイント以上）継続**した時点で確定記録、またはデータギャップ（45分超）発生。
     - エピソード統合: 正常値への一時的な揺らぎが30分未満で再低下した場合は、同一エピソードの継続として時間を延伸・最低値を更新。
  4. **高血糖エピソード判定 (正常復帰30分継続ルール)**:
     - 開始条件: $G_{curr} > Th_{high}$ かつ 非高血糖状態
     - 継続条件: $G_{curr} > Th_{high}$（ピーク値 $G_{max} = \max(G_{max}, G_{curr})$ および終了候補日時 $t_{end}$ を更新）
     - 終了条件: **正常範囲（$G_{curr} \le Th_{high}$）が30分以上（28分以上、連続2ポイント以上）継続**した時点で確定記録、またはデータギャップ（45分超）発生。
     - エピソード統合: 正常値への一時的な揺らぎが30分未満で再上昇した場合は、同一エピソードの継続として時間を延伸・ピーク値を更新。
  5. **エピソード継続時間計算式 (15分単位丸め)**:
     \\text{Duration (分)} = \\text{Round}\\left(\\frac{(t_{end} - t_{start}) \\times 1440 + 15}{15}, 0\\right) \\times 15
     *(注: 15分間隔測定器の臨床特性に合わせ、ハードウェア時計の1分前後の揺らぎを吸収して15分単位に四捨五入丸めを行う)*
  6. **一意キー採番 & 冪等性保証**:
     - 重複登録防止ディクショナリ（`Scripting.Dictionary`）により既存のイベントIDと照合。
     - ID体系: `YYYYMMDD_HHNNSS_LOW01`, `YYYYMMDD_HHNNSS_HIGH01`
     - メモ欄自動生成: `最低 58 mg/dL (継続 45分)` / `ピーク 242 mg/dL (継続 60分)`

---

### 1.3 食前・食後血糖値の自動算出・補完
- **概要**: 登録された食事イベントに対して、近傍のリブレ生データから食前および食後2時間の血糖値を自動探索して補完します。
- **対象プロシージャ**: [`BatchUpdateGlucose`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modCalendar.txt#L1173), [`FindClosestGlucose`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modCalendar.txt#L1293) (`modCalendar`)
- **計算・探索ロジック**:
  1. **対象レコード**: `イベント記録` シートでイベント種別が「食事」かつ、食前血糖値（I列）または食後血糖値（J列）が空欄の行。
  2. **ターゲット日時の算出**:
     - 食前目標時刻: $T_{pre} = \text{日付} + \text{時刻}$
     - 食後目標時刻: $T_{post} = \text{DateAdd}("h", 2, T_{pre})$（食事開始から2時間後）
  3. **最寄り探索アルゴリズム (`FindClosestGlucose`)**:
     - 許容時間枠: 前後15分以内（$\text{limitDiff} = \frac{15}{1440}$）
     - 最小差分探索:
       $$\min_{j} |t_j - T_{target}| \quad \text{s.t.} \quad |t_j - T_{target}| \le \frac{15}{1440}$$
     - 該当する直近のグルコース値（E列）を返却。範囲内にデータが存在しない場合は `-1` を返し未補完のまま維持。

---

## 2. カレンダー画面 (Calendar View)

### 2.1 月次カレンダー日別サマリの集計ロジック
- **概要**: カレンダー表示に必要な42日分（6週×7日）の血糖データを一括集計し、各日セルへ数値を反映します。
- **対象プロシージャ**: [`UpdateCalendarData`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modCalendar.txt#L809) (`modCalendar`)
- **集計アルゴリズム**:
  1. **カレンダー基準日算出**:
     $$D_{start} = \text{DateSerial}(y, m, 1) - \text{Weekday}(\text{DateSerial}(y, m, 1)) + 1$$
     対象範囲: $D_{start} \sim D_{start} + 41$（インデックス $0 \sim 41$）
  2. **Variant配列による一括走査**:
     `wsLibre.Range("C2:E" & lastRow)` をメモリ上に展開し、1回のループで該当日付の血糖値を判定。
  3. **日別合計と件数の加算**:
     $$\text{dailySum}(d) = \sum G_i, \quad \text{dailyCount}(d) = \sum 1 \quad (\text{if } \text{Int}(t_i) = D_{start} + d)$$
  4. **日別平均血糖値の算出**:
     $$\text{AvgGlucose}(d) = \text{Round}\left(\frac{\text{dailySum}(d)}{\text{dailyCount}(d)}, 0\right)$$

---

### 2.2 スパークライン（1日ミニ推移グラフ）データ展開
- **概要**: カレンダーの各日セル内に埋め込まれるミニ折れ線グラフ（Sparkline）のための日次データを生成します。
- **対象プロシージャ**: [`UpdateCalendarData`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modCalendar.txt#L809) (`modCalendar`)
- **データ構造と処理**:
  1. 非表示シート `SparklineData` に 42行×100列（最大100測定点/日）の二次元配列を一括出力。
     - 行番号: $d + 1$ （Day Index 1〜42）
     - 列番号: $1 \sim 96$ （15分間隔の時系列データ）
  2. セルへのスパークラインバインド:
     `wsCal.Cells(r+2, c).SparklineGroups.Add` を用い、`SparklineData` の該当行範囲をデータソースとして指定。

---

### 2.3 血糖値異常アラートアイコン判定
- **概要**: 日別セルに低血糖（▼）・高血糖（▲）の発生アイコンを描画します。
- **対象プロシージャ**: [`UpdateCalendarData`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modCalendar.txt#L809) (`modCalendar`)
- **判定ルール**:
  - `イベント記録` シートの種別が「血糖値異常」または「低血糖」「高血糖」のレコードを日付別に集計。
  - 低血糖エピソードが存在する場合: `ChrW(&H25BC)`（青色 ▼ アイコン）
  - 高血糖エピソードが存在する場合: `ChrW(&H25B1)`（赤色 ▲ アイコン）
  - 発生回数に応じてアイコンを連結（例: `▼▼`）。

---

### 2.4 カレンダーサイドバーのリアルタイム高速集計
- **概要**: カレンダーで選択された特定日の血糖統計をサイドバー（Q4:V25）へ即座に表示します。
- **対象プロシージャ**: [`UpdateCalendarSideMenu`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modDailyDetail.txt#L1747) (`modDailyDetail`)
- **ハング防止キャッシュ参照ロジック**:
  - `Libreデータ`（数万行）を再走査せず、**`SparklineData` シートにキャッシュされた当該日の行データ（1〜100列）のみを高速走査**（所要時間 < 5ms）。
  - 有効測定値（数値かつ > 0）の合計と件数をカウントし、平均血糖値を算出:
    $$\text{サイドバー平均血糖値} = \text{Format}\left(\text{Round}\left(\frac{\sum C_{val}}{N_{cnt}}, 0\right), "0"\right) \ \& \ " \text{mg/dL}"$$

---

## 3. 日次詳細画面 (Daily Detail View)

### 3.1 選択日グルコース測定値抽出 & 統計指標計算
- **概要**: 選択された1日のリブレデータを抽出し、日次サマリカードに臨床統計値を算出・表示します。
- **対象プロシージャ**: [`UpdateDailyDetailView`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modDailyDetail.txt#L449) (`modDailyDetail`)
- **計算ロジック**:
  1. 対象日のシリアル日付 $D_{target} = \text{CLng}(\text{Int}(T_{selected}))$
  2. `Libreデータ` から $\text{Int}(t_i) = D_{target}$ となる全レコードを配列抽出。
  3. **統計値計算**:
     - 測定点数: $N = \sum 1$（正常時: 最大96ポイント）
     - 日次平均血糖値:
       $$\bar{G}_{daily} = \text{Round}\left(\frac{\sum_{i=1}^N G_i}{N}, 0\right)$$
     - サマリカード（C9:E10）に `xxx mg/dL` を設定。
     - $N = 0$ の場合は `- mg/dL` をフォールバック表示。

---

### 3.2 24時間血糖散布図グラフ (XY Scatter Chart)
- **概要**: 0:00〜24:00の24時間における血糖推移を滑らかな散布図折れ線として可視化します。
- **対象プロシージャ**: [`DrawDailyGlucoseChart`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modDailyDetail.txt#L913) (`modDailyDetail`)
- **グラフ仕様と座標変換**:
  - **チャート種類**: `xlXYScatterLinesNoMarkers`（マーカーなし散布図）
  - **X軸（時間軸）設定**:
    - 最小値: $D_{target}$ (0:00)
    - 最大値: $D_{target} + 1.0$ (24:00)
    - 目盛間隔: $\frac{2}{24} = \frac{1}{12}$（2時間間隔）
    - 表示形式: `hh:mm`
  - **Y軸（グルコース軸）設定**:
    - 最小値: $30\text{ mg/dL}$
    - 最大値: $350\text{ mg/dL}$
    - 目盛間隔: $50\text{ mg/dL}$
  - **系列1（血糖値曲線）**:
    - X値: `ChartData!A1:A{N}`（日時シリアル値）
    - Y値: `ChartData!B1:B{N}`（グルコース値）
    - 線色: プライマリブルー (`RGB(14, 116, 144)`)、太さ: 2pt

---

### 3.3 食事・異常イベントマーカーのグラフ重畳プロット
- **概要**: 散布図上に食事タイミング（オレンジ丸）、低血糖（青色三角）、高血糖（赤色三角）を垂直ドロップライン付きで重畳表示します。
- **対象プロシージャ**: [`DrawDailyGlucoseChart`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modDailyDetail.txt#L913) (`modDailyDetail`)
- **プロット計算**:
  - マーカー系列のベースY値: 固定値 $Y = 50\text{ mg/dL}$（下部ベースライン）
  - **垂直ガイド線の生成（ErrorBarsの活用）**:
    ```vba
    .HasErrorBars = True
    .ErrorBar Direction:=xlY, Include:=xlPlusValues, Type:=xlFixedValue, amount:=250
    .ErrorBars.Format.Line.DashStyle = msoLineDash
    ```
    - $Y=50$ から $+250$（$Y=300$ 付近まで）破線で伸びるバーを自動描画し、血糖推移線との交差タイミングを視覚化。

---

## 4. 分析画面 (Analysis View)

### 4.1 期間トレンド分析 & 2クラスタ積層グラフ生成
- **概要**: 選択された期間（直近7日/14日/30日/90日/全期間/カスタム）の糖質・インスリン摂取と血糖推移を集計します。
- **対象プロシージャ**: [`AnalyzePeriodTrends`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modAnalysis.txt#L954) (`modAnalysis`)
- **集計・配置ロジック**:
  - 対象期間の開始日 $D_{start}$ と終了日 $D_{end}$ を特定。
  - 各日について食事タイミング別に集計:
    - 糖質: 朝食 (Col C), 昼食 (Col D), 夕食 (Col E), 間食 (Col F)
    - インスリン: 朝食 (Col G), 昼食 (Col H), 夕食 (Col I), 就寝前 (Col J)
  - **2軸積層縦棒グラフ（`xlColumnStacked`）**:
    - 第1主軸 (Primary Y): 糖質量 ($g$)
    - 第2主軸 (Secondary Y): インスリン量 ($\text{単位}$)

---

### 4.2 時間帯別 血糖異常（低血糖・高血糖）集計
- **概要**: 1日を4つの生活時間帯に区分し、低血糖・高血糖の発生頻度と割合を分析します。
- **対象プロシージャ**: [`AnalyzePeriodTrends`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modAnalysis.txt#L954) (`modAnalysis`)
- **時間帯スロット定義**:
  | スロット番号 | 名称 | 対象時刻範囲 | 主な生活行動 |
  | :---: | :--- | :---: | :--- |
  | **Slot 1** | 朝 | 06:00 〜 11:59 | 起床・朝食後 |
  | **Slot 2** | 昼 | 12:00 〜 17:59 | 昼食・日中活動 |
  | **Slot 3** | 夕・夜 | 18:00 〜 23:59 | 夕食・リラックス |
  | **Slot 4** | 深夜 | 00:00 〜 05:59 | 睡眠中（夜間低血糖監視） |
- **集計式**:
  - スロット内発生比率:
    $$\text{Ratio}(s) = \frac{\text{Count}_{low}(s) + \text{Count}_{high}(s)}{\sum_{k=1}^4 (\text{Count}_{low}(k) + \text{Count}_{high}(k))} \times 100\%$$

---

### 4.3 選択食品の血糖影響分析 (Food Impact Analysis)
- **概要**: 指定した食品（例: 「白米」「うどん」）の摂取履歴から、食前食後血糖値および血糖上昇幅を統計計算します。
- **対象プロシージャ**: [`AnalyzeSelectedFood`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modAnalysis.txt#L243) (`modAnalysis`)
- **計算式**:
  1. **平均食前血糖値**:
     $$\bar{G}_{pre} = \frac{\sum_{i=1}^{M_{pre}} G_{pre, i}}{M_{pre}}$$
  2. **平均食後血糖値**:
     $$\bar{G}_{post} = \frac{\sum_{i=1}^{M_{post}} G_{post, i}}{M_{post}}$$
  3. **平均血糖上昇幅 ($\Delta BG$)**:
     $$\Delta BG = \bar{G}_{post} - \bar{G}_{pre}$$
     - $\Delta BG \ge 0$ の場合は表示形式 `+XX mg/dL`、負の場合は `-XX mg/dL`。
  4. **直近3件の履歴テーブル出力**:
     日付, 時刻, 食事区分, 食品名, 摂取量, 糖質量(g), 投与インスリン, 食前/食後血糖, 血糖上昇幅

---

### 4.4 曜日別傾向分析 (Weekday Trends)
- **概要**: 月曜日〜日曜日（7曜日）ごとの糖質・インスリン・異常血糖発生の規則性を分析します。
- **対象プロシージャ**: [`AnalyzeWeekdayTrends`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modAnalysis.txt#L643) (`modAnalysis`)
- **集計マトリクス**:
  - `Weekday(evDate, vbSunday)` により $w \in \{1: \text{日}, 2: \text{月}, \dots, 7: \text{土}\}$ に分類。
  - 表示順: 月・火・水・木・金・土・日（週サイクル順）
  - 各曜日の指標:
    $$\text{平均糖質}(w) = \frac{\sum Carb_w}{N_{meal}(w)}, \quad \text{平均インスリン}(w) = \frac{\sum Ins_w}{N_{ins}(w)}$$
    $$\text{異常発生件数}(w) = Count_{low}(w) + Count_{high}(w)$$

---

### 4.5 異常日要因分析 & 自動インサイト生成
- **概要**: 期間内の日を「通常日」「低血糖日」「高血糖日」に分類し、食事・インスリン比率の差異から臨床リスクを判定します。
- **対象プロシージャ**: [`AnalyzeAbnormalDayCharacteristics`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modAnalysis.txt#L1564) (`modAnalysis`)
- **群分け分類基準**:
  - $D_{hypo}$: 期間内で低血糖エピソードが1件以上発生した日
  - $D_{hyper}$: 低血糖がなく、高血糖エピソードが1件以上発生した日
  - $D_{normal}$: 低血糖・高血糖がともに発生しなかった日（目標範囲内）
- **主要臨床指標**:
  - **糖質10gあたりのインスリン比率 ($R_{ins/10g}$)**:
    $$R_{ins/10g} = \left(\frac{\bar{Ins}_{group}}{\bar{Carb}_{group}}\right) \times 10$$
- **自動インサイト推論ロジック**:
  - 高血糖日と通常日の糖質差 $\Delta C = \bar{Carb}_{hyper} - \bar{Carb}_{normal}$
  - 条件分岐:
    1. $D_{hyper} > 0 \land D_{normal} > 0$ かつ $\Delta C > 0$:
       > 「【分析知見】高血糖日は通常日より糖質量が +XX.X g 多い傾向です。食事内容または追加インスリンの調整を検討してください。」
    2. $D_{hyper} > 0 \land D_{normal} > 0$ かつ $\Delta C \le 0$:
       > 「【分析知見】高血糖日の糖質量に大きな差はありません。食事以外の要因（間食・運動不足・インスリンタイミング）の検証を推奨します。」
    3. $D_{hypo} > 0$:
       > 「【分析知見】低血糖日のインスリン比率が高くなっています。食事の糖質量に応じたインスリン単位数の見直しを推奨します。」
    4. 異常日なし:
       > 「【分析知見】期間内の記録は安定しています。現在の食事・インスリン比率を維持してください。」

---

### 4.6 Gemini AI 臨床アドバイス連携
- **概要**: 分析画面で集計された統計指標をプロンプト化し、Gemini API経由で個別化された助言を生成します。
- **対象プロシージャ**: [`GenerateAIDoctorAdvice`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modGeminiAPI.txt#L68), [`RunAIAnalysisFromSheet`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modGeminiAPI.txt#L104) (`modGeminiAPI`)
- **連携パラメータ**:
  - 平均血糖値 ($mg/dL$)
  - 平均糖質摂取量 ($g$)
  - 平均インスリン投与量 ($\text{単位}$)
  - 低血糖発生回数 / 高血糖発生回数
  - 特記事項（「週末に高血糖ピーク傾向」等）
- **通信仕様**:
  - エンドポイント: `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
  - 通信方式: `MSXML2.ServerXMLHTTP.6.0`（非同期・タイムアウト設定: Connect 5s, Send 10s, Receive 15s）
  - UTF-8エンコーディング: `ADODB.Stream` によるBOMなしバイナリ変換

---

## 5. 設定画面 (Settings Modal)

### 5.1 血糖値判定閾値の管理
- **概要**: 臨床閾値を動的に取得し、システム全体で統一した判定基準を提供します。
- **対象プロシージャ**: [`GetHypoThreshold`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modSettings.txt#L9), [`GetHyperThreshold`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modSettings.txt#L28) (`modSettings`)
- **取得先セル**:
  - 低血糖閾値: `Sheets("設定").Range("D7").Value`（デフォルト: 70.0）
  - 高血糖閾値: `Sheets("設定").Range("D8").Value`（デフォルト: 180.0）

---

### 5.2 異常値ログの全データ再判定（リバリュエーション）
- **概要**: ユーザーが設定画面で目標閾値を変更した際、過去全期間のリブレ生データに対してエピソード抽出を再実行し、画面を同期します。
- **対象プロシージャ**: [`ReevaluateAllAbnormalEvents`](file:///c:/Users/PC05/Documents/VBA/課題/anti_test/vba_exported/modSettings.txt#L94) (`modSettings`)
- **不変性保護 & 再計算フロー**:
  1. **手動記録の保護**: `イベント記録` シート内の「食事」「活動」レコードをメモリに退避。
  2. **自動ログの全消去**: 種別が「血糖値異常」「低血糖」「高血糖」の行のみをクリア。
  3. **再抽出実行**: 新閾値で `modAbnormalEvents.ExtractGlucoseAbnormalEvents(True)` を実行。
  4. **全画面再計算**:
     - `modDailyDetail.SortEventLogSheet`（日付・時刻順ソート）
     - `modCalendar.UpdateCalendarData`（カレンダー再描画）
     - `modAnalysis.UpdateAllAnalysis`（分析画面再集計）

---

## 6. まとめ・計算処理一覧対照表

| 大分類 (画面/コンテキスト) | 小分類 (機能) | 主な計算・処理内容 | 入力データ | 出力先 / 反映UI |
| :--- | :--- | :--- | :--- | :--- |
| **共通基盤** | CSVインポート & パージ | 3年経過データの自動削除、シリアル日時変換 | 外部CSV | `Libreデータ` シート |
| **共通基盤** | 異常値抽出エンジン | 連続エピソード判定、継続時間、極値算出 | `Libreデータ` C/E列 | `イベント記録` シート |
| **共通基盤** | 食前・食後血糖補完 | 前後15分以内の最寄りグルコース探索 | 食事日時, `Libreデータ` | `イベント記録` I/J列 |
| **カレンダー** | 月次日別サマリ集計 | 42日間の日別血糖合計・平均値・測定点数 | `Libreデータ` C/E列 | カレンダー各日セル |
| **カレンダー** | スパークライン展開 | 1日最大96点のグルコース推移配列出力 | `Libreデータ` C/E列 | `SparklineData` シート |
| **カレンダー** | アラートアイコン判定 | 低血糖▼/高血糖▲の発生有無と回数判定 | `イベント記録` | カレンダー各日セル |
| **カレンダー** | サイドバーリアルタイム集計 | キャッシュ走査による選択日平均血糖値算出 | `SparklineData` | サイドバー Q4:V25 |
| **日次詳細** | 当日統計カード計算 | 1日の平均血糖値、測定回数、総糖質・インスリン | `Libreデータ`, `イベント記録` | サマリカード C8:O10 |
| **日次詳細** | 24時間血糖散布図描画 | XY散布図（0〜24時、30〜350 mg/dL）生成 | `ChartData` A/B列 | 散布図グラフ Chart 19 |
| **日次詳細** | イベントマーカープロット | 垂直破線（ErrorBars +250）付きイベント表示 | `ChartData` D〜K列 | 散布図グラフ Chart 19 |
| **分析** | 期間トレンド積層グラフ | 日別タイミング別糖質・インスリンの2軸積層 | `イベント記録` | 積層グラフ ChartCarbInsCombined |
| **分析** | 時間帯別異常値集計 | 4スロット（朝/昼/夕夜/深夜）別発生回数・比率 | `イベント記録` | 集計テーブル C46:G51 |
| **分析** | 選択食品血糖影響分析 | 食前・食後血糖差（$\Delta BG$）、直近3回履歴 | `食事明細`, `イベント記録` | サマリカード & 履歴テーブル |
| **分析** | 曜日別傾向分析 | 月〜日の平均糖質・インスリン・異常頻度 | `イベント記録` | 曜日別テーブル O7:S13 |
| **分析** | 異常日要因分析 | 通常/低血糖/高血糖日の糖質10g比率、インサイト | `イベント記録` | 要因分析表 & インサイト枠 |
| **分析** | Gemini AI 臨床助言 | 統計値をプロンプト化、API経由で助言取得 | 各種集計値 | インサイト枠 C21 |
| **設定** | 閾値管理 & 全データ再判定 | 閾値変更に伴う手動データ保護＋自動抽出再実行 | `設定` D7/D8 | 全画面（カレンダー/詳細/分析） |
