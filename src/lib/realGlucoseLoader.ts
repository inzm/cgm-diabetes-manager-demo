import {
  clearInMemoryDemoDatabase,
  db,
  isDemoMemoryOnlyMode,
  purgeDemoPhysicalIndexedDB,
} from './db';
import {
  DEFAULT_HYPER_THRESHOLD,
  DEFAULT_HYPO_THRESHOLD,
  HealthEvent,
  LibreReading,
  MealDetail,
} from '@/types/database';
import { extractAnomalyEventsFromReadings } from './anomalyExtractor';
import { invalidateAnalysisDatasetCache } from './analysisCalculators';
import { resetFoodSeedSession, seedFoodMasterIfEmpty } from './foodSeed';
import { deterministicUuid } from './uuidUtils';
import {
  MealItemSpec,
  MealTemplate,
  MEAL_TEMPLATES,
  calculateRealisticInsulinUnits,
  findMealGlucoseWindow,
  generateRealisticEventsFromReadings,
} from './demoMealGenerator';

export {
  invalidateAnalysisDatasetCache,
  MEAL_TEMPLATES,
  calculateRealisticInsulinUnits,
  findMealGlucoseWindow,
  generateRealisticEventsFromReadings,
};
export type { MealItemSpec, MealTemplate };

export const RECENT_CUTOFF_ISO = '2026-07-15T00:00:00.000Z';
const FULL_READINGS_EXPECTED_MIN = 75000;
const BACKGROUND_CHUNK_SIZE = 6000;

let activeInitPromise: Promise<boolean> | null = null;
const initializedPatients = new Set<string>();
const manuallyClearedPatients = new Set<string>();
const activeBackgroundHydrations = new Map<string, Promise<void>>();
const recentPersistencePromises = new Map<string, Promise<void>>();
const hydrationGenerations = new Map<string, number>();
const currentThresholdsByPatient = new Map<string, { hypo: number; hyper: number }>();
const pauseHydrationUntilByPatient = new Map<string, number>();
const inMemoryRecentCache = new Map<
  string,
  {
    readings: LibreReading[];
    events: HealthEvent[];
    mealDetails: MealDetail[];
    hypoThreshold: number;
    hyperThreshold: number;
    persisted: boolean;
  }
>();

/**
 * ポートフォリオモード時、ブラウザのページ読み込み（F5リロード含む）ごとに1回だけ
 * 初期状態へクリーンリセットするためのオンメモリフラグ。
 * 同一ページセッション内での追加・編集・削除はすべてクライアント上で動作し、
 * ページを再読み込みすると永続保存されず初期状態に戻る。
 */
let hasResetPortfolioSession = false;

export function isPortfolioMode(): boolean {
  try {
    return import.meta.env.VITE_APP_MODE === 'portfolio';
  } catch {
    return false;
  }
}

export function isDemoCsvImportDisabled(): boolean {
  if (!isPortfolioMode()) return false;
  if (
    typeof window !== 'undefined' &&
    (window as unknown as Record<string, unknown>).__CGM_E2E_ALLOW_CSV_IMPORT__ === true
  ) {
    return false;
  }
  return true;
}

/**
 * 設定画面で「記録データを初期化」または「バックアップから復元」を実行した際、
 * 同一セッション内でカレンダーや分析画面へ戻ってもデモデータが勝手に再ハイドレーションされないよう抑止する。
 * `resetDemoDataToInitialState` 実行時のみ解除される。
 */
export function markPatientManuallyCleared(patientId: string): void {
  manuallyClearedPatients.add(patientId);
  cancelBackgroundHydration(patientId);
  initializedPatients.add(patientId);
}

export function clearPatientManuallyCleared(patientId?: string): void {
  if (patientId) {
    manuallyClearedPatients.delete(patientId);
  } else {
    manuallyClearedPatients.clear();
  }
}

export function isPatientManuallyCleared(patientId: string): boolean {
  return manuallyClearedPatients.has(patientId);
}

// ポートフォリオモード時のみ、ブラウザ起動と同時に直近42日分JSON（約18KB gzip）のネットワーク取得を先行開始
let preloadedRecentTuplesPromise: Promise<[string, number, number][] | null> | null = null;

