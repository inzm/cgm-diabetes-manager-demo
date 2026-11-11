import {
  clearInMemoryDemoDatabase,
  db,
  isDemoMemoryOnlyMode,
  purgeDemoPhysicalIndexedDB,
} from './db';
import { HealthEvent, LibreReading, MealDetail } from '@/types/database';
import { extractAnomalyEventsFromReadings } from './anomalyExtractor';
import { invalidateAnalysisDatasetCache } from './analysisCalculators';
import { INITIAL_FOODS, resetFoodSeedSession, seedFoodMasterIfEmpty } from './foodSeed';
import { deterministicUuid } from './uuidUtils';

export { invalidateAnalysisDatasetCache };

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

export interface MealItemSpec {
  foodKey: string;
  quantity: number;
}

export interface MealTemplate {
  id: string;
  label: string;
  mealTime: '朝食' | '昼食' | '夕食' | '間食';
  tier: 'low' | 'standard' | 'high_spike';
  cuisine: 'japanese' | 'western' | 'noodle_chinese' | 'snack';
  items: MealItemSpec[];
}

/**
 * 食べ合わせを厳格に考慮した献立テンプレート一覧
 * - ごはん・パン・麺類の主食重複ゼロ
 * - パン＋みそ汁、パスタ＋納豆などの不自然な組み合わせゼロ
 * - low/standard は糖質 100g 以内、high_spike は規定量の 1.1〜1.45倍（110g〜140g）
 */
