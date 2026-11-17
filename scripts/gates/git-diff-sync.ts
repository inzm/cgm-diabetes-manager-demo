import { execSync } from 'node:child_process';
import { SOURCE_TO_SPEC_RULES } from './module-coverage.ts';

export function isPureSpecFirstCommit(
  subject: string,
  commitFiles: readonly string[]
): boolean {
  if (typeof subject !== 'string' || !/^docs\(spec\):\s*\S/.test(subject.trim())) {
    return false;
  }
  if (!Array.isArray(commitFiles) || commitFiles.length === 0) {
    return false;
  }
  const touchesImplementationCode = commitFiles.some((f) =>
    /^(?:src|functions|supabase)\//.test(String(f).trim())
  );
  return !touchesImplementationCode;
}

export function getPrecedingSpecFirstContext(
  rootDir: string,
  startRef = 'HEAD',
  maxDepth = 5
): { commits: string[]; specFiles: string[] } {
  const commits: string[] = [];
  const specFilesSet = new Set<string>();
  const safeStart = (startRef || 'HEAD').trim();
  if (!/^[A-Za-z0-9_./~^-]+$/.test(safeStart)) {
    return { commits, specFiles: [] };
  }

  for (let offset = 0; offset < maxDepth; offset++) {
    const rev = offset === 0 ? safeStart : `${safeStart}~${offset}`;
    try {
      const meta = execSync(`git log -1 --format="%h|%P|%s" ${rev}`, {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!meta) break;

      const [shortHash, parentsRaw, ...subjParts] = meta.split('|');
      const parents = parentsRaw.trim().split(/\s+/).filter(Boolean);
      if (parents.length > 1) break;

      const subject = subjParts.join('|');
      const filesOut = execSync(
        `git -c core.quotePath=false diff-tree --no-commit-id --name-only -r ${rev}`,
        {
          cwd: rootDir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      );
      const files = filesOut
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);

      if (!isPureSpecFirstCommit(subject, files)) {
        break;
      }

      commits.push(shortHash);
      for (const f of files) {
        specFilesSet.add(f);
      }
    } catch {
      break;
    }
  }

  return { commits, specFiles: Array.from(specFilesSet) };
}

export function getExplicitDiffRange(argv = process.argv): string {
  const idx = argv.indexOf('--diff-range');
  if (idx !== -1 && idx + 1 < argv.length) {
    return argv[idx + 1].trim();
  }
  const inline = argv.find((a) => a.startsWith('--diff-range='));
  if (inline) {
    return inline.slice('--diff-range='.length).trim();
  }
  return (process.env.DIFF_RANGE || '').trim();
}

export function getWorkingTreeOrStagedFiles(rootDir: string, isStagedMode: boolean): string[] {
  try {
    if (isStagedMode) {
      const out = execSync('git -c core.quotePath=false diff --cached --name-only', {
        cwd: rootDir,
        encoding: 'utf8',
      });
      return out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const statusOut = execSync('git -c core.quotePath=false status --porcelain', {
      cwd: rootDir,
      encoding: 'utf8',
    });
    return statusOut
      .split(/\r?\n/)
      .map((line) => {
        const entry = line.slice(3).trim().replace(/^"(.*)"$/, '$1');
        return (entry.includes(' -> ') ? entry.split(' -> ').pop()!.trim() : entry).replace(
          /\\+/g,
          '/'
        );
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function getChangedFiles(
  rootDir: string,
  isStagedMode: boolean,
  explicitRange: string
): string[] {
  try {
    if (isStagedMode) {
      return getWorkingTreeOrStagedFiles(rootDir, true);
    }
    if (explicitRange) {
      try {
        const out = execSync(`git -c core.quotePath=false diff --name-only ${explicitRange}`, {
          cwd: rootDir,
          encoding: 'utf8',
        });
        return out
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
      } catch {
        // Fallback below
      }
    }

    const workingFiles = getWorkingTreeOrStagedFiles(rootDir, false);
    let branchFiles: string[] = [];
    try {
      const diffMain = execSync('git -c core.quotePath=false diff --name-only main...HEAD', {
        cwd: rootDir,
        encoding: 'utf8',
      });
      branchFiles = diffMain
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      // Fallback if main ref unavailable
    }

    return Array.from(new Set([...workingFiles, ...branchFiles]));
  } catch {
    return [];
  }
}

export function runGitDiffSyncGate(
  rootDir: string,
  options: { isStagedMode: boolean; skipDiffGate: boolean; explicitRange: string },
  errors: string[]
): void {
  const { isStagedMode, skipDiffGate, explicitRange } = options;
  const changedFiles = getChangedFiles(rootDir, isStagedMode, explicitRange);
  let specFirstStartRef = 'HEAD';
  if (!isStagedMode && explicitRange) {
    const rangeMatch = explicitRange.match(/^([A-Za-z0-9_./~^-]+?)\.{2,3}/);
    if (rangeMatch) {
      specFirstStartRef = rangeMatch[1];
    }
  }

  const specFirstCtx = getPrecedingSpecFirstContext(rootDir, specFirstStartRef);
  const effectiveSpecSet = new Set([...changedFiles, ...specFirstCtx.specFiles]);
  let usedPrecedingSpecFirst = false;

  if (changedFiles.length > 0 && !skipDiffGate) {
    for (const changedFile of changedFiles) {
      const matchedRules = SOURCE_TO_SPEC_RULES.filter((rule) =>
        changedFile.startsWith(rule.prefix)
      );
      for (const rule of matchedRules) {
        if (Array.isArray(rule.requiredSpecs) && rule.requiredSpecs.length > 0) {
          const missingRequired = rule.requiredSpecs.filter(
            (reqSpec) => !effectiveSpecSet.has(reqSpec)
          );
          if (missingRequired.length > 0) {
            errors.push(
              `[Required Spec Sync Missing] Core file "${changedFile}" (${rule.description}) was modified, ` +
                `but required SSOT spec(s) [${missingRequired.join(', ')}] were updated neither in a preceding "docs(spec): ..." commit nor in this change set.`
            );
          } else if (
            rule.requiredSpecs.some(
              (reqSpec) =>
                !changedFiles.includes(reqSpec) && specFirstCtx.specFiles.includes(reqSpec)
            )
          ) {
            usedPrecedingSpecFirst = true;
          }
        }

        const isSpecUpdated = rule.specs.some((specPath) => effectiveSpecSet.has(specPath));
        if (!isSpecUpdated) {
          errors.push(
            `[Spec Sync Required] Source file "${changedFile}" (${rule.description}) was modified, ` +
              `but none of its corresponding specifications (${rule.specs.join(', ')}) were updated in a preceding "docs(spec): ..." commit or in this change set.`
          );
        } else if (
          !rule.specs.some((specPath) => changedFiles.includes(specPath)) &&
          rule.specs.some((specPath) => specFirstCtx.specFiles.includes(specPath))
        ) {
          usedPrecedingSpecFirst = true;
        }
      }
    }
  }

  console.log(
    `✅ [PASS] Check 4: Git diff sync gate evaluated (${changedFiles.length} changed files inspected${
      usedPrecedingSpecFirst
        ? `; Spec-First verified via preceding docs(spec) commit [${specFirstCtx.commits.join(', ')}]`
        : ''
    }).`
  );
}
