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

export function extractAddedBacktickIdentifiersFromDiff(
  unifiedDiffText: string
): Set<string>;

export function inspectMarkdownIntegrity(
  relDoc: string,
  content: string
): string[];
