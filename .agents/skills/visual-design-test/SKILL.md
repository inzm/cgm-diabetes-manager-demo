---
name: visual-design-test
description: >-
  Playwrightによる全主要画面・モーダルのデスクトップ(1280x800)＆モバイル(375x812)自動スクリーンショット撮影、DOMレイアウト監査（横スクロール・開発者用語混入・コンソールエラー検知）、およびAIマルチモーダル画像認識によるデザイン・視認性テストを実行するスキル。UI・スタイル・レイアウト修正時やデザインレビュー時に必ず使用する。
---

# スクリーンショット自動撮影 & マルチモーダルデザイン検証スキル (`visual-design-test`)

このスキルは、UIコンポーネントやスタイル（Tailwind CSS / ECharts / モーダル / ドロワー）を変更した際、Playwright で全主要画面のスクリーンショットを自動撮影し、DOM計測とAIの画像認識（マルチモーダル視覚検査）を組み合わせてデザイン品質を100%保証するための標準手順です。

---

## 1. 撮影される画面一覧（Desktop `1280x800` & Mobile `375x812`）

`npm run test:visual` を実行すると、[`e2e/visual-design.spec.ts`](../../../e2e/visual-design.spec.ts) がポートフォリオビルドに対して以下の11枚のスクリーンショットを `.agents/scratch/screenshots/` に出力し、同時に `visual-audit-report.json` を生成します：

| ファイル名 | 画面・状態 | ビューポート |
| :--- | :--- | :--- |
| `01-calendar-desktop.png` | カレンダー月間グリッド＆選択日サマリー | `1280x800` |
| `02-daily-drawer-desktop.png` | 日次詳細ドロワー＆24H血糖推移グラフ | `1280x800` |
| `03-meal-modal-desktop.png` | 食事・インスリン記録モーダル | `1280x800` |
| `04-analysis-desktop.png` | 4大臨床データ分析ダッシュボード | `1280x800` |
| `05-food-activity-desktop.png` | よく使う食品・活動管理画面 | `1280x800` |
| `06-category-modal-desktop.png` | 食品カテゴリ管理モーダル | `1280x800` |
| `07-settings-desktop.png` | 設定・目標範囲・データ管理画面 | `1280x800` |
| `08-calendar-mobile.png` | カレンダー画面（モバイル表示） | `375x812` |
| `09-daily-drawer-mobile.png` | 日次詳細ドロワー（モバイル表示） | `375x812` |
| `10-analysis-mobile.png` | 4大臨床データ分析（モバイル表示・横スクロールゼロ検証） | `375x812` |
| `11-food-activity-mobile.png` | よく使う食品・活動管理（モバイル表示） | `375x812` |

---

## 2. 実行手順 (Step-by-Step Workflow)

### Step 1: ビルド & スクリーンショット自動撮影の実行
以下のコマンドを実行して最新のバンドルを作成し、全画面のスクリーンショット撮影とDOMレイアウト検査を実行します：

```powershell
npm run build:portfolio; npm run test:visual
```

### Step 2: レイアウト監査レポート (`visual-audit-report.json`) の確認
`read_file` で `.agents/scratch/screenshots/visual-audit-report.json` を読み込み、全画面で以下が満たされていることを確認します：
- `hasHorizontalOverflow === false`（モバイルを含む全画面で意図しない横スクロールがゼロ）
- `exposedJargon.length === 0`（「マスタ」「IndexedDB」「Dexie」「Web Worker」等の開発者用語露出がゼロ）
- `runtimeErrors.length === 0`（`console.error` および未キャッチ例外がゼロ）

### Step 3: AIマルチモーダル視覚検査 (`read_file` による画像直接確認)
変更した画面に対応する `.agents/scratch/screenshots/*.png` を `read_file` ツールで直接読み込み、人間の目線（患者・家族目線）で以下の5点を視覚チェックします：
1. **文字切れ・重なり・折り返し崩れがないか**: ボタンラベル、バッジ、テーブル見出し、EChartsの軸ラベルや凡例が重なっていないか。
2. **視覚的メリハリ（主役と脇役）**: 主役（血糖値・異常値・合計糖質・保存ボタン）が明確に際立ち、補助情報が控えめになっているか。
3. **引き算の法則の遵守**: 見れば分かる冗長な説明文や不要な枠線・二重バッジが画面を圧迫していないか。
4. **モバイルでのタップ領域と余白**: モバイル画面（`375x812`）でボトムナビゲーションやドロワーの閉じるボタンが押しやすく、窮屈になっていないか。
5. **ユーザーへの提示（必要時）**: ユーザーへ視覚的な変更結果を報告する際は、撮影した `.png` を Artifact ディレクトリへコピーして Markdown カルーセル等で提示する。

