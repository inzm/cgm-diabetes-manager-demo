/**
 * Antigravity Lifecycle Stop Hook (`stop-guard.mjs`)
 *
 * エージェントがターンを終了（NO_TOOL_CALL）しようとした際、
 * 変更されたソースコードに対する仕様書（docs/Web_Project/SPEC_*.md）の更新漏れや
 * セキュリティ・開発者用語露出違反（verify-docs-sync.mjs）がないかを自動点検する。
 * 違反が残っている場合は自動でループを継続（decision: "continue"）し、自律修正を促す。
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '{}';
  }
}

function hasRelevantGitDirtyFiles() {
  try {
    const out = execSync('git status --porcelain', { cwd: REPO_ROOT, encoding: 'utf8' });
    return out
      .split(/\r?\n/)
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
      .some((f) =>
        /^(?:src|functions|supabase|scripts|e2e|docs\/Web_Project|\.agents)\//.test(f)
      );
  } catch {
    return false;
  }
}

function didCurrentTurnModifySrc(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return hasRelevantGitDirtyFiles();
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
          if (name.includes('edit_file') || name.includes('write_file') || name.includes('replace_file_content')) {
            const argsStr = JSON.stringify(tc.args || tc.arguments || {});
            const watchedDirs = [
              'src',
              'functions',
              'supabase',
              'scripts',
              'e2e',
              '.agents',
              'docs/Web_Project',
              'docs\\\\Web_Project',
            ];
            if (
              watchedDirs.some(
                (dir) =>
                  argsStr.includes(`/${dir}/`) ||
                  argsStr.includes(`\\\\${dir}\\\\`)
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
  } catch {
    return hasRelevantGitDirtyFiles();
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

  // 無限ループ防止: 通常のツール完了時かつ初回/2回目ループのみ検査を実行
  if (terminationReason !== 'NO_TOOL_CALL' || executionNum > 2) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  // この会話ターン内で src/ 配下のファイルを編集していない場合（Q&Aや動画原稿作成セッション等）は干渉せず通過させる
  if (!didCurrentTurnModifySrc(payload.transcriptPath)) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  try {
    execSync('node scripts/verify-docs-sync.mjs', {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
  } catch (err) {
    const stderr = (err.stderr || err.stdout || err.message || '').toString().trim();
    const compactError = stderr.split(/\r?\n/).slice(-8).join(' | ');
    process.stdout.write(
      JSON.stringify({
        decision: 'continue',
        reason: `[DDD Stop Guard] 仕様書同期またはUX/セキュリティ検証 (npm run test:docs) が失敗しています。作業完了前に修正してください: ${compactError}`,
      })
    );
  }
}

main();

