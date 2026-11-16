import React, { useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Download,
  Loader2,
  RotateCcw,
  Sparkles,
  Upload,
} from 'lucide-react';
import { DEFAULT_HYPER_THRESHOLD, DEFAULT_HYPO_THRESHOLD } from '@/types/database';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import {
  PatientBackupPayload,
  resetPatientDataAndInvalidateCaches,
  restorePatientBackupPayload,
} from '@/lib/backupRestore';
import { getTodayLocalDateStr } from '@/lib/dateUtils';
import { db } from '@/lib/db';
import { resetFoodSeedSession } from '@/lib/foodSeed';
import { isGeminiBffEnabled } from '@/lib/gemini';
import {
  cancelBackgroundHydration,
  markPatientManuallyCleared,
  notifyThresholdsUpdated,
} from '@/lib/realGlucoseLoader';
import { clearRemotePatientData, triggerBackgroundCloudSync } from '@/lib/syncEngine';
import { cn, getErrorMessage } from '@/lib/utils';

interface DataBackupSectionProps {
  currentPatientId: string;
  isReadOnly: boolean;
  isDemoMode: boolean;
  isPortfolio: boolean;
  hypoThreshold: number;
  hyperThreshold: number;
  readingCount: number;
  eventCount: number;
  detailCount: number;
  foodCount: number;
  eventMasterCount: number;
  categoryCount: number;
  isPersisted: boolean;
  onApplyRestoredSettings: (settings: {
    hypo: number;
    hyper: number;
    enableDefaultInsulin: boolean;
    breakfast: string;
    lunch: string;
    dinner: string;
    snack: string;
  }) => void;
  updateClinicalThresholds: (hypo: number, hyper: number) => void;
  onReloadSettingsAndStats: () => Promise<void>;
  onSettingsChanged?: () => void;
}

