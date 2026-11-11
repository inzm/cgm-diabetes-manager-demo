import React, { useRef } from 'react';
import { DailyAggregatedData } from '@/lib/aggregates';
import { CalendarDayCell } from './CalendarDayCell';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CalendarGridProps {
  gridDays: { date: string; dayNumber: number; isCurrentMonth: boolean; isToday: boolean }[];
  aggregatedMap: Map<string, DailyAggregatedData>;
  selectedDate: string;
  onSelectDate: (date: string) => void;
  onOpenDetails: (date: string) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  isLoading?: boolean;
  hypoThreshold?: number;
  hyperThreshold?: number;
  transitionDirection?: 'forward' | 'backward' | null;
}

export const CalendarGrid: React.FC<CalendarGridProps> = ({
  gridDays,
  aggregatedMap,
  selectedDate,
  onSelectDate,
  onOpenDetails,
  onPrevMonth,
  onNextMonth,
  isLoading = false,
  hypoThreshold = 70,
  hyperThreshold = 180,
  transitionDirection = null,
}) => {
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (document.querySelector('[role="dialog"], [aria-modal="true"], .fixed.inset-0.z-50')) {
      touchStartX.current = null;
      touchStartY.current = null;
      return;
    }
    const touch = e.touches?.[0] ?? e.changedTouches?.[0];
    if (!touch) return;
    touchStartX.current = touch.clientX;
    touchStartY.current = touch.clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const touch = e.changedTouches?.[0] ?? e.touches?.[0];
    const startX = touchStartX.current;
    const startY = touchStartY.current;
    touchStartX.current = null;
    touchStartY.current = null;
    if (!touch) return;
    if (document.querySelector('[role="dialog"], [aria-modal="true"], .fixed.inset-0.z-50')) {
      return;
    }

    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;

    if (Math.abs(deltaX) > Math.abs(deltaY) * 1.2 && Math.abs(deltaX) > 50) {
      (e.nativeEvent as unknown as Record<string, boolean>).__cgmSwipeHandled = true;
      if (deltaX > 0) {
        onPrevMonth();
      } else {
        onNextMonth();
      }
    } else if (deltaY < -50 && Math.abs(deltaY) > Math.abs(deltaX) * 1.2) {
      (e.nativeEvent as unknown as Record<string, boolean>).__cgmSwipeHandled = true;
      // スマホで上スワイプした時は、現在選択中の日付のドロワーを展開する
      onOpenDetails(selectedDate);
    }
  };

  const weekdays = [
    { label: '日', color: 'text-rose-600 bg-rose-50/60' },
    { label: '月', color: 'text-slate-700 bg-slate-50' },
    { label: '火', color: 'text-slate-700 bg-slate-50' },
    { label: '水', color: 'text-slate-700 bg-slate-50' },
    { label: '木', color: 'text-slate-700 bg-slate-50' },
    { label: '金', color: 'text-slate-700 bg-slate-50' },
    { label: '土', color: 'text-blue-600 bg-blue-50/60' },
  ];

  // 月切替アニメーション用に先頭日付をキーとして保持
  const gridKey = gridDays[15]?.date?.slice(0, 7) || 'grid';

  return (
    <div className="flex-1 min-h-0 w-full max-w-7xl mx-auto px-1.5 sm:px-6 lg:px-8 py-1 sm:py-1.5 flex flex-col">
      {/* カレンダーコンテナ (スマホ時は touch-none + flex-1 min-h-0 で縦スクロールを完全抑止し画面高さに100%フィット) */}
      <div
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        className="flex-1 min-h-0 flex flex-col relative bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden select-none max-sm:touch-none"
      >
        {/* ローディング時のフローティングインジケーター */}
        {isLoading && (
          <div className="absolute inset-0 z-20 bg-white/45 backdrop-blur-[1px] flex items-center justify-center transition-opacity duration-200">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-slate-900/85 text-white text-xs font-bold shadow-lg">
              <Loader2 className="w-4 h-4 text-sky-400 animate-spin" />
              <span>カレンダーデータを集計中...</span>
            </div>
          </div>
        )}

        {/* 曜日ヘッダー (日曜始まり: 日=赤, 土=青 / shrink-0 で見切れ防止) */}
        <div className="shrink-0 grid grid-cols-7 border-b border-slate-200 text-center font-bold text-[11px] sm:text-xs divide-x divide-slate-200/70">
          {weekdays.map((w) => (
            <div key={w.label} className={`py-1 ${w.color}`}>
              {w.label}
            </div>
          ))}
        </div>

        {/* 42マスカレンダーグリッド (7列 × 6行均等伸縮: grid-rows-6 flex-1 min-h-0) */}
        <div
          key={gridKey}
          data-testid="calendar-month-grid"
          data-transition-direction={transitionDirection ?? 'none'}
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget) {
              e.currentTarget.style.animation = 'none';
            }
          }}
          onClickCapture={(e) => {
            e.currentTarget.style.animation = 'none';
          }}
          className={cn(
            'flex-1 min-h-0 grid grid-cols-7 grid-rows-6 divide-x divide-y divide-slate-200/70 bg-slate-100',
            transitionDirection === 'forward' && 'cgm-slide-fade-forward',
            transitionDirection === 'backward' && 'cgm-slide-fade-backward'
          )}
        >
          {gridDays.map((cell, idx) => {
            const cellData = aggregatedMap.get(cell.date) || {
              date: cell.date,
              dayNumber: cell.dayNumber,
              isCurrentMonth: cell.isCurrentMonth,
              isToday: cell.isToday,
              recordCount: 0,
              avgGlucose: null,
              minGlucose: null,
              maxGlucose: null,
              tirPercent: null,
              totalCarbs: 0,
              totalInsulin: 0,
              mealCount: 0,
              insulinCount: 0,
              hypoCount: 0,
              hyperCount: 0,
              spikeCount: 0,
              sparklineData: Array(24).fill(null),
            };

            return (
              <CalendarDayCell
                key={cell.date}
                index={idx}
                isLoading={isLoading}
                data={cellData}
                isSelected={cell.date === selectedDate}
                onSelect={onSelectDate}
                onOpenDetails={onOpenDetails}
                hypoThreshold={hypoThreshold}
                hyperThreshold={hyperThreshold}
              />
            );
          })}
        </div>
      </div>

      {/* 下部凡例 (PC表示のみ: スマホ時は選択日サマリー右端の「！」ポップオーバーに集約し縦スクロール競合を防止) */}
      <div className="hidden sm:flex mt-1.5 px-1 flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-slate-600 shrink-0">
        <span className="font-bold text-slate-500">【凡例】</span>
        <span className="inline-flex items-center gap-1">
          <span className="text-rose-500 font-black">▲</span>
          <span>高血糖アラート(&gt;{hyperThreshold})</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="text-blue-500 font-black">▼</span>
          <span>低血糖アラート(&lt;{hypoThreshold})</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <span>🍚</span>
          <span>糖質</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <span>💉</span>
          <span>インスリン</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <span>🩸</span>
          <span>平均血糖値</span>
        </span>
      </div>
    </div>
  );
};