export const MEAL_TEMPLATES: MealTemplate[] = [
  // ==================== 朝食 (Low / Standard <= 100g) ====================
  {
    id: 'bf_west_toast_egg',
    label: '洋食モーニング（トースト・ベーコンエッグ）',
    mealTime: '朝食',
    tier: 'low',
    cuisine: 'western',
    items: [
      { foodKey: 'food_toast_6', quantity: 1 },
      { foodKey: 'food_bacon_egg', quantity: 1 },
      { foodKey: 'food_green_salad', quantity: 1 },
      { foodKey: 'food_yogurt_plain', quantity: 1 },
      { foodKey: 'food_black_coffee', quantity: 1 },
    ], // 26.6 + 0.5 + 3.5 + 4.9 + 0 = 35.5g
  },
  {
    id: 'bf_jp_natto_tamago',
    label: '和朝食（ごはん少なめ・納豆・卵焼き）',
    mealTime: '朝食',
    tier: 'low',
    cuisine: 'japanese',
    items: [
      { foodKey: 'food_rice', quantity: 0.8 },
      { foodKey: 'food_natto', quantity: 1 },
      { foodKey: 'food_tamagoyaki', quantity: 1 },
      { foodKey: 'food_miso_soup', quantity: 1 },
      { foodKey: 'food_green_tea', quantity: 1 },
    ], // 44.2 + 2.2 + 2.5 + 3.8 + 0 = 52.7g
  },
  {
    id: 'bf_west_roll_milk',
    label: '洋食モーニング（ロールパン・牛乳・りんご）',
    mealTime: '朝食',
    tier: 'standard',
    cuisine: 'western',
    items: [
      { foodKey: 'food_roll_bread', quantity: 1 },
      { foodKey: 'food_bacon_egg', quantity: 1 },
      { foodKey: 'food_green_salad', quantity: 1 },
      { foodKey: 'food_milk', quantity: 1 },
      { foodKey: 'food_apple', quantity: 1 },
    ], // 28.0 + 0.5 + 3.5 + 9.6 + 17.5 = 59.1g
  },
  {
    id: 'bf_jp_salmon_set',
    label: '和朝食（焼き鮭定食）',
    mealTime: '朝食',
    tier: 'standard',
    cuisine: 'japanese',
    items: [
      { foodKey: 'food_rice', quantity: 1 },
      { foodKey: 'food_grilled_salmon', quantity: 1 },
      { foodKey: 'food_spinach_ohitashi', quantity: 1 },
      { foodKey: 'food_miso_soup', quantity: 1 },
      { foodKey: 'food_green_tea', quantity: 1 },
    ], // 55.2 + 0.1 + 0.8 + 3.8 + 0 = 59.9g
  },
  {
    id: 'bf_west_toast_banana_latte',
    label: '洋食モーニング（トースト・バナナ・カフェラテ）',
    mealTime: '朝食',
    tier: 'standard',
    cuisine: 'western',
    items: [
      { foodKey: 'food_toast_6', quantity: 1.5 },
      { foodKey: 'food_bacon_egg', quantity: 1 },
      { foodKey: 'food_green_salad', quantity: 1 },
      { foodKey: 'food_banana', quantity: 1 },
      { foodKey: 'food_cafe_latte', quantity: 1 },
    ], // 39.9 + 0.5 + 3.5 + 21.4 + 6.8 = 72.1g
  },
  {
    id: 'bf_jp_full_set',
    label: '和朝食（焼き鮭・卵焼き・ひじき小鉢）',
    mealTime: '朝食',
    tier: 'standard',
    cuisine: 'japanese',
    items: [
      { foodKey: 'food_rice', quantity: 1.2 },
      { foodKey: 'food_grilled_salmon', quantity: 1 },
      { foodKey: 'food_tamagoyaki', quantity: 1 },
      { foodKey: 'food_hijiki', quantity: 1 },
      { foodKey: 'food_miso_soup', quantity: 1 },
    ], // 66.2 + 0.1 + 2.5 + 5.2 + 3.8 = 77.8g
  },
  // ==================== 朝食 (High Spike ~1.15x) ====================
  {
    id: 'bf_high_honey_toast_juice',
    label: '洋食モーニング（はちみつトースト2枚・バナナ・オレンジジュース）',
    mealTime: '朝食',
    tier: 'high_spike',
    cuisine: 'western',
    items: [
      { foodKey: 'food_toast_6', quantity: 2 },
      { foodKey: 'food_honey_tbsp', quantity: 1 },
      { foodKey: 'food_bacon_egg', quantity: 1 },
      { foodKey: 'food_banana', quantity: 1 },
      { foodKey: 'food_orange_juice', quantity: 1 },
    ], // 53.2 + 17.0 + 0.5 + 21.4 + 21.0 = 113.1g
  },

  // ==================== 昼食 (Low / Standard <= 100g) ====================
  {
    id: 'ln_soba_tofu',
    label: 'かけそば＆冷奴セット',
    mealTime: '昼食',
    tier: 'low',
    cuisine: 'noodle_chinese',
    items: [
      { foodKey: 'food_soba', quantity: 1 },
      { foodKey: 'food_tofu', quantity: 1 },
      { foodKey: 'food_spinach_ohitashi', quantity: 1 },
      { foodKey: 'food_green_tea', quantity: 1 },
    ], // 48.0 + 2.0 + 0.8 + 0 = 50.8g
  },
  {
    id: 'ln_west_chicken_roll',
    label: '鶏むね肉ハーブソテー＆ロールパンランチ',
    mealTime: '昼食',
    tier: 'low',
    cuisine: 'western',
    items: [
      { foodKey: 'food_roll_bread', quantity: 1 },
      { foodKey: 'food_chicken_saute', quantity: 1 },
      { foodKey: 'food_potato_salad', quantity: 1 },
      { foodKey: 'food_corn_soup', quantity: 1 },
      { foodKey: 'food_black_coffee', quantity: 1 },
    ], // 28.0 + 0.5 + 13.5 + 12.5 + 0 = 54.5g
  },
  {
    id: 'ln_udon_salad',
    label: 'うどん＆卵焼き・サラダセット',
    mealTime: '昼食',
    tier: 'low',
    cuisine: 'noodle_chinese',
    items: [
      { foodKey: 'food_udon', quantity: 1 },
      { foodKey: 'food_tamagoyaki', quantity: 1 },
      { foodKey: 'food_green_salad', quantity: 1 },
      { foodKey: 'food_green_tea', quantity: 1 },
    ], // 52.0 + 2.5 + 3.5 + 0 = 58.0g
  },
  {
    id: 'ln_jp_ginger_pork',
    label: '豚肉の生姜焼き定食',
    mealTime: '昼食',
    tier: 'standard',
    cuisine: 'japanese',
    items: [
      { foodKey: 'food_rice', quantity: 1 },
      { foodKey: 'food_ginger_pork', quantity: 1 },
      { foodKey: 'food_kinpira', quantity: 1 },
      { foodKey: 'food_miso_soup', quantity: 1 },
      { foodKey: 'food_green_tea', quantity: 1 },
    ], // 55.2 + 6.5 + 9.5 + 3.8 + 0 = 75.0g
  },
  {
    id: 'ln_ramen_half_gyoza',
    label: '醤油ラーメン＆半餃子セット',
    mealTime: '昼食',
    tier: 'standard',
    cuisine: 'noodle_chinese',
    items: [
      { foodKey: 'food_ramen', quantity: 1 },
      { foodKey: 'food_gyoza', quantity: 0.5 },
      { foodKey: 'food_green_salad', quantity: 1 },
    ], // 65.0 + 14.0 + 3.5 = 82.5g
  },
  {
    id: 'ln_west_pasta_lunch',
    label: 'ミートソースパスタランチ',
    mealTime: '昼食',
    tier: 'standard',
    cuisine: 'western',
    items: [
      { foodKey: 'food_pasta', quantity: 1 },
      { foodKey: 'food_green_salad', quantity: 1 },
      { foodKey: 'food_corn_soup', quantity: 1 },
      { foodKey: 'food_black_coffee', quantity: 1 },
    ], // 70.0 + 3.5 + 12.5 + 0 = 86.0g
  },
  {
    id: 'ln_jp_onigiri_bento',
    label: 'おにぎり2個＆唐揚げ弁当',
    mealTime: '昼食',
    tier: 'standard',
    cuisine: 'japanese',
    items: [
      { foodKey: 'food_onigiri', quantity: 2 },
      { foodKey: 'food_karaage', quantity: 1 },
      { foodKey: 'food_tamagoyaki', quantity: 1 },
      { foodKey: 'food_green_tea', quantity: 1 },
    ], // 76.0 + 8.8 + 2.5 + 0 = 87.3g
  },
  // ==================== 昼食 (High Spike ~1.2x - 1.3x) ====================
  {
    id: 'ln_high_tendon_set',
    label: '天丼＆みそ汁セット（外食）',
    mealTime: '昼食',
    tier: 'high_spike',
    cuisine: 'japanese',
    items: [
      { foodKey: 'food_tendon', quantity: 1 },
      { foodKey: 'food_miso_soup', quantity: 1 },
      { foodKey: 'food_spinach_ohitashi', quantity: 1 },
      { foodKey: 'food_green_tea', quantity: 1 },
    ], // 115.0 + 3.8 + 0.8 + 0 = 119.6g
  },
  {
    id: 'ln_high_curry_set',
    label: '大盛ビーフカレー＆ポテトサラダ・カフェラテ',
    mealTime: '昼食',
    tier: 'high_spike',
    cuisine: 'western',
    items: [
      { foodKey: 'food_curry_rice', quantity: 1.2 },
      { foodKey: 'food_potato_salad', quantity: 1 },
      { foodKey: 'food_cafe_latte', quantity: 1 },
    ], // 102.0 + 13.5 + 6.8 = 122.3g
  },
  {
    id: 'ln_high_ramen_gyoza',
    label: '大盛醤油ラーメン＆焼き餃子6個（外食）',
    mealTime: '昼食',
    tier: 'high_spike',
    cuisine: 'noodle_chinese',
    items: [
      { foodKey: 'food_ramen', quantity: 1.5 },
      { foodKey: 'food_gyoza', quantity: 1 },
    ], // 97.5 + 28.0 = 125.5g
  },

  // ==================== 夕食 (Low / Standard <= 100g) ====================
  {
    id: 'dn_jp_salmon_tofu',
    label: '焼き鮭と冷奴の和食膳',
    mealTime: '夕食',
    tier: 'low',
    cuisine: 'japanese',
    items: [
      { foodKey: 'food_rice', quantity: 0.8 },
      { foodKey: 'food_grilled_salmon', quantity: 1 },
      { foodKey: 'food_tofu', quantity: 1 },
      { foodKey: 'food_hijiki', quantity: 1 },
      { foodKey: 'food_miso_soup', quantity: 1 },
    ], // 44.2 + 0.1 + 2.0 + 5.2 + 3.8 = 55.3g
  },
  {
    id: 'dn_jp_ginger_tonjiru',
    label: '豚肉の生姜焼き＆豚汁定食',
    mealTime: '夕食',
    tier: 'low',
    cuisine: 'japanese',
    items: [
      { foodKey: 'food_rice', quantity: 0.9 },
      { foodKey: 'food_ginger_pork', quantity: 1 },
      { foodKey: 'food_spinach_ohitashi', quantity: 1 },
      { foodKey: 'food_tonjiru', quantity: 1 },
    ], // 49.7 + 6.5 + 0.8 + 6.5 = 63.5g
  },
  {
    id: 'dn_jp_saba_misoni',
    label: 'サバの味噌煮定食',
    mealTime: '夕食',
    tier: 'standard',
    cuisine: 'japanese',
    items: [
      { foodKey: 'food_rice', quantity: 1 },
      { foodKey: 'food_saba_misoni', quantity: 1 },
      { foodKey: 'food_kinpira', quantity: 1 },
      { foodKey: 'food_miso_soup', quantity: 1 },
    ], // 55.2 + 11.2 + 9.5 + 3.8 = 79.7g
  },
  {
    id: 'dn_west_hamburg_set',
    label: 'ハンバーグ＆コーンスープ洋食セット',
    mealTime: '夕食',
    tier: 'standard',
    cuisine: 'western',
    items: [
      { foodKey: 'food_rice', quantity: 1 },
      { foodKey: 'food_hamburg', quantity: 1 },
      { foodKey: 'food_green_salad', quantity: 1 },
      { foodKey: 'food_corn_soup', quantity: 1 },
    ], // 55.2 + 12.5 + 3.5 + 12.5 = 83.7g
  },
  {
    id: 'dn_jp_sushi_set',
    label: '握り寿司(10貫)＆みそ汁セット',
    mealTime: '夕食',
    tier: 'standard',
    cuisine: 'japanese',
    items: [
      { foodKey: 'food_sushi_10', quantity: 1 },
      { foodKey: 'food_tamagoyaki', quantity: 1 },
      { foodKey: 'food_miso_soup', quantity: 1 },
      { foodKey: 'food_green_tea', quantity: 1 },
    ], // 78.0 + 2.5 + 3.8 + 0 = 84.3g
  },
  {
    id: 'dn_jp_karaage_tonjiru',
    label: '鶏の唐揚げ＆豚汁定食',
    mealTime: '夕食',
    tier: 'standard',
    cuisine: 'japanese',
    items: [
      { foodKey: 'food_rice', quantity: 1.1 },
      { foodKey: 'food_karaage', quantity: 1 },
      { foodKey: 'food_potato_salad', quantity: 1 },
      { foodKey: 'food_tonjiru', quantity: 1 },
    ], // 60.7 + 8.8 + 13.5 + 6.5 = 89.5g
  },
  // ==================== 夕食 (High Spike ~1.2x - 1.4x) ====================
  {
    id: 'dn_high_sushi_dango',
    label: '特上握り寿司(12貫)＆みたらし団子',
    mealTime: '夕食',
    tier: 'high_spike',
    cuisine: 'japanese',
    items: [
      { foodKey: 'food_sushi_10', quantity: 1.2 },
      { foodKey: 'food_miso_soup', quantity: 1 },
      { foodKey: 'food_mitarashi_dango', quantity: 1 },
      { foodKey: 'food_green_tea', quantity: 1 },
    ], // 93.6 + 3.8 + 24.0 + 0 = 121.4g
  },
  {
    id: 'dn_high_gyoza_karaage_dinner',
    label: '中華ディナー（大盛ごはん・焼き餃子・唐揚げ）',
    mealTime: '夕食',
    tier: 'high_spike',
    cuisine: 'japanese',
    items: [
      { foodKey: 'food_rice', quantity: 1.4 },
      { foodKey: 'food_gyoza', quantity: 1 },
      { foodKey: 'food_karaage', quantity: 1 },
      { foodKey: 'food_potato_salad', quantity: 1 },
    ], // 77.3 + 28.0 + 8.8 + 13.5 = 127.6g
  },
  {
    id: 'dn_high_pasta_shortcake',
    label: 'イタリアンディナー（大盛パスタ・コーンスープ・ショートケーキ）',
    mealTime: '夕食',
    tier: 'high_spike',
    cuisine: 'western',
    items: [
      { foodKey: 'food_pasta', quantity: 1.2 },
      { foodKey: 'food_green_salad', quantity: 1 },
      { foodKey: 'food_corn_soup', quantity: 1 },
      { foodKey: 'food_shortcake', quantity: 1 },
    ], // 84.0 + 3.5 + 12.5 + 38.5 = 138.5g
  },

  // ==================== 週末の間食・夜食 (間食) ====================
  {
    id: 'sn_nuts_choco',
    label: '素焼きナッツ＆高カカオチョコ',
    mealTime: '間食',
    tier: 'low',
    cuisine: 'snack',
    items: [
      { foodKey: 'food_mixed_nuts', quantity: 1 },
      { foodKey: 'food_high_cacao_choco', quantity: 1 },
      { foodKey: 'food_black_coffee', quantity: 1 },
    ], // 3.2 + 4.2 + 0 = 7.4g
  },
  {
    id: 'sn_cheesecake_coffee',
    label: 'ベイクドチーズケーキ＆コーヒー',
    mealTime: '間食',
    tier: 'standard',
    cuisine: 'snack',
    items: [
      { foodKey: 'food_cheesecake', quantity: 1 },
      { foodKey: 'food_black_coffee', quantity: 1 },
    ], // 22.0g
  },
  {
    id: 'sn_cream_puff_latte',
    label: 'シュークリーム＆カフェラテ',
    mealTime: '間食',
    tier: 'standard',
    cuisine: 'snack',
    items: [
      { foodKey: 'food_cream_puff', quantity: 1 },
      { foodKey: 'food_cafe_latte', quantity: 1 },
    ], // 18.5 + 6.8 = 25.3g
  },
  {
    id: 'sn_night_ice_cream',
    label: '夜食アイスクリーム',
    mealTime: '間食',
    tier: 'standard',
    cuisine: 'snack',
    items: [
      { foodKey: 'food_ice_cream', quantity: 1 },
      { foodKey: 'food_green_tea', quantity: 1 },
    ], // 23.2g
  },
  {
    id: 'sn_night_potato_chips',
    label: '夜食ポテトチップス',
    mealTime: '間食',
    tier: 'standard',
    cuisine: 'snack',
    items: [
      { foodKey: 'food_potato_chips', quantity: 1 },
      { foodKey: 'food_green_tea', quantity: 1 },
    ], // 32.8g
  },
];

