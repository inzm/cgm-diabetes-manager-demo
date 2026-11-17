// @vitest-environment node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SOURCE_TO_SPEC_RULES,
  createRepoReader,
  evaluateSpecFirstIdentExemption,
  extractAddedBacktickIdentifiersFromDiff,
  inspectMarkdownIntegrity,
  isPureSpecFirstCommit,
  parseLatestDexieStores,
  parseMermaidErdEntities,
  parseSequentialMigrations,
  parseTsInterfaces,
  runAllGates,
  stripJsCommentsPreservingStrings,
} from '../gates/index.ts';
import type { RepoReader } from '../gates/repo-reader.ts';
import { runSecurityAndUxGate } from '../gates/security-ux.ts';
import { runMarkdownAndPublicLeakGate } from '../gates/markdown-integrity.ts';
import { runSchemaAndDiagramParityGate } from '../gates/schema-parity.ts';
import {
  getExplicitDiffRange,
  getPrecedingSpecFirstContext,
  runGitDiffSyncGate,
} from '../gates/git-diff-sync.ts';
import {
  evaluateShipStagingState,
  isVerifyStampReusable,
} from '../orchestrate-pipeline.mjs';
import { allocateEphemeralPort, deriveSmokeEndpoints } from '../smoke-test.mjs';
import { verifyDeployedEndpoint } from '../post-deploy-smoke.mjs';
import { evaluatePreToolGuard } from '../../.agents/hooks/pre-tool-guard.mjs';
import {
  didTranscriptLinesTouchWorkspace,
  hasHeadAdvancedSinceSessionStart,
} from '../../.agents/hooks/stop-guard.mjs';

