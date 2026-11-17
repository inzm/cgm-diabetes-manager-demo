/**
 * 並列インクリメンタル TypeScript 厳格型検査ランナー (run-typecheck.mjs)
 *
 * tsconfig.json / tsconfig.functions.json / tsconfig.e2e.json (および存在する場合は tsconfig.scripts.json)
 * を .agents/scratch/tsbuildinfo/ キャッシュ付きで並列実行し、フィードバックループを高速化する。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const TSBUILDINFO_DIR = path.join(ROOT_DIR, '.agents', 'scratch', 'tsbuildinfo');

const CANDIDATE_PROJECTS = [
  'tsconfig.json',
  'tsconfig.functions.json',
  'tsconfig.e2e.json',
  'tsconfig.scripts.json',
];

function resolveTscJs() {
  return path.join(ROOT_DIR, 'node_modules', 'typescript', 'bin', 'tsc');
}

function runSingleTsc(projectFile) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tscJs = resolveTscJs();
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=512', tscJs, '--noEmit', '--pretty', 'false', '-p', projectFile],
      {
        cwd: ROOT_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      resolve({
        projectFile,
        code: code ?? 1,
        durationMs: Date.now() - start,
        output: (stdout + stderr).trim(),
      });
    });
    child.on('error', (err) => {
      resolve({
        projectFile,
        code: 1,
        durationMs: Date.now() - start,
        output: err.message,
      });
    });
  });
}

async function main() {
  if (!fs.existsSync(TSBUILDINFO_DIR)) {
    fs.mkdirSync(TSBUILDINFO_DIR, { recursive: true });
  }

  const activeProjects = CANDIDATE_PROJECTS.filter((f) =>
    fs.existsSync(path.join(ROOT_DIR, f))
  );

  const startAll = Date.now();
  const results = await Promise.all(activeProjects.map((p) => runSingleTsc(p)));
  const totalMs = Date.now() - startAll;

  let failed = false;
  for (const res of results) {
    if (res.code !== 0) {
      failed = true;
      console.error(`❌ [typecheck] ${res.projectFile} FAILED (${(res.durationMs / 1000).toFixed(2)}s):`);
      if (res.output) {
        console.error(res.output);
      }
    } else {
      console.log(`✅ [typecheck] ${res.projectFile} PASSED (${(res.durationMs / 1000).toFixed(2)}s)`);
    }
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }
  console.log(`🎉 All ${activeProjects.length} TypeScript projects verified in ${(totalMs / 1000).toFixed(2)}s.`);
}

main();
