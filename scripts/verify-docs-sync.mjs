/**
 * ドキュメント駆動開発 (DDD) 同期・整合性・セキュリティ検証ゲート (verify-docs-sync.mjs)
 *
 * 実装本体は厳格型付きの6モジュール (`scripts/gates/*.ts`) に分離されており、
 * 本ファイルは CLI エントリポイントおよび後方互換エクスポートの薄いファサードとして機能する。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveSmokeEndpoints } from './smoke-test.mjs';
import {
  SOURCE_TO_SPEC_RULES,
  evaluateSpecFirstIdentExemption,
  extractAddedBacktickIdentifiersFromDiff,
  inspectMarkdownIntegrity,
  isPureSpecFirstCommit,
  runAllGates,
  stripJsCommentsPreservingStrings,
} from './gates/index.ts';

export {
  SOURCE_TO_SPEC_RULES,
  isPureSpecFirstCommit,
  stripJsCommentsPreservingStrings,
  evaluateSpecFirstIdentExemption,
  extractAddedBacktickIdentifiersFromDiff,
  inspectMarkdownIntegrity,
  runAllGates,
};

export function runVerification() {
  const rootDir = process.cwd();
  const smokeEndpoints = deriveSmokeEndpoints(rootDir);
  const { passed, errors } = runAllGates({
    rootDir,
    argv: process.argv,
    smokeEndpoints,
  });

  if (!passed) {
    console.error(
      `\n❌ DDD Documentation Sync Verification FAILED with ${errors.length} error(s):\n`
    );
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    console.error(`\n======================================================\n`);
    process.exit(1);
  }

  console.log(`\n🎉 All DDD Documentation & Code Sync checks PASSED!\n`);
}

const isExecutedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isExecutedDirectly) {
  runVerification();
}
