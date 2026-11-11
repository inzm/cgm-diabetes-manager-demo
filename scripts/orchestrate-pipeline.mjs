/**
 * AI オーケストレーション 一気通貫パイプライン実行エンジン (orchestrate-pipeline.mjs)
 *
 * 目的:
 * コード修正 → DDD仕様書同期検査 → TypeScript型検査 → 単体テスト → 本番/デモビルド →
 * Playwright E2E回帰テスト & スクリーンショットデザイン検査 → Git Commit/Push →
 * Cloudflare Pages デプロイまでをノンストップかつ安全に自動実行する。
 *
 * 2系統ターゲット対応 (personal / demo):
 * - 検証＆スクリーンショット撮影のみ:
 *   npm run pipeline:verify
 * - 本番アプリ (Privateリポジトリ origin + cgm-diabetes-manager-personal) の検証・Push・デプロイ:
 *   npm run pipeline:ship:personal -- --message "feat(personal): ..."
 * - デモ公開アプリ (Publicリポジトリ public-demo + cgm-diabetes-manager-demo) の検証・Push・デプロイ:
 *   npm run pipeline:ship:demo -- --message "feat(demo): ..."
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const SCRATCH_DIR = path.join(ROOT_DIR, '.agents', 'scratch');
const SUMMARY_PATH = path.join(SCRATCH_DIR, 'pipeline-last-run.json');

const args = process.argv.slice(2);
const isShipMode = args.includes('--ship');
const skipDeploy = args.includes('--no-deploy');
const skipVisual = args.includes('--skip-visual');

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

function runStep(stepId, title, command, stepLogs) {
  console.log(`\n------------------------------------------------------`);
  console.log(`▶️ [${stepId}] ${title}`);
  console.log(`   $ ${command}`);
  console.log(`------------------------------------------------------`);
  const start = Date.now();
  try {
    execSync(command, { stdio: 'inherit', cwd: ROOT_DIR });
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

/**
 * Public デモ出荷時のセキュリティ・プライバシー強制ガード
 * 1. ブランチが `demo-public` であること（本番用 `main` の履歴ごと Public へ誤Pushすることを防止）
 * 2. `legacy_vba/` 配下のファイルが Git インデックスに含まれていないこと
 */
function verifyDemoPublicSafetyGuard(stepLogs) {
  const branch = getCurrentBranch();
  if (branch !== 'demo-public') {
    const msg = `[Security Guard] --target=demo requires current branch to be "demo-public", but found "${branch}". Switch to demo-public before shipping to the public repository.`;
    stepLogs.push({
      stepId: 'PHASE-0-GUARD',
      title: 'Public Demo Branch & Asset Isolation Guard',
      status: 'FAILED',
      error: msg,
    });
    throw new Error(msg);
  }

  const trackedLegacyFiles = execSync('git ls-files legacy_vba', {
    encoding: 'utf8',
    cwd: ROOT_DIR,
  }).trim();
  if (trackedLegacyFiles.length > 0) {
    const msg = `[Security Guard] legacy_vba/ files are still tracked on branch "${branch}". Remove them with "git rm -rf --cached legacy_vba" before pushing to public-demo.`;
    stepLogs.push({
      stepId: 'PHASE-0-GUARD',
      title: 'Public Demo Branch & Asset Isolation Guard',
      status: 'FAILED',
      error: msg,
    });
    throw new Error(msg);
  }

  console.log(`✅ [PHASE-0-GUARD] Public demo branch ("demo-public") & zero legacy_vba tracking verified.`);
  stepLogs.push({
    stepId: 'PHASE-0-GUARD',
    title: 'Public Demo Branch & Asset Isolation Guard',
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
  console.log(`   Mode   : ${isShipMode ? '🚀 VERIFY + GIT PUSH + DEPLOY (--ship)' : '🔍 VERIFY & VISUAL TEST ONLY'}`);
  console.log(`   Target : ${targetEnv === 'demo' ? '🌐 PUBLIC DEMO (portfolio)' : '🔒 PERSONAL PRODUCTION (personal)'}`);
  console.log(`   Branch : ${currentBranchOnStart}`);
  console.log(`======================================================`);

  try {
    if (isShipMode && targetEnv === 'demo') {
      verifyDemoPublicSafetyGuard(stepLogs);
    }

    // Phase 1: DDD Specification Sync, Security & UX Terminology Gate
    runStep(
      'PHASE-1',
      'DDD Specification Sync & Security/UX Gate',
      'npm run test:docs',
      stepLogs
    );

    // Phase 2: TypeScript Strict Typecheck
    runStep('PHASE-2', 'TypeScript Strict Typecheck', 'npm run typecheck', stepLogs);

    // Phase 3: Clinical & Data Integrity Unit Tests
    runStep('PHASE-3', 'Clinical & Data Integrity Unit Tests', 'npm test', stepLogs);

    // Phase 4: Portfolio Bundle Build (for E2E & Visual Regression Suite)
    runStep(
      'PHASE-4A',
      'Portfolio Bundle Build (VITE_APP_MODE=portfolio)',
      'npm run build:portfolio',
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
      runStep(
        'PHASE-5C',
        'Personal Production Bundle Build (VITE_APP_MODE=personal)',
        'npm run build:personal',
        stepLogs
      );
    }

    // Phase 6: Non-stop Atomic Commit, Git Push & Cloudflare Pages Deployment
    if (isShipMode) {
      if (hasUncommittedChanges()) {
        runStep('PHASE-6A', 'Stage All Updated Code & Specs', 'git add -A', stepLogs);
        const safeMsg = commitMessage.replace(/"/g, '\\"');
        runStep(
          'PHASE-6B',
          'Create Atomic Git Commit',
          `git commit -m "${safeMsg}"`,
          stepLogs
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
        if (!skipDeploy) {
          runStep(
            'PHASE-6D',
            'Deploy Portfolio Demo Bundle to Cloudflare Pages (cgm-diabetes-manager-demo)',
            'npm run pages:deploy:demo',
            stepLogs
          );
        }
      } else {
        runStep(
          'PHASE-6C',
          `Push Branch (${branch}) to Private Origin`,
          `git push -u origin ${branch}`,
          stepLogs
        );
        if (!skipDeploy) {
          runStep(
            'PHASE-6D',
            'Deploy Personal Production Bundle to Cloudflare Pages (cgm-diabetes-manager-personal)',
            'npm run pages:deploy:personal',
            stepLogs
          );
        }
      }
    }

    const totalDurationMs = Date.now() - pipelineStart;
    const summary = {
      completedAt: new Date().toISOString(),
      mode: isShipMode ? 'ship' : 'verify',
      target: targetEnv,
      branch: getCurrentBranch(),
      overallStatus: 'SUCCESS',
      totalDurationMs,
      steps: stepLogs,
    };
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8');

    console.log(`\n======================================================`);
    console.log(`🎉 AI Orchestration Pipeline (${targetEnv}) Succeeded in ${(totalDurationMs / 1000).toFixed(1)}s!`);
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
