import React, { useState, useEffect } from 'react';
import { X, Check, Search } from 'lucide-react';
import { useAnimatedModal } from '@/lib/useAnimatedModal';
import { cn } from '@/lib/utils';

export interface SelectPickerOption {
  value: string;
  label: string;
}

interface SelectPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  options: SelectPickerOption[];
  selectedValue: string;
  onSelect: (value: string) => void;
  searchable?: boolean;
  searchPlaceholder?: string;
}

/**
 * モバイルでも画面いっぱいに広がらず、常にキャンセル（閉じる / 背景タップ / Escape）できる
 * コンパクトなカスタム選択ピッカーモーダル
 */
export const SelectPickerModal: React.FC<SelectPickerModalProps> = ({
  isOpen,
  onClose,
  title,
  options,
  selectedValue,
  onSelect,
  searchable = false,
  searchPlaceholder = 'キーワードで絞り込み...',
}) => {
  const { shouldRender, isVisible } = useAnimatedModal(isOpen);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (isOpen) {
      setQuery('');
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!shouldRender) return null;

  const trimmed = query.trim().toLowerCase();
  const visibleOptions = trimmed
    ? options.filter((o) => o.label.toLowerCase().includes(trimmed))
    : options;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs transition-opacity duration-200 ease-out',
        isVisible ? 'opacity-100' : 'opacity-0'
      )}
    >
      <div
        className={cn(
          'relative w-full max-w-sm max-h-[75dvh] flex flex-col bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden transition-all duration-220 ease-[cubic-bezier(0.16,1,0.3,1)]',
          isVisible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-3'
        )}
      >
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-slate-50 shrink-0">
          <h3 className="text-sm sm:text-base font-extrabold text-slate-900 truncate">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-200/70 transition-colors cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 検索欄（選択肢が多い場合） */}
        {searchable && (
          <div className="px-3.5 py-2.5 border-b border-slate-100 bg-white shrink-0">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full min-h-[40px] pl-9 pr-3 py-1.5 rounded-xl border border-slate-200 bg-slate-50 text-sm text-slate-800 focus:outline-none focus:bg-white focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>
        )}

        {/* 選択肢リスト（画面を埋め尽くさない最大高さ制限＆内部スクロール） */}
        <div className="overflow-y-auto overscroll-contain max-h-[48dvh] p-2 space-y-1">
          {visibleOptions.length === 0 ? (
            <div className="py-8 text-center text-xs sm:text-sm text-slate-400">
              該当する項目がありません
            </div>
          ) : (
            visibleOptions.map((opt) => {
              const isSelected = opt.value === selectedValue;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    onSelect(opt.value);
                    onClose();
                  }}
                  className={cn(
                    'w-full min-h-[44px] flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl text-left text-sm font-semibold transition-colors cursor-pointer',
                    isSelected
                      ? 'bg-indigo-50 text-indigo-700 font-bold'
                      : 'text-slate-700 hover:bg-slate-100'
                  )}
                >
                  <span className="truncate">{opt.label}</span>
                  {isSelected && <Check className="w-4 h-4 text-indigo-600 shrink-0" />}
                </button>
              );
            })
          )}
        </div>

        {/* フッター（明示的なキャンセルボタン） */}
        <div className="px-4 py-2.5 border-t border-slate-200 bg-slate-50 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="w-full min-h-[42px] rounded-xl border border-slate-300 bg-white hover:bg-slate-100 text-sm font-bold text-slate-700 transition-colors cursor-pointer active:scale-[0.99]"
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
};
