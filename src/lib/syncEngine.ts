import type { SupabaseClient } from '@supabase/supabase-js';
import { db } from './db';
import { getSupabaseClient } from './supabase';
import {
  cancelBackgroundHydration,
  clearPatientManuallyCleared,
  invalidateAnalysisDatasetCache,
  invalidateInMemoryRecentCache,
} from './realGlucoseLoader';
import { resetFoodSeedSession } from './foodSeed';
import { reevaluatePatientAnomalyEvents } from './anomalyExtractor';
import { deterministicUuid, ensureUuid } from './uuidUtils';
import {
  DEFAULT_HYPER_THRESHOLD,
  DEFAULT_HYPO_THRESHOLD,
  type Category,
  type EventMaster,
  type FamilyPermission,
  type FoodMaster,
  type HealthEvent,
  type LibreReading,
  type MealDetail,
  type UserRole,
  type UserSettings,
} from '@/types/database';

export const DEFAULT_LOCAL_PATIENT_ID = '00000000-0000-0000-0000-000000000001';
export const DEFAULT_CHUNK_SIZE = 1000;

export const UNAUTHORIZED_ACCESS_ERROR_MESSAGE =
  'このアカウントにはアクセス権限がありません。患者ご本人、または事前に招待されたご家族のメールアドレスでのみログインできます。';

export interface AccessVerificationResult {
  authorized: boolean;
  isOwner: boolean;
  isInvitedFamily: boolean;
  errorMessage?: string;
}

export interface AccessiblePatientTarget {
  patientId: string;
  label: string;
  role: UserRole;
  permissionId?: string;
  ownerEmail?: string | null;
}

export interface ResolvedAccessState {
  currentPatientId: string;
  currentRole: UserRole;
  accessibleTargets: AccessiblePatientTarget[];
  myInvitedFollowers: FamilyPermission[];
}

export interface SyncOptions {
  /** 対象患者データの編集権限があるか（viewer の場合は Push をスキップし Pull のみ実行） */
  canEdit?: boolean;
  /** 閾値変更やCSV取込直後など、Supabase上の古い異常値イベントをローカル状態に合わせて置換削除するか */
  replaceRemoteAnomalies?: boolean;
  /** libre_readings の全件比較・Push/Pull を強制実行するか */
  includeReadings?: boolean;
  /** テスト用モッククライアント注入 */
  clientOverride?: SupabaseClient | null;
}

export interface SyncResult {
  status: 'success' | 'skipped' | 'error';
  syncedAt?: string;
  pushedCount: number;
  pulledCount: number;
  errorMessage?: string;
}

type UiCacheInvalidator = (patientId?: string) => void;
const uiCacheInvalidators = new Set<UiCacheInvalidator>();

/**
 * UI層のメモリキャッシュ（FoodMasterView, CalendarView 等）を同期完了時に一括破棄するためのコールバック登録
 */
export function registerUiCacheInvalidator(fn: UiCacheInvalidator): () => void {
  uiCacheInvalidators.add(fn);
  return () => {
    uiCacheInvalidators.delete(fn);
  };
}

/**
 * 全4種のオンメモリキャッシュを破棄する（patientId 省略時は全患者分のキャッシュを全消去）
 */
export function invalidateAllCachesAfterSync(patientId?: string): void {
  invalidateAnalysisDatasetCache(patientId);
  invalidateInMemoryRecentCache(patientId);
  for (const fn of uiCacheInvalidators) {
    try {
      fn(patientId);
    } catch {
      // Ignore individual UI cache error
    }
  }
}

/**
 * 課題 #7 対応:
 * Supabase (TIMESTAMPTZ) から取得した日時文字列（例: "2026-08-25T12:30:00+00:00",
 * "2026-08-25 07:15:00+00", "2026-08-25T12:30:00Z" 等）を、
 * IndexedDB の `.between()` 辞書順検索が100%機能する 24文字のウォールクロックISO形式
 * （"YYYY-MM-DDTHH:mm:ss.000Z"）へ正規化する。
 */
