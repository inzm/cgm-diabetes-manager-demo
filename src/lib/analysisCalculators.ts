import {
  Category,
  DEFAULT_HYPER_THRESHOLD,
  DEFAULT_HYPO_THRESHOLD,
  FoodMaster,
  HealthEvent,
  LibreReading,
  MealDetail,
} from '@/types/database';
import { computeBoundGlucoseForMeal } from './anomalyExtractor';
import {
  extractDateStr,
  extractHour,
  formatLocalDate,
  getDayOfWeekFromDateStr,
  parseWallClockMs,
  shiftLocalDateStr,
} from './dateUtils';

export interface FoodImpactItem {
  id: string; // event id
  eventDatetime: string;
  timingCategory: string;
  foodName: string;
  amountText: string;
  carbs: number;
  totalMealCarbs: number;
  insulinUnits: number;
  preGlucose: number | null;
  peakGlucose: number | null;
  delta: number | null;
  otherFoods: string[];
}

export interface FoodImpactSummary {
  selectedFood: string;
  totalCount: number;
  avgInsulin: number;
  avgPreGlucose: number | null;
  avgPeakGlucose: number | null;
  avgDelta: number | null;
  items: FoodImpactItem[];
}

export interface TimePeriodAnomaly {
  periodName: '朝' | '昼' | '夕・夜' | '夜間・未明';
  timeRange: string;
  hypoCount: number;
  hyperCount: number;
  totalCount: number;
  percentage: number; // 全異常値に対する割合(%)
}

export interface WeekdayTrendItem {
  dayOfWeek: number; // 0 (日) 〜 6 (土)
  dayName: string; // '日', '月', ...
  dateCount: number; // その曜日の日数
  avgCarbs: number; // 1日あたり平均糖質 (g)
  avgInsulin: number; // 1日あたり平均インスリン (U: 食事+単体合算)
  avgGlucose: number | null; // 平均血糖値 (mg/dL)
  anomalyCount: number; // 異常値件数
}

export interface DailyCarbInsulinTrendItem {
  date: string; // YYYY-MM-DD
  totalCarbs: number; // g
  totalInsulin: number; // U (食事+単体合算)
  avgGlucose: number | null; // mg/dL
  anomalyCount: number;
}

/**
 * 期間別集計結果およびスライス済みデータのメモリキャッシュ単位
 */
export interface PeriodAnalysisSlice {
  startDate: string;
  endDate: string;
  events: HealthEvent[];
  readings: LibreReading[];
  mealDetails?: MealDetail[];
  detailsByEventId?: Map<string, MealDetail[]>;
  readingsByDate?: Map<string, LibreReading[]>;
  foodOptions?: string[];
  timeAnomaly: TimePeriodAnomaly[];
  weekdayTrends: WeekdayTrendItem[];
  carbInsulinTrend: DailyCarbInsulinTrendItem[];
  foodImpactCache: Map<string, FoodImpactSummary>;
}

/**
 * 患者単位の軽量境界メタデータ＆マスタキャッシュ（全件toArray不要）
 */
export interface AnalysisBoundaryMetadata {
  patientId: string;
  signature: string;
  earliestDateStr: string;
  referenceDateStr: string;
  availableMonths: string[];
  foodMasters: FoodMaster[];
  foodCategories: Category[];
  masterFoodOptions: string[];
  periodSlices: Map<string, PeriodAnalysisSlice>;
}

/**
 * 患者単位の単一パス日付インデックス＆オンメモリキャッシュ構造
 */
export interface IndexedAnalysisDataset {
  patientId: string;
  signature: string;
  earliestDateStr: string;
  referenceDateStr: string;
  allEvents: HealthEvent[];
  allMealDetails: MealDetail[];
  allReadings: LibreReading[];
  foodMasters: FoodMaster[];
  foodCategories: Category[];
  eventsByDate: Map<string, HealthEvent[]>;
  readingsByDate: Map<string, LibreReading[]>;
  detailsByEventId: Map<string, MealDetail[]>;
  foodOptions: string[];
  periodSlices: Map<string, PeriodAnalysisSlice>;
}

