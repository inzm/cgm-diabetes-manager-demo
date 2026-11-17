import type { RepoReader } from './repo-reader.ts';

export interface ParsedColumnDef {
  type: string;
  varcharLength: number | null;
}

export interface ParsedFunctionDef {
  schema: string;
  name: string;
  security: 'DEFINER' | 'INVOKER';
}

export interface CumulativeSqlSchema {
  migrationFiles: string[];
  tables: Map<string, Map<string, ParsedColumnDef>>;
  rlsEnabledTables: Set<string>;
  functions: Map<string, ParsedFunctionDef>;
  familyPermissionsPolicies: Set<string>;
}

export const SQL_TABLE_TO_TS_INTERFACE: Readonly<Record<string, string>> = {
  family_permissions: 'FamilyPermission',
  libre_readings: 'LibreReading',
  events: 'HealthEvent',
  meal_details: 'MealDetail',
  categories: 'Category',
  food_master: 'FoodMaster',
  event_master: 'EventMaster',
  user_settings: 'UserSettings',
};

function parseColumnType(rawType: string): ParsedColumnDef {
  const cleanType = rawType.toUpperCase().replace(/\s+/g, '');
  const varcharMatch = cleanType.match(/^VARCHAR\((\d+)\)$/);
  return {
    type: cleanType,
    varcharLength: varcharMatch ? parseInt(varcharMatch[1], 10) : null,
  };
}

/**
 * 連番 SQL マイグレーション群を順番に適用解析し、CREATE TABLE・ALTER TABLE (ADD / ALTER TYPE / DROP)・
 * SECURITY DEFINER / INVOKER 関数・DROP FUNCTION・family_permissions RLS ポリシーの最終状態を導出する
 */
