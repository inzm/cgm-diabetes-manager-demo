import type { RepoReader } from './repo-reader.ts';

export const FORBIDDEN_TRACKED_DIRS: readonly string[] = [
  'legacy_vba',
  'docs/VBA_Project',
  'docs/screenshot',
  'docs/動画作成用資料',
  'docs/video_assets',
];

const PRIVATE_ISSUE_REF_REGEX = /(?:\bIssue\s*#\d+\b|[（(]#\d+[）),、]|[,、]\s*#\d+[）)])/i;

/**
 * Markdown ドキュメントの破損（未閉じコードフェンス・未閉じ数式ブロック・正規表現 $1 残存・文字化け U+FFFD・
 * 孤立テーブル行・未完了ステータスタグ・内部Issue参照・ローカルマシンパス混入）を検査する純粋関数
 */
export function inspectMarkdownIntegrity(relDoc: string, content: string): string[] {
  const docErrors: string[] = [];
  const normalized = String(content ?? '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  let inFence = false;
  let fenceStartLine = 0;
  let inMathBlock = false;
  let mathStartLine = 0;
  const nonFenceTableFlags = new Array<boolean>(lines.length).fill(false);
  const isPublicDoc = relDoc.startsWith('docs/Web_Project/') || relDoc === 'README.md';

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (rawLine.includes('\uFFFD')) {
      docErrors.push(
        `[Mojibake / Encoding Corruption Detected] ${relDoc}:${i + 1} contains Unicode replacement character (U+FFFD).`
      );
    }

    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      if (!inFence) {
        inFence = true;
        fenceStartLine = i + 1;
      } else {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    if (trimmed === '$$') {
      if (!inMathBlock) {
        inMathBlock = true;
        mathStartLine = i + 1;
      } else {
        inMathBlock = false;
      }
      continue;
    }

    if (/^\$[1-9]\d*$/.test(trimmed)) {
      docErrors.push(
        `[Doc Corruption Detected] ${relDoc}:${i + 1} contains literal regex placeholder "${trimmed}".`
      );
    }

    const lineWithoutInlineCode = trimmed.replace(/`[^`]*`/g, '');
    if (/file:\/\/\/[a-zA-Z0-9_~.%-]/i.test(lineWithoutInlineCode)) {
      docErrors.push(
        `[Machine-Local Link Leak] ${relDoc}:${i + 1} contains machine-local "file:///" URI.`
      );
    }
    if (/(?:[A-Za-z]:[\\/]+Users[\\/]+|\/Users\/)[A-Za-z0-9._-]+/i.test(lineWithoutInlineCode)) {
      docErrors.push(
        `[Local Username Path Leak] ${relDoc}:${i + 1} contains machine-specific OS user-home path.`
      );
    }

    if (relDoc.startsWith('docs/Web_Project/')) {
      const unresolvedMarkerMatch = lineWithoutInlineCode.match(
        /(?:【未決事項】|【要確認】|【改修予定】|【実装予定】|【将来案[^】]*】)/
      );
      if (unresolvedMarkerMatch) {
        docErrors.push(
          `[Prohibited Unresolved Spec Marker] ${relDoc}:${i + 1} contains prohibited unresolved marker "${unresolvedMarkerMatch[0]}". Manage unstarted or pending items in Private GitHub Issues and write only confirmed specifications.`
        );
      }
    }

    if (isPublicDoc) {
      const privateIssueRefMatch = lineWithoutInlineCode.match(PRIVATE_ISSUE_REF_REGEX);
      if (privateIssueRefMatch) {
        docErrors.push(
          `[Private Issue Reference Prohibited] ${relDoc}:${i + 1} references a Private GitHub Issue number ("${privateIssueRefMatch[0].trim()}") inside public documentation.`
        );
      }
    }

    if (/^\|.+\|$/.test(trimmed)) {
      nonFenceTableFlags[i] = true;
    }
  }

  if (inFence) {
    docErrors.push(
      `[Markdown Unclosed Code Fence] ${relDoc}:${fenceStartLine} opens a fenced code block that is never closed.`
    );
  }
  if (inMathBlock) {
    docErrors.push(
      `[Markdown Unclosed Math Block] ${relDoc}:${mathStartLine} opens a "$$" math block that is never closed.`
    );
  }

  for (let i = 0; i < lines.length; i++) {
    if (!nonFenceTableFlags[i]) continue;
    const prevIsTable = i > 0 && nonFenceTableFlags[i - 1];
    const nextIsTable = i + 1 < lines.length && nonFenceTableFlags[i + 1];
    if (!prevIsTable && !nextIsTable) {
      docErrors.push(
        `[Orphaned Markdown Table Row] ${relDoc}:${i + 1} has an isolated table row detached from any table header/separator: "${lines[i].trim().slice(0, 80)}".`
      );
    }
  }

  return docErrors;
}

export function runMarkdownAndPublicLeakGate(
  reader: RepoReader,
  docFiles: readonly string[],
  errors: string[]
): void {
  for (const relDoc of docFiles) {
    const content = reader.readText(relDoc);
    const integrityErrors = inspectMarkdownIntegrity(relDoc, content);
    for (const ie of integrityErrors) {
      errors.push(ie);
    }
  }

  // Scan public-facing CI/config files (.github/workflows/*, wrangler.toml, package.json) for Private Issue #XX leaks & personal project hardcodes
  const publicConfigTargets = [
    ...reader.listFilesUnder('.github/workflows', ['.yml', '.yaml']),
    'wrangler.toml',
    'package.json',
  ].filter((rel) => reader.exists(rel));

  for (const relCfg of publicConfigTargets) {
    const content = reader.readText(relCfg);
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/\bIssue\s*#\d+\b/i);
      if (m) {
        errors.push(
          `[Public Config Private Issue Leak] ${relCfg}:${i + 1} exposes Private GitHub reference "${m[0]}" in a file published to public-demo.`
        );
      }
    }
    if (/cgm-diabetes-manager-personal/i.test(content)) {
      errors.push(
        `[Public Config Leak] ${relCfg} hardcodes private project name "cgm-diabetes-manager-personal". Use neutral project name and pass environment target via CI Variables.`
      );
    }
  }

  // Verify zero tracked files under forbidden legacy/private directories
  const trackedFiles = reader.listTrackedFiles();
  for (const forbiddenDir of FORBIDDEN_TRACKED_DIRS) {
    const prefix = `${forbiddenDir}/`;
    const matched = trackedFiles.filter((f) => f === forbiddenDir || f.startsWith(prefix));
    if (matched.length > 0) {
      errors.push(
        `[Forbidden Legacy Asset Tracked] "${forbiddenDir}/" has ${matched.length} file(s) tracked in Git index. Untrack them and keep in .gitignore.`
      );
    }
  }

  console.log(
    `✅ [PASS] Check 9: Doc corruption guard, public config private Issue leak guard, & legacy VBA asset isolation verified.`
  );
}
