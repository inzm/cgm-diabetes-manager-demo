import React, { useState, useEffect } from 'react';
import { usePatient } from '@/contexts/PatientContext';
import { db } from '@/lib/db';
import { FoodMaster, Category } from '@/types/database';
import { estimateCarbsWithGemini } from '@/lib/gemini';
import { invalidateAnalysisDatasetCache, isPortfolioMode } from '@/lib/realGlucoseLoader';
import { triggerBackgroundCloudSync } from '@/lib/syncEngine';
import { useAnimatedModal } from '@/lib/useAnimatedModal';
import { X, Sparkles, Loader2, Check, AlertCircle, Trash2 } from 'lucide-react';
import { cn, getErrorMessage } from '@/lib/utils';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { invalidateFoodMasterMemoryCache } from './FoodMasterView';

interface FoodEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  foodToEdit?: FoodMaster | null;
  categories: Category[];
  onSaveSuccess: () => void;
  onRequestDelete?: (id: string) => void;
}

export const FoodEditModal: React.FC<FoodEditModalProps> = ({
  isOpen,
  onClose,
  foodToEdit,
  categories,
  onSaveSuccess,
  onRequestDelete,
}) => {
  const { currentPatientId, isReadOnly } = usePatient();

  const [foodName, setFoodName] = useState('');
  const [baseAmount, setBaseAmount] = useState('1');
  const [unit, setUnit] = useState('人前');
  const [carbs, setCarbs] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [isEstimating, setIsEstimating] = useState(false);
  const [estimateNote, setEstimateNote] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  // モーダルオープン時または編集対象切替時に初期値をセット（編集中にcategories参照が更新されても入力値を消去しない）
  useEffect(() => {
    if (!isOpen) return;
    setShowDiscardConfirm(false);
    if (foodToEdit) {
      setFoodName(foodToEdit.food_name);
      setBaseAmount(String(foodToEdit.base_amount));
      setUnit(foodToEdit.unit);
      setCarbs(String(foodToEdit.carbs_per_unit));
      setCategoryId(foodToEdit.category_id || (categories.length > 0 ? categories[0].id : ''));
      setEstimateNote(null);
      setErrorMsg(null);
    } else {
      setFoodName('');
      setBaseAmount('1');
      setUnit('人前');
      setCarbs('');
      setCategoryId(categories.length > 0 ? categories[0].id : '');
      setEstimateNote(null);
      setErrorMsg(null);
    }
  }, [foodToEdit, isOpen]);

  // 新規作成時にカテゴリ一覧が非同期ロード完了した場合、未選択なら先頭カテゴリを補完
  useEffect(() => {
    if (isOpen && !foodToEdit && !categoryId && categories.length > 0) {
      setCategoryId(categories[0].id);
    }
  }, [isOpen, foodToEdit, categoryId, categories]);

  const { shouldRender, isVisible, blurActiveElementOnBackdropClick } = useAnimatedModal(
    isOpen,
    220
  );

  if (!shouldRender) return null;

  const defaultCatId = categories.length > 0 ? categories[0].id : '';
  const isDirty = foodToEdit
    ? foodName.trim() !== foodToEdit.food_name.trim() ||
      baseAmount.trim() !== String(foodToEdit.base_amount) ||
      unit.trim() !== foodToEdit.unit.trim() ||
      carbs.trim() !== String(foodToEdit.carbs_per_unit) ||
      categoryId !== (foodToEdit.category_id || defaultCatId)
    : foodName.trim() !== '' ||
      baseAmount.trim() !== '1' ||
      unit.trim() !== '人前' ||
      carbs.trim() !== '' ||
      (categoryId !== '' && categoryId !== defaultCatId);

  const handleRequestClose = () => {
    if (isDirty) {
      setShowDiscardConfirm(true);
      return;
    }
    onClose();
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      blurActiveElementOnBackdropClick();
    }
  };

  // 糖質量を自動推定するハンドラ
  const handleEstimateCarbs = async () => {
    if (isReadOnly) return;
    if (!foodName.trim()) {
      setErrorMsg('糖質を推定するには食品名を入力してください。');
      return;
    }

    setErrorMsg(null);
    setIsEstimating(true);
    setEstimateNote(null);

    try {
      const result = await estimateCarbsWithGemini(
        foodName.trim(),
        baseAmount || 1,
        unit || '人前'
      );
      setCarbs(String(result.carbs_g));
      setEstimateNote(result.note);
    } catch (err: unknown) {
      setErrorMsg(`糖質推定エラー: ${getErrorMessage(err)}`);
    } finally {
      setIsEstimating(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly) return;

    if (!foodName.trim()) {
      setErrorMsg('食品名を入力してください。');
      return;
    }
    const carbsNum = parseFloat(carbs);
    if (isNaN(carbsNum) || carbsNum < 0) {
      setErrorMsg('有効な糖質量 (g) を入力してください。');
      return;
    }
    const amountNum = parseFloat(baseAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setErrorMsg('有効な分量を入力してください。');
      return;
    }

    const now = new Date().toISOString();

    const record: FoodMaster = {
      id: foodToEdit ? foodToEdit.id : crypto.randomUUID(),
      user_id: currentPatientId,
      category_id: categoryId || undefined,
      food_name: foodName.trim(),
      base_amount: amountNum,
      unit: unit.trim(),
      carbs_per_unit: Math.round(carbsNum * 10) / 10,
      is_deleted: false,
      updated_at: now,
      created_at: foodToEdit ? foodToEdit.created_at : now,
    };

    try {
      await db.food_master.put(record);
      invalidateFoodMasterMemoryCache(currentPatientId);
      invalidateAnalysisDatasetCache(currentPatientId);
      triggerBackgroundCloudSync(currentPatientId);
      onSaveSuccess();
      onClose();
    } catch (err: unknown) {
      setErrorMsg(`保存エラー: ${getErrorMessage(err)}`);
    }
  };

  const unitPresets = ['g', '個', '杯', '枚', '切れ', '皿', '本', '缶', 'パック', '人前', 'ml'];

  return (
    <div
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto"
    >
      {/* 背景オーバーレイ（タップ時はモーダルを閉じず、フォーカス中のキーボードのみ閉じる） */}
      <div
        onClick={handleBackdropClick}
        className={cn(
          'fixed inset-0 bg-slate-900/45 backdrop-blur-xs transition-opacity duration-200 ease-out',
          isVisible ? 'opacity-100' : 'opacity-0'
        )}
      />

      {/* モーダルウィンドウ */}
      <div
        className={cn(
          'relative w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden z-10 transition-all duration-220 ease-[cubic-bezier(0.16,1,0.3,1)]',
          isVisible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-3'
        )}
      >
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h3 className="text-base font-bold text-slate-800">
            {foodToEdit ? '食品を編集' : '食品を登録'}
          </h3>
          <button
            type="button"
            onClick={handleRequestClose}
            className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* フォーム */}
        <form onSubmit={handleSave} className="p-6 space-y-4">
          {errorMsg && (
            <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-500" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* 食品名 */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              食品・料理名 <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              disabled={isReadOnly}
              value={foodName}
              onChange={(e) => setFoodName(e.target.value)}
              placeholder="例: 白米、食パン、りんご、カレーライス"
              className="w-full px-3.5 py-2 rounded-xl border border-slate-200 text-sm focus:outline-hidden focus:ring-2 focus:ring-sky-500 focus:border-transparent transition-all disabled:opacity-50"
            />
          </div>

          {/* 分量 & 単位 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                基準分量 <span className="text-rose-500">*</span>
              </label>
              <input
                type="number"
                step="any"
                required
                disabled={isReadOnly}
                value={baseAmount}
                onChange={(e) => setBaseAmount(e.target.value)}
                placeholder="1"
                className="w-full px-3.5 py-2 rounded-xl border border-slate-200 text-sm focus:outline-hidden focus:ring-2 focus:ring-sky-500 focus:border-transparent transition-all disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                単位 <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                disabled={isReadOnly}
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                list="unit-presets"
                placeholder="杯, g, 個"
                className="w-full px-3.5 py-2 rounded-xl border border-slate-200 text-sm focus:outline-hidden focus:ring-2 focus:ring-sky-500 focus:border-transparent transition-all disabled:opacity-50"
              />
              <datalist id="unit-presets">
                {unitPresets.map((u) => (
                  <option key={u} value={u} />
                ))}
              </datalist>
            </div>
          </div>

          {/* カテゴリ選択 */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              カテゴリ分類
            </label>
            <select
              disabled={isReadOnly}
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="w-full px-3.5 py-2 rounded-xl border border-slate-200 text-sm focus:outline-hidden focus:ring-2 focus:ring-sky-500 focus:border-transparent transition-all bg-white disabled:opacity-50"
            >
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.category_name}
                </option>
              ))}
            </select>
          </div>

          {/* 糖質量 (自動推定ボタン付き) */}
          <div className="pt-1">
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-bold text-slate-700">
                糖質量 (g) <span className="text-rose-500">*</span>
              </label>

              {/* 糖質を自動推定ボタン (デモアプリでは非表示) */}
              {!isPortfolioMode() && (
                <button
                  type="button"
                  onClick={handleEstimateCarbs}
                  disabled={isReadOnly || isEstimating || !foodName.trim()}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold bg-linear-to-r from-amber-500 to-sky-500 text-white hover:opacity-90 disabled:opacity-50 transition-all cursor-pointer shadow-xs"
                >
                  {isEstimating ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>計算中...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>糖質を自動推定</span>
                    </>
                  )}
                </button>
              )}
            </div>

            <div className="relative">
              <input
                type="number"
                step="0.1"
                required
                disabled={isReadOnly}
                value={carbs}
                onChange={(e) => setCarbs(e.target.value)}
                placeholder="例: 36.8"
                className="w-full px-3.5 py-2 rounded-xl border border-slate-200 text-sm font-bold text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-sky-500 focus:border-transparent transition-all pr-10 disabled:opacity-50"
              />
              <span className="absolute right-3.5 top-2.5 text-xs text-slate-400 font-bold">
                g
              </span>
            </div>

            {estimateNote && (
              <p className="mt-1.5 text-[11px] text-emerald-600 flex items-center gap-1">
                <Check className="w-3.5 h-3.5 shrink-0" />
                <span>{estimateNote} (手動で修正可能)</span>
              </p>
            )}
          </div>

          {/* アクションボタン */}
          <div className="flex items-center justify-between gap-2 pt-3 border-t border-slate-100">
            {foodToEdit && onRequestDelete && !isReadOnly ? (
              <button
                type="button"
                onClick={() => {
                  const targetId = foodToEdit.id;
                  onClose();
                  onRequestDelete(targetId);
                }}
                className="inline-flex items-center gap-1 px-3 py-2.5 rounded-xl border border-rose-200 bg-rose-50/70 hover:bg-rose-100 text-xs font-bold text-rose-600 cursor-pointer transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>削除</span>
              </button>
            ) : (
              <div />
            )}

            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={handleRequestClose}
                className="px-4 py-2.5 rounded-xl border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50 cursor-pointer transition-colors"
              >
                キャンセル
              </button>
              <button
                type="submit"
                disabled={isReadOnly}
                className="px-5 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold cursor-pointer transition-colors shadow-xs disabled:opacity-50"
              >
                保存する
              </button>
            </div>
          </div>
        </form>
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
    </div>
  );
};
