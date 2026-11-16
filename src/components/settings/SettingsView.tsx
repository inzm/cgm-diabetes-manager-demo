import React, { useCallback, useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { DEFAULT_HYPER_THRESHOLD, DEFAULT_HYPO_THRESHOLD } from '@/types/database';
import { usePatient } from '@/contexts/PatientContext';
import {
  PatientBackupPayload,
  invalidateAllPatientMemoryCaches,
  resetPatientDataAndInvalidateCaches,
  restorePatientBackupPayload,
} from '@/lib/backupRestore';
import { db, requestPersistentStorage } from '@/lib/db';
import {
  isDemoCsvImportDisabled,
  isPortfolioMode,
  waitForRecentPersistence,
} from '@/lib/realGlucoseLoader';
import { CloudSyncFamilySection } from './CloudSyncFamilySection';
import { DataBackupSection } from './DataBackupSection';
import { DefaultInsulinSection } from './DefaultInsulinSection';
import { TargetRangeSection } from './TargetRangeSection';
import { VerificationPwaSection } from './VerificationPwaSection';

export {
  invalidateAllPatientMemoryCaches,
  restorePatientBackupPayload,
  resetPatientDataAndInvalidateCaches,
};
export type { PatientBackupPayload };

interface SettingsViewProps {
  onSettingsChanged?: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ onSettingsChanged }) => {
  const {
    currentPatientId,
    isReadOnly,
    hypoThreshold: contextHypo,
    hyperThreshold: contextHyper,
    updateClinicalThresholds,
    lastSyncedAt,
  } = usePatient();

  const isDemoMode = isDemoCsvImportDisabled();
  const isPortfolio = isPortfolioMode();

  const [hypoThreshold, setHypoThreshold] = useState<number>(
    contextHypo || DEFAULT_HYPO_THRESHOLD
  );
  const [hyperThreshold, setHyperThreshold] = useState<number>(
    contextHyper || DEFAULT_HYPER_THRESHOLD
  );

  const [enableDefaultInsulin, setEnableDefaultInsulin] = useState<boolean>(false);
  const [defaultInsulinBreakfast, setDefaultInsulinBreakfast] = useState<string>('');
  const [defaultInsulinLunch, setDefaultInsulinLunch] = useState<string>('');
  const [defaultInsulinDinner, setDefaultInsulinDinner] = useState<string>('');
  const [defaultInsulinSnack, setDefaultInsulinSnack] = useState<string>('');

  const [readingCount, setReadingCount] = useState<number>(0);
  const [eventCount, setEventCount] = useState<number>(0);
  const [detailCount, setDetailCount] = useState<number>(0);
  const [foodCount, setFoodCount] = useState<number>(0);
  const [eventMasterCount, setEventMasterCount] = useState<number>(0);
  const [categoryCount, setCategoryCount] = useState<number>(0);
  const [isPersisted, setIsPersisted] = useState<boolean>(false);

  const loadSettingsAndStats = useCallback(async () => {
    try {
      await waitForRecentPersistence(currentPatientId);
      const settings = await db.user_settings.get(currentPatientId);
      if (settings) {
        setHypoThreshold(settings.hypo_threshold || DEFAULT_HYPO_THRESHOLD);
        setHyperThreshold(settings.hyper_threshold || DEFAULT_HYPER_THRESHOLD);
        setEnableDefaultInsulin(Boolean(settings.enable_default_insulin));
        setDefaultInsulinBreakfast(
          settings.default_insulin_breakfast != null
            ? String(settings.default_insulin_breakfast)
            : ''
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
        db.meal_details
          .where('user_id')
          .equals(currentPatientId)
          .filter((d) => !d.is_deleted)
          .count(),
        db.food_master
          .where('user_id')
          .equals(currentPatientId)
          .filter((f) => !f.is_deleted)
          .count(),
        db.event_master
          .where('user_id')
          .equals(currentPatientId)
          .filter((em) => !em.is_deleted)
          .count(),
        db.categories
          .where('user_id')
          .equals(currentPatientId)
          .filter((c) => !c.is_deleted)
          .count(),
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
  }, [currentPatientId, isDemoMode]);

  useEffect(() => {
    void loadSettingsAndStats();
  }, [loadSettingsAndStats, lastSyncedAt]);

  const handleApplyRestoredSettings = useCallback(
    (restored: {
      hypo: number;
      hyper: number;
      enableDefaultInsulin: boolean;
      breakfast: string;
      lunch: string;
      dinner: string;
      snack: string;
    }) => {
      setHypoThreshold(restored.hypo);
      setHyperThreshold(restored.hyper);
      setEnableDefaultInsulin(restored.enableDefaultInsulin);
      setDefaultInsulinBreakfast(restored.breakfast);
      setDefaultInsulinLunch(restored.lunch);
      setDefaultInsulinDinner(restored.dinner);
      setDefaultInsulinSnack(restored.snack);
    },
    []
  );

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-3 sm:py-3.5 space-y-3">
      {isReadOnly && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-center space-x-3 text-xs text-amber-900">
          <Lock className="w-4 h-4 text-amber-600 shrink-0" />
          <div>
            <span className="font-bold">閲覧専用モードで表示中:</span>{' '}
            設定の変更やデータの復元・初期化は患者本人モードのみで行えます。
          </div>
        </div>
      )}

      <TargetRangeSection
        currentPatientId={currentPatientId}
        isReadOnly={isReadOnly}
        hypoThreshold={hypoThreshold}
        setHypoThreshold={setHypoThreshold}
        hyperThreshold={hyperThreshold}
        setHyperThreshold={setHyperThreshold}
        enableDefaultInsulin={enableDefaultInsulin}
        defaultInsulinBreakfast={defaultInsulinBreakfast}
        defaultInsulinLunch={defaultInsulinLunch}
        defaultInsulinDinner={defaultInsulinDinner}
        defaultInsulinSnack={defaultInsulinSnack}
        updateClinicalThresholds={updateClinicalThresholds}
        onSettingsChanged={onSettingsChanged}
        onReloadSettingsAndStats={loadSettingsAndStats}
      />

      <DefaultInsulinSection
        currentPatientId={currentPatientId}
        isReadOnly={isReadOnly}
        hypoThreshold={hypoThreshold}
        hyperThreshold={hyperThreshold}
        enableDefaultInsulin={enableDefaultInsulin}
        setEnableDefaultInsulin={setEnableDefaultInsulin}
        defaultInsulinBreakfast={defaultInsulinBreakfast}
        setDefaultInsulinBreakfast={setDefaultInsulinBreakfast}
        defaultInsulinLunch={defaultInsulinLunch}
        setDefaultInsulinLunch={setDefaultInsulinLunch}
        defaultInsulinDinner={defaultInsulinDinner}
        setDefaultInsulinDinner={setDefaultInsulinDinner}
        defaultInsulinSnack={defaultInsulinSnack}
        setDefaultInsulinSnack={setDefaultInsulinSnack}
        onSettingsChanged={onSettingsChanged}
      />

      <DataBackupSection
        currentPatientId={currentPatientId}
        isReadOnly={isReadOnly}
        isDemoMode={isDemoMode}
        isPortfolio={isPortfolio}
        hypoThreshold={hypoThreshold}
        hyperThreshold={hyperThreshold}
        readingCount={readingCount}
        eventCount={eventCount}
        detailCount={detailCount}
        foodCount={foodCount}
        eventMasterCount={eventMasterCount}
        categoryCount={categoryCount}
        isPersisted={isPersisted}
        onApplyRestoredSettings={handleApplyRestoredSettings}
        updateClinicalThresholds={updateClinicalThresholds}
        onReloadSettingsAndStats={loadSettingsAndStats}
        onSettingsChanged={onSettingsChanged}
      />

      <CloudSyncFamilySection
        isPortfolio={isPortfolio}
        isDemoMode={isDemoMode}
        onSettingsChanged={onSettingsChanged}
        onReloadSettingsAndStats={loadSettingsAndStats}
      />

      <VerificationPwaSection
        isDemoMode={isDemoMode}
        onApplyRestoredSettings={handleApplyRestoredSettings}
        onReloadSettingsAndStats={loadSettingsAndStats}
        onSettingsChanged={onSettingsChanged}
      />
    </div>
  );
};
