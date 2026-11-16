import React, { useMemo } from 'react';
import { ReactECharts } from '@/lib/echartsCore';
import { HealthEvent, LibreReading } from '@/types/database';
import { usePatient } from '@/contexts/PatientContext';
import { escapeHtml } from '@/lib/utils';
import {
  calculateTimeAnomalyPatterns,
  TimePeriodAnomaly,
} from '@/lib/analysisCalculators';
import {
  Clock,
  AlertTriangle,
  ArrowDownCircle,
  ArrowUpCircle,
  Info,
} from 'lucide-react';

interface TimeAnomalyTabProps {
  events: HealthEvent[];
  readings: LibreReading[];
  precomputedData?: TimePeriodAnomaly[];
}

export const TimeAnomalyTab: React.FC<TimeAnomalyTabProps> = ({
  events,
  readings,
  precomputedData,
}) => {
  const { hypoThreshold, hyperThreshold } = usePatient();

  const periodData: TimePeriodAnomaly[] = useMemo(() => {
    if (precomputedData) return precomputedData;
    return calculateTimeAnomalyPatterns(events, readings, hypoThreshold, hyperThreshold);
  }, [precomputedData, events, readings, hypoThreshold, hyperThreshold]);

  const totalHypo = useMemo(() => periodData.reduce((acc, p) => acc + p.hypoCount, 0), [periodData]);
  const totalHyper = useMemo(() => periodData.reduce((acc, p) => acc + p.hyperCount, 0), [periodData]);
  const grandTotal = totalHypo + totalHyper;

  const peakPeriod = useMemo(() => {
    if (grandTotal === 0) return null;
    return [...periodData].sort((a, b) => b.totalCount - a.totalCount)[0];
  }, [periodData, grandTotal]);

  const hypoLabel = `低血糖 (<${hypoThreshold})`;
  const hyperLabel = `高血糖 (>${hyperThreshold})`;

  // 旧VBA準拠：横棒グラフ（Y軸＝朝・昼・夕夜・夜間［上から朝→夜間の順］、X軸＝発生件数）
  const chartOption = useMemo(() => {
    const reversed = [...periodData].reverse();
    const categories = reversed.map(
      (p) => `${p.periodName}\n(${p.timeRange.replace(' 〜 ', '-')})`
    );
    const hypoSeries = reversed.map((p) => p.hypoCount);
    const hyperSeries = reversed.map((p) => p.hyperCount);

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
          let res = `<div class="font-bold text-xs mb-1">${escapeHtml(String(params[0].axisValueLabel).replace('\n', ' '))}</div>`;
          params.forEach((item) => {
            res += `<div class="flex items-center justify-between text-xs space-x-3">
              <span>${item.marker} ${escapeHtml(item.seriesName)}</span>
              <span class="font-bold font-mono">${escapeHtml(item.value)} 件</span>
            </div>`;
          });
          return res;
        },
      },
      legend: {
        data: [hypoLabel, hyperLabel],
        top: 4,
        itemGap: 16,
        textStyle: {
          fontSize: 11,
          color: '#475569',
          fontWeight: 600,
        },
      },
      grid: {
        top: 38,
        left: '3%',
        right: '5%',
        bottom: '6%',
        containLabel: true,
      },
      xAxis: {
        type: 'value',
        minInterval: 1,
        splitLine: {
          lineStyle: {
            color: '#e2e8f0',
          },
        },
        axisLabel: {
          color: '#64748b',
          fontSize: 11,
          formatter: '{value}件',
        },
      },
      yAxis: {
        type: 'category',
        data: categories,
        axisLine: {
          lineStyle: { color: '#cbd5e1' },
        },
        axisLabel: {
          color: '#334155',
          fontSize: 10.5,
          lineHeight: 14,
          fontWeight: 600,
        },
      },
      series: [
        {
          name: hypoLabel,
          type: 'bar',
          data: hypoSeries,
          barMaxWidth: 18,
          itemStyle: {
            color: '#2563eb',
            borderRadius: [0, 4, 4, 0],
          },
        },
        {
          name: hyperLabel,
          type: 'bar',
          data: hyperSeries,
          barMaxWidth: 18,
          itemStyle: {
            color: '#e11d48',
            borderRadius: [0, 4, 4, 0],
          },
        },
      ],
    };
  }, [periodData, hypoLabel, hyperLabel]);

  return (
    <div className="space-y-4">
      {/* 1. 総合ステータスカード（第2層：淡いスレートグレー bg-slate-50/80） */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3">
        <div className="bg-slate-50/80 p-3.5 rounded-2xl border border-slate-200/80 flex items-center space-x-3">
          <div className="w-9 h-9 rounded-xl bg-blue-100/80 flex items-center justify-center text-blue-600 shrink-0">
            <ArrowDownCircle className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] font-bold text-slate-500 truncate">
              低血糖 (&lt;{hypoThreshold})
            </div>
            <div className="flex items-baseline space-x-1">
              <span className="text-xl font-extrabold text-blue-600 tracking-tight">
                {totalHypo}
              </span>
              <span className="text-xs text-slate-500 font-semibold">件</span>
            </div>
          </div>
        </div>

        <div className="bg-slate-50/80 p-3.5 rounded-2xl border border-slate-200/80 flex items-center space-x-3">
          <div className="w-9 h-9 rounded-xl bg-rose-100/80 flex items-center justify-center text-rose-500 shrink-0">
            <ArrowUpCircle className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] font-bold text-slate-500 truncate">
              高血糖 (&gt;{hyperThreshold})
            </div>
            <div className="flex items-baseline space-x-1">
              <span className="text-xl font-extrabold text-rose-600 tracking-tight">
                {totalHyper}
              </span>
              <span className="text-xs text-slate-500 font-semibold">件</span>
            </div>
          </div>
        </div>

        <div className="bg-slate-50/80 p-3.5 rounded-2xl border border-slate-200/80 flex items-center space-x-3">
          <div className="w-9 h-9 rounded-xl bg-indigo-100/80 flex items-center justify-center text-indigo-600 shrink-0">
            <AlertTriangle className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] font-bold text-slate-500 truncate">
              最多集中時間帯
            </div>
            <div className="text-sm font-extrabold text-slate-800 truncate">
              {peakPeriod ? `${peakPeriod.periodName} (${peakPeriod.percentage}%)` : '異常値なし'}
            </div>
          </div>
        </div>
      </div>

      {/* 2. 旧VBA準拠 左右2カラム配置（左：4時間帯 集計データ表 ／ 右：横棒グラフ） */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
        {/* 左側：4時間帯 集計データテーブル */}
        <div className="lg:col-span-5 bg-white rounded-2xl border border-slate-200 shadow-2xs overflow-hidden flex flex-col justify-between">
          <div>
            <div className="px-3 sm:px-4 py-2.5 border-b border-slate-200 bg-slate-50">
              <h4 className="text-xs font-bold text-slate-700">
                4時間帯 集計データ（朝・昼・夕夜・夜間）
              </h4>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px] sm:text-xs text-slate-600">
                <thead className="bg-slate-100 text-slate-500 font-bold text-[10px] sm:text-[11px] border-b border-slate-200">
                  <tr>
                    <th className="py-2 pl-2 sm:pl-3 pr-1 whitespace-nowrap">時間帯</th>
                    <th className="py-2 px-1 sm:px-2 whitespace-nowrap">時刻</th>
                    <th className="py-2 px-1 sm:px-2 text-right text-blue-600 whitespace-nowrap">
                      ▼低血糖
                    </th>
                    <th className="py-2 px-1 sm:px-2 text-right text-rose-600 whitespace-nowrap">
                      ▲高血糖
                    </th>
                    <th className="py-2 px-1 sm:px-2 text-right font-bold whitespace-nowrap">合計</th>
                    <th className="py-2 pl-1 pr-2 sm:pr-3 text-right whitespace-nowrap">割合</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {periodData.map((p) => (
                    <tr key={p.periodName} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-2 pl-2 sm:pl-3 pr-1 font-bold text-slate-800 whitespace-nowrap">
                        {p.periodName}
                      </td>
                      <td className="py-2 px-1 sm:px-2 text-slate-500 font-mono text-[10px] sm:text-[11px] whitespace-nowrap">
                        {p.timeRange.replace(' 〜 ', '-')}
                      </td>
                      <td className="py-2 px-1 sm:px-2 text-right font-mono font-bold text-blue-600 whitespace-nowrap">
                        {p.hypoCount}件
                      </td>
                      <td className="py-2 px-1 sm:px-2 text-right font-mono font-bold text-rose-600 whitespace-nowrap">
                        {p.hyperCount}件
                      </td>
                      <td className="py-2 px-1 sm:px-2 text-right font-mono font-extrabold text-slate-900 whitespace-nowrap">
                        {p.totalCount}件
                      </td>
                      <td className="py-2 pl-1 pr-2 sm:pr-3 text-right whitespace-nowrap">
                        <span className="inline-block px-1.5 sm:px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-mono font-bold text-[10px] sm:text-xs">
                          {p.percentage.toFixed(1)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-50 border-t border-slate-200 font-bold text-slate-800">
                  <tr>
                    <td colSpan={2} className="py-2 pl-2 sm:pl-3 pr-1">
                      全時間帯 合計
                    </td>
                    <td className="py-2 px-1 sm:px-2 text-right text-blue-600 font-mono">
                      {totalHypo}件
                    </td>
                    <td className="py-2 px-1 sm:px-2 text-right text-rose-600 font-mono">
                      {totalHyper}件
                    </td>
                    <td className="py-2 px-1 sm:px-2 text-right font-mono text-indigo-700">
                      {grandTotal}件
                    </td>
                    <td className="py-2 pl-1 pr-2 sm:pr-3 text-right font-mono text-[10px] sm:text-xs">
                      100.0%
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {peakPeriod && peakPeriod.totalCount > 0 && (
            <div className="m-3 p-2.5 bg-amber-50/70 border border-amber-200/80 rounded-xl flex items-start space-x-2 text-xs text-amber-900">
              <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div>
                異常値の約 <span className="font-bold">{peakPeriod.percentage}%</span> が「
                <span className="font-bold">{peakPeriod.periodName}（{peakPeriod.timeRange}）</span>
                」に集中しています。
              </div>
            </div>
          )}
        </div>

        {/* 右側：横棒グラフ */}
        <div className="lg:col-span-7 bg-slate-50/60 p-4 sm:p-5 rounded-2xl border border-slate-200/80 flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs sm:text-sm font-bold text-slate-800 flex items-center space-x-2">
              <Clock className="w-4 h-4 text-rose-500" />
              <span>時間帯別の異常値発生件数 ({hypoLabel} / {hyperLabel})</span>
            </h4>
          </div>

          <div className="w-full flex-1 min-h-[240px]">
            <ReactECharts
              option={chartOption}
              style={{ height: '100%', width: '100%', minHeight: '240px' }}
              opts={{ renderer: 'canvas' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
