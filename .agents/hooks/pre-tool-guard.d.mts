export interface PreToolGuardVerdict {
  decision: 'allow' | 'deny' | 'force_ask';
  reason?: string;
}

export function evaluatePreToolGuard(payload: Record<string, unknown>): PreToolGuardVerdict;
