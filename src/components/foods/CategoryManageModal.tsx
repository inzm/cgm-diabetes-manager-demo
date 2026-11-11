import React, { useState, useEffect } from 'react';
import { Category } from '@/types/database';
import { db } from '@/lib/db';
import { invalidateAnalysisDatasetCache } from '@/lib/realGlucoseLoader';
import { invalidateFoodMasterMemoryCache } from '@/components/foods/FoodMasterView';
import { deterministicUuid, ensureUuid } from '@/lib/uuidUtils';
import { usePatient } from '@/contexts/PatientContext';
import { X, Tag, Plus, Edit3, Trash2, Check } from 'lucide-react';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { cn } from '@/lib/utils';

/**
 * カテゴリ新規追加（論理削除済み同名カテゴリが存在する場合は新規UUIDを採番せず復活更新）
 * PostgreSQL UNIQUE (user_id, target_type, category_name) 制約との衝突を防止する
 */
export async function addOrReviveCategory(params: {
  userId: string;
  targetType: 'food' | 'event';
  categoryName: string;
  displayOrder: number;
}): Promise<Category> {
  const { userId, targetType, categoryName, displayOrder } = params;
  const trimmed = categoryName.trim();
  const now = new Date().toISOString();

  const matchingRecords = await db.categories
    .where('[user_id+target_type]')
    .equals([userId, targetType])
    .filter((c) => c.category_name === trimmed)
    .toArray();

  const activeExisting = matchingRecords.find((c) => !c.is_deleted);
  if (activeExisting) {
    throw new Error('同じ名前のカテゴリがすでに存在します。');
  }

  const deletedMatches = matchingRecords.filter((c) => c.is_deleted);
  if (deletedMatches.length > 0) {
    const deletedExisting = deletedMatches[0];
    const normalizedId = ensureUuid(
      deletedExisting.id,
      `${userId}_cat_${targetType}_${trimmed}`
    );
    const revived: Category = {
      ...deletedExisting,
      id: normalizedId,
      is_deleted: false,
      display_order: displayOrder,
      updated_at: now,
    };
    await db.categories.put(revived);
    for (const extra of deletedMatches) {
      if (extra.id !== normalizedId) {
        await db.categories.delete(extra.id);
      }
    }
    return revived;
  }

  const created: Category = {
    id: crypto.randomUUID(),
    user_id: userId,
    target_type: targetType,
    category_name: trimmed,
    display_order: displayOrder,
    is_protected: false,
    is_deleted: false,
    created_at: now,
    updated_at: now,
  };
  await db.categories.add(created);
  return created;
}

interface CategoryManageModalProps {
  isOpen: boolean;
  onClose: () => void;
  onChanged: () => void;
  targetType: 'food' | 'event';
  categories: Category[];
}

