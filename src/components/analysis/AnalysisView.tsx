import React, { useState, useEffect, useMemo, useRef } from 'react';
import { usePatient } from '@/contexts/PatientContext';
import { db } from '@/lib/db';
import { formatLocalDate, shiftLocalDateStr } from '@/lib/dateUtils';
import {
  ensureRealGlucoseDataLoaded,
  isDemoCsvImportDisabled,
  pauseBackgroundHydration,
  waitForRecentPersistence,
} from '@/lib/realGlucoseLoader';
import {
  AnalysisBoundaryMetadata,
  PeriodAnalysisSlice,
  buildAndCacheLocalizedPeriodSlice,
  getAnalysisBoundaryCache,
  setAnalysisBoundaryCache,
} from '@/lib/analysisCalculators';
import { FoodImpactTab } from './FoodImpactTab';
import { TimeAnomalyTab } from './TimeAnomalyTab';
import { WeekdayTrendsTab } from './WeekdayTrendsTab';
import { CarbInsulinTrendTab } from './CarbInsulinTrendTab';
import {
  BarChart3,
  Utensils,
  Clock,
  CalendarDays,
  TrendingUp,
  RefreshCw,
  FileSpreadsheet,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type AnalysisRange = '7d' | '14d' | '30d' | '90d' | 'all' | `month:${string}`;

function computeDateBounds(
  dateRange: AnalysisRange,
  referenceDateStr: string,
  earliestDateStr: string
): { startDate: string; endDate: string } {
  const [refY, refM, refD] = referenceDateStr.split('-').map(Number);
  const baseDate =
    !isNaN(refY) && !isNaN(refM) && !isNaN(refD)
      ? new Date(refY, refM - 1, refD)
      : new Date();
  const end = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  const endFormatted = formatLocalDate(end);

  if (dateRange === 'all') {
    return {
      startDate: earliestDateStr <= endFormatted ? earliestDateStr : endFormatted,
      endDate: endFormatted,
    };
  }

  if (dateRange.startsWith('month:')) {
    const ym = dateRange.slice(6);
    const [mY, mM] = ym.split('-').map(Number);
    if (!isNaN(mY) && !isNaN(mM)) {
      const monthFirstStr = formatLocalDate(new Date(mY, mM - 1, 1));
      const monthLastStr = formatLocalDate(new Date(mY, mM, 0));
      const clampedStart =
        earliestDateStr && monthFirstStr < earliestDateStr ? earliestDateStr : monthFirstStr;
      const clampedEnd =
        referenceDateStr && monthLastStr > referenceDateStr ? referenceDateStr : monthLastStr;
      return {
        startDate: clampedStart <= clampedEnd ? clampedStart : monthFirstStr,
        endDate: clampedEnd >= clampedStart ? clampedEnd : monthLastStr,
      };
    }
  }

  const start = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());

  switch (dateRange) {
    case '7d':
      start.setDate(start.getDate() - 6);
      break;
    case '14d':
      start.setDate(start.getDate() - 13);
      break;
    case '30d':
      start.setDate(start.getDate() - 29);
      break;
    case '90d':
      start.setDate(start.getDate() - 89);
      break;
  }

  const computedStart = formatLocalDate(start);
  const clampedStart =
    earliestDateStr && computedStart < earliestDateStr ? earliestDateStr : computedStart;

  return {
    startDate: clampedStart,
    endDate: endFormatted,
  };
}

