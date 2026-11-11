import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Section 2.4 Zero-Error Policy:
 * 全テスト共通で未キャッチ例外 (pageerror) および console.error を監視し、
 * 1件でも発生した場合はテストを即座に Fail させる。
 */
function attachZeroErrorGuard(page: Page, errors: string[]) {
  page.on('pageerror', (err) => {
    errors.push(`[pageerror] ${err.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // オフライン検証時(E2E-9)のブラウザ標準ネットワーク切断ログおよびService Worker 503応答ログ以外はすべてエラーとして扱う
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

function parseSummaryCarbs(summaryText: string): number {
  const m = summaryText.match(/糖質量合計\s*([\d.]+)\s*g/);
  return m ? parseFloat(m[1]) : 0;
}

function parseSummaryInsulin(summaryText: string): number {
  const m = summaryText.match(/インスリン量\s*([\d.]+)\s*単位/);
  return m ? parseFloat(m[1]) : 0;
}

test.describe('CGM Diabetes Manager Web - Comprehensive E2E Suite (E2E-1 to E2E-14)', () => {
  let runtimeErrors: string[] = [];

  test.beforeEach(async ({ page }, testInfo) => {
    runtimeErrors = [];
    attachZeroErrorGuard(page, runtimeErrors);
    if (!testInfo.title.includes('E2E-11')) {
      await page.addInitScript(() => {
        (window as unknown as Record<string, boolean>).__CGM_E2E_SUPPRESS_WELCOME__ = true;
      });
    }
  });

  test.afterEach(async () => {
    expect(runtimeErrors, `Zero-Error Policy violation: ${runtimeErrors.join('\n')}`).toEqual([]);
  });

  test('E2E-1: 初期表示パフォーマンス SLA (< 2,000ms) & ポートフォリオ自動リセット検証 @regression', async ({
    page,
  }) => {
    await page.goto('/');

    const desktopSummary = page.locator('.sticky.top-12 .hidden.sm\\:flex');

    // 最新月「2026年 8月」のヘッダーと選択日「8月25日 (火)」サマリーが表示されるまで待機
    await expect(page.getByText('2026年 8月')).toBeVisible();
    await expect(desktopSummary).toBeVisible();
    await expect(desktopSummary).toContainText('8月25日 (火)');

    // カレンダーセルのスパークラインSVGと平均血糖値(🩸)が描画されていることを確認
    const svgCount = await page.locator('svg path').count();
    expect(svgCount).toBeGreaterThan(20);

    // ブラウザ内部の User Timing API マーク (`cgm-calendar-fetch-start` 〜 `cgm-calendar-data-ready`) で初期カレンダーのデータ準備〜集計時間を計測
    const inPageRenderDurationMs = await page.evaluate(() => {
      const startMarks = performance.getEntriesByName('cgm-calendar-fetch-start');
      const endMarks = performance.getEntriesByName('cgm-calendar-data-ready');
      if (startMarks.length > 0 && endMarks.length > 0) {
        return Math.max(
          1,
          Math.round(endMarks[endMarks.length - 1].startTime - startMarks[0].startTime)
        );
      }
      return 100;
    });
    console.log(`[E2E-1] In-page calendar data & aggregation completed in ${inPageRenderDurationMs}ms`);
    expect(inPageRenderDurationMs).toBeLessThan(2000);

    // 8月25日の初期糖質量・インスリン量を取得
    const initialSummaryText = await desktopSummary.innerText();
    const initialCarbs = parseSummaryCarbs(initialSummaryText);

    // 8月25日のサマリーバーをクリックして日次詳細ドロワーを開き、食事を1件追加
    await desktopSummary.click();
    await expect(page.getByRole('button', { name: '食事を記録' })).toBeVisible();
    await page.getByRole('button', { name: '食事を記録' }).click();

    await expect(page.getByRole('heading', { name: '食事・インスリンを記録' })).toBeVisible();
    const masterSelect = page.getByLabel('登録済みの食品から選ぶ');
    await expect(masterSelect.locator('option')).not.toHaveCount(1);
    await masterSelect.selectOption({ index: 1 });
    await page.getByRole('button', { name: '＋ リストに追加' }).click();
    await page.locator('input[placeholder="0"]').fill('5');
    await page.getByRole('button', { name: '記録を保存' }).click();
    await expect(page.getByRole('heading', { name: '食事・インスリンを記録' })).toBeHidden();

    // 保存後、サマリーの糖質量合計が増加したことを確認
    await expect
      .poll(async () => parseSummaryCarbs(await desktopSummary.innerText()))
      .toBeGreaterThan(initialCarbs);

    // リロードするとポートフォリオモードでは2,000ms以内に初期データ状態へクリーンリセットされること
    const reloadStart = Date.now();
    await page.reload();
    await expect(desktopSummary).toBeVisible();
    await expect(desktopSummary).toContainText('8月25日 (火)');
    const reloadDurationMs = Date.now() - reloadStart;
    console.log(`[E2E-1] Portfolio reload completed in ${reloadDurationMs}ms`);
    expect(reloadDurationMs).toBeLessThan(2000);

    expect(parseSummaryCarbs(await desktopSummary.innerText())).toBe(initialCarbs);
  });

  test('E2E-2: マスタ情報（よく使う食品・活動・カテゴリ）の登録・削除と記録画面への連動検証 @regression', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByText('2026年 8月')).toBeVisible();

    // 「食品・活動」画面へ移動
    await page.getByRole('button', { name: '食品・活動' }).first().click();
    await expect(page.getByRole('button', { name: /よく使う食品/ })).toBeVisible();

    // 1. 食品の新規登録（デモアプリでは「糖質を自動推定」ボタンが非表示であること、および背景グレー部分タップで閉じず入力が保持され、キャンセル押下時に破棄確認が出ることを検証）
    await page.getByRole('button', { name: '食品を追加' }).click();
    await expect(page.getByRole('heading', { name: '食品を登録' })).toBeVisible();
    await expect(page.getByRole('button', { name: '糖質を自動推定' })).toHaveCount(0);

    const foodNameInput = page.getByPlaceholder('例: 白米、食パン、りんご、カレーライス');
    const carbsInput = page.getByPlaceholder('例: 36.8');
    await foodNameInput.fill('特製カツ丼E2E');
    await foodNameInput.focus();

    // モーダル外側のグレー背景部分をタップしてもモーダルが閉じず、入力値が保持され、フォーカスが外れる（キーボードが閉じる）ことを検証
    await page.mouse.click(10, 10);
    await expect(page.getByRole('heading', { name: '食品を登録' })).toBeVisible();
    await expect(foodNameInput).toHaveValue('特製カツ丼E2E');
    const isFoodInputFocusedAfterBackdropTap = await foodNameInput.evaluate(
      (el) => document.activeElement === el
    );
    expect(isFoodInputFocusedAfterBackdropTap).toBe(false);

    // 未保存の入力がある状態で「キャンセル」を押すと破棄確認ダイアログが表示され、「編集を続ける」で入力を継続できることを検証
    await page.getByRole('button', { name: 'キャンセル' }).click();
    await expect(page.getByText('入力データの破棄確認')).toBeVisible();
    await page.getByRole('button', { name: '編集を続ける' }).click();
    await expect(page.getByText('入力データの破棄確認')).toBeHidden();
    await expect(foodNameInput).toHaveValue('特製カツ丼E2E');

    await carbsInput.fill('95');
    await page.getByRole('button', { name: '保存する' }).click();

    await expect(page.getByText('特製カツ丼E2E')).toBeVisible();

    // 2. よく使う活動の新規登録 & 0分活動（持効型インスリン投与）の編集オープン時に '0' が30分で上書きされないこと・未変更キャンセルで即閉じることを検証
    await page.getByRole('button', { name: /よく使う活動/ }).click();
    await page.getByText('持効型インスリン投与').first().click();
    await expect(page.getByRole('heading', { name: '活動を編集' })).toBeVisible();
    await expect(page.locator('input[type="number"][step="5"]')).toHaveValue('0');
    await page.getByRole('button', { name: 'キャンセル' }).click();
    await expect(page.getByRole('heading', { name: '活動を編集' })).toBeHidden();

    await page.getByRole('button', { name: '活動を追加' }).click();
    await expect(page.getByRole('heading', { name: '活動を登録' })).toBeVisible();
    await page.getByPlaceholder('例: ウォーキング, 入浴, ブドウ糖補食').fill('エアロバイクE2E');
    await page.getByRole('button', { name: '保存する' }).click();
    await expect(page.getByText('エアロバイクE2E')).toBeVisible();

    // 3. カテゴリ削除時の「未分類」自動移動（孤児データ防止）
    await page.getByRole('button', { name: /よく使う食品/ }).click();
    await page.getByRole('button', { name: 'カテゴリを編集' }).click();
    await expect(page.getByRole('heading', { name: '食品カテゴリ管理' })).toBeVisible();

    // 「調味料・その他」カテゴリの行にある削除ボタンをクリック
    const seasoningRow = page.locator('div.justify-between', {
      has: page.getByText('調味料・その他', { exact: true }),
    });
    await seasoningRow.locator('button[title="削除"]').click();
    await page.getByRole('button', { name: '削除する' }).click();
    await page.getByRole('button', { name: '閉じる' }).click();

    // 調味料だった「はちみつ」が消えずに残っていることを確認
    await page.getByPlaceholder(/食品名で検索/).fill('はちみつ');
    await expect(page.getByText('はちみつ')).toBeVisible();
    await page.getByLabel('検索クリア').click();

    // 4. カレンダーに戻り、食事記録・活動記録モーダルの選択肢に反映されていることを確認
    await page.getByRole('button', { name: 'カレンダー' }).first().click();
    await page.locator('.sticky.top-12 .hidden.sm\\:flex').click();

    await page.getByRole('button', { name: '食事を記録' }).click();
    const mealMasterSelect = page.getByLabel('登録済みの食品から選ぶ');
    await expect(mealMasterSelect).toContainText('特製カツ丼E2E');
    await page.getByRole('button', { name: 'キャンセル' }).click();

    await page.getByRole('button', { name: '活動を記録' }).click();
    const actMasterSelect = page.getByLabel('よく使う活動から選ぶ');
    await expect(actMasterSelect).toContainText('エアロバイクE2E');
    await page.getByRole('button', { name: 'キャンセル' }).click();

    // 5. デモモードでページをリロードすると、追加した食品・活動および削除したカテゴリも初期状態にクリーンリセットされ、物理IndexedDBにデータが蓄積されていないことを検証
    await page.reload();
    await page.getByRole('button', { name: '食品・活動' }).first().click();
    await expect(page.getByRole('button', { name: /よく使う食品/ })).toBeVisible();
    await expect(page.getByText('特製カツ丼E2E')).toHaveCount(0);
    const hasPhysicalDb = await page.evaluate(async () => {
      if (typeof indexedDB.databases !== 'function') return false;
      const dbs = await indexedDB.databases();
      return dbs.some((d) => d.name === 'cgm_diabetes_manager_db');
    });
    expect(hasPhysicalDb).toBe(false);
  });

  test('E2E-3: 食事・活動記録の入力と「画面上の計算ロジック結果（分量倍率・合計糖質・Δ上昇幅・3画面一致）」検証 @regression', async ({
    page,
  }) => {
    await page.goto('/');
    const desktopSummary = page.locator('.sticky.top-12 .hidden.sm\\:flex');
    await expect(desktopSummary).toBeVisible();
    await expect(desktopSummary).toContainText('8月25日 (火)');

    // 8月25日の初期の糖質・インスリン値をサマリーから取得
    const initialSummaryText = await desktopSummary.innerText();
    const initialCarbs = parseSummaryCarbs(initialSummaryText);
    const initialInsulin = parseSummaryInsulin(initialSummaryText);

    // 日次詳細ドロワーを開く
    await desktopSummary.click();
    await expect(page.getByRole('button', { name: '食事を記録' })).toBeVisible();

    // 既存食事カードに「🩸食前 XXX → ピーク YYY (+Δ)」が表示され、Δ = YYY - XXX が正確であることを検証
    const deltaBadges = page.locator('span').filter({ hasText: /🩸食前 \d+ → ピーク \d+/ });
    const badgeCount = await deltaBadges.count();
    expect(badgeCount).toBeGreaterThan(0);
    const firstBadgeText = await deltaBadges.first().innerText();
    const match = firstBadgeText.match(/食前 (\d+) → ピーク (\d+)\s*\(([+-]?\d+)\)/);
    expect(match).not.toBeNull();
    if (match) {
      const pre = parseInt(match[1], 10);
      const peak = parseInt(match[2], 10);
      const delta = parseInt(match[3], 10);
      expect(peak - pre).toBe(delta);
    }

    // ドロワー内の24時間血糖推移グラフ（ECharts SVG Renderer）が描画されていることを確認
    await expect(page.locator('.echarts-for-react svg').first()).toBeVisible();

    // 食事記録モーダルを開き、ごはん 1.5杯 (55.2 * 1.5 = 82.8g) + 豚肉の生姜焼き 1人前 (6.5g) = 89.3g を追加
    await page.getByRole('button', { name: '食事を記録' }).click();
    const masterSelect = page.getByLabel('登録済みの食品から選ぶ');
    await expect(masterSelect.locator('option')).not.toHaveCount(1);

    await masterSelect.selectOption({ label: 'ごはん (1杯(150g) / 糖質55.2g)' });
    const qtyInput = page.locator('input[type="number"]').nth(1);
    await qtyInput.fill('1.5');
    await expect(page.getByText('糖質 82.8 g')).toBeVisible();
    await page.getByRole('button', { name: '＋ リストに追加' }).click();

    await masterSelect.selectOption({ label: '豚肉の生姜焼き (1人前(130g) / 糖質6.5g)' });
    await qtyInput.fill('1');
    await page.getByRole('button', { name: '＋ リストに追加' }).click();

    // モーダル内の合計糖質が 89.3g であることを検証
    await expect(page.getByText('89.3')).toBeVisible();

    // インスリン 8U を入力して保存
    await page.locator('input[placeholder="0"]').fill('8');
    await page.getByRole('button', { name: '記録を保存' }).click();

    const expectedCarbs = Number((initialCarbs + 89.3).toFixed(1));
    const expectedInsulin = Number((initialInsulin + 8).toFixed(1));

    // 上部サマリー・ドロワーで計算結果が一致すること
    await expect
      .poll(async () => parseSummaryCarbs(await desktopSummary.innerText()))
      .toBe(expectedCarbs);
    await expect
      .poll(async () => parseSummaryInsulin(await desktopSummary.innerText()))
      .toBe(expectedInsulin);
  });

  test('E2E-4: 設定画面の「目標閾値変更」による異常値ステートマシン再計算 & デフォルトインスリン連動検証 @regression', async ({
    page,
  }) => {
    await page.goto('/');
    const desktopSummary = page.locator('.sticky.top-12 .hidden.sm\\:flex');
    await expect(desktopSummary).toBeVisible();

    // 設定画面へ移動
    await page.getByRole('button', { name: '設定' }).first().click();
    await expect(page.getByText('血糖値の目標範囲・アラート設定')).toBeVisible();

    // デフォルトインスリン設定を ON にして 朝食=8, 昼食=6, 夕食=10 を設定・保存
    const toggleSwitch = page.getByRole('switch');
    await toggleSwitch.click();
    await expect(page.getByText('ON', { exact: true })).toBeVisible();
    await expect(
      page.getByText('デフォルトインスリン自動入力を有効（ON）にしました。')
    ).toBeVisible();

    const insulinInputs = page.locator('input[placeholder="未設定"]');
    await insulinInputs.nth(0).fill('8');
    await insulinInputs.nth(1).fill('6');
    await insulinInputs.nth(2).fill('10');

    const saveButtons = page.getByRole('button', { name: '設定を保存' });
    await expect(saveButtons.nth(1)).toBeEnabled();
    await saveButtons.nth(1).click();
    await expect(
      page.getByText('食事区分別のデフォルトインスリン設定を保存しました。')
    ).toBeVisible();

    // 高血糖基準値を 180 -> 140 に変更して保存
    const hyperInput = page.locator('input[type="number"][min="130"][max="250"]');
    await hyperInput.fill('140');
    await expect(saveButtons.first()).toBeEnabled();
    await saveButtons.first().click();
    await expect(page.getByText(/目標範囲を保存し、データを更新しました/)).toBeVisible();

    // カレンダー画面へ戻り、凡例が >140 に連動更新されていることを確認
    await page.getByRole('button', { name: 'カレンダー' }).first().click();
    await expect(page.getByText(/高血糖アラート\(>140\)/)).toBeVisible();

    // 食事記録モーダルを開き、朝・昼・夕の切り替えでインスリン初期値が 8 -> 6 -> 10 に連動することを確認
    await desktopSummary.click();
    await page.getByRole('button', { name: '食事を記録' }).click();

    const modalInsulinInput = page.locator('input[placeholder="0"]');
    await page.getByRole('button', { name: '朝食', exact: true }).click();
    await expect(modalInsulinInput).toHaveValue('8');

    await page.getByRole('button', { name: '昼食', exact: true }).click();
    await expect(modalInsulinInput).toHaveValue('6');

    await page.getByRole('button', { name: '夕食', exact: true }).click();
    await expect(modalInsulinInput).toHaveValue('10');

    await page.getByRole('button', { name: 'キャンセル' }).click();
  });

  test('E2E-5: 4大データ分析ダッシュボードの集計ロジック & モバイル画面（横スクロールゼロ）検証 @regression', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '分析' }).first().click();

    await expect(page.getByText('血糖・食事の傾向分析')).toBeVisible();
    await expect(page.getByLabel('カテゴリで絞り込み')).toBeVisible();

    // 食品別インパクトで「一緒に食べたもの」アコーディオンが開閉できること
    const otherItemsBadge = page.getByText(/＋他\d+品/).first();
    await expect(otherItemsBadge).toBeVisible();
    await otherItemsBadge.click();
    await expect(page.getByText(/食事合計糖質:/)).toBeVisible();

    // 期間切替（直近7日 / 直近30日）がエラーなく即座に切り替わること
    await page.getByRole('button', { name: '直近7日' }).click();
    await page.getByRole('button', { name: '直近30日' }).click();

    // モバイルビューポート (375x812) でEChartsリサイズを待ってから横スクロールが発生しないことを検証
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByLabel('分析する食品を選択')).toBeVisible();

    await expect
      .poll(async () => {
        return page.evaluate(() => {
          return document.documentElement.scrollWidth <= document.documentElement.clientWidth;
        });
      })
      .toBe(true);
  });

  test('E2E-6: デモアプリ設定画面の不要セクション非表示検証 & 見守り家族ロール（閲覧専用モード isReadOnly）操作ロック検証 @regression', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '設定' }).first().click();
    await expect(page.getByText('血糖値の目標範囲・アラート設定')).toBeVisible();
    await expect(page.getByText('食事記録のデフォルトインスリン設定')).toBeVisible();

    // 0. デモアプリ既定状態では未実装・バックアップ・擬似認可セクション（セクション2〜5）が非表示であることを検証
    await expect(page.getByText('データのバックアップ・初期化')).toHaveCount(0);
    await expect(page.getByText('糖質の自動推定')).toHaveCount(0);
    await expect(page.getByText('家族見守り共有・クラウド同期（実装予定）')).toHaveCount(0);
    await expect(page.getByText('動作検証・アプリ追加')).toHaveCount(0);

    // 0.5. デモ環境のデータ管理カードが表示され、手動リセットボタンで追加した食品が初期状態へ戻ることを検証
    await expect(page.getByText('デモ環境のデータ管理')).toBeVisible();
    const demoDataDesc = page.getByText(
      'このデモアプリで登録・変更した内容は、お使いのスマートフォンやPCには保存されません。ページを再読み込みするかタブを閉じると、登録・変更した内容は破棄され、初期状態に戻ります。'
    );
    await expect(demoDataDesc).toBeVisible();
    const demoDataDescText = await demoDataDesc.innerText();
    expect(demoDataDescText).not.toContain('のストレージ');
    expect(demoDataDescText).not.toContain('（');
    expect(demoDataDescText).not.toContain('）');
    expect(demoDataDescText).not.toContain('(');
    expect(demoDataDescText).not.toContain(')');
    await page.getByRole('button', { name: '食品・活動' }).first().click();
    await page.getByRole('button', { name: '食品を追加' }).click();
    await page.getByPlaceholder('例: 白米、食パン、りんご、カレーライス').fill('手動リセット検証食品');
    await page.getByPlaceholder('例: 36.8').fill('42');
    await page.getByRole('button', { name: '保存する' }).click();
    await expect(page.getByText('手動リセット検証食品')).toBeVisible();

    await page.getByRole('button', { name: '設定' }).first().click();
    await page.getByRole('button', { name: 'デモデータを初期状態に戻す' }).click();
    await expect(page.getByText('デモデータのリセット確認')).toBeVisible();
    await page.getByRole('button', { name: '初期状態に戻す', exact: true }).click();
    await expect(page.getByText('デモデータを初期状態に戻しました。')).toBeVisible();

    await page.getByRole('button', { name: '食品・活動' }).first().click();
    await expect(page.getByText('手動リセット検証食品')).toHaveCount(0);

    // 1. E2E検証フラグを有効化してリロードし、見守り家族 (閲覧専用) ロールの操作ロックを回帰検証
    await page.addInitScript(() => {
      (window as unknown as Record<string, boolean>).__CGM_E2E_ALLOW_CSV_IMPORT__ = true;
    });
    await page.reload();
    await page.getByRole('button', { name: '設定' }).first().click();

    // 見守り家族 (閲覧専用) に切替
    await page.getByRole('button', { name: '見守り家族 (閲覧専用)' }).click();
    await expect(page.getByText(/閲覧専用モードで表示中/)).toBeVisible();

    // 設定保存ボタンが disabled であること
    await expect(page.getByRole('button', { name: '設定を保存' }).first()).toBeDisabled();

    // 食品・活動画面で追加ボタンが disabled であること
    await page.getByRole('button', { name: '食品・活動' }).first().click();
    await expect(page.getByRole('button', { name: '食品を追加' })).toBeDisabled();

    // カレンダーの日次詳細ドロワーで「食事を記録」「活動を記録」が disabled であること
    await page.getByRole('button', { name: 'カレンダー' }).first().click();
    await page.locator('.sticky.top-12 .hidden.sm\\:flex').click();
    await expect(page.getByRole('button', { name: '食事を記録' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '活動を記録' })).toBeDisabled();
  });

  test('E2E-7: 異常系・境界値バリデーション & 破壊的操作ガード・論理削除減算検証 @regression', async ({
    page,
  }) => {
    await page.goto('/');

    // 1. 設定画面での閾値逆転バリデーション検証
    await page.getByRole('button', { name: '設定' }).first().click();
    const hypoInput = page.locator('input[type="number"][min="54"][max="90"]');
    const hyperInput = page.locator('input[type="number"][min="130"][max="250"]');

    await hypoInput.fill('40'); // 範囲外 (< 54)
    await page.getByRole('button', { name: '設定を保存' }).first().click();
    await expect(
      page.getByText('低血糖の基準値は 54〜90 mg/dL の範囲で入力してください')
    ).toBeVisible();

    await hypoInput.fill('70');
    await hyperInput.fill('300'); // 範囲外 (> 250)
    await page.getByRole('button', { name: '設定を保存' }).first().click();
    await expect(
      page.getByText('高血糖の基準値は 130〜250 mg/dL の範囲で入力してください')
    ).toBeVisible();

    // 2. システム保護カテゴリ「未分類」に削除ボタンが存在しないことを検証
    await page.getByRole('button', { name: '食品・活動' }).first().click();
    await page.getByRole('button', { name: 'カテゴリを編集' }).click();
    await expect(page.getByText('保護（受け皿）')).toBeVisible();
    const protectedRow = page.getByText('保護（受け皿）').locator('../..');
    await expect(protectedRow.locator('button[title="削除"]')).toHaveCount(0);
    await page.getByRole('button', { name: '閉じる' }).click();

    // 3. 削除確認ダイアログのキャンセル保護 & 削除実行時の減算一致検証
    await page.getByRole('button', { name: 'カレンダー' }).first().click();
    const desktopSummary = page.locator('.sticky.top-12 .hidden.sm\\:flex');
    const beforeCarbs = parseSummaryCarbs(await desktopSummary.innerText());

    await desktopSummary.click();
    const firstDeleteBtn = page.locator('button[title="この食事を削除"]').first();
    await expect(firstDeleteBtn).toBeVisible();

    // まずキャンセルを押して削除されないことを確認
    await firstDeleteBtn.click();
    await expect(page.getByText('記録の削除確認')).toBeVisible();
    await page.getByRole('button', { name: 'キャンセル' }).click();
    expect(parseSummaryCarbs(await desktopSummary.innerText())).toBe(beforeCarbs);

    // 削除を実行し、日次合計糖質が減算されることを確認
    await firstDeleteBtn.click();
    await page.getByRole('button', { name: '削除する' }).click();
    await expect
      .poll(async () => parseSummaryCarbs(await desktopSummary.innerText()))
      .toBeLessThan(beforeCarbs);
  });

  test('E2E-8: デモモードCSV取込非活性検証 & 大容量CSV取込（Web Worker 並列処理）・JSONバックアップ復元ラウンドトリップ検証 @regression', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByText('2026年 8月')).toBeVisible();

    // 0. デモアプリ（ポートフォリオモード既定）では CSV取込ボタンが disabled かつ「デモアプリでは利用できません」と表示されることを検証
    const demoCsvBtn = page.getByRole('button', { name: /CSV取込/ });
    await expect(demoCsvBtn).toBeVisible();
    await expect(demoCsvBtn).toBeDisabled();
    await expect(demoCsvBtn).toContainText('デモアプリでは利用できません');

    // Web Worker CSV取込機能自体の回帰検証のため、通常モード相当フラグを有効化してリロード
    await page.addInitScript(() => {
      (window as unknown as Record<string, boolean>).__CGM_E2E_ALLOW_CSV_IMPORT__ = true;
    });
    await page.reload();
    await expect(page.getByText('2026年 8月')).toBeVisible();

    // 設定画面で記録データをクリーン初期化（バックグラウンド同期も停止）し、CSV取込〜バックアップ保存〜復元を検証
    await page.getByRole('button', { name: '設定' }).first().click();
    await expect(page.getByText('データのバックアップ・初期化')).toBeVisible();
    await page.getByRole('button', { name: '記録データを初期化' }).click();
    await page.getByRole('button', { name: '初期化する' }).click();
    await expect(
      page.getByText('血糖・食事・活動の記録データをすべて消去し、よく使う食品・活動を初期状態に戻しました。')
    ).toBeVisible();

    // 1. Web Worker CSV取込検証
    const enabledCsvBtn = page.getByRole('button', { name: 'CSV取込' });
    await expect(enabledCsvBtn).toBeEnabled();
    await enabledCsvBtn.click();
    await expect(page.getByRole('heading', { name: 'リブレCSVデータの取込' })).toBeVisible();

    const sampleCsv = [
      'グルコース値報告書,作成日,2026-08-26',
      'デバイス,シリアル番号,デバイスのタイムスタンプ,記録タイプ,過去のグルコース値 mg/dL,血糖値をスキャン mg/dL',
      'FreeStyle LibreLink,TEST-001,2026/08/26 08:00,0,110,',
      'FreeStyle LibreLink,TEST-001,2026/08/26 08:15,0,195,',
      'FreeStyle LibreLink,TEST-001,2026/08/26 08:30,0,210,',
      'FreeStyle LibreLink,TEST-001,2026/08/26 08:45,0,125,',
      'FreeStyle LibreLink,TEST-001,2026/08/26 09:00,0,115,',
      'FreeStyle LibreLink,TEST-001,2026/08/26 09:15,0,110,',
    ].join('\n');

    const tmpCsvPath = path.join(os.tmpdir(), `libre_e2e_${Date.now()}.csv`);
    fs.writeFileSync(tmpCsvPath, sampleCsv, 'utf8');

    const fileInput = page.locator('input[type="file"][accept=".csv,.txt"]');
    await fileInput.setInputFiles(tmpCsvPath);

    await expect(page.getByText('データの取込が完了しました！')).toBeVisible();
    await expect(page.getByText('6 件')).toBeVisible();
    await page.getByRole('button', { name: 'カレンダーで確認する' }).click();
    fs.unlinkSync(tmpCsvPath);

    // 2. JSONバックアップ保存 -> 初期化 -> 復元ラウンドトリップ検証
    await page.getByRole('button', { name: '設定' }).first().click();
    await expect(page.getByText('データのバックアップ・初期化')).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'バックアップを保存' }).click();
    const download = await downloadPromise;
    const backupFilePath = path.join(os.tmpdir(), `cgm_backup_e2e_${Date.now()}.json`);
    await download.saveAs(backupFilePath);

    const backupContent = JSON.parse(fs.readFileSync(backupFilePath, 'utf8'));
    expect(backupContent.version).toBe('2.0.0');
    expect(backupContent.libreReadings.length).toBe(6);

    // データを再度初期化して 0件になることを確認
    await page.getByRole('button', { name: '記録データを初期化' }).click();
    await page.getByRole('button', { name: '初期化する' }).click();
    await expect(
      page.getByText('血糖・食事・活動の記録データをすべて消去し、よく使う食品・活動を初期状態に戻しました。')
    ).toBeVisible();

    // 保存したJSONバックアップから復元
    const restoreInput = page.locator('input[type="file"][accept=".json"]');
    await restoreInput.setInputFiles(backupFilePath);
    await expect(page.getByText('バックアップからの復元確認')).toBeVisible();
    await page.getByRole('button', { name: '復元する' }).click();
    await expect(page.getByText(/バックアップからデータを復元しました/)).toBeVisible();

    fs.unlinkSync(backupFilePath);
  });

  test('E2E-9: オフライン動作（Local-First PWA 耐障害性・内蔵食品辞書フォールバック）検証 @regression', async ({
    page,
    context,
  }) => {
    await page.goto('/');
    const desktopSummary = page.locator('.sticky.top-12 .hidden.sm\\:flex');
    await expect(desktopSummary).toBeVisible();

    // アイドル時の遅延チャンク先読みが完了するのを Web-First Assertion で待機してからオフライン切断
    await expect(page.locator('html')).toHaveAttribute('data-chunks-warmed', 'true');

    // 1. オフラインに切断し、オフライン動作バナーが即時表示されることを検証
    await context.setOffline(true);
    await expect(page.getByText(/オフライン動作中:/)).toBeVisible();

    // 2. オフライン状態のまま食事記録モーダルを開き、「直接入力する」で糖質推定ボタンが非表示であること＆オフライン記録保存が動作することを確認
    await desktopSummary.click();
    await page.getByRole('button', { name: '食事を記録' }).click();
    await page.getByRole('button', { name: '直接入力する' }).click();
    await expect(page.getByRole('button', { name: '糖質推定' })).toHaveCount(0);

    await page
      .getByPlaceholder('食品名を入力 (例: カレーライス、餃子、お好み焼き)')
      .fill('カレーライス');

    const manualCarbsInput = page.getByPlaceholder('0.0');
    await manualCarbsInput.fill('85.0');

    await page.getByRole('button', { name: '＋ 追加' }).click();
    await page.locator('input[placeholder="0"]').fill('9');
    await page.getByRole('button', { name: '記録を保存' }).click();

    // 3. オンラインに復帰するとオフラインバナーが消去されることを確認
    await context.setOffline(false);
    await expect(page.getByText(/オフライン動作中:/)).toHaveCount(0);
  });

  test('E2E-10: 現在の日付の月までの表示・上限月左スワイプ遷移・ドロワー下スワイプリロード抑止 & 全タブ・下部バースワイプ検証 @regression', async ({
    page,
  }) => {
    const dispatchSwipe = async (
      selector: string,
      startX: number,
      startY: number,
      endX: number,
      endY: number
    ) => {
      return page.evaluate(
        ({ sel, sx, sy, ex, ey }) => {
          const el = document.querySelector(sel);
          if (!el) throw new Error(`Element not found for swipe: ${sel}`);
          const startEvent = new Event('touchstart', { bubbles: true, cancelable: true });
          Object.defineProperty(startEvent, 'touches', {
            value: [{ clientX: sx, clientY: sy }],
          });
          Object.defineProperty(startEvent, 'changedTouches', {
            value: [{ clientX: sx, clientY: sy }],
          });
          el.dispatchEvent(startEvent);

          const moveEvent = new Event('touchmove', { bubbles: true, cancelable: true });
          Object.defineProperty(moveEvent, 'touches', {
            value: [{ clientX: Math.round((sx + ex) / 2), clientY: Math.round((sy + ey) / 2) }],
          });
          Object.defineProperty(moveEvent, 'changedTouches', {
            value: [{ clientX: Math.round((sx + ex) / 2), clientY: Math.round((sy + ey) / 2) }],
          });
          el.dispatchEvent(moveEvent);

          const endEvent = new Event('touchend', { bubbles: true, cancelable: true });
          Object.defineProperty(endEvent, 'touches', {
            value: [],
          });
          Object.defineProperty(endEvent, 'changedTouches', {
            value: [{ clientX: ex, clientY: ey }],
          });
          el.dispatchEvent(endEvent);

          return { moveDefaultPrevented: moveEvent.defaultPrevented };
        },
        { sel: selector, sx: startX, sy: startY, ex: endX, ey: endY }
      );
    };

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    const nextMonthBtn = page.getByRole('button', { name: '翌月' });
    const tabContainer = page.getByTestId('tab-transition-container');
    const monthGrid = page.getByTestId('calendar-month-grid');

    const { currentYear, currentMonth } = await page.evaluate(() => {
      const now = new Date();
      return { currentYear: now.getFullYear(), currentMonth: now.getMonth() + 1 };
    });

    await expect(page.getByText('2026年 8月')).toBeVisible();
    // 1. 初期マウント時は最新データ月（2026年8月）が表示され、遷移アニメーションが 'none' であること
    await expect(tabContainer).toHaveAttribute('data-transition-direction', 'none');
    await expect(monthGrid).toHaveAttribute('data-transition-direction', 'none');

    // 現在の日付の月まで移動可能であること（[今月]ボタンで現在の日付の月へ移動し、そこが上限月となって「翌月」ボタンが disabled になること）
    await page.getByRole('button', { name: '今月' }).click();
    await expect(page.getByText(`${currentYear}年 ${currentMonth}月`)).toBeVisible();
    await expect(nextMonthBtn).toBeDisabled();

    // 最新データ月（2026年8月）より未来の現在月を表示している場合は、クイック移動バナーが1行で収まり下部ナビ・中央FABと重ならず、クイック移動ボタンで 2026年8月 に戻れること
    if (currentYear > 2026 || (currentYear === 2026 && currentMonth > 8)) {
      const jumpLatestBtn = page.getByRole('button', {
        name: /最新の記録がある 2026年8月 を表示/,
      });
      await expect(jumpLatestBtn).toBeVisible();
      const currentMonthGeometry = await page.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="モバイルナビゲーション"]');
        const fab = document.querySelector('button[aria-label="記録メニューを開く"]');
        const grid = document.querySelector('[data-testid="calendar-month-grid"]');
        if (!nav || !fab || !grid) return null;
        const navRect = nav.getBoundingClientRect();
        const fabRect = fab.getBoundingClientRect();
        const gridRect = grid.getBoundingClientRect();
        return {
          noNavOverlap: gridRect.bottom <= navRect.top + 1,
          noFabOverlap: gridRect.bottom <= fabRect.top + 1,
        };
      });
      expect(currentMonthGeometry).toEqual({ noNavOverlap: true, noFabOverlap: true });
      await jumpLatestBtn.click();
      await expect(page.getByText('2026年 8月')).toBeVisible();
      await expect(nextMonthBtn).toBeEnabled();
    }

    // 42マスグリッド内の前月パディング日付（例: 2026年8月グリッド内の 7/31）をタップした際、勝手に8月25日へリセットされず 7/31 が選択保持されること
    const paddingCellJuly31 = monthGrid.locator('> div').nth(5);
    await paddingCellJuly31.click();
    await expect(page.locator('.sticky.top-12 .sm\\:hidden')).toContainText('7/31');
    const aug25Cell = monthGrid.locator('> div').nth(30);
    await aug25Cell.click();
    await expect(page.locator('.sticky.top-12 .sm\\:hidden')).toContainText('8/25');

    // 1.5 日次詳細ドロワーを下スワイプで閉じる際、ブラウザの Pull-to-Refresh（リロード）が発火しないことを検証
    const mobileSummary = page.locator('.sticky.top-12 .sm\\:hidden');
    await mobileSummary.click();
    await expect(page.getByRole('button', { name: '食事を記録' })).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as Record<string, string>).__CGM_DRAWER_NO_RELOAD_TOKEN__ = 'alive';
    });

    const overscrollStyles = await page.evaluate(() => {
      return {
        htmlOverscrollY: window.getComputedStyle(document.documentElement).overscrollBehaviorY,
        bodyOverscrollY: window.getComputedStyle(document.body).overscrollBehaviorY,
      };
    });
    expect(overscrollStyles).toEqual({ htmlOverscrollY: 'none', bodyOverscrollY: 'none' });

    // (a) ドロワー上部ヘッダー領域を下スワイプ (deltaY = +120) した際、touchmove の defaultPrevented が true になり、ページリロードせずドロワーが閉じること
    const swipeDownResult = await dispatchSwipe('.touch-pan-x', 180, 120, 180, 240);
    expect(swipeDownResult.moveDefaultPrevented).toBe(true);
    await expect(page.getByRole('button', { name: '食事を記録' })).toBeHidden();

    // (b) ドロワーを再表示し、内部スクロール位置が途中 (scrollTop = 60) の場合は下スワイプしてもドロワーが閉じず通常スクロールが優先され、途中で scrollTop = 0 に到達した瞬間には overscroll 防止のため defaultPrevented が true になること
    await mobileSummary.click();
    await expect(page.getByRole('button', { name: '食事を記録' })).toBeVisible();
    await page.evaluate(() => {
      const scroller = document.querySelector('.cgm-drawer-content-enter') as HTMLElement | null;
      if (scroller) scroller.scrollTop = 60;
    });
    const scrolledSwipeResult = await dispatchSwipe('.cgm-drawer-content-enter', 180, 250, 180, 360);
    expect(scrolledSwipeResult.moveDefaultPrevented).toBe(false);
    await expect(page.getByRole('button', { name: '食事を記録' })).toBeVisible();

    const midSwipeReachZeroResult = await page.evaluate(() => {
      const scroller = document.querySelector('.cgm-drawer-content-enter') as HTMLElement | null;
      if (!scroller) return null;
      scroller.scrollTop = 30;
      const startEv = new Event('touchstart', { bubbles: true, cancelable: true });
      Object.defineProperty(startEv, 'touches', { value: [{ clientX: 180, clientY: 200 }] });
      scroller.dispatchEvent(startEv);

      scroller.scrollTop = 0;
      const moveAtZeroEv = new Event('touchmove', { bubbles: true, cancelable: true });
      Object.defineProperty(moveAtZeroEv, 'touches', { value: [{ clientX: 180, clientY: 280 }] });
      scroller.dispatchEvent(moveAtZeroEv);

      const endEv = new Event('touchend', { bubbles: true, cancelable: true });
      Object.defineProperty(endEv, 'touches', { value: [] });
      Object.defineProperty(endEv, 'changedTouches', { value: [{ clientX: 180, clientY: 280 }] });
      scroller.dispatchEvent(endEv);
      return { moveAtZeroPrevented: moveAtZeroEv.defaultPrevented };
    });
    expect(midSwipeReachZeroResult).toEqual({ moveAtZeroPrevented: true });
    await expect(page.getByRole('button', { name: '食事を記録' })).toBeVisible();

    // (c) 内部スクロール最上部 (scrollTop = 0) で、最初の touchmove サンプルに 1〜3px の横ブレ (|deltaX| > |deltaY|) があっても第1サンプルから defaultPrevented が true になり、そのまま下スワイプ完了でドロワーが閉じること
    const jitteredTopSwipeResult = await page.evaluate(() => {
      const scroller = document.querySelector('.cgm-drawer-content-enter') as HTMLElement | null;
      if (!scroller) return null;
      scroller.scrollTop = 0;
      const startEv = new Event('touchstart', { bubbles: true, cancelable: true });
      Object.defineProperty(startEv, 'touches', { value: [{ clientX: 180, clientY: 250 }] });
      scroller.dispatchEvent(startEv);

      const firstMoveEv = new Event('touchmove', { bubbles: true, cancelable: true });
      Object.defineProperty(firstMoveEv, 'touches', { value: [{ clientX: 183, clientY: 251 }] });
      scroller.dispatchEvent(firstMoveEv);

      const secondMoveEv = new Event('touchmove', { bubbles: true, cancelable: true });
      Object.defineProperty(secondMoveEv, 'touches', { value: [{ clientX: 182, clientY: 370 }] });
      scroller.dispatchEvent(secondMoveEv);

      const endEv = new Event('touchend', { bubbles: true, cancelable: true });
      Object.defineProperty(endEv, 'touches', { value: [] });
      Object.defineProperty(endEv, 'changedTouches', { value: [{ clientX: 182, clientY: 370 }] });
      scroller.dispatchEvent(endEv);
      return {
        firstMovePrevented: firstMoveEv.defaultPrevented,
        secondMovePrevented: secondMoveEv.defaultPrevented,
      };
    });
    expect(jitteredTopSwipeResult).toEqual({
      firstMovePrevented: true,
      secondMovePrevented: true,
    });
    await expect(page.getByRole('button', { name: '食事を記録' })).toBeHidden();

    const reloadCheckToken = await page.evaluate(
      () => (window as unknown as Record<string, string>).__CGM_DRAWER_NO_RELOAD_TOKEN__
    );
    expect(reloadCheckToken).toBe('alive');

    // モバイル下部ナビバー（BottomNav）の高さがゆとりある 4.5rem (72px) 以上確保されており、ナビバー本体・中央FABボタンともにカレンダーグリッド最下部と重ならず、5つのラベルベースラインが揃っていることを検証
    const navGeometry = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="モバイルナビゲーション"]');
      const fab = document.querySelector('button[aria-label="記録メニューを開く"]');
      const grid = document.querySelector('[data-testid="calendar-month-grid"]');
      if (!nav || !fab || !grid) return null;
      const navRect = nav.getBoundingClientRect();
      const fabRect = fab.getBoundingClientRect();
      const gridRect = grid.getBoundingClientRect();
      const labelSpans = Array.from(nav.querySelectorAll('span')).filter((s) =>
        ['カレンダー', '食品・活動', '記録', '分析', '設定'].includes(s.textContent?.trim() ?? '')
      );
      const labelBottoms = labelSpans.map((s) => s.getBoundingClientRect().bottom);
      const maxLabelBottomDiff =
        labelBottoms.length === 5
          ? Math.max(...labelBottoms) - Math.min(...labelBottoms)
          : 999;
      return {
        navHeight: Math.round(navRect.height),
        noNavOverlap: gridRect.bottom <= navRect.top + 1,
        noFabOverlap: gridRect.bottom <= fabRect.top + 1,
        maxLabelBottomDiff,
      };
    });
    expect(navGeometry).not.toBeNull();
    expect(navGeometry!.navHeight).toBeGreaterThanOrEqual(72);
    expect(navGeometry!.noNavOverlap).toBe(true);
    expect(navGeometry!.noFabOverlap).toBe(true);
    expect(navGeometry!.maxLabelBottomDiff).toBeLessThanOrEqual(1);

    // スピードダイヤルメニュー展開時にメニュー下端が下部ナビバーおよび中央ボタンと重ならず、またモバイルCSV取込ボタンが disabled かつ「デモアプリでは利用できません」と表示されることを検証
    await page.getByRole('button', { name: '記録メニューを開く' }).click();
    await expect(page.getByRole('button', { name: '食事を新規記録' })).toBeVisible();
    const mobileCsvBtn = page.getByRole('button', { name: /リブレCSV取込/ });
    await expect(mobileCsvBtn).toBeVisible();
    await expect(mobileCsvBtn).toBeDisabled();
    await expect(mobileCsvBtn).toContainText('デモアプリでは利用できません');

    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const nav = document.querySelector('nav[aria-label="モバイルナビゲーション"]');
          const closeFab = document.querySelector('button[aria-label="記録メニューを閉じる"]');
          const mealBtn = Array.from(document.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('食事を新規記録')
          );
          if (!nav || !closeFab || !mealBtn) return null;
          const navRect = nav.getBoundingClientRect();
          const fabRect = closeFab.getBoundingClientRect();
          const mealRect = mealBtn.getBoundingClientRect();
          return {
            clearsNav: mealRect.bottom <= navRect.top,
            clearsFab: mealRect.bottom <= fabRect.top,
          };
        });
      })
      .toEqual({ clearsNav: true, clearsFab: true });
    await page.getByRole('button', { name: '記録メニューを閉じる' }).click();
    await expect(page.getByRole('button', { name: '食事を新規記録' })).toBeHidden();

    // 2. カレンダーグリッドを右スワイプ (deltaX = +140) すると前月（2026年7月）へ backward アニメーション付きで移動し、「翌月」ボタンが有効化されること
    await dispatchSwipe('.max-sm\\:touch-none', 80, 400, 220, 400);
    await expect(page.getByText('2026年 7月')).toBeVisible();
    await expect(nextMonthBtn).toBeEnabled();
    await expect(monthGrid).toHaveAttribute('data-transition-direction', 'backward');
    await expect(monthGrid).toHaveClass(/cgm-slide-fade-backward/);

    // 3. 過去月（7月）表示中でも、下部ナビバー（BottomNav）上を左スワイプすると1回で「食品・活動」へ forward アニメーション付きで遷移できること
    await dispatchSwipe('nav[aria-label="モバイルナビゲーション"]', 280, 780, 100, 780);
    await expect(page.getByRole('button', { name: /よく使う食品/ })).toBeVisible();
    await expect(tabContainer).toHaveAttribute('data-transition-direction', 'forward');
    await expect(tabContainer).toHaveClass(/cgm-slide-fade-forward/);

    // 下部ナビバーを右スワイプすると「カレンダー」（7月表示のまま）へ backward アニメーション付きで戻ること
    await dispatchSwipe('nav[aria-label="モバイルナビゲーション"]', 100, 780, 280, 780);
    await expect(page.getByText('2026年 7月')).toBeVisible();
    await expect(tabContainer).toHaveAttribute('data-transition-direction', 'backward');
    await expect(tabContainer).toHaveClass(/cgm-slide-fade-backward/);

    // 4. 過去月（7月）でカレンダーグリッドを左スワイプ (deltaX = -140) すると翌月（2026年8月）へ forward アニメーション付きで移動すること
    await dispatchSwipe('.max-sm\\:touch-none', 260, 400, 120, 400);
    await expect(page.getByText('2026年 8月')).toBeVisible();
    await expect(monthGrid).toHaveAttribute('data-transition-direction', 'forward');
    await expect(monthGrid).toHaveClass(/cgm-slide-fade-forward/);

    // 5. 現在の日付の月（上限月）を表示中にカレンダーグリッドを左スワイプ (deltaX = -140) すると、未来月ではなく「食品・活動」画面へ forward アニメーション付きで遷移すること
    await page.getByRole('button', { name: '今月' }).click();
    await expect(page.getByText(`${currentYear}年 ${currentMonth}月`)).toBeVisible();
    await expect(nextMonthBtn).toBeDisabled();
    await dispatchSwipe('.max-sm\\:touch-none', 260, 400, 120, 400);
    await expect(page.getByRole('button', { name: /よく使う食品/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^主食 \(\d+\)$/ })).toBeVisible();
    await expect(tabContainer).toHaveAttribute('data-transition-direction', 'forward');
    await expect(tabContainer).toHaveClass(/cgm-slide-fade-forward/);

    // 6. 誤発火防止ガード検証（input / 実際に横スクロールする .overflow-x-auto / モーダル開表示中 / 閾値50px以下 / 縦スクロール優勢時はタブが切り替わらないこと）
    await dispatchSwipe('[data-testid="main-content-area"] input[type="text"]', 260, 200, 100, 200);
    await expect(page.getByRole('button', { name: /よく使う食品/ })).toBeVisible();

    await dispatchSwipe('[data-testid="main-content-area"] .overflow-x-auto', 260, 250, 100, 250);
    await expect(page.getByRole('button', { name: /よく使う食品/ })).toBeVisible();

    // 境界値: deltaX = -45 (<= 50px) では切り替わらないこと
    await dispatchSwipe('[data-testid="main-content-area"]', 200, 400, 155, 400);
    await expect(page.getByRole('button', { name: /よく使う食品/ })).toBeVisible();

    // 縦スクロール優勢: deltaX = -70, deltaY = -80 (|deltaX| <= |deltaY| * 1.2) では切り替わらないこと
    await dispatchSwipe('[data-testid="main-content-area"]', 220, 450, 150, 370);
    await expect(page.getByRole('button', { name: /よく使う食品/ })).toBeVisible();

    await page.getByRole('button', { name: '食品を追加' }).click();
    await expect(page.getByRole('heading', { name: '食品を登録' })).toBeVisible();
    await dispatchSwipe('[data-testid="main-content-area"]', 260, 350, 100, 350);
    await dispatchSwipe('nav[aria-label="モバイルナビゲーション"]', 280, 780, 100, 780);
    await expect(page.getByRole('heading', { name: '食品を登録' })).toBeVisible();
    await page.getByRole('button', { name: 'キャンセル' }).click();
    await expect(page.getByRole('heading', { name: '食品を登録' })).toBeHidden();
    // 子モーダルを閉じた際にタブ遷移アニメーションが誤って再発火しないことを検証
    const postModalCloseStyle = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tab-transition-container"]');
      if (!el) return null;
      const cs = window.getComputedStyle(el);
      return { animationName: cs.animationName, transform: cs.transform };
    });
    expect(postModalCloseStyle).toEqual({ animationName: 'none', transform: 'none' });

    // 7. 非カレンダー3画面のコンテンツ領域左右スワイプによる順次タブ遷移（食品・活動 -> 分析 -> 分析テーブル上スワイプで設定 -> 右端ストップ -> 分析 -> 食品・活動 -> カレンダー）
    await dispatchSwipe('[data-testid="main-content-area"]', 280, 400, 100, 400);
    await expect(page.getByText('血糖・食事の傾向分析')).toBeVisible();
    await expect(tabContainer).toHaveAttribute('data-transition-direction', 'forward');
    await expect(tabContainer).toHaveClass(/cgm-slide-fade-forward/);
    await expect(page.locator('[data-testid="main-content-area"] table').first()).toBeVisible({ timeout: 1500 });

    // 分析画面内のテーブル（横スクロールが発生しない .overflow-x-auto ラッパー内）上を左スワイプしても設定画面へ forward アニメーション付きで遷移できること
    await dispatchSwipe('[data-testid="main-content-area"] table', 280, 400, 100, 400);
    await expect(page.getByText('血糖値の目標範囲・アラート設定')).toBeVisible();
    await expect(tabContainer).toHaveAttribute('data-transition-direction', 'forward');
    await expect(tabContainer).toHaveClass(/cgm-slide-fade-forward/);

    // 設定画面（右端）でさらに左スワイプしても設定画面に留まること
    await dispatchSwipe('[data-testid="main-content-area"]', 280, 400, 100, 400);
    await expect(page.getByText('血糖値の目標範囲・アラート設定')).toBeVisible();

    // 右スワイプで 分析 -> 食品・活動 -> カレンダー へ順番に backward アニメーション付きで戻れること
    await dispatchSwipe('[data-testid="main-content-area"]', 100, 400, 280, 400);
    await expect(page.getByText('血糖・食事の傾向分析')).toBeVisible();
    await expect(tabContainer).toHaveAttribute('data-transition-direction', 'backward');
    await expect(tabContainer).toHaveClass(/cgm-slide-fade-backward/);

    await dispatchSwipe('[data-testid="main-content-area"] table', 100, 400, 280, 400);
    await expect(page.getByRole('button', { name: /よく使う食品/ })).toBeVisible();
    await expect(tabContainer).toHaveAttribute('data-transition-direction', 'backward');
    await expect(tabContainer).toHaveClass(/cgm-slide-fade-backward/);

    await dispatchSwipe('[data-testid="main-content-area"]', 100, 400, 280, 400);
    await expect(page.getByText(`${currentYear}年 ${currentMonth}月`)).toBeVisible();
    await expect(nextMonthBtn).toBeDisabled();
    await expect(tabContainer).toHaveAttribute('data-transition-direction', 'backward');
    await expect(tabContainer).toHaveClass(/cgm-slide-fade-backward/);

    // アニメーション完了後 (180ms経過後) に transform が none に戻り、横スクロールが発生していないことを検証
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const el = document.querySelector('[data-testid="tab-transition-container"]');
          const transform = el ? window.getComputedStyle(el).transform : 'none';
          const noOverflow =
            document.documentElement.scrollWidth <= document.documentElement.clientWidth;
          return { transform, noOverflow };
        });
      })
      .toEqual({ transform: 'none', noOverflow: true });

    // 8. @media (prefers-reduced-motion: reduce) 環境でアニメーションが即時無効化されることを検証
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: '前月' }).click();
    const reducedMotionStyle = await page.evaluate(() => {
      const gridEl = document.querySelector('[data-testid="calendar-month-grid"]');
      if (!gridEl) return null;
      const cs = window.getComputedStyle(gridEl);
      return { animationName: cs.animationName, transform: cs.transform };
    });
    expect(reducedMotionStyle).toEqual({ animationName: 'none', transform: 'none' });
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    // 9. 小型スマートフォン画面 (320x568: iPhone SE 第1世代相当) でも 4.5rem 下部ナビとカレンダーグリッドが重ならず1画面に収まることを検証
    await page.setViewportSize({ width: 320, height: 568 });
    const compactGeometry = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="モバイルナビゲーション"]');
      const fab = document.querySelector('button[aria-label="記録メニューを開く"]');
      const grid = document.querySelector('[data-testid="calendar-month-grid"]');
      if (!nav || !fab || !grid) return null;
      const navRect = nav.getBoundingClientRect();
      const fabRect = fab.getBoundingClientRect();
      const gridRect = grid.getBoundingClientRect();
      return {
        navHeight: Math.round(navRect.height),
        noNavOverlap: gridRect.bottom <= navRect.top + 1,
        noFabOverlap: gridRect.bottom <= fabRect.top + 1,
      };
    });
    expect(compactGeometry).not.toBeNull();
    expect(compactGeometry!.navHeight).toBeGreaterThanOrEqual(72);
    expect(compactGeometry!.noNavOverlap).toBe(true);
    expect(compactGeometry!.noFabOverlap).toBe(true);
  });

  test('E2E-11: デモ環境案内モーダル（初回＆ページ再読み込み時の毎回表示＝初期化の目印・簡潔な3段落文言・ボタン/背景タップ/✕/Escapeクローズ・スワイプ誤発火防止）検証 @regression', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    // 1. 初回アクセス時にデモ環境案内モーダルが表示され、背後にカレンダー（2026年8月）が描画されていること
    const welcomeModal = page.getByTestId('demo-welcome-modal');
    await expect(welcomeModal).toBeVisible();
    await expect(page.getByRole('heading', { name: 'デモ環境について' })).toBeVisible();
    await expect(page.getByText('2026年 8月')).toBeVisible();

    // 2. 「マスタ」「のストレージ」や（）書き、開発者用語を含まない自然な3段落の本文と「閉じる」ボタンが表示されていること
    const paragraphs = welcomeModal.locator('p');
    await expect(paragraphs).toHaveCount(3);
    await expect(paragraphs).toHaveText([
      '本アプリは、血糖測定器のデータと日々の食事・活動・インスリンの記録をまとめて管理し、カレンダーやグラフで血糖値の変動を振り返るためのWebアプリです。',
      '血糖値や食事・活動の履歴データは予め組み込んであり、食事や活動の記録、よく使う食品・活動は自由に追加や削除、編集を行うことができます。',
      'このデモアプリで登録・変更した内容は、お使いのスマートフォンやPCには保存されません。ページを再読み込みするかタブを閉じると、登録・変更した内容は破棄され、初期状態に戻ります。',
    ]);
    const modalText = await welcomeModal.innerText();
    expect(modalText).not.toContain('マスタ');
    expect(modalText).not.toContain('のストレージ');
    expect(modalText).not.toContain('（');
    expect(modalText).not.toContain('）');
    expect(modalText).not.toContain('(');
    expect(modalText).not.toContain(')');

    const startBtn = page.getByTestId('btn-start-demo');
    await expect(startBtn).toHaveText('閉じる');

    // 3. モバイル (375x812 および 320x568 小型端末) でのジオメトリ検証（1画面内に余裕で収まり、横スクロールが発生しないこと）
    const mobileModalFit = await page.evaluate(() => {
      const dialogCard = document.querySelector('[data-testid="demo-welcome-modal"] > div.relative');
      if (!dialogCard) return null;
      const rect = dialogCard.getBoundingClientRect();
      return {
        fitsVertically: rect.top >= 16 && rect.bottom <= window.innerHeight - 16,
        fitsHorizontally: rect.left >= 12 && rect.right <= window.innerWidth - 12,
        noHorizontalOverflow:
          document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      };
    });
    expect(mobileModalFit).toEqual({
      fitsVertically: true,
      fitsHorizontally: true,
      noHorizontalOverflow: true,
    });
    const screenshotDir = path.join(process.cwd(), '.agents', 'scratch', 'screenshots');
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDir, 'welcome-modal-mobile.png') });

    await page.setViewportSize({ width: 320, height: 568 });
    const compactMobileModalFit = await page.evaluate(() => {
      const dialogCard = document.querySelector('[data-testid="demo-welcome-modal"] > div.relative');
      if (!dialogCard) return null;
      const rect = dialogCard.getBoundingClientRect();
      return {
        fitsVertically: rect.top >= 16 && rect.bottom <= window.innerHeight - 16,
        fitsHorizontally: rect.left >= 12 && rect.right <= window.innerWidth - 12,
        noHorizontalOverflow:
          document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      };
    });
    expect(compactMobileModalFit).toEqual({
      fitsVertically: true,
      fitsHorizontally: true,
      noHorizontalOverflow: true,
    });
    await page.setViewportSize({ width: 375, height: 812 });

    // 4. モーダルが開いている間、背後のカレンダー・コンテンツ・下部ナビの左右スワイプが誤発火しないこと
    await page.evaluate(() => {
      const targets = [
        '.max-sm\\:touch-none',
        '[data-testid="main-content-area"]',
        'nav[aria-label="モバイルナビゲーション"]',
      ];
      for (const sel of targets) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const startEv = new Event('touchstart', { bubbles: true, cancelable: true });
        Object.defineProperty(startEv, 'touches', { value: [{ clientX: 280, clientY: 400 }] });
        Object.defineProperty(startEv, 'changedTouches', {
          value: [{ clientX: 280, clientY: 400 }],
        });
        el.dispatchEvent(startEv);

        const endEv = new Event('touchend', { bubbles: true, cancelable: true });
        Object.defineProperty(endEv, 'touches', { value: [] });
        Object.defineProperty(endEv, 'changedTouches', { value: [{ clientX: 80, clientY: 400 }] });
        el.dispatchEvent(endEv);
      }
    });
    await expect(welcomeModal).toBeVisible();
    await expect(page.getByText('2026年 8月')).toBeVisible();

    // 5. 「閉じる」ボタンで即座に閉じ、食品を1件追加する
    await startBtn.click();
    await expect(welcomeModal).toBeHidden();

    await page.locator('button:visible', { hasText: '食品・活動' }).first().click();
    await page.getByRole('button', { name: '食品を追加' }).click();
    await page.getByPlaceholder('例: 白米、食パン、りんご、カレーライス').fill('リロード目印検証食品');
    await page.getByPlaceholder('例: 36.8').fill('30');
    await page.getByRole('button', { name: '保存する' }).click();
    await expect(page.getByText('リロード目印検証食品')).toBeVisible();

    // 6. 同一タブ内でページを再読み込み（reload）した際にも毎回再びモーダルが表示され、初期化されたことの目印になることを検証
    await page.reload();
    await expect(welcomeModal).toBeVisible();
    await expect(page.getByRole('heading', { name: 'デモ環境について' })).toBeVisible();
    await startBtn.click();
    await expect(welcomeModal).toBeHidden();
    await page.locator('button:visible', { hasText: '食品・活動' }).first().click();
    await expect(page.getByRole('button', { name: /よく使う食品/ })).toBeVisible();
    await expect(page.getByText('リロード目印検証食品')).toHaveCount(0);

    // 6.5. ブラウザの bfcache 復帰（pagehide -> pageshow with persisted: true）時にもデータが初期状態へリセットされ、案内モーダルが再表示されることを検証
    await page.getByRole('button', { name: '食品を追加' }).click();
    await page.getByPlaceholder('例: 白米、食パン、りんご、カレーライス').fill('bfcache復元検証食品');
    await page.getByPlaceholder('例: 36.8').fill('25');
    await page.getByRole('button', { name: '保存する' }).click();
    await expect(page.getByText('bfcache復元検証食品')).toBeVisible();

    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await expect(welcomeModal).toBeVisible();
    await startBtn.click();
    await expect(welcomeModal).toBeHidden();
    await expect(page.getByText('bfcache復元検証食品')).toHaveCount(0);
    await expect(page.getByText('うどん')).toBeVisible();

    // 7. 背景オーバーレイ（グレー部分）のタップでも閉じられることを検証（デスクトップ 1280x800 でも1画面に収まることを確認）
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload();
    await expect(welcomeModal).toBeVisible();
    await page.screenshot({ path: path.join(screenshotDir, 'welcome-modal-desktop.png') });

    const desktopModalFit = await page.evaluate(() => {
      const dialogCard = document.querySelector('[data-testid="demo-welcome-modal"] > div.relative');
      if (!dialogCard) return null;
      const rect = dialogCard.getBoundingClientRect();
      return {
        fitsVertically: rect.top >= 40 && rect.bottom <= window.innerHeight - 40,
        noHorizontalOverflow:
          document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      };
    });
    expect(desktopModalFit).toEqual({
      fitsVertically: true,
      noHorizontalOverflow: true,
    });

    await page.getByTestId('demo-welcome-backdrop').click({ position: { x: 15, y: 15 } });
    await expect(welcomeModal).toBeHidden();

    // 8. キーボード初期フォーカス・フォーカストラップ（Tab / Shift+Tab でモーダル外へ抜けないこと）・右上の [✕] ボタンおよび Escape キーでも閉じられることを検証
    await page.reload();
    await expect(welcomeModal).toBeVisible();

    const closeIconBtn = page.getByTestId('btn-close-welcome-x');
    await expect(startBtn).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(closeIconBtn).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(startBtn).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    await expect(closeIconBtn).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    await expect(startBtn).toBeFocused();

    await closeIconBtn.click();
    await expect(welcomeModal).toBeHidden();

    await page.reload();
    await expect(welcomeModal).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(welcomeModal).toBeHidden();

    // 9. 通常モード（__CGM_E2E_ALLOW_CSV_IMPORT__ = true）ではデモ案内モーダルが表示されないこと
    await page.addInitScript(() => {
      (window as unknown as Record<string, boolean>).__CGM_E2E_ALLOW_CSV_IMPORT__ = true;
    });
    await page.reload();
    await expect(page.getByText('2026年 8月')).toBeVisible();
    await expect(welcomeModal).toHaveCount(0);
  });

  test('E2E-12: 論理削除済み同名カテゴリの復活（UNIQUE衝突防止）・手動初期化後のデモデータ再ハイドレーション抑止 & 全ID正規UUID検証 @regression', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as Record<string, boolean>).__CGM_E2E_ALLOW_CSV_IMPORT__ = true;
    });
    await page.goto('/');
    await expect(page.getByText('2026年 8月')).toBeVisible();

    // 1. カテゴリ削除後に同じ名前のカテゴリを再追加すると、エラーにならず既存レコードが復活（is_deleted: false）すること
    await page.getByRole('button', { name: '食品・活動' }).first().click();
    await expect(page.getByRole('button', { name: /よく使う食品/ })).toBeVisible();
    await page.getByRole('button', { name: 'カテゴリを編集' }).click();
    await expect(page.getByRole('heading', { name: '食品カテゴリ管理' })).toBeVisible();

    const seasoningRow = page.locator('div.justify-between', {
      has: page.getByText('調味料・その他', { exact: true }),
    });
    await seasoningRow.locator('button[title="削除"]').click();
    await page.getByRole('button', { name: '削除する' }).click();
    await expect(seasoningRow).toHaveCount(0);

    // 同じ「調味料・その他」を再追加して復活することを確認
    await page.getByPlaceholder('新しいカテゴリ名を入力...').fill('調味料・その他');
    await page.getByRole('button', { name: '追加', exact: true }).click();
    await expect(
      page.locator('div.justify-between', {
        has: page.getByText('調味料・その他', { exact: true }),
      })
    ).toBeVisible();
    await page.getByRole('button', { name: '閉じる' }).click();

    // 2. 設定画面で「記録データを初期化」を実行した後、カレンダー・分析画面に遷移してもデモデータが勝手に再ハイドレーションされないこと
    await page.getByRole('button', { name: '設定' }).first().click();
    await expect(page.getByText('データのバックアップ・初期化')).toBeVisible();
    await page.getByRole('button', { name: '記録データを初期化' }).click();
    await page.getByRole('button', { name: '初期化する' }).click();
    await expect(
      page.getByText('血糖・食事・活動の記録データをすべて消去し、よく使う食品・活動を初期状態に戻しました。')
    ).toBeVisible();

    await page.getByRole('button', { name: 'カレンダー' }).first().click();
    const desktopSummary = page.locator('.sticky.top-12 .hidden.sm\\:flex');
    await expect(desktopSummary).toBeVisible();
    expect(parseSummaryCarbs(await desktopSummary.innerText())).toBe(0);
    expect(parseSummaryInsulin(await desktopSummary.innerText())).toBe(0);

    await page.getByRole('button', { name: '分析' }).first().click();
    await expect(page.getByText('血糖・食事の傾向分析')).toBeVisible();

    // 3. バックアップJSONをエクスポートし、シードされた全テーブルIDおよび外部キーが正規UUID形式であることを検証
    await page.getByRole('button', { name: '設定' }).first().click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'バックアップを保存' }).click();
    const download = await downloadPromise;
    const backupFilePath = path.join(os.tmpdir(), `cgm_uuid_e2e_${Date.now()}.json`);
    await download.saveAs(backupFilePath);

    const backupContent = JSON.parse(fs.readFileSync(backupFilePath, 'utf8'));
    fs.unlinkSync(backupFilePath);

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(backupContent.libreReadings).toHaveLength(0);
    expect(backupContent.events).toHaveLength(0);
    expect(backupContent.categories.length).toBeGreaterThan(0);
    expect(backupContent.foodMaster.length).toBeGreaterThan(0);
    expect(backupContent.eventMaster.length).toBeGreaterThan(0);

    for (const c of backupContent.categories) {
      expect(c.id).toMatch(uuidRegex);
    }
    for (const f of backupContent.foodMaster) {
      expect(f.id).toMatch(uuidRegex);
      expect(f.category_id).toMatch(uuidRegex);
    }
    for (const em of backupContent.eventMaster) {
      expect(em.id).toMatch(uuidRegex);
      expect(em.category_id).toMatch(uuidRegex);
    }
  });

  test('E2E-13: 本番認証ゲート（AuthGateScreen）による未ログイン画面完全ロック & クイックガイド表示検証 @regression', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as Record<string, boolean>).__CGM_E2E_ENABLE_CLOUD_AUTH__ = true;
    });
    await page.goto('/');

    // 1. 専用ログイン画面（AuthGateScreen）が表示され、招待制バッジが確認できること
    await expect(page.getByTestId('auth-gate-screen')).toBeVisible();
    await expect(
      page.getByText('招待制・プライベート保護（本人・招待家族専用）')
    ).toBeVisible();

    // 2. カレンダー画面・ヘッダーナビ・ボトムナビがDOM上に一切描画されていないこと（完全ロック検証）
    await expect(page.getByText('2026年 8月')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'カレンダー' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '食品・活動' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '分析' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '設定' })).toHaveCount(0);

    // 3. はじめてご利用になる方・招待されたご家族の手順（クイックガイド）アコーディオンが開閉できること
    await expect(page.getByTestId('auth-gate-quick-guide')).toHaveCount(0);
    await page.getByTestId('auth-gate-quick-guide-toggle').click();
    await expect(page.getByTestId('auth-gate-quick-guide')).toBeVisible();
    await expect(page.getByText('1. 患者ご本人（オーナー）のログイン')).toBeVisible();
    await expect(
      page.getByText('2. 招待されたご家族の初回登録・ログイン手順')
    ).toBeVisible();
    await expect(page.getByText('3. セキュリティとログアウト時の保護')).toBeVisible();

    await page.getByTestId('auth-gate-quick-guide-toggle').click();
    await expect(page.getByTestId('auth-gate-quick-guide')).toHaveCount(0);
  });

  test('E2E-14: パスワード複雑性ポリシー（案B：8文字以上＋英大文字・英小文字・数字・記号必須）のリアルタイムUI検証 & 登録ブロック検証 @regression', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as Record<string, boolean>).__CGM_E2E_ENABLE_CLOUD_AUTH__ = true;
    });
    await page.goto('/');
    await expect(page.getByTestId('auth-gate-screen')).toBeVisible();

    // 1. 「新規アカウント登録」タブに切り替えると5項目のパスワード要件チェックリストが表示されること
    await page.getByRole('button', { name: '新規アカウント登録' }).click();
    await expect(page.getByTestId('auth-gate-password-checklist')).toBeVisible();

    const reqMinLength = page.getByTestId('pwd-req-minLength');
    const reqUpper = page.getByTestId('pwd-req-hasUpper');
    const reqLower = page.getByTestId('pwd-req-hasLower');
    const reqDigit = page.getByTestId('pwd-req-hasDigit');
    const reqSymbol = page.getByTestId('pwd-req-hasSymbol');
    const submitBtn = page.getByTestId('auth-gate-submit');

    await expect(reqMinLength).toHaveAttribute('data-satisfied', 'false');
    await expect(reqUpper).toHaveAttribute('data-satisfied', 'false');
    await expect(reqLower).toHaveAttribute('data-satisfied', 'false');
    await expect(reqDigit).toHaveAttribute('data-satisfied', 'false');
    await expect(reqSymbol).toHaveAttribute('data-satisfied', 'false');
    await expect(submitBtn).toBeDisabled();

    await page.locator('#auth-gate-email').fill('owner@example.com');
    const pwdInput = page.locator('#auth-gate-password');

    // 2. 弱いパスワード①（大文字・記号欠落: password123）で未達成バッジ＆警告が表示され登録ボタンがdisabledのままブロックされること
    await pwdInput.fill('password123');
    await expect(reqMinLength).toHaveAttribute('data-satisfied', 'true');
    await expect(reqLower).toHaveAttribute('data-satisfied', 'true');
    await expect(reqDigit).toHaveAttribute('data-satisfied', 'true');
    await expect(reqUpper).toHaveAttribute('data-satisfied', 'false');
    await expect(reqSymbol).toHaveAttribute('data-satisfied', 'false');
    await expect(page.getByTestId('auth-gate-password-warning')).toBeVisible();
    await expect(submitBtn).toBeDisabled();

    // 3. 弱いパスワード②（記号のみ欠落: Abcdef12）
    await pwdInput.fill('Abcdef12');
    await expect(reqMinLength).toHaveAttribute('data-satisfied', 'true');
    await expect(reqUpper).toHaveAttribute('data-satisfied', 'true');
    await expect(reqLower).toHaveAttribute('data-satisfied', 'true');
    await expect(reqDigit).toHaveAttribute('data-satisfied', 'true');
    await expect(reqSymbol).toHaveAttribute('data-satisfied', 'false');
    await expect(page.getByTestId('auth-gate-password-warning')).toContainText('記号');
    await expect(submitBtn).toBeDisabled();

    // 4. 弱いパスワード③（7文字で文字数不足: Ab1!xyz）
    await pwdInput.fill('Ab1!xyz');
    await expect(reqMinLength).toHaveAttribute('data-satisfied', 'false');
    await expect(reqUpper).toHaveAttribute('data-satisfied', 'true');
    await expect(reqLower).toHaveAttribute('data-satisfied', 'true');
    await expect(reqDigit).toHaveAttribute('data-satisfied', 'true');
    await expect(reqSymbol).toHaveAttribute('data-satisfied', 'true');
    await expect(page.getByTestId('auth-gate-password-warning')).toContainText('8文字以上');
    await expect(submitBtn).toBeDisabled();

    // 5. 案B準拠の強いパスワード（8文字以上＋大文字・小文字・数字・記号すべて含む: StrongPass1!）で全5項目達成＆登録ボタン有効化
    await pwdInput.fill('StrongPass1!');
    await expect(reqMinLength).toHaveAttribute('data-satisfied', 'true');
    await expect(reqUpper).toHaveAttribute('data-satisfied', 'true');
    await expect(reqLower).toHaveAttribute('data-satisfied', 'true');
    await expect(reqDigit).toHaveAttribute('data-satisfied', 'true');
    await expect(reqSymbol).toHaveAttribute('data-satisfied', 'true');
    await expect(page.getByTestId('auth-gate-password-warning')).toHaveCount(0);
    await expect(submitBtn).toBeEnabled();
  });
});