let activeDatasetCache: IndexedAnalysisDataset | null = null;
let activeBoundaryCache: AnalysisBoundaryMetadata | null = null;

/**
 * 最古日〜最新日から選択可能な全年月（YYYY-MM、降順）をO(M)で生成
 */
export function buildAvailableMonthsList(
  earliestDateStr: string,
  referenceDateStr: string
): string[] {
  const startYm = earliestDateStr.slice(0, 7);
  const endYm = referenceDateStr.slice(0, 7);
  if (!startYm || !endYm || startYm.length < 7 || endYm.length < 7) {
    return endYm ? [endYm] : [];
  }

  const [sy, sm] = startYm.split('-').map(Number);
  const [ey, em] = endYm.split('-').map(Number);
  if (isNaN(sy) || isNaN(sm) || isNaN(ey) || isNaN(em)) {
    return [endYm];
  }

  const months: string[] = [];
  let y = ey;
  let m = em;
  while (y > sy || (y === sy && m >= sm)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m--;
    if (m < 1) {
      m = 12;
      y--;
    }
    if (months.length > 120) break;
  }
  return months.length > 0 ? months : [endYm];
}

/**
 * 軽量境界メタデータキャッシュの取得
 */
export function getAnalysisBoundaryCache(
  patientId: string,
  signature?: string
): AnalysisBoundaryMetadata | null {
  if (!activeBoundaryCache || activeBoundaryCache.patientId !== patientId) {
    return null;
  }
  if (signature && activeBoundaryCache.signature !== signature) {
    return null;
  }
  return activeBoundaryCache;
}

/**
 * 軽量境界メタデータキャッシュの構築・保存
 */
export function setAnalysisBoundaryCache(
  patientId: string,
  signature: string,
  earliestDateStr: string,
  referenceDateStr: string,
  foodMasters: FoodMaster[],
  categories: Category[]
): AnalysisBoundaryMetadata {
  const activeFoods = foodMasters.filter((f) => !f.is_deleted);
  const foodCategories = categories
    .filter((c) => !c.is_deleted && c.target_type === 'food')
    .sort((a, b) => a.display_order - b.display_order);

  const foodSet = new Set<string>();
  for (let i = 0; i < activeFoods.length; i++) {
    if (activeFoods[i].food_name) {
      foodSet.add(activeFoods[i].food_name);
    }
  }

  const meta: AnalysisBoundaryMetadata = {
    patientId,
    signature,
    earliestDateStr,
    referenceDateStr,
    availableMonths: buildAvailableMonthsList(earliestDateStr, referenceDateStr),
    foodMasters: activeFoods,
    foodCategories,
    masterFoodOptions: Array.from(foodSet).sort(),
    periodSlices: new Map<string, PeriodAnalysisSlice>(),
  };

  activeBoundaryCache = meta;
  return meta;
}

/**
 * 期間別クエリで取得した局所データから PeriodAnalysisSlice を構築しメモリキャッシュへ保存する
 */
