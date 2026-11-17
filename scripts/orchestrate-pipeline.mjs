/**
 * AI オーケストレーション 一気通貫パイプライン実行エンジン (orchestrate-pipeline.mjs)
 *
 * 目的:
 * DDD仕様書同期検査 → 4プロジェクト並列TypeScript型検査 → 単体・統合テスト (src + scripts) →
 * 分離出力ビルド (`dist-portfolio` + `dist-personal`) → 2プロジェクト隔離 Playwright E2E 回帰 &
 * 11画面デザイン監査 → 明示ステージング検証・原子的 Git Commit / Push までを安全に自動実行する。
 *
 * 設計上の安全原則:
 * - `git add -A` は完全廃止。`--ship` 時に未ステージ変更または未追跡ファイルが残っている場合は即座に中断し、
 *   明示的に `git add` された変更のみをコミットする（クリーンな HEAD のまま Push のみ行うことも可能）。
 * - `--target=demo` 出荷時は Working Tree (`main`) を一切切り替えず、`rebuild-demo-branch.mjs` で
 *   `demo-public` 上に Fast-Forward 子コミットを生成し、`public-demo` の `release/demo` ブランチで
 *   Ruleset 27410303 の必須 CI ステータスチェック通過を確認してから `main` へ Fast-Forward 昇格する。
 */

import { execFileSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCleanDemoCommit } from './rebuild-demo-branch.mjs';

const ROOT_DIR = process.cwd();
const SCRATCH_DIR = path.join(ROOT_DIR, '.agents', 'scratch');
const SUMMARY_PATH = path.join(SCRATCH_DIR, 'pipeline-last-run.json');
const VERIFY_STAMP_PATH = path.join(SCRATCH_DIR, 'verify-stamp.json');
const VERIFY_STAMP_TTL_MS = 15 * 60 * 1000;
const PUBLIC_DEMO_GH_REPO = process.env.PUBLIC_DEMO_GH_REPO || 'inzm/cgm-diabetes-manager-demo';

/**
 * 一時 GIT_INDEX_FILE を用いてメインの `.git/index` を一切変更せずに Working Tree 全体の決定論的ツリーSHAを算出する
 */
