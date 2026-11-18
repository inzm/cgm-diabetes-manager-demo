import path from 'node:path';
import type { RepoReader } from './repo-reader.ts';

export interface SourceToSpecRule {
  prefix: string;
  specs: string[];
  requiredSpecs?: string[];
  description: string;
}

/**
 * ソースコード ⇔ 仕様書 (SSOT) 対応マッピング定義 (単一真実源)
 * spec-sync-and-review スキルからも本定義を直接参照し重複管理を排除する。
 */
export const SOURCE_TO_SPEC_RULES: readonly SourceToSpecRule[] = [
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
    prefix: 'src/components/common/SelectPickerModal.tsx',
    specs: ['docs/Web_Project/SPEC_ANALYSIS.md'],
    description: 'キャンセル可能なカスタム選択ピッカーモーダル',
  },
  {
    prefix: 'src/components/common/AuthGateScreen.tsx',
    specs: [
      'docs/Web_Project/ARCHITECTURE.md',
      'docs/Web_Project/SPEC_CALENDAR.md',
      'docs/Web_Project/SPEC_SETTINGS.md',
      'docs/Web_Project/USER_GUIDE.md',
    ],
    requiredSpecs: ['docs/Web_Project/ARCHITECTURE.md', 'docs/Web_Project/SPEC_SETTINGS.md'],
    description: '本番モード専用ログイン画面 (Auth Gate) & 初回セットアップ案内',
  },
  {
    prefix: 'src/components/common/PasswordStrengthChecklist.tsx',
    specs: [
      'docs/Web_Project/ARCHITECTURE.md',
      'docs/Web_Project/SPEC_SETTINGS.md',
      'docs/Web_Project/USER_GUIDE.md',
    ],
    requiredSpecs: ['docs/Web_Project/SPEC_SETTINGS.md'],
    description: 'パスワード強度5条件リアルタイムチェックリスト共通コンポーネント',
  },
  {
    prefix: 'src/main.tsx',
    specs: ['docs/Web_Project/ARCHITECTURE.md', 'docs/Web_Project/SPEC_PWA.md'],
    description: 'アプリケーションエントリポイント & Service Worker登録',
  },
  {
    prefix: 'src/App.tsx',
    specs: [
      'docs/Web_Project/ARCHITECTURE.md',
      'docs/Web_Project/SPEC_CALENDAR.md',
      'docs/Web_Project/SPEC_SETTINGS.md',
      'docs/Web_Project/USER_GUIDE.md',
    ],
    description: 'アプリケーションルート & Auth Gate 強制ロック制御',
  },
  {
    prefix: 'src/components/analysis/',
    specs: ['docs/Web_Project/SPEC_ANALYSIS.md', 'docs/Web_Project/USER_GUIDE.md'],
    description: '臨床分析画面コンポーネント',
  },
  {
    prefix: 'src/lib/analysisCalculators.ts',
    specs: ['docs/Web_Project/SPEC_ANALYSIS.md', 'docs/Web_Project/TEST_PLAN.md'],
    requiredSpecs: ['docs/Web_Project/SPEC_ANALYSIS.md'],
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
      'docs/Web_Project/diagrams/CSV_IMPORT_AND_ANOMALY_FLOW.md',
    ],
    requiredSpecs: ['docs/Web_Project/SPEC_CSV_IMPORT.md'],
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
    specs: ['docs/Web_Project/SPEC_FOOD_MASTER.md', 'docs/Web_Project/USER_GUIDE.md'],
    requiredSpecs: ['docs/Web_Project/SPEC_FOOD_MASTER.md'],
    description: 'よく使う食品・活動管理画面コンポーネント',
  },
  {
    prefix: 'src/lib/foodSeed.ts',
    specs: ['docs/Web_Project/SPEC_FOOD_MASTER.md'],
    requiredSpecs: ['docs/Web_Project/SPEC_FOOD_MASTER.md'],
    description: '食品・活動初期データ・カテゴリシード',
  },
  {
    prefix: 'src/lib/gemini.ts',
    specs: [
      'docs/Web_Project/SPEC_FOOD_MASTER.md',
      'docs/Web_Project/SPEC_SETTINGS.md',
      'docs/Web_Project/ARCHITECTURE.md',
      'docs/Web_Project/diagrams/system_architecture.drawio',
    ],
    requiredSpecs: ['docs/Web_Project/SPEC_FOOD_MASTER.md'],
    description: '糖質量自動推定エンジン (BFFプロキシ + 案2認証ヘッダ + 標準食品辞書)',
  },
  {
    prefix: 'src/components/import/',
    specs: [
      'docs/Web_Project/SPEC_CSV_IMPORT.md',
      'docs/Web_Project/USER_GUIDE.md',
      'docs/Web_Project/diagrams/CSV_IMPORT_AND_ANOMALY_FLOW.md',
      'docs/Web_Project/diagrams/SEQUENCE_AND_ERD.md',
    ],
    requiredSpecs: ['docs/Web_Project/SPEC_CSV_IMPORT.md'],
    description: 'リブレCSV取込モーダル',
  },
  {
    prefix: 'src/workers/csvParser.worker.ts',
    specs: [
      'docs/Web_Project/SPEC_CSV_IMPORT.md',
      'docs/Web_Project/diagrams/CSV_IMPORT_AND_ANOMALY_FLOW.md',
      'docs/Web_Project/diagrams/SEQUENCE_AND_ERD.md',
    ],
    requiredSpecs: ['docs/Web_Project/SPEC_CSV_IMPORT.md'],
    description: 'CSVパース & 異常値抽出Web Worker',
  },
  {
    prefix: 'src/components/records/',
    specs: ['docs/Web_Project/SPEC_MEAL_RECORD.md', 'docs/Web_Project/USER_GUIDE.md'],
    requiredSpecs: ['docs/Web_Project/SPEC_MEAL_RECORD.md'],
    description: '食事・インスリン・活動記録モーダル',
  },
  {
    prefix: 'src/components/settings/',
    specs: [
      'docs/Web_Project/SPEC_SETTINGS.md',
      'docs/Web_Project/SPEC_PWA.md',
      'docs/Web_Project/USER_GUIDE.md',
    ],
    requiredSpecs: ['docs/Web_Project/SPEC_SETTINGS.md'],
    description: '設定・データ管理画面 & 家族招待ガイド',
  },
  {
    prefix: 'src/contexts/PatientContext.tsx',
    specs: [
      'docs/Web_Project/SPEC_SETTINGS.md',
      'docs/Web_Project/SPEC_CALENDAR.md',
      'docs/Web_Project/USER_GUIDE.md',
    ],
    requiredSpecs: ['docs/Web_Project/SPEC_SETTINGS.md'],
    description: '患者コンテキスト・ロール・臨床目標閾値・認証ゲート状態',
  },
  {
    prefix: 'src/lib/pwa.ts',
    specs: ['docs/Web_Project/SPEC_PWA.md', 'docs/Web_Project/SPEC_SETTINGS.md'],
    requiredSpecs: ['docs/Web_Project/SPEC_PWA.md'],
    description: 'PWAインストール・オンライン状態管理',
  },
  {
    prefix: 'src/lib/db.ts',
    specs: [
      'docs/Web_Project/ARCHITECTURE.md',
      'docs/Web_Project/SPEC_CALENDAR.md',
      'docs/Web_Project/diagrams/SEQUENCE_AND_ERD.md',
    ],
    requiredSpecs: ['docs/Web_Project/ARCHITECTURE.md'],
    description: 'IndexedDB (Dexie.js) データベース定義',
  },
  {
    prefix: 'src/lib/uuidUtils.ts',
    specs: [
      'docs/Web_Project/ARCHITECTURE.md',
      'docs/Web_Project/SPEC_FOOD_MASTER.md',
      'docs/Web_Project/SPEC_CSV_IMPORT.md',
      'docs/Web_Project/SPEC_SETTINGS.md',
    ],
    description: '決定論的UUID生成・UUID形式検証ユーティリティ',
  },
  {
    prefix: 'src/lib/realGlucoseLoader.ts',
    specs: [
      'docs/Web_Project/ARCHITECTURE.md',
      'docs/Web_Project/SPEC_CALENDAR.md',
      'docs/Web_Project/SPEC_SETTINGS.md',
    ],
    description: 'デモデータ遅延ハイドレーション・本番モードデータ保護ローダー',
  },
  {
    prefix: 'src/lib/demoMealGenerator.ts',
    specs: [
      'docs/Web_Project/ARCHITECTURE.md',
      'docs/Web_Project/SPEC_CALENDAR.md',
      'docs/Web_Project/SPEC_SETTINGS.md',
    ],
    description: 'デモ用献立テンプレート・血糖連動イベント・インスリン単位生成モジュール',
  },
  {
    prefix: 'src/lib/backupRestore.ts',
    specs: [
      'docs/Web_Project/ARCHITECTURE.md',
      'docs/Web_Project/SPEC_SETTINGS.md',
      'docs/Web_Project/USER_GUIDE.md',
    ],
    requiredSpecs: ['docs/Web_Project/ARCHITECTURE.md', 'docs/Web_Project/SPEC_SETTINGS.md'],
    description: '患者バックアップJSON検証・UUID正規化マイグレーション復元・マルチテナント安全な初期化サービス',
  },
  {
    prefix: 'src/lib/useAnimatedModal.ts',
    specs: [
      'docs/Web_Project/ARCHITECTURE.md',
      'docs/Web_Project/SPEC_MEAL_RECORD.md',
      'docs/Web_Project/SPEC_FOOD_MASTER.md',
      'docs/Web_Project/SPEC_SETTINGS.md',
    ],
    description: 'モーダル・ドロワー共通2段階マウント＆フェードアニメーションフック',
  },
  {
    prefix: 'src/lib/utils.ts',
    specs: ['docs/Web_Project/ARCHITECTURE.md'],
    description: 'クラス結合 (cn) および型安全なエラーメッセージ抽出ユーティリティ',
  },
  {
    prefix: 'src/types/database.ts',
    specs: ['docs/Web_Project/ARCHITECTURE.md', 'docs/Web_Project/diagrams/SEQUENCE_AND_ERD.md'],
    requiredSpecs: ['docs/Web_Project/ARCHITECTURE.md'],
    description: 'データベース・エンティティ型定義',
  },
  {
    prefix: 'src/lib/echartsCore.ts',
    specs: [
      'docs/Web_Project/ARCHITECTURE.md',
      'docs/Web_Project/SPEC_CALENDAR.md',
      'docs/Web_Project/SPEC_ANALYSIS.md',
    ],
    description: 'ECharts ツリーシェイク済み軽量コアモジュール',
  },
  {
    prefix: 'src/lib/supabase.ts',
    specs: [
      'docs/Web_Project/ARCHITECTURE.md',
      'docs/Web_Project/SPEC_SETTINGS.md',
      'docs/Web_Project/diagrams/SEQUENCE_AND_ERD.md',
    ],
    description: 'Supabase クライアント初期化・ローカルフォールバック管理',
  },
  {
    prefix: 'src/lib/syncEngine.ts',
    specs: [
      'docs/Web_Project/ARCHITECTURE.md',
      'docs/Web_Project/SPEC_SETTINGS.md',
      'docs/Web_Project/SPEC_CALENDAR.md',
      'docs/Web_Project/TEST_PLAN.md',
      'docs/Web_Project/USER_GUIDE.md',
      'docs/Web_Project/diagrams/SEQUENCE_AND_ERD.md',
    ],
    requiredSpecs: ['docs/Web_Project/ARCHITECTURE.md'],
    description: 'Local-First 双方向クラウド同期エンジン & 家族権限解決・ローカルキャッシュ消去',
  },
  {
    prefix: 'supabase/migrations/',
    specs: [
      'docs/Web_Project/ARCHITECTURE.md',
      'docs/Web_Project/SPEC_SETTINGS.md',
      'docs/Web_Project/USER_GUIDE.md',
      'docs/Web_Project/diagrams/SEQUENCE_AND_ERD.md',
      'docs/Web_Project/diagrams/system_architecture.drawio',
    ],
    requiredSpecs: [
      'docs/Web_Project/ARCHITECTURE.md',
      'docs/Web_Project/diagrams/SEQUENCE_AND_ERD.md',
    ],
    description: 'Supabase PostgreSQL 連番マイグレーション & RLS・招待専用ガード関数',
  },
  {
    prefix: 'functions/api/gemini.ts',
    specs: [
      'docs/Web_Project/ARCHITECTURE.md',
      'docs/Web_Project/SPEC_FOOD_MASTER.md',
      'docs/Web_Project/SPEC_SETTINGS.md',
      'docs/Web_Project/diagrams/system_architecture.drawio',
    ],
    requiredSpecs: ['docs/Web_Project/ARCHITECTURE.md', 'docs/Web_Project/SPEC_SETTINGS.md'],
    description: 'Cloudflare Pages Functions BFF (/api/gemini)',
  },
];

