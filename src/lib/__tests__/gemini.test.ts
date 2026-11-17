// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  estimateCarbsWithGemini,
  estimateCarbsLocally,
  isGeminiBffEnabled,
  buildBffRequestHeaders,
} from '../gemini';
import { __setSupabaseClientForTest } from '../supabase';
import { escapeHtml } from '../utils';
import {
  checkBffUserRateLimit,
  onRequestPost,
  resetBffRateLimitStoreForTest,
  verifyBffRequestAuth,
} from '../../../functions/api/gemini';
import {
  SOURCE_TO_SPEC_RULES,
  evaluateSpecFirstIdentExemption,
  extractAddedBacktickIdentifiersFromDiff,
  inspectMarkdownIntegrity,
  isPureSpecFirstCommit,
  stripJsCommentsPreservingStrings,
} from '../../../scripts/verify-docs-sync.mjs';
import { evaluatePreToolGuard } from '../../../.agents/hooks/pre-tool-guard.mjs';
import { didTranscriptLinesTouchWorkspace, isWatchedRepoPath } from '../../../.agents/hooks/stop-guard.mjs';
import { isVerifyStampReusable } from '../../../scripts/orchestrate-pipeline.mjs';
import {
  validateProductionSupabaseEnv,
  computeServiceWorkerCacheName,
} from '../../../scripts/build-guards';

