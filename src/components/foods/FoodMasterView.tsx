import React, { useState, useEffect, useMemo } from 'react';
import { usePatient } from '@/contexts/PatientContext';
import { db } from '@/lib/db';
import { FoodMaster, EventMaster, Category } from '@/types/database';
import { seedFoodMasterIfEmpty } from '@/lib/foodSeed';
import {
  invalidateAnalysisDatasetCache,
  pauseBackgroundHydration,
  waitForRecentPersistence,
} from '@/lib/realGlucoseLoader';
import {
  registerUiCacheInvalidator,
  triggerBackgroundCloudSync,
} from '@/lib/syncEngine';
import { FoodCard } from './FoodCard';
import { FoodEditModal } from './FoodEditModal';
import { EventEditModal } from './EventEditModal';
import { CategoryManageModal } from './CategoryManageModal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import {
  Search,
  Plus,
  Utensils,
  Footprints,
  Tag,
  Lock,
  Trash2,
  FolderInput,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type SectionTab = 'food' | 'event';
type FoodSortKey = 'name_asc' | 'name_desc' | 'carbs_asc' | 'carbs_desc';
type EventSortKey = 'name_asc' | 'name_desc' | 'duration_asc' | 'duration_desc';

interface FoodMasterCacheEntry {
  foods: FoodMaster[];
  foodCategories: Category[];
  eventItems: EventMaster[];
  eventCategories: Category[];
}

const foodMasterMemoryCache = new Map<string, FoodMasterCacheEntry>();

export function invalidateFoodMasterMemoryCache(patientId?: string): void {
  if (patientId) {
    foodMasterMemoryCache.delete(patientId);
  } else {
    foodMasterMemoryCache.clear();
  }
}

registerUiCacheInvalidator((patientId) => {
  invalidateFoodMasterMemoryCache(patientId);
});

export function hasFoodMasterMemoryCache(patientId: string): boolean {
  return foodMasterMemoryCache.has(patientId);
}

export function primeFoodMasterMemoryCache(
  patientId: string,
  entry: FoodMasterCacheEntry
): void {
  foodMasterMemoryCache.set(patientId, entry);
}

