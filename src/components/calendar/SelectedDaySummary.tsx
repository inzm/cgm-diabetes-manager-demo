import React, { useState, useEffect, useRef } from 'react';
import { usePatient } from '@/contexts/PatientContext';
import { SelectedDaySummaryData, MonthlyOverallKpi } from '@/lib/aggregates';
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

  const dateObj = new Date(`${selectedDate}T00:00:00`);
  const dayOfWeek = !isNaN(dateObj.getTime()) ? dateObj.getDay() : -1;
  const weekdayNames = ['日', '月', '火', '水', '木', '金', '土'];

  const weekdayLabel = !isNaN(dateObj.getTime()) ? `(${weekdayNames[dayOfWeek]})` : '';

  const formattedDate = !isNaN(dateObj.getTime())
    ? `${dateObj.getMonth() + 1}月${dateObj.getDate()}日 ${weekdayLabel}`
    : selectedDate;

  const compactMobileDate = !isNaN(dateObj.getTime())
    ? `${dateObj.getMonth() + 1}/${dateObj.getDate()}`
    : selectedDate;

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
      <div className="max-w-7xl mx-auto px-2.5 sm:px-6 lg:px-8 py-1.5 sm:py-2 relative">
        {/* モバイル用: 省スペース1行スリム表示 (M/D (曜) バッジ・アイコン+数値・凡例アイコンボタン) */}
        <div className="sm:hidden flex items-center justify-between gap-1.5 py-0.5">
          <div
            onClick={onOpenDetails}
            role="button"
            tabIndex={0}
            className="flex-1 flex items-center justify-between gap-1.5 min-w-0 cursor-pointer active:opacity-75"
          >
            <span
              className={cn(
                'inline-flex items-baseline gap-1 px-2.5 py-0.5 rounded-lg border shadow-2xs whitespace-nowrap shrink-0',
                dateBadgeStyle
              )}
            >
              <span className="text-sm font-black tracking-tight tabular-nums">
                {compactMobileDate}
              </span>{' '}
              {weekdayLabel && (
                <span className="text-xs font-extrabold">{weekdayLabel}</span>
              )}
            </span>

            <div className="flex items-center gap-1.5 text-xs overflow-x-auto no-scrollbar">
              {/* 平均血糖 (テキスト廃止・アイコンのみ) */}
              <span className="inline-flex items-baseline gap-0.5 whitespace-nowrap">
                <span className="text-[10px]">🩸</span>
                <span className={cn('font-black tabular-nums', glucoseColor)}>
                  {avg !== null ? avg : '--'}
                </span>
                <span className="text-[8.5px] text-slate-400">mg/dL</span>
              </span>

              <span className="text-slate-200">|</span>

              {/* 糖質 (テキスト廃止・アイコンのみ) */}
              <span className="inline-flex items-baseline gap-0.5 whitespace-nowrap">
                <span className="text-[10px]">🍚</span>
                <span className="font-bold text-amber-700 tabular-nums">{totalCarbsDisplay}</span>
                <span className="text-[9px] text-slate-400">g</span>
              </span>

              <span className="text-slate-200">|</span>

              {/* インスリン */}
              <span className="inline-flex items-baseline gap-0.5 whitespace-nowrap">
                <span className="text-[10px]">💉</span>
                <span className="font-bold text-sky-700 tabular-nums">
                  {daySummary.totalInsulin}
                </span>
                <span className="text-[9px] text-slate-400">U</span>
              </span>

              <span className="text-slate-200">|</span>

              {/* 異常値回数 (▼=青系, ▲=赤系) */}
              <span className="inline-flex items-center gap-1 whitespace-nowrap font-bold tabular-nums">
                <span className="text-blue-600 text-[11px]">▼{daySummary.hypoCount}</span>
                <span className="text-rose-600 text-[11px]">▲{daySummary.hyperCount}</span>
              </span>
            </div>
          </div>

          {/* 右端: スマホ用 凡例ポップオーバートグルボタン (「！」アイコン) */}
          <div ref={popoverRef} className="relative shrink-0">
            <button
              type="button"
              aria-label="凡例を表示"
              onClick={(e) => {
                e.stopPropagation();
                setIsLegendOpen((prev) => !prev);
              }}
              className={cn(
                'w-6 h-6 rounded-full flex items-center justify-center border transition-all cursor-pointer active:scale-95',
                isLegendOpen
                  ? 'bg-sky-600 text-white border-sky-600 shadow-xs'
                  : 'bg-slate-100 text-slate-500 border-slate-200/90 hover:bg-slate-200'
              )}
              title="カレンダー記号の凡例"
            >
              <AlertCircle className="w-3.5 h-3.5" />
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

        {/* デスクトップ用: コンパクト横並びバー */}
        <div
          onClick={onOpenDetails}
          role="button"
          tabIndex={0}
          className="hidden sm:flex items-center justify-between gap-4 cursor-pointer group"
        >
          {/* 左側: 選択日付（曜日別カラー強調バッジ） */}
          <div className="flex items-center gap-2 shrink-0 min-w-[140px]">
            <span
              className={cn(
                'inline-flex items-center px-3.5 py-1.5 rounded-xl border text-base font-black tracking-tight tabular-nums shadow-2xs',
                dateBadgeStyle
              )}
            >
              {formattedDate}
            </span>
          </div>

          {/* 右側: 4大指標コンパクトグリッド */}
          <div className="flex-1 grid grid-cols-4 gap-2.5">
            {/* 1. 平均血糖値 */}
            <div className="flex items-center justify-between px-3.5 py-1.5 rounded-xl border border-slate-200/90 bg-slate-50/60 group-hover:border-rose-300 transition-colors">
              <span className="flex items-center gap-1.5 text-xs font-bold text-slate-600">
                <Droplets className="w-3.5 h-3.5 text-rose-500" />
                平均血糖値
              </span>
              <div className="flex items-baseline gap-1">
                <span className={cn('text-base font-black tabular-nums', glucoseColor)}>
                  {avg !== null ? avg : '--'}
                </span>
                <span className="text-[11px] text-slate-400 font-medium">mg/dL</span>
              </div>
            </div>

            {/* 2. 糖質量合計 */}
            <div className="flex items-center justify-between px-3.5 py-1.5 rounded-xl border border-slate-200/90 bg-slate-50/60 group-hover:border-amber-300 transition-colors">
              <span className="flex items-center gap-1.5 text-xs font-bold text-slate-600">
                <Utensils className="w-3.5 h-3.5 text-amber-500" />
                糖質量合計
              </span>
              <div className="flex items-baseline gap-1">
                <span className="text-base font-black text-amber-700 tabular-nums">
                  {totalCarbsDisplay}
                </span>
                <span className="text-[11px] text-slate-400 font-medium">g</span>
              </div>
            </div>

            {/* 3. インスリン量 */}
            <div className="flex items-center justify-between px-3.5 py-1.5 rounded-xl border border-slate-200/90 bg-slate-50/60 group-hover:border-sky-300 transition-colors">
              <span className="flex items-center gap-1.5 text-xs font-bold text-slate-600">
                <Syringe className="w-3.5 h-3.5 text-sky-500" />
                インスリン量
              </span>
              <div className="flex items-baseline gap-1">
                <span className="text-base font-black text-sky-700 tabular-nums">
                  {daySummary.totalInsulin}
                </span>
                <span className="text-[11px] text-slate-400 font-medium">単位</span>
              </div>
            </div>

            {/* 4. 異常値回数 (▼低=青系, ▲高=赤系) */}
            <div className="flex items-center justify-between px-3.5 py-1.5 rounded-xl border border-slate-200/90 bg-slate-50/60 group-hover:border-slate-300 transition-colors">
              <span className="flex items-center gap-1.5 text-xs font-bold text-slate-600">
                <AlertTriangle className="w-3.5 h-3.5 text-slate-400" />
                異常値回数
              </span>
              <div className="flex items-center gap-2.5 tabular-nums">
                <span className="inline-flex items-baseline gap-0.5 text-blue-600 font-extrabold text-sm">
                  <span className="text-xs">▼低</span>
                  <span className="text-base font-black">{daySummary.hypoCount}</span>
                </span>
                <span className="text-slate-300">/</span>
                <span className="inline-flex items-baseline gap-0.5 text-rose-600 font-extrabold text-sm">
                  <span className="text-xs">▲高</span>
                  <span className="text-base font-black">{daySummary.hyperCount}</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
