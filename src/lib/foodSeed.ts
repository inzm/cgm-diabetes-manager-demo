import { db } from './db';
import { Category, EventMaster, FoodMaster } from '@/types/database';
import { deterministicUuid, ensureUuid, isValidUuid } from './uuidUtils';

const activeSeedPromises = new Map<string, Promise<void>>();
const seededPatientsInSession = new Set<string>();

export interface InitialCategoryDef {
  key: string;
  target_type: 'food' | 'event';
  category_name: string;
  sort_order: number;
  is_protected: boolean;
}

export interface InitialFoodDef {
  key: string;
  categoryKey: string;
  food_name: string;
  base_amount: number;
  unit: string;
  carbs_per_unit: number;
  notes?: string;
}

export interface InitialEventDef {
  key: string;
  categoryKey: string;
  event_name: string;
  default_duration: number;
  notes: string;
}

export const INITIAL_CATEGORIES: InitialCategoryDef[] = [
  // 食品カテゴリ（未分類のみ削除保護 is_protected: true、他はすべてユーザーが自由に削除・再編可能）
  { key: 'cat_food_staple', target_type: 'food', category_name: '主食', sort_order: 1, is_protected: false },
  { key: 'cat_food_main', target_type: 'food', category_name: '主菜', sort_order: 2, is_protected: false },
  { key: 'cat_food_side', target_type: 'food', category_name: '副菜', sort_order: 3, is_protected: false },
  { key: 'cat_food_snack', target_type: 'food', category_name: '間食・デザート', sort_order: 4, is_protected: false },
  { key: 'cat_food_drink', target_type: 'food', category_name: '飲料', sort_order: 5, is_protected: false },
  { key: 'cat_food_uncategorized', target_type: 'food', category_name: '未分類', sort_order: 99, is_protected: true },
  // 活動カテゴリ（未分類のみ削除保護 is_protected: true）
  { key: 'cat_event_exercise', target_type: 'event', category_name: '運動', sort_order: 1, is_protected: false },
  { key: 'cat_event_life', target_type: 'event', category_name: '生活・入浴', sort_order: 2, is_protected: false },
  { key: 'cat_event_uncategorized', target_type: 'event', category_name: '未分類', sort_order: 99, is_protected: true },
];

/**
 * 日本食品標準成分表（八訂）および臨床カーボカウント基準に準拠した初期食品データ（28品目）
 * スマホ操作で入力・選択しやすいシンプルな食品名と単位に統一。
 */
