---
trigger: model_decision
description: 日時生成・パース・フォーマット・カレンダー日付計算・タイムゾーン正規化 (src/lib/dateUtils.ts, syncEngine.ts, csvParser.worker.ts, 各画面コンポーネント) を編集・監査するときに適用する。
---

# ルール: 24文字ウォールクロック日時・タイムゾーン不変条件 (`wallclock-date`)

## 1. 24文字ウォールクロック ISO 形式の厳守
- すべての臨床記録日時（`event_datetime` / `timestamp`）は **`YYYY-MM-DDTHH:mm:ss.000Z`（24文字固定ウォールクロック ISO、手動記録の秒は `00`）** に統一する。
- 理由:
  1. 日本時間（JST）等のローカル時刻が UTC 変換で `-9時間` ズレて別日の記録になる事故を防ぐため。
  2. Dexie 複合インデックス（`[user_id+event_datetime]`, `[user_id+timestamp]`）の `.between()` 辞書順検索で 24文字境界を完全一致させるため。

## 2. 禁止パターン
- 記録日時（`event_datetime` / `timestamp`）やカレンダー日付・曜日・時間帯の算出に、以下のネイティブ UTC / ローカル混在メソッドを直接使うことを禁止する:
  - `new Date().toISOString().slice(...)` / `.split('T')`（UTC 日付への9時間ズレが発生する）
  - `new Date(iso).getHours()` / `new Date(iso).getDay()` / `new Date(iso).getDate()`
- 例外: レコードの監査・Last-Write-Wins（LWW）競合解決用の実時刻カラム（`created_at` / `updated_at`）に限り、`new Date().toISOString()` の使用を許可する。

## 3. 必須ユーティリティ (`src/lib/dateUtils.ts`)
日時操作は必ず `src/lib/dateUtils.ts` の単一実装を経由し、UI コンポーネント内に独自の日付文字列整形ロジックを重複実装しない。
- ローカル現在日付・時刻・加減算: `formatLocalDate` / `getTodayLocalDateStr` / `getCurrentLocalTimeStr` / `shiftLocalDateStr`
- カレンダーセル・日本語曜日ラベル算出: `formatCalendarDayLabels` / `formatJapaneseDateWithWeekday`
- 日付＋時刻からの24文字ISO構築: `buildWallClockIso`
- 24文字ISOからの切り出し・数値化: `extractLocalDateStr` / `extractLocalTimeStr` / `parseWallClockMs` / `extractHour` / `getDayOfWeekFromDateStr`
- Supabase（`TIMESTAMPTZ`）取得値の24文字正規化: `normalizeToWallClockIso`（タイムゾーンオフセット付きの文字列もローカル壁時計時刻を保持したまま正規化する）
