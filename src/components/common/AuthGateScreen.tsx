import React, { useState } from 'react';
import { usePatient, validateStrongPassword } from '@/contexts/PatientContext';
import {
  ShieldCheck,
  LogIn,
  UserPlus,
  Loader2,
  AlertCircle,
  CheckCircle2,
  HelpCircle,
  ChevronDown,
  ChevronUp,
  Lock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { PasswordStrengthChecklist } from './PasswordStrengthChecklist';

export const AuthGateScreen: React.FC = () => {
  const {
    isAuthLoading,
    isSyncing,
    syncError,
    signInWithEmail,
    signUpWithEmail,
  } = usePatient();

  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isGuideOpen, setIsGuideOpen] = useState<boolean>(false);

  const pwdStrength = validateStrongPassword(password);

  if (isAuthLoading) {
    return (
      <div
        data-testid="auth-gate-loading"
        className="flex-1 flex items-center justify-center px-4 py-12"
      >
        <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-xs max-w-sm w-full text-center space-y-3">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-sky-50 border border-sky-100 mx-auto">
            <Loader2 className="w-6 h-6 text-sky-600 animate-spin" />
          </div>
          <h1 className="text-sm font-extrabold text-slate-900">
            リブレ・食事管理
          </h1>
          <p className="text-xs font-medium text-slate-600">
            ログイン状態とアクセス権限を確認しています...
          </p>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setSuccessMsg(null);

    if (authMode === 'signup') {
      if (!pwdStrength.isValid) {
        setLocalError(
          pwdStrength.errorMessage ||
            'パスワードは8文字以上で、英大文字・英小文字・数字・記号の4種類すべてを含めてください。'
        );
        return;
      }
    } else if (password.length < 8) {
      setLocalError('パスワードは8文字以上で入力してください。');
      return;
    }

    setIsSubmitting(true);

    try {
      if (authMode === 'login') {
        const res = await signInWithEmail(email, password);
        if (res.error) {
          setLocalError(res.error);
        } else {
          setPassword('');
        }
      } else {
        const res = await signUpWithEmail(email, password);
        if (res.error) {
          setLocalError(res.error);
        } else if (res.needsEmailConfirmation) {
          setPassword('');
          setSuccessMsg(
            '確認メールを送信しました。メール内のリンクを開いてからログインしてください。'
          );
          setAuthMode('login');
        } else {
          setPassword('');
        }
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const displayError = localError || syncError;

  return (
    <div
      data-testid="auth-gate-screen"
      className="flex-1 flex flex-col items-center justify-center px-4 py-8 sm:py-12"
    >
      <div className="w-full max-w-md space-y-4">
        {/* メイン認証カード */}
        <div className="bg-white rounded-3xl border border-slate-200/90 shadow-sm p-6 sm:p-8 space-y-5">
          {/* ブランドヘッダー */}
          <div className="text-center space-y-2">
            <div className="inline-flex items-center justify-center">
              <img
                src="/icons/icon-192.svg"
                alt="リブレ・食事管理"
                className="w-12 h-12 rounded-2xl drop-shadow-2xs"
              />
            </div>
            <div>
              <h1 className="text-lg sm:text-xl font-extrabold text-slate-900 tracking-tight">
                リブレ・食事管理
              </h1>
              <p className="text-xs text-slate-500 mt-0.5">
                血糖値・食事・インスリン統合管理システム
              </p>
            </div>
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-[11px] font-bold text-emerald-800">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
              <span>招待制・プライベート保護（本人・招待家族専用）</span>
            </div>
          </div>

          {/* モード切替タブ */}
          <div className="grid grid-cols-2 rounded-xl bg-slate-100 p-1 border border-slate-200">
            <button
              type="button"
              onClick={() => {
                setAuthMode('login');
                setLocalError(null);
                setSuccessMsg(null);
              }}
              className={cn(
                'py-2 px-3 rounded-lg text-xs font-bold transition-all cursor-pointer',
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
                setLocalError(null);
                setSuccessMsg(null);
              }}
              className={cn(
                'py-2 px-3 rounded-lg text-xs font-bold transition-all cursor-pointer',
                authMode === 'signup'
                  ? 'bg-white text-slate-900 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              )}
            >
              新規アカウント登録
            </button>
          </div>

          {/* モード別の説明案内 */}
          <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 text-xs text-slate-600 leading-relaxed flex items-start gap-2">
            <Lock className="w-4 h-4 text-sky-600 shrink-0 mt-0.5" />
            <div>
              {authMode === 'login' ? (
                <span>
                  登録済みの患者ご本人、または招待されたご家族のメールアドレスとパスワードでログインしてください。
                </span>
              ) : (
                <span>
                  <strong className="text-slate-800">
                    患者ご本人から事前に招待されたメールアドレス
                  </strong>
                  （または初回オーナー登録）のみアカウントを作成できます。招待されていない第三者の登録は自動的に遮断されます。
                </span>
              )}
            </div>
          </div>

          {/* 入力フォーム */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="auth-gate-email"
                className="block text-xs font-bold text-slate-700 mb-1"
              >
                メールアドレス
              </label>
              <input
                id="auth-gate-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="example@email.com"
                className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
            </div>

            <div>
              <label
                htmlFor="auth-gate-password"
                className="block text-xs font-bold text-slate-700 mb-1"
              >
                {authMode === 'signup'
                  ? 'パスワード（8文字以上・大文字/小文字/数字/記号を含む）'
                  : 'パスワード（8文字以上）'}
              </label>
              <input
                id="auth-gate-password"
                type="password"
                required
                minLength={8}
                autoComplete={
                  authMode === 'login' ? 'current-password' : 'new-password'
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  authMode === 'signup'
                    ? '8文字以上・大文字/小文字/数字/記号を含む'
                    : '8文字以上のパスワード'
                }
                className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
              {authMode === 'signup' && (
                <PasswordStrengthChecklist
                  password={password}
                  containerTestId="auth-gate-password-checklist"
                  itemTestIdPrefix="pwd-req-"
                  warningTestId="auth-gate-password-warning"
                />
              )}
            </div>

            {successMsg && (
              <div
                role="status"
                className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 flex items-start space-x-2"
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                <span>{successMsg}</span>
              </div>
            )}

            {displayError && (
              <div
                role="alert"
                data-testid="auth-gate-error"
                className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-start space-x-2"
              >
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <span>{displayError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={
                isSubmitting ||
                isSyncing ||
                (authMode === 'signup' && !pwdStrength.isValid)
              }
              data-testid="auth-gate-submit"
              className="w-full inline-flex items-center justify-center space-x-2 px-4 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs sm:text-sm font-bold transition-all shadow-2xs cursor-pointer active:scale-95 disabled:opacity-50"
            >
              {isSubmitting || isSyncing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : authMode === 'login' ? (
                <LogIn className="w-4 h-4" />
              ) : (
                <UserPlus className="w-4 h-4" />
              )}
              <span>
                {isSubmitting || isSyncing
                  ? '認証・権限を確認中...'
                  : authMode === 'login'
                    ? 'ログインして開く'
                    : 'アカウントを登録する'}
              </span>
            </button>
          </form>
        </div>

        {/* はじめてご利用になる方・招待されたご家族向けガイド（アコーディオン） */}
        <div className="bg-white rounded-2xl border border-slate-200/90 shadow-2xs overflow-hidden">
          <button
            type="button"
            data-testid="auth-gate-quick-guide-toggle"
            onClick={() => setIsGuideOpen((prev) => !prev)}
            className="w-full px-4 py-3 flex items-center justify-between text-left text-xs font-bold text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <HelpCircle className="w-4 h-4 text-sky-600 shrink-0" />
              <span>はじめてご利用になる方・招待されたご家族の手順</span>
            </span>
            {isGuideOpen ? (
              <ChevronUp className="w-4 h-4 text-slate-400" />
            ) : (
              <ChevronDown className="w-4 h-4 text-slate-400" />
            )}
          </button>

          {isGuideOpen && (
            <div
              data-testid="auth-gate-quick-guide"
              className="px-4 pb-4 pt-1 border-t border-slate-100 text-xs text-slate-600 space-y-3 leading-relaxed"
            >
              <div className="space-y-1">
                <div className="font-bold text-slate-800">
                  1. 患者ご本人（オーナー）のログイン
                </div>
                <p>
                  初回のみ「新規アカウント登録」からご自身のメールアドレスとパスワードを登録してください。2回目以降は「ログイン」からパソコン・スマートフォンのどちらからでも同じデータにアクセスできます。
                </p>
              </div>

              <div className="space-y-1">
                <div className="font-bold text-slate-800">
                  2. 招待されたご家族の初回登録・ログイン手順
                </div>
                <ol className="list-decimal list-inside space-y-1 text-slate-600">
                  <li>
                    事前に患者ご本人が、アプリ内の「設定 ＞ 家族へのデータ共有・招待設定」であなたのメールアドレスを登録します。
                  </li>
                  <li>
                    この画面で<strong>「新規アカウント登録」</strong>を選び、招待されたものと同じメールアドレスとご希望のパスワード（8文字以上・大文字/小文字/数字/記号を含む）を入力して登録します。
                  </li>
                  <li>
                    ログインすると自動的に患者ご本人の記録が共有表示されます（「閲覧のみ」権限ではデータの変更や削除はロックされます）。
                  </li>
                </ol>
              </div>

              <div className="space-y-1">
                <div className="font-bold text-slate-800">
                  3. セキュリティとログアウト時の保護
                </div>
                <p>
                  招待されていない第三者がURLにアクセスしても画面は一切表示されません。また、ログアウトを実行するとお使いの端末内のキャッシュデータは自動的に消去されます。
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
