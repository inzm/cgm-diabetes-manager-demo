import React, { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Eye,
  FlaskConical,
  Loader2,
  RotateCcw,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import { DEFAULT_HYPER_THRESHOLD, DEFAULT_HYPO_THRESHOLD } from '@/types/database';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { usePatient } from '@/contexts/PatientContext';
import { invalidateAllPatientMemoryCaches } from '@/lib/backupRestore';
import { usePwaInstallPrompt } from '@/lib/pwa';
import { resetDemoDataToInitialState } from '@/lib/realGlucoseLoader';
import { cn, getErrorMessage } from '@/lib/utils';

interface VerificationPwaSectionProps {
  isDemoMode: boolean;
  onApplyRestoredSettings: (settings: {
    hypo: number;
    hyper: number;
    enableDefaultInsulin: boolean;
    breakfast: string;
    lunch: string;
    dinner: string;
    snack: string;
  }) => void;
  onReloadSettingsAndStats: () => Promise<void>;
  onSettingsChanged?: () => void;
}

export const VerificationPwaSection: React.FC<VerificationPwaSectionProps> = ({
  isDemoMode,
  onApplyRestoredSettings,
  onReloadSettingsAndStats,
  onSettingsChanged,
}) => {
  const {
    currentPatientId,
    isReadOnly,
    currentRole,
    setRole,
    updateClinicalThresholds,
    authUser,
    accessibleTargets,
  } = usePatient();
  const { isInstallable, promptInstall } = usePwaInstallPrompt();

  const [showDemoResetConfirm, setShowDemoResetConfirm] = useState<boolean>(false);
  const [isResettingDemo, setIsResettingDemo] = useState<boolean>(false);
  const [demoResetMsg, setDemoResetMsg] = useState<string | null>(null);
  const [demoResetErrorMsg, setDemoResetErrorMsg] = useState<string | null>(null);

  const isLockedViewerAccount = Boolean(
    authUser &&
      accessibleTargets.find((t) => t.patientId === currentPatientId)?.role === 'viewer'
  );

  const handleConfirmDemoReset = async () => {
    if (isReadOnly) return;
    setShowDemoResetConfirm(false);
    setIsResettingDemo(true);
    setDemoResetMsg(null);
    setDemoResetErrorMsg(null);

    try {
      await resetDemoDataToInitialState(currentPatientId);
      onApplyRestoredSettings({
        hypo: DEFAULT_HYPO_THRESHOLD,
        hyper: DEFAULT_HYPER_THRESHOLD,
        enableDefaultInsulin: false,
        breakfast: '',
        lunch: '',
        dinner: '',
        snack: '',
      });
      updateClinicalThresholds(DEFAULT_HYPO_THRESHOLD, DEFAULT_HYPER_THRESHOLD);

      invalidateAllPatientMemoryCaches(currentPatientId);
      await onReloadSettingsAndStats();
      onSettingsChanged?.();

      setDemoResetMsg('デモデータを初期状態に戻しました。');
      setTimeout(() => setDemoResetMsg(null), 6000);
    } catch (err: unknown) {
      console.error('Failed to reset demo data:', err);
      setDemoResetErrorMsg(getErrorMessage(err, 'デモデータのリセットに失敗しました'));
    } finally {
      setIsResettingDemo(false);
    }
  };

  return (
    <>
      {/* セクション 5: 動作検証・アプリ追加 (デモアプリおよびクラウドログイン時ロール切替は非表示) */}
      {!isDemoMode && (!authUser || isInstallable) && (
        <div className="bg-slate-50/80 rounded-2xl border border-dashed border-slate-300 p-5 sm:p-6 space-y-4">
          <div className="flex items-center space-x-2 text-slate-700">
            <FlaskConical className="w-5 h-5 text-indigo-600" />
            <h3 className="text-sm sm:text-base font-bold">動作検証・アプリ追加</h3>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2 border-t border-slate-200">
            {/* 表示モード切替 (未ログインのローカル検証・E2E回帰テスト時のみ表示) */}
            {!authUser && (
              <div className="space-y-1.5">
                <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-slate-500" />
                  表示モード切替:
                </span>
                <div className="inline-flex items-center rounded-xl bg-white p-1 border border-slate-200 shadow-2xs">
                  <button
                    type="button"
                    disabled={isLockedViewerAccount}
                    onClick={() => setRole('patient')}
                    className={cn(
                      'flex items-center space-x-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed',
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
            )}

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

          {demoResetErrorMsg && (
            <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-center space-x-2">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>{demoResetErrorMsg}</span>
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
    </>
  );
};