export const INITIAL_FOODS: InitialFoodDef[] = [
  // 主食
  {
    key: 'food_rice',
    categoryKey: 'cat_food_staple',
    food_name: 'ごはん',
    base_amount: 1,
    unit: '杯',
    carbs_per_unit: 55.2,
    notes: '白米お茶碗1杯（約150g）',
  },
  {
    key: 'food_onigiri',
    categoryKey: 'cat_food_staple',
    food_name: 'おにぎり',
    base_amount: 1,
    unit: '個',
    carbs_per_unit: 38.0,
    notes: 'コンビニ標準サイズ',
  },
  {
    key: 'food_toast_6',
    categoryKey: 'cat_food_staple',
    food_name: '食パン',
    base_amount: 1,
    unit: '枚',
    carbs_per_unit: 26.6,
    notes: '6枚切り1枚',
  },
  {
    key: 'food_roll_bread',
    categoryKey: 'cat_food_staple',
    food_name: 'ロールパン',
    base_amount: 1,
    unit: '個',
    carbs_per_unit: 14.0,
    notes: 'バターロール1個',
  },
  {
    key: 'food_tempura_udon',
    categoryKey: 'cat_food_staple',
    food_name: '天ぷらうどん',
    base_amount: 1,
    unit: '人前',
    carbs_per_unit: 58.0,
    notes: 'うどん1玉＋えび天',
  },
  {
    key: 'food_oroshi_soba',
    categoryKey: 'cat_food_staple',
    food_name: 'おろしそば',
    base_amount: 1,
    unit: '人前',
    carbs_per_unit: 48.0,
    notes: 'そば1玉＋大根おろし',
  },
  {
    key: 'food_ramen',
    categoryKey: 'cat_food_staple',
    food_name: '醤油ラーメン',
    base_amount: 1,
    unit: '人前',
    carbs_per_unit: 65.0,
    notes: '中華麺1玉＋醤油スープ',
  },
  {
    key: 'food_pasta',
    categoryKey: 'cat_food_staple',
    food_name: 'ミートソースパスタ',
    base_amount: 1,
    unit: '人前',
    carbs_per_unit: 70.0,
    notes: 'スパゲッティ1人前',
  },
  {
    key: 'food_curry_rice',
    categoryKey: 'cat_food_staple',
    food_name: 'カレーライス',
    base_amount: 1,
    unit: '人前',
    carbs_per_unit: 85.0,
    notes: 'ごはん＋カレールー',
  },

  // 主菜
  {
    key: 'food_bacon_egg',
    categoryKey: 'cat_food_main',
    food_name: '目玉焼き・ベーコン',
    base_amount: 1,
    unit: '人前',
    carbs_per_unit: 0.5,
    notes: '卵1個＋ベーコン2枚',
  },
  {
    key: 'food_tamagoyaki',
    categoryKey: 'cat_food_main',
    food_name: '卵焼き',
    base_amount: 1,
    unit: '人前',
    carbs_per_unit: 2.5,
    notes: 'だし巻き・厚焼き卵',
  },
  {
    key: 'food_grilled_salmon',
    categoryKey: 'cat_food_main',
    food_name: '鮭の塩焼き',
    base_amount: 1,
    unit: '切れ',
    carbs_per_unit: 0.1,
    notes: '焼き魚',
  },
  {
    key: 'food_karaage',
    categoryKey: 'cat_food_main',
    food_name: '鶏の唐揚げ',
    base_amount: 1,
    unit: '人前',
    carbs_per_unit: 8.8,
    notes: '唐揚げ4個程度',
  },
  {
    key: 'food_ginger_pork',
    categoryKey: 'cat_food_main',
    food_name: '豚の生姜焼き',
    base_amount: 1,
    unit: '人前',
    carbs_per_unit: 6.5,
    notes: '豚ロース生姜焼き',
  },
  {
    key: 'food_hamburg',
    categoryKey: 'cat_food_main',
    food_name: 'ハンバーグ',
    base_amount: 1,
    unit: '個',
    carbs_per_unit: 12.5,
    notes: 'デミグラスソース',
  },
  {
    key: 'food_gyoza',
    categoryKey: 'cat_food_main',
    food_name: '焼き餃子',
    base_amount: 1,
    unit: '人前',
    carbs_per_unit: 28.0,
    notes: '餃子6個',
  },
  {
    key: 'food_natto',
    categoryKey: 'cat_food_main',
    food_name: '納豆',
    base_amount: 1,
    unit: 'パック',
    carbs_per_unit: 2.2,
    notes: '添付たれ含む',
  },

  // 副菜
  {
    key: 'food_green_salad',
    categoryKey: 'cat_food_side',
    food_name: '野菜サラダ',
    base_amount: 1,
    unit: '皿',
    carbs_per_unit: 3.5,
    notes: '生野菜サラダ',
  },
  {
    key: 'food_miso_soup',
    categoryKey: 'cat_food_side',
    food_name: 'みそ汁',
    base_amount: 1,
    unit: '杯',
    carbs_per_unit: 3.8,
    notes: '豆腐・わかめ',
  },
  {
    key: 'food_tonjiru',
    categoryKey: 'cat_food_side',
    food_name: '豚汁',
    base_amount: 1,
    unit: '杯',
    carbs_per_unit: 6.5,
    notes: '具だくさん豚汁',
  },

  // 間食・デザート
  {
    key: 'food_banana',
    categoryKey: 'cat_food_snack',
    food_name: 'バナナ',
    base_amount: 1,
    unit: '本',
    carbs_per_unit: 21.4,
    notes: '中1本',
  },
  {
    key: 'food_yogurt_plain',
    categoryKey: 'cat_food_snack',
    food_name: 'ヨーグルト',
    base_amount: 1,
    unit: '個',
    carbs_per_unit: 4.9,
    notes: 'プレーン無糖',
  },
  {
    key: 'food_cream_puff',
    categoryKey: 'cat_food_snack',
    food_name: 'シュークリーム',
    base_amount: 1,
    unit: '個',
    carbs_per_unit: 18.5,
    notes: 'カスタード＆ホイップ',
  },
  {
    key: 'food_ice_cream',
    categoryKey: 'cat_food_snack',
    food_name: 'アイスクリーム',
    base_amount: 1,
    unit: '個',
    carbs_per_unit: 23.2,
    notes: 'ミニカップ1個',
  },

  // 飲料
  {
    key: 'food_milk',
    categoryKey: 'cat_food_drink',
    food_name: '牛乳',
    base_amount: 1,
    unit: '杯',
    carbs_per_unit: 9.6,
    notes: 'コップ1杯',
  },
  {
    key: 'food_cafe_latte',
    categoryKey: 'cat_food_drink',
    food_name: 'カフェラテ',
    base_amount: 1,
    unit: '杯',
    carbs_per_unit: 6.8,
    notes: '無糖カフェラテ',
  },
  {
    key: 'food_black_coffee',
    categoryKey: 'cat_food_drink',
    food_name: 'ブラックコーヒー',
    base_amount: 1,
    unit: '杯',
    carbs_per_unit: 0.0,
    notes: '無糖コーヒー',
  },
  {
    key: 'food_green_tea',
    categoryKey: 'cat_food_drink',
    food_name: '緑茶',
    base_amount: 1,
    unit: '杯',
    carbs_per_unit: 0.0,
    notes: '無糖緑茶',
  },
];

