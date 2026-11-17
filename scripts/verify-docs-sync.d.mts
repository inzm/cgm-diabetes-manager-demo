export interface SourceToSpecRule {
  prefix: string;
  specs: string[];
  requiredSpecs?: string[];
  description: string;
}

export const SOURCE_TO_SPEC_RULES: readonly SourceToSpecRule[];

export function isPureSpecFirstCommit(
  subject: string,
  commitFiles: readonly string[]
): boolean;

export function stripJsCommentsPreservingStrings(source: string): string;

export function evaluateSpecFirstIdentExemption(params: {
  forceStrictIdents: boolean;
  isStagedMode: boolean;
  activeFiles: readonly string[];
}): {
  allowUncommittedDocDiff: boolean;
  allowPrecedingSpecCommits: boolean;
};

export function extractAddedBacktickIdentifiersFromDiff(
  unifiedDiffText: string
): Set<string>;

export function inspectMarkdownIntegrity(
  relDoc: string,
  content: string
): string[];

export function runAllGates(options: {
  rootDir?: string;
  argv?: string[];
  smokeEndpoints: readonly string[];
}): { passed: boolean; errors: string[] };

export function runVerification(): void;
