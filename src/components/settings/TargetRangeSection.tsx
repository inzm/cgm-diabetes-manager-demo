import React, { useState } from 'react';
import { Activity, AlertCircle, CheckCircle2, Loader2, Save } from 'lucide-react';
import {
  CLINICAL_THRESHOLD_BOUNDS,
  DEFAULT_HYPER_THRESHOLD,
  DEFAULT_HYPO_THRESHOLD,
} from '@/types/database';
import { db } from '@/lib/db';
import { reevaluatePatientAnomalyEvents } from '@/lib/anomalyExtractor';
import { invalidateAllPatientMemoryCaches } from '@/lib/backupRestore';
import { notifyThresholdsUpdated, waitForRecentPersistence } from '@/lib/realGlucoseLoader';
import { triggerBackgroundCloudSync } from '@/lib/syncEngine';
import { cn, getErrorMessage } from '@/lib/utils';
import { parseOptionalInsulin } from './DefaultInsulinSection';

interface TargetRangeSectionProps {
  currentPatientId: string;
  isReadOnly: boolean;
  hypoThreshold: number;
  setHypoThreshold: (val: number) => void;
  hyperThreshold: number;
  setHyperThreshold: (val: number) => void;
  enableDefaultInsulin: boolean;
  defaultInsulinBreakfast: string;
  defaultInsulinLunch: string;
  defaultInsulinDinner: string;
  defaultInsulinSnack: string;
  updateClinicalThresholds: (hypo: number, hyper: number) => void;
  onSettingsChanged?: () => void;
  onReloadSettingsAndStats: () => Promise<void>;
}

export const TargetRangeSection: React.FC<TargetRangeSectionProps> = ({
  currentPatientId,
  isReadOnly,
  hypoThreshold,
  setHypoThreshold,
  hyperThreshold,
  setHyperThreshold,
  enableDefaultInsulin,
  defaultInsulinBreakfast,
  defaultInsulinLunch,
  defaultInsulinDinner,
  defaultInsulinSnack,
  updateClinicalThresholds,
  onSettingsChanged,
  onReloadSettingsAndStats,
}) => {
  const [isSavingTarget, setIsSavingTarget] = useState<boolean>(false);
  const [targetSuccessMsg, setTargetSuccessMsg] = useState<string | null>(null);
  const [targetErrorMsg, setTargetErrorMsg] = useState<string | null>(null);

  const handleSaveTarget = async () => {
    if (isReadOnly) return;
    setTargetErrorMsg(null);
    setTargetSuccessMsg(null);

    const { hypo, hyper } = CLINICAL_THRESHOLD_BOUNDS;
    if (isNaN(hypoThreshold) || hypoThreshold < hypo.min || hypoThreshold > hypo.max) {
      setTargetErrorMsg(
        `低血糖の基準値は ${hypo.min}〜${hypo.max} mg/dL の範囲で入力してください`
      );
      return;
    }
    if (isNaN(hyperThreshold) || hyperThreshold < hyper.min || hyperThreshold > hyper.max) {
      setTargetErrorMsg(
        `高血糖の基準値は ${hyper.min}〜${hyper.max} mg/dL の範囲で入力してください`
      );
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

      notifyThresholdsUpdated(currentPatientId, hypoThreshold, hyperThreshold);
      updateClinicalThresholds(hypoThreshold, hyperThreshold);
      onSettingsChanged?.();

      const { hypoCount, hyperCount } = await reevaluatePatientAnomalyEvents(
        currentPatientId,
        hypoThreshold,
        hyperThreshold
      );

      invalidateAllPatientMemoryCaches(currentPatientId);
      triggerBackgroundCloudSync(currentPatientId, {
        canEdit: !isReadOnly,
        replaceRemoteAnomalies: true,
      });

      setTargetSuccessMsg(
        `目標範囲を保存し、データを更新しました（低血糖: ${hypoCount}件 / 高血糖: ${hyperCount}件）。`
      );
      setTimeout(() => setTargetSuccessMsg(null), 6000);
      void onReloadSettingsAndStats();
    } catch (err: unknown) {
      setTargetErrorMsg(getErrorMessage(err, '保存に失敗しました'));
    } finally {
      setIsSavingTarget(false);
    }
  };

  return (
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
          <span className="text-emerald-700">
            目標範囲 ({hypoThreshold} 〜 {hyperThreshold})
          </span>
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
              min={CLINICAL_THRESHOLD_BOUNDS.hypo.min}
              max={CLINICAL_THRESHOLD_BOUNDS.hypo.max}
              step="1"
              disabled={isReadOnly}
              value={hypoThreshold}
              onChange={(e) => setHypoThreshold(parseInt(e.target.value, 10))}
              className="w-full px-3 py-1 bg-slate-50 border border-slate-300 rounded-xl text-sm font-mono font-bold text-blue-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-50"
            />
            <span className="text-xs text-slate-400 font-semibold whitespace-nowrap">
              標準: {DEFAULT_HYPO_THRESHOLD}
            </span>
          </div>
          <p className="text-[11px] text-slate-400 mt-0.5">
            設定範囲: {CLINICAL_THRESHOLD_BOUNDS.hypo.min}〜{CLINICAL_THRESHOLD_BOUNDS.hypo.max}{' '}
            mg/dL
          </p>
        </div>

        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">
            高血糖の基準値 (mg/dL)
          </label>
          <div className="flex items-center space-x-2">
            <input
              type="number"
              min={CLINICAL_THRESHOLD_BOUNDS.hyper.min}
              max={CLINICAL_THRESHOLD_BOUNDS.hyper.max}
              step="1"
              disabled={isReadOnly}
              value={hyperThreshold}
              onChange={(e) => setHyperThreshold(parseInt(e.target.value, 10))}
              className="w-full px-3 py-1 bg-slate-50 border border-slate-300 rounded-xl text-sm font-mono font-bold text-rose-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-50"
            />
            <span className="text-xs text-slate-400 font-semibold whitespace-nowrap">
              標準: {DEFAULT_HYPER_THRESHOLD}
            </span>
          </div>
          <p className="text-[11px] text-slate-400 mt-0.5">
            設定範囲: {CLINICAL_THRESHOLD_BOUNDS.hyper.min}〜{CLINICAL_THRESHOLD_BOUNDS.hyper.max}{' '}
            mg/dL
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
          {isSavingTarget ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          <span>設定を保存</span>
        </button>
      </div>
    </div>
  );
};