export const FoodMasterView: React.FC = () => {
  const { currentPatientId, isReadOnly } = usePatient();

  // セクション切替 ('food' = よく使う食品, 'event' = よく使う活動)
  const [sectionTab, setSectionTab] = useState<SectionTab>('food');

  const [foods, setFoods] = useState<FoodMaster[]>(
    () => foodMasterMemoryCache.get(currentPatientId)?.foods ?? []
  );
  const [foodCategories, setFoodCategories] = useState<Category[]>(
    () => foodMasterMemoryCache.get(currentPatientId)?.foodCategories ?? []
  );
  const [eventItems, setEventItems] = useState<EventMaster[]>(
    () => foodMasterMemoryCache.get(currentPatientId)?.eventItems ?? []
  );
  const [eventCategories, setEventCategories] = useState<Category[]>(
    () => foodMasterMemoryCache.get(currentPatientId)?.eventCategories ?? []
  );
  const [isLoading, setIsLoading] = useState<boolean>(
    () => !foodMasterMemoryCache.has(currentPatientId)
  );

  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [foodSort, setFoodSort] = useState<FoodSortKey>('name_asc');
  const [eventSort, setEventSort] = useState<EventSortKey>('name_asc');

  // 複数選択チェックボックス状態
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkCategoryId, setBulkCategoryId] = useState<string>('');
  const [isBulkDeleteConfirmOpen, setIsBulkDeleteConfirmOpen] = useState<boolean>(false);

  // モーダル状態
  const [isFoodModalOpen, setIsFoodModalOpen] = useState(false);
  const [foodToEdit, setFoodToEdit] = useState<FoodMaster | null>(null);

  const [isEventModalOpen, setIsEventModalOpen] = useState(false);
  const [eventToEdit, setEventToEdit] = useState<EventMaster | null>(null);

  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false);
  const [deleteFoodId, setDeleteFoodId] = useState<string | null>(null);
  const [deleteEventId, setDeleteEventId] = useState<string | null>(null);

  // データ読み込み
  const loadData = async () => {
    try {
      if (!foodMasterMemoryCache.has(currentPatientId)) {
        setIsLoading(true);
      }
      pauseBackgroundHydration(currentPatientId, 2500);
      await waitForRecentPersistence(currentPatientId);
      await seedFoodMasterIfEmpty(currentPatientId);

      const [foodList, eventList, allCats] = await Promise.all([
        db.food_master
          .where('user_id')
          .equals(currentPatientId)
          .filter((f) => !f.is_deleted)
          .toArray(),
        db.event_master
          .where('user_id')
          .equals(currentPatientId)
          .filter((e) => !e.is_deleted)
          .toArray(),
        db.categories
          .where('user_id')
          .equals(currentPatientId)
          .filter((c) => !c.is_deleted)
          .toArray(),
      ]);

      const fCats = allCats
        .filter((c) => c.target_type === 'food')
        .sort((a, b) => a.display_order - b.display_order);
      const eCats = allCats
        .filter((c) => c.target_type === 'event')
        .sort((a, b) => a.display_order - b.display_order);

      foodMasterMemoryCache.set(currentPatientId, {
        foods: foodList,
        foodCategories: fCats,
        eventItems: eventList,
        eventCategories: eCats,
      });

      setFoods(foodList);
      setFoodCategories(fCats);
      setEventItems(eventList);
      setEventCategories(eCats);

      // 選択中だったカテゴリが削除された場合は「すべて」へ自動リセット
      setSelectedCategoryId((prev) => {
        if (prev === 'all') return 'all';
        const exists = allCats.some((c) => c.id === prev);
        return exists ? prev : 'all';
      });
    } catch (err) {
      console.error('Failed to load food and activity items:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [currentPatientId]);

  const handleSwitchSection = (tab: SectionTab) => {
    setSectionTab(tab);
    setSelectedCategoryId('all');
    setSearchQuery('');
    setSelectedIds(new Set());
    setBulkCategoryId('');
  };

  const handleSelectCategory = (catId: string) => {
    setSelectedCategoryId(catId);
    setSelectedIds(new Set());
  };

  // 食品フィルタリング & ソート
  const filteredFoods = useMemo(() => {
    return foods
      .filter((f) => {
        const matchesCategory =
          selectedCategoryId === 'all' || f.category_id === selectedCategoryId;
        const matchesSearch =
          !searchQuery.trim() ||
          f.food_name.toLowerCase().includes(searchQuery.toLowerCase().trim());
        return matchesCategory && matchesSearch;
      })
      .sort((a, b) => {
        if (foodSort === 'name_asc') return a.food_name.localeCompare(b.food_name, 'ja');
        if (foodSort === 'name_desc') return b.food_name.localeCompare(a.food_name, 'ja');
        if (foodSort === 'carbs_asc') return a.carbs_per_unit - b.carbs_per_unit;
        return b.carbs_per_unit - a.carbs_per_unit;
      });
  }, [foods, selectedCategoryId, searchQuery, foodSort]);

  // 活動フィルタリング & ソート
  const filteredEvents = useMemo(() => {
    return eventItems
      .filter((e) => {
        const matchesCategory =
          selectedCategoryId === 'all' || e.category_id === selectedCategoryId;
        const matchesSearch =
          !searchQuery.trim() ||
          e.event_name.toLowerCase().includes(searchQuery.toLowerCase().trim()) ||
          (e.memo && e.memo.toLowerCase().includes(searchQuery.toLowerCase().trim()));
        return matchesCategory && matchesSearch;
      })
      .sort((a, b) => {
        if (eventSort === 'name_asc') return a.event_name.localeCompare(b.event_name, 'ja');
        if (eventSort === 'name_desc') return b.event_name.localeCompare(a.event_name, 'ja');
        if (eventSort === 'duration_asc') return a.default_duration - b.default_duration;
        return b.default_duration - a.default_duration;
      });
  }, [eventItems, selectedCategoryId, searchQuery, eventSort]);

  const currentVisibleIds = useMemo(() => {
    return sectionTab === 'food'
      ? filteredFoods.map((f) => f.id)
      : filteredEvents.map((e) => e.id);
  }, [sectionTab, filteredFoods, filteredEvents]);

  const isAllVisibleSelected =
    currentVisibleIds.length > 0 && currentVisibleIds.every((id) => selectedIds.has(id));

  const handleToggleSelectOne = (id: string) => {
    if (isReadOnly) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleToggleSelectAllVisible = () => {
    if (isReadOnly) return;
    if (isAllVisibleSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of currentVisibleIds) {
          next.delete(id);
        }
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of currentVisibleIds) {
          next.add(id);
        }
        return next;
      });
    }
  };

  // 列ヘッダークリックによるソート切替
  const toggleFoodSort = (field: 'name' | 'carbs') => {
    if (field === 'name') {
      setFoodSort((prev) => (prev === 'name_asc' ? 'name_desc' : 'name_asc'));
    } else {
      setFoodSort((prev) => (prev === 'carbs_desc' ? 'carbs_asc' : 'carbs_desc'));
    }
  };

  const toggleEventSort = (field: 'name' | 'duration') => {
    if (field === 'name') {
      setEventSort((prev) => (prev === 'name_asc' ? 'name_desc' : 'name_asc'));
    } else {
      setEventSort((prev) => (prev === 'duration_desc' ? 'duration_asc' : 'duration_desc'));
    }
  };

  // 一括カテゴリ変更
  const handleBulkCategoryMove = async (targetCatId: string) => {
    if (isReadOnly || !targetCatId || selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    const now = new Date().toISOString();

    if (sectionTab === 'food') {
      await db.transaction('rw', db.food_master, async () => {
        for (const id of ids) {
          await db.food_master.update(id, { category_id: targetCatId, updated_at: now });
        }
      });
    } else {
      await db.transaction('rw', db.event_master, async () => {
        for (const id of ids) {
          await db.event_master.update(id, { category_id: targetCatId, updated_at: now });
        }
      });
    }

    setBulkCategoryId('');
    setSelectedIds(new Set());
    invalidateFoodMasterMemoryCache(currentPatientId);
    invalidateAnalysisDatasetCache();
    triggerBackgroundCloudSync(currentPatientId);
    loadData();
  };

  // 一括削除の実行
  const executeBulkDelete = async () => {
    if (isReadOnly || selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    const now = new Date().toISOString();
    setIsBulkDeleteConfirmOpen(false);

    if (sectionTab === 'food') {
      await db.transaction('rw', db.food_master, async () => {
        for (const id of ids) {
          await db.food_master.update(id, { is_deleted: true, updated_at: now });
        }
      });
    } else {
      await db.transaction('rw', db.event_master, async () => {
        for (const id of ids) {
          await db.event_master.update(id, { is_deleted: true, updated_at: now });
        }
      });
    }

    setSelectedIds(new Set());
    invalidateFoodMasterMemoryCache(currentPatientId);
    invalidateAnalysisDatasetCache();
    triggerBackgroundCloudSync(currentPatientId);
    loadData();
  };

  // 単体操作ハンドラー
  const handleOpenAddFood = () => {
    setFoodToEdit(null);
    setIsFoodModalOpen(true);
  };

  const handleOpenEditFood = (food: FoodMaster) => {
    setFoodToEdit(food);
    setIsFoodModalOpen(true);
  };

  const executeDeleteFood = async () => {
    if (!deleteFoodId) return;
    const id = deleteFoodId;
    setDeleteFoodId(null);
    await db.food_master.update(id, {
      is_deleted: true,
      updated_at: new Date().toISOString(),
    });
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    invalidateFoodMasterMemoryCache(currentPatientId);
    invalidateAnalysisDatasetCache();
    triggerBackgroundCloudSync(currentPatientId);
    loadData();
  };

  const handleOpenAddEvent = () => {
    setEventToEdit(null);
    setIsEventModalOpen(true);
  };

  const handleOpenEditEvent = (ev: EventMaster) => {
    setEventToEdit(ev);
    setIsEventModalOpen(true);
  };

  const executeDeleteEvent = async () => {
    if (!deleteEventId) return;
    const id = deleteEventId;
    setDeleteEventId(null);
    await db.event_master.update(id, {
      is_deleted: true,
      updated_at: new Date().toISOString(),
    });
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    invalidateFoodMasterMemoryCache(currentPatientId);
    invalidateAnalysisDatasetCache();
    triggerBackgroundCloudSync(currentPatientId);
    loadData();
  };

  const activeCategories = sectionTab === 'food' ? foodCategories : eventCategories;
  const totalCount = sectionTab === 'food' ? foods.length : eventItems.length;

  const getCategoryDotColor = (name: string) => {
    switch (name) {
      case '主食':
        return 'bg-amber-500';
      case '主菜':
        return 'bg-rose-500';
      case '副菜':
      case '運動':
        return 'bg-emerald-500';
      case '間食・デザート':
      case '体調・補食':
        return 'bg-purple-500';
      case '飲料':
      case 'インスリン':
        return 'bg-sky-500';
      default:
        return 'bg-slate-400';
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-6 space-y-4">
      {/* 1. 上部バー: 食品・活動 切替タブ & 新規追加ボタン */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-white p-3 sm:p-4 rounded-2xl border border-slate-200 shadow-2xs">
        <div className="grid grid-cols-2 sm:inline-flex rounded-xl bg-slate-100 p-1 gap-1">
          <button
            type="button"
            onClick={() => handleSwitchSection('food')}
            className={cn(
              'flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs sm:text-sm font-bold transition-all cursor-pointer',
              sectionTab === 'food'
                ? 'bg-white text-amber-700 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            )}
          >
            <Utensils className="w-4 h-4 text-amber-500" />
            <span>よく使う食品 ({foods.length})</span>
          </button>

          <button
            type="button"
            onClick={() => handleSwitchSection('event')}
            className={cn(
              'flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs sm:text-sm font-bold transition-all cursor-pointer',
              sectionTab === 'event'
                ? 'bg-white text-emerald-700 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            )}
          >
            <Footprints className="w-4 h-4 text-emerald-500" />
            <span>よく使う活動 ({eventItems.length})</span>
          </button>
        </div>

        <div className="flex items-center justify-end gap-2">
          {/* モバイル・タブレット時のみ上部にカテゴリ編集ボタンを表示 (PCは右サイドメニュー内に配置) */}
          <button
            type="button"
            onClick={() => setIsCategoryModalOpen(true)}
            className="lg:hidden inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-xs font-bold text-slate-700 transition-colors shadow-2xs cursor-pointer"
          >
            <Tag className="w-3.5 h-3.5 text-sky-500" />
            <span>カテゴリ編集</span>
          </button>

          <button
            type="button"
            disabled={isReadOnly}
            onClick={sectionTab === 'food' ? handleOpenAddFood : handleOpenAddEvent}
            className={cn(
              'inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-xs',
              isReadOnly
                ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed'
                : sectionTab === 'food'
                  ? 'bg-amber-600 hover:bg-amber-700 text-white cursor-pointer active:scale-95'
                  : 'bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer active:scale-95'
            )}
          >
            {isReadOnly ? <Lock className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            <span>{sectionTab === 'food' ? '食品を追加' : '活動を追加'}</span>
          </button>
        </div>
      </div>

      {/* 2. メイン2カラム領域 (左: 検索＋リスト / 右: PC用カテゴリサイドメニュー) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* 左カラム: 検索・一括操作・データリスト */}
        <div className="lg:col-span-9 space-y-3">
          {/* 検索バー & モバイル用カテゴリピル */}
          <div className="bg-white rounded-2xl border border-slate-200 p-3 sm:p-3.5 shadow-2xs space-y-2.5">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-2.5" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={
                  sectionTab === 'food'
                    ? '食品名で検索 (例: ごはん, 食パン, うどん)...'
                    : '活動名やメモで検索 (例: ウォーキング, 入浴)...'
                }
                className="w-full pl-9 pr-8 py-2 rounded-xl border border-slate-200 text-xs sm:text-sm focus:outline-hidden focus:ring-2 focus:ring-sky-500"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="検索クリア"
                  className="absolute right-2.5 top-2 p-1 text-slate-400 hover:text-slate-600 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* モバイル・タブレット用横スクロールカテゴリピル (lg未満で表示) */}
            <div className="flex lg:hidden items-center gap-1.5 overflow-x-auto pt-0.5 pb-0.5">
              <button
                type="button"
                onClick={() => handleSelectCategory('all')}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all cursor-pointer',
                  selectedCategoryId === 'all'
                    ? 'bg-slate-900 text-white shadow-2xs'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                )}
              >
                すべて ({totalCount})
              </button>

              {activeCategories.map((cat) => {
                const count =
                  sectionTab === 'food'
                    ? foods.filter((f) => f.category_id === cat.id).length
                    : eventItems.filter((e) => e.category_id === cat.id).length;
                return (
                  <button
                    type="button"
                    key={cat.id}
                    onClick={() => handleSelectCategory(cat.id)}
                    className={cn(
                      'px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all cursor-pointer',
                      selectedCategoryId === cat.id
                        ? 'bg-slate-900 text-white shadow-2xs'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    )}
                  >
                    {cat.category_name} ({count})
                  </button>
                );
              })}
            </div>
          </div>

          {/* 複数選択時の一括操作バー */}
          {!isReadOnly && selectedIds.size > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 bg-sky-900 text-white px-3.5 py-2.5 rounded-xl shadow-md animate-in fade-in duration-150">
              <div className="flex items-center gap-2 text-xs sm:text-sm font-bold">
                <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-md bg-sky-500 text-white font-black tabular-nums">
                  {selectedIds.size}件
                </span>
                <span>を選択中</span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {/* 一括カテゴリ変更セレクタ */}
                <div className="inline-flex items-center gap-1.5 bg-slate-800/90 border border-slate-700 rounded-lg px-2.5 py-1">
                  <FolderInput className="w-3.5 h-3.5 text-sky-300 shrink-0" />
                  <select
                    value={bulkCategoryId}
                    onChange={(e) => handleBulkCategoryMove(e.target.value)}
                    aria-label="選択した項目のカテゴリを一括変更"
                    className="bg-transparent text-xs font-bold text-white focus:outline-hidden cursor-pointer"
                  >
                    <option value="" className="text-slate-800">
                      カテゴリを一括変更...
                    </option>
                    {activeCategories.map((cat) => (
                      <option key={cat.id} value={cat.id} className="text-slate-800">
                        「{cat.category_name}」へ移動
                      </option>
                    ))}
                  </select>
                </div>

                {/* 一括削除ボタン */}
                <button
                  type="button"
                  onClick={() => setIsBulkDeleteConfirmOpen(true)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>まとめて削除</span>
                </button>

                {/* 選択解除ボタン */}
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-sky-200 hover:text-white hover:bg-sky-800 transition-colors cursor-pointer"
                >
                  選択解除
                </button>
              </div>
            </div>
          )}

          {/* 3. リストテーブル本体 */}
          {isLoading ? (
            <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center space-y-2">
              <Utensils className="w-7 h-7 text-slate-300 animate-pulse mx-auto" />
              <p className="text-xs font-semibold text-slate-500">データを読み込み中...</p>
            </div>
          ) : sectionTab === 'food' ? (
            filteredFoods.length === 0 ? (
              <div className="bg-white rounded-2xl border border-dashed border-slate-200 p-10 text-center space-y-2">
                <Utensils className="w-8 h-8 text-slate-300 mx-auto" />
                <h4 className="text-sm font-bold text-slate-700">該当する食品がありません</h4>
                <p className="text-xs text-slate-400">
                  「+ 食品を追加」ボタンから登録してください。
                </p>
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-2xs overflow-hidden">
                {/* 食品リスト列ヘッダー */}
                <div className="grid grid-cols-12 items-center gap-1 sm:gap-2 px-3 sm:px-4 py-2.5 bg-slate-50 border-b border-slate-200 text-[11px] font-bold text-slate-500 select-none">
                  <div className="col-span-7 flex items-center gap-1.5 sm:gap-2.5 min-w-0">
                    {!isReadOnly && (
                      <input
                        type="checkbox"
                        checked={isAllVisibleSelected}
                        onChange={handleToggleSelectAllVisible}
                        aria-label="表示中の食品をすべて選択"
                        className="w-4 h-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500 cursor-pointer shrink-0"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => toggleFoodSort('name')}
                      className="inline-flex items-center gap-1 hover:text-slate-900 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <span>カテゴリ / 食品名</span>
                      {foodSort === 'name_asc' ? (
                        <ArrowUp className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                      ) : foodSort === 'name_desc' ? (
                        <ArrowDown className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                      ) : (
                        <ArrowUpDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      )}
                    </button>
                  </div>

                  <div className="col-span-3 text-right whitespace-nowrap">基準量</div>

                  <div className="col-span-2 flex justify-end">
                    <button
                      type="button"
                      onClick={() => toggleFoodSort('carbs')}
                      className="inline-flex items-center gap-0.5 sm:gap-1 hover:text-slate-900 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <span>糖質量</span>
                      {foodSort === 'carbs_asc' ? (
                        <ArrowUp className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-amber-600 shrink-0" />
                      ) : foodSort === 'carbs_desc' ? (
                        <ArrowDown className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-amber-600 shrink-0" />
                      ) : (
                        <ArrowUpDown className="hidden sm:inline-block w-3.5 h-3.5 text-slate-400 shrink-0" />
                      )}
                    </button>
                  </div>
                </div>

                {/* 食品リスト行 */}
                <div className="divide-y divide-slate-100">
                  {filteredFoods.map((food) => (
                    <FoodCard
                      key={food.id}
                      food={food}
                      categories={foodCategories}
                      selected={selectedIds.has(food.id)}
                      onToggleSelect={handleToggleSelectOne}
                      onEdit={handleOpenEditFood}
                    />
                  ))}
                </div>
              </div>
            )
          ) : filteredEvents.length === 0 ? (
            <div className="bg-white rounded-2xl border border-dashed border-slate-200 p-10 text-center space-y-2">
              <Footprints className="w-8 h-8 text-slate-300 mx-auto" />
              <h4 className="text-sm font-bold text-slate-700">該当する活動がありません</h4>
              <p className="text-xs text-slate-400">
                「+ 活動を追加」ボタンから登録してください。
              </p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-slate-200 shadow-2xs overflow-hidden">
              {/* 活動リスト列ヘッダー */}
              <div className="grid grid-cols-12 items-center gap-2 px-3 sm:px-4 py-2.5 bg-slate-50 border-b border-slate-200 text-[11px] font-bold text-slate-500 select-none">
                <div className="col-span-7 sm:col-span-6 flex items-center gap-2.5">
                  {!isReadOnly && (
                    <input
                      type="checkbox"
                      checked={isAllVisibleSelected}
                      onChange={handleToggleSelectAllVisible}
                      aria-label="表示中の活動をすべて選択"
                      className="w-4 h-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500 cursor-pointer"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => toggleEventSort('name')}
                    className="inline-flex items-center gap-1 hover:text-slate-900 transition-colors cursor-pointer"
                  >
                    <span>カテゴリ / 活動名</span>
                    {eventSort === 'name_asc' ? (
                      <ArrowUp className="w-3.5 h-3.5 text-emerald-600" />
                    ) : eventSort === 'name_desc' ? (
                      <ArrowDown className="w-3.5 h-3.5 text-emerald-600" />
                    ) : (
                      <ArrowUpDown className="w-3.5 h-3.5 text-slate-400" />
                    )}
                  </button>
                </div>

                <div className="hidden sm:block sm:col-span-4 text-left">補足メモ</div>

                <div className="col-span-5 sm:col-span-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => toggleEventSort('duration')}
                    className="inline-flex items-center gap-1 hover:text-slate-900 transition-colors cursor-pointer"
                  >
                    <span>標準時間</span>
                    {eventSort === 'duration_asc' ? (
                      <ArrowUp className="w-3.5 h-3.5 text-emerald-600" />
                    ) : eventSort === 'duration_desc' ? (
                      <ArrowDown className="w-3.5 h-3.5 text-emerald-600" />
                    ) : (
                      <ArrowUpDown className="w-3.5 h-3.5 text-slate-400" />
                    )}
                  </button>
                </div>
              </div>

              {/* 活動リスト行 */}
              <div className="divide-y divide-slate-100">
                {filteredEvents.map((ev) => {
                  const catName =
                    eventCategories.find((c) => c.id === ev.category_id)?.category_name ||
                    '未分類';
                  const isSelected = selectedIds.has(ev.id);

                  return (
                    <div
                      key={ev.id}
                      role={isReadOnly ? undefined : 'button'}
                      tabIndex={isReadOnly ? undefined : 0}
                      onClick={() => !isReadOnly && handleOpenEditEvent(ev)}
                      onKeyDown={(e) => {
                        if (!isReadOnly && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          handleOpenEditEvent(ev);
                        }
                      }}
                      className={cn(
                        'grid grid-cols-12 items-center gap-2 px-3 sm:px-4 py-2.5 text-xs sm:text-sm transition-colors',
                        !isReadOnly && 'cursor-pointer hover:bg-emerald-50/40',
                        isSelected ? 'bg-sky-50/70 hover:bg-sky-50/90' : 'bg-white'
                      )}
                    >
                      <div className="col-span-7 sm:col-span-6 flex items-center gap-2.5 min-w-0">
                        {!isReadOnly && (
                          <div
                            onClick={(e) => e.stopPropagation()}
                            className="flex items-center justify-center shrink-0 p-1 -m-1"
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => handleToggleSelectOne(ev.id)}
                              aria-label={`${ev.event_name}を選択`}
                              className="w-4 h-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500 cursor-pointer"
                            />
                          </div>
                        )}

                        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 shrink-0 whitespace-nowrap">
                          {catName}
                        </span>

                        <div className="min-w-0">
                          <div className="font-bold text-slate-800 truncate">{ev.event_name}</div>
                          {ev.memo && (
                            <div className="sm:hidden text-[11px] text-slate-400 truncate">
                              {ev.memo}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="hidden sm:block sm:col-span-4 text-xs text-slate-500 truncate">
                        {ev.memo || '—'}
                      </div>

                      <div className="col-span-5 sm:col-span-2 text-right tabular-nums">
                        <span className="text-sm sm:text-base font-black text-emerald-700">
                          {ev.default_duration}
                        </span>
                        <span className="text-[11px] text-slate-400 font-bold ml-0.5">分</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* 右カラム (PC専用): カテゴリ一覧サイドメニュー */}
        <aside className="hidden lg:block lg:col-span-3 sticky top-16">
          <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-2xs space-y-3">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
              <div className="flex items-center gap-1.5 text-xs font-extrabold text-slate-800">
                <Tag className="w-4 h-4 text-sky-500" />
                <span>カテゴリ</span>
              </div>
              <span className="text-[11px] font-bold text-slate-400 tabular-nums">
                {activeCategories.length}区分
              </span>
            </div>

            <nav className="space-y-1" aria-label="カテゴリ絞り込み">
              <button
                type="button"
                onClick={() => handleSelectCategory('all')}
                className={cn(
                  'w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer',
                  selectedCategoryId === 'all'
                    ? 'bg-slate-900 text-white shadow-2xs'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={cn(
                      'w-2 h-2 rounded-full shrink-0',
                      selectedCategoryId === 'all' ? 'bg-white' : 'bg-slate-400'
                    )}
                  />
                  <span className="truncate">すべて</span>
                </div>
                <span
                  className={cn(
                    'text-[11px] px-1.5 py-0.5 rounded-md font-extrabold tabular-nums',
                    selectedCategoryId === 'all'
                      ? 'bg-slate-700 text-white'
                      : 'bg-slate-100 text-slate-500'
                  )}
                >
                  {totalCount}
                </span>
              </button>

              {activeCategories.map((cat) => {
                const count =
                  sectionTab === 'food'
                    ? foods.filter((f) => f.category_id === cat.id).length
                    : eventItems.filter((e) => e.category_id === cat.id).length;
                const isActive = selectedCategoryId === cat.id;

                return (
                  <button
                    type="button"
                    key={cat.id}
                    onClick={() => handleSelectCategory(cat.id)}
                    className={cn(
                      'w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer',
                      isActive
                        ? 'bg-slate-900 text-white shadow-2xs'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={cn(
                          'w-2 h-2 rounded-full shrink-0',
                          isActive ? 'bg-white' : getCategoryDotColor(cat.category_name)
                        )}
                      />
                      <span className="truncate">{cat.category_name}</span>
                    </div>
                    <span
                      className={cn(
                        'text-[11px] px-1.5 py-0.5 rounded-md font-extrabold tabular-nums',
                        isActive
                          ? 'bg-slate-700 text-white'
                          : 'bg-slate-100 text-slate-500'
                      )}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </nav>

            <div className="pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setIsCategoryModalOpen(true)}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-xs font-bold text-slate-700 transition-colors cursor-pointer"
              >
                <Tag className="w-3.5 h-3.5 text-sky-500" />
                <span>カテゴリを編集</span>
              </button>
            </div>
          </div>
        </aside>
      </div>

      {/* 食品登録・編集モーダル */}
      <FoodEditModal
        isOpen={isFoodModalOpen}
        onClose={() => setIsFoodModalOpen(false)}
        onSaveSuccess={loadData}
        categories={foodCategories}
        foodToEdit={foodToEdit}
        onRequestDelete={(id) => setDeleteFoodId(id)}
      />

      {/* 活動登録・編集モーダル */}
      <EventEditModal
        isOpen={isEventModalOpen}
        onClose={() => setIsEventModalOpen(false)}
        onSaved={loadData}
        categories={eventCategories}
        editItem={eventToEdit}
        onRequestDelete={(id) => setDeleteEventId(id)}
      />

      {/* カテゴリ管理モーダル */}
      <CategoryManageModal
        isOpen={isCategoryModalOpen}
        onClose={() => setIsCategoryModalOpen(false)}
        onChanged={loadData}
        targetType={sectionTab}
        categories={activeCategories}
      />

      {/* 単体食品削除確認ダイアログ */}
      <ConfirmDialog
        isOpen={!!deleteFoodId}
        title="食品の削除確認"
        message="この食品を削除しますか？"
        cancelLabel="キャンセル"
        confirmLabel="削除する"
        variant="danger"
        onCancel={() => setDeleteFoodId(null)}
        onConfirm={executeDeleteFood}
      />

      {/* 単体活動削除確認ダイアログ */}
      <ConfirmDialog
        isOpen={!!deleteEventId}
        title="活動の削除確認"
        message="この活動を削除しますか？"
        cancelLabel="キャンセル"
        confirmLabel="削除する"
        variant="danger"
        onCancel={() => setDeleteEventId(null)}
        onConfirm={executeDeleteEvent}
      />

      {/* 複数選択一括削除確認ダイアログ */}
      <ConfirmDialog
        isOpen={isBulkDeleteConfirmOpen}
        title="一括削除の確認"
        message={`選択中の${sectionTab === 'food' ? '食品' : '活動'}（${selectedIds.size}件）をまとめて削除しますか？`}
        cancelLabel="キャンセル"
        confirmLabel={`${selectedIds.size}件を削除する`}
        variant="danger"
        onCancel={() => setIsBulkDeleteConfirmOpen(false)}
        onConfirm={executeBulkDelete}
      />
    </div>
  );
};
