import React, { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  CloudOff,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { PasswordStrengthChecklist } from '@/components/common/PasswordStrengthChecklist';
import { usePatient, validateStrongPassword } from '@/contexts/PatientContext';
import { cn } from '@/lib/utils';

interface CloudSyncFamilySectionProps {
  isPortfolio: boolean;
  isDemoMode: boolean;
  onSettingsChanged?: () => void;
  onReloadSettingsAndStats: () => Promise<void>;
}

export const CloudSyncFamilySection: React.FC<CloudSyncFamilySectionProps> = ({
  isPortfolio,
  isDemoMode,
  onSettingsChanged,
  onReloadSettingsAndStats,
}) => {
  const {
    currentPatientId,
    isReadOnly,
    currentRole,
    isCloudEnabled,
    isSystemOwner,
    authUser,
    isAuthLoading,
    isSyncing,
    lastSyncedAt,
    syncError,
    accessibleTargets,
    myInvitedFollowers,
    signInWithEmail,
    signUpWithEmail,
    signOut,
    switchTargetPatient,
    syncNow,
    addFamilyMember,
    removeFamilyMember,
  } = usePatient();

  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [authEmailInput, setAuthEmailInput] = useState<string>('');
  const [authPasswordInput, setAuthPasswordInput] = useState<string>('');
  const [isSubmittingAuth, setIsSubmittingAuth] = useState<boolean>(false);
  const [authSuccessMsg, setAuthSuccessMsg] = useState<string | null>(null);
  const [authErrorMsg, setAuthErrorMsg] = useState<string | null>(null);

  const [familyEmailInput, setFamilyEmailInput] = useState<string>('');
  const [familyRoleInput, setFamilyRoleInput] = useState<'viewer' | 'editor'>('viewer');
  const [isSubmittingFamily, setIsSubmittingFamily] = useState<boolean>(false);
  const [familySuccessMsg, setFamilySuccessMsg] = useState<string | null>(null);
  const [familyErrorMsg, setFamilyErrorMsg] = useState<string | null>(null);
  const [pendingRemoveFamilyId, setPendingRemoveFamilyId] = useState<string | null>(null);
  const [pendingRemoveFamilyEmail, setPendingRemoveFamilyEmail] = useState<string>('');

  const authPasswordStrength = validateStrongPassword(authPasswordInput);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthErrorMsg(null);
    setAuthSuccessMsg(null);

    if (authMode === 'signup') {
      if (!authPasswordStrength.isValid) {
        setAuthErrorMsg(
          authPasswordStrength.errorMessage ||
            'パスワードは8文字以上で、英大文字・英小文字・数字・記号の4種類すべてを含めてください。'
        );
        return;
      }
    } else if (authPasswordInput.length < 8) {
      setAuthErrorMsg('パスワードは8文字以上で入力してください。');
      return;
    }

    setIsSubmittingAuth(true);

    try {
      if (authMode === 'login') {
        const res = await signInWithEmail(authEmailInput, authPasswordInput);
        if (res.error) {
          setAuthErrorMsg(res.error);
        } else {
          setAuthPasswordInput('');
          setAuthSuccessMsg('ログインし、クラウドとデータを同期しました。');
          onSettingsChanged?.();
          void onReloadSettingsAndStats();
        }
      } else {
        const res = await signUpWithEmail(authEmailInput, authPasswordInput);
        if (res.error) {
          setAuthErrorMsg(res.error);
        } else if (res.needsEmailConfirmation) {
          setAuthPasswordInput('');
          setAuthSuccessMsg(
            '確認メールを送信しました。メール内のリンクを開いてからログインしてください。'
          );
          setAuthMode('login');
        } else {
          setAuthPasswordInput('');
          setAuthSuccessMsg('アカウントを登録し、クラウド同期を開始しました。');
          onSettingsChanged?.();
          void onReloadSettingsAndStats();
        }
      }
    } finally {
      setIsSubmittingAuth(false);
    }
  };

  const handleManualSync = async () => {
    setAuthErrorMsg(null);
    setAuthSuccessMsg(null);
    const res = await syncNow({ includeReadings: true });
    if (res.status === 'success') {
      setAuthSuccessMsg(
        `クラウド同期が完了しました（送信: ${res.pushedCount}件 / 受信: ${res.pulledCount}件）。`
      );
      onSettingsChanged?.();
      void onReloadSettingsAndStats();
      setTimeout(() => setAuthSuccessMsg(null), 5000);
    } else if (res.status === 'error' && res.errorMessage) {
      setAuthErrorMsg(res.errorMessage);
    }
  };

  const handleAddFamilySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly) return;
    setFamilyErrorMsg(null);
    setFamilySuccessMsg(null);
    setIsSubmittingFamily(true);
    try {
      const res = await addFamilyMember(familyEmailInput, familyRoleInput);
      if (res.error) {
        setFamilyErrorMsg(res.error);
      } else {
        const addedEmail = familyEmailInput.trim();
        setFamilyEmailInput('');
        setFamilySuccessMsg(
          `${addedEmail} を家族共有メンバーに登録しました。相手がこのメールアドレスでログインすると自動的に共有されます。`
        );
        setTimeout(() => setFamilySuccessMsg(null), 6000);
      }
    } finally {
      setIsSubmittingFamily(false);
    }
  };

  const handleConfirmRemoveFamily = async () => {
    if (!pendingRemoveFamilyId) return;
    const targetId = pendingRemoveFamilyId;
    setPendingRemoveFamilyId(null);
    setFamilyErrorMsg(null);
    setFamilySuccessMsg(null);
    const res = await removeFamilyMember(targetId);
    if (res.error) {
      setFamilyErrorMsg(res.error);
    } else {
      setFamilySuccessMsg(`${pendingRemoveFamilyEmail} の共有設定を解除しました。`);
      setTimeout(() => setFamilySuccessMsg(null), 5000);
    }
  };

  if (isPortfolio || isDemoMode) {
    return null;
  }

  return (
    <>
      <div className="bg-white p-5 sm:p-6 rounded-2xl border border-slate-200 shadow-2xs space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
          <h3 className="text-sm font-bold text-slate-800 flex items-center space-x-2">
            <Users className="w-4 h-4 text-sky-500" />
            <span>家族見守り共有・クラウド同期</span>
          </h3>
          {isCloudEnabled ? (
            authUser ? (
              <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-bold border border-emerald-200">
                <Cloud className="w-3.5 h-3.5" />
                <span>クラウド同期中</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 font-semibold border border-amber-200">
                <CloudOff className="w-3.5 h-3.5" />
                <span>未ログイン（端末内保存モード）</span>
              </span>
            )
          ) : (
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 font-semibold">
              端末内保存モード
            </span>
          )}
        </div>

        {!isCloudEnabled ? (
          <div className="p-4 rounded-xl bg-slate-50 border border-dashed border-slate-300 text-xs text-slate-600 space-y-1.5">
            <p className="font-bold text-slate-800">
              現在はご利用中の端末内にデータを保存して動作しています
            </p>
            <p>
              クラウド接続設定が有効になると、複数端末（パソコン・スマートフォン）での自動同期や家族との共有が利用できます。
            </p>
          </div>
        ) : isAuthLoading ? (
          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex items-center gap-2 text-xs text-slate-600">
            <Loader2 className="w-4 h-4 animate-spin text-sky-600" />
            <span>アカウントのログイン状態を確認しています...</span>
          </div>
        ) : !authUser ? (
          /* 未ログイン時: ログイン / 新規アカウント登録フォーム */
          <form onSubmit={handleAuthSubmit} className="space-y-4">
            <div className="p-3.5 rounded-xl bg-sky-50/70 border border-sky-200/80 text-xs text-slate-700 space-y-1">
              <p className="font-bold text-slate-800">
                パソコン・スマートフォン間の自動同期 ＆ 家族見守り共有
              </p>
              <p className="leading-relaxed">
                未ログインのまま記録したデータも、ログインすると自動的にあなたのアカウントへ引き継がれてクラウドに保存されます。家族から招待を受けている場合は、招待されたメールアドレスで登録・ログインしてください。
              </p>
            </div>

            <div className="inline-flex rounded-xl bg-slate-100 p-1 border border-slate-200">
              <button
                type="button"
                onClick={() => {
                  setAuthMode('login');
                  setAuthErrorMsg(null);
                  setAuthSuccessMsg(null);
                }}
                className={cn(
                  'px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer',
                  authMode === 'login'
                    ? 'bg-white text-slate-900 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                )}
              >
                ログイン
              </button>
              <button
                type="button"
                onClick={() => {
                  setAuthMode('signup');
                  setAuthErrorMsg(null);
                  setAuthSuccessMsg(null);
                }}
                className={cn(
                  'px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer',
                  authMode === 'signup'
                    ? 'bg-white text-slate-900 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                )}
              >
                新規アカウント登録
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  メールアドレス
                </label>
                <input
                  type="email"
                  required
                  value={authEmailInput}
                  onChange={(e) => setAuthEmailInput(e.target.value)}
                  placeholder="example@email.com"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-xl text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  {authMode === 'signup'
                    ? 'パスワード（8文字以上・大文字/小文字/数字/記号を含む）'
                    : 'パスワード（8文字以上）'}
                </label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={authPasswordInput}
                  onChange={(e) => setAuthPasswordInput(e.target.value)}
                  placeholder={
                    authMode === 'signup'
                      ? '8文字以上・大文字/小文字/数字/記号を含む'
                      : '8文字以上のパスワード'
                  }
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-xl text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500"
                />
              </div>
            </div>

            {authMode === 'signup' && (
              <PasswordStrengthChecklist
                password={authPasswordInput}
                containerTestId="settings-password-checklist"
              />
            )}

            {authSuccessMsg && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 flex items-center space-x-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>{authSuccessMsg}</span>
              </div>
            )}

            {authErrorMsg && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-center space-x-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>{authErrorMsg}</span>
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={
                  isSubmittingAuth || (authMode === 'signup' && !authPasswordStrength.isValid)
                }
                className="inline-flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold transition-all shadow-2xs cursor-pointer active:scale-95 disabled:opacity-50"
              >
                {isSubmittingAuth ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <LogIn className="w-4 h-4" />
                )}
                <span>
                  {authMode === 'login' ? 'ログインして同期する' : 'アカウントを登録する'}
                </span>
              </button>
            </div>
          </form>
        ) : (
          /* ログイン済み: アカウント状態・今すぐ同期・表示対象切替・家族招待管理 */
          <div className="space-y-5">
            {/* アカウント情報 & 手動同期バー */}
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200/90 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-bold text-slate-800">{authUser.email}</span>
                  <span
                    className={cn(
                      'text-[11px] font-bold px-2 py-0.5 rounded-md border',
                      currentRole === 'patient'
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : currentRole === 'editor'
                          ? 'bg-sky-50 text-sky-700 border-sky-200'
                          : 'bg-amber-50 text-amber-800 border-amber-200'
                    )}
                  >
                    {currentRole === 'patient'
                      ? '患者本人'
                      : currentRole === 'editor'
                        ? '家族（記録・編集可能）'
                        : '家族（閲覧のみ）'}
                  </span>
                </div>
                <div className="text-[11px] text-slate-500">
                  {lastSyncedAt
                    ? `最終同期: ${new Date(lastSyncedAt).toLocaleString('ja-JP')}`
                    : 'クラウド接続済み'}{' '}
                  ・ログアウト時はこの端末内のキャッシュを自動消去してログイン画面へ戻ります
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleManualSync}
                  disabled={isSyncing}
                  className="inline-flex items-center space-x-1.5 px-3.5 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold transition-all shadow-2xs cursor-pointer active:scale-95 disabled:opacity-50"
                >
                  <RefreshCw className={cn('w-3.5 h-3.5', isSyncing && 'animate-spin')} />
                  <span>{isSyncing ? '同期中...' : '今すぐ同期'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => void signOut()}
                  disabled={isSyncing}
                  className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 text-xs font-bold transition-all cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5 text-slate-500" />
                  <span>ログアウト</span>
                </button>
              </div>
            </div>

            {(authSuccessMsg || authErrorMsg || syncError) && (
              <div className="space-y-2">
                {authSuccessMsg && (
                  <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span>{authSuccessMsg}</span>
                  </div>
                )}
                {(authErrorMsg || syncError) && (
                  <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-center space-x-2">
                    <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                    <span>{authErrorMsg || syncError}</span>
                  </div>
                )}
              </div>
            )}

            {/* 表示対象の切り替え（招待された家族データと自分自身のデータの両方がある場合） */}
            {accessibleTargets.length > 1 && (
              <div className="p-4 rounded-xl bg-sky-50/50 border border-sky-200/80 space-y-2">
                <label className="block text-xs font-bold text-slate-800">
                  表示・記録するデータの切り替え
                </label>
                <div className="flex flex-wrap gap-2">
                  {accessibleTargets.map((target) => {
                    const isSelected = target.patientId === currentPatientId;
                    return (
                      <button
                        key={target.patientId}
                        type="button"
                        onClick={() => void switchTargetPatient(target.patientId)}
                        className={cn(
                          'px-3.5 py-2 rounded-xl text-xs font-bold border transition-all cursor-pointer',
                          isSelected
                            ? 'bg-sky-600 text-white border-sky-600 shadow-2xs'
                            : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                        )}
                      >
                        {target.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 家族見守り招待・権限管理（患者本人オーナーのプロファイル選択時のみ表示） */}
            {currentPatientId === authUser.id && isSystemOwner && (
              <div className="pt-3 border-t border-slate-100 space-y-4">
                <div>
                  <h4 className="text-xs font-bold text-slate-800">
                    家族へのデータ共有・招待設定
                  </h4>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    共有したい家族のメールアドレスと権限を登録してください。事前登録されていない第三者のアカウント作成・ログインは自動的に遮断されます。
                  </p>
                </div>

                {/* 家族招待の3ステップ案内ボックス */}
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/80 text-xs text-slate-600 space-y-1.5 leading-relaxed">
                  <div className="font-bold text-slate-800">
                    新しい家族を招待する手順（3ステップ）
                  </div>
                  <ol className="list-decimal list-inside space-y-1">
                    <li>
                      <strong>患者本人が招待登録</strong>：下の欄に家族のメールアドレスを入力し、権限を選んで「家族を追加」を押します。
                    </li>
                    <li>
                      <strong>家族が初回登録</strong>：家族がアプリのURLを開き、ログイン画面の「新規アカウント登録」から<strong>招待された同じメールアドレス</strong>とパスワード（8文字以上・大文字/小文字/数字/記号を含む）を登録します。
                    </li>
                    <li>
                      <strong>共有開始</strong>：家族がログインすると自動的に「連携済み」となり、選んだ権限（閲覧のみ／記録・編集も可能）でデータが共有されます。
                    </li>
                  </ol>
                </div>

                <form
                  onSubmit={handleAddFamilySubmit}
                  className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end"
                >
                  <div className="sm:col-span-5">
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">
                      家族のメールアドレス
                    </label>
                    <input
                      type="email"
                      required
                      value={familyEmailInput}
                      onChange={(e) => setFamilyEmailInput(e.target.value)}
                      placeholder="family@email.com"
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-xl text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500"
                    />
                  </div>

                  <div className="sm:col-span-4">
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">
                      共有する権限
                    </label>
                    <select
                      value={familyRoleInput}
                      onChange={(e) =>
                        setFamilyRoleInput(e.target.value as 'viewer' | 'editor')
                      }
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500"
                    >
                      <option value="viewer">閲覧のみ（変更・削除不可）</option>
                      <option value="editor">記録・編集も可能（代理入力可）</option>
                    </select>
                  </div>

                  <div className="sm:col-span-3">
                    <button
                      type="submit"
                      disabled={isSubmittingFamily || isReadOnly}
                      className="w-full inline-flex items-center justify-center space-x-1.5 px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition-all shadow-2xs cursor-pointer active:scale-95 disabled:opacity-50"
                    >
                      {isSubmittingFamily ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <UserPlus className="w-4 h-4" />
                      )}
                      <span>家族を追加</span>
                    </button>
                  </div>
                </form>

                {familySuccessMsg && (
                  <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span>{familySuccessMsg}</span>
                  </div>
                )}

                {familyErrorMsg && (
                  <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-center space-x-2">
                    <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                    <span>{familyErrorMsg}</span>
                  </div>
                )}

                {/* 登録済み家族一覧 */}
                <div className="space-y-2">
                  <div className="text-[11px] font-bold text-slate-600">
                    共有中の家族一覧 ({myInvitedFollowers.length}名)
                  </div>
                  {myInvitedFollowers.length === 0 ? (
                    <div className="p-3.5 rounded-xl bg-slate-50 border border-dashed border-slate-200 text-xs text-slate-500">
                      現在共有設定されている家族はいません。
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-200 border border-slate-200 rounded-xl overflow-hidden bg-white">
                      {myInvitedFollowers.map((perm) => {
                        const isAccepted = Boolean(perm.accepted_at || perm.family_user_id);
                        const displayEmail = perm.family_email || '登録済み家族メンバー';
                        return (
                          <div
                            key={perm.id}
                            className="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-bold text-slate-800">{displayEmail}</span>
                              <span
                                className={cn(
                                  'px-2 py-0.5 rounded-md text-[11px] font-bold border',
                                  perm.role === 'editor'
                                    ? 'bg-sky-50 text-sky-700 border-sky-200'
                                    : 'bg-slate-100 text-slate-700 border-slate-200'
                                )}
                              >
                                {perm.role === 'editor' ? '記録・編集可能' : '閲覧のみ'}
                              </span>
                              <span
                                className={cn(
                                  'px-2 py-0.5 rounded-md text-[10px] font-semibold',
                                  isAccepted
                                    ? 'bg-emerald-50 text-emerald-700'
                                    : 'bg-amber-50 text-amber-700'
                                )}
                              >
                                {isAccepted ? '連携済み' : '招待中（初回ログイン待ち）'}
                              </span>
                            </div>

                            <button
                              type="button"
                              onClick={() => {
                                setPendingRemoveFamilyId(perm.id);
                                setPendingRemoveFamilyEmail(displayEmail);
                              }}
                              className="inline-flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-700 text-[11px] font-bold transition-colors cursor-pointer self-end sm:self-auto"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>共有を解除</span>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 家族共有解除確認ダイアログ */}
      <ConfirmDialog
        isOpen={!!pendingRemoveFamilyId}
        title="家族共有の解除確認"
        message={`${pendingRemoveFamilyEmail} へのデータ共有を解除しますか？（解除すると相手はあなたの記録を閲覧できなくなります）`}
        confirmLabel="共有を解除する"
        cancelLabel="キャンセル"
        variant="danger"
        onConfirm={handleConfirmRemoveFamily}
        onCancel={() => setPendingRemoveFamilyId(null)}
      />
    </>
  );
};
