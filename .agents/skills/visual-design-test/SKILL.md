---
name: visual-design-test
description: Playwrightで全主要画面をデスクトップ(1280x800)とモバイル(375x812)で自動撮影し、DOMレイアウト監査と画像の目視確認でデザインを検査する。UI・スタイル・レイアウトを変更したときや、デザインレビュー時に使う。
---

# visual-design-test

目的: UI変更後に、撮影・DOM監査・画像確認で表示品質を検査する。

## 撮影対象
`npm run test:visual` が e2e/visual-design.spec.ts をポートフォリオビルドに対して実行し、11枚を .agents/scratch/screenshots/ に出力する。同時に visual-audit-report.json を生成する。

| ファイル名 | 画面・状態 | ビューポート |
| :--- | :--- | :--- |
| 01-calendar-desktop.png | カレンダー月間グリッド・選択日サマリー | 1280x800 |
| 02-daily-drawer-desktop.png | 日次詳細ドロワー・24H血糖推移グラフ | 1280x800 |
| 03-meal-modal-desktop.png | 食事・インスリン記録モーダル | 1280x800 |
| 04-analysis-desktop.png | 臨床データ分析ダッシュボード | 1280x800 |
| 05-food-activity-desktop.png | よく使う食品・活動の管理画面 | 1280x800 |
| 06-category-modal-desktop.png | 食品カテゴリ管理モーダル | 1280x800 |
| 07-settings-desktop.png | 設定・目標範囲・データ管理 | 1280x800 |
| 08-calendar-mobile.png | カレンダー | 375x812 |
| 09-daily-drawer-mobile.png | 日次詳細ドロワー | 375x812 |
| 10-analysis-mobile.png | 臨床データ分析 (横スクロールなしを検証) | 375x812 |
| 11-food-activity-mobile.png | よく使う食品・活動の管理 | 375x812 |

## 手順
1. 撮影と監査を実行する。
   ```powershell
   npm run build:portfolio; npm run test:visual
   ```
2. read_file で .agents/scratch/screenshots/visual-audit-report.json を読み、全画面で次を確認する。
   - hasHorizontalOverflow === false
   - exposedJargon.length === 0 (マスタ / IndexedDB / Dexie / Web Worker などの露出なし)
   - runtimeErrors.length === 0 (console.error と未キャッチ例外なし)
3. 変更した画面の PNG を read_file で開き、患者・家族の目線で次を確認する。
   - 文字切れ・重なり・折り返し崩れがない (ボタン、バッジ、表の見出し、EChartsの軸ラベルと凡例)。
   - 主役 (血糖値・異常値・合計糖質・保存ボタン) が際立ち、補助情報が控えめである。
   - 見れば分かる説明文や不要な枠線・二重バッジがない。
   - モバイル (375x812) でボトムナビと閉じるボタンが押しやすく、窮屈でない。
4. ユーザーに結果を報告するときは、PNG を Artifact ディレクトリへコピーして Markdown のカルーセル等で示す。