function getOrStartRecentTuplesFetch(): Promise<[string, number, number][] | null> {
  if (!isPortfolioMode()) {
    return Promise.resolve(null);
  }
  if (!preloadedRecentTuplesPromise && typeof window !== 'undefined' && typeof fetch !== 'undefined') {
    preloadedRecentTuplesPromise = (async () => {
      try {
        let res = await fetch('/data/real_glucose_recent.json');
        let loadedFullFileDirectly = false;
        if (!res.ok) {
          res = await fetch('/data/real_glucose_readings.json');
          loadedFullFileDirectly = true;
        }
        if (!res.ok) return null;
        const rawTuples = (await res.json()) as [string, number, number][];
        if (!Array.isArray(rawTuples) || rawTuples.length === 0) return null;
        return loadedFullFileDirectly ? rawTuples.filter((t) => t[0] >= '2026-07-15') : rawTuples;
      } catch {
        return null;
      }
    })();
  }
  return preloadedRecentTuplesPromise ?? Promise.resolve(null);
}

// モジュール評価時点で即座にプリフェッチ開始（ポートフォリオモードのみ。personalモードおよびVitest環境ではスキップ）
if (
  typeof window !== 'undefined' &&
  typeof fetch !== 'undefined' &&
  !(import.meta.env && import.meta.env.MODE === 'test') &&
  isPortfolioMode()
) {
  void getOrStartRecentTuplesFetch();
}

export function getInMemoryRecentSlice(
  patientId: string,
  startDate: string,
  endDate: string,
  hypoThreshold: number,
  hyperThreshold: number
): { readings: LibreReading[]; events: HealthEvent[] } | null {
  if (!isPortfolioMode() || manuallyClearedPatients.has(patientId)) return null;
  if (startDate < RECENT_CUTOFF_ISO) return null;
  const cached = inMemoryRecentCache.get(patientId);
  if (
    !cached ||
    cached.persisted ||
    cached.hypoThreshold !== hypoThreshold ||
    cached.hyperThreshold !== hyperThreshold
  ) {
    return null;
  }
  return {
    readings: cached.readings.filter((r) => r.timestamp >= startDate && r.timestamp <= endDate),
    events: cached.events.filter(
      (e) => !e.is_deleted && e.event_datetime >= startDate && e.event_datetime <= endDate
    ),
  };
}

export function getInMemoryRecentMealDetails(
  patientId: string,
  mealEventIds: string[]
): MealDetail[] | null {
  if (!isPortfolioMode() || manuallyClearedPatients.has(patientId)) return null;
  const cached = inMemoryRecentCache.get(patientId);
  if (!cached || cached.persisted) return null;
  const idSet = new Set(mealEventIds);
  return cached.mealDetails.filter((d) => !d.is_deleted && idSet.has(d.event_id));
}

function convertTuplesToReadings(
  rawTuples: [string, number, number][],
  patientId: string,
  nowIso: string
): LibreReading[] {
  const readings: LibreReading[] = new Array(rawTuples.length);
  for (let i = 0; i < rawTuples.length; i++) {
    const [prefix, val, isScan] = rawTuples[i];
    const ts = `${prefix}:00.000Z`;
    readings[i] = {
      id: deterministicUuid(`${patientId}_${ts}`),
      user_id: patientId,
      timestamp: ts,
      glucose_value: val,
      scan_type: isScan === 1 ? 'Scan' : 'Historic',
      created_at: nowIso,
    };
  }
  return readings;
}

function assignDeterministicAnomalyIds(events: HealthEvent[], patientId: string): HealthEvent[] {
  return events.map((ev) => ({
    ...ev,
    id: deterministicUuid(`${patientId}_anomaly_${ev.event_type}_${ev.event_datetime}`),
  }));
}

/**
 * Phase 1.5 (非ブロッキング背景永続化) & Phase 2 (バックグラウンド過去データ完全同期):
 * カレンダー初期描画（Memory-First 即時表示）が完了した後に、
 * 1) 直近42日分データと食品・活動初期データを IndexedDB へ永続化
 * 2) 過去期間（< 2026-07-15）のイベントおよび生データ（約7.6万件）を分割投入する。
 */
export function cancelBackgroundHydration(patientId: string): void {
  const nextGen = (hydrationGenerations.get(patientId) ?? 0) + 1;
  hydrationGenerations.set(patientId, nextGen);
  inMemoryRecentCache.delete(patientId);
  activeBackgroundHydrations.delete(patientId);
  recentPersistencePromises.delete(patientId);
}

