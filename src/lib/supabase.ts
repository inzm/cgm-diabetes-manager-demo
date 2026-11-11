import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isPortfolioMode } from './realGlucoseLoader';

/**
 * E2Eテストやユニットテストでローカル単体動作へ強制フォールバックさせるためのウィンドウフラグ判定
 */
function isLocalOnlyForced(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const win = window as Window & {
    __CGM_E2E_FORCE_LOCAL_ONLY__?: boolean;
    __CGM_E2E_ALLOW_CSV_IMPORT__?: boolean;
    __CGM_E2E_SUPPRESS_WELCOME__?: boolean;
    __CGM_E2E_ENABLE_CLOUD_AUTH__?: boolean;
  };
  if (win.__CGM_E2E_ENABLE_CLOUD_AUTH__) {
    return false;
  }
  return Boolean(
    win.__CGM_E2E_FORCE_LOCAL_ONLY__ ||
      win.__CGM_E2E_ALLOW_CSV_IMPORT__ ||
      win.__CGM_E2E_SUPPRESS_WELCOME__
  );
}

let cachedClient: SupabaseClient | null | undefined = undefined;
let testClientOverride: SupabaseClient | null | undefined = undefined;

/**
 * 単体テスト用にモック SupabaseClient を注入・解除するヘルパー
 */
export function __setSupabaseClientForTest(client: SupabaseClient | null | undefined): void {
  testClientOverride = client;
}

/**
 * 現在の実行環境において Supabase クラウド連携が有効かどうかを判定する。
 * - portfolio モードでは常に false（ローカル単体動作）
 * - Vitest 単体テスト環境（MODE === 'test'）では testClientOverride 未設定時は false
 * - E2E ローカル強制フラグ（__CGM_E2E_FORCE_LOCAL_ONLY__ 等）が立っている場合は false
 * - VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY の両方が設定されている場合のみ true
 */
export function isSupabaseConfigured(): boolean {
  if (testClientOverride !== undefined) {
    return testClientOverride !== null;
  }
  if (isPortfolioMode()) {
    return false;
  }
  if (import.meta.env.MODE === 'test') {
    return false;
  }
  if (isLocalOnlyForced()) {
    return false;
  }

  const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL ?? '').trim();
  const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();

  return Boolean(supabaseUrl && supabaseAnonKey);
}

/**
 * Supabase クライアントインスタンスを取得する。
 * 未設定時や portfolio モード、E2E ローカルモード時は null を返す。
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (testClientOverride !== undefined) {
    return testClientOverride;
  }
  if (!isSupabaseConfigured()) {
    return null;
  }
  if (cachedClient !== undefined) {
    return cachedClient;
  }

  const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL ?? '').trim();
  const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();

  cachedClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  return cachedClient;
}

