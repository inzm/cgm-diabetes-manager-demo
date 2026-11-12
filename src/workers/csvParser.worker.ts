import {
  DEFAULT_HYPER_THRESHOLD,
  DEFAULT_HYPO_THRESHOLD,
  HealthEvent,
  LibreReading,
} from '@/types/database';
import { extractAnomalyEventsFromReadings } from '@/lib/anomalyExtractor';
import { getErrorMessage } from '@/lib/utils';
import { deterministicUuid } from '@/lib/uuidUtils';

export interface CsvImportStartMessage {
  type: 'START_IMPORT';
  fileText: string;
  patientId: string;
  hypoThreshold?: number; // default: 70
  hyperThreshold?: number; // default: 180
}

export interface CsvImportProgressMessage {
  type: 'PROGRESS';
  processedLines: number;
  totalLines: number;
  percent: number;
  readingCount: number;
  hypoCount: number;
  hyperCount: number;
}

export interface CsvImportCompleteMessage {
  type: 'COMPLETE';
  readings: LibreReading[];
  events: HealthEvent[];
  stats: {
    totalReadings: number;
    startDate: string;
    endDate: string;
    hypoCount: number;
    hyperCount: number;
    durationMs: number;
  };
}

export interface CsvImportErrorMessage {
  type: 'ERROR';
  error: string;
}

self.onmessage = (e: MessageEvent<CsvImportStartMessage>) => {
  if (e.data.type !== 'START_IMPORT') return;

  const startTime = Date.now();
  const {
    fileText,
    patientId,
    hypoThreshold = DEFAULT_HYPO_THRESHOLD,
    hyperThreshold = DEFAULT_HYPER_THRESHOLD,
  } = e.data;

  try {
    const lines = fileText.split(/\r?\n/);
    const totalLines = lines.length;

    // ヘッダー行の探索 (FreeStyleリブレLink 日本語/英語/各種標準ヘッダー完全対応)
    let headerIndex = -1;
    let timeColIndex = -1;
    let typeColIndex = -1;
    let historicColIndex = -1;
    let scanColIndex = -1;

    for (let i = 0; i < Math.min(20, lines.length); i++) {
      const line = lines[i];
      if (
        line.includes('タイムスタンプ') ||
        line.includes('日時') ||
        line.includes('Timestamp') ||
        line.includes('Meter Timestamp')
      ) {
        headerIndex = i;
        const cols = line.split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''));

        cols.forEach((col, idx) => {
          if (
            col.includes('タイムスタンプ') ||
            col.includes('日時') ||
            col.includes('Timestamp')
          ) {
            timeColIndex = idx;
          } else if (
            col.includes('記録タイプ') ||
            col.includes('Scan Type') ||
            col.includes('Record Type')
          ) {
            typeColIndex = idx;
          } else if (
            col.includes('過去のグルコース') ||
            col.includes('履歴グルコース') ||
            col.includes('Historic Glucose')
          ) {
            historicColIndex = idx;
          } else if (
            col.includes('血糖値をスキャン') ||
            col.includes('スキャングルコース') ||
            col.includes('Scan Glucose')
          ) {
            scanColIndex = idx;
          }
        });
        break;
      }
    }

    if (headerIndex === -1 || timeColIndex === -1) {
      headerIndex = 0;
      timeColIndex = 2;
      typeColIndex = 3;
      historicColIndex = 4;
      scanColIndex = 5;
    }

    const readingMap = new Map<string, LibreReading>();

    // 日時文字列パース補助 (YYYY/MM/DD HH:mm または YYYY-MM-DD HH:mm -> ウォールクロック ISO)
    const parseIsoTimestamp = (str: string): string | null => {
      const trimmed = str.trim().replace(/^["']|["']$/g, '');
      if (!trimmed) return null;

      const parts = trimmed.match(
        /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/
      );
      if (!parts) {
        return null;
      }

      const year = parts[1];
      const month = parts[2].padStart(2, '0');
      const day = parts[3].padStart(2, '0');
      const hour = parts[4].padStart(2, '0');
      const min = parts[5].padStart(2, '0');
      const sec = (parts[6] || '0').padStart(2, '0');

      return `${year}-${month}-${day}T${hour}:${min}:${sec}.000Z`;
    };

    const chunkSize = 5000;
    for (let i = headerIndex + 1; i < totalLines; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = line.split(',');
      if (cols.length <= timeColIndex) continue;

      const timeStr = cols[timeColIndex];
      const isoTime = parseIsoTimestamp(timeStr);
      if (!isoTime) continue;

      let glucoseStr =
        historicColIndex !== -1 && cols[historicColIndex] ? cols[historicColIndex].trim() : '';
      if (!glucoseStr && scanColIndex !== -1 && cols[scanColIndex]) {
        glucoseStr = cols[scanColIndex].trim();
      }
      const glucose = parseFloat(glucoseStr);
      if (isNaN(glucose) || glucose <= 0) continue;

      const scanTypeRaw =
        typeColIndex !== -1 && cols[typeColIndex] ? cols[typeColIndex].trim() : '';
      const scanType =
        scanTypeRaw === '1' || scanTypeRaw.toLowerCase().includes('scan') ? 'Scan' : 'Historic';

      const existing = readingMap.get(isoTime);
      if (!existing || scanType === 'Historic') {
        readingMap.set(isoTime, {
          id: deterministicUuid(`${patientId}_${isoTime}`),
          user_id: patientId,
          timestamp: isoTime,
          glucose_value: Math.round(glucose),
          scan_type: scanType,
          created_at: isoTime,
        });
      }

      if (i % chunkSize === 0 || i === totalLines - 1) {
        const percent = Math.min(100, Math.round((i / totalLines) * 100));
        self.postMessage({
          type: 'PROGRESS',
          processedLines: i,
          totalLines,
          percent,
          readingCount: readingMap.size,
          hypoCount: 0,
          hyperCount: 0,
        } as CsvImportProgressMessage);
      }
    }

    const readings = Array.from(readingMap.values()).sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp)
    );

    // 共通ステートマシン (src/lib/anomalyExtractor.ts) で異常値エピソードを一括抽出
    const { events, hypoCount, hyperCount } = extractAnomalyEventsFromReadings(
      readings,
      patientId,
      hypoThreshold,
      hyperThreshold
    );

    const startDate = readings.length > 0 ? readings[0].timestamp.slice(0, 10) : '';
    const endDate =
      readings.length > 0 ? readings[readings.length - 1].timestamp.slice(0, 10) : '';
    const durationMs = Date.now() - startTime;

    self.postMessage({
      type: 'COMPLETE',
      readings,
      events,
      stats: {
        totalReadings: readings.length,
        startDate,
        endDate,
        hypoCount,
        hyperCount,
        durationMs,
      },
    } as CsvImportCompleteMessage);
  } catch (err: unknown) {
    self.postMessage({
      type: 'ERROR',
      error: getErrorMessage(err, 'CSVのパース処理中に予期せぬエラーが発生しました'),
    } as CsvImportErrorMessage);
  }
};
