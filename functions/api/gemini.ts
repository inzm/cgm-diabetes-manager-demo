/**
 * Cloudflare Pages Functions BFF: POST /api/gemini
 *
 * 【セキュリティ原則】
 * 1. Google Gemini APIキー (`GEMINI_API_KEY`) はクライアント（ブラウザ）には一切露出させず、
 *    Cloudflare Pages / Workers の環境変数（Secrets）からのみ読み出してサーバーサイドで推論を実行する。
 * 2. 本番モード時は不正な外部呼び出し（APIキータダ乗り・CSRF）を遮断するため、
 *    Cross-Origin / Cross-Site リクエストを即時拒否（HTTP 403）した上で、
 *    有効な Supabase JWT（`Authorization: Bearer <token>`）または同一 Origin（`Origin` / `Sec-Fetch-Site: same-origin` / `Referer`）の
 *    検証を必須化する（未充足時は HTTP 401）。
 * 3. `GEMINI_API_KEY` 未設定時やエラー発生時は非200応答を返し、クライアント側の
 *    日本食品標準成分表内蔵辞書（`estimateCarbsLocally`）へ安全にフォールバックさせる。
 */

export interface GeminiPagesEnv {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  APP_MODE?: string;
  VITE_APP_MODE?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  VITE_SUPABASE_ANON_KEY?: string;
  REQUIRE_SUPABASE_JWT?: string;
}

export interface PagesFunctionContext<Env = GeminiPagesEnv> {
  request: Request;
  env: Env;
}

interface CarbEstimateRequestBody {
  foodName?: string;
  amount?: number | string;
  unit?: string;
}

interface CarbEstimateResponseBody {
  carbs_g: number;
  confidence: 'high' | 'medium' | 'low';
  note: string;
}

export interface BffAuthVerificationResult {
  authorized: boolean;
  status: number;
  error?: string;
}

const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

function decodeBase64UrlJson(segment: string): Record<string, unknown> | null {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + '='.repeat(padLen);
    const decoded = atob(padded);
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function verifySupabaseBearerJwt(
  token: string,
  env?: GeminiPagesEnv
): Promise<{ valid: boolean; remoteVerified: boolean; reason?: string }> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { valid: false, remoteVerified: false, reason: 'Malformed JWT structure' };
  }

  const payload = decodeBase64UrlJson(parts[1]);
  if (!payload) {
    return { valid: false, remoteVerified: false, reason: 'Invalid JWT payload encoding' };
  }

  const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  const role = typeof payload.role === 'string' ? payload.role.trim() : '';
  if (!sub && role !== 'authenticated') {
    return { valid: false, remoteVerified: false, reason: 'Missing subject claim in JWT' };
  }

  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) {
    return {
      valid: false,
      remoteVerified: false,
      reason: 'JWT has expired or is missing exp claim',
    };
  }

  const supabaseUrl = (env?.SUPABASE_URL || env?.VITE_SUPABASE_URL || '').trim();
  const supabaseAnonKey = (env?.SUPABASE_ANON_KEY || env?.VITE_SUPABASE_ANON_KEY || '').trim();

  if (supabaseUrl && supabaseAnonKey) {
    try {
      const userEndpoint = `${supabaseUrl.replace(/\/$/, '')}/auth/v1/user`;
      const authRes = await fetch(userEndpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: supabaseAnonKey,
        },
      });
      if (!authRes.ok) {
        return {
          valid: false,
          remoteVerified: false,
          reason: `Supabase Auth rejected token (${authRes.status})`,
        };
      }
      return { valid: true, remoteVerified: true };
    } catch {
      return {
        valid: false,
        remoteVerified: false,
        reason: 'Failed to verify token with Supabase Auth',
      };
    }
  }

  // SUPABASE_URL / SUPABASE_ANON_KEY 未設定時はフォーマット・有効期限のみ通過とし、署名検証済み (remoteVerified) とはみなさない
  return { valid: true, remoteVerified: false };
}

/**
 * BFF リクエスト元の認証・同一 Origin 検証を実行する
 */
