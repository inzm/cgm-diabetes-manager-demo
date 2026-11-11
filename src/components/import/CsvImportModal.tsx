import React, { useState, useRef, useEffect } from 'react';
import { usePatient } from '@/contexts/PatientContext';
import { db } from '@/lib/db';
import { bindMealGlucoseFromReadings } from '@/lib/anomalyExtractor';
import { isDemoCsvImportDisabled } from '@/lib/realGlucoseLoader';
import {
  X,
  UploadCloud,
  FileSpreadsheet,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Database,
  Activity,
  Calendar,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  CsvImportProgressMessage,
  CsvImportCompleteMessage,
  CsvImportErrorMessage,
} from '@/workers/csvParser.worker';

interface CsvImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportSuccess?: (latestDateStr?: string) => void;
}

export const CsvImportModal: React.FC<CsvImportModalProps> = ({
  isOpen,
  onClose,
  onImportSuccess,
}) => {
  const { currentPatientId, hypoThreshold, hyperThreshold } = usePatient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<CsvImportProgressMessage | null>(null);
  const [completeStats, setCompleteStats] = useState<CsvImportCompleteMessage['stats'] | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
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

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFile(e.target.files[0]);
    }
  };

  const processFile = async (file: File) => {
    if (isDemoCsvImportDisabled()) {
      setErrorMsg('デモアプリでは利用できません');
      return;
    }
    if (!file.name.toLowerCase().endsWith('.csv') && !file.name.toLowerCase().endsWith('.txt')) {
      setErrorMsg('CSV形式 (.csv) のファイルを選択してください。');
      return;
    }

    setErrorMsg(null);
    setIsProcessing(true);
    setProgress({
      type: 'PROGRESS',
      processedLines: 0,
      totalLines: 100,
      percent: 0,
      readingCount: 0,
      hypoCount: 0,
      hyperCount: 0,
    });
    setCompleteStats(null);

    try {
      const text = await file.text();

      const worker = new Worker(
        new URL('../../workers/csvParser.worker.ts', import.meta.url),
        { type: 'module' }
      );

      worker.onmessage = async (
        e: MessageEvent<
          CsvImportProgressMessage | CsvImportCompleteMessage | CsvImportErrorMessage
        >
      ) => {
        const data = e.data;

        if (data.type === 'PROGRESS') {
          setProgress(data);
        } else if (data.type === 'COMPLETE') {
          const startIso = data.stats.startDate
            ? `${data.stats.startDate}T00:00:00.000Z`
            : '';
          const endIso = data.stats.endDate
            ? `${data.stats.endDate}T23:59:59.999Z`
            : '';

          await db.transaction('rw', [db.libre_readings, db.events], async () => {
            if (startIso && endIso) {
              const oldAnomalyKeys = await db.events
                .where('[user_id+event_datetime]')
                .between([currentPatientId, startIso], [currentPatientId, endIso], true, true)
                .filter(
                  (ev) =>
                    (ev.event_type === '低血糖' || ev.event_type === '高血糖') &&
                    ev.event_datetime >= startIso &&
                    ev.event_datetime <= endIso
                )
                .primaryKeys();
              if (oldAnomalyKeys.length > 0) {
                await db.events.bulkDelete(oldAnomalyKeys);
              }
            }
            await db.libre_readings.bulkPut(data.readings);
            await db.events.bulkPut(data.events);
          });

          // 先行して登録されていた食事記録に対し、取り込まれた履歴から食前・食後血糖値を自動紐づけ
          await bindMealGlucoseFromReadings(currentPatientId);

          setCompleteStats(data.stats);
          setIsProcessing(false);
          worker.terminate();

          if (onImportSuccess) {
            onImportSuccess(data.stats.endDate);
          }
        } else if (data.type === 'ERROR') {
          setErrorMsg(data.error);
          setIsProcessing(false);
          worker.terminate();
        }
      };

      worker.onerror = (err) => {
        setErrorMsg(`読み込みエラー: ${err.message}`);
        setIsProcessing(false);
        worker.terminate();
      };

      worker.postMessage({
        type: 'START_IMPORT',
        fileText: text,
        patientId: currentPatientId,
        hypoThreshold,
        hyperThreshold,
      });
    } catch (err: any) {
      setErrorMsg(`ファイル読込エラー: ${err.message || err}`);
      setIsProcessing(false);
    }
  };

  const handleReset = () => {
    setProgress(null);
    setCompleteStats(null);
    setErrorMsg(null);
    setIsProcessing(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div
        onClick={isProcessing ? undefined : onClose}
        className={cn(
          'fixed inset-0 bg-slate-900/50 backdrop-blur-xs transition-opacity duration-200 ease-out',
          isVisible ? 'opacity-100' : 'opacity-0'
        )}
      />

      <div
        className={cn(
          'relative w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden z-10 transition-all duration-220 ease-[cubic-bezier(0.16,1,0.3,1)]',
          isVisible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-3'
        )}
      >
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-xl bg-sky-50 text-sky-600">
              <FileSpreadsheet className="w-5 h-5" />
            </span>
            <h3 className="text-base font-bold text-slate-800">
              リブレCSVデータの取込
            </h3>
          </div>

          {!isProcessing && (
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* コンテンツ領域 */}
        <div className="p-6 space-y-5">
          {errorMsg && (
            <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700 flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-500 mt-0.5" />
              <div>
                <p className="font-bold">取込エラー</p>
                <p>{errorMsg}</p>
              </div>
            </div>
          )}

          {!isProcessing && !completeStats && (
            <>
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  'border-2 border-dashed rounded-2xl p-8 text-center transition-all cursor-pointer select-none flex flex-col items-center justify-center gap-3',
                  isDragging
                    ? 'border-sky-500 bg-sky-50/60'
                    : 'border-slate-200 hover:border-sky-400 hover:bg-slate-50/60'
                )}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.txt"
                  onChange={handleFileChange}
                  className="hidden"
                />

                <div className="w-12 h-12 rounded-full bg-sky-100 text-sky-600 flex items-center justify-center">
                  <UploadCloud className="w-6 h-6" />
                </div>

                <div>
                  <p className="text-sm font-bold text-slate-700">
                    CSVファイルをドラッグ＆ドロップ
                  </p>
                  <p className="text-xs text-slate-400 mt-1">
                    または <span className="text-sky-600 font-semibold underline">ファイルを選択</span>
                  </p>
                </div>

                <div className="text-[11px] text-slate-400 bg-slate-100 px-3 py-1 rounded-full">
                  FreeStyleリブレ標準形式 (日本語 / 英語) 対応
                </div>
              </div>

              <div className="bg-slate-50 rounded-xl p-3.5 border border-slate-200/60 text-xs text-slate-600 space-y-1.5">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  <span>大量の測定データもスムーズに取り込めます</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  <span>
                    現在の目標範囲（低血糖 &lt;{hypoThreshold} / 高血糖 &gt;{hyperThreshold}）で記録を自動抽出します
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  <span>登録済みの食事記録に食前・食後の血糖値を自動で紐づけます</span>
                </div>
              </div>
            </>
          )}

          {isProcessing && progress && (
            <div className="py-6 text-center space-y-4">
              <div className="w-12 h-12 rounded-full bg-sky-100 text-sky-600 flex items-center justify-center mx-auto animate-pulse">
                <Loader2 className="w-6 h-6 animate-spin" />
              </div>

              <div>
                <h4 className="text-sm font-bold text-slate-800">
                  データを読み込んでいます...
                </h4>
                <p className="text-xs text-slate-400 mt-0.5">
                  そのまましばらくお待ちください
                </p>
              </div>

              <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden">
                <div
                  className="bg-sky-500 h-2.5 rounded-full transition-all duration-200"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>

              <div className="flex justify-between text-xs text-slate-500 px-1 font-mono">
                <span>{progress.processedLines.toLocaleString()} 行処理済み</span>
                <span className="font-bold text-sky-600">{progress.percent}%</span>
              </div>
            </div>
          )}

          {completeStats && (
            <div className="py-4 text-center space-y-4 animate-in fade-in duration-300">
              <div className="w-14 h-14 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-8 h-8" />
              </div>

              <div>
                <h4 className="text-base font-bold text-slate-800">
                  データの取込が完了しました！
                </h4>
                <p className="text-xs text-slate-400 mt-1">
                  処理時間: {(completeStats.durationMs / 1000).toFixed(1)} 秒
                </p>
              </div>

              <div className="bg-slate-50 rounded-xl p-4 border border-slate-200/80 text-left space-y-2.5 text-xs">
                <div className="flex items-center justify-between pb-2 border-b border-slate-200">
                  <span className="text-slate-500 flex items-center gap-1.5 font-medium">
                    <Database className="w-3.5 h-3.5 text-sky-500" />
                    取込測定データ数
                  </span>
                  <span className="font-black text-slate-800 text-sm">
                    {completeStats.totalReadings.toLocaleString()} 件
                  </span>
                </div>

                <div className="flex items-center justify-between pb-2 border-b border-slate-200">
                  <span className="text-slate-500 flex items-center gap-1.5 font-medium">
                    <Calendar className="w-3.5 h-3.5 text-slate-400" />
                    測定データ期間
                  </span>
                  <span className="font-semibold text-slate-700">
                    {completeStats.startDate} 〜 {completeStats.endDate}
                  </span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-slate-500 flex items-center gap-1.5 font-medium">
                    <Activity className="w-3.5 h-3.5 text-emerald-500" />
                    自動抽出された高血糖・低血糖
                  </span>
                  <span className="space-x-2 font-bold">
                    <span className="text-blue-600">▼低血糖 {completeStats.hypoCount}件</span>
                    <span className="text-rose-600">▲高血糖 {completeStats.hyperCount}件</span>
                  </span>
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  onClick={handleReset}
                  className="flex-1 px-4 py-2 rounded-xl border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  別のファイルを取込む
                </button>
                <button
                  onClick={onClose}
                  className="flex-1 px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold cursor-pointer shadow-xs"
                >
                  カレンダーで確認する
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
