import { LibreReading, HealthEvent } from '@/types/database';
import { db } from './db';
import { parseWallClockMs, shiftLocalDateStr } from './dateUtils';
import { invalidateAnalysisDatasetCache } from './analysisCalculators';

/**
 * 異常値（低血糖・高血糖）エピソード抽出ステートマシン (Single Source of Truth)
 *
 * 旧VBA資産 (`legacy_vba/vba_exported/modAbnormalEvents.txt`) の臨床判定ルールを継承し、
 * CSV取込Worker・デモデータ生成・目標閾値変更時の再判定で100%同一のロジックを使用する。
 *
 * 【臨床エピソード判定ルール】
 * 1. 低血糖: 測定値が `hypoThreshold` (デフォルト 70 mg/dL) 未満で開始。
 * 2. 高血糖: 測定値が `hyperThreshold` (デフォルト 180 mg/dL) 超で開始。
 * 3. 28分継続復帰ルール: 正常範囲に戻ってから 28分以上（約2測定周期）正常値が持続した時点で
 *    1つのエピソードとしてクローズし、開始時刻・継続分数・最低/最高血糖値を記録する。
 * 4. センサー欠損ギャップルール: 測定間隔が 45分を超えて空いた場合は、進行中のエピソードを一旦確定する。
 */
export function extractAnomalyEventsFromReadings(
  readings: LibreReading[],
  patientId: string,
  hypoThreshold = 70,
  hyperThreshold = 180
): {
  events: HealthEvent[];
  hypoCount: number;
  hyperCount: number;
} {
  if (!readings || readings.length === 0) {
    return { events: [], hypoCount: 0, hyperCount: 0 };
  }

  const sorted = [...readings].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const events: HealthEvent[] = [];

  let inLow = false;
  let lowStart = '';
  let lowEnd = '';
  let minVal = 9999;

  let inHigh = false;
  let highStart = '';
  let highEnd = '';
  let maxVal = 0;

  let hypoCount = 0;
  let hyperCount = 0;
  let prevTimeMs: number | null = null;

  const flushLow = () => {
    if (!inLow) return;
    const durationMin = Math.max(
      15,
      Math.round((parseWallClockMs(lowEnd) - parseWallClockMs(lowStart)) / 60000) + 15
    );
    events.push({
      id: crypto.randomUUID(),
      user_id: patientId,
      event_datetime: lowStart,
      event_type: '低血糖',
      memo: `最低 ${Math.round(minVal)} mg/dL (継続 ${durationMin}分間)`,
      duration_minutes: durationMin,
      is_deleted: false,
      created_at: lowStart,
      updated_at: lowEnd,
    });
    hypoCount++;
    inLow = false;
  };

  const flushHigh = () => {
    if (!inHigh) return;
    const durationMin = Math.max(
      15,
      Math.round((parseWallClockMs(highEnd) - parseWallClockMs(highStart)) / 60000) + 15
    );
    events.push({
      id: crypto.randomUUID(),
      user_id: patientId,
      event_datetime: highStart,
      event_type: '高血糖',
      memo: `最高 ${Math.round(maxVal)} mg/dL (継続 ${durationMin}分間)`,
      duration_minutes: durationMin,
      is_deleted: false,
      created_at: highStart,
      updated_at: highEnd,
    });
    hyperCount++;
    inHigh = false;
  };

  for (const r of sorted) {
    const isoTime = r.timestamp;
    const currTimeMs = parseWallClockMs(isoTime);
    const glucose = r.glucose_value;

    // センサー欠損（前回測定から45分超の空白）がある場合は進行中エピソードを確定
    if (prevTimeMs !== null && (currTimeMs - prevTimeMs) / 60000 > 45) {
      flushLow();
      flushHigh();
    }
    prevTimeMs = currTimeMs;

    // --- 低血糖ステートマシン (< hypoThreshold) ---
    if (glucose < hypoThreshold) {
      if (!inLow) {
        inLow = true;
        lowStart = isoTime;
        lowEnd = isoTime;
        minVal = glucose;
      } else {
        lowEnd = isoTime;
        if (glucose < minVal) minVal = glucose;
      }
    } else if (inLow) {
      const diffMinutes = (currTimeMs - parseWallClockMs(lowEnd)) / 60000;
      if (diffMinutes >= 28) {
        flushLow();
      }
    }

    // --- 高血糖ステートマシン (> hyperThreshold) ---
    if (glucose > hyperThreshold) {
      if (!inHigh) {
        inHigh = true;
        highStart = isoTime;
        highEnd = isoTime;
        maxVal = glucose;
      } else {
        highEnd = isoTime;
        if (glucose > maxVal) maxVal = glucose;
      }
    } else if (inHigh) {
      const diffMinutes = (currTimeMs - parseWallClockMs(highEnd)) / 60000;
      if (diffMinutes >= 28) {
        flushHigh();
      }
    }
  }

  // 末尾で継続中のエピソードをフラッシュ
  flushLow();
  flushHigh();

  return { events, hypoCount, hyperCount };
}