export function buildAndCacheLocalizedPeriodSlice(
  meta: AnalysisBoundaryMetadata,
  startDate: string,
  endDate: string,
  hypoThreshold: number,
  hyperThreshold: number,
  periodEvents: HealthEvent[],
  periodMealDetails: MealDetail[],
  windowReadings: LibreReading[]
): PeriodAnalysisSlice {
  const sliceKey = `${startDate}_${endDate}_${hypoThreshold}_${hyperThreshold}`;
  const existing = meta.periodSlices.get(sliceKey);
  if (existing) {
    return existing;
  }

  const detailsByEventId = new Map<string, MealDetail[]>();
  const foodSet = new Set<string>(meta.masterFoodOptions);

  for (let i = 0; i < periodMealDetails.length; i++) {
    const d = periodMealDetails[i];
    if (d.is_deleted) continue;
    if (d.food_name) foodSet.add(d.food_name);
    const list = detailsByEventId.get(d.event_id);
    if (list) {
      list.push(d);
    } else {
      detailsByEventId.set(d.event_id, [d]);
    }
  }

  const activeEvents: HealthEvent[] = [];
  for (let i = 0; i < periodEvents.length; i++) {
    const e = periodEvents[i];
    if (e.is_deleted) continue;
    const dStr = e.event_datetime.slice(0, 10);
    if (dStr >= startDate && dStr <= endDate) {
      activeEvents.push(e);
      if (e.event_type === '食事' && e.memo) {
        const words = e.memo.split(/[\s,、]+/);
        for (let wIdx = 0; wIdx < words.length; wIdx++) {
          const w = words[wIdx];
          if (w.length >= 2) foodSet.add(w);
        }
      }
    }
  }

  // readingsByDate には食前・食後ピーク探索用の前後1日マージンを含む測定値を格納し、
  // periodReadings には [startDate, endDate] 内の測定値のみを抽出する
  const readingsByDate = new Map<string, LibreReading[]>();
  const periodReadings: LibreReading[] = [];

  for (let i = 0; i < windowReadings.length; i++) {
    const r = windowReadings[i];
    const dStr = extractDateStr(r.timestamp);
    const list = readingsByDate.get(dStr);
    if (list) {
      list.push(r);
    } else {
      readingsByDate.set(dStr, [r]);
    }
    if (dStr >= startDate && dStr <= endDate) {
      periodReadings.push(r);
    }
  }

  const timeAnomaly = calculateTimeAnomalyPatterns(
    activeEvents,
    periodReadings,
    hypoThreshold,
    hyperThreshold
  );
  const weekdayTrends = calculateWeekdayTrends(activeEvents, periodReadings, startDate, endDate);
  const carbInsulinTrend = calculateCarbInsulinTrend(
    activeEvents,
    periodReadings,
    startDate,
    endDate
  );

  const slice: PeriodAnalysisSlice = {
    startDate,
    endDate,
    events: activeEvents,
    readings: periodReadings,
    mealDetails: periodMealDetails,
    detailsByEventId,
    readingsByDate,
    foodOptions: Array.from(foodSet).sort(),
    timeAnomaly,
    weekdayTrends,
    carbInsulinTrend,
    foodImpactCache: new Map<string, FoodImpactSummary>(),
  };

  meta.periodSlices.set(sliceKey, slice);
  return slice;
}

/**
 * 現在のオンメモリデータセットキャッシュを取得する（シグネチャ一致時のみ）
 */
export function getAnalysisDatasetCache(
  patientId: string,
  signature?: string
): IndexedAnalysisDataset | null {
  if (!activeDatasetCache || activeDatasetCache.patientId !== patientId) {
    return null;
  }
  if (signature && activeDatasetCache.signature !== signature) {
    return null;
  }
  return activeDatasetCache;
}

/**
 * 食事・活動の追加/編集/削除や閾値変更時にキャッシュを明示クリアする
 */
export function invalidateAnalysisDatasetCache(patientId?: string): void {
  if (!patientId || activeDatasetCache?.patientId === patientId) {
    activeDatasetCache = null;
  }
  if (!patientId || activeBoundaryCache?.patientId === patientId) {
    activeBoundaryCache = null;
  }
}

/**
 * 患者の全期間データから単一パス（O(N)）で日付別インデックスと食品候補リストを構築しキャッシュに保持する
 */
