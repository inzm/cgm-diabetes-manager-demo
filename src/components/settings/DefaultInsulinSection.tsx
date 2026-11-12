import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Save, Syringe } from 'lucide-react';
import { db } from '@/lib/db';
import { waitForRecentPersistence } from '@/lib/realGlucoseLoader';
import { triggerBackgroundCloudSync } from '@/lib/syncEngine';
import { cn, getErrorMessage } from '@/lib/utils';

export function parseOptionalInsulin(raw: string, label: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const num = parseFloat(trimmed);
  if (Number.isNaN(num) || num < 0 || num > 100) {
    throw new Error(`${label}のインスリン単位数は 0〜100 の範囲（または空欄）で入力してください`);
  }
  return Math.round(num * 10) / 10;
}

interface DefaultInsulinSectionProps {
  currentPatientId: string;
  isReadOnly: boolean;
  hypoThreshold: number;
  hyperThreshold: number;
  enableDefaultInsulin: boolean;
  setEnableDefaultInsulin: (val: boolean) => void;
  defaultInsulinBreakfast: string;
  setDefaultInsulinBreakfast: (val: string) => void;
  defaultInsulinLunch: string;
  setDefaultInsulinLunch: (val: string) => void;
  defaultInsulinDinner: string;
  setDefaultInsulinDinner: (val: string) => void;
  defaultInsulinSnack: string;
  setDefaultInsulinSnack: (val: string) => void;
  onSettingsChanged?: () => void;
}

export const DefaultInsulinSection: React.FC<DefaultInsulinSectionProps> = ({
  currentPatientId,
  isReadOnly,
  hypoThreshold,
  hyperThreshold,
  enableDefaultInsulin,
  setEnableDefaultInsulin,
  defaultInsulinBreakfast,
  setDefaultInsulinBreakfast,
  defaultInsulinLunch,
  setDefaultInsulinLunch,
  defaultInsulinDinner,
  setDefaultInsulinDinner,
  defaultInsulinSnack,
  setDefaultInsulinSnack,
  onSettingsChanged,
}) => {
  const [isSavingInsulinDefaults, setIsSavingInsulinDefaults] = useState<boolean>(false);
  const [insulinDefaultSuccessMsg, setInsulinDefaultSuccessMsg] = useState<string | null>(null);
  const [insulinDefaultErrorMsg, setInsulinDefaultErrorMsg] = useState<string | null>(null);

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
      triggerBackgroundCloudSync(currentPatientId, { canEdit: !isReadOnly });
      setInsulinDefaultSuccessMsg(
        showFullMsg
          ? '食事区分別のデフォルトインスリン設定を保存しました。'
          : nextEnable
            ? 'デフォルトインスリン自動入力を有効（ON）にしました。'
            : 'デフォルトインスリン自動入力を無効（OFF: 空欄初期値）にしました。'
      );
      setTimeout(() => setInsulinDefaultSuccessMsg(null), 5000);
    } catch (err: unknown) {
      setInsulinDefaultErrorMsg(getErrorMessage(err, '設定の保存に失敗しました'));
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

  return (
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
              isReadOnly ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
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
  );
};
