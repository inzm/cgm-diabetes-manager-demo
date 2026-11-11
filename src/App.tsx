import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Header } from '@/components/common/Header';
import { OfflineBanner } from '@/components/common/OfflineBanner';
import { AuthGateScreen } from '@/components/common/AuthGateScreen';
import {
  DemoWelcomeModal,
  shouldShowDemoWelcomeModal,
} from '@/components/common/DemoWelcomeModal';
import { usePatient } from '@/contexts/PatientContext';
import { db, requestPersistentStorage } from '@/lib/db';
import {
  invalidateAnalysisDatasetCache,
  invalidateInMemoryRecentCache,
  isDemoCsvImportDisabled,
  isPortfolioMode,
  resetDemoDataToInitialState,
} from '@/lib/realGlucoseLoader';
import { CalendarView, clearCalendarMonthlyCache } from '@/components/calendar/CalendarView';
import { BottomNav, NAV_TAB_ORDER, NavTabType } from '@/components/common/BottomNav';
import { registerUiCacheInvalidator } from '@/lib/syncEngine';
import {
  Calendar,
  FolderKanban,
  BarChart3,
  Settings,
  FileSpreadsheet,
  RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';

registerUiCacheInvalidator(() => {
  clearCalendarMonthlyCache();
});

// 初期表示（カレンダー画面）以外のサブビュー・モーダルを遅延読み込み (Code Splitting)
const FoodMasterView = lazy(() =>
  import('@/components/foods/FoodMasterView').then((m) => ({ default: m.FoodMasterView }))
);
const AnalysisView = lazy(() =>
  import('@/components/analysis/AnalysisView').then((m) => ({ default: m.AnalysisView }))
);
const SettingsView = lazy(() =>
  import('@/components/settings/SettingsView').then((m) => ({ default: m.SettingsView }))
);
const CsvImportModal = lazy(() =>
  import('@/components/import/CsvImportModal').then((m) => ({ default: m.CsvImportModal }))
);
const MealRecordModal = lazy(() =>
  import('@/components/records/MealRecordModal').then((m) => ({ default: m.MealRecordModal }))
);
const ActivityRecordModal = lazy(() =>
  import('@/components/records/ActivityRecordModal').then((m) => ({
    default: m.ActivityRecordModal,
  }))
);

const ViewLoadingFallback: React.FC = () => (
  <div className="max-w-7xl mx-auto px-4 py-12 text-center">
    <div className="bg-white p-10 rounded-3xl border border-slate-200 shadow-xs inline-flex flex-col items-center space-y-2.5">
      <RefreshCw className="w-6 h-6 text-sky-500 animate-spin" />
      <p className="text-xs font-semibold text-slate-600">画面を読み込み中...</p>
    </div>
  </div>
);

function shouldIgnoreContentSwipe(
  target: EventTarget | null,
  container: HTMLElement | null
): boolean {
  if (!(target instanceof Element)) return false;
  if (
    target.closest(
      'input, select, textarea, [contenteditable="true"], [role="dialog"], [aria-modal="true"], .fixed.inset-0, [data-swipe-ignore="true"]'
    )
  ) {
    return true;
  }
  let el: HTMLElement | null = target instanceof HTMLElement ? target : target.parentElement;
  while (el && el !== container && el !== document.body) {
    if (el.scrollWidth > el.clientWidth + 2) {
      const style = window.getComputedStyle(el);
      if (
        el.classList.contains('overflow-x-auto') ||
        el.classList.contains('overflow-x-scroll') ||
        style.overflowX === 'auto' ||
        style.overflowX === 'scroll'
      ) {
        return true;
      }
    }
    el = el.parentElement;
  }
  return false;
}

export const App: React.FC = () => {
  const {
    currentPatientId,
    isReadOnly,
    updateClinicalThresholds,
    isAuthRequired,
    isAuthLoading,
    authUser,
    isAccessAuthorized,
  } = usePatient();
  const [activeTab, setActiveTab] = useState<NavTabType>('calendar');
  const prevTabRef = useRef<NavTabType>('calendar');
  const tabDirectionRef = useRef<'forward' | 'backward' | null>(null);
  if (prevTabRef.current !== activeTab) {
    const prevIdx = NAV_TAB_ORDER.indexOf(prevTabRef.current);
    const nextIdx = NAV_TAB_ORDER.indexOf(activeTab);
    if (prevIdx !== -1 && nextIdx !== -1) {
      tabDirectionRef.current = nextIdx > prevIdx ? 'forward' : 'backward';
    }
    prevTabRef.current = activeTab;
  }
  const tabTransitionDirection = tabDirectionRef.current;

  const [isWelcomeModalOpen, setIsWelcomeModalOpen] = useState<boolean>(() =>
    shouldShowDemoWelcomeModal()
  );
  const [isImportModalOpen, setIsImportModalOpen] = useState<boolean>(false);
  const [hasOpenedImportModal, setHasOpenedImportModal] = useState<boolean>(false);
  const [isMealModalOpen, setIsMealModalOpen] = useState<boolean>(false);
  const [hasOpenedMealModal, setHasOpenedMealModal] = useState<boolean>(false);
  const [isActivityModalOpen, setIsActivityModalOpen] = useState<boolean>(false);
  const [hasOpenedActivityModal, setHasOpenedActivityModal] = useState<boolean>(false);
  const [refreshKey, setRefreshKey] = useState<number>(0);

  const handleCloseWelcomeModal = () => {
    setIsWelcomeModalOpen(false);
  };

  // クラウド同期完了時に画面を自動再描画
  useEffect(() => {
    const handleCloudSynced = () => {
      clearCalendarMonthlyCache();
      setRefreshKey((k) => k + 1);
    };
    window.addEventListener('cgm-cloud-sync-updated', handleCloudSynced);
    return () => window.removeEventListener('cgm-cloud-sync-updated', handleCloudSynced);
  }, []);

  useEffect(() => {
    const handlePageShow = (e: PageTransitionEvent) => {
      if (!e.persisted || !isDemoCsvImportDisabled()) return;
      if (shouldShowDemoWelcomeModal()) {
        setIsWelcomeModalOpen(true);
      }
      void (async () => {
        await resetDemoDataToInitialState(currentPatientId);
        updateClinicalThresholds(70, 180);
        clearCalendarMonthlyCache();
        try {
          const foodMod = await import('@/components/foods/FoodMasterView');
          foodMod.invalidateFoodMasterMemoryCache(currentPatientId);
        } catch {
          // Ignore if chunk load fails
        }
        setRefreshKey((k) => k + 1);
      })();
    };
    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, [currentPatientId, updateClinicalThresholds]);

  // カレンダー画面・ヘッダー共通の年月状態（初期表示は最新データ月 2026年8月、表示・移動上限は常に現在の日付の年月）
  const today = useState(() => new Date())[0];
  const maxYear = today.getFullYear();
  const maxMonth = today.getMonth() + 1;
  const [calYear, setCalYear] = useState<number>(() => (isPortfolioMode() ? 2026 : maxYear));
  const [calMonth, setCalMonth] = useState<number>(() => (isPortfolioMode() ? 8 : maxMonth));
  const isCsvImportDisabledByDemo = isDemoCsvImportDisabled();

  const isAtLatestMonth =
    calYear > maxYear || (calYear === maxYear && calMonth >= maxMonth);

  const handlePrevMonth = () => {
    if (calMonth === 1) {
      setCalYear((y) => y - 1);
      setCalMonth(12);
    } else {
      setCalMonth((m) => m - 1);
    }
  };

  const handleNextMonth = () => {
    if (calYear > maxYear || (calYear === maxYear && calMonth >= maxMonth)) {
      return;
    }
    if (calMonth === 12) {
      setCalYear((y) => y + 1);
      setCalMonth(1);
    } else {
      setCalMonth((m) => m + 1);
    }
  };

  const handleToday = () => {
    setCalYear(maxYear);
    setCalMonth(maxMonth);
  };

  const handleChangeMonth = (newYear: number, newMonth: number) => {
    if (newYear > maxYear || (newYear === maxYear && newMonth > maxMonth)) {
      setCalYear(maxYear);
      setCalMonth(maxMonth);
      return;
    }
    setCalYear(newYear);
    setCalMonth(newMonth);
  };

  const contentContainerRef = useRef<HTMLDivElement>(null);
  const contentTouchStartX = useRef<number | null>(null);
  const contentTouchStartY = useRef<number | null>(null);
  const contentTouchIgnored = useRef<boolean>(false);

  const isAnyAppModalOpen =
    isWelcomeModalOpen || isImportModalOpen || isMealModalOpen || isActivityModalOpen;

  const handleContentTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (
      isAnyAppModalOpen ||
      shouldIgnoreContentSwipe(e.target, contentContainerRef.current) ||
      document.querySelector('[role="dialog"], [aria-modal="true"], .fixed.inset-0.z-50')
    ) {
      contentTouchIgnored.current = true;
      contentTouchStartX.current = null;
      contentTouchStartY.current = null;
      return;
    }
    const touch = e.touches?.[0] ?? e.changedTouches?.[0];
    if (!touch) return;
    contentTouchIgnored.current = false;
    contentTouchStartX.current = touch.clientX;
    contentTouchStartY.current = touch.clientY;
  };

  const handleContentTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (
      contentTouchIgnored.current ||
      contentTouchStartX.current === null ||
      contentTouchStartY.current === null
    ) {
      contentTouchIgnored.current = false;
      contentTouchStartX.current = null;
      contentTouchStartY.current = null;
      return;
    }

    const touch = e.changedTouches?.[0] ?? e.touches?.[0];
    const startX = contentTouchStartX.current;
    const startY = contentTouchStartY.current;
    contentTouchStartX.current = null;
    contentTouchStartY.current = null;

    if (!touch) return;
    if ((e.nativeEvent as unknown as Record<string, boolean>).__cgmSwipeHandled) {
      return;
    }
    if (
      isAnyAppModalOpen ||
      document.querySelector('[role="dialog"], [aria-modal="true"], .fixed.inset-0.z-50')
    ) {
      return;
    }

    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;

    if (Math.abs(deltaX) > Math.abs(deltaY) * 1.2 && Math.abs(deltaX) > 50) {
      if (activeTab === 'calendar') {
        if (deltaX > 0) {
          handlePrevMonth();
        } else if (isAtLatestMonth) {
          setActiveTab('events');
        } else {
          handleNextMonth();
        }
        return;
      }

      const currentIdx = NAV_TAB_ORDER.indexOf(activeTab);
      if (currentIdx === -1) return;
      if (deltaX < 0 && currentIdx < NAV_TAB_ORDER.length - 1) {
        setActiveTab(NAV_TAB_ORDER[currentIdx + 1]);
      } else if (deltaX > 0 && currentIdx > 0) {
        setActiveTab(NAV_TAB_ORDER[currentIdx - 1]);
      }
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!isPortfolioMode()) {
        void requestPersistentStorage();
      }
      void db.open().catch(() => {});
      // オフライン切断後（電車移動中等）でもサブ画面・モーダルがネットワークチャンク読込エラーにならないようアイドル時にバックグラウンド先読み
      void Promise.allSettled([
        import('@/components/daily/DailyDetailDrawer'),
        import('@/components/daily/DailyGlucoseChart'),
        import('@/components/records/MealRecordModal'),
        import('@/components/records/ActivityRecordModal'),
        import('@/components/foods/FoodMasterView'),
        import('@/components/analysis/AnalysisView'),
        import('@/components/settings/SettingsView'),
        ...(isDemoCsvImportDisabled() ? [] : [import('@/components/import/CsvImportModal')]),
      ]).then(() => {
        document.documentElement.setAttribute('data-chunks-warmed', 'true');
      });
    }, 200);
    return () => window.clearTimeout(timer);
  }, []);

  if (isAuthRequired && (isAuthLoading || !authUser || !isAccessAuthorized)) {
    return (
      <div className="min-h-screen overflow-x-clip bg-slate-100/75 flex flex-col font-sans">
        <OfflineBanner />
        <AuthGateScreen />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'min-h-screen overflow-x-clip bg-slate-100/75 flex flex-col font-sans',
        activeTab === 'calendar' && 'max-sm:h-[100dvh] max-sm:min-h-0 max-sm:overflow-hidden'
      )}
    >
      {/* 1. ブランドヘッダー & カレンダー年月操作バー */}
      <Header
        activeTab={activeTab}
        onNavigateToSettings={() => setActiveTab('settings')}
        calendarControls={
          activeTab === 'calendar'
            ? {
                year: calYear,
                month: calMonth,
                onPrevMonth: handlePrevMonth,
                onNextMonth: handleNextMonth,
                onToday: handleToday,
                onRefresh: () => setRefreshKey((k) => k + 1),
                isNextMonthDisabled: isAtLatestMonth,
              }
            : undefined
        }
      />

      {/* オフライン状態検知バナー */}
      <OfflineBanner />

      {/* 2. PC用サブナビゲーションバー (モバイルのボトムナビと同じ4画面タブ構成 + CSV取込) */}
      <div className="hidden sm:block bg-white border-b border-slate-200/90">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-1.5 flex items-center justify-between gap-3">
          {/* メイン画面タブ (モバイルのボトムナビと完全統一) */}
          <nav className="flex space-x-1.5 overflow-x-auto">
            <button
              onClick={() => setActiveTab('calendar')}
              className={cn(
                'flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg text-xs sm:text-sm font-bold transition-all cursor-pointer whitespace-nowrap',
                activeTab === 'calendar'
                  ? 'bg-slate-900 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
              )}
            >
              <Calendar className="h-4 w-4 text-sky-400" />
              <span>カレンダー</span>
            </button>

            <button
              onClick={() => setActiveTab('events')}
              className={cn(
                'flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg text-xs sm:text-sm font-bold transition-all cursor-pointer whitespace-nowrap',
                activeTab === 'events'
                  ? 'bg-slate-900 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
              )}
            >
              <FolderKanban className="h-4 w-4 text-amber-400" />
              <span>食品・活動</span>
            </button>

            <button
              onClick={() => setActiveTab('analysis')}
              className={cn(
                'flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg text-xs sm:text-sm font-bold transition-all cursor-pointer whitespace-nowrap',
                activeTab === 'analysis'
                  ? 'bg-slate-900 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
              )}
            >
              <BarChart3 className="h-4 w-4 text-indigo-400" />
              <span>分析</span>
            </button>

            <button
              onClick={() => setActiveTab('settings')}
              className={cn(
                'flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg text-xs sm:text-sm font-bold transition-all cursor-pointer whitespace-nowrap',
                activeTab === 'settings'
                  ? 'bg-slate-900 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
              )}
            >
              <Settings className="h-4 w-4 text-slate-400" />
              <span>設定</span>
            </button>
          </nav>

          {/* 右側: リブレCSV取込ボタンのみ配置 */}
          <div className="flex items-center">
            <button
              disabled={isReadOnly || isCsvImportDisabledByDemo}
              onClick={() => {
                if (isReadOnly || isCsvImportDisabledByDemo) return;
                setHasOpenedImportModal(true);
                setIsImportModalOpen(true);
              }}
              className={cn(
                'flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all',
                isReadOnly || isCsvImportDisabledByDemo
                  ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed'
                  : 'bg-sky-50 text-sky-700 border border-sky-200 hover:bg-sky-100 cursor-pointer active:scale-95'
              )}
              title={
                isCsvImportDisabledByDemo
                  ? 'デモアプリでは利用できません'
                  : isReadOnly
                    ? '家族ロール（閲覧専用）のため取込できません'
                    : 'リブレCSV取込'
              }
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              <span>CSV取込</span>
              {isCsvImportDisabledByDemo && (
                <span className="text-[10px] font-medium text-slate-400">
                  （デモアプリでは利用できません）
                </span>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* 3. メインビュー切り替え (日次詳細はカレンダードロワーに集約 / 左右スワイプによるタブ遷移対応) */}
      <div
        ref={contentContainerRef}
        onTouchStart={handleContentTouchStart}
        onTouchEnd={handleContentTouchEnd}
        data-testid="main-content-area"
        className={cn(
          'flex-1 overflow-x-clip pb-[calc(4.5rem+env(safe-area-inset-bottom))] sm:pb-0',
          activeTab === 'calendar' && 'max-sm:flex max-sm:flex-col max-sm:min-h-0 max-sm:overflow-hidden'
        )}
      >
        <div
          key={activeTab}
          data-testid="tab-transition-container"
          data-transition-direction={tabTransitionDirection ?? 'none'}
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget) {
              e.currentTarget.style.animation = 'none';
            }
          }}
          onClickCapture={(e) => {
            e.currentTarget.style.animation = 'none';
          }}
          className={cn(
            activeTab === 'calendar' &&
              'flex-1 min-h-0 flex flex-col max-sm:h-full max-sm:overflow-hidden',
            tabTransitionDirection === 'forward' && 'cgm-slide-fade-forward',
            tabTransitionDirection === 'backward' && 'cgm-slide-fade-backward'
          )}
        >
          {activeTab === 'calendar' && (
            <CalendarView
              refreshKey={refreshKey}
              year={calYear}
              month={calMonth}
              isAtLatestMonth={isAtLatestMonth}
              onPrevMonth={handlePrevMonth}
              onNextMonth={handleNextMonth}
              onChangeMonth={handleChangeMonth}
              onSwipePastLatestMonth={() => setActiveTab('events')}
            />
          )}

          {activeTab === 'events' && (
            <Suspense fallback={<ViewLoadingFallback />}>
              <FoodMasterView key={refreshKey} />
            </Suspense>
          )}

          {activeTab === 'analysis' && (
            <Suspense fallback={<ViewLoadingFallback />}>
              <AnalysisView key={refreshKey} />
            </Suspense>
          )}

          {activeTab === 'settings' && (
            <Suspense fallback={<ViewLoadingFallback />}>
              <SettingsView
                onSettingsChanged={() => {
                  clearCalendarMonthlyCache();
                  invalidateAnalysisDatasetCache();
                  invalidateInMemoryRecentCache(currentPatientId);
                  setRefreshKey((k) => k + 1);
                }}
              />
            </Suspense>
          )}
        </div>
      </div>

      {/* モバイル用 ボトムナビゲーションバー (カレンダー、食品・活動、記録、分析、設定) */}
      <BottomNav
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onOpenMealModal={() => {
          setHasOpenedMealModal(true);
          setIsMealModalOpen(true);
        }}
        onOpenActivityModal={() => {
          setHasOpenedActivityModal(true);
          setIsActivityModalOpen(true);
        }}
        onOpenImportModal={() => {
          setHasOpenedImportModal(true);
          setIsImportModalOpen(true);
        }}
      />

      {/* CSV取込モーダル（開いた時のみチャンクを読み込み、フェードアウトアニメーションを保持） */}
      {(isImportModalOpen || hasOpenedImportModal) && (
        <Suspense fallback={null}>
          <CsvImportModal
            isOpen={isImportModalOpen}
            onClose={() => setIsImportModalOpen(false)}
            onImportSuccess={(latestDateStr) => {
              if (latestDateStr && latestDateStr.length >= 7) {
                const y = parseInt(latestDateStr.slice(0, 4), 10);
                const m = parseInt(latestDateStr.slice(5, 7), 10);
                if (!isNaN(y) && !isNaN(m)) {
                  handleChangeMonth(y, m);
                }
              }
              setRefreshKey((k) => k + 1);
            }}
          />
        </Suspense>
      )}

      {/* 食事記録モーダル（開いた時のみチャンクを読み込み、フェードアウトアニメーションを保持） */}
      {(isMealModalOpen || hasOpenedMealModal) && (
        <Suspense fallback={null}>
          <MealRecordModal
            isOpen={isMealModalOpen}
            onClose={() => setIsMealModalOpen(false)}
            onSuccess={() => setRefreshKey((k) => k + 1)}
          />
        </Suspense>
      )}

      {/* 活動記録モーダル（開いた時のみチャンクを読み込み、フェードアウトアニメーションを保持） */}
      {(isActivityModalOpen || hasOpenedActivityModal) && (
        <Suspense fallback={null}>
          <ActivityRecordModal
            isOpen={isActivityModalOpen}
            onClose={() => setIsActivityModalOpen(false)}
            onSuccess={() => setRefreshKey((k) => k + 1)}
          />
        </Suspense>
      )}

      {/* デモ環境案内モーダル（ページアクセス時・再読み込み時に毎回表示＝初期化の目印） */}
      <DemoWelcomeModal isOpen={isWelcomeModalOpen} onClose={handleCloseWelcomeModal} />
    </div>
  );
};