function createMockRepoReader(files: Record<string, string | Buffer>, isStagedMode = false): RepoReader {
  const normalized = new Map<string, Buffer>();
  for (const [k, v] of Object.entries(files)) {
    const cleanKey = k.replace(/^\/+/, '');
    normalized.set(cleanKey, Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8'));
  }
  const sortedKeys = Array.from(normalized.keys()).sort();

  return {
    rootDir: process.cwd(),
    isStagedMode,
    exists(relPosixPath: string): boolean {
      const clean = relPosixPath.replace(/^\/+/, '');
      if (normalized.has(clean)) return true;
      const prefix = clean.replace(/\/+$/, '') + '/';
      return sortedKeys.some((k) => k.startsWith(prefix));
    },
    readText(relPosixPath: string): string {
      return this.readBuffer(relPosixPath).toString('utf8');
    },
    readBuffer(relPosixPath: string): Buffer {
      const clean = relPosixPath.replace(/^\/+/, '');
      const buf = normalized.get(clean);
      if (!buf) throw new Error(`Mock file not found: ${clean}`);
      return buf;
    },
    listTrackedFiles(): string[] {
      return sortedKeys;
    },
    listFilesUnder(relDirPosix: string, extFilter?: string | readonly string[]): string[] {
      const prefix = relDirPosix.replace(/^\/+/, '').replace(/\/+$/, '') + '/';
      return sortedKeys.filter((k) => {
        if (!k.startsWith(prefix)) return false;
        if (!extFilter) return true;
        if (typeof extFilter === 'string') return k.endsWith(extFilter);
        return extFilter.some((ext) => k.endsWith(ext));
      });
    },
  };
}

describe('Staged Index RepoReader & Partial Staging Isolation', () => {
  it('reads exclusively from Git Staging Index blobs when isStagedMode=true, ignoring unstaged Working Tree edits', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgm-repo-reader-test-'));
    try {
      const git = (args: string[]) =>
        execFileSync('git', args, { cwd: tmpDir, encoding: 'utf8' });

      git(['init']);
      git(['config', 'user.email', 'test@example.com']);
      git(['config', 'user.name', 'Test Runner']);

      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src', 'calc.ts'), 'export const v = 1;\n', 'utf8');
      git(['add', 'src/calc.ts']);
      git(['commit', '-m', 'chore: initial']);

      // Stage v = 2 into Git Index
      fs.writeFileSync(path.join(tmpDir, 'src', 'calc.ts'), 'export const v = 2;\n', 'utf8');
      git(['add', 'src/calc.ts']);

      // Mutate Working Tree WITHOUT git add (Partial Staging scenario) + create unstaged file
      fs.writeFileSync(path.join(tmpDir, 'src', 'calc.ts'), 'export const v = 999;\n', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'src', 'untracked.ts'), 'export const u = true;\n', 'utf8');

      const stagedReader = createRepoReader(tmpDir, { isStagedMode: true });
      const worktreeReader = createRepoReader(tmpDir, { isStagedMode: false });

      expect(stagedReader.readText('src/calc.ts')).toBe('export const v = 2;\n');
      expect(stagedReader.exists('src/untracked.ts')).toBe(false);
      expect(stagedReader.listFilesUnder('src', '.ts')).toEqual(['src/calc.ts']);

      expect(worktreeReader.readText('src/calc.ts')).toBe('export const v = 999;\n');
      expect(worktreeReader.exists('src/untracked.ts')).toBe(true);
      expect(worktreeReader.listFilesUnder('src', '.ts')).toEqual([
        'src/calc.ts',
        'src/untracked.ts',
      ]);

      // Verify staged deletion (`git rm`), staged rename (`git mv`), and Unicode filenames
      fs.writeFileSync(path.join(tmpDir, 'src', 'old.ts'), 'export const old = 1;\n', 'utf8');
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'docs', '仕様メモ.md'), '# 日本語パス\n', 'utf8');
      git(['add', 'src/old.ts', 'docs/仕様メモ.md']);
      git(['commit', '-m', 'chore: add old and unicode doc']);

      git(['rm', '-f', 'src/calc.ts']);
      git(['mv', 'src/old.ts', 'src/renamed.ts']);

      const afterRmMvReader = createRepoReader(tmpDir, { isStagedMode: true });
      expect(afterRmMvReader.exists('src/calc.ts')).toBe(false);
      expect(afterRmMvReader.exists('src/old.ts')).toBe(false);
      expect(afterRmMvReader.exists('src/renamed.ts')).toBe(true);
      expect(afterRmMvReader.exists('docs/仕様メモ.md')).toBe(true);
      expect(afterRmMvReader.readText('src/renamed.ts')).toBe('export const old = 1;\n');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('enforces Spec-First git diff sync and honors preceding docs(spec): commits', () => {
    expect(getExplicitDiffRange(['node', 'script', '--diff-range=HEAD~1..HEAD'])).toBe(
      'HEAD~1..HEAD'
    );
    expect(getExplicitDiffRange(['node', 'script', '--diff-range', 'main...HEAD'])).toBe(
      'main...HEAD'
    );

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgm-diff-sync-test-'));
    try {
      const git = (args: string[]) =>
        execFileSync('git', args, { cwd: tmpDir, encoding: 'utf8' });

      git(['init']);
      git(['config', 'user.email', 'test@example.com']);
      git(['config', 'user.name', 'Test Runner']);

      fs.mkdirSync(path.join(tmpDir, 'src', 'lib'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'docs', 'Web_Project'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src', 'lib', 'db.ts'), 'export const v = 1;\n', 'utf8');
      fs.writeFileSync(
        path.join(tmpDir, 'docs', 'Web_Project', 'ARCHITECTURE.md'),
        '# Arch v1\n',
        'utf8'
      );
      git(['add', '.']);
      git(['commit', '-m', 'chore: initial']);

      // 1. Modifying src/lib/db.ts WITHOUT updating ARCHITECTURE.md must fail
      fs.writeFileSync(path.join(tmpDir, 'src', 'lib', 'db.ts'), 'export const v = 2;\n', 'utf8');
      git(['add', 'src/lib/db.ts']);
      const missingSpecErrors: string[] = [];
      runGitDiffSyncGate(
        tmpDir,
        { isStagedMode: true, skipDiffGate: false, explicitRange: '' },
        missingSpecErrors
      );
      expect(missingSpecErrors.some((e) => e.includes('[Required Spec Sync Missing]'))).toBe(true);
      expect(missingSpecErrors.some((e) => e.includes('[Spec Sync Required]'))).toBe(true);

      // Reset src/lib/db.ts, commit preceding pure docs(spec): commit, then stage src/lib/db.ts
      git(['checkout', 'HEAD', '--', 'src/lib/db.ts']);
      fs.writeFileSync(
        path.join(tmpDir, 'docs', 'Web_Project', 'ARCHITECTURE.md'),
        '# Arch v2\n',
        'utf8'
      );
      git(['add', 'docs/Web_Project/ARCHITECTURE.md']);
      git(['commit', '-m', 'docs(spec): specify db v2']);

      const ctx = getPrecedingSpecFirstContext(tmpDir, 'HEAD');
      expect(ctx.commits.length).toBe(1);
      expect(ctx.specFiles).toContain('docs/Web_Project/ARCHITECTURE.md');

      fs.writeFileSync(path.join(tmpDir, 'src', 'lib', 'db.ts'), 'export const v = 2;\n', 'utf8');
      git(['add', 'src/lib/db.ts']);
      const okErrors: string[] = [];
      runGitDiffSyncGate(
        tmpDir,
        { isStagedMode: true, skipDiffGate: false, explicitRange: '' },
        okErrors
      );
      expect(okErrors).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Sequential SQL Migration Parser & Supabase Security/Performance Lint Guards', () => {
  it('evolves CREATE TABLE, ALTER TABLE (ADD / ALTER TYPE / DROP), function schemas, and RLS policies in sequence', () => {
    const cumulative = parseSequentialMigrations([
      {
        fileName: '001_init.sql',
        sql: `
          CREATE TABLE public.events (
            id UUID PRIMARY KEY,
            timing_category VARCHAR(30),
            legacy_col TEXT
          );
          ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
          CREATE OR REPLACE FUNCTION public.can_view_patient_data(target_owner_id UUID)
          RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN true; END; $$;
          CREATE POLICY "family_permissions_all" ON public.family_permissions FOR ALL USING (true);
          CREATE POLICY "family_permissions_accept_invite" ON public.family_permissions FOR UPDATE USING (true);
        `,
      },
      {
        fileName: '002_evolve.sql',
        sql: `
          ALTER TABLE public.events ALTER COLUMN timing_category TYPE VARCHAR(50);
          ALTER TABLE public.events ADD COLUMN notes TEXT;
          ALTER TABLE public.events DROP COLUMN legacy_col;
          CREATE OR REPLACE FUNCTION app_private.can_view_patient_data(target_owner_id UUID)
          RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN true; END; $$;
          DROP FUNCTION IF EXISTS public.can_view_patient_data(UUID);
          CREATE OR REPLACE FUNCTION public.enforce_invited_or_owner_signup()
          RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN NEW; END; $$;
          ALTER FUNCTION public.enforce_invited_or_owner_signup() SET SCHEMA app_private;
          CREATE OR REPLACE FUNCTION public.verify_user_authorization()
          RETURNS BOOLEAN LANGUAGE sql SECURITY INVOKER AS $$ SELECT true; $$;
          DROP POLICY IF EXISTS "family_permissions_all" ON public.family_permissions;
          DROP POLICY IF EXISTS "family_permissions_accept_invite" ON public.family_permissions;
          CREATE POLICY "family_permissions_update" ON public.family_permissions FOR UPDATE USING (true);
        `,
      },
    ]);

    const eventCols = cumulative.tables.get('events');
    expect(eventCols).toBeDefined();
    expect(eventCols?.get('timing_category')).toEqual({ type: 'VARCHAR(50)', varcharLength: 50 });
    expect(eventCols?.has('notes')).toBe(true);
    expect(eventCols?.has('legacy_col')).toBe(false);
    expect(cumulative.rlsEnabledTables.has('events')).toBe(true);

    expect(cumulative.functions.has('public.can_view_patient_data')).toBe(false);
    expect(cumulative.functions.has('public.enforce_invited_or_owner_signup')).toBe(false);
    expect(cumulative.functions.get('app_private.enforce_invited_or_owner_signup')?.security).toBe(
      'DEFINER'
    );
    expect(cumulative.functions.get('app_private.can_view_patient_data')?.security).toBe('DEFINER');
    expect(cumulative.functions.get('public.verify_user_authorization')?.security).toBe('INVOKER');

    expect(cumulative.familyPermissionsPolicies.has('family_permissions_all')).toBe(false);
    expect(cumulative.familyPermissionsPolicies.has('family_permissions_accept_invite')).toBe(false);
    expect(cumulative.familyPermissionsPolicies.has('family_permissions_update')).toBe(true);
  });

  it('rejects exposed SECURITY DEFINER functions in public (Lint 0029) and duplicate policies (Lint 0006)', () => {
    const badReader = createMockRepoReader({
      'supabase/migrations/001_bad.sql': `
        CREATE OR REPLACE FUNCTION public.leaked_definer()
        RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN true; END; $$;
        CREATE POLICY "family_permissions_all" ON public.family_permissions FOR ALL USING (true);
      `,
    });
    const errors: string[] = [];
    runSchemaAndDiagramParityGate(badReader, errors);
    expect(errors.some((e) => e.includes('[Supabase Lint 0029 Guard]'))).toBe(true);
    expect(errors.some((e) => e.includes('[Supabase Lint 0006 Guard]'))).toBe(true);
  });

  it('passes full schema, snapshot, ARCHITECTURE §5 catalog, TypeScript, Dexie, and ERD parity on real workspace', () => {
    const realReader = createRepoReader(process.cwd(), { isStagedMode: false });
    const errors: string[] = [];
    runSchemaAndDiagramParityGate(realReader, errors);
    expect(errors).toEqual([]);
  });
});

describe('Dexie Latest Version, TypeScript Interface, & Mermaid ERD Parsers', () => {
  it('selects the highest Dexie schema version and extracts compound index columns', () => {
    const sampleDb = `
      this.version(1).stores({
        events: 'id, user_id'
      });
      this.version(3).stores({
        events: 'id, [user_id+event_datetime], [user_id+is_deleted]',
        libre_readings: 'id, [user_id+timestamp]'
      });
      this.version(2).stores({
        events: 'id, user_id, event_datetime'
      });
    `;
    const parsed = parseLatestDexieStores(sampleDb);
    expect(parsed.version).toBe(3);
    expect(Array.from(parsed.stores.get('events') ?? [])).toEqual([
      'id',
      'user_id',
      'event_datetime',
      'is_deleted',
    ]);
  });

  it('parses top-level TypeScript interface properties without leaking nested object literals', () => {
    const tsCode = `
      export interface SampleRow {
        id: string; // PK
        metadata?: {
          nested_should_not_appear: number;
        };
        created_at: string;
      }
    `;
    const map = parseTsInterfaces(tsCode);
    expect(Array.from(map.get('SampleRow') ?? [])).toEqual(['id', 'metadata', 'created_at']);
  });

  it('parses Mermaid erDiagram entity attributes accurately', () => {
    const md = [
      '```mermaid',
      'erDiagram',
      '    user_settings {',
      '        uuid user_id PK',
      '        numeric target_low',
      '    }',
      '```',
    ].join('\n');
    const erd = parseMermaidErdEntities(md);
    expect(Array.from(erd.get('user_settings') ?? [])).toEqual(['user_id', 'target_low']);
  });
});

describe('Security, E2E Backdoor Removal, UX Jargon & Wall-Clock Gates', () => {
  it('preserves code following https:// URLs inside strings when stripping comments', () => {
    const src = `const endpoint = "https://api.example.com/v1"; const danger = window.confirm("ok?"); // trailing comment`;
    const stripped = stripJsCommentsPreservingStrings(src);
    expect(stripped).toContain('window.confirm("ok?")');
    expect(stripped).not.toContain('trailing comment');
  });

  it('flags E2E client backdoors, leaked API keys, unauthorized toISOString(), and developer jargon in UI', () => {
    const fakeGeminiKey = 'AIza' + 'B'.repeat(35);
    const bomBuffer = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"ok":true}\n', 'utf8'),
    ]);
    const mockReader = createMockRepoReader({
      'package.json': bomBuffer,
      'src/App.tsx': `
        const w = window.__CGM_E2E_FORCE_PERSONAL__;
        const iso = new Date().toISOString().slice(0, 10);
        const k = "${fakeGeminiKey}";
      `,
      'src/components/BadPanel.tsx': `
        export function BadPanel() {
          window.confirm("delete?");
          return <div>IndexedDB キャッシュ</div>;
        }
      `,
    });
    const errors: string[] = [];
    runSecurityAndUxGate(mockReader, errors);

    expect(errors.some((e) => e.includes('__CGM_E2E_'))).toBe(true);
    expect(errors.some((e) => e.includes('9-hour UTC drift'))).toBe(true);
    expect(errors.some((e) => e.includes('Google/Gemini API key'))).toBe(true);
    expect(errors.some((e) => e.includes('window.confirm()'))).toBe(true);
    expect(errors.some((e) => e.includes('[User-Centric UX Violation]'))).toBe(true);
    expect(errors.some((e) => e.includes('[UTF-8 BOM Prohibited] package.json'))).toBe(true);
  });
});

describe('Markdown Integrity, UTF-8 BOM, & Public Repository Leak Guards', () => {
  it('detects unclosed code fences, unclosed LaTeX blocks, local paths, and Issue references', () => {
    const brokenMd = [
      '# Sample Spec',
      '【未決事項】対応検討 (Issue #42)',
      'See [link](file:///C:/Users/LocalDevUser/secret.md)',
      '$$',
      'TIR = 70%',
      '```sql',
      'SELECT 1;',
    ].join('\n');

    const errs = inspectMarkdownIntegrity('docs/Web_Project/SPEC_TEST.md', brokenMd);
    expect(errs.some((e) => e.includes('[Markdown Unclosed Code Fence]'))).toBe(true);
    expect(errs.some((e) => e.includes('[Markdown Unclosed Math Block]'))).toBe(true);
    expect(errs.some((e) => e.includes('[Prohibited Unresolved Spec Marker]'))).toBe(true);
    expect(errs.some((e) => e.includes('[Private Issue Reference Prohibited]'))).toBe(true);
    expect(errs.some((e) => e.includes('[Machine-Local Link Leak]'))).toBe(true);
    expect(errs.some((e) => e.includes('[Local Username Path Leak]'))).toBe(true);
  });

  it('detects private Cloudflare project names and private Issue refs in deploy-pages.yml', () => {
    const reader = createMockRepoReader({
      '.github/workflows/deploy-pages.yml':
        'command: pages deploy dist --project-name=cgm-diabetes-manager-personal # Issue #87\n',
    });
    const errors: string[] = [];
    runMarkdownAndPublicLeakGate(reader, [], errors);

    expect(errors.some((e) => e.includes('[Public Config Leak]'))).toBe(true);
    expect(errors.some((e) => e.includes('[Public Config Private Issue Leak]'))).toBe(true);
  });
});

describe('Spec-First Exemptions & Pipeline Explicit Staging / Verify Stamp Rules', () => {
  it('allows Spec-First identifier exemptions ONLY when 100% of active files are pure docs', () => {
    expect(
      evaluateSpecFirstIdentExemption({
        forceStrictIdents: false,
        isStagedMode: true,
        activeFiles: ['docs/Web_Project/SPEC_CALENDAR.md'],
      }).allowUncommittedDocDiff
    ).toBe(true);

    expect(
      evaluateSpecFirstIdentExemption({
        forceStrictIdents: false,
        isStagedMode: false,
        activeFiles: ['docs/Web_Project/SPEC_CALENDAR.md', 'src/lib/dateUtils.ts'],
      })
    ).toEqual({
      allowUncommittedDocDiff: false,
      allowPrecedingSpecCommits: false,
    });

    expect(
      evaluateSpecFirstIdentExemption({
        forceStrictIdents: true,
        isStagedMode: false,
        activeFiles: ['docs/Web_Project/SPEC_CALENDAR.md'],
      })
    ).toEqual({
      allowUncommittedDocDiff: false,
      allowPrecedingSpecCommits: false,
    });
  });

  it('validates pure spec-first commits and diff backtick identifier extraction', () => {
    expect(isPureSpecFirstCommit('docs(spec): update spec', ['docs/Web_Project/SPEC_SYNC.md'])).toBe(
      true
    );
    expect(
      isPureSpecFirstCommit('docs(spec): mixed', ['docs/Web_Project/SPEC_SYNC.md', 'src/App.tsx'])
    ).toBe(false);

    const diff = `+Added \`buildCleanDemoCommit()\` and ignored \`README.md\`.\n-Removed \`oldHelperFn\`\n`;
    expect(Array.from(extractAddedBacktickIdentifiersFromDiff(diff))).toEqual([
      'buildCleanDemoCommit',
    ]);
    expect(SOURCE_TO_SPEC_RULES.length).toBeGreaterThanOrEqual(8);
  });

  it('enforces explicit git add staging in --ship mode (Decision 3: git add -A abolished)', () => {
    expect(
      evaluateShipStagingState({
        stagedFiles: ['src/App.tsx'],
        unstagedFiles: ['src/lib/db.ts'],
        untrackedFiles: [],
      }).ok
    ).toBe(false);

    expect(
      evaluateShipStagingState({
        stagedFiles: ['src/App.tsx'],
        unstagedFiles: [],
        untrackedFiles: ['notes.txt'],
      }).ok
    ).toBe(false);

    expect(
      evaluateShipStagingState({
        stagedFiles: ['src/App.tsx', 'docs/Web_Project/ARCHITECTURE.md'],
        unstagedFiles: [],
        untrackedFiles: [],
      })
    ).toEqual({ ok: true, action: 'commit_staged', reason: null });

    expect(
      evaluateShipStagingState({
        stagedFiles: [],
        unstagedFiles: [],
        untrackedFiles: [],
      })
    ).toEqual({ ok: true, action: 'push_clean_head', reason: null });
  });

  it('reuses Verify Stamp strictly when tree SHA, HEAD, target, envHash, and TTL match', () => {
    const fp = {
      worktreeTreeSha: 'aaaa1111bbbb2222',
      headSha: 'cccc3333',
      targetEnv: 'personal',
      envHash: '1234567890abcdef',
    };
    const now = 1_700_000_000_000;
    const validStamp = {
      ...fp,
      skipVisual: false,
      verifiedAt: '2026-11-17T00:00:00.000Z',
      verifiedAtMs: now - 60_000,
    };

    expect(isVerifyStampReusable(validStamp, fp, now)).toBe(true);
    expect(isVerifyStampReusable({ ...validStamp, skipVisual: true }, fp, now)).toBe(false);
    expect(isVerifyStampReusable(validStamp, { ...fp, worktreeTreeSha: 'different' }, now)).toBe(
      false
    );
    expect(isVerifyStampReusable(validStamp, fp, now + 20 * 60_000)).toBe(false);
  });
});

describe('Agent Lifecycle Hook Guards (PreToolUse & Stop Transcript Detection)', () => {
  it('blocks legacy_vba mutations, Excel COM commands, force-push to main, and .env reads', () => {
    expect(
      evaluatePreToolGuard({
        tool_name: 'edit_file',
        tool_input: { Path: 'C:/repo/legacy_vba/Module1.bas' },
      }).decision
    ).toBe('deny');

    expect(
      evaluatePreToolGuard({
        tool_name: 'run_command',
        tool_input: { CommandLine: 'New-Object -ComObject Excel.Application' },
      }).decision
    ).toBe('deny');

    expect(
      evaluatePreToolGuard({
        tool_name: 'run_command',
        tool_input: { CommandLine: 'git push --force origin main' },
      }).decision
    ).toBe('deny');

    expect(
      evaluatePreToolGuard({
        tool_name: 'read_file',
        tool_input: { Path: 'C:/repo/.env.local' },
      }).decision
    ).toBe('deny');

    expect(
      evaluatePreToolGuard({
        tool_name: 'read_file',
        tool_input: { Path: 'C:/repo/.dev.vars' },
      }).decision
    ).toBe('deny');

    expect(
      evaluatePreToolGuard({
        tool_name: 'read_file',
        tool_input: { Path: 'C:/repo/.env.example' },
      }).decision
    ).toBe('allow');
  });

  it('detects workspace mutations anywhere in the full transcript even if followed by 20+ read-only turns', () => {
    const lines = [
      JSON.stringify({
        type: 'MODEL_RESPONSE',
        tool_calls: [{ name: 'edit_file', args: { Path: 'src/App.tsx' } }],
      }),
      ...Array.from({ length: 25 }, (_, idx) =>
        JSON.stringify({
          type: 'MODEL_RESPONSE',
          tool_calls: [{ name: 'read_file', args: { Path: `src/file_${idx}.ts` } }],
        })
      ),
    ];
    expect(didTranscriptLinesTouchWorkspace(lines)).toBe(true);
    expect(didTranscriptLinesTouchWorkspace(lines.slice(1))).toBe(false);
  });

  it('preserves per-session HEAD baseline across subagent spawns and outputs protojson-safe {} on SessionStart', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgm-session-state-'));
    try {
      const stateFile = path.join(tmpDir, 'session-start-state.json');
      const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      }).trim();

      fs.writeFileSync(
        stateFile,
        JSON.stringify({
          startedAt: '2026-11-17T00:00:00.000Z',
          headSha: currentHead, // overwritten by child subagent after parent committed
          sessionId: 'child-subagent-id',
          sessions: {
            'parent-session-id': {
              startedAt: '2026-11-17T00:00:00.000Z',
              headSha: '0000000000000000000000000000000000000001',
            },
            'child-subagent-id': {
              startedAt: '2026-11-17T00:01:00.000Z',
              headSha: currentHead,
            },
          },
        }),
        'utf8'
      );

      expect(
        hasHeadAdvancedSinceSessionStart(stateFile, process.cwd(), 'parent-session-id')
      ).toBe(true);
      expect(
        hasHeadAdvancedSinceSessionStart(stateFile, process.cwd(), 'child-subagent-id')
      ).toBe(false);

      const sessionOut = execFileSync(
        process.execPath,
        [path.join(process.cwd(), '.agents', 'hooks', 'session-start.mjs')],
        { input: JSON.stringify({ sessionId: 'unit-test-session' }), encoding: 'utf8' }
      ).trim();
      expect(sessionOut).toBe('{}');

      const ephemeralPort = await allocateEphemeralPort();
      expect(ephemeralPort).toBeGreaterThan(1024);
      expect(ephemeralPort).not.toBe(5173);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('runs runAllGates cleanly on the current repository state when SKIP_DOC_SYNC=1', () => {
    const prev = process.env.SKIP_DOC_SYNC;
    process.env.SKIP_DOC_SYNC = '1';
    try {
      const smokeEndpoints = deriveSmokeEndpoints(process.cwd());
      const res = runAllGates({
        rootDir: process.cwd(),
        argv: ['node', 'verify-docs-sync.mjs'],
        smokeEndpoints,
      });
      expect(res.errors).toEqual([]);
      expect(res.passed).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SKIP_DOC_SYNC;
      else process.env.SKIP_DOC_SYNC = prev;
    }
  });
});

describe('Post-Deploy Live Smoke Verifier (post-deploy-smoke.mjs)', () => {
  it('verifies personal deployment shell, SW stamp, demo JSON exclusion, and 401 BFF JWT boundary', async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/sw.js')) {
        return new Response("const CACHE_NAME = 'cgm-manager-v2-a1b2c3d4';", { status: 200 });
      }
      if (url.endsWith('/data/real_glucose_recent.json')) {
        return new Response('<!doctype html><div id="root"></div>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url.endsWith('/api/gemini')) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
      }
      return new Response('<!doctype html><html><body><div id="root"></div></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    };

    const okPersonal = await verifyDeployedEndpoint({
      target: 'personal',
      baseUrl: 'https://personal-example.pages.dev',
      fetchImpl: mockFetch,
    });
    expect(okPersonal.passed).toBe(true);

    // Must fail if /api/gemini returns 200 without JWT on personal deployment
    const leakyBffFetch: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/api/gemini')) {
        return new Response('{}', { status: 200 });
      }
      return mockFetch(input, init);
    };
    const failedPersonal = await verifyDeployedEndpoint({
      target: 'personal',
      baseUrl: 'https://personal-example.pages.dev',
      fetchImpl: leakyBffFetch,
    });
    expect(failedPersonal.passed).toBe(false);
  });

  it('verifies demo deployment serves portfolio dataset JSON cleanly', async () => {
    const demoFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/sw.js')) {
        return new Response("const CACHE_NAME = 'cgm-manager-v2-deadbeef';", { status: 200 });
      }
      if (url.endsWith('/data/real_glucose_recent.json')) {
        return new Response('[{"t":"2026-08-01T08:00:00.000Z","v":110}]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('<!doctype html><div id="root"></div>', { status: 200 });
    };

    const okDemo = await verifyDeployedEndpoint({
      target: 'demo',
      baseUrl: 'https://demo-example.pages.dev',
      fetchImpl: demoFetch,
    });
    expect(okDemo.passed).toBe(true);
  });
});
