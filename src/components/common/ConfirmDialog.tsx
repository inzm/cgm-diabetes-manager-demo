import React, { useEffect } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { useAnimatedModal } from '@/lib/useAnimatedModal';
import { cn } from '@/lib/utils';

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning';
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  confirmLabel = '実行する',
  cancelLabel = 'キャンセル',
  variant = 'danger',
  onConfirm,
  onCancel,
}) => {
  const { shouldRender, isVisible } = useAnimatedModal(isOpen, 200);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!shouldRender) return null;

  return (
    <div
      className={cn(
        'fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-900/55 backdrop-blur-xs transition-opacity duration-200 ease-out',
        isVisible ? 'opacity-100' : 'opacity-0'
      )}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div
        className="fixed inset-0"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div
        className={cn(
          'relative z-10 w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]',
          isVisible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-2'
        )}
      >
        <div className="p-5 space-y-3.5">
          <div className="flex items-start space-x-3">
            <div
              className={cn(
                'p-2.5 rounded-xl shrink-0',
                variant === 'danger'
                  ? 'bg-rose-50 text-rose-600 border border-rose-200/70'
                  : 'bg-amber-50 text-amber-600 border border-amber-200/70'
              )}
            >
              {variant === 'danger' ? (
                <Trash2 className="w-5 h-5" />
              ) : (
                <AlertTriangle className="w-5 h-5" />
              )}
            </div>
            <div className="space-y-1 min-w-0 flex-1">
              <h4
                id="confirm-dialog-title"
                className="text-sm font-extrabold text-slate-800"
              >
                {title}
              </h4>
              <p className="text-xs text-slate-600 leading-relaxed whitespace-pre-line">
                {message}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5 pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="min-h-[42px] px-3 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-xs font-bold text-slate-700 transition-colors cursor-pointer"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className={cn(
                'min-h-[42px] px-3 py-2 rounded-xl text-xs font-bold text-white transition-all shadow-2xs cursor-pointer active:scale-95',
                variant === 'danger'
                  ? 'bg-rose-600 hover:bg-rose-700'
                  : 'bg-amber-600 hover:bg-amber-700'
              )}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