export function computeWorktreeVerifyFingerprint(target, cwd = ROOT_DIR) {
  const tmpIdx = path.join(
    os.tmpdir(),
    `cgm_verify_stamp_idx_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );
  try {
    const headSha = execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim();
    const idxEnv = { ...process.env, GIT_INDEX_FILE: tmpIdx };
    execFileSync('git', ['read-tree', 'HEAD'], { cwd, env: idxEnv, stdio: 'ignore' });
    execFileSync('git', ['add', '--all'], { cwd, env: idxEnv, stdio: 'ignore' });
    const worktreeTreeSha = execFileSync('git', ['write-tree'], {
      cwd,
      env: idxEnv,
      encoding: 'utf8',
    }).trim();

    const envHasher = crypto.createHash('sha256');
    for (const envName of ['.env', '.env.local', '.env.personal', '.env.portfolio']) {
      const p = path.join(cwd, envName);
      if (fs.existsSync(p)) {
        envHasher.update(`${envName}:`);
        envHasher.update(fs.readFileSync(p));
        envHasher.update('\n');
      }
    }
    envHasher.update(`VITE_SUPABASE_URL=${process.env.VITE_SUPABASE_URL || ''}\n`);

    return {
      worktreeTreeSha,
      headSha,
      targetEnv: target,
      envHash: envHasher.digest('hex').slice(0, 16),
    };
  } finally {
    if (fs.existsSync(tmpIdx)) {
      fs.unlinkSync(tmpIdx);
    }
  }
}

export function isVerifyStampReusable(
  stamp,
  currentFp,
  nowMs = Date.now(),
  ttlMs = VERIFY_STAMP_TTL_MS
) {
  if (!stamp || !currentFp) return false;
  if (typeof stamp.verifiedAtMs !== 'number' || nowMs - stamp.verifiedAtMs > ttlMs) return false;
  if (nowMs < stamp.verifiedAtMs) return false;
  return (
    stamp.worktreeTreeSha === currentFp.worktreeTreeSha &&
    stamp.headSha === currentFp.headSha &&
    stamp.targetEnv === currentFp.targetEnv &&
    stamp.envHash === currentFp.envHash &&
    stamp.skipVisual === false
  );
}

/**
 * 出荷モード (`--ship`) における明示的ステージング整合性検査（無差別ステージング完全廃止）
 */
export function evaluateShipStagingState(state) {
  const staged = Array.isArray(state?.stagedFiles) ? state.stagedFiles : [];
  const unstaged = Array.isArray(state?.unstagedFiles) ? state.unstagedFiles : [];
  const untracked = Array.isArray(state?.untrackedFiles) ? state.untrackedFiles : [];

  if (unstaged.length > 0 || untracked.length > 0) {
    const details = [
      ...(unstaged.length > 0 ? [`unstaged (${unstaged.length}): ${unstaged.join(', ')}`] : []),
      ...(untracked.length > 0 ? [`untracked (${untracked.length}): ${untracked.join(', ')}`] : []),
    ].join(' | ');
    return {
      ok: false,
      action: 'abort',
      reason: `[Explicit Staging Guard] --ship requires zero unstaged/untracked files (${details}). Stage intended files explicitly with "git add <files>" (or move scratch files to .agents/scratch/) before shipping.`,
    };
  }

  if (staged.length > 0) {
    return { ok: true, action: 'commit_staged', reason: null };
  }
  return { ok: true, action: 'push_clean_head', reason: null };
}

function readGitStagingSnapshot(cwd = ROOT_DIR) {
  const splitLines = (raw) =>
    raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  const stagedFiles = splitLines(
    execSync('git -c core.quotePath=false diff --cached --name-only', { cwd, encoding: 'utf8' })
  );
  const unstagedFiles = splitLines(
    execSync('git -c core.quotePath=false diff --name-only', { cwd, encoding: 'utf8' })
  );
  const untrackedFiles = splitLines(
    execSync('git -c core.quotePath=false ls-files --others --exclude-standard', {
      cwd,
      encoding: 'utf8',
    })
  );
  return { stagedFiles, unstagedFiles, untrackedFiles };
}

function hasConfiguredPersonalSupabaseEnv(cwd = ROOT_DIR) {
  if (process.env.VITE_SUPABASE_URL && process.env.VITE_SUPABASE_ANON_KEY) {
    return true;
  }
  for (const envName of ['.env.personal.local', '.env.local', '.env.personal', '.env']) {
    const full = path.join(cwd, envName);
    if (!fs.existsSync(full)) continue;
    const content = fs.readFileSync(full, 'utf8');
    if (
      /^VITE_SUPABASE_URL\s*=\s*https:\/\/.+/m.test(content) &&
      /^VITE_SUPABASE_ANON_KEY\s*=\s*\S+/m.test(content)
    ) {
      return true;
    }
  }
  return false;
}

const args = process.argv.slice(2);
const isShipMode = args.includes('--ship');
const useLocalDeploy = args.includes('--local-deploy') && !args.includes('--no-deploy');
const skipVisual = args.includes('--skip-visual');
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
        NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=768',
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
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
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

function getRemoteHeadSha(remoteName, refName) {
  try {
    const out = execFileSync('git', ['ls-remote', remoteName, refName], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
    }).trim();
    if (!out) return null;
    return out.split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

function waitForPublicDemoCiGate(commitSha, stepLogs) {
  console.log(
    `\n⏳ [PHASE-6C-WAIT-CI] Waiting for GitHub Actions status check on ${PUBLIC_DEMO_GH_REPO} (${commitSha.slice(0, 7)})...`
  );
  const start = Date.now();
  let runId = null;

  for (let attempt = 1; attempt <= 24; attempt++) {
    try {
      const raw = execFileSync(
        'gh',
        [
          'run',
          'list',
          '--repo',
          PUBLIC_DEMO_GH_REPO,
          '--commit',
          commitSha,
          '--limit',
          '5',
          '--json',
          'databaseId,status,conclusion,workflowName',
        ],
        { cwd: ROOT_DIR, encoding: 'utf8' }
      ).trim();
      const runs = JSON.parse(raw || '[]');
      if (Array.isArray(runs) && runs.length > 0 && runs[0].databaseId) {
        runId = String(runs[0].databaseId);
        break;
      }
    } catch {
      // Retry briefly while GitHub registers the push webhook
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);
  }

  if (!runId) {
    throw new Error(
      `[Public Demo CI Gate] Timed out waiting for GitHub Actions workflow run on ${PUBLIC_DEMO_GH_REPO} for commit ${commitSha}.`
    );
  }

  runStep(
    'PHASE-6C-WAIT-CI',
    `Wait for Required CI Gate on ${PUBLIC_DEMO_GH_REPO} (run #${runId})`,
    `gh run watch ${runId} --repo ${PUBLIC_DEMO_GH_REPO} --exit-status`,
    stepLogs
  );
  return Date.now() - start;
}

const FORBIDDEN_TRACKED_PATHS = [
  'legacy_vba',
  'docs/VBA_Project',
  'docs/screenshot',
  'docs/動画作成用資料',
  'docs/video_assets',
];

const ALLOWED_UNTRACKED_PATTERN =
  /^(?:src|public|functions|supabase|scripts|e2e|docs\/Web_Project|\.agents\/(?:skills|hooks|rules)|\.github|\.githooks)\/|^(?:README\.md|AGENTS\.md|\.agents\/AGENTS\.md|\.agents\/hooks\.json|package\.json|package-lock\.json|tsconfig.*\.json|vite\.config\.ts|vitest\.config\.ts|playwright\.config\.ts|wrangler\.toml|\.nvmrc|\.gitignore|\.gitattributes|\.vscode\/settings\.json)$/;

function verifyForbiddenAssetAndStagingIsolation(stepLogs, options = {}) {
  const { requireMainBranch = false, enforceExplicitShipStaging = false } = options;
  const branch = getCurrentBranch();

  if (requireMainBranch && branch !== 'main') {
    const msg = `[Security Guard] Operation requires current branch to be "main", but found "${branch}". Switch to or merge into "main" first.`;
    stepLogs.push({
      stepId: 'PHASE-0-GUARD',
      title: 'Main Branch & Asset Isolation Guard',
      status: 'FAILED',
      error: msg,
    });
    throw new Error(msg);
  }

  for (const forbiddenDir of FORBIDDEN_TRACKED_PATHS) {
    const tracked = execSync(`git -c core.quotePath=false ls-files "${forbiddenDir}"`, {
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

  const stagingSnap = readGitStagingSnapshot(ROOT_DIR);

  if (enforceExplicitShipStaging) {
    const decision = evaluateShipStagingState(stagingSnap);
    if (!decision.ok) {
      stepLogs.push({
        stepId: 'PHASE-0-GUARD',
        title: 'Explicit Staging Guard (--ship)',
        status: 'FAILED',
        error: decision.reason,
      });
      throw new Error(decision.reason);
    }
  } else {
    for (const rawPath of stagingSnap.untrackedFiles) {
      const normalized = rawPath.replace(/\\+/g, '/');
      if (
        /\.(?:csv|xlsm|xlsx|db|sqlite|pem|key)$/i.test(normalized) ||
        /(?:^|\/)\.env/i.test(normalized) ||
        /^public\/data\//i.test(normalized) ||
        !ALLOWED_UNTRACKED_PATTERN.test(normalized)
      ) {
        const msg = `[Security Guard] Unexpected untracked file/directory "${normalized}" detected. Add it to .gitignore or move to .agents/scratch/ before running verify.`;
        stepLogs.push({
          stepId: 'PHASE-0-GUARD',
          title: 'Untracked File Safety Guard',
          status: 'FAILED',
          error: msg,
        });
        throw new Error(msg);
      }
    }
  }

  console.log(
    `✅ [PHASE-0-GUARD] Branch ("${branch}"), zero legacy tracking, & ${
      enforceExplicitShipStaging ? 'explicit git staging state' : 'untracked safety'
    } verified.`
  );
  stepLogs.push({
    stepId: 'PHASE-0-GUARD',
    title: 'Branch, Private Asset & Explicit Staging Guard',
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
          ? '🚀 VERIFY + EXPLICIT COMMIT/PUSH + EMERGENCY LOCAL DEPLOY (--ship --local-deploy)'
          : '🚀 VERIFY + EXPLICIT COMMIT/PUSH -> GITHUB ACTIONS CD (--ship)'
        : isQuickMode
          ? '⚡ QUICK VERIFY (docs / typecheck / tests / smoke)'
          : '🔍 FULL VERIFY (2-Project Isolated Bundles & Visual Audit)'
    }`
  );
  console.log(
    `   Target : ${
      targetEnv === 'demo'
        ? '🌐 PUBLIC DEMO (portfolio -> Ruleset 27410303 FF Pipeline)'
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

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const runDir = path.join(SCRATCH_DIR, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });

  try {
    verifyForbiddenAssetAndStagingIsolation(stepLogs, {
      requireMainBranch:
        isShipMode && (targetEnv === 'demo' || (useLocalDeploy && targetEnv === 'personal')),
      enforceExplicitShipStaging: isShipMode,
    });

    // Quick mode: test:docs + typecheck + npm test + test:smoke ONLY
    if (isQuickMode) {
      runStep(
        'PHASE-1A',
        'DDD Specification Sync & Security/UX Gate (Strict Identifier Mode)',
        'npm run test:docs',
        stepLogs,
        { STRICT_DOC_IDENTIFIERS: '1' }
      );
      runStep(
        'PHASE-2',
        'Parallel Incremental TypeScript Strict Typecheck (4 Projects)',
        'npm run typecheck',
        stepLogs
      );
      runStep(
        'PHASE-3',
        'Clinical, Data Integrity & Gate Unit Tests (Vitest src + scripts)',
        'npm test',
        stepLogs
      );
      runStep(
        'PHASE-3B',
        'Vite Dev Server 8-Parallel Runtime Smoke Test',
        'npm run test:smoke',
        stepLogs
      );

      const totalDurationMs = Date.now() - pipelineStart;
      const quickSummary = JSON.stringify(
        {
          runId,
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
      );
      fs.writeFileSync(path.join(runDir, 'pipeline-run.json'), quickSummary, 'utf8');
      fs.writeFileSync(SUMMARY_PATH, quickSummary, 'utf8');
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

    const currentFp = computeWorktreeVerifyFingerprint(targetEnv);
    let existingStamp = null;
    if (fs.existsSync(VERIFY_STAMP_PATH)) {
      try {
        existingStamp = JSON.parse(fs.readFileSync(VERIFY_STAMP_PATH, 'utf8'));
      } catch {
        existingStamp = null;
      }
    }
    const stampMatched = isShipMode && isVerifyStampReusable(existingStamp, currentFp);

    if (stampMatched) {
      console.log(
        `\n⚡ [VERIFY-STAMP HIT] Working tree (${currentFp.worktreeTreeSha.slice(0, 10)}) + HEAD (${currentFp.headSha.slice(0, 7)}) + env (${currentFp.envHash.slice(0, 8)}) matches fresh pipeline:verify stamp (<15m). Skipping redundant rebuild & Playwright re-run.`
      );
      stepLogs.push({
        stepId: 'PHASE-1-TO-5-STAMP',
        title: 'Reused Fresh Strict Verify Stamp',
        status: 'PASSED',
        durationMs: 0,
      });
    } else {
      runStep(
        'PHASE-1A',
        'DDD Specification Sync & Security/UX Gate (Strict Identifier Mode)',
        'npm run test:docs',
        stepLogs,
        { STRICT_DOC_IDENTIFIERS: '1' }
      );
      runStep(
        'PHASE-1B',
        'Production Dependency Vulnerability Audit',
        'npm run audit:prod',
        stepLogs
      );
      runStep(
        'PHASE-2',
        'Parallel Incremental TypeScript Strict Typecheck (4 Projects)',
        'npm run typecheck',
        stepLogs
      );
      runStep(
        'PHASE-3',
        'Clinical, Data Integrity & Gate Unit Tests (Vitest src + scripts)',
        'npm test',
        stepLogs
      );

      // Phase 4A & 4B: Build BOTH isolated bundles (`dist-portfolio` & `dist-personal`) prior to 2-project Playwright E2E
      runStep(
        'PHASE-4A',
        'Portfolio Bundle Build -> dist-portfolio (VITE_APP_MODE=portfolio)',
        'npm run build:vite:portfolio',
        stepLogs
      );

      const personalBuildEnv =
        useLocalDeploy && targetEnv === 'personal'
          ? { REQUIRE_SUPABASE_ENV: '1' }
          : hasConfiguredPersonalSupabaseEnv(ROOT_DIR)
            ? {}
            : {
                VITE_SUPABASE_URL: 'https://e2e-verify.supabase.co',
                VITE_SUPABASE_ANON_KEY:
                  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e2e.verify',
              };

      runStep(
        'PHASE-4B',
        'Personal Bundle Build -> dist-personal (VITE_APP_MODE=personal)',
        'npm run build:vite:personal',
        stepLogs,
        personalBuildEnv
      );

      // Allow OS to reclaim Rollup/esbuild virtual memory commit charge before launching Chromium
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);

      // Phase 5A: 2-Project Playwright E2E Regression Suite (`portfolio` then `personal`, 1 server at a time)
      runStep(
        'PHASE-5A-PORTFOLIO',
        'Playwright Isolated E2E Regression Suite (project=portfolio @regression)',
        'npx playwright test --project=portfolio --grep @regression',
        stepLogs
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      runStep(
        'PHASE-5A-PERSONAL',
        'Playwright Isolated E2E Regression Suite (project=personal @regression)',
        'npx playwright test --project=personal --grep @regression',
        stepLogs
      );

      // Phase 5B: Playwright Visual Screenshot & Layout Audit Suite (`portfolio` project)
      if (!skipVisual) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
        const runScreenshotDir = path.join(runDir, 'screenshots');
        runStep(
          'PHASE-5B',
          'Playwright Screenshot Capture & Multimodal Layout Audit (@visual)',
          'npm run test:visual',
          stepLogs,
          { CGM_VISUAL_SCREENSHOT_DIR: runScreenshotDir }
        );
      }

      const postVerifyFp = computeWorktreeVerifyFingerprint(targetEnv);
      fs.writeFileSync(
        VERIFY_STAMP_PATH,
        JSON.stringify(
          {
            ...postVerifyFp,
            skipVisual,
            verifiedAt: new Date().toISOString(),
            verifiedAtMs: Date.now(),
          },
          null,
          2
        ),
        'utf8'
      );
    }

    // Phase 6: Explicit-Staged Atomic Commit & Ruleset-Compliant Git Push
    if (isShipMode) {
      const stagingSnap = readGitStagingSnapshot(ROOT_DIR);
      const stagingDecision = evaluateShipStagingState(stagingSnap);
      if (!stagingDecision.ok) {
        throw new Error(stagingDecision.reason);
      }

      let createdNewMainCommit = false;
      if (stagingDecision.action === 'commit_staged') {
        const safeMsg = commitMessage.replace(/"/g, '\\"');
        runStep(
          'PHASE-6A',
          `Create Atomic Git Commit (${stagingSnap.stagedFiles.length} explicitly staged file(s))`,
          `git commit -m "${safeMsg}"`,
          stepLogs,
          { PIPELINE_TESTS_PASSED: '1', PIPELINE_VERIFIED_STAMP: '1' }
        );
        createdNewMainCommit = true;
      } else {
        console.log(`\nℹ️ [PHASE-6A] Working tree & staging index are clean. Proceeding to push HEAD.`);
      }

      const branch = getCurrentBranch();

      if (targetEnv === 'demo') {
        if (createdNewMainCommit && hasRemote('origin')) {
          runStep(
            'PHASE-6B-ORIGIN-MAIN',
            `Push Verified Main Commit to Private Origin (${branch})`,
            `git push -u origin ${branch}`,
            stepLogs,
            { PIPELINE_SHIP_AUTHORIZED: '1' }
          );
        }

        const remoteDemoMainSha = hasRemote('public-demo')
          ? getRemoteHeadSha('public-demo', 'refs/heads/main')
          : null;
        if (remoteDemoMainSha) {
          try {
            execFileSync('git', ['cat-file', '-e', `${remoteDemoMainSha}^{commit}`], {
              cwd: ROOT_DIR,
            });
          } catch {
            execFileSync('git', ['fetch', 'public-demo', 'main'], {
              cwd: ROOT_DIR,
              stdio: 'inherit',
            });
          }
        }

        const demoBuild = buildCleanDemoCommit({
          targetBranch: 'demo-public',
          parentRef: remoteDemoMainSha || 'refs/heads/demo-public',
          sourceRef: 'HEAD',
          message: commitMessage,
          dryRun: hasRemote('public-demo'),
        });
        stepLogs.push({
          stepId: 'PHASE-6C-BUILD-DEMO',
          title: `Generate Clean Fast-Forward Commit for demo-public (${demoBuild.commitSha.slice(0, 7)})`,
          status: 'PASSED',
          durationMs: 0,
        });

        if (hasRemote('public-demo')) {
          if (remoteDemoMainSha === demoBuild.commitSha) {
            console.log(
              `\nℹ️ [PHASE-6C-PUBLIC] public-demo refs/heads/main is already at ${demoBuild.commitSha.slice(0, 7)}. Skipping redundant promotion.`
            );
          } else {
            runStep(
              'PHASE-6C-STAGE',
              'Push Clean Fast-Forward Commit to Staging Branch (public-demo release/demo)',
              `git push --force public-demo ${demoBuild.commitSha}:refs/heads/release/demo`,
              stepLogs
            );

            waitForPublicDemoCiGate(demoBuild.commitSha, stepLogs);

            runStep(
              'PHASE-6C-PROMOTE',
              'Fast-Forward Promote CI-Verified Commit to public-demo main (Ruleset 27410303)',
              `git push public-demo ${demoBuild.commitSha}:refs/heads/main`,
              stepLogs,
              { PIPELINE_DEMO_FF_VERIFIED: '1' }
            );

            try {
              execSync('git push public-demo --delete release/demo', {
                cwd: ROOT_DIR,
                stdio: 'ignore',
              });
            } catch {
              // Best-effort staging branch cleanup
            }
          }
          execFileSync('git', ['branch', '-f', 'demo-public', demoBuild.commitSha], {
            cwd: ROOT_DIR,
          });
        }

        if (hasRemote('origin')) {
          runStep(
            'PHASE-6C-BACKUP',
            'Backup Clean Fast-Forward demo-public Branch to Private Origin',
            'git push origin refs/heads/demo-public:refs/heads/demo-public',
            stepLogs
          );
        }

        if (useLocalDeploy) {
          runStep(
            'PHASE-6D',
            'Emergency Local Deploy Portfolio Bundle (dist-portfolio) to Cloudflare Pages',
            'npx wrangler pages deploy dist-portfolio --project-name=cgm-diabetes-manager-demo --branch=main',
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
          stepLogs,
          { PIPELINE_SHIP_AUTHORIZED: '1' }
        );
        if (useLocalDeploy) {
          const cfProj = process.env.CF_PAGES_PROJECT_NAME;
          if (!cfProj) {
            throw new Error(
              '[Deploy Guard] Emergency --local-deploy for personal requires CF_PAGES_PROJECT_NAME environment variable.'
            );
          }
          runStep(
            'PHASE-6D',
            'Emergency Local Deploy Personal Bundle (dist-personal) to Cloudflare Pages',
            `npx wrangler pages deploy dist-personal --project-name=${cfProj} --branch=main`,
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
    if (typeof runDir === 'string' && fs.existsSync(runDir)) {
      fs.writeFileSync(
        path.join(runDir, 'pipeline-run.json'),
        JSON.stringify(summary, null, 2),
        'utf8'
      );
    }

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
    if (typeof runDir === 'string' && fs.existsSync(runDir)) {
      fs.writeFileSync(
        path.join(runDir, 'pipeline-run.json'),
        JSON.stringify(summary, null, 2),
        'utf8'
      );
    }

    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
    console.error(`💥 AI Orchestration Pipeline ABORTED due to failure.`);
    console.error(`📄 Check details in .agents/scratch/pipeline-last-run.json\n`);
    process.exit(1);
  }
}

const isExecutedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isExecutedDirectly) {
  main();
}
