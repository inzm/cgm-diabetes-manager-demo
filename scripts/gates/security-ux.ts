import type { RepoReader } from './repo-reader.ts';

/**
 * 文字列リテラル（'...', "...", `...` — テンプレート内の https:// 等を含む）を保持したまま、
 * JS/TS の行コメント (//...) およびブロックコメント (/*...*\/) のみを空白へ置換する純粋関数
 */
export function stripJsCommentsPreservingStrings(source: string): string {
  const s = String(source ?? '');
  let out = '';
  let i = 0;
  const len = s.length;
  const modeStack: Array<'code' | 'single' | 'double' | 'template'> = ['code'];
  const braceDepthStack: number[] = [];

  while (i < len) {
    const mode = modeStack[modeStack.length - 1];
    const ch = s[i];
    const next = i + 1 < len ? s[i + 1] : '';

    if (mode === 'code') {
      if (ch === '/' && next === '/') {
        out += '  ';
        i += 2;
        while (i < len && s[i] !== '\n') {
          out += s[i] === '\r' ? '\r' : ' ';
          i++;
        }
        continue;
      }
      if (ch === '/' && next === '*') {
        out += '  ';
        i += 2;
        while (i < len && !(s[i] === '*' && s[i + 1] === '/')) {
          out += s[i] === '\n' || s[i] === '\r' ? s[i] : ' ';
          i++;
        }
        if (i < len) {
          out += '  ';
          i += 2;
        }
        continue;
      }
      if (ch === "'") {
        modeStack.push('single');
        out += ch;
        i++;
        continue;
      }
      if (ch === '"') {
        modeStack.push('double');
        out += ch;
        i++;
        continue;
      }
      if (ch === '`') {
        modeStack.push('template');
        out += ch;
        i++;
        continue;
      }
      if (ch === '{' && braceDepthStack.length > 0) {
        braceDepthStack[braceDepthStack.length - 1]++;
        out += ch;
        i++;
        continue;
      }
      if (ch === '}' && braceDepthStack.length > 0) {
        if (braceDepthStack[braceDepthStack.length - 1] === 0) {
          braceDepthStack.pop();
          modeStack.pop();
          out += ch;
          i++;
          continue;
        }
        braceDepthStack[braceDepthStack.length - 1]--;
        out += ch;
        i++;
        continue;
      }
      out += ch;
      i++;
      continue;
    }

    if (mode === 'single') {
      if (ch === '\\' && i + 1 < len) {
        out += ch + s[i + 1];
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '\n') {
        modeStack.pop();
      }
      out += ch;
      i++;
      continue;
    }

    if (mode === 'double') {
      if (ch === '\\' && i + 1 < len) {
        out += ch + s[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"' || ch === '\n') {
        modeStack.pop();
      }
      out += ch;
      i++;
      continue;
    }

    if (mode === 'template') {
      if (ch === '\\' && i + 1 < len) {
        out += ch + s[i + 1];
        i += 2;
        continue;
      }
      if (ch === '$' && next === '{') {
        modeStack.push('code');
        braceDepthStack.push(0);
        out += '${';
        i += 2;
        continue;
      }
      if (ch === '`') {
        modeStack.pop();
      }
      out += ch;
      i++;
      continue;
    }
  }

  return out;
}

const FORBIDDEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /cgm_gemini_api_key/,
    reason:
      'Browser localStorage storage of Gemini API keys (cgm_gemini_api_key) is prohibited for security.',
  },
  {
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/,
    reason: 'Hardcoded Google/Gemini API key literal ("AIza...") is strictly prohibited.',
  },
  {
    pattern: /\bsbp_[0-9a-fA-F]{30,}\b|\bsb_secret_[0-9A-Za-z_-]{20,}\b/,
    reason:
      'Hardcoded Supabase access/secret key literal ("sbp_..." / "sb_secret_...") is strictly prohibited.',
  },
  {
    pattern: /\bghp_[0-9A-Za-z]{30,}\b|\bgithub_pat_[0-9A-Za-z_]{50,}\b/,
    reason:
      'Hardcoded GitHub Personal Access Token ("ghp_..." / "github_pat_...") is strictly prohibited.',
  },
  {
    pattern: /\bSUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*['"`]eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
    reason: 'Hardcoded JWT literal for SUPABASE_SERVICE_ROLE_KEY ("eyJ...") is strictly prohibited.',
  },
  {
    pattern: /\bVITE_[A-Z0-9_]*(?:GEMINI|SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|ACCESS_TOKEN)\b/,
    reason: 'Exposing secret keys via Vite client bundle prefix ("VITE_*") is strictly prohibited.',
  },
  {
    pattern: /__CGM_E2E_/,
    reason:
      'Test backdoor window flags ("__CGM_E2E_*") are prohibited in production client/BFF code; verify real dist-personal and dist-portfolio bundles directly.',
  },
  {
    pattern: /ローカルストレージに安全に保管/,
    reason: 'False security claim ("ローカルストレージに安全に保管") is strictly prohibited.',
  },
  {
    pattern: /佐藤 綾子|佐藤 健一/,
    reason: 'Hardcoded fake family member stubs ("佐藤 綾子" / "佐藤 健一") are prohibited.',
  },
  {
    pattern: /window\.confirm\s*\(/,
    reason:
      'Browser native window.confirm() is prohibited; use custom ConfirmDialog component instead.',
  },
  {
    pattern:
      /toISOString\s*\(\s*\)\s*\.\s*(?:slice\s*\(\s*0\s*,\s*(?:7|10|16|19)\s*\)|substring\s*\(\s*0\s*,\s*(?:7|10|16|19)\s*\)|split\s*\(\s*['"`]T['"`]\s*\))/,
    reason:
      'Extracting wall-clock date/time via toISOString().slice(...) / split("T") causes 9-hour UTC drift; use formatLocalDate / normalizeToWallClockIso from src/lib/dateUtils.ts instead.',
  },
];

const CLIENT_ONLY_FORBIDDEN: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\bSUPABASE_SERVICE_ROLE_KEY\b/,
    reason: 'Referencing SUPABASE_SERVICE_ROLE_KEY inside client-side src/ code is strictly prohibited.',
  },
  {
    pattern:
      /\b(?:localStorage|sessionStorage)\.setItem\s*\(\s*['"`][^'"`]*(?:api[_-]?key|gemini|secret|service[_-]?role|private[_-]?key|password)[^'"`]*['"`]/i,
    reason:
      'Persisting API keys, secrets, or passwords in browser localStorage/sessionStorage is strictly prohibited.',
  },
];

const TSX_UX_FORBIDDEN: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /マスタ/,
    reason:
      'Developer jargon ("マスタ") in UI TSX is prohibited; use user-centric expressions ("よく使う食品", "登録済みから選ぶ", etc.).',
  },
  {
    pattern: /IndexedDB|Dexie/,
    reason: 'Exposing internal storage engine names ("IndexedDB" / "Dexie") in UI TSX is prohibited.',
  },
  {
    pattern: /Web Worker/,
    reason: 'Exposing internal thread architecture ("Web Worker") in UI TSX is prohibited.',
  },
  {
    pattern: /\((?:libre_readings|food_master|event_master|meal_details|user_settings|family_permissions)\)/,
    reason: 'Exposing physical DB table names in UI TSX is prohibited.',
  },
];

const REPO_WIDE_SECRET_REGEX =
  /\bAIza[0-9A-Za-z_-]{30,}\b|\bsbp_[0-9a-fA-F]{30,}\b|\bsb_secret_[0-9A-Za-z_-]{20,}\b|\bghp_[0-9A-Za-z]{30,}\b|\bgithub_pat_[0-9A-Za-z_]{50,}\b|\bSUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*['"`]eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

export function runSecurityAndUxGate(reader: RepoReader, errors: string[]): void {
  const allSrcFiles = [
    ...reader.listFilesUnder('src', ['.ts', '.tsx']),
    ...reader.listFilesUnder('functions', '.ts'),
  ];

  for (const relSrc of allSrcFiles) {
    const content = reader.readText(relSrc);
    const codeWithoutComments = stripJsCommentsPreservingStrings(content);
    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.pattern.test(content)) {
        errors.push(`[Security / Anti-Stub Violation] ${relSrc}: ${rule.reason}`);
      }
    }
    if (relSrc.startsWith('src/')) {
      for (const rule of CLIENT_ONLY_FORBIDDEN) {
        if (rule.pattern.test(codeWithoutComments)) {
          errors.push(`[Client Secret Isolation Violation] ${relSrc}: ${rule.reason}`);
        }
      }
      if (relSrc.endsWith('.tsx')) {
        for (const rule of TSX_UX_FORBIDDEN) {
          if (rule.pattern.test(codeWithoutComments)) {
            errors.push(`[User-Centric UX Violation] ${relSrc}: ${rule.reason}`);
          }
        }
      }
    }
  }

  if (reader.exists('.gitignore')) {
    const gitignoreText = reader.readText('.gitignore');
    for (const requiredIgnore of ['.env', '.env.local', '.env.*.local', '.dev.vars']) {
      if (!gitignoreText.split(/\r?\n/).some((l) => l.trim() === requiredIgnore)) {
        errors.push(
          `[Secret Hygiene Violation] .gitignore is missing required secret ignore pattern "${requiredIgnore}".`
        );
      }
    }
  }

  const trackedFiles = reader.listTrackedFiles();
  for (const tf of trackedFiles) {
    if (
      /(?:^|\/)(?:\.env|\.env\.local|\.env\..+\.local|\.dev\.vars|\.dev\.vars\..+|.+\.pem|.+\.key)$/.test(
        tf
      )
    ) {
      errors.push(
        `[Tracked Secret File Violation] Local secret/key file "${tf}" is tracked in Git index. Untrack it immediately.`
      );
    }

    if (tf.startsWith('public/data/')) continue;
    if (!/\.(?:ts|tsx|mts|cts|mjs|cjs|js|json|md|sql|yml|yaml|toml|html|css|svg|drawio|sh)$/i.test(tf)) {
      continue;
    }
    if (!reader.exists(tf)) continue;
    const rawBuf = reader.readBuffer(tf);
    if (rawBuf.length >= 3 && rawBuf[0] === 0xef && rawBuf[1] === 0xbb && rawBuf[2] === 0xbf) {
      errors.push(
        `[UTF-8 BOM Prohibited] ${tf} starts with a UTF-8 BOM (0xEF 0xBB 0xBF). Save all repository files as UTF-8 without BOM.`
      );
    }

    if (
      tf !== 'scripts/verify-docs-sync.mjs' &&
      !tf.startsWith('scripts/gates/') &&
      !tf.includes('__tests__/')
    ) {
      const txt = rawBuf.toString('utf8');
      if (REPO_WIDE_SECRET_REGEX.test(txt)) {
        errors.push(
          `[Repo-Wide Secret Token Violation] ${tf} contains a hardcoded API key, PAT, or Service Role JWT literal.`
        );
      }
    }
  }

  for (const cfgRel of ['.env.personal', '.env.portfolio', 'wrangler.toml']) {
    if (!reader.exists(cfgRel)) continue;
    const cfgText = reader.readText(cfgRel);
    if (
      /\b(?:GEMINI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|CLOUDFLARE_API_TOKEN)\b/.test(cfgText) ||
      /\bVITE_[A-Z0-9_]*(?:GEMINI|SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|ACCESS_TOKEN)\b/.test(cfgText) ||
      REPO_WIDE_SECRET_REGEX.test(cfgText)
    ) {
      errors.push(
        `[Tracked Config Secret Leak] ${cfgRel} contains secret environment keys or API token literals.`
      );
    }
  }

  console.log(
    `✅ [PASS] Check 5: Security, UTF-8 BOM, Anti-Backdoor & UX Gate verified across ${allSrcFiles.length} source/BFF files and ${trackedFiles.length} tracked files.`
  );
}
