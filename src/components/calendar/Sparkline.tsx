import React from 'react';

interface SparklineProps {
  /** 24時間データ (通常24〜96点、nullは欠損) */
  data: (number | null)[];
  width?: number;
  height?: number;
  targetMin?: number;
  targetMax?: number;
  className?: string;
}

/**
 * カレンダーセル内専用 超軽量インラインSVGスパークライン
 * セルの右半分（適切なアスペクト比）に配置し、血糖値の上下変動が明確に判読できるように描画する。
 */
export const Sparkline: React.FC<SparklineProps> = ({
  data,
  height = 24,
  targetMin = 70,
  targetMax = 180,
  className = '',
}) => {
  const validPoints = data.filter((v): v is number => v !== null && !isNaN(v));
  if (validPoints.length < 2) {
    return <div style={{ height }} className={`w-full ${className}`} />;
  }

  // Y軸スケールをデータの変動が強調されるよう最適化 (下限50〜上限220を基準に実測最小/最大へ追従)
  const actualMin = Math.min(...validPoints);
  const actualMax = Math.max(...validPoints);
  const minY = Math.min(55, actualMin - 8);
  const maxY = Math.max(210, actualMax + 8);
  const rangeY = Math.max(40, maxY - minY);

  // 横長になりすぎないよう仮想幅 64 : 高さ 24 (約 2.6 : 1) のアスペクト比で描画
  const svgWidth = 64;
  const svgHeight = height;

  const getY = (val: number) => {
    const clamped = Math.max(minY, Math.min(maxY, val));
    return svgHeight - ((clamped - minY) / rangeY) * (svgHeight - 3) - 1.5;
  };

  const getX = (index: number, total: number) => {
    return (index / Math.max(1, total - 1)) * svgWidth;
  };

  const targetTopY = getY(targetMax);
  const targetBottomY = getY(targetMin);
  const targetHeight = Math.max(1, targetBottomY - targetTopY);

  let pathD = '';
  let isDrawing = false;
  const total = data.length;

  data.forEach((val, idx) => {
    if (val === null || isNaN(val)) {
      isDrawing = false;
      return;
    }
    const x = getX(idx, total);
    const y = getY(val);

    if (!isDrawing) {
      pathD += `M ${x.toFixed(1)} ${y.toFixed(1)} `;
      isDrawing = true;
    } else {
      pathD += `L ${x.toFixed(1)} ${y.toFixed(1)} `;
    }
  });

  return (
    <div style={{ height }} className={`w-full overflow-hidden ${className}`}>
      <svg
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        preserveAspectRatio="none"
        className="w-full h-full block"
      >
        {/* 目標範囲 (70〜180 mg/dL) の薄い背景帯 */}
        <rect
          x="0"
          y={targetTopY.toFixed(1)}
          width={svgWidth}
          height={targetHeight.toFixed(1)}
          fill="#10b981"
          fillOpacity="0.10"
        />

        {/* 血糖値折れ線 (旧VBAカレンダーと同じく視認性の高いブルー系ライン + 描画アニメーション) */}
        <path
          d={pathD}
          fill="none"
          stroke="#0284c7"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="cgm-sparkline-path"
        />
      </svg>
    </div>
  );
};
