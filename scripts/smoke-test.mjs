/**
 * 開発サーバー（Vite dev server）8並列ランタイム・スモークテスト
 *
 * 強化点:
 * - ハードコード配列を廃止し、src/ ファイルシステム走査から検査対象エンドポイントを単一自動導出
 * - 無関係な localhost:3000 プロセスの無検証流用を廃止し、毎回ポート 0 (OS 空きポート自動割当) の隔離エフェメラル Vite サーバーを起動
 * - 8並列ワーカープールで全エンドポイントを検証 (約20s -> 約2〜3s)
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const CONCURRENCY = 8;

function walkSrcModules(dir, extFilter) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'test') continue;
      results = results.concat(walkSrcModules(full, extFilter));
    } else if (
      extFilter.some((ext) => full.endsWith(ext)) &&
      !full.endsWith('.test.ts') &&
      !full.endsWith('.test.tsx') &&
      !full.endsWith('.d.ts')
    ) {
      results.push('/' + path.relative(ROOT_DIR, full).split(path.sep).join('/'));
    }
  }
  return results.sort();
}

export function deriveSmokeEndpoints(rootDir = ROOT_DIR) {
  const srcRoot = path.join(rootDir, 'src');
  const discovered = new Set(['/']);
  for (const entry of ['/src/main.tsx', '/src/App.tsx']) {
    if (fs.existsSync(path.join(rootDir, entry.slice(1)))) {
      discovered.add(entry);
    }
  }
  for (const sub of ['components', 'contexts', 'lib', 'types', 'workers']) {
    for (const mod of walkSrcModules(path.join(srcRoot, sub), ['.ts', '.tsx'])) {
      discovered.add(mod);
    }
  }
  return Array.from(discovered);
}

export const ENDPOINTS_TO_CHECK = deriveSmokeEndpoints();

const ERROR_PATTERNS = [
  'Failed to resolve import',
  'Pre-transform error',
  'Internal server error',
  'vite-error-overlay',
  'plugin:vite:import-analysis',
  'Cannot find module',
];

async function checkSingleEndpoint(activeBaseUrl, endpoint, timeoutMs = 20_000) {
  if (endpoint !== '/') {
    const localPath = path.join(ROOT_DIR, endpoint.replace(/^\//, ''));
    if (!fs.existsSync(localPath)) {
      return {
        endpoint,
        status: 'MISSING_FILE',
        error: `${endpoint} does NOT exist on disk (${localPath})`,
      };
    }
  }

  const targetUrl = `${activeBaseUrl}${endpoint}`;
  try {
    const response = await fetch(targetUrl, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();

    if (response.status !== 200) {
      return {
        endpoint,
        status: 'FAIL',
        code: response.status,
        error: `HTTP ${response.status}: ${text.slice(0, 240)}`,
      };
    }

    if (endpoint !== '/' && text.trimStart().toLowerCase().startsWith('<!doctype html>')) {
      return {
        endpoint,
        status: 'SPA_FALLBACK_ERR',
        error: 'Returned HTML fallback instead of transformed JS module',
      };
    }

    const foundError = ERROR_PATTERNS.find((pattern) => text.includes(pattern));
    if (foundError) {
      return {
        endpoint,
        status: 'FAIL',
        pattern: foundError,
        error: `Contains error pattern "${foundError}": ${text.slice(0, 240)}`,
      };
    }

    return { endpoint, status: 'PASS', code: 200 };
  } catch (err) {
    return {
      endpoint,
      status: 'CONN_ERR',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function allocateEphemeralPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

export async function runSmokeTest() {
  const explicitUrl = (process.env.SMOKE_BASE_URL || '').trim();
  let activeBaseUrl = explicitUrl;
  let ephemeralServer = null;
  const startedAt = Date.now();

  try {
    if (!activeBaseUrl) {
      const ephemeralPort = await allocateEphemeralPort();
      ephemeralServer = await createServer({
        root: ROOT_DIR,
        mode: 'personal',
        logLevel: 'error',
        optimizeDeps: {
          noDiscovery: true,
          include: [],
        },
        server: {
          host: '127.0.0.1',
          port: ephemeralPort,
          strictPort: true,
        },
      });
      await ephemeralServer.listen();
      const address = ephemeralServer.httpServer?.address();
      if (!address || typeof address !== 'object') {
        throw new Error('Failed to bind ephemeral Vite dev server port.');
      }
      activeBaseUrl = `http://127.0.0.1:${address.port}`;
    }

    const endpoints = deriveSmokeEndpoints();
    console.log(`\n======================================================`);
    console.log(
      `🚀 Starting ${CONCURRENCY}-Parallel Runtime Smoke Test on ${activeBaseUrl} (${endpoints.length} endpoints)`
    );
    console.log(`======================================================\n`);

    const results = new Array(endpoints.length);
    // Warm up Vite esbuild dependency pre-bundling on entrypoints first so parallel workers never block on cold optimizeDeps lock
    const warmupCount = Math.min(2, endpoints.length);
    for (let i = 0; i < warmupCount; i++) {
      results[i] = await checkSingleEndpoint(activeBaseUrl, endpoints[i], 45_000);
    }

    let cursor = warmupCount;

    async function worker() {
      while (true) {
        const idx = cursor++;
        if (idx >= endpoints.length) break;
        results[idx] = await checkSingleEndpoint(activeBaseUrl, endpoints[idx], 20_000);
      }
    }

    if (cursor < endpoints.length) {
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, endpoints.length - warmupCount) }, () =>
          worker()
        )
      );
    }

    const failed = results.filter((r) => r.status !== 'PASS');
    for (const f of failed) {
      console.error(`❌ [FAIL] ${f.endpoint} (${f.status}): ${f.error}`);
    }

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(2);
    console.log(`📊 Smoke Test Summary (${elapsedSec}s):`);
    console.log(`   Total Endpoints: ${endpoints.length}`);
    console.log(`   Passed: ${results.length - failed.length}`);
    console.log(`   Failed: ${failed.length}\n`);

    if (failed.length > 0) {
      console.error(`💥 Runtime Smoke Test FAILED!`);
      process.exitCode = 1;
    } else {
      console.log(`🎉 All ${endpoints.length} runtime endpoints passed with ZERO errors in ${elapsedSec}s!\n`);
      process.exitCode = 0;
    }
  } finally {
    if (ephemeralServer) {
      await ephemeralServer.close();
    }
  }
}

const isExecutedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isExecutedDirectly) {
  runSmokeTest();
}