export function collectProjectDocFiles(reader: RepoReader): string[] {
  const candidates = [
    ...reader.listFilesUnder('docs/Web_Project', '.md'),
    ...reader.listFilesUnder('.agents/skills', '.md'),
    ...reader.listFilesUnder('.agents/rules', '.md'),
    '.agents/AGENTS.md',
    'AGENTS.md',
    'README.md',
  ];
  return Array.from(new Set(candidates)).filter((rel) => reader.exists(rel));
}

export function runModuleAndIndexChecks(
  reader: RepoReader,
  smokeEndpoints: readonly string[],
  errors: string[]
): { docFiles: string[]; allSmokeTestableSrcModules: string[] } {
  // Check 1: README.md index completeness
  const readmeRel = 'docs/Web_Project/README.md';
  if (!reader.exists(readmeRel)) {
    errors.push(`Missing index document: ${readmeRel}`);
  } else {
    const readmeContent = reader.readText(readmeRel);
    if (readmeContent.includes('策定予定')) {
      errors.push(
        `[Stale Marker] ${readmeRel} still contains "(策定予定)". Update the index to link to completed specs.`
      );
    }

    const topDocs = reader
      .listFilesUnder('docs/Web_Project', ['.md', '.drawio'])
      .filter((rel) => rel !== readmeRel && !rel.startsWith('docs/Web_Project/diagrams/'))
      .map((rel) => rel.slice('docs/Web_Project/'.length));
    const diagramDocs = reader
      .listFilesUnder('docs/Web_Project/diagrams', ['.md', '.drawio'])
      .map((rel) => rel.slice('docs/Web_Project/'.length));

    const allDocAndDiagramFiles = [...topDocs, ...diagramDocs];

    if (!reader.exists('docs/Web_Project/USER_GUIDE.md')) {
      errors.push(`[Missing User Guide] docs/Web_Project/USER_GUIDE.md does not exist.`);
    }

    for (const specFile of allDocAndDiagramFiles) {
      if (!readmeContent.includes(specFile)) {
        errors.push(
          `[Unindexed Spec/Diagram] docs/Web_Project/${specFile} is not linked in ${readmeRel}.`
        );
      }
    }
    console.log(
      `✅ [PASS] Check 1: Spec index (README.md) covers all ${allDocAndDiagramFiles.length} docs & diagrams in docs/Web_Project/ with no stale markers.`
    );
  }

  // Check 2: Referenced file paths & Markdown links
  const docFiles = collectProjectDocFiles(reader);
  const pathRegex =
    /`((?:src|public|functions|supabase|scripts|e2e|\.github|\.githooks|\.agents|docs)\/[^\s`*<>${}]+?\.[A-Za-z0-9]+)`/g;
  const mdLinkRegex =
    /\]\((?!https?:\/\/|file:\/\/|mailto:|#)([^)#\s*<>${}]+\.(?:md|ts|tsx|mjs|json|yml|sql|drawio|png|jpg|svg|txt))(?:#[^)]*)?\)/g;
  const fileUrlLinkRegex = /\]\(file:\/\/\/([^)#\s]+)(?:#[^)]*)?\)/g;
  let checkedRefCount = 0;

  for (const relDoc of docFiles) {
    const content = reader.readText(relDoc);
    let match: RegExpExecArray | null;
    while ((match = pathRegex.exec(content)) !== null) {
      const refPath = match[1];
      if (refPath.startsWith('.agents/scratch/')) continue;
      checkedRefCount++;
      if (!reader.exists(refPath)) {
        errors.push(`[Broken File Reference] ${relDoc} references non-existent file \`${refPath}\`.`);
      }
    }

    while ((match = mdLinkRegex.exec(content)) !== null) {
      const linkTarget = match[1];
      if (linkTarget.includes('.agents/scratch/')) continue;
      checkedRefCount++;
      const resolvedRel = path.posix.normalize(path.posix.join(path.posix.dirname(relDoc), linkTarget));
      if (!reader.exists(resolvedRel)) {
        errors.push(
          `[Broken Markdown Link] ${relDoc} links to non-existent relative target "(${linkTarget})".`
        );
      }
    }

    while ((match = fileUrlLinkRegex.exec(content)) !== null) {
      checkedRefCount++;
      errors.push(
        `[Machine-Specific file:// Link Prohibited] ${relDoc} contains machine-local URL "file:///${match[1]}". Use repository-relative Markdown links instead.`
      );
    }

    if (/(?:[A-Za-z]:[\\/]+Users[\\/]+|\/Users\/)[A-Za-z0-9._-]+/i.test(content)) {
      errors.push(
        `[Machine-Specific Path Prohibited] ${relDoc} exposes a local OS user-home path ("C:/Users/..." or "/Users/..."). Use repository-relative paths only.`
      );
    }

    if (relDoc === 'docs/Web_Project/USER_GUIDE.md') {
      const bareFileRegex = /`([A-Za-z0-9_]+\.(?:tsx|ts))`/g;
      let bareMatch: RegExpExecArray | null;
      while ((bareMatch = bareFileRegex.exec(content)) !== null) {
        errors.push(
          `[Abbreviated File Path] ${relDoc} uses bare filename \`${bareMatch[1]}\` without directory path (use full \`src/.../${bareMatch[1]}\`).`
        );
      }
    }
  }
  console.log(
    `✅ [PASS] Check 2: Verified ${checkedRefCount} file paths & Markdown links (including Unicode paths) across ${docFiles.length} docs/skills/rules.`
  );

  // Check 3: Full module coverage & Smoke endpoint parity
  const componentFiles = reader.listFilesUnder('src/components', '.tsx');
  const contextFiles = reader.listFilesUnder('src/contexts', '.tsx');
  const libFiles = reader
    .listFilesUnder('src/lib', '.ts')
    .filter((f) => !f.includes('/__tests__/') && !f.endsWith('.test.ts'));
  const typeFiles = reader.listFilesUnder('src/types', '.ts');
  const workerFiles = reader.listFilesUnder('src/workers', '.ts');
  const functionFiles = reader.listFilesUnder('functions', '.ts');

  const allTrackableModules = [
    ...componentFiles,
    ...contextFiles,
    ...libFiles,
    ...typeFiles,
    ...workerFiles,
    ...functionFiles,
  ];
  const allSmokeTestableSrcModules = [
    'src/main.tsx',
    'src/App.tsx',
    ...componentFiles,
    ...contextFiles,
    ...libFiles,
    ...typeFiles,
    ...workerFiles,
  ];

  for (const modFile of allTrackableModules) {
    const isMapped = SOURCE_TO_SPEC_RULES.some((rule) => modFile.startsWith(rule.prefix));
    if (!isMapped) {
      errors.push(
        `[Unmapped Module] ${modFile} is not covered by SOURCE_TO_SPEC_RULES in scripts/gates/module-coverage.ts.`
      );
    }
  }

  const smokeSet = new Set(smokeEndpoints);
  for (const srcMod of allSmokeTestableSrcModules) {
    if (!smokeSet.has(`/${srcMod}`)) {
      errors.push(
        `[Missing Smoke Test Endpoint] /${srcMod} is not discovered by deriveSmokeEndpoints() in scripts/smoke-test.mjs.`
      );
    }
  }

  // Ensure spec-sync-and-review/SKILL.md points to SOURCE_TO_SPEC_RULES SSOT instead of a stale duplicate table
  const specSkillRel = '.agents/skills/spec-sync-and-review/SKILL.md';
  if (reader.exists(specSkillRel)) {
    const skillText = reader.readText(specSkillRel);
    if (!skillText.includes('scripts/gates/module-coverage.ts')) {
      errors.push(
        `[Duplicate Mapping Drift] ${specSkillRel} must reference scripts/gates/module-coverage.ts (SOURCE_TO_SPEC_RULES) as the single source of truth.`
      );
    }
  }

  console.log(
    `✅ [PASS] Check 3: All ${allTrackableModules.length} source/BFF modules are mapped to SSOT specs and all ${allSmokeTestableSrcModules.length} client modules are discovered by smoke-test.mjs.`
  );

  return { docFiles, allSmokeTestableSrcModules };
}
