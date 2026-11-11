import React, { Suspense, lazy, useState, useEffect, useMemo, useRef } from 'react';
import { usePatient } from '@/contexts/PatientContext';
import { db } from '@/lib/db';
import {
  getCalendarGridDays,
  aggregateMonthlyData,
  getSelectedDaySummary,
  calculateMonthlyOverallKpi,
  DailyAggregatedData,
  MonthlyOverallKpi,
} from '@/lib/aggregates';
import { getTodayLocalDateStr, shiftLocalDateStr } from '@/lib/dateUtils';
import {
  ensureRealGlucoseDataLoaded,
  getInMemoryRecentSlice,
  invalidateInMemoryRecentCache,
  isPatientManuallyCleared,
  isPortfolioMode,
} from '@/lib/realGlucoseLoader';
import { registerUiCacheInvalidator } from '@/lib/syncEngine';
import { SelectedDaySummary } from './SelectedDaySummary';
import { CalendarGrid } from './CalendarGrid';
import { LibreReading, HealthEvent } from '@/types/database';
import { CalendarSearch, ArrowRight } from 'lucide-react';

// 日次詳細ドロワー（および内部の24H EChartsグラフ）はドロワー初回オープン時まで遅延読み込み
const DailyDetailDrawer = lazy(() =>
  import('../daily/DailyDetailDrawer').then((m) => ({ default: m.DailyDetailDrawer }))
);

interface CalendarViewProps {
  refreshKey?: number;
  year?: number;
  month?: number;
  isAtLatestMonth?: boolean;
  onPrevMonth?: () => void;
  onNextMonth?: () => void;
  onChangeMonth?: (year: number, month: number) => void;
  onSwipePastLatestMonth?: () => void;
}

interface CachedMonthEntry {
  gridDays: { date: string; dayNumber: number; isCurrentMonth: boolean; isToday: boolean }[];
  readings: LibreReading[];
  events: HealthEvent[];
  aggregatedMap: Map<string, DailyAggregatedData>;
  monthlyOverallKpi: MonthlyOverallKpi;
}

const monthlyCacheMap = new Map<string, CachedMonthEntry>();
const latestDateCacheMap = new Map<string, string | null>();
const hasAutoJumpedPatients = new Set<string>();
let lastGlobalRefreshSignature = '';

export function clearCalendarMonthlyCache(): void {
  monthlyCacheMap.clear();
  latestDateCacheMap.clear();
  hasAutoJumpedPatients.clear();
}

registerUiCacheInvalidator(() => {
  clearCalendarMonthlyCache();
});

export function hasCalendarMonthlyCache(): boolean {
  return monthlyCacheMap.size > 0 || latestDateCacheMap.size > 0;
}

export function primeCalendarMonthlyCache(
  patientId: string,
  latestDateStr: string = '2026-08-25'
): void {
  latestDateCacheMap.set(patientId, latestDateStr);
}

function getMonthCacheKey(
  patientId: string,
  year: number,
  month: number,
  hypoThreshold: number,
  hyperThreshold: number
): string {
  return `${patientId}:${year}-${String(month).padStart(2, '0')}:${hypoThreshold}-${hyperThreshold}`;
}

