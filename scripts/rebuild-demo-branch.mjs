/**
 * 公開デモ用 クリーンブランチ構築スクリプト (rebuild-demo-branch.mjs)
 *
 * 目的:
 * ローカルのワーキングツリー（main ブランチや legacy_vba/ 参照用資産）を一切切り替え・変更せず、
 * 一時 Git インデックス (GIT_INDEX_FILE) と git commit-tree を用いて、
 * 指定元コミット（既定: HEAD）から非公開・旧VBA関連資産を完全除外したクリーンツリーを生成し、
 * `demo-public` ブランチの Fast-Forward 子コミット (`-p refs/heads/demo-public`) を作成する。
 *
 * 公開リポジトリ `public-demo` の Ruleset 27410303 (`non_fast_forward` + `required_status_checks`) に完全準拠する。
 *
 * 使い方:
 * - ドライラン検証（ブランチを更新せずクリーンツリー隔離・FF親接続・秘匿検査のみ検証）:
 *   node scripts/rebuild-demo-branch.mjs --dry-run
 * - demo-public ブランチに Fast-Forward 子コミットを生成（main チェックアウトのまま実行可）:
 *   npm run demo:rebuild-branch -- --message "feat(demo): ..."
 * - 初回ミラー構築用の履歴ゼロ孤立コミット（明示指定時のみ）:
 *   node scripts/rebuild-demo-branch.mjs --orphan --dry-run
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = process.cwd();
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isOrphanMode = args.includes('--orphan');
const allowEmpty = args.includes('--allow-empty');

function getArgValue(flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  const prefix = `${flag}=`;
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

const TARGET_BRANCH = getArgValue('--branch') || 'demo-public';
const SOURCE_REF = getArgValue('--source') || 'HEAD';
const CUSTOM_MESSAGE = getArgValue('--message') || getArgValue('-m');

export const FORBIDDEN_PUBLIC_PATHS = [
  'legacy_vba',
  'docs/VBA_Project',
  'docs/screenshot',
  'docs/動画作成用資料',
  'docs/video_assets',
];

const FORBIDDEN_GLOBAL_TEXT_PATTERNS = [
  { regex: /file:\/\/\/[a-zA-Z0-9_~.%-]/i, label: 'file:/// machine-local URL' },
  {
    regex: /(?:[A-Za-z]:[\\/]+Users[\\/]+|\/Users\/)[A-Za-z0-9._-]+/i,
    label: 'Local OS user-home path (C:/Users/... or /Users/...)',
  },
  { regex: /AIza[0-9A-Za-z_-]{35}/, label: 'Google/Gemini API Key literal' },
  { regex: /sbp_[0-9a-zA-Z]{30,}/, label: 'Supabase Personal Access Token literal' },
  {
    regex: /SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*['"`]?eyJ[A-Za-z0-9_-]{10,}/,
    label: 'Supabase service_role JWT literal',
  },
];

const REGEX_FIXTURE_FILES = new Set([
  'scripts/rebuild-demo-branch.mjs',
  'scripts/verify-docs-sync.mjs',
  'scripts/gates/module-coverage.ts',
  'scripts/gates/security-ux.ts',
  'scripts/gates/markdown-integrity.ts',
  'scripts/__tests__/gates.test.ts',
  '.agents/hooks/pre-tool-guard.mjs',
]);

function git(cmd, extraEnv = {}) {
  return execSync(`git -c core.quotePath=false ${cmd}`, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  }).trim();
}

function refExists(fullRef) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${fullRef}^{commit}`], {
      cwd: ROOT_DIR,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

export function buildCleanDemoCommit(options = {}) {
  const targetBranch = options.targetBranch || TARGET_BRANCH;
  const sourceRef = options.sourceRef || SOURCE_REF;
  const dryRun = options.dryRun ?? isDryRun;
  const orphan = options.orphan ?? isOrphanMode;
  const targetRef = `refs/heads/${targetBranch}`;

  console.log(`\n======================================================`);
  console.log(
    `🧹 Building Clean Public Demo Commit (${targetBranch}) [${
      orphan ? 'ORPHAN MODE' : 'FAST-FORWARD MODE'
    }]`
  );
  console.log(`   Source Ref : ${sourceRef}`);
  console.log(`   Mode       : ${dryRun ? '🔍 DRY-RUN (no branch ref update)' : '🚀 UPDATE BRANCH REF'}`);
  console.log(`======================================================\n`);

  const currentBranch = git('rev-parse --abbrev-ref HEAD');
  if (!dryRun && currentBranch === targetBranch) {
    throw new Error(
      `Cannot update "${targetBranch}" while it is checked out in working tree. Keep "main" checked out; this script uses GIT_INDEX_FILE without switching branches.`
    );
  }

  let parentSha = null;
  if (!orphan) {
    const baseRef = options.parentRef || targetRef;
    if (!refExists(baseRef)) {
      throw new Error(
        `Parent ref "${baseRef}" does not exist locally. Fetch it first (git fetch public-demo main:${targetBranch}) or pass --orphan.`
      );
    }
    parentSha = git(`rev-parse --verify "${baseRef}^{commit}"`);
  }

  const sourceSha = git(`rev-parse --verify "${sourceRef}^{commit}"`);
  const tmpIndexFile = path.join(
    os.tmpdir(),
    `cgm_demo_ff_index_${process.pid}_${Date.now()}`
  );
  const indexEnv = { GIT_INDEX_FILE: tmpIndexFile };

  try {
    // 1. Read source commit tree into isolated temporary index
    git(`read-tree ${sourceSha}`, indexEnv);

    // 2. Strip forbidden legacy/private directories from the temporary index
    const quotedForbidden = FORBIDDEN_PUBLIC_PATHS.map((p) => `"${p}"`).join(' ');
    git(`rm -r --cached --ignore-unmatch --quiet -- ${quotedForbidden}`, indexEnv);

    // 3. Verify zero forbidden paths remain in the clean index
    const remainingFiles = git('ls-files', indexEnv)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const filePath of remainingFiles) {
      for (const forbidden of FORBIDDEN_PUBLIC_PATHS) {
        if (filePath === forbidden || filePath.startsWith(`${forbidden}/`)) {
          throw new Error(
            `[Isolation Failure] Forbidden path "${filePath}" still present in clean demo index.`
          );
        }
      }
    }

    // 4. Scan tracked blobs in the clean index for BOM, secrets, local paths, and private Issue numbers
    const scannableFiles = remainingFiles.filter(
      (f) =>
        !f.startsWith('public/data/') &&
        (/\.(?:md|ts|tsx|mts|mjs|cjs|js|json|yml|yaml|html|toml|sql|sh|drawio)$/i.test(f) ||
          f.startsWith('.githooks/'))
    );

    for (const relFile of scannableFiles) {
      const rawBuf = execFileSync('git', ['show', `${sourceSha}:${relFile}`], {
        cwd: ROOT_DIR,
        maxBuffer: 16 * 1024 * 1024,
      });

      if (
        rawBuf.length >= 3 &&
        rawBuf[0] === 0xef &&
        rawBuf[1] === 0xbb &&
        rawBuf[2] === 0xbf
      ) {
        throw new Error(
          `[Encoding Guard] "${relFile}" in ${sourceRef} starts with UTF-8 BOM (EF BB BF). Strip BOM before publishing to ${targetBranch}.`
        );
      }

      if (REGEX_FIXTURE_FILES.has(relFile)) continue;

      const blobContent = rawBuf.toString('utf8');
      for (const rule of FORBIDDEN_GLOBAL_TEXT_PATTERNS) {
        if (rule.regex.test(blobContent)) {
          throw new Error(
            `[Privacy Guard] "${relFile}" in ${sourceRef} contains forbidden ${rule.label}.`
          );
        }
      }

      const isDocOrWorkflow =
        relFile.startsWith('docs/') ||
        relFile.startsWith('.github/') ||
        relFile.startsWith('.agents/') ||
        relFile === 'README.md' ||
        relFile === 'AGENTS.md';

      if (isDocOrWorkflow) {
        const lines = blobContent.replace(/\r\n/g, '\n').split('\n');
        let inFence = false;
        for (const rawLine of lines) {
          const trimmed = rawLine.trim();
          if (/^(`{3,}|~{3,})/.test(trimmed)) {
            inFence = !inFence;
            continue;
          }
          if (inFence) continue;
          const withoutInlineCode = trimmed.replace(/`[^`]*`/g, '');
          if (/\bIssue\s*#\d+\b/i.test(withoutInlineCode)) {
            throw new Error(
              `[Public Hygiene Guard] "${relFile}" in ${sourceRef} contains forbidden Private GitHub Issue reference (Issue #XX).`
            );
          }
          if (
            relFile.startsWith('docs/Web_Project/') &&
            /【(?:未決事項|要確認|改修予定|実装予定|将来案)】/.test(withoutInlineCode)
          ) {
            throw new Error(
              `[Public Hygiene Guard] "${relFile}" in ${sourceRef} contains forbidden Unresolved specification status tag.`
            );
          }
        }
      }

      if (
        relFile === '.github/workflows/deploy-pages.yml' &&
        blobContent.includes('cgm-diabetes-manager-personal')
      ) {
        throw new Error(
          `[Public Hygiene Guard] "${relFile}" leaks private Cloudflare project name "cgm-diabetes-manager-personal".`
        );
      }
    }

    // 5. Write clean tree and create Fast-Forward child commit (or reuse if tree unchanged)
    const treeSha = git('write-tree', indexEnv);

    if (parentSha && !allowEmpty) {
      const parentTreeSha = git(`rev-parse "${parentSha}^{tree}"`);
      if (parentTreeSha === treeSha) {
        console.log(
          `✅ Clean public tree (${treeSha.slice(0, 10)}) is already identical to ${targetBranch} (${parentSha.slice(0, 7)}).`
        );
        return { commitSha: parentSha, treeSha, parentSha, unchanged: true };
      }
    }

    const commitMsg =
      options.message ||
      CUSTOM_MESSAGE ||
      (orphan
        ? 'feat(demo): clean public portfolio release of CGM Diabetes Manager PWA (zero legacy history)'
        : 'feat(demo): sync clean public portfolio release with latest verified main');

    const commitTreeArgs = ['commit-tree', treeSha];
    if (parentSha) {
      commitTreeArgs.push('-p', parentSha);
    }
    commitTreeArgs.push('-m', commitMsg);

    const newCommitSha = execFileSync('git', commitTreeArgs, {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      env: { ...process.env, ...indexEnv },
    }).trim();

    if (parentSha) {
      execFileSync('git', ['merge-base', '--is-ancestor', parentSha, newCommitSha], {
        cwd: ROOT_DIR,
        stdio: 'ignore',
      });
    }

    console.log(
      `✅ Verified ${remainingFiles.length} clean public files (0 legacy/private assets, 0 BOM, 0 leaks).`
    );
    console.log(
      `✅ Created ${orphan ? 'orphan' : `Fast-Forward (parent ${parentSha.slice(0, 7)})`} commit: ${newCommitSha} (tree: ${treeSha.slice(0, 10)})`
    );

    if (!dryRun) {
      if (parentSha) {
        execFileSync('git', ['update-ref', targetRef, newCommitSha, parentSha], {
          cwd: ROOT_DIR,
        });
      } else {
        execFileSync('git', ['branch', '-f', targetBranch, newCommitSha], {
          cwd: ROOT_DIR,
        });
      }
      console.log(`🎉 Updated ${targetRef} -> ${newCommitSha} (Working tree stayed on "${currentBranch}").`);
    } else {
      console.log(`ℹ️ Dry-run complete. "${targetBranch}" was not modified.\n`);
    }

    return { commitSha: newCommitSha, treeSha, parentSha, unchanged: false };
  } finally {
    if (fs.existsSync(tmpIndexFile)) {
      fs.unlinkSync(tmpIndexFile);
    }
  }
}

const isExecutedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isExecutedDirectly) {
  try {
    buildCleanDemoCommit();
  } catch (err) {
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
