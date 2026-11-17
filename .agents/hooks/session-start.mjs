/**
 * セッション開始フック (SessionStart Hook): session-start.mjs
 *
 * エージェントセッション開始時点の Git HEAD SHA とタイムスタンプを
 * .agents/scratch/session-start-state.json に記録し、ターン途中でコミットが行われた後に
 * 大量の read_file 等が実行されても Stop Hook が確実に変更発生を検知できるようにする。
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STATE_PATH = path.join(REPO_ROOT, '.agents', 'scratch', 'session-start-state.json');

export async function readStdinWithTimeout(timeoutMs = 500) {
  if (process.stdin.isTTY) return '{}';
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.removeAllListeners('error');
      if (typeof process.stdin.unref === 'function') {
        process.stdin.unref();
      }
      resolve(val || '{}');
    };
    const timer = setTimeout(() => finish(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => finish(data));
    process.stdin.on('error', () => finish(data));
  });
}

export function getCurrentHeadSha(cwd = REPO_ROOT) {
  try {
    return execSync('git rev-parse HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

async function main() {
  try {
    const raw = await readStdinWithTimeout(500);
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = {};
    }

    const scratchDir = path.dirname(STATE_PATH);
    if (!fs.existsSync(scratchDir)) {
      fs.mkdirSync(scratchDir, { recursive: true });
    }

    let existingSessions = {};
    if (fs.existsSync(STATE_PATH)) {
      try {
        const prev = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        if (prev && typeof prev.sessions === 'object' && prev.sessions !== null) {
          existingSessions = prev.sessions;
        }
      } catch {
        existingSessions = {};
      }
    }

    const startedAt = new Date().toISOString();
    const headSha = getCurrentHeadSha();
    const sessionId = payload.sessionId || payload.conversationId || null;

    if (sessionId) {
      existingSessions[sessionId] = { startedAt, headSha };
      const keys = Object.keys(existingSessions);
      if (keys.length > 32) {
        for (const oldKey of keys.slice(0, keys.length - 32)) {
          delete existingSessions[oldKey];
        }
      }
    }

    const state = {
      startedAt,
      headSha,
      sessionId,
      sessions: existingSessions,
    };
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // Non-fatal: always allow session start
  }

  // SessionStart protojson expects an empty response message ({}) with no "decision" field
  process.stdout.write('{}\n');
}

const isExecutedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isExecutedDirectly) {
  main().catch(() => {
    process.stdout.write('{}\n');
  });
}
