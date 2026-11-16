/**
 * AI オーケストレーション 一気通貫パイプライン実行エンジン (orchestrate-pipeline.mjs)
 *
 * 目的:
 * コード修正 → DDD仕様書同期検査 → 3層TypeScript型検査 → 単体・統合テスト → 本番/デモビルド →
 * Playwright E2E回帰テスト & スクリーンショットデザイン検査 → 原子的 Git Commit/Push までを
 * 安全に自動実行する（Cloudflare Pages へのデプロイは GitHub Actions CD に一本化）。
 *
 * 2系統ターゲット対応 (personal / demo):
 * - 中間確認 (test:docs / typecheck / npm test / test:smoke のみ。ビルド・E2E・撮影なし):
 *   npm run pipeline:verify:quick
 * - 検証＆スクリーンショット撮影のみ:
 *   npm run pipeline:verify
 * - 本番アプリ (Privateリポジトリ origin への検証・Commit・Push → GitHub Actions CD でデプロイ):
 *   npm run pipeline:ship:personal -- --message "feat(personal): ..."
 * - デモ公開アプリ (Publicリポジトリ public-demo への検証・Commit・Push → GitHub Actions CD でデプロイ):
 *   npm run pipeline:ship:demo -- --message "feat(demo): ..."
 * - 緊急手動デプロイ (GitHub Secrets 未設定時のみ。main / demo-public ブランチ強制ガード付き):
 *   npm run pipeline:ship:personal -- --local-deploy --message "feat(personal): ..."
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const SCRATCH_DIR = path.join(ROOT_DIR, '.agents', 'scratch');
const SUMMARY_PATH = path.join(SCRATCH_DIR, 'pipeline-last-run.json');

const args = process.argv.slice(2);
const isShipMode = args.includes('--ship');
const useLocalDeploy = args.includes('--local-deploy') && !args.includes('--no-deploy');
const skipVisual = args.includes('--skip-visual');
// 中間確認用の軽量モード: test:docs + typecheck + npm test + test:smoke のみ (ビルド・E2E・撮影なし)
const isQuickMode = args.includes('--quick');

function getArgValue(flag) {
  const exactIdx = args.indexOf(flag);
  if (exactIdx !== -1 && exactIdx + 1 < args.length) {
    return args[exactIdx + 1];
  }
  const prefix = `${flag}=`;
  const inlineArg = args.find((a) => a.startsWith(prefix));
  if (inlineArg) {
    return inlineArg.slice(prefix.length);
  }
  return null;
}

function getCurrentBranch() {
  return execSync('git rev-parse --abbrev-ref HEAD', {
    encoding: 'utf8',
    cwd: ROOT_DIR,
  }).trim();
}

const currentBranchOnStart = getCurrentBranch();
const explicitTarget = getArgValue('--target');
const targetEnv =
  explicitTarget === 'demo' || explicitTarget === 'personal'
    ? explicitTarget
    : currentBranchOnStart === 'demo-public'
      ? 'demo'
      : 'personal';

const commitMessage =
  getArgValue('--message') ||
  getArgValue('-m') ||
  `chore(${targetEnv}): sync implementation, specifications, and visual verification`;

function ensureScratchDir() {
  if (!fs.existsSync(SCRATCH_DIR)) {
    fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  }
}

function runStep(stepId, title, command, stepLogs, extraEnv = {}) {
  console.log(`\n------------------------------------------------------`);
  console.log(`▶️ [${stepId}] ${title}`);
  console.log(`   $ ${command}`);
  console.log(`------------------------------------------------------`);
  const start = Date.now();
  try {
    execSync(command, {
      stdio: 'inherit',
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        GOMAXPROCS: process.env.GOMAXPROCS || '1',
        GOMEMLIMIT: process.env.GOMEMLIMIT || '256MiB',
        NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=1024',
        ...extraEnv,
      },
    });
    const durationMs = Date.now() - start;
    console.log(`✅ [${stepId}] PASSED (${(durationMs / 1000).toFixed(1)}s)`);
    stepLogs.push({ stepId, title, command, status: 'PASSED', durationMs });
  } catch (err) {
    const durationMs = Date.now() - start;
    console.error(`❌ [${stepId}] FAILED after ${(durationMs / 1000).toFixed(1)}s`);
    stepLogs.push({
      stepId,
      title,
      command,
      status: 'FAILED',
      durationMs,
      error: err.message,
    });
    throw err;
  }
}

function hasUncommittedChanges() {
  const out = execSync('git status --porcelain', { encoding: 'utf8', cwd: ROOT_DIR }).trim();
  return out.length > 0;
}

function hasRemote(remoteName) {
  try {
    const out = execSync('git remote', { encoding: 'utf8', cwd: ROOT_DIR })
      .split(/\r?\n/)
      .map((s) => s.trim());
    return out.includes(remoteName);
  } catch {
    return false;
  }
}

const FORBIDDEN_TRACKED_PATHS = [
  'legacy_vba',
  'docs/VBA_Project',
  'docs/screenshot',
  'docs/動画作成用資料',
];

const ALLOWED_UNTRACKED_PATTERN =
  /^(?:src|public|functions|supabase|scripts|e2e|docs\/Web_Project|\.agents\/(?:skills|hooks)|\.github)\/|^(?:README\.md|AGENTS\.md|\.agents\/AGENTS\.md|\.agents\/hooks\.json|package\.json|package-lock\.json|tsconfig.*\.json|vite\.config\.ts|vitest\.config\.ts|playwright\.config\.ts|wrangler\.toml|\.nvmrc|\.gitignore)$/;

/**
 * 旧VBA資産・旧スクリーンショット・個人メモや意図しない未追跡データファイルが Git に混入しないこと、
 * およびローカル直接デプロイ時の対象ブランチ制約を強制検証する
 */
