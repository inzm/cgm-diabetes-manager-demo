import React, { useMemo } from 'react';
import { ReactECharts } from '@/lib/echartsCore';
import { HealthEvent, LibreReading } from '@/types/database';
import { escapeHtml } from '@/lib/utils';
import {
  calculateCarbInsulinTrend,
  DailyCarbInsulinTrendItem,
} from '@/lib/analysisCalculators';
import { Flame, Syringe, TrendingUp, Info } from 'lucide-react';

interface CarbInsulinTrendTabProps {
  events: HealthEvent[];
  readings: LibreReading[];
  startDate: string;
  endDate: string;
  precomputedData?: DailyCarbInsulinTrendItem[];
}

export const CarbInsulinTrendTab: React.FC<CarbInsulinTrendTabProps> = ({
  events,
  readings,
  startDate,
  endDate,
  precomputedData,
}) => {
  const trendData: DailyCarbInsulinTrendItem[] = useMemo(() => {
    if (precomputedData) return precomputedData;
    return calculateCarbInsulinTrend(events, readings, startDate, endDate);
  }, [precomputedData, events, readings, startDate, endDate]);

  // 期間合計 & 1日平均サマリー
  const summary = useMemo(() => {
    const totalCarbs = trendData.reduce((acc, d) => acc + d.totalCarbs, 0);
    const totalInsulin = trendData.reduce((acc, d) => acc + d.totalInsulin, 0);
    const days = trendData.length || 1;

    const validGlucose = trendData.map((d) => d.avgGlucose).filter((g): g is number => g !== null);
    const overallAvgGlucose =
      validGlucose.length > 0
        ? Math.round(validGlucose.reduce((a, b) => a + b, 0) / validGlucose.length)
        : null;

    return {
      totalCarbs: Math.round(totalCarbs * 10) / 10,
      avgDailyCarbs: Math.round((totalCarbs / days) * 10) / 10,
      totalInsulin: Math.round(totalInsulin * 10) / 10,
      avgDailyInsulin: Math.round((totalInsulin / days) * 10) / 10,
      overallAvgGlucose,
    };
  }, [trendData]);

  // ECharts 2軸 複合推移グラフ（凡例とY軸ラベルの重なりを防止）
  const chartOption = useMemo(() => {
    const dates = trendData.map((d) => {
      const parts = d.date.split('-');
      return `${parts[1]}/${parts[2]}`;
    });
    const carbs = trendData.map((d) => d.totalCarbs);
    const insulins = trendData.map((d) => d.totalInsulin);

    return {
      animation: false,
      tooltip: {
        trigger: 'axis',
        axisPointer: {
          type: 'cross',
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
          const item = trendData[idx];
          if (!item) return '';
          let res = `<div class="font-bold text-xs mb-1.5">${escapeHtml(item.date)}</div>`;
          res += `<div class="space-y-1 text-xs">
            <div class="flex items-center justify-between space-x-3 text-amber-400">
              <span>🍽️ 糖質摂取量:</span>
              <span class="font-bold font-mono">${escapeHtml(item.totalCarbs.toFixed(1))} g</span>
            </div>
            <div class="flex items-center justify-between space-x-3 text-sky-400">
              <span>💉 インスリン量:</span>
              <span class="font-bold font-mono">${escapeHtml(item.totalInsulin.toFixed(1))} U</span>
            </div>
            <div class="flex items-center justify-between space-x-3 text-slate-300">
              <span>🩸 平均血糖値:</span>
              <span class="font-bold font-mono">${item.avgGlucose != null ? `${escapeHtml(item.avgGlucose)} mg/dL` : '測定なし'}</span>
            </div>
            ${item.anomalyCount > 0
              ? `<div class="flex items-center justify-between space-x-3 text-rose-400">
                    <span>⚠️ 異常値発生:</span>
                    <span class="font-bold font-mono">${escapeHtml(item.anomalyCount)} 件</span>
                  </div>`
              : ''
            }
          </div>`;
          return res;
        },
      },
      legend: {
        data: ['日次 糖質摂取量 (g)', '日次 インスリン投与量 (U)'],
        top: 4,
        itemGap: 12,
        textStyle: {
          fontSize: 11,
          color: '#475569',
          fontWeight: 600,
        },
      },
      grid: {
        top: 44,
        left: '3%',
        right: '3%',
        bottom: '10%',
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        data: dates,
        axisLine: {
          lineStyle: { color: '#cbd5e1' },
        },
        axisLabel: {
          color: '#64748b',
          fontSize: 11,
          rotate: dates.length > 20 ? 45 : 0,
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
          min: 0,
          splitLine: { show: false },
          axisLabel: {
            color: '#0284c7',
            fontSize: 11,
            formatter: '{value}U',
          },
        },
      ],
      series: [
        {
          name: '日次 糖質摂取量 (g)',
          type: 'bar',
          yAxisIndex: 0,
          data: carbs,
          barMaxWidth: 20,
          itemStyle: {
            color: '#f59e0b',
            borderRadius: [4, 4, 0, 0],
          },
        },
        {
          name: '日次 インスリン投与量 (U)',
          type: 'line',
          yAxisIndex: 1,
          data: insulins,
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          itemStyle: {
            color: '#0ea5e9',
          },
          lineStyle: {
            width: 2.5,
          },
        },
      ],
    };
  }, [trendData]);

  return (
    <div className="space-y-4">
      {/* 1. 期間サマリーカード（第2層：淡いスレートグレー bg-slate-50/80） */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-2.5">
        <div className="bg-slate-50/80 p-3 rounded-2xl border border-slate-200/80">
          <div className="flex items-center justify-between text-slate-500 mb-1">
            <span className="text-[11px] font-bold whitespace-nowrap">1日平均糖質</span>
            <Flame className="w-3.5 h-3.5 text-amber-500 shrink-0" />
          </div>
          <div className="flex items-baseline space-x-1">
            <span className="text-xl font-extrabold text-amber-600 tracking-tight">
              {summary.avgDailyCarbs}
            </span>
            <span className="text-xs font-semibold text-slate-500">g/日</span>
          </div>
        </div>

        <div className="bg-slate-50/80 p-3 rounded-2xl border border-slate-200/80">
          <div className="flex items-center justify-between text-slate-500 mb-1">
            <span className="text-[11px] font-bold whitespace-nowrap">1日平均インスリン</span>
            <Syringe className="w-3.5 h-3.5 text-sky-500 shrink-0" />
          </div>
          <div className="flex items-baseline space-x-1">
            <span className="text-xl font-extrabold text-sky-600 tracking-tight">
              {summary.avgDailyInsulin}
            </span>
            <span className="text-xs font-semibold text-slate-500">U/日</span>
          </div>
        </div>

        <div className="bg-slate-50/80 p-3 rounded-2xl border border-slate-200/80">
          <div className="flex items-center justify-between text-slate-500 mb-1">
            <span className="text-[11px] font-bold whitespace-nowrap">期間平均血糖</span>
            <TrendingUp className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
          </div>
          <div className="flex items-baseline space-x-1">
            <span className="text-xl font-extrabold text-indigo-700 tracking-tight">
              {summary.overallAvgGlucose ?? '-'}
            </span>
            <span className="text-[11px] font-semibold text-slate-500">mg/dL</span>
          </div>
        </div>

        <div className="bg-slate-50/80 p-3 rounded-2xl border border-slate-200/80">
          <div className="flex items-center justify-between text-slate-500 mb-1">
            <span className="text-[11px] font-bold whitespace-nowrap">対象日数</span>
            <Info className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          </div>
          <div className="flex items-baseline space-x-1">
            <span className="text-xl font-extrabold text-slate-800 tracking-tight">
              {trendData.length}
            </span>
            <span className="text-xs font-semibold text-slate-500">日間</span>
          </div>
        </div>
      </div>

      {/* 2. ECharts 複合時系列グラフ */}
      <div className="bg-slate-50/60 p-3.5 sm:p-5 rounded-2xl border border-slate-200/80">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs sm:text-sm font-bold text-slate-800 flex items-center space-x-2">
            <Flame className="w-4 h-4 text-amber-500" />
            <span>日次 糖質摂取量 (棒グラフ) × インスリン投与量 (折れ線)</span>
          </h4>
        </div>

        <div className="w-full h-64">
          <ReactECharts
            option={chartOption}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'canvas' }}
          />
        </div>
      </div>
    </div>
  );
};
