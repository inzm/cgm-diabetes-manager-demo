import React, { useState, useEffect } from 'react';
import { EventMaster, Category } from '@/types/database';
import { db } from '@/lib/db';
import { invalidateAnalysisDatasetCache } from '@/lib/realGlucoseLoader';
import { triggerBackgroundCloudSync } from '@/lib/syncEngine';
import { usePatient } from '@/contexts/PatientContext';
import { X, Footprints, Check, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

interface EventEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  categories: Category[];
  editItem?: EventMaster | null;
  onRequestDelete?: (id: string) => void;
}

export const EventEditModal: React.FC<EventEditModalProps> = ({
  isOpen,
  onClose,
  onSaved,
  categories,
  editItem,
  onRequestDelete,
}) => {
  const { currentPatientId, isReadOnly } = usePatient();

  const [eventName, setEventName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [defaultDuration, setDefaultDuration] = useState('30');
  const [memo, setMemo] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setErrorMsg(null);
      setShowDiscardConfirm(false);
      if (editItem) {
        setEventName(editItem.event_name);
        setCategoryId(editItem.category_id || (categories[0]?.id ?? ''));
        setDefaultDuration(String(editItem.default_duration ?? 30));
        setMemo(editItem.memo || '');
      } else {
        setEventName('');
        setCategoryId(categories[0]?.id ?? '');
        setDefaultDuration('30');
        setMemo('');
      }
    }
  }, [isOpen, editItem]);

  useEffect(() => {
    if (isOpen && !editItem && !categoryId && categories.length > 0) {
      setCategoryId(categories[0].id);
    }
  }, [isOpen, editItem, categoryId, categories]);

  const [shouldRender, setShouldRender] = useState<boolean>(isOpen);
  const [isVisible, setIsVisible] = useState<boolean>(false);

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      const rafId = window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setIsVisible(true);
        });
      });
      return () => window.cancelAnimationFrame(rafId);
    } else {
      setIsVisible(false);
      const timerId = window.setTimeout(() => {
        setShouldRender(false);
      }, 220);
      return () => window.clearTimeout(timerId);
    }
  }, [isOpen]);

  if (!shouldRender) return null;

  const defaultCatId = categories[0]?.id ?? '';
  const isDirty = editItem
    ? eventName.trim() !== editItem.event_name.trim() ||
      categoryId !== (editItem.category_id || defaultCatId) ||
      defaultDuration.trim() !== String(editItem.default_duration ?? 30) ||
      memo.trim() !== (editItem.memo || '').trim()
    : eventName.trim() !== '' ||
      (categoryId !== '' && categoryId !== defaultCatId) ||
      defaultDuration.trim() !== '30' ||
      memo.trim() !== '';

  const handleRequestClose = () => {
    if (isDirty) {
      setShowDiscardConfirm(true);
      return;
    }
    onClose();
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly) return;

    const trimmedName = eventName.trim();
    const numDuration = parseInt(defaultDuration, 10);

    if (!trimmedName) {
      setErrorMsg('活動名を入力してください。');
      return;
    }
    if (isNaN(numDuration) || numDuration < 0) {
      setErrorMsg('標準実施時間（分）には0以上の数値を入力してください。');
      return;
    }

    const now = new Date().toISOString();

    try {
      if (editItem) {
        await db.event_master.update(editItem.id, {
          event_name: trimmedName,
          category_id: categoryId || undefined,
          default_duration: numDuration,
          memo: memo.trim() || undefined,
          updated_at: now,
        });
      } else {
        const newEvent: EventMaster = {
          id: crypto.randomUUID(),
          user_id: currentPatientId,
          category_id: categoryId || undefined,
          event_name: trimmedName,
          default_duration: numDuration,
          memo: memo.trim() || undefined,
          is_deleted: false,
          created_at: now,
          updated_at: now,
        };
        await db.event_master.add(newEvent);
      }

      invalidateAnalysisDatasetCache();
      triggerBackgroundCloudSync(currentPatientId);
      onSaved();
      onClose();
    } catch (err) {
      console.error('Failed to save activity item:', err);
      setErrorMsg('保存中にエラーが発生しました。');
    }
  };

  return (
    <div
      onClick={handleBackdropClick}
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs transition-opacity duration-200 ease-out',
        isVisible ? 'opacity-100' : 'opacity-0'
      )}
    >
      <div
        className={cn(
          'relative w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden transition-all duration-220 ease-[cubic-bezier(0.16,1,0.3,1)]',
          isVisible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-3'
        )}
      >
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50">
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-lg bg-emerald-100 text-emerald-700">
              <Footprints className="w-5 h-5" />
            </span>
            <h3 className="text-base font-bold text-slate-800">
              {editItem ? '活動を編集' : '活動を登録'}
            </h3>
          </div>
          <button
            type="button"
            onClick={handleRequestClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200/60 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* フォーム */}
        <form onSubmit={handleSave} className="p-6 space-y-4">
          {errorMsg && (
            <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700 font-medium">
              {errorMsg}
            </div>
          )}

          {/* 活動名 */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              活動名 <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              value={eventName}
              onChange={(e) => setEventName(e.target.value)}
              placeholder="例: ウォーキング, 入浴, ブドウ糖補食"
              className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm focus:outline-hidden focus:ring-2 focus:ring-emerald-500"
              required
            />
          </div>

          {/* カテゴリ & 標準時間 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                カテゴリ
              </label>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm bg-white focus:outline-hidden focus:ring-2 focus:ring-emerald-500"
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.category_name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                標準実施時間 (分)
              </label>
              <input
                type="number"
                min="0"
                step="5"
                value={defaultDuration}
                onChange={(e) => setDefaultDuration(e.target.value)}
                className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm focus:outline-hidden focus:ring-2 focus:ring-emerald-500"
              />
            </div>
          </div>

          {/* メモ */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              補足メモ (任意)
            </label>
            <input
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="例: 食後の有酸素運動（目安30分）"
              className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm focus:outline-hidden focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          {/* フッター */}
          <div className="flex items-center justify-between gap-2 pt-3 border-t border-slate-200">
            {editItem && onRequestDelete && !isReadOnly ? (
              <button
                type="button"
                onClick={() => {
                  const targetId = editItem.id;
                  onClose();
                  onRequestDelete(targetId);
                }}
                className="inline-flex items-center gap-1 px-3 py-2 rounded-xl border border-rose-200 bg-rose-50/70 hover:bg-rose-100 text-xs font-bold text-rose-600 cursor-pointer transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>削除</span>
              </button>
            ) : (
              <div />
            )}

            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={handleRequestClose}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100 cursor-pointer"
              >
                キャンセル
              </button>
              <button
                type="submit"
                disabled={isReadOnly}
                className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-700 shadow-xs cursor-pointer active:scale-95"
              >
                <Check className="w-4 h-4" />
                <span>保存する</span>
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* 未保存変更の破棄確認ダイアログ */}
      <ConfirmDialog
        isOpen={showDiscardConfirm}
        title="入力データの破棄確認"
        message="入力中の内容が保存されていません。破棄して閉じてもよろしいですか？"
        confirmLabel="破棄して閉じる"
        cancelLabel="編集を続ける"
        variant="danger"
        onConfirm={() => {
          setShowDiscardConfirm(false);
          onClose();
        }}
        onCancel={() => setShowDiscardConfirm(false)}
      />
    </div>
  );
};
