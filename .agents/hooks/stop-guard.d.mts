export function isWatchedRepoPath(relPosixPath: string): boolean;
export function hasRelevantGitDirtyFiles(cwd?: string): boolean;
export function hasHeadAdvancedSinceSessionStart(
  statePath?: string,
  cwd?: string,
  sessionId?: string | null
): boolean;
export function didTranscriptLinesTouchWorkspace(lines: readonly string[]): boolean;
export function didCurrentTurnTouchWorkspace(
  transcriptPath?: string,
  sessionId?: string | null
): boolean;
