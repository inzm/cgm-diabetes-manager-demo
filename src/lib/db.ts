import Dexie, { type EntityTable } from 'dexie';
import type {
  LibreReading,
  HealthEvent,
  MealDetail,
  FoodMaster,
  EventMaster,
  Category,
  UserSettings,
} from '@/types/database';

const PHYSICAL_DB_NAME = 'cgm_diabetes_manager_db';

/**
 * デモアプリ（ポートフォリオモード既定状態）かどうかを判定する。
 * E2Eテストで CSV取込・バックアップ永続化を検証する際 (`__CGM_E2E_ALLOW_CSV_IMPORT__ === true`) は
 * 物理 IndexedDB を使用する。
 */
export function isDemoMemoryOnlyMode(): boolean {
  try {
    if (
      import.meta.env.MODE === 'test' &&
      (typeof window === 'undefined' || typeof window.indexedDB === 'undefined')
    ) {
      return true;
    }
    if (import.meta.env.VITE_APP_MODE !== 'portfolio') return false;
    if (
      typeof window !== 'undefined' &&
      (window as unknown as Record<string, unknown>).__CGM_E2E_ALLOW_CSV_IMPORT__ === true
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function compareValues(a: any, b: any): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  return a < b ? -1 : 1;
}

function compareTuple2(a0: any, a1: any, b0: any, b1: any): number {
  const c0 = compareValues(a0, b0);
  if (c0 !== 0) return c0;
  return compareValues(a1, b1);
}

class InMemoryCollection<T extends Record<string, any>, K extends string> {
  private predicates: Array<(item: T) => boolean> = [];

  constructor(
    private readonly store: Map<string, T>,
    private readonly primaryKey: K,
    private readonly indexFields: string[],
    initialPredicate: (item: T) => boolean
  ) {
    this.predicates.push(initialPredicate);
  }

  filter(fn: (item: T) => boolean): InMemoryCollection<T, K> {
    this.predicates.push(fn);
    return this;
  }

  and(fn: (item: T) => boolean): InMemoryCollection<T, K> {
    return this.filter(fn);
  }

  private matches(item: T): boolean {
    for (let i = 0; i < this.predicates.length; i++) {
      if (!this.predicates[i](item)) return false;
    }
    return true;
  }

  private compareItems(a: T, b: T): number {
    for (let i = 0; i < this.indexFields.length; i++) {
      const f = this.indexFields[i];
      const cmp = compareValues(a[f], b[f]);
      if (cmp !== 0) return cmp;
    }
    return compareValues(a[this.primaryKey], b[this.primaryKey]);
  }

  async toArray(): Promise<T[]> {
    const result: T[] = [];
    for (const item of this.store.values()) {
      if (this.matches(item)) {
        result.push(item);
      }
    }
    result.sort((a, b) => this.compareItems(a, b));
    return result;
  }

  async count(): Promise<number> {
    let cnt = 0;
    for (const item of this.store.values()) {
      if (this.matches(item)) {
        cnt++;
      }
    }
    return cnt;
  }

  async first(): Promise<T | undefined> {
    let best: T | undefined;
    for (const item of this.store.values()) {
      if (!this.matches(item)) continue;
      if (best === undefined || this.compareItems(item, best) < 0) {
        best = item;
      }
    }
    return best;
  }

  async last(): Promise<T | undefined> {
    let best: T | undefined;
    for (const item of this.store.values()) {
      if (!this.matches(item)) continue;
      if (best === undefined || this.compareItems(item, best) > 0) {
        best = item;
      }
    }
    return best;
  }

  async primaryKeys(): Promise<string[]> {
    const keys: string[] = [];
    for (const item of this.store.values()) {
      if (this.matches(item)) {
        keys.push(String(item[this.primaryKey]));
      }
    }
    return keys;
  }

  async delete(): Promise<number> {
    const keysToDelete: string[] = [];
    for (const [k, item] of this.store.entries()) {
      if (this.matches(item)) {
        keysToDelete.push(k);
      }
    }
    for (let i = 0; i < keysToDelete.length; i++) {
      this.store.delete(keysToDelete[i]);
    }
    return keysToDelete.length;
  }
}

class InMemoryTable<T extends Record<string, any>, K extends string> {
  readonly store = new Map<string, T>();

  constructor(private readonly primaryKey: K) {}

  async get(key: string): Promise<T | undefined> {
    return this.store.get(String(key));
  }

  async add(item: T): Promise<string> {
    const key = String(item[this.primaryKey]);
    this.store.set(key, item);
    return key;
  }

  async put(item: T): Promise<string> {
    const key = String(item[this.primaryKey]);
    this.store.set(key, item);
    return key;
  }

  async bulkPut(items: readonly T[]): Promise<string> {
    let lastKey = '';
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      lastKey = String(item[this.primaryKey]);
      this.store.set(lastKey, item);
    }
    return lastKey;
  }

  async update(key: string, changes: Partial<T>): Promise<number> {
    const k = String(key);
    const existing = this.store.get(k);
    if (!existing) return 0;
    this.store.set(k, { ...existing, ...changes });
    return 1;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(String(key));
  }

  async bulkDelete(keys: readonly string[]): Promise<void> {
    for (let i = 0; i < keys.length; i++) {
      this.store.delete(String(keys[i]));
    }
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async toArray(): Promise<T[]> {
    return Array.from(this.store.values());
  }

  async count(): Promise<number> {
    return this.store.size;
  }

  where(indexSpec: string) {
    const isCompound = indexSpec.startsWith('[') && indexSpec.endsWith(']');
    const fields = isCompound ? indexSpec.slice(1, -1).split('+') : [indexSpec];

    return {
      equals: (value: any) => {
        if (isCompound && Array.isArray(value)) {
          const [f0, f1] = fields;
          const [v0, v1] = value;
          return new InMemoryCollection<T, K>(
            this.store,
            this.primaryKey,
            fields,
            (item) => item[f0] === v0 && item[f1] === v1
          );
        }
        const f0 = fields[0];
        return new InMemoryCollection<T, K>(
          this.store,
          this.primaryKey,
          fields,
          (item) => item[f0] === value
        );
      },
      between: (
        lower: any,
        upper: any,
        includeLower: boolean = true,
        includeUpper: boolean = false
      ) => {
        if (isCompound && Array.isArray(lower) && Array.isArray(upper)) {
          const [f0, f1] = fields;
          const [l0, l1] = lower;
          const [u0, u1] = upper;
          return new InMemoryCollection<T, K>(this.store, this.primaryKey, fields, (item) => {
            const cmpLow = compareTuple2(item[f0], item[f1], l0, l1);
            if (includeLower ? cmpLow < 0 : cmpLow <= 0) return false;
            const cmpHigh = compareTuple2(item[f0], item[f1], u0, u1);
            if (includeUpper ? cmpHigh > 0 : cmpHigh >= 0) return false;
            return true;
          });
        }
        const f0 = fields[0];
        return new InMemoryCollection<T, K>(this.store, this.primaryKey, fields, (item) => {
          const val = item[f0];
          const cmpLow = compareValues(val, lower);
          if (includeLower ? cmpLow < 0 : cmpLow <= 0) return false;
          const cmpHigh = compareValues(val, upper);
          if (includeUpper ? cmpHigh > 0 : cmpHigh >= 0) return false;
          return true;
        });
      },
      anyOf: (values: readonly any[]) => {
        const valSet = new Set(values);
        const f0 = fields[0];
        return new InMemoryCollection<T, K>(this.store, this.primaryKey, fields, (item) =>
          valSet.has(item[f0])
        );
      },
    };
  }
}

class PhysicalDexieDatabase extends Dexie {
  libre_readings!: EntityTable<LibreReading, 'id'>;
  events!: EntityTable<HealthEvent, 'id'>;
  meal_details!: EntityTable<MealDetail, 'id'>;
  food_master!: EntityTable<FoodMaster, 'id'>;
  event_master!: EntityTable<EventMaster, 'id'>;
  categories!: EntityTable<Category, 'id'>;
  user_settings!: EntityTable<UserSettings, 'user_id'>;

  constructor() {
    super(PHYSICAL_DB_NAME);
    this.version(1).stores({
      libre_readings: 'id, [user_id+timestamp], timestamp, user_id',
      events: 'id, [user_id+event_datetime], user_id, event_datetime, event_type, is_deleted, updated_at',
      meal_details: 'id, event_id, user_id, is_deleted, updated_at',
      food_master: 'id, user_id, category_id, food_name, is_deleted, updated_at',
      event_master: 'id, user_id, category_id, event_name, is_deleted, updated_at',
      categories: 'id, user_id, target_type, [user_id+target_type], is_deleted',
      user_settings: 'user_id, updated_at',
    });

    // Version 2: 期間クエリ・イベント種別検索・明細高速結合用の複合インデックス追加
    this.version(2).stores({
      libre_readings: 'id, [user_id+timestamp], timestamp, user_id',
      events:
        'id, [user_id+event_datetime], [user_id+event_type], user_id, event_datetime, event_type, is_deleted, updated_at',
      meal_details: 'id, [user_id+event_id], event_id, user_id, is_deleted, updated_at',
      food_master: 'id, [user_id+category_id], user_id, category_id, food_name, is_deleted, updated_at',
      event_master: 'id, [user_id+category_id], user_id, category_id, event_name, is_deleted, updated_at',
      categories: 'id, user_id, target_type, [user_id+target_type], is_deleted',
      user_settings: 'user_id, updated_at',
    });
  }
}

const physicalDb = new PhysicalDexieDatabase();

const memoryTables = {
  libre_readings: new InMemoryTable<LibreReading, 'id'>('id'),
  events: new InMemoryTable<HealthEvent, 'id'>('id'),
  meal_details: new InMemoryTable<MealDetail, 'id'>('id'),
  food_master: new InMemoryTable<FoodMaster, 'id'>('id'),
  event_master: new InMemoryTable<EventMaster, 'id'>('id'),
  categories: new InMemoryTable<Category, 'id'>('id'),
  user_settings: new InMemoryTable<UserSettings, 'user_id'>('user_id'),
};

/**
 * オンメモリDB（デモモード用）の全テーブルを即時クリアする
 */
export function clearInMemoryDemoDatabase(): void {
  memoryTables.libre_readings.store.clear();
  memoryTables.events.store.clear();
  memoryTables.meal_details.store.clear();
  memoryTables.food_master.store.clear();
  memoryTables.event_master.store.clear();
  memoryTables.categories.store.clear();
  memoryTables.user_settings.store.clear();
}

/**
 * 端末のブラウザに過去に残存している物理 IndexedDB ('cgm_diabetes_manager_db') を完全に削除・パージする
 */
export async function purgeDemoPhysicalIndexedDB(): Promise<void> {
  if (typeof window === 'undefined' || !isDemoMemoryOnlyMode()) return;
  try {
    window.localStorage.removeItem('cgm_real_dataset_version_v4');
  } catch {
    // Ignore
  }
  try {
    if (physicalDb.isOpen()) {
      physicalDb.close();
    }
  } catch {
    // Ignore
  }
  try {
    if (
      typeof window.indexedDB !== 'undefined' &&
      typeof window.indexedDB.deleteDatabase === 'function'
    ) {
      await new Promise<void>((resolve) => {
        const req = window.indexedDB.deleteDatabase(PHYSICAL_DB_NAME);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });
    }
  } catch {
    // Ignore
  }
}

if (typeof window !== 'undefined') {
  if (isDemoMemoryOnlyMode()) {
    void purgeDemoPhysicalIndexedDB();
  }
  window.addEventListener('pagehide', () => {
    if (isDemoMemoryOnlyMode()) {
      clearInMemoryDemoDatabase();
      void purgeDemoPhysicalIndexedDB();
    }
  });
}

/**
 * Local database facade:
 * - デモアプリ既定状態 (`isDemoMemoryOnlyMode() === true`): 端末の物理 IndexedDB には一切書き込まず、RAM 上の InMemoryTable で高速動作
 * - 通常モード / E2E CSV検証モード (`isDemoMemoryOnlyMode() === false`): Dexie.js による物理 IndexedDB で永続化
 */
export class DiabetesAppDatabase {
  get libre_readings(): EntityTable<LibreReading, 'id'> {
    return (
      isDemoMemoryOnlyMode() ? memoryTables.libre_readings : physicalDb.libre_readings
    ) as unknown as EntityTable<LibreReading, 'id'>;
  }

  get events(): EntityTable<HealthEvent, 'id'> {
    return (
      isDemoMemoryOnlyMode() ? memoryTables.events : physicalDb.events
    ) as unknown as EntityTable<HealthEvent, 'id'>;
  }

  get meal_details(): EntityTable<MealDetail, 'id'> {
    return (
      isDemoMemoryOnlyMode() ? memoryTables.meal_details : physicalDb.meal_details
    ) as unknown as EntityTable<MealDetail, 'id'>;
  }

  get food_master(): EntityTable<FoodMaster, 'id'> {
    return (
      isDemoMemoryOnlyMode() ? memoryTables.food_master : physicalDb.food_master
    ) as unknown as EntityTable<FoodMaster, 'id'>;
  }

  get event_master(): EntityTable<EventMaster, 'id'> {
    return (
      isDemoMemoryOnlyMode() ? memoryTables.event_master : physicalDb.event_master
    ) as unknown as EntityTable<EventMaster, 'id'>;
  }

  get categories(): EntityTable<Category, 'id'> {
    return (
      isDemoMemoryOnlyMode() ? memoryTables.categories : physicalDb.categories
    ) as unknown as EntityTable<Category, 'id'>;
  }

  get user_settings(): EntityTable<UserSettings, 'user_id'> {
    return (
      isDemoMemoryOnlyMode() ? memoryTables.user_settings : physicalDb.user_settings
    ) as unknown as EntityTable<UserSettings, 'user_id'>;
  }

  async open(): Promise<Dexie> {
    if (isDemoMemoryOnlyMode()) {
      await purgeDemoPhysicalIndexedDB();
      return physicalDb;
    }
    return physicalDb.open();
  }

  close(): void {
    if (physicalDb.isOpen()) {
      physicalDb.close();
    }
  }

  async transaction<U>(_mode: string, ...args: any[]): Promise<U> {
    const callback = args[args.length - 1];
    if (isDemoMemoryOnlyMode()) {
      if (typeof callback === 'function') {
        return await callback();
      }
      return undefined as unknown as U;
    }
    return (physicalDb.transaction as any)(_mode, ...args);
  }
}

export const db = new DiabetesAppDatabase();

/**
 * Request persistent storage from browser (prevents Safari/Chrome auto-eviction in non-demo mode)
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (isDemoMemoryOnlyMode()) {
    return false;
  }
  if (typeof window !== 'undefined' && navigator.storage && navigator.storage.persist) {
    try {
      return await navigator.storage.persist();
    } catch (err) {
      console.warn('[Storage] Failed to request persistent storage:', err);
      return false;
    }
  }
  return false;
}