function verifyForbiddenAssetIsolation(stepLogs, options = {}) {
  const { requireDemoBranch = false, requirePersonalMainBranch = false } = options;
  const branch = getCurrentBranch();

  if (requireDemoBranch && branch !== 'demo-public') {
    const msg = `[Security Guard] --target=demo requires current branch to be "demo-public", but found "${branch}". Switch to demo-public before shipping to the public repository.`;
    stepLogs.push({
      stepId: 'PHASE-0-GUARD',
      title: 'Public Demo Branch & Asset Isolation Guard',
      status: 'FAILED',
      error: msg,
    });
    throw new Error(msg);
  }

  if (requirePersonalMainBranch && branch !== 'main') {
    const msg = `[Security Guard] --local-deploy with --target=personal requires current branch to be "main", but found "${branch}". Merge into main first so unmerged topic branches never overwrite production.`;
    stepLogs.push({
      stepId: 'PHASE-0-GUARD',
      title: 'Production Main Branch Guard',
      status: 'FAILED',
      error: msg,
    });
    throw new Error(msg);
  }

  for (const forbiddenDir of FORBIDDEN_TRACKED_PATHS) {
    const tracked = execSync(`git ls-files "${forbiddenDir}"`, {
      encoding: 'utf8',
      cwd: ROOT_DIR,
    }).trim();
    if (tracked.length > 0) {
      const msg = `[Security Guard] Forbidden legacy/private assets under "${forbiddenDir}/" are tracked on branch "${branch}". Untrack them with 'git rm -rf --cached "${forbiddenDir}"' and ensure .gitignore excludes them.`;
      stepLogs.push({
        stepId: 'PHASE-0-GUARD',
        title: 'Legacy VBA & Private Asset Isolation Guard',
        status: 'FAILED',
        error: msg,
      });
      throw new Error(msg);
    }
  }

  // git add -A 実行時の個人実測データ (.csv/.xlsm/.db/.env/public/data/*) や想定外ディレクトリの誤ステージング防止
  const statusLines = execSync('git status --porcelain', {
    encoding: 'utf8',
    cwd: ROOT_DIR,
  })
    .split(/\r?\n/)
    .filter((l) => l.startsWith('?? '));
  for (const line of statusLines) {
    const rawPath = line.slice(3).trim().replace(/^"(.*)"$/, '$1').replace(/\\+/g, '/');
    if (
      /\.(?:csv|xlsm|xlsx|db|sqlite|pem|key)$/i.test(rawPath) ||
      /(?:^|\/)\.env/i.test(rawPath) ||
      /^public\/data\//i.test(rawPath) ||
      !ALLOWED_UNTRACKED_PATTERN.test(rawPath)
    ) {
      const msg = `[Security Guard] Unexpected untracked file/directory "${rawPath}" detected. Add it to .gitignore or move to .agents/scratch/ before running ship/verify.`;
      stepLogs.push({
        stepId: 'PHASE-0-GUARD',
        title: 'Untracked File Safety Guard',
        status: 'FAILED',
        error: msg,
      });
      throw new Error(msg);
    }
  }

  console.log(
    `✅ [PHASE-0-GUARD] Branch ("${branch}") & zero legacy VBA / private asset tracking verified.`
  );
  stepLogs.push({
    stepId: 'PHASE-0-GUARD',
    title: requireDemoBranch
      ? 'Public Demo Branch & Asset Isolation Guard'
      : 'Legacy VBA & Private Asset Isolation Guard',
    status: 'PASSED',
    durationMs: 0,
  });
}

