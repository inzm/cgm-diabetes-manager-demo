import React, { useState, useEffect, useRef } from 'react';
import { usePatient } from '@/contexts/PatientContext';
import { db, requestPersistentStorage } from '@/lib/db';
import { usePwaInstallPrompt } from '@/lib/pwa';
import { isGeminiBffEnabled } from '@/lib/gemini';
import { reevaluatePatientAnomalyEvents } from '@/lib/anomalyExtractor';
import {
  cancelBackgroundHydration,
  invalidateAnalysisDatasetCache,
  invalidateInMemoryRecentCache,
  isDemoCsvImportDisabled,
  isPortfolioMode,
  markPatientManuallyCleared,
  notifyThresholdsUpdated,
  resetDemoDataToInitialState,
  waitForRecentPersistence,
} from '@/lib/realGlucoseLoader';
import { resetFoodSeedSession, seedFoodMasterIfEmpty } from '@/lib/foodSeed';
import { ensureUuid } from '@/lib/uuidUtils';
import { invalidateFoodMasterMemoryCache } from '@/components/foods/FoodMasterView';
import { clearCalendarMonthlyCache } from '@/components/calendar/CalendarView';
import { getTodayLocalDateStr } from '@/lib/dateUtils';
import {
  Activity,
  Users,
  Database,
  Save,
  Eye,
  CheckCircle2,
  AlertCircle,
  Download,
  Upload,
  RotateCcw,
  Loader2,
  Lock,
  Sparkles,
  ShieldCheck,
  Smartphone,
  FlaskConical,
  CloudOff,
  Syringe,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

/**
 * 全4種のオンメモリキャッシュ（食品・活動一覧、カレンダー月次集計、分析データセット、直近メモリスライス）を一括破棄する
 */
export function invalidateAllPatientMemoryCaches(patientId: string): void {
  invalidateFoodMasterMemoryCache(patientId);
  clearCalendarMonthlyCache();
  invalidateAnalysisDatasetCache();
  invalidateInMemoryRecentCache(patientId);
}

/**
 * バックアップJSONペイロードから既存テーブルをクリアして復元し、
 * 旧形式の非UUID文字列があれば正規UUIDへ自動マイグレーションした上で全4種キャッシュを破棄する
 */
export async function restorePatientBackupPayload(
  patientId: string,
  parsed: Record<string, any>
): Promise<void> {
  markPatientManuallyCleared(patientId);
  cancelBackgroundHydration(patientId);
  resetFoodSeedSession(patientId);

  const rawSettings = parsed.userSettings ?? parsed.user_settings;
  const rawReadings = Array.isArray(parsed.libreReadings)
    ? parsed.libreReadings
    : Array.isArray(parsed.libre_readings)
      ? parsed.libre_readings
      : [];
  const rawEvents = Array.isArray(parsed.events) ? parsed.events : [];
  const rawDetails = Array.isArray(parsed.mealDetails)
    ? parsed.mealDetails
    : Array.isArray(parsed.meal_details)
      ? parsed.meal_details
      : [];
  const rawCategories = Array.isArray(parsed.categories) ? parsed.categories : [];
  const rawFoods = Array.isArray(parsed.foodMaster)
    ? parsed.foodMaster
    : Array.isArray(parsed.food_master)
      ? parsed.food_master
      : [];
  const rawEventMasters = Array.isArray(parsed.eventMaster)
    ? parsed.eventMaster
    : Array.isArray(parsed.event_master)
      ? parsed.event_master
      : [];

  const hasCategories = rawCategories.length > 0;
  const hasFoods = rawFoods.length > 0;
  const hasEventMasters = rawEventMasters.length > 0;

  await db.transaction(
    'rw',
    [
      db.user_settings,
      db.libre_readings,
      db.events,
      db.meal_details,
      db.food_master,
      db.event_master,
      db.categories,
    ],
    async () => {
      await db.user_settings.delete(patientId);
      await db.libre_readings.where('user_id').equals(patientId).delete();
      await db.events.where('user_id').equals(patientId).delete();
      await db.meal_details.where('user_id').equals(patientId).delete();
      await db.food_master.where('user_id').equals(patientId).delete();
      await db.event_master.where('user_id').equals(patientId).delete();
      await db.categories.where('user_id').equals(patientId).delete();

      if (rawSettings) {
        await db.user_settings.put({
          ...rawSettings,
          user_id: patientId,
        });
      }
      if (rawReadings.length > 0) {
        await db.libre_readings.bulkPut(
          rawReadings.map((r: any) => ({
            ...r,
            id: ensureUuid(r.id, `${patientId}_${r.timestamp}`),
            user_id: patientId,
          }))
        );
      }

      const eventIdMap = new Map<string, string>();
      if (rawEvents.length > 0) {
        await db.events.bulkPut(
          rawEvents.map((ev: any) => {
            const normalizedEventId = ensureUuid(
              ev.id,
              `${patientId}_${ev.event_type}_${ev.event_datetime}`
            );
            if (ev.id != null && String(ev.id).trim() !== '') {
              eventIdMap.set(String(ev.id).trim(), normalizedEventId);
            }
            return {
              ...ev,
              id: normalizedEventId,
              user_id: patientId,
            };
          })
        );
      }

      if (rawDetails.length > 0) {
        const validDetails = rawDetails.filter(
          (d: any) => d && d.event_id != null && String(d.event_id).trim() !== ''
        );
        if (validDetails.length > 0) {
          await db.meal_details.bulkPut(
            validDetails.map((d: any) => {
              const rawEventIdStr = String(d.event_id).trim();
              const normalizedEventId =
                eventIdMap.get(rawEventIdStr) ?? ensureUuid(rawEventIdStr);
              return {
                ...d,
                id: ensureUuid(d.id, `${normalizedEventId}_${d.food_name}`),
                event_id: normalizedEventId,
                user_id: patientId,
              };
            })
          );
        }
      }

      const categoryIdMap = new Map<string, string>();
      if (hasCategories) {
        const dedupedByKey = new Map<string, { raw: any; allOriginalIds: string[] }>();
        for (const c of rawCategories) {
          if (!c || !c.category_name) continue;
          const targetType = c.target_type === 'event' ? 'event' : 'food';
          const trimmedName = String(c.category_name).trim();
          const key = `${targetType}::${trimmedName}`;
          const origId = c.id != null ? String(c.id).trim() : '';
          const existing = dedupedByKey.get(key);
          if (!existing) {
            dedupedByKey.set(key, {
              raw: { ...c, target_type: targetType, category_name: trimmedName },
              allOriginalIds: origId ? [origId] : [],
            });
          } else {
            if (origId) {
              existing.allOriginalIds.push(origId);
            }
            if (existing.raw.is_deleted && !c.is_deleted) {
              existing.raw = { ...c, target_type: targetType, category_name: trimmedName };
            }
          }
        }

        const normalizedCategories = Array.from(dedupedByKey.values()).map(
          ({ raw, allOriginalIds }) => {
            const canonicalId = ensureUuid(
              raw.id,
              `${patientId}_cat_${raw.target_type}_${raw.category_name}`
            );
            for (const origId of allOriginalIds) {
              categoryIdMap.set(origId, canonicalId);
            }
            return {
              ...raw,
              id: canonicalId,
              user_id: patientId,
            };
          }
        );

        if (normalizedCategories.length > 0) {
          await db.categories.bulkPut(normalizedCategories);
        }
      }

      if (hasFoods) {
        await db.food_master.bulkPut(
          rawFoods.map((f: any) => {
            const rawCatId = f.category_id != null ? String(f.category_id).trim() : '';
            return {
              ...f,
              id: ensureUuid(f.id, `${patientId}_food_${f.food_name}`),
              category_id: rawCatId
                ? (categoryIdMap.get(rawCatId) ?? ensureUuid(rawCatId))
                : f.category_id,
              user_id: patientId,
            };
          })
        );
      }

      if (hasEventMasters) {
        await db.event_master.bulkPut(
          rawEventMasters.map((em: any) => {
            const rawCatId = em.category_id != null ? String(em.category_id).trim() : '';
            return {
              ...em,
              id: ensureUuid(em.id, `${patientId}_event_${em.event_name}`),
              category_id: rawCatId
                ? (categoryIdMap.get(rawCatId) ?? ensureUuid(rawCatId))
                : em.category_id,
              user_id: patientId,
            };
          })
        );
      }
    }
  );

  if (!hasCategories && !hasFoods && !hasEventMasters) {
    await seedFoodMasterIfEmpty(patientId);
  }

  invalidateAllPatientMemoryCaches(patientId);
}

/**
 * 記録データをすべて消去し、よく使う食品・活動を初期状態へ再シードした上で全4種キャッシュを破棄する
 */
export async function resetPatientDataAndInvalidateCaches(patientId: string): Promise<void> {
  markPatientManuallyCleared(patientId);
  cancelBackgroundHydration(patientId);
  resetFoodSeedSession(patientId);

  await db.transaction(
    'rw',
    [
      db.user_settings,
      db.libre_readings,
      db.events,
      db.meal_details,
      db.food_master,
      db.event_master,
      db.categories,
    ],
    async () => {
      await db.user_settings.clear();
      await db.libre_readings.clear();
      await db.events.clear();
      await db.meal_details.clear();
      await db.food_master.clear();
      await db.event_master.clear();
      await db.categories.clear();
    }
  );

  await seedFoodMasterIfEmpty(patientId);
  invalidateAllPatientMemoryCaches(patientId);
}

interface SettingsViewProps {
  onSettingsChanged?: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ onSettingsChanged }) => {
  const {
    currentPatientId,
    isReadOnly,
    currentRole,
    setRole,
    hypoThreshold: contextHypo,
    hyperThreshold: contextHyper,
    updateClinicalThresholds,
  } = usePatient();
  const { isInstallable, promptInstall } = usePwaInstallPrompt();
  const restoreFileInputRef = useRef<HTMLInputElement>(null);
  const isDemoMode = isDemoCsvImportDisabled();
  const isPortfolio = isPortfolioMode();

  // 1. 血糖値の目標範囲状態
  const [hypoThreshold, setHypoThreshold] = useState<number>(contextHypo || 70);
  const [hyperThreshold, setHyperThreshold] = useState<number>(contextHyper || 180);
  const [isSavingTarget, setIsSavingTarget] = useState<boolean>(false);
  const [targetSuccessMsg, setTargetSuccessMsg] = useState<string | null>(null);
  const [targetErrorMsg, setTargetErrorMsg] = useState<string | null>(null);

  // 1-2. 食事区分別デフォルトインスリン設定状態
  const [enableDefaultInsulin, setEnableDefaultInsulin] = useState<boolean>(false);
  const [defaultInsulinBreakfast, setDefaultInsulinBreakfast] = useState<string>('');
  const [defaultInsulinLunch, setDefaultInsulinLunch] = useState<string>('');
  const [defaultInsulinDinner, setDefaultInsulinDinner] = useState<string>('');
  const [defaultInsulinSnack, setDefaultInsulinSnack] = useState<string>('');
  const [isSavingInsulinDefaults, setIsSavingInsulinDefaults] = useState<boolean>(false);
  const [insulinDefaultSuccessMsg, setInsulinDefaultSuccessMsg] = useState<string | null>(null);
  const [insulinDefaultErrorMsg, setInsulinDefaultErrorMsg] = useState<string | null>(null);

  // 2. 保存データの件数統計状態
  const [readingCount, setReadingCount] = useState<number>(0);
  const [eventCount, setEventCount] = useState<number>(0);
  const [detailCount, setDetailCount] = useState<number>(0);
  const [foodCount, setFoodCount] = useState<number>(0);
  const [eventMasterCount, setEventMasterCount] = useState<number>(0);
  const [categoryCount, setCategoryCount] = useState<number>(0);
  const [isPersisted, setIsPersisted] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [isRestoring, setIsRestoring] = useState<boolean>(false);
  const [pendingRestorePayload, setPendingRestorePayload] = useState<Record<string, any> | null>(
    null
  );
  const [isResettingDb, setIsResettingDb] = useState<boolean>(false);
  const [showResetConfirm, setShowResetConfirm] = useState<boolean>(false);
  const [dataActionMsg, setDataActionMsg] = useState<string | null>(null);
  const [dataErrorMsg, setDataErrorMsg] = useState<string | null>(null);
  const [showDemoResetConfirm, setShowDemoResetConfirm] = useState<boolean>(false);
  const [isResettingDemo, setIsResettingDemo] = useState<boolean>(false);
  const [demoResetMsg, setDemoResetMsg] = useState<string | null>(null);

  const loadSettingsAndStats = async () => {
    try {
      await waitForRecentPersistence(currentPatientId);
      const settings = await db.user_settings.get(currentPatientId);
      if (settings) {
        setHypoThreshold(settings.hypo_threshold || 70);
        setHyperThreshold(settings.hyper_threshold || 180);
        setEnableDefaultInsulin(Boolean(settings.enable_default_insulin));
        setDefaultInsulinBreakfast(
          settings.default_insulin_breakfast != null ? String(settings.default_insulin_breakfast) : ''
        );
        setDefaultInsulinLunch(
          settings.default_insulin_lunch != null ? String(settings.default_insulin_lunch) : ''
        );
        setDefaultInsulinDinner(
          settings.default_insulin_dinner != null ? String(settings.default_insulin_dinner) : ''
        );
        setDefaultInsulinSnack(
          settings.default_insulin_snack != null ? String(settings.default_insulin_snack) : ''
        );
      } else {
        setEnableDefaultInsulin(false);
        setDefaultInsulinBreakfast('');
        setDefaultInsulinLunch('');
        setDefaultInsulinDinner('');
        setDefaultInsulinSnack('');
      }
    } catch (err) {
      console.warn('Failed to load user settings:', err);
    }

    if (isDemoMode) return;

    try {
      const [rCount, eCount, dCount, fCount, emCount, cCount] = await Promise.all([
        db.libre_readings.where('user_id').equals(currentPatientId).count(),
        db.events.where('user_id').equals(currentPatientId).filter((e) => !e.is_deleted).count(),
        db.meal_details.where('user_id').equals(currentPatientId).filter((d) => !d.is_deleted).count(),
        db.food_master.where('user_id').equals(currentPatientId).filter((f) => !f.is_deleted).count(),
        db.event_master.where('user_id').equals(currentPatientId).filter((em) => !em.is_deleted).count(),
        db.categories.where('user_id').equals(currentPatientId).filter((c) => !c.is_deleted).count(),
      ]);
      setReadingCount(rCount);
      setEventCount(eCount);
      setDetailCount(dCount);
      setFoodCount(fCount);
      setEventMasterCount(emCount);
      setCategoryCount(cCount);

      const persisted = await requestPersistentStorage();
      setIsPersisted(persisted);
    } catch (err) {
      console.warn('Failed to load storage stats:', err);
    }
  };

  useEffect(() => {
    loadSettingsAndStats();
  }, [currentPatientId]);

  // 1. 目標範囲の保存 & 既存測定データからの高血糖・低血糖再判定
  const handleSaveTarget = async () => {
    if (isReadOnly) return;
    setTargetErrorMsg(null);
    setTargetSuccessMsg(null);

    if (isNaN(hypoThreshold) || hypoThreshold < 54 || hypoThreshold > 90) {
      setTargetErrorMsg('低血糖の基準値は 54〜90 mg/dL の範囲で入力してください');
      return;
    }
    if (isNaN(hyperThreshold) || hyperThreshold < 130 || hyperThreshold > 250) {
      setTargetErrorMsg('高血糖の基準値は 130〜250 mg/dL の範囲で入力してください');
      return;
    }
    if (hypoThreshold >= hyperThreshold) {
      setTargetErrorMsg('低血糖の基準値は高血糖の基準値より小さく設定してください');
      return;
    }

    setIsSavingTarget(true);
    try {
      await waitForRecentPersistence(currentPatientId);
      const existing = await db.user_settings.get(currentPatientId);
      const nowIso = new Date().toISOString();
      await db.user_settings.put({
        ...existing,
        user_id: currentPatientId,
        hypo_threshold: hypoThreshold,
        hyper_threshold: hyperThreshold,
        target_tir_min: hypoThreshold,
        target_tir_max: hyperThreshold,
        enable_default_insulin: existing?.enable_default_insulin ?? enableDefaultInsulin,
        default_insulin_breakfast:
          existing?.default_insulin_breakfast ??
          parseOptionalInsulin(defaultInsulinBreakfast, '朝食'),
        default_insulin_lunch:
          existing?.default_insulin_lunch ?? parseOptionalInsulin(defaultInsulinLunch, '昼食'),
        default_insulin_dinner:
          existing?.default_insulin_dinner ?? parseOptionalInsulin(defaultInsulinDinner, '夕食'),
        default_insulin_snack:
          existing?.default_insulin_snack ?? parseOptionalInsulin(defaultInsulinSnack, '間食'),
        updated_at: nowIso,
      });

      // 新しい基準値で全測定データから低血糖・高血糖を再抽出・更新
      notifyThresholdsUpdated(currentPatientId, hypoThreshold, hyperThreshold);
      updateClinicalThresholds(hypoThreshold, hyperThreshold);
      onSettingsChanged?.();

      const { hypoCount, hyperCount } = await reevaluatePatientAnomalyEvents(
        currentPatientId,
        hypoThreshold,
        hyperThreshold
      );

      setTargetSuccessMsg(
        `目標範囲を保存し、データを更新しました（低血糖: ${hypoCount}件 / 高血糖: ${hyperCount}件）。`
      );
      setTimeout(() => setTargetSuccessMsg(null), 6000);
      void loadSettingsAndStats();
    } catch (err: any) {
      setTargetErrorMsg(err.message || '保存に失敗しました');
    } finally {
      setIsSavingTarget(false);
    }
  };

  // 1-2. 食事区分別デフォルトインスリン設定の保存・トグル切替
  const parseOptionalInsulin = (raw: string, label: string): number | null => {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const num = parseFloat(trimmed);
    if (Number.isNaN(num) || num < 0 || num > 100) {
      throw new Error(`${label}のインスリン単位数は 0〜100 の範囲（または空欄）で入力してください`);
    }
    return Math.round(num * 10) / 10;
  };

  const persistInsulinDefaults = async (nextEnable: boolean, showFullMsg: boolean) => {
    if (isReadOnly) return;
    setInsulinDefaultErrorMsg(null);
    setInsulinDefaultSuccessMsg(null);
    setIsSavingInsulinDefaults(true);
    try {
      await waitForRecentPersistence(currentPatientId);
      const bVal = parseOptionalInsulin(defaultInsulinBreakfast, '朝食');
      const lVal = parseOptionalInsulin(defaultInsulinLunch, '昼食');
      const dVal = parseOptionalInsulin(defaultInsulinDinner, '夕食');
      const sVal = parseOptionalInsulin(defaultInsulinSnack, '間食');

      const existing = await db.user_settings.get(currentPatientId);
      const nowIso = new Date().toISOString();
      await db.user_settings.put({
        user_id: currentPatientId,
        hypo_threshold: existing?.hypo_threshold ?? hypoThreshold,
        hyper_threshold: existing?.hyper_threshold ?? hyperThreshold,
        target_tir_min: existing?.target_tir_min ?? hypoThreshold,
        target_tir_max: existing?.target_tir_max ?? hyperThreshold,
        enable_default_insulin: nextEnable,
        default_insulin_breakfast: bVal,
        default_insulin_lunch: lVal,
        default_insulin_dinner: dVal,
        default_insulin_snack: sVal,
        updated_at: nowIso,
      });

      setEnableDefaultInsulin(nextEnable);
      onSettingsChanged?.();
      setInsulinDefaultSuccessMsg(
        showFullMsg
          ? '食事区分別のデフォルトインスリン設定を保存しました。'
          : nextEnable
            ? 'デフォルトインスリン自動入力を有効（ON）にしました。'
            : 'デフォルトインスリン自動入力を無効（OFF: 空欄初期値）にしました。'
      );
      setTimeout(() => setInsulinDefaultSuccessMsg(null), 5000);
    } catch (err: any) {
      setInsulinDefaultErrorMsg(err.message || '設定の保存に失敗しました');
    } finally {
      setIsSavingInsulinDefaults(false);
    }
  };

  const handleToggleDefaultInsulin = async () => {
    if (isReadOnly) return;
    const next = !enableDefaultInsulin;
    setEnableDefaultInsulin(next);
    await persistInsulinDefaults(next, false);
  };

  const handleSaveDefaultInsulin = async () => {
    await persistInsulinDefaults(enableDefaultInsulin, true);
  };

  // 2. バックアップ保存 (JSONエクスポート)
  const handleExportData = async () => {
    setIsExporting(true);
    setDataErrorMsg(null);
    setDataActionMsg(null);
    try {
      const [
        userSettings,
        allReadings,
        allEvents,
        allDetails,
        allFoods,
        allEventMasters,
        allCategories,
      ] = await Promise.all([
        db.user_settings.get(currentPatientId),
        db.libre_readings.where('user_id').equals(currentPatientId).toArray(),
        db.events.where('user_id').equals(currentPatientId).toArray(),
        db.meal_details.where('user_id').equals(currentPatientId).toArray(),
        db.food_master.where('user_id').equals(currentPatientId).toArray(),
        db.event_master.where('user_id').equals(currentPatientId).toArray(),
        db.categories.where('user_id').equals(currentPatientId).toArray(),
      ]);

      const backupObj = {
        version: '2.0.0',
        exportedAt: new Date().toISOString(),
        patientId: currentPatientId,
        userSettings: userSettings || {
          user_id: currentPatientId,
          hypo_threshold: hypoThreshold,
          hyper_threshold: hyperThreshold,
          target_tir_min: hypoThreshold,
          target_tir_max: hyperThreshold,
          updated_at: new Date().toISOString(),
        },
        libreReadings: allReadings,
        events: allEvents,
        mealDetails: allDetails,
        foodMaster: allFoods,
        eventMaster: allEventMasters,
        categories: allCategories,
      };

      const jsonText = JSON.stringify(backupObj);
      const blob = new Blob([jsonText], { type: 'application/json;charset=utf-8' });
      const blobUrl = URL.createObjectURL(blob);
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute('href', blobUrl);
      downloadAnchor.setAttribute(
        'download',
        `cgm_full_backup_${getTodayLocalDateStr()}.json`
      );
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

      setDataActionMsg('バックアップファイルを保存しました。');
    } catch (err: any) {
      console.error('Failed to export data:', err);
      setDataErrorMsg(err.message || 'バックアップの保存に失敗しました');
    } finally {
      setIsExporting(false);
    }
  };

  // 3. バックアップファイル選択時の検証 & 確認ダイアログ表示
  const handleRestoreFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || isReadOnly) return;

    setDataErrorMsg(null);
    setDataActionMsg(null);

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      if (!parsed || typeof parsed !== 'object') {
        throw new Error('有効なバックアップファイルではありません。');
      }

      setPendingRestorePayload(parsed);
    } catch (err: any) {
      console.error('Failed to parse JSON backup:', err);
      setDataErrorMsg(
        `読込エラー: ${err.message || 'バックアップファイルの読み込みに失敗しました'}`
      );
    } finally {
      if (restoreFileInputRef.current) {
        restoreFileInputRef.current.value = '';
      }
    }
  };

  const executeRestoreBackup = async () => {
    if (isReadOnly || !pendingRestorePayload) return;
    const parsed = pendingRestorePayload;
    setPendingRestorePayload(null);

    setIsRestoring(true);
    setDataErrorMsg(null);
    setDataActionMsg(null);
    markPatientManuallyCleared(currentPatientId);
    cancelBackgroundHydration(currentPatientId);
    resetFoodSeedSession(currentPatientId);

    try {
      await restorePatientBackupPayload(currentPatientId, parsed);

      const rawSettings = parsed.userSettings ?? parsed.user_settings;
      const restoredHypo = rawSettings?.hypo_threshold ?? 70;
      const restoredHyper = rawSettings?.hyper_threshold ?? 180;
      setHypoThreshold(restoredHypo);
      setHyperThreshold(restoredHyper);
      setEnableDefaultInsulin(Boolean(rawSettings?.enable_default_insulin));
      setDefaultInsulinBreakfast(
        rawSettings?.default_insulin_breakfast != null
          ? String(rawSettings.default_insulin_breakfast)
          : ''
      );
      setDefaultInsulinLunch(
        rawSettings?.default_insulin_lunch != null
          ? String(rawSettings.default_insulin_lunch)
          : ''
      );
      setDefaultInsulinDinner(
        rawSettings?.default_insulin_dinner != null
          ? String(rawSettings.default_insulin_dinner)
          : ''
      );
      setDefaultInsulinSnack(
        rawSettings?.default_insulin_snack != null
          ? String(rawSettings.default_insulin_snack)
          : ''
      );
      notifyThresholdsUpdated(currentPatientId, restoredHypo, restoredHyper);
      updateClinicalThresholds(restoredHypo, restoredHyper);

      await loadSettingsAndStats();
      onSettingsChanged?.();
      setDataActionMsg('バックアップからデータを復元しました。');
    } catch (err: any) {
      console.error('Failed to restore JSON backup:', err);
      setDataErrorMsg(
        `復元エラー: ${err.message || 'バックアップファイルの復元に失敗しました'}`
      );
    } finally {
      setIsRestoring(false);
    }
  };

  // 4. 保存データの初期化 (実データ検証に備え、架空デモデータは生成せず初期プリセットのみシード)
  const handleRequestResetData = () => {
    if (isReadOnly) return;
    setShowResetConfirm(true);
  };

  const handleConfirmResetData = async () => {
    if (isReadOnly) return;
    setShowResetConfirm(false);

    setIsResettingDb(true);
    setDataErrorMsg(null);
    setDataActionMsg(null);

    try {
      await resetPatientDataAndInvalidateCaches(currentPatientId);

      setHypoThreshold(70);
      setHyperThreshold(180);
      setEnableDefaultInsulin(false);
      setDefaultInsulinBreakfast('');
      setDefaultInsulinLunch('');
      setDefaultInsulinDinner('');
      setDefaultInsulinSnack('');
      notifyThresholdsUpdated(currentPatientId, 70, 180);
      updateClinicalThresholds(70, 180);

      await loadSettingsAndStats();
      onSettingsChanged?.();

      setDataActionMsg(
        '血糖・食事・活動の記録データをすべて消去し、よく使う食品・活動を初期状態に戻しました。'
      );
    } catch (err: any) {
      console.error('Failed to reset local data:', err);
      setDataErrorMsg(`初期化エラー: ${err.message || '初期化に失敗しました'}`);
    } finally {
      setIsResettingDb(false);
    }
  };

  // 5. デモ環境の手動リセット (オンメモリ上の追加食品・活動・記録・設定を初期シード状態へ復元)
  const handleConfirmDemoReset = async () => {
    if (isReadOnly) return;
    setShowDemoResetConfirm(false);
    setIsResettingDemo(true);
    setDemoResetMsg(null);
    setTargetErrorMsg(null);
    setTargetSuccessMsg(null);
    setInsulinDefaultErrorMsg(null);
    setInsulinDefaultSuccessMsg(null);

    try {
      await resetDemoDataToInitialState(currentPatientId);
      setHypoThreshold(70);
      setHyperThreshold(180);
      setEnableDefaultInsulin(false);
      setDefaultInsulinBreakfast('');
      setDefaultInsulinLunch('');
      setDefaultInsulinDinner('');
      setDefaultInsulinSnack('');
      updateClinicalThresholds(70, 180);

      invalidateAllPatientMemoryCaches(currentPatientId);
      await loadSettingsAndStats();
      onSettingsChanged?.();

      setDemoResetMsg('デモデータを初期状態に戻しました。');
      setTimeout(() => setDemoResetMsg(null), 6000);
    } catch (err: any) {
      console.error('Failed to reset demo data:', err);
      setTargetErrorMsg(err.message || 'デモデータのリセットに失敗しました');
    } finally {
      setIsResettingDemo(false);
    }
  };

  const bffEnabled = isGeminiBffEnabled();
  const restoreReadingsList = Array.isArray(pendingRestorePayload?.libreReadings)
    ? pendingRestorePayload.libreReadings
    : Array.isArray(pendingRestorePayload?.libre_readings)
      ? pendingRestorePayload.libre_readings
      : [];
  const restoreReadingCount = restoreReadingsList.length;
  const restoreEventCount = Array.isArray(pendingRestorePayload?.events)
    ? pendingRestorePayload.events.length
    : 0;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-3 sm:py-3.5 space-y-3">
      {/* 家族閲覧ロール警告バナー */}
      {isReadOnly && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-center space-x-3 text-xs text-amber-900">
          <Lock className="w-4 h-4 text-amber-600 shrink-0" />
          <div>
            <span className="font-bold">閲覧専用モードで表示中:</span>{' '}
            設定の変更やデータの復元・初期化は患者本人モードのみで行えます。
          </div>
        </div>
      )}

      {/* セクション 1: 血糖値の目標範囲・アラート設定 */}
      <div className="bg-white p-3.5 sm:p-4 rounded-2xl border border-slate-200 shadow-2xs space-y-2.5 sm:space-y-3">
        <div className="flex items-center justify-between border-b border-slate-100 pb-2">
          <h3 className="text-sm font-bold text-slate-800 flex items-center space-x-2">
            <Activity className="w-4 h-4 text-emerald-500" />
            <span>血糖値の目標範囲・アラート設定</span>
          </h3>
        </div>

        {/* 視覚的目標帯バー */}
        <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-200/80 space-y-1">
          <div className="flex items-center justify-between text-xs font-bold">
            <span className="text-blue-600">低血糖 (&lt; {hypoThreshold})</span>
            <span className="text-emerald-700">目標範囲 ({hypoThreshold} 〜 {hyperThreshold})</span>
            <span className="text-rose-600">高血糖 (&gt; {hyperThreshold})</span>
          </div>

          <div className="h-3 w-full bg-slate-200 rounded-full overflow-hidden flex shadow-inner">
            <div
              style={{ width: `${(hypoThreshold / 300) * 100}%` }}
              className="bg-blue-500 h-full transition-all duration-300"
              title={`低血糖: < ${hypoThreshold} mg/dL`}
            />
            <div
              style={{ width: `${((hyperThreshold - hypoThreshold) / 300) * 100}%` }}
              className="bg-emerald-500 h-full transition-all duration-300"
              title={`目標範囲: ${hypoThreshold}〜${hyperThreshold} mg/dL`}
            />
            <div
              style={{ width: `${((300 - hyperThreshold) / 300) * 100}%` }}
              className="bg-rose-500 h-full transition-all duration-300"
              title={`高血糖: > ${hyperThreshold} mg/dL`}
            />
          </div>
          <div className="text-[10px] text-slate-400 text-center leading-none pt-0.5">
            0 mg/dL ────────────── 300 mg/dL スケール
          </div>
        </div>

        {/* 入力フォーム */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              低血糖の基準値 (mg/dL)
            </label>
            <div className="flex items-center space-x-2">
              <input
                type="number"
                min="54"
                max="90"
                step="1"
                disabled={isReadOnly}
                value={hypoThreshold}
                onChange={(e) => setHypoThreshold(parseInt(e.target.value, 10))}
                className="w-full px-3 py-1 bg-slate-50 border border-slate-300 rounded-xl text-sm font-mono font-bold text-blue-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-50"
              />
              <span className="text-xs text-slate-400 font-semibold whitespace-nowrap">
                標準: 70
              </span>
            </div>
            <p className="text-[11px] text-slate-400 mt-0.5">
              設定範囲: 54〜90 mg/dL
            </p>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              高血糖の基準値 (mg/dL)
            </label>
            <div className="flex items-center space-x-2">
              <input
                type="number"
                min="130"
                max="250"
                step="1"
                disabled={isReadOnly}
                value={hyperThreshold}
                onChange={(e) => setHyperThreshold(parseInt(e.target.value, 10))}
                className="w-full px-3 py-1 bg-slate-50 border border-slate-300 rounded-xl text-sm font-mono font-bold text-rose-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-50"
              />
              <span className="text-xs text-slate-400 font-semibold whitespace-nowrap">
                標準: 180
              </span>
            </div>
            <p className="text-[11px] text-slate-400 mt-0.5">
              設定範囲: 130〜250 mg/dL
            </p>
          </div>
        </div>

        {targetSuccessMsg && (
          <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 flex items-center space-x-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{targetSuccessMsg}</span>
          </div>
        )}
        {targetErrorMsg && (
          <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-center space-x-2">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{targetErrorMsg}</span>
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleSaveTarget}
            disabled={isSavingTarget || isReadOnly}
            className={cn(
              'inline-flex items-center space-x-1.5 px-4 py-1.5 rounded-xl text-xs font-bold transition-all shadow-2xs',
              isReadOnly
                ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                : 'bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer active:scale-95'
            )}
          >
            {isSavingTarget ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            <span>設定を保存</span>
          </button>
        </div>
      </div>

      {/* セクション 1-2: 食事記録のデフォルトインスリン設定 */}
      <div className="bg-white p-3.5 sm:p-4 rounded-2xl border border-slate-200 shadow-2xs space-y-2.5 sm:space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-2">
          <div>
            <h3 className="text-sm font-bold text-slate-800 flex items-center space-x-2">
              <Syringe className="w-4 h-4 text-sky-500" />
              <span>食事記録のデフォルトインスリン設定</span>
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              毎食の投与単位数が決まっている場合、食事区分（朝・昼・夕・間食）に応じた初期値を自動入力します
            </p>
          </div>

          {/* デフォルト値を有効にするトグルボタン */}
          <div className="flex items-center space-x-2.5 self-start sm:self-auto">
            <span className="text-xs font-bold text-slate-700">デフォルト値を有効にする</span>
            <button
              type="button"
              role="switch"
              aria-checked={enableDefaultInsulin}
              disabled={isReadOnly || isSavingInsulinDefaults}
              onClick={handleToggleDefaultInsulin}
              className={cn(
                'relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden',
                isReadOnly
                  ? 'opacity-50 cursor-not-allowed'
                  : 'cursor-pointer',
                enableDefaultInsulin ? 'bg-sky-600' : 'bg-slate-300'
              )}
            >
              <span
                className={cn(
                  'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-xs ring-0 transition duration-200 ease-in-out',
                  enableDefaultInsulin ? 'translate-x-5' : 'translate-x-0'
                )}
              />
            </button>
            <span
              className={cn(
                'text-xs font-extrabold px-2 py-0.5 rounded-md',
                enableDefaultInsulin
                  ? 'bg-sky-50 text-sky-700 border border-sky-200'
                  : 'bg-slate-100 text-slate-500'
              )}
            >
              {enableDefaultInsulin ? 'ON' : 'OFF'}
            </span>
          </div>
        </div>

        <div
          className={cn(
            'grid grid-cols-2 sm:grid-cols-4 gap-2.5 transition-opacity',
            !enableDefaultInsulin && 'opacity-60'
          )}
        >
          {[
            { label: '朝食', value: defaultInsulinBreakfast, setter: setDefaultInsulinBreakfast },
            { label: '昼食', value: defaultInsulinLunch, setter: setDefaultInsulinLunch },
            { label: '夕食', value: defaultInsulinDinner, setter: setDefaultInsulinDinner },
            { label: '間食', value: defaultInsulinSnack, setter: setDefaultInsulinSnack },
          ].map((item) => (
            <div
              key={item.label}
              className="bg-slate-50 p-2 rounded-xl border border-slate-200/80 space-y-1"
            >
              <label className="block text-xs font-bold text-slate-700">{item.label}</label>
              <div className="flex items-center space-x-1.5">
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  max="100"
                  placeholder="未設定"
                  disabled={isReadOnly}
                  value={item.value}
                  onChange={(e) => item.setter(e.target.value)}
                  className="w-full min-h-[32px] px-2.5 py-1 bg-white border border-slate-300 rounded-lg text-xs font-mono font-bold text-sky-700 placeholder:text-slate-400 placeholder:font-sans placeholder:font-normal focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:opacity-50"
                />
                <span className="text-xs text-slate-500 font-semibold shrink-0">U</span>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <p className="text-[11px] text-slate-500 leading-relaxed">
            ※OFFの場合（または該当区分が空欄の場合）、食事記録画面のインスリン投与量欄は空欄で起動し、未入力のまま保存ボタンを押した際に確認画面を表示します。
          </p>

          <button
            type="button"
            onClick={handleSaveDefaultInsulin}
            disabled={isSavingInsulinDefaults || isReadOnly}
            className={cn(
              'inline-flex items-center justify-center space-x-1.5 px-4 py-1.5 rounded-xl text-xs font-bold transition-all shadow-2xs shrink-0 self-end sm:self-auto',
              isReadOnly
                ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                : 'bg-sky-600 hover:bg-sky-700 text-white cursor-pointer active:scale-95'
            )}
          >
            {isSavingInsulinDefaults ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            <span>設定を保存</span>
          </button>
        </div>

        {insulinDefaultSuccessMsg && (
          <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 flex items-center space-x-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{insulinDefaultSuccessMsg}</span>
          </div>
        )}
        {insulinDefaultErrorMsg && (
          <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-center space-x-2">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{insulinDefaultErrorMsg}</span>
          </div>
        )}
      </div>

      {/* セクション 2: データのバックアップ・初期化 (デモアプリでは非表示) */}
      {!isDemoMode && (
        <div className="bg-white p-3.5 sm:p-4 rounded-2xl border border-slate-200 shadow-2xs space-y-2.5 sm:space-y-3">
          <div className="flex items-center justify-between border-b border-slate-100 pb-2">
            <h3 className="text-sm font-bold text-slate-800 flex items-center space-x-2">
              <Database className="w-4 h-4 text-indigo-500" />
              <span>データのバックアップ・初期化</span>
            </h3>
          </div>

          {/* データ統計グリッド */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-200/80">
              <div className="text-[11px] font-bold text-slate-500">血糖データ</div>
              <div className="flex items-baseline gap-1 mt-0.5">
                <span className="text-base sm:text-lg font-extrabold text-slate-900 font-mono">
                  {readingCount.toLocaleString()}
                </span>
                <span className="text-[10px] text-slate-400">件</span>
              </div>
            </div>

            <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-200/80">
              <div className="text-[11px] font-bold text-slate-500">食事・活動記録</div>
              <div className="flex items-baseline gap-1 mt-0.5">
                <span className="text-base sm:text-lg font-extrabold text-amber-600 font-mono">
                  {eventCount.toLocaleString()}
                </span>
                <span className="text-[10px] text-slate-400">件</span>
              </div>
            </div>

            <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-200/80">
              <div className="text-[11px] font-bold text-slate-500">食事明細</div>
              <div className="flex items-baseline gap-1 mt-0.5">
                <span className="text-base sm:text-lg font-extrabold text-emerald-600 font-mono">
                  {detailCount.toLocaleString()}
                </span>
                <span className="text-[10px] text-slate-400">品目</span>
              </div>
            </div>

            <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-200/80">
              <div className="text-[11px] font-bold text-slate-500">登録食品</div>
              <div className="flex items-baseline gap-1 mt-0.5">
                <span className="text-base sm:text-lg font-extrabold text-indigo-600 font-mono">
                  {foodCount.toLocaleString()}
                </span>
                <span className="text-[10px] text-slate-400">件</span>
              </div>
            </div>

            <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-200/80">
              <div className="text-[11px] font-bold text-slate-500">登録活動</div>
              <div className="flex items-baseline gap-1 mt-0.5">
                <span className="text-base sm:text-lg font-extrabold text-sky-600 font-mono">
                  {eventMasterCount.toLocaleString()}
                </span>
                <span className="text-[10px] text-slate-400">件</span>
              </div>
            </div>

            <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-200/80">
              <div className="text-[11px] font-bold text-slate-500">カテゴリ</div>
              <div className="flex items-baseline gap-1 mt-0.5">
                <span className="text-base sm:text-lg font-extrabold text-slate-700 font-mono">
                  {categoryCount.toLocaleString()}
                </span>
                <span className="text-[10px] text-slate-400">件</span>
              </div>
            </div>
          </div>

          {dataActionMsg && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 flex items-center space-x-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{dataActionMsg}</span>
            </div>
          )}

          {dataErrorMsg && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-center space-x-2">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>{dataErrorMsg}</span>
            </div>
          )}

          {/* 保存状態ステータス & バックアップ・復元・初期化ボタン */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pt-2 border-t border-slate-100">
            <div className="flex items-center space-x-2 text-xs">
              <span
                className={cn(
                  'w-2 h-2 rounded-full',
                  isPersisted ? 'bg-emerald-500' : 'bg-amber-500'
                )}
              />
              <span className="text-slate-600">
                端末データの保護:{' '}
                <span className="font-bold text-slate-800">
                  {isPersisted ? '有効 (自動削除から保護)' : '標準'}
                </span>
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={restoreFileInputRef}
                type="file"
                accept=".json"
                onChange={handleRestoreFileChange}
                className="hidden"
              />

              <button
                type="button"
                onClick={handleExportData}
                disabled={isExporting}
                className="inline-flex items-center space-x-1.5 px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition-all shadow-2xs cursor-pointer active:scale-95"
              >
                {isExporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                <span>バックアップを保存</span>
              </button>

              <button
                type="button"
                onClick={() => restoreFileInputRef.current?.click()}
                disabled={isRestoring || isReadOnly}
                className={cn(
                  'inline-flex items-center space-x-1.5 px-3.5 py-2 rounded-xl text-xs font-bold border transition-all',
                  isReadOnly
                    ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                    : 'bg-white hover:bg-slate-50 text-slate-700 border-slate-300 cursor-pointer active:scale-95'
                )}
              >
                {isRestoring ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5 text-sky-600" />}
                <span>バックアップから復元</span>
              </button>

              <button
                type="button"
                onClick={handleRequestResetData}
                disabled={isResettingDb || isReadOnly}
                className={cn(
                  'inline-flex items-center space-x-1.5 px-3.5 py-2 rounded-xl text-xs font-bold border transition-all',
                  isReadOnly
                    ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                    : 'bg-rose-50 hover:bg-rose-100 text-rose-700 border-rose-200 cursor-pointer active:scale-95'
                )}
              >
                {isResettingDb ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                <span>記録データを初期化</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* セクション 3: 糖質の自動推定 (デモアプリでは非表示) */}
      {!isPortfolio && !isDemoMode && (
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-2xs space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h3 className="text-sm font-bold text-slate-800 flex items-center space-x-2">
              <Sparkles className="w-4 h-4 text-indigo-500" />
              <span>糖質の自動推定</span>
            </h3>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-bold border border-emerald-200">
              日本食品標準成分表 辞書稼働中
            </span>
          </div>

          <div className="bg-slate-50 p-4 rounded-xl border border-slate-200/80 space-y-1.5 text-xs text-slate-700">
            <div className="font-bold text-slate-800">
              {bffEnabled
                ? 'AI推定サーバー接続 + 内蔵の日本食品標準成分表データで自動推定'
                : '日本食品標準成分表の内蔵データからオフラインで自動推定'}
            </div>
            <p className="text-slate-600 leading-relaxed">
              食品名と分量を入力すると、内蔵の食品辞書データから糖質量（g）を即座に計算します。ネット接続がない場所でもそのまま利用できます。
            </p>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              disabled
              className="inline-flex items-center space-x-1.5 px-3.5 py-2 rounded-xl bg-slate-100 border border-slate-200 text-slate-400 text-xs font-bold cursor-not-allowed"
            >
              <CloudOff className="w-3.5 h-3.5" />
              <span>AIサーバー接続確認（未実装）</span>
            </button>
          </div>
        </div>
      )}

      {/* セクション 4: 家族見守り共有・クラウド同期（実装予定） (デモアプリでは非表示) */}
      {!isPortfolio && !isDemoMode && (
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-2xs space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h3 className="text-sm font-bold text-slate-800 flex items-center space-x-2">
              <Users className="w-4 h-4 text-sky-500" />
              <span>家族見守り共有・クラウド同期（実装予定）</span>
            </h3>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 font-semibold">
              次期フェーズで実装予定
            </span>
          </div>

          <div className="p-4 rounded-xl bg-slate-50 border border-dashed border-slate-300 text-xs text-slate-600 space-y-1.5">
            <p className="font-bold text-slate-800">
              家族との見守り共有・複数端末でのクラウド同期機能を実装予定
            </p>
            <p>
              現在はご利用中の端末内にデータを保存して動作しています。家族用の招待リンク発行やリアルタイム同期は今後のアップデートで提供予定です。
            </p>
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled
              className="inline-flex items-center space-x-1.5 px-3.5 py-2 rounded-xl bg-slate-100 border border-slate-200 text-slate-400 text-xs font-bold cursor-not-allowed"
            >
              <span>招待リンクを発行（未実装）</span>
            </button>
            <button
              type="button"
              disabled
              className="inline-flex items-center space-x-1.5 px-3.5 py-2 rounded-xl bg-slate-100 border border-slate-200 text-slate-400 text-xs font-bold cursor-not-allowed"
            >
              <span>クラウド同期を実行（未実装）</span>
            </button>
          </div>
        </div>
      )}

      {/* セクション 5: 動作検証・アプリ追加 (デモアプリでは非表示) */}
      {!isDemoMode && (
        <div className="bg-slate-50/80 rounded-2xl border border-dashed border-slate-300 p-5 sm:p-6 space-y-4">
          <div className="flex items-center space-x-2 text-slate-700">
            <FlaskConical className="w-5 h-5 text-indigo-600" />
            <h3 className="text-sm sm:text-base font-bold">動作検証・アプリ追加</h3>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2 border-t border-slate-200">
            {/* 表示モード切替 */}
            <div className="space-y-1.5">
              <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-slate-500" />
                表示モード切替:
              </span>
              <div className="inline-flex items-center rounded-xl bg-white p-1 border border-slate-200 shadow-2xs">
                <button
                  type="button"
                  onClick={() => setRole('patient')}
                  className={cn(
                    'flex items-center space-x-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all cursor-pointer',
                    currentRole === 'patient'
                      ? 'bg-slate-900 text-white shadow-xs'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                  )}
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  <span>患者本人 (編集可)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setRole('viewer')}
                  className={cn(
                    'flex items-center space-x-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all cursor-pointer',
                    currentRole === 'viewer'
                      ? 'bg-rose-700 text-white shadow-xs'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                  )}
                >
                  <Eye className="h-3.5 w-3.5" />
                  <span>見守り家族 (閲覧専用)</span>
                </button>
              </div>
            </div>

            {/* ホーム画面へ追加 */}
            {isInstallable && (
              <div className="space-y-1.5">
                <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                  <Smartphone className="w-3.5 h-3.5 text-indigo-600" />
                  アプリとして使う:
                </span>
                <div>
                  <button
                    type="button"
                    onClick={promptInstall}
                    className="inline-flex items-center space-x-1.5 px-3.5 py-1.5 rounded-xl bg-indigo-50 border border-indigo-200 text-indigo-700 hover:bg-indigo-100 text-xs font-bold transition-all shadow-2xs cursor-pointer active:scale-95"
                  >
                    <Download className="w-3.5 h-3.5 text-indigo-600" />
                    <span>ホーム画面にアプリを追加</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* デモアプリ専用: デモ環境のデータ管理カード */}
      {isDemoMode && (
        <div className="bg-white p-3.5 sm:p-4 rounded-2xl border border-slate-200 shadow-2xs space-y-2.5">
          <div className="flex items-center justify-between border-b border-slate-100 pb-2">
            <h3 className="text-sm font-bold text-slate-800 flex items-center space-x-2">
              <ShieldCheck className="w-4 h-4 text-sky-600" />
              <span>デモ環境のデータ管理</span>
            </h3>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
            <p className="text-xs text-slate-600 leading-relaxed">
              このデモアプリで登録・変更した内容は、お使いのスマートフォンやPCには保存されません。ページを再読み込みするかタブを閉じると、登録・変更した内容は破棄され、初期状態に戻ります。
            </p>

            <button
              type="button"
              data-testid="btn-reset-demo-data"
              onClick={() => setShowDemoResetConfirm(true)}
              disabled={isResettingDemo || isReadOnly}
              className={cn(
                'inline-flex items-center justify-center space-x-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold border transition-all shrink-0 self-end sm:self-auto',
                isReadOnly
                  ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                  : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-300 cursor-pointer active:scale-95'
              )}
            >
              {isResettingDemo ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RotateCcw className="w-3.5 h-3.5 text-slate-600" />
              )}
              <span>デモデータを初期状態に戻す</span>
            </button>
          </div>

          {demoResetMsg && (
            <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 flex items-center space-x-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{demoResetMsg}</span>
            </div>
          )}
        </div>
      )}

      {/* デモデータ初期状態リセット確認ダイアログ */}
      <ConfirmDialog
        isOpen={showDemoResetConfirm}
        title="デモデータのリセット確認"
        message="このセッションで登録・変更した食品・活動・記録・設定をすべて初期状態に戻しますか？"
        confirmLabel="初期状態に戻す"
        cancelLabel="キャンセル"
        variant="warning"
        onConfirm={handleConfirmDemoReset}
        onCancel={() => setShowDemoResetConfirm(false)}
      />

      {/* バックアップ復元確認ダイアログ */}
      <ConfirmDialog
        isOpen={!!pendingRestorePayload}
        title="バックアップからの復元確認"
        message={`選択したバックアップファイル（血糖データ ${restoreReadingCount.toLocaleString()}件、食事・活動記録 ${restoreEventCount.toLocaleString()}件）を復元しますか？`}
        confirmLabel="復元する"
        cancelLabel="キャンセル"
        variant="warning"
        onConfirm={executeRestoreBackup}
        onCancel={() => setPendingRestorePayload(null)}
      />

      {/* データ初期化確認ダイアログ */}
      <ConfirmDialog
        isOpen={showResetConfirm}
        title="記録データの初期化確認"
        message="保存されている血糖・食事・活動の記録データをすべて消去し、よく使う食品・活動を初期状態に戻しますか？"
        confirmLabel="初期化する"
        cancelLabel="キャンセル"
        variant="danger"
        onConfirm={handleConfirmResetData}
        onCancel={() => setShowResetConfirm(false)}
      />
    </div>
  );
};
