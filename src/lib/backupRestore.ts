import {
  Category,
  EventMaster,
  FoodMaster,
  HealthEvent,
  LibreReading,
  MealDetail,
  UserSettings,
} from '@/types/database';
import { db } from './db';
import {
  cancelBackgroundHydration,
  invalidateAnalysisDatasetCache,
  invalidateInMemoryRecentCache,
  markPatientManuallyCleared,
} from './realGlucoseLoader';
import { resetFoodSeedSession, seedFoodMasterIfEmpty } from './foodSeed';
import { ensureUuid } from './uuidUtils';
import { invalidateFoodMasterMemoryCache } from '@/components/foods/FoodMasterView';
import { clearCalendarMonthlyCache } from '@/components/calendar/CalendarView';
import { registerUiCacheInvalidator } from './syncEngine';

export interface PatientBackupPayload {
  version?: string | number;
  exportedAt?: string;
  patientId?: string;
  userSettings?: Partial<UserSettings> | null;
  user_settings?: Partial<UserSettings> | null;
  libreReadings?: Array<Partial<LibreReading> & Record<string, unknown>>;
  libre_readings?: Array<Partial<LibreReading> & Record<string, unknown>>;
  events?: Array<Partial<HealthEvent> & Record<string, unknown>>;
  mealDetails?: Array<Partial<MealDetail> & Record<string, unknown>>;
  meal_details?: Array<Partial<MealDetail> & Record<string, unknown>>;
  categories?: Array<Partial<Category> & Record<string, unknown>>;
  foodMaster?: Array<Partial<FoodMaster> & Record<string, unknown>>;
  food_master?: Array<Partial<FoodMaster> & Record<string, unknown>>;
  eventMaster?: Array<Partial<EventMaster> & Record<string, unknown>>;
  event_master?: Array<Partial<EventMaster> & Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * 全4種のオンメモリキャッシュ（食品・活動一覧、カレンダー月次集計、分析データセット、直近メモリスライス）を一括破棄する
 */
export function invalidateAllPatientMemoryCaches(patientId: string): void {
  invalidateFoodMasterMemoryCache(patientId);
  clearCalendarMonthlyCache();
  invalidateAnalysisDatasetCache(patientId);
  invalidateInMemoryRecentCache(patientId);
}

registerUiCacheInvalidator((patientId) => {
  invalidateFoodMasterMemoryCache(patientId);
  clearCalendarMonthlyCache();
});

/**
 * バックアップJSONペイロードから対象患者の既存レコードをクリアして復元し、
 * 旧形式の非UUID文字列があれば正規UUIDへ自動マイグレーションした上で全4種キャッシュを破棄する
 */
export async function restorePatientBackupPayload(
  patientId: string,
  parsed: PatientBackupPayload
): Promise<void> {
  markPatientManuallyCleared(patientId);
  cancelBackgroundHydration(patientId);
  resetFoodSeedSession(patientId);

  const rawSettings = parsed.userSettings ?? parsed.user_settings;
  const rawReadings = Array.isArray(parsed.libreReadings)
    ? parsed.libreReadings
    : Array.isArray(parsed.libre_readings)
      ? parsed.libre_readings
      : [];
  const rawEvents = Array.isArray(parsed.events) ? parsed.events : [];
  const rawDetails = Array.isArray(parsed.mealDetails)
    ? parsed.mealDetails
    : Array.isArray(parsed.meal_details)
      ? parsed.meal_details
      : [];
  const rawCategories = Array.isArray(parsed.categories) ? parsed.categories : [];
  const rawFoods = Array.isArray(parsed.foodMaster)
    ? parsed.foodMaster
    : Array.isArray(parsed.food_master)
      ? parsed.food_master
      : [];
  const rawEventMasters = Array.isArray(parsed.eventMaster)
    ? parsed.eventMaster
    : Array.isArray(parsed.event_master)
      ? parsed.event_master
      : [];

  const hasCategories = rawCategories.length > 0;
  const hasFoods = rawFoods.length > 0;
  const hasEventMasters = rawEventMasters.length > 0;

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

      if (rawSettings) {
        await db.user_settings.put({
          ...(rawSettings as UserSettings),
          user_id: patientId,
        });
      }
      if (rawReadings.length > 0) {
        await db.libre_readings.bulkPut(
          rawReadings.map((r) => ({
            ...(r as LibreReading),
            id: ensureUuid(
              typeof r.id === 'string' ? r.id : undefined,
              `${patientId}_${String(r.timestamp ?? '')}`
            ),
            user_id: patientId,
          }))
        );
      }

      const eventIdMap = new Map<string, string>();
      if (rawEvents.length > 0) {
        await db.events.bulkPut(
          rawEvents.map((ev) => {
            const rawId = typeof ev.id === 'string' ? ev.id : undefined;
            const normalizedEventId = ensureUuid(
              rawId,
              `${patientId}_${String(ev.event_type ?? '')}_${String(ev.event_datetime ?? '')}`
            );
            if (ev.id != null && String(ev.id).trim() !== '') {
              eventIdMap.set(String(ev.id).trim(), normalizedEventId);
            }
            return {
              ...(ev as HealthEvent),
              id: normalizedEventId,
              user_id: patientId,
            };
          })
        );
      }

      if (rawDetails.length > 0) {
        const validDetails = rawDetails.filter(
          (d) => d && d.event_id != null && String(d.event_id).trim() !== ''
        );
        if (validDetails.length > 0) {
          await db.meal_details.bulkPut(
            validDetails.map((d) => {
              const rawEventIdStr = String(d.event_id).trim();
              const normalizedEventId =
                eventIdMap.get(rawEventIdStr) ?? ensureUuid(rawEventIdStr);
              return {
                ...(d as MealDetail),
                id: ensureUuid(
                  typeof d.id === 'string' ? d.id : undefined,
                  `${normalizedEventId}_${String(d.food_name ?? '')}`
                ),
                event_id: normalizedEventId,
                user_id: patientId,
              };
            })
          );
        }
      }

      const categoryIdMap = new Map<string, string>();
      if (hasCategories) {
        const dedupedByKey = new Map<
          string,
          { raw: Category; allOriginalIds: string[] }
        >();
        for (const c of rawCategories) {
          if (!c || !c.category_name) continue;
          const targetType = c.target_type === 'event' ? 'event' : 'food';
          const trimmedName = String(c.category_name).trim();
          const key = `${targetType}::${trimmedName}`;
          const origId = c.id != null ? String(c.id).trim() : '';
          const existing = dedupedByKey.get(key);
          if (!existing) {
            dedupedByKey.set(key, {
              raw: {
                ...(c as Category),
                target_type: targetType,
                category_name: trimmedName,
              },
              allOriginalIds: origId ? [origId] : [],
            });
          } else {
            if (origId) {
              existing.allOriginalIds.push(origId);
            }
            if (existing.raw.is_deleted && !c.is_deleted) {
              existing.raw = {
                ...(c as Category),
                target_type: targetType,
                category_name: trimmedName,
              };
            }
          }
        }

        const normalizedCategories = Array.from(dedupedByKey.values()).map(
          ({ raw, allOriginalIds }) => {
            const canonicalId = ensureUuid(
              raw.id,
              `${patientId}_cat_${raw.target_type}_${raw.category_name}`
            );
            for (const origId of allOriginalIds) {
              categoryIdMap.set(origId, canonicalId);
            }
            return {
              ...raw,
              id: canonicalId,
              user_id: patientId,
            };
          }
        );

        if (normalizedCategories.length > 0) {
          await db.categories.bulkPut(normalizedCategories);
        }
      }

      if (hasFoods) {
        await db.food_master.bulkPut(
          rawFoods.map((f) => {
            const rawCatId = f.category_id != null ? String(f.category_id).trim() : '';
            return {
              ...(f as FoodMaster),
              id: ensureUuid(
                typeof f.id === 'string' ? f.id : undefined,
                `${patientId}_food_${String(f.food_name ?? '')}`
              ),
              category_id: rawCatId
                ? (categoryIdMap.get(rawCatId) ?? ensureUuid(rawCatId))
                : f.category_id,
              user_id: patientId,
            };
          })
        );
      }

      if (hasEventMasters) {
        await db.event_master.bulkPut(
          rawEventMasters.map((em) => {
            const rawCatId = em.category_id != null ? String(em.category_id).trim() : '';
            return {
              ...(em as EventMaster),
              id: ensureUuid(
                typeof em.id === 'string' ? em.id : undefined,
                `${patientId}_event_${String(em.event_name ?? '')}`
              ),
              category_id: rawCatId
                ? (categoryIdMap.get(rawCatId) ?? ensureUuid(rawCatId))
                : em.category_id,
              user_id: patientId,
            };
          })
        );
      }
    }
  );

  if (!hasCategories && !hasFoods && !hasEventMasters) {
    await seedFoodMasterIfEmpty(patientId);
  }

  invalidateAllPatientMemoryCaches(patientId);
}

/**
 * 対象患者の記録データをすべて消去し（他テナントのデータは保護）、よく使う食品・活動を初期状態へ再シードした上で全4種キャッシュを破棄する
 */
export async function resetPatientDataAndInvalidateCaches(patientId: string): Promise<void> {
  markPatientManuallyCleared(patientId);
  cancelBackgroundHydration(patientId);
  resetFoodSeedSession(patientId);

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

  await seedFoodMasterIfEmpty(patientId);
  invalidateAllPatientMemoryCaches(patientId);
}