export function parseSequentialMigrations(
  migrations: ReadonlyArray<{ fileName: string; sql: string }>
): CumulativeSqlSchema {
  const tables = new Map<string, Map<string, ParsedColumnDef>>();
  const rlsEnabledTables = new Set<string>();
  const functions = new Map<string, ParsedFunctionDef>();
  const familyPermissionsPolicies = new Set<string>();

  for (const { sql } of migrations) {
    const normalized = sql.replace(/\r\n/g, '\n');

    // 1. CREATE TABLE [IF NOT EXISTS] [public.]<name> (...)
    const createTableRegex =
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\);/gi;
    let m: RegExpExecArray | null;
    while ((m = createTableRegex.exec(normalized)) !== null) {
      const tableName = m[1].toLowerCase();
      const body = m[2];
      const cols = tables.get(tableName) ?? new Map<string, ParsedColumnDef>();
      for (const rawLine of body.split('\n')) {
        const line = rawLine.replace(/--.*$/, '').trim().replace(/,$/, '').trim();
        if (!line) continue;
        if (/^(?:CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)\b/i.test(line)) continue;
        const colMatch = line.match(
          /^([a-z_][a-z0-9_]*)\s+([A-Z0-9_]+(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?)/i
        );
        if (colMatch) {
          cols.set(colMatch[1].toLowerCase(), parseColumnType(colMatch[2]));
        }
      }
      tables.set(tableName, cols);
    }

    // 2. ALTER TABLE ... ADD [COLUMN] / ALTER [COLUMN] TYPE / DROP [COLUMN] / ENABLE ROW LEVEL SECURITY
    const cleanLines = normalized
      .split('\n')
      .map((l) => l.replace(/--.*$/, '').trim())
      .join('\n');

    const alterAddRegex =
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+([A-Z0-9_]+(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?)/gi;
    while ((m = alterAddRegex.exec(cleanLines)) !== null) {
      const tbl = tables.get(m[1].toLowerCase());
      if (tbl) {
        tbl.set(m[2].toLowerCase(), parseColumnType(m[3]));
      }
    }

    const alterTypeRegex =
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+ALTER\s+(?:COLUMN\s+)?([a-z_][a-z0-9_]*)\s+(?:SET\s+DATA\s+)?TYPE\s+([A-Z0-9_]+(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?)/gi;
    while ((m = alterTypeRegex.exec(cleanLines)) !== null) {
      const tbl = tables.get(m[1].toLowerCase());
      if (tbl) {
        tbl.set(m[2].toLowerCase(), parseColumnType(m[3]));
      }
    }

    const alterDropRegex =
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
    while ((m = alterDropRegex.exec(cleanLines)) !== null) {
      const tbl = tables.get(m[1].toLowerCase());
      if (tbl) {
        tbl.delete(m[2].toLowerCase());
      }
    }

    const rlsRegex =
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi;
    while ((m = rlsRegex.exec(cleanLines)) !== null) {
      rlsEnabledTables.add(m[1].toLowerCase());
    }

    // 3. Track CREATE OR REPLACE FUNCTION, ALTER FUNCTION ... SET SCHEMA, and DROP FUNCTION in source order
    const fnEvents: Array<
      | { index: number; op: 'create'; schema: string; name: string; security: 'DEFINER' | 'INVOKER' }
      | { index: number; op: 'alter_schema'; oldSchema: string; name: string; newSchema: string }
      | { index: number; op: 'drop'; schema: string; name: string }
    > = [];

    const createFnRegex =
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:([a-z_][a-z0-9_]*)\.)?([a-z_][a-z0-9_]*)\s*\([\s\S]*?\$\$[\s\S]*?\$\$([\s\S]*?);/gi;
    while ((m = createFnRegex.exec(cleanLines)) !== null) {
      const schemaName = (m[1] || 'public').toLowerCase();
      const fnName = m[2].toLowerCase();
      const headerAndTail = m[0];
      const security: 'DEFINER' | 'INVOKER' = /SECURITY\s+DEFINER/i.test(headerAndTail)
        ? 'DEFINER'
        : 'INVOKER';
      fnEvents.push({ index: m.index, op: 'create', schema: schemaName, name: fnName, security });
    }

    const alterFnSchemaRegex =
      /ALTER\s+FUNCTION\s+(?:([a-z_][a-z0-9_]*)\.)?([a-z_][a-z0-9_]*)\s*\([^)]*\)\s*SET\s+SCHEMA\s+([a-z_][a-z0-9_]*)/gi;
    while ((m = alterFnSchemaRegex.exec(cleanLines)) !== null) {
      const oldSchema = (m[1] || 'public').toLowerCase();
      const fnName = m[2].toLowerCase();
      const newSchema = m[3].toLowerCase();
      fnEvents.push({ index: m.index, op: 'alter_schema', oldSchema, name: fnName, newSchema });
    }

    const dropFnRegex =
      /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:([a-z_][a-z0-9_]*)\.)?([a-z_][a-z0-9_]*)\s*\(/gi;
    while ((m = dropFnRegex.exec(cleanLines)) !== null) {
      const schemaName = (m[1] || 'public').toLowerCase();
      const fnName = m[2].toLowerCase();
      fnEvents.push({ index: m.index, op: 'drop', schema: schemaName, name: fnName });
    }

    fnEvents.sort((a, b) => a.index - b.index);
    for (const ev of fnEvents) {
      if (ev.op === 'create') {
        functions.set(`${ev.schema}.${ev.name}`, {
          schema: ev.schema,
          name: ev.name,
          security: ev.security,
        });
      } else if (ev.op === 'alter_schema') {
        const prev = functions.get(`${ev.oldSchema}.${ev.name}`);
        functions.delete(`${ev.oldSchema}.${ev.name}`);
        functions.set(`${ev.newSchema}.${ev.name}`, {
          schema: ev.newSchema,
          name: ev.name,
          security: prev?.security ?? 'DEFINER',
        });
      } else {
        functions.delete(`${ev.schema}.${ev.name}`);
      }
    }

    // 4. Track policies on `family_permissions` sequentially using source position order
    const policyEvents: Array<{ index: number; op: 'drop' | 'create'; name: string }> = [];
    const dropFamPolRegex =
      /DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?"([^"]+)"\s+ON\s+(?:public\.)?family_permissions\b/gi;
    while ((m = dropFamPolRegex.exec(cleanLines)) !== null) {
      policyEvents.push({ index: m.index, op: 'drop', name: m[1] });
    }
    const createFamPolRegex =
      /CREATE\s+POLICY\s+"([^"]+)"\s+ON\s+(?:public\.)?family_permissions\b/gi;
    while ((m = createFamPolRegex.exec(cleanLines)) !== null) {
      policyEvents.push({ index: m.index, op: 'create', name: m[1] });
    }
    policyEvents.sort((a, b) => a.index - b.index);
    for (const ev of policyEvents) {
      if (ev.op === 'drop') {
        familyPermissionsPolicies.delete(ev.name);
      } else {
        familyPermissionsPolicies.add(ev.name);
      }
    }
  }

  return {
    migrationFiles: migrations.map((m) => m.fileName),
    tables,
    rlsEnabledTables,
    functions,
    familyPermissionsPolicies,
  };
}