async function fetchAndCacheMonthData(
  patientId: string,
  year: number,
  month: number,
  hypoThreshold: number,
  hyperThreshold: number
): Promise<CachedMonthEntry> {
  const cacheKey = getMonthCacheKey(patientId, year, month, hypoThreshold, hyperThreshold);
  const existing = monthlyCacheMap.get(cacheKey);
  if (existing) {
    if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
      performance.mark('cgm-calendar-data-ready');
    }
    return existing;
  }

  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    performance.mark('cgm-calendar-fetch-start');
  }

  await ensureRealGlucoseDataLoaded(patientId, hypoThreshold, hyperThreshold);

  const gridDays = getCalendarGridDays(year, month);
  const firstGridDate = gridDays[0]?.date ?? `${year}-${String(month).padStart(2, '0')}-01`;
  const lastGridDate =
    gridDays[gridDays.length - 1]?.date ?? `${year}-${String(month).padStart(2, '0')}-31`;

  const startDate = `${firstGridDate}T00:00:00.000Z`;
  const endDate = `${lastGridDate}T23:59:59.999Z`;

  // 初回表示時（IndexedDBへのバックグラウンド書き込み完了前）はインメモリキャッシュから 0ms で即時取得
  const inMemorySlice = getInMemoryRecentSlice(
    patientId,
    startDate,
    endDate,
    hypoThreshold,
    hyperThreshold
  );

  let rList: LibreReading[];
  let eList: HealthEvent[];

  if (inMemorySlice) {
    rList = inMemorySlice.readings;
    eList = inMemorySlice.events;
  } else {
    // 全件取得(where('user_id').filter())を廃止し、複合インデックス [user_id+timestamp] / [user_id+event_datetime] の between で局所取得
    [rList, eList] = await Promise.all([
      db.libre_readings
        .where('[user_id+timestamp]')
        .between([patientId, startDate], [patientId, endDate], true, true)
        .toArray(),
      db.events
        .where('[user_id+event_datetime]')
        .between([patientId, startDate], [patientId, endDate], true, true)
        .filter((e) => !e.is_deleted)
        .toArray(),
    ]);
  }

  const aggregatedMap = aggregateMonthlyData(gridDays, rList, eList, hypoThreshold, hyperThreshold);
  const monthlyOverallKpi = calculateMonthlyOverallKpi(
    year,
    month,
    rList,
    hypoThreshold,
    hyperThreshold
  );

  const entry: CachedMonthEntry = {
    gridDays,
    readings: rList,
    events: eList,
    aggregatedMap,
    monthlyOverallKpi,
  };

  monthlyCacheMap.set(cacheKey, entry);
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    performance.mark('cgm-calendar-data-ready');
  }
  return entry;
}

async function findLatestDataDateStr(patientId: string): Promise<string | null> {
  if (latestDateCacheMap.has(patientId)) {
    return latestDateCacheMap.get(patientId) ?? null;
  }
  if (isPortfolioMode() && !isPatientManuallyCleared(patientId)) {
    latestDateCacheMap.set(patientId, '2026-08-25');
    return '2026-08-25';
  }
  try {
    const [lastReading, lastEvent] = await Promise.all([
      db.libre_readings
        .where('[user_id+timestamp]')
        .between([patientId, ''], [patientId, '\uffff'])
        .last(),
      db.events
        .where('[user_id+event_datetime]')
        .between([patientId, ''], [patientId, '\uffff'])
        .filter((e) => !e.is_deleted)
        .last(),
    ]);

    const rDate = lastReading?.timestamp?.slice(0, 10) || '';
    const eDate = lastEvent?.event_datetime?.slice(0, 10) || '';
    const latest = rDate >= eDate ? rDate : eDate;
    const resolved = latest ? latest : null;
    latestDateCacheMap.set(patientId, resolved);
    return resolved;
  } catch {
    return null;
  }
}

