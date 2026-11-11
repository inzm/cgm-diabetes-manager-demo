import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from 'react';
import type { FamilyPermission, UserRole } from '@/types/database';
import { db } from '@/lib/db';
import { isPortfolioMode } from '@/lib/realGlucoseLoader';
import { seedFoodMasterIfEmpty } from '@/lib/foodSeed';
import { getSupabaseClient, isSupabaseConfigured } from '@/lib/supabase';
import {
  type AccessiblePatientTarget,
  type SyncResult,
  DEFAULT_LOCAL_PATIENT_ID,
  UNAUTHORIZED_ACCESS_ERROR_MESSAGE,
  migrateAnonymousLocalDataToUser,
  purgeAllLocalPatientCaches,
  resolveUserAccessFromPermissions,
  subscribeToPatientRealtime,
  syncPatientDataWithCloud,
  verifyUserAccessWithCloud,
} from '@/lib/syncEngine';

export interface AuthUserInfo {
  id: string;
  email?: string;
}

export interface PatientContextType {
  currentPatientId: string;
  currentRole: UserRole;
  isReadOnly: boolean;
  isSystemOwner: boolean;
  hypoThreshold: number;
  hyperThreshold: number;
  setRole: (role: UserRole) => void;
  updateClinicalThresholds: (hypo: number, hyper: number) => void;
  // Cloud Auth & Family Sharing & Sync
  isCloudEnabled: boolean;
  isAuthRequired: boolean;
  isAccessAuthorized: boolean;
  authUser: AuthUserInfo | null;
  isAuthLoading: boolean;
  isSyncing: boolean;
  lastSyncedAt: string | null;
  syncError: string | null;
  accessibleTargets: AccessiblePatientTarget[];
  myInvitedFollowers: FamilyPermission[];
  signInWithEmail: (
    email: string,
    password: string
  ) => Promise<{ error?: string }>;
  signUpWithEmail: (
    email: string,
    password: string
  ) => Promise<{ error?: string; needsEmailConfirmation?: boolean }>;
  signOut: () => Promise<void>;
  switchTargetPatient: (targetPatientId: string) => Promise<void>;
  syncNow: (options?: {
    replaceRemoteAnomalies?: boolean;
    includeReadings?: boolean;
  }) => Promise<SyncResult>;
  addFamilyMember: (
    email: string,
    role: 'viewer' | 'editor'
  ) => Promise<{ error?: string }>;
  removeFamilyMember: (permissionId: string) => Promise<{ error?: string }>;
  refreshFamilyPermissions: () => Promise<void>;
}

const PatientContext = createContext<PatientContextType | undefined>(undefined);

// Initial default patient ID (for local-first mode prior to Supabase Auth)
export const DEFAULT_PATIENT_ID = DEFAULT_LOCAL_PATIENT_ID;

