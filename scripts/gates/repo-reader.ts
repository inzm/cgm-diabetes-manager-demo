import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface RepoReader {
  readonly rootDir: string;
  readonly isStagedMode: boolean;
  exists(relPosixPath: string): boolean;
  readText(relPosixPath: string): string;
  readBuffer(relPosixPath: string): Buffer;
  listTrackedFiles(): string[];
  listFilesUnder(relDirPosix: string, extFilter?: string | readonly string[]): string[];
}

function normalizeRel(relPath: string): string {
  return relPath.replace(/\\+/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function matchesExt(filePath: string, extFilter?: string | readonly string[]): boolean {
  if (!extFilter) return true;
  if (typeof extFilter === 'string') {
    return filePath.endsWith(extFilter);
  }
  return extFilter.some((ext) => filePath.endsWith(ext));
}

function walkDiskFiles(absDir: string, rootDir: string, extFilter?: string | readonly string[]): string[] {
  let out: string[] = [];
  if (!fs.existsSync(absDir)) return out;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(walkDiskFiles(full, rootDir, extFilter));
    } else {
      const rel = path.relative(rootDir, full).split(path.sep).join('/');
      if (matchesExt(rel, extFilter)) {
        out.push(rel);
      }
    }
  }
  return out.sort();
}

const PRELOAD_TEXT_EXT =
  /\.(?:ts|tsx|mts|cts|mjs|cjs|js|json|md|sql|yml|yaml|toml|html|css|svg|drawio|sh|nvmrc)$|(?:^|\/)(?:\.gitignore|\.gitattributes|\.nvmrc|\.env\.personal|\.env\.portfolio)$/i;

/**
 * Git Staging Index (`git ls-files --stage` + `git cat-file --batch`) と Working Tree を
 * 透過的に切り替えるファイルリーダー。
 * --staged モード時は未ステージの Working Tree 変更を一切読まないため Partial Staging 脆弱性を根絶する。
 */
export function createRepoReader(
  rootDir: string,
  options: { isStagedMode?: boolean } = {}
): RepoReader {
  const isStagedMode = Boolean(options.isStagedMode);

  if (!isStagedMode) {
    let cachedTracked: string[] | null = null;
    return {
      rootDir,
      isStagedMode: false,
      exists(relPosixPath: string): boolean {
        const abs = path.join(rootDir, normalizeRel(relPosixPath));
        return fs.existsSync(abs);
      },
      readText(relPosixPath: string): string {
        const abs = path.join(rootDir, normalizeRel(relPosixPath));
        return fs.readFileSync(abs, 'utf8');
      },
      readBuffer(relPosixPath: string): Buffer {
        const abs = path.join(rootDir, normalizeRel(relPosixPath));
        return fs.readFileSync(abs);
      },
      listTrackedFiles(): string[] {
        if (cachedTracked) return cachedTracked;
        try {
          cachedTracked = execSync('git -c core.quotePath=false ls-files', {
            cwd: rootDir,
            encoding: 'utf8',
          })
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
            .sort();
        } catch {
          cachedTracked = [];
        }
        return cachedTracked;
      },
      listFilesUnder(relDirPosix: string, extFilter?: string | readonly string[]): string[] {
        const normDir = normalizeRel(relDirPosix).replace(/\/+$/, '');
        return walkDiskFiles(path.join(rootDir, normDir), rootDir, extFilter);
      },
    };
  }

  // Staged Index Mode: read all indexed paths and preload text blobs in a single `git cat-file --batch`
  const indexedShaByPath = new Map<string, string>();
  const rawStage = execFileSync('git', ['ls-files', '--stage', '-z'], {
    cwd: rootDir,
    maxBuffer: 32 * 1024 * 1024,
  }).toString('utf8');

  for (const record of rawStage.split('\0')) {
    if (!record) continue;
    const tabIdx = record.indexOf('\t');
    if (tabIdx === -1) continue;
    const meta = record.slice(0, tabIdx).trim().split(/\s+/);
    const sha = meta[1];
    const filePath = normalizeRel(record.slice(tabIdx + 1));
    if (sha && filePath) {
      indexedShaByPath.set(filePath, sha);
    }
  }

  const shasToPreload = new Set<string>();
  for (const [rel, sha] of indexedShaByPath.entries()) {
    if (!rel.startsWith('public/data/') && PRELOAD_TEXT_EXT.test(rel)) {
      shasToPreload.add(sha);
    }
  }

  const blobBySha = new Map<string, Buffer>();
  if (shasToPreload.size > 0) {
    const inputList = Array.from(shasToPreload).join('\n') + '\n';
    const batchBuf = execFileSync('git', ['cat-file', '--batch'], {
      cwd: rootDir,
      input: inputList,
      maxBuffer: 64 * 1024 * 1024,
    });

    let offset = 0;
    while (offset < batchBuf.length) {
      const nlIdx = batchBuf.indexOf(0x0a, offset);
      if (nlIdx === -1) break;
      const header = batchBuf.subarray(offset, nlIdx).toString('utf8').trim();
      const parts = header.split(' ');
      const sha = parts[0];
      const size = parseInt(parts[2] ?? '0', 10);
      const contentStart = nlIdx + 1;
      const contentEnd = contentStart + size;
      if (sha && !Number.isNaN(size) && contentEnd <= batchBuf.length) {
        blobBySha.set(sha, batchBuf.subarray(contentStart, contentEnd));
      }
      offset = contentEnd + 1; // skip trailing LF after blob content
    }
  }

  const sortedTracked = Array.from(indexedShaByPath.keys()).sort();

  function loadSingleBlob(sha: string): Buffer {
    const cached = blobBySha.get(sha);
    if (cached) return cached;
    const buf = execFileSync('git', ['cat-file', 'blob', sha], {
      cwd: rootDir,
      maxBuffer: 32 * 1024 * 1024,
    });
    blobBySha.set(sha, buf);
    return buf;
  }

  return {
    rootDir,
    isStagedMode: true,
    exists(relPosixPath: string): boolean {
      const norm = normalizeRel(relPosixPath);
      if (indexedShaByPath.has(norm)) return true;
      // Directory existence check in staged index
      const prefix = norm.replace(/\/+$/, '') + '/';
      return sortedTracked.some((p) => p.startsWith(prefix));
    },
    readText(relPosixPath: string): string {
      return this.readBuffer(relPosixPath).toString('utf8');
    },
    readBuffer(relPosixPath: string): Buffer {
      const norm = normalizeRel(relPosixPath);
      const sha = indexedShaByPath.get(norm);
      if (!sha) {
        throw new Error(`[StagedRepoReader] File "${norm}" is not present in Git staging index.`);
      }
      return loadSingleBlob(sha);
    },
    listTrackedFiles(): string[] {
      return sortedTracked;
    },
    listFilesUnder(relDirPosix: string, extFilter?: string | readonly string[]): string[] {
      const prefix = normalizeRel(relDirPosix).replace(/\/+$/, '') + '/';
      return sortedTracked.filter((p) => p.startsWith(prefix) && matchesExt(p, extFilter));
    },
  };
}
