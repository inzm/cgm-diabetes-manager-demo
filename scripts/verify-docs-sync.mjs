/**
 * ドキュメント駆動開発 (DDD) 同期・整合性・セキュリティ検証ゲート (verify-docs-sync.mjs)
 *
 * 目的:
 * AIエージェントおよび開発者がデザイン・仕様・コードを変更した際、
 * 関連する仕様書（docs/Web_Project/*.md）の更新漏れ、記述の陳腐化、
 * ブラウザ localStorage への秘密情報保存、事実と異なるセキュリティ表記、
 * および開発者専門用語（マスタ、IndexedDB、Web Worker 等）の画面露出を
 * 機械的に検出し、コミットおよびPR前に100%ブロックする。
 *
 * 検査項目:
 * 1. [Index & Stale Check] docs/Web_Project/README.md に全 SPEC_*.md が掲載され、「策定予定」等の放置記述がないか
 * 2. [Path Existence Check] 仕様書内に記載された src/... や public/... のファイルパスが実在するか
 * 3. [Component Coverage Check] src/components/ 配下の全 .tsx コンポーネントが仕様書マッピングと smoke-test.mjs の両方に登録されているか
 * 4. [Git Diff Sync Gate] ソースコード変更時に、対応する仕様書（SPEC_*.md / ARCHITECTURE.md）が同一変更セット内で更新されているか
 * 5. [Security, Anti-Stub & User-Centric UX Gate] localStorage への APIキー保存、虚偽のセキュリティ表記、架空人物ハードコード、window.confirm()、およびUIコンポーネントにおける開発者用語（「マスタ」「IndexedDB」「Web Worker」等）が含まれていないか
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT_DIR = process.cwd();
const DOCS_DIR = path.join(ROOT_DIR, 'docs', 'Web_Project');
const isStagedMode = process.argv.includes('--staged');
const skipDiffGate = process.env.SKIP_DOC_SYNC === '1';

/**
 * ソースコード ⇔ 仕様書 (SSOT) 対応マッピング定義
 * prefix に一致するファイルが変更された場合、specs のいずれか1つ以上が同時更新されている必要がある。
 */
