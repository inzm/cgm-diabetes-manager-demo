/**
 * 終了フック (Stop Hook): stop-guard.mjs
 *
 * AIが「作業が終わりました」と報告しようとした瞬間に Antigravity から呼ばれ、
 * 仕様書同期・セキュリティ検査 (scripts/verify-docs-sync.mjs) を実行する。
 * 違反があれば完了を止め (decision: "continue")、エラー内容を添えてAIに作業を差し戻す。
 * 設定: .agents/hooks.json
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const WATCHED_PATH_PATTERN =
  /(?:^|\/)(?:src|functions|supabase|scripts|e2e|docs|\.agents|\.github)\/|(?:^|\/)(?:README\.md|AGENTS\.md|package\.json)$/;

// Antigravity から標準入力で渡される情報 (終了理由・実行回数・会話記録の場所) を読む
function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '{}';
  }
}

// Git 上で監視対象ファイルに未コミットの変更があるか (run_command・サブエージェント経由の編集も100%捕捉)
function hasRelevantGitDirtyFiles() {
  try {
    const out = execSync('git status --porcelain', { cwd: REPO_ROOT, encoding: 'utf8' });
    return out
      .split(/\r?\n/)
      .map((l) => {
        const entry = l.slice(3).trim().replace(/^"(.*)"$/, '$1');
        const target = entry.includes(' -> ') ? entry.split(' -> ').pop().trim() : entry;
        return target.replace(/\\+/g, '/');
      })
      .filter(Boolean)
      .some((f) => WATCHED_PATH_PATTERN.test(f));
  } catch {
    return false;
  }
}

// 今回のターン (最後のユーザー発言以降) で、AIが監視対象の編集またはコマンド・サブエージェントを実行したか
// ※ Windows の transcript.jsonl で発生する多重バックスラッシュ (\\\\src\\\\ 等) も "/" へ正規化して判定する
function didCurrentTurnTouchWorkspace(transcriptPath) {
  if (hasRelevantGitDirtyFiles()) {
    return true;
  }
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return false;
  }
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split(/\r?\n/);

    let lastUserIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const step = JSON.parse(lines[i]);
        if (step.type === 'USER_INPUT' && step.source === 'USER_EXPLICIT') {
          lastUserIdx = i;
          break;
        }
      } catch {
        // ignore malformed line
      }
    }

    const turnLines = lastUserIdx >= 0 ? lines.slice(lastUserIdx + 1) : lines.slice(-10);
    for (const line of turnLines) {
      try {
        const step = JSON.parse(line);
        const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
        for (const tc of toolCalls) {
          const name = tc.name || tc.tool_name || '';
          if (
            name.includes('edit_file') ||
            name.includes('write_file') ||
            name.includes('replace_file_content')
          ) {
            // 多重エスケープされた Windows パス区切り (\\, \\\\) と引用符を正規化する
            const normalizedArgs = JSON.stringify(tc.args || tc.arguments || {})
              .replace(/\\+"/g, '"')
              .replace(/\\+/g, '/');
            if (WATCHED_PATH_PATTERN.test(normalizedArgs)) {
              return true;
            }
          }
          if (name.includes('invoke_subagent') || name.includes('swarm')) {
            return true;
          }
          if (name.includes('run_command')) {
            const cmdStr = JSON.stringify(tc.args || tc.arguments || {});
            if (/\b(?:git\s+(?:commit|cherry-pick|merge|rm|mv)|Set-Content|Out-File|Move-Item|Remove-Item)\b/i.test(cmdStr)) {
              return true;
            }
          }
        }
      } catch {
        // ignore malformed line
      }
    }
    return false;
  } catch {
    return true;
  }
}

function main() {
  let payload = {};
  try {
    const raw = readStdin();
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    // Fallback if stdin is not valid JSON
  }

  const terminationReason = payload.terminationReason || 'NO_TOOL_CALL';
  const executionNum = typeof payload.executionNum === 'number' ? payload.executionNum : 1;

  // ① 無限ループ防止: 差し戻しは3回まで。4回目以降と、通常の完了以外の終了は通過させる
  if (terminationReason !== 'NO_TOOL_CALL' || executionNum > 3) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  // ② 監視対象に未コミット変更がなく、かつ当ターンで編集も行っていない場合 (純粋な質問応答など) は通過させる
  if (!didCurrentTurnTouchWorkspace(payload.transcriptPath)) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  // ③ 仕様書同期・スキーマ整合性・セキュリティ検査を実行する (約1.5〜2秒)
  try {
    execSync('node scripts/verify-docs-sync.mjs', {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    // ④ 合格: 作業完了を許可する
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
  } catch (err) {
    // ④ 不合格: 完了を止め、エラー内容の末尾10行を添えてAIに作業を差し戻す
    const stderr = (err.stderr || err.stdout || err.message || '').toString().trim();
    const compactError = stderr.split(/\r?\n/).slice(-10).join(' | ');
    process.stdout.write(
      JSON.stringify({
        decision: 'continue',
        reason: `[DDD Stop Guard] 仕様書同期・スキーマ整合性またはUX/セキュリティ検証 (npm run test:docs) が失敗しています。作業完了前に修正してください: ${compactError}`,
      })
    );
  }
}

main();