/**
 * 設定画面で臨床目標閾値 (hypoThreshold / hyperThreshold) が変更された際、
 * IndexedDB 内の全 CGM 測定値から低血糖・高血糖イベントを再判定・更新する
 */
export async function reevaluatePatientAnomalyEvents(
  patientId: string,
  hypoThreshold: number,
  hyperThreshold: number
): Promise<{ hypoCount: number; hyperCount: number }> {
  const readings = await db.libre_readings.where('user_id').equals(patientId).toArray();
  const { events: rawAnomalyEvents, hypoCount, hyperCount } = extractAnomalyEventsFromReadings(
    readings,
    patientId,
    hypoThreshold,
    hyperThreshold
  );
  const newAnomalyEvents = rawAnomalyEvents.map((ev) => ({
    ...ev,
    id: `${patientId}_anomaly_${ev.event_type}_${ev.event_datetime}`,
  }));

  const [oldHypoKeys, oldHyperKeys] = await Promise.all([
    db.events.where('[user_id+event_type]').equals([patientId, '低血糖']).primaryKeys(),
    db.events.where('[user_id+event_type]').equals([patientId, '高血糖']).primaryKeys(),
  ]);
  const oldAnomalyKeys = [...oldHypoKeys, ...oldHyperKeys];

  await db.transaction('rw', [db.events], async () => {
    if (oldAnomalyKeys.length > 0) {
      await db.events.bulkDelete(oldAnomalyKeys);
    }
    if (newAnomalyEvents.length > 0) {
      await db.events.bulkPut(newAnomalyEvents);
    }
  });

  invalidateAnalysisDatasetCache();
  return { hypoCount, hyperCount };
}

function computeBoundGlucoseForMeal(
  meal: HealthEvent,
  candidateReadings: LibreReading[]
): { boundPre: number | undefined; boundPost: number | undefined } {
  const eventTimeMs = parseWallClockMs(meal.event_datetime);
  const preStart = eventTimeMs - 15 * 60 * 1000;
  const preEnd = eventTimeMs + 5 * 60 * 1000;
  const postStart = eventTimeMs + 60 * 60 * 1000;
  const postEnd = eventTimeMs + 180 * 60 * 1000;

  let boundPre = meal.pre_meal_glucose;
  let bestPreDiff = Infinity;

  let boundPost = meal.post_meal_glucose;
  let maxPostVal = -Infinity;
  let foundPost = false;

  for (const r of candidateReadings) {
    const t = parseWallClockMs(r.timestamp);
    if (t >= preStart && t <= preEnd) {
      const diff = Math.abs(t - eventTimeMs);
      if (diff < bestPreDiff) {
        bestPreDiff = diff;
        boundPre = r.glucose_value;
      }
    }
    if (t >= postStart && t <= postEnd) {
      if (r.glucose_value > maxPostVal) {
        maxPostVal = r.glucose_value;
        foundPost = true;
      }
    }
  }

  if (foundPost) {
    boundPost = maxPostVal;
  }

  return { boundPre, boundPost };
}