export function buildAndCacheAnalysisDataset(
  patientId: string,
  signature: string,
  allEvents: HealthEvent[],
  allMealDetails: MealDetail[],
  allReadings: LibreReading[],
  foodMasters: FoodMaster[],
  categories: Category[] = []
): IndexedAnalysisDataset {
  const eventsByDate = new Map<string, HealthEvent[]>();
  const readingsByDate = new Map<string, LibreReading[]>();
  const detailsByEventId = new Map<string, MealDetail[]>();
  const foodSet = new Set<string>();

  let earliestDateStr = '';
  let latestDateStr = '';

  for (let i = 0; i < foodMasters.length; i++) {
    const f = foodMasters[i];
    if (!f.is_deleted && f.food_name) {
      foodSet.add(f.food_name);
    }
  }

  const activeDetails: MealDetail[] = [];
  for (let i = 0; i < allMealDetails.length; i++) {
    const d = allMealDetails[i];
    if (d.is_deleted) continue;
    activeDetails.push(d);
    if (d.food_name) {
      foodSet.add(d.food_name);
    }
    const list = detailsByEventId.get(d.event_id);
    if (list) {
      list.push(d);
    } else {
      detailsByEventId.set(d.event_id, [d]);
    }
  }

  const activeEvents: HealthEvent[] = [];
  for (let i = 0; i < allEvents.length; i++) {
    const e = allEvents[i];
    if (e.is_deleted) continue;
    activeEvents.push(e);
    const dStr = extractDateStr(e.event_datetime);
    if (dStr) {
      if (!earliestDateStr || dStr < earliestDateStr) earliestDateStr = dStr;
      if (dStr > latestDateStr) latestDateStr = dStr;
    }

    const list = eventsByDate.get(dStr);
    if (list) {
      list.push(e);
    } else {
      eventsByDate.set(dStr, [e]);
    }

    if (e.event_type === '食事' && e.memo) {
      const words = e.memo.split(/[\s,、]+/);
      for (let wIdx = 0; wIdx < words.length; wIdx++) {
        const w = words[wIdx];
        if (w.length >= 2) foodSet.add(w);
      }
    }
  }

  for (let i = 0; i < allReadings.length; i++) {
    const r = allReadings[i];
    const dStr = extractDateStr(r.timestamp);
    if (dStr) {
      if (!earliestDateStr || dStr < earliestDateStr) earliestDateStr = dStr;
      if (dStr > latestDateStr) latestDateStr = dStr;
    }

    const list = readingsByDate.get(dStr);
    if (list) {
      list.push(r);
    } else {
      readingsByDate.set(dStr, [r]);
    }
  }

  if (!latestDateStr) {
    latestDateStr = formatLocalDate(new Date());
  }
  if (!earliestDateStr) {
    earliestDateStr = latestDateStr;
  }

  const foodCategories = categories
    .filter((c) => !c.is_deleted && c.target_type === 'food')
    .sort((a, b) => a.display_order - b.display_order);

  const dataset: IndexedAnalysisDataset = {
    patientId,
    signature,
    earliestDateStr,
    referenceDateStr: latestDateStr,
    allEvents: activeEvents,
    allMealDetails: activeDetails,
    allReadings,
    foodMasters: foodMasters.filter((f) => !f.is_deleted),
    foodCategories,
    eventsByDate,
    readingsByDate,
    detailsByEventId,
    foodOptions: Array.from(foodSet).sort(),
    periodSlices: new Map<string, PeriodAnalysisSlice>(),
  };

  activeDatasetCache = dataset;
  return dataset;
}

/**
 * 指定された期間（startDate〜endDate）のスライスと4大集計結果をキャッシュから即時取得（未計算時のみO(N)算出）
 */
export function getOrComputePeriodSlice(
  dataset: IndexedAnalysisDataset,
  startDate: string,
  endDate: string,
  hypoThreshold: number,
  hyperThreshold: number
): PeriodAnalysisSlice {
  const sliceKey = `${startDate}_${endDate}_${hypoThreshold}_${hyperThreshold}`;
  const cached = dataset.periodSlices.get(sliceKey);
  if (cached) {
    return cached;
  }

  const events: HealthEvent[] = [];
  for (let i = 0; i < dataset.allEvents.length; i++) {
    const ev = dataset.allEvents[i];
    const dStr = ev.event_datetime.slice(0, 10);
    if (dStr >= startDate && dStr <= endDate) {
      events.push(ev);
    }
  }

  const readings: LibreReading[] = [];
  for (let i = 0; i < dataset.allReadings.length; i++) {
    const r = dataset.allReadings[i];
    const dStr = r.timestamp.slice(0, 10);
    if (dStr >= startDate && dStr <= endDate) {
      readings.push(r);
    }
  }

  const timeAnomaly = calculateTimeAnomalyPatterns(
    events,
    readings,
    hypoThreshold,
    hyperThreshold
  );
  const weekdayTrends = calculateWeekdayTrends(events, readings, startDate, endDate);
  const carbInsulinTrend = calculateCarbInsulinTrend(events, readings, startDate, endDate);

  const slice: PeriodAnalysisSlice = {
    startDate,
    endDate,
    events,
    readings,
    mealDetails: dataset.allMealDetails,
    detailsByEventId: dataset.detailsByEventId,
    readingsByDate: dataset.readingsByDate,
    foodOptions: dataset.foodOptions,
    timeAnomaly,
    weekdayTrends,
    carbInsulinTrend,
    foodImpactCache: new Map<string, FoodImpactSummary>(),
  };

  dataset.periodSlices.set(sliceKey, slice);
  return slice;
}

