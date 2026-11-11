import React from 'react';
import { DailyAggregatedData } from '@/lib/aggregates';
import { Sparkline } from './Sparkline';
import { cn } from '@/lib/utils';

interface CalendarDayCellProps {
  data: DailyAggregatedData;
  isSelected: boolean;
  onSelect: (date: string) => void;
  onOpenDetails: (date: string) => void;
  index?: number;
  isLoading?: boolean;
  hypoThreshold?: number;
  hyperThreshold?: number;
}

export const CalendarDayCell: React.FC<CalendarDayCellProps> = ({
  data,
  isSelected,
  onSelect,
  onOpenDetails,
  index = 0,
  isLoading = false,
  hypoThreshold = 70,
  hyperThreshold = 180,
}) => {
  const {
    date,
    dayNumber,
    isCurrentMonth,
    isToday,
    avgGlucose,
    totalCarbs,
    totalInsulin,
    hypoCount,
    hyperCount,
    sparklineData,
  } = data;

  const handleClick = () => {
    if (isSelected) {
      onOpenDetails(date);
    } else {
      onSelect(date);
    }
  };

  // 曜日判定 (0: 日曜 = 赤系, 6: 土曜 = 青系)
  const dateObj = new Date(`${date}T00:00:00`);
  const dayOfWeek = !isNaN(dateObj.getTime()) ? dateObj.getDay() : -1;

  // 日付数字の色 (前月・翌月は淡いトーン、当月ははっきりした色)
  const dayNumberColor = isToday
    ? 'bg-sky-600 text-white font-black px-1 sm:px-1.5 py-0.5 rounded-full shadow-2xs'
    : !isCurrentMonth
    ? dayOfWeek === 0
      ? 'text-rose-300/80 font-medium'
      : dayOfWeek === 6
      ? 'text-blue-300/80 font-medium'
      : 'text-slate-300 font-medium'
    : dayOfWeek === 0
    ? 'text-rose-600 font-black'
    : dayOfWeek === 6
    ? 'text-blue-600 font-black'
    : 'text-slate-900 font-black';

  // 異常値記号 (▼: 低血糖 = 青系, ▲: 高血糖 = 赤系) 最大3個まで記号で並記
  const hypoTriangles = '▼'.repeat(Math.min(3, hypoCount));
  const hyperTriangles = '▲'.repeat(Math.min(3, hyperCount));

  const formattedCarbs =
    totalCarbs > 0
      ? Number.isInteger(totalCarbs)
        ? `${totalCarbs}g`
        : `${totalCarbs.toFixed(1)}g`
      : '';

  // 左上から右下へ段階的にフェードインさせる遅延設定 (最大250ms)
  const enterDelayMs = Math.min(index * 6, 250);

  // 当月セルは視認性を損なわないよう純白 (bg-white) に統一し、前月・翌月セルのみ淡いスレート背景とする
  const cellBgClass = !isCurrentMonth
    ? 'bg-slate-50/90'
    : isSelected
    ? 'bg-sky-50/45'
    : 'bg-white';

  const hasAnyData =
    avgGlucose !== null ||
    totalCarbs > 0 ||
    totalInsulin > 0 ||
    sparklineData.some((v) => v !== null);

  return (
    <div
      onClick={handleClick}
      role="button"
      tabIndex={0}
      style={{ animationDelay: `${enterDelayMs}ms` }}
      className={cn(
        'cgm-cell-enter group relative h-full min-h-0 sm:min-h-[88px] lg:min-h-[92px] p-0.5 sm:p-1.5 border border-slate-200/80 transition-all duration-200 select-none cursor-pointer flex flex-col justify-between overflow-hidden active:scale-[0.98]',
        cellBgClass,
        isSelected && 'ring-2 ring-sky-500 z-10 shadow-xs border-transparent',
        !isSelected && isCurrentMonth && 'hover:bg-slate-50/90 hover:border-slate-300'
      )}
    >
      {/* 1行目 (最優先): 日付番号 (大きく強調: 日曜=赤, 土曜=青) & 異常値ラベル (さらにコントラストを抑えた ▼青 / ▲赤) */}
      <div className="flex items-center justify-between gap-0.5 leading-none shrink-0">
        <span className={cn('text-[13px] sm:text-sm leading-none tabular-nums tracking-tight', dayNumberColor)}>
          {dayNumber}
        </span>

        {isCurrentMonth && !isLoading && (hypoCount > 0 || hyperCount > 0) && (
          <div className="flex items-center gap-0.5 text-[8px] sm:text-[9.5px] font-medium tracking-tighter leading-none shrink-0">
            {hypoCount > 0 && (
              <span className="text-blue-400/65" title={`低血糖 ${hypoCount}回`}>
                {hypoTriangles}
              </span>
            )}
            {hyperCount > 0 && (
              <span className="text-rose-400/65" title={`高血糖 ${hyperCount}回`}>
                {hyperTriangles}
              </span>
            )}
          </div>
        )}
      </div>

      {/* 前月・翌月セル (!isCurrentMonth) または記録未登録日 (!hasAnyData) は日付数字のみ表示し、不要な「--」記号を排除 */}
      {!isCurrentMonth || (!isLoading && !hasAnyData) ? (
        <div className="flex-1 min-h-0" />
      ) : isLoading ? (
        /* ローディング中: 4行分のスケルトンパルスアニメーション */
        <div className="flex-1 min-h-0 flex flex-col justify-between py-0.5 animate-pulse">
          <div className="h-1.5 w-4/5 bg-slate-200/80 rounded" />
          <div className="h-1.5 w-3/5 bg-slate-200/80 rounded" />
          <div className="h-2.5 w-3/4 bg-slate-200/80 rounded" />
          <div className="h-3 w-full bg-sky-100/70 rounded mt-0.5" />
        </div>
      ) : (
        <>
          {/* 2行目 (脇役): 糖質量合計 */}
          <div className="flex items-center leading-none shrink-0">
            {totalCarbs > 0 ? (
              <span
                className="inline-flex items-center gap-0.5 text-[8px] sm:text-[10px] font-medium text-slate-400 tabular-nums whitespace-nowrap leading-none"
                title={`糖質合計 ${formattedCarbs}`}
              >
                <span className="text-[7.5px] sm:text-[9px] leading-none opacity-55 grayscale-[50%]">
                  🍚
                </span>
                <span>{formattedCarbs}</span>
              </span>
            ) : (
              <span className="text-[7.5px] text-transparent select-none leading-none">-</span>
            )}
          </div>

          {/* 3行目 (脇役): インスリン量合計 */}
          <div className="flex items-center leading-none shrink-0">
            {totalInsulin > 0 ? (
              <span
                className="inline-flex items-center gap-0.5 text-[8px] sm:text-[10px] font-medium text-slate-400 tabular-nums whitespace-nowrap leading-none"
                title={`インスリン合計 ${totalInsulin}単位`}
              >
                <span className="text-[7.5px] sm:text-[9px] leading-none opacity-55 grayscale-[45%]">
                  💉
                </span>
                <span>{totalInsulin}</span>
              </span>
            ) : (
              <span className="text-[7.5px] text-transparent select-none leading-none">-</span>
            )}
          </div>

          {/* 4行目: 血糖値平均 (日付と競合しないよう正常時は落ち着いたスレート色、閾値超過時のみ青/赤) */}
          <div className="flex items-center leading-none shrink-0">
            {avgGlucose !== null ? (
              <span
                className={cn(
                  'inline-flex items-center gap-0.5 text-[9.5px] sm:text-xs font-bold tabular-nums leading-none whitespace-nowrap',
                  avgGlucose < hypoThreshold
                    ? 'text-blue-500/90'
                    : avgGlucose > hyperThreshold
                    ? 'text-rose-500/90'
                    : 'text-slate-600'
                )}
                title={`平均血糖値 ${avgGlucose} mg/dL`}
              >
                <span className="text-[8px] sm:text-[10px] leading-none opacity-65">🩸</span>
                <span>{avgGlucose}</span>
              </span>
            ) : (
              <span className="text-[8px] text-transparent select-none leading-none">-</span>
            )}
          </div>

          {/* 5行目: 24Hスパークライン (目標帯を設定閾値と連動、スマホの残りセル高さに柔軟フィット) */}
          <div className="w-full flex-1 min-h-[12px] max-h-[18px] sm:max-h-[20px] mt-auto flex items-end">
            <Sparkline
              data={sparklineData}
              height={16}
              targetMin={hypoThreshold}
              targetMax={hyperThreshold}
              className="h-full"
            />
          </div>
        </>
      )}
    </div>
  );
};
