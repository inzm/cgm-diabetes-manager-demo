import {
  DEFAULT_HYPER_THRESHOLD,
  DEFAULT_HYPO_THRESHOLD,
  HealthEvent,
  LibreReading,
} from '@/types/database';
import { extractDateStr, extractHour, getTodayLocalDateStr } from './dateUtils';
import { extractAnomalyEventsFromReadings } from './anomalyExtractor';

/** カレンダーの日別カードに渡す集計データ */
export interface DailyAggregatedData {
  date: string; // YYYY-MM-DD
  dayNumber: number;
  isCurrentMonth: boolean;
  isToday: boolean;

  // 血糖サマリー
  recordCount: number;
  avgGlucose: number | null;
  minGlucose: number | null;
  maxGlucose: number | null;
  tirPercent: number | null; // 目標範囲内の割合 (%)

  // ライフログ合計
  totalCarbs: number; // 糖質 (g)
  totalInsulin: number; // インスリン (単位: 食事 + 活動・持効型合算)
  mealCount: number;
  insulinCount: number;

  // 異常値発生回数 (エピソード件数)
  hypoCount: number;
  hyperCount: number;
  spikeCount: number;

  // 24H推移スパークライン用データ (24時間バケット平均)
  sparklineData: (number | null)[];
}

/** 選択日サマリーカードに表示する詳細情報 */
export interface SelectedDaySummaryData {
  date: string; // YYYY-MM-DD
  avgGlucose: number | null;
  totalCarbs: number;
  totalInsulin: number;
  hypoCount: number;
  hyperCount: number;
  // 内訳
  carbsBreakdown: {
    breakfast: number;
    lunch: number;
    dinner: number;
    snack: number;
  };
  insulinBreakdown: {
    bolus: number; // 食事時 (超速効)
    basal: number; // 単体・持効型
  };
  tirPercent: number | null;
}

/** 月間全体統計サマリー */
export interface MonthlyOverallKpi {
  avgGlucose: number | null;
  tirPercent: number | null;
  cvPercent: number | null;
  activeDays: number;
  totalDays: number;
  totalRecords: number;
  coveragePercent: number | null;
}

/**
 * 指定された年月の42マス（日〜土）の日付リストを生成 (ローカルタイムゾーン基準)
 */
export function getCalendarGridDays(year: number, month: number): {
  date: string; // YYYY-MM-DD
  dayNumber: number;
  isCurrentMonth: boolean;
  isToday: boolean;
}[] {
  const result: { date: string; dayNumber: number; isCurrentMonth: boolean; isToday: boolean }[] = [];
  const todayStr = getTodayLocalDateStr();

  const firstDayOfMonth = new Date(year, month - 1, 1);
  const lastDayOfMonth = new Date(year, month, 0);
  const firstDayWeekday = firstDayOfMonth.getDay();

  // 前月のはみ出し日数
  const prevMonthLastDay = new Date(year, month - 1, 0).getDate();
  for (let i = firstDayWeekday - 1; i >= 0; i--) {
    const day = prevMonthLastDay - i;
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const dateStr = `${prevYear}-${String(prevMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    result.push({
      date: dateStr,
      dayNumber: day,
      isCurrentMonth: false,
      isToday: dateStr === todayStr,
    });
  }

  // 当月の日付
  for (let day = 1; day <= lastDayOfMonth.getDate(); day++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    result.push({
      date: dateStr,
      dayNumber: day,
      isCurrentMonth: true,
      isToday: dateStr === todayStr,
    });
  }

  // 翌月のはみ出し日付 (合計42マス = 6週間 になるまで埋める)
  const remainingDays = 42 - result.length;
  for (let day = 1; day <= remainingDays; day++) {
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const dateStr = `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    result.push({
      date: dateStr,
      dayNumber: day,
      isCurrentMonth: false,
      isToday: dateStr === todayStr,
    });
  }

  return result;
}

/**
 * 取得したリブレレコード・イベントデータから日別集計マップを作成
 * 異常値件数 (hypoCount / hyperCount) は、イベントテーブルの「低血糖」「高血糖」エピソード件数と統一する
 */
