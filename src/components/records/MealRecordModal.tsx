import React, { useState, useEffect, useMemo } from 'react';
import { usePatient } from '@/contexts/PatientContext';
import { db } from '@/lib/db';
import {
  FoodMaster,
  Category,
  UserSettings,
  resolveDefaultInsulinInput,
} from '@/types/database';
import { seedFoodMasterIfEmpty } from '@/lib/foodSeed';
import {
  invalidateAnalysisDatasetCache,
  invalidateInMemoryRecentCache,
  isPortfolioMode,
  pauseBackgroundHydration,
  waitForRecentPersistence,
} from '@/lib/realGlucoseLoader';
import { bindMealGlucoseFromReadings } from '@/lib/anomalyExtractor';
import { estimateCarbsWithGemini } from '@/lib/gemini';
import {
  buildWallClockIso,
  extractDateStr,
  extractTimeStr,
  getCurrentLocalTimeStr,
  getTodayLocalDateStr,
} from '@/lib/dateUtils';
import {
  X,
  Utensils,
  Plus,
  Trash2,
  Sparkles,
  Syringe,
  AlertCircle,
  Save,
  Loader2,
  Lock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

interface MealRecordModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  initialDate?: string; // YYYY-MM-DD
  editEventId?: string | null;
}

interface LocalMealItem {
  tempId: string;
  foodName: string;
  amount: number;
  unit: string;
  carbs: number;
  baseCarbsPerUnit: number;
  baseAmount: number;
}

function serializeMealState(
  date: string,
  time: string,
  timingCategory: string,
  insulinUnits: string,
  memo: string,
  items: LocalMealItem[]
): string {
  return JSON.stringify({
    date,
    time,
    timingCategory,
    insulinUnits: insulinUnits.trim(),
    memo: memo.trim(),
    items: items.map((i) => ({
      foodName: i.foodName,
      amount: i.amount,
      unit: i.unit,
      carbs: i.carbs,
    })),
  });
}

/**
 * 時刻文字列 ("HH:mm") から初期の食事区分（朝食・昼食・夕食・間食）を自動判定する
 */
function inferTimingCategoryFromTime(timeStr: string): string {
  const [hStr, mStr] = timeStr.split(':');
  const totalMinutes = (parseInt(hStr || '12', 10) || 0) * 60 + (parseInt(mStr || '0', 10) || 0);
  if (totalMinutes >= 4 * 60 && totalMinutes < 10 * 60 + 30) return '朝食';
  if (totalMinutes >= 10 * 60 + 30 && totalMinutes < 15 * 60 + 30) return '昼食';
  if (totalMinutes >= 17 * 60 && totalMinutes < 22 * 60) return '夕食';
  return '間食';
}