export function invalidateInMemoryRecentCache(patientId?: string): void {
  if (patientId) {
    const cached = inMemoryRecentCache.get(patientId);
    if (cached) {
      cached.persisted = true;
    }
    inMemoryRecentCache.delete(patientId);
  } else {
    inMemoryRecentCache.clear();
  }
}

export function hasInMemoryRecentCache(patientId: string): boolean {
  return inMemoryRecentCache.has(patientId);
}

export function primeInMemoryRecentCache(
  patientId: string,
  readings: LibreReading[] = [],
  events: HealthEvent[] = [],
  mealDetails: MealDetail[] = [],
  hypoThreshold: number = DEFAULT_HYPO_THRESHOLD,
  hyperThreshold: number = DEFAULT_HYPER_THRESHOLD
): void {
  inMemoryRecentCache.set(patientId, {
    readings,
    events,
    mealDetails,
    hypoThreshold,
    hyperThreshold,
    persisted: false,
  });
}

export function pauseBackgroundHydration(patientId: string, durationMs: number = 2500): void {
  const prevUntil = pauseHydrationUntilByPatient.get(patientId) ?? 0;
  pauseHydrationUntilByPatient.set(patientId, Math.max(prevUntil, Date.now() + durationMs));
}

async function waitIfHydrationPaused(
  patientId: string,
  isCancelled: () => boolean
): Promise<void> {
  while (!isCancelled()) {
    const pauseUntil = pauseHydrationUntilByPatient.get(patientId) ?? 0;
    const remaining = pauseUntil - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 250)));
  }
}

export async function waitForRecentPersistence(patientId: string): Promise<void> {
  const p = recentPersistencePromises.get(patientId);
  if (p) {
    try {
      await p;
    } catch {
      // Ignore
    }
  }
}

export function notifyThresholdsUpdated(
  patientId: string,
  hypoThreshold: number,
  hyperThreshold: number
): void {
  currentThresholdsByPatient.set(patientId, {
    hypo: hypoThreshold,
    hyper: hyperThreshold,
  });
  pauseBackgroundHydration(patientId, 2500);
}

