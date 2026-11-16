import React, { useState, useEffect, useRef } from 'react';
import {
  Calendar,
  FolderKanban,
  BarChart3,
  Settings,
  Plus,
  X,
  Utensils,
  Footprints,
  FileSpreadsheet,
  Lock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePatient } from '@/contexts/PatientContext';
import { isDemoCsvImportDisabled } from '@/lib/realGlucoseLoader';

export type NavTabType = 'calendar' | 'events' | 'analysis' | 'settings';

export const NAV_TAB_ORDER: readonly NavTabType[] = [
  'calendar',
  'events',
  'analysis',
  'settings',
];

interface BottomNavProps {
  activeTab: NavTabType;
  onTabChange: (tab: NavTabType) => void;
  onOpenMealModal: () => void;
  onOpenActivityModal: () => void;
  onOpenImportModal: () => void;
}

export const BottomNav: React.FC<BottomNavProps> = ({
  activeTab,
  onTabChange,
  onOpenMealModal,
  onOpenActivityModal,
  onOpenImportModal,
}) => {
  const { isReadOnly } = usePatient();
  const isCsvImportDisabledByDemo = isDemoCsvImportDisabled();
  const [isRecordMenuOpen, setIsRecordMenuOpen] = useState(false);
  const [shouldRenderMenu, setShouldRenderMenu] = useState(false);
  const [isMenuVisible, setIsMenuVisible] = useState(false);

  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const didSwipeRef = useRef<boolean>(false);

  useEffect(() => {
    if (isRecordMenuOpen) {
      setShouldRenderMenu(true);
      const rafId = window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setIsMenuVisible(true);
        });
      });
      return () => window.cancelAnimationFrame(rafId);
    } else {
      setIsMenuVisible(false);
      const timerId = window.setTimeout(() => {
        setShouldRenderMenu(false);
      }, 200);
      return () => window.clearTimeout(timerId);
    }
  }, [isRecordMenuOpen]);

  const handleTouchStart = (e: React.TouchEvent) => {
    didSwipeRef.current = false;
    if (document.querySelector('[role="dialog"], [aria-modal="true"], .fixed.inset-0.z-50')) {
      touchStartX.current = null;
      touchStartY.current = null;
      return;
    }
    const touch = e.touches?.[0] ?? e.changedTouches?.[0];
    if (!touch) return;
    touchStartX.current = touch.clientX;
    touchStartY.current = touch.clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const touch = e.changedTouches?.[0] ?? e.touches?.[0];
    const startX = touchStartX.current;
    const startY = touchStartY.current;
    touchStartX.current = null;
    touchStartY.current = null;
    if (!touch) return;
    if (document.querySelector('[role="dialog"], [aria-modal="true"], .fixed.inset-0.z-50')) {
      return;
    }

    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;

    if (Math.abs(deltaX) > Math.abs(deltaY) * 1.2 && Math.abs(deltaX) > 50) {
      didSwipeRef.current = true;
      setIsRecordMenuOpen(false);
      const currentIdx = NAV_TAB_ORDER.indexOf(activeTab);
      if (currentIdx === -1) return;
      if (deltaX < 0 && currentIdx < NAV_TAB_ORDER.length - 1) {
        onTabChange(NAV_TAB_ORDER[currentIdx + 1]);
      } else if (deltaX > 0 && currentIdx > 0) {
        onTabChange(NAV_TAB_ORDER[currentIdx - 1]);
      }
    }
  };

  const handleTabButtonClick = (tab: NavTabType) => {
    if (didSwipeRef.current) {
      didSwipeRef.current = false;
      return;
    }
    setIsRecordMenuOpen(false);
    onTabChange(tab);
  };

  return (
    <>
      {/* 記録メニュー展開時の背景オーバーレイ */}
      {shouldRenderMenu && (
        <div
          onClick={() => setIsRecordMenuOpen(false)}
          className={cn(
            'fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-40 transition-opacity duration-200 ease-out sm:hidden',
            isMenuVisible ? 'opacity-100' : 'opacity-0'
          )}
        />
      )}

      {/* スピードダイヤルメニュー (記録ボタンから上方向へ展開) */}
      {shouldRenderMenu && (
        <div
          className={cn(
            'fixed bottom-[calc(5.25rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2.5 sm:hidden transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]',
            isMenuVisible ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-3 scale-95'
          )}
        >
          <button
            disabled={isReadOnly || isCsvImportDisabledByDemo}
            onClick={() => {
              if (isReadOnly || isCsvImportDisabledByDemo) return;
              setIsRecordMenuOpen(false);
              onOpenImportModal();
            }}
            title={
              isCsvImportDisabledByDemo
                ? 'デモアプリでは利用できません'
                : isReadOnly
                  ? '家族ロール（閲覧専用）のため取込できません'
                  : 'リブレCSV取込'
            }
            className={cn(
              'flex items-center gap-2 px-4 py-2.5 rounded-full text-xs font-bold shadow-xl transition-all whitespace-nowrap',
              isReadOnly || isCsvImportDisabledByDemo
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200'
                : 'bg-white text-sky-700 border border-sky-200 hover:bg-sky-50 active:scale-95 cursor-pointer'
            )}
          >
            <span
              className={cn(
                'p-1 rounded-full',
                isReadOnly || isCsvImportDisabledByDemo
                  ? 'bg-slate-200 text-slate-400'
                  : 'bg-sky-100 text-sky-600'
              )}
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
            </span>
            <span className="flex flex-col items-start leading-tight">
              <span>リブレCSV取込</span>
              {isCsvImportDisabledByDemo && (
                <span className="text-[10px] font-medium text-slate-400">
                  デモアプリでは利用できません
                </span>
              )}
            </span>
          </button>

          <button
            disabled={isReadOnly}
            onClick={() => {
              setIsRecordMenuOpen(false);
              onOpenActivityModal();
            }}
            className={cn(
              'flex items-center gap-2 px-4 py-2.5 rounded-full text-xs font-bold shadow-xl transition-all active:scale-95 cursor-pointer whitespace-nowrap',
              isReadOnly
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200'
                : 'bg-white text-indigo-700 border border-indigo-200 hover:bg-indigo-50'
            )}
          >
            <span className="p-1 rounded-full bg-indigo-100 text-indigo-600">
              <Footprints className="w-3.5 h-3.5" />
            </span>
            <span>活動・インスリン記録</span>
          </button>

          <button
            disabled={isReadOnly}
            onClick={() => {
              setIsRecordMenuOpen(false);
              onOpenMealModal();
            }}
            className={cn(
              'flex items-center gap-2 px-4 py-2.5 rounded-full text-xs font-bold shadow-xl transition-all active:scale-95 cursor-pointer whitespace-nowrap',
              isReadOnly
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                : 'bg-emerald-600 text-white shadow-emerald-600/30'
            )}
          >
            <span className="p-1 rounded-full bg-emerald-700 text-white">
              <Utensils className="w-3.5 h-3.5" />
            </span>
            <span>食事を新規記録</span>
          </button>
        </div>
      )}

      {/* ボトムナビゲーションバー本体 (5アイテム構成: カレンダー / 食品・活動 / ＋記録 / 分析 / 設定) */}
      <nav
        aria-label="モバイルナビゲーション"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        className="fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-slate-200/90 shadow-lg sm:hidden pb-[env(safe-area-inset-bottom)]"
      >
        <div className="grid grid-cols-5 h-[4.5rem] max-w-lg mx-auto px-1.5 items-stretch">
          {/* 1. カレンダー */}
          <button
            onClick={() => handleTabButtonClick('calendar')}
            className={cn(
              'flex flex-col items-center justify-end h-full pb-3 gap-1.5 transition-colors cursor-pointer',
              activeTab === 'calendar'
                ? 'text-sky-600 font-bold'
                : 'text-slate-400 hover:text-slate-600 font-medium'
            )}
          >
            <Calendar className={cn('w-[22px] h-[22px]', activeTab === 'calendar' && 'stroke-[2.5px]')} />
            <span className="text-[11px] leading-tight tracking-tight whitespace-nowrap">カレンダー</span>
          </button>

          {/* 2. 食品・活動 */}
          <button
            onClick={() => handleTabButtonClick('events')}
            className={cn(
              'flex flex-col items-center justify-end h-full pb-3 gap-1.5 transition-colors cursor-pointer',
              activeTab === 'events'
                ? 'text-amber-600 font-bold'
                : 'text-slate-400 hover:text-slate-600 font-medium'
            )}
          >
            <FolderKanban className={cn('w-[22px] h-[22px]', activeTab === 'events' && 'stroke-[2.5px]')} />
            <span className="text-[11px] leading-tight tracking-tight whitespace-nowrap">食品・活動</span>
          </button>

          {/* 3. 中央: 記録ボタン (センタードックFAB) */}
          <div className="flex flex-col items-center justify-end h-full pb-3 relative">
            <button
              onClick={() => {
                if (didSwipeRef.current) {
                  didSwipeRef.current = false;
                  return;
                }
                setIsRecordMenuOpen(!isRecordMenuOpen);
              }}
              aria-label={isRecordMenuOpen ? '記録メニューを閉じる' : '記録メニューを開く'}
              className={cn(
                'w-11 h-11 -mt-1 rounded-full flex items-center justify-center shadow-md transition-all cursor-pointer active:scale-90',
                isRecordMenuOpen
                  ? 'bg-slate-800 text-white rotate-90 shadow-slate-900/30'
                  : isReadOnly
                  ? 'bg-slate-300 text-slate-500 cursor-not-allowed'
                  : 'bg-emerald-600 hover:bg-emerald-700 text-white ring-2 ring-white shadow-emerald-600/30'
              )}
            >
              {isRecordMenuOpen ? (
                <X className="w-5 h-5" />
              ) : isReadOnly ? (
                <Lock className="w-4 h-4" />
              ) : (
                <Plus className="w-6 h-6 stroke-[2.5px]" />
              )}
            </button>
            <span
              className={cn(
                'text-[11px] leading-tight tracking-tight mt-[3px] font-bold whitespace-nowrap',
                isRecordMenuOpen ? 'text-slate-800' : 'text-emerald-700'
              )}
            >
              記録
            </span>
          </div>

          {/* 4. 分析 */}
          <button
            onClick={() => handleTabButtonClick('analysis')}
            className={cn(
              'flex flex-col items-center justify-end h-full pb-3 gap-1.5 transition-colors cursor-pointer',
              activeTab === 'analysis'
                ? 'text-indigo-600 font-bold'
                : 'text-slate-400 hover:text-slate-600 font-medium'
            )}
          >
            <BarChart3 className={cn('w-[22px] h-[22px]', activeTab === 'analysis' && 'stroke-[2.5px]')} />
            <span className="text-[11px] leading-tight tracking-tight whitespace-nowrap">分析</span>
          </button>

          {/* 5. 設定 */}
          <button
            onClick={() => handleTabButtonClick('settings')}
            className={cn(
              'flex flex-col items-center justify-end h-full pb-3 gap-1.5 transition-colors cursor-pointer',
              activeTab === 'settings'
                ? 'text-slate-900 font-bold'
                : 'text-slate-400 hover:text-slate-600 font-medium'
            )}
          >
            <Settings className={cn('w-[22px] h-[22px]', activeTab === 'settings' && 'stroke-[2.5px]')} />
            <span className="text-[11px] leading-tight tracking-tight whitespace-nowrap">設定</span>
          </button>
        </div>
      </nav>
    </>
  );
};
