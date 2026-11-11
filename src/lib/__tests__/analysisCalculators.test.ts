import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculateFoodImpact,
  calculateTimeAnomalyPatterns,
  calculateWeekdayTrends,
  calculateCarbInsulinTrend,
  buildAndCacheAnalysisDataset,
  getAnalysisDatasetCache,
  getOrComputePeriodSlice,
  invalidateAnalysisDatasetCache,
  buildAvailableMonthsList,
  setAnalysisBoundaryCache,
  getAnalysisBoundaryCache,
  buildAndCacheLocalizedPeriodSlice,
} from '../analysisCalculators';
import { FoodMaster, HealthEvent, LibreReading, MealDetail } from '@/types/database';

describe('analysisCalculators (臨床分析計算ロジック & オンメモリキャッシュ)', () => {
  const userId = 'patient-test-1';

  beforeEach(() => {
    invalidateAnalysisDatasetCache();
  });

  describe('calculateFoodImpact (食品インパクト分析)', () => {
    it('クエリが空文字列の場合は初期状態の安全なオブジェクトを返すこと', () => {
      const result = calculateFoodImpact('', [], [], []);
      expect(result.totalCount).toBe(0);
      expect(result.items).toEqual([]);
      expect(result.avgPreGlucose).toBeNull();
      expect(result.avgPeakGlucose).toBeNull();
      expect(result.avgDelta).toBeNull();
    });

    it('対象食品の食前血糖値・食後ピーク血糖値・Δ上昇幅を正確に計算できること', () => {
      // 2026-10-20 12:00 にカレーライスを食べた
      const mealEvent: HealthEvent = {
        id: 'event-1',
        user_id: userId,
        event_datetime: '2026-10-20T12:00:00',
        event_type: '食事',
        timing_category: '昼食',
        insulin_units: 8,
        total_carbs: 85,
        is_deleted: false,
        created_at: '2026-10-20T12:00:00',
        updated_at: '2026-10-20T12:00:00',
      };

      const mealDetail: MealDetail = {
        id: 'detail-1',
        user_id: userId,
        event_id: 'event-1',
        food_name: 'カレーライス',
        amount: 1,
        unit: '人前',
        carbs: 85,
        is_deleted: false,
        created_at: '2026-10-20T12:00:00',
        updated_at: '2026-10-20T12:00:00',
      };

      // CGM生データ:
      // 食前5分 (11:55): 110 mg/dL (食前近傍)
      // 食後60分 (13:00): 160 mg/dL
      // 食後90分 (13:30): 195 mg/dL (ピーク)
      // 食後120分 (14:00): 170 mg/dL
      const readings: LibreReading[] = [
        {
          id: 'r-1',
          user_id: userId,
          timestamp: '2026-10-20T11:55:00',
          glucose_value: 110,
          scan_type: 'Historic',
          created_at: '2026-10-20T11:55:00',
        },
        {
          id: 'r-2',
          user_id: userId,
          timestamp: '2026-10-20T13:00:00',
          glucose_value: 160,
          scan_type: 'Historic',
          created_at: '2026-10-20T13:00:00',
        },
        {
          id: 'r-3',
          user_id: userId,
          timestamp: '2026-10-20T13:30:00',
          glucose_value: 195,
          scan_type: 'Historic',
          created_at: '2026-10-20T13:30:00',
        },
        {
          id: 'r-4',
          user_id: userId,
          timestamp: '2026-10-20T14:00:00',
          glucose_value: 170,
          scan_type: 'Historic',
          created_at: '2026-10-20T14:00:00',
        },
      ];

      const result = calculateFoodImpact('カレー', [mealEvent], [mealDetail], readings);

      expect(result.totalCount).toBe(1);
      expect(result.avgInsulin).toBe(8);
      expect(result.avgPreGlucose).toBe(110);
      expect(result.avgPeakGlucose).toBe(195);
      expect(result.avgDelta).toBe(85); // 195 - 110 = 85
      expect(result.items[0].foodName).toBe('カレーライス');
      expect(result.items[0].delta).toBe(85);
    });

    it('深夜の食事（23:00）で食後ピークが翌日（00:30）にまたがる場合も日付インデックスで正確に探索できること', () => {
      const mealEvent: HealthEvent = {
        id: 'event-late',
        user_id: userId,
        event_datetime: '2026-10-20T23:00:00',
        event_type: '食事',
        timing_category: '間食',
        insulin_units: 3,
        total_carbs: 35,
        is_deleted: false,
        created_at: '2026-10-20T23:00:00',
        updated_at: '2026-10-20T23:00:00',
      };

      const mealDetail: MealDetail = {
        id: 'detail-late',
        user_id: userId,
        event_id: 'event-late',
        food_name: 'アイスクリーム',
        amount: 1,
        unit: '個',
        carbs: 35,
        is_deleted: false,
        created_at: '2026-10-20T23:00:00',
        updated_at: '2026-10-20T23:00:00',
      };

      const readings: LibreReading[] = [
        {
          id: 'r-pre',
          user_id: userId,
          timestamp: '2026-10-20T22:55:00',
          glucose_value: 105,
          scan_type: 'Historic',
          created_at: '2026-10-20T22:55:00',
        },
        {
          id: 'r-post-nextday',
          user_id: userId,
          timestamp: '2026-10-21T00:30:00',
          glucose_value: 165,
          scan_type: 'Historic',
          created_at: '2026-10-21T00:30:00',
        },
      ];

      const result = calculateFoodImpact('アイス', [mealEvent], [mealDetail], readings);
      expect(result.totalCount).toBe(1);
      expect(result.avgPreGlucose).toBe(105);
      expect(result.avgPeakGlucose).toBe(165);
      expect(result.avgDelta).toBe(60);
    });

    it('該当食品が見つからない場合は totalCount: 0 を返すこと', () => {
      const result = calculateFoodImpact('うどん', [], [], []);
      expect(result.totalCount).toBe(0);
      expect(result.items).toHaveLength(0);
    });
  });

  describe('calculateTimeAnomalyPatterns (時間帯別異常値分析)', () => {
    it('朝・昼・夕・夜の4区分に低血糖・高血糖を正しく分類できること', () => {
      const events: HealthEvent[] = [
        // 朝 (06:00 - 11:59): 低血糖 1件 (07:30)
        {
          id: 'ev-1',
          user_id: userId,
          event_datetime: '2026-10-20T07:30:00',
          event_type: '低血糖',
          is_deleted: false,
          created_at: '2026-10-20T07:30:00',
          updated_at: '2026-10-20T07:30:00',
        },
        // 昼 (12:00 - 17:59): 高血糖 2件 (14:00, 16:00)
        {
          id: 'ev-2',
          user_id: userId,
          event_datetime: '2026-10-20T14:00:00',
          event_type: '高血糖',
          is_deleted: false,
          created_at: '2026-10-20T14:00:00',
          updated_at: '2026-10-20T14:00:00',
        },
        {
          id: 'ev-3',
          user_id: userId,
          event_datetime: '2026-10-20T16:00:00',
          event_type: '高血糖',
          is_deleted: false,
          created_at: '2026-10-20T16:00:00',
          updated_at: '2026-10-20T16:00:00',
        },
        // 夜間・未明 (00:00 - 05:59): 低血糖 1件 (02:00)
        {
          id: 'ev-4',
          user_id: userId,
          event_datetime: '2026-10-20T02:00:00',
          event_type: '低血糖',
          is_deleted: false,
          created_at: '2026-10-20T02:00:00',
          updated_at: '2026-10-20T02:00:00',
        },
      ];

      const result = calculateTimeAnomalyPatterns(events);

      // 全4区分返却
      expect(result).toHaveLength(4);

      // 朝
      const morning = result.find((p) => p.periodName === '朝')!;
      expect(morning.hypoCount).toBe(1);
      expect(morning.hyperCount).toBe(0);
      expect(morning.totalCount).toBe(1);
      expect(morning.percentage).toBe(25); // 1 / 4 = 25%

      // 昼
      const afternoon = result.find((p) => p.periodName === '昼')!;
      expect(afternoon.hypoCount).toBe(0);
      expect(afternoon.hyperCount).toBe(2);
      expect(afternoon.totalCount).toBe(2);
      expect(afternoon.percentage).toBe(50); // 2 / 4 = 50%

      // 夕・夜
      const evening = result.find((p) => p.periodName === '夕・夜')!;
      expect(evening.totalCount).toBe(0);
      expect(evening.percentage).toBe(0);

      // 夜間・未明
      const night = result.find((p) => p.periodName === '夜間・未明')!;
      expect(night.hypoCount).toBe(1);
      expect(night.hyperCount).toBe(0);
      expect(night.totalCount).toBe(1);
      expect(night.percentage).toBe(25);
    });

    it('イベントが存在しない場合、CGM生データから低血糖・高血糖を判定すること', () => {
      const readings: LibreReading[] = [
        {
          id: 'r-1',
          user_id: userId,
          timestamp: '2026-10-20T03:00:00',
          glucose_value: 65, // 低血糖 (< 70)
          scan_type: 'Historic',
          created_at: '2026-10-20T03:00:00',
        },
        {
          id: 'r-2',
          user_id: userId,
          timestamp: '2026-10-20T13:00:00',
          glucose_value: 220, // 高血糖 (> 180)
          scan_type: 'Historic',
          created_at: '2026-10-20T13:00:00',
        },
      ];

      const result = calculateTimeAnomalyPatterns([], readings);
      const night = result.find((p) => p.periodName === '夜間・未明')!;
      expect(night.hypoCount).toBe(1);
      const afternoon = result.find((p) => p.periodName === '昼')!;
      expect(afternoon.hyperCount).toBe(1);
    });
  });

  describe('calculateWeekdayTrends (曜日別傾向分析)', () => {
    it('日曜日〜土曜日の7曜日すべてに対して統計を集計すること', () => {
      const startDate = '2026-10-18'; // 日曜日
      const endDate = '2026-10-24'; // 土曜日 (ちょうど7日間)

      const events: HealthEvent[] = [
        {
          id: 'ev-meal-1',
          user_id: userId,
          event_datetime: '2026-10-18T12:00:00', // 日曜日
          event_type: '食事',
          total_carbs: 60,
          insulin_units: 5,
          is_deleted: false,
          created_at: '2026-10-18T12:00:00',
          updated_at: '2026-10-18T12:00:00',
        },
      ];

      const readings: LibreReading[] = [
        {
          id: 'r-1',
          user_id: userId,
          timestamp: '2026-10-18T12:00:00', // 日曜日
          glucose_value: 120,
          scan_type: 'Historic',
          created_at: '2026-10-18T12:00:00',
        },
        {
          id: 'r-2',
          user_id: userId,
          timestamp: '2026-10-18T18:00:00', // 日曜日
          glucose_value: 140,
          scan_type: 'Historic',
          created_at: '2026-10-18T18:00:00',
        },
      ];

      const result = calculateWeekdayTrends(events, readings, startDate, endDate);

      expect(result).toHaveLength(7);
      // 日曜日 (dayOfWeek: 0)
      const sunday = result[0];
      expect(sunday.dayName).toBe('日');
      expect(sunday.dateCount).toBe(1);
      expect(sunday.avgCarbs).toBe(60);
      expect(sunday.avgInsulin).toBe(5);
      expect(sunday.avgGlucose).toBe(130); // (120 + 140) / 2 = 130
    });
  });

  describe('calculateCarbInsulinTrend (糖質・インスリン日次推移)', () => {
    it('指定期間の日付ごとに糖質・インスリン・平均血糖値を集計すること', () => {
      const startDate = '2026-10-20';
      const endDate = '2026-10-21';

      const events: HealthEvent[] = [
        {
          id: 'ev-1',
          user_id: userId,
          event_datetime: '2026-10-20T08:00:00',
          event_type: '食事',
          total_carbs: 40,
          insulin_units: 4,
          is_deleted: false,
          created_at: '2026-10-20T08:00:00',
          updated_at: '2026-10-20T08:00:00',
        },
        {
          id: 'ev-2',
          user_id: userId,
          event_datetime: '2026-10-20T12:00:00',
          event_type: '食事',
          total_carbs: 50,
          insulin_units: 5,
          is_deleted: false,
          created_at: '2026-10-20T12:00:00',
          updated_at: '2026-10-20T12:00:00',
        },
      ];

      const readings: LibreReading[] = [
        {
          id: 'r-1',
          user_id: userId,
          timestamp: '2026-10-20T10:00:00',
          glucose_value: 120,
          scan_type: 'Historic',
          created_at: '2026-10-20T10:00:00',
        },
      ];

      const result = calculateCarbInsulinTrend(events, readings, startDate, endDate);

      expect(result).toHaveLength(2);
      expect(result[0].date).toBe('2026-10-20');
      expect(result[0].totalCarbs).toBe(90); // 40 + 50
      expect(result[0].totalInsulin).toBe(9); // 4 + 5
      expect(result[0].avgGlucose).toBe(120);

      expect(result[1].date).toBe('2026-10-21');
      expect(result[1].totalCarbs).toBe(0);
      expect(result[1].avgGlucose).toBeNull();
    });
  });

  describe('buildAndCacheAnalysisDataset & getOrComputePeriodSlice (オンメモリキャッシュと即時期間スライス)', () => {
    it('データセットを単一パスでインデックス化し、期間別スライスを同一参照でキャッシュ返却できること', () => {
      const events: HealthEvent[] = [
        {
          id: 'ev-1',
          user_id: userId,
          event_datetime: '2026-10-20T08:00:00',
          event_type: '食事',
          total_carbs: 48,
          insulin_units: 5,
          is_deleted: false,
          created_at: '2026-10-20T08:00:00',
          updated_at: '2026-10-20T08:00:00',
        },
      ];
      const mealDetails: MealDetail[] = [
        {
          id: 'md-1',
          user_id: userId,
          event_id: 'ev-1',
          food_name: 'ごはん',
          amount: 1,
          unit: '杯',
          carbs: 48,
          is_deleted: false,
          created_at: '2026-10-20T08:00:00',
          updated_at: '2026-10-20T08:00:00',
        },
      ];
      const readings: LibreReading[] = [
        {
          id: 'r-1',
          user_id: userId,
          timestamp: '2026-10-20T07:55:00',
          glucose_value: 100,
          scan_type: 'Historic',
          created_at: '2026-10-20T07:55:00',
        },
        {
          id: 'r-2',
          user_id: userId,
          timestamp: '2026-10-20T09:30:00',
          glucose_value: 152,
          scan_type: 'Historic',
          created_at: '2026-10-20T09:30:00',
        },
      ];
      const foodMasters: FoodMaster[] = [];

      const dataset = buildAndCacheAnalysisDataset(
        userId,
        'sig-v1',
        events,
        mealDetails,
        readings,
        foodMasters
      );

      expect(dataset.referenceDateStr).toBe('2026-10-20');
      expect(getAnalysisDatasetCache(userId, 'sig-v1')).toBe(dataset);
      expect(getAnalysisDatasetCache(userId, 'sig-v2')).toBeNull();

      const slice1 = getOrComputePeriodSlice(dataset, '2026-10-15', '2026-10-20', 70, 180);
      const slice2 = getOrComputePeriodSlice(dataset, '2026-10-15', '2026-10-20', 70, 180);
      // 2回目の呼び出しは再計算せずキャッシュ済みオブジェクトの同一参照を返すこと
      expect(slice2).toBe(slice1);
      expect(slice1.events).toHaveLength(1);
      expect(slice1.readings).toHaveLength(2);
    });

    it('setAnalysisBoundaryCache & buildAndCacheLocalizedPeriodSlice で全件取得なしの期間別局所スライス＆キャッシュが動作すること', () => {
      const months = buildAvailableMonthsList('2026-08-10', '2026-10-20');
      expect(months).toEqual(['2026-10', '2026-09', '2026-08']);

      const meta = setAnalysisBoundaryCache(
        userId,
        'sig-local-v1',
        '2026-08-10',
        '2026-10-20',
        [],
        []
      );
      expect(getAnalysisBoundaryCache(userId, 'sig-local-v1')).toBe(meta);
      expect(getAnalysisBoundaryCache(userId, 'sig-local-v2')).toBeNull();

      const periodEvents: HealthEvent[] = [
        {
          id: 'ev-local-1',
          user_id: userId,
          event_datetime: '2026-10-20T12:00:00',
          event_type: '食事',
          total_carbs: 62,
          insulin_units: 6,
          is_deleted: false,
          created_at: '2026-10-20T12:00:00',
          updated_at: '2026-10-20T12:00:00',
        },
      ];
      const periodDetails: MealDetail[] = [
        {
          id: 'md-local-1',
          user_id: userId,
          event_id: 'ev-local-1',
          food_name: '天丼',
          amount: 1,
          unit: '杯',
          carbs: 62,
          is_deleted: false,
          created_at: '2026-10-20T12:00:00',
          updated_at: '2026-10-20T12:00:00',
        },
      ];
      const periodReadings: LibreReading[] = [
        {
          id: 'r-prev-day',
          user_id: userId,
          timestamp: '2026-10-14T23:45:00',
          glucose_value: 98,
          scan_type: 'Historic',
          created_at: '2026-10-14T23:45:00',
        },
        {
          id: 'r-in-range-1',
          user_id: userId,
          timestamp: '2026-10-20T11:55:00',
          glucose_value: 105,
          scan_type: 'Historic',
          created_at: '2026-10-20T11:55:00',
        },
        {
          id: 'r-in-range-2',
          user_id: userId,
          timestamp: '2026-10-20T13:30:00',
          glucose_value: 175,
          scan_type: 'Historic',
          created_at: '2026-10-20T13:30:00',
        },
      ];

      const sliceA = buildAndCacheLocalizedPeriodSlice(
        meta,
        '2026-10-15',
        '2026-10-20',
        70,
        180,
        periodEvents,
        periodDetails,
        periodReadings
      );
      const sliceB = buildAndCacheLocalizedPeriodSlice(
        meta,
        '2026-10-15',
        '2026-10-20',
        70,
        180,
        periodEvents,
        periodDetails,
        periodReadings
      );

      expect(sliceB).toBe(sliceA);
      // 期間外の余白測定値 (2026-10-14) は periodSlice.readings からは除外され、readingsByDate には保持されること
      expect(sliceA.readings).toHaveLength(2);
      expect(sliceA.readingsByDate?.has('2026-10-14')).toBe(true);
      expect(sliceA.foodOptions).toContain('天丼');
      const impact = calculateFoodImpact(
        '天丼',
        sliceA.events,
        sliceA.mealDetails || [],
        sliceA.readings,
        {
          detailsByEventId: sliceA.detailsByEventId,
          readingsByDate: sliceA.readingsByDate,
        }
      );
      expect(impact.avgDelta).toBe(70);
    });
  });
});