export function normalizeToWallClockIso(raw: string | null | undefined): string {
  if (!raw) {
    return '1970-01-01T00:00:00.000Z';
  }
  const trimmed = String(raw).trim();
  const match = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/
  );
  if (match) {
    const [, yyyy, mm, dd, hh, min, ss] = match;
    return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss ?? '00'}.000Z`;
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 19) + '.000Z';
  }
  return trimmed;
}

/**
 * 大容量配列を指定件数（デフォルト 1,000件）ずつのチャンクに分割する
 */
export function chunkArray<T>(
  items: readonly T[],
  chunkSize: number = DEFAULT_CHUNK_SIZE
): T[][] {
  const safeSize = chunkSize > 0 ? Math.floor(chunkSize) : DEFAULT_CHUNK_SIZE;
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) {
    chunks.push(items.slice(i, i + safeSize));
  }
  return chunks;
}

function parseTimestampMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

export interface LwwEntity {
  id: string;
  updated_at?: string;
  created_at?: string;
  is_deleted?: boolean;
}

export interface ComputeLwwDiffOptions<T extends LwwEntity> {
  canEdit: boolean;
  filterLocal?: (item: T) => boolean;
  preferDeletedOnTie?: boolean;
  transformBeforePush?: (item: T) => T;
}

/**
 * Last-Write-Wins (LWW) 双方向差分解決ジェネリック純粋関数
 * - ローカルのみに存在するレコードは canEdit === true 時に toPush へ追加
 * - リモートのみに存在するレコードは常に toPull へ追加
 * - 両方に存在するレコードは updated_at (または created_at) タイムスタンプを比較し、
 *   preferDeletedOnTie === true 時は論理削除側 (is_deleted: true) も優先判定する
 */
export function computeLwwDiff<T extends LwwEntity>(
  localItems: readonly T[],
  remoteItems: readonly T[],
  options: ComputeLwwDiffOptions<T>
): { toPush: T[]; toPull: T[] } {
  const { canEdit, filterLocal, preferDeletedOnTie = false, transformBeforePush } = options;
  const remoteById = new Map(remoteItems.map((r) => [r.id, r]));
  const localById = new Map(localItems.map((l) => [l.id, l]));
  const toPush: T[] = [];
  const toPull: T[] = [];

  for (const rawLocal of localItems) {
    if (filterLocal && !filterLocal(rawLocal)) continue;
    const localItem = transformBeforePush ? transformBeforePush(rawLocal) : rawLocal;
    const remoteItem = remoteById.get(localItem.id);
    if (!remoteItem) {
      if (canEdit) toPush.push(localItem);
    } else {
      const lMs = parseTimestampMs(localItem.updated_at || localItem.created_at);
      const rMs = parseTimestampMs(remoteItem.updated_at || remoteItem.created_at);
      const localDeletedWins =
        preferDeletedOnTie && Boolean(localItem.is_deleted) && !remoteItem.is_deleted;
      const remoteDeletedWins =
        preferDeletedOnTie && Boolean(remoteItem.is_deleted) && !localItem.is_deleted;

      if ((lMs > rMs || localDeletedWins) && canEdit) {
        toPush.push(localItem);
      } else if (rMs > lMs || remoteDeletedWins || !canEdit) {
        toPull.push(remoteItem);
      }
    }
  }

  for (const remoteItem of remoteItems) {
    if (!localById.has(remoteItem.id)) {
      toPull.push(remoteItem);
    }
  }

  return { toPush, toPull };
}

/**
 * ログインユーザーの family_permissions レコード一覧から、
 * 監視対象患者（currentPatientId）、ロール（patient / editor / viewer）、
 * 切り替え可能な対象一覧、および自分が招待した家族一覧を解決する純粋関数。
 */
export function resolveUserAccessFromPermissions(
  authUserId: string,
  authEmail: string | null | undefined,
  permissions: readonly FamilyPermission[],
  preferredPatientId?: string | null
): ResolvedAccessState {
  const normalizedEmail = (authEmail ?? '').trim().toLowerCase();

  // 自分が患者として招待した家族一覧
  const myInvitedFollowers = permissions.filter(
    (p) => p.patient_id === authUserId
  );

  // 自分宛てに届いている他患者からの招待一覧
  const invitationsForMe = permissions.filter((p) => {
    if (p.patient_id === authUserId) return false;
    const matchById = Boolean(p.family_user_id && p.family_user_id === authUserId);
    const matchByEmail = Boolean(
      normalizedEmail &&
      p.family_email &&
      p.family_email.trim().toLowerCase() === normalizedEmail
    );
    return matchById || matchByEmail;
  });

  const accessibleTargets: AccessiblePatientTarget[] = [];

  for (const inv of invitationsForMe) {
    if (!accessibleTargets.some((t) => t.patientId === inv.patient_id)) {
      const roleLabel = inv.role === 'editor' ? '記録・編集可能' : '閲覧のみ';
      accessibleTargets.push({
        patientId: inv.patient_id,
        label: `共有された家族の記録 (${roleLabel})`,
        role: inv.role,
        permissionId: inv.id,
      });
    }
  }

  // 自分自身の患者プロファイルも常に選択肢に含める
  accessibleTargets.push({
    patientId: authUserId,
    label: '自分自身の記録 (本人)',
    role: 'patient',
  });

  // 優先指定された patientId がアクセス可能一覧にあれば採用、
  // なければ家族招待がある場合は招待元の patient_id を優先、それもなければ本人 (authUserId)
  let selectedTarget = accessibleTargets.find(
    (t) => preferredPatientId && t.patientId === preferredPatientId
  );

  if (!selectedTarget) {
    selectedTarget = accessibleTargets[0];
  }

  return {
    currentPatientId: selectedTarget.patientId,
    currentRole: selectedTarget.role,
    accessibleTargets,
    myInvitedFollowers,
  };
}

/**
 * ログインまたは新規登録したユーザーが「システムのオーナー本人」または
 * 「family_permissions に招待登録された家族」のいずれかであるかを検証する。
 * 招待されていない無関係な第三者の場合は authorized: false を返し、即時サインアウトさせる。
 */
export async function verifyUserAccessWithCloud(
  client: SupabaseClient | null,
  authUserId: string,
  authEmail: string | null | undefined,
  permissions: readonly FamilyPermission[]
): Promise<AccessVerificationResult> {
  if (!authUserId) {
    return {
      authorized: false,
      isOwner: false,
      isInvitedFamily: false,
      errorMessage: UNAUTHORIZED_ACCESS_ERROR_MESSAGE,
    };
  }

  const normalizedEmail = (authEmail ?? '').trim().toLowerCase();

  // 1. family_permissions でオーナー本人として招待を発行済みか、または招待された家族として一致するか判定
  const hasOwnedPermissions = permissions.some((p) => p.patient_id === authUserId);
  const isInvitedFamily = permissions.some((p) => {
    if (p.patient_id === authUserId) return false;
    const matchById = Boolean(p.family_user_id && p.family_user_id === authUserId);
    const matchByEmail = Boolean(
      normalizedEmail &&
        p.family_email &&
        p.family_email.trim().toLowerCase() === normalizedEmail
    );
    return matchById || matchByEmail;
  });

  if (hasOwnedPermissions || isInvitedFamily) {
    return {
      authorized: true,
      isOwner: hasOwnedPermissions || !isInvitedFamily,
      isInvitedFamily,
    };
  }

  if (!client) {
    return {
      authorized: true,
      isOwner: true,
      isInvitedFamily: false,
    };
  }

  // 2. DB 側 SECURITY DEFINER RPC (verify_user_authorization) による厳格検証
  if (typeof (client as { rpc?: unknown }).rpc === 'function') {
    try {
      const { data: rpcData, error: rpcErr } = await client.rpc(
        'verify_user_authorization'
      );
      if (!rpcErr && rpcData && typeof rpcData === 'object') {
        const authFlag = (rpcData as { authorized?: unknown }).authorized;
        if (authFlag === false) {
          return {
            authorized: false,
            isOwner: false,
            isInvitedFamily: false,
            errorMessage: UNAUTHORIZED_ACCESS_ERROR_MESSAGE,
          };
        }
        if (authFlag === true) {
          const rpcIsInvited = Boolean(
            (rpcData as { is_invited_family?: unknown }).is_invited_family
          );
          const rpcIsOwner =
            typeof (rpcData as { is_owner?: unknown }).is_owner === 'boolean'
              ? Boolean((rpcData as { is_owner?: unknown }).is_owner)
              : !rpcIsInvited;
          return {
            authorized: true,
            isOwner: rpcIsOwner,
            isInvitedFamily: rpcIsInvited,
          };
        }
      }
    } catch {
      // RPC が未適用の場合は後続のテーブル＆RLSプローブ検証へフォールバック
    }
  }

  // 3. フォールバック検証: user_settings の参照および初期オーナー登録可否（RLSプローブ）を確認
  try {
    const eqQuery = client
      .from('user_settings')
      .select('*')
      .eq('user_id', authUserId) as unknown as {
      maybeSingle?: () => Promise<{ data: unknown; error: { message?: string } | null }>;
    } & PromiseLike<{ data: unknown; error: { message?: string } | null }>;

    const { data: existingSettings, error: selErr } =
      typeof eqQuery.maybeSingle === 'function'
        ? await eqQuery.maybeSingle()
        : await eqQuery;

    if (selErr) {
      return {
        authorized: false,
        isOwner: false,
        isInvitedFamily: false,
        errorMessage: UNAUTHORIZED_ACCESS_ERROR_MESSAGE,
      };
    }

    const hasExistingRow = Array.isArray(existingSettings)
      ? existingSettings.length > 0
      : Boolean(existingSettings);

    if (hasExistingRow) {
      return {
        authorized: true,
        isOwner: true,
        isInvitedFamily: false,
      };
    }

    const nowIso = new Date().toISOString();
    const { error: probeErr } = await client.from('user_settings').upsert(
      [
        {
          user_id: authUserId,
          hypo_threshold: DEFAULT_HYPO_THRESHOLD,
          hyper_threshold: DEFAULT_HYPER_THRESHOLD,
          target_tir_min: DEFAULT_HYPO_THRESHOLD,
          target_tir_max: DEFAULT_HYPER_THRESHOLD,
          enable_default_insulin: false,
          default_insulin_breakfast: null,
          default_insulin_lunch: null,
          default_insulin_dinner: null,
          default_insulin_snack: null,
          updated_at: nowIso,
        },
      ],
      { onConflict: 'user_id' }
    );

    if (probeErr) {
      return {
        authorized: false,
        isOwner: false,
        isInvitedFamily: false,
        errorMessage: UNAUTHORIZED_ACCESS_ERROR_MESSAGE,
      };
    }

    return {
      authorized: true,
      isOwner: true,
      isInvitedFamily: false,
    };
  } catch {
    return {
      authorized: false,
      isOwner: false,
      isInvitedFamily: false,
      errorMessage: UNAUTHORIZED_ACCESS_ERROR_MESSAGE,
    };
  }
}

/**
 * ログアウト時または未認可アクセス遮断時に、端末ブラウザ内のローカルキャッシュ
 * （IndexedDB 全7テーブルおよび全4種のオンメモリキャッシュ・同期シグネチャ・シードセッション）を完全消去する。
 */
export async function purgeAllLocalPatientCaches(
  previousPatientId?: string
): Promise<void> {
  resetSyncSignaturesForPatient();
  resetFoodSeedSession();
  clearPatientManuallyCleared();
  if (previousPatientId) {
    cancelBackgroundHydration(previousPatientId);
  }
  cancelBackgroundHydration(DEFAULT_LOCAL_PATIENT_ID);

  try {
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
        await db.user_settings.clear();
        await db.libre_readings.clear();
        await db.events.clear();
        await db.meal_details.clear();
        await db.food_master.clear();
        await db.event_master.clear();
        await db.categories.clear();
      }
    );
  } catch (err) {
    console.warn('Failed to clear local IndexedDB on sign-out:', err);
  }

  // 引数なしで呼び出し、全患者ID分のオンメモリキャッシュ（FoodMasterView, CalendarView, Analysis, RecentSlice）を一括消去
  invalidateAllCachesAfterSync();
}

/**
 * 未ログイン時（DEFAULT_LOCAL_PATIENT_ID）にローカルに記録・編集されたデータを、
 * ログインした本人アカウント（targetUserId）へ引き継ぐ。
 */
export async function migrateAnonymousLocalDataToUser(
  targetUserId: string,
  anonymousPatientId: string = DEFAULT_LOCAL_PATIENT_ID
): Promise<boolean> {
  if (!targetUserId || targetUserId === anonymousPatientId) {
    return false;
  }

  let migratedAny = false;

  await db.transaction(
    'rw',
    [
      db.user_settings,
      db.categories,
      db.food_master,
      db.event_master,
      db.events,
      db.meal_details,
      db.libre_readings,
    ],
    async () => {
      // 1. カテゴリの引き継ぎ（IDマッピングを作成）
      const anonCategories = await db.categories
        .where('user_id')
        .equals(anonymousPatientId)
        .toArray();
      const targetCategories = await db.categories
        .where('user_id')
        .equals(targetUserId)
        .toArray();

      const categoryIdMap = new Map<string, string>();
      const targetCatByKey = new Map<string, Category>();
      for (const c of targetCategories) {
        if (!c.is_deleted) {
          targetCatByKey.set(`${c.target_type}:${c.category_name}`, c);
        }
      }

      if (anonCategories.length > 0) {
        const categoriesToPut: Category[] = [];
        for (const oldCat of anonCategories) {
          const key = `${oldCat.target_type}:${oldCat.category_name}`;
          const existing = targetCatByKey.get(key);
          if (existing) {
            categoryIdMap.set(oldCat.id, existing.id);
            if (parseTimestampMs(oldCat.updated_at) > parseTimestampMs(existing.updated_at)) {
              categoriesToPut.push({
                ...existing,
                display_order: oldCat.display_order,
                is_deleted: oldCat.is_deleted,
                updated_at: oldCat.updated_at,
              });
            }
          } else {
            const newId = deterministicUuid(
              `${targetUserId}_cat_${oldCat.target_type}_${oldCat.category_name}`
            );
            categoryIdMap.set(oldCat.id, newId);
            const migratedCat: Category = {
              ...oldCat,
              id: newId,
              user_id: targetUserId,
            };
            categoriesToPut.push(migratedCat);
            if (!migratedCat.is_deleted) {
              targetCatByKey.set(key, migratedCat);
            }
          }
        }
        if (categoriesToPut.length > 0) {
          await db.categories.bulkPut(categoriesToPut);
        }
        await db.categories.bulkDelete(anonCategories.map((c) => c.id));
        migratedAny = true;
      }

      // 2. 食品（food_master）の引き継ぎ
      const anonFoods = await db.food_master
        .where('user_id')
        .equals(anonymousPatientId)
        .toArray();
      if (anonFoods.length > 0) {
        const targetFoods = await db.food_master
          .where('user_id')
          .equals(targetUserId)
          .toArray();
        const targetFoodByName = new Map<string, FoodMaster>();
        for (const f of targetFoods) {
          targetFoodByName.set(f.food_name, f);
        }

        const foodsToPut: FoodMaster[] = [];
        for (const oldFood of anonFoods) {
          const mappedCatId = oldFood.category_id
            ? categoryIdMap.get(oldFood.category_id) ?? oldFood.category_id
            : undefined;
          const existing = targetFoodByName.get(oldFood.food_name);
          if (existing) {
            if (parseTimestampMs(oldFood.updated_at) > parseTimestampMs(existing.updated_at)) {
              foodsToPut.push({
                ...existing,
                category_id: mappedCatId,
                base_amount: oldFood.base_amount,
                unit: oldFood.unit,
                carbs_per_unit: oldFood.carbs_per_unit,
                is_deleted: oldFood.is_deleted,
                updated_at: oldFood.updated_at,
              });
            }
          } else {
            foodsToPut.push({
              ...oldFood,
              id: deterministicUuid(
                `${targetUserId}_food_${oldFood.food_name}_${oldFood.id}`
              ),
              user_id: targetUserId,
              category_id: mappedCatId,
            });
          }
        }
        if (foodsToPut.length > 0) {
          await db.food_master.bulkPut(foodsToPut);
        }
        await db.food_master.bulkDelete(anonFoods.map((f) => f.id));
        migratedAny = true;
      }

      // 3. 活動（event_master）の引き継ぎ
      const anonEventMasters = await db.event_master
        .where('user_id')
        .equals(anonymousPatientId)
        .toArray();
      if (anonEventMasters.length > 0) {
        const targetEventMasters = await db.event_master
          .where('user_id')
          .equals(targetUserId)
          .toArray();
        const targetByName = new Map<string, EventMaster>();
        for (const em of targetEventMasters) {
          targetByName.set(em.event_name, em);
        }

        const eventsToPut: EventMaster[] = [];
        for (const oldEm of anonEventMasters) {
          const mappedCatId = oldEm.category_id
            ? categoryIdMap.get(oldEm.category_id) ?? oldEm.category_id
            : undefined;
          const existing = targetByName.get(oldEm.event_name);
          if (existing) {
            if (parseTimestampMs(oldEm.updated_at) > parseTimestampMs(existing.updated_at)) {
              eventsToPut.push({
                ...existing,
                category_id: mappedCatId,
                default_duration: oldEm.default_duration,
                memo: oldEm.memo,
                is_deleted: oldEm.is_deleted,
                updated_at: oldEm.updated_at,
              });
            }
          } else {
            eventsToPut.push({
              ...oldEm,
              id: deterministicUuid(
                `${targetUserId}_event_${oldEm.event_name}_${oldEm.id}`
              ),
              user_id: targetUserId,
              category_id: mappedCatId,
            });
          }
        }
        if (eventsToPut.length > 0) {
          await db.event_master.bulkPut(eventsToPut);
        }
        await db.event_master.bulkDelete(anonEventMasters.map((em) => em.id));
        migratedAny = true;
      }

      // 4. 設定（user_settings）の引き継ぎ
      const anonSettings = await db.user_settings.get(anonymousPatientId);
      if (anonSettings) {
        const targetSettings = await db.user_settings.get(targetUserId);
        if (
          !targetSettings ||
          parseTimestampMs(anonSettings.updated_at) >
          parseTimestampMs(targetSettings.updated_at)
        ) {
          await db.user_settings.put({
            ...anonSettings,
            user_id: targetUserId,
          });
        }
        await db.user_settings.delete(anonymousPatientId);
        migratedAny = true;
      }

      // 5. 記録イベント（events）および食事明細（meal_details）の引き継ぎ
      const anonEvents = await db.events
        .where('user_id')
        .equals(anonymousPatientId)
        .toArray();
      if (anonEvents.length > 0) {
        const migratedEvents: HealthEvent[] = [];
        for (const ev of anonEvents) {
          const normDt = normalizeToWallClockIso(ev.event_datetime);
          const isAnomaly =
            ev.event_type === '低血糖' || ev.event_type === '高血糖';
          const newEventId = isAnomaly
            ? deterministicUuid(
              `${targetUserId}_anomaly_${ev.event_type}_${normDt}`
            )
            : ensureUuid(ev.id, `${targetUserId}_event_${normDt}`);
          migratedEvents.push({
            ...ev,
            id: newEventId,
            user_id: targetUserId,
            event_datetime: normDt,
          });
        }
        await db.events.bulkDelete(anonEvents.map((e) => e.id));
        await db.events.bulkPut(migratedEvents);
        migratedAny = true;
      }

      const anonMealDetails = await db.meal_details
        .where('user_id')
        .equals(anonymousPatientId)
        .toArray();
      if (anonMealDetails.length > 0) {
        const migratedDetails: MealDetail[] = anonMealDetails.map((md) => ({
          ...md,
          id: ensureUuid(md.id, `${targetUserId}_md_${md.food_name}`),
          event_id: ensureUuid(md.event_id),
          user_id: targetUserId,
        }));
        await db.meal_details.bulkDelete(anonMealDetails.map((m) => m.id));
        await db.meal_details.bulkPut(migratedDetails);
        migratedAny = true;
      }

      // 6. 血糖測定データ（libre_readings）の引き継ぎ
      const anonReadings = await db.libre_readings
        .where('user_id')
        .equals(anonymousPatientId)
        .toArray();
      if (anonReadings.length > 0) {
        const migratedReadings: LibreReading[] = anonReadings.map((r) => {
          const normTs = normalizeToWallClockIso(r.timestamp);
          return {
            ...r,
            id: deterministicUuid(`${targetUserId}_${normTs}`),
            user_id: targetUserId,
            timestamp: normTs,
          };
        });
        await db.libre_readings.bulkDelete(anonReadings.map((r) => r.id));
        await db.libre_readings.bulkPut(migratedReadings);
        migratedAny = true;
      }
    }
  );

  if (migratedAny) {
    invalidateAllCachesAfterSync(targetUserId);
  }

  return migratedAny;
}

/**
 * Supabase テーブルから対象患者の全レコードを 1,000件ずつのページネーションで取得する
 */
async function fetchAllPatientRowsFromTable<TRow>(
  client: SupabaseClient,
  tableName: string,
  patientId: string,
  orderColumn: string = 'id'
): Promise<TRow[]> {
  const results: TRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await client
      .from(tableName)
      .select('*')
      .eq('user_id', patientId)
      .order(orderColumn, { ascending: true })
      .range(offset, offset + DEFAULT_CHUNK_SIZE - 1);

    if (error) {
      throw new Error(`${tableName} の取得に失敗しました: ${error.message}`);
    }

    const batch = (data ?? []) as TRow[];
    results.push(...batch);

    if (batch.length < DEFAULT_CHUNK_SIZE) {
      break;
    }
    offset += DEFAULT_CHUNK_SIZE;
  }

  return results;
}

/**
 * Supabase テーブルへチャンク単位で upsert する
 */
async function upsertRowsInChunks<TRow extends object>(
  client: SupabaseClient,
  tableName: string,
  rows: readonly TRow[],
  onConflict: string = 'id'
): Promise<number> {
  if (rows.length === 0) return 0;
  const chunks = chunkArray(rows, DEFAULT_CHUNK_SIZE);
  let total = 0;
  for (const chunk of chunks) {
    const { error } = await client
      .from(tableName)
      .upsert(chunk as Record<string, unknown>[], { onConflict });
    if (error) {
      throw new Error(`${tableName} の保存に失敗しました: ${error.message}`);
    }
    total += chunk.length;
  }
  return total;
}

// セッション内で最後に同期完了した libre_readings のシグネチャを保持し、不要な再送を防ぐ
const syncedReadingsSignatureByPatient = new Map<string, string>();

/**
 * テストやデータリセット時にメモリ内の同期シグネチャをクリアする
 */
export function resetSyncSignaturesForPatient(patientId?: string): void {
  if (patientId) {
    syncedReadingsSignatureByPatient.delete(patientId);
  } else {
    syncedReadingsSignatureByPatient.clear();
  }
}

// 同一患者に対する多重同時実行を直列化するロックマップ
const activeSyncPromises = new Map<string, Promise<SyncResult>>();

/**
 * IndexedDB (Dexie.js) と Supabase PostgreSQL の全7テーブル双方向同期（Push & Pull）
 */
export async function syncPatientDataWithCloud(
  patientId: string,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const client =
    options.clientOverride !== undefined
      ? options.clientOverride
      : getSupabaseClient();

  if (!client || !patientId || patientId === DEFAULT_LOCAL_PATIENT_ID) {
    return {
      status: 'skipped',
      pushedCount: 0,
      pulledCount: 0,
    };
  }

  const existingPromise = activeSyncPromises.get(patientId);
  if (existingPromise) {
    await existingPromise.catch(() => undefined);
  }

  const syncTask = executeSyncPatientData(client, patientId, options);
  activeSyncPromises.set(patientId, syncTask);
  try {
    return await syncTask;
  } finally {
    if (activeSyncPromises.get(patientId) === syncTask) {
      activeSyncPromises.delete(patientId);
    }
  }
}

function serializeUserSettingsForRemote(s: UserSettings): Record<string, unknown> {
  return {
    user_id: s.user_id,
    hypo_threshold: Number(s.hypo_threshold ?? DEFAULT_HYPO_THRESHOLD),
    hyper_threshold: Number(s.hyper_threshold ?? DEFAULT_HYPER_THRESHOLD),
    target_tir_min: Number(s.target_tir_min ?? s.hypo_threshold ?? DEFAULT_HYPO_THRESHOLD),
    target_tir_max: Number(s.target_tir_max ?? s.hyper_threshold ?? DEFAULT_HYPER_THRESHOLD),
    enable_default_insulin: Boolean(s.enable_default_insulin),
    default_insulin_breakfast:
      s.default_insulin_breakfast != null ? Number(s.default_insulin_breakfast) : null,
    default_insulin_lunch:
      s.default_insulin_lunch != null ? Number(s.default_insulin_lunch) : null,
    default_insulin_dinner:
      s.default_insulin_dinner != null ? Number(s.default_insulin_dinner) : null,
    default_insulin_snack:
      s.default_insulin_snack != null ? Number(s.default_insulin_snack) : null,
    updated_at: s.updated_at || new Date().toISOString(),
  };
}

function normalizeRemoteUserSettings(raw: Record<string, unknown>): UserSettings {
  return {
    user_id: String(raw.user_id),
    hypo_threshold: Number(raw.hypo_threshold ?? DEFAULT_HYPO_THRESHOLD),
    hyper_threshold: Number(raw.hyper_threshold ?? DEFAULT_HYPER_THRESHOLD),
    target_tir_min: Number(raw.target_tir_min ?? raw.hypo_threshold ?? DEFAULT_HYPO_THRESHOLD),
    target_tir_max: Number(raw.target_tir_max ?? raw.hyper_threshold ?? DEFAULT_HYPER_THRESHOLD),
    enable_default_insulin: Boolean(raw.enable_default_insulin),
    default_insulin_breakfast:
      raw.default_insulin_breakfast != null
        ? Number(raw.default_insulin_breakfast)
        : null,
    default_insulin_lunch:
      raw.default_insulin_lunch != null ? Number(raw.default_insulin_lunch) : null,
    default_insulin_dinner:
      raw.default_insulin_dinner != null ? Number(raw.default_insulin_dinner) : null,
    default_insulin_snack:
      raw.default_insulin_snack != null ? Number(raw.default_insulin_snack) : null,
    updated_at: String(raw.updated_at || new Date().toISOString()),
  };
}

async function executeSyncPatientData(
  client: SupabaseClient,
  patientId: string,
  options: SyncOptions
): Promise<SyncResult> {
  const canEdit = options.canEdit !== false;
  let pushedCount = 0;
  let pulledCount = 0;

  try {
    // =========================================================================
    // 1. user_settings (PK: user_id)
    // =========================================================================
    const localSettingsBefore = await db.user_settings.get(patientId);
    const settingsEqQuery = client
      .from('user_settings')
      .select('*')
      .eq('user_id', patientId) as unknown as {
      maybeSingle?: () => Promise<{ data: unknown; error: { message: string } | null }>;
    } & PromiseLike<{ data: unknown; error: { message: string } | null }>;

    const { data: remoteSettingsData, error: settingsErr } =
      typeof settingsEqQuery.maybeSingle === 'function'
        ? await settingsEqQuery.maybeSingle()
        : await settingsEqQuery;

    if (settingsErr) {
      throw new Error(`user_settings の取得に失敗しました: ${settingsErr.message}`);
    }

    const remoteSettingsRaw = (
      Array.isArray(remoteSettingsData) ? remoteSettingsData[0] : remoteSettingsData
    ) as Record<string, any> | undefined | null;
    const remoteSettings: UserSettings | null = remoteSettingsRaw
      ? normalizeRemoteUserSettings(remoteSettingsRaw)
      : null;

    let thresholdChangedFromRemote = false;

    if (localSettingsBefore && !remoteSettings) {
      if (canEdit) {
        await upsertRowsInChunks(
          client,
          'user_settings',
          [serializeUserSettingsForRemote(localSettingsBefore)],
          'user_id'
        );
        pushedCount += 1;
      }
    } else if (!localSettingsBefore && remoteSettings) {
      await db.user_settings.put(remoteSettings);
      pulledCount += 1;
      thresholdChangedFromRemote = true;
    } else if (localSettingsBefore && remoteSettings) {
      const localMs = parseTimestampMs(localSettingsBefore.updated_at);
      const remoteMs = parseTimestampMs(remoteSettings.updated_at);
      if (localMs > remoteMs && canEdit) {
        await upsertRowsInChunks(
          client,
          'user_settings',
          [serializeUserSettingsForRemote(localSettingsBefore)],
          'user_id'
        );
        pushedCount += 1;
      } else if (remoteMs > localMs || !canEdit) {
        if (
          localSettingsBefore.hypo_threshold !== remoteSettings.hypo_threshold ||
          localSettingsBefore.hyper_threshold !== remoteSettings.hyper_threshold
        ) {
          thresholdChangedFromRemote = true;
        }
        await db.user_settings.put(remoteSettings);
        if (remoteMs > localMs) {
          pulledCount += 1;
        }
      }
    }

    // =========================================================================
    // 2. categories (PK: id, 部分ユニークインデックス uq_user_type_cat_active 対応)
    // =========================================================================
    const remoteCategoriesRaw = await fetchAllPatientRowsFromTable<Record<string, any>>(
      client,
      'categories',
      patientId,
      'id'
    );
    const remoteCategories: Category[] = remoteCategoriesRaw.map((c) => ({
      id: String(c.id),
      user_id: String(c.user_id),
      target_type: c.target_type === 'event' ? 'event' : 'food',
      category_name: String(c.category_name),
      display_order: Number(c.display_order ?? 0),
      is_protected: Boolean(c.is_protected),
      is_deleted: Boolean(c.is_deleted),
      created_at: String(c.created_at || new Date().toISOString()),
      updated_at: String(c.updated_at || new Date().toISOString()),
    }));

    let localCategories = await db.categories
      .where('user_id')
      .equals(patientId)
      .toArray();

    // リモートに同一 (target_type, category_name) のアクティブカテゴリが別UUIDで存在する場合、
    // uq_user_type_cat_active 衝突を防ぐためローカルの参照IDをリモートIDへ統合する
    const remoteActiveByKey = new Map<string, Category>();
    for (const rc of remoteCategories) {
      if (!rc.is_deleted) {
        remoteActiveByKey.set(`${rc.target_type}:${rc.category_name}`, rc);
      }
    }

    const categoryRemap = new Map<string, string>();
    for (const lc of localCategories) {
      if (!lc.is_deleted) {
        const remoteMatch = remoteActiveByKey.get(
          `${lc.target_type}:${lc.category_name}`
        );
        if (remoteMatch && remoteMatch.id !== lc.id) {
          categoryRemap.set(lc.id, remoteMatch.id);
        }
      }
    }

    if (categoryRemap.size > 0) {
      await db.transaction(
        'rw',
        [db.categories, db.food_master, db.event_master],
        async () => {
          for (const [oldId, newId] of categoryRemap.entries()) {
            await db.categories.delete(oldId);
            const foodsToUpdate = await db.food_master
              .where('user_id')
              .equals(patientId)
              .filter((f) => f.category_id === oldId)
              .toArray();
            if (foodsToUpdate.length > 0) {
              await db.food_master.bulkPut(
                foodsToUpdate.map((f) => ({ ...f, category_id: newId }))
              );
            }
            const eventsToUpdate = await db.event_master
              .where('user_id')
              .equals(patientId)
              .filter((em) => em.category_id === oldId)
              .toArray();
            if (eventsToUpdate.length > 0) {
              await db.event_master.bulkPut(
                eventsToUpdate.map((em) => ({ ...em, category_id: newId }))
              );
            }
          }
        }
      );
      localCategories = await db.categories
        .where('user_id')
        .equals(patientId)
        .toArray();
    }

    const { toPush: categoriesToPush, toPull: categoriesToPull } = computeLwwDiff(
      localCategories,
      remoteCategories,
      { canEdit }
    );

    if (categoriesToPull.length > 0) {
      await db.categories.bulkPut(categoriesToPull);
      pulledCount += categoriesToPull.length;
    }
    if (canEdit && categoriesToPush.length > 0) {
      pushedCount += await upsertRowsInChunks(
        client,
        'categories',
        categoriesToPush.map((c) => ({
          id: c.id,
          user_id: c.user_id,
          target_type: c.target_type,
          category_name: c.category_name,
          display_order: Number(c.display_order ?? 0),
          is_protected: Boolean(c.is_protected),
          is_deleted: Boolean(c.is_deleted),
          created_at: c.created_at,
          updated_at: c.updated_at,
        })),
        'id'
      );
    }

    const validCategoryIds = new Set<string>([
      ...localCategories.map((c) => c.id),
      ...remoteCategories.map((c) => c.id),
    ]);

    // =========================================================================
    // 3. food_master (PK: id, FK: category_id -> categories.id)
    // =========================================================================
    const remoteFoodsRaw = await fetchAllPatientRowsFromTable<Record<string, any>>(
      client,
      'food_master',
      patientId,
      'id'
    );
    const remoteFoods: FoodMaster[] = remoteFoodsRaw.map((f) => ({
      id: String(f.id),
      user_id: String(f.user_id),
      category_id: f.category_id ? String(f.category_id) : undefined,
      food_name: String(f.food_name),
      base_amount: Number(f.base_amount ?? 1),
      unit: String(f.unit || '個'),
      carbs_per_unit: Number(f.carbs_per_unit ?? 0),
      is_deleted: Boolean(f.is_deleted),
      created_at: String(f.created_at || new Date().toISOString()),
      updated_at: String(f.updated_at || new Date().toISOString()),
    }));

    const localFoods = await db.food_master
      .where('user_id')
      .equals(patientId)
      .toArray();
    const { toPush: foodsToPush, toPull: foodsToPull } = computeLwwDiff(
      localFoods,
      remoteFoods,
      { canEdit }
    );

    if (foodsToPull.length > 0) {
      await db.food_master.bulkPut(foodsToPull);
      pulledCount += foodsToPull.length;
    }
    if (canEdit && foodsToPush.length > 0) {
      pushedCount += await upsertRowsInChunks(
        client,
        'food_master',
        foodsToPush.map((f) => ({
          id: f.id,
          user_id: f.user_id,
          category_id:
            f.category_id && validCategoryIds.has(f.category_id)
              ? f.category_id
              : null,
          food_name: f.food_name,
          base_amount: Number(f.base_amount ?? 1),
          unit: f.unit || '個',
          carbs_per_unit: Number(f.carbs_per_unit ?? 0),
          is_deleted: Boolean(f.is_deleted),
          created_at: f.created_at,
          updated_at: f.updated_at,
        })),
        'id'
      );
    }

    // =========================================================================
    // 4. event_master (PK: id, FK: category_id -> categories.id)
    // =========================================================================
    const remoteEventMastersRaw = await fetchAllPatientRowsFromTable<Record<string, any>>(
      client,
      'event_master',
      patientId,
      'id'
    );
    const remoteEventMasters: EventMaster[] = remoteEventMastersRaw.map((em) => ({
      id: String(em.id),
      user_id: String(em.user_id),
      category_id: em.category_id ? String(em.category_id) : undefined,
      event_name: String(em.event_name),
      default_duration: Number(em.default_duration ?? 30),
      memo: em.memo ?? undefined,
      is_deleted: Boolean(em.is_deleted),
      created_at: String(em.created_at || new Date().toISOString()),
      updated_at: String(em.updated_at || new Date().toISOString()),
    }));

    const localEventMasters = await db.event_master
      .where('user_id')
      .equals(patientId)
      .toArray();
    const { toPush: emsToPush, toPull: emsToPull } = computeLwwDiff(
      localEventMasters,
      remoteEventMasters,
      { canEdit }
    );

    if (emsToPull.length > 0) {
      await db.event_master.bulkPut(emsToPull);
      pulledCount += emsToPull.length;
    }
    if (canEdit && emsToPush.length > 0) {
      pushedCount += await upsertRowsInChunks(
        client,
        'event_master',
        emsToPush.map((em) => ({
          id: em.id,
          user_id: em.user_id,
          category_id:
            em.category_id && validCategoryIds.has(em.category_id)
              ? em.category_id
              : null,
          event_name: em.event_name,
          default_duration: Number(em.default_duration ?? 30),
          memo: em.memo ?? null,
          is_deleted: Boolean(em.is_deleted),
          created_at: em.created_at,
          updated_at: em.updated_at,
        })),
        'id'
      );
    }

    // =========================================================================
    // 5. events (PK: id, 課題 #7 event_datetime 正規化 & 課題 #6 異常値イベント整合性)
    // =========================================================================
    const remoteEventsRaw = await fetchAllPatientRowsFromTable<Record<string, any>>(
      client,
      'events',
      patientId,
      'id'
    );
    const remoteEvents: HealthEvent[] = remoteEventsRaw.map((ev) => ({
      id: String(ev.id),
      user_id: String(ev.user_id),
      event_datetime: normalizeToWallClockIso(ev.event_datetime),
      event_type: ev.event_type,
      timing_category: ev.timing_category ?? undefined,
      total_carbs:
        ev.total_carbs !== null && ev.total_carbs !== undefined
          ? Number(ev.total_carbs)
          : undefined,
      insulin_units:
        ev.insulin_units !== null && ev.insulin_units !== undefined
          ? Number(ev.insulin_units)
          : undefined,
      pre_meal_glucose:
        ev.pre_meal_glucose !== null && ev.pre_meal_glucose !== undefined
          ? Number(ev.pre_meal_glucose)
          : undefined,
      post_meal_glucose:
        ev.post_meal_glucose !== null && ev.post_meal_glucose !== undefined
          ? Number(ev.post_meal_glucose)
          : undefined,
      duration_minutes:
        ev.duration_minutes !== null && ev.duration_minutes !== undefined
          ? Number(ev.duration_minutes)
          : undefined,
      memo: ev.memo ?? undefined,
      is_deleted: Boolean(ev.is_deleted),
      created_at: String(ev.created_at || new Date().toISOString()),
      updated_at: String(ev.updated_at || new Date().toISOString()),
    }));

    const localEvents = await db.events
      .where('user_id')
      .equals(patientId)
      .toArray();

    // 課題 #6 対応: 閾値変更やCSV取込直後の同期（replaceRemoteAnomalies === true）では、
    // リモート上の古い異常値レコードを一括削除し、ローカルで再計算された最新の異常値集合で置換する
    const staleRemoteAnomalyIds = new Set<string>();
    if (canEdit && options.replaceRemoteAnomalies) {
      const { error: delErr } = await client
        .from('events')
        .delete()
        .eq('user_id', patientId)
        .in('event_type', ['低血糖', '高血糖']);
      if (delErr) {
        throw new Error(`古い異常値イベントの削除に失敗しました: ${delErr.message}`);
      }
      for (const rev of remoteEvents) {
        if (rev.event_type === '低血糖' || rev.event_type === '高血糖') {
          staleRemoteAnomalyIds.add(rev.id);
        }
      }
    }

    const activeRemoteEvents = remoteEvents.filter(
      (rev) => !staleRemoteAnomalyIds.has(rev.id)
    );
    const { toPush: eventsToPush, toPull: eventsToPull } = computeLwwDiff(
      localEvents,
      activeRemoteEvents,
      {
        canEdit,
        transformBeforePush: (lev) => ({
          ...lev,
          event_datetime: normalizeToWallClockIso(lev.event_datetime),
        }),
      }
    );

    if (eventsToPull.length > 0) {
      await db.events.bulkPut(eventsToPull);
      pulledCount += eventsToPull.length;
    }
    if (canEdit && eventsToPush.length > 0) {
      pushedCount += await upsertRowsInChunks(
        client,
        'events',
        eventsToPush.map((ev) => ({
          id: ev.id,
          user_id: ev.user_id,
          event_datetime: normalizeToWallClockIso(ev.event_datetime),
          event_type: ev.event_type,
          timing_category: ev.timing_category ?? null,
          total_carbs: ev.total_carbs != null ? Number(ev.total_carbs) : null,
          insulin_units: ev.insulin_units != null ? Number(ev.insulin_units) : null,
          pre_meal_glucose:
            ev.pre_meal_glucose != null ? Number(ev.pre_meal_glucose) : null,
          post_meal_glucose:
            ev.post_meal_glucose != null ? Number(ev.post_meal_glucose) : null,
          duration_minutes:
            ev.duration_minutes != null ? Number(ev.duration_minutes) : null,
          memo: ev.memo ?? null,
          is_deleted: Boolean(ev.is_deleted),
          created_at: ev.created_at,
          updated_at: ev.updated_at,
        })),
        'id'
      );
    }

    const validEventIds = new Set<string>([
      ...localEvents.map((ev) => ev.id),
      ...activeRemoteEvents.map((ev) => ev.id),
    ]);

    // =========================================================================
    // 6. meal_details (PK: id, FK: event_id -> events.id)
    // =========================================================================
    const remoteMealDetailsRaw = await fetchAllPatientRowsFromTable<Record<string, any>>(
      client,
      'meal_details',
      patientId,
      'id'
    );
    const remoteMealDetails: MealDetail[] = remoteMealDetailsRaw.map((md) => ({
      id: String(md.id),
      event_id: String(md.event_id),
      user_id: String(md.user_id),
      food_name: String(md.food_name),
      amount: Number(md.amount ?? 1),
      unit: String(md.unit || '人前'),
      carbs: Number(md.carbs ?? 0),
      is_deleted: Boolean(md.is_deleted),
      updated_at: String(md.updated_at || md.created_at || new Date().toISOString()),
      created_at: String(md.created_at || new Date().toISOString()),
    }));

    const localMealDetails = await db.meal_details
      .where('user_id')
      .equals(patientId)
      .toArray();
    const { toPush: mdsToPush, toPull: mdsToPull } = computeLwwDiff(
      localMealDetails,
      remoteMealDetails,
      {
        canEdit,
        filterLocal: (lmd) => validEventIds.has(lmd.event_id),
        preferDeletedOnTie: true,
      }
    );

    if (mdsToPull.length > 0) {
      await db.meal_details.bulkPut(mdsToPull);
      pulledCount += mdsToPull.length;
    }
    if (canEdit && mdsToPush.length > 0) {
      pushedCount += await upsertRowsInChunks(
        client,
        'meal_details',
        mdsToPush.map((md) => ({
          id: md.id,
          event_id: md.event_id,
          user_id: md.user_id,
          food_name: md.food_name,
          amount: Number(md.amount ?? 1),
          unit: md.unit || '人前',
          carbs: Number(md.carbs ?? 0),
          is_deleted: Boolean(md.is_deleted),
          updated_at: md.updated_at || md.created_at,
          created_at: md.created_at,
        })),
        'id'
      );
    }

    // =========================================================================
    // 7. libre_readings (PK: id, UNIQUE(user_id, timestamp), 1,000件チャンク & 時刻正規化)
    // =========================================================================
    const localReadings = await db.libre_readings
      .where('user_id')
      .equals(patientId)
      .toArray();
    const localSignature = `${localReadings.length}:${localReadings[0]?.timestamp ?? ''}:${localReadings[localReadings.length - 1]?.timestamp ?? ''}`;
    const shouldSyncReadings =
      options.includeReadings === true ||
      syncedReadingsSignatureByPatient.get(patientId) !== localSignature;

    if (shouldSyncReadings) {
      const remoteReadingsRaw = await fetchAllPatientRowsFromTable<Record<string, any>>(
        client,
        'libre_readings',
        patientId,
        'timestamp'
      );
      const remoteReadings: LibreReading[] = remoteReadingsRaw.map((r) => {
        const normTs = normalizeToWallClockIso(r.timestamp);
        return {
          id: String(r.id || deterministicUuid(`${patientId}_${normTs}`)),
          user_id: String(r.user_id),
          timestamp: normTs,
          glucose_value: Number(r.glucose_value),
          scan_type: r.scan_type === 'Scan' ? 'Scan' : 'Historic',
          created_at: String(r.created_at || normTs),
        };
      });

      const remoteByTs = new Map(remoteReadings.map((r) => [r.timestamp, r]));
      const localByTs = new Map<string, LibreReading>();
      for (const lr of localReadings) {
        localByTs.set(normalizeToWallClockIso(lr.timestamp), lr);
      }

      const readingsToPush: LibreReading[] = [];
      const readingsToPull: LibreReading[] = [];

      for (const [normTs, lr] of localByTs.entries()) {
        if (!remoteByTs.has(normTs) && canEdit) {
          readingsToPush.push({
            id: ensureUuid(lr.id, `${patientId}_${normTs}`),
            user_id: patientId,
            timestamp: normTs,
            glucose_value: Number(lr.glucose_value),
            scan_type: lr.scan_type === 'Scan' ? 'Scan' : 'Historic',
            created_at: lr.created_at || normTs,
          });
        }
      }

      for (const [normTs, rr] of remoteByTs.entries()) {
        if (!localByTs.has(normTs)) {
          readingsToPull.push(rr);
        }
      }

      if (readingsToPull.length > 0) {
        await db.libre_readings.bulkPut(readingsToPull);
        pulledCount += readingsToPull.length;
      }

      if (canEdit && readingsToPush.length > 0) {
        pushedCount += await upsertRowsInChunks(
          client,
          'libre_readings',
          readingsToPush.map((r) => ({
            id: r.id,
            user_id: r.user_id,
            timestamp: r.timestamp,
            glucose_value: r.glucose_value,
            scan_type: r.scan_type,
            created_at: r.created_at,
          })),
          'user_id,timestamp'
        );
      }

      const finalCount = localByTs.size + readingsToPull.length;
      const allTimestamps = [
        ...Array.from(localByTs.keys()),
        ...readingsToPull.map((r) => r.timestamp),
      ].sort();
      syncedReadingsSignatureByPatient.set(
        patientId,
        `${finalCount}:${allTimestamps[0] ?? ''}:${allTimestamps[allTimestamps.length - 1] ?? ''}`
      );
    }

    // リモートから新しい閾値がPullされた場合、ローカルの異常値イベントも最新閾値に合わせて再計算する
    if (thresholdChangedFromRemote && remoteSettings) {
      await reevaluatePatientAnomalyEvents(
        patientId,
        remoteSettings.hypo_threshold,
        remoteSettings.hyper_threshold
      );
    }

    // 全4種インメモリキャッシュを破棄し、UIへ最新状態を即時反映させる
    invalidateAllCachesAfterSync(patientId);

    const syncedAt = new Date().toISOString();
    dispatchCloudSyncUpdatedEvent(patientId, syncedAt);

    return {
      status: 'success',
      syncedAt,
      pushedCount,
      pulledCount,
    };
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : 'クラウド同期中にエラーが発生しました。';
    console.warn('Cloud sync error:', errorMessage);
    return {
      status: 'error',
      pushedCount,
      pulledCount,
      errorMessage,
    };
  }
}

/**
 * クラウド同期完了を画面コンポーネントへ通知するカスタムイベントを発火
 */
export function dispatchCloudSyncUpdatedEvent(
  patientId: string,
  syncedAt: string
): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('cgm-cloud-sync-updated', {
        detail: { patientId, syncedAt },
      })
    );
  }
}

/**
 * 記録の保存・削除・CSV取込・設定変更時に非同期でクラウド同期をトリガーするヘルパー
 */
export function triggerBackgroundCloudSync(
  patientId: string,
  options: SyncOptions = {}
): void {
  if (!patientId || patientId === DEFAULT_LOCAL_PATIENT_ID) return;
  const client = options.clientOverride ?? getSupabaseClient();
  if (!client) return;

  void syncPatientDataWithCloud(patientId, options);
}

/**
 * 患者本人が全データ初期化を実行した際、Supabase 側の当該患者データも削除し、設定を初期値へ戻す
 */
export async function clearRemotePatientData(
  patientId: string,
  clientOverride?: SupabaseClient | null
): Promise<void> {
  const client =
    clientOverride !== undefined ? clientOverride : getSupabaseClient();
  if (!client || !patientId || patientId === DEFAULT_LOCAL_PATIENT_ID) return;

  resetSyncSignaturesForPatient(patientId);

  const tablesInDeleteOrder = [
    'meal_details',
    'events',
    'libre_readings',
    'food_master',
    'event_master',
    'categories',
  ];

  for (const table of tablesInDeleteOrder) {
    await client.from(table).delete().eq('user_id', patientId);
  }

  // user_settings はオーナー認可フラグ維持のため標準値（70/180）で upsert し、upsert 未定義モック時は delete にフォールバック
  const settingsTable = client.from('user_settings') as unknown as {
    upsert?: (
      rows: Array<Record<string, unknown>>,
      opts: { onConflict: string }
    ) => Promise<unknown>;
    delete?: () => { eq: (col: string, val: string) => Promise<unknown> };
  };
  if (typeof settingsTable.upsert === 'function') {
    await settingsTable.upsert(
      [
        {
          user_id: patientId,
          hypo_threshold: DEFAULT_HYPO_THRESHOLD,
          hyper_threshold: DEFAULT_HYPER_THRESHOLD,
          target_tir_min: DEFAULT_HYPO_THRESHOLD,
          target_tir_max: DEFAULT_HYPER_THRESHOLD,
          enable_default_insulin: false,
          default_insulin_breakfast: null,
          default_insulin_lunch: null,
          default_insulin_dinner: null,
          default_insulin_snack: null,
          updated_at: new Date().toISOString(),
        },
      ],
      { onConflict: 'user_id' }
    );
  } else if (typeof settingsTable.delete === 'function') {
    await settingsTable.delete().eq('user_id', patientId);
  }
}

/**
 * Supabase Realtime による対象患者テーブルの変更監視サブスクリプションを開始する
 */
export function subscribeToPatientRealtime(
  patientId: string,
  canEdit: boolean,
  onSynced?: (result: SyncResult) => void
): () => void {
  const client = getSupabaseClient();
  if (!client || !patientId || patientId === DEFAULT_LOCAL_PATIENT_ID) {
    return () => undefined;
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const schedulePull = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(async () => {
      const res = await syncPatientDataWithCloud(patientId, {
        canEdit,
        includeReadings: true,
      });
      if (onSynced) {
        onSynced(res);
      }
    }, 600);
  };

  const channel = client
    .channel(`patient-sync-${patientId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'events',
        filter: `user_id=eq.${patientId}`,
      },
      schedulePull
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'meal_details',
        filter: `user_id=eq.${patientId}`,
      },
      schedulePull
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'user_settings',
        filter: `user_id=eq.${patientId}`,
      },
      schedulePull
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'food_master',
        filter: `user_id=eq.${patientId}`,
      },
      schedulePull
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'event_master',
        filter: `user_id=eq.${patientId}`,
      },
      schedulePull
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'categories',
        filter: `user_id=eq.${patientId}`,
      },
      schedulePull
    )
    .subscribe();

  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    void client.removeChannel(channel);
  };
}
