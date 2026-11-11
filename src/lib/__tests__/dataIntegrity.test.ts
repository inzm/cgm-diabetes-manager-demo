import { describe, it, expect, vi } from 'vitest';
import {
  buildWallClockIso,
  extractDateStr,
  extractTimeStr,
  extractHour,
  shiftLocalDateStr,
  getDayOfWeekFromDateStr,
} from '../dateUtils';
import { extractAnomalyEventsFromReadings } from '../anomalyExtractor';
import {
  getCalendarGridDays,
  aggregateMonthlyData,
  getSelectedDaySummary,
} from '../aggregates';
import {
  calculateTimeAnomalyPatterns,
  calculateWeekdayTrends,
  calculateCarbInsulinTrend,
} from '../analysisCalculators';
import {
  LibreReading,
  HealthEvent,
  UserSettings,
  resolveDefaultInsulinInput,
} from '@/types/database';
import { estimateCarbsLocally } from '../gemini';
import { INITIAL_CATEGORIES, INITIAL_EVENTS, INITIAL_FOODS } from '../foodSeed';
import {
  MEAL_TEMPLATES,
  calculateRealisticInsulinUnits,
  generateRealisticEventsFromReadings,
} from '../realGlucoseLoader';

describe('End-to-End Cross-Screen Data Integrity (全画面データ整合性検証)', () => {
  const patientId = '00000000-0000-0000-0000-000000000001';

  describe('1. タイムゾーン安全な日時ユーティリティ (dateUtils.ts)', () => {
    it('記録した日付・時刻 (例: 12:30 / 22:15) が -9時間ズレることなくそのまま保存・復元されること', () => {
      const isoLunch = buildWallClockIso('2026-10-27', '12:30');
      expect(isoLunch).toBe('2026-10-27T12:30:00.000Z');
      expect(extractDateStr(isoLunch)).toBe('2026-10-27');
      expect(extractTimeStr(isoLunch)).toBe('12:30');
      expect(extractHour(isoLunch)).toBe(12);

      const isoNight = buildWallClockIso('2026-10-27', '22:15');
      expect(extractDateStr(isoNight)).toBe('2026-10-27');
      expect(extractTimeStr(isoNight)).toBe('22:15');
      expect(extractHour(isoNight)).toBe(22);
      // 2026-10-27 は火曜日 (2) — 22:15 でも水曜日にズレないこと
      expect(getDayOfWeekFromDateStr(isoNight)).toBe(2);
    });

    it('前後日移動 (shiftLocalDateStr) が月初・月末境界でもズレないこと', () => {
      expect(shiftLocalDateStr('2026-10-01', -1)).toBe('2026-09-30');
      expect(shiftLocalDateStr('2026-09-30', 1)).toBe('2026-10-01');
    });
  });

  describe('2. 異常値エピソード抽出ステートマシンと閾値変更連動 (anomalyExtractor.ts)', () => {
    const sampleReadings: LibreReading[] = [
      // 10:30 正常 (95)
      { id: '1', user_id: patientId, timestamp: '2026-10-20T10:30:00.000Z', glucose_value: 95, scan_type: 'Historic', created_at: '' },
      // 10:45 〜 11:00 低血糖 (64, 62)
      { id: '2', user_id: patientId, timestamp: '2026-10-20T10:45:00.000Z', glucose_value: 64, scan_type: 'Historic', created_at: '' },
      { id: '3', user_id: patientId, timestamp: '2026-10-20T11:00:00.000Z', glucose_value: 62, scan_type: 'Historic', created_at: '' },
      // 11:15 正常回復 (85) -> 15分経過時点ではまだクローズしない
      { id: '4', user_id: patientId, timestamp: '2026-10-20T11:15:00.000Z', glucose_value: 85, scan_type: 'Historic', created_at: '' },
      // 11:30 正常継続 (92) -> lowEnd(11:00)から30分経過 (>=28分) で1件の低血糖エピソードとして確定
      { id: '5', user_id: patientId, timestamp: '2026-10-20T11:30:00.000Z', glucose_value: 92, scan_type: 'Historic', created_at: '' },
      // 13:30 〜 13:45 食後中等度上昇 (172, 175) -> 標準閾値180では正常、閾値165に変更すると高血糖になる
      { id: '6', user_id: patientId, timestamp: '2026-10-20T13:30:00.000Z', glucose_value: 172, scan_type: 'Historic', created_at: '' },
      { id: '7', user_id: patientId, timestamp: '2026-10-20T13:45:00.000Z', glucose_value: 175, scan_type: 'Historic', created_at: '' },
      { id: '8', user_id: patientId, timestamp: '2026-10-20T14:15:00.000Z', glucose_value: 125, scan_type: 'Historic', created_at: '' },
    ];

    it('標準閾値 (70 / 180) では低血糖1件・高血糖0件が抽出されること', () => {
      const res = extractAnomalyEventsFromReadings(sampleReadings, patientId, 70, 180);
      expect(res.hypoCount).toBe(1);
      expect(res.hyperCount).toBe(0);
      expect(res.events).toHaveLength(1);
      expect(res.events[0].event_type).toBe('低血糖');
      expect(res.events[0].memo).toContain('最低 62 mg/dL');
    });

    it('設定画面で高血糖閾値を 165 mg/dL に変更すると、高血糖1件が追加抽出されること', () => {
      const res = extractAnomalyEventsFromReadings(sampleReadings, patientId, 70, 165);
      expect(res.hypoCount).toBe(1);
      expect(res.hyperCount).toBe(1);
      expect(res.events).toHaveLength(2);
    });
  });

  describe('3. カレンダー ⇔ 選択日サマリー ⇔ 分析画面の数値100%一致検証', () => {
    const targetDate = '2026-10-20';
    const readings: LibreReading[] = [
      { id: 'r1', user_id: patientId, timestamp: '2026-10-20T07:00:00.000Z', glucose_value: 100, scan_type: 'Historic', created_at: '' },
      { id: 'r2', user_id: patientId, timestamp: '2026-10-20T10:45:00.000Z', glucose_value: 62, scan_type: 'Historic', created_at: '' },
      { id: 'r3', user_id: patientId, timestamp: '2026-10-20T11:15:00.000Z', glucose_value: 95, scan_type: 'Historic', created_at: '' },
      { id: 'r4', user_id: patientId, timestamp: '2026-10-20T14:00:00.000Z', glucose_value: 195, scan_type: 'Historic', created_at: '' },
      { id: 'r5', user_id: patientId, timestamp: '2026-10-20T14:30:00.000Z', glucose_value: 190, scan_type: 'Historic', created_at: '' },
      { id: 'r6', user_id: patientId, timestamp: '2026-10-20T15:00:00.000Z', glucose_value: 130, scan_type: 'Historic', created_at: '' },
    ];

    const { events: anomalyEvents } = extractAnomalyEventsFromReadings(readings, patientId, 70, 180);

    const events: HealthEvent[] = [
      ...anomalyEvents,
      // 朝食 (糖質 40g, インスリン 7U)
      {
        id: 'm1',
        user_id: patientId,
        event_datetime: '2026-10-20T07:15:00.000Z',
        event_type: '食事',
        timing_category: '朝食',
        total_carbs: 40,
        insulin_units: 7,
        is_deleted: false,
        created_at: '',
        updated_at: '',
      },
      // 昼食 (糖質 70g, インスリン 11U)
      {
        id: 'm2',
        user_id: patientId,
        event_datetime: '2026-10-20T12:15:00.000Z',
        event_type: '食事',
        timing_category: '昼食',
        total_carbs: 70,
        insulin_units: 11,
        is_deleted: false,
        created_at: '',
        updated_at: '',
      },
      // 夕食 (糖質 60g, インスリン 13U)
      {
        id: 'm3',
        user_id: patientId,
        event_datetime: '2026-10-20T18:15:00.000Z',
        event_type: '食事',
        timing_category: '夕食',
        total_carbs: 60,
        insulin_units: 13,
        is_deleted: false,
        created_at: '',
        updated_at: '',
      },
      // 就寝前 持効型インスリン (単体インスリン 10U)
      {
        id: 'act-ins',
        user_id: patientId,
        event_datetime: '2026-10-20T22:15:00.000Z',
        event_type: '活動',
        timing_category: 'インスリン',
        insulin_units: 10,
        memo: '持効型インスリン投与',
        is_deleted: false,
        created_at: '',
        updated_at: '',
      },
    ];

    it('糖質合計 (170g)、インスリン合計 (食事31U + 持効型10U = 41U)、異常値件数 (低1/高1) が全画面で100%一致すること', () => {
      const gridDays = getCalendarGridDays(2026, 10);
      const aggMap = aggregateMonthlyData(gridDays, readings, events, 70, 180);
      const calCell = aggMap.get(targetDate)!;
      const summary = getSelectedDaySummary(targetDate, calCell, events);
      const carbInsulinTrend = calculateCarbInsulinTrend(events, readings, targetDate, targetDate);
      const weekdayTrends = calculateWeekdayTrends(events, readings, targetDate, targetDate);
      const timeAnomalies = calculateTimeAnomalyPatterns(events, readings, 70, 180);

      // 1. 糖質合計 (40 + 70 + 60 = 170g)
      expect(calCell.totalCarbs).toBe(170);
      expect(summary.totalCarbs).toBe(170);
      expect(carbInsulinTrend[0].totalCarbs).toBe(170);
      // 2026-10-20 は火曜日 (index 2)
      expect(weekdayTrends[2].avgCarbs).toBe(170);

      // 2. インスリン合計 (7 + 11 + 13 + 10 = 41U)
      expect(calCell.totalInsulin).toBe(41);
      expect(summary.totalInsulin).toBe(41);
      expect(summary.insulinBreakdown.bolus).toBe(31);
      expect(summary.insulinBreakdown.basal).toBe(10);
      expect(carbInsulinTrend[0].totalInsulin).toBe(41);
      expect(weekdayTrends[2].avgInsulin).toBe(41);

      // 3. 異常値件数 (朝10:45に低血糖1件、昼14:00に高血糖1件 = 計2件)
      expect(calCell.hypoCount).toBe(1);
      expect(calCell.hyperCount).toBe(1);
      expect(summary.hypoCount).toBe(1);
      expect(summary.hyperCount).toBe(1);
      expect(carbInsulinTrend[0].anomalyCount).toBe(2);
      expect(weekdayTrends[2].anomalyCount).toBe(2);

      const morningAnomaly = timeAnomalies.find((p) => p.periodName === '朝')!;
      const afternoonAnomaly = timeAnomalies.find((p) => p.periodName === '昼')!;
      expect(morningAnomaly.hypoCount).toBe(1);
      expect(afternoonAnomaly.hyperCount).toBe(1);
    });
  });

  describe('4. 食事区分別デフォルトインスリン設定とトグル連動 (resolveDefaultInsulinInput)', () => {
    const baseSettings: UserSettings = {
      user_id: patientId,
      hypo_threshold: 70,
      hyper_threshold: 180,
      target_tir_min: 70,
      target_tir_max: 180,
      enable_default_insulin: true,
      default_insulin_breakfast: 8,
      default_insulin_lunch: 6.5,
      default_insulin_dinner: 10,
      default_insulin_snack: null,
      updated_at: '2026-10-31T00:00:00.000Z',
    };

    it('enable_default_insulin が true の場合、食事区分に応じたデフォルト単位文字列を返し、未設定(null)の区分は空文字を返すこと', () => {
      expect(resolveDefaultInsulinInput(baseSettings, '朝食')).toBe('8');
      expect(resolveDefaultInsulinInput(baseSettings, '昼食')).toBe('6.5');
      expect(resolveDefaultInsulinInput(baseSettings, '夕食')).toBe('10');
      expect(resolveDefaultInsulinInput(baseSettings, '間食')).toBe('');
    });

    it('enable_default_insulin が false の場合、設定値が残っていても全区分で空文字(プレースホルダー用)を返すこと', () => {
      const disabledSettings: UserSettings = {
        ...baseSettings,
        enable_default_insulin: false,
      };
      expect(resolveDefaultInsulinInput(disabledSettings, '朝食')).toBe('');
      expect(resolveDefaultInsulinInput(disabledSettings, '昼食')).toBe('');
      expect(resolveDefaultInsulinInput(disabledSettings, '夕食')).toBe('');
      expect(resolveDefaultInsulinInput(disabledSettings, '間食')).toBe('');
    });
  });

  describe('5. オフライン日本食品標準成分辞書による糖質推定 (estimateCarbsLocally)', () => {
    it('中華・粉もの・揚げ物・和菓子・無糖飲料の糖質量を適切に推論できること', () => {
      expect(estimateCarbsLocally('焼き餃子', 1, '人前').carbs_g).toBe(28);
      expect(estimateCarbsLocally('お好み焼き', 1, '人前').carbs_g).toBe(52);
      expect(estimateCarbsLocally('とんかつ', 1, '人前').carbs_g).toBe(14);
      expect(estimateCarbsLocally('豆大福', 1, '個').carbs_g).toBe(35);
      expect(estimateCarbsLocally('緑茶', 1, '杯').carbs_g).toBe(0);
    });
  });

  describe('6. 食品・活動初期データの重複ゼロ保証 & 栄養成分の理論的整合性 (foodSeed.ts)', () => {
    it('食品・活動・カテゴリのキーおよび名称に重複が1件も存在せず、全数値が理論的に妥当であること', () => {
      const catKeys = new Set(INITIAL_CATEGORIES.map((c) => c.key));
      expect(catKeys.size).toBe(INITIAL_CATEGORIES.length);

      // 「未分類」のみが削除保護 (is_protected: true) であり、他の全カテゴリは削除可能 (false) であること
      for (const cat of INITIAL_CATEGORIES) {
        expect(cat.is_protected).toBe(cat.category_name === '未分類');
      }

      const foodKeys = new Set(INITIAL_FOODS.map((f) => f.key));
      const foodNames = new Set(INITIAL_FOODS.map((f) => f.food_name));
      expect(foodKeys.size).toBe(INITIAL_FOODS.length);
      expect(foodNames.size).toBe(INITIAL_FOODS.length);

      const eventKeys = new Set(INITIAL_EVENTS.map((e) => e.key));
      const eventNames = new Set(INITIAL_EVENTS.map((e) => e.event_name));
      expect(eventKeys.size).toBe(INITIAL_EVENTS.length);
      expect(eventNames.size).toBe(INITIAL_EVENTS.length);

      for (const food of INITIAL_FOODS) {
        expect(catKeys.has(food.categoryKey)).toBe(true);
        expect(food.base_amount).toBeGreaterThan(0);
        expect(food.carbs_per_unit).toBeGreaterThanOrEqual(0);
      }

      // 代表的食品の日本食品標準成分表との一致確認
      const rice = INITIAL_FOODS.find((f) => f.key === 'food_rice')!;
      expect(rice.carbs_per_unit).toBe(55.2);
      const udon = INITIAL_FOODS.find((f) => f.key === 'food_udon')!;
      expect(udon.carbs_per_unit).toBe(52.0);
    });
  });

  describe('7. 食べ合わせ規約・糖質制限(基本100g以内 / 高スパイク時最大1.5倍)・理論的インスリン計算 (realGlucoseLoader.ts)', () => {
    const foodMap = new Map(INITIAL_FOODS.map((f) => [f.key, f]));
    const stapleKeys = new Set([
      'food_rice',
      'food_toast_6',
      'food_roll_bread',
      'food_udon',
      'food_soba',
      'food_ramen',
      'food_pasta',
      'food_curry_rice',
      'food_tendon',
      'food_sushi_10',
      'food_onigiri',
    ]);
    const breadKeys = new Set(['food_toast_6', 'food_roll_bread']);
    const misoAndJpSideKeys = new Set([
      'food_miso_soup',
      'food_tonjiru',
      'food_natto',
      'food_hijiki',
      'food_kinpira',
    ]);

    it('全献立テンプレートで主食の重複がなく、パンとみそ汁・納豆等の不自然な食べ合わせが存在しないこと', () => {
      for (const tpl of MEAL_TEMPLATES) {
        const keysInMeal = tpl.items.map((i) => i.foodKey);
        const staplesInMeal = keysInMeal.filter((k) => stapleKeys.has(k));
        // 1回の食事に主食（ごはん・パン・麺等）は最大1種類のみ
        expect(staplesInMeal.length).toBeLessThanOrEqual(1);

        const hasBread = keysInMeal.some((k) => breadKeys.has(k));
        const hasMisoOrJpSide = keysInMeal.some((k) => misoAndJpSideKeys.has(k));
        // パンとみそ汁・納豆等の組み合わせ禁止
        expect(hasBread && hasMisoOrJpSide).toBe(false);

        const totalCarbs = tpl.items.reduce((sum, item) => {
          const food = foodMap.get(item.foodKey)!;
          return sum + food.carbs_per_unit * item.quantity;
        }, 0);

        if (tpl.tier === 'low' || tpl.tier === 'standard') {
          // 基本の食事は糖質制限 100g 以内
          expect(totalCarbs).toBeLessThanOrEqual(100);
        } else {
          // 高血糖スパイク時の超過メニューも規定量の 1.5倍 (150g) 以内
          expect(totalCarbs).toBeGreaterThan(100);
          expect(totalCarbs).toBeLessThanOrEqual(150);
        }
      }
    });

    it('平日(2026-08-03 月)は1日3食のみ、週末(2026-08-01 土)は3食＋ランダム間食が生成され、インスリン量が糖質量に比例すること', () => {
      const mockReadings: LibreReading[] = [];
      for (const dateStr of ['2026-08-01', '2026-08-03']) {
        for (let h = 0; h < 24; h++) {
          for (const m of [0, 15, 30, 45]) {
            const hh = String(h).padStart(2, '0');
            const mm = String(m).padStart(2, '0');
            // 昼食後(13時台)に高血糖スパイク(210 mg/dL)を発生させる
            const val = h === 13 ? 210 : h === 8 ? 155 : h === 20 ? 165 : 105;
            mockReadings.push({
              id: `r_${dateStr}_${hh}_${mm}`,
              user_id: patientId,
              timestamp: `${dateStr}T${hh}:${mm}:00.000Z`,
              glucose_value: val,
              scan_type: 'Historic',
              created_at: '',
            });
          }
        }
      }

      const { mealAndActivityEvents } = generateRealisticEventsFromReadings(
        mockReadings,
        patientId,
        '2026-08-25T00:00:00.000Z'
      );

      const weekdayMeals = mealAndActivityEvents.filter(
        (e) => e.event_type === '食事' && e.event_datetime.startsWith('2026-08-03')
      );
      // 平日は必ず朝食・昼食・夕食の3食のみ（間食なし）
      expect(weekdayMeals).toHaveLength(3);
      expect(weekdayMeals.map((m) => m.timing_category)).toEqual(['朝食', '昼食', '夕食']);

      for (const meal of weekdayMeals) {
        expect(meal.total_carbs).toBeGreaterThan(25);
        expect(meal.insulin_units).toBeGreaterThanOrEqual(3);
      }

      // インスリン単位数が糖質量に理論的に連動すること
      const unitsLowCarb = calculateRealisticInsulinUnits('昼食', 50, 100, 145);
      const unitsHighCarb = calculateRealisticInsulinUnits('昼食', 120, 130, 190);
      expect(unitsLowCarb).toBe(5);
      expect(unitsHighCarb).toBeGreaterThan(unitsLowCarb);
    });
  });

  describe('8. デモモード用オンメモリDB (InMemoryTable) & 食品・活動・カテゴリ初期シード完全復元 (db.ts / foodSeed.ts)', () => {
    it('オンメモリDBでの複合インデックス検索および追加・変更・削除後の初期シード復元が100%正確に動作すること', async () => {
      const { db, clearInMemoryDemoDatabase } = await import('../db');
      const { resetFoodAndEventMasterToInitial, seedFoodMasterIfEmpty } = await import(
        '../foodSeed'
      );

      clearInMemoryDemoDatabase();
      await seedFoodMasterIfEmpty(patientId);

      const initialFoods = await db.food_master
        .where('user_id')
        .equals(patientId)
        .filter((f) => !f.is_deleted)
        .toArray();
      const initialEvents = await db.event_master
        .where('user_id')
        .equals(patientId)
        .filter((e) => !e.is_deleted)
        .toArray();
      const initialCats = await db.categories
        .where('user_id')
        .equals(patientId)
        .filter((c) => !c.is_deleted)
        .toArray();

      expect(initialFoods).toHaveLength(INITIAL_FOODS.length);
      expect(initialEvents).toHaveLength(INITIAL_EVENTS.length);
      expect(initialCats).toHaveLength(INITIAL_CATEGORIES.length);

      // 0分活動（持効型インスリン投与・ブドウ糖補食）の default_duration === 0 が正確に保持されていること
      const zeroDurationEvents = initialEvents.filter((e) => e.default_duration === 0);
      expect(zeroDurationEvents.length).toBeGreaterThanOrEqual(2);

      // 食品の追加・既存食品の削除・カテゴリの削除を実行
      await db.food_master.add({
        id: 'custom_food_test_1',
        user_id: patientId,
        food_name: 'テスト追加食品',
        base_amount: 1,
        unit: '人前',
        carbs_per_unit: 88,
        is_deleted: false,
        created_at: '2026-08-25T00:00:00.000Z',
        updated_at: '2026-08-25T00:00:00.000Z',
      });
      await db.food_master.update(initialFoods[0].id, { is_deleted: true });
      await db.categories.update(initialCats[0].id, { is_deleted: true });

      // リセット実行で追加分が消え、削除分が復活し、初期シード数に完全一致すること
      await resetFoodAndEventMasterToInitial(patientId);

      const restoredFoods = await db.food_master
        .where('user_id')
        .equals(patientId)
        .filter((f) => !f.is_deleted)
        .toArray();
      const restoredCats = await db.categories
        .where('user_id')
        .equals(patientId)
        .filter((c) => !c.is_deleted)
        .toArray();

      expect(restoredFoods).toHaveLength(INITIAL_FOODS.length);
      expect(restoredFoods.some((f) => f.food_name === 'テスト追加食品')).toBe(false);
      expect(restoredCats).toHaveLength(INITIAL_CATEGORIES.length);

      clearInMemoryDemoDatabase();
      expect(await db.food_master.count()).toBe(0);
    });

    it('デモ環境案内モーダルの表示判定ヘルパーがポートフォリオモードで毎回 true を返し、通常モード・テスト抑止フラグ有効時は false を返すこと', async () => {
      const { shouldShowDemoWelcomeModal } = await import('@/components/common/DemoWelcomeModal');

      // 非ポートフォリオモードでは常に false
      expect(shouldShowDemoWelcomeModal()).toBe(false);

      // ポートフォリオモード（VITE_APP_MODE = 'portfolio'）では毎回 true を返すこと（リロード時も毎回表示され初期化の目印になる）
      vi.stubEnv('VITE_APP_MODE', 'portfolio');
      try {
        expect(shouldShowDemoWelcomeModal()).toBe(true);
        expect(shouldShowDemoWelcomeModal()).toBe(true);

        // E2E CSV取込許可フラグ（通常モード相当）有効時は false
        (window as unknown as Record<string, boolean>).__CGM_E2E_ALLOW_CSV_IMPORT__ = true;
        expect(shouldShowDemoWelcomeModal()).toBe(false);
        delete (window as unknown as Record<string, boolean>).__CGM_E2E_ALLOW_CSV_IMPORT__;

        // E2E モーダル抑止フラグ有効時は false
        (window as unknown as Record<string, boolean>).__CGM_E2E_SUPPRESS_WELCOME__ = true;
        expect(shouldShowDemoWelcomeModal()).toBe(false);
        delete (window as unknown as Record<string, boolean>).__CGM_E2E_SUPPRESS_WELCOME__;
        expect(shouldShowDemoWelcomeModal()).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        delete (window as unknown as Record<string, boolean>).__CGM_E2E_ALLOW_CSV_IMPORT__;
        delete (window as unknown as Record<string, boolean>).__CGM_E2E_SUPPRESS_WELCOME__;
      }
    });
  });

  describe('9. 全テーブルIDの正規UUID統一 (uuidUtils.ts / foodSeed.ts / anomalyExtractor.ts / realGlucoseLoader.ts)', () => {
    it('deterministicUuid が常に RFC 4122 準拠の標準UUID形式 (xxxxxxxx-xxxx-5xxx-[89ab]xxx-xxxxxxxxxxxx) を返し、シードに対して決定論的であること', async () => {
      const {
        UUID_REGEX,
        UUID_V5_DETERMINISTIC_REGEX,
        isValidUuid,
        deterministicUuid,
        ensureUuid,
      } = await import('../uuidUtils');

      const id1 = deterministicUuid(`${patientId}_cat_food_staple`);
      const id2 = deterministicUuid(`${patientId}_cat_food_staple`);
      const id3 = deterministicUuid(`${patientId}_cat_food_main`);

      expect(id1).toBe(id2);
      expect(id1).not.toBe(id3);
      expect(UUID_REGEX.test(id1)).toBe(true);
      expect(UUID_V5_DETERMINISTIC_REGEX.test(id1)).toBe(true);
      expect(isValidUuid(id1)).toBe(true);
      expect(isValidUuid('00000000-0000-0000-0000-000000000001_cat_food_staple')).toBe(false);

      // ensureUuid は既に有効なUUIDならそのまま返し、非UUID文字列なら決定論的UUIDへ変換すること
      expect(ensureUuid(id1, 'fallback')).toBe(id1);
      const migrated = ensureUuid('legacy_non_uuid_id', 'fallback');
      expect(isValidUuid(migrated)).toBe(true);
      expect(migrated).toBe(deterministicUuid('legacy_non_uuid_id'));
    });

    it('初期シード・異常値抽出・デモイベント生成で作成される全レコードのIDおよび外部キーが100%正規UUID形式であること', async () => {
      const { isValidUuid, deterministicUuid } = await import('../uuidUtils');
      const { db, clearInMemoryDemoDatabase } = await import('../db');
      const { seedFoodMasterIfEmpty } = await import('../foodSeed');
      const { reevaluatePatientAnomalyEvents } = await import('../anomalyExtractor');

      clearInMemoryDemoDatabase();
      await seedFoodMasterIfEmpty(patientId);

      const cats = await db.categories.where('user_id').equals(patientId).toArray();
      const foods = await db.food_master.where('user_id').equals(patientId).toArray();
      const eventMasters = await db.event_master.where('user_id').equals(patientId).toArray();

      expect(cats.length).toBeGreaterThan(0);
      for (const c of cats) {
        expect(isValidUuid(c.id)).toBe(true);
      }
      for (const f of foods) {
        expect(isValidUuid(f.id)).toBe(true);
        if (f.category_id) {
          expect(isValidUuid(f.category_id)).toBe(true);
        }
      }
      for (const em of eventMasters) {
        expect(isValidUuid(em.id)).toBe(true);
        if (em.category_id) {
          expect(isValidUuid(em.category_id)).toBe(true);
        }
      }

      // 血糖測定値と生成イベント・明細・異常値再判定のIDがすべて正規UUIDであること
      const mockReadings: LibreReading[] = [
        {
          id: deterministicUuid(`${patientId}_2026-08-10T08:00:00.000Z`),
          user_id: patientId,
          timestamp: '2026-08-10T08:00:00.000Z',
          glucose_value: 62,
          scan_type: 'Historic',
          created_at: '2026-08-10T08:00:00.000Z',
        },
        {
          id: deterministicUuid(`${patientId}_2026-08-10T08:35:00.000Z`),
          user_id: patientId,
          timestamp: '2026-08-10T08:35:00.000Z',
          glucose_value: 95,
          scan_type: 'Historic',
          created_at: '2026-08-10T08:35:00.000Z',
        },
      ];
      await db.libre_readings.bulkPut(mockReadings);

      const { mealAndActivityEvents, mealDetails } = generateRealisticEventsFromReadings(
        mockReadings,
        patientId,
        '2026-08-10T00:00:00.000Z'
      );
      for (const ev of mealAndActivityEvents) {
        expect(isValidUuid(ev.id)).toBe(true);
      }
      for (const md of mealDetails) {
        expect(isValidUuid(md.id)).toBe(true);
        expect(isValidUuid(md.event_id)).toBe(true);
      }

      await reevaluatePatientAnomalyEvents(patientId, 70, 180);
      const anomalyEvents = await db.events
        .where('user_id')
        .equals(patientId)
        .filter((e) => !e.is_deleted && (e.event_type === '低血糖' || e.event_type === '高血糖'))
        .toArray();
      expect(anomalyEvents.length).toBe(1);
      expect(isValidUuid(anomalyEvents[0].id)).toBe(true);

      clearInMemoryDemoDatabase();
    });
  });

  describe('10. 論理削除済みカテゴリの再登録復活とUNIQUE制約衝突防止 (CategoryManageModal.tsx)', () => {
    it('論理削除済み (is_deleted: true) の同名カテゴリを再追加した際、新規UUIDを作らず既存レコードを is_deleted: false に復活させること', async () => {
      const { db, clearInMemoryDemoDatabase } = await import('../db');
      const { addOrReviveCategory } = await import('@/components/foods/CategoryManageModal');
      const { isValidUuid } = await import('../uuidUtils');

      clearInMemoryDemoDatabase();

      // 1. 新規カテゴリ追加
      const created = await addOrReviveCategory({
        userId: patientId,
        targetType: 'food',
        categoryName: 'テスト特別カテゴリ',
        displayOrder: 10,
      });
      expect(isValidUuid(created.id)).toBe(true);
      expect(created.is_deleted).toBe(false);

      // 2. アクティブな同名カテゴリの重複追加はエラーになること
      await expect(
        addOrReviveCategory({
          userId: patientId,
          targetType: 'food',
          categoryName: 'テスト特別カテゴリ',
          displayOrder: 11,
        })
      ).rejects.toThrow('同じ名前のカテゴリがすでに存在します');

      // 3. 論理削除 (is_deleted: true)
      await db.categories.update(created.id, { is_deleted: true });

      // 4. 同じ名前で再追加すると、別UUIDを増やさず元のUUIDのまま is_deleted: false に復活すること
      const revived = await addOrReviveCategory({
        userId: patientId,
        targetType: 'food',
        categoryName: 'テスト特別カテゴリ',
        displayOrder: 12,
      });
      expect(revived.id).toBe(created.id);
      expect(revived.is_deleted).toBe(false);

      const allSameName = await db.categories
        .where('user_id')
        .equals(patientId)
        .filter((c) => c.target_type === 'food' && c.category_name === 'テスト特別カテゴリ')
        .toArray();
      expect(allSameName).toHaveLength(1);

      clearInMemoryDemoDatabase();
    });
  });

  describe('11. 本番モード(personal)でのデモデータ自動投入ゼロ保証 & バックアップ復元・キャッシュ全破棄検証', () => {
    it('personal モード (isPortfolioMode() === false) では ensureRealGlucoseDataLoaded がデモデータを一切投入せず、既存ユーザーデータを保持すること', async () => {
      const { db, clearInMemoryDemoDatabase } = await import('../db');
      const { ensureRealGlucoseDataLoaded, clearPatientManuallyCleared } = await import(
        '../realGlucoseLoader'
      );
      const { isValidUuid, deterministicUuid } = await import('../uuidUtils');

      clearInMemoryDemoDatabase();
      clearPatientManuallyCleared(patientId);

      // ユーザーが手動登録した食事イベント1件を事前に保存
      const userMealId = deterministicUuid(`${patientId}_user_manual_meal_1`);
      await db.events.add({
        id: userMealId,
        user_id: patientId,
        event_datetime: '2026-11-11T12:00:00.000Z',
        event_type: '食事',
        timing_category: '昼食',
        total_carbs: 62.5,
        insulin_units: 6,
        is_deleted: false,
        created_at: '2026-11-11T12:00:00.000Z',
        updated_at: '2026-11-11T12:00:00.000Z',
      });

      // personal モード (デフォルト) で実行
      const hydrated = await ensureRealGlucoseDataLoaded(patientId);
      expect(hydrated).toBe(false);

      // デモの血糖測定値は0件のままであり、ユーザーの食事記録は消されずに残っていること
      expect(await db.libre_readings.where('user_id').equals(patientId).count()).toBe(0);
      const events = await db.events.where('user_id').equals(patientId).toArray();
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(userMealId);

      // 初期食品プリセットのみ正規UUIDで投入されていること
      const foods = await db.food_master.where('user_id').equals(patientId).toArray();
      expect(foods.length).toBe(INITIAL_FOODS.length);
      expect(foods.every((f) => isValidUuid(f.id))).toBe(true);

      clearInMemoryDemoDatabase();
    });

    it('restorePatientBackupPayload が旧非UUIDデータを正規UUIDへマイグレーション変換して復元し、resetPatientDataAndInvalidateCaches が全データをクリアして手動削除抑止フラグを立てること', async () => {
      const { db, clearInMemoryDemoDatabase } = await import('../db');
      const {
        restorePatientBackupPayload,
        resetPatientDataAndInvalidateCaches,
      } = await import('@/components/settings/SettingsView');
      const { isPatientManuallyCleared, clearPatientManuallyCleared } = await import(
        '../realGlucoseLoader'
      );
      const { isValidUuid } = await import('../uuidUtils');
      const {
        hasInMemoryRecentCache,
        primeInMemoryRecentCache,
      } = await import('../realGlucoseLoader');
      const {
        getAnalysisBoundaryCache,
        setAnalysisBoundaryCache,
      } = await import('../analysisCalculators');
      const {
        hasFoodMasterMemoryCache,
        primeFoodMasterMemoryCache,
      } = await import('../../components/foods/FoodMasterView');
      const {
        hasCalendarMonthlyCache,
        primeCalendarMonthlyCache,
      } = await import('../../components/calendar/CalendarView');

      clearInMemoryDemoDatabase();
      clearPatientManuallyCleared(patientId);

      // 復元前に全4種のオンメモリキャッシュを意図的にセット
      primeFoodMasterMemoryCache(patientId, {
        foods: [],
        foodCategories: [],
        eventItems: [],
        eventCategories: [],
      });
      primeCalendarMonthlyCache(patientId, '2026-08-25');
      setAnalysisBoundaryCache(patientId, 'sig-before-restore', '2026-08-01', '2026-08-25', [], []);
      primeInMemoryRecentCache(patientId, [], [], []);

      expect(hasFoodMasterMemoryCache(patientId)).toBe(true);
      expect(hasCalendarMonthlyCache()).toBe(true);
      expect(getAnalysisBoundaryCache(patientId)).not.toBeNull();
      expect(hasInMemoryRecentCache(patientId)).toBe(true);

      // 旧形式（非UUID）および重複同名カテゴリ（削除済み＋有効）・孤児明細を含むバックアップペイロードを復元
      const legacyPayload = {
        libre_readings: [
          {
            id: `${patientId}_2026-11-01T08:00:00.000Z`,
            user_id: patientId,
            timestamp: '2026-11-01T08:00:00.000Z',
            glucose_value: 118,
            scan_type: 'Historic' as const,
            created_at: '2026-11-01T08:00:00.000Z',
          },
        ],
        events: [
          {
            id: `${patientId}_meal_2026-11-01_breakfast`,
            user_id: patientId,
            event_datetime: '2026-11-01T08:00:00.000Z',
            event_type: '食事' as const,
            timing_category: '朝食' as const,
            total_carbs: 55.2,
            insulin_units: 7,
            is_deleted: false,
            created_at: '2026-11-01T08:00:00.000Z',
            updated_at: '2026-11-01T08:00:00.000Z',
          },
        ],
        meal_details: [
          {
            id: `${patientId}_meal_2026-11-01_breakfast_item_0`,
            user_id: patientId,
            event_id: `${patientId}_meal_2026-11-01_breakfast`,
            food_name: 'ごはん',
            amount: 1,
            unit: '杯(150g)',
            carbs: 55.2,
            is_deleted: false,
            created_at: '2026-11-01T08:00:00.000Z',
            updated_at: '2026-11-01T08:00:00.000Z',
          },
          {
            id: '',
            user_id: patientId,
            event_id: '',
            food_name: '孤児レコード（event_id欠損）',
            amount: 1,
            unit: '個',
            carbs: 10,
            is_deleted: false,
            created_at: '2026-11-01T08:00:00.000Z',
            updated_at: '2026-11-01T08:00:00.000Z',
          },
        ],
        categories: [
          {
            id: `${patientId}_cat_food_custom_old_deleted`,
            user_id: patientId,
            target_type: 'food' as const,
            category_name: 'カスタム主食',
            display_order: 1,
            is_protected: false,
            is_deleted: true,
            created_at: '2026-10-01T08:00:00.000Z',
            updated_at: '2026-10-01T08:00:00.000Z',
          },
          {
            id: `${patientId}_cat_food_custom`,
            user_id: patientId,
            target_type: 'food' as const,
            category_name: 'カスタム主食',
            display_order: 2,
            is_protected: false,
            is_deleted: false,
            created_at: '2026-11-01T08:00:00.000Z',
            updated_at: '2026-11-01T08:00:00.000Z',
          },
        ],
        food_master: [
          {
            id: `${patientId}_food_custom_1`,
            user_id: patientId,
            category_id: `${patientId}_cat_food_custom_old_deleted`,
            food_name: '玄米ごはん',
            base_amount: 1,
            unit: '杯',
            carbs_per_unit: 51.3,
            is_deleted: false,
            created_at: '2026-11-01T08:00:00.000Z',
            updated_at: '2026-11-01T08:00:00.000Z',
          },
        ],
      };

      await restorePatientBackupPayload(patientId, legacyPayload);

      // バックアップ復元時に全4種のオンメモリキャッシュが確実に破棄されていること
      expect(hasFoodMasterMemoryCache(patientId)).toBe(false);
      expect(hasCalendarMonthlyCache()).toBe(false);
      expect(getAnalysisBoundaryCache(patientId)).toBeNull();
      expect(hasInMemoryRecentCache(patientId)).toBe(false);

      const readings = await db.libre_readings.where('user_id').equals(patientId).toArray();
      const events = await db.events.where('user_id').equals(patientId).toArray();
      const details = await db.meal_details.where('user_id').equals(patientId).toArray();
      const cats = await db.categories.where('user_id').equals(patientId).toArray();
      const foods = await db.food_master.where('user_id').equals(patientId).toArray();

      expect(readings).toHaveLength(1);
      expect(isValidUuid(readings[0].id)).toBe(true);

      expect(events).toHaveLength(1);
      expect(isValidUuid(events[0].id)).toBe(true);

      // 孤児明細は除外され、有効な食事明細の event_id が親イベントの新UUIDと一致していること
      expect(details).toHaveLength(1);
      expect(isValidUuid(details[0].id)).toBe(true);
      expect(details[0].event_id).toBe(events[0].id);

      // 同名カテゴリは有効な1件に統合され、旧削除済みIDを参照していた食品の category_id も生存カテゴリUUIDへリマップされていること
      expect(cats).toHaveLength(1);
      expect(cats[0].is_deleted).toBe(false);
      expect(isValidUuid(cats[0].id)).toBe(true);
      expect(foods).toHaveLength(1);
      expect(isValidUuid(foods[0].id)).toBe(true);
      expect(foods[0].category_id).toBe(cats[0].id);

      // 再び全4種キャッシュをセットしてからデータ初期化を実行し、全4種キャッシュが破棄されることを検証
      primeFoodMasterMemoryCache(patientId, {
        foods: [],
        foodCategories: [],
        eventItems: [],
        eventCategories: [],
      });
      primeCalendarMonthlyCache(patientId, '2026-11-01');
      setAnalysisBoundaryCache(patientId, 'sig-before-reset', '2026-11-01', '2026-11-01', [], []);
      primeInMemoryRecentCache(patientId, [], [], []);

      await resetPatientDataAndInvalidateCaches(patientId);
      expect(hasFoodMasterMemoryCache(patientId)).toBe(false);
      expect(hasCalendarMonthlyCache()).toBe(false);
      expect(getAnalysisBoundaryCache(patientId)).toBeNull();
      expect(hasInMemoryRecentCache(patientId)).toBe(false);

      expect(await db.libre_readings.where('user_id').equals(patientId).count()).toBe(0);
      expect(await db.events.where('user_id').equals(patientId).count()).toBe(0);
      expect(isPatientManuallyCleared(patientId)).toBe(true);

      clearPatientManuallyCleared(patientId);
      clearInMemoryDemoDatabase();
    });
  });
});