export const MealRecordModal: React.FC<MealRecordModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  initialDate,
  editEventId,
}) => {
  const { currentPatientId, isReadOnly } = usePatient();

  // 1. 基本情報 (タイムゾーン安全なローカル日付・時刻・区分・インスリン量)
  const [date, setDate] = useState<string>(() => initialDate || getTodayLocalDateStr());
  const [time, setTime] = useState<string>(() => getCurrentLocalTimeStr());
  const [timingCategory, setTimingCategory] = useState<string>(() =>
    inferTimingCategoryFromTime(getCurrentLocalTimeStr())
  );
  const timingCategoryRef = React.useRef<string>(timingCategory);
  const [insulinUnits, setInsulinUnits] = useState<string>('');
  const [isInsulinManuallyEdited, setIsInsulinManuallyEdited] = useState<boolean>(false);
  const [userSettings, setUserSettings] = useState<UserSettings | null>(null);
  const [memo, setMemo] = useState<string>('');

  // 2. 食品追加フォーム状態 ('master': 登録済みから選ぶ / 'manual': 直接入力する)
  const [inputMode, setInputMode] = useState<'master' | 'manual'>('master');
  const [selectedFoodCategoryId, setSelectedFoodCategoryId] = useState<string>('ALL');
  const [selectedMasterId, setSelectedMasterId] = useState<string>('');
  const [newFoodName, setNewFoodName] = useState<string>('');
  const [newAmount, setNewAmount] = useState<string>('1');
  const [newUnit, setNewUnit] = useState<string>('人前');
  const [newCarbs, setNewCarbs] = useState<string>('');

  // 3. 食べた食品リスト & 初期状態スナップショット（未保存変更判定用）
  const [mealItems, setMealItems] = useState<LocalMealItem[]>([]);
  const [initialSnapshot, setInitialSnapshot] = useState<string>('');

  // 食品カテゴリ & 登録済み食品一覧
  const [foodCategories, setFoodCategories] = useState<Category[]>([]);
  const [foodMasters, setFoodMasters] = useState<FoodMaster[]>([]);

  const [isEstimating, setIsEstimating] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState<boolean>(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<boolean>(false);
  const [showEmptyInsulinConfirm, setShowEmptyInsulinConfirm] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 1. 食品カテゴリ & 登録済み食品のロード
  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    async function loadMasters() {
      pauseBackgroundHydration(currentPatientId, 3000);
      await waitForRecentPersistence(currentPatientId);
      await seedFoodMasterIfEmpty(currentPatientId);
      const [cats, masters] = await Promise.all([
        db.categories
          .where('user_id')
          .equals(currentPatientId)
          .filter((c) => !c.is_deleted && (!c.target_type || c.target_type === 'food'))
          .toArray(),
        db.food_master
          .where('user_id')
          .equals(currentPatientId)
          .filter((f) => !f.is_deleted)
          .toArray(),
      ]);
      if (!active) return;
      cats.sort((a, b) => (a.display_order ?? 99) - (b.display_order ?? 99));
      masters.sort((a, b) => a.food_name.localeCompare(b.food_name, 'ja'));
      setFoodCategories(cats);
      setFoodMasters(masters);
    }
    loadMasters();
    return () => {
      active = false;
    };
  }, [isOpen, currentPatientId]);

  // 2. 編集モード / 新規作成モードの初期データセット (設定画面のデフォルトインスリン連動含む)
  useEffect(() => {
    if (!isOpen) return;
    let active = true;

    if (editEventId) {
      setInputMode('master');
      setSelectedFoodCategoryId('ALL');
      setSelectedMasterId('');
      setNewFoodName('');
      setNewAmount('1');
      setNewUnit('人前');
      setNewCarbs('');
      setShowDiscardConfirm(false);
      setShowDeleteConfirm(false);
      setShowEmptyInsulinConfirm(false);
      setErrorMsg(null);

      const targetId = editEventId;
      async function loadEditData() {
        try {
          const [event, settings] = await Promise.all([
            db.events.get(targetId),
            db.user_settings.get(currentPatientId),
          ]);
          if (!active) return;
          setUserSettings(settings || null);

          if (event && !event.is_deleted) {
            const loadedDate = extractDateStr(event.event_datetime);
            const loadedTime = extractTimeStr(event.event_datetime);
            const loadedCat =
              event.timing_category === '夜食' ? '間食' : event.timing_category || '昼食';
            const loadedInsulin =
              event.insulin_units != null ? String(event.insulin_units) : '';
            const loadedMemo = event.memo || '';

            setDate(loadedDate);
            setTime(loadedTime);
            setTimingCategory(loadedCat);
            setInsulinUnits(loadedInsulin);
            setIsInsulinManuallyEdited(true);
            setMemo(loadedMemo);

            const details = await db.meal_details
              .where('event_id')
              .equals(targetId)
              .filter((d) => !d.is_deleted)
              .toArray();
            if (!active) return;

            const loadedItems: LocalMealItem[] = details.map((d) => ({
              tempId: d.id,
              foodName: d.food_name,
              amount: d.amount,
              unit: d.unit,
              carbs: d.carbs,
              baseAmount: d.amount > 0 ? d.amount : 1,
              baseCarbsPerUnit: d.carbs,
            }));
            setMealItems(loadedItems);
            setInitialSnapshot(
              serializeMealState(
                loadedDate,
                loadedTime,
                loadedCat,
                loadedInsulin,
                loadedMemo,
                loadedItems
              )
            );
          }
        } catch (err) {
          console.error('[MealRecordModal] Failed to load edit event:', err);
        }
      }
      loadEditData();
    } else {
      const nowDate = initialDate || getTodayLocalDateStr();
      const nowTime = getCurrentLocalTimeStr();
      const initialCat = inferTimingCategoryFromTime(nowTime);
      setDate(nowDate);
      setTime(nowTime);
      setTimingCategory(initialCat);
      timingCategoryRef.current = initialCat;
      setUserSettings(null);
      setInsulinUnits('');
      setIsInsulinManuallyEdited(false);
      setMemo('');
      setMealItems([]);
      setInitialSnapshot(serializeMealState(nowDate, nowTime, initialCat, '', '', []));
      setInputMode('master');
      setSelectedFoodCategoryId('ALL');
      setSelectedMasterId('');
      setNewFoodName('');
      setNewAmount('1');
      setNewUnit('人前');
      setNewCarbs('');
      setShowDiscardConfirm(false);
      setShowDeleteConfirm(false);
      setShowEmptyInsulinConfirm(false);
      setErrorMsg(null);

      async function loadDefaultInsulinSettings() {
        try {
          await waitForRecentPersistence(currentPatientId);
          const settings = await db.user_settings.get(currentPatientId);
          if (!active) return;
          setUserSettings(settings || null);
          const currentCat = timingCategoryRef.current;
          const defInsulin = resolveDefaultInsulinInput(settings, currentCat);
          setInsulinUnits(defInsulin);
          setInitialSnapshot(
            serializeMealState(nowDate, nowTime, currentCat, defInsulin, '', [])
          );
        } catch (err) {
          console.warn('[MealRecordModal] Failed to load user settings:', err);
        }
      }
      loadDefaultInsulinSettings();
    }

    return () => {
      active = false;
    };
  }, [isOpen, editEventId, initialDate, currentPatientId]);

  // 食事区分切替ハンドラー (手動編集前であれば設定画面の区分別デフォルトインスリン値を反映)
  const handleSelectTimingCategory = async (cat: string) => {
    setTimingCategory(cat);
    timingCategoryRef.current = cat;
    if (!editEventId && !isInsulinManuallyEdited) {
      const settings = userSettings ?? (await db.user_settings.get(currentPatientId));
      if (settings && !userSettings) {
        setUserSettings(settings);
      }
      if (timingCategoryRef.current === cat) {
        setInsulinUnits(resolveDefaultInsulinInput(settings, cat));
      }
    }
  };

  // カテゴリでフィルタされた食品一覧
  const filteredFoodMasters = useMemo(() => {
    if (selectedFoodCategoryId === 'ALL') return foodMasters;
    return foodMasters.filter((m) => m.category_id === selectedFoodCategoryId);
  }, [foodMasters, selectedFoodCategoryId]);

  // カテゴリ別グループ化（optgroup表示用）
  const groupedFoodMasters = useMemo(() => {
    const groups: { categoryId: string; categoryName: string; items: FoodMaster[] }[] = [];
    const knownCatIds = new Set<string>();

    for (const cat of foodCategories) {
      knownCatIds.add(cat.id);
      const items = foodMasters.filter((m) => m.category_id === cat.id);
      if (items.length > 0) {
        groups.push({ categoryId: cat.id, categoryName: cat.category_name, items });
      }
    }

    const uncategorized = foodMasters.filter(
      (m) => !m.category_id || !knownCatIds.has(m.category_id)
    );
    if (uncategorized.length > 0) {
      groups.push({
        categoryId: 'UNCATEGORIZED',
        categoryName: 'その他・未分類',
        items: uncategorized,
      });
    }

    return groups;
  }, [foodCategories, foodMasters]);

  // 選択中の食品オブジェクト
  const selectedMaster = useMemo(
    () => foodMasters.find((f) => f.id === selectedMasterId) || null,
    [foodMasters, selectedMasterId]
  );

  // 合計糖質量（リアルタイム合算）
  const totalCarbs = useMemo(() => {
    const sum = mealItems.reduce((acc, item) => acc + item.carbs, 0);
    return Math.round(sum * 10) / 10;
  }, [mealItems]);

  // 食品カテゴリ変更ハンドラー
  const handleCategoryChange = (categoryId: string) => {
    setSelectedFoodCategoryId(categoryId);
    if (categoryId !== 'ALL' && selectedMasterId) {
      const currentMaster = foodMasters.find((f) => f.id === selectedMasterId);
      if (currentMaster && currentMaster.category_id !== categoryId) {
        setSelectedMasterId('');
        setNewFoodName('');
        setNewCarbs('');
      }
    }
  };

  // 登録済み食品選択ハンドラー
  const handleSelectMaster = (masterId: string) => {
    setSelectedMasterId(masterId);
    if (!masterId) {
      setNewFoodName('');
      setNewCarbs('');
      return;
    }
    const master = foodMasters.find((f) => f.id === masterId);
    if (master) {
      setNewFoodName(master.food_name);
      setNewAmount(String(master.base_amount));
      setNewUnit(master.unit);
      setNewCarbs(String(master.carbs_per_unit));
      setErrorMsg(null);
    }
  };

  // 新規フォームの数量変更時の糖質比例計算
  const handleAmountChange = (amtStr: string) => {
    setNewAmount(amtStr);
    const amt = parseFloat(amtStr);
    if (!isNaN(amt) && amt >= 0 && selectedMaster && selectedMaster.base_amount > 0) {
      const calculatedCarbs = (amt / selectedMaster.base_amount) * selectedMaster.carbs_per_unit;
      setNewCarbs(String(Math.round(calculatedCarbs * 10) / 10));
    }
  };

  // リスト追加済みアイテムの数量インライン変更 (比例再計算)
  const handleUpdateItemAmount = (tempId: string, newAmtStr: string) => {
    const amt = parseFloat(newAmtStr);
    if (isNaN(amt) || amt < 0) return;
    setMealItems((prev) =>
      prev.map((item) => {
        if (item.tempId !== tempId) return item;
        const baseAmt = item.baseAmount > 0 ? item.baseAmount : 1;
        const recalculated = Math.round(((amt / baseAmt) * item.baseCarbsPerUnit) * 10) / 10;
        return {
          ...item,
          amount: amt,
          carbs: recalculated,
        };
      })
    );
  };

  // 直接入力モードでの糖質自動推定
  const handleEstimateCarbs = async () => {
    if (!newFoodName.trim()) {
      setErrorMsg('食品名を入力してください');
      return;
    }
    setErrorMsg(null);
    setIsEstimating(true);
    try {
      const amt = parseFloat(newAmount) || 1;
      const res = await estimateCarbsWithGemini(newFoodName.trim(), amt, newUnit.trim() || '人前');
      setNewCarbs(String(Math.round(res.carbs_g * 10) / 10));
    } catch (err: any) {
      setErrorMsg(err.message || '糖質の自動計算に失敗しました');
    } finally {
      setIsEstimating(false);
    }
  };

  // 食品を明細リストに追加
  const handleAddMealItem = () => {
    if (inputMode === 'master') {
      if (!selectedMaster) {
        setErrorMsg('追加する食品を選択してください');
        return;
      }
      const amount = parseFloat(newAmount) || selectedMaster.base_amount || 1;
      const baseAmt = selectedMaster.base_amount > 0 ? selectedMaster.base_amount : 1;
      const carbs =
        Math.round(((amount / baseAmt) * selectedMaster.carbs_per_unit) * 10) / 10;

      setMealItems((prev) => [
        ...prev,
        {
          tempId: crypto.randomUUID(),
          foodName: selectedMaster.food_name,
          amount,
          unit: selectedMaster.unit,
          carbs,
          baseAmount: baseAmt,
          baseCarbsPerUnit: selectedMaster.carbs_per_unit,
        },
      ]);

      setSelectedMasterId('');
      setNewFoodName('');
      setNewAmount('1');
      setNewCarbs('');
      setErrorMsg(null);
      return;
    }

    // 直接入力モード
    if (!newFoodName.trim()) {
      setErrorMsg('追加する食品名を入力してください');
      return;
    }
    const carbs = Math.round((parseFloat(newCarbs) || 0) * 10) / 10;
    const amount = parseFloat(newAmount) || 1;

    setMealItems((prev) => [
      ...prev,
      {
        tempId: crypto.randomUUID(),
        foodName: newFoodName.trim(),
        amount,
        unit: newUnit.trim() || '人前',
        carbs,
        baseAmount: amount > 0 ? amount : 1,
        baseCarbsPerUnit: carbs,
      },
    ]);

    setNewFoodName('');
    setNewAmount('1');
    setNewUnit('人前');
    setNewCarbs('');
    setSelectedMasterId('');
    setErrorMsg(null);
  };

  // 食品明細の削除
  const handleRemoveMealItem = (tempId: string) => {
    setMealItems((prev) => prev.filter((item) => item.tempId !== tempId));
  };

  // 未保存変更の有無 (isDirty) を判定して閉じる
  const handleRequestClose = () => {
    const hasPendingFoodInput =
      selectedMasterId !== '' || newFoodName.trim() !== '' || newCarbs.trim() !== '';

    if (editEventId) {
      const currentSnapshot = serializeMealState(
        date,
        time,
        timingCategory,
        insulinUnits,
        memo,
        mealItems
      );
      if ((initialSnapshot && currentSnapshot !== initialSnapshot) || hasPendingFoodInput) {
        setShowDiscardConfirm(true);
        return;
      }
      onClose();
      return;
    }

    if (
      mealItems.length > 0 ||
      memo.trim() !== '' ||
      isInsulinManuallyEdited ||
      hasPendingFoodInput
    ) {
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

  // 保存ボタン押下時のハンドラー (インスリン未入力時はカスタム確認ダイアログを表示)
  const handleRequestSave = () => {
    if (isReadOnly) return;
    if (mealItems.length === 0) {
      setErrorMsg('食べた食品を1品以上リストに追加してください');
      return;
    }
    if (insulinUnits.trim() === '') {
      setShowEmptyInsulinConfirm(true);
      return;
    }
    void executeSave();
  };

  // 保存処理 (既存の血糖測定データがある場合は食前/食後血糖値も即時紐づけ)
  const executeSave = async () => {
    if (isReadOnly || mealItems.length === 0) return;

    setShowEmptyInsulinConfirm(false);
    setIsSaving(true);
    setErrorMsg(null);

    try {
      pauseBackgroundHydration(currentPatientId, 3000);
      await waitForRecentPersistence(currentPatientId);
      const eventDateTimeIso = buildWallClockIso(date, time);
      const insulin = parseFloat(insulinUnits) || 0;
      const nowIso = new Date().toISOString();
      const autoMemo =
        memo.trim() || mealItems.map((item) => item.foodName).join('、') || undefined;

      const targetMealId = editEventId || crypto.randomUUID();
      if (editEventId) {
        await db.transaction('rw', [db.events, db.meal_details], async () => {
          await db.events.update(editEventId, {
            event_datetime: eventDateTimeIso,
            timing_category: timingCategory,
            total_carbs: totalCarbs,
            insulin_units: insulin,
            memo: autoMemo,
            updated_at: nowIso,
          });

          const existingDetails = await db.meal_details
            .where('event_id')
            .equals(editEventId)
            .toArray();
          for (const d of existingDetails) {
            await db.meal_details.update(d.id, { is_deleted: true, updated_at: nowIso });
          }

          for (const item of mealItems) {
            await db.meal_details.add({
              id: crypto.randomUUID(),
              user_id: currentPatientId,
              event_id: editEventId,
              food_name: item.foodName,
              amount: item.amount,
              unit: item.unit,
              carbs: item.carbs,
              is_deleted: false,
              created_at: nowIso,
              updated_at: nowIso,
            });
          }
        });
      } else {
        const newEventId = targetMealId;
        await db.transaction('rw', [db.events, db.meal_details], async () => {
          await db.events.add({
            id: newEventId,
            user_id: currentPatientId,
            event_datetime: eventDateTimeIso,
            event_type: '食事',
            timing_category: timingCategory,
            total_carbs: totalCarbs,
            insulin_units: insulin,
            memo: autoMemo,
            is_deleted: false,
            created_at: nowIso,
            updated_at: nowIso,
          });

          for (const item of mealItems) {
            await db.meal_details.add({
              id: crypto.randomUUID(),
              user_id: currentPatientId,
              event_id: newEventId,
              food_name: item.foodName,
              amount: item.amount,
              unit: item.unit,
              carbs: item.carbs,
              is_deleted: false,
              created_at: nowIso,
              updated_at: nowIso,
            });
          }
        });
      }

      // 既に取り込み済みの血糖データがある日の場合は、食前・食後ピーク血糖値を自動反映
      await bindMealGlucoseFromReadings(currentPatientId, targetMealId);
      invalidateInMemoryRecentCache(currentPatientId);

      onSuccess();
      onClose();
    } catch (err: any) {
      console.error('[MealRecordModal] Failed to save meal event:', err);
      setErrorMsg(err.message || '保存に失敗しました');
    } finally {
      setIsSaving(false);
    }
  };

  // 論理削除処理
  const executeDelete = async () => {
    if (isReadOnly || !editEventId) return;
    setShowDeleteConfirm(false);

    setIsDeleting(true);
    try {
      pauseBackgroundHydration(currentPatientId, 3000);
      await waitForRecentPersistence(currentPatientId);
      const nowIso = new Date().toISOString();
      await db.transaction('rw', [db.events, db.meal_details], async () => {
        await db.events.update(editEventId, { is_deleted: true, updated_at: nowIso });
        const details = await db.meal_details.where('event_id').equals(editEventId).toArray();
        for (const d of details) {
          await db.meal_details.update(d.id, { is_deleted: true, updated_at: nowIso });
        }
      });
      invalidateInMemoryRecentCache(currentPatientId);
      invalidateAnalysisDatasetCache();
      onSuccess();
      onClose();
    } catch (err: any) {
      console.error('[MealRecordModal] Failed to delete event:', err);
      setErrorMsg('削除に失敗しました');
    } finally {
      setIsDeleting(false);
    }
  };

  const [shouldRender, setShouldRender] = useState<boolean>(isOpen);
  const [isVisible, setIsVisible] = useState<boolean>(false);

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

  const isSaveDisabled = isSaving || isReadOnly || mealItems.length === 0;

  return (
    <div
      onClick={handleBackdropClick}
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/50 backdrop-blur-xs transition-opacity duration-200 ease-out',
        isVisible ? 'opacity-100' : 'opacity-0'
      )}
    >
      <div
        className={cn(
          'bg-white rounded-2xl max-w-xl w-full max-h-[92vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden transition-all duration-220 ease-[cubic-bezier(0.16,1,0.3,1)]',
          isVisible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-3'
        )}
      >
        {/* ヘッダー */}
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 rounded-xl bg-amber-50 text-amber-600">
              <Utensils className="w-4 h-4" />
            </div>
            <h3 className="text-base font-bold text-slate-800">
              {editEventId ? '食事・インスリンを編集' : '食事・インスリンを記録'}
            </h3>
          </div>
          <button
            type="button"
            onClick={handleRequestClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* スクロール可能な本文 (1.基本情報 ➔ 2.食品を追加 ➔ 3.食べた食品リスト ➔ 4.メモ) */}
        <div className="p-4 sm:p-5 overflow-y-auto space-y-4 flex-1">
          {errorMsg && (
            <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center space-x-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* 1. 基本情報: 記録日時・インスリン投与量・食事区分 */}
          <div className="bg-slate-50/80 p-3.5 rounded-xl border border-slate-200/80 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-end">
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">
                  記録日付 &amp; 時刻
                </label>
                <div className="flex items-center space-x-2">
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="min-h-[38px] px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                  <input
                    type="time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    className="min-h-[38px] px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1 flex items-center space-x-1">
                  <Syringe className="w-3.5 h-3.5 text-sky-500 shrink-0" />
                  <span>インスリン投与量</span>
                </label>
                <div className="flex items-center space-x-1.5">
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    placeholder="0"
                    value={insulinUnits}
                    onChange={(e) => {
                      setInsulinUnits(e.target.value);
                      setIsInsulinManuallyEdited(true);
                    }}
                    className="w-24 min-h-[38px] px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-mono font-bold text-sky-700 placeholder:text-slate-400 placeholder:font-normal focus:outline-none focus:ring-2 focus:ring-sky-500"
                  />
                  <span className="text-xs text-slate-500 font-semibold">単位 (U)</span>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-600 mb-1">食事区分</label>
              <div className="grid grid-cols-4 gap-2">
                {['朝食', '昼食', '夕食', '間食'].map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => handleSelectTimingCategory(cat)}
                    className={cn(
                      'min-h-[38px] py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer',
                      timingCategory === cat
                        ? 'bg-amber-600 text-white shadow-2xs'
                        : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
                    )}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 2. 食品を追加エリア (食べた食品リストの上に配置) */}
          {!isReadOnly && (
            <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-bold text-slate-700 flex items-center space-x-1.5">
                  <Plus className="w-3.5 h-3.5 text-amber-600" />
                  <span>食品を追加</span>
                </div>

                {/* 登録済みから選ぶ / 直接入力する モード切替 */}
                <div className="inline-flex rounded-lg bg-slate-200/80 p-0.5 text-[11px] font-semibold">
                  <button
                    type="button"
                    onClick={() => {
                      setInputMode('master');
                      setErrorMsg(null);
                    }}
                    className={cn(
                      'px-2.5 py-1 rounded-md transition-all cursor-pointer',
                      inputMode === 'master'
                        ? 'bg-white text-slate-800 shadow-2xs font-bold'
                        : 'text-slate-600 hover:text-slate-800'
                    )}
                  >
                    登録済みから選ぶ
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedMasterId) {
                        setNewFoodName('');
                        setNewAmount('1');
                        setNewUnit('人前');
                        setNewCarbs('');
                      }
                      setInputMode('manual');
                      setSelectedMasterId('');
                      setErrorMsg(null);
                    }}
                    className={cn(
                      'px-2.5 py-1 rounded-md transition-all cursor-pointer',
                      inputMode === 'manual'
                        ? 'bg-white text-slate-800 shadow-2xs font-bold'
                        : 'text-slate-600 hover:text-slate-800'
                    )}
                  >
                    直接入力する
                  </button>
                </div>
              </div>

              {inputMode === 'master' ? (
                <>
                  {/* 登録済みから選ぶモード: カテゴリ絞り込みセレクト & 食品選択セレクト */}
                  <div className="grid grid-cols-1 sm:grid-cols-[200px_1fr] gap-2.5">
                    <select
                      aria-label="カテゴリで絞り込む"
                      value={selectedFoodCategoryId}
                      onChange={(e) => handleCategoryChange(e.target.value)}
                      className="w-full min-h-[42px] px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs sm:text-sm font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500 cursor-pointer"
                    >
                      <option value="ALL">すべてのカテゴリ</option>
                      {foodCategories.map((cat) => (
                        <option key={cat.id} value={cat.id}>
                          {cat.category_name}
                        </option>
                      ))}
                    </select>

                    <select
                      aria-label="登録済みの食品から選ぶ"
                      value={selectedMasterId}
                      onChange={(e) => handleSelectMaster(e.target.value)}
                      className="w-full min-h-[42px] px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs sm:text-sm font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500 cursor-pointer"
                    >
                      <option value="">食品を選ぶ...</option>
                      {selectedFoodCategoryId === 'ALL' && groupedFoodMasters.length > 0
                        ? groupedFoodMasters.map((group) => (
                            <optgroup key={group.categoryId} label={group.categoryName}>
                              {group.items.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.food_name} ({m.base_amount}
                                  {m.unit} / 糖質{m.carbs_per_unit}g)
                                </option>
                              ))}
                            </optgroup>
                          ))
                        : filteredFoodMasters.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.food_name} ({m.base_amount}
                              {m.unit} / 糖質{m.carbs_per_unit}g)
                            </option>
                          ))}
                    </select>
                  </div>

                  {/* 選択時の数量・単位ラベル・糖質プレビュー・追加ボタン */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <div className="flex items-center space-x-2">
                      <label className="text-xs font-bold text-slate-600">数量:</label>
                      <input
                        type="number"
                        step="0.1"
                        min="0.1"
                        disabled={!selectedMaster}
                        value={newAmount}
                        onChange={(e) => handleAmountChange(e.target.value)}
                        className="w-20 min-h-[38px] px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-mono font-bold text-slate-800 disabled:bg-slate-100 disabled:text-slate-400"
                      />
                      <span className="text-xs font-semibold text-slate-600 min-w-[2.5rem]">
                        {selectedMaster ? selectedMaster.unit : '単位'}
                      </span>
                      {selectedMaster && (
                        <span className="text-xs font-mono font-bold text-amber-700 bg-amber-50 px-2 py-1 rounded-md border border-amber-200/70">
                          糖質 {(parseFloat(newCarbs) || 0).toFixed(1)} g
                        </span>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={handleAddMealItem}
                      disabled={!selectedMaster}
                      className="min-h-[38px] py-1.5 px-4 bg-amber-600 hover:bg-amber-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-white font-bold rounded-lg text-xs transition-all shadow-2xs cursor-pointer active:scale-95"
                    >
                      ＋ リストに追加
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {/* 直接入力モード */}
                  <div className="flex items-center space-x-2">
                    <input
                      type="text"
                      placeholder="食品名を入力 (例: カレーライス、餃子、お好み焼き)"
                      value={newFoodName}
                      onChange={(e) => setNewFoodName(e.target.value)}
                      className="flex-1 min-h-[40px] px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs sm:text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500"
                    />
                    {!isPortfolioMode() && (
                      <button
                        type="button"
                        onClick={handleEstimateCarbs}
                        disabled={isEstimating || !newFoodName.trim()}
                        className="inline-flex items-center space-x-1 min-h-[40px] px-3 py-2 rounded-lg bg-indigo-50 border border-indigo-200 text-indigo-700 hover:bg-indigo-100 text-xs font-semibold transition-all disabled:opacity-50 cursor-pointer shrink-0"
                        title="食品名から糖質量を自動推定"
                      >
                        {isEstimating ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Sparkles className="w-3.5 h-3.5 text-indigo-500" />
                        )}
                        <span>糖質推定</span>
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-4 gap-2 items-center">
                    <div>
                      <label className="block text-[10px] text-slate-500 mb-0.5">数量</label>
                      <input
                        type="number"
                        step="0.1"
                        min="0.1"
                        value={newAmount}
                        onChange={(e) => setNewAmount(e.target.value)}
                        className="w-full min-h-[38px] px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-mono font-semibold"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-500 mb-0.5">単位</label>
                      <input
                        type="text"
                        value={newUnit}
                        onChange={(e) => setNewUnit(e.target.value)}
                        placeholder="人前/個/g"
                        className="w-full min-h-[38px] px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-500 mb-0.5">糖質(g)</label>
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        value={newCarbs}
                        onChange={(e) => setNewCarbs(e.target.value)}
                        placeholder="0.0"
                        className="w-full min-h-[38px] px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-mono font-bold text-amber-700"
                      />
                    </div>
                    <div className="pt-3.5">
                      <button
                        type="button"
                        onClick={handleAddMealItem}
                        disabled={!newFoodName.trim()}
                        className="w-full min-h-[38px] py-1.5 px-3 bg-amber-600 hover:bg-amber-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-white font-bold rounded-lg text-xs transition-all shadow-2xs cursor-pointer active:scale-95"
                      >
                        ＋ 追加
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* 3. 食べた食品リスト (食品を追加エリアの直下に配置) & 合計糖質 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-bold text-slate-700">
                食べた食品リスト ({mealItems.length}品)
              </label>
              <div className="text-xs font-extrabold text-amber-700 bg-amber-50 px-2.5 py-1 rounded-lg border border-amber-200/60">
                合計糖質: <span className="text-sm font-mono">{totalCarbs}</span> g
              </div>
            </div>

            {mealItems.length === 0 ? (
              <div className="p-3.5 rounded-xl border border-dashed border-slate-200 text-center text-xs text-slate-400">
                上の「食品を追加」から食べた食品を1品以上追加してください
              </div>
            ) : (
              <div className="border border-slate-200 rounded-xl overflow-hidden divide-y divide-slate-100 bg-white">
                {mealItems.map((item, idx) => (
                  <div
                    key={item.tempId}
                    className="p-2.5 flex items-center justify-between gap-2 text-xs hover:bg-slate-50/60 transition-colors"
                  >
                    <div className="flex items-center space-x-2 min-w-0 flex-1">
                      <span className="w-5 text-center font-bold text-slate-400 shrink-0">
                        {idx + 1}
                      </span>
                      <span className="font-bold text-slate-800 truncate">{item.foodName}</span>
                    </div>

                    <div className="flex items-center space-x-2 shrink-0">
                      <input
                        type="number"
                        step="0.1"
                        min="0.1"
                        disabled={isReadOnly}
                        value={item.amount}
                        onChange={(e) => handleUpdateItemAmount(item.tempId, e.target.value)}
                        className="w-16 px-2 py-1 bg-slate-50 border border-slate-300 rounded text-xs font-mono font-bold text-right text-slate-800"
                        title="数量を変更すると糖質量が自動再計算されます"
                      />
                      <span className="text-slate-500 text-[11px] min-w-[2.5rem]">{item.unit}</span>
                      <span className="font-mono font-bold text-amber-600 min-w-[3.5rem] text-right">
                        {item.carbs.toFixed(1)}g
                      </span>
                      {!isReadOnly && (
                        <button
                          type="button"
                          onClick={() => handleRemoveMealItem(item.tempId)}
                          className="p-1 rounded text-slate-400 hover:text-rose-600 transition-colors cursor-pointer"
                          title="削除"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 4. メモ (任意) */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              メモ (任意)
            </label>
            <input
              type="text"
              placeholder="例: 外食定食、野菜から摂取"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
          </div>
        </div>

        {/* フッター (食べた食品リストが0品の場合は保存ボタンを無効化) */}
        <div className="px-5 py-3.5 border-t border-slate-200 bg-slate-50/50 flex items-center justify-between">
          <div>
            {editEventId && !isReadOnly && (
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                disabled={isDeleting}
                className="inline-flex items-center space-x-1 px-3 py-1.5 rounded-lg text-xs font-bold text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer"
              >
                {isDeleting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
                <span>削除</span>
              </button>
            )}
          </div>

          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={handleRequestClose}
              className="px-3.5 py-1.5 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
            >
              キャンセル
            </button>

            <button
              type="button"
              onClick={handleRequestSave}
              disabled={isSaveDisabled}
              title={
                mealItems.length === 0
                  ? '食べた食品を1品以上リストに追加してください'
                  : undefined
              }
              className={cn(
                'inline-flex items-center space-x-1.5 px-4 py-1.5 rounded-xl text-xs font-bold transition-all shadow-2xs',
                isSaveDisabled
                  ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  : 'bg-amber-600 hover:bg-amber-700 text-white cursor-pointer active:scale-95'
              )}
            >
              {isSaving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : isReadOnly ? (
                <Lock className="w-3.5 h-3.5" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              <span>{editEventId ? '変更を保存' : '記録を保存'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* インスリン未入力保存確認ダイアログ */}
      <ConfirmDialog
        isOpen={showEmptyInsulinConfirm}
        title="インスリン投与量の未入力確認"
        message="インスリン投与量が未入力です。0単位として保存しますか？"
        cancelLabel="戻って入力する"
        confirmLabel="0単位として保存"
        variant="warning"
        onCancel={() => setShowEmptyInsulinConfirm(false)}
        onConfirm={executeSave}
      />

      {/* 入力データ破棄確認ダイアログ */}
      <ConfirmDialog
        isOpen={showDiscardConfirm}
        title="入力データの破棄確認"
        message="入力データが破棄されます。よろしいですか？"
        cancelLabel="入力を続ける"
        confirmLabel="破棄して閉じる"
        variant="warning"
        onCancel={() => setShowDiscardConfirm(false)}
        onConfirm={() => {
          setShowDiscardConfirm(false);
          onClose();
        }}
      />

      {/* 食事記録削除確認ダイアログ */}
      <ConfirmDialog
        isOpen={showDeleteConfirm}
        title="食事記録の削除確認"
        message="この食事記録を削除してもよろしいですか？"
        cancelLabel="キャンセル"
        confirmLabel="削除する"
        variant="danger"
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={executeDelete}
      />
    </div>
  );
};
