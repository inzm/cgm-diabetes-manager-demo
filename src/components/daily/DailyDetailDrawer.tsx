import React, { Suspense, lazy, useRef, useState, useEffect } from 'react';
import { SelectedDaySummaryData } from '@/lib/aggregates';
import { LibreReading, HealthEvent, MealDetail } from '@/types/database';
import { usePatient } from '@/contexts/PatientContext';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { db } from '@/lib/db';
import {
  getInMemoryRecentMealDetails,
  invalidateAnalysisDatasetCache,
  invalidateInMemoryRecentCache,
  pauseBackgroundHydration,
  waitForRecentPersistence,
} from '@/lib/realGlucoseLoader';
import { triggerBackgroundCloudSync } from '@/lib/syncEngine';
import { formatJapaneseDateWithWeekday } from '@/lib/dateUtils';
import { useAnimatedModal } from '@/lib/useAnimatedModal';
import {
  X,
  ChevronLeft,
  ChevronRight,
  Utensils,
  Edit3,
  Trash2,
  Lock,
  Footprints,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// チャートおよび編集モーダルを遅延読み込みし初期表示バンドルから分離
const DailyGlucoseChart = lazy(() =>
  import('./DailyGlucoseChart').then((m) => ({ default: m.DailyGlucoseChart }))
);
const MealRecordModal = lazy(() =>
  import('@/components/records/MealRecordModal').then((m) => ({ default: m.MealRecordModal }))
);
const ActivityRecordModal = lazy(() =>
  import('@/components/records/ActivityRecordModal').then((m) => ({
    default: m.ActivityRecordModal,
  }))
);

interface DailyDetailDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  targetDate: string; // YYYY-MM-DD
  daySummary: SelectedDaySummaryData;
  readings: LibreReading[];
  events: HealthEvent[];
  onPrevDay: () => void;
  onNextDay: () => void;
  onReloadData?: () => void;
}