export const INITIAL_EVENTS: InitialEventDef[] = [
  {
    key: 'event_walking',
    categoryKey: 'cat_event_exercise',
    event_name: 'ウォーキング',
    default_duration: 30,
    notes: '食後の有酸素運動（中強度）',
  },
  {
    key: 'event_stretching',
    categoryKey: 'cat_event_exercise',
    event_name: '軽い運動・ストレッチ',
    default_duration: 20,
    notes: '室内での体操・ストレッチ',
  },
  {
    key: 'event_jogging',
    categoryKey: 'cat_event_exercise',
    event_name: 'ジョギング',
    default_duration: 20,
    notes: '有酸素運動（やや高強度）',
  },
  {
    key: 'event_strength',
    categoryKey: 'cat_event_exercise',
    event_name: '筋力トレーニング',
    default_duration: 30,
    notes: 'スクワット・自重トレーニング',
  },
  {
    key: 'event_bath',
    categoryKey: 'cat_event_life',
    event_name: '入浴',
    default_duration: 20,
    notes: '血行促進によるインスリン吸収変化に留意',
  },
];

/**
 * よく使う食品・活動・カテゴリの初期データを重複ゼロで投入・整合化する。
 * - 並行呼び出し時はシングルトンPromiseで排他制御を行う。
 * - 決定論的UUID（`deterministicUuid(`${patientId}_${key}`)`）を用いて冪等にupsertする。
 * - 過去にランダムUUIDまたは旧形式文字列IDで重複登録された同名カテゴリ・同名食品・同名活動が存在する場合は自動統合・削除する。
 */
