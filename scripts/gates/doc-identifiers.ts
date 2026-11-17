import { execSync } from 'node:child_process';
import type { RepoReader } from './repo-reader.ts';
import { getPrecedingSpecFirstContext, getWorkingTreeOrStagedFiles } from './git-diff-sync.ts';

export function extractAddedBacktickIdentifiersFromDiff(unifiedDiffText: string): Set<string> {
  const added = new Set<string>();
  if (typeof unifiedDiffText !== 'string' || !unifiedDiffText) return added;
  for (const rawLine of unifiedDiffText.split(/\r?\n/)) {
    if (!rawLine.startsWith('+') || rawLine.startsWith('+++ ')) continue;
    const line = rawLine.slice(1);
    for (const m of line.matchAll(/`([A-Za-z_][A-Za-z0-9_.]*)(\(\))?`/g)) {
      if (/\.(?:tsx?|mts|cts|mjs|cjs|js|sql|json|md|xlsm|xlsx|txt|png|jpg|svg|yml|yaml|toml|drawio|css|html|sh)$/i.test(m[1])) {
        continue;
      }
      const core = m[1].split('.').pop();
      if (core && core.length >= 5 && (/[a-z][A-Z]|_/.test(core) || m[2])) {
        added.add(core);
      }
    }
  }
  return added;
}

export function evaluateSpecFirstIdentExemption(params: {
  forceStrictIdents: boolean;
  isStagedMode: boolean;
  activeFiles: readonly string[];
}): {
  allowUncommittedDocDiff: boolean;
  allowPrecedingSpecCommits: boolean;
} {
  if (params.forceStrictIdents) {
    return { allowUncommittedDocDiff: false, allowPrecedingSpecCommits: false };
  }
  const files = Array.isArray(params.activeFiles) ? params.activeFiles : [];
  const isDocOrAgentMetaFile = (f: string) =>
    /^(?:docs\/|\.agents\/(?:skills|rules)\/|\.agents\/AGENTS\.md$|README\.md$|AGENTS\.md$)/.test(
      String(f).trim()
    );
  const allActiveAreDocsOnly = files.every(isDocOrAgentMetaFile);
  const isPureSpecEditPhase = files.length > 0 && allActiveAreDocsOnly;

  return {
    allowUncommittedDocDiff: isPureSpecEditPhase,
    allowPrecedingSpecCommits: !params.isStagedMode && allActiveAreDocsOnly,
  };
}

const IDENT_ALLOWLIST = new Set([
  'ErrorBars', // Excel(VBA)側の旧機能名（移行元の説明）
  'markPoint', // ECharts の標準オプション名
  'sessionStorage', // ブラウザ標準API名（使用禁止の説明）
  'invoke_subagent', // Antigravity エージェント実行環境の組み込みツール名
]);

const REQUIRED_DEMO_RULESET_CHECK_NAME =
  'Verify Quality Gates (DDD / Types / Vitest / Smoke / Playwright E2E)';

