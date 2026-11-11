import React, { useState, useEffect, useMemo } from 'react';
import { usePatient } from '@/contexts/PatientContext';
import { db } from '@/lib/db';
import { Category, EventMaster } from '@/types/database';
import { seedFoodMasterIfEmpty } from '@/lib/foodSeed';
import {
  invalidateAnalysisDatasetCache,
  invalidateInMemoryRecentCache,
  pauseBackgroundHydration,
  waitForRecentPersistence,
} from '@/lib/realGlucoseLoader';
import { triggerBackgroundCloudSync } from '@/lib/syncEngine';
import {
  buildWallClockIso,
  extractDateStr,
  extractTimeStr,
  getCurrentLocalTimeStr,
  getTodayLocalDateStr,
} from '@/lib/dateUtils';
import {
  X,
  Footprints,
  Clock,
  Syringe,
  Save,
  Trash2,
  AlertCircle,
  Loader2,
  Lock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

interface ActivityRecordModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  initialDate?: string; // YYYY-MM-DD
  editEventId?: string | null;
}

function serializeActivityState(
  date: string,
  time: string,
  activityType: string,
  eventName: string,
  durationMinutes: string,
  insulinUnits: string,
  memoNote: string
): string {
  return JSON.stringify({
    date,
    time,
    activityType,
    eventName: eventName.trim(),
    durationMinutes: durationMinutes.trim(),
    insulinUnits: insulinUnits.trim(),
    memoNote: memoNote.trim(),
  });
}

