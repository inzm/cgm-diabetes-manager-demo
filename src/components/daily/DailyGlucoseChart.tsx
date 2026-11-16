import React, { useMemo } from 'react';
import { ReactECharts } from '@/lib/echartsCore';
import { LibreReading, HealthEvent } from '@/types/database';
import { usePatient } from '@/contexts/PatientContext';
import { escapeHtml } from '@/lib/utils';
import { isDemoCsvImportDisabled } from '@/lib/realGlucoseLoader';


interface DailyGlucoseChartProps {
  targetDate: string; // YYYY-MM-DD
  readings: LibreReading[];
  events: HealthEvent[];
  height?: number | string;
}

/**
 * 時刻文字列 "HH:mm" を 0〜24 (時間単位の小数) に変換する
 */
function parseTimeToHours(isoOrTime: string): number {
  const timePart = isoOrTime.includes('T') ? isoOrTime.slice(11, 16) : isoOrTime.slice(0, 5);
  const [hStr, mStr] = timePart.split(':');
  const h = parseInt(hStr, 10) || 0;
  const m = parseInt(mStr, 10) || 0;
  return h + m / 60;
}

function formatHoursToHHMM(hoursVal: number): string {
  const totalMin = Math.round(hoursVal * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 凡例・プロット双方で確実に下向き三角形 (▼) / 上向き三角形 (▲) として描画されるSVGパス
const DOWN_TRIANGLE_SYMBOL = 'path://M 0 0 L 10 0 L 5 9 Z';
const UP_TRIANGLE_SYMBOL = 'path://M 5 0 L 10 9 L 0 9 Z';

export const DailyGlucoseChart: React.FC<DailyGlucoseChartProps> = ({
  targetDate,
  readings,
  events,
  height = 280,
}) => {
  const { hypoThreshold, hyperThreshold } = usePatient();

  const dayRecords = useMemo(() => {
    return readings
      .filter((r) => r.timestamp.startsWith(targetDate))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }, [readings, targetDate]);

  const dayEvents = useMemo(() => {
    return events
      .filter((e) => !e.is_deleted && e.event_datetime.startsWith(targetDate))
      .sort((a, b) => a.event_datetime.localeCompare(b.event_datetime));
  }, [events, targetDate]);

  const option = useMemo(() => {
    const glucoseSeriesData = dayRecords.map((r) => {
      const xHour = parseTimeToHours(r.timestamp);
      const timeLabel = r.timestamp.slice(11, 16);
      return [xHour, r.glucose_value, timeLabel];
    });

    const mealEvents = dayEvents.filter((e) => e.event_type === '食事');
    const hyperEvents = dayEvents.filter((e) => e.event_type === '高血糖');
    const hypoEvents = dayEvents.filter((e) => e.event_type === '低血糖');
    const activityEvents = dayEvents.filter(
      (e) =>
        e.event_type === '活動' &&
        ((e.duration_minutes !== undefined && e.duration_minutes > 0) ||
          e.timing_category !== 'インスリン')
    );

    const baselineY = 45;
    const dropTopY = 300;

    const verticalDropLines: any[] = [];
    const activityMarkAreas: any[] = [];

    // 1. 食事イベント (橙色の垂直破線 + 底辺丸マーカー)
    const mealScatterData = mealEvents.map((m) => {
      const xHour = parseTimeToHours(m.event_datetime);
      const timeLabel = m.event_datetime.slice(11, 16);
      verticalDropLines.push([
        {
          coord: [xHour, baselineY],
          lineStyle: { color: '#ea580c', type: 'dashed', width: 1.4 },
          symbol: 'none',
        },
        {
          coord: [xHour, dropTopY],
          symbol: 'line',
          symbolSize: 6,
          label: { show: false },
        },
      ]);
      return {
        value: [xHour, baselineY],
        timeLabel,
        category: m.timing_category || '食事',
        carbs: m.total_carbs || 0,
        insulin: m.insulin_units || 0,
        memo: m.memo || '',
      };
    });

    // 2. 活動イベント (エメラルド緑の垂直破線 + 実施時間の縦帯ハイライト + 底辺継続バー + 上端「XX分」ラベル + ◆マーカー)
    const activityScatterData = activityEvents.map((ev) => {
      const xStart = parseTimeToHours(ev.event_datetime);
      const durationMin = ev.duration_minutes || 0;
      const xEnd = durationMin > 0 ? Math.min(24, xStart + durationMin / 60) : xStart;
      const startTimeLabel = ev.event_datetime.slice(11, 16);
      const endTimeLabel =
        durationMin > 0 ? formatHoursToHHMM(xStart + durationMin / 60) : '';
      const timeRangeLabel = endTimeLabel
        ? `${startTimeLabel}〜${endTimeLabel}`
        : startTimeLabel;

      verticalDropLines.push([
        {
          coord: [xStart, baselineY],
          lineStyle: { color: '#059669', type: 'dashed', width: 1.5 },
          symbol: 'none',
        },
        {
          coord: [xStart, dropTopY],
          symbol: 'line',
          symbolSize: 6,
          label:
            durationMin > 0
              ? {
                  show: true,
                  position: 'end',
                  formatter: `${durationMin}分`,
                  fontSize: 9,
                  fontWeight: 700,
                  color: '#065f46',
                  backgroundColor: 'rgba(209, 250, 229, 0.95)',
                  borderColor: '#6ee7b7',
                  borderWidth: 1,
                  padding: [1, 4],
                  borderRadius: 3,
                }
              : { show: false },
        },
      ]);

      if (durationMin > 0 && xEnd > xStart) {
        activityMarkAreas.push([
          {
            xAxis: xStart,
            yAxis: baselineY,
            itemStyle: {
              color: 'rgba(5, 150, 105, 0.13)',
              borderColor: 'rgba(5, 150, 105, 0.35)',
              borderWidth: 1,
              borderType: 'dotted',
            },
          },
          {
            xAxis: xEnd,
            yAxis: dropTopY,
          },
        ]);

        verticalDropLines.push([
          {
            coord: [xStart, baselineY],
            lineStyle: { color: '#059669', type: 'solid', width: 4.5 },
            symbol: 'none',
          },
          {
            coord: [xEnd, baselineY],
            symbol: 'line',
            symbolSize: 7,
            label: { show: false },
          },
        ]);
      }

      return {
        value: [xStart, baselineY],
        timeLabel: startTimeLabel,
        timeRangeLabel,
        category: ev.timing_category || '活動',
        duration: durationMin,
        memo: ev.memo || '',
      };
    });

    // 3. 高血糖イベント (赤色の垂直破線 + 底辺▲マーカー)
    const hyperScatterData = hyperEvents.map((ev) => {
      const xHour = parseTimeToHours(ev.event_datetime);
      const timeLabel = ev.event_datetime.slice(11, 16);
      verticalDropLines.push([
        {
          coord: [xHour, baselineY],
          lineStyle: { color: '#e11d48', type: 'dashed', width: 1.5 },
          symbol: 'none',
        },
        {
          coord: [xHour, dropTopY],
          symbol: 'line',
          symbolSize: 6,
          label: { show: false },
        },
      ]);
      return {
        value: [xHour, baselineY],
        timeLabel,
        memo: ev.memo || `高血糖アラート (>${hyperThreshold} mg/dL)`,
      };
    });

    // 4. 低血糖イベント (青色の垂直破線 + 底辺▼マーカー)
    const hypoScatterData = hypoEvents.map((ev) => {
      const xHour = parseTimeToHours(ev.event_datetime);
      const timeLabel = ev.event_datetime.slice(11, 16);
      verticalDropLines.push([
        {
          coord: [xHour, baselineY],
          lineStyle: { color: '#2563eb', type: 'dashed', width: 1.5 },
          symbol: 'none',
        },
        {
          coord: [xHour, dropTopY],
          symbol: 'line',
          symbolSize: 6,
          label: { show: false },
        },
      ]);
      return {
        value: [xHour, baselineY],
        timeLabel,
        memo: ev.memo || `低血糖アラート (<${hypoThreshold} mg/dL)`,
      };
    });

    return {
      animation: false,
      legend: {
        top: 4,
        left: 'center',
        itemWidth: 11,
        itemHeight: 10,
        itemGap: 10,
        textStyle: {
          fontSize: 11,
          color: '#334155',
          fontWeight: 600,
        },
        data: ['血糖値', '食事', '活動', '高血糖', '低血糖'],
      },
      grid: {
        top: 36,
        right: 20,
        bottom: 28,
        left: 38,
      },
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(15, 23, 42, 0.94)',
        borderColor: '#334155',
        textStyle: {
          color: '#f8fafc',
          fontSize: 12,
        },
        formatter: (param: any) => {
          if (param.seriesName === '食事') {
            const d = param.data;
            return `
              <div style="font-weight:700; color:#fb923c; margin-bottom:2px;">🍽️ ${escapeHtml(d.category)} (${escapeHtml(d.timeLabel)})</div>
              <div style="font-size:12px;">糖質: <b>${escapeHtml(d.carbs)}g</b> / インスリン: <b>${escapeHtml(d.insulin)}単位</b></div>
              ${d.memo ? `<div style="font-size:11px; color:#cbd5e1; margin-top:2px;">${escapeHtml(d.memo)}</div>` : ''}
            `;
          }
          if (param.seriesName === '活動') {
            const d = param.data;
            return `
              <div style="font-weight:700; color:#34d399; margin-bottom:2px;">🏃 ${escapeHtml(d.category)} (${escapeHtml(d.timeRangeLabel)})</div>
              ${d.duration > 0 ? `<div style="font-size:12px;">実施時間: <b>${escapeHtml(d.duration)}分間</b></div>` : ''}
              ${d.memo ? `<div style="font-size:11px; color:#cbd5e1; margin-top:2px;">${escapeHtml(d.memo)}</div>` : ''}
            `;
          }
          if (param.seriesName === '高血糖') {
            const d = param.data;
            return `
              <div style="font-weight:700; color:#fb7185; margin-bottom:2px;">▲ 高血糖 (${escapeHtml(d.timeLabel)})</div>
              <div style="font-size:12px;">${escapeHtml(d.memo)}</div>
            `;
          }
          if (param.seriesName === '低血糖') {
            const d = param.data;
            return `
              <div style="font-weight:700; color:#60a5fa; margin-bottom:2px;">▼ 低血糖 (${escapeHtml(d.timeLabel)})</div>
              <div style="font-size:12px;">${escapeHtml(d.memo)}</div>
            `;
          }
          const val = param.value[1];
          const timeLabel = param.value[2] || formatHoursToHHMM(param.value[0]);
          const color = val < hypoThreshold ? '#60a5fa' : val > hyperThreshold ? '#fb7185' : '#34d399';
          return `
            <div style="font-weight:600; margin-bottom:2px;">⏰ ${escapeHtml(timeLabel)}</div>
            <div><span style="font-size:15px; font-weight:800; color:${color};">${escapeHtml(val)}</span> <span style="font-size:11px; color:#94a3b8;">mg/dL</span></div>
          `;
        },
      },
      xAxis: {
        type: 'value',
        min: 0,
        max: 24,
        interval: 6,
        axisLine: { lineStyle: { color: '#94a3b8' } },
        axisTick: { show: true, length: 4 },
        minorTick: {
          show: true,
          splitNumber: 2,
          length: 2.5,
          lineStyle: { color: '#cbd5e1' },
        },
        splitLine: {
          show: true,
          lineStyle: { color: '#f1f5f9', type: 'dashed' },
        },
        axisLabel: {
          color: '#475569',
          fontSize: 10,
          fontWeight: 600,
          formatter: (val: number) => `${String(val).padStart(2, '0')}:00`,
        },
      },
      yAxis: {
        type: 'value',
        min: 30,
        max: 330,
        interval: 50,
        splitLine: {
          lineStyle: {
            color: '#e2e8f0',
            type: 'solid',
          },
        },
        axisLabel: {
          color: '#475569',
          fontSize: 10,
        },
      },
      series: [
        {
          name: '血糖値',
          type: 'line',
          smooth: 0.25,
          symbol: 'circle',
          symbolSize: 4,
          showSymbol: false,
          data: glucoseSeriesData,
          lineStyle: {
            color: '#0284c7',
            width: 2.4,
          },
          itemStyle: {
            color: '#0284c7',
          },
          markArea: {
            silent: true,
            data: [
              // ユーザー設定に連動する目標範囲帯 (hypoThreshold 〜 hyperThreshold mg/dL)
              [
                {
                  yAxis: hypoThreshold,
                  itemStyle: { color: 'rgba(16, 185, 129, 0.07)' },
                },
                {
                  yAxis: hyperThreshold,
                },
              ],
              ...activityMarkAreas,
            ],
          },
          markLine: {
            silent: true,
            animation: false,
            symbol: ['none', 'none'],
            data: [
              {
                yAxis: baselineY,
                lineStyle: { color: '#94a3b8', type: 'solid', width: 1 },
                label: { show: false },
              },
              ...verticalDropLines,
            ],
          },
        },
        {
          name: '食事',
          type: 'scatter',
          symbol: 'circle',
          symbolSize: 9,
          z: 10,
          itemStyle: {
            color: '#ea580c',
            borderColor: '#ffffff',
            borderWidth: 1,
          },
          data: mealScatterData,
        },
        {
          name: '活動',
          type: 'scatter',
          symbol: 'diamond',
          symbolSize: 10,
          z: 10,
          itemStyle: {
            color: '#059669',
            borderColor: '#ffffff',
            borderWidth: 1,
          },
          data: activityScatterData,
        },
        {
          name: '高血糖',
          type: 'scatter',
          symbol: UP_TRIANGLE_SYMBOL,
          symbolSize: 11,
          z: 11,
          itemStyle: {
            color: '#e11d48',
          },
          data: hyperScatterData,
        },
        {
          name: '低血糖',
          type: 'scatter',
          symbol: DOWN_TRIANGLE_SYMBOL,
          symbolSize: 11,
          z: 11,
          itemStyle: {
            color: '#2563eb',
          },
          data: hypoScatterData,
        },
      ],
    };
  }, [dayRecords, dayEvents, hypoThreshold, hyperThreshold]);

  if (dayRecords.length === 0) {
    return (
      <div
        style={{ height }}
        className="flex flex-col items-center justify-center bg-slate-50 rounded-xl border border-dashed border-slate-200 text-slate-400 text-xs gap-1"
      >
        <span>この日の血糖測定データはありません</span>
        <span className="text-[11px]">
          {isDemoCsvImportDisabled()
            ? '記録のある日付（2026年8月以前）を選択すると24時間推移が表示されます'
            : 'CSV取込を行うと24時間推移が表示されます'}
        </span>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200/90 p-2 sm:p-3 shadow-2xs">
      <ReactECharts
        option={option}
        style={{ height, width: '100%' }}
        opts={{ renderer: 'svg' }}
        notMerge={true}
      />
    </div>
  );
};
