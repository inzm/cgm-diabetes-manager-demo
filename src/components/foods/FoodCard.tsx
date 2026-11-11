import React from 'react';
import { FoodMaster, Category } from '@/types/database';
import { usePatient } from '@/contexts/PatientContext';
import { cn } from '@/lib/utils';

interface FoodCardProps {
  food: FoodMaster;
  categories: Category[];
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  onEdit: (food: FoodMaster) => void;
  onDelete?: (id: string) => void;
}

export const FoodCard: React.FC<FoodCardProps> = ({
  food,
  categories,
  selected = false,
  onToggleSelect,
  onEdit,
}) => {
  const { isReadOnly } = usePatient();

  const category = categories.find((c) => c.id === food.category_id);
  const categoryName = category?.category_name || '未分類';

  const getCategoryBadgeClass = (name: string) => {
    switch (name) {
      case '主食':
        return 'bg-amber-50 text-amber-700 border-amber-200';
      case '主菜':
        return 'bg-rose-50 text-rose-700 border-rose-200';
      case '副菜':
        return 'bg-emerald-50 text-emerald-700 border-emerald-200';
      case '間食・デザート':
        return 'bg-purple-50 text-purple-700 border-purple-200';
      case '飲料':
        return 'bg-sky-50 text-sky-700 border-sky-200';
      default:
        return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  const handleRowClick = () => {
    if (isReadOnly) return;
    onEdit(food);
  };

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  const handleCheckboxChange = () => {
    if (isReadOnly || !onToggleSelect) return;
    onToggleSelect(food.id);
  };

  const carbsVal = Number(food.carbs_per_unit) || 0;
  const carbsFormatted = Number.isInteger(carbsVal) ? String(carbsVal) : carbsVal.toFixed(1);

  return (
    <div
      role={isReadOnly ? undefined : 'button'}
      tabIndex={isReadOnly ? undefined : 0}
      onClick={handleRowClick}
      onKeyDown={(e) => {
        if (!isReadOnly && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onEdit(food);
        }
      }}
      className={cn(
        'grid grid-cols-12 items-center gap-1 sm:gap-2 px-3 sm:px-4 py-2.5 text-xs sm:text-sm transition-colors',
        !isReadOnly && 'cursor-pointer hover:bg-amber-50/40',
        selected ? 'bg-sky-50/70 hover:bg-sky-50/90' : 'bg-white'
      )}
    >
      {/* チェックボックス + カテゴリ + 食品名 */}
      <div className="col-span-7 flex items-center gap-1.5 sm:gap-2.5 min-w-0">
        {!isReadOnly && (
          <div
            onClick={handleCheckboxClick}
            className="flex items-center justify-center shrink-0 p-1 -m-1"
          >
            <input
              type="checkbox"
              checked={selected}
              onChange={handleCheckboxChange}
              aria-label={`${food.food_name}を選択`}
              className="w-4 h-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500 cursor-pointer"
            />
          </div>
        )}

        <span
          className={cn(
            'text-[10px] font-bold px-1.5 sm:px-2 py-0.5 rounded-md border shrink-0 whitespace-nowrap',
            getCategoryBadgeClass(categoryName)
          )}
        >
          {categoryName}
        </span>

        <span className="font-bold text-slate-800 truncate">{food.food_name}</span>
      </div>

      {/* 基準量 */}
      <div className="col-span-3 text-right text-[11px] sm:text-xs text-slate-500 font-medium tabular-nums whitespace-nowrap truncate">
        {food.base_amount} {food.unit}
      </div>

      {/* 糖質量 */}
      <div className="col-span-2 text-right tabular-nums whitespace-nowrap">
        <span
          className={cn(
            'text-sm sm:text-base font-black tracking-tight',
            carbsVal >= 50
              ? 'text-amber-700'
              : carbsVal >= 20
                ? 'text-amber-600'
                : 'text-slate-700'
          )}
        >
          {carbsFormatted}
        </span>
        <span className="text-[11px] text-slate-400 font-bold ml-0.5">g</span>
      </div>
    </div>
  );
};
