import { HealthEvent, LibreReading, MealDetail } from '@/types/database';
import { INITIAL_FOODS } from './foodSeed';
import { deterministicUuid } from './uuidUtils';

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
export function findMealGlucoseWindow(
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