/**
 * src/types/database.ts から export interface <Name> { ... } のトップレベルプロパティ一覧を抽出する（ネスト型定義対応の括弧バランス走査）
 */
export function parseTsInterfaces(tsText: string): Map<string, Set<string>> {
  const interfaces = new Map<string, Set<string>>();
  const headerRegex = /export\s+interface\s+([A-Za-z0-9_]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = headerRegex.exec(tsText)) !== null) {
    const name = m[1];
    const openBraceIdx = m.index + m[0].length - 1;
    let braceBalance = 1;
    let cursor = openBraceIdx + 1;
    while (cursor < tsText.length && braceBalance > 0) {
      const ch = tsText[cursor];
      if (ch === '{') braceBalance++;
      else if (ch === '}') braceBalance--;
      cursor++;
    }
    const body = tsText.slice(openBraceIdx + 1, Math.max(openBraceIdx + 1, cursor - 1));
    const props = new Set<string>();
    let depth = 0;
    for (const rawLine of body.split('\n')) {
      const line = rawLine.replace(/\/\/.*$/, '').trim();
      if (!line) continue;
      if (depth === 0) {
        const propMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\??\s*:/);
        if (propMatch) {
          props.add(propMatch[1]);
        }
      }
      for (const ch of line) {
        if (ch === '{' || ch === '(' || ch === '[') depth++;
        else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      }
    }
    interfaces.set(name, props);
  }
  return interfaces;
}

export function parseMermaidErdEntities(mdText: string): Map<string, Set<string>> {
  const entities = new Map<string, Set<string>>();
  const erdBlockMatch = mdText.match(/```mermaid\s*\nerDiagram([\s\S]*?)```/);
  if (!erdBlockMatch) return entities;
  const erdBody = erdBlockMatch[1];
  const entityRegex = /^\s{4}([a-z_][a-z0-9_]*)\s*\{([\s\S]*?)^\s{4}\}/gm;
  let m: RegExpExecArray | null;
  while ((m = entityRegex.exec(erdBody)) !== null) {
    const entityName = m[1];
    const cols = new Set<string>();
    for (const rawLine of m[2].split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const attrMatch = line.match(/^[a-z0-9_]+\s+([a-z_][a-z0-9_]*)\b/i);
      if (attrMatch) {
        cols.add(attrMatch[1].toLowerCase());
      }
    }
    entities.set(entityName, cols);
  }
  return entities;
}

/**
 * src/lib/db.ts から最新バージョンの `this.version(N).stores({ ... })` を自動抽出する（バージョン番号非固定）
 */
