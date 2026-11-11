import React, { useState, useMemo, useEffect } from 'react';
import {
  HealthEvent,
  MealDetail,
  LibreReading,
  FoodMaster,
  Category,
} from '@/types/database';
import {
  calculateFoodImpact,
  FoodImpactSummary,
} from '@/lib/analysisCalculators';
import { extractDateStr, extractTimeStr } from '@/lib/dateUtils';
import {
  Utensils,
  TrendingUp,
  Syringe,
  Activity,
  AlertCircle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface FoodImpactTabProps {
  events: HealthEvent[];
  mealDetails: MealDetail[];
  readings: LibreReading[];
  foodMasters: FoodMaster[];
  foodCategories?: Category[];
  precomputedFoodOptions?: string[];
  detailsByEventId?: Map<string, MealDetail[]>;
  readingsByDate?: Map<string, LibreReading[]>;
  foodImpactCache?: Map<string, FoodImpactSummary>;
  isDashboardMode?: boolean;
}

/**
 * 食事時間帯区分（朝食/昼食/夕食/間食）をスマホでも省スペースで視認できる1文字ラベル＆配色に変換
 */
function getShortTimingBadge(timingCategory: string): {
  shortLabel: string;
  badgeClass: string;
} {
  if (timingCategory.startsWith('朝')) {
    return {
      shortLabel: '朝',
      badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200/80',
    };
  }
  if (timingCategory.startsWith('昼')) {
    return {
      shortLabel: '昼',
      badgeClass: 'bg-amber-50 text-amber-700 border-amber-200/80',
    };
  }
  if (timingCategory.startsWith('夕')) {
    return {
      shortLabel: '夕',
      badgeClass: 'bg-indigo-50 text-indigo-700 border-indigo-200/80',
    };
  }
  return {
    shortLabel: '間',
    badgeClass: 'bg-rose-50 text-rose-700 border-rose-200/80',
  };
}

export const FoodImpactTab: React.FC<FoodImpactTabProps> = ({
  events,
  mealDetails,
  readings,
  foodMasters,
  foodCategories = [],
  precomputedFoodOptions,
  detailsByEventId,
  readingsByDate,
  foodImpactCache,
  isDashboardMode = false,
}) => {
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('ALL');

  // 食品名 -> category_id のマップ（登録済み食品から構築し、未登録の自由入力食品は「未分類」に紐付け）
  const uncategorizedCategoryId = useMemo(() => {
    const found = foodCategories.find((c) => !c.is_deleted && c.category_name === '未分類');
    return found?.id || '';
  }, [foodCategories]);

  const foodCategoryMap = useMemo(() => {
    const map = new Map<string, string>();
    foodMasters.forEach((f) => {
      if (!f.is_deleted && f.food_name) {
        map.set(f.food_name, f.category_id || '');
      }
    });
    return map;
  }, [foodMasters]);

  // 全食品候補リスト
  const allFoodOptions = useMemo(() => {
    if (precomputedFoodOptions && precomputedFoodOptions.length > 0) {
      return precomputedFoodOptions;
    }
    const set = new Set<string>();
    foodMasters.forEach((f) => {
      if (!f.is_deleted && f.food_name) set.add(f.food_name);
    });
    mealDetails.forEach((d) => {
      if (!d.is_deleted && d.food_name) set.add(d.food_name);
    });
    events.forEach((e) => {
      if (e.event_type === '食事' && e.memo) {
        const words = e.memo.split(/[\s,、]+/);
        words.forEach((w) => {
          if (w.length >= 2 && !set.has(w)) set.add(w);
        });
      }
    });

    return Array.from(set).sort();
  }, [precomputedFoodOptions, foodMasters, mealDetails, events]);

  // 選択中のカテゴリで絞り込んだ食品候補リスト
  const filteredFoodOptions = useMemo(() => {
    if (selectedCategoryId === 'ALL') {
      return allFoodOptions;
    }
    return allFoodOptions.filter((name) => {
      const catId = foodCategoryMap.get(name) || uncategorizedCategoryId;
      return catId === selectedCategoryId;
    });
  }, [allFoodOptions, selectedCategoryId, foodCategoryMap, uncategorizedCategoryId]);

  const [selectedFood, setSelectedFood] = useState<string>(() => {
    if (allFoodOptions.includes('ごはん')) return 'ごはん';
    return allFoodOptions.length > 0 ? allFoodOptions[0] : 'ごはん';
  });

  // カテゴリ変更時に現在の選択食品が絞り込みリストに含まれない場合は先頭食品に自動切替
  useEffect(() => {
    if (
      filteredFoodOptions.length > 0 &&
      !filteredFoodOptions.includes(selectedFood)
    ) {
      setSelectedFood(filteredFoodOptions[0]);
    }
  }, [filteredFoodOptions, selectedFood]);

  // 各行の「一緒に食べたもの」アコーディオン開閉状態
  const [expandedRowIds, setExpandedRowIds] = useState<Set<string>>(() => new Set());

  const activeFoodName = selectedFood;

  // 計算実行（期間別キャッシュがあればO(1)で即時返却、未計算時も日付インデックスで<1ms算出）
  const impactSummary: FoodImpactSummary = useMemo(() => {
    const cacheKey = activeFoodName.trim().toLowerCase();
    if (foodImpactCache && foodImpactCache.has(cacheKey)) {
      return foodImpactCache.get(cacheKey)!;
    }
    const computed = calculateFoodImpact(
      activeFoodName,
      events,
      mealDetails,
      readings,
      detailsByEventId || readingsByDate
        ? { detailsByEventId, readingsByDate }
        : undefined
    );
    if (foodImpactCache) {
      foodImpactCache.set(cacheKey, computed);
    }
    return computed;
  }, [
    activeFoodName,
    events,
    mealDetails,
    readings,
    detailsByEventId,
    readingsByDate,
    foodImpactCache,
  ]);

  const toggleRowExpand = (id: string) => {
    setExpandedRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="flex flex-col flex-1 h-full space-y-3.5 sm:space-y-4">
      {/* 1. カテゴリ絞り込み ➔ 食品選択エリア（第2層：淡いスレートグレーのインナーボックス＋白いセレクトボックス） */}
      <div className="bg-slate-50/90 p-3 sm:p-3.5 rounded-2xl border border-slate-200/80 shrink-0">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {/* カテゴリ選択セレクトボックス */}
          <div>
            <label
              htmlFor="analysis-food-category-select"
              className="block text-[11px] font-bold text-slate-500 mb-1"
            >
              カテゴリで絞り込み
            </label>
            <select
              id="analysis-food-category-select"
              value={selectedCategoryId}
              onChange={(e) => setSelectedCategoryId(e.target.value)}
              className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-sm font-semibold text-slate-800 shadow-2xs focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
            >
              <option value="ALL">すべてのカテゴリ ({allFoodOptions.length}品)</option>
              {foodCategories.map((cat) => {
                const count = allFoodOptions.filter(
                  (name) => (foodCategoryMap.get(name) || uncategorizedCategoryId) === cat.id
                ).length;
                if (count === 0) return null;
                return (
                  <option key={cat.id} value={cat.id}>
                    {cat.category_name} ({count}品)
                  </option>
                );
              })}
            </select>
          </div>

          {/* 食品選択セレクトボックス */}
          <div>
            <label
              htmlFor="analysis-food-item-select"
              className="block text-[11px] font-bold text-slate-500 mb-1"
            >
              分析する食品を選択
            </label>
            <select
              id="analysis-food-item-select"
              value={selectedFood}
              onChange={(e) => setSelectedFood(e.target.value)}
              className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-sm font-semibold text-slate-800 shadow-2xs focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
            >
              {filteredFoodOptions.length === 0 ? (
                <option value="ごはん">🍚 ごはん</option>
              ) : (
                filteredFoodOptions.map((name) => (
                  <option key={name} value={name}>
                    🍚 {name}
                  </option>
                ))
              )}
            </select>
          </div>
        </div>
      </div>

      {/* 2. 4大サマリーカード (第2層：淡いスレートグレー bg-slate-50/80 で親セクション bg-white との主従階層を明確化) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-2.5 shrink-0">
        {/* 食べた回数 */}
        <div className="bg-slate-50/80 p-2.5 sm:p-3 rounded-2xl border border-slate-200/80">
          <div className="flex items-center justify-between text-slate-500 mb-0.5 sm:mb-1">
            <span className="text-[11px] font-bold whitespace-nowrap">食べた回数</span>
            <Utensils className="w-3.5 h-3.5 text-amber-500 shrink-0" />
          </div>
          <div className="flex items-baseline space-x-1">
            <span className="text-lg sm:text-xl font-extrabold text-slate-900 tracking-tight">
              {impactSummary.totalCount}
            </span>
            <span className="text-xs font-semibold text-slate-500">回</span>
          </div>
        </div>

        {/* 平均インスリン */}
        <div className="bg-slate-50/80 p-2.5 sm:p-3 rounded-2xl border border-slate-200/80">
          <div className="flex items-center justify-between text-slate-500 mb-0.5 sm:mb-1">
            <span className="text-[11px] font-bold whitespace-nowrap">平均インスリン</span>
            <Syringe className="w-3.5 h-3.5 text-sky-500 shrink-0" />
          </div>
          <div className="flex items-baseline space-x-1">
            <span className="text-lg sm:text-xl font-extrabold text-sky-600 tracking-tight">
              {impactSummary.totalCount > 0 ? impactSummary.avgInsulin.toFixed(1) : '-'}
            </span>
            <span className="text-xs font-semibold text-slate-500">U</span>
          </div>
        </div>

        {/* 食前 / ピーク平均 */}
        <div className="bg-slate-50/80 p-2.5 sm:p-3 rounded-2xl border border-slate-200/80">
          <div className="flex items-center justify-between text-slate-500 mb-0.5 sm:mb-1">
            <span className="text-[11px] font-bold whitespace-nowrap">食前 → ピーク</span>
            <Activity className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
          </div>
          <div className="flex items-baseline space-x-1">
            <span className="text-base sm:text-lg font-extrabold text-slate-800">
              {impactSummary.avgPreGlucose != null ? impactSummary.avgPreGlucose : '-'}
            </span>
            <span className="text-xs text-slate-400">→</span>
            <span className="text-base sm:text-lg font-extrabold text-amber-600">
              {impactSummary.avgPeakGlucose != null ? impactSummary.avgPeakGlucose : '-'}
            </span>
          </div>
        </div>

        {/* 平均上昇幅 (Δ) */}
        <div className="bg-slate-50/80 p-2.5 sm:p-3 rounded-2xl border border-slate-200/80">
          <div className="flex items-center justify-between text-slate-500 mb-0.5 sm:mb-1">
            <span className="text-[11px] font-bold whitespace-nowrap">平均上昇幅 (Δ)</span>
            <TrendingUp className="w-3.5 h-3.5 text-rose-500 shrink-0" />
          </div>
          <div className="flex items-baseline space-x-1">
            <span
              className={cn(
                'text-lg sm:text-xl font-extrabold tracking-tight',
                impactSummary.avgDelta != null && impactSummary.avgDelta >= 50
                  ? 'text-rose-600'
                  : impactSummary.avgDelta != null && impactSummary.avgDelta >= 30
                  ? 'text-amber-600'
                  : 'text-emerald-600'
              )}
            >
              {impactSummary.avgDelta != null
                ? `${impactSummary.avgDelta > 0 ? '+' : ''}${impactSummary.avgDelta}`
                : '-'}
            </span>
            <span className="text-[11px] font-semibold text-slate-500">mg/dL</span>
          </div>
        </div>
      </div>

      {/* 3. 食事履歴テーブル（スマホ横スクロール完全ゼロ・1文字区分バッジ・ピル型アコーディオン） */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-2xs overflow-hidden flex-1 flex flex-col min-h-0">
        <div className="px-3 py-2.5 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-2 shrink-0">
          <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5 min-w-0">
            <span className="truncate">「{activeFoodName}」の食事履歴</span>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-200 text-slate-700 font-semibold whitespace-nowrap shrink-0">
              {impactSummary.items.length} 件
            </span>
          </h4>
          {impactSummary.items.some((i) => i.otherFoods.length > 0) && (
            <span className="text-[10px] sm:text-[11px] text-slate-400 whitespace-nowrap shrink-0">
              ※行タップで他品目を表示
            </span>
          )}
        </div>

        {impactSummary.items.length === 0 ? (
          <div className="p-8 text-center text-slate-400 space-y-1.5 flex-1 flex flex-col items-center justify-center">
            <AlertCircle className="w-7 h-7 text-slate-300 mx-auto" />
            <p className="text-xs font-medium">
              選択された期間内に「{activeFoodName}」を含む食事記録は見つかりませんでした。
            </p>
          </div>
        ) : (
          <div
            className={cn(
              'overflow-x-auto overflow-y-auto flex-1',
              isDashboardMode ? 'xl:h-[415px] max-h-[415px]' : 'max-h-[540px]'
            )}
          >
            <table className="w-full text-left text-xs text-slate-600">
              <thead className="bg-slate-100 text-slate-500 font-bold text-[10px] sm:text-[11px] border-b border-slate-200 sticky top-0 z-10 shadow-2xs">
                <tr>
                  <th className="py-2 pl-2.5 pr-1 sm:px-2.5 whitespace-nowrap">日時</th>
                  <th className="py-2 px-1.5 sm:px-2 whitespace-nowrap">量・糖質</th>
                  <th className="py-2 px-1 sm:px-2 text-right whitespace-nowrap">インスリン</th>
                  <th className="py-2 px-1 sm:px-2 text-center whitespace-nowrap">食前→ピーク</th>
                  <th className="py-2 pl-1 pr-2.5 sm:px-2.5 text-right font-extrabold whitespace-nowrap">
                    Δ上昇幅
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {impactSummary.items.map((item) => {
                  const rawDate = extractDateStr(item.eventDatetime);
                  const [, mStr, dStr] = rawDate.split('-');
                  const dateLabel =
                    mStr && dStr ? `${parseInt(mStr, 10)}/${parseInt(dStr, 10)}` : rawDate;
                  const timeStr = extractTimeStr(item.eventDatetime);
                  const hasOtherFoods = item.otherFoods.length > 0;
                  const isRowExpanded = expandedRowIds.has(item.id);
                  const timingBadge = getShortTimingBadge(item.timingCategory);
                  // スマホで横幅を圧迫しないよう、例: "1杯(150g)" の括弧内補足は省いて "1杯" をすっきり表示
                  const compactAmount =
                    item.amountText.replace(/\([^)]*\)/g, '').trim() || item.amountText;

                  return (
                    <React.Fragment key={item.id}>
                      <tr
                        onClick={() => hasOtherFoods && toggleRowExpand(item.id)}
                        className={cn(
                          'transition-colors',
                          hasOtherFoods
                            ? 'hover:bg-indigo-50/40 cursor-pointer'
                            : 'hover:bg-slate-50/80',
                          isRowExpanded && 'bg-indigo-50/25'
                        )}
                      >
                        {/* 列1: 1行目＝日付＋1文字区分バッジ（朝/昼/夕/間）、2行目＝時刻 */}
                        <td className="py-2 pl-2.5 pr-1 sm:px-2.5 whitespace-nowrap align-middle">
                          <div className="flex items-center gap-1">
                            <span className="font-bold text-slate-800 text-[11px] sm:text-xs">
                              {dateLabel}
                            </span>
                            <span
                              title={item.timingCategory}
                              className={cn(
                                'px-1 py-0 rounded text-[10px] font-bold border leading-tight',
                                timingBadge.badgeClass
                              )}
                            >
                              {timingBadge.shortLabel}
                            </span>
                          </div>
                          <div className="text-[10px] sm:text-[11px] text-slate-400 font-mono leading-tight mt-0.5">
                            {timeStr}
                          </div>
                        </td>

                        {/* 列2: 1行目＝量・糖質、2行目＝他品目アコーディオンボタン */}
                        <td className="py-2 px-1.5 sm:px-2 align-middle">
                          <div className="flex items-baseline gap-0.5 whitespace-nowrap">
                            <span className="font-bold text-slate-800 text-[11px] sm:text-xs">
                              {compactAmount}
                            </span>
                            <span className="text-[10px] sm:text-[11px] font-mono font-semibold text-slate-500">
                              ({item.carbs.toFixed(1)}g)
                            </span>
                          </div>
                          {hasOtherFoods && (
                            <div className="mt-0.5">
                              <span
                                className={cn(
                                  'inline-flex items-center space-x-0.5 px-1.5 py-0.2 rounded-full text-[10px] font-semibold transition-colors whitespace-nowrap',
                                  isRowExpanded
                                    ? 'bg-indigo-100 text-indigo-700'
                                    : 'bg-slate-100 text-slate-600 hover:bg-indigo-50 hover:text-indigo-600'
                                )}
                              >
                                <span>＋他{item.otherFoods.length}品</span>
                                {isRowExpanded ? (
                                  <ChevronUp className="w-2.5 h-2.5 shrink-0" />
                                ) : (
                                  <ChevronDown className="w-2.5 h-2.5 shrink-0" />
                                )}
                              </span>
                            </div>
                          )}
                        </td>

                        {/* 列3: インスリン */}
                        <td className="py-2 px-1 sm:px-2 text-right font-mono font-semibold text-sky-600 text-[11px] sm:text-xs whitespace-nowrap align-middle">
                          {item.insulinUnits > 0 ? `${item.insulinUnits.toFixed(1)}U` : '-'}
                        </td>

                        {/* 列4: 食前→ピーク */}
                        <td className="py-2 px-1 sm:px-2 text-center font-mono text-[11px] sm:text-xs whitespace-nowrap align-middle">
                          <span className="font-semibold text-slate-700">
                            {item.preGlucose ?? '-'}
                          </span>
                          <span className="text-slate-400 mx-0.5">→</span>
                          <span className="font-bold text-amber-600">
                            {item.peakGlucose ?? '-'}
                          </span>
                        </td>

                        {/* 列5: Δ上昇幅 */}
                        <td className="py-2 pl-1 pr-2.5 sm:px-2.5 text-right whitespace-nowrap align-middle">
                          <span
                            className={cn(
                              'font-mono font-extrabold text-[11px] sm:text-xs',
                              item.delta != null && item.delta >= 50
                                ? 'text-rose-600'
                                : item.delta != null && item.delta >= 30
                                ? 'text-amber-600'
                                : 'text-emerald-600'
                            )}
                          >
                            {item.delta != null
                              ? `${item.delta > 0 ? '+' : ''}${item.delta}`
                              : '-'}
                          </span>
                        </td>
                      </tr>

                      {/* 一緒に食べたもののアコーディオン内訳行（品目ごとの独立ピル表示で途中改行を防止） */}
                      {hasOtherFoods && isRowExpanded && (
                        <tr className="bg-indigo-50/35">
                          <td colSpan={5} className="p-0">
                            <div className="border-l-4 border-indigo-400 px-2.5 sm:px-3.5 py-2 space-y-1.5">
                              <div className="flex items-center justify-between gap-2 text-[11px]">
                                <span className="font-bold text-slate-700 whitespace-nowrap">
                                  🍽️ 一緒に食べたもの（{item.otherFoods.length}品）
                                </span>
                                <span className="text-[10px] sm:text-[11px] font-semibold text-slate-600 bg-white px-2 py-0.5 rounded-full border border-indigo-200/80 whitespace-nowrap">
                                  食事合計糖質:{' '}
                                  <strong className="font-mono font-bold text-indigo-700">
                                    {item.totalMealCarbs.toFixed(1)}g
                                  </strong>
                                </span>
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {item.otherFoods.map((foodStr, idx) => {
                                  const match = foodStr.match(/^(.*?)\s*\(([^)]+)\)$/);
                                  const foodName = match ? match[1] : foodStr;
                                  const carbLabel = match ? match[2] : null;
                                  return (
                                    <span
                                      key={idx}
                                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-white border border-slate-200/90 shadow-2xs text-[11px] whitespace-nowrap"
                                    >
                                      <span className="font-semibold text-slate-800">
                                        {foodName}
                                      </span>
                                      {carbLabel && (
                                        <span className="font-mono text-[10px] font-bold text-amber-700 bg-amber-50 px-1 rounded">
                                          {carbLabel}
                                        </span>
                                      )}
                                    </span>
                                  );
                                })}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
