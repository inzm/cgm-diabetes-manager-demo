import React, { useMemo } from 'react';
import { ReactECharts } from '@/lib/echartsCore';
import { HealthEvent, LibreReading } from '@/types/database';
import { escapeHtml } from '@/lib/utils';
import {
  calculateWeekdayTrends,
  WeekdayTrendItem,
} from '@/lib/analysisCalculators';
import {
  CalendarDays,
  Flame,
  Activity,
  AlertTriangle,
} from 'lucide-react';

interface WeekdayTrendsTabProps {
  events: HealthEvent[];
  readings: LibreReading[];
  startDate: string;
  endDate: string;
  precomputedData?: WeekdayTrendItem[];
}

export const WeekdayTrendsTab: React.FC<WeekdayTrendsTabProps> = ({
  events,
  readings,
  startDate,
  endDate,
  precomputedData,
}) => {
  const weekdayData: WeekdayTrendItem[] = useMemo(() => {
    if (precomputedData) return precomputedData;
    return calculateWeekdayTrends(events, readings, startDate, endDate);
  }, [precomputedData, events, readings, startDate, endDate]);

  // 平日（月〜金: index 1〜5）と休日（日:0, 土:6）の比較
  const comparison = useMemo(() => {
    const weekdays = weekdayData.filter((w) => w.dayOfWeek >= 1 && w.dayOfWeek <= 5);
    const weekends = weekdayData.filter((w) => w.dayOfWeek === 0 || w.dayOfWeek === 6);

    const avgWeekdayCarbs =
      weekdays.reduce((a, b) => a + b.avgCarbs, 0) / (weekdays.length || 1);
    const avgWeekendCarbs =
      weekends.reduce((a, b) => a + b.avgCarbs, 0) / (weekends.length || 1);

    const validWeekdayGlucose = weekdays
      .map((w) => w.avgGlucose)
      .filter((g): g is number => g !== null);
    const avgWeekdayGlucose =
      validWeekdayGlucose.length > 0
        ? validWeekdayGlucose.reduce((a, b) => a + b, 0) / validWeekdayGlucose.length
        : null;

    const validWeekendGlucose = weekends
      .map((w) => w.avgGlucose)
      .filter((g): g is number => g !== null);
    const avgWeekendGlucose =
      validWeekendGlucose.length > 0
        ? validWeekendGlucose.reduce((a, b) => a + b, 0) / validWeekendGlucose.length
        : null;

    return {
      avgWeekdayCarbs: Math.round(avgWeekdayCarbs * 10) / 10,
      avgWeekendCarbs: Math.round(avgWeekendCarbs * 10) / 10,
      avgWeekdayGlucose: avgWeekdayGlucose ? Math.round(avgWeekdayGlucose) : null,
      avgWeekendGlucose: avgWeekendGlucose ? Math.round(avgWeekendGlucose) : null,
    };
  }, [weekdayData]);

  // ECharts 複合チャート (平均糖質 [棒: Amber] × 平均血糖 [折れ線: Indigo])
  const chartOption = useMemo(() => {
    const days = weekdayData.map((w) => `${w.dayName}曜`);
    const carbs = weekdayData.map((w) => w.avgCarbs);
    const glucoses = weekdayData.map((w) => w.avgGlucose);

    return {
      animation: false,
      tooltip: {
        trigger: 'axis',
        axisPointer: {
          type: 'shadow',
        },
        backgroundColor: 'rgba(15, 23, 42, 0.92)',
        borderColor: '#334155',
        textStyle: {
          color: '#f8fafc',
          fontSize: 12,
        },
        formatter: (params: any[]) => {
          if (!params || params.length === 0) return '';
          const idx = params[0].dataIndex;
          const w = weekdayData[idx];
          if (!w) return '';
          return `<div class="font-bold text-xs mb-1.5">${escapeHtml(w.dayName)}曜日（期間内 ${escapeHtml(w.dateCount)}日）</div>
            <div class="space-y-1 text-xs">
              <div class="flex items-center justify-between space-x-3 text-amber-400">
                <span>🍽️ 1日平均糖質:</span>
                <span class="font-bold font-mono">${escapeHtml(w.avgCarbs.toFixed(1))} g</span>
              </div>
              <div class="flex items-center justify-between space-x-3 text-indigo-300">
                <span>🩸 平均血糖値:</span>
                <span class="font-bold font-mono">${w.avgGlucose != null ? `${escapeHtml(w.avgGlucose)} mg/dL` : '-'}</span>
              </div>
              <div class="flex items-center justify-between space-x-3 text-rose-400">
                <span>⚠️ 異常値発生:</span>
                <span class="font-bold font-mono">${escapeHtml(w.anomalyCount)} 件</span>
              </div>
            </div>`;
        },
      },
      legend: {
        data: ['1日平均糖質 (g)', '平均血糖値 (mg/dL)'],
        top: 4,
        itemGap: 20,
        textStyle: {
          fontSize: 12,
          color: '#475569',
          fontWeight: 600,
        },
      },
      grid: {
        top: 44,
        left: '3%',
        right: '3%',
        bottom: '6%',
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        data: days,
        axisLine: {
          lineStyle: { color: '#cbd5e1' },
        },
        axisLabel: {
          color: '#64748b',
          fontSize: 12,
          fontWeight: 600,
        },
      },
      yAxis: [
        {
          type: 'value',
          min: 0,
          splitLine: {
            lineStyle: { color: '#e2e8f0' },
          },
          axisLabel: {
            color: '#64748b',
            fontSize: 11,
            formatter: '{value}g',
          },
        },
        {
          type: 'value',
          min: 60,
          max: 220,
          splitLine: { show: false },
          axisLabel: {
            color: '#6366f1',
            fontSize: 11,
            formatter: '{value}',
          },
        },
      ],
      series: [
        {
          name: '1日平均糖質 (g)',
          type: 'bar',
          yAxisIndex: 0,
          data: carbs,
          barMaxWidth: 28,
          itemStyle: {
            color: '#f59e0b',
            borderRadius: [6, 6, 0, 0],
          },
        },
        {
          name: '平均血糖値 (mg/dL)',
          type: 'line',
          yAxisIndex: 1,
          data: glucoses,
          smooth: true,
          symbol: 'circle',
          symbolSize: 8,
          itemStyle: {
            color: '#6366f1',
          },
          lineStyle: {
            width: 3,
          },
        },
      ],
    };
  }, [weekdayData]);

  return (
    <div className="flex flex-col flex-1 h-full space-y-3">
      {/* 1. 平日 vs 休日 比較カード（第2層：淡いスレートグレー bg-slate-50/80） */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 shrink-0">
        <div className="bg-slate-50/80 p-3 rounded-2xl border border-slate-200/80">
          <div className="flex items-center justify-between text-slate-600 mb-1">
            <span className="text-xs font-bold">平日 (月〜金) リズム</span>
            <span className="text-[11px] px-2 py-0.5 rounded-md bg-white text-slate-600 font-semibold border border-slate-200/80">
              仕事・生活習慣
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 pt-1 border-t border-slate-200/70">
            <div>
              <div className="text-[11px] text-slate-500">平均糖質 / 日</div>
              <div className="text-base sm:text-lg font-extrabold text-amber-600">
                {comparison.avgWeekdayCarbs} <span className="text-xs font-semibold">g</span>
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-500">平均血糖値</div>
              <div className="text-base sm:text-lg font-extrabold text-indigo-600">
                {comparison.avgWeekdayGlucose ?? '-'}{' '}
                <span className="text-xs font-semibold">mg/dL</span>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-slate-50/80 p-3 rounded-2xl border border-slate-200/80">
          <div className="flex items-center justify-between text-slate-600 mb-1">
            <span className="text-xs font-bold">休日 (土・日) リズム</span>
            <span className="text-[11px] px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 font-semibold border border-amber-200/80">
              外食・間食傾向
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 pt-1 border-t border-slate-200/70">
            <div>
              <div className="text-[11px] text-slate-500">平均糖質 / 日</div>
              <div className="text-base sm:text-lg font-extrabold text-amber-600">
                {comparison.avgWeekendCarbs} <span className="text-xs font-semibold">g</span>
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-500">平均血糖値</div>
              <div className="text-base sm:text-lg font-extrabold text-indigo-600">
                {comparison.avgWeekendGlucose ?? '-'}{' '}
                <span className="text-xs font-semibold">mg/dL</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 2. ECharts 複合チャート（第2層：淡いスレートグレー枠） */}
      <div className="bg-slate-50/60 p-3 sm:p-3.5 rounded-2xl border border-slate-200/80 shrink-0">
        <div className="flex items-center justify-between mb-1">
          <h4 className="text-xs font-bold text-slate-800 flex items-center space-x-1.5">
            <CalendarDays className="w-4 h-4 text-emerald-500" />
            <span>曜日別の1日平均糖質 ＆ 平均血糖値</span>
          </h4>
        </div>

        <div className="w-full h-44 sm:h-48">
          <ReactECharts
            option={chartOption}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'canvas' }}
          />
        </div>
      </div>

      {/* 3. 7曜日 集計内訳テーブル（常時表示・モバイルでも横スクロールゼロで全5列収容） */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-2xs overflow-hidden flex-1 flex flex-col">
        <div className="px-3 sm:px-4 py-2 bg-slate-50 border-b border-slate-200 shrink-0">
          <h4 className="text-xs font-bold text-slate-700">曜日別 集計内訳（日〜土）</h4>
        </div>

        <div className="overflow-x-auto flex-1">
          <table className="w-full text-left text-[11px] sm:text-xs text-slate-600 h-full">
            <thead className="bg-slate-100 text-slate-500 font-bold text-[10px] sm:text-[11px] border-b border-slate-200">
              <tr>
                <th className="py-1.5 pl-2.5 pr-1 sm:px-3 whitespace-nowrap">曜日</th>
                <th className="py-1.5 px-1 sm:px-3 text-center whitespace-nowrap">対象日数</th>
                <th className="py-1.5 px-1 sm:px-3 text-right whitespace-nowrap">
                  <span className="inline-flex items-center space-x-1">
                    <Flame className="hidden sm:inline w-3.5 h-3.5 text-amber-500" />
                    <span>1日平均糖質</span>
                  </span>
                </th>
                <th className="py-1.5 px-1 sm:px-3 text-right whitespace-nowrap">
                  <span className="inline-flex items-center space-x-1">
                    <Activity className="hidden sm:inline w-3.5 h-3.5 text-indigo-500" />
                    <span>平均血糖値</span>
                  </span>
                </th>
                <th className="py-1.5 pl-1 pr-2.5 sm:px-3 text-right whitespace-nowrap">
                  <span className="inline-flex items-center space-x-1">
                    <AlertTriangle className="hidden sm:inline w-3.5 h-3.5 text-rose-500" />
                    <span>異常値件数</span>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {weekdayData.map((w) => {
                const isWeekend = w.dayOfWeek === 0 || w.dayOfWeek === 6;
                return (
                  <tr
                    key={w.dayName}
                    className={`hover:bg-slate-50/80 transition-colors ${isWeekend ? 'bg-amber-50/20' : ''
                      }`}
                  >
                    <td className="py-1.5 pl-2.5 pr-1 sm:px-3 whitespace-nowrap">
                      <span
                        className={`font-bold ${w.dayOfWeek === 0
                          ? 'text-rose-600'
                          : w.dayOfWeek === 6
                            ? 'text-sky-600'
                            : 'text-slate-800'
                          }`}
                      >
                        {w.dayName}曜日
                      </span>
                    </td>
                    <td className="py-1.5 px-1 sm:px-3 text-center font-mono text-slate-500 whitespace-nowrap">
                      {w.dateCount} 日
                    </td>
                    <td className="py-1.5 px-1 sm:px-3 text-right font-mono font-bold text-amber-600 whitespace-nowrap">
                      {w.avgCarbs.toFixed(1)} g
                    </td>
                    <td className="py-1.5 px-1 sm:px-3 text-right font-mono font-bold text-indigo-700 whitespace-nowrap">
                      {w.avgGlucose ?? '-'} mg/dL
                    </td>
                    <td className="py-1.5 pl-1 pr-2.5 sm:px-3 text-right font-mono font-bold text-rose-600 whitespace-nowrap">
                      {w.anomalyCount} 件
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