export async function seedFoodMasterIfEmpty(patientId: string): Promise<void> {
  const sampleStapleCatId = deterministicUuid(`${patientId}_cat_food_staple`);
  if (seededPatientsInSession.has(patientId)) {
    const sampleCat = await db.categories.get(sampleStapleCatId);
    if (sampleCat) {
      return;
    }
    seededPatientsInSession.delete(patientId);
  }
  const existingLock = activeSeedPromises.get(patientId);
  if (existingLock) {
    return existingLock;
  }

  const task = (async () => {
    const now = '2020-01-01T00:00:00.000Z';

    await db.transaction('rw', db.categories, db.food_master, db.event_master, async () => {
      const existingCats = await db.categories.where('user_id').equals(patientId).toArray();
      const existingCatById = new Map(existingCats.map((c) => [c.id, c]));
      const existingCatByKey = new Map(
        existingCats.map((c) => [`${c.target_type}:${c.category_name}`, c])
      );

      const existingFoods = await db.food_master.where('user_id').equals(patientId).toArray();
      const existingFoodById = new Map(existingFoods.map((f) => [f.id, f]));
      const existingFoodByName = new Map(existingFoods.map((f) => [f.food_name, f]));

      const existingEvents = await db.event_master.where('user_id').equals(patientId).toArray();
      const existingEventById = new Map(existingEvents.map((e) => [e.id, e]));
      const existingEventByName = new Map(existingEvents.map((e) => [e.event_name, e]));

      // 1. 標準カテゴリを決定論的UUIDで作成（既存の削除・編集状態は維持しつつ、is_protectedのみ最新仕様へ同期）
      const canonicalCategories: Category[] = INITIAL_CATEGORIES.map((def) => {
        const legacyId = `${patientId}_${def.key}`;
        const id = deterministicUuid(legacyId);
        const prev =
          existingCatById.get(id) ??
          existingCatById.get(legacyId) ??
          existingCatByKey.get(`${def.target_type}:${def.category_name}`);
        if (prev) {
          return {
            ...prev,
            id,
            is_protected: def.is_protected,
            is_deleted: def.is_protected ? false : prev.is_deleted,
          };
        }
        return {
          id,
          user_id: patientId,
          target_type: def.target_type,
          category_name: def.category_name,
          display_order: def.sort_order,
          is_protected: def.is_protected,
          is_deleted: false,
          created_at: now,
          updated_at: now,
        };
      });
      await db.categories.bulkPut(canonicalCategories);

      // 2. カテゴリの重複排除（target_type + category_name が同一の別IDレコードを統合・削除）
      const allCategories = await db.categories.where('user_id').equals(patientId).toArray();
      const canonicalCatMap = new Map<string, Category>();
      for (const cat of canonicalCategories) {
        canonicalCatMap.set(`${cat.target_type}:${cat.category_name}`, cat);
      }

      const duplicateCatIdsToRemove: string[] = [];
      const catIdRemap = new Map<string, string>();
      for (const def of INITIAL_CATEGORIES) {
        const legacyId = `${patientId}_${def.key}`;
        const id = deterministicUuid(legacyId);
        catIdRemap.set(legacyId, id);
      }

      for (const cat of allCategories) {
        const mapKey = `${cat.target_type}:${cat.category_name}`;
        const existingCanonical = canonicalCatMap.get(mapKey);
        if (!existingCanonical) {
          if (!isValidUuid(cat.id)) {
            const normalizedCatId = ensureUuid(cat.id);
            const migratedCat: Category = { ...cat, id: normalizedCatId };
            await db.categories.put(migratedCat);
            duplicateCatIdsToRemove.push(cat.id);
            catIdRemap.set(cat.id, normalizedCatId);
            canonicalCatMap.set(mapKey, migratedCat);
          } else {
            canonicalCatMap.set(mapKey, cat);
          }
        } else if (cat.id !== existingCanonical.id) {
          duplicateCatIdsToRemove.push(cat.id);
          catIdRemap.set(cat.id, existingCanonical.id);
        }
      }

      // 3. 標準食品を決定論的UUIDで作成（未登録の初期食品のみ追加し、既存の編集・削除状態を保持）
      const canonicalFoodsToPut: FoodMaster[] = [];
      const canonicalFoodByName = new Map<string, FoodMaster>();

      for (const def of INITIAL_FOODS) {
        const legacyId = `${patientId}_${def.key}`;
        const id = deterministicUuid(legacyId);
        const defaultCategoryId = deterministicUuid(`${patientId}_${def.categoryKey}`);
        const prev =
          existingFoodById.get(id) ??
          existingFoodById.get(legacyId) ??
          existingFoodByName.get(def.food_name);
        if (prev) {
          const normalizedCatId = prev.category_id
            ? (catIdRemap.get(prev.category_id) ?? ensureUuid(prev.category_id, defaultCategoryId))
            : defaultCategoryId;
          const updatedPrev: FoodMaster = {
            ...prev,
            id,
            category_id: normalizedCatId,
          };
          if (prev.id !== id || prev.category_id !== normalizedCatId) {
            canonicalFoodsToPut.push(updatedPrev);
          }
          canonicalFoodByName.set(updatedPrev.food_name, updatedPrev);
        } else {
          const created: FoodMaster = {
            id,
            user_id: patientId,
            category_id: defaultCategoryId,
            food_name: def.food_name,
            base_amount: def.base_amount,
            unit: def.unit,
            carbs_per_unit: def.carbs_per_unit,
            is_deleted: false,
            created_at: now,
            updated_at: now,
          };
          canonicalFoodsToPut.push(created);
          canonicalFoodByName.set(created.food_name, created);
        }
      }
      if (canonicalFoodsToPut.length > 0) {
        await db.food_master.bulkPut(canonicalFoodsToPut);
      }

      // 旧表記の「うどん (玉(200g)=35g)」や重複食品をクレンジング
      const allFoods = await db.food_master.where('user_id').equals(patientId).toArray();
      const duplicateFoodIdsToRemove: string[] = [];
      const foodsToUpdateCategory: FoodMaster[] = [];

      for (const food of allFoods) {
        const canonical = canonicalFoodByName.get(food.food_name);
        if (!canonical) {
          const normalizedId = ensureUuid(food.id);
          const normalizedCatId = food.category_id
            ? (catIdRemap.get(food.category_id) ?? ensureUuid(food.category_id))
            : food.category_id;
          const updatedFood: FoodMaster = {
            ...food,
            id: normalizedId,
            category_id: normalizedCatId,
          };
          canonicalFoodByName.set(food.food_name, updatedFood);
          if (normalizedId !== food.id || normalizedCatId !== food.category_id) {
            foodsToUpdateCategory.push(updatedFood);
            if (normalizedId !== food.id) {
              duplicateFoodIdsToRemove.push(food.id);
            }
          }
        } else if (food.id !== canonical.id) {
          duplicateFoodIdsToRemove.push(food.id);
        }
      }

      if (foodsToUpdateCategory.length > 0) {
        await db.food_master.bulkPut(foodsToUpdateCategory);
      }
      if (duplicateFoodIdsToRemove.length > 0) {
        await db.food_master.bulkDelete(duplicateFoodIdsToRemove);
      }

      // 4. 標準活動を決定論的UUIDで作成（未登録の初期活動のみ追加し、既存の編集・削除状態を保持）
      const canonicalEventsToPut: EventMaster[] = [];
      const canonicalEventByName = new Map<string, EventMaster>();

      for (const def of INITIAL_EVENTS) {
        const legacyId = `${patientId}_${def.key}`;
        const id = deterministicUuid(legacyId);
        const defaultCategoryId = deterministicUuid(`${patientId}_${def.categoryKey}`);
        const prev =
          existingEventById.get(id) ??
          existingEventById.get(legacyId) ??
          existingEventByName.get(def.event_name);
        if (prev) {
          const normalizedCatId = prev.category_id
            ? (catIdRemap.get(prev.category_id) ?? ensureUuid(prev.category_id, defaultCategoryId))
            : defaultCategoryId;
          const updatedPrev: EventMaster = {
            ...prev,
            id,
            category_id: normalizedCatId,
          };
          if (prev.id !== id || prev.category_id !== normalizedCatId) {
            canonicalEventsToPut.push(updatedPrev);
          }
          canonicalEventByName.set(updatedPrev.event_name, updatedPrev);
        } else {
          const created: EventMaster = {
            id,
            user_id: patientId,
            category_id: defaultCategoryId,
            event_name: def.event_name,
            default_duration: def.default_duration,
            memo: def.notes,
            is_deleted: false,
            created_at: now,
            updated_at: now,
          };
          canonicalEventsToPut.push(created);
          canonicalEventByName.set(created.event_name, created);
        }
      }
      if (canonicalEventsToPut.length > 0) {
        await db.event_master.bulkPut(canonicalEventsToPut);
      }

      // 旧表記の重複活動（「軽い運動」など）および同名活動の重複排除
      const allEventMasters = await db.event_master.where('user_id').equals(patientId).toArray();

      const duplicateEventMasterIdsToRemove: string[] = [];
      const eventsToUpdateCategory: EventMaster[] = [];
      const stretchingId = deterministicUuid(`${patientId}_event_stretching`);

      for (const ev of allEventMasters) {
        // 旧名称「軽い運動」は「軽い運動・ストレッチ」に統合
        if (ev.event_name === '軽い運動' && ev.id !== stretchingId) {
          duplicateEventMasterIdsToRemove.push(ev.id);
          continue;
        }
        const canonical = canonicalEventByName.get(ev.event_name);
        if (!canonical) {
          const normalizedId = ensureUuid(ev.id);
          const normalizedCatId = ev.category_id
            ? (catIdRemap.get(ev.category_id) ?? ensureUuid(ev.category_id))
            : ev.category_id;
          const updatedEv: EventMaster = {
            ...ev,
            id: normalizedId,
            category_id: normalizedCatId,
          };
          canonicalEventByName.set(ev.event_name, updatedEv);
          if (normalizedId !== ev.id || normalizedCatId !== ev.category_id) {
            eventsToUpdateCategory.push(updatedEv);
            if (normalizedId !== ev.id) {
              duplicateEventMasterIdsToRemove.push(ev.id);
            }
          }
        } else if (ev.id !== canonical.id) {
          duplicateEventMasterIdsToRemove.push(ev.id);
        }
      }

      if (eventsToUpdateCategory.length > 0) {
        await db.event_master.bulkPut(eventsToUpdateCategory);
      }
      if (duplicateEventMasterIdsToRemove.length > 0) {
        await db.event_master.bulkDelete(duplicateEventMasterIdsToRemove);
      }
      if (duplicateCatIdsToRemove.length > 0) {
        await db.categories.bulkDelete(duplicateCatIdsToRemove);
      }
    });
  })();

  activeSeedPromises.set(patientId, task);
  try {
    await task;
    seededPatientsInSession.add(patientId);
  } finally {
    activeSeedPromises.delete(patientId);
  }
}

/**
 * セッション内のシード完了キャッシュを破棄する（デモモードのリロード・手動リセット用）
 */
export function resetFoodSeedSession(patientId?: string): void {
  if (patientId) {
    seededPatientsInSession.delete(patientId);
    activeSeedPromises.delete(patientId);
  } else {
    seededPatientsInSession.clear();
    activeSeedPromises.clear();
  }
}

/**
 * 指定患者の食品・活動・カテゴリデータをすべて初期シード状態へクリーンにリセットする
 */
export async function resetFoodAndEventMasterToInitial(patientId: string): Promise<void> {
  resetFoodSeedSession(patientId);
  await db.transaction('rw', db.categories, db.food_master, db.event_master, async () => {
    await db.categories.where('user_id').equals(patientId).delete();
    await db.food_master.where('user_id').equals(patientId).delete();
    await db.event_master.where('user_id').equals(patientId).delete();
  });
  await seedFoodMasterIfEmpty(patientId);
}
