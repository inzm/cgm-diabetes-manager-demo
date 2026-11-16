import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isPortfolioMode } from './realGlucoseLoader';

/**
 * E2Eテストで本番認証ゲート（AuthGateScreen）の動作を強制有効化するためのウィンドウフラグ判定
 */
export function isCloudAuthForcedForE2E(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const win = window as Window & {
    __CGM_E2E_ENABLE_CLOUD_AUTH__?: boolean;
  };
  return Boolean(win.__CGM_E2E_ENABLE_CLOUD_AUTH__);
}

/**
 * E2Eテストやユニットテストでローカル単体動作へ強制フォールバックさせるためのウィンドウフラグ判定
 */
function isLocalOnlyForced(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  if (isCloudAuthForcedForE2E()) {
    return false;
  }
  const win = window as Window & {
    __CGM_E2E_FORCE_LOCAL_ONLY__?: boolean;
    __CGM_E2E_ALLOW_CSV_IMPORT__?: boolean;
    __CGM_E2E_SUPPRESS_WELCOME__?: boolean;
  };
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
 * - E2E クラウド認証検証フラグ（__CGM_E2E_ENABLE_CLOUD_AUTH__）が立っている場合は true
 * - portfolio モードでは常に false（ローカル単体動作）
 * - Vitest 単体テスト環境（MODE === 'test'）では testClientOverride 未設定時は false
 * - E2E ローカル強制フラグ（__CGM_E2E_FORCE_LOCAL_ONLY__ 等）が立っている場合は false
 * - VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY の両方が設定されている場合のみ true
 */
export function isSupabaseConfigured(): boolean {
  if (testClientOverride !== undefined) {
    return testClientOverride !== null;
  }
  if (isCloudAuthForcedForE2E()) {
    return true;
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
  if (!supabaseUrl || !supabaseAnonKey) {
    return null;
  }

  cachedClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  return cachedClient;
}

export interface PasswordStrengthResult {
  minLength: boolean;
  hasUpper: boolean;
  hasLower: boolean;
  hasDigit: boolean;
  hasSymbol: boolean;
  isValid: boolean;
  errorMessage?: string;
}

/**
 * 新規アカウント登録時のパスワード複雑性を検証する純粋関数（案B: 最高強度）
 * 必須要件:
 * - 8文字以上 (minLength)
 * - 英大文字 A-Z (hasUpper)
 * - 英小文字 a-z (hasLower)
 * - 数字 0-9 (hasDigit)
 * - 記号: 英数字・空白以外のASCII記号文字 (hasSymbol)
 */
export function validateStrongPassword(password: string): PasswordStrengthResult {
  const raw = typeof password === 'string' ? password : '';
  const minLength = raw.length >= 8;
  const hasUpper = /[A-Z]/.test(raw);
  const hasLower = /[a-z]/.test(raw);
  const hasDigit = /[0-9]/.test(raw);
  const hasSymbol = /[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]/.test(raw);
  const isValid = minLength && hasUpper && hasLower && hasDigit && hasSymbol;

  if (isValid) {
    return {
      minLength,
      hasUpper,
      hasLower,
      hasDigit,
      hasSymbol,
      isValid: true,
    };
  }

  const missing: string[] = [];
  if (!minLength) missing.push('8文字以上');
  if (!hasUpper) missing.push('英大文字(A-Z)');
  if (!hasLower) missing.push('英小文字(a-z)');
  if (!hasDigit) missing.push('数字(0-9)');
  if (!hasSymbol) missing.push('記号(!@#$%等)');

  return {
    minLength,
    hasUpper,
    hasLower,
    hasDigit,
    hasSymbol,
    isValid: false,
    errorMessage: `パスワードは8文字以上で、英大文字・英小文字・数字・記号の4種類すべてを含めてください（未達成: ${missing.join('、')}）。`,
  };
}