/**
 * 1. 食品別 血糖上昇インパクト分析 (旧VBA AnalyzeSelectedFood 準拠・日付インデックス高速化版)
 * 食事イベントから対象食品を検索し、食前・食後ピーク・上昇幅Δ・インスリン・一緒に食べたものを算出
 */
export function calculateFoodImpact(
  foodQuery: string,
  events: HealthEvent[],
  mealDetails: MealDetail[],
  readings: LibreReading[],
  preIndexed?: {
    detailsByEventId?: Map<string, MealDetail[]>;
    readingsByDate?: Map<string, LibreReading[]>;
  }
): FoodImpactSummary {
  const query = foodQuery.trim().toLowerCase();
  if (!query) {
    return {
      selectedFood: '',
      totalCount: 0,
      avgInsulin: 0,
      avgPreGlucose: null,
      avgPeakGlucose: null,
      avgDelta: null,
      items: [],
    };
  }

  // 1. event_id -> MealDetail[] のマップ構築（事前インデックスがあればO(1)で再利用）
  let detailsByEventId = preIndexed?.detailsByEventId;
  if (!detailsByEventId) {
    detailsByEventId = new Map<string, MealDetail[]>();
    for (let i = 0; i < mealDetails.length; i++) {
      const d = mealDetails[i];
      if (d.is_deleted) continue;
      const list = detailsByEventId.get(d.event_id);
      if (list) {
        list.push(d);
      } else {
        detailsByEventId.set(d.event_id, [d]);
      }
    }
  }

  // 2. クエリに一致する食事イベントのみを先行抽出
  const matchedMealCandidates: {
    event: HealthEvent;
    details: MealDetail[];
    matchedDetail: MealDetail | undefined;
  }[] = [];
  const neededDates = new Set<string>();

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.event_type !== '食事' || event.is_deleted) continue;

    const details = detailsByEventId.get(event.id) || [];
    const matchedDetail = details.find((d) => d.food_name.toLowerCase().includes(query));
    const memoMatch = Boolean(event.memo && event.memo.toLowerCase().includes(query));

    if (!matchedDetail && !memoMatch) {
      continue;
    }

    matchedMealCandidates.push({ event, details, matchedDetail });
    const dStr = extractDateStr(event.event_datetime);
    neededDates.add(dStr);
    neededDates.add(shiftLocalDateStr(dStr, 1));
    neededDates.add(shiftLocalDateStr(dStr, -1));
  }

  if (matchedMealCandidates.length === 0) {
    return {
      selectedFood: foodQuery,
      totalCount: 0,
      avgInsulin: 0,
      avgPreGlucose: null,
      avgPeakGlucose: null,
      avgDelta: null,
      items: [],
    };
  }

  // 3. 必要な日付の測定値のみをインデックス化（事前インデックスがあればO(1)で再利用）
  let readingsByDate = preIndexed?.readingsByDate;
  if (!readingsByDate) {
    readingsByDate = new Map<string, LibreReading[]>();
    for (let i = 0; i < readings.length; i++) {
      const r = readings[i];
      const dStr = extractDateStr(r.timestamp);
      if (!neededDates.has(dStr)) continue;
      const list = readingsByDate.get(dStr);
      if (list) {
        list.push(r);
      } else {
        readingsByDate.set(dStr, [r]);
      }
    }
  }

  const matchedItems: FoodImpactItem[] = [];

  for (let i = 0; i < matchedMealCandidates.length; i++) {
    const { event, details, matchedDetail } = matchedMealCandidates[i];
    const eventDateStr = extractDateStr(event.event_datetime);
    const nextDateStr = shiftLocalDateStr(eventDateStr, 1);
    const prevDateStr = shiftLocalDateStr(eventDateStr, -1);

    // 食事当日および前後日の測定値のみを走査（最大約200件程度）
    const candidateReadings: LibreReading[] = [];
    const rPrev = readingsByDate.get(prevDateStr);
    const rCurr = readingsByDate.get(eventDateStr);
    const rNext = readingsByDate.get(nextDateStr);
    if (rPrev) candidateReadings.push(...rPrev);
    if (rCurr) candidateReadings.push(...rCurr);
    if (rNext) candidateReadings.push(...rNext);

    const { boundPre, boundPost } = computeBoundGlucoseForMeal(event, candidateReadings);
    const preGlucose: number | null = boundPre ?? null;
    const peakGlucose: number | null = boundPost ?? null;

    const delta = preGlucose != null && peakGlucose != null ? peakGlucose - preGlucose : null;

    const otherFoods = details
      .filter((d) => d !== matchedDetail)
      .map((d) => `${d.food_name} (${d.carbs.toFixed(1)}g)`);

    const foodName = matchedDetail ? matchedDetail.food_name : foodQuery;
    const amountText = matchedDetail ? `${matchedDetail.amount}${matchedDetail.unit}` : '1食';
    const carbs = matchedDetail ? matchedDetail.carbs : event.total_carbs || 0;

    matchedItems.push({
      id: event.id,
      eventDatetime: event.event_datetime,
      timingCategory: event.timing_category || '食事',
      foodName,
      amountText,
      carbs: Math.round(carbs * 10) / 10,
      totalMealCarbs: Math.round((event.total_carbs || carbs) * 10) / 10,
      insulinUnits: event.insulin_units || 0,
      preGlucose,
      peakGlucose,
      delta,
      otherFoods,
    });
  }

  matchedItems.sort(
    (a, b) => parseWallClockMs(b.eventDatetime) - parseWallClockMs(a.eventDatetime)
  );

  const totalCount = matchedItems.length;
  let insulinSum = 0;
  let preSum = 0;
  let preCount = 0;
  let peakSum = 0;
  let peakCount = 0;
  let deltaSum = 0;
  let deltaCount = 0;

  for (let i = 0; i < totalCount; i++) {
    const item = matchedItems[i];
    insulinSum += item.insulinUnits;
    if (item.preGlucose !== null) {
      preSum += item.preGlucose;
      preCount++;
    }
    if (item.peakGlucose !== null) {
      peakSum += item.peakGlucose;
      peakCount++;
    }
    if (item.delta !== null) {
      deltaSum += item.delta;
      deltaCount++;
    }
  }

  const avgInsulin = Math.round((insulinSum / totalCount) * 10) / 10;
  const avgPreGlucose = preCount > 0 ? Math.round(preSum / preCount) : null;
  const avgPeakGlucose = peakCount > 0 ? Math.round(peakSum / peakCount) : null;
  const avgDelta =
    deltaCount > 0 ? Math.round((deltaSum / deltaCount) * 10) / 10 : null;

  return {
    selectedFood: foodQuery,
    totalCount,
    avgInsulin,
    avgPreGlucose,
    avgPeakGlucose,
    avgDelta,
    items: matchedItems,
  };
}

