import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  estimateCarbsWithGemini,
  estimateCarbsLocally,
  isGeminiBffEnabled,
  buildBffRequestHeaders,
} from '../gemini';
import { __setSupabaseClientForTest } from '../supabase';
import { escapeHtml } from '../utils';
import { onRequestPost, verifyBffRequestAuth } from '../../../functions/api/gemini';

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

    it('有効な Supabase JWT または同一 Origin が確認できた場合は認証を通過し、上流Gemini API応答を整形して返すこと', async () => {
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
      expect(estimateCarbsLocally('オレンジジュース(100%)', 1, '杯').carbs_g).toBe(21.0);
      expect(estimateCarbsLocally('オレンジジュース', 1, '杯').carbs_g).toBe(21.0);
      expect(estimateCarbsLocally('野菜・果実ミックスジュース', 1, '本').carbs_g).toBe(15.4);
      expect(estimateCarbsLocally('コーンスープ', 1, '杯').carbs_g).toBe(12.5);
      expect(estimateCarbsLocally('サバの味噌煮', 1, '切れ').carbs_g).toBe(11.2);
      expect(estimateCarbsLocally('豚肉の生姜焼き', 1, '人前').carbs_g).toBe(6.5);
      expect(estimateCarbsLocally('ロールパン(2個)', 2, '個(60g)').carbs_g).toBe(28.0);
      expect(estimateCarbsLocally('ロールパン', 1, '個').carbs_g).toBe(14.0);
      expect(estimateCarbsLocally('握り寿司', 5, '貫').carbs_g).toBe(39.0);
      expect(estimateCarbsLocally('焼き餃子', 3, '個').carbs_g).toBe(14.0);
      expect(estimateCarbsLocally('鶏の唐揚げ', 2, '個').carbs_g).toBe(4.4);
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
});
