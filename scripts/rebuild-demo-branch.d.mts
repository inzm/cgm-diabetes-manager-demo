export const FORBIDDEN_PUBLIC_PATHS: readonly string[];

export interface BuildCleanDemoCommitOptions {
  targetBranch?: string;
  parentRef?: string;
  sourceRef?: string;
  dryRun?: boolean;
  orphan?: boolean;
  message?: string;
}

export interface BuildCleanDemoCommitResult {
  commitSha: string;
  treeSha: string;
  parentSha: string | null;
  unchanged: boolean;
}

export function buildCleanDemoCommit(
  options?: BuildCleanDemoCommitOptions
): BuildCleanDemoCommitResult;
