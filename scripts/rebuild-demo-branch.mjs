/**
 * 公開デモ用 孤立ブランチ (demo-public) クリーン再構築スクリプト (rebuild-demo-branch.mjs)
 *
 * 目的:
 * ローカルのワーキングツリー（legacy_vba/ 等の参照用資産）に一切手を触れず、
 * 一時 Git インデックス (GIT_INDEX_FILE) と git commit-tree を用いて、
 * 指定元ブランチ（既定: HEAD または --source=<ref>）から非公開・旧VBA関連資産を完全除外した
 * 「親コミットを持たない単一コミット（過去履歴ゼロ）」の demo-public ブランチを生成する。
 *
 * 使い方:
 * - ドライラン検証（ブランチを更新せずツリー隔離・履歴ゼロ生成のみ検証）:
 *   node scripts/rebuild-demo-branch.mjs --dry-run
 * - demo-public ブランチをクリーン再構築（main 等にチェックアウトした状態で実行）:
 *   npm run demo:rebuild-branch
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');

function getArgValue(flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  const prefix = `${flag}=`;
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

const TARGET_BRANCH = getArgValue('--branch') || 'demo-public';
const SOURCE_REF = getArgValue('--source') || 'HEAD';

const FORBIDDEN_PUBLIC_PATHS = [
  'legacy_vba',
  'docs/VBA_Project',
  'docs/screenshot',
  'docs/動画作成用資料',
  'docs/video_assets',
];

const FORBIDDEN_TEXT_PATTERNS = [
  { regex: /file:\/\/\/[a-zA-Z0-9_~.-]/i, label: 'file:/// machine-local URL' },
  { regex: /Users[\\/]+PC05/i, label: 'Local machine username path (Users/PC05)' },
];

function git(cmd, extraEnv = {}) {
  return execSync(`git ${cmd}`, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  }).trim();
}

function main() {
  console.log(`\n======================================================`);
  console.log(`🧹 Rebuilding Clean Orphan Branch (${TARGET_BRANCH})`);
  console.log(`   Source Ref : ${SOURCE_REF}`);
  console.log(`   Mode       : ${isDryRun ? '🔍 DRY-RUN (no branch ref update)' : '🚀 UPDATE BRANCH'}`);
  console.log(`======================================================\n`);

  const currentBranch = git('rev-parse --abbrev-ref HEAD');
  if (!isDryRun && currentBranch === TARGET_BRANCH) {
    console.error(
      `❌ Cannot rebuild "${TARGET_BRANCH}" while it is currently checked out. Switch to "main" first (git checkout main).`
    );
    process.exit(1);
  }

  const sourceSha = git(`rev-parse --verify "${SOURCE_REF}^{commit}"`);
  const tmpIndexFile = path.join(
    os.tmpdir(),
    `cgm_demo_orphan_index_${process.pid}_${Date.now()}`
  );
  const indexEnv = { GIT_INDEX_FILE: tmpIndexFile };

  try {
    // 1. Read source commit tree into isolated temporary index
    git(`read-tree ${sourceSha}`, indexEnv);

    // 2. Strip any forbidden legacy/private directories from the temporary index
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
            `[Isolation Failure] Forbidden path "${filePath}" still present in orphan index.`
          );
        }
      }
    }

    // 4. Scan tracked markdown/code blobs in the clean index for machine-specific paths
    const docAndConfigFiles = remainingFiles.filter((f) =>
      /\.(?:md|ts|tsx|mjs|json|yml|yaml|html|toml)$/i.test(f) &&
      !f.startsWith('public/data/') &&
      f !== 'scripts/rebuild-demo-branch.mjs' &&
      f !== 'scripts/verify-docs-sync.mjs'
    );

    for (const relFile of docAndConfigFiles) {
      const blobContent = git(`show "${sourceSha}:${relFile}"`);
      for (const rule of FORBIDDEN_TEXT_PATTERNS) {
        if (rule.regex.test(blobContent)) {
          throw new Error(
            `[Privacy Guard] "${relFile}" in ${SOURCE_REF} contains forbidden ${rule.label}. Commit the cleanup before rebuilding ${TARGET_BRANCH}.`
          );
        }
      }
    }

    // 5. Write tree and create parentless orphan commit
    const treeSha = git('write-tree', indexEnv);
    const commitMsg =
      'feat(demo): clean public portfolio release of CGM Diabetes Manager PWA (zero legacy history)';
    const orphanCommitSha = git(`commit-tree ${treeSha} -m "${commitMsg}"`, indexEnv);

    const parentLine = git(`cat-file -p ${orphanCommitSha}`)
      .split(/\r?\n/)
      .find((l) => l.startsWith('parent '));
    if (parentLine) {
      throw new Error(`[Orphan Guard] Expected 0 parents, but found: ${parentLine}`);
    }

    console.log(`✅ Verified ${remainingFiles.length} clean public files (0 legacy/private assets).`);
    console.log(`✅ Created parentless orphan commit: ${orphanCommitSha} (tree: ${treeSha.slice(0, 10)})`);

    if (!isDryRun) {
      git(`branch -f ${TARGET_BRANCH} ${orphanCommitSha}`);
      const commitCount = parseInt(git(`rev-list --count ${TARGET_BRANCH}`), 10);
      if (commitCount !== 1) {
        throw new Error(
          `[Orphan Guard] Expected commit count on ${TARGET_BRANCH} to be 1, got ${commitCount}.`
        );
      }
      console.log(`🎉 Updated branch "${TARGET_BRANCH}" -> ${orphanCommitSha} (total history: 1 commit).`);
      console.log(
        `   Next step to publish clean history:\n   git push --force public-demo ${TARGET_BRANCH}:main && git push --force origin ${TARGET_BRANCH}\n`
      );
    } else {
      console.log(`ℹ️ Dry-run complete. Branch "${TARGET_BRANCH}" was not modified.\n`);
    }
  } finally {
    if (fs.existsSync(tmpIndexFile)) {
      fs.unlinkSync(tmpIndexFile);
    }
  }
}

main();