export function PatientProvider({ children }: { children: React.ReactNode }) {
  const [currentPatientId, setCurrentPatientId] =
    useState<string>(DEFAULT_PATIENT_ID);
  const [currentRole, setCurrentRole] = useState<UserRole>('patient');
  const [hypoThreshold, setHypoThreshold] = useState<number>(70);
  const [hyperThreshold, setHyperThreshold] = useState<number>(180);

  const isCloudEnabled = isSupabaseConfigured();
  const isAuthRequired = isCloudEnabled && !isPortfolioMode();

  const [authUser, setAuthUser] = useState<AuthUserInfo | null>(null);
  const [isSystemOwner, setIsSystemOwner] = useState<boolean>(
    () => !isAuthRequired
  );
  const [isAccessAuthorized, setIsAccessAuthorized] = useState<boolean>(
    () => !isAuthRequired
  );
  const [isAuthLoading, setIsAuthLoading] = useState<boolean>(() =>
    isSupabaseConfigured()
  );
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [accessibleTargets, setAccessibleTargets] = useState<
    AccessiblePatientTarget[]
  >([]);
  const [myInvitedFollowers, setMyInvitedFollowers] = useState<
    FamilyPermission[]
  >([]);

  const preferredPatientIdRef = useRef<string | null>(null);
  const currentPatientIdRef = useRef<string>(DEFAULT_PATIENT_ID);
  currentPatientIdRef.current = currentPatientId;
  const rejectionErrorRef = useRef<string | null>(null);
  const inFlightSessionResolveRef = useRef<{
    key: string;
    promise: Promise<{ authorized: boolean; error?: string }>;
  } | null>(null);
  const isReadOnly = currentRole === 'viewer';

  const loadThresholdsFromLocalDb = useCallback(async (patientId: string) => {
    try {
      const settings = await db.user_settings.get(patientId);
      if (settings) {
        setHypoThreshold(settings.hypo_threshold || 70);
        setHyperThreshold(settings.hyper_threshold || 180);
      } else {
        setHypoThreshold(70);
        setHyperThreshold(180);
      }
    } catch {
      // Ignore
    }
  }, []);

  useEffect(() => {
    // ポートフォリオモードの初期起動時は常に 70 / 180 にリセットされるため、起動直後のIndexedDB競合アクセスを回避
    if (isPortfolioMode()) {
      setHypoThreshold(70);
      setHyperThreshold(180);
      return;
    }
    let active = true;
    db.user_settings
      .get(currentPatientId)
      .then((settings) => {
        if (!active) return;
        if (settings) {
          setHypoThreshold(settings.hypo_threshold || 70);
          setHyperThreshold(settings.hyper_threshold || 180);
        } else {
          setHypoThreshold(70);
          setHyperThreshold(180);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [currentPatientId]);

  /**
   * ログイン済みユーザーのアクセス権限検証（オーナー本人または招待済み家族のみ許可）・
   * ローカルデータ引き継ぎ・初回クラウド同期を実行（同一条件の並行呼び出しは直列共有）
   */
  const resolveSessionAndSync = useCallback(
    async (
      user: AuthUserInfo,
      overridePreferredPatientId?: string | null
    ): Promise<{ authorized: boolean; error?: string }> => {
      const client = getSupabaseClient();
      if (!client) {
        return { authorized: true };
      }

      const preferredKey =
        overridePreferredPatientId !== undefined
          ? (overridePreferredPatientId ?? '')
          : (preferredPatientIdRef.current ?? '');
      const dedupeKey = `${user.id}:${preferredKey}`;
      if (
        inFlightSessionResolveRef.current &&
        inFlightSessionResolveRef.current.key === dedupeKey
      ) {
        return inFlightSessionResolveRef.current.promise;
      }

      const task = (async (): Promise<{ authorized: boolean; error?: string }> => {
        setIsSyncing(true);
        setSyncError(null);
        rejectionErrorRef.current = null;

        try {
          // 1. family_permissions テーブルを照会
          const { data: rawPerms, error: permErr } = await client
            .from('family_permissions')
            .select('*')
            .order('created_at', { ascending: true });

          if (permErr) {
            console.warn('family_permissions query warning:', permErr.message);
          }

          const permissions: FamilyPermission[] = Array.isArray(rawPerms)
            ? (rawPerms as FamilyPermission[])
            : [];

          // 2. アクセス認可チェック（オーナー本人 または 招待済み家族であるか検証）
          const accessCheck = await verifyUserAccessWithCloud(
            client,
            user.id,
            user.email,
            permissions
          );

          if (!accessCheck.authorized) {
            const rejectMsg =
              accessCheck.errorMessage || UNAUTHORIZED_ACCESS_ERROR_MESSAGE;
            rejectionErrorRef.current = rejectMsg;
            await client.auth.signOut().catch(() => undefined);
            await purgeAllLocalPatientCaches(currentPatientIdRef.current);
            preferredPatientIdRef.current = null;
            setAuthUser(null);
            setIsSystemOwner(false);
            setIsAccessAuthorized(false);
            setAccessibleTargets([]);
            setMyInvitedFollowers([]);
            setCurrentPatientId(DEFAULT_PATIENT_ID);
            setCurrentRole('patient');
            setHypoThreshold(70);
            setHyperThreshold(180);
            setLastSyncedAt(null);
            setSyncError(rejectMsg);
            return { authorized: false, error: rejectMsg };
          }

          // 認可通過後に認証状態を確定
          setAuthUser(user);
          setIsSystemOwner(accessCheck.isOwner);
          setIsAccessAuthorized(true);

          // 3. オーナー本人の場合は、未ログイン時に記録されたローカルデータがあれば本人IDへ自動引き継ぎ
          if (accessCheck.isOwner) {
            await migrateAnonymousLocalDataToUser(user.id, DEFAULT_PATIENT_ID);
          }

          // 4. 初回家族ログイン時: family_user_id が未設定でメールアドレスが一致する招待レコードを更新
          const normalizedEmail = (user.email ?? '').trim().toLowerCase();
          const nowIso = new Date().toISOString();
          for (const perm of permissions) {
            if (
              perm.patient_id !== user.id &&
              !perm.family_user_id &&
              normalizedEmail &&
              perm.family_email &&
              perm.family_email.trim().toLowerCase() === normalizedEmail
            ) {
              try {
                await client
                  .from('family_permissions')
                  .update({
                    family_user_id: user.id,
                    accepted_at: nowIso,
                  })
                  .eq('id', perm.id);
                perm.family_user_id = user.id;
                perm.accepted_at = nowIso;
              } catch {
                // RLS等で更新不可の場合もメモリ上で紐づけを保持（RLS関数は family_email でも許可済み）
                perm.family_user_id = user.id;
                perm.accepted_at = nowIso;
              }
            }
          }

          const preferredId =
            overridePreferredPatientId !== undefined
              ? overridePreferredPatientId
              : preferredPatientIdRef.current;

          const resolved = resolveUserAccessFromPermissions(
            user.id,
            user.email,
            permissions,
            preferredId
          );

          // 招待された家族専用アカウント（非オーナー）の場合は、共有された患者レコードのみを選択対象とする
          const sharedOnlyTargets = resolved.accessibleTargets.filter(
            (t) => t.patientId !== user.id
          );
          const effectiveTargets =
            !accessCheck.isOwner && sharedOnlyTargets.length > 0
              ? sharedOnlyTargets
              : resolved.accessibleTargets;
          const effectiveSelected =
            effectiveTargets.find((t) => t.patientId === resolved.currentPatientId) ??
            effectiveTargets[0];

          preferredPatientIdRef.current = effectiveSelected.patientId;
          setAccessibleTargets(effectiveTargets);
          setMyInvitedFollowers(
            accessCheck.isOwner ? resolved.myInvitedFollowers : []
          );
          setCurrentPatientId(effectiveSelected.patientId);
          setCurrentRole(effectiveSelected.role);

          const canEditTarget = effectiveSelected.role !== 'viewer';

          // 本人または編集可能ロールの場合は初期シードを確保してから双方向同期
          if (canEditTarget) {
            await seedFoodMasterIfEmpty(effectiveSelected.patientId);
          }

          const syncRes = await syncPatientDataWithCloud(
            effectiveSelected.patientId,
            {
              canEdit: canEditTarget,
              includeReadings: true,
            }
          );

          if (!canEditTarget) {
            await seedFoodMasterIfEmpty(effectiveSelected.patientId);
          }

          if (syncRes.status === 'success' && syncRes.syncedAt) {
            setLastSyncedAt(syncRes.syncedAt);
            setSyncError(null);
          } else if (syncRes.status === 'error' && syncRes.errorMessage) {
            setSyncError(syncRes.errorMessage);
          }

          await loadThresholdsFromLocalDb(effectiveSelected.patientId);
          return { authorized: true };
        } catch (err) {
          const msg =
            err instanceof Error
              ? err.message
              : 'クラウド同期中にエラーが発生しました。';
          setSyncError(msg);
          return { authorized: true, error: msg };
        } finally {
          setIsSyncing(false);
        }
      })();

      inFlightSessionResolveRef.current = { key: dedupeKey, promise: task };
      try {
        return await task;
      } finally {
        if (inFlightSessionResolveRef.current?.promise === task) {
          inFlightSessionResolveRef.current = null;
        }
      }
    },
    [loadThresholdsFromLocalDb]
  );

  // Supabase Auth セッション監視
  useEffect(() => {
    const client = getSupabaseClient();
    if (!client) {
      setIsAuthLoading(false);
      return;
    }

    let mounted = true;

    client.auth
      .getSession()
      .then(async ({ data }) => {
        if (!mounted) return;
        const sessionUser = data.session?.user;
        if (sessionUser) {
          const info: AuthUserInfo = {
            id: sessionUser.id,
            email: sessionUser.email,
          };
          await resolveSessionAndSync(info);
        } else {
          setAuthUser(null);
          setIsSystemOwner(false);
          setIsAccessAuthorized(false);
        }
        if (mounted) setIsAuthLoading(false);
      })
      .catch(() => {
        if (mounted) {
          setAuthUser(null);
          setIsSystemOwner(false);
          setIsAccessAuthorized(false);
          setIsAuthLoading(false);
        }
      });

    const { data: sub } = client.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;
      const sessionUser = session?.user;
      if (sessionUser) {
        const info: AuthUserInfo = {
          id: sessionUser.id,
          email: sessionUser.email,
        };
        if (event === 'SIGNED_IN' || event === 'USER_UPDATED') {
          void resolveSessionAndSync(info);
        }
      } else if (event === 'SIGNED_OUT') {
        const prevPatientId = currentPatientIdRef.current;
        preferredPatientIdRef.current = null;
        setAuthUser(null);
        setIsSystemOwner(false);
        setIsAccessAuthorized(false);
        setAccessibleTargets([]);
        setMyInvitedFollowers([]);
        setCurrentPatientId(DEFAULT_PATIENT_ID);
        setCurrentRole('patient');
        setHypoThreshold(70);
        setHyperThreshold(180);
        setLastSyncedAt(null);
        if (!rejectionErrorRef.current) {
          setSyncError(null);
        }
        void purgeAllLocalPatientCaches(prevPatientId);
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [resolveSessionAndSync]);

  // Supabase Realtime 購読（ログイン中かつ対象患者確定時）
  useEffect(() => {
    if (
      !authUser ||
      !isAccessAuthorized ||
      !currentPatientId ||
      currentPatientId === DEFAULT_PATIENT_ID
    ) {
      return;
    }
    const canEdit = currentRole !== 'viewer';
    const unsubscribe = subscribeToPatientRealtime(
      currentPatientId,
      canEdit,
      (res) => {
        if (res.status === 'success' && res.syncedAt) {
          setLastSyncedAt(res.syncedAt);
          void loadThresholdsFromLocalDb(currentPatientId);
        }
      }
    );
    return unsubscribe;
  }, [
    authUser,
    isAccessAuthorized,
    currentPatientId,
    currentRole,
    loadThresholdsFromLocalDb,
  ]);

  // バックグラウンド同期イベント受信時にも最終同期時刻・設定閾値を反映
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleCloudSynced = (e: Event) => {
      const detail = (e as CustomEvent<{ patientId: string; syncedAt: string }>)
        .detail;
      if (detail?.syncedAt) {
        setLastSyncedAt(detail.syncedAt);
      }
      if (detail?.patientId && detail.patientId === currentPatientId) {
        void loadThresholdsFromLocalDb(currentPatientId);
      }
    };
    window.addEventListener('cgm-cloud-sync-updated', handleCloudSynced);
    return () => {
      window.removeEventListener('cgm-cloud-sync-updated', handleCloudSynced);
    };
  }, [currentPatientId, loadThresholdsFromLocalDb]);

  const setRole = useCallback(
    (role: UserRole) => {
      if (authUser) {
        const grantedTarget = accessibleTargets.find(
          (t) => t.patientId === currentPatientIdRef.current
        );
        if (
          (grantedTarget && grantedTarget.role === 'viewer' && role !== 'viewer') ||
          (!isSystemOwner && !grantedTarget && role !== 'viewer')
        ) {
          return;
        }
      }
      setCurrentRole(role);
    },
    [authUser, accessibleTargets, isSystemOwner]
  );

  const updateClinicalThresholds = useCallback(
    (hypo: number, hyper: number) => {
      setHypoThreshold(hypo);
      setHyperThreshold(hyper);
    },
    []
  );

  const signInWithEmail = useCallback(
    async (
      email: string,
      password: string
    ): Promise<{ error?: string }> => {
      const client = getSupabaseClient();
      if (!client) {
        return { error: 'クラウド接続設定が見つかりません。' };
      }
      const trimmedEmail = email.trim();
      if (!trimmedEmail || !password) {
        return { error: 'メールアドレスとパスワードを入力してください。' };
      }
      const { data, error } = await client.auth.signInWithPassword({
        email: trimmedEmail,
        password,
      });
      if (error) {
        return {
          error:
            error.message.includes('Invalid login credentials')
              ? 'メールアドレスまたはパスワードが正しくありません。'
              : `ログインに失敗しました: ${error.message}`,
        };
      }
      if (data.user) {
        const info: AuthUserInfo = {
          id: data.user.id,
          email: data.user.email,
        };
        const outcome = await resolveSessionAndSync(info);
        if (!outcome.authorized) {
          return {
            error: outcome.error || UNAUTHORIZED_ACCESS_ERROR_MESSAGE,
          };
        }
      }
      return {};
    },
    [resolveSessionAndSync]
  );

  const signUpWithEmail = useCallback(
    async (
      email: string,
      password: string
    ): Promise<{ error?: string; needsEmailConfirmation?: boolean }> => {
      const client = getSupabaseClient();
      if (!client) {
        return { error: 'クラウド接続設定が見つかりません。' };
      }
      const trimmedEmail = email.trim();
      if (!trimmedEmail || password.length < 6) {
        return {
          error:
            '有効なメールアドレスと6文字以上のパスワードを入力してください。',
        };
      }
      const { data, error } = await client.auth.signUp({
        email: trimmedEmail,
        password,
      });
      if (error) {
        if (
          error.message.includes('招待されていません') ||
          error.message.includes('Database error saving new user')
        ) {
          return { error: UNAUTHORIZED_ACCESS_ERROR_MESSAGE };
        }
        return { error: `アカウント登録に失敗しました: ${error.message}` };
      }
      if (data.session && data.user) {
        const info: AuthUserInfo = {
          id: data.user.id,
          email: data.user.email,
        };
        const outcome = await resolveSessionAndSync(info);
        if (!outcome.authorized) {
          return {
            error: outcome.error || UNAUTHORIZED_ACCESS_ERROR_MESSAGE,
          };
        }
        return { needsEmailConfirmation: false };
      }
      return { needsEmailConfirmation: true };
    },
    [resolveSessionAndSync]
  );

  const signOut = useCallback(async (): Promise<void> => {
    const prevPatientId = currentPatientIdRef.current;
    rejectionErrorRef.current = null;
    const client = getSupabaseClient();
    if (client) {
      await client.auth.signOut().catch(() => undefined);
    }
    await purgeAllLocalPatientCaches(prevPatientId);
    preferredPatientIdRef.current = null;
    setAuthUser(null);
    setIsAccessAuthorized(false);
    setIsSystemOwner(false);
    setAccessibleTargets([]);
    setMyInvitedFollowers([]);
    setCurrentPatientId(DEFAULT_PATIENT_ID);
    setCurrentRole('patient');
    setHypoThreshold(70);
    setHyperThreshold(180);
    setLastSyncedAt(null);
    setSyncError(null);
  }, []);

  const switchTargetPatient = useCallback(
    async (targetPatientId: string): Promise<void> => {
      if (!authUser) return;
      preferredPatientIdRef.current = targetPatientId;
      await resolveSessionAndSync(authUser, targetPatientId);
    },
    [authUser, resolveSessionAndSync]
  );

  const syncNow = useCallback(
    async (options?: {
      replaceRemoteAnomalies?: boolean;
      includeReadings?: boolean;
    }): Promise<SyncResult> => {
      if (!authUser || !currentPatientId || currentPatientId === DEFAULT_PATIENT_ID) {
        return { status: 'skipped', pushedCount: 0, pulledCount: 0 };
      }
      setIsSyncing(true);
      setSyncError(null);
      try {
        const res = await syncPatientDataWithCloud(currentPatientId, {
          canEdit: currentRole !== 'viewer',
          replaceRemoteAnomalies: options?.replaceRemoteAnomalies,
          includeReadings: options?.includeReadings ?? true,
        });
        if (res.status === 'success' && res.syncedAt) {
          setLastSyncedAt(res.syncedAt);
          setSyncError(null);
        } else if (res.status === 'error' && res.errorMessage) {
          setSyncError(res.errorMessage);
        }
        await loadThresholdsFromLocalDb(currentPatientId);
        return res;
      } finally {
        setIsSyncing(false);
      }
    },
    [authUser, currentPatientId, currentRole, loadThresholdsFromLocalDb]
  );

  const refreshFamilyPermissions = useCallback(async (): Promise<void> => {
    if (!authUser) return;
    await resolveSessionAndSync(authUser, preferredPatientIdRef.current);
  }, [authUser, resolveSessionAndSync]);

  const addFamilyMember = useCallback(
    async (
      email: string,
      role: 'viewer' | 'editor'
    ): Promise<{ error?: string }> => {
      const client = getSupabaseClient();
      if (!client || !authUser) {
        return {
          error: '家族を招待するには先にクラウドアカウントへログインしてください。',
        };
      }
      if (!isSystemOwner || isReadOnly) {
        return {
          error: '家族の招待・権限変更は患者ご本人のアカウントからのみ行えます。',
        };
      }
      const normalizedEmail = email.trim().toLowerCase();
      if (!normalizedEmail || !normalizedEmail.includes('@')) {
        return { error: '招待する家族の有効なメールアドレスを入力してください。' };
      }
      if (authUser.email && authUser.email.trim().toLowerCase() === normalizedEmail) {
        return { error: '自分自身のメールアドレスは招待できません。' };
      }

      const nowIso = new Date().toISOString();
      const existing = myInvitedFollowers.find(
        (p) => p.family_email?.trim().toLowerCase() === normalizedEmail
      );

      if (existing) {
        const { error: updErr } = await client
          .from('family_permissions')
          .update({ role })
          .eq('id', existing.id)
          .eq('patient_id', authUser.id);
        if (updErr) {
          return { error: `権限の更新に失敗しました: ${updErr.message}` };
        }
      } else {
        const { error: insErr } = await client.from('family_permissions').insert({
          id: crypto.randomUUID(),
          patient_id: authUser.id,
          family_email: normalizedEmail,
          role,
          invited_at: nowIso,
          created_at: nowIso,
        });
        if (insErr) {
          return { error: `家族の登録に失敗しました: ${insErr.message}` };
        }
      }

      await refreshFamilyPermissions();
      return {};
    },
    [authUser, isSystemOwner, isReadOnly, myInvitedFollowers, refreshFamilyPermissions]
  );

  const removeFamilyMember = useCallback(
    async (permissionId: string): Promise<{ error?: string }> => {
      const client = getSupabaseClient();
      if (!client || !authUser) {
        return { error: 'ログイン状態を確認してください。' };
      }
      if (!isSystemOwner || isReadOnly) {
        return {
          error: '家族の共有解除は患者ご本人のアカウントからのみ行えます。',
        };
      }
      const { error } = await client
        .from('family_permissions')
        .delete()
        .eq('id', permissionId)
        .eq('patient_id', authUser.id);

      if (error) {
        return { error: `共有設定の解除に失敗しました: ${error.message}` };
      }

      await refreshFamilyPermissions();
      return {};
    },
    [authUser, isSystemOwner, isReadOnly, refreshFamilyPermissions]
  );

  return (
    <PatientContext.Provider
      value={{
        currentPatientId,
        currentRole,
        isReadOnly,
        hypoThreshold,
        hyperThreshold,
        setRole,
        updateClinicalThresholds,
        isCloudEnabled,
        isAuthRequired,
        isAccessAuthorized,
        isSystemOwner,
        authUser,
        isAuthLoading,
        isSyncing,
        lastSyncedAt,
        syncError,
        accessibleTargets,
        myInvitedFollowers,
        signInWithEmail,
        signUpWithEmail,
        signOut,
        switchTargetPatient,
        syncNow,
        addFamilyMember,
        removeFamilyMember,
        refreshFamilyPermissions,
      }}
    >
      {children}
    </PatientContext.Provider>
  );
}

export function usePatient() {
  const context = useContext(PatientContext);
  if (!context) {
    throw new Error('usePatient must be used within a PatientProvider');
  }
  return context;
}