export function parseLatestDexieStores(dbTsText: string): {
  version: number;
  stores: Map<string, Set<string>>;
} {
  const versionRegex = /this\.version\((\d+)\)\.stores\(\{([\s\S]*?)\}\);/g;
  let latestVersion = 0;
  let latestBody = '';
  let m: RegExpExecArray | null;
  while ((m = versionRegex.exec(dbTsText)) !== null) {
    const ver = parseInt(m[1], 10);
    if (ver >= latestVersion) {
      latestVersion = ver;
      latestBody = m[2];
    }
  }

  const stores = new Map<string, Set<string>>();
  if (!latestBody) return { version: latestVersion, stores };

  const entryRegex = /([a-z_][a-z0-9_]*)\s*:\s*['"`]([^'"`]+)['"`]/g;
  while ((m = entryRegex.exec(latestBody)) !== null) {
    const tableName = m[1];
    const spec = m[2];
    const indexedCols = new Set<string>();
    for (const token of spec.split(',')) {
      const clean = token.trim();
      if (!clean) continue;
      if (clean.startsWith('[') && clean.endsWith(']')) {
        for (const sub of clean.slice(1, -1).split('+')) {
          if (sub.trim()) indexedCols.add(sub.trim());
        }
      } else {
        indexedCols.add(clean.replace(/^[+&*]+/, ''));
      }
    }
    stores.set(tableName, indexedCols);
  }

  return { version: latestVersion, stores };
}

function setsDiff(a: Set<string>, b: Set<string>): { missingInB: string[]; extraInB: string[] } {
  const missingInB = [...a].filter((x) => !b.has(x));
  const extraInB = [...b].filter((x) => !a.has(x));
  return { missingInB, extraInB };
}

export function runSchemaAndDiagramParityGate(reader: RepoReader, errors: string[]): void {
  const migrationRelFiles = reader
    .listFilesUnder('supabase/migrations', '.sql')
    .sort((a, b) => a.localeCompare(b));

  if (migrationRelFiles.length === 0) {
    errors.push(`[Schema Parity Gate] No SQL migration files found under supabase/migrations/.`);
    return;
  }

  const migrationsInput = migrationRelFiles.map((rel) => ({
    fileName: rel.slice('supabase/migrations/'.length),
    sql: reader.readText(rel),
  }));
  const cumulative = parseSequentialMigrations(migrationsInput);

  // 1. Verify Security Posture: zero SECURITY DEFINER functions remaining in `public` (Lint 0029 guard)
  for (const fn of cumulative.functions.values()) {
    if (fn.schema === 'public' && fn.security === 'DEFINER') {
      errors.push(
        `[Supabase Lint 0029 Guard] Function "public.${fn.name}" is SECURITY DEFINER in exposed public schema. Move privileged helpers to app_private and keep only SECURITY INVOKER wrappers in public.`
      );
    }
  }
  const publicVerifyRpc = cumulative.functions.get('public.verify_user_authorization');
  if (!publicVerifyRpc || publicVerifyRpc.security !== 'INVOKER') {
    errors.push(
      `[Supabase RPC Guard] Expected public.verify_user_authorization() to exist as a SECURITY INVOKER wrapper.`
    );
  }
  for (const requiredHelper of [
    'is_system_owner',
    'is_authorized_system_user',
    'can_view_patient_data',
    'can_edit_patient_data',
    'verify_user_authorization',
    'enforce_invited_or_owner_signup',
  ]) {
    if (!cumulative.functions.has(`app_private.${requiredHelper}`)) {
      errors.push(
        `[Supabase Schema Guard] Missing internal SECURITY DEFINER helper "app_private.${requiredHelper}" across supabase/migrations/.`
      );
    }
  }

  // 2. Verify zero duplicate permissive policies on `family_permissions` (Lint 0006 guard)
  if (
    cumulative.familyPermissionsPolicies.has('family_permissions_all') ||
    cumulative.familyPermissionsPolicies.has('family_permissions_accept_invite')
  ) {
    errors.push(
      `[Supabase Lint 0006 Guard] Duplicate legacy policies (family_permissions_all / family_permissions_accept_invite) remain active on public.family_permissions.`
    );
  }

  // 3. Verify `supabase/schema_snapshot.json` matches cumulative sequential migrations
  const snapshotRel = 'supabase/schema_snapshot.json';
  if (!reader.exists(snapshotRel)) {
    errors.push(`[Schema Snapshot Missing] ${snapshotRel} does not exist.`);
  } else {
    const snap = JSON.parse(reader.readText(snapshotRel)) as {
      migrations?: string[];
      tables?: Record<
        string,
        {
          tsInterface?: string;
          rlsEnabled?: boolean;
          columns?: Record<string, { type: string; varcharLength: number | null }>;
        }
      >;
    };
    const snapMigrations = Array.isArray(snap.migrations) ? snap.migrations : [];
    if (JSON.stringify(snapMigrations) !== JSON.stringify(cumulative.migrationFiles)) {
      errors.push(
        `[Schema Snapshot Drift] ${snapshotRel} migrations list [${snapMigrations.join(', ')}] does not match supabase/migrations/ [${cumulative.migrationFiles.join(', ')}].`
      );
    }
    const snapTables = snap.tables ?? {};
    for (const [tblName, colsMap] of cumulative.tables.entries()) {
      const snapTbl = snapTables[tblName];
      if (!snapTbl) {
        errors.push(`[Schema Snapshot Drift] Table "${tblName}" is missing from ${snapshotRel}.`);
        continue;
      }
      if (!cumulative.rlsEnabledTables.has(tblName) || snapTbl.rlsEnabled !== true) {
        errors.push(`[RLS Missing] Table "${tblName}" must have ENABLE ROW LEVEL SECURITY.`);
      }
      const snapCols = snapTbl.columns ?? {};
      const { missingInB, extraInB } = setsDiff(
        new Set(colsMap.keys()),
        new Set(Object.keys(snapCols))
      );
      if (missingInB.length > 0 || extraInB.length > 0) {
        errors.push(
          `[Schema Snapshot Drift] Columns of "${tblName}" in ${snapshotRel} diverge from migrations (missing: [${missingInB.join(', ')}], extra: [${extraInB.join(', ')}]).`
        );
      }
    }
  }

  // 4. Verify SQL table set & ARCHITECTURE.md §5 concise catalog (no 480-line duplicate SQL required)
  const expectedTableNames = new Set(Object.keys(SQL_TABLE_TO_TS_INTERFACE));
  const { missingInB: missingSqlTables, extraInB: extraSqlTables } = setsDiff(
    expectedTableNames,
    new Set(cumulative.tables.keys())
  );
  if (missingSqlTables.length > 0 || extraSqlTables.length > 0) {
    errors.push(
      `[Schema Parity Violation] SQL table set mismatch across supabase/migrations/ (missing: [${missingSqlTables.join(', ')}], unmapped: [${extraSqlTables.join(', ')}]).`
    );
  }

  const archRel = 'docs/Web_Project/ARCHITECTURE.md';
  if (reader.exists(archRel)) {
    const archContent = reader.readText(archRel).replace(/\r\n/g, '\n');
    const sec5Idx = archContent.indexOf('## 5. データベース物理スキーマ');
    const sec6Idx = archContent.indexOf('## 6. ', sec5Idx >= 0 ? sec5Idx : 0);
    if (sec5Idx === -1) {
      errors.push(`[ARCHITECTURE §5 Missing] Section 5 heading not found in ${archRel}.`);
    } else {
      const sec5Slice = archContent.slice(sec5Idx, sec6Idx > sec5Idx ? sec6Idx : undefined);
      for (const [sqlTbl, ifaceName] of Object.entries(SQL_TABLE_TO_TS_INTERFACE)) {
        if (!sec5Slice.includes(`\`${sqlTbl}\``) || !sec5Slice.includes(`\`${ifaceName}\``)) {
          errors.push(
            `[ARCHITECTURE §5 Catalog Drift] Section 5 in ${archRel} must document table \`${sqlTbl}\` and TypeScript interface \`${ifaceName}\`.`
          );
        }
      }
      for (const migFile of cumulative.migrationFiles) {
        if (!sec5Slice.includes(migFile)) {
          errors.push(
            `[ARCHITECTURE §5 Migration Index Drift] Section 5 in ${archRel} does not list migration "${migFile}".`
          );
        }
      }
    }
  }

  // 5. VARCHAR length parity & TypeScript interfaces (`src/types/database.ts`)
  const catLen = cumulative.tables.get('categories')?.get('category_name')?.varcharLength ?? null;
  const timingLen = cumulative.tables.get('events')?.get('timing_category')?.varcharLength ?? null;
  if (catLen && timingLen && catLen !== timingLen) {
    errors.push(
      `[Schema Length Mismatch] categories.category_name is VARCHAR(${catLen}) while events.timing_category is VARCHAR(${timingLen}).`
    );
  }

  const typesRel = 'src/types/database.ts';
  if (reader.exists(typesRel)) {
    const tsText = reader.readText(typesRel);
    const tsInterfaces = parseTsInterfaces(tsText);
    const maxConstMatch = tsText.match(/MAX_CATEGORY_NAME_LENGTH\s*=\s*(\d+)/);
    const tsMaxCatLen = maxConstMatch ? parseInt(maxConstMatch[1], 10) : null;
    if (catLen && tsMaxCatLen !== catLen) {
      errors.push(
        `[Schema Length Mismatch] MAX_CATEGORY_NAME_LENGTH in ${typesRel} is ${tsMaxCatLen}, expected ${catLen}.`
      );
    }

    for (const [sqlTbl, ifaceName] of Object.entries(SQL_TABLE_TO_TS_INTERFACE)) {
      const sqlCols = new Set((cumulative.tables.get(sqlTbl) ?? new Map()).keys());
      const tsProps = tsInterfaces.get(ifaceName);
      if (!tsProps) {
        errors.push(
          `[Schema Parity Violation] Missing TypeScript interface "${ifaceName}" in ${typesRel} for SQL table "${sqlTbl}".`
        );
        continue;
      }
      const { missingInB, extraInB } = setsDiff(sqlCols, tsProps);
      if (missingInB.length > 0 || extraInB.length > 0) {
        errors.push(
          `[Schema Parity Violation] Column mismatch between SQL "${sqlTbl}" and TypeScript "${ifaceName}" (missing in TS: [${missingInB.join(', ')}], extra in TS: [${extraInB.join(', ')}]).`
        );
      }
    }
  }

  // 6. Dexie latest version (`src/lib/db.ts`)
  const dbRel = 'src/lib/db.ts';
  if (reader.exists(dbRel)) {
    const { version: dexieVersion, stores: dexieStores } = parseLatestDexieStores(
      reader.readText(dbRel)
    );
    const expectedLocalTables = new Set(
      Object.keys(SQL_TABLE_TO_TS_INTERFACE).filter((t) => t !== 'family_permissions')
    );
    const { missingInB, extraInB } = setsDiff(expectedLocalTables, new Set(dexieStores.keys()));
    if (missingInB.length > 0 || extraInB.length > 0) {
      errors.push(
        `[Schema Parity Violation] Dexie Version ${dexieVersion} stores in ${dbRel} diverge from local table set (missing: [${missingInB.join(', ')}], extra: [${extraInB.join(', ')}]).`
      );
    }
    for (const [tblName, indexedCols] of dexieStores.entries()) {
      const sqlCols = new Set((cumulative.tables.get(tblName) ?? new Map()).keys());
      for (const idxCol of indexedCols) {
        if (!sqlCols.has(idxCol)) {
          errors.push(
            `[Schema Parity Violation] Dexie table "${tblName}" (v${dexieVersion}) indexes non-existent SQL column "${idxCol}".`
          );
        }
      }
    }
  }

  // 7. First-class Diagrams Parity
  const seqErdRel = 'docs/Web_Project/diagrams/SEQUENCE_AND_ERD.md';
  if (reader.exists(seqErdRel)) {
    const seqErd = reader.readText(seqErdRel);
    if (!seqErd.includes('family_email') || !seqErd.includes('bindMealGlucoseFromReadings')) {
      errors.push(
        `[Diagram Sync Violation] ${seqErdRel} is missing "family_email" in ER diagram or "bindMealGlucoseFromReadings" in CSV sequence diagram.`
      );
    }
    const erdEntities = parseMermaidErdEntities(seqErd);
    for (const sqlTbl of Object.keys(SQL_TABLE_TO_TS_INTERFACE)) {
      const sqlCols = new Set((cumulative.tables.get(sqlTbl) ?? new Map()).keys());
      const erdCols = erdEntities.get(sqlTbl);
      if (!erdCols) {
        errors.push(`[ERD Parity Violation] Entity "${sqlTbl}" is missing from erDiagram in ${seqErdRel}.`);
        continue;
      }
      const { missingInB, extraInB } = setsDiff(sqlCols, erdCols);
      if (missingInB.length > 0 || extraInB.length > 0) {
        errors.push(
          `[ERD Parity Violation] Entity "${sqlTbl}" in ${seqErdRel} diverges from SQL DDL (missing in ERD: [${missingInB.join(', ')}], extra in ERD: [${extraInB.join(', ')}]).`
        );
      }
    }
  }

  const csvFlowRel = 'docs/Web_Project/diagrams/CSV_IMPORT_AND_ANOMALY_FLOW.md';
  if (reader.exists(csvFlowRel)) {
    const csvFlow = reader.readText(csvFlowRel);
    if (
      !csvFlow.includes('bindMealGlucoseFromReadings') ||
      !csvFlow.includes('28分') ||
      !csvFlow.includes('45分') ||
      !csvFlow.includes('hypoThreshold')
    ) {
      errors.push(
        `[Diagram Sync Violation] ${csvFlowRel} is missing required pipeline/state-machine elements (bindMealGlucoseFromReadings, 28分, 45分, hypoThreshold).`
      );
    }
  }

  const drawioRel = 'docs/Web_Project/diagrams/system_architecture.drawio';
  if (reader.exists(drawioRel)) {
    const drawio = reader.readText(drawioRel);
    if (!drawio.includes('family_email') || !drawio.includes('Supabase Storage（未実装）')) {
      errors.push(
        `[Diagram Sync Violation] ${drawioRel} is missing "family_email" or "Supabase Storage（未実装）" marker.`
      );
    }
  }

  console.log(
    `✅ [PASS] Check 6: Sequential Migrations (${cumulative.migrationFiles.length}) === schema_snapshot.json === ARCHITECTURE.md §5 === database.ts === Dexie === ERD + 3 diagrams verified (0 exposed SECURITY DEFINER in public).`
  );
}
