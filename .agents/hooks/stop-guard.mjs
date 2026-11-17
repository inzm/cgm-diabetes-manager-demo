/**
 * 終了フック (Stop Hook): stop-guard.mjs
 *
 * AIがターンを完了しようとした瞬間に Antigravity から呼ばれ、
 * 仕様書同期・セキュリティ検査 (scripts/verify-docs-sync.mjs) を実行する。
 *
 * 強化点:
 * - Windows 非同期パイプでのハングを防ぐタイムアウト付き非同期 stdin 読取
 * - .agents/scratch/ を除く全未コミットファイル (.env*, wrangler.toml, .gitignore, public/,
 *   vite.config.ts, .vscode/, .githooks/, legacy_vba/ 等すべて) を監視対象化
 * - SessionStart 記録 SHA と現在 HEAD SHA の比較により、ターン内コミット後に大量の
 *   read_file が続いた場合や Subagent 会話 (USER_EXPLICIT 不在) でも100%捕捉
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCurrentHeadSha, readStdinWithTimeout } from './session-start.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SESSION_STATE_PATH = path.join(REPO_ROOT, '.agents', 'scratch', 'session-start-state.json');

export function isWatchedRepoPath(relPosixPath) {
  const clean = String(relPosixPath ?? '')
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/\\+/g, '/')
    .replace(/^\.\//, '');
  if (!clean) return false;
  if (clean.startsWith('.agents/scratch/')) return false;
  return true;
}

// Git 上で .agents/scratch/ 以外のいずれかのファイルに未コミット変更があるか
export function hasRelevantGitDirtyFiles(cwd = REPO_ROOT) {
  try {
    const out = execSync('git -c core.quotePath=false status --porcelain', {
      cwd,
      encoding: 'utf8',
    });
    return out
      .split(/\r?\n/)
      .map((l) => {
        const entry = l.slice(3).trim().replace(/^"(.*)"$/, '$1');
        const target = entry.includes(' -> ') ? entry.split(' -> ').pop().trim() : entry;
        return target.replace(/\\+/g, '/');
      })
      .filter(Boolean)
      .some((f) => isWatchedRepoPath(f));
  } catch {
    return false;
  }
}

// セッション開始時から HEAD コミットが変化しているか（ターン途中コミット後の read_file 押し出し・Subagent 上書き対策）
export function hasHeadAdvancedSinceSessionStart(
  statePath = SESSION_STATE_PATH,
  cwd = REPO_ROOT,
  sessionId = null
) {
  try {
    if (!fs.existsSync(statePath)) return false;
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const recordedSha =
      (sessionId && state?.sessions?.[sessionId]?.headSha) || state?.headSha || '';
    if (!recordedSha) return false;
    const currentHead = getCurrentHeadSha(cwd);
    return Boolean(currentHead && currentHead !== recordedSha);
  } catch {
    return false;
  }
}

/**
 * 会話トランスクリプト行配列から当ターンのワークスペース変更有無を判定する純粋関数
 * - USER_EXPLICIT が無いサブエージェント会話でも末尾10行に切り詰めず、最後の USER_INPUT 以降（無ければ全行・最大300行）を走査
 */
export function didTranscriptLinesTouchWorkspace(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return false;

  let lastExplicitIdx = -1;
  let lastAnyUserIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const step = JSON.parse(lines[i]);
      if (step.type === 'USER_INPUT') {
        if (lastAnyUserIdx === -1) lastAnyUserIdx = i;
        if (step.source === 'USER_EXPLICIT') {
          lastExplicitIdx = i;
          break;
        }
      }
    } catch {
      // ignore malformed line
    }
  }

  const startIdx =
    lastExplicitIdx >= 0
      ? lastExplicitIdx + 1
      : lastAnyUserIdx >= 0
        ? lastAnyUserIdx + 1
        : Math.max(0, lines.length - 300);
  const turnLines = lines.slice(startIdx);

  for (const line of turnLines) {
    try {
      const step = JSON.parse(line);
      const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      for (const tc of toolCalls) {
        const name = String(tc.name || tc.tool_name || '');
        if (
          name.includes('edit_file') ||
          name.includes('write_file') ||
          name.includes('replace_file_content') ||
          name.includes('create_file') ||
          name.includes('delete_file')
        ) {
          const normalizedArgs = JSON.stringify(tc.args || tc.arguments || {})
            .replace(/\\+"/g, '"')
            .replace(/\\+/g, '/');
          if (!normalizedArgs.includes('.agents/scratch/')) {
            return true;
          }
        }
        if (
          name.includes('invoke_subagent') ||
          name.includes('swarm') ||
          name.includes('call_mcp_tool')
        ) {
          return true;
        }
        if (name.includes('run_command')) {
          const cmdStr = JSON.stringify(tc.args || tc.arguments || {});
          if (
            /\b(?:git\s+(?:commit|cherry-pick|merge|rebase|reset|rm|mv|add)|Set-Content|Add-Content|Out-File|Move-Item|Copy-Item|New-Item|Remove-Item|node\s+-e|npm\s+run)\b/i.test(
              cmdStr
            )
          ) {
            return true;
          }
        }
      }
    } catch {
      // ignore malformed line
    }
  }
  return false;
}

export function didCurrentTurnTouchWorkspace(transcriptPath, sessionId = null) {
  if (hasRelevantGitDirtyFiles()) {
    return true;
  }
  if (hasHeadAdvancedSinceSessionStart(SESSION_STATE_PATH, REPO_ROOT, sessionId)) {
    return true;
  }
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return false;
  }
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split(/\r?\n/);
    return didTranscriptLinesTouchWorkspace(lines);
  } catch {
    return true;
  }
}

async function main() {
  let payload = {};
  try {
    const raw = await readStdinWithTimeout(500);
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }

  const terminationReason = payload.terminationReason || 'NO_TOOL_CALL';
  const executionNum = typeof payload.executionNum === 'number' ? payload.executionNum : 1;
  const sessionId = payload.sessionId || payload.conversationId || null;

  // ① 無限ループ防止上限を6回に拡大（通常の完了以外の強制中断時は通過）
  if (terminationReason !== 'NO_TOOL_CALL' || executionNum > 6) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
    return;
  }

  // ② 監視対象に未コミット変更がなく、セッション開始後のコミットもなく、当ターンで編集も行っていない場合は通過
  if (!didCurrentTurnTouchWorkspace(payload.transcriptPath, sessionId)) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
    return;
  }

  // ③ 仕様書同期・スキーマ整合性・セキュリティ検査を実行する
  try {
    execSync('node scripts/verify-docs-sync.mjs', {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
  } catch (err) {
    const stderr = (err.stderr || err.stdout || err.message || '').toString().trim();
    const compactError = stderr.split(/\r?\n/).slice(-12).join(' | ');
    process.stdout.write(
      JSON.stringify({
        decision: 'continue',
        reason: `[DDD Stop Guard] 仕様書同期・スキーマ整合性またはUX/セキュリティ検証 (npm run test:docs) が失敗しています。作業完了前に修正してください: ${compactError}`,
      }) + '\n'
    );
  }
}

const isExecutedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isExecutedDirectly) {
  main().catch(() => {
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
  });
}
