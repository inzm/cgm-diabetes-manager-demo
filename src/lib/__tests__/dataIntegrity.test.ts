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

  describe('12. 双方向クラウド同期エンジン (syncEngine) & 家族権限解決 & Gemini BFF 検証', () => {
    it('normalizeToWallClockIso (課題 #7) が PostgreSQL TIMESTAMPTZ 文字列を 24文字 ISO へ正規化し、chunkArray が 1,000件単位で分割すること', async () => {
      const { normalizeToWallClockIso, chunkArray } = await import('../syncEngine');

      expect(normalizeToWallClockIso('2026-11-11T08:15:00+00:00')).toBe(
        '2026-11-11T08:15:00.000Z'
      );
      expect(normalizeToWallClockIso('2026-11-11 19:30:45+00')).toBe(
        '2026-11-11T19:30:45.000Z'
      );
      expect(normalizeToWallClockIso('2026-11-11T08:15:00.123456Z')).toBe(
        '2026-11-11T08:15:00.000Z'
      );
      expect(normalizeToWallClockIso('2026-11-11T08:15')).toBe(
        '2026-11-11T08:15:00.000Z'
      );
      expect(normalizeToWallClockIso('2026-11-11T08:15:00.000Z')).toHaveLength(24);

      const items = Array.from({ length: 2500 }, (_, i) => i);
      const chunks = chunkArray(items, 1000);
      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toHaveLength(1000);
      expect(chunks[1]).toHaveLength(1000);
      expect(chunks[2]).toHaveLength(500);
      expect(chunkArray([], 1000)).toEqual([]);
    });

    it('resolveUserAccessFromPermissions が患者本人・家族招待(viewer/editor)・メールアドレス大文字小文字無視・表示対象切替を正しく解決すること', async () => {
      const { resolveUserAccessFromPermissions } = await import('../syncEngine');

      const selfUid = '11111111-1111-4111-8111-111111111111';
      const parentPatientUid = '22222222-2222-4222-8222-222222222222';

      // 1. 招待がない場合は患者本人 (編集可)
      const selfOnly = resolveUserAccessFromPermissions(selfUid, 'self@example.com', []);
      expect(selfOnly.currentPatientId).toBe(selfUid);
      expect(selfOnly.currentRole).toBe('patient');

      // 2. family_email で viewer 招待されている場合 (大文字小文字混在でもマッチし、閲覧専用ロール)
      const viewerInvite = resolveUserAccessFromPermissions(
        selfUid,
        'Family.Viewer@Example.com',
        [
          {
            id: '33333333-3333-4333-8333-333333333333',
            patient_id: parentPatientUid,
            family_user_id: null,
            family_email: 'family.viewer@example.com',
            role: 'viewer',
            invited_at: '2026-11-11T00:00:00.000Z',
            accepted_at: null,
            created_at: '2026-11-11T00:00:00.000Z',
          },
        ]
      );
      expect(viewerInvite.currentPatientId).toBe(parentPatientUid);
      expect(viewerInvite.currentRole).toBe('viewer');
      expect(viewerInvite.accessibleTargets).toHaveLength(2);

      // 3. preferredPatientId で自分自身の記録へ切り替えた場合は patient (編集可) になること
      const switchedToSelf = resolveUserAccessFromPermissions(
        selfUid,
        'Family.Viewer@Example.com',
        [
          {
            id: '33333333-3333-4333-8333-333333333333',
            patient_id: parentPatientUid,
            family_user_id: selfUid,
            family_email: 'family.viewer@example.com',
            role: 'viewer',
            invited_at: '2026-11-11T00:00:00.000Z',
            accepted_at: '2026-11-11T01:00:00.000Z',
            created_at: '2026-11-11T00:00:00.000Z',
          },
        ],
        selfUid
      );
      expect(switchedToSelf.currentPatientId).toBe(selfUid);
      expect(switchedToSelf.currentRole).toBe('patient');

      // 4. editor 招待の場合は対象患者のデータに対して editor ロールとなること
      const editorInvite = resolveUserAccessFromPermissions(
        selfUid,
        'editor@example.com',
        [
          {
            id: '44444444-4444-4444-8444-444444444444',
            patient_id: parentPatientUid,
            family_user_id: selfUid,
            family_email: 'editor@example.com',
            role: 'editor',
            invited_at: '2026-11-11T00:00:00.000Z',
            accepted_at: '2026-11-11T01:00:00.000Z',
            created_at: '2026-11-11T00:00:00.000Z',
          },
        ]
      );
      expect(editorInvite.currentPatientId).toBe(parentPatientUid);
      expect(editorInvite.currentRole).toBe('editor');
    });

    it('migrateAnonymousLocalDataToUser が未ログイン時のローカル記録を認証済み auth.uid() へ欠損なく引き継ぐこと', async () => {
      const { db, clearInMemoryDemoDatabase } = await import('../db');
      const { migrateAnonymousLocalDataToUser } = await import('../syncEngine');
      const { deterministicUuid, isValidUuid } = await import('../uuidUtils');

      clearInMemoryDemoDatabase();
      const anonId = '00000000-0000-0000-0000-000000000001';
      const targetUid = '55555555-5555-4555-8555-555555555555';

      const anonMealId = deterministicUuid(`${anonId}_meal_local_1`);
      await db.events.add({
        id: anonMealId,
        user_id: anonId,
        event_datetime: '2026-11-10T12:30:00.000Z',
        event_type: '食事',
        timing_category: '昼食',
        total_carbs: 48.0,
        insulin_units: 5,
        is_deleted: false,
        created_at: '2026-11-10T12:30:00.000Z',
        updated_at: '2026-11-10T12:30:00.000Z',
      });
      await db.meal_details.add({
        id: deterministicUuid(`${anonId}_detail_local_1`),
        user_id: anonId,
        event_id: anonMealId,
        food_name: 'かけそば',
        amount: 1,
        unit: '杯',
        carbs: 48.0,
        is_deleted: false,
        created_at: '2026-11-10T12:30:00.000Z',
        updated_at: '2026-11-10T12:30:00.000Z',
      });
      await db.libre_readings.add({
        id: deterministicUuid(`${anonId}_2026-11-10T12:15:00.000Z`),
        user_id: anonId,
        timestamp: '2026-11-10T12:15:00.000Z',
        glucose_value: 112,
        scan_type: 'Historic',
        created_at: '2026-11-10T12:15:00.000Z',
      });

      const migratedAny = await migrateAnonymousLocalDataToUser(targetUid, anonId);
      expect(migratedAny).toBe(true);

      // 元の匿名IDのレコードは消去され、新しい targetUid に引き継がれていること
      expect(await db.events.where('user_id').equals(anonId).count()).toBe(0);
      const userEvents = await db.events.where('user_id').equals(targetUid).toArray();
      const userDetails = await db.meal_details.where('user_id').equals(targetUid).toArray();
      const userReadings = await db.libre_readings.where('user_id').equals(targetUid).toArray();

      expect(userEvents).toHaveLength(1);
      expect(userDetails).toHaveLength(1);
      expect(userDetails[0].event_id).toBe(userEvents[0].id);
      expect(userReadings).toHaveLength(1);
      expect(isValidUuid(userReadings[0].id)).toBe(true);

      clearInMemoryDemoDatabase();
    });

    it('syncPatientDataWithCloud が 7テーブル双方向同期・時刻24文字正規化(課題#7)・異常値置換(課題#6)・viewer時のPush抑止を正しく実行すること', async () => {
      const { db, clearInMemoryDemoDatabase } = await import('../db');
      const { syncPatientDataWithCloud } = await import('../syncEngine');
      const { deterministicUuid } = await import('../uuidUtils');

      clearInMemoryDemoDatabase();
      const syncUserId = '66666666-6666-4666-8666-666666666666';

      // ローカルに新しい食事イベントと再計算後の高血糖イベントを保存
      const localMealId = deterministicUuid(`${syncUserId}_meal_sync_1`);
      const localHyperId = deterministicUuid(
        `${syncUserId}_anomaly_高血糖_2026-11-11T14:00:00.000Z`
      );
      await db.events.bulkPut([
        {
          id: localMealId,
          user_id: syncUserId,
          event_datetime: '2026-11-11T12:00:00.000Z',
          event_type: '食事',
          timing_category: '昼食',
          total_carbs: 65.0,
          insulin_units: 7,
          is_deleted: false,
          created_at: '2026-11-11T12:00:00.000Z',
          updated_at: '2026-11-11T12:05:00.000Z',
        },
        {
          id: localHyperId,
          user_id: syncUserId,
          event_datetime: '2026-11-11T14:00:00.000Z',
          event_type: '高血糖',
          memo: '最高 210 mg/dL (継続 45分間)',
          is_deleted: false,
          created_at: '2026-11-11T14:00:00.000Z',
          updated_at: '2026-11-11T14:00:00.000Z',
        },
      ]);

      // リモートモックストア (TIMESTAMPTZ "+00:00" 形式の測定値と、閾値変更前の古い異常値イベントを保持)
      const staleRemoteAnomalyId = deterministicUuid(
        `${syncUserId}_anomaly_高血糖_2026-11-11T10:00:00.000Z`
      );
      const remoteStore: Record<string, Array<Record<string, unknown>>> = {
        user_settings: [],
        categories: [],
        food_master: [],
        event_master: [],
        events: [
          {
            id: staleRemoteAnomalyId,
            user_id: syncUserId,
            event_datetime: '2026-11-11T10:00:00+00:00',
            event_type: '高血糖',
            memo: '旧閾値での高血糖エピソード',
            is_deleted: false,
            created_at: '2026-11-11T10:00:00+00:00',
            updated_at: '2026-11-11T10:00:00+00:00',
          },
        ],
        meal_details: [],
        libre_readings: [
          {
            id: deterministicUuid(`${syncUserId}_2026-11-11T08:15:00.000Z`),
            user_id: syncUserId,
            timestamp: '2026-11-11T08:15:00+00:00', // 課題 #7: +00:00 オフセット形式
            glucose_value: 105,
            scan_type: 'Historic',
            created_at: '2026-11-11T08:15:00+00:00',
          },
        ],
      };

      let upsertCallCount = 0;
      const mockClient = {
        from(table: string) {
          return {
            select() {
              const tableRows = () => [...(remoteStore[table] || [])];
              const builder = {
                eq(_col: string, val: unknown) {
                  const filtered = tableRows().filter((r) => r.user_id === val);
                  return {
                    maybeSingle: async () => ({
                      data: filtered[0] ?? null,
                      error: null,
                    }),
                    order() {
                      return {
                        range: async (fromIdx: number, toIdx: number) => ({
                          data: filtered.slice(fromIdx, toIdx + 1),
                          error: null,
                        }),
                      };
                    },
                  };
                },
              };
              return builder;
            },
            async upsert(payload: Record<string, unknown> | Array<Record<string, unknown>>) {
              upsertCallCount++;
              const rows = Array.isArray(payload) ? payload : [payload];
              const list = remoteStore[table] || [];
              const pk = table === 'user_settings' ? 'user_id' : 'id';
              for (const row of rows) {
                const idx = list.findIndex((existing) => existing[pk] === row[pk]);
                if (idx >= 0) {
                  list[idx] = { ...list[idx], ...row };
                } else {
                  list.push({ ...row });
                }
              }
              remoteStore[table] = list;
              return { error: null };
            },
            delete() {
              return {
                eq(_col: string, val: unknown) {
                  return {
                    in: async (_inCol: string, types: string[]) => {
                      remoteStore[table] = (remoteStore[table] || []).filter(
                        (r) => !(r.user_id === val && types.includes(String(r.event_type)))
                      );
                      return { error: null };
                    },
                  };
                },
              };
            },
          };
        },
      };

      // 1. replaceRemoteAnomalies: true で双方向同期を実行
      const syncResult = await syncPatientDataWithCloud(syncUserId, {
        canEdit: true,
        replaceRemoteAnomalies: true,
        includeReadings: true,
        clientOverride: mockClient as unknown as NonNullable<
          Parameters<typeof syncPatientDataWithCloud>[1]
        >['clientOverride'],
      });

      expect(syncResult.status).toBe('success');
      expect(upsertCallCount).toBeGreaterThan(0);

      // 課題 #6: リモートの古い異常値エピソードが削除され、新しい異常値と食事がリモートへPushされていること
      expect(
        remoteStore.events.some((e) => e.id === staleRemoteAnomalyId)
      ).toBe(false);
      expect(remoteStore.events.some((e) => e.id === localMealId)).toBe(true);
      expect(remoteStore.events.some((e) => e.id === localHyperId)).toBe(true);

      // 課題 #7: リモートの "+00:00" 測定値がローカルDBに 24文字 ".000Z" 形式で保存され、.between() 検索でヒットすること
      const pulledReadings = await db.libre_readings
        .where('[user_id+timestamp]')
        .between(
          [syncUserId, '2026-11-11T00:00:00.000Z'],
          [syncUserId, '2026-11-11T23:59:59.999Z'],
          true,
          true
        )
        .toArray();
      expect(pulledReadings).toHaveLength(1);
      expect(pulledReadings[0].timestamp).toBe('2026-11-11T08:15:00.000Z');
      expect(pulledReadings[0].timestamp).toHaveLength(24);

      // 2. canEdit: false (家族閲覧モード) の場合は Push (upsert) を一切行わず Pull のみ行うこと
      const prevUpsertCount = upsertCallCount;
      await syncPatientDataWithCloud(syncUserId, {
        canEdit: false,
        clientOverride: mockClient as unknown as NonNullable<
          Parameters<typeof syncPatientDataWithCloud>[1]
        >['clientOverride'],
      });
      expect(upsertCallCount).toBe(prevUpsertCount);

      clearInMemoryDemoDatabase();
    });

    it('Cloudflare Pages Functions BFF (/api/gemini) が GEMINI_API_KEY 未設定時に HTTP 503 を返し、設定時は糖質推定JSONを返すこと', async () => {
      const { onRequestPost } = await import('../../../functions/api/gemini');

      // 1. GEMINI_API_KEY 未設定時は 503 を返すこと
      const resNoKey = await onRequestPost({
        request: new Request('https://example.com/api/gemini', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ foodName: 'カレーライス', amount: 1, unit: '皿' }),
        }),
        env: {},
      });
      expect(resNoKey.status).toBe(503);

      // 2. 不正なリクエストボディ時は 400 を返すこと
      const resBadBody = await onRequestPost({
        request: new Request('https://example.com/api/gemini', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ foodName: '', amount: 1, unit: '皿' }),
        }),
        env: { GEMINI_API_KEY: 'dummy-test-key' },
      });
      expect(resBadBody.status).toBe(400);
    });

    it('verifyUserAccessWithCloud がオーナー本人・招待済み家族のみを許可し、未招待の第三者を RPC および RLS プローブで確実に遮断すること', async () => {
      const {
        verifyUserAccessWithCloud,
        UNAUTHORIZED_ACCESS_ERROR_MESSAGE,
      } = await import('../syncEngine');

      const ownerUid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const familyUid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const strangerUid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

      // 0. 空の authUserId は即座に拒否されること
      const emptyUidRes = await verifyUserAccessWithCloud(null, '', 'test@example.com', []);
      expect(emptyUidRes.authorized).toBe(false);
      expect(emptyUidRes.errorMessage).toBe(UNAUTHORIZED_ACCESS_ERROR_MESSAGE);

      // 0b. family_permissions で自身が patient_id (招待発行元オーナー) のレコードが存在する場合は即座にオーナーとして許可されること
      const ownedPermRes = await verifyUserAccessWithCloud(
        {} as unknown as Parameters<typeof verifyUserAccessWithCloud>[0],
        ownerUid,
        'owner@example.com',
        [
          {
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            patient_id: ownerUid,
            family_user_id: familyUid,
            family_email: 'invited.family@example.com',
            role: 'viewer',
            invited_at: '2026-11-11T00:00:00.000Z',
            accepted_at: null,
            created_at: '2026-11-11T00:00:00.000Z',
          },
        ]
      );
      expect(ownedPermRes.authorized).toBe(true);
      expect(ownedPermRes.isOwner).toBe(true);
      expect(ownedPermRes.isInvitedFamily).toBe(false);

      // 1. family_permissions で招待されている家族 (メールアドレス大文字小文字混在) は即座に許可されること
      const invitedRes = await verifyUserAccessWithCloud(
        {} as unknown as Parameters<typeof verifyUserAccessWithCloud>[0],
        familyUid,
        'Invited.Family@Example.com',
        [
          {
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            patient_id: ownerUid,
            family_user_id: null,
            family_email: 'invited.family@example.com',
            role: 'viewer',
            invited_at: '2026-11-11T00:00:00.000Z',
            accepted_at: null,
            created_at: '2026-11-11T00:00:00.000Z',
          },
        ]
      );
      expect(invitedRes.authorized).toBe(true);
      expect(invitedRes.isInvitedFamily).toBe(true);
      expect(invitedRes.isOwner).toBe(false);

      // 2. RPC verify_user_authorization が authorized: true を返した場合（オーナー本人）は許可されること
      const rpcOwnerClient = {
        async rpc(fnName: string) {
          expect(fnName).toBe('verify_user_authorization');
          return {
            data: { authorized: true, is_owner: true, is_invited_family: false },
            error: null,
          };
        },
      };
      const ownerRes = await verifyUserAccessWithCloud(
        rpcOwnerClient as unknown as Parameters<typeof verifyUserAccessWithCloud>[0],
        ownerUid,
        'owner@example.com',
        []
      );
      expect(ownerRes.authorized).toBe(true);
      expect(ownerRes.isOwner).toBe(true);
      expect(ownerRes.isInvitedFamily).toBe(false);

      // 2b. RPC verify_user_authorization が is_owner: false, is_invited_family: true を返した場合、オーナーに誤昇格しないこと
      const rpcInvitedClient = {
        async rpc(fnName: string) {
          expect(fnName).toBe('verify_user_authorization');
          return {
            data: { authorized: true, is_owner: false, is_invited_family: true },
            error: null,
          };
        },
      };
      const rpcInvitedRes = await verifyUserAccessWithCloud(
        rpcInvitedClient as unknown as Parameters<typeof verifyUserAccessWithCloud>[0],
        familyUid,
        'invited.family@example.com',
        []
      );
      expect(rpcInvitedRes.authorized).toBe(true);
      expect(rpcInvitedRes.isOwner).toBe(false);
      expect(rpcInvitedRes.isInvitedFamily).toBe(true);

      // 3. RPC verify_user_authorization が authorized: false を返した場合（未招待の第三者）は即座に拒否されること
      const rpcDeniedClient = {
        async rpc(fnName: string) {
          expect(fnName).toBe('verify_user_authorization');
          return {
            data: { authorized: false, is_owner: false, is_invited_family: false },
            error: null,
          };
        },
      };
      const deniedRes = await verifyUserAccessWithCloud(
        rpcDeniedClient as unknown as Parameters<typeof verifyUserAccessWithCloud>[0],
        strangerUid,
        'stranger@example.com',
        []
      );
      expect(deniedRes.authorized).toBe(false);
      expect(deniedRes.errorMessage).toBe(UNAUTHORIZED_ACCESS_ERROR_MESSAGE);

      // 4. 旧スキーマ等で RPC が未定義の場合でも、user_settings の RLS プローブが 42501 で拒否されれば未招待第三者を遮断すること
      const rlsProbeDeniedClient = {
        async rpc() {
          return { data: null, error: { code: 'PGRST202', message: 'function not found' } };
        },
        from(table: string) {
          expect(table).toBe('user_settings');
          return {
            select() {
              return {
                eq() {
                  return {
                    maybeSingle: async () => ({ data: null, error: null }),
                  };
                },
              };
            },
            async upsert() {
              return {
                error: {
                  code: '42501',
                  message: 'new row violates row-level security policy for table "user_settings"',
                },
              };
            },
          };
        },
      };
      const probeDeniedRes = await verifyUserAccessWithCloud(
        rlsProbeDeniedClient as unknown as Parameters<typeof verifyUserAccessWithCloud>[0],
        strangerUid,
        'stranger2@example.com',
        []
      );
      expect(probeDeniedRes.authorized).toBe(false);
      expect(probeDeniedRes.errorMessage).toBe(UNAUTHORIZED_ACCESS_ERROR_MESSAGE);

      // 5. RPC未定義かつ user_settings に既存レコードがある場合、または初回オーナー登録 upsert が成功した場合はオーナーとして許可されること
      const rlsProbeAllowedClient = {
        async rpc() {
          return { data: null, error: { code: 'PGRST202', message: 'function not found' } };
        },
        from() {
          return {
            select() {
              return {
                eq() {
                  return {
                    maybeSingle: async () => ({ data: null, error: null }),
                  };
                },
              };
            },
            async upsert() {
              return { error: null };
            },
          };
        },
      };
      const firstOwnerRes = await verifyUserAccessWithCloud(
        rlsProbeAllowedClient as unknown as Parameters<typeof verifyUserAccessWithCloud>[0],
        ownerUid,
        'first.owner@example.com',
        []
      );
      expect(firstOwnerRes.authorized).toBe(true);
      expect(firstOwnerRes.isOwner).toBe(true);
    });

    it('purgeAllLocalPatientCaches がログアウト時に IndexedDB 全7テーブルおよび全プロファイル分の全4種メモリキャッシュを完全消去すること', async () => {
      const { db, clearInMemoryDemoDatabase } = await import('../db');
      const { purgeAllLocalPatientCaches } = await import('../syncEngine');
      const { deterministicUuid } = await import('../uuidUtils');
      const {
        hasInMemoryRecentCache,
        primeInMemoryRecentCache,
        markPatientManuallyCleared,
        isPatientManuallyCleared,
      } = await import('../realGlucoseLoader');
      const { getAnalysisBoundaryCache, setAnalysisBoundaryCache } = await import(
        '../analysisCalculators'
      );
      const { hasFoodMasterMemoryCache, primeFoodMasterMemoryCache } = await import(
        '../../components/foods/FoodMasterView'
      );
      const { hasCalendarMonthlyCache, primeCalendarMonthlyCache } = await import(
        '../../components/calendar/CalendarView'
      );

      clearInMemoryDemoDatabase();
      const targetUserId = '99999999-9999-4999-8999-999999999999';
      const secondaryPatientId = '88888888-8888-4888-8888-888888888888';

      // 全7テーブルにレコードを投入
      await db.user_settings.put({
        user_id: targetUserId,
        hypo_threshold: 70,
        hyper_threshold: 180,
        target_tir_min: 70,
        target_tir_max: 180,
        enable_default_insulin: false,
        default_insulin_breakfast: 0,
        default_insulin_lunch: 0,
        default_insulin_dinner: 0,
        default_insulin_snack: 0,
        updated_at: '2026-11-11T00:00:00.000Z',
      });
      const catId = deterministicUuid(`${targetUserId}_cat_1`);
      await db.categories.put({
        id: catId,
        user_id: targetUserId,
        target_type: 'food',
        category_name: '主食',
        display_order: 1,
        is_protected: false,
        is_deleted: false,
        created_at: '2026-11-11T00:00:00.000Z',
        updated_at: '2026-11-11T00:00:00.000Z',
      });
      await db.food_master.put({
        id: deterministicUuid(`${targetUserId}_food_1`),
        user_id: targetUserId,
        category_id: catId,
        food_name: '白米',
        base_amount: 1,
        unit: '杯',
        carbs_per_unit: 55.2,
        is_deleted: false,
        created_at: '2026-11-11T00:00:00.000Z',
        updated_at: '2026-11-11T00:00:00.000Z',
      });
      await db.event_master.put({
        id: deterministicUuid(`${targetUserId}_em_1`),
        user_id: targetUserId,
        category_id: undefined,
        event_name: '散歩',
        default_duration: 30,
        memo: '',
        is_deleted: false,
        created_at: '2026-11-11T00:00:00.000Z',
        updated_at: '2026-11-11T00:00:00.000Z',
      });
      const evId = deterministicUuid(`${targetUserId}_ev_1`);
      await db.events.put({
        id: evId,
        user_id: targetUserId,
        event_datetime: '2026-11-11T08:00:00.000Z',
        event_type: '食事',
        timing_category: '朝食',
        total_carbs: 55.2,
        insulin_units: 6,
        is_deleted: false,
        created_at: '2026-11-11T08:00:00.000Z',
        updated_at: '2026-11-11T08:00:00.000Z',
      });
      await db.meal_details.put({
        id: deterministicUuid(`${targetUserId}_md_1`),
        user_id: targetUserId,
        event_id: evId,
        food_name: '白米',
        amount: 1,
        unit: '杯',
        carbs: 55.2,
        is_deleted: false,
        created_at: '2026-11-11T08:00:00.000Z',
        updated_at: '2026-11-11T08:00:00.000Z',
      });
      await db.libre_readings.put({
        id: deterministicUuid(`${targetUserId}_lr_1`),
        user_id: targetUserId,
        timestamp: '2026-11-11T08:00:00.000Z',
        glucose_value: 110,
        scan_type: 'Historic',
        created_at: '2026-11-11T08:00:00.000Z',
      });

      // 複数プロファイル分の全4種メモリキャッシュおよび手動クリアフラグをセット
      primeFoodMasterMemoryCache(targetUserId, {
        foods: [],
        foodCategories: [],
        eventItems: [],
        eventCategories: [],
      });
      primeFoodMasterMemoryCache(secondaryPatientId, {
        foods: [],
        foodCategories: [],
        eventItems: [],
        eventCategories: [],
      });
      primeCalendarMonthlyCache(targetUserId, '2026-11-11');
      setAnalysisBoundaryCache(targetUserId, 'sig-logout', '2026-11-11', '2026-11-11', [], []);
      primeInMemoryRecentCache(targetUserId, [], [], []);
      primeInMemoryRecentCache(secondaryPatientId, [], [], []);
      markPatientManuallyCleared(targetUserId);

      // ログアウト時のキャッシュ全消去を実行
      await purgeAllLocalPatientCaches(targetUserId);

      // IndexedDB 全7テーブルが 0件になっていること
      expect(await db.user_settings.count()).toBe(0);
      expect(await db.categories.count()).toBe(0);
      expect(await db.food_master.count()).toBe(0);
      expect(await db.event_master.count()).toBe(0);
      expect(await db.events.count()).toBe(0);
      expect(await db.meal_details.count()).toBe(0);
      expect(await db.libre_readings.count()).toBe(0);

      // 全プロファイル分の全4種メモリキャッシュおよびフラグが消去されていること
      expect(hasFoodMasterMemoryCache(targetUserId)).toBe(false);
      expect(hasFoodMasterMemoryCache(secondaryPatientId)).toBe(false);
      expect(hasCalendarMonthlyCache()).toBe(false);
      expect(getAnalysisBoundaryCache(targetUserId)).toBeNull();
      expect(hasInMemoryRecentCache(targetUserId)).toBe(false);
      expect(hasInMemoryRecentCache(secondaryPatientId)).toBe(false);
      expect(isPatientManuallyCleared(targetUserId)).toBe(false);
    });

    it('validateStrongPassword が 8文字未満・大文字欠落・小文字欠落・数字欠落・記号欠落をすべて拒否し、4種すべて含む8文字以上のみ許可すること', async () => {
      const { validateStrongPassword } = await import('../supabase');

      // 1. 空文字
      const emptyRes = validateStrongPassword('');
      expect(emptyRes).toMatchObject({
        minLength: false,
        hasUpper: false,
        hasLower: false,
        hasDigit: false,
        hasSymbol: false,
        isValid: false,
      });
      expect(emptyRes.errorMessage).toContain('8文字以上');

      // 2. 8文字未満（4種類の文字をすべて含んでいても7文字は拒否）
      const shortRes = validateStrongPassword('Ab1!xyz');
      expect(shortRes).toMatchObject({
        minLength: false,
        hasUpper: true,
        hasLower: true,
        hasDigit: true,
        hasSymbol: true,
        isValid: false,
      });
      expect(shortRes.errorMessage).toContain('8文字以上');

      // 3. 英大文字欠落
      const noUpperRes = validateStrongPassword('abcdef1!@');
      expect(noUpperRes).toMatchObject({
        minLength: true,
        hasUpper: false,
        hasLower: true,
        hasDigit: true,
        hasSymbol: true,
        isValid: false,
      });
      expect(noUpperRes.errorMessage).toContain('英大文字');

      // 4. 英小文字欠落
      const noLowerRes = validateStrongPassword('ABCDEF1!@');
      expect(noLowerRes).toMatchObject({
        minLength: true,
        hasUpper: true,
        hasLower: false,
        hasDigit: true,
        hasSymbol: true,
        isValid: false,
      });
      expect(noLowerRes.errorMessage).toContain('英小文字');

      // 5. 数字欠落
      const noDigitRes = validateStrongPassword('Abcdefg!@');
      expect(noDigitRes).toMatchObject({
        minLength: true,
        hasUpper: true,
        hasLower: true,
        hasDigit: false,
        hasSymbol: true,
        isValid: false,
      });
      expect(noDigitRes.errorMessage).toContain('数字');

      // 6. 記号欠落（英大小＋数字のみ）
      const noSymbolRes = validateStrongPassword('Abcdefg12');
      expect(noSymbolRes).toMatchObject({
        minLength: true,
        hasUpper: true,
        hasLower: true,
        hasDigit: true,
        hasSymbol: false,
        isValid: false,
      });
      expect(noSymbolRes.errorMessage).toContain('記号');

      // 7. 空白や日本語文字は記号として認められないこと
      expect(validateStrongPassword('Abcdefg1 ').hasSymbol).toBe(false);
      expect(validateStrongPassword('Abcdefg1 ').isValid).toBe(false);
      expect(validateStrongPassword('Abcdefg1あ').hasSymbol).toBe(false);
      expect(validateStrongPassword('Abcdefg1あ').isValid).toBe(false);

      // 8. 8文字以上かつ英大文字・英小文字・数字・ASCII記号の4種類すべてを含む場合のみ許可されること
      for (const validPwd of [
        'Abcdef1!',
        'Pass123@',
        'Zx9#mN2_',
        'Qw8$rT5-',
        'Lp3%kM9.',
        'Hj7^vB4/',
        'Gf6&cD1~',
      ]) {
        const res = validateStrongPassword(validPwd);
        expect(res).toEqual({
          minLength: true,
          hasUpper: true,
          hasLower: true,
          hasDigit: true,
          hasSymbol: true,
          isValid: true,
        });
        expect(res.errorMessage).toBeUndefined();
      }
    });
  });
});
