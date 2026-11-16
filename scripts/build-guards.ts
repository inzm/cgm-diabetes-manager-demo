import crypto from 'crypto';

/**
 * 本番モード (VITE_APP_MODE=personal) かつ REQUIRE_SUPABASE_ENV=1 の場合、
 * VITE_SUPABASE_URL (https://...) と VITE_SUPABASE_ANON_KEY が両方設定されていなければ
 * Auth Gate 無効化デプロイを防止するためビルドを即座に中断する。
 */
export function validateProductionSupabaseEnv(
  mode: string,
  env: Record<string, string | undefined>,
  requireSupabaseEnv: boolean
): void {
  if (mode !== 'personal' || !requireSupabaseEnv) {
    return;
  }
  const supabaseUrl = (env.VITE_SUPABASE_URL ?? '').trim();
  const supabaseAnonKey = (env.VITE_SUPABASE_ANON_KEY ?? '').trim();

  if (!supabaseUrl || !/^https:\/\/[a-z0-9.-]+/i.test(supabaseUrl) || !supabaseAnonKey) {
    throw new Error(
      '[Production Build Blocked] REQUIRE_SUPABASE_ENV=1 requires valid VITE_SUPABASE_URL (https://...) and VITE_SUPABASE_ANON_KEY for personal production deployment so Auth Gate and Cloud Sync remain active.'
    );
  }
}

/**
 * dist/index.html の SHA-256 先頭8文字から Service Worker 用の決定論的 CACHE_NAME を生成する。
 */
export function computeServiceWorkerCacheName(
  indexHtmlContent: string,
  baseCacheName = 'cgm-manager-v2'
): string {
  const hash8 = crypto.createHash('sha256').update(indexHtmlContent, 'utf8').digest('hex').slice(0, 8);
  return `${baseCacheName}-${hash8}`;
}
