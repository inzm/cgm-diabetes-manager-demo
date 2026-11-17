import { createRepoReader } from './repo-reader.ts';
import { SOURCE_TO_SPEC_RULES, runModuleAndIndexChecks, type SourceToSpecRule } from './module-coverage.ts';
import {
  getExplicitDiffRange,
  isPureSpecFirstCommit,
  runGitDiffSyncGate,
} from './git-diff-sync.ts';
import {
  runSecurityAndUxGate,
  stripJsCommentsPreservingStrings,
} from './security-ux.ts';
import {
  parseLatestDexieStores,
  parseMermaidErdEntities,
  parseSequentialMigrations,
  parseTsInterfaces,
  runSchemaAndDiagramParityGate,
} from './schema-parity.ts';
import {
  evaluateSpecFirstIdentExemption,
  extractAddedBacktickIdentifiersFromDiff,
  runSuiteHookAndIdentifierGates,
} from './doc-identifiers.ts';
import {
  inspectMarkdownIntegrity,
  runMarkdownAndPublicLeakGate,
} from './markdown-integrity.ts';

export {
  createRepoReader,
  SOURCE_TO_SPEC_RULES,
  type SourceToSpecRule,
  isPureSpecFirstCommit,
  stripJsCommentsPreservingStrings,
  parseSequentialMigrations,
  parseLatestDexieStores,
  parseTsInterfaces,
  parseMermaidErdEntities,
  evaluateSpecFirstIdentExemption,
  extractAddedBacktickIdentifiersFromDiff,
  inspectMarkdownIntegrity,
};

export function runAllGates(options: {
  rootDir?: string;
  argv?: string[];
  smokeEndpoints: readonly string[];
}): { passed: boolean; errors: string[] } {
  const rootDir = options.rootDir ?? process.cwd();
  const argv = options.argv ?? process.argv;
  const isStagedMode = argv.includes('--staged');
  const skipDiffGate = process.env.SKIP_DOC_SYNC === '1';
  const explicitRange = getExplicitDiffRange(argv);

  console.log(`\n======================================================`);
  console.log(
    `📚 Starting DDD Specification & Code Sync Verification (${
      isStagedMode ? 'Staged Index Blob Mode' : 'Working Tree Mode'
    })`
  );
  console.log(`======================================================\n`);

  const reader = createRepoReader(rootDir, { isStagedMode });
  const errors: string[] = [];

  const { docFiles, allSmokeTestableSrcModules } = runModuleAndIndexChecks(
    reader,
    options.smokeEndpoints,
    errors
  );

  runGitDiffSyncGate(
    rootDir,
    { isStagedMode, skipDiffGate, explicitRange },
    errors
  );

  runSecurityAndUxGate(reader, errors);
  runSchemaAndDiagramParityGate(reader, errors);
  runSuiteHookAndIdentifierGates(
    reader,
    { docFiles, allSmokeTestableSrcModules, argv },
    errors
  );
  runMarkdownAndPublicLeakGate(reader, docFiles, errors);

  return {
    passed: errors.length === 0,
    errors,
  };
}
