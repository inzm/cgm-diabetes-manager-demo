# システム詳細仕様 & 包括的統合テストプラン (SYSTEM_SPEC_AND_TEST_PLAN.md)

本ドキュメントは、Excel VBA 血糖値・食事・インスリン管理システムにおける**画面デザインの統一仕様**、**全UIボタン・操作要素のアクション仕様**、および**網羅的テスト計画**を定義したものです。

---

## 1. デザイン統一仕様（共通デザインシステム）

### 1.1 グローバル・ナビゲーションバー仕様
全6画面（カレンダー、日次詳細、分析、食品管理、イベント管理、設定）の上部ヘッダーを以下の共通ルールで統一します。

| 要素 | 配置・座標 | スタイル仕様 |
| :--- | :--- | :--- |
| **戻るボタン**（カレンダー以外） | `Left: 20pt`, `Top: 12pt`, `Width: 130pt`, `Height: 26pt` | 背景: `#EFF6FF`（淡い青）、枠線: `#93C5FD`、文字: `#1E3A8A`（濃紺、9pt Bold）<br>表記: `← カレンダーに戻る`、Action: 各画面の `NavToCalendar` |
| **画面タイトル** | `Left: 180pt`, `Top: 10pt`, `Font: 14pt Bold` | カラー: `#1E3A8A`（プライマリネイビー） |
| **右側ナビゲーションタブ** | `Top: 10pt`, `Height: 28pt`, `Width: 95pt`<br>間隔: `8pt`（全4タブ共通） | ・非アクティブ: 背景 `#FFFFFF`、枠線 `#CBD5E1`、文字 `#334155`<br>・アクティブ: 背景 `#0284C7`（鮮快青）、枠線なし、文字 `#FFFFFF`（白・Bold） |

#### 統一ナビゲーションタブ配置（右寄せ）:
1. `nav_tab_event` : **イベント管理** (`modUITheme.NavToEventManagement`)
2. `nav_tab_food` : **食品管理** (`modUITheme.NavToFoodManagement`)
3. `nav_tab_analysis` : **分析** (`modUITheme.NavToAnalysis`)
4. `nav_tab_settings` : **⚙ 設定** (`modSettings.ShowSettings`)

---

## 2. 全画面ボタン・操作要素の仕様総点検

### ① カレンダー画面
| シェイプ/要素 | 表記・種別 | 期待される動作（仕様） | 割り当てマクロ (OnAction) | 現状ステータス |
| :--- | :--- | :--- | :--- | :---: |
| `Rounded Rectangle 1` | `◀ 先月` | カレンダーを1ヶ月前へ更新 | `modCalendar.ShowPrevMonth` | 正常 |
| `Rounded Rectangle 3` | `今月` | カレンダーを当月へ更新 | `modCalendar.ShowCurrentMonth` | 正常 |
| `Rounded Rectangle 2` | `次月 ▶` | カレンダーを1ヶ月先へ更新 | `modCalendar.ShowNextMonth` | 正常 |
| `nav_tab_event` | `イベント管理` | イベント管理画面へ遷移 | `modUITheme.NavToEventManagement` | 正常 |
| `nav_tab_food` | `食品管理` | 食品管理画面へ遷移 | `modUITheme.NavToFoodManagement` | 正常 |
| `nav_tab_analysis` | `分析` | 分析ダッシュボードへ遷移 | `modUITheme.NavToAnalysis` | 正常 |
| `nav_tab_settings` | `⚙ 設定` | 設定画面へ遷移 | `modSettings.ShowSettings` | 正常 |
| `btnFoodEdit` | `✏️` (サイドバー) | 選択日の食事情報編集フォームを開く | `frmAddMealEvent.InitEditMode` | ⚠️ **未設定(要修正)** |
| `btnQuickActivityCal` | `＋ 活動を記録` | 選択日の活動実績登録ダイアログを開く | `modDailyDetail.OpenQuickActivityDialog` | 正常 |
| `btnCatAdd` | `詳細を見る ➜` | 選択日の日次詳細画面へ遷移 | `modCalendar.ShowDailyDetail` | 正常 |
| `ToggleButton1` | (残骸ActiveX) | なし（不要なコントロール） | なし | ⚠️ **残骸(要削除)** |
| 日付セル (B6:O35) | Wクリック | 食事登録フォームを開く | `Worksheet_BeforeDoubleClick` | 正常 |
| スパークライン | Wクリック | 当日の日次詳細グラフへジャンプ | `Worksheet_BeforeDoubleClick` | 正常 |

### ② 日次詳細画面
| シェイプ/要素 | 表記・種別 | 期待される動作（仕様） | 割り当てマクロ (OnAction) | 現状ステータス |
| :--- | :--- | :--- | :--- | :---: |
| `Rounded Rectangle 6` | `← カレンダーに戻る` | カレンダー画面へ遷移 | `modDailyDetail.ShowCalendarFromDetail` | 正常（位置調整要） |
| `btnPrevDay` | `◀ 前日` | 前日の日次詳細画面を表示 | `modDailyDetail.ShowPrevDay` | 正常 |
| `btnToday` | `今日` | 当日の日次詳細画面を表示 | `modDailyDetail.ShowToday` | 正常 |
| `btnNextDay` | `翌日 ▶` | 翌日の日次詳細画面を表示 | `modDailyDetail.ShowNextDay` | 正常 |
| `nav_tab_event` | `イベント管理` | イベント管理画面へ遷移 | `modUITheme.NavToEventManagement` | 正常（スタイル調整要） |
| `nav_tab_food` | `食品管理` | 食品管理画面へ遷移 | `modUITheme.NavToFoodManagement` | 正常（スタイル調整要） |
| `nav_tab_analysis` | `分析` | 分析ダッシュボードへ遷移 | `modUITheme.NavToAnalysis` | 正常（スタイル調整要） |
| `nav_tab_settings` | `⚙ 設定` | 設定画面へ遷移 | `modSettings.ShowSettings` | ⚠️ **未配置(要追加)** |
| `btnQuickActivityDetail` | `＋ 活動を記録` | 表示日の活動実績登録ダイアログを開く | `modDailyDetail.OpenQuickActivityDialog` | 正常 |