export const CalendarView: React.FC<CalendarViewProps> = ({
  refreshKey = 0,
  year: propYear,
  month: propMonth,
  isAtLatestMonth: propIsAtLatestMonth,
  onPrevMonth: propPrevMonth,
  onNextMonth: propNextMonth,
  onChangeMonth: propChangeMonth,
  onSwipePastLatestMonth,
}) => {
  const { currentPatientId, hypoThreshold, hyperThreshold } = usePatient();

  const today = useMemo(() => new Date(), []);
  const todayStr = useMemo(() => getTodayLocalDateStr(), []);
  const maxYear = today.getFullYear();
  const maxMonth = today.getMonth() + 1;

  const [internalYear, setInternalYear] = useState<number>(() =>
    isPortfolioMode() ? 2026 : maxYear
  );
  const [internalMonth, setInternalMonth] = useState<number>(() =>
    isPortfolioMode() ? 8 : maxMonth
  );

  const year = propYear ?? internalYear;
  const month = propMonth ?? internalMonth;
  const isAtLatestMonth =
    propIsAtLatestMonth ?? (year > maxYear || (year === maxYear && month >= maxMonth));

  const currentYearMonth = year * 12 + month;
  const prevYearMonthRef = useRef<number>(currentYearMonth);
  const monthTransitionDirRef = useRef<'forward' | 'backward' | null>(null);
  if (prevYearMonthRef.current !== currentYearMonth) {
    monthTransitionDirRef.current =
      currentYearMonth > prevYearMonthRef.current ? 'forward' : 'backward';
    prevYearMonthRef.current = currentYearMonth;
  }
  const monthTransitionDirection = monthTransitionDirRef.current;

  const [selectedDate, setSelectedDate] = useState<string>(() =>
    isPortfolioMode() && !isPatientManuallyCleared(currentPatientId) ? '2026-08-25' : todayStr
  );
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);
  const [hasOpenedDrawer, setHasOpenedDrawer] = useState<boolean>(false);
  const [localRefreshKey, setLocalRefreshKey] = useState<number>(0);
  const [latestDataDate, setLatestDataDate] = useState<string | null>(() =>
    latestDateCacheMap.get(currentPatientId) ??
    (isPortfolioMode() && !isPatientManuallyCleared(currentPatientId) ? '2026-08-25' : null)
  );
  const hasAutoJumpedRef = useRef<boolean>(false);

  // Phase 2 バックグラウンド過去データ同期完了時に、最新データ月以外の月キャッシュを破棄し、過去月表示中なら再描画する
  useEffect(() => {
    const handleBackgroundHydration = () => {
      const latestMonthPrefix = latestDataDate ? latestDataDate.slice(0, 7) : null;
      const keepToken = latestMonthPrefix ? `:${latestMonthPrefix}:` : null;
      for (const key of Array.from(monthlyCacheMap.keys())) {
        if (!keepToken || !key.includes(keepToken)) {
          monthlyCacheMap.delete(key);
        }
      }
      const currentMonthPrefix = `${year}-${String(month).padStart(2, '0')}`;
      if (currentMonthPrefix !== latestMonthPrefix) {
        setLocalRefreshKey((k) => k + 1);
      }
    };
    window.addEventListener('cgm-background-hydration-complete', handleBackgroundHydration);
    return () => {
      window.removeEventListener('cgm-background-hydration-complete', handleBackgroundHydration);
    };
  }, [year, month, latestDataDate]);

  const currentRefreshSignature = `${currentPatientId}:${refreshKey}:${localRefreshKey}:${hypoThreshold}:${hyperThreshold}`;
  if (lastGlobalRefreshSignature !== currentRefreshSignature) {
    if (lastGlobalRefreshSignature !== '') {
      clearCalendarMonthlyCache();
    }
    lastGlobalRefreshSignature = currentRefreshSignature;
  }

  const currentCacheKey = getMonthCacheKey(
    currentPatientId,
    year,
    month,
    hypoThreshold,
    hyperThreshold
  );
  const cachedForCurrentMonth = monthlyCacheMap.get(currentCacheKey) ?? null;

  const [loadedMonthState, setLoadedMonthState] = useState<{
    cacheKey: string;
    entry: CachedMonthEntry;
  } | null>(() =>
    cachedForCurrentMonth ? { cacheKey: currentCacheKey, entry: cachedForCurrentMonth } : null
  );
  const [isLoading, setIsLoading] = useState<boolean>(!cachedForCurrentMonth);
  const activeRequestRef = useRef<number>(0);

  const monthData =
    cachedForCurrentMonth ??
    (loadedMonthState?.cacheKey === currentCacheKey ? loadedMonthState.entry : null);

  useEffect(() => {
    const cacheKey = getMonthCacheKey(
      currentPatientId,
      year,
      month,
      hypoThreshold,
      hyperThreshold
    );
    const cached = monthlyCacheMap.get(cacheKey);

    const scheduleAdjacentPrefetch = () => {
      const prevY = month === 1 ? year - 1 : year;
      const prevM = month === 1 ? 12 : month - 1;
      const nextY = month === 12 ? year + 1 : year;
      const nextM = month === 12 ? 1 : month + 1;

      const timerId = window.setTimeout(() => {
        if (
          !monthlyCacheMap.has(
            getMonthCacheKey(currentPatientId, prevY, prevM, hypoThreshold, hyperThreshold)
          )
        ) {
          void fetchAndCacheMonthData(
            currentPatientId,
            prevY,
            prevM,
            hypoThreshold,
            hyperThreshold
          ).catch(() => {});
        }
        if (
          !isAtLatestMonth &&
          !monthlyCacheMap.has(
            getMonthCacheKey(currentPatientId, nextY, nextM, hypoThreshold, hyperThreshold)
          )
        ) {
          void fetchAndCacheMonthData(
            currentPatientId,
            nextY,
            nextM,
            hypoThreshold,
            hyperThreshold
          ).catch(() => {});
        }
      }, 180);

      return () => window.clearTimeout(timerId);
    };

    if (cached) {
      setLoadedMonthState({ cacheKey, entry: cached });
      setIsLoading(false);
      void findLatestDataDateStr(currentPatientId).then((d) => setLatestDataDate(d));
      return scheduleAdjacentPrefetch();
    }

    const reqId = ++activeRequestRef.current;
    setIsLoading(true);
    let cancelPrefetch: (() => void) | undefined;

    fetchAndCacheMonthData(currentPatientId, year, month, hypoThreshold, hyperThreshold)
      .then(async (entry) => {
        const latestStr = await findLatestDataDateStr(currentPatientId);
        if (activeRequestRef.current === reqId) {
          setLatestDataDate(latestStr);
          setLoadedMonthState({ cacheKey, entry });
          setIsLoading(false);
          cancelPrefetch = scheduleAdjacentPrefetch();
        }
      })
      .catch((err) => {
        console.error('Failed to load local glucose records:', err);
        if (activeRequestRef.current === reqId) {
          setIsLoading(false);
        }
      });

    return () => {
      if (cancelPrefetch) cancelPrefetch();
    };
  }, [
    currentPatientId,
    year,
    month,
    isAtLatestMonth,
    refreshKey,
    localRefreshKey,
    hypoThreshold,
    hyperThreshold,
  ]);

  const gridDays = useMemo(() => {
    if (monthData && monthData.gridDays.length > 0) {
      return monthData.gridDays;
    }
    return getCalendarGridDays(year, month);
  }, [monthData, year, month]);

  const aggregatedMap = useMemo(() => {
    return monthData?.aggregatedMap ?? new Map<string, DailyAggregatedData>();
  }, [monthData]);

  const readings = monthData?.readings ?? [];
  const events = monthData?.events ?? [];

  const currentMonthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  const hasCurrentMonthData = useMemo(() => {
    return (
      readings.some((r) => r.timestamp.startsWith(currentMonthPrefix)) ||
      events.some((e) => e.event_datetime.startsWith(currentMonthPrefix))
    );
  }, [readings, events, currentMonthPrefix]);

  const latestDataMonthInfo = useMemo(() => {
    if (!latestDataDate) return null;
    const lYear = parseInt(latestDataDate.slice(0, 4), 10);
    const lMonth = parseInt(latestDataDate.slice(5, 7), 10);
    if (isNaN(lYear) || isNaN(lMonth)) return null;
    if (lYear === year && lMonth === month) return null;
    return { year: lYear, month: lMonth, dateStr: latestDataDate };
  }, [latestDataDate, year, month]);

  // 初回表示時、portfolioモードかつ当月にデータがなく最新データ月が存在する場合のみ自動移動する（personalモードでは常に今日・当月を表示）
  useEffect(() => {
    if (isLoading) return;
    if (!isPortfolioMode() || hasCurrentMonthData || !latestDataMonthInfo) {
      hasAutoJumpedRef.current = true;
      hasAutoJumpedPatients.add(currentPatientId);
      return;
    }
    if (!hasAutoJumpedRef.current && !hasAutoJumpedPatients.has(currentPatientId)) {
      hasAutoJumpedRef.current = true;
      hasAutoJumpedPatients.add(currentPatientId);
      setSelectedDate(latestDataMonthInfo.dateStr);
      if (propChangeMonth) {
        propChangeMonth(latestDataMonthInfo.year, latestDataMonthInfo.month);
      } else {
        setInternalYear(latestDataMonthInfo.year);
        setInternalMonth(latestDataMonthInfo.month);
      }
    }
  }, [isLoading, hasCurrentMonthData, latestDataMonthInfo, propChangeMonth, currentPatientId]);

  const selectedDaySummary = useMemo(() => {
    return getSelectedDaySummary(selectedDate, aggregatedMap.get(selectedDate), events);
  }, [selectedDate, aggregatedMap, events]);

  const monthlyOverallKpi = useMemo(() => {
    return (
      monthData?.monthlyOverallKpi ??
      calculateMonthlyOverallKpi(year, month, [], hypoThreshold, hyperThreshold)
    );
  }, [monthData, year, month, hypoThreshold, hyperThreshold]);

  const handlePrevMonth = () => {
    hasAutoJumpedRef.current = true;
    hasAutoJumpedPatients.add(currentPatientId);
    if (propPrevMonth) {
      propPrevMonth();
    } else {
      if (month === 1) {
        setInternalYear((y) => y - 1);
        setInternalMonth(12);
      } else {
        setInternalMonth((m) => m - 1);
      }
    }
  };

  const handleNextMonth = () => {
    hasAutoJumpedRef.current = true;
    hasAutoJumpedPatients.add(currentPatientId);
    if (isAtLatestMonth) return;
    if (propNextMonth) {
      propNextMonth();
    } else {
      if (month === 12) {
        setInternalYear((y) => y + 1);
        setInternalMonth(1);
      } else {
        setInternalMonth((m) => m + 1);
      }
    }
  };

  const handleGridNextOrSwipeRightTab = () => {
    if (isAtLatestMonth) {
      onSwipePastLatestMonth?.();
    } else {
      handleNextMonth();
    }
  };

  const handleJumpToLatestDataMonth = () => {
    if (!latestDataMonthInfo) return;
    setSelectedDate(latestDataMonthInfo.dateStr);
    if (propChangeMonth) {
      propChangeMonth(latestDataMonthInfo.year, latestDataMonthInfo.month);
    } else {
      setInternalYear(latestDataMonthInfo.year);
      setInternalMonth(latestDataMonthInfo.month);
    }
  };

  const prevYearMonthSelectionRef = useRef<string>(`${year}-${month}`);

  useEffect(() => {
    const ymKey = `${year}-${month}`;
    if (prevYearMonthSelectionRef.current === ymKey) {
      return;
    }
    prevYearMonthSelectionRef.current = ymKey;

    const pYear = parseInt(selectedDate.slice(0, 4), 10);
    const pMonth = parseInt(selectedDate.slice(5, 7), 10);
    if (pYear !== year || pMonth !== month) {
      if (year === today.getFullYear() && month === today.getMonth() + 1) {
        setSelectedDate(todayStr);
      } else if (
        latestDataDate &&
        parseInt(latestDataDate.slice(0, 4), 10) === year &&
        parseInt(latestDataDate.slice(5, 7), 10) === month
      ) {
        setSelectedDate(latestDataDate);
      } else {
        setSelectedDate(`${year}-${String(month).padStart(2, '0')}-01`);
      }
    }
  }, [year, month, today, todayStr, selectedDate, latestDataDate]);

  const handleSelectDate = (date: string) => {
    setSelectedDate(date);
  };

  const handleOpenDetails = (date?: string) => {
    if (date) setSelectedDate(date);
    setHasOpenedDrawer(true);
    setIsDrawerOpen(true);
  };

  const handlePrevDay = () => {
    const newDateStr = shiftLocalDateStr(selectedDate, -1);
    setSelectedDate(newDateStr);

    const newYear = parseInt(newDateStr.slice(0, 4), 10);
    const newMonth = parseInt(newDateStr.slice(5, 7), 10);
    if (newMonth !== month || newYear !== year) {
      prevYearMonthSelectionRef.current = `${newYear}-${newMonth}`;
      if (propChangeMonth) {
        propChangeMonth(newYear, newMonth);
      } else {
        setInternalYear(newYear);
        setInternalMonth(newMonth);
      }
    }
  };

  const handleNextDay = () => {
    const newDateStr = shiftLocalDateStr(selectedDate, 1);
    const newYear = parseInt(newDateStr.slice(0, 4), 10);
    const newMonth = parseInt(newDateStr.slice(5, 7), 10);
    if (newYear > maxYear || (newYear === maxYear && newMonth > maxMonth)) {
      return;
    }
    setSelectedDate(newDateStr);

    if (newMonth !== month || newYear !== year) {
      prevYearMonthSelectionRef.current = `${newYear}-${newMonth}`;
      if (propChangeMonth) {
        propChangeMonth(newYear, newMonth);
      } else {
        setInternalYear(newYear);
        setInternalMonth(newMonth);
      }
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-slate-50/50 max-sm:h-full max-sm:overflow-hidden">
      {/* 選択日サマリー (ヘッダー直下メイン表示) */}
      <SelectedDaySummary
        selectedDate={selectedDate}
        daySummary={selectedDaySummary}
        monthlyKpi={monthlyOverallKpi}
        onOpenDetails={() => handleOpenDetails(selectedDate)}
      />

      {/* 当月にデータがなく、別の月に実データが存在する場合のクイック移動案内 */}
      {!isLoading && !hasCurrentMonthData && latestDataMonthInfo && (
        <div className="max-w-7xl mx-auto w-full px-1.5 sm:px-6 lg:px-8 pt-1 sm:pt-1.5 shrink-0">
          <div className="flex items-center justify-between gap-1.5 sm:gap-2 px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-xl bg-sky-50 border border-sky-200/80 text-[11px] sm:text-xs text-sky-900 shadow-2xs">
            <div className="flex items-center gap-1.5 min-w-0 truncate">
              <CalendarSearch className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-sky-600 shrink-0" />
              <span className="truncate">
                <span className="hidden sm:inline">{year}年</span>
                {month}月は未記録
                <span className="hidden sm:inline">です。</span>
              </span>
            </div>
            <button
              type="button"
              onClick={handleJumpToLatestDataMonth}
              className="inline-flex items-center gap-1 px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-bold text-[11px] sm:text-xs transition-colors cursor-pointer shadow-2xs shrink-0 whitespace-nowrap"
            >
              <span>
                最新の記録がある {latestDataMonthInfo.year}年{latestDataMonthInfo.month}月 を表示
              </span>
              <ArrowRight className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* 月間カレンダーグリッド (スマホ時は残り高さを100%使い切り縦スクロールゼロで6行均等配置) */}
      <main className="flex-1 min-h-0 flex flex-col">
        <CalendarGrid
          gridDays={gridDays}
          aggregatedMap={aggregatedMap}
          selectedDate={selectedDate}
          onSelectDate={handleSelectDate}
          onOpenDetails={handleOpenDetails}
          onPrevMonth={handlePrevMonth}
          onNextMonth={handleGridNextOrSwipeRightTab}
          isLoading={isLoading}
          hypoThreshold={hypoThreshold}
          hyperThreshold={hyperThreshold}
          transitionDirection={monthTransitionDirection}
        />
      </main>

      {/* 日次詳細ボトムシート / サイドパネル（初回オープン時までチャンク遅延読み込み） */}
      {(isDrawerOpen || hasOpenedDrawer) && (
        <Suspense fallback={null}>
          <DailyDetailDrawer
            isOpen={isDrawerOpen}
            onClose={() => setIsDrawerOpen(false)}
            targetDate={selectedDate}
            daySummary={selectedDaySummary}
            readings={readings}
            events={events}
            onPrevDay={handlePrevDay}
            onNextDay={handleNextDay}
            onReloadData={() => {
              invalidateInMemoryRecentCache(currentPatientId);
              clearCalendarMonthlyCache();
              setLocalRefreshKey((k) => k + 1);
            }}
          />
        </Suspense>
      )}
    </div>
  );
};