const FOOD_BY_KEY = new Map(INITIAL_FOODS.map((f) => [f.key, f]));

/**
 * 糖質量（totalCarbs）と食前血糖値（preMealGlucose）、および食後ピーク血糖値に基づき、
 * 臨床カーボカウント理論（ICR: 糖質/インスリン比 + ISF: インスリン効果値補正）から
 * リアルな超速効型インスリン単位数を算出する。
 */
export function calculateRealisticInsulinUnits(
  mealTime: '朝食' | '昼食' | '夕食' | '間食',
  totalCarbs: number,
  preMealGlucose: number,
  postMealPeakGlucose: number
): number {
  if (totalCarbs < 8) {
    return 0;
  }
  const icr = mealTime === '朝食' ? 8.5 : mealTime === '夕食' ? 9.5 : 10.0;
  const carbBolus = totalCarbs / icr;
  const correctionBolus = Math.max(0, (preMealGlucose - 110) / 50);
  const underDoseAdjustment = postMealPeakGlucose >= 215 && totalCarbs >= 95 ? -1.0 : 0;

  const rawUnits = carbBolus + correctionBolus + underDoseAdjustment;
  return Math.max(1, Math.round(rawUnits));
}

function parseMinuteOfDay(isoTimestamp: string): number {
  const hh = Number(isoTimestamp.slice(11, 13));
  const mm = Number(isoTimestamp.slice(14, 16));
  return hh * 60 + mm;
}