function scheduleBackgroundPersistenceAndHydration(
  patientId: string,
  hypoThreshold: number,
  hyperThreshold: number,
  recentReadings: LibreReading[],
  recentAllEvents: HealthEvent[],
  recentMealDetails: MealDetail[],
  portfolioMode: boolean
): void {
  if (activeBackgroundHydrations.has(patientId)) {
    return;
  }

  const currentGen = (hydrationGenerations.get(patientId) ?? 0) + 1;
  hydrationGenerations.set(patientId, currentGen);
  currentThresholdsByPatient.set(patientId, {
    hypo: hypoThreshold,
    hyper: hyperThreshold,
  });
  const isCancelled = () => hydrationGenerations.get(patientId) !== currentGen;

  const isVitest = Boolean(import.meta.env && import.meta.env.MODE === 'test');

  let resolveRecentPersistence!: () => void;
  const recentOnlyPromise = new Promise<void>((resolve) => {
    resolveRecentPersistence = resolve;
  });
  recentPersistencePromises.set(patientId, recentOnlyPromise);

  const persistTask = (async () => {
    try {
      // ブラウザ表示時は初期カレンダーのDOM描画（First Paint）を最優先させるため 60ms 譲る
      if (!isVitest) {
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      if (isCancelled()) return;

      const existingCount = await db.libre_readings.where('user_id').equals(patientId).count();
      if (isCancelled()) return;
      const readingsAlreadyFull = existingCount >= FULL_READINGS_EXPECTED_MIN;

      if (readingsAlreadyFull) {
        await db.transaction(
          'rw',
          [db.events, db.meal_details, db.user_settings],
          async () => {
            if (isCancelled()) return;
            await db.events.where('user_id').equals(patientId).delete();
            await db.meal_details.where('user_id').equals(patientId).delete();
            if (portfolioMode) {
              await db.user_settings.delete(patientId);
            }
            if (recentAllEvents.length > 0) {
              await db.events.bulkPut(recentAllEvents);
            }
            if (recentMealDetails.length > 0) {
              await db.meal_details.bulkPut(recentMealDetails);
            }
          }
        );
        if (isCancelled()) return;
        await seedFoodMasterIfEmpty(patientId);
      } else {
        await seedFoodMasterIfEmpty(patientId);
        if (isCancelled()) return;
        await db.transaction(
          'rw',
          [db.libre_readings, db.events, db.meal_details, db.user_settings],
          async () => {
            if (isCancelled()) return;
            if (existingCount > 0) {
              await db.libre_readings.where('user_id').equals(patientId).delete();
            }
            await db.events.where('user_id').equals(patientId).delete();
            await db.meal_details.where('user_id').equals(patientId).delete();
            if (portfolioMode) {
              await db.user_settings.delete(patientId);
            }
            await db.libre_readings.bulkPut(recentReadings);
            if (recentAllEvents.length > 0) {
              await db.events.bulkPut(recentAllEvents);
            }
            if (recentMealDetails.length > 0) {
              await db.meal_details.bulkPut(recentMealDetails);
            }
          }
        );
      }

      if (isCancelled()) return;
      const cached = inMemoryRecentCache.get(patientId);
      if (cached) {
        cached.persisted = true;
      }
      resolveRecentPersistence();
      if (recentPersistencePromises.get(patientId) === recentOnlyPromise) {
        recentPersistencePromises.delete(patientId);
      }

      // Vitest 環境では過去7.6万件のバックグラウンドチャンク投入は不要
      if (isVitest) {
        return;
      }

      // Phase 2: 初期インタラクションを妨げないよう十分待ってから過去データを取得・分割投入
      await new Promise((resolve) => setTimeout(resolve, 1800));
      await waitIfHydrationPaused(patientId, isCancelled);
      if (isCancelled()) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

      let res: Response;
      try {
        res = await fetch('/data/real_glucose_readings.json');
      } catch {
        return;
      }
      if (!res.ok || isCancelled()) return;

      const rawTuples = (await res.json()) as [string, number, number][];
      if (!Array.isArray(rawTuples) || rawTuples.length === 0 || isCancelled()) return;

      await waitIfHydrationPaused(patientId, isCancelled);
      if (isCancelled()) return;

      const nowIso = new Date().toISOString();
      const allReadings = convertTuplesToReadings(rawTuples, patientId, nowIso);
      const latestThresholds = currentThresholdsByPatient.get(patientId) ?? {
        hypo: hypoThreshold,
        hyper: hyperThreshold,
      };

      const { events: rawAnomalyEvents } = extractAnomalyEventsFromReadings(
        allReadings,
        patientId,
        latestThresholds.hypo,
        latestThresholds.hyper
      );
      const anomalyEvents = assignDeterministicAnomalyIds(rawAnomalyEvents, patientId);

      const { mealAndActivityEvents, mealDetails } = generateRealisticEventsFromReadings(
        allReadings,
        patientId,
        nowIso
      );

      if (isCancelled()) return;

      // Phase 1 で投入済みの 2026-07-15 以降を除いた過去イベント・明細を抽出
      const historicalEvents = [...anomalyEvents, ...mealAndActivityEvents].filter(
        (e) => e.event_datetime < RECENT_CUTOFF_ISO
      );
      const historicalMealEventIds = new Set(
        historicalEvents.filter((e) => e.event_type === '食事').map((e) => e.id)
      );
      const historicalMealDetails = mealDetails.filter((d) =>
        historicalMealEventIds.has(d.event_id)
      );

      const EVENT_CHUNK_SIZE = 1500;
      for (let i = 0; i < historicalEvents.length; i += EVENT_CHUNK_SIZE) {
        await waitIfHydrationPaused(patientId, isCancelled);
        if (isCancelled()) return;
        await db.events.bulkPut(historicalEvents.slice(i, i + EVENT_CHUNK_SIZE));
        await new Promise((resolve) => setTimeout(resolve, 30));
      }

      const DETAIL_CHUNK_SIZE = 2000;
      for (let i = 0; i < historicalMealDetails.length; i += DETAIL_CHUNK_SIZE) {
        await waitIfHydrationPaused(patientId, isCancelled);
        if (isCancelled()) return;
        await db.meal_details.bulkPut(historicalMealDetails.slice(i, i + DETAIL_CHUNK_SIZE));
        await new Promise((resolve) => setTimeout(resolve, 30));
      }

      // 初回コールドスタート時のみ、過去分の血糖測定データ（約7.6万件）を新しい月順・小分けチャンクでバックグラウンド投入
      if (!readingsAlreadyFull) {
        const historicalReadings = allReadings.filter((r) => r.timestamp < RECENT_CUTOFF_ISO);

        for (let endIdx = historicalReadings.length; endIdx > 0; endIdx -= BACKGROUND_CHUNK_SIZE) {
          await waitIfHydrationPaused(patientId, isCancelled);
          if (isCancelled()) return;
          const startIdx = Math.max(0, endIdx - BACKGROUND_CHUNK_SIZE);
          const chunk = historicalReadings.slice(startIdx, endIdx);
          await db.libre_readings.bulkPut(chunk);
          // メインスレッドとIndexedDBロックを解放してUI操作を妨げない
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      }

      invalidateAnalysisDatasetCache(patientId);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('cgm-background-hydration-complete'));
      }
    } catch (err) {
      console.warn('[LazySync] Background persistence/hydration skipped:', err);
    } finally {
      resolveRecentPersistence();
      if (!isCancelled()) {
        activeBackgroundHydrations.delete(patientId);
      }
      if (recentPersistencePromises.get(patientId) === recentOnlyPromise) {
        recentPersistencePromises.delete(patientId);
      }
    }
  })();

  activeBackgroundHydrations.set(patientId, persistTask);
}