export function aggregateMonthlyData(
  gridDays: { date: string; dayNumber: number; isCurrentMonth: boolean; isToday: boolean }[],
  readings: LibreReading[],
  events: HealthEvent[],
  hypoThreshold = DEFAULT_HYPO_THRESHOLD,
  hyperThreshold = DEFAULT_HYPER_THRESHOLD
): Map<string, DailyAggregatedData> {
  const map = new Map<string, DailyAggregatedData>();

  const readingsByDate = new Map<string, LibreReading[]>();
  const glucoseByDate = new Map<string, number[]>();
  const glucoseHourlyByDate = new Map<string, number[][]>();

  readings.forEach((r) => {
    const dateStr = extractDateStr(r.timestamp);
    if (!glucoseByDate.has(dateStr)) {
      readingsByDate.set(dateStr, []);
      glucoseByDate.set(dateStr, []);
      glucoseHourlyByDate.set(dateStr, Array.from({ length: 24 }, () => []));
    }
    readingsByDate.get(dateStr)!.push(r);
    glucoseByDate.get(dateStr)!.push(r.glucose_value);

    const hour = extractHour(r.timestamp);
    if (hour >= 0 && hour < 24) {
      glucoseHourlyByDate.get(dateStr)![hour].push(r.glucose_value);
    }
  });

  const eventsByDate = new Map<string, HealthEvent[]>();
  events.forEach((e) => {
    if (e.is_deleted) return;
    const dateStr = extractDateStr(e.event_datetime);
    if (!eventsByDate.has(dateStr)) eventsByDate.set(dateStr, []);
    eventsByDate.get(dateStr)!.push(e);
  });

  const hasAnyAnomalyEventInSet = events.some(
    (e) => !e.is_deleted && (e.event_type === '低血糖' || e.event_type === '高血糖')
  );

  gridDays.forEach(({ date, dayNumber, isCurrentMonth, isToday }) => {
    const values = glucoseByDate.get(date) || [];
    const hourly = glucoseHourlyByDate.get(date);
    const dayEvents = eventsByDate.get(date) || [];

    let avgGlucose: number | null = null;
    let minGlucose: number | null = null;
    let maxGlucose: number | null = null;
    let tirPercent: number | null = null;

    if (values.length > 0) {
      const sum = values.reduce((acc, v) => acc + v, 0);
      avgGlucose = Math.round(sum / values.length);
      minGlucose = Math.min(...values);
      maxGlucose = Math.max(...values);

      const inRangeCount = values.filter((v) => v >= hypoThreshold && v <= hyperThreshold).length;
      tirPercent = Math.round((inRangeCount / values.length) * 100);
    }

    // 異常値エピソード件数の算出 (日次ドロワーおよび分析画面と100%一致させる)
    let hypoCount = dayEvents.filter((e) => e.event_type === '低血糖').length;
    let hyperCount = dayEvents.filter((e) => e.event_type === '高血糖').length;

    if (!hasAnyAnomalyEventInSet && values.length > 0) {
      const dayReadings = readingsByDate.get(date) || [];
      const extracted = extractAnomalyEventsFromReadings(
        dayReadings,
        dayReadings[0]?.user_id || '',
        hypoThreshold,
        hyperThreshold
      );
      hypoCount = extracted.hypoCount;
      hyperCount = extracted.hyperCount;
    }

    // イベント集計 (食事・インスリン)
    const mealEvents = dayEvents.filter((e) => e.event_type === '食事');
    const totalCarbs = mealEvents.reduce((sum, e) => sum + (e.total_carbs || 0), 0);
    const totalInsulin = dayEvents.reduce((sum, e) => sum + (e.insulin_units || 0), 0);

    const sparklineData: (number | null)[] = hourly
      ? hourly.map((vals) => (vals.length > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null))
      : Array(24).fill(null);

    map.set(date, {
      date,
      dayNumber,
      isCurrentMonth,
      isToday,
      recordCount: values.length,
      avgGlucose,
      minGlucose,
      maxGlucose,
      tirPercent,
      totalCarbs: Math.round(totalCarbs * 10) / 10,
      totalInsulin: Math.round(totalInsulin * 10) / 10,
      mealCount: mealEvents.length,
      insulinCount: dayEvents.filter((e) => (e.insulin_units || 0) > 0).length,
      hypoCount,
      hyperCount,
      spikeCount: 0,
      sparklineData,
    });
  });

  return map;
}