export const DataBackupSection: React.FC<DataBackupSectionProps> = ({
  currentPatientId,
  isReadOnly,
  isDemoMode,
  isPortfolio,
  hypoThreshold,
  hyperThreshold,
  readingCount,
  eventCount,
  detailCount,
  foodCount,
  eventMasterCount,
  categoryCount,
  isPersisted,
  onApplyRestoredSettings,
  updateClinicalThresholds,
  onReloadSettingsAndStats,
  onSettingsChanged,
}) => {
  const restoreFileInputRef = useRef<HTMLInputElement>(null);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [isRestoring, setIsRestoring] = useState<boolean>(false);
  const [pendingRestorePayload, setPendingRestorePayload] = useState<PatientBackupPayload | null>(
    null
  );
  const [isResettingDb, setIsResettingDb] = useState<boolean>(false);
  const [showResetConfirm, setShowResetConfirm] = useState<boolean>(false);
  const [dataActionMsg, setDataActionMsg] = useState<string | null>(null);
  const [dataErrorMsg, setDataErrorMsg] = useState<string | null>(null);

  const bffEnabled = isGeminiBffEnabled();

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
      downloadAnchor.setAttribute('download', `cgm_full_backup_${getTodayLocalDateStr()}.json`);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

      setDataActionMsg('バックアップファイルを保存しました。');
    } catch (err: unknown) {
      console.error('Failed to export data:', err);
      setDataErrorMsg(getErrorMessage(err, 'バックアップの保存に失敗しました'));
    } finally {
      setIsExporting(false);
    }
  };

  const handleRestoreFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || isReadOnly) return;

    setDataErrorMsg(null);
    setDataActionMsg(null);

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('有効なバックアップファイルではありません。');
      }

      setPendingRestorePayload(parsed as PatientBackupPayload);
    } catch (err: unknown) {
      console.error('Failed to parse JSON backup:', err);
      setDataErrorMsg(
        `読込エラー: ${getErrorMessage(err, 'バックアップファイルの読み込みに失敗しました')}`
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
      const restoredHypo = rawSettings?.hypo_threshold ?? DEFAULT_HYPO_THRESHOLD;
      const restoredHyper = rawSettings?.hyper_threshold ?? DEFAULT_HYPER_THRESHOLD;
      onApplyRestoredSettings({
        hypo: restoredHypo,
        hyper: restoredHyper,
        enableDefaultInsulin: Boolean(rawSettings?.enable_default_insulin),
        breakfast:
          rawSettings?.default_insulin_breakfast != null
            ? String(rawSettings.default_insulin_breakfast)
            : '',
        lunch:
          rawSettings?.default_insulin_lunch != null
            ? String(rawSettings.default_insulin_lunch)
            : '',
        dinner:
          rawSettings?.default_insulin_dinner != null
            ? String(rawSettings.default_insulin_dinner)
            : '',
        snack:
          rawSettings?.default_insulin_snack != null
            ? String(rawSettings.default_insulin_snack)
            : '',
      });
      notifyThresholdsUpdated(currentPatientId, restoredHypo, restoredHyper);
      updateClinicalThresholds(restoredHypo, restoredHyper);

      triggerBackgroundCloudSync(currentPatientId, {
        canEdit: !isReadOnly,
        replaceRemoteAnomalies: true,
        includeReadings: true,
      });

      await onReloadSettingsAndStats();
      onSettingsChanged?.();
      setDataActionMsg('バックアップからデータを復元しました。');
    } catch (err: unknown) {
      console.error('Failed to restore JSON backup:', err);
      setDataErrorMsg(
        `復元エラー: ${getErrorMessage(err, 'バックアップファイルの復元に失敗しました')}`
      );
    } finally {
      setIsRestoring(false);
    }
  };

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
      await clearRemotePatientData(currentPatientId);
      triggerBackgroundCloudSync(currentPatientId, {
        canEdit: !isReadOnly,
        replaceRemoteAnomalies: true,
        includeReadings: true,
      });

      onApplyRestoredSettings({
        hypo: DEFAULT_HYPO_THRESHOLD,
        hyper: DEFAULT_HYPER_THRESHOLD,
        enableDefaultInsulin: false,
        breakfast: '',
        lunch: '',
        dinner: '',
        snack: '',
      });
      notifyThresholdsUpdated(
        currentPatientId,
        DEFAULT_HYPO_THRESHOLD,
        DEFAULT_HYPER_THRESHOLD
      );
      updateClinicalThresholds(DEFAULT_HYPO_THRESHOLD, DEFAULT_HYPER_THRESHOLD);

      await onReloadSettingsAndStats();
      onSettingsChanged?.();

      setDataActionMsg(
        '血糖・食事・活動の記録データをすべて消去し、よく使う食品・活動を初期状態に戻しました。'
      );
    } catch (err: unknown) {
      console.error('Failed to reset local data:', err);
      setDataErrorMsg(`初期化エラー: ${getErrorMessage(err, '初期化に失敗しました')}`);
    } finally {
      setIsResettingDb(false);
    }
  };

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
    <>
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
                {isExporting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
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
                {isRestoring ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Upload className="w-3.5 h-3.5 text-sky-600" />
                )}
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
                {isResettingDb ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="w-3.5 h-3.5" />
                )}
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
              {bffEnabled
                ? 'AI推定 + 日本食品標準成分表 稼働中'
                : '日本食品標準成分表 辞書稼働中'}
            </span>
          </div>

          <div className="bg-slate-50 p-4 rounded-xl border border-slate-200/80 space-y-1.5 text-xs text-slate-700">
            <div className="font-bold text-slate-800">
              {bffEnabled
                ? 'AI推定サーバー接続 + 内蔵の日本食品標準成分表データで自動推定'
                : '日本食品標準成分表の内蔵データからオフラインで自動推定'}
            </div>
            <p className="text-slate-600 leading-relaxed">
              食品名と分量を入力すると、AIまたは内蔵の食品辞書データから糖質量（g）を即座に計算します。ネット接続がない場所でもそのまま利用できます。
            </p>
          </div>
        </div>
      )}

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
    </>
  );
};
