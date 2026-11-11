/**
 * Git pre-commit フック自動インストーラー
 *
 * コミット実行時に必ず以下を自動実行し、仕様書更新漏れや型エラーがある状態での
 * git commit を物理的にブロックする：
 * 1. node scripts/verify-docs-sync.mjs --staged (仕様書・コード同期検査)
 * 2. npm run typecheck (TypeScript厳格型検査)
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const HOOK_PATH = path.join(ROOT_DIR, '.git', 'hooks', 'pre-commit');

const HOOK_CONTENT = `#!/bin/sh
echo "🔒 [Pre-Commit Gate] Running DDD Spec Sync & Typecheck..."

node scripts/verify-docs-sync.mjs --staged
if [ $? -ne 0 ]; then
  echo "❌ [Pre-Commit Blocked] 仕様書（docs/Web_Project/SPEC_*.md）の同期検証に失敗しました。仕様書を最新化して git add してください。"
  exit 1
fi

npm run typecheck
if [ $? -ne 0 ]; then
  echo "❌ [Pre-Commit Blocked] TypeScript 型検査に失敗しました。"
  exit 1
fi

echo "✅ [Pre-Commit Gate] All checks passed!"
exit 0
`;

if (fs.existsSync(path.join(ROOT_DIR, '.git', 'hooks'))) {
  fs.writeFileSync(HOOK_PATH, HOOK_CONTENT, { encoding: 'utf8', mode: 0o755 });
  console.log(`✅ Installed Git pre-commit hook at ${HOOK_PATH}`);
} else {
  console.warn(`⚠️ .git/hooks directory not found. Skipping hook installation.`);
}

