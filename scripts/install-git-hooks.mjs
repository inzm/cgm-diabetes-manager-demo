/**
 * Git Hooks セットアップスクリプト (install-git-hooks.mjs)
 *
 * リポジトリ追跡下の `.githooks/` (`pre-commit`, `pre-push`) を
 * `git config core.hooksPath .githooks` で有効化し、LF 改行コードと実行権限を保証する。
 * `core.hooksPath` により通常のチェックアウトと並列 `git worktree` の双方で同一フックが機能する。
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const GITHOOKS_DIR = path.join(ROOT_DIR, '.githooks');
const HOOK_FILES = ['pre-commit', 'pre-push'];

function main() {
  if (!fs.existsSync(GITHOOKS_DIR)) {
    console.warn(`⚠️ .githooks directory not found at ${GITHOOKS_DIR}. Skipping hook setup.`);
    return;
  }

  for (const hookName of HOOK_FILES) {
    const hookPath = path.join(GITHOOKS_DIR, hookName);
    if (!fs.existsSync(hookPath)) continue;
    const raw = fs.readFileSync(hookPath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    fs.writeFileSync(hookPath, Buffer.from(raw, 'utf8'), { mode: 0o755 });
    try {
      fs.chmodSync(hookPath, 0o755);
    } catch {
      // Windows NTFS ignores POSIX mode bits; git index chmod is handled via .gitattributes / git update-index
    }
  }

  try {
    execSync('git rev-parse --git-dir', { cwd: ROOT_DIR, stdio: 'ignore' });
    execSync('git config core.hooksPath .githooks', { cwd: ROOT_DIR, stdio: 'ignore' });
    console.log(`✅ Configured git core.hooksPath -> .githooks (pre-commit, pre-push LF verified)`);
  } catch {
    console.warn(`⚠️ Not inside a Git repository. Skipping git config core.hooksPath.`);
  }
}

main();