export const ActivityRecordModal: React.FC<ActivityRecordModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  initialDate,
  editEventId,
}) => {
  const { currentPatientId, isReadOnly } = usePatient();

  const [date, setDate] = useState<string>(() => initialDate || getTodayLocalDateStr());
  const [time, setTime] = useState<string>(() => getCurrentLocalTimeStr());
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('ALL');
  const [activityType, setActivityType] = useState<string>('運動');
  const [selectedMasterId, setSelectedMasterId] = useState<string>('');
  const [eventName, setEventName] = useState<string>('');
  const [durationMinutes, setDurationMinutes] = useState<string>('30');
  const [insulinUnits, setInsulinUnits] = useState<string>('');
  const [memoNote, setMemoNote] = useState<string>('');
  const [initialSnapshot, setInitialSnapshot] = useState<string>('');

  const [eventCategories, setEventCategories] = useState<Category[]>([]);
  const [eventMasters, setEventMasters] = useState<EventMaster[]>([]);

  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState<boolean>(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 1. 活動カテゴリ & 登録済み活動のロード
  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    async function loadEventMastersAndCategories() {
      pauseBackgroundHydration(currentPatientId, 3000);
      await waitForRecentPersistence(currentPatientId);
      await seedFoodMasterIfEmpty(currentPatientId);
      const [cats, masters] = await Promise.all([
        db.categories
          .where('user_id')
          .equals(currentPatientId)
          .filter((c) => !c.is_deleted && c.target_type === 'event')
          .toArray(),
        db.event_master
          .where('user_id')
          .equals(currentPatientId)
          .filter((e) => !e.is_deleted)
          .toArray(),
      ]);
      if (!active) return;
      cats.sort((a, b) => (a.display_order ?? 99) - (b.display_order ?? 99));
      masters.sort((a, b) => a.event_name.localeCompare(b.event_name, 'ja'));
      setEventCategories(cats);
      setEventMasters(masters);
    }
    loadEventMastersAndCategories();
    return () => {
      active = false;
    };
  }, [isOpen, currentPatientId]);

  // 2. 編集モードまたは新規作成モードの初期値セット
  useEffect(() => {
    if (!isOpen) return;
    if (editEventId) {
      const targetId = editEventId;
      async function loadEditData() {
        try {
          const event = await db.events.get(targetId);
          if (event && !event.is_deleted) {
            const loadedDate = extractDateStr(event.event_datetime);
            const loadedTime = extractTimeStr(event.event_datetime);
            const loadedType = event.timing_category || '運動';
            const rawMemo = event.memo || '';
            const sepIdx = rawMemo.indexOf(' — ');
            const loadedName = sepIdx !== -1 ? rawMemo.slice(0, sepIdx) : rawMemo;
            const loadedNote = sepIdx !== -1 ? rawMemo.slice(sepIdx + 3) : '';
            const loadedDuration = String(event.duration_minutes ?? 0);
            const loadedInsulin =
              event.insulin_units != null && event.insulin_units > 0
                ? String(event.insulin_units)
                : '';

            setDate(loadedDate);
            setTime(loadedTime);
            setActivityType(loadedType);
            setSelectedCategoryId('ALL');
            setSelectedMasterId('');
            setEventName(loadedName);
            setMemoNote(loadedNote);
            setDurationMinutes(loadedDuration);
            setInsulinUnits(loadedInsulin);
            setInitialSnapshot(
              serializeActivityState(
                loadedDate,
                loadedTime,
                loadedType,
                loadedName,
                loadedDuration,
                loadedInsulin,
                loadedNote
              )
            );
            setShowDiscardConfirm(false);
            setShowDeleteConfirm(false);
            setErrorMsg(null);
          }
        } catch (err) {
          console.error('[ActivityRecordModal] Failed to load edit event:', err);
        }
      }
      loadEditData();
    } else {
      const nowDate = initialDate || getTodayLocalDateStr();
      const nowTime = getCurrentLocalTimeStr();
      setDate(nowDate);
      setTime(nowTime);
      setSelectedCategoryId('ALL');
      setActivityType('運動');
      setSelectedMasterId('');
      setEventName('');
      setDurationMinutes('30');
      setInsulinUnits('');
      setMemoNote('');
      setInitialSnapshot(
        serializeActivityState(nowDate, nowTime, '運動', '', '30', '', '')
      );
      setShowDiscardConfirm(false);
      setShowDeleteConfirm(false);
      setErrorMsg(null);
    }
  }, [isOpen, editEventId, initialDate]);

  // 選択中のカテゴリで絞り込んだ活動候補
  const filteredEventMasters = useMemo(() => {
    if (selectedCategoryId === 'ALL') return eventMasters;
    return eventMasters.filter((m) => m.category_id === selectedCategoryId);
  }, [eventMasters, selectedCategoryId]);

  // カテゴリ別グループ化（optgroup表示用）
  const groupedEventMasters = useMemo(() => {
    const groups: { categoryId: string; categoryName: string; items: EventMaster[] }[] = [];
    const knownCatIds = new Set<string>();

    for (const cat of eventCategories) {
      knownCatIds.add(cat.id);
      const items = eventMasters.filter((m) => m.category_id === cat.id);
      if (items.length > 0) {
        groups.push({ categoryId: cat.id, categoryName: cat.category_name, items });
      }
    }

    const uncategorized = eventMasters.filter(
      (m) => !m.category_id || !knownCatIds.has(m.category_id)
    );
    if (uncategorized.length > 0) {
      groups.push({
        categoryId: 'UNCATEGORIZED',
        categoryName: 'その他・未分類',
        items: uncategorized,
      });
    }

    return groups;
  }, [eventCategories, eventMasters]);

  // カテゴリセレクト変更ハンドラ
  const handleSelectCategoryById = (categoryId: string) => {
    setSelectedCategoryId(categoryId);
    if (categoryId === 'ALL') {
      return;
    }
    const cat = eventCategories.find((c) => c.id === categoryId);
    if (!cat) return;

    setActivityType(cat.category_name);

    const firstMaster = eventMasters.find((m) => m.category_id === cat.id);
    if (firstMaster && !editEventId) {
      setSelectedMasterId(firstMaster.id);
      setEventName(firstMaster.event_name);
      setDurationMinutes(String(firstMaster.default_duration ?? 0));
      setMemoNote(firstMaster.memo || '');
      setErrorMsg(null);
    } else if (selectedMasterId) {
      const currentMaster = eventMasters.find((m) => m.id === selectedMasterId);
      if (currentMaster && currentMaster.category_id !== cat.id) {
        setSelectedMasterId('');
      }
    }
  };

  // 登録済み活動選択ハンドラ (標準実施時間・カテゴリ・メモを自動セット)
  const handleSelectEventMaster = (masterId: string) => {
    setSelectedMasterId(masterId);
    if (!masterId) return;
    const master = eventMasters.find((m) => m.id === masterId);
    if (!master) return;

    setEventName(master.event_name);
    setDurationMinutes(String(master.default_duration ?? 0));
    if (master.memo) {
      setMemoNote(master.memo);
    }
    const cat = eventCategories.find((c) => c.id === master.category_id);
    if (cat) {
      setActivityType(cat.category_name);
    }
    setErrorMsg(null);
  };

  // 未保存変更の有無 (isDirty) を判定して閉じる
  const handleRequestClose = () => {
    const currentSnapshot = serializeActivityState(
      date,
      time,
      activityType,
      eventName,
      durationMinutes,
      insulinUnits,
      memoNote
    );
    if (initialSnapshot && currentSnapshot !== initialSnapshot) {
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

  // 保存処理 (ウォールクロック ISO でタイムゾーンズレなく保存)
  const handleSave = async () => {
    if (isReadOnly) return;
    if (!eventName.trim()) {
      setErrorMsg('活動名を入力するか、よく使う活動から選んでください');
      return;
    }

    setIsSaving(true);
    setErrorMsg(null);

    try {
      pauseBackgroundHydration(currentPatientId, 3000);
      await waitForRecentPersistence(currentPatientId);
      const eventDateTimeIso = buildWallClockIso(date, time);
      const insulin = parseFloat(insulinUnits) || 0;
      const duration = Math.max(0, parseInt(durationMinutes, 10) || 0);
      const nowIso = new Date().toISOString();

      const combinedMemo = memoNote.trim()
        ? `${eventName.trim()} — ${memoNote.trim()}`
        : eventName.trim();

      if (editEventId) {
        await db.events.update(editEventId, {
          event_datetime: eventDateTimeIso,
          event_type: '活動',
          timing_category: activityType,
          duration_minutes: duration,
          insulin_units: insulin > 0 ? insulin : undefined,
          memo: combinedMemo,
          updated_at: nowIso,
        });
      } else {
        await db.events.add({
          id: crypto.randomUUID(),
          user_id: currentPatientId,
          event_datetime: eventDateTimeIso,
          event_type: '活動',
          timing_category: activityType,
          duration_minutes: duration,
          insulin_units: insulin > 0 ? insulin : undefined,
          memo: combinedMemo,
          is_deleted: false,
          created_at: nowIso,
          updated_at: nowIso,
        });
      }

      invalidateInMemoryRecentCache(currentPatientId);
      invalidateAnalysisDatasetCache();
      triggerBackgroundCloudSync(currentPatientId);
      onSuccess();
      onClose();
    } catch (err: any) {
      console.error('[ActivityRecordModal] Failed to save activity event:', err);
      setErrorMsg(err.message || '保存に失敗しました');
    } finally {
      setIsSaving(false);
    }
  };

  // 論理削除処理
  const executeDelete = async () => {
    if (isReadOnly || !editEventId) return;
    setShowDeleteConfirm(false);

    setIsDeleting(true);
    try {
      pauseBackgroundHydration(currentPatientId, 3000);
      await waitForRecentPersistence(currentPatientId);
      const nowIso = new Date().toISOString();
      await db.events.update(editEventId, { is_deleted: true, updated_at: nowIso });
      invalidateInMemoryRecentCache(currentPatientId);
      invalidateAnalysisDatasetCache();
      triggerBackgroundCloudSync(currentPatientId);
      onSuccess();
      onClose();
    } catch (err: any) {
      console.error('[ActivityRecordModal] Failed to delete event:', err);
      setErrorMsg('削除に失敗しました');
    } finally {
      setIsDeleting(false);
    }
  };

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

  return (
    <div
      onClick={handleBackdropClick}
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/50 backdrop-blur-xs transition-opacity duration-200 ease-out',
        isVisible ? 'opacity-100' : 'opacity-0'
      )}
    >
      <div
        className={cn(
          'bg-white rounded-2xl max-w-lg w-full max-h-[92vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden transition-all duration-220 ease-[cubic-bezier(0.16,1,0.3,1)]',
          isVisible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-3'
        )}
      >
        {/* ヘッダー */}
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 rounded-xl bg-emerald-50 text-emerald-600">
              <Footprints className="w-4 h-4" />
            </div>
            <h3 className="text-base font-bold text-slate-800">
              {editEventId ? '活動・インスリンを編集' : '活動・インスリンを記録'}
            </h3>
          </div>
          <button
            type="button"
            onClick={handleRequestClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 本文 */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {errorMsg && (
            <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center space-x-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* 1. 記録日時 */}
          <div className="bg-slate-50/70 p-3.5 rounded-xl border border-slate-200/80 flex flex-wrap items-center justify-between gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-600 mb-1">記録日付 &amp; 時刻</label>
              <div className="flex items-center space-x-2">
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
                <input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </div>
            <div className="text-right">
              <span className="text-[11px] text-slate-500 block">選択区分</span>
              <span className="inline-block mt-0.5 px-2.5 py-1 rounded-md bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-bold">
                {activityType}
              </span>
            </div>
          </div>

          {/* 2. よく使う活動から選ぶ (カテゴリ絞り込み & 活動選択) */}
          <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 space-y-2.5">
            <label className="block text-xs font-bold text-slate-700">
              よく使う活動から選ぶ
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-2.5">
              <select
                aria-label="カテゴリで絞り込む"
                value={selectedCategoryId}
                onChange={(e) => handleSelectCategoryById(e.target.value)}
                className="w-full min-h-[42px] px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs sm:text-sm font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
              >
                <option value="ALL">すべてのカテゴリ</option>
                {eventCategories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.category_name}
                  </option>
                ))}
              </select>

              <select
                aria-label="よく使う活動から選ぶ"
                value={selectedMasterId}
                onChange={(e) => handleSelectEventMaster(e.target.value)}
                className="w-full min-h-[42px] px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs sm:text-sm font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
              >
                <option value="">活動を選ぶ（時間を自動入力）...</option>
                {selectedCategoryId === 'ALL' && groupedEventMasters.length > 0
                  ? groupedEventMasters.map((group) => (
                      <optgroup key={group.categoryId} label={group.categoryName}>
                        {group.items.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.event_name}
                            {m.default_duration ? ` (${m.default_duration}分)` : ''}
                            {m.memo ? ` — ${m.memo}` : ''}
                          </option>
                        ))}
                      </optgroup>
                    ))
                  : filteredEventMasters.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.event_name}
                        {m.default_duration ? ` (${m.default_duration}分)` : ''}
                        {m.memo ? ` — ${m.memo}` : ''}
                      </option>
                    ))}
              </select>
            </div>
          </div>

          {/* 3. 活動名 (初期値は空欄プレースホルダー) */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              活動名 <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              placeholder="例: ウォーキング、ジョギング、入浴、持効型インスリン投与"
              value={eventName}
              onChange={(e) => setEventName(e.target.value)}
              className="w-full min-h-[40px] px-3 py-2 bg-white border border-slate-300 rounded-xl text-xs sm:text-sm font-bold text-slate-800 placeholder:text-slate-400 placeholder:font-normal focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          {/* 4. 実施時間 & インスリン投与量 (初期値は空欄プレースホルダー) */}
          <div className="grid grid-cols-2 gap-3.5">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1 flex items-center space-x-1">
                <Clock className="w-3.5 h-3.5 text-slate-400" />
                <span>実施時間 (分)</span>
              </label>
              <input
                type="number"
                step="5"
                min="0"
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(e.target.value)}
                className="w-full min-h-[38px] px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-mono font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1 flex items-center space-x-1">
                <Syringe className="w-3.5 h-3.5 text-sky-500" />
                <span>インスリン投与量 (任意)</span>
              </label>
              <div className="flex items-center space-x-1.5">
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  placeholder="0"
                  value={insulinUnits}
                  onChange={(e) => setInsulinUnits(e.target.value)}
                  className="w-full min-h-[38px] px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-mono font-bold text-sky-700 placeholder:text-slate-400 placeholder:font-normal focus:outline-none focus:ring-2 focus:ring-sky-500"
                />
                <span className="text-xs text-slate-400 font-semibold">U</span>
              </div>
            </div>
          </div>

          {/* 5. 補足メモ */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              補足メモ・体調コメント (任意)
            </label>
            <input
              type="text"
              placeholder="例: 食後ウォーキング、軽く汗ばむ程度"
              value={memoNote}
              onChange={(e) => setMemoNote(e.target.value)}
              className="w-full min-h-[40px] px-3 py-2 bg-white border border-slate-300 rounded-xl text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
        </div>

        {/* フッター */}
        <div className="px-5 py-3.5 border-t border-slate-200 bg-slate-50/50 flex items-center justify-between">
          <div>
            {editEventId && !isReadOnly && (
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                disabled={isDeleting}
                className="inline-flex items-center space-x-1 px-3 py-1.5 rounded-lg text-xs font-bold text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer"
              >
                {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                <span>削除</span>
              </button>
            )}
          </div>

          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={handleRequestClose}
              className="px-3.5 py-1.5 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
            >
              キャンセル
            </button>

            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving || isReadOnly}
              className={cn(
                'inline-flex items-center space-x-1.5 px-4 py-1.5 rounded-xl text-xs font-bold transition-all shadow-2xs',
                isReadOnly
                  ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  : 'bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer active:scale-95'
              )}
            >
              {isSaving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : isReadOnly ? (
                <Lock className="w-3.5 h-3.5" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              <span>{editEventId ? '変更を保存' : '記録を保存'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* 入力データ破棄確認ダイアログ */}
      <ConfirmDialog
        isOpen={showDiscardConfirm}
        title="入力データの破棄確認"
        message="入力データが破棄されます。よろしいですか？"
        cancelLabel="入力を続ける"
        confirmLabel="破棄して閉じる"
        variant="warning"
        onCancel={() => setShowDiscardConfirm(false)}
        onConfirm={() => {
          setShowDiscardConfirm(false);
          onClose();
        }}
      />

      {/* 活動記録削除確認ダイアログ */}
      <ConfirmDialog
        isOpen={showDeleteConfirm}
        title="活動記録の削除確認"
        message="この活動記録を削除してもよろしいですか？"
        cancelLabel="キャンセル"
        confirmLabel="削除する"
        variant="danger"
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={executeDelete}
      />
    </div>
  );
};