/**
 * 2. 時間帯別 異常値パターン分析 (旧VBA AnalyzePeriodTrends 準拠)
 * 朝(06-11), 昼(12-17), 夕・夜(18-23), 夜間・未明(00-05) の4区分集計
 */
export function calculateTimeAnomalyPatterns(
  events: HealthEvent[],
  readings?: LibreReading[],
  hypoThreshold = DEFAULT_HYPO_THRESHOLD,
  hyperThreshold = DEFAULT_HYPER_THRESHOLD
): TimePeriodAnomaly[] {
  const periods: {
    periodName: '朝' | '昼' | '夕・夜' | '夜間・未明';
    timeRange: string;
    startHour: number;
    endHour: number;
    hypoCount: number;
    hyperCount: number;
  }[] = [
    { periodName: '朝', timeRange: '06:00 〜 11:59', startHour: 6, endHour: 11, hypoCount: 0, hyperCount: 0 },
    { periodName: '昼', timeRange: '12:00 〜 17:59', startHour: 12, endHour: 17, hypoCount: 0, hyperCount: 0 },
    { periodName: '夕・夜', timeRange: '18:00 〜 23:59', startHour: 18, endHour: 23, hypoCount: 0, hyperCount: 0 },
    { periodName: '夜間・未明', timeRange: '00:00 〜 05:59', startHour: 0, endHour: 5, hypoCount: 0, hyperCount: 0 },
  ];

  let foundAnomalyEvent = false;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.is_deleted) continue;
    if (ev.event_type !== '低血糖' && ev.event_type !== '高血糖') continue;
    foundAnomalyEvent = true;

    const h = extractHour(ev.event_datetime);
    const pIdx = h >= 6 && h <= 11 ? 0 : h >= 12 && h <= 17 ? 1 : h >= 18 && h <= 23 ? 2 : 3;
    if (ev.event_type === '低血糖') {
      periods[pIdx].hypoCount += 1;
    } else {
      periods[pIdx].hyperCount += 1;
    }
  }

  if (!foundAnomalyEvent && readings && readings.length > 0) {
    for (let i = 0; i < readings.length; i++) {
      const r = readings[i];
      if (r.glucose_value < hypoThreshold || r.glucose_value > hyperThreshold) {
        const h = extractHour(r.timestamp);
        const pIdx = h >= 6 && h <= 11 ? 0 : h >= 12 && h <= 17 ? 1 : h >= 18 && h <= 23 ? 2 : 3;
        if (r.glucose_value < hypoThreshold) {
          periods[pIdx].hypoCount += 1;
        } else {
          periods[pIdx].hyperCount += 1;
        }
      }
    }
  }

  const grandTotal =
    periods[0].hypoCount +
    periods[0].hyperCount +
    periods[1].hypoCount +
    periods[1].hyperCount +
    periods[2].hypoCount +
    periods[2].hyperCount +
    periods[3].hypoCount +
    periods[3].hyperCount;

  return periods.map((p) => {
    const totalCount = p.hypoCount + p.hyperCount;
    const percentage = grandTotal > 0 ? Math.round((totalCount / grandTotal) * 1000) / 10 : 0;
    return {
      periodName: p.periodName,
      timeRange: p.timeRange,
      hypoCount: p.hypoCount,
      hyperCount: p.hyperCount,
      totalCount,
      percentage,
    };
  });
}

