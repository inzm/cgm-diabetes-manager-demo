import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SCREENSHOT_DIR = path.join(process.cwd(), '.agents', 'scratch', 'screenshots');
const REPORT_PATH = path.join(SCREENSHOT_DIR, 'visual-audit-report.json');

interface ScreenAuditResult {
  id: string;
  title: string;
  viewport: { width: number; height: number };
  screenshotPath: string;
  hasHorizontalOverflow: boolean;
  scrollWidth: number;
  clientWidth: number;
  exposedJargon: string[];
  runtimeErrors: string[];
  timestamp: string;
}

const FORBIDDEN_UI_JARGON = [
  'マスタ',
  'IndexedDB',
  'Dexie',
  'Web Worker',
  'libre_readings',
  'food_master',
  'event_master',
  'meal_details',
];

function ensureScreenshotDir() {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
}

function attachZeroErrorGuard(page: Page, errors: string[]) {
  page.on('pageerror', (err) => {
    errors.push(`[pageerror] ${err.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (
        !text.includes('ERR_INTERNET_DISCONNECTED') &&
        !text.includes('Failed to load resource: net::') &&
        !text.includes('status of 503 (Service Unavailable)')
      ) {
        errors.push(`[console.error] ${text}`);
      }
    }
  });
}

async function captureAndAuditScreen(
  page: Page,
  id: string,
  title: string,
  runtimeErrors: string[],
  auditLog: ScreenAuditResult[]
) {
  ensureScreenshotDir();
  // Wait briefly for transitions and ECharts canvas/SVG animations to settle
  await page.waitForTimeout(250);

  const viewport = page.viewportSize() || { width: 1280, height: 800 };
  const fileName = `${id}.png`;
  const fullPath = path.join(SCREENSHOT_DIR, fileName);

  await page.screenshot({ path: fullPath, fullPage: false });

  const layoutMetrics = await page.evaluate((jargonList) => {
    const docEl = document.documentElement;
    const scrollWidth = docEl.scrollWidth;
    const clientWidth = docEl.clientWidth;
    const bodyText = document.body ? document.body.innerText : '';
    const exposedJargon = jargonList.filter((term) => bodyText.includes(term));
    return {
      scrollWidth,
      clientWidth,
      hasHorizontalOverflow: scrollWidth > clientWidth + 1,
      exposedJargon,
    };
  }, FORBIDDEN_UI_JARGON);

  const result: ScreenAuditResult = {
    id,
    title,
    viewport,
    screenshotPath: fullPath.split(path.sep).join('/'),
    hasHorizontalOverflow: layoutMetrics.hasHorizontalOverflow,
    scrollWidth: layoutMetrics.scrollWidth,
    clientWidth: layoutMetrics.clientWidth,
    exposedJargon: layoutMetrics.exposedJargon,
    runtimeErrors: [...runtimeErrors],
    timestamp: new Date().toISOString(),
  };

  auditLog.push(result);

  expect(
    result.hasHorizontalOverflow,
    `[${id}] Horizontal overflow detected (${result.scrollWidth}px > ${result.clientWidth}px)`
  ).toBe(false);
  expect(
    result.exposedJargon,
    `[${id}] Forbidden developer jargon exposed in UI: ${result.exposedJargon.join(', ')}`
  ).toEqual([]);
  expect(
    result.runtimeErrors,
    `[${id}] Runtime errors detected: ${result.runtimeErrors.join('\n')}`
  ).toEqual([]);
}

test.describe('AI Orchestration Visual Design & Multimodal Screenshot Suite @visual', () => {
  test('Capture & Audit All Key Views Across Desktop (1280x800) and Mobile (375x812)', async ({
    page,
  }) => {
    const runtimeErrors: string[] = [];
    const auditLog: ScreenAuditResult[] = [];
    attachZeroErrorGuard(page, runtimeErrors);

    // =========================================================================
    // 1. Desktop Views (1280x800)
    // =========================================================================
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    const welcomeModal = page.getByTestId('demo-welcome-modal');
    if (await welcomeModal.isVisible()) {
      await page.getByTestId('btn-start-demo').click();
      await expect(welcomeModal).toBeHidden();
    }
    await expect(page.getByText('2026年 8月')).toBeVisible();
    const desktopSummary = page.locator('.sticky.top-12 .hidden.sm\\:flex');
    await expect(desktopSummary).toBeVisible();
    await expect(desktopSummary).toContainText('8月25日 (火)');

    await captureAndAuditScreen(
      page,
      '01-calendar-desktop',
      'カレンダー画面（デスクトップ 1280x800）',
      runtimeErrors,
      auditLog
    );

    // Open Daily Detail Drawer on Desktop
    await desktopSummary.click();
    await expect(page.getByRole('button', { name: '食事を記録' })).toBeVisible();
    await expect(page.locator('.echarts-for-react svg').first()).toBeVisible();

    await captureAndAuditScreen(
      page,
      '02-daily-drawer-desktop',
      '日次詳細ドロワー＆24H血糖推移グラフ（デスクトップ 1280x800）',
      runtimeErrors,
      auditLog
    );

    // Open Meal Record Modal on Desktop
    await page.getByRole('button', { name: '食事を記録' }).click();
    await expect(page.getByRole('heading', { name: '食事・インスリンを記録' })).toBeVisible();

    await captureAndAuditScreen(
      page,
      '03-meal-modal-desktop',
      '食事・インスリン記録モーダル（デスクトップ 1280x800）',
      runtimeErrors,
      auditLog
    );

    await page.getByRole('button', { name: 'キャンセル' }).click();
    await expect(page.getByRole('heading', { name: '食事・インスリンを記録' })).toBeHidden();
    await page.getByRole('button', { name: '閉じる' }).first().click();
    await expect(page.getByRole('button', { name: '食事を記録' })).toBeHidden();

    // Navigate to Analysis Dashboard on Desktop
    await page.getByRole('button', { name: '分析' }).first().click();
    await expect(page.getByText('血糖・食事の傾向分析')).toBeVisible();
    await expect(page.getByLabel('分析する食品を選択')).toBeVisible();

    await captureAndAuditScreen(
      page,
      '04-analysis-desktop',
      '4大臨床データ分析ダッシュボード（デスクトップ 1280x800）',
      runtimeErrors,
      auditLog
    );

    // Navigate to Food & Activity View on Desktop
    await page.getByRole('button', { name: '食品・活動' }).first().click();
    await expect(page.getByRole('button', { name: /よく使う食品/ })).toBeVisible();
    await expect(page.getByText('うどん')).toBeVisible();

    await captureAndAuditScreen(
      page,
      '05-food-activity-desktop',
      'よく使う食品・活動管理画面（デスクトップ 1280x800）',
      runtimeErrors,
      auditLog
    );

    // Open Category Manage Modal on Desktop
    await page.getByRole('button', { name: 'カテゴリを編集' }).click();
    await expect(page.getByRole('heading', { name: '食品カテゴリ管理' })).toBeVisible();

    await captureAndAuditScreen(
      page,
      '06-category-modal-desktop',
      'カテゴリ管理モーダル（デスクトップ 1280x800）',
      runtimeErrors,
      auditLog
    );

    await page.getByRole('button', { name: '閉じる' }).click();

    // Navigate to Settings View on Desktop
    await page.getByRole('button', { name: '設定' }).first().click();
    await expect(page.getByText('血糖値の目標範囲・アラート設定')).toBeVisible();

    await captureAndAuditScreen(
      page,
      '07-settings-desktop',
      '設定・目標範囲・データ管理画面（デスクトップ 1280x800）',
      runtimeErrors,
      auditLog
    );

    // =========================================================================
    // 2. Mobile Views (375x812)
    // =========================================================================
    await page.setViewportSize({ width: 375, height: 812 });
    await page.locator('button:visible', { hasText: 'カレンダー' }).first().click();
    await expect(page.getByText('2026年 8月')).toBeVisible();

    const mobileSummary = page.locator('.sticky.top-12 .sm\\:hidden');
    await expect(mobileSummary).toBeVisible();
    await expect(mobileSummary).toContainText('8/25 (火)');

    await captureAndAuditScreen(
      page,
      '08-calendar-mobile',
      'カレンダー画面（モバイル 375x812）',
      runtimeErrors,
      auditLog
    );

    // Open Daily Detail Drawer on Mobile via mobile summary bar
    await mobileSummary.click();
    await expect(page.getByRole('button', { name: '食事を記録' })).toBeVisible();

    await captureAndAuditScreen(
      page,
      '09-daily-drawer-mobile',
      '日次詳細ドロワー（モバイル 375x812）',
      runtimeErrors,
      auditLog
    );

    // Close drawer on Mobile
    await page.getByRole('button', { name: '閉じる' }).first().click();
    await expect(page.getByRole('button', { name: '食事を記録' })).toBeHidden();

    // Navigate to Analysis Dashboard on Mobile
    await page.locator('button:visible', { hasText: '分析' }).first().click();
    await expect(page.getByText('血糖・食事の傾向分析')).toBeVisible();
    await expect(page.getByLabel('分析する食品を選択')).toBeVisible();

    await captureAndAuditScreen(
      page,
      '10-analysis-mobile',
      '4大臨床データ分析ダッシュボード（モバイル 375x812）',
      runtimeErrors,
      auditLog
    );

    // Verify all inner analysis tables (FoodImpact, WeekdayTrends, TimeAnomaly) fit within mobile viewport without horizontal scroll
    const overflowingAnalysisTables = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('table'));
      return tables
        .map((t, idx) => {
          const parent = t.parentElement;
          const scrollW = parent ? parent.scrollWidth : t.scrollWidth;
          const clientW = parent ? parent.clientWidth : t.clientWidth;
          return { idx, scrollW, clientW };
        })
        .filter((m) => m.scrollW > m.clientW + 1);
    });
    expect(
      overflowingAnalysisTables,
      `Mobile analysis inner tables should not overflow horizontally: ${JSON.stringify(overflowingAnalysisTables)}`
    ).toEqual([]);

    // Navigate to Food & Activity View on Mobile
    await page.locator('button:visible', { hasText: '食品・活動' }).first().click();
    await expect(page.getByRole('button', { name: /よく使う食品/ })).toBeVisible();
    await expect(page.getByText('うどん')).toBeVisible();

    await captureAndAuditScreen(
      page,
      '11-food-activity-mobile',
      'よく使う食品・活動管理画面（モバイル 375x812）',
      runtimeErrors,
      auditLog
    );

    // Verify mobile food serving weights (e.g., "1 玉(250g)") do not truncate with ellipsis
    const udonServingMetrics = await page.evaluate(() => {
      const udonTextEl = Array.from(document.querySelectorAll('div, span')).find(
        (el) => el.children.length === 0 && el.textContent?.trim() === '1 玉(250g)'
      );
      if (!udonTextEl) return null;
      return {
        scrollWidth: udonTextEl.scrollWidth,
        clientWidth: udonTextEl.clientWidth,
        isTruncated: udonTextEl.scrollWidth > udonTextEl.clientWidth + 1,
      };
    });
    expect(udonServingMetrics).not.toBeNull();
    expect(
      udonServingMetrics?.isTruncated,
      `Mobile food serving weight '1 玉(250g)' should not be truncated: ${JSON.stringify(udonServingMetrics)}`
    ).toBe(false);

    // Write structured visual audit report
    fs.writeFileSync(
      REPORT_PATH,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          totalScreens: auditLog.length,
          allPassed: auditLog.every(
            (item) =>
              !item.hasHorizontalOverflow &&
              item.exposedJargon.length === 0 &&
              item.runtimeErrors.length === 0
          ),
          screens: auditLog,
        },
        null,
        2
      ),
      'utf8'
    );
  });
});