export function runSuiteHookAndIdentifierGates(
  reader: RepoReader,
  params: {
    docFiles: readonly string[];
    allSmokeTestableSrcModules: readonly string[];
    argv?: string[];
  },
  errors: string[]
): void {
  const argv = params.argv ?? process.argv;

  // Check 7: Dynamic suite/endpoint counts (when mentioned in docs), lifecycle hooks, & Ruleset 27410303 job name guard
  const unitTestFiles = [
    ...reader.listFilesUnder('src/lib/__tests__', '.test.ts'),
    ...reader.listFilesUnder('scripts/__tests__', '.test.ts'),
  ];
  let actualVitestCount = 0;
  for (const tf of unitTestFiles) {
    const tc = reader.readText(tf);
    actualVitestCount += (tc.match(/\b(?:it|test)\s*\(/g) || []).length;
  }

  const e2eRel = 'e2e/app.spec.ts';
  if (reader.exists(e2eRel)) {
    const e2eContent = reader.readText(e2eRel);
    const e2eMatches = e2eContent.match(/test\(['"`]E2E-\d+:/g) || [];
    const e2eCount = e2eMatches.length;

    const e2eRangeRegex = /E2E-1[`'"]?\s*[〜~]\s*[`'"]?E2E-(\d+)\b/g;
    const totalSuitesRegex = /全(\d+)スイート/g;
    const smokeEndpointsRegex = /全(\d+)(?:モジュール)?エンドポイント/g;
    const vitestCountRegex = /Vitest[`'"]?\s*(?:全)?(\d+)件/g;
    const expectedSmokeEndpoints = params.allSmokeTestableSrcModules.length + 1;

    for (const relDoc of params.docFiles) {
      const content = reader.readText(relDoc);
      let m: RegExpExecArray | null;
      while ((m = e2eRangeRegex.exec(content)) !== null) {
        const mentionedEnd = parseInt(m[1], 10);
        if (mentionedEnd !== e2eCount) {
          errors.push(
            `[Stale E2E Suite Count] ${relDoc} contains "${m[0]}" (expected E2E-1〜E2E-${e2eCount}).`
          );
        }
      }
      while ((m = totalSuitesRegex.exec(content)) !== null) {
        const mentionedTotal = parseInt(m[1], 10);
        if (mentionedTotal !== e2eCount) {
          errors.push(
            `[Stale E2E Suite Count] ${relDoc} contains "${m[0]}" (expected 全${e2eCount}スイート).`
          );
        }
      }
      while ((m = smokeEndpointsRegex.exec(content)) !== null) {
        const mentionedEndpoints = parseInt(m[1], 10);
        if (mentionedEndpoints !== expectedSmokeEndpoints) {
          errors.push(
            `[Stale Smoke Endpoint Count] ${relDoc} contains "${m[0]}" (expected 全${expectedSmokeEndpoints}エンドポイント).`
          );
        }
      }
      while ((m = vitestCountRegex.exec(content)) !== null) {
        const mentionedTests = parseInt(m[1], 10);
        if (actualVitestCount > 0 && mentionedTests !== actualVitestCount) {
          errors.push(
            `[Stale Vitest Test Count] ${relDoc} contains "${m[0]}" (actual test cases: ${actualVitestCount}).`
          );
        }
      }
    }
  }

  const hooksJsonRel = '.agents/hooks.json';
  if (reader.exists(hooksJsonRel)) {
    const hooksConfig = JSON.parse(reader.readText(hooksJsonRel)) as Record<
      string,
      Record<string, unknown>
    >;
    const lifecycleEvents = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'];
    for (const [hookGroup, groupDef] of Object.entries(hooksConfig)) {
      for (const eventKey of lifecycleEvents) {
        const rawList = groupDef?.[eventKey];
        const hookList = Array.isArray(rawList) ? rawList : [];
        for (const hook of hookList as Array<{ command?: unknown }>) {
          if (typeof hook.command === 'string' && hook.command.startsWith('node ')) {
            const scriptRel = hook.command.replace(/^node\s+/, '').trim();
            const fullRel = `.agents/${scriptRel.replace(/^\.\//, '')}`;
            if (!reader.exists(fullRel)) {
              errors.push(
                `[Broken Hook Script Path] ${hooksJsonRel} (${hookGroup}.${eventKey}) references non-existent script "${scriptRel}".`
              );
            }
          }
        }
      }
    }
  }

  // Verify Ruleset 27410303 required status check name is preserved in deploy-pages.yml
  const workflowRel = '.github/workflows/deploy-pages.yml';
  if (reader.exists(workflowRel)) {
    const wfText = reader.readText(workflowRel);
    if (!wfText.includes(`name: ${REQUIRED_DEMO_RULESET_CHECK_NAME}`)) {
      errors.push(
        `[Ruleset 27410303 Check Name Drift] ${workflowRel} must keep exact job name "${REQUIRED_DEMO_RULESET_CHECK_NAME}" required by public-demo branch protection.`
      );
    }
  }

  console.log(
    `✅ [PASS] Check 7: Suite/Endpoint counts, all lifecycle hooks in .agents/hooks.json, & Ruleset 27410303 CI check name verified.`
  );

  // Check 8: Documented Identifier Existence Gate
  let codeCorpus = '';
  for (const dirRel of [
    'src',
    'functions',
    'supabase',
    'e2e',
    'scripts',
    'public',
    '.agents/hooks',
    '.githooks',
    '.github/workflows',
  ]) {
    for (const relFile of reader.listFilesUnder(dirRel)) {
      if (relFile.startsWith('public/data/')) continue;
      if (
        !/\.(?:ts|tsx|mts|cts|mjs|cjs|js|sql|json|html|yml|yaml|sh)$/i.test(relFile) &&
        !relFile.startsWith('.githooks/')
      ) {
        continue;
      }
      codeCorpus += reader.readText(relFile) + '\n';
    }
  }

  for (const rootFile of [
    'package.json',
    'vite.config.ts',
    'playwright.config.ts',
    'vitest.config.ts',
    'wrangler.toml',
    'tsconfig.json',
    'tsconfig.functions.json',
    'tsconfig.e2e.json',
    'tsconfig.scripts.json',
    '.agents/hooks.json',
    '.nvmrc',
    '.gitattributes',
    'index.html',
  ]) {
    if (reader.exists(rootFile)) {
      codeCorpus += reader.readText(rootFile) + '\n';
    }
  }

  const identDocs = Array.from(
    new Set([
      ...reader.listFilesUnder('docs/Web_Project', ['.md', '.drawio']),
      ...reader.listFilesUnder('.agents/rules', '.md'),
      '.agents/AGENTS.md',
      'AGENTS.md',
      'README.md',
    ])
  ).filter((rel) => reader.exists(rel));

  const forceStrictIdents =
    process.env.CI === 'true' ||
    process.env.STRICT_DOC_IDENTIFIERS === '1' ||
    argv.includes('--strict-identifiers');

  const activeFilesForIdentCheck = getWorkingTreeOrStagedFiles(
    reader.rootDir,
    reader.isStagedMode
  );
  const { allowUncommittedDocDiff, allowPrecedingSpecCommits } =
    evaluateSpecFirstIdentExemption({
      forceStrictIdents,
      isStagedMode: reader.isStagedMode,
      activeFiles: activeFilesForIdentCheck,
    });
  const allowPendingSpecFirstIdents = allowUncommittedDocDiff || allowPrecedingSpecCommits;

  const specFirstAddedIdents = new Set<string>();
  if (allowUncommittedDocDiff) {
    try {
      const diffCmd = reader.isStagedMode ? 'git diff --cached -U0' : 'git diff HEAD -U0';
      const diffText = execSync(diffCmd, {
        cwd: reader.rootDir,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
      });
      for (const id of extractAddedBacktickIdentifiersFromDiff(diffText)) {
        specFirstAddedIdents.add(id);
      }
    } catch {
      // Ignore diff error
    }
  }

  if (allowPrecedingSpecCommits) {
    const precedingSpecForIdents = getPrecedingSpecFirstContext(reader.rootDir, 'HEAD');
    if (precedingSpecForIdents.commits.length > 0) {
      try {
        const baseRev = `HEAD~${precedingSpecForIdents.commits.length}`;
        const committedSpecDiff = execSync(
          `git diff ${baseRev} HEAD -U0 -- docs/ .agents/ README.md AGENTS.md`,
          {
            cwd: reader.rootDir,
            encoding: 'utf8',
            maxBuffer: 20 * 1024 * 1024,
          }
        );
        for (const id of extractAddedBacktickIdentifiersFromDiff(committedSpecDiff)) {
          specFirstAddedIdents.add(id);
        }
      } catch {
        // Ignore
      }
    }
  }

  const missingIdents = new Map<string, boolean>();
  const pendingSpecFirstIdents = new Map<string, boolean>();
  let identChecked = 0;

  for (const relDoc of identDocs) {
    const text = reader.readText(relDoc);
    for (const m of text.matchAll(/`([A-Za-z_][A-Za-z0-9_.]*)(\(\))?`/g)) {
      if (
        /\.(?:tsx?|mts|cts|mjs|cjs|js|sql|json|md|xlsm|xlsx|txt|png|jpg|svg|yml|yaml|toml|drawio|css|html|sh)$/i.test(
          m[1]
        )
      ) {
        continue;
      }
      const core = m[1].split('.').pop() || '';
      if (core.length < 5 || !(/[a-z][A-Z]|_/.test(core) || m[2])) continue;
      if (IDENT_ALLOWLIST.has(core)) continue;
      identChecked++;
      if (!codeCorpus.includes(core)) {
        const key = `${relDoc} :: ${m[1]}`;
        if (allowPendingSpecFirstIdents && specFirstAddedIdents.has(core)) {
          pendingSpecFirstIdents.set(key, true);
        } else {
          missingIdents.set(key, true);
        }
      }
    }
  }

  if (pendingSpecFirstIdents.size > 0) {
    console.log(
      `ℹ️ [Spec-First Stage] Check 8: Allowing ${pendingSpecFirstIdents.size} newly added planned identifier(s) during pure spec update:`
    );
    for (const key of pendingSpecFirstIdents.keys()) {
      console.log(`   - ${key}`);
    }
  }

  if (missingIdents.size > 0) {
    const warnOnly = process.env.WARN_IDENT_CHECK === '1';
    const label = warnOnly ? 'WARN' : 'ERROR';
    console.warn(
      `⚠️ [${label}] Check 8: ${missingIdents.size} documented identifier(s) not found in code (checked ${identChecked}):`
    );
    for (const key of missingIdents.keys()) {
      console.warn(`   - ${key}`);
      if (!warnOnly) {
        errors.push(`[Stale Identifier] ${key} is documented but absent from code.`);
      }
    }
  } else {
    console.log(
      `✅ [PASS] Check 8: All ${identChecked} documented identifiers verified (${pendingSpecFirstIdents.size > 0 ? 'Spec-First pending stage' : 'strict mode'}).`
    );
  }
}