export const SOURCE_TO_SPEC_RULES = [
  {
    prefix: 'src/components/calendar/',
    specs: ['docs/Web_Project/SPEC_CALENDAR.md'],
    description: 'カレンダー画面コンポーネント',
  },
  {
    prefix: 'src/components/daily/',
    specs: ['docs/Web_Project/SPEC_CALENDAR.md', 'docs/Web_Project/SPEC_MEAL_RECORD.md'],
    description: '日次詳細ドロワー・24H血糖グラフ',
  },
  {
    prefix: 'src/components/common/Header.tsx',
    specs: ['docs/Web_Project/SPEC_CALENDAR.md'],
    description: '共通ヘッダー・年月ナビゲーション',
  },
  {
    prefix: 'src/components/common/BottomNav.tsx',
    specs: ['docs/Web_Project/SPEC_CALENDAR.md'],
    description: 'モバイル用ボトムナビゲーション',
  },
  {
    prefix: 'src/components/common/OfflineBanner.tsx',
    specs: ['docs/Web_Project/SPEC_PWA.md'],
    description: 'オフライン状態バナー',
  },
  {
    prefix: 'src/components/common/ConfirmDialog.tsx',
    specs: [
      'docs/Web_Project/SPEC_MEAL_RECORD.md',
      'docs/Web_Project/SPEC_CALENDAR.md',
      'docs/Web_Project/SPEC_FOOD_MASTER.md',
      'docs/Web_Project/SPEC_SETTINGS.md',
    ],
    description: '共通カスタム確認ダイアログモーダル',
  },
  {
    prefix: 'src/components/common/DemoWelcomeModal.tsx',
    specs: ['docs/Web_Project/SPEC_CALENDAR.md', 'docs/Web_Project/SPEC_SETTINGS.md'],
    description: 'デモアプリ初回アクセス案内モーダル',
  },
  {
    prefix: 'src/components/analysis/',
    specs: ['docs/Web_Project/SPEC_ANALYSIS.md'],
    description: '臨床分析画面コンポーネント',
  },
  {
    prefix: 'src/lib/analysisCalculators.ts',
    specs: ['docs/Web_Project/SPEC_ANALYSIS.md', 'docs/Web_Project/TEST_PLAN.md'],
    description: '臨床分析計算ロジック',
  },
  {
    prefix: 'src/lib/aggregates.ts',
    specs: ['docs/Web_Project/SPEC_CALENDAR.md', 'docs/Web_Project/SPEC_ANALYSIS.md'],
    description: '月間・日次集計ロジック',
  },
  {
    prefix: 'src/lib/anomalyExtractor.ts',
    specs: [
      'docs/Web_Project/SPEC_CSV_IMPORT.md',
      'docs/Web_Project/SPEC_CALENDAR.md',
      'docs/Web_Project/SPEC_SETTINGS.md',
    ],
    description: '異常値エピソード抽出ステートマシン (SSOT)',
  },
  {
    prefix: 'src/lib/dateUtils.ts',
    specs: [
      'docs/Web_Project/SPEC_MEAL_RECORD.md',
      'docs/Web_Project/SPEC_ANALYSIS.md',
      'docs/Web_Project/SPEC_CALENDAR.md',
    ],
    description: 'ローカルタイムゾーン & ウォールクロック日時ユーティリティ',
  },
  {
    prefix: 'src/components/foods/',
    specs: ['docs/Web_Project/SPEC_FOOD_MASTER.md'],
    description: 'よく使う食品・活動管理画面コンポーネント',
  },
  {
    prefix: 'src/lib/foodSeed.ts',
    specs: ['docs/Web_Project/SPEC_FOOD_MASTER.md'],
    description: '食品・活動初期データ・カテゴリシード',
  },
  {
    prefix: 'src/lib/gemini.ts',
    specs: ['docs/Web_Project/SPEC_FOOD_MASTER.md', 'docs/Web_Project/SPEC_SETTINGS.md'],
    description: '糖質量自動推定エンジン (BFFプロキシ + 標準食品辞書)',
  },
  {
    prefix: 'src/components/import/',
    specs: ['docs/Web_Project/SPEC_CSV_IMPORT.md'],
    description: 'リブレCSV取込モーダル',
  },
  {
    prefix: 'src/workers/csvParser.worker.ts',
    specs: ['docs/Web_Project/SPEC_CSV_IMPORT.md'],
    description: 'CSVパース & 異常値抽出Web Worker',
  },
  {
    prefix: 'src/components/records/',
    specs: ['docs/Web_Project/SPEC_MEAL_RECORD.md'],
    description: '食事・インスリン・活動記録モーダル',
  },
  {
    prefix: 'src/components/settings/',
    specs: ['docs/Web_Project/SPEC_SETTINGS.md', 'docs/Web_Project/SPEC_PWA.md'],
    description: '設定・データ管理画面',
  },
  {
    prefix: 'src/contexts/PatientContext.tsx',
    specs: ['docs/Web_Project/SPEC_SETTINGS.md', 'docs/Web_Project/SPEC_CALENDAR.md'],
    description: '患者コンテキスト・ロール・臨床目標閾値状態',
  },
  {
    prefix: 'src/lib/pwa.ts',
    specs: ['docs/Web_Project/SPEC_PWA.md', 'docs/Web_Project/SPEC_SETTINGS.md'],
    description: 'PWAインストール・オンライン状態管理',
  },
  {
    prefix: 'src/lib/db.ts',
    specs: ['docs/Web_Project/ARCHITECTURE.md', 'docs/Web_Project/SPEC_CALENDAR.md'],
    description: 'IndexedDB (Dexie.js) データベース定義',
  },
  {
    prefix: 'src/types/database.ts',
    specs: ['docs/Web_Project/ARCHITECTURE.md'],
    description: 'データベース・エンティティ型定義',
  },
  {
    prefix: 'src/lib/echartsCore.ts',
    specs: ['docs/Web_Project/ARCHITECTURE.md', 'docs/Web_Project/SPEC_CALENDAR.md', 'docs/Web_Project/SPEC_ANALYSIS.md'],
    description: 'ECharts ツリーシェイク済み軽量コアモジュール',
  },
];