/**
 * 3. 曜日別 傾向分析 (旧VBA AnalyzeWeekdayTrends 準拠・曜日キャッシュ高速化版)
 */
export function calculateWeekdayTrends(
  events: HealthEvent[],
  readings: LibreReading[],
  startDate: string,
  endDate: string
): WeekdayTrendItem[] {
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];

  const [sy, sm, sd] = startDate.slice(0, 10).split('-').map((n) => parseInt(n, 10));
  const [ey, em, ed] = endDate.slice(0, 10).split('-').map((n) => parseInt(n, 10));
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  const dayCounts = [0, 0, 0, 0, 0, 0, 0];

  const dateToDowMap = new Map<string, number>();

  const cur = new Date(start);
  while (cur <= end) {
    const dow = cur.getDay();
    dayCounts[dow]++;
    dateToDowMap.set(formatLocalDate(cur), dow);
    cur.setDate(cur.getDate() + 1);
  }

  const resolveDow = (iso: string): number => {
    const dStr = iso.slice(0, 10);
    const cached = dateToDowMap.get(dStr);
    if (cached !== undefined) return cached;
    const computed = getDayOfWeekFromDateStr(dStr);
    dateToDowMap.set(dStr, computed);
    return computed;
  };

  const carbsSum = [0, 0, 0, 0, 0, 0, 0];
  const insulinSum = [0, 0, 0, 0, 0, 0, 0];
  const anomalyCounts = [0, 0, 0, 0, 0, 0, 0];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.is_deleted) continue;
    const dow = resolveDow(ev.event_datetime);

    if (ev.event_type === '食事') {
      carbsSum[dow] += ev.total_carbs || 0;
    }
    if ((ev.insulin_units || 0) > 0) {
      insulinSum[dow] += ev.insulin_units || 0;
    }
    if (ev.event_type === '低血糖' || ev.event_type === '高血糖') {
      anomalyCounts[dow] += 1;
    }
  }

  const glucoseSums = [0, 0, 0, 0, 0, 0, 0];
  const glucoseCounts = [0, 0, 0, 0, 0, 0, 0];

  for (let i = 0; i < readings.length; i++) {
    const r = readings[i];
    const dow = resolveDow(r.timestamp);
    glucoseSums[dow] += r.glucose_value;
    glucoseCounts[dow] += 1;
  }

  return dayNames.map((name, dow) => {
    const dates = dayCounts[dow] || 1;
    const avgCarbs = Math.round((carbsSum[dow] / dates) * 10) / 10;
    const avgInsulin = Math.round((insulinSum[dow] / dates) * 10) / 10;
    const avgGlucose =
      glucoseCounts[dow] > 0 ? Math.round(glucoseSums[dow] / glucoseCounts[dow]) : null;

    return {
      dayOfWeek: dow,
      dayName: name,
      dateCount: dayCounts[dow],
      avgCarbs,
      avgInsulin,
      avgGlucose,
      anomalyCount: anomalyCounts[dow],
    };
  });
}

