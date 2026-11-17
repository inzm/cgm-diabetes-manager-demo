/**
 * デプロイ後ライブ疎通・セキュリティ境界スモーク検証スクリプト (post-deploy-smoke.mjs)
 *
 * 目的:
 * GitHub Actions CD 完了後の Cloudflare Pages 実 URL (`personal` または `demo`) に対して、
 * 秘密情報や患者データを一切送信せずに HTTP レベルの死活・バンドル分離・BFF JWT 認証境界を検証する。
 *
 * 使い方:
 * - ドライラン検証:
 *   node scripts/post-deploy-smoke.mjs --target=personal --url=https://example.pages.dev --dry-run
 * - 本番デプロイ後の実疎通確認:
 *   node scripts/post-deploy-smoke.mjs --target=personal --url=https://<your-pages-domain>
 * - 公開デモデプロイ後の実疎通確認:
 *   node scripts/post-deploy-smoke.mjs --target=demo --url=https://<demo-pages-domain>
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyDeployedEndpoint(options) {
  const target = options?.target === 'demo' ? 'demo' : 'personal';
  const rawUrl = String(options?.baseUrl || '').trim().replace(/\/+$/, '');
  const fetchImpl = options?.fetchImpl || globalThis.fetch;

  if (!/^https?:\/\/[^/\s]+$/i.test(rawUrl)) {
    throw new Error(
      `[Post-Deploy Smoke] Valid --url=https://<host> is required (received: "${rawUrl}").`
    );
  }

  const checks = [];

  // 1. Root HTML shell (`GET /`)
  const rootRes = await fetchImpl(`${rawUrl}/`, { redirect: 'follow' });
  const rootHtml = await rootRes.text();
  const rootOk = rootRes.status === 200 && rootHtml.includes('<div id="root">');
  checks.push({
    name: 'GET / (SPA HTML shell)',
    passed: rootOk,
    detail: `status=${rootRes.status}, hasRootDiv=${rootHtml.includes('<div id="root">')}`,
  });

  // 2. Stamped Service Worker (`GET /sw.js`)
  const swRes = await fetchImpl(`${rawUrl}/sw.js`);
  const swText = await swRes.text();
  const swStamped = /const\s+CACHE_NAME\s*=\s*'cgm-manager-v2-[0-9a-f]{8}';/.test(swText);
  checks.push({
    name: 'GET /sw.js (deterministic revision cache stamp)',
    passed: swRes.status === 200 && swStamped,
    detail: `status=${swRes.status}, swStamped=${swStamped}`,
  });

  // 3. Bundle Data Isolation (`GET /data/real_glucose_recent.json`)
  const dataRes = await fetchImpl(`${rawUrl}/data/real_glucose_recent.json`);
  const dataContentType = (dataRes.headers.get('content-type') || '').toLowerCase();
  const dataBodySample = (await dataRes.text()).trim().slice(0, 32);
  const servesDemoJson =
    dataRes.status === 200 &&
    (dataContentType.includes('application/json') || dataBodySample.startsWith('['));

  if (target === 'personal') {
    checks.push({
      name: 'GET /data/real_glucose_recent.json (demo dataset excluded in personal)',
      passed: !servesDemoJson,
      detail: `status=${dataRes.status}, contentType=${dataContentType || 'none'}`,
    });

    // 4. BFF Unauthenticated POST Guard (`POST /api/gemini` -> 401)
    const bffRes = await fetchImpl(`${rawUrl}/api/gemini`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: rawUrl,
      },
      body: JSON.stringify({ foodDescription: '白米 150g' }),
    });
    checks.push({
      name: 'POST /api/gemini without Bearer JWT (must reject with 401)',
      passed: bffRes.status === 401,
      detail: `status=${bffRes.status}`,
    });
  } else {
    checks.push({
      name: 'GET /data/real_glucose_recent.json (demo dataset present in portfolio)',
      passed: servesDemoJson,
      detail: `status=${dataRes.status}, contentType=${dataContentType || 'none'}`,
    });
  }

  const failed = checks.filter((c) => !c.passed);
  return {
    passed: failed.length === 0,
    target,
    baseUrl: rawUrl,
    checks,
  };
}

function getArgValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
  const prefix = `${flag}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const target = getArgValue(argv, '--target') === 'demo' ? 'demo' : 'personal';
  const baseUrl =
    getArgValue(argv, '--url') ||
    (target === 'demo' ? process.env.DEMO_DEPLOY_URL : process.env.PERSONAL_DEPLOY_URL) ||
    '';
  const isDryRun = argv.includes('--dry-run');

  if (isDryRun) {
    console.log(
      `ℹ️ [Post-Deploy Smoke Dry-Run] target=${target}, url=${baseUrl || '(unset)'} — ready.`
    );
    return;
  }

  const result = await verifyDeployedEndpoint({ target, baseUrl });
  console.log(`\n======================================================`);
  console.log(`🌐 Post-Deploy Live Smoke Report (${result.target} @ ${result.baseUrl})`);
  console.log(`======================================================`);
  for (const c of result.checks) {
    console.log(`  ${c.passed ? '✅' : '❌'} ${c.name} (${c.detail})`);
  }
  if (!result.passed) {
    console.error(`\n❌ Post-Deploy Smoke Verification FAILED.\n`);
    process.exit(1);
  }
  console.log(`\n🎉 All Post-Deploy Live Smoke checks PASSED!\n`);
}

const isExecutedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isExecutedDirectly) {
  main().catch((err) => {
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
