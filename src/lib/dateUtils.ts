/**
 * ローカルタイムゾーン & ウォールクロック日時操作ユーティリティ (Single Source of Truth)
 *
 * 本システムでは、FreeStyleリブレCSVおよび手動記録の日時を
 * ウォールクロック（端末ローカル時刻そのままの見た目）の ISO 文字列
 * `"YYYY-MM-DDTHH:mm:00.000Z"` として統一保持する。
 * `new Date(...).toISOString()` による UTC -9時間ズレや、
 * `new Date(iso).getHours()` / `getDay()` による +9時間ズレを防止するため、
 * すべての日時生成・抽出・差分計算は本モジュールを経由する。
 */

/**
 * Dateオブジェクトからローカルタイムゾーン基準の YYYY-MM-DD を返す
 */
export function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 当日のローカル日付文字列 (YYYY-MM-DD) を返す
 */
export function getTodayLocalDateStr(): string {
  return formatLocalDate(new Date());
}

/**
 * 現在時刻のローカル時刻文字列 (HH:mm) を返す
 */
export function getCurrentLocalTimeStr(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * YYYY-MM-DD 文字列に対して指定日数を加減算した YYYY-MM-DD を返す (タイムゾーンズレなし)
 */
export function shiftLocalDateStr(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return dateStr;
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  return formatLocalDate(dt);
}

/**
 * 日付 (YYYY-MM-DD) と時刻 (HH:mm) からウォールクロック ISO 文字列を生成する
 * 例: ("2026-10-27", "12:30") -> "2026-10-27T12:30:00.000Z"
 */
export function buildWallClockIso(dateStr: string, timeStr: string): string {
  const cleanDate = dateStr.trim().slice(0, 10);
  const cleanTime = timeStr.trim().slice(0, 5);
  return `${cleanDate}T${cleanTime}:00.000Z`;
}

/**
 * ISO 文字列から日付部分 (YYYY-MM-DD) を抽出する
 */
export function extractDateStr(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * ISO 文字列から時刻部分 (HH:mm) を抽出する
 */
export function extractTimeStr(iso: string): string {
  if (iso.includes('T') && iso.length >= 16) {
    return iso.slice(11, 16);
  }
  return '00:00';
}

/**
 * ISO 文字列からウォールクロックの時 (0〜23) を抽出する
 */
export function extractHour(iso: string): number {
  if (iso.includes('T') && iso.length >= 13) {
    const h = parseInt(iso.slice(11, 13), 10);
    return isNaN(h) ? 0 : h;
  }
  return 0;
}

/**
 * YYYY-MM-DD または ISO 文字列から曜日番号 (0:日曜 〜 6:土曜) をタイムゾーンズレなく返す
 */
export function getDayOfWeekFromDateStr(dateOrIso: string): number {
  const [y, m, d] = dateOrIso.slice(0, 10).split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return 0;
  return new Date(y, m - 1, d).getDay();
}

/**
 * ウォールクロック ISO 文字列 ("YYYY-MM-DDTHH:mm:ss" または ".000Z" 付き) を
 * タイムゾーン非依存のミリ秒値に変換する（イベント間の分数差計算用）
 */
export function parseWallClockMs(iso: string): number {
  const match = iso
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) {
    const fallback = new Date(iso).getTime();
    return isNaN(fallback) ? 0 : fallback;
  }
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const min = parseInt(match[5], 10);
  const sec = parseInt(match[6] || '0', 10);
  return Date.UTC(year, month, day, hour, min, sec);
}

/**
 * AGENTS.md §8.3 準拠の標準エイリアス関数群
 */
export const buildLocalDateTimeString = buildWallClockIso;
export const extractLocalDateStr = extractDateStr;
export const extractLocalTimeStr = extractTimeStr;

const JAPANESE_WEEKDAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'] as const;

/**
 * YYYY-MM-DD 文字列から「YYYY年M月D日 (曜)」形式の日本語表記と曜日番号 (0〜6) を返す
 */
export function formatJapaneseDateWithWeekday(dateStr: string): {
  formattedDate: string;
  dayOfWeek: number;
} {
  const clean = dateStr.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    return { formattedDate: dateStr, dayOfWeek: -1 };
  }
  const [y, m, d] = clean.split('-');
  const yearNum = parseInt(y, 10);
  const monthNum = parseInt(m, 10);
  const dayNum = parseInt(d, 10);
  const utcMs = Date.UTC(yearNum, monthNum - 1, dayNum);
  if (isNaN(utcMs)) {
    return { formattedDate: dateStr, dayOfWeek: -1 };
  }
  const dayOfWeek = new Date(utcMs).getUTCDay();
  const formattedDate = `${yearNum}年 ${monthNum}月 ${dayNum}日 (${JAPANESE_WEEKDAY_NAMES[dayOfWeek]})`;
  return { formattedDate, dayOfWeek };
}