/**
 * Memory-First 2段階段階的ロード (Lazy Sync - ARCHITECTURE.md 2.3 準拠):
 * - 本番モード (`isPortfolioMode() === false` / `VITE_APP_MODE=personal`):
 *   デモ用JSON (`real_glucose_recent.json` / `real_glucose_readings.json`) の取得・ハイドレーションや
 *   既存ユーザーデータの削除を一切行わず、`seedFoodMasterIfEmpty(patientId)` のみを実行して `false` を返す。
 * - ポートフォリオ（デモ）モード (`isPortfolioMode() === true` / `VITE_APP_MODE=portfolio`):
 *   Phase 1 で直近42日分を `inMemoryRecentCache` に展開して即座に描画し、
 *   Phase 1.5 & Phase 2 で直近データおよび過去7.6万件をバックグラウンドで格納する。
 *   ただし、同一セッション内で「記録データを初期化」が実行された場合 (`manuallyClearedPatients.has(patientId)`) は、
 *   `resetDemoDataToInitialState` が呼ばれるまでデモデータの再ハイドレーションを行わない。
 */
export async function ensureRealGlucoseDataLoaded(
  patientId: string,
  hypoThreshold: number = DEFAULT_HYPO_THRESHOLD,
  hyperThreshold: number = DEFAULT_HYPER_THRESHOLD
): Promise<boolean> {
  if (typeof window === 'undefined' || typeof fetch === 'undefined') {
    return false;
  }

  const portfolioMode = isPortfolioMode();

  // 1. 本番モード (personal) ではデモデータのプリフェッチ・自動投入・既存データ削除を一切行わない
  if (!portfolioMode) {
    await seedFoodMasterIfEmpty(patientId);
    initializedPatients.add(patientId);
    return false;
  }

  // 2. 同一セッション内で「記録データを初期化」等が実行された場合はデモデータの自動再投入を抑止する
  if (manuallyClearedPatients.has(patientId)) {
    await seedFoodMasterIfEmpty(patientId);
    initializedPatients.add(patientId);
    return false;
  }

  const isVitest = Boolean(import.meta.env && import.meta.env.MODE === 'test');

  if (initializedPatients.has(patientId)) {
    const mem = inMemoryRecentCache.get(patientId);
    if (mem && !mem.persisted) {
      return false;
    }
    const anyReading = await db.libre_readings.where('user_id').equals(patientId).first();
    if (anyReading) {
      return false;
    }
    initializedPatients.delete(patientId);
  }

  if (activeInitPromise) {
    return activeInitPromise;
  }

  activeInitPromise = (async () => {
    try {
      let needsResetAndSeed = false;

      if (!hasResetPortfolioSession) {
        needsResetAndSeed = true;
        hasResetPortfolioSession = true;
        resetFoodSeedSession(patientId);
        if (isDemoMemoryOnlyMode()) {
          clearInMemoryDemoDatabase();
          void purgeDemoPhysicalIndexedDB();
        } else {
          await db.transaction(
            'rw',
            [db.categories, db.food_master, db.event_master, db.user_settings],
            async () => {
              await db.categories.where('user_id').equals(patientId).delete();
              await db.food_master.where('user_id').equals(patientId).delete();
              await db.event_master.where('user_id').equals(patientId).delete();
              await db.user_settings.delete(patientId);
            }
          );
        }
      }

      if (!needsResetAndSeed) {
        const [existingCount, sampleDetail] = await Promise.all([
          db.libre_readings.where('user_id').equals(patientId).count(),
          db.meal_details.where('user_id').equals(patientId).first(),
        ]);

        const isDetailValid =
          sampleDetail &&
          typeof sampleDetail.carbs === 'number' &&
          !Number.isNaN(sampleDetail.carbs) &&
          typeof sampleDetail.amount === 'number' &&
          typeof sampleDetail.unit === 'string';

        if (existingCount > 0 && isDetailValid) {
          void seedFoodMasterIfEmpty(patientId);
          initializedPatients.add(patientId);
          return false;
        }
      }

      // Phase 1: 起動時に並列プリフェッチ済みの直近42日タプルを取得
      const recentTuples = await getOrStartRecentTuplesFetch();
      if (!recentTuples || recentTuples.length === 0) {
        return false;
      }

      const nowIso = new Date().toISOString();
      const recentReadings = convertTuplesToReadings(recentTuples, patientId, nowIso);

      const { events: rawRecentAnomalies } = extractAnomalyEventsFromReadings(
        recentReadings,
        patientId,
        hypoThreshold,
        hyperThreshold
      );
      const recentAnomalyEvents = assignDeterministicAnomalyIds(rawRecentAnomalies, patientId);

      const { mealAndActivityEvents: recentMealsAndActs, mealDetails: recentMealDetails } =
        generateRealisticEventsFromReadings(recentReadings, patientId, nowIso);

      const recentAllEvents = [...recentAnomalyEvents, ...recentMealsAndActs];

      // メモリキャッシュへ即座に格納（IndexedDB書き込み完了前でも CalendarView / DailyDetailDrawer が 0ms で参照可能）
      inMemoryRecentCache.set(patientId, {
        readings: recentReadings,
        events: recentAllEvents,
        mealDetails: recentMealDetails,
        hypoThreshold,
        hyperThreshold,
        persisted: false,
      });

      initializedPatients.add(patientId);

      // IndexedDB への書き込みと過去データ同期をスケジュール
      scheduleBackgroundPersistenceAndHydration(
        patientId,
        hypoThreshold,
        hyperThreshold,
        recentReadings,
        recentAllEvents,
        recentMealDetails,
        portfolioMode
      );

      // テスト環境（Vitest）では直後に db.* を直接アサートするため永続化完了を待つ
      if (isVitest) {
        await recentPersistencePromises.get(patientId);
      }

      return true;
    } catch (err) {
      console.warn('Real glucose dataset preload skipped:', err);
      return false;
    } finally {
      activeInitPromise = null;
    }
  })();

  return activeInitPromise;
}