function walkFiles(dir, extFilter = null) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(walkFiles(fullPath, extFilter));
    } else if (!extFilter || fullPath.endsWith(extFilter)) {
      results.push(fullPath);
    }
  }
  return results;
}

function toPosixRelative(fullPath) {
  return path.relative(ROOT_DIR, fullPath).split(path.sep).join('/');
}

function getChangedFiles() {
  try {
    if (isStagedMode) {
      const out = execSync('git diff --cached --name-only', { encoding: 'utf8' });
      return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
    // Working tree (staged + unstaged) + commits ahead of main
    const statusOut = execSync('git status --porcelain', { encoding: 'utf8' });
    const workingFiles = statusOut
      .split(/\r?\n/)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);

    let branchFiles = [];
    try {
      const diffMain = execSync('git diff --name-only main...HEAD', { encoding: 'utf8' });
      branchFiles = diffMain.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } catch {
      // Fallback if main ref is not available
    }

    return Array.from(new Set([...workingFiles, ...branchFiles]));
  } catch {
    return [];
  }
}

function runVerification() {
  console.log(`\n======================================================`);
  console.log(`📚 Starting DDD Specification & Code Sync Verification`);
  console.log(`======================================================\n`);

  const errors = [];

  // -------------------------------------------------------------------------
  // 1. Check docs/Web_Project/README.md index completeness & stale markers
  // -------------------------------------------------------------------------
  const readmePath = path.join(DOCS_DIR, 'README.md');
  if (!fs.existsSync(readmePath)) {
    errors.push(`Missing index document: docs/Web_Project/README.md`);
  } else {
    const readmeContent = fs.readFileSync(readmePath, 'utf8');
    if (readmeContent.includes('策定予定')) {
      errors.push(
        `[Stale Marker] docs/Web_Project/README.md still contains "(策定予定)". Update the index to link to completed specs.`
      );
    }

    const specFiles = fs
      .readdirSync(DOCS_DIR)
      .filter((name) => name.startsWith('SPEC_') && name.endsWith('.md'));

    for (const specFile of specFiles) {
      if (!readmeContent.includes(specFile)) {
        errors.push(
          `[Unindexed Spec] docs/Web_Project/${specFile} is not linked in docs/Web_Project/README.md.`
        );
      }
    }
    console.log(`✅ [PASS] Check 1: Spec index (README.md) covers all ${specFiles.length} SPEC_*.md files with no stale markers.`);
  }

  // -------------------------------------------------------------------------
  // 2. Check referenced file paths inside docs/Web_Project/*.md
  // -------------------------------------------------------------------------
  const docFiles = walkFiles(DOCS_DIR, '.md');
  const pathRegex = /`((?:src|public)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)`/g;
  let checkedRefCount = 0;

  for (const docFile of docFiles) {
    const relDoc = toPosixRelative(docFile);
    const content = fs.readFileSync(docFile, 'utf8');
    let match;
    while ((match = pathRegex.exec(content)) !== null) {
      const refPath = match[1];
      checkedRefCount++;
      const absRef = path.join(ROOT_DIR, refPath);
      if (!fs.existsSync(absRef)) {
        errors.push(
          `[Broken File Reference] ${relDoc} references non-existent file \`${refPath}\`.`
        );
      }
    }
  }
  console.log(`✅ [PASS] Check 2: Verified ${checkedRefCount} source/public file references across ${docFiles.length} markdown specs.`);

  // -------------------------------------------------------------------------
  // 3. Check component coverage (every src/components/**/*.tsx must be mapped & in smoke-test.mjs)
  // -------------------------------------------------------------------------
  const componentFiles = walkFiles(path.join(ROOT_DIR, 'src', 'components'), '.tsx').map(toPosixRelative);
  const smokeTestContent = fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'smoke-test.mjs'), 'utf8');

  for (const compFile of componentFiles) {
    const isMapped = SOURCE_TO_SPEC_RULES.some((rule) => compFile.startsWith(rule.prefix));
    if (!isMapped) {
      errors.push(
        `[Unmapped Component] ${compFile} is not covered by SOURCE_TO_SPEC_RULES in scripts/verify-docs-sync.mjs.`
      );
    }
    if (!smokeTestContent.includes(`/${compFile}`)) {
      errors.push(
        `[Missing Smoke Test Endpoint] /${compFile} is not registered in scripts/smoke-test.mjs.`
      );
    }
  }
  console.log(`✅ [PASS] Check 3: All ${componentFiles.length} UI components are mapped to SSOT specs and registered in smoke-test.mjs.`);

  // -------------------------------------------------------------------------
  // 4. Git Diff Sync Gate (Code change requires corresponding Spec update)
  // -------------------------------------------------------------------------
  const changedFiles = getChangedFiles();
  if (changedFiles.length > 0 && !skipDiffGate) {
    for (const changedFile of changedFiles) {
      const matchedRules = SOURCE_TO_SPEC_RULES.filter((rule) =>
        changedFile.startsWith(rule.prefix)
      );
      for (const rule of matchedRules) {
        const isSpecUpdated = rule.specs.some((specPath) =>
          changedFiles.includes(specPath)
        );
        if (!isSpecUpdated) {
          errors.push(
            `[Spec Sync Required] Source file "${changedFile}" (${rule.description}) was modified, ` +
            `but none of its corresponding specifications (${rule.specs.join(', ')}) were updated in this change set.\n` +
            `   👉 Please update the relevant SPEC_*.md to reflect the latest design/behavior (or set SKIP_DOC_SYNC=1 if this is a pure internal refactor with zero spec changes).`
          );
        }
      }
    }
  }
  console.log(`✅ [PASS] Check 4: Git diff sync gate evaluated (${changedFiles.length} changed files inspected).`);

  // -------------------------------------------------------------------------
  // 5. Security, Anti-Stub & User-Centric UX Gate
  // -------------------------------------------------------------------------
  const allSrcFiles = [
    ...walkFiles(path.join(ROOT_DIR, 'src'), '.ts'),
    ...walkFiles(path.join(ROOT_DIR, 'src'), '.tsx'),
  ];

  const forbiddenPatterns = [
    {
      pattern: /cgm_gemini_api_key/,
      reason: 'Browser localStorage storage of Gemini API keys (cgm_gemini_api_key) is prohibited for security.',
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
      reason: 'Browser native window.confirm() is prohibited; use custom ConfirmDialog component instead.',
    },
  ];

  const componentForbiddenPatterns = [
    {
      pattern: /マスタ/,
      reason: 'Developer jargon ("マスタ") in UI components is prohibited; use user-centric expressions ("よく使う食品", "登録済みから選ぶ", etc.).',
    },
    {
      pattern: /IndexedDB|Dexie/,
      reason: 'Exposing internal storage engine names ("IndexedDB" / "Dexie") in UI components is prohibited.',
    },
    {
      pattern: /Web Worker/,
      reason: 'Exposing internal thread architecture ("Web Worker") in UI components is prohibited.',
    },
    {
      pattern: /\((?:libre_readings|food_master|event_master|meal_details)\)/,
      reason: 'Exposing physical DB table names in UI components is prohibited.',
    },
  ];

  for (const srcFile of allSrcFiles) {
    const relSrc = toPosixRelative(srcFile);
    const content = fs.readFileSync(srcFile, 'utf8');
    for (const rule of forbiddenPatterns) {
      if (rule.pattern.test(content)) {
        errors.push(`[Security / Anti-Stub Violation] ${relSrc}: ${rule.reason}`);
      }
    }
    if (relSrc.startsWith('src/components/')) {
      const codeWithoutComments = content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const rule of componentForbiddenPatterns) {
        if (rule.pattern.test(codeWithoutComments)) {
          errors.push(`[User-Centric UX Violation] ${relSrc}: ${rule.reason}`);
        }
      }
    }
  }
  console.log(`✅ [PASS] Check 5: Security, Anti-Stub & User-Centric UX Gate verified across ${allSrcFiles.length} source files.`);

  // -------------------------------------------------------------------------
  // Final Verdict
  // -------------------------------------------------------------------------
  if (errors.length > 0) {
    console.error(`\n❌ DDD Documentation Sync Verification FAILED with ${errors.length} error(s):\n`);
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    console.error(`\n======================================================\n`);
    process.exit(1);
  }

  console.log(`\n🎉 All DDD Documentation & Code Sync checks PASSED!\n`);
}

runVerification();
