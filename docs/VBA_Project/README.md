# Excel VBA 血糖値・食事・インスリン統合管理システム 仕様書

本ディレクトリ（`docs/`）は、本システム（`main.xlsm`）の実装コード（VBAモジュール群・フォーム群・テーブル構造）を徹底調査・静的解析し、各画面・機能・データモデルの現行仕様を正確に体系化した技術仕様書群です。

---

## 仕様書ドキュメント一覧

| ドキュメント | 対象領域 / 内容 | 主な関連モジュール |
| :--- | :--- | :--- |
| **[全体アーキテクチャ設計書](ARCHITECTURE.md)** | システム全体構造、モジュール責務一覧、データフロー、共通基盤 | 全モジュール, `modCommon`, `modUITheme`, `modMenu` |
| **[データモデル仕様書](SPEC_DATA_MODEL.md)** | 全シート・テーブルの列定義、型、主キー体系、親子整合性制約 | `Sheet1`〜`Sheet14`, `modAbnormalEvents` |
| **[カレンダー画面仕様書](SPEC_CALENDAR.md)** | 月次カレンダー表示、日別セル集計、スパークライン描画、サイドメニュー | `Sheet3`, `modCalendar` |
| **[日次詳細画面仕様書](SPEC_DAILY_DETAIL.md)** | 24時間血糖値推移グラフ、食事・イベントタイムライン、KPIカード | `Sheet4`, `modDailyDetail` |
| **[食品管理画面仕様書](SPEC_FOOD_MANAGEMENT.md)** | 食品マスタ一覧、カテゴリフィルタ、Gemini栄養推定、編集・削除 | `Sheet8`, `modFoodManagement`, `frmAddMealData` |
| **[イベント管理画面仕様書](SPEC_EVENT_MANAGEMENT.md)** | 活動マスタ一覧、カテゴリフィルタ、カード動的拡張、編集・削除 | `Sheet9`, `modEventManagement`, `frmAddEventData` |
| **[分析画面仕様書](SPEC_ANALYSIS.md)** | 月次・期間分析KPI、7大分析ビュー、時間帯別異常値、AI臨床アドバイス | `Sheet11`, `modAnalysis`, `modGeminiAPI` |
| **[設定・外部連携仕様書](SPEC_SETTINGS_INTEGRATION.md)** | 臨床閾値設定、Gemini APIキー管理、Libre生データCSV取込、異常値自動抽出 | `frmSettings`, `modSettings`, `modAbnormalEvents` |

---

## 開発・改修時の留意事項（AGENTS.md抜粋）

1. **文字コード・エンコーディング**: VBAコードおよびエクスポートファイルはすべて **CP932（Shift-JIS）** かつ **CRLF (`\r\n`)**。
2. **テーブル正規化の維持**: `イベント記録` シートは「実施時間(分)」を含む11列構成（A〜K列）。ソートや一括代入時は必ずK列まで含める。
3. **データ不変性**: 異常値イベント（低血糖・高血糖）はリブレ測定値に基づく客観ログのため、手動変更不可。手動管理は「食事」と「活動」に限定。
4. **安全ランナーの活用**: Excel COM を外部実行する際は、必ず `.agents/skills/safe-excel-runner/scripts/safe_excel_runner.py` を経由する。
