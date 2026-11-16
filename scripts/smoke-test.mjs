/**
 * 開発サーバー（Vite dev server）ランタイム・スモークテスト
 * 
 * 目的:
 * - 静的ビルド（tsc / vite build）では検知できない、Vite dev server の
 *   Pre-transform error, Failed to resolve import, モジュール解決エラー、
 *   HTTP 500 等のランタイムエラーを自動検出し、ブラウザでの画面クラッシュを防ぐ。
 * - 検査対象の全エンドポイントがローカルディスク上にも実在することを検証し、
 *   Vite SPA フォールバックによるパス間違いのすり抜けを防止する。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';

const DEFAULT_DEV_SERVER_URL = process.env.DEV_SERVER_URL || 'http://localhost:3000';
const ROOT_DIR = process.cwd();

export const ENDPOINTS_TO_CHECK = [
  '/',
  '/src/main.tsx',
  '/src/App.tsx',
  '/src/components/common/Header.tsx',
  '/src/components/common/OfflineBanner.tsx',
  '/src/components/common/BottomNav.tsx',
  '/src/components/common/ConfirmDialog.tsx',
  '/src/components/common/DemoWelcomeModal.tsx',
  '/src/components/common/AuthGateScreen.tsx',
  '/src/components/common/PasswordStrengthChecklist.tsx',
  '/src/components/calendar/CalendarView.tsx',
  '/src/components/calendar/CalendarGrid.tsx',
  '/src/components/calendar/CalendarDayCell.tsx',
  '/src/components/calendar/SelectedDaySummary.tsx',
  '/src/components/calendar/Sparkline.tsx',
  '/src/components/daily/DailyDetailDrawer.tsx',
  '/src/components/daily/DailyGlucoseChart.tsx',
  '/src/components/analysis/AnalysisView.tsx',
  '/src/components/analysis/FoodImpactTab.tsx',
  '/src/components/analysis/TimeAnomalyTab.tsx',
  '/src/components/analysis/WeekdayTrendsTab.tsx',
  '/src/components/analysis/CarbInsulinTrendTab.tsx',
  '/src/components/foods/FoodMasterView.tsx',
  '/src/components/foods/FoodCard.tsx',
  '/src/components/foods/FoodEditModal.tsx',
  '/src/components/foods/EventEditModal.tsx',
  '/src/components/foods/CategoryManageModal.tsx',
  '/src/components/records/MealRecordModal.tsx',
  '/src/components/records/ActivityRecordModal.tsx',
  '/src/components/import/CsvImportModal.tsx',
  '/src/components/settings/SettingsView.tsx',
  '/src/components/settings/TargetRangeSection.tsx',
  '/src/components/settings/DefaultInsulinSection.tsx',
  '/src/components/settings/DataBackupSection.tsx',
  '/src/components/settings/CloudSyncFamilySection.tsx',
  '/src/components/settings/VerificationPwaSection.tsx',
  '/src/contexts/PatientContext.tsx',
  '/src/lib/aggregates.ts',
  '/src/lib/analysisCalculators.ts',
  '/src/lib/anomalyExtractor.ts',
  '/src/lib/backupRestore.ts',
  '/src/lib/dateUtils.ts',
  '/src/lib/db.ts',
  '/src/lib/demoMealGenerator.ts',
  '/src/lib/echartsCore.ts',
  '/src/lib/foodSeed.ts',
  '/src/lib/gemini.ts',
  '/src/lib/pwa.ts',
  '/src/lib/realGlucoseLoader.ts',
  '/src/lib/supabase.ts',
  '/src/lib/syncEngine.ts',
  '/src/lib/useAnimatedModal.ts',
  '/src/lib/utils.ts',
  '/src/lib/uuidUtils.ts',
  '/src/types/database.ts',
  '/src/workers/csvParser.worker.ts',
];

const ERROR_PATTERNS = [
  'Failed to resolve import',
  'Pre-transform error',
  'Internal server error',
  'vite-error-overlay',
  'plugin:vite:import-analysis',
  'Cannot find module',
];

async function isServerListening(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(1500) });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function runSmokeTest() {
  let activeBaseUrl = DEFAULT_DEV_SERVER_URL;
  let ephemeralServer = null;

  try {
    const alreadyRunning = await isServerListening(activeBaseUrl);
    if (!alreadyRunning) {
      ephemeralServer = await createServer({
        root: ROOT_DIR,
        mode: 'personal',
        logLevel: 'error',
        server: {
          host: '127.0.0.1',
          port: 0,
          strictPort: false,
        },
      });
      await ephemeralServer.listen();
      const address = ephemeralServer.httpServer?.address();
      const port = typeof address === 'object' && address ? address.port : 3000;
      activeBaseUrl = `http://127.0.0.1:${port}`;
    }

    console.log(`\n======================================================`);
    console.log(`🚀 Starting Runtime Smoke Test on ${activeBaseUrl} (${ephemeralServer ? 'ephemeral Vite dev server' : 'existing dev server'})`);
    console.log(`======================================================\n`);

    let hasError = false;
    const results = [];

    for (const endpoint of ENDPOINTS_TO_CHECK) {
      // 1. 実ファイル存在確認 ('/' 以外)
      if (endpoint !== '/') {
        const localPath = path.join(ROOT_DIR, endpoint.replace(/^\//, ''));
        if (!fs.existsSync(localPath)) {
          console.error(`❌ [FAIL] ${endpoint} does NOT exist on disk (${localPath})`);
          hasError = true;
          results.push({ endpoint, status: 'MISSING_FILE' });
          continue;
        }
      }

      const targetUrl = `${activeBaseUrl}${endpoint}`;
      try {
        const response = await fetch(targetUrl);
        const text = await response.text();

        if (response.status !== 200) {
          console.error(`❌ [FAIL] ${endpoint} returned HTTP ${response.status}`);
          console.error(`   Error Snippet: ${text.slice(0, 300)}...`);
          hasError = true;
          results.push({ endpoint, status: 'FAIL', code: response.status });
          continue;
        }

        // 2. Vite SPA フォールバック検知 ('/' 以外のモジュールリクエストに <!DOCTYPE html> が返った場合は404相当)
        if (endpoint !== '/' && text.trimStart().toLowerCase().startsWith('<!doctype html>')) {
          console.error(`❌ [FAIL] ${endpoint} returned HTML fallback instead of transformed JS module`);
          hasError = true;
          results.push({ endpoint, status: 'SPA_FALLBACK_ERR' });
          continue;
        }

        // 3. エラーパターンの検出
        const foundError = ERROR_PATTERNS.find((pattern) => text.includes(pattern));
        if (foundError) {
          console.error(`❌ [FAIL] ${endpoint} contains error pattern: "${foundError}"`);
          console.error(`   Error Snippet: ${text.slice(0, 300)}...`);
          hasError = true;
          results.push({ endpoint, status: 'FAIL', pattern: foundError });
          continue;
        }

        console.log(`✅ [PASS] ${endpoint} (HTTP 200, clean module response)`);
        results.push({ endpoint, status: 'PASS', code: 200 });
      } catch (err) {
        console.error(`❌ [ERROR] Could not connect to ${targetUrl}:`, err.message);
        hasError = true;
        results.push({ endpoint, status: 'CONN_ERR', message: err.message });
      }
    }

    console.log(`\n======================================================`);
    console.log(`📊 Smoke Test Summary:`);
    console.log(`   Total Endpoints: ${ENDPOINTS_TO_CHECK.length}`);
    console.log(`   Passed: ${results.filter((r) => r.status === 'PASS').length}`);
    console.log(`   Failed: ${results.filter((r) => r.status !== 'PASS').length}`);
    console.log(`======================================================\n`);

    if (hasError) {
      console.error(`💥 Runtime Smoke Test FAILED! Fix module resolution or restart Vite dev server before proceeding.`);
      process.exitCode = 1;
    } else {
      console.log(`🎉 All runtime endpoints passed with ZERO errors! Dev server is fully healthy.\n`);
      process.exitCode = 0;
    }
  } finally {
    if (ephemeralServer) {
      await ephemeralServer.close();
    }
  }
}

runSmokeTest();