function formatMinuteToHHMM(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(totalMinutes)));
  const hh = String(Math.floor(clamped / 60)).padStart(2, '0');
  const mm = String(clamped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function deterministicHash(seedStr: string): number {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 指定された食事時間帯ウィンドウ内で、実測CGM波形の「上昇開始直前の谷（食前血糖値）」と
 * 「その後30〜180分以内の最高値（食後ピーク血糖値）」を探索する。
 */
function findMealGlucoseWindow(
  dayReadings: LibreReading[],
  windowStartMin: number,
  windowEndMin: number,
  defaultMinute: number
): { mealMinute: number; preGlucose: number; postPeakGlucose: number } {
  const indexedDayReadings = dayReadings.map((r) => ({
    reading: r,
    min: parseMinuteOfDay(r.timestamp),
  }));
  const candidates = indexedDayReadings.filter(
    (item) => item.min >= windowStartMin && item.min <= windowEndMin
  );

  if (candidates.length === 0) {
    const fallbackReading = dayReadings[Math.floor(dayReadings.length / 2)];
    const baseVal = fallbackReading ? fallbackReading.glucose_value : 108;
    return {
      mealMinute: defaultMinute,
      preGlucose: baseVal,
      postPeakGlucose: Math.max(baseVal + 42, 145),
    };
  }

  let bestPreItem = candidates[0];
  let bestPostPeak = candidates[0].reading.glucose_value;
  let bestDelta = -999;

  for (const cand of candidates) {
    const candMin = cand.min;
    let localPeak = cand.reading.glucose_value;
    for (const item of indexedDayReadings) {
      if (item.min >= candMin + 20 && item.min <= candMin + 180) {
        if (item.reading.glucose_value > localPeak) {
          localPeak = item.reading.glucose_value;
        }
      }
    }
    const delta = localPeak - cand.reading.glucose_value;
    if (delta > bestDelta) {
      bestDelta = delta;
      bestPreItem = cand;
      bestPostPeak = localPeak;
    }
  }

  const mealMinute = bestPreItem.min;
  const preGlucose = bestPreItem.reading.glucose_value;
  const postPeakGlucose = Math.max(preGlucose + 18, bestPostPeak);

  return { mealMinute, preGlucose, postPeakGlucose };
}

/**
 * 実測CGMデータ（2026年1月〜2026年8月）の血糖変動曲線に連動したリアルな
 * 1日3食＋週末ランダム間食・インスリン・運動データを生成する。
 */
export function generateRealisticEventsFromReadings(
  readings: LibreReading[],
  patientId: string,
  nowIso: string
): { mealAndActivityEvents: HealthEvent[]; mealDetails: MealDetail[] } {
  const byDate = new Map<string, LibreReading[]>();
  for (const r of readings) {
    const dateStr = r.timestamp.slice(0, 10);
    // 2026年1月以降の全測定日に対してリアルな食事・インスリン・活動を生成
    if (dateStr < '2026-01-01') continue;
    const arr = byDate.get(dateStr);
    if (arr) {
      arr.push(r);
    } else {
      byDate.set(dateStr, [r]);
    }
  }

  const mealAndActivityEvents: HealthEvent[] = [];
  const mealDetails: MealDetail[] = [];

  const templatesByMealAndTier = {
    朝食: {
      low: MEAL_TEMPLATES.filter((t) => t.mealTime === '朝食' && t.tier === 'low'),
      standard: MEAL_TEMPLATES.filter((t) => t.mealTime === '朝食' && t.tier === 'standard'),
      high_spike: MEAL_TEMPLATES.filter((t) => t.mealTime === '朝食' && t.tier === 'high_spike'),
    },
    昼食: {
      low: MEAL_TEMPLATES.filter((t) => t.mealTime === '昼食' && t.tier === 'low'),
      standard: MEAL_TEMPLATES.filter((t) => t.mealTime === '昼食' && t.tier === 'standard'),
      high_spike: MEAL_TEMPLATES.filter((t) => t.mealTime === '昼食' && t.tier === 'high_spike'),
    },
    夕食: {
      low: MEAL_TEMPLATES.filter((t) => t.mealTime === '夕食' && t.tier === 'low'),
      standard: MEAL_TEMPLATES.filter((t) => t.mealTime === '夕食' && t.tier === 'standard'),
      high_spike: MEAL_TEMPLATES.filter((t) => t.mealTime === '夕食' && t.tier === 'high_spike'),
    },
    間食: {
      all: MEAL_TEMPLATES.filter((t) => t.mealTime === '間食'),
    },
  };

  const mealWindows: Array<{
    mealTime: '朝食' | '昼食' | '夕食';
    startMin: number;
    endMin: number;
    defaultMin: number;
  }> = [
    { mealTime: '朝食', startMin: 6 * 60 + 30, endMin: 9 * 60, defaultMin: 7 * 60 + 30 },
    { mealTime: '昼食', startMin: 11 * 60 + 30, endMin: 13 * 60 + 45, defaultMin: 12 * 60 + 20 },
    { mealTime: '夕食', startMin: 18 * 60, endMin: 20 * 60 + 45, defaultMin: 19 * 60 + 15 },
  ];

  for (const [dateStr, dayReadings] of byDate.entries()) {
    if (dayReadings.length < 12) continue;

    const [y, m, d] = dateStr.split('-').map(Number);
    const dayOfWeek = new Date(y, m - 1, d).getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    // 1. 毎日3食（朝食・昼食・夕食）の生成
    for (const win of mealWindows) {
      const { mealMinute, preGlucose, postPeakGlucose } = findMealGlucoseWindow(
        dayReadings,
        win.startMin,
        win.endMin,
        win.defaultMin
      );
      const delta = postPeakGlucose - preGlucose;
      const hash = deterministicHash(`${dateStr}_${win.mealTime}`);

      let tier: 'low' | 'standard' | 'high_spike' = 'standard';
      if ((postPeakGlucose >= 195 || delta >= 82) && hash % 10 < 6) {
        tier = 'high_spike';
      } else if (delta < 42 && postPeakGlucose < 160) {
        tier = 'low';
      } else {
        tier = 'standard';
      }

      const pool = templatesByMealAndTier[win.mealTime][tier];
      const chosenTemplate = pool[hash % pool.length];

      let totalCarbs = 0;
      const summaryParts: string[] = [];
      const eventIdSeed = `${patientId}_meal_${dateStr}_${win.mealTime}`;
      const eventId = deterministicUuid(eventIdSeed);

      chosenTemplate.items.forEach((itemSpec, idx) => {
        const foodDef = FOOD_BY_KEY.get(itemSpec.foodKey);
        if (!foodDef) return;
        const itemCarbs = Math.round(foodDef.carbs_per_unit * itemSpec.quantity * 10) / 10;
        const itemAmount = Math.round(foodDef.base_amount * itemSpec.quantity * 10) / 10;
        totalCarbs = Math.round((totalCarbs + itemCarbs) * 10) / 10;
        summaryParts.push(
          itemSpec.quantity === 1
            ? foodDef.food_name
            : `${foodDef.food_name}(${itemAmount}${foodDef.unit.replace(/\(.*\)/, '')})`
        );

        mealDetails.push({
          id: deterministicUuid(`${eventIdSeed}_item_${idx}`),
          event_id: eventId,
          user_id: patientId,
          food_name: foodDef.food_name,
          amount: itemAmount,
          unit: foodDef.unit,
          carbs: itemCarbs,
          is_deleted: false,
          created_at: nowIso,
          updated_at: nowIso,
        });
      });

      const insulinUnits = calculateRealisticInsulinUnits(
        win.mealTime,
        totalCarbs,
        preGlucose,
        postPeakGlucose
      );

      const hhmm = formatMinuteToHHMM(mealMinute);
      mealAndActivityEvents.push({
        id: eventId,
        user_id: patientId,
        event_datetime: `${dateStr}T${hhmm}:00.000Z`,
        event_type: '食事',
        timing_category: win.mealTime,
        memo: summaryParts.join('、'),
        total_carbs: totalCarbs,
        insulin_units: insulinUnits,
        pre_meal_glucose: preGlucose,
        post_meal_glucose: postPeakGlucose,
        is_deleted: false,
        created_at: nowIso,
        updated_at: nowIso,
      });
    }

    // 2. 週末（土曜・日曜）のランダム間食・夜食（約65%の週末日に登録）
    const weekendHash = deterministicHash(`${dateStr}_weekend_snack`);
    if (isWeekend && weekendHash % 10 < 7) {
      const isLateNightSnack = weekendHash % 2 === 1;
      const snackWinStart = isLateNightSnack ? 21 * 60 : 14 * 60 + 30;
      const snackWinEnd = isLateNightSnack ? 22 * 60 + 15 : 16 * 60 + 15;
      const snackDefaultMin = isLateNightSnack ? 21 * 60 + 30 : 15 * 60 + 15;

      const { mealMinute, preGlucose, postPeakGlucose } = findMealGlucoseWindow(
        dayReadings,
        snackWinStart,
        snackWinEnd,
        snackDefaultMin
      );

      const snackPool = isLateNightSnack
        ? templatesByMealAndTier['間食'].all.filter(
            (t) =>
              t.id === 'sn_night_ice_cream' ||
              t.id === 'sn_night_potato_chips' ||
              t.id === 'sn_nuts_choco'
          )
        : templatesByMealAndTier['間食'].all.filter(
            (t) =>
              t.id === 'sn_cheesecake_coffee' ||
              t.id === 'sn_cream_puff_latte' ||
              t.id === 'sn_nuts_choco'
          );
      const chosenSnack = snackPool[weekendHash % snackPool.length];
      const snackEventIdSeed = `${patientId}_meal_${dateStr}_間食`;
      const snackEventId = deterministicUuid(snackEventIdSeed);

      let snackCarbs = 0;
      const snackSummaryParts: string[] = [];

      chosenSnack.items.forEach((itemSpec, idx) => {
        const foodDef = FOOD_BY_KEY.get(itemSpec.foodKey);
        if (!foodDef) return;
        const itemCarbs = Math.round(foodDef.carbs_per_unit * itemSpec.quantity * 10) / 10;
        const itemAmount = Math.round(foodDef.base_amount * itemSpec.quantity * 10) / 10;
        snackCarbs = Math.round((snackCarbs + itemCarbs) * 10) / 10;
        snackSummaryParts.push(foodDef.food_name);

        mealDetails.push({
          id: deterministicUuid(`${snackEventIdSeed}_item_${idx}`),
          event_id: snackEventId,
          user_id: patientId,
          food_name: foodDef.food_name,
          amount: itemAmount,
          unit: foodDef.unit,
          carbs: itemCarbs,
          is_deleted: false,
          created_at: nowIso,
          updated_at: nowIso,
        });
      });

      const snackInsulin = calculateRealisticInsulinUnits(
        '間食',
        snackCarbs,
        preGlucose,
        postPeakGlucose
      );

      const snackHHMM = formatMinuteToHHMM(mealMinute);
      mealAndActivityEvents.push({
        id: snackEventId,
        user_id: patientId,
        event_datetime: `${dateStr}T${snackHHMM}:00.000Z`,
        event_type: '食事',
        timing_category: '間食',
        memo: snackSummaryParts.join('、'),
        total_carbs: snackCarbs,
        insulin_units: snackInsulin,
        pre_meal_glucose: preGlucose,
        post_meal_glucose: postPeakGlucose,
        is_deleted: false,
        created_at: nowIso,
        updated_at: nowIso,
      });
    }

    // 3. 毎晩の持効型インスリン投与（22:00 定時 10U）
    mealAndActivityEvents.push({
      id: deterministicUuid(`${patientId}_basal_${dateStr}`),
      user_id: patientId,
      event_datetime: `${dateStr}T22:00:00.000Z`,
      event_type: '活動',
      timing_category: 'インスリン',
      memo: '持効型インスリン投与 (就寝前)',
      insulin_units: 10,
      duration_minutes: 0,
      is_deleted: false,
      created_at: nowIso,
      updated_at: nowIso,
    });

    // 4. 週3回程度の有酸素運動・ストレッチ記録
    const exerciseHash = deterministicHash(`${dateStr}_exercise`);
    if (exerciseHash % 7 < 3) {
      const exType =
        exerciseHash % 3 === 0
          ? 'ジョギング'
          : exerciseHash % 3 === 1
            ? 'ウォーキング'
            : '軽い運動・ストレッチ';
      const exDuration = exType === 'ウォーキング' ? 30 : 20;
      const exHour = isWeekend ? '10:30' : '20:15';
      mealAndActivityEvents.push({
        id: deterministicUuid(`${patientId}_exercise_${dateStr}`),
        user_id: patientId,
        event_datetime: `${dateStr}T${exHour}:00.000Z`,
        event_type: '活動',
        timing_category: '運動',
        memo: exType,
        duration_minutes: exDuration,
        is_deleted: false,
        created_at: nowIso,
        updated_at: nowIso,
      });
    }
  }

  return { mealAndActivityEvents, mealDetails };
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
  hypoThreshold: number = 70,
  hyperThreshold: number = 180
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

      invalidateAnalysisDatasetCache();
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
  hypoThreshold: number = 70,
  hyperThreshold: number = 180
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
  currentThresholdsByPatient.set(patientId, { hypo: 70, hyper: 180 });
  initializedPatients.delete(patientId);
  hasResetPortfolioSession = false;
  resetFoodSeedSession(patientId);
  invalidateAnalysisDatasetCache();

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

  await ensureRealGlucoseDataLoaded(patientId, 70, 180);
  await waitForRecentPersistence(patientId);
  await seedFoodMasterIfEmpty(patientId);
}
