export interface WorktreeVerifyFingerprint {
  worktreeTreeSha: string;
  headSha: string;
  targetEnv: string;
  envHash: string;
}

export interface VerifyStamp extends WorktreeVerifyFingerprint {
  skipVisual: boolean;
  verifiedAt: string;
  verifiedAtMs: number;
}

export interface ShipStagingSnapshot {
  stagedFiles: readonly string[];
  unstagedFiles: readonly string[];
  untrackedFiles: readonly string[];
}

export interface ShipStagingEvaluation {
  ok: boolean;
  action: 'abort' | 'commit_staged' | 'push_clean_head';
  reason: string | null;
}

export function computeWorktreeVerifyFingerprint(
  target: string,
  cwd?: string
): WorktreeVerifyFingerprint;

export function isVerifyStampReusable(
  stamp: Partial<VerifyStamp> | null | undefined,
  currentFp: WorktreeVerifyFingerprint | null | undefined,
  nowMs?: number,
  ttlMs?: number
): boolean;

export function evaluateShipStagingState(
  state: ShipStagingSnapshot
): ShipStagingEvaluation;