/**
 * CSV履歴データ取込完了時、または食事記録の単体保存時に、食事イベント (`event_type === '食事'`) に対して
 * CGM 測定データから食前血糖値 (`pre_meal_glucose`) および食後ピーク血糖値 (`post_meal_glucose`) を自動バインドする。
 * - `targetMealEventId` 指定時: 該当食事の前後1日の測定値のみを `[user_id+timestamp]` 複合インデックスで局所取得し O(1) で紐づける。
 * - 一括実行時: 日付別インデックス (`Map<YYYY-MM-DD, LibreReading[]>`) を構築し O(N + M) で高速に紐づける。
 */
export async function bindMealGlucoseFromReadings(
  patientId: string,
  targetMealEventId?: string
): Promise<number> {
  const nowIso = new Date().toISOString();

  // 単一食事イベントのピンポイント紐づけ（全件取得を排除）
  if (targetMealEventId) {
    const meal = await db.events.get(targetMealEventId);
    if (!meal || meal.is_deleted || meal.event_type !== '食事') {
      return 0;
    }
    const dateStr = meal.event_datetime.slice(0, 10);
    const startIso = `${shiftLocalDateStr(dateStr, -1)}T00:00:00.000Z`;
    const endIso = `${shiftLocalDateStr(dateStr, 1)}T23:59:59.999Z`;

    const windowReadings = await db.libre_readings
      .where('[user_id+timestamp]')
      .between([patientId, startIso], [patientId, endIso], true, true)
      .toArray();

    if (windowReadings.length === 0) return 0;

    const { boundPre, boundPost } = computeBoundGlucoseForMeal(meal, windowReadings);
    if (boundPre !== meal.pre_meal_glucose || boundPost !== meal.post_meal_glucose) {
      await db.events.update(meal.id, {
        pre_meal_glucose: boundPre,
        post_meal_glucose: boundPost,
        updated_at: nowIso,
      });
      invalidateAnalysisDatasetCache();
      return 1;
    }
    invalidateAnalysisDatasetCache();
    return 0;
  }

  // 一括紐づけ（CSV取込時）：日付バケット化により O(M * N) ループを排除
  const [readings, mealEvents] = await Promise.all([
    db.libre_readings.where('user_id').equals(patientId).toArray(),
    db.events
      .where('user_id')
      .equals(patientId)
      .filter((e) => e.event_type === '食事' && !e.is_deleted)
      .toArray(),
  ]);

  if (readings.length === 0 || mealEvents.length === 0) {
    return 0;
  }

  const readingsByDate = new Map<string, LibreReading[]>();
  for (const r of readings) {
    const dStr = r.timestamp.slice(0, 10);
    const bucket = readingsByDate.get(dStr);
    if (bucket) {
      bucket.push(r);
    } else {
      readingsByDate.set(dStr, [r]);
    }
  }

  const updatedMeals: HealthEvent[] = [];

  for (const meal of mealEvents) {
    const dStr = meal.event_datetime.slice(0, 10);
    const candidateDates = [shiftLocalDateStr(dStr, -1), dStr, shiftLocalDateStr(dStr, 1)];
    const candidateReadings: LibreReading[] = [];
    for (const cd of candidateDates) {
      const bucket = readingsByDate.get(cd);
      if (bucket) {
        for (const r of bucket) candidateReadings.push(r);
      }
    }

    if (candidateReadings.length === 0) continue;

    const { boundPre, boundPost } = computeBoundGlucoseForMeal(meal, candidateReadings);

    if (boundPre !== meal.pre_meal_glucose || boundPost !== meal.post_meal_glucose) {
      updatedMeals.push({
        ...meal,
        pre_meal_glucose: boundPre,
        post_meal_glucose: boundPost,
        updated_at: nowIso,
      });
    }
  }

  if (updatedMeals.length > 0) {
    await db.events.bulkPut(updatedMeals);
  }

  invalidateAnalysisDatasetCache();
  return updatedMeals.length;
}
