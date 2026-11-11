import { db } from './db';
import { Category, EventMaster, FoodMaster } from '@/types/database';

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
  { key: 'cat_food_other', target_type: 'food', category_name: '調味料・その他', sort_order: 6, is_protected: false },
  { key: 'cat_food_uncategorized', target_type: 'food', category_name: '未分類', sort_order: 99, is_protected: true },
  // 活動カテゴリ（未分類のみ削除保護 is_protected: true）
  { key: 'cat_event_exercise', target_type: 'event', category_name: '運動', sort_order: 1, is_protected: false },
  { key: 'cat_event_life', target_type: 'event', category_name: '生活・入浴', sort_order: 2, is_protected: false },
  { key: 'cat_event_health', target_type: 'event', category_name: '体調・補食', sort_order: 3, is_protected: false },
  { key: 'cat_event_insulin', target_type: 'event', category_name: 'インスリン', sort_order: 4, is_protected: false },
  { key: 'cat_event_uncategorized', target_type: 'event', category_name: '未分類', sort_order: 99, is_protected: true },
];

/**
 * 日本食品標準成分表（八訂）および臨床カーボカウント基準に準拠した初期食品データ
 */
export const INITIAL_FOODS: InitialFoodDef[] = [
  // 主食
  {
    key: 'food_rice',
    categoryKey: 'cat_food_staple',
    food_name: 'ごはん',
    base_amount: 1,
    unit: '杯(150g)',
    carbs_per_unit: 55.2,
    notes: '白米（うるち米・炊飯後 36.8g/100g）',
  },
  {
    key: 'food_toast_6',
    categoryKey: 'cat_food_staple',
    food_name: '食パン(6枚切り)',
    base_amount: 1,
    unit: '枚(60g)',
    carbs_per_unit: 26.6,
    notes: '角食パン1枚（44.3g/100g）',
  },
  {
    key: 'food_roll_bread',
    categoryKey: 'cat_food_staple',
    food_name: 'ロールパン(2個)',
    base_amount: 2,
    unit: '個(60g)',
    carbs_per_unit: 28.0,
    notes: 'バターロール1個30g×2個（1個あたり14.0g）',
  },
  {
    key: 'food_udon',
    categoryKey: 'cat_food_staple',
    food_name: 'うどん',
    base_amount: 1,
    unit: '玉(250g)',
    carbs_per_unit: 52.0,
    notes: 'ゆでうどん1玉（20.8g/100g）',
  },
  {
    key: 'food_soba',
    categoryKey: 'cat_food_staple',
    food_name: 'かけそば',
    base_amount: 1,
    unit: '杯(260g)',
    carbs_per_unit: 48.0,
    notes: 'ゆでそば1玉＋かけつゆ',
  },
  {
    key: 'food_ramen',
    categoryKey: 'cat_food_staple',
    food_name: '醤油ラーメン',
    base_amount: 1,
    unit: '杯(230g)',
    carbs_per_unit: 65.0,
    notes: '中華麺ゆで1玉＋醤油スープ',
  },
  {
    key: 'food_pasta',
    categoryKey: 'cat_food_staple',
    food_name: 'ミートソースパスタ',
    base_amount: 1,
    unit: '人前(250g)',
    carbs_per_unit: 70.0,
    notes: 'スパゲッティゆで200g＋ミートソース',
  },
  {
    key: 'food_curry_rice',
    categoryKey: 'cat_food_staple',
    food_name: 'ビーフカレーライス',
    base_amount: 1,
    unit: '皿(350g)',
    carbs_per_unit: 85.0,
    notes: '白米200g＋カレールー150g',
  },
  {
    key: 'food_tendon',
    categoryKey: 'cat_food_staple',
    food_name: '天丼',
    base_amount: 1,
    unit: '杯(380g)',
    carbs_per_unit: 115.0,
    notes: '丼飯230g＋天ぷら衣＋甘辛たれ',
  },
  {
    key: 'food_sushi_10',
    categoryKey: 'cat_food_staple',
    food_name: '握り寿司(10貫)',
    base_amount: 1,
    unit: '人前(10貫)',
    carbs_per_unit: 78.0,
    notes: 'すし飯1貫あたり約7.8g×10貫',
  },
  {
    key: 'food_onigiri',
    categoryKey: 'cat_food_staple',
    food_name: 'おにぎり',
    base_amount: 1,
    unit: '個(110g)',
    carbs_per_unit: 38.0,
    notes: '鮭・梅・昆布おにぎり標準サイズ',
  },

  // 主菜
  {
    key: 'food_tamagoyaki',
    categoryKey: 'cat_food_main',
    food_name: '卵焼き',
    base_amount: 1,
    unit: '人前(80g)',
    carbs_per_unit: 2.5,
    notes: 'だし巻き・厚焼き卵',
  },
  {
    key: 'food_bacon_egg',
    categoryKey: 'cat_food_main',
    food_name: '目玉焼き・ベーコン',
    base_amount: 1,
    unit: '人前(90g)',
    carbs_per_unit: 0.5,
    notes: '鶏卵1個＋ベーコン2枚',
  },
  {
    key: 'food_grilled_salmon',
    categoryKey: 'cat_food_main',
    food_name: '鮭の塩焼き',
    base_amount: 1,
    unit: '切れ(80g)',
    carbs_per_unit: 0.1,
    notes: '焼き魚（銀鮭・白鮭）',
  },
  {
    key: 'food_saba_misoni',
    categoryKey: 'cat_food_main',
    food_name: 'サバの味噌煮',
    base_amount: 1,
    unit: '切れ(100g)',
    carbs_per_unit: 11.2,
    notes: '味噌・砂糖・みりん煮',
  },
  {
    key: 'food_chicken_saute',
    categoryKey: 'cat_food_main',
    food_name: '鶏むね肉のハーブソテー',
    base_amount: 1,
    unit: '人前(120g)',
    carbs_per_unit: 0.5,
    notes: '塩・ハーブ焼き（低糖質）',
  },
  {
    key: 'food_karaage',
    categoryKey: 'cat_food_main',
    food_name: '鶏の唐揚げ',
    base_amount: 1,
    unit: '人前(4個)',
    carbs_per_unit: 8.8,
    notes: '鶏もも肉唐揚げ4個（約120g）',
  },
  {
    key: 'food_ginger_pork',
    categoryKey: 'cat_food_main',
    food_name: '豚肉の生姜焼き',
    base_amount: 1,
    unit: '人前(130g)',
    carbs_per_unit: 6.5,
    notes: '豚ロース＋醤油・みりん・生姜だれ',
  },
  {
    key: 'food_hamburg',
    categoryKey: 'cat_food_main',
    food_name: 'ハンバーグ',
    base_amount: 1,
    unit: '個(150g)',
    carbs_per_unit: 12.5,
    notes: '合挽き肉（パン粉つなぎ＋デミグラスソース）',
  },
  {
    key: 'food_gyoza',
    categoryKey: 'cat_food_main',
    food_name: '焼き餃子',
    base_amount: 1,
    unit: '人前(6個)',
    carbs_per_unit: 28.0,
    notes: '餃子の皮6枚分＋具材',
  },
  {
    key: 'food_tofu',
    categoryKey: 'cat_food_main',
    food_name: '冷奴(豆腐)',
    base_amount: 1,
    unit: '丁(150g)',
    carbs_per_unit: 2.0,
    notes: '絹ごし・木綿豆腐（小パック150g）',
  },
  {
    key: 'food_natto',
    categoryKey: 'cat_food_main',
    food_name: '納豆',
    base_amount: 1,
    unit: 'パック(45g)',
    carbs_per_unit: 2.2,
    notes: '糸引き納豆1パック（添付たれ含む）',
  },

  // 副菜
  {
    key: 'food_green_salad',
    categoryKey: 'cat_food_side',
    food_name: '野菜サラダ',
    base_amount: 1,
    unit: '皿(100g)',
    carbs_per_unit: 3.5,
    notes: 'レタス・トマト・きゅうり（和風ドレッシング）',
  },
  {
    key: 'food_potato_salad',
    categoryKey: 'cat_food_side',
    food_name: 'ポテトサラダ',
    base_amount: 1,
    unit: '小鉢(80g)',
    carbs_per_unit: 13.5,
    notes: 'じゃがいも・にんじん・きゅうり・マヨネーズ',
  },
  {
    key: 'food_spinach_ohitashi',
    categoryKey: 'cat_food_side',
    food_name: 'ほうれん草のおひたし',
    base_amount: 1,
    unit: '小鉢(60g)',
    carbs_per_unit: 0.8,
    notes: 'ゆでほうれん草＋醤油・かつお節',
  },
  {
    key: 'food_kinpira',
    categoryKey: 'cat_food_side',
    food_name: 'きんぴらごぼう',
    base_amount: 1,
    unit: '小鉢(60g)',
    carbs_per_unit: 9.5,
    notes: 'ごぼう・にんじんの甘辛炒め',
  },
  {
    key: 'food_hijiki',
    categoryKey: 'cat_food_side',
    food_name: 'ひじきの煮物',
    base_amount: 1,
    unit: '小鉢(60g)',
    carbs_per_unit: 5.2,
    notes: 'ひじき・油揚げ・大豆の煮物',
  },
  {
    key: 'food_miso_soup',
    categoryKey: 'cat_food_side',
    food_name: '豆腐とわかめのみそ汁',
    base_amount: 1,
    unit: '杯(160ml)',
    carbs_per_unit: 3.8,
    notes: '米みそ仕立て・豆腐・わかめ・ねぎ',
  },
  {
    key: 'food_tonjiru',
    categoryKey: 'cat_food_side',
    food_name: '豚汁',
    base_amount: 1,
    unit: '杯(200ml)',
    carbs_per_unit: 6.5,
    notes: '豚肉・大根・にんじん・ごぼう・こんにゃく',
  },
  {
    key: 'food_corn_soup',
    categoryKey: 'cat_food_side',
    food_name: 'コーンスープ',
    base_amount: 1,
    unit: '杯(160ml)',
    carbs_per_unit: 12.5,
    notes: 'スイートコーンポタージュ',
  },

  // 間食・デザート
  {
    key: 'food_apple',
    categoryKey: 'cat_food_snack',
    food_name: 'りんご',
    base_amount: 1,
    unit: '1/2個(125g)',
    carbs_per_unit: 17.5,
    notes: '生りんご可食部125g（14.0g/100g）',
  },
  {
    key: 'food_banana',
    categoryKey: 'cat_food_snack',
    food_name: 'バナナ',
    base_amount: 1,
    unit: '本(100g)',
    carbs_per_unit: 21.4,
    notes: '可食部100g（中1本）',
  },
  {
    key: 'food_yogurt_plain',
    categoryKey: 'cat_food_snack',
    food_name: 'プレーンヨーグルト(無糖)',
    base_amount: 1,
    unit: 'カップ(100g)',
    carbs_per_unit: 4.9,
    notes: '全脂無糖ヨーグルト',
  },
  {
    key: 'food_mixed_nuts',
    categoryKey: 'cat_food_snack',
    food_name: '素焼きミックスナッツ',
    base_amount: 1,
    unit: '袋(25g)',
    carbs_per_unit: 3.2,
    notes: 'アーモンド・くるみ・カシューナッツ（食塩・植物油不使用）',
  },
  {
    key: 'food_high_cacao_choco',
    categoryKey: 'cat_food_snack',
    food_name: '高カカオチョコレート(3枚)',
    base_amount: 1,
    unit: '人前(15g)',
    carbs_per_unit: 4.2,
    notes: 'カカオ72%チョコレート 5g×3枚',
  },
  {
    key: 'food_cheesecake',
    categoryKey: 'cat_food_snack',
    food_name: 'ベイクドチーズケーキ',
    base_amount: 1,
    unit: '個(90g)',
    carbs_per_unit: 22.0,
    notes: 'クリームチーズ主体ケーキ1カット',
  },
  {
    key: 'food_cream_puff',
    categoryKey: 'cat_food_snack',
    food_name: 'シュークリーム',
    base_amount: 1,
    unit: '個(85g)',
    carbs_per_unit: 18.5,
    notes: 'カスタード＆ホイップシュークリーム',
  },
  {
    key: 'food_shortcake',
    categoryKey: 'cat_food_snack',
    food_name: '苺のショートケーキ',
    base_amount: 1,
    unit: '個(110g)',
    carbs_per_unit: 38.5,
    notes: 'スポンジ・生クリーム・苺',
  },
  {
    key: 'food_mitarashi_dango',
    categoryKey: 'cat_food_snack',
    food_name: 'みたらし団子',
    base_amount: 1,
    unit: '本(55g)',
    carbs_per_unit: 24.0,
    notes: '上新粉団子＋醤油砂糖あん1串',
  },
  {
    key: 'food_potato_chips',
    categoryKey: 'cat_food_snack',
    food_name: 'ポテトチップス',
    base_amount: 1,
    unit: '袋(60g)',
    carbs_per_unit: 32.8,
    notes: 'うすしお味1袋（54.7g/100g）',
  },
  {
    key: 'food_ice_cream',
    categoryKey: 'cat_food_snack',
    food_name: 'バニラアイスクリーム',
    base_amount: 1,
    unit: '個(110ml)',
    carbs_per_unit: 23.2,
    notes: 'ミニカップ1個',
  },

  // 飲料
  {
    key: 'food_milk',
    categoryKey: 'cat_food_drink',
    food_name: '牛乳',
    base_amount: 1,
    unit: '杯(200ml)',
    carbs_per_unit: 9.6,
    notes: '普通牛乳（乳糖 4.8g/100ml）',
  },
  {
    key: 'food_soymilk',
    categoryKey: 'cat_food_drink',
    food_name: '無調整豆乳',
    base_amount: 1,
    unit: '杯(200ml)',
    carbs_per_unit: 3.6,
    notes: '大豆固形分8%以上（1.8g/100ml）',
  },
  {
    key: 'food_cafe_latte',
    categoryKey: 'cat_food_drink',
    food_name: 'カフェラテ(無糖)',
    base_amount: 1,
    unit: '杯(220ml)',
    carbs_per_unit: 6.8,
    notes: 'エスプレッソ＋牛乳140ml（砂糖不使用）',
  },
  {
    key: 'food_veggie_juice',
    categoryKey: 'cat_food_drink',
    food_name: '野菜・果実ミックスジュース',
    base_amount: 1,
    unit: '本(200ml)',
    carbs_per_unit: 15.4,
    notes: '紙パック1本（200ml）',
  },
  {
    key: 'food_orange_juice',
    categoryKey: 'cat_food_drink',
    food_name: 'オレンジジュース(100%)',
    base_amount: 1,
    unit: '杯(200ml)',
    carbs_per_unit: 21.0,
    notes: '果汁100%ジュース（10.5g/100ml）',
  },
  {
    key: 'food_black_coffee',
    categoryKey: 'cat_food_drink',
    food_name: 'ブラックコーヒー',
    base_amount: 1,
    unit: '杯(200ml)',
    carbs_per_unit: 0.0,
    notes: '無糖コーヒー（糖質0g）',
  },
  {
    key: 'food_green_tea',
    categoryKey: 'cat_food_drink',
    food_name: '緑茶・麦茶',
    base_amount: 1,
    unit: '杯(200ml)',
    carbs_per_unit: 0.0,
    notes: '無糖茶類（糖質0g）',
  },

  // 調味料・その他
  {
    key: 'food_sugar_tbsp',
    categoryKey: 'cat_food_other',
    food_name: '砂糖',
    base_amount: 1,
    unit: '大さじ(9g)',
    carbs_per_unit: 9.0,
    notes: '上白糖 大さじ1杯',
  },
  {
    key: 'food_honey_tbsp',
    categoryKey: 'cat_food_other',
    food_name: 'はちみつ',
    base_amount: 1,
    unit: '大さじ(21g)',
    carbs_per_unit: 17.0,
    notes: '純粋はちみつ 大さじ1杯',
  },
  {
    key: 'food_glucose_10g',
    categoryKey: 'cat_food_other',
    food_name: 'ブドウ糖補食(10g)',
    base_amount: 1,
    unit: '包(10g)',
    carbs_per_unit: 10.0,
    notes: '低血糖時の速効性ブドウ糖',
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
  {
    key: 'event_basal_insulin',
    categoryKey: 'cat_event_insulin',
    event_name: '持効型インスリン投与',
    default_duration: 0,
    notes: '1日1回定時投与（トレシーバ / ランタス等）',
  },
  {
    key: 'event_glucose_rescue',
    categoryKey: 'cat_event_health',
    event_name: 'ブドウ糖補食 (10g)',
    default_duration: 0,
    notes: '低血糖時（70 mg/dL未満）の応急補食',
  },
];

/**
 * よく使う食品・活動・カテゴリの初期データを重複ゼロで投入・整合化する。
 * - 並行呼び出し時はシングルトンPromiseで排他制御を行う。
 * - 決定論的ID（`${patientId}_${key}`）を用いて冪等にupsertする。
 * - 過去にランダムUUIDで重複登録された同名カテゴリ・同名食品・同名活動が存在する場合は自動統合・削除する。
 */
export async function seedFoodMasterIfEmpty(patientId: string): Promise<void> {
  if (seededPatientsInSession.has(patientId)) {
    const sampleCat = await db.categories.get(`${patientId}_cat_food_staple`);
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
    const now = new Date().toISOString();

    await db.transaction('rw', db.categories, db.food_master, db.event_master, async () => {
      const existingCats = await db.categories.where('user_id').equals(patientId).toArray();
      const existingCatById = new Map(existingCats.map((c) => [c.id, c]));

      const existingFoods = await db.food_master.where('user_id').equals(patientId).toArray();
      const existingFoodById = new Map(existingFoods.map((f) => [f.id, f]));

      const existingEvents = await db.event_master.where('user_id').equals(patientId).toArray();
      const existingEventById = new Map(existingEvents.map((e) => [e.id, e]));

      // 1. 標準カテゴリを決定論的IDで作成（既存の削除・編集状態は維持しつつ、is_protectedのみ最新仕様へ同期）
      const canonicalCategories: Category[] = INITIAL_CATEGORIES.map((def) => {
        const id = `${patientId}_${def.key}`;
        const prev = existingCatById.get(id);
        if (prev) {
          return {
            ...prev,
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

      for (const cat of allCategories) {
        const mapKey = `${cat.target_type}:${cat.category_name}`;
        const existingCanonical = canonicalCatMap.get(mapKey);
        if (!existingCanonical) {
          canonicalCatMap.set(mapKey, cat);
        } else if (cat.id !== existingCanonical.id) {
          duplicateCatIdsToRemove.push(cat.id);
          catIdRemap.set(cat.id, existingCanonical.id);
        }
      }

      // 3. 標準食品を決定論的IDで作成（未登録の初期食品のみ追加し、既存の編集・削除状態を保持）
      const canonicalFoodsToPut: FoodMaster[] = [];
      const canonicalFoodByName = new Map<string, FoodMaster>();

      for (const def of INITIAL_FOODS) {
        const id = `${patientId}_${def.key}`;
        const prev = existingFoodById.get(id);
        if (prev) {
          canonicalFoodByName.set(prev.food_name, prev);
        } else {
          const created: FoodMaster = {
            id,
            user_id: patientId,
            category_id: `${patientId}_${def.categoryKey}`,
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
          canonicalFoodByName.set(food.food_name, food);
          if (food.category_id && catIdRemap.has(food.category_id)) {
            foodsToUpdateCategory.push({
              ...food,
              category_id: catIdRemap.get(food.category_id)!,
            });
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

      // 4. 標準活動を決定論的IDで作成（未登録の初期活動のみ追加し、既存の編集・削除状態を保持）
      const canonicalEventsToPut: EventMaster[] = [];
      const canonicalEventByName = new Map<string, EventMaster>();

      for (const def of INITIAL_EVENTS) {
        const id = `${patientId}_${def.key}`;
        const prev = existingEventById.get(id);
        if (prev) {
          canonicalEventByName.set(prev.event_name, prev);
        } else {
          const created: EventMaster = {
            id,
            user_id: patientId,
            category_id: `${patientId}_${def.categoryKey}`,
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

      for (const ev of allEventMasters) {
        // 旧名称「軽い運動」は「軽い運動・ストレッチ」に統合
        if (ev.event_name === '軽い運動' && ev.id !== `${patientId}_event_stretching`) {
          duplicateEventMasterIdsToRemove.push(ev.id);
          continue;
        }
        const canonical = canonicalEventByName.get(ev.event_name);
        if (!canonical) {
          canonicalEventByName.set(ev.event_name, ev);
          if (ev.category_id && catIdRemap.has(ev.category_id)) {
            eventsToUpdateCategory.push({
              ...ev,
              category_id: catIdRemap.get(ev.category_id)!,
            });
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
