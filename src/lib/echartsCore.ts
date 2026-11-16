import React from 'react';
import * as echarts from 'echarts/core';
import { LineChart, BarChart, ScatterChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  MarkAreaComponent,
} from 'echarts/components';
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import type { EChartsReactProps } from 'echarts-for-react/lib/types';

// ECharts Tree-shaking: 本システムで使用するチャート・コンポーネント・レンダラーのみを登録
echarts.use([
  LineChart,
  BarChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  MarkAreaComponent,
  CanvasRenderer,
  SVGRenderer,
]);

export type OptimizedEChartsProps = Omit<EChartsReactProps, 'echarts'>;

export const ReactECharts: React.FC<OptimizedEChartsProps> = (props) => {
  return React.createElement(ReactEChartsCore, {
    ...props,
    echarts,
  });
};

export { echarts, ReactEChartsCore };
export default ReactECharts;