export const CategoryManageModal: React.FC<CategoryManageModalProps> = ({
  isOpen,
  onClose,
  onChanged,
  targetType,
  categories,
}) => {
  const { currentPatientId, isReadOnly } = usePatient();
  const [newCategoryName, setNewCategoryName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [deleteTargetCategory, setDeleteTargetCategory] = useState<Category | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [shouldRender, setShouldRender] = useState<boolean>(isOpen);
  const [isVisible, setIsVisible] = useState<boolean>(false);

  useEffect(() => {
    setNewCategoryName('');
    setEditingId(null);
    setEditingName('');
    setErrorMsg(null);
    setDeleteTargetCategory(null);
    setShowDiscardConfirm(false);
  }, [isOpen, targetType]);

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      const rafId = window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setIsVisible(true);
        });
      });
      return () => window.cancelAnimationFrame(rafId);
    } else {
      setIsVisible(false);
      const timerId = window.setTimeout(() => {
        setShouldRender(false);
      }, 220);
      return () => window.clearTimeout(timerId);
    }
  }, [isOpen]);

  if (!shouldRender) return null;

  const isDirty = newCategoryName.trim() !== '' || editingId !== null;

  const handleRequestClose = () => {
    if (isDirty) {
      setShowDiscardConfirm(true);
      return;
    }
    onClose();
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  };

  const titleLabel = targetType === 'food' ? '食品カテゴリ管理' : '活動カテゴリ管理';

  const handleAddCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly) return;
    setErrorMsg(null);

    const trimmed = newCategoryName.trim();
    if (!trimmed) {
      setErrorMsg('カテゴリ名を入力してください。');
      return;
    }
    if (categories.some((c) => c.category_name === trimmed && !c.is_deleted)) {
      setErrorMsg('同じ名前のカテゴリがすでに存在します。');
      return;
    }

    const maxOrder = categories.reduce((max, c) => Math.max(max, c.display_order), 0);

    try {
      await addOrReviveCategory({
        userId: currentPatientId,
        targetType,
        categoryName: trimmed,
        displayOrder: maxOrder + 1,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'カテゴリの追加に失敗しました。');
      return;
    }

    setNewCategoryName('');
    invalidateFoodMasterMemoryCache(currentPatientId);
    invalidateAnalysisDatasetCache();
    onChanged();
  };

  const handleStartEdit = (cat: Category) => {
    setEditingId(cat.id);
    setEditingName(cat.category_name);
    setErrorMsg(null);
  };

  const handleSaveEdit = async (catId: string) => {
    if (isReadOnly) return;
    setErrorMsg(null);
    const trimmed = editingName.trim();
    if (!trimmed) {
      setErrorMsg('カテゴリ名を入力してください。');
      return;
    }
    if (categories.some((c) => c.id !== catId && c.category_name === trimmed && !c.is_deleted)) {
      setErrorMsg('同じ名前のカテゴリがすでに存在します。');
      return;
    }

    const nowIso = new Date().toISOString();
    await db.transaction('rw', [db.categories], async () => {
      const sameNameDeleted = await db.categories
        .where('[user_id+target_type]')
        .equals([currentPatientId, targetType])
        .filter((c) => c.id !== catId && c.category_name === trimmed && c.is_deleted)
        .primaryKeys();
      if (sameNameDeleted.length > 0) {
        await db.categories.bulkDelete(sameNameDeleted);
      }
      await db.categories.update(catId, {
        category_name: trimmed,
        updated_at: nowIso,
      });
    });
    setEditingId(null);
    setEditingName('');
    invalidateFoodMasterMemoryCache(currentPatientId);
    invalidateAnalysisDatasetCache();
    onChanged();
  };

  const handleRequestDeleteCategory = (cat: Category) => {
    if (isReadOnly) return;
    if (cat.is_protected || cat.category_name === '未分類') {
      setErrorMsg('「未分類」カテゴリは受け皿として保護されているため削除できません。');
      return;
    }
    setDeleteTargetCategory(cat);
  };

  const handleConfirmDeleteCategory = async () => {
    if (isReadOnly || !deleteTargetCategory) return;
    const targetId = deleteTargetCategory.id;
    setDeleteTargetCategory(null);

    const now = new Date().toISOString();
    const fallbackCatId =
      categories.find((c) => c.category_name === '未分類' || c.is_protected)?.id ||
      deterministicUuid(`${currentPatientId}_cat_${targetType}_uncategorized`);

    await db.transaction('rw', [db.categories, db.food_master, db.event_master], async () => {
      const existingFallback = await db.categories.get(fallbackCatId);
      if (!existingFallback) {
        await db.categories.put({
          id: fallbackCatId,
          user_id: currentPatientId,
          target_type: targetType,
          category_name: '未分類',
          display_order: 99,
          is_protected: true,
          is_deleted: false,
          created_at: now,
          updated_at: now,
        });
      } else if (existingFallback.is_deleted) {
        await db.categories.update(fallbackCatId, { is_deleted: false, updated_at: now });
      }

      if (targetType === 'food') {
        const affectedFoods = await db.food_master
          .where('user_id')
          .equals(currentPatientId)
          .filter((f) => f.category_id === targetId)
          .toArray();
        for (const f of affectedFoods) {
          await db.food_master.update(f.id, { category_id: fallbackCatId, updated_at: now });
        }
      } else {
        const affectedEvents = await db.event_master
          .where('user_id')
          .equals(currentPatientId)
          .filter((ev) => ev.category_id === targetId)
          .toArray();
        for (const ev of affectedEvents) {
          await db.event_master.update(ev.id, { category_id: fallbackCatId, updated_at: now });
        }
      }

      await db.categories.update(targetId, {
        is_deleted: true,
        updated_at: now,
      });
    });

    invalidateFoodMasterMemoryCache(currentPatientId);
    invalidateAnalysisDatasetCache();
    onChanged();
  };

  return (
    <div
      onClick={handleBackdropClick}
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs transition-opacity duration-200 ease-out',
        isVisible ? 'opacity-100' : 'opacity-0'
      )}
    >
      <div
        className={cn(
          'relative w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden transition-all duration-220 ease-[cubic-bezier(0.16,1,0.3,1)]',
          isVisible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-3'
        )}
      >
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-slate-50">
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-lg bg-sky-100 text-sky-700">
              <Tag className="w-4 h-4" />
            </span>
            <h3 className="text-sm sm:text-base font-bold text-slate-800">{titleLabel}</h3>
          </div>
          <button
            type="button"
            onClick={handleRequestClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200/60 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {errorMsg && (
            <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700 font-medium">
              {errorMsg}
            </div>
          )}

          {/* 新規カテゴリ追加フォーム */}
          {!isReadOnly && (
            <form onSubmit={handleAddCategory} className="flex items-center gap-2">
              <input
                type="text"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                placeholder="新しいカテゴリ名を入力..."
                className="flex-1 px-3 py-2 rounded-xl border border-slate-300 text-xs sm:text-sm focus:outline-hidden focus:ring-2 focus:ring-sky-500"
              />
              <button
                type="submit"
                className="inline-flex items-center gap-1 px-3.5 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold cursor-pointer shrink-0 active:scale-95"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>追加</span>
              </button>
            </form>
          )}

          {/* カテゴリ一覧 */}
          <div className="max-h-80 overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-xl">
            {categories.map((cat) => (
              <div key={cat.id} className="flex items-center justify-between px-3.5 py-2.5 bg-white">
                {editingId === cat.id ? (
                  <div className="flex items-center gap-2 flex-1 mr-2">
                    <input
                      type="text"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      className="flex-1 px-2.5 py-1 rounded-lg border border-sky-400 text-xs font-semibold focus:outline-hidden"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => handleSaveEdit(cat.id)}
                      className="p-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 cursor-pointer"
                      title="保存"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="p-1.5 rounded-lg bg-slate-100 text-slate-500 hover:bg-slate-200 cursor-pointer"
                      title="キャンセル"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="text-xs sm:text-sm font-semibold text-slate-800">
                        {cat.category_name}
                      </span>
                      {cat.is_protected && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-medium">
                          保護（受け皿）
                        </span>
                      )}
                    </div>

                    {!isReadOnly && (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleStartEdit(cat)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-sky-600 hover:bg-sky-50 cursor-pointer transition-colors"
                          title="名称を編集"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        {!cat.is_protected && (
                          <button
                            type="button"
                            onClick={() => handleRequestDeleteCategory(cat)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 cursor-pointer transition-colors"
                            title="削除"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>

          <div className="flex justify-end pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={handleRequestClose}
              className="px-4 py-1.5 rounded-xl bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 cursor-pointer"
            >
              閉じる
            </button>
          </div>
        </div>
      </div>

      {/* 未保存変更の破棄確認ダイアログ */}
      <ConfirmDialog
        isOpen={showDiscardConfirm}
        title="入力データの破棄確認"
        message="入力中の内容が保存されていません。破棄して閉じてもよろしいですか？"
        confirmLabel="破棄して閉じる"
        cancelLabel="編集を続ける"
        variant="danger"
        onConfirm={() => {
          setShowDiscardConfirm(false);
          onClose();
        }}
        onCancel={() => setShowDiscardConfirm(false)}
      />

      {/* カテゴリ削除確認ダイアログ */}
      <ConfirmDialog
        isOpen={Boolean(deleteTargetCategory)}
        title="カテゴリの削除確認"
        message={
          deleteTargetCategory
            ? `カテゴリ「${deleteTargetCategory.category_name}」を削除しますか？\n（このカテゴリに所属している項目は削除されず、自動的に「未分類」へ移動します）`
            : ''
        }
        confirmLabel="削除する"
        cancelLabel="キャンセル"
        variant="danger"
        onConfirm={handleConfirmDeleteCategory}
        onCancel={() => setDeleteTargetCategory(null)}
      />
    </div>
  );
};