/**
 * デモアプリの全データ（追加・変更した食品・活動・カテゴリ・食事記録・目標閾値・インスリン設定）を
 * 即座に初期状態へクリーンリセットする。
 */
export async function resetDemoDataToInitialState(patientId: string): Promise<void> {
  manuallyClearedPatients.delete(patientId);
  cancelBackgroundHydration(patientId);
  pauseHydrationUntilByPatient.delete(patientId);
  currentThresholdsByPatient.set(patientId, {
    hypo: DEFAULT_HYPO_THRESHOLD,
    hyper: DEFAULT_HYPER_THRESHOLD,
  });
  initializedPatients.delete(patientId);
  hasResetPortfolioSession = false;
  resetFoodSeedSession(patientId);
  invalidateAnalysisDatasetCache(patientId);

  if (isDemoMemoryOnlyMode()) {
    clearInMemoryDemoDatabase();
    await purgeDemoPhysicalIndexedDB();
  } else {
    await db.transaction(
      'rw',
      [
        db.user_settings,
        db.libre_readings,
        db.events,
        db.meal_details,
        db.food_master,
        db.event_master,
        db.categories,
      ],
      async () => {
        await db.user_settings.delete(patientId);
        await db.libre_readings.where('user_id').equals(patientId).delete();
        await db.events.where('user_id').equals(patientId).delete();
        await db.meal_details.where('user_id').equals(patientId).delete();
        await db.food_master.where('user_id').equals(patientId).delete();
        await db.event_master.where('user_id').equals(patientId).delete();
        await db.categories.where('user_id').equals(patientId).delete();
      }
    );
  }

  await ensureRealGlucoseDataLoaded(
    patientId,
    DEFAULT_HYPO_THRESHOLD,
    DEFAULT_HYPER_THRESHOLD
  );
  await waitForRecentPersistence(patientId);
  await seedFoodMasterIfEmpty(patientId);
}
