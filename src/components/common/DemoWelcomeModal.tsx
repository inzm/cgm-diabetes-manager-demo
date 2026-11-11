import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { isDemoCsvImportDisabled } from '@/lib/realGlucoseLoader';

export function shouldShowDemoWelcomeModal(): boolean {
  if (!isDemoCsvImportDisabled()) return false;
  if (typeof window === 'undefined') return false;
  if ((window as unknown as Record<string, unknown>).__CGM_E2E_SUPPRESS_WELCOME__ === true) {
    return false;
  }
  return true;
}

export interface DemoWelcomeModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DemoWelcomeModal: React.FC<DemoWelcomeModalProps> = ({ isOpen, onClose }) => {
  const dialogCardRef = useRef<HTMLDivElement>(null);
  const startButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    startButtonRef.current?.focus({ preventScroll: true });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab' && dialogCardRef.current) {
        const focusable = Array.from(
          dialogCardRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;

        if (e.shiftKey) {
          if (!active || !dialogCardRef.current.contains(active) || active === first) {
            e.preventDefault();
            last.focus({ preventScroll: true });
          }
        } else {
          if (!active || !dialogCardRef.current.contains(active) || active === last) {
            e.preventDefault();
            first.focus({ preventScroll: true });
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/45 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="demo-welcome-modal-title"
      data-testid="demo-welcome-modal"
    >
      <div
        className="fixed inset-0"
        data-testid="demo-welcome-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={dialogCardRef}
        className="relative z-10 w-full max-w-sm sm:max-w-[400px] max-h-[calc(100dvh-2rem)] overflow-y-auto bg-white rounded-2xl shadow-2xl border border-slate-200/90"
      >
        <div className="p-4 sm:p-5 space-y-3.5">
          {/* ヘッダー */}
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
            <h2
              id="demo-welcome-modal-title"
              className="text-sm sm:text-base font-extrabold text-slate-800"
            >
              デモ環境について
            </h2>

            <button
              type="button"
              onClick={onClose}
              aria-label="モーダルを閉じる"
              title="閉じる"
              data-testid="btn-close-welcome-x"
              className="w-8 h-8 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 flex items-center justify-center transition-colors cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* 本文 */}
          <div className="space-y-2.5 text-xs sm:text-[13px] text-slate-700 leading-relaxed">
            <p>
              本アプリは、血糖測定器のデータと日々の食事・活動・インスリンの記録をまとめて管理し、カレンダーやグラフで血糖値の変動を振り返るためのWebアプリです。
            </p>
            <p>
              血糖値や食事・活動の履歴データは予め組み込んであり、食事や活動の記録、よく使う食品・活動は自由に追加や削除、編集を行うことができます。
            </p>
            <p>
              このデモアプリで登録・変更した内容は、お使いのスマートフォンやPCには保存されません。ページを再読み込みするかタブを閉じると、登録・変更した内容は破棄され、初期状態に戻ります。
            </p>
          </div>

          {/* 閉じるボタン */}
          <div className="pt-1">
            <button
              ref={startButtonRef}
              type="button"
              onClick={onClose}
              data-testid="btn-start-demo"
              className="w-full min-h-[42px] py-2.5 px-4 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs sm:text-sm font-bold shadow-xs transition-all cursor-pointer active:scale-[0.99]"
            >
              閉じる
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