export const AnalysisView: React.FC = () => {
  const { currentPatientId, hypoThreshold, hyperThreshold } = usePatient();

  const [dateRange, setDateRange] = useState<AnalysisRange>('30d');
  const [isPeriodSheetOpen, setIsPeriodSheetOpen] = useState<boolean>(false);
  const periodSheetTouchStartY = useRef<number | null>(null);

  useEffect(() => {
    const handleBottomSwipe = (e: Event) => {
      const dir = (e as CustomEvent<{ direction?: 'open' | 'close' }>).detail?.direction;
      if (dir === 'open') setIsPeriodSheetOpen(true);
      if (dir === 'close') setIsPeriodSheetOpen(false);
    };
    window.addEventListener('cgm-bottom-sheet-swipe', handleBottomSwipe);
    return () => window.removeEventListener('cgm-bottom-sheet-swipe', handleBottomSwipe);
  }, []);

  // 既にメモリ上に構築済みの境界メタデータがあれば初期描画から即座に利用
  const [boundaryMeta, setBoundaryMeta] = useState<AnalysisBoundaryMetadata | null>(() =>
    getAnalysisBoundaryCache(currentPatientId)
  );
  const [periodSlice, setPeriodSlice] = useState<PeriodAnalysisSlice | null>(() => {
    const cachedMeta = getAnalysisBoundaryCache(currentPatientId);
    if (!cachedMeta) return null;
    const { startDate: initStart, endDate: initEnd } = computeDateBounds(
      '30d',
      cachedMeta.referenceDateStr,
      cachedMeta.earliestDateStr
    );
    const sliceKey = `${initStart}_${initEnd}_${hypoThreshold}_${hyperThreshold}`;
    return cachedMeta.periodSlices.get(sliceKey) ?? null;
  });
  const [isLoading, setIsLoading] = useState<boolean>(() => {
    const cachedMeta = getAnalysisBoundaryCache(currentPatientId);
    if (!cachedMeta) return true;
    const { startDate: initStart, endDate: initEnd } = computeDateBounds(
      '30d',
      cachedMeta.referenceDateStr,
      cachedMeta.earliestDateStr
    );
    const sliceKey = `${initStart}_${initEnd}_${hypoThreshold}_${hyperThreshold}`;
    return !cachedMeta.periodSlices.has(sliceKey);
  });
  const [hydrationRev, setHydrationRev] = useState<number>(0);

  // Phase 2 バックグラウンド過去データ同期完了時に境界メタデータ（最古日・選択可能月）を自動更新
  useEffect(() => {
    const handleBackgroundHydration = () => {
      setHydrationRev((r) => r + 1);
    };
    window.addEventListener('cgm-background-hydration-complete', handleBackgroundHydration);
    return () => {
      window.removeEventListener('cgm-background-hydration-complete', handleBackgroundHydration);
    };
  }, []);

  // 1. 軽量メタデータ＆境界日付（最古日・最新日）と食品・カテゴリ一覧の取得（全件 toArray スキャンを排除）
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        pauseBackgroundHydration(currentPatientId, 3000);
        await ensureRealGlucoseDataLoaded(currentPatientId, hypoThreshold, hyperThreshold);
        await waitForRecentPersistence(currentPatientId);

        const [evCount, detailCount, readingCount, foodCount, catCount, lastUpdatedEvent] =
          await Promise.all([
            db.events.where('user_id').equals(currentPatientId).count(),
            db.meal_details.where('user_id').equals(currentPatientId).count(),
            db.libre_readings.where('user_id').equals(currentPatientId).count(),
            db.food_master.where('user_id').equals(currentPatientId).count(),
            db.categories.where('user_id').equals(currentPatientId).count(),
            db.events.where('user_id').equals(currentPatientId).last(),
          ]);

        const signature = `${currentPatientId}_${hypoThreshold}_${hyperThreshold}_${evCount}_${detailCount}_${readingCount}_${foodCount}_${catCount}_${lastUpdatedEvent?.updated_at ?? ''}_${lastUpdatedEvent?.is_deleted ?? ''}`;

        const cachedMeta = getAnalysisBoundaryCache(currentPatientId, signature);
        if (cachedMeta) {
          if (active) {
            setBoundaryMeta(cachedMeta);
          }
          return;
        }

        if (active && !boundaryMeta) {
          setIsLoading(true);
        }

        const minBound: [string, string] = [currentPatientId, '0000-00-00'];
        const maxBound: [string, string] = [currentPatientId, '9999-99-99'];

        const [firstReading, lastReading, firstEvent, lastEvent, masters, categories] =
          await Promise.all([
            db.libre_readings.where('[user_id+timestamp]').between(minBound, maxBound).first(),
            db.libre_readings.where('[user_id+timestamp]').between(minBound, maxBound).last(),
            db.events
              .where('[user_id+event_datetime]')
              .between(minBound, maxBound)
              .filter((e) => !e.is_deleted)
              .first(),
            db.events
              .where('[user_id+event_datetime]')
              .between(minBound, maxBound)
              .filter((e) => !e.is_deleted)
              .last(),
            db.food_master.where('user_id').equals(currentPatientId).toArray(),
            db.categories.where('user_id').equals(currentPatientId).toArray(),
          ]);

        if (!active) return;

        const candidateEarliest: string[] = [];
        const candidateLatest: string[] = [];
        if (firstReading?.timestamp) candidateEarliest.push(firstReading.timestamp.slice(0, 10));
        if (firstEvent?.event_datetime)
          candidateEarliest.push(firstEvent.event_datetime.slice(0, 10));
        if (lastReading?.timestamp) candidateLatest.push(lastReading.timestamp.slice(0, 10));
        if (lastEvent?.event_datetime) candidateLatest.push(lastEvent.event_datetime.slice(0, 10));

        candidateEarliest.sort();
        candidateLatest.sort();

        const todayStr = formatLocalDate(new Date());
        const referenceDateStr =
          candidateLatest.length > 0 ? candidateLatest[candidateLatest.length - 1] : todayStr;
        const earliestDateStr =
          candidateEarliest.length > 0 ? candidateEarliest[0] : referenceDateStr;

        const builtMeta = setAnalysisBoundaryCache(
          currentPatientId,
          signature,
          earliestDateStr,
          referenceDateStr,
          masters,
          categories
        );
        setBoundaryMeta(builtMeta);
      } catch (err) {
        console.error('[AnalysisView] Failed to load analysis boundary metadata:', err);
        if (active) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [currentPatientId, hypoThreshold, hyperThreshold, hydrationRev]);

  const referenceDateStr = boundaryMeta?.referenceDateStr || formatLocalDate(new Date());
  const earliestDateStr = boundaryMeta?.earliestDateStr || referenceDateStr;
  const availableMonths = boundaryMeta?.availableMonths || [referenceDateStr.slice(0, 7)];

  // 選択期間の開始日・終了日（YYYY-MM-DD、最新実データ日基準・全期間は最古実データ日基準・月別は該当月初〜月末）の計算
  const { startDate, endDate } = useMemo(
    () => computeDateBounds(dateRange, referenceDateStr, earliestDateStr),
    [dateRange, referenceDateStr, earliestDateStr]
  );

  // 2. 選択された期間 [startDate, endDate] のみを複合インデックス between() でピンポイント取得＆インメモリキャッシュ
  useEffect(() => {
    if (!boundaryMeta) return;

    const sliceKey = `${startDate}_${endDate}_${hypoThreshold}_${hyperThreshold}`;
    const cachedSlice = boundaryMeta.periodSlices.get(sliceKey);
    if (cachedSlice) {
      setPeriodSlice(cachedSlice);
      setIsLoading(false);
      return;
    }

    let active = true;

    (async () => {
      try {
        pauseBackgroundHydration(currentPatientId, 3000);
        // 食前15分〜食後180分の日跨ぎ探索および期間末日夜間の後続イベント干渉判定に対応するため、前後余白を含めて複合インデックス検索
        const readingsStartIso = `${shiftLocalDateStr(startDate, -1)}T00:00:00.000Z`;
        const readingsEndIso = `${shiftLocalDateStr(endDate, 1)}T23:59:59.999Z`;
        const eventsStartIso = `${startDate}T00:00:00.000Z`;
        const eventsEndIso = `${shiftLocalDateStr(endDate, 1)}T23:59:59.999Z`;

        const [periodReadings, periodEvents] = await Promise.all([
          db.libre_readings
            .where('[user_id+timestamp]')
            .between(
              [currentPatientId, readingsStartIso],
              [currentPatientId, readingsEndIso],
              true,
              true
            )
            .toArray(),
          db.events
            .where('[user_id+event_datetime]')
            .between(
              [currentPatientId, eventsStartIso],
              [currentPatientId, eventsEndIso],
              true,
              true
            )
            .filter((e) => !e.is_deleted)
            .toArray(),
        ]);

        if (!active) return;

        const mealEventIds = periodEvents
          .filter((e) => e.event_type === '食事' && e.event_datetime.slice(0, 10) <= endDate)
          .map((e) => e.id);
        const periodDetails =
          mealEventIds.length > 0
            ? await db.meal_details
                .where('event_id')
                .anyOf(mealEventIds)
                .filter((d) => !d.is_deleted)
                .toArray()
            : [];

        if (!active) return;

        const builtSlice = buildAndCacheLocalizedPeriodSlice(
          boundaryMeta,
          startDate,
          endDate,
          hypoThreshold,
          hyperThreshold,
          periodEvents,
          periodDetails,
          periodReadings
        );

        setPeriodSlice(builtSlice);
      } catch (err) {
        console.error('[AnalysisView] Failed to load localized period slice:', err);
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [boundaryMeta, currentPatientId, startDate, endDate, hypoThreshold, hyperThreshold]);

  const rangeOptions: { key: AnalysisRange; label: string }[] = [
    { key: '7d', label: '直近7日' },
    { key: '14d', label: '直近14日' },
    { key: '30d', label: '直近30日' },
    { key: '90d', label: '直近90日' },
    { key: 'all', label: '全期間' },
  ];

  const isMonthSelected = dateRange.startsWith('month:');
  const activeRangeLabel = isMonthSelected
    ? (() => {
        const [y, m] = dateRange.slice(6).split('-');
        return `${y}年${parseInt(m, 10)}月`;
      })()
    : rangeOptions.find((o) => o.key === dateRange)?.label || '直近30日';

  return (
    <div className="max-w-7xl mx-auto px-2.5 sm:px-6 lg:px-8 pt-3 pb-16 sm:py-4 space-y-3.5 sm:space-y-4">
      {/* 1. タイトル & 集計期間 常時表示ヘッダー（スクロール追従 sticky） */}
      <div className="sticky top-12 z-20 flex items-center justify-between gap-3 bg-white/95 backdrop-blur-md px-3.5 py-2.5 sm:p-3.5 rounded-2xl border border-slate-200 shadow-xs">
        <div className="flex items-center space-x-2.5 min-w-0">
          <div className="p-1.5 sm:p-2 rounded-xl bg-indigo-50 text-indigo-600 shrink-0">
            <BarChart3 className="w-4 h-4 sm:w-5 sm:h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm sm:text-base font-extrabold text-slate-900 tracking-tight truncate">
              血糖・食事の傾向分析
            </h2>
            <p className="text-[11px] sm:text-xs font-semibold text-slate-500 tabular-nums truncate">
              集計期間: {startDate} 〜 {endDate}
            </p>
          </div>
        </div>
      </div>

      {/* 2. 1画面統合ダッシュボード（第1層：4大分析セクションすべてを純白カード bg-white に統一してグルーピングを明確化） */}
      {isLoading || !boundaryMeta || !periodSlice ? (
        <div className="bg-white p-12 rounded-3xl border border-slate-200 shadow-xs text-center space-y-3">
          <RefreshCw className="w-8 h-8 text-indigo-500 animate-spin mx-auto" />
          <p className="text-sm font-semibold text-slate-700">データを準備中...</p>
        </div>
      ) : periodSlice.readings.length === 0 && periodSlice.events.length === 0 ? (
        <div className="bg-white p-12 rounded-3xl border border-slate-200 shadow-xs text-center space-y-3">
          <FileSpreadsheet className="w-10 h-10 text-slate-300 mx-auto" />
          <h3 className="text-base font-bold text-slate-800">
            選択された期間（{startDate} 〜 {endDate}）のデータがありません
          </h3>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            {isDemoCsvImportDisabled()
              ? '期間セレクターで記録のある月（2026年8月以前）または「全期間」を選択してください。'
              : 'リブレのCSVデータをインポートするか、期間セレクターで別の月または「全期間」を選択してください。'}
          </p>
        </div>
      ) : (
        <div className="space-y-4 sm:space-y-5">
          {/* 上段 2カラム並列（高さ完全一致 items-stretch） */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-5 items-stretch">
            {/* ① 左上：食品別の血糖変化（旧VBA C5:L23 準拠・全件スクロール表示） */}
            <section className="bg-white p-3.5 sm:p-4 rounded-3xl border border-slate-200 shadow-xs flex flex-col h-full space-y-3">
              <div className="flex items-center space-x-2.5 pb-2 border-b border-slate-100 shrink-0">
                <span className="p-1.5 rounded-xl bg-amber-100/90 text-amber-600">
                  <Utensils className="w-4 h-4" />
                </span>
                <h3 className="text-sm sm:text-base font-extrabold text-slate-900">
                  食品別の血糖変化（食前・ピーク・上昇幅Δ）
                </h3>
              </div>
              <div className="flex-1 flex flex-col min-h-0">
                <FoodImpactTab
                  events={periodSlice.events}
                  mealDetails={periodSlice.mealDetails || []}
                  readings={periodSlice.readings}
                  foodMasters={boundaryMeta.foodMasters}
                  foodCategories={boundaryMeta.foodCategories}
                  precomputedFoodOptions={periodSlice.foodOptions}
                  detailsByEventId={periodSlice.detailsByEventId}
                  readingsByDate={periodSlice.readingsByDate}
                  eventsByDate={periodSlice.eventsByDate}
                  foodImpactCache={periodSlice.foodImpactCache}
                  isDashboardMode
                />
              </div>
            </section>

            {/* ② 右上：曜日別の傾向（旧VBA O5:U14 準拠・内訳常時表示） */}
            <section className="bg-white p-3.5 sm:p-4 rounded-3xl border border-slate-200 shadow-xs flex flex-col h-full space-y-3">
              <div className="flex items-center space-x-2.5 pb-2 border-b border-slate-100 shrink-0">
                <span className="p-1.5 rounded-xl bg-emerald-100/90 text-emerald-600">
                  <CalendarDays className="w-4 h-4" />
                </span>
                <h3 className="text-sm sm:text-base font-extrabold text-slate-900">
                  曜日別の傾向（平日 vs 休日）
                </h3>
              </div>
              <div className="flex-1 flex flex-col min-h-0">
                <WeekdayTrendsTab
                  events={periodSlice.events}
                  readings={periodSlice.readings}
                  startDate={startDate}
                  endDate={endDate}
                  precomputedData={periodSlice.weekdayTrends}
                />
              </div>
            </section>
          </div>

          {/* ③ 中段（2カラム分フル幅）：時間帯別の傾向（旧VBA準拠 左＝集計データ表 ／ 右＝横棒グラフ） */}
          <section className="bg-white p-3.5 sm:p-4 rounded-3xl border border-slate-200 shadow-xs space-y-3 sm:space-y-3.5">
            <div className="flex items-center space-x-2.5 pb-2 border-b border-slate-100">
              <span className="p-1.5 rounded-xl bg-rose-100/90 text-rose-600">
                <Clock className="w-4 h-4" />
              </span>
              <h3 className="text-sm sm:text-base font-extrabold text-slate-900">
                時間帯別の傾向（4区分）
              </h3>
            </div>
            <TimeAnomalyTab
              events={periodSlice.events}
              readings={periodSlice.readings}
              precomputedData={periodSlice.timeAnomaly}
            />
          </section>

          {/* ④ 下段（2カラム分フル幅）：日次 糖質・インスリン推移グラフ */}
          <section className="bg-white p-3.5 sm:p-4 rounded-3xl border border-slate-200 shadow-xs space-y-3 sm:space-y-3.5">
            <div className="flex items-center space-x-2.5 pb-2 border-b border-slate-100">
              <span className="p-1.5 rounded-xl bg-sky-100/90 text-sky-600">
                <TrendingUp className="w-4 h-4" />
              </span>
              <h3 className="text-sm sm:text-base font-extrabold text-slate-900">
                日次 糖質・インスリン推移
              </h3>
            </div>
            <CarbInsulinTrendTab
              events={periodSlice.events}
              readings={periodSlice.readings}
              startDate={startDate}
              endDate={endDate}
              precomputedData={periodSlice.carbInsulinTrend}
            />
          </section>
        </div>
      )}

      {/* モバイル用 ボトムナビ直上固定 期間アコーディオン（縦スワイプ / タップ開閉・複数行表示） */}
      <div
        data-testid="analysis-period-bottom-bar"
        onTouchStart={(e) => {
          const touch = e.touches?.[0] ?? e.changedTouches?.[0];
          if (touch) periodSheetTouchStartY.current = touch.clientY;
        }}
        onTouchEnd={(e) => {
          if (periodSheetTouchStartY.current === null) return;
          const touch = e.changedTouches?.[0] ?? e.touches?.[0];
          const startY = periodSheetTouchStartY.current;
          periodSheetTouchStartY.current = null;
          if (!touch) return;
          const deltaY = touch.clientY - startY;
          if (deltaY < -25) setIsPeriodSheetOpen(true);
          if (deltaY > 25) setIsPeriodSheetOpen(false);
        }}
        className="sm:hidden fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] inset-x-0 z-30 bg-white/95 backdrop-blur-md border-t border-slate-200 shadow-[0_-4px_16px_-4px_rgba(15,23,42,0.12)]"
      >
        <button
          type="button"
          onClick={() => setIsPeriodSheetOpen((v) => !v)}
          aria-expanded={isPeriodSheetOpen}
          aria-label={isPeriodSheetOpen ? '期間選択を閉じる' : '集計期間を変更する'}
          className="w-full h-9 px-3.5 flex items-center justify-between text-xs font-bold text-slate-600 hover:bg-slate-50/70 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-6 h-1 rounded-full bg-slate-300 shrink-0" />
            <span className="truncate text-slate-800">期間: {activeRangeLabel}</span>
          </div>
          <div className="flex items-center gap-1 text-[11px] text-slate-500 shrink-0">
            <span>{isPeriodSheetOpen ? '閉じる' : '期間を選択'}</span>
            {isPeriodSheetOpen ? (
              <ChevronDown className="w-4 h-4 text-slate-500" />
            ) : (
              <ChevronUp className="w-4 h-4 text-slate-500" />
            )}
          </div>
        </button>

        {isPeriodSheetOpen && (
          <div className="px-3 pb-3 pt-1.5 space-y-2.5 border-t border-slate-100">
            <div className="flex flex-wrap items-center gap-1.5">
              {rangeOptions.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => {
                    setDateRange(opt.key);
                    setIsPeriodSheetOpen(false);
                  }}
                  className={cn(
                    'min-h-[40px] px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer',
                    dateRange === opt.key
                      ? 'bg-slate-900 text-white shadow-xs'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <select
              aria-label="月単位で集計期間を選択"
              value={isMonthSelected ? dateRange : ''}
              onChange={(e) => {
                if (e.target.value) {
                  setDateRange(e.target.value as AnalysisRange);
                  setIsPeriodSheetOpen(false);
                }
              }}
              className={cn(
                'w-full min-h-[42px] px-3 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500',
                isMonthSelected
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
              )}
            >
              <option value="" disabled>
                📅 月別で選択...
              </option>
              {availableMonths.map((ym) => {
                const [yStr, mStr] = ym.split('-');
                return (
                  <option key={ym} value={`month:${ym}`} className="bg-white text-slate-800">
                    📅 {yStr}年{parseInt(mStr, 10)}月
                  </option>
                );
              })}
            </select>
          </div>
        )}
      </div>

      {/* PC用 下部固定 期間セレクターバー */}
      <div className="hidden sm:block sticky bottom-3 z-20 pointer-events-none">
        <div className="max-w-3xl mx-auto pointer-events-auto bg-white/95 backdrop-blur-md border border-slate-200 rounded-2xl p-1.5 shadow-lg">
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {rangeOptions.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setDateRange(opt.key)}
                className={cn(
                  'min-h-[38px] px-3 py-1.5 rounded-xl text-xs font-semibold transition-all cursor-pointer whitespace-nowrap',
                  dateRange === opt.key
                    ? 'bg-slate-900 text-white shadow-xs font-bold'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900'
                )}
              >
                {opt.label}
              </button>
            ))}

            <select
              aria-label="月単位で集計期間を選択"
              value={isMonthSelected ? dateRange : ''}
              onChange={(e) => {
                if (e.target.value) {
                  setDateRange(e.target.value as AnalysisRange);
                }
              }}
              className={cn(
                'min-h-[38px] px-3 py-1.5 rounded-xl text-xs font-semibold transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500',
                isMonthSelected
                  ? 'bg-indigo-600 text-white shadow-xs font-bold'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
              )}
            >
              <option value="" disabled>
                📅 月別...
              </option>
              {availableMonths.map((ym) => {
                const [yStr, mStr] = ym.split('-');
                return (
                  <option key={ym} value={`month:${ym}`} className="bg-white text-slate-800">
                    📅 {yStr}年{parseInt(mStr, 10)}月
                  </option>
                );
              })}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
};