export async function verifyBffRequestAuth(
  context: PagesFunctionContext<GeminiPagesEnv>
): Promise<BffAuthVerificationResult> {
  let requestOrigin: string;
  try {
    requestOrigin = new URL(context.request.url).origin;
  } catch {
    return { authorized: false, status: 400, error: 'Invalid request URL' };
  }

  const originHeader = context.request.headers.get('Origin')?.trim() || '';
  const refererHeader = context.request.headers.get('Referer')?.trim() || '';
  const secFetchSite = context.request.headers.get('Sec-Fetch-Site')?.trim().toLowerCase() || '';

  // 1. Cross-Origin / Cross-Site リクエストの即時遮断 (403 Forbidden)
  if (secFetchSite === 'cross-site') {
    return {
      authorized: false,
      status: 403,
      error: 'Forbidden: Cross-site request is not allowed',
    };
  }

  if (originHeader && originHeader !== requestOrigin) {
    return {
      authorized: false,
      status: 403,
      error: 'Forbidden: Origin header does not match BFF origin',
    };
  }

  let isRefererSameOrigin = false;
  if (refererHeader) {
    try {
      const refererOrigin = new URL(refererHeader).origin;
      if (refererOrigin !== requestOrigin) {
        return {
          authorized: false,
          status: 403,
          error: 'Forbidden: Referer origin does not match BFF origin',
        };
      }
      isRefererSameOrigin = true;
    } catch {
      return {
        authorized: false,
        status: 403,
        error: 'Forbidden: Malformed Referer header',
      };
    }
  }

  const isSameOriginVerified =
    originHeader === requestOrigin || secFetchSite === 'same-origin' || isRefererSameOrigin;

  // 2. Authorization (Supabase JWT) ヘッダーの検証
  const authHeader = context.request.headers.get('Authorization')?.trim() || '';
  let hasValidJwt = false;

  if (authHeader) {
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      return {
        authorized: false,
        status: 401,
        error: 'Unauthorized: Bearer token scheme is required',
      };
    }
    const token = authHeader.slice(7).trim();
    const jwtCheck = await verifySupabaseBearerJwt(token, context.env);
    if (!jwtCheck.valid) {
      return {
        authorized: false,
        status: 401,
        error: `Unauthorized: ${jwtCheck.reason || 'Invalid token'}`,
      };
    }
    hasValidJwt = jwtCheck.remoteVerified;
  }

  if (context.env?.REQUIRE_SUPABASE_JWT === 'true' && !hasValidJwt) {
    return {
      authorized: false,
      status: 401,
      error: 'Unauthorized: Verified Supabase JWT Bearer token is required',
    };
  }

  // 3. 本番モード時は「Supabase Authで検証済みのJWT」または「同一 Origin 検証」のいずれかを必須化
  const isPortfolioMode =
    context.env?.APP_MODE === 'portfolio' || context.env?.VITE_APP_MODE === 'portfolio';

  if (!isPortfolioMode && !hasValidJwt && !isSameOriginVerified) {
    return {
      authorized: false,
      status: 401,
      error: 'Unauthorized: Supabase JWT or Same-Origin verification is required in production mode',
    };
  }

  return { authorized: true, status: 200 };
}

export async function onRequestPost(
  context: PagesFunctionContext<GeminiPagesEnv>
): Promise<Response> {
  const apiKey = context.env?.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: 'GEMINI_API_KEY is not configured; falling back to local dictionary.',
      }),
      { status: 503, headers: JSON_HEADERS }
    );
  }

  const authResult = await verifyBffRequestAuth(context);
  if (!authResult.authorized) {
    return new Response(
      JSON.stringify({
        error: authResult.error || 'Unauthorized BFF request',
      }),
      { status: authResult.status, headers: JSON_HEADERS }
    );
  }

  let body: CarbEstimateRequestBody;
  try {
    body = (await context.request.json()) as CarbEstimateRequestBody;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON request body' }), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }

  const foodName = String(body.foodName ?? '').trim();
  const amount = Number(body.amount) > 0 ? Number(body.amount) : 1;
  const unit = String(body.unit ?? '人前').trim() || '人前';

  if (!foodName || foodName.length > 100) {
    return new Response(JSON.stringify({ error: 'Invalid foodName parameter' }), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }

  if (unit.length > 20) {
    return new Response(JSON.stringify({ error: 'Invalid unit parameter' }), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }

  const model = context.env?.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const prompt = [
    'あなたは日本の糖尿病臨床栄養士AIです。日本食品標準成分表（八訂）に基づき、指定された食品の糖質量（利用可能炭水化物・g）を推定し、JSONオブジェクトのみを返してください。',
    `食品名: ${foodName}`,
    `分量: ${amount}`,
    `単位: ${unit}`,
    '出力JSONスキーマ: {"carbs_g": 数値(小数第1位まで), "confidence": "high" | "medium" | "low", "note": "算出根拠の簡潔な説明(40文字以内)"}',
  ].join('\n');

  try {
    const upstreamRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!upstreamRes.ok) {
      return new Response(
        JSON.stringify({ error: `Gemini upstream status ${upstreamRes.status}` }),
        { status: 502, headers: JSON_HEADERS }
      );
    }

    const upstreamData = (await upstreamRes.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };

    const rawText = upstreamData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!rawText) {
      return new Response(JSON.stringify({ error: 'Empty response from Gemini API' }), {
        status: 502,
        headers: JSON_HEADERS,
      });
    }

    const parsed = JSON.parse(rawText) as Partial<CarbEstimateResponseBody>;
    const carbsG = Math.max(0, Math.round(Number(parsed.carbs_g ?? 0) * 10) / 10);
    const confidence: 'high' | 'medium' | 'low' =
      parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low'
        ? parsed.confidence
        : 'medium';
    const note = String(parsed.note || `AI推定: ${foodName} (${amount}${unit})`).slice(0, 80);

    const result: CarbEstimateResponseBody = {
      carbs_g: carbsG,
      confidence,
      note,
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: JSON_HEADERS,
    });
  } catch {
    return new Response(JSON.stringify({ error: 'Failed to invoke Gemini API' }), {
      status: 502,
      headers: JSON_HEADERS,
    });
  }
}