/**
 * 4. 指定期間の糖質・インスリン推移グラフ データ作成 (単一パス O(N + M) 高速化版)
 */
export function calculateCarbInsulinTrend(
  events: HealthEvent[],
  readings: LibreReading[],
  startDate: string,
  endDate: string
): DailyCarbInsulinTrendItem[] {
  const result: DailyCarbInsulinTrendItem[] = [];

  const dayEventMap = new Map<
    string,
    { totalCarbs: number; totalInsulin: number; anomalyCount: number }
  >();

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.is_deleted) continue;
    const dateStr = e.event_datetime.slice(0, 10);
    let bucket = dayEventMap.get(dateStr);
    if (!bucket) {
      bucket = { totalCarbs: 0, totalInsulin: 0, anomalyCount: 0 };
      dayEventMap.set(dateStr, bucket);
    }
    if (e.event_type === '食事') {
      bucket.totalCarbs += e.total_carbs || 0;
    }
    bucket.totalInsulin += e.insulin_units || 0;
    if (e.event_type === '低血糖' || e.event_type === '高血糖') {
      bucket.anomalyCount += 1;
    }
  }

  const dayReadingMap = new Map<string, { sum: number; count: number }>();
  for (let i = 0; i < readings.length; i++) {
    const r = readings[i];
    const dateStr = r.timestamp.slice(0, 10);
    let bucket = dayReadingMap.get(dateStr);
    if (!bucket) {
      bucket = { sum: 0, count: 0 };
      dayReadingMap.set(dateStr, bucket);
    }
    bucket.sum += r.glucose_value;
    bucket.count += 1;
  }

  const [sy, sm, sd] = startDate.slice(0, 10).split('-').map((n) => parseInt(n, 10));
  const [ey, em, ed] = endDate.slice(0, 10).split('-').map((n) => parseInt(n, 10));
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);

  const cur = new Date(start);
  while (cur <= end) {
    const dateStr = formatLocalDate(cur);
    const evBucket = dayEventMap.get(dateStr);
    const rdBucket = dayReadingMap.get(dateStr);

    const totalCarbs = evBucket ? Math.round(evBucket.totalCarbs * 10) / 10 : 0;
    const totalInsulin = evBucket ? Math.round(evBucket.totalInsulin * 10) / 10 : 0;
    const anomalyCount = evBucket ? evBucket.anomalyCount : 0;
    const avgGlucose =
      rdBucket && rdBucket.count > 0 ? Math.round(rdBucket.sum / rdBucket.count) : null;

    result.push({
      date: dateStr,
      totalCarbs,
      totalInsulin,
      avgGlucose,
      anomalyCount,
    });

    cur.setDate(cur.getDate() + 1);
  }

  return result;
}
