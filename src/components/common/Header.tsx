import React from 'react';
import { usePatient } from '@/contexts/PatientContext';
import { useOnlineStatus } from '@/lib/pwa';
import {
  Users,
  WifiOff,
  ChevronLeft,
  ChevronRight,
  FolderKanban,
  BarChart3,
  Settings,
  Cloud,
  LogIn,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CalendarHeaderControls {
  year: number;
  month: number;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onToday: () => void;
  isNextMonthDisabled?: boolean;
}

interface HeaderProps {
  activeTab?: string;
  calendarControls?: CalendarHeaderControls;
  onNavigateToSettings?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab = 'calendar',
  calendarControls,
  onNavigateToSettings,
}) => {
  const { isReadOnly, isCloudEnabled, authUser, isSyncing } = usePatient();
  const isOnline = useOnlineStatus();

  // カレンダー以外のタブ表示時のバッジ定義（右寄せでバランス良く表示）
  const tabBadgeConfig: Record<
    string,
    { label: string; icon: React.ReactNode; badgeClass: string }
  > = {
    events: {
      label: 'よく使う食品・活動',
      icon: <FolderKanban className="w-3.5 h-3.5 text-amber-600 shrink-0" />,
      badgeClass: 'bg-amber-50/90 text-amber-800 border-amber-200/80',
    },
    analysis: {
      label: 'データ分析',
      icon: <BarChart3 className="w-3.5 h-3.5 text-indigo-600 shrink-0" />,
      badgeClass: 'bg-indigo-50/90 text-indigo-700 border-indigo-200/80',
    },
    settings: {
      label: '設定',
      icon: <Settings className="w-3.5 h-3.5 text-slate-600 shrink-0" />,
      badgeClass: 'bg-slate-100 text-slate-700 border-slate-200/90',
    },
  };

  const currentTabBadge = tabBadgeConfig[activeTab];

  return (
    <header className="sticky top-0 z-40 w-full border-b border-slate-200/90 bg-white/95 backdrop-blur-md text-slate-900 shadow-2xs">
      <div className="relative mx-auto flex h-12 max-w-7xl items-center justify-between gap-2 px-3 sm:px-6 lg:px-8">
        {/* Left: Brand Logo & Title（二重枠を排しアイコン本来のグラデーションを鮮明に表示） */}
        <div className="flex items-center space-x-2 sm:space-x-2.5 shrink-0">
          <img
            src="/icons/icon-192.svg"
            alt="糖質管理"
            className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg drop-shadow-2xs shrink-0"
          />
          <span className="font-extrabold tracking-tight text-slate-900 text-xs sm:text-sm whitespace-nowrap">
            糖質管理
          </span>
        </div>

        {/* Center: カレンダー以外のタブ表示時の現在画面ピルバッジ（中央配置） */}
        {!calendarControls && currentTabBadge && (
          <div
            className={cn(
              'pointer-events-none absolute left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-bold whitespace-nowrap max-w-[calc(100%-10rem)] truncate',
              currentTabBadge.badgeClass
            )}
          >
            {currentTabBadge.icon}
            <span className="truncate">{currentTabBadge.label}</span>
          </div>
        )}

        {/* Right: カレンダー年月操作部 ＋ ステータス */}
        <div className="flex items-center justify-end gap-1.5 sm:gap-2 min-w-0">
          {calendarControls ? (
            <div className="flex items-center gap-1.5 sm:gap-2">
              <div className="flex items-center rounded-xl border border-slate-200 bg-slate-100/90 p-0.5">
                <button
                  onClick={calendarControls.onPrevMonth}
                  aria-label="前月"
                  className="p-1.5 sm:p-2 rounded-lg hover:bg-white text-slate-600 hover:text-slate-900 hover:shadow-2xs transition-all cursor-pointer active:scale-95"
                >
                  <ChevronLeft className="w-4 h-4 sm:w-5 sm:h-5" />
                </button>
                <span className="px-2.5 sm:px-3.5 text-sm sm:text-base font-extrabold text-slate-900 whitespace-nowrap tabular-nums tracking-tight">
                  {calendarControls.year}年 {calendarControls.month}月
                </span>
                <button
                  onClick={calendarControls.onNextMonth}
                  disabled={Boolean(calendarControls.isNextMonthDisabled)}
                  aria-label="翌月"
                  title={
                    calendarControls.isNextMonthDisabled
                      ? '最新の月を表示中です'
                      : '翌月'
                  }
                  className={cn(
                    'p-1.5 sm:p-2 rounded-lg transition-all',
                    calendarControls.isNextMonthDisabled
                      ? 'text-slate-300 opacity-50 cursor-not-allowed'
                      : 'hover:bg-white text-slate-600 hover:text-slate-900 hover:shadow-2xs cursor-pointer active:scale-95'
                  )}
                >
                  <ChevronRight className="w-4 h-4 sm:w-5 sm:h-5" />
                </button>
              </div>

              {/* 今月のカレンダーを表示する独立ボタン */}
              <button
                onClick={calendarControls.onToday}
                className="inline-flex items-center justify-center px-3 sm:px-3.5 py-1.5 rounded-xl border border-sky-200/90 bg-sky-50 hover:bg-sky-100 text-xs sm:text-sm font-bold text-sky-700 transition-all cursor-pointer whitespace-nowrap active:scale-95"
                title="今月のカレンダーを表示"
              >
                <span>今月</span>
              </button>
            </div>
          ) : null}

          {/* 本番クラウド有効時: ログイン・同期ステータスバッジ */}
          {isCloudEnabled && onNavigateToSettings && (
            <button
              type="button"
              onClick={onNavigateToSettings}
              className={cn(
                'inline-flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-full border text-[11px] sm:text-xs font-bold transition-colors cursor-pointer whitespace-nowrap',
                authUser
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                  : 'bg-sky-50 text-sky-700 border-sky-200 hover:bg-sky-100'
              )}
              title={
                authUser
                  ? `クラウド同期中 (${authUser.email ?? ''})`
                  : 'ログインしてクラウド同期を利用する'
              }
            >
              {authUser ? (
                <>
                  <Cloud
                    className={cn(
                      'h-3 w-3 text-emerald-600 shrink-0',
                      isSyncing && 'animate-pulse'
                    )}
                  />
                  <span className="hidden md:inline">
                    {isSyncing ? '同期中' : 'クラウド同期'}
                  </span>
                </>
              ) : (
                <>
                  <LogIn className="h-3 w-3 text-sky-600 shrink-0" />
                  <span className="hidden md:inline">ログイン</span>
                </>
              )}
            </button>
          )}

          {/* オフライン警告 (ネットワーク切断時のみ) */}
          {!isOnline && (
            <div className="flex items-center space-x-1 rounded-full bg-amber-50 border border-amber-300 px-2 py-0.5 text-[11px] sm:text-xs font-bold text-amber-800 whitespace-nowrap">
              <WifiOff className="h-3 w-3 text-amber-600 shrink-0" />
              <span className="hidden sm:inline">オフライン</span>
            </div>
          )}

          {/* 家族閲覧ロールバッジ (閲覧専用アカウント時のみ控えめに表示) */}
          {isReadOnly && (
            <div className="flex items-center space-x-1 text-[11px] sm:text-xs font-bold text-rose-700 bg-rose-50 px-2 sm:px-2.5 py-0.5 rounded-full border border-rose-200 whitespace-nowrap">
              <Users className="h-3 w-3 text-rose-500 shrink-0" />
              <span>閲覧専用</span>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