function makeTestJwt(payload: Record<string, unknown>): string {
  const encode = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.dummy-sig`;
}

describe('gemini (方式1: BFFプロキシ連携 & 日本食品標準成分表内蔵辞書)', () => {
  afterEach(() => {
    __setSupabaseClientForTest(undefined);
    resetBffRateLimitStoreForTest();
    vi.restoreAllMocks();
  });

  it('デフォルト環境ではBFFフラグがfalseまたはbooleanであること', () => {
    expect(typeof isGeminiBffEnabled()).toBe('boolean');
  });

  describe('Cloudflare Pages Functions BFF 認証検証 (案2: 本番モード時の Supabase JWT または同一 Origin 検証)', () => {
    it('本番モードで JWT も同一 Origin ヘッダーも無い外部リクエストを HTTP 401 で遮断すること', async () => {
      const res = await onRequestPost({
        request: new Request('https://example.com/api/gemini', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ foodName: '白ごはん', amount: 1, unit: '杯' }),
        }),
        env: { GEMINI_API_KEY: 'dummy-key', APP_MODE: 'personal' },
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain('Unauthorized');
    });

    it('Cross-Origin (Origin不一致 / Sec-Fetch-Site: cross-site / Referer不一致) リクエストを HTTP 403 で即時遮断すること', async () => {
      const crossOriginRes = await onRequestPost({
        request: new Request('https://example.com/api/gemini', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://malicious.example.org',
          },
          body: JSON.stringify({ foodName: '白ごはん', amount: 1, unit: '杯' }),
        }),
        env: { GEMINI_API_KEY: 'dummy-key' },
      });
      expect(crossOriginRes.status).toBe(403);

      const crossSiteRes = await onRequestPost({
        request: new Request('https://example.com/api/gemini', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Sec-Fetch-Site': 'cross-site',
          },
          body: JSON.stringify({ foodName: '白ごはん', amount: 1, unit: '杯' }),
        }),
        env: { GEMINI_API_KEY: 'dummy-key' },
      });
      expect(crossSiteRes.status).toBe(403);

      const badRefererRes = await verifyBffRequestAuth({
        request: new Request('https://example.com/api/gemini', {
          method: 'POST',
          headers: {
            Referer: 'https://evil.example.org/page',
          },
        }),
        env: { GEMINI_API_KEY: 'dummy-key' },
      });
      expect(badRefererRes.authorized).toBe(false);
      expect(badRefererRes.status).toBe(403);
    });

    it('不正または期限切れの Supabase JWT が送信された場合は同一 Origin であっても HTTP 401 で拒否すること', async () => {
      const expiredToken = makeTestJwt({
        sub: '11111111-1111-4111-8111-111111111111',
        role: 'authenticated',
        exp: Math.floor(Date.now() / 1000) - 60,
      });

      const resExpired = await onRequestPost({
        request: new Request('https://example.com/api/gemini', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://example.com',
            Authorization: `Bearer ${expiredToken}`,
          },
          body: JSON.stringify({ foodName: '白ごはん', amount: 1, unit: '杯' }),
        }),
        env: { GEMINI_API_KEY: 'dummy-key' },
      });
      expect(resExpired.status).toBe(401);
    });

    it('SUPABASE_URL / SUPABASE_ANON_KEY 未設定時に同一 Origin ヘッダー無しで偽造 JWT のみを送った外部リクエストを HTTP 401 で遮断すること', async () => {
      const forgedToken = makeTestJwt({
        sub: 'attacker-user-id',
        role: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const resForged = await onRequestPost({
        request: new Request('https://example.com/api/gemini', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${forgedToken}`,
          },
          body: JSON.stringify({ foodName: '白ごはん', amount: 1, unit: '杯' }),
        }),
        env: { GEMINI_API_KEY: 'dummy-key', APP_MODE: 'personal' },
      });
      expect(resForged.status).toBe(401);
    });

    it('BFF が 401 (Origin/Referer/Sec-Fetch-Site 欠落・未ログイン) を返した場合、クライアント側で内蔵日本食品標準成分辞書へ安全にフォールバックすること', async () => {
      vi.stubEnv('VITE_ENABLE_GEMINI_BFF', 'true');
      try {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
        );
        const res = await estimateCarbsWithGemini('白ごはん', 1, '杯');
        expect(res.carbs_g).toBe(55.2);
        expect(res.confidence).toBe('high');
        expect(res.note).toContain('日本食品標準成分表');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('本番モードでは同一 Origin ヘッダーのみ（JWTなし）のリクエストも HTTP 401 で遮断すること', async () => {
      const resSameOriginNoJwt = await onRequestPost({
        request: new Request('https://example.com/api/gemini', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://example.com',
            Referer: 'https://example.com/foods',
            'Sec-Fetch-Site': 'same-origin',
          },
          body: JSON.stringify({ foodName: '白ごはん', amount: 1, unit: '杯' }),
        }),
        env: { GEMINI_API_KEY: 'dummy-key', APP_MODE: 'personal' },
      });
      expect(resSameOriginNoJwt.status).toBe(401);

      // SUPABASE_URL / SUPABASE_ANON_KEY 未設定時は同一 Origin + 形式上妥当な JWT でも署名未検証として 401 にすること
      const unverifiedToken = makeTestJwt({
        sub: '11111111-1111-4111-8111-111111111111',
        role: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const resUnverifiedSig = await onRequestPost({
        request: new Request('https://example.com/api/gemini', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://example.com',
            Authorization: `Bearer ${unverifiedToken}`,
          },
          body: JSON.stringify({ foodName: '白ごはん', amount: 1, unit: '杯' }),
        }),
        env: { GEMINI_API_KEY: 'dummy-key', APP_MODE: 'personal' },
      });
      expect(resUnverifiedSig.status).toBe(401);
    });

    it('GEMINI_API_KEY 未設定時であっても、不正・偽造 JWT や Cross-Origin リクエストは 503 ではなく最優先で 401 / 403 遮断され、認証通過後のみ 503 になること', async () => {
      const forgedToken = makeTestJwt({
        sub: '11111111-1111-4111-8111-111111111111',
        role: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ message: 'Invalid JWT signature' }), { status: 401 })
      );

      // 1. GEMINI_API_KEY 未設定 + 偽造 JWT -> 401 (503 ではない)
      const resForgedNoKey = await onRequestPost({
        request: new Request('https://example.com/api/gemini', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://example.com',
            Authorization: `Bearer ${forgedToken}`,
          },
          body: JSON.stringify({ foodName: '白ごはん', amount: 1, unit: '杯' }),
        }),
        env: {
          APP_MODE: 'personal',
          SUPABASE_URL: 'https://project.supabase.co',
          SUPABASE_ANON_KEY: 'anon-key',
        },
      });
      expect(resForgedNoKey.status).toBe(401);

      // 2. GEMINI_API_KEY 未設定 + Cross-Origin -> 403 (503 ではない)
      const resCrossNoKey = await onRequestPost({
        request: new Request('https://example.com/api/gemini', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://evil.example.org',
          },
          body: JSON.stringify({ foodName: '白ごはん', amount: 1, unit: '杯' }),
        }),
        env: { APP_MODE: 'personal' },
      });
      expect(resCrossNoKey.status).toBe(403);

      // 3. 検証済み JWT で認証・入力検証を通過した後に GEMINI_API_KEY 未設定なら 503 を返すこと
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ id: '11111111-1111-4111-8111-111111111111' }), {
          status: 200,
        })
      );
      const resAuthedNoKey = await onRequestPost({
        request: new Request('https://example.com/api/gemini', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://example.com',
            Authorization: `Bearer ${forgedToken}`,
          },
          body: JSON.stringify({ foodName: '白ごはん', amount: 1, unit: '杯' }),
        }),
        env: {
          APP_MODE: 'personal',
          SUPABASE_URL: 'https://project.supabase.co',
          SUPABASE_ANON_KEY: 'anon-key',
        },
      });
      expect(resAuthedNoKey.status).toBe(503);
    });

    it('同一ユーザーがレート制限上限 (BFF_RATE_LIMIT_MAX) を超えて呼び出すと HTTP 429 (Retry-After付き) になり、別ユーザーやウィンドウ経過後は通過すること', async () => {
      // 1. 純粋スライディングウィンドウ関数の境界検証
      const baseNow = 1_700_000_000_000;
      const limitEnv = { BFF_RATE_LIMIT_MAX: '2', BFF_RATE_LIMIT_WINDOW_SEC: '30' };
      expect(checkBffUserRateLimit('user:u1', limitEnv, baseNow)).toMatchObject({
        allowed: true,
        remaining: 1,
      });
      expect(checkBffUserRateLimit('user:u1', limitEnv, baseNow + 5_000)).toMatchObject({
        allowed: true,
        remaining: 0,
      });
      const blocked = checkBffUserRateLimit('user:u1', limitEnv, baseNow + 10_000);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterSec).toBe(20);

      // 別ユーザーは影響を受けないこと
      expect(checkBffUserRateLimit('user:u2', limitEnv, baseNow + 10_000).allowed).toBe(true);
      // 30秒経過後は最初の1件がウィンドウから外れて再び通過すること
      expect(checkBffUserRateLimit('user:u1', limitEnv, baseNow + 30_001).allowed).toBe(true);

      resetBffRateLimitStoreForTest();

      // 2. onRequestPost 統合検証 (上限2回で3回目が 429 になること)
      const userAToken = makeTestJwt({
        sub: 'aaaa1111-1111-4111-8111-111111111111',
        role: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.includes('/auth/v1/user')) {
          return new Response(
            JSON.stringify({ id: 'aaaa1111-1111-4111-8111-111111111111' }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        carbs_g: 55.2,
                        confidence: 'high',
                        note: 'AI推定',
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );
      });

      const makeReq = () =>
        onRequestPost({
          request: new Request('https://example.com/api/gemini', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: 'https://example.com',
              Authorization: `Bearer ${userAToken}`,
            },
            body: JSON.stringify({ foodName: '白ごはん', amount: 1, unit: '杯' }),
          }),
          env: {
            GEMINI_API_KEY: 'dummy-key',
            SUPABASE_URL: 'https://project.supabase.co',
            SUPABASE_ANON_KEY: 'anon-key',
            BFF_RATE_LIMIT_MAX: '2',
            BFF_RATE_LIMIT_WINDOW_SEC: '60',
          },
        });

      expect((await makeReq()).status).toBe(200);
      expect((await makeReq()).status).toBe(200);
      const thirdRes = await makeReq();
      expect(thirdRes.status).toBe(429);
      expect(Number(thirdRes.headers.get('Retry-After'))).toBeGreaterThan(0);

      // クライアント側でも 429 受信時に内蔵日本食品標準成分辞書へ安全にフォールバックすること
      vi.stubEnv('VITE_ENABLE_GEMINI_BFF', 'true');
      try {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(JSON.stringify({ error: 'Too Many Requests' }), { status: 429 })
        );
        const fallback = await estimateCarbsWithGemini('白ごはん', 1, '杯');
        expect(fallback.carbs_g).toBe(55.2);
        expect(fallback.note).toContain('日本食品標準成分表');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('検証済みの有効な Supabase JWT が確認できた場合は認証を通過し、上流Gemini API応答を整形して返すこと', async () => {
      const validToken = makeTestJwt({
        sub: '11111111-1111-4111-8111-111111111111',
        role: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/auth/v1/user')) {
          return new Response(JSON.stringify({ id: '11111111-1111-4111-8111-111111111111' }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        carbs_g: 55.24,
                        confidence: 'high',
                        note: 'AI推定: 精白米ご飯1杯',
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );
      });

      const resJwt = await onRequestPost({
        request: new Request('https://example.com/api/gemini', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${validToken}`,
          },
          body: JSON.stringify({ foodName: '白ごはん', amount: 1, unit: '杯' }),
        }),
        env: {
          GEMINI_API_KEY: 'dummy-key',
          SUPABASE_URL: 'https://project.supabase.co',
          SUPABASE_ANON_KEY: 'anon-key',
        },
      });
      expect(resJwt.status).toBe(200);
      const data = await resJwt.json();
      expect(data).toEqual({
        carbs_g: 55.2,
        confidence: 'high',
        note: 'AI推定: 精白米ご飯1杯',
      });
    });

    it('buildBffRequestHeaders が Supabase セッション存在時に Authorization: Bearer ヘッダーを自動付与すること', async () => {
      __setSupabaseClientForTest({
        auth: {
          getSession: async () => ({
            data: { session: { access_token: 'supabase-jwt-token-xyz' } },
          }),
        },
      } as unknown as Parameters<typeof __setSupabaseClientForTest>[0]);

      const headers = await buildBffRequestHeaders();
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Authorization']).toBe('Bearer supabase-jwt-token-xyz');
    });
  });

  describe('estimateCarbsWithGemini / estimateCarbsLocally (標準食品辞書推定)', () => {
    it('白ごはん1杯に対して55.2gを推定すること', async () => {
      const res = await estimateCarbsWithGemini('白ごはん', 1, '杯');
      expect(res.carbs_g).toBe(55.2);
      expect(res.confidence).toBe('high');
      expect(res.note).toContain('精白米ご飯');
    });

    it('食パン1枚に対して26.6gを推定すること', async () => {
      const res = await estimateCarbsWithGemini('食パン', 1, '枚');
      expect(res.carbs_g).toBe(26.6);
      expect(res.note).toContain('食パン');
    });

    it('カレーライス1人前に対して85.0gを推定すること', () => {
      const res = estimateCarbsLocally('カレーライス', 1, '人前');
      expect(res.carbs_g).toBe(85.0);
    });

    it('豚汁1杯に対して4.5gを推定すること', () => {
      const res = estimateCarbsLocally('豚汁', 1, '杯');
      expect(res.carbs_g).toBe(4.5);
    });

    it('鶏むね肉などの低糖質食品に対して0.5gを推定すること', async () => {
      const res = await estimateCarbsWithGemini('鶏むね肉', 1, '枚');
      expect(res.carbs_g).toBe(0.5);
      expect(res.note).toContain('精肉');
    });

    it('未知の食品に対してデフォルト値15gを安全に返すこと', async () => {
      const res = await estimateCarbsWithGemini('不思議な未知の料理', 1, '個');
      expect(res.carbs_g).toBe(15);
      expect(res.confidence).toBe('medium');
    });

    it('「焼きそば」が「そば(48.0g)」に吸われず中華麺(65.0g)として推定されること', () => {
      const yakisoba = estimateCarbsLocally('焼きそば', 1, '人前');
      expect(yakisoba.carbs_g).toBe(65.0);
      expect(yakisoba.note).toContain('焼きそば');

      const soba = estimateCarbsLocally('ざるそば', 1, '人前');
      expect(soba.carbs_g).toBe(48.0);
    });

    it('部分一致の優先順位バグ（肉まん・豚まん・水ようかん・水飴・カレーパン・いちご大福・アイスコーヒー・お茶漬け・サンド・バーガー・パイナップル）が解消されていること', () => {
      expect(estimateCarbsLocally('肉まん', 1, '個').carbs_g).toBe(35.0);
      expect(estimateCarbsLocally('豚まん', 1, '個').carbs_g).toBe(35.0);
      expect(estimateCarbsLocally('水ようかん', 1, '個').carbs_g).toBe(35.0);
      expect(estimateCarbsLocally('水飴', 1, '大さじ').carbs_g).toBe(17.0);
      expect(estimateCarbsLocally('カレーパン', 1, '個').carbs_g).toBe(26.6);
      expect(estimateCarbsLocally('いちご大福', 1, '個').carbs_g).toBe(35.0);
      expect(estimateCarbsLocally('水', 1, '杯').carbs_g).toBe(0.0);
      expect(estimateCarbsLocally('アイスコーヒー', 1, '杯').carbs_g).toBe(0.0);
      expect(estimateCarbsLocally('アイスティー', 1, '杯').carbs_g).toBe(0.0);
      expect(estimateCarbsLocally('アイス緑茶', 1, '杯').carbs_g).toBe(0.0);
      expect(estimateCarbsLocally('お茶漬け', 1, '杯').carbs_g).toBe(55.2);
      expect(estimateCarbsLocally('鮭茶漬け', 1, '杯').carbs_g).toBe(55.2);
      expect(estimateCarbsLocally('たまごサンド', 1, '人前').carbs_g).toBe(26.6);
      expect(estimateCarbsLocally('ハムサンド', 1, '人前').carbs_g).toBe(26.6);
      expect(estimateCarbsLocally('チーズバーガー', 1, '個').carbs_g).toBe(26.6);
      expect(estimateCarbsLocally('パイナップル', 1, '皿').carbs_g).toBe(11.0);
      expect(estimateCarbsLocally('フライドポテト', 1, '人前').carbs_g).toBe(22.0);
    });

    it('INITIAL_FOODS（初期登録食品）と一致する料理がマスタ定義値・単位通りに推定されること', () => {
      expect(estimateCarbsLocally('天ぷらうどん', 1, '人前').carbs_g).toBe(58.0);
      expect(estimateCarbsLocally('おろしそば', 1, '人前').carbs_g).toBe(48.0);
      expect(estimateCarbsLocally('豚の生姜焼き', 1, '人前').carbs_g).toBe(6.5);
      expect(estimateCarbsLocally('ロールパン', 2, '個').carbs_g).toBe(28.0);
      expect(estimateCarbsLocally('ロールパン', 1, '個').carbs_g).toBe(14.0);
      expect(estimateCarbsLocally('焼き餃子', 1, '人前').carbs_g).toBe(28.0);
      expect(estimateCarbsLocally('鶏の唐揚げ', 1, '人前').carbs_g).toBe(8.8);
      expect(estimateCarbsLocally('カフェラテ', 1, '杯').carbs_g).toBe(6.8);
    });
  });

  describe('escapeHtml (ECharts tooltip XSSサニタイズ)', () => {
    it('HTML特殊文字（&, <, >, ", \'）を完全にエスケープすること', () => {
      const malicious = `<img src=x onerror="alert('XSS')">&`;
      const escaped = escapeHtml(malicious);
      expect(escaped).toBe('&lt;img src=x onerror=&quot;alert(&#39;XSS&#39;)&quot;&gt;&amp;');
      expect(escaped).not.toContain('<');
      expect(escaped).not.toContain('>');
    });

    it('nullやundefinedに対して空文字を返すこと', () => {
      expect(escapeHtml(null)).toBe('');
      expect(escapeHtml(undefined)).toBe('');
    });
  });

  describe('本番デプロイ環境変数ガード & Service Worker リビジョンスタンプ (CI/CD 安全性)', () => {
    it('REQUIRE_SUPABASE_ENV=1 かつ personal モードで Supabase 設定が欠落している場合はビルドを即座に中断すること', () => {
      expect(() => validateProductionSupabaseEnv('personal', {}, true)).toThrow(
        /\[Production Build Blocked\]/
      );
      expect(() =>
        validateProductionSupabaseEnv(
          'personal',
          { VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_ANON_KEY: '   ' },
          true
        )
      ).toThrow(/\[Production Build Blocked\]/);
    });

    it('VITE_SUPABASE_URL が https:// 以外の場合はビルドを中断すること', () => {
      expect(() =>
        validateProductionSupabaseEnv(
          'personal',
          { VITE_SUPABASE_URL: 'http://insecure.example.com', VITE_SUPABASE_ANON_KEY: 'anon-key' },
          true
        )
      ).toThrow(/\[Production Build Blocked\]/);
    });

    it('personal モードで有効な Supabase 設定がある場合は例外を投げないこと', () => {
      expect(() =>
        validateProductionSupabaseEnv(
          'personal',
          { VITE_SUPABASE_URL: 'https://project.supabase.co', VITE_SUPABASE_ANON_KEY: 'anon-key' },
          true
        )
      ).not.toThrow();
    });

    it('portfolio モード、または REQUIRE_SUPABASE_ENV 無効時は Supabase 未設定でもビルドを許可すること', () => {
      expect(() => validateProductionSupabaseEnv('portfolio', {}, true)).not.toThrow();
      expect(() => validateProductionSupabaseEnv('personal', {}, false)).not.toThrow();
    });

    it('dist/index.html の内容ハッシュから決定論的な Service Worker CACHE_NAME を生成すること', () => {
      const htmlV1 = '<!doctype html><html><body><script src="/assets/index-aaa111.js"></script></body></html>';
      const htmlV2 = '<!doctype html><html><body><script src="/assets/index-bbb222.js"></script></body></html>';

      const cacheV1A = computeServiceWorkerCacheName(htmlV1);
      const cacheV1B = computeServiceWorkerCacheName(htmlV1);
      const cacheV2 = computeServiceWorkerCacheName(htmlV2);

      expect(cacheV1A).toMatch(/^cgm-manager-v2-[0-9a-f]{8}$/);
      expect(cacheV1A).toBe(cacheV1B);
      expect(cacheV2).toMatch(/^cgm-manager-v2-[0-9a-f]{8}$/);
      expect(cacheV2).not.toBe(cacheV1A);
    });
  });

  describe('DDD 2段階記録 (Spec-First) 同期検証ゲート純粋ロジック (scripts/verify-docs-sync.mjs)', () => {
    it('isPureSpecFirstCommit が純粋な docs(spec): コミットのみを許可し、コード混在や他プレフィックスを拒否すること', () => {
      expect(
        isPureSpecFirstCommit('docs(spec): update BFF rate limit specification', [
          'docs/Web_Project/ARCHITECTURE.md',
          'docs/Web_Project/SPEC_SETTINGS.md',
        ])
      ).toBe(true);

      // src/ や functions/ が混在している場合は純粋 Spec-First とはみなさない
      expect(
        isPureSpecFirstCommit('docs(spec): mixed commit', [
          'docs/Web_Project/ARCHITECTURE.md',
          'src/App.tsx',
        ])
      ).toBe(false);
      expect(
        isPureSpecFirstCommit('docs(spec): mixed bff', [
          'docs/Web_Project/ARCHITECTURE.md',
          'functions/api/gemini.ts',
        ])
      ).toBe(false);

      // feat: や空ファイル配列は拒否
      expect(
        isPureSpecFirstCommit('feat(personal): implement feature', [
          'docs/Web_Project/ARCHITECTURE.md',
        ])
      ).toBe(false);
      expect(isPureSpecFirstCommit('docs(spec): empty', [])).toBe(false);
    });

    it('extractAddedBacktickIdentifiersFromDiff が追加行(+)の識別子のみを抽出し、削除行(-)やファイルパスを除外すること', () => {
      const sampleDiff = [
        '+++ b/docs/Web_Project/ARCHITECTURE.md',
        '-旧識別子 `legacyRemovedFunc()` を削除',
        '+新設関数 `verifyNewSpecFirstGate()` および `BFF_RATE_LIMIT_MAX`、`src/lib/syncEngine.ts` を定義',
      ].join('\n');

      const extracted = extractAddedBacktickIdentifiersFromDiff(sampleDiff);
      expect(extracted.has('verifyNewSpecFirstGate')).toBe(true);
      expect(extracted.has('BFF_RATE_LIMIT_MAX')).toBe(true);
      expect(extracted.has('legacyRemovedFunc')).toBe(false);
      expect(extracted.has('syncEngine.ts')).toBe(false);
    });

    it('inspectMarkdownIntegrity が $1 破損・U+FFFD 文字化け・孤立テーブル行・未完了ステータスタグ・内部Issue参照を確実に検出すること', () => {
      expect(
        inspectMarkdownIntegrity(
          'docs/Web_Project/ARCHITECTURE.md',
          '# 正常見出し\n- 確定した仕様を断定形で記述する（課題 #7 対応）\n- `【未決事項】` や `Issue #XX` のインラインコード説明引用は除外\n\n| A | B |\n|---|---|\n| 1 | 2 |\n'
        )
      ).toEqual([]);

      // .agents/ 配下のルール文書では Issue 例示を許容すること
      expect(
        inspectMarkdownIntegrity(
          '.agents/AGENTS.md',
          '# ルール\n- 人の手が必要な項目は Issue #80 のように Private Issue で管理する\n'
        )
      ).toEqual([]);

      const corrupted = inspectMarkdownIntegrity(
        'docs/Web_Project/ARCHITECTURE.md',
        '# 異常サンプル\n$1\n文字化け\uFFFDテスト\n- 【未決事項】仕様の確認（Issue #82）\n- 【実装予定】バックアップ促進表示\n- オンライン復帰同期（#84）\n\n| 孤立した行 |\n'
      );
      expect(corrupted.some((e) => e.includes('[Doc Corruption Detected]'))).toBe(true);
      expect(corrupted.some((e) => e.includes('[Mojibake / Encoding Corruption Detected]'))).toBe(
        true
      );
      expect(
        corrupted.filter((e) => e.includes('[Prohibited Unresolved Spec Marker]')).length
      ).toBe(2);
      expect(
        corrupted.filter((e) => e.includes('[Private Issue Reference Prohibited]')).length
      ).toBe(2);
      expect(corrupted.some((e) => e.includes('[Orphaned Markdown Table Row]'))).toBe(true);
    });

    it('横断コアモジュール (AuthGateScreen, PatientContext, backupRestore, gemini, BFF) に requiredSpecs が設定されていること', () => {
      const mustHaveRequired = [
        'src/components/common/AuthGateScreen.tsx',
        'src/components/common/PasswordStrengthChecklist.tsx',
        'src/contexts/PatientContext.tsx',
        'src/lib/backupRestore.ts',
        'src/lib/gemini.ts',
        'functions/api/gemini.ts',
      ];

      for (const targetPrefix of mustHaveRequired) {
        const rule = SOURCE_TO_SPEC_RULES.find((r) => r.prefix === targetPrefix);
        expect(rule, `Rule missing for ${targetPrefix}`).toBeDefined();
        expect(Array.isArray(rule?.requiredSpecs) && rule!.requiredSpecs!.length > 0).toBe(true);
      }
    });

    it('stripJsCommentsPreservingStrings が https:// を含む文字列リテラルを壊さずコメントのみを除去すること', () => {
      const code = [
        `const api = 'https://example.com/api'; const jargon = "IndexedDB"; // マスタ コメント`,
        'const tpl = `https://foo.test/${1 + /* Dexie */ 2}`;',
      ].join('\n');
      const stripped = stripJsCommentsPreservingStrings(code);
      expect(stripped).toContain(`'https://example.com/api'`);
      expect(stripped).toContain(`"IndexedDB"`);
      expect(stripped).not.toContain('マスタ');
      expect(stripped).toContain('https://foo.test/');
      expect(stripped).not.toContain('Dexie');
    });

    it('evaluateSpecFirstIdentExemption が実装ファイル混在時に未実装識別子の猶予を確実に拒否すること', () => {
      expect(
        evaluateSpecFirstIdentExemption({
          forceStrictIdents: false,
          isStagedMode: false,
          activeFiles: ['docs/Web_Project/SPEC_CALENDAR.md'],
        })
      ).toEqual({ allowUncommittedDocDiff: true, allowPrecedingSpecCommits: true });

      expect(
        evaluateSpecFirstIdentExemption({
          forceStrictIdents: false,
          isStagedMode: false,
          activeFiles: ['src/App.tsx', 'docs/Web_Project/SPEC_CALENDAR.md'],
        })
      ).toEqual({ allowUncommittedDocDiff: false, allowPrecedingSpecCommits: false });

      expect(
        evaluateSpecFirstIdentExemption({
          forceStrictIdents: true,
          isStagedMode: false,
          activeFiles: ['docs/Web_Project/SPEC_CALENDAR.md'],
        })
      ).toEqual({ allowUncommittedDocDiff: false, allowPrecedingSpecCommits: false });
    });

    it('PreToolUse / Stop ライフサイクルフックと厳密 Verify Stamp がバイパス・誤判定を防止すること', () => {
      expect(
        evaluatePreToolGuard({
          tool_name: 'run_command',
          tool_input: { CommandLine: 'git commit --no-verify -m "bypass"' },
        }).decision
      ).toBe('deny');
      expect(
        evaluatePreToolGuard({
          tool_name: 'run_command',
          tool_input: { CommandLine: 'git push --force public-demo demo-public:main' },
        }).decision
      ).toBe('deny');
      expect(
        evaluatePreToolGuard({
          tool_name: 'edit_file',
          tool_input: { Path: 'c:\\repo\\legacy_vba\\Module1.bas' },
        }).decision
      ).toBe('deny');
      expect(
        evaluatePreToolGuard({
          tool_name: 'call_mcp_tool',
          tool_input: { ServerName: 'excel-manager', ToolName: 'run_macro' },
        }).decision
      ).toBe('deny');
      expect(
        evaluatePreToolGuard({
          tool_name: 'run_command',
          tool_input: { CommandLine: 'SKIP_DOC_SYNC=1 npm run test:docs' },
        }).decision
      ).toBe('force_ask');
      expect(
        evaluatePreToolGuard({
          tool_name: 'call_mcp_tool',
          tool_input: { ServerName: 'supabase_mcp', ToolName: 'apply_migration' },
        }).decision
      ).toBe('force_ask');
      expect(
        evaluatePreToolGuard({
          tool_name: 'call_mcp_tool',
          tool_input: {
            ServerName: 'supabase_mcp',
            ToolName: 'execute_sql',
            Arguments: { query: 'SELECT version FROM supabase_migrations.schema_migrations;' },
          },
        }).decision
      ).toBe('allow');

      // Subagent 会話（USER_EXPLICIT なし + 15回の read_file 押し出し）でも先行する edit_file を検知できること
      const subagentTranscript = [
        JSON.stringify({
          type: 'ASSISTANT',
          tool_calls: [{ name: 'edit_file', args: { Path: 'src/App.tsx' } }],
        }),
        ...Array.from({ length: 15 }, () =>
          JSON.stringify({
            type: 'ASSISTANT',
            tool_calls: [{ name: 'read_file', args: { Path: 'README.md' } }],
          })
        ),
      ];
      expect(didTranscriptLinesTouchWorkspace(subagentTranscript)).toBe(true);
      expect(isWatchedRepoPath('.env.personal')).toBe(true);
      expect(isWatchedRepoPath('wrangler.toml')).toBe(true);
      expect(isWatchedRepoPath('.agents/scratch/pipeline-last-run.json')).toBe(false);

      const fp = {
        worktreeTreeSha: 'aaa111',
        headSha: 'bbb222',
        targetEnv: 'personal',
        envHash: 'ccc333',
      };
      expect(
        isVerifyStampReusable(
          { ...fp, skipVisual: false, verifiedAtMs: 1_000_000 },
          fp,
          1_060_000
        )
      ).toBe(true);
      // 1文字でも worktreeTreeSha が変化、または期限切れの場合は再利用不可
      expect(
        isVerifyStampReusable(
          { ...fp, worktreeTreeSha: 'modified', skipVisual: false, verifiedAtMs: 1_000_000 },
          fp,
          1_060_000
        )
      ).toBe(false);
      expect(
        isVerifyStampReusable(
          { ...fp, skipVisual: false, verifiedAtMs: 1_000_000 },
          fp,
          2_500_000
        )
      ).toBe(false);
    });
  });
});
