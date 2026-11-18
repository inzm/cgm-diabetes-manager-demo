import React, { useState, useEffect, useRef } from 'react';
import { usePatient } from '@/contexts/PatientContext';
import { SelectedDaySummaryData, MonthlyOverallKpi } from '@/lib/aggregates';
import { formatCalendarDayLabels } from '@/lib/dateUtils';
import { Droplets, Utensils, Syringe, AlertTriangle, AlertCircle, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SelectedDaySummaryProps {
  selectedDate: string; // YYYY-MM-DD
  daySummary: SelectedDaySummaryData;
  monthlyKpi?: MonthlyOverallKpi;
  onOpenDetails: () => void;
}

export const SelectedDaySummary: React.FC<SelectedDaySummaryProps> = ({
  selectedDate,
  daySummary,
  onOpenDetails,
}) => {
  const { hypoThreshold, hyperThreshold } = usePatient();
  const [isLegendOpen, setIsLegendOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isLegendOpen) return;
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setIsLegendOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [isLegendOpen]);

  const {
    dayOfWeek,
    weekdayLabel,
    formattedMonthDayWithWeekday: formattedDate,
    compactMobileDate,
  } = formatCalendarDayLabels(selectedDate);

  const dateBadgeStyle =
    dayOfWeek === 0
      ? 'bg-rose-50 border-rose-200/90 text-rose-600'
      : dayOfWeek === 6
      ? 'bg-blue-50 border-blue-200/90 text-blue-600'
      : 'bg-slate-100 border-slate-300/90 text-slate-900';

  const avg = daySummary.avgGlucose;
  const glucoseColor =
    avg === null
      ? 'text-slate-400'
      : avg < hypoThreshold
      ? 'text-blue-600'
      : avg > hyperThreshold
      ? 'text-rose-600'
      : 'text-slate-700';

  const totalCarbsDisplay = Number.isInteger(daySummary.totalCarbs)
    ? daySummary.totalCarbs
    : daySummary.totalCarbs.toFixed(1);

  return (
    <div className="shrink-0 sticky top-12 max-sm:relative max-sm:top-0 z-30 bg-white/95 backdrop-blur-xs border-b border-slate-200/90 shadow-xs">
      <div className="max-w-7xl mx-auto px-2.5 sm:px-6 lg:px-8 py-2 sm:py-2.5 relative">
        {/* モバイル用: 2段構成の視認性重視サマリー (1段目: 日付・異常値・凡例 / 2段目: 血糖・糖質・インスリン) */}
        <div
          onClick={onOpenDetails}
          role="button"
          tabIndex={0}
          className="sm:hidden space-y-1.5 cursor-pointer"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex-1 flex items-center justify-between gap-2 min-w-0 active:opacity-75">
              <span
                className={cn(
                  'inline-flex items-baseline gap-1 px-3 py-1 rounded-lg border shadow-2xs whitespace-nowrap shrink-0',
                  dateBadgeStyle
                )}
              >
                <span className="text-[15px] font-black tracking-tight tabular-nums">
                  {compactMobileDate}
                </span>{' '}
                {weekdayLabel && (
                  <span className="text-xs font-extrabold">{weekdayLabel}</span>
                )}
              </span>

              {/* 異常値回数 (▼=青系, ▲=赤系) */}
              <span className="inline-flex items-center gap-2 whitespace-nowrap font-extrabold tabular-nums text-xs bg-slate-50 px-2.5 py-1 rounded-lg border border-slate-200/80">
                <span className="text-blue-600">▼低 {daySummary.hypoCount}</span>
                <span className="text-slate-300">/</span>
                <span className="text-rose-600">▲高 {daySummary.hyperCount}</span>
              </span>
            </div>

            {/* 右端: スマホ用 凡例ポップオーバートグルボタン (「！」アイコン) */}
            <div
              ref={popoverRef}
              onClick={(e) => e.stopPropagation()}
              className="relative shrink-0"
            >
            <button
              type="button"
              aria-label="凡例を表示"
              onClick={(e) => {
                e.stopPropagation();
                setIsLegendOpen((prev) => !prev);
              }}
              className={cn(
                'w-7 h-7 rounded-full flex items-center justify-center border transition-all cursor-pointer active:scale-95',
                isLegendOpen
                  ? 'bg-sky-600 text-white border-sky-600 shadow-xs'
                  : 'bg-slate-100 text-slate-500 border-slate-200/90 hover:bg-slate-200'
              )}
              title="カレンダー記号の凡例"
            >
              <AlertCircle className="w-4 h-4" />
            </button>

            {isLegendOpen && (
              <div className="cgm-popover-enter absolute right-0 top-8 z-50 w-64 p-3 rounded-2xl bg-white border border-slate-200 shadow-xl text-xs text-slate-700 space-y-2">
                <div className="flex items-center justify-between pb-1.5 border-b border-slate-100">
                  <span className="font-extrabold text-slate-800">カレンダーの見方・操作</span>
                  <button
                    type="button"
                    onClick={() => setIsLegendOpen(false)}
                    className="p-0.5 rounded text-slate-400 hover:text-slate-600 cursor-pointer"
                    aria-label="凡例を閉じる"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                  <span className="inline-flex items-center gap-1">
                    <span className="text-rose-500 font-black">▲</span>
                    <span>高血糖(&gt;{hyperThreshold})</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="text-blue-500 font-black">▼</span>
                    <span>低血糖(&lt;{hypoThreshold})</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span>🍚</span>
                    <span>糖質合計(g)</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span>💉</span>
                    <span>インスリン(U)</span>
                  </span>
                  <span className="inline-flex items-center gap-1 col-span-2">
                    <span>🩸</span>
                    <span>平均血糖値 (mg/dL)</span>
                  </span>
                  <span className="inline-flex items-center gap-1 col-span-2">
                    <span
                      className="inline-block w-3 h-3 rounded-xs bg-amber-50 border border-amber-300 shrink-0"
                      aria-hidden="true"
                    />
                    <span>同じ食事が2件</span>
                  </span>
                </div>
                <div className="pt-1.5 border-t border-slate-100 text-[10px] text-slate-500 leading-relaxed">
                  ・左右スワイプ：前月 / 翌月（最新月は食品・活動へ）
                  <br />
                  ・上スワイプ：選択日の詳細を開く
                </div>
              </div>
            )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-1.5 active:opacity-75">
            {/* 平均血糖 */}
            <div className="flex items-center justify-center gap-1 py-1 px-1.5 rounded-lg bg-slate-50 border border-slate-200/80 whitespace-nowrap">
              <span className="text-xs">🩸</span>
              <span className={cn('text-sm font-black tabular-nums', glucoseColor)}>
                {avg !== null ? avg : '--'}
              </span>
              <span className="text-[10px] font-semibold text-slate-400">mg/dL</span>
            </div>

            {/* 糖質 */}
            <div className="flex items-center justify-center gap-1 py-1 px-1.5 rounded-lg bg-slate-50 border border-slate-200/80 whitespace-nowrap">
              <span className="text-xs">🍚</span>
              <span className="text-sm font-black text-amber-700 tabular-nums">{totalCarbsDisplay}</span>
              <span className="text-[10px] font-semibold text-slate-400">g</span>
            </div>

            {/* インスリン */}
            <div className="flex items-center justify-center gap-1 py-1 px-1.5 rounded-lg bg-slate-50 border border-slate-200/80 whitespace-nowrap">
              <span className="text-xs">💉</span>
              <span className="text-sm font-black text-sky-700 tabular-nums">
                {daySummary.totalInsulin}
              </span>
              <span className="text-[10px] font-semibold text-slate-400">U</span>
            </div>
          </div>
        </div>

        {/* デスクトップ用: コンパクト横並びバー */}
        <div
          onClick={onOpenDetails}
          role="button"
          tabIndex={0}
          className="hidden sm:flex items-center justify-between gap-4 cursor-pointer group"
        >
          {/* 左側: 選択日付（曜日別カラー強調バッジ） */}
          <div className="flex items-center gap-2 shrink-0 min-w-[150px]">
            <span
              className={cn(
                'inline-flex items-center px-4 py-2 rounded-xl border text-lg font-black tracking-tight tabular-nums shadow-2xs',
                dateBadgeStyle
              )}
            >
              {formattedDate}
            </span>
          </div>

          {/* 右側: 4大指標コンパクトグリッド */}
          <div className="flex-1 grid grid-cols-4 gap-2.5">
            {/* 1. 平均血糖値 */}
            <div className="flex items-center justify-between px-3.5 py-2 rounded-xl border border-slate-200/90 bg-slate-50/60 group-hover:border-rose-300 transition-colors">
              <span className="flex items-center gap-1.5 text-xs sm:text-sm font-bold text-slate-600">
                <Droplets className="w-4 h-4 text-rose-500" />
                平均血糖値
              </span>
              <div className="flex items-baseline gap-1">
                <span className={cn('text-lg font-black tabular-nums', glucoseColor)}>
                  {avg !== null ? avg : '--'}
                </span>
                <span className="text-xs text-slate-400 font-medium">mg/dL</span>
              </div>
            </div>

            {/* 2. 糖質量合計 */}
            <div className="flex items-center justify-between px-3.5 py-2 rounded-xl border border-slate-200/90 bg-slate-50/60 group-hover:border-amber-300 transition-colors">
              <span className="flex items-center gap-1.5 text-xs sm:text-sm font-bold text-slate-600">
                <Utensils className="w-4 h-4 text-amber-500" />
                糖質量合計
              </span>
              <div className="flex items-baseline gap-1">
                <span className="text-lg font-black text-amber-700 tabular-nums">
                  {totalCarbsDisplay}
                </span>
                <span className="text-xs text-slate-400 font-medium">g</span>
              </div>
            </div>

            {/* 3. インスリン量 */}
            <div className="flex items-center justify-between px-3.5 py-2 rounded-xl border border-slate-200/90 bg-slate-50/60 group-hover:border-sky-300 transition-colors">
              <span className="flex items-center gap-1.5 text-xs sm:text-sm font-bold text-slate-600">
                <Syringe className="w-4 h-4 text-sky-500" />
                インスリン量
              </span>
              <div className="flex items-baseline gap-1">
                <span className="text-lg font-black text-sky-700 tabular-nums">
                  {daySummary.totalInsulin}
                </span>
                <span className="text-xs text-slate-400 font-medium">単位</span>
              </div>
            </div>

            {/* 4. 異常値回数 (▼低=青系, ▲高=赤系) */}
            <div className="flex items-center justify-between px-3.5 py-2 rounded-xl border border-slate-200/90 bg-slate-50/60 group-hover:border-slate-300 transition-colors">
              <span className="flex items-center gap-1.5 text-xs sm:text-sm font-bold text-slate-600">
                <AlertTriangle className="w-4 h-4 text-slate-400" />
                異常値回数
              </span>
              <div className="flex items-center gap-2.5 tabular-nums">
                <span className="inline-flex items-baseline gap-0.5 text-blue-600 font-extrabold text-sm">
                  <span className="text-xs">▼低</span>
                  <span className="text-lg font-black">{daySummary.hypoCount}</span>
                </span>
                <span className="text-slate-300">/</span>
                <span className="inline-flex items-baseline gap-0.5 text-rose-600 font-extrabold text-sm">
                  <span className="text-xs">▲高</span>
                  <span className="text-lg font-black">{daySummary.hyperCount}</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