### ③ 分析画面
| シェイプ/要素 | 表記・種別 | 期待される動作（仕様） | 割り当てマクロ (OnAction) | 現状ステータス |
| :--- | :--- | :--- | :--- | :---: |
| `nav_back` | `← カレンダーに戻る` | カレンダー画面へ遷移 | `modUITheme.NavToCalendar` | 正常 |
| `btnRefreshAnalysis` | `🔄 分析更新` | 全分析（食品・特徴・曜日・推移）を再計算 | `modAnalysis.UpdateAllAnalysis` | 正常 |
| `nav_tab_event` | `イベント管理` | イベント管理画面へ遷移 | `modUITheme.NavToEventManagement` | 正常 |
| `nav_tab_food` | `食品管理` | 食品管理画面へ遷移 | `modUITheme.NavToFoodManagement` | 正常 |
| `nav_tab_analysis` | `分析` | （現在のアクティブ画面） | `modUITheme.NavToAnalysis` | 正常 |
| `nav_tab_settings` | `⚙ 設定` | 設定画面へ遷移 | `modSettings.ShowSettings` | 正常 |
| `C6` セル | 食品選択 | 対象食品のインスリン・血糖インパクトを即時更新 | `Worksheet_Change` | 正常 |

### ④ 設定画面
| シェイプ/要素 | 表記・種別 | 期待される動作（仕様） | 割り当てマクロ (OnAction) | 現状ステータス |
| :--- | :--- | :--- | :--- | :---: |
| `btnBackCal` | `← カレンダーに戻る` | カレンダー画面へ遷移 | `modSettings.ShowCalendarFromSettings` | 正常 |
| `nav_tab_event` | `イベント管理` | イベント管理画面へ遷移 | `modEventMaster.ShowEventManagement` | 正常 |
| `nav_tab_food` | `食品管理` | 食品管理画面へ遷移 | `modFoodMaster.ShowFoodManagement` | 正常 |
| `nav_tab_analysis` | `分析` | 分析ダッシュボードへ遷移 | `modAnalysis.ShowAnalysis` | 正常 |
| `nav_tab_settings` | `⚙ 設定` | （現在のアクティブ画面） | `modSettings.ShowSettings` | 正常 |
| `btnSaveSettings` | `設定を保存して反映` | 閾値バリデーション・保存・各画面への即時反映 | `modSettings.SaveSettingsFromSheet` | 正常 |

### ⑤ 食品管理画面 & ⑥ イベント管理画面
| シェイプ/要素 | 表記・種別 | 期待される動作（仕様） | 割り当てマクロ (OnAction) | 現状ステータス |
| :--- | :--- | :--- | :--- | :---: |
| 戻るボタン | `← カレンダーに戻る` | カレンダー画面へ遷移 | `modFoodManagement.OnBackToCalendarClick` 等 | 正常 |
| ナビゲーションタブ | イベント/食品/分析/設定 | 他管理画面への直接ジャンプ | なし | ⚠️ **未配置(要追加)** |
| 新規追加ボタン | `＋ 新規追加` | 食品/イベント登録フォームを開く | 各管理モジュール | 正常 |
| 編集ボタン（各行） | `✏️` | 該当レコードの編集フォームを開く | 各管理モジュール | 正常 |
| 検索枠 (D7) | テキスト入力 | 一覧の動的インクリメンタルフィルタ | `Worksheet_Change` | 正常 |

---

## 3. テスト計画 & 実施項目 (Test Plan)

| テストID | 対象画面 | テスト操作内容 | 合格基準 |
| :---: | :--- | :--- | :--- |
| **TP-01** | 全画面 | ヘッダーの各タブ（イベント、食品、分析、設定）をクリック | 該当画面へ正しく遷移し、アクティブタブがハイライトされること |
| **TP-02** | 全画面 | `← カレンダーに戻る` をクリック | カレンダー画面へ確実に復帰すること |
| **TP-03** | カレンダー | サイドバーの「✏️」ボタンをクリック | 選択日の食事・イベント編集ダイアログが起動すること |
| **TP-04** | カレンダー | 不要なActiveXボタン（`ToggleButton1`）の完全消去 | 余分な矩形が描画されないこと |
| **TP-05** | カレンダー | 「＋ 活動を記録」をクリック | 当日日付が初期選択された活動登録フォームが起動し、記録後にカレンダーが更新されること |
| **TP-06** | 日次詳細 | 「＋ 活動を記録」をクリック | 表示日日付の活動登録フォームが起動し、記録後に日次詳細が更新されること |
| **TP-07** | 日次詳細 | 「前日」「今日」「翌日」ボタンをクリック | グラフと各サマリーカードの日付・データが連動して切り替わること |
| **TP-08** | 分析 | 「🔄 分析更新」をクリック | 食品別、曜日別、低血糖・高血糖特徴、推移グラフがすべてエラーなく再描画されること |
| **TP-09** | 設定 | 閾値を変更（例: 低血糖=75, 高血糖=190）して保存 | バリデーションが動作し、カレンダーの凡例テキストとアラート基準が連動更新されること |
| **TP-10** | 自動検証 | safe_excel_runner による全マクロ順次自動実行 | 全プロシージャが実行時エラーおよびハングなしで正常終了（Exit Code 0）すること |