function main() {
  ensureScratchDir();
  const pipelineStart = Date.now();
  const stepLogs = [];

  console.log(`\n======================================================`);
  console.log(`🤖 Starting AI Orchestration Automated Pipeline`);
  console.log(
    `   Mode   : ${
      isShipMode
        ? useLocalDeploy
          ? '🚀 VERIFY + GIT PUSH + EMERGENCY LOCAL DEPLOY (--ship --local-deploy)'
          : '🚀 VERIFY + GIT PUSH -> GITHUB ACTIONS CD (--ship)'
        : isQuickMode
          ? '⚡ QUICK VERIFY (docs / typecheck / tests / smoke)'
          : '🔍 VERIFY & VISUAL TEST ONLY'
    }`
  );
  console.log(
    `   Target : ${
      targetEnv === 'demo'
        ? '🌐 PUBLIC DEMO (portfolio)'
        : '🔒 PERSONAL PRODUCTION (personal)'
    }`
  );
  console.log(`   Branch : ${currentBranchOnStart}`);
  console.log(`======================================================`);

  if (isQuickMode && isShipMode) {
    console.error(
      `\n❌ --quick はビルド・E2E・画面撮影を省くため、--ship と併用できません。出荷時は総合検査を実行してください。`
    );
    process.exit(1);
  }

  try {
    verifyForbiddenAssetIsolation(stepLogs, {
      requireDemoBranch: isShipMode && targetEnv === 'demo',
      requirePersonalMainBranch: isShipMode && useLocalDeploy && targetEnv === 'personal',
    });

    // Phase 1: DDD Specification Sync, Security & UX Terminology Gate + Production Dependency Audit
    runStep(
      'PHASE-1A',
      'DDD Specification Sync & Security/UX Gate',
      'npm run test:docs',
      stepLogs
    );
    runStep(
      'PHASE-1B',
      'Production Dependency Vulnerability Audit',
      'npm run audit:prod',
      stepLogs
    );

    // Phase 2: 3-Layer TypeScript Strict Typecheck (Frontend + Workers BFF + Playwright E2E)
    runStep(
      'PHASE-2',
      '3-Layer TypeScript Strict Typecheck (src + functions + e2e)',
      'npm run typecheck',
      stepLogs
    );

    // Phase 3: Clinical Calculation Unit Tests + Cross-Screen Data Integrity Integration Tests
    runStep(
      'PHASE-3',
      'Clinical Calculation & Data Integrity Tests (Unit + Integration)',
      'npm test',
      stepLogs
    );

    // Phase 3B: Runtime Dev Server Smoke Test (All 56 Module Endpoints)
    runStep(
      'PHASE-3B',
      'Vite Dev Server Runtime Smoke Test (56 Endpoints)',
      'npm run test:smoke',
      stepLogs
    );

    // Quick mode stops here (no build / E2E / visual audit)
    if (isQuickMode) {
      const totalDurationMs = Date.now() - pipelineStart;
      fs.writeFileSync(
        SUMMARY_PATH,
        JSON.stringify(
          {
            completedAt: new Date().toISOString(),
            mode: 'quick',
            target: targetEnv,
            branch: getCurrentBranch(),
            overallStatus: 'SUCCESS',
            totalDurationMs,
            steps: stepLogs,
          },
          null,
          2
        ),
        'utf8'
      );
      console.log(`\n======================================================`);
      console.log(
        `⚡ Quick Verify Succeeded in ${(totalDurationMs / 1000).toFixed(1)}s (build / E2E / visual audit skipped).`
      );
      console.log(
        `   出荷前は npm run pipeline:verify または pipeline:ship:* で総合検査を実行してください。`
      );
      console.log(`======================================================\n`);
      return;
    }

    // Phase 4: Portfolio Bundle Build (typecheck already passed in PHASE-2)
    runStep(
      'PHASE-4A',
      'Portfolio Bundle Build (VITE_APP_MODE=portfolio)',
      'npm run build:vite:portfolio',
      stepLogs
    );

    // Phase 5A: Playwright E2E Regression Suite
    runStep(
      'PHASE-5A',
      'Playwright E2E Regression Suite (@regression)',
      'npm run test:e2e:regression',
      stepLogs
    );

    // Phase 5B: Playwright Visual Screenshot & Layout Audit Suite
    if (!skipVisual) {
      runStep(
        'PHASE-5B',
        'Playwright Screenshot Capture & Multimodal Layout Audit (@visual)',
        'npm run test:visual',
        stepLogs
      );
    }

    // Phase 5C: If target is personal production, build the final personal bundle into dist/
    if (targetEnv === 'personal') {
      // Allow OS to reclaim Chromium virtual memory commit charge after Playwright finishes
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
      runStep(
        'PHASE-5C',
        'Personal Production Bundle Build (VITE_APP_MODE=personal)',
        'npm run build:vite:personal',
        stepLogs,
        useLocalDeploy ? { REQUIRE_SUPABASE_ENV: '1' } : {}
      );
    }

    // Phase 6: Atomic Commit & Git Push (Cloudflare Pages deploy is unified in GitHub Actions CD)
    if (isShipMode) {
      if (hasUncommittedChanges()) {
        runStep('PHASE-6A', 'Stage All Updated Code & Specs', 'git add -A', stepLogs);
        const safeMsg = commitMessage.replace(/"/g, '\\"');
        // PHASE-3 で npm test 通過済みのため、pre-commit フックでの重複実行のみ省略する
        runStep(
          'PHASE-6B',
          'Create Atomic Git Commit',
          `git commit -m "${safeMsg}"`,
          stepLogs,
          { PIPELINE_TESTS_PASSED: '1' }
        );
      } else {
        console.log(`\nℹ️ [PHASE-6A/B] Working tree is already clean. Proceeding to push.`);
      }

      const branch = getCurrentBranch();

      if (targetEnv === 'demo') {
        if (hasRemote('public-demo')) {
          runStep(
            'PHASE-6C-PUBLIC',
            'Push Clean Demo Branch (demo-public -> main) to Public Repository (public-demo)',
            'git push -u public-demo demo-public:main',
            stepLogs
          );
        }
        runStep(
          'PHASE-6C-BACKUP',
          `Backup Branch (${branch}) to Private Origin`,
          `git push -u origin ${branch}`,
          stepLogs
        );
        if (useLocalDeploy) {
          runStep(
            'PHASE-6D',
            'Emergency Local Deploy Portfolio Demo Bundle to Cloudflare Pages (cgm-diabetes-manager-demo)',
            'npm run pages:deploy:demo',
            stepLogs
          );
        } else {
          console.log(
            `\nℹ️ [PHASE-6D] Cloudflare Pages deployment is delegated to GitHub Actions CD on public-demo.`
          );
        }
      } else {
        runStep(
          'PHASE-6C',
          `Push Branch (${branch}) to Private Origin`,
          `git push -u origin ${branch}`,
          stepLogs
        );
        if (useLocalDeploy) {
          runStep(
            'PHASE-6D',
            'Emergency Local Deploy Personal Production Bundle to Cloudflare Pages (cgm-diabetes-manager-personal)',
            'npm run pages:deploy:personal',
            stepLogs
          );
        } else {
          console.log(
            `\nℹ️ [PHASE-6D] Cloudflare Pages deployment is unified in GitHub Actions CD (triggers automatically when pushed to main).`
          );
        }
      }
    }

    const totalDurationMs = Date.now() - pipelineStart;
    const summary = {
      completedAt: new Date().toISOString(),
      mode: isShipMode ? 'ship' : 'verify',
      localDeploy: useLocalDeploy,
      target: targetEnv,
      branch: getCurrentBranch(),
      overallStatus: 'SUCCESS',
      totalDurationMs,
      steps: stepLogs,
    };
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8');

    console.log(`\n======================================================`);
    console.log(
      `🎉 AI Orchestration Pipeline (${targetEnv}) Succeeded in ${(totalDurationMs / 1000).toFixed(1)}s!`
    );
    console.log(`📄 Summary Report: .agents/scratch/pipeline-last-run.json`);
    if (!skipVisual) {
      console.log(`📸 Visual Audit Report: .agents/scratch/screenshots/visual-audit-report.json`);
    }
    console.log(`======================================================\n`);
  } catch (err) {
    const totalDurationMs = Date.now() - pipelineStart;
    const summary = {
      completedAt: new Date().toISOString(),
      mode: isShipMode ? 'ship' : 'verify',
      localDeploy: useLocalDeploy,
      target: targetEnv,
      branch: getCurrentBranch(),
      overallStatus: 'FAILED',
      totalDurationMs,
      steps: stepLogs,
    };
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8');

    console.error(`\n💥 AI Orchestration Pipeline ABORTED due to failure.`);
    console.error(`📄 Check details in .agents/scratch/pipeline-last-run.json\n`);
    process.exit(1);
  }
}

main();
