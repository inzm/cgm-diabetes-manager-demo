/**
 * Cloudflare Pages Functions BFF: POST /api/gemini
 *
 * 【セキュリティ原則】
 * Google Gemini APIキー (`GEMINI_API_KEY`) はクライアント（ブラウザ）には一切露出させず、
 * Cloudflare Pages / Workers の環境変数（Secrets）からのみ読み出してサーバーサイドで推論を実行する。
 * `GEMINI_API_KEY` 未設定時やエラー発生時は非200応答を返し、クライアント側の
 * 日本食品標準成分表内蔵辞書（`estimateCarbsLocally`）へ安全にフォールバックさせる。
 */

export interface GeminiPagesEnv {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
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

const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

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