/**
 * 選択日の詳細サマリーデータを算出 (食事インスリン + 単体・持効型インスリンを完全網羅)
 */
export function getSelectedDaySummary(
  targetDate: string,
  dailyData: DailyAggregatedData | undefined,
  events: HealthEvent[]
): SelectedDaySummaryData {
  const dayEvents = events.filter(
    (e) => !e.is_deleted && e.event_datetime.startsWith(targetDate)
  );
  const targetMeals = dayEvents.filter((e) => e.event_type === '食事');
  const otherEvents = dayEvents.filter((e) => e.event_type !== '食事');

  let breakfast = 0;
  let lunch = 0;
  let dinner = 0;
  let snack = 0;
  let bolus = 0;
  let basal = 0;

  targetMeals.forEach((m) => {
    const carbs = m.total_carbs || 0;
    if (m.timing_category === '朝食') breakfast += carbs;
    else if (m.timing_category === '昼食') lunch += carbs;
    else if (m.timing_category === '夕食') dinner += carbs;
    else snack += carbs;

    bolus += m.insulin_units || 0;
  });

  otherEvents.forEach((ev) => {
    basal += ev.insulin_units || 0;
  });

  const computedTotalCarbs = Math.round((breakfast + lunch + dinner + snack) * 10) / 10;
  const computedTotalInsulin = Math.round((bolus + basal) * 10) / 10;
  const hypoEventsCount = dayEvents.filter((e) => e.event_type === '低血糖').length;
  const hyperEventsCount = dayEvents.filter((e) => e.event_type === '高血糖').length;

  return {
    date: targetDate,
    avgGlucose: dailyData?.avgGlucose ?? null,
    totalCarbs: dailyData?.totalCarbs ?? computedTotalCarbs,
    totalInsulin: dailyData?.totalInsulin ?? computedTotalInsulin,
    hypoCount: dailyData?.hypoCount ?? hypoEventsCount,
    hyperCount: dailyData?.hyperCount ?? hyperEventsCount,
    carbsBreakdown: {
      breakfast: Math.round(breakfast * 10) / 10,
      lunch: Math.round(lunch * 10) / 10,
      dinner: Math.round(dinner * 10) / 10,
      snack: Math.round(snack * 10) / 10,
    },
    insulinBreakdown: {
      bolus: Math.round(bolus * 10) / 10,
      basal: Math.round(basal * 10) / 10,
    },
    tirPercent: dailyData?.tirPercent ?? null,
  };
}

/**
 * 月間全体の4大KPIを算出
 */
export function calculateMonthlyOverallKpi(
  year: number,
  month: number,
  readings: LibreReading[],
  hypoThreshold = DEFAULT_HYPO_THRESHOLD,
  hyperThreshold = DEFAULT_HYPER_THRESHOLD
): MonthlyOverallKpi {
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  const monthRecords = readings.filter((r) => r.timestamp.startsWith(monthPrefix));

  if (monthRecords.length === 0) {
    return {
      avgGlucose: null,
      tirPercent: null,
      cvPercent: null,
      activeDays: 0,
      totalDays: new Date(year, month, 0).getDate(),
      totalRecords: 0,
      coveragePercent: null,
    };
  }

  const values = monthRecords.map((r) => r.glucose_value);
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / values.length;

  const variance = values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / values.length;
  const sd = Math.sqrt(variance);
  const cv = mean > 0 ? (sd / mean) * 100 : 0;

  const inRange = values.filter((v) => v >= hypoThreshold && v <= hyperThreshold).length;
  const tir = (inRange / values.length) * 100;

  const activeDates = new Set(monthRecords.map((r) => extractDateStr(r.timestamp)));
  const totalDays = new Date(year, month, 0).getDate();

  const expectedRecords = activeDates.size * 96;
  const coverage = expectedRecords > 0 ? Math.min(100, (values.length / expectedRecords) * 100) : 0;

  return {
    avgGlucose: Math.round(mean),
    tirPercent: Math.round(tir * 10) / 10,
    cvPercent: Math.round(cv * 10) / 10,
    activeDays: activeDates.size,
    totalDays,
    totalRecords: values.length,
    coveragePercent: Math.round(coverage * 10) / 10,
  };
}