export const DailyDetailDrawer: React.FC<DailyDetailDrawerProps> = ({
  isOpen,
  onClose,
  targetDate,
  daySummary,
  readings,
  events,
  onPrevDay,
  onNextDay,
  onReloadData,
}) => {
  const { currentPatientId, isReadOnly } = usePatient();

  // ドロワーの滑らかなスライドイン・スライドアウト用2段階マウント状態
  const { shouldRender, isVisible } = useAnimatedModal(isOpen, 280);

  const [isMealModalOpen, setIsMealModalOpen] = useState<boolean>(false);
  const [hasOpenedMealModal, setHasOpenedMealModal] = useState<boolean>(false);
  const [isActivityModalOpen, setIsActivityModalOpen] = useState<boolean>(false);
  const [hasOpenedActivityModal, setHasOpenedActivityModal] = useState<boolean>(false);
  const [editEventId, setEditEventId] = useState<string | null>(null);
  const [deleteTargetEvent, setDeleteTargetEvent] = useState<HealthEvent | null>(null);
  const [mealDetailsMap, setMealDetailsMap] = useState<Record<string, MealDetail[]>>({});

  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const lastTouchY = useRef<number | null>(null);
  const touchStartScrollTop = useRef<number>(0);
  const touchStartedInHeader = useRef<boolean>(false);
  const touchStartedInScroller = useRef<boolean>(false);
  const drawerRootRef = useRef<HTMLDivElement>(null);
  const drawerPanelRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const headerAreaRef = useRef<HTMLDivElement>(null);

  // モバイル実機で下スワイプ時にブラウザ標準の Pull-to-Refresh（引っ張ってリロード）が発動しないよう
  // ドロワー表示中は body のオーバースクロールをロックし、non-passive touchmove で下方向オーバースクロールを即座に抑止する
  useEffect(() => {
    const rootEl = drawerRootRef.current;
    if (!rootEl || !shouldRender) return;

    const prevBodyOverscrollY = document.body.style.overscrollBehaviorY;
    const prevHtmlOverscrollY = document.documentElement.style.overscrollBehaviorY;
    document.body.style.overscrollBehaviorY = 'none';
    document.documentElement.style.overscrollBehaviorY = 'none';

    const recordTouchStart = (target: EventTarget | null, clientX: number, clientY: number) => {
      touchStartX.current = clientX;
      touchStartY.current = clientY;
      lastTouchY.current = clientY;
      touchStartScrollTop.current = scrollContainerRef.current?.scrollTop ?? 0;
      const node = target as Node | null;
      touchStartedInHeader.current = Boolean(
        node && headerAreaRef.current && headerAreaRef.current.contains(node)
      );
      touchStartedInScroller.current = Boolean(
        node && scrollContainerRef.current && scrollContainerRef.current.contains(node)
      );
    };

    const handleNativeTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 0) return;
      recordTouchStart(e.target, e.touches[0].clientX, e.touches[0].clientY);
    };

    const handleNativeTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 0) return;
      const currentX = e.touches[0].clientX;
      const currentY = e.touches[0].clientY;
      if (touchStartX.current === null || touchStartY.current === null) {
        recordTouchStart(e.target, currentX, currentY);
      }
      const deltaY = currentY - (touchStartY.current ?? currentY);
      const stepDeltaY = currentY - (lastTouchY.current ?? currentY);
      lastTouchY.current = currentY;
      const currentScrollTop = scrollContainerRef.current?.scrollTop ?? 0;

      // 1) ヘッダー・ドラッグバー・フッター・背景オーバーレイ（スクロール領域外）での下方向移動、または
      // 2) 内部スクロール領域が最上部 (scrollTop <= 0) にある状態での下方向移動（初期1〜2pxの横ブレや途中から最上部に達した場合も含む）
      // では即座に preventDefault() を呼び、モバイルブラウザの Pull-to-Refresh 介入を100%遮断する
      const isPullingDown = deltaY > 0 || stepDeltaY > 0;
      const isAtOrAboveScrollerTop =
        touchStartedInHeader.current ||
        !touchStartedInScroller.current ||
        currentScrollTop <= 0 ||
        (touchStartScrollTop.current <= 5 && currentScrollTop <= 5 && deltaY > 0);

      if (isPullingDown && isAtOrAboveScrollerTop) {
        if (e.cancelable) {
          e.preventDefault();
        }
      }
    };

    rootEl.addEventListener('touchstart', handleNativeTouchStart, { passive: true });
    rootEl.addEventListener('touchmove', handleNativeTouchMove, { passive: false });
    return () => {
      rootEl.removeEventListener('touchstart', handleNativeTouchStart);
      rootEl.removeEventListener('touchmove', handleNativeTouchMove);
      document.body.style.overscrollBehaviorY = prevBodyOverscrollY;
      document.documentElement.style.overscrollBehaviorY = prevHtmlOverscrollY;
    };
  }, [shouldRender]);

  // 当日の食事イベントに紐づく食品明細 (meal_details) を event_id インデックス経由でピンポイント取得
  useEffect(() => {
    async function loadDayMealDetails() {
      if (!isOpen) return;
      const mealEventIds = events
        .filter(
          (e) =>
            !e.is_deleted &&
            e.event_datetime.startsWith(targetDate) &&
            e.event_type === '食事'
        )
        .map((e) => e.id);

      if (mealEventIds.length === 0) {
        setMealDetailsMap({});
        return;
      }

      const inMemoryDetails = getInMemoryRecentMealDetails(currentPatientId, mealEventIds);
      const dayDetails =
        inMemoryDetails ??
        (await db.meal_details
          .where('event_id')
          .anyOf(mealEventIds)
          .filter((d) => !d.is_deleted && d.user_id === currentPatientId)
          .toArray());

      const grouped: Record<string, MealDetail[]> = {};
      for (const d of dayDetails) {
        if (!grouped[d.event_id]) grouped[d.event_id] = [];
        grouped[d.event_id].push(d);
      }
      setMealDetailsMap(grouped);
    }

    loadDayMealDetails();
  }, [isOpen, targetDate, events, currentPatientId]);

  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches?.[0] ?? e.changedTouches?.[0];
    if (!touch) return;
    touchStartX.current = touch.clientX;
    touchStartY.current = touch.clientY;
    lastTouchY.current = touch.clientY;
    touchStartScrollTop.current = scrollContainerRef.current?.scrollTop ?? 0;
    const node = e.target as Node | null;
    touchStartedInHeader.current = Boolean(
      node && headerAreaRef.current && headerAreaRef.current.contains(node)
    );
    touchStartedInScroller.current = Boolean(
      node && scrollContainerRef.current && scrollContainerRef.current.contains(node)
    );
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const touch = e.changedTouches?.[0] ?? e.touches?.[0];
    if (!touch) return;
    const deltaX = touch.clientX - touchStartX.current;
    const deltaY = touch.clientY - touchStartY.current;

    if (Math.abs(deltaX) > Math.abs(deltaY) * 1.2 && Math.abs(deltaX) > 50) {
      if (deltaX > 0) {
        onPrevDay();
      } else {
        onNextDay();
      }
    } else if (deltaY > 55 && Math.abs(deltaY) > Math.abs(deltaX) * 1.2) {
      // 上部ドラッグバー・ヘッダー・スクロール外領域からの下スワイプ、またはスクロール最上部での下スワイプ時にドロワーを閉じる
      const currentScrollTop = scrollContainerRef.current?.scrollTop ?? 0;
      if (
        touchStartedInHeader.current ||
        !touchStartedInScroller.current ||
        (touchStartScrollTop.current <= 5 && currentScrollTop <= 5)
      ) {
        onClose();
      }
    }
    touchStartX.current = null;
    touchStartY.current = null;
    lastTouchY.current = null;
  };

  if (!shouldRender) return null;

  const { formattedDate, dayOfWeek } = formatJapaneseDateWithWeekday(targetDate);

  // 当日のイベントを「食事情報」と「イベント情報（高血糖・低血糖・活動・単体インスリン）」に分離
  const dayAllEvents = events
    .filter((e) => !e.is_deleted && e.event_datetime.startsWith(targetDate))
    .sort((a, b) => a.event_datetime.localeCompare(b.event_datetime));

  const mealEvents = dayAllEvents.filter((e) => e.event_type === '食事');
  const otherEvents = dayAllEvents.filter((e) => e.event_type !== '食事');

  const totalAnomalies = daySummary.hypoCount + daySummary.hyperCount;
  const totalCarbsFormatted = Number.isInteger(daySummary.totalCarbs)
    ? daySummary.totalCarbs
    : daySummary.totalCarbs.toFixed(1);

  const handleEditClick = (event: HealthEvent) => {
    if (isReadOnly) return;
    setEditEventId(event.id);
    if (event.event_type === '食事') {
      setHasOpenedMealModal(true);
      setIsMealModalOpen(true);
    } else {
      setHasOpenedActivityModal(true);
      setIsActivityModalOpen(true);
    }
  };

  const handleDeleteClick = (event: HealthEvent) => {
    if (isReadOnly) return;
    setDeleteTargetEvent(event);
  };

  const executeDeleteEvent = async () => {
    if (isReadOnly || !deleteTargetEvent) return;
    const event = deleteTargetEvent;
    setDeleteTargetEvent(null);

    try {
      pauseBackgroundHydration(currentPatientId, 3000);
      await waitForRecentPersistence(currentPatientId);
      const nowIso = new Date().toISOString();
      await db.transaction('rw', [db.events, db.meal_details], async () => {
        await db.events.update(event.id, { is_deleted: true, updated_at: nowIso });
        if (event.event_type === '食事') {
          const details = await db.meal_details.where('event_id').equals(event.id).toArray();
          if (details.length > 0) {
            await db.meal_details.bulkPut(
              details.map((d) => ({ ...d, is_deleted: true, updated_at: nowIso }))
            );
          }
        }
      });
      invalidateInMemoryRecentCache(currentPatientId);
      invalidateAnalysisDatasetCache(currentPatientId);
      triggerBackgroundCloudSync(currentPatientId);
      if (onReloadData) onReloadData();
    } catch (err) {
      console.error('[DailyDetailDrawer] Delete failed:', err);
    }
  };

  const handleAddMeal = () => {
    if (isReadOnly) return;
    setEditEventId(null);
    setHasOpenedMealModal(true);
    setIsMealModalOpen(true);
  };

  const handleAddActivity = () => {
    if (isReadOnly) return;
    setEditEventId(null);
    setHasOpenedActivityModal(true);
    setIsActivityModalOpen(true);
  };

  const handleSuccess = () => {
    if (onReloadData) onReloadData();
  };

  const deleteTargetName = deleteTargetEvent
    ? deleteTargetEvent.timing_category || deleteTargetEvent.memo || deleteTargetEvent.event_type
    : '';

  return (
    <>
      <div
        ref={drawerRootRef}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        className="fixed inset-0 z-50 overflow-hidden overscroll-none"
      >
        {/* 背景オーバーレイ (フェードイン・フェードアウトアニメーション) */}
        <div
          onClick={onClose}
          className={cn(
            'absolute inset-0 bg-slate-900/45 backdrop-blur-xs transition-opacity duration-300 ease-out touch-none overscroll-none',
            isVisible ? 'opacity-100' : 'opacity-0'
          )}
        />

        <div className="absolute inset-0 flex justify-end pointer-events-none">
          {/* パネル本体 (モバイル: 下からスライドアップ / PC: 右からスライドイン) */}
          <div
            ref={drawerPanelRef}
            className={cn(
              'pointer-events-auto relative w-full bg-white shadow-2xl flex flex-col overscroll-contain transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
              'max-md:mt-auto max-md:max-h-[90vh] max-md:rounded-t-2xl',
              'md:w-[580px] md:h-full',
              isVisible
                ? 'max-md:translate-y-0 md:translate-x-0'
                : 'max-md:translate-y-full md:translate-x-full'
            )}
          >
            {/* 上部ドラッグバー & ヘッダー領域 (下スワイプでドロワー収納対応・ブラウザPull-to-Refresh抑止) */}
            <div ref={headerAreaRef} className="touch-pan-x select-none">
              <div className="md:hidden flex justify-center pt-2.5 pb-1 cursor-grab active:cursor-grabbing">
                <div className="w-12 h-1.5 rounded-full bg-slate-300" />
              </div>

              {/* ヘッダー: 日付ナビゲーション & 閉じるボタン */}
              <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-slate-200 bg-slate-50/70">
                <div className="flex items-center gap-2">
                  <button
                    onClick={onPrevDay}
                    aria-label="前日"
                    className="inline-flex items-center gap-0.5 px-2.5 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 active:scale-95 text-xs font-semibold text-slate-700 transition-all cursor-pointer"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>前日</span>
                  </button>
                  <h3
                    className={cn(
                      'text-sm sm:text-base font-extrabold tracking-tight transition-colors duration-200',
                      dayOfWeek === 0
                        ? 'text-rose-600'
                        : dayOfWeek === 6
                          ? 'text-blue-600'
                          : 'text-slate-800'
                    )}
                  >
                    {formattedDate}
                  </h3>
                  <button
                    onClick={onNextDay}
                    aria-label="翌日"
                    className="inline-flex items-center gap-0.5 px-2.5 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 active:scale-95 text-xs font-semibold text-slate-700 transition-all cursor-pointer"
                  >
                    <span>翌日</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>

                <button
                  onClick={onClose}
                  aria-label="閉じる"
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200/60 active:scale-95 transition-all cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* スクロール可能コンテンツ領域 (前日・翌日切替時にフェード＆スライド遷移) */}
            <div
              ref={scrollContainerRef}
              key={targetDate}
              className="cgm-drawer-content-enter flex-1 overflow-y-auto overscroll-y-contain p-3.5 sm:p-4 space-y-3.5 sm:space-y-4"
            >
              {/* 1. 概要 (旧VBA準拠の4列サマリーテーブル) */}
              <div>
                <h4 className="text-xs font-bold text-slate-700 border-l-3 border-slate-800 pl-2 mb-1.5">
                  概要
                </h4>
                <div className="grid grid-cols-4 divide-x divide-slate-200 rounded-xl border border-slate-200 overflow-hidden bg-white text-center shadow-2xs">
                  <div className="p-2">
                    <div className="text-[10px] text-slate-500 font-semibold bg-slate-50 -mx-2 -mt-2 py-1 mb-1 border-b border-slate-200">
                      血糖値平均
                    </div>
                    <span className="text-sm sm:text-base font-extrabold text-rose-700 tabular-nums">
                      {daySummary.avgGlucose !== null ? `${daySummary.avgGlucose}` : '--'}
                    </span>
                    <span className="text-[10px] text-slate-500 ml-0.5 font-semibold">mg/dL</span>
                  </div>

                  <div className="p-2">
                    <div className="text-[10px] text-slate-500 font-semibold bg-slate-50 -mx-2 -mt-2 py-1 mb-1 border-b border-slate-200">
                      糖質総量
                    </div>
                    <span className="text-sm sm:text-base font-extrabold text-amber-700 tabular-nums">
                      {totalCarbsFormatted}
                    </span>
                    <span className="text-[10px] text-slate-500 ml-0.5 font-semibold">g</span>
                  </div>

                  <div className="p-2">
                    <div className="text-[10px] text-slate-500 font-semibold bg-slate-50 -mx-2 -mt-2 py-1 mb-1 border-b border-slate-200">
                      インスリン量
                    </div>
                    <span className="text-sm sm:text-base font-extrabold text-sky-700 tabular-nums">
                      {daySummary.totalInsulin || 0}
                    </span>
                    <span className="text-[10px] text-slate-500 ml-0.5 font-semibold">単位</span>
                  </div>

                  <div className="p-2">
                    <div className="text-[10px] text-slate-500 font-semibold bg-slate-50 -mx-2 -mt-2 py-1 mb-1 border-b border-slate-200">
                      異常回数
                    </div>
                    {totalAnomalies > 0 ? (
                      <div className="inline-flex items-center justify-center gap-1.5 text-xs sm:text-sm font-black tabular-nums">
                        {daySummary.hypoCount > 0 && (
                          <span className="text-blue-600">▼{daySummary.hypoCount}</span>
                        )}
                        {daySummary.hyperCount > 0 && (
                          <span className="text-rose-600">▲{daySummary.hyperCount}</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-sm sm:text-base font-extrabold text-slate-400">
                        0 回
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* 2. 血糖値の推移 (24時間グラフ + 垂直ドロップ破線) */}
              <div>
                <h4 className="text-xs font-bold text-slate-700 border-l-3 border-slate-800 pl-2 mb-1.5">
                  血糖値の推移
                </h4>
                <Suspense
                  fallback={
                    <div
                      style={{ height: 220 }}
                      className="flex items-center justify-center bg-slate-50 rounded-xl border border-slate-200 text-xs text-slate-400"
                    >
                      グラフを読み込み中...
                    </div>
                  }
                >
                  <DailyGlucoseChart
                    targetDate={targetDate}
                    readings={readings}
                    events={events}
                    height={220}
                  />
                </Suspense>
              </div>

              {/* 3. 食事情報 (朝食・昼食・夕食ごとの食品明細 & 区分別糖質合計 & 食前・食後ピーク血糖値) */}
              <div>
                <div className="flex items-center justify-between bg-slate-100 px-3 py-1.5 rounded-t-lg border border-slate-200">
                  <h4 className="text-xs font-bold text-slate-800">食事情報</h4>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white text-slate-600 border border-slate-200/80 tabular-nums">
                    {mealEvents.length}件
                  </span>
                </div>

                <div className="border-x border-b border-slate-200 rounded-b-lg divide-y divide-slate-200 bg-white">
                  {mealEvents.length === 0 ? (
                    <div className="p-4 text-center text-xs text-slate-400">
                      この日の食事記録はありません
                    </div>
                  ) : (
                    mealEvents.map((meal) => {
                      const timeStr = meal.event_datetime.slice(11, 16);
                      const details = mealDetailsMap[meal.id] || [];
                      const mealTotalCarbs =
                        details.length > 0
                          ? details.reduce((s, d) => s + (Number(d.carbs) || 0), 0)
                          : Number(meal.total_carbs) || 0;
                      const hasGlucoseLink =
                        meal.pre_meal_glucose != null || meal.post_meal_glucose != null;
                      const glucoseDelta =
                        meal.pre_meal_glucose != null && meal.post_meal_glucose != null
                          ? Math.round(meal.post_meal_glucose - meal.pre_meal_glucose)
                          : null;

                      return (
                        <div key={meal.id} className="p-2.5 sm:p-3 space-y-1.5">
                          {/* 食事区分ヘッダー */}
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-xs font-extrabold text-slate-900">
                                {meal.timing_category || '食事'} ({timeStr})
                              </span>
                              {meal.insulin_units ? (
                                <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-sky-50 text-sky-700 border border-sky-200/80 tabular-nums">
                                  インスリン: {meal.insulin_units}単位
                                </span>
                              ) : null}
                              {hasGlucoseLink && (
                                <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200/80 tabular-nums">
                                  🩸食前 {meal.pre_meal_glucose ?? '--'} → ピーク{' '}
                                  {meal.post_meal_glucose ?? '--'}
                                  {glucoseDelta !== null && (
                                    <span className="ml-0.5">
                                      ({glucoseDelta >= 0 ? `+${glucoseDelta}` : glucoseDelta})
                                    </span>
                                  )}
                                </span>
                              )}
                            </div>

                            {!isReadOnly && (
                              <div className="flex items-center gap-1.5 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => handleEditClick(meal)}
                                  aria-label="この食事を編集"
                                  className="w-8 h-8 rounded-lg border border-sky-200/90 bg-sky-50 text-sky-600 hover:bg-sky-100 hover:text-sky-700 active:scale-95 flex items-center justify-center cursor-pointer transition-all shadow-2xs"
                                  title="この食事を編集"
                                >
                                  <Edit3 className="w-4 h-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteClick(meal)}
                                  aria-label="この食事を削除"
                                  className="w-8 h-8 rounded-lg border border-rose-200/90 bg-rose-50 text-rose-600 hover:bg-rose-100 hover:text-rose-700 active:scale-95 flex items-center justify-center cursor-pointer transition-all shadow-2xs"
                                  title="この食事を削除"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            )}
                          </div>

                          {/* 食べた食品明細リスト */}
                          {details.length > 0 ? (
                            <div className="pl-3 space-y-1 divide-y divide-slate-100 text-xs">
                              {details.map((d) => (
                                <div
                                  key={d.id}
                                  className="grid grid-cols-12 items-center pt-1 text-slate-700"
                                >
                                  <span className="col-span-6 truncate font-medium">
                                    {d.food_name}
                                  </span>
                                  <span className="col-span-3 text-slate-500 text-right pr-2 tabular-nums">
                                    {d.amount ?? 1}
                                    {d.unit ?? ''}
                                  </span>
                                  <span className="col-span-3 text-right font-semibold text-slate-800 tabular-nums">
                                    {(Number(d.carbs) || 0).toFixed(1)}g
                                  </span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            meal.memo && (
                              <div className="pl-3 text-xs text-slate-600">{meal.memo}</div>
                            )
                          )}

                          {/* 食事区分ごとの糖質量合計 */}
                          <div className="flex justify-end pt-1 border-t border-slate-100">
                            <span className="text-xs font-extrabold text-slate-900 tabular-nums">
                              合計: {mealTotalCarbs.toFixed(1)}g
                            </span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* 4. イベント情報 (高血糖・低血糖・活動・単体インスリンを食事情報から完全分離) */}
              <div>
                <div className="flex items-center justify-between bg-slate-100 px-3 py-1.5 rounded-t-lg border border-slate-200">
                  <h4 className="text-xs font-bold text-slate-800">イベント情報</h4>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white text-slate-600 border border-slate-200/80 tabular-nums">
                    {otherEvents.length}件
                  </span>
                </div>

                <div className="border-x border-b border-slate-200 rounded-b-lg divide-y divide-slate-100 bg-white">
                  {otherEvents.length === 0 ? (
                    <div className="p-4 text-center text-xs text-slate-400">
                      この日のイベント記録はありません
                    </div>
                  ) : (
                    otherEvents.map((ev) => {
                      const timeStr = ev.event_datetime.slice(11, 16);
                      const isHypo = ev.event_type === '低血糖';
                      const isHyper = ev.event_type === '高血糖';
                      const typeLabel = isHyper
                        ? '▲ 高血糖'
                        : isHypo
                          ? '▼ 低血糖'
                          : ev.timing_category || ev.event_type;

                      return (
                        <div
                          key={ev.id}
                          className="flex items-center justify-between px-3 py-2 text-xs hover:bg-slate-50/70 transition-colors"
                        >
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <span className="font-mono text-slate-500 shrink-0 w-10 text-right">
                              {timeStr}
                            </span>
                            <span
                              className={cn(
                                'font-extrabold shrink-0 min-w-[72px]',
                                isHyper
                                  ? 'text-rose-600'
                                  : isHypo
                                    ? 'text-blue-600'
                                    : 'text-slate-800'
                              )}
                            >
                              {typeLabel}
                            </span>
                            <span className="text-slate-600 truncate">
                              {ev.memo ||
                                (ev.duration_minutes ? `実施時間: ${ev.duration_minutes}分` : '')}
                            </span>
                          </div>

                          {!isReadOnly && !isHypo && !isHyper && (
                            <div className="flex items-center gap-1.5 shrink-0 ml-2">
                              <button
                                type="button"
                                onClick={() => handleEditClick(ev)}
                                aria-label="編集"
                                className="w-8 h-8 rounded-lg border border-sky-200/90 bg-sky-50 text-sky-600 hover:bg-sky-100 hover:text-sky-700 active:scale-95 flex items-center justify-center cursor-pointer transition-all shadow-2xs"
                                title="編集"
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteClick(ev)}
                                aria-label="削除"
                                className="w-8 h-8 rounded-lg border border-rose-200/90 bg-rose-50 text-rose-600 hover:bg-rose-100 hover:text-rose-700 active:scale-95 flex items-center justify-center cursor-pointer transition-all shadow-2xs"
                                title="削除"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            {/* 下部固定アクションフッター (旧VBA準拠の「食事を記録」「活動を記録」ボタン) */}
            <div className="px-4 sm:px-5 py-3 border-t border-slate-200 bg-slate-50 grid grid-cols-2 gap-3">
              <button
                type="button"
                disabled={isReadOnly}
                onClick={handleAddMeal}
                className={cn(
                  'flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs sm:text-sm font-bold shadow-xs transition-all',
                  isReadOnly
                    ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                    : 'bg-amber-600 hover:bg-amber-700 text-white cursor-pointer active:scale-95'
                )}
              >
                {isReadOnly ? <Lock className="w-4 h-4" /> : <Utensils className="w-4 h-4" />}
                <span>食事を記録</span>
              </button>

              <button
                type="button"
                disabled={isReadOnly}
                onClick={handleAddActivity}
                className={cn(
                  'flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs sm:text-sm font-bold shadow-xs transition-all',
                  isReadOnly
                    ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                    : 'bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer active:scale-95'
                )}
              >
                {isReadOnly ? <Lock className="w-4 h-4" /> : <Footprints className="w-4 h-4" />}
                <span>活動を記録</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 食事モーダル（開いた時のみチャンクを読み込み、閉じた後もフェードアウト完了までマウント維持） */}
      {(isMealModalOpen || hasOpenedMealModal) && (
        <Suspense fallback={null}>
          <MealRecordModal
            isOpen={isMealModalOpen}
            onClose={() => {
              setIsMealModalOpen(false);
              setEditEventId(null);
            }}
            onSuccess={handleSuccess}
            initialDate={targetDate}
            editEventId={editEventId}
          />
        </Suspense>
      )}

      {/* 活動モーダル（開いた時のみチャンクを読み込み、閉じた後もフェードアウト完了までマウント維持） */}
      {(isActivityModalOpen || hasOpenedActivityModal) && (
        <Suspense fallback={null}>
          <ActivityRecordModal
            isOpen={isActivityModalOpen}
            onClose={() => {
              setIsActivityModalOpen(false);
              setEditEventId(null);
            }}
            onSuccess={handleSuccess}
            initialDate={targetDate}
            editEventId={editEventId}
          />
        </Suspense>
      )}

      {/* 記録削除確認ダイアログ */}
      <ConfirmDialog
        isOpen={!!deleteTargetEvent}
        title="記録の削除確認"
        message={`「${deleteTargetName}」の記録を削除してもよろしいですか？`}
        cancelLabel="キャンセル"
        confirmLabel="削除する"
        variant="danger"
        onCancel={() => setDeleteTargetEvent(null)}
        onConfirm={executeDeleteEvent}
      />
    </>
  );
};
