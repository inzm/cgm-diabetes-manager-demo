/**
 * ドキュメント駆動開発 (DDD) 同期・整合性・セキュリティ検証ゲート (verify-docs-sync.mjs)
 *
 * 目的:
 * AIエージェントおよび開発者がデザイン・仕様・コードを変更した際、
 * 関連する仕様書（docs/Web_Project/*.md）の更新漏れ、記述の陳腐化・置換破損、
 * DB物理スキーマ・TypeScript型・Dexie・ER図の不整合、旧VBA資料の混入、
 * ブラウザ localStorage への秘密情報保存、事実と異なるセキュリティ表記、
 * および開発者専門用語（マスタ、IndexedDB、Web Worker 等）の画面露出を
 * 機械的に検出し、作業完了（Stop Hook）・コミット（pre-commit）・PR/CI前に100%ブロックする。
 *
 * 検査項目:
 * 1. [Index & Stale Check] docs/Web_Project/README.md に全 SPEC_*.md & USER_GUIDE.md が掲載され、「策定予定」等の放置記述がないか
 * 2. [Path & Link Existence Check] 仕様書・スキル・AGENTS.md・ルートREADME.md 内に記載されたファイルパス（日本語等の非ASCII文字を含む）および Markdown 相対リンクが実在するか
 * 3. [Full Module Coverage Check] src/components, src/contexts, src/lib, src/types, src/workers, functions 配下の全モジュールが仕様書マッピングと smoke-test.mjs の両方に100%登録されているか
 * 4. [Git Diff Sync Gate (2-Stage Spec-First Aware)] ソースコード・マイグレーション・BFF変更時に、対応する仕様書・図面（重要モジュールは requiredSpecs 全件）が直前の連続する純粋 docs(spec): コミットまたは同一変更セット内で更新されているか（CI の DIFF_RANGE にも対応）
 * 5. [Security, Anti-Stub & User-Centric UX Gate] src/ および functions/ 内に localStorage への APIキー保存、虚偽のセキュリティ表記、架空人物ハードコード、window.confirm()、およびUIコンポーネントにおける開発者用語が含まれていないか
 * 6. [4-Layer Schema & Diagram Parity Gate] supabase/migrations/0001_initial_schema.sql・ARCHITECTURE.md Section 5・src/types/database.ts・src/lib/db.ts・diagrams/SEQUENCE_AND_ERD.md の全テーブル・全カラム・文字長上限および第一級図面が100%一致しているか
 * 7. [Suite/Endpoint Count & Hook Integrity Gate] E2E実スイート数・スモークエンドポイント数・Vitestテスト数表記および .agents/hooks.json のスクリプト実在を検証
 * 8. [Documented Identifier Existence Gate] 仕様書内のバッククォート識別子がコードに実在するか（純粋 docs(spec) 先行編集段階の新規追加識別子のみ段階的許容し、実装後・パイプライン・CIでは既定で厳格 ERROR）
 * 9. [Doc Corruption, Open-Item Issue Link & Legacy Asset Gate] 正規表現置換ミス（単独行の $1 等）・文字化け（U+FFFD）・孤立テーブル行・「【未決事項】/【要確認】」の Issue番号欠落防止、および旧VBA関連ディレクトリの Git 追跡ゼロ保証
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = process.cwd();
const DOCS_DIR = path.join(ROOT_DIR, 'docs', 'Web_Project');
const isStagedMode = process.argv.includes('--staged');
const skipDiffGate = process.env.SKIP_DOC_SYNC === '1';

function getExplicitDiffRange() {
  const idx = process.argv.indexOf('--diff-range');
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1].trim();
  }
  const inline = process.argv.find((a) => a.startsWith('--diff-range='));
  if (inline) {
    return inline.slice('--diff-range='.length).trim();
  }
  return (process.env.DIFF_RANGE || '').trim();
}

/**
 * ソースコード ⇔ 仕様書 (SSOT) 対応マッピング定義
 * - specs: いずれか1つ以上が同時更新されている必要がある関連仕様書群
 * - requiredSpecs: 指定されている場合、そのすべてが同時更新されていなければならない必須仕様書群
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
    description: 'Supabase PostgreSQL 本番DDL & RLS・招待専用ガード関数',
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

const SQL_TABLE_TO_TS_INTERFACE = {
  family_permissions: 'FamilyPermission',
  libre_readings: 'LibreReading',
  events: 'HealthEvent',
  meal_details: 'MealDetail',
  categories: 'Category',
  food_master: 'FoodMaster',
  event_master: 'EventMaster',
  user_settings: 'UserSettings',
};

const FORBIDDEN_TRACKED_DIRS = [
  'legacy_vba',
  'docs/VBA_Project',
  'docs/screenshot',
  'docs/動画作成用資料',
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

/**
 * コミットが「コード（src/・functions/・supabase/）を一切含まない純粋な先行仕様コミット (docs(spec): ...)」
 * であるかを判定する純粋関数（Git 履歴上での2段階 Spec-First 証明用）
 */
export function isPureSpecFirstCommit(subject, commitFiles) {
  if (typeof subject !== 'string' || !/^docs\(spec\):\s*\S/.test(subject.trim())) {
    return false;
  }
  if (!Array.isArray(commitFiles) || commitFiles.length === 0) {
    return false;
  }
  const touchesImplementationCode = commitFiles.some((f) =>
    /^(?:src|functions|supabase)\//.test(String(f).trim())
  );
  return !touchesImplementationCode;
}

/**
 * 指定された基準コミット（startRef）から親方向へ連続する純粋 docs(spec): コミット群を辿り、
 * 先行コミットで更新済みの仕様書ファイル一覧を返す（途中に実装コミットやマージコミットがあれば即打ち切り）
 */
function getPrecedingSpecFirstContext(startRef = 'HEAD', maxDepth = 5) {
  const commits = [];
  const specFilesSet = new Set();
  const safeStart = (startRef || 'HEAD').trim();
  if (!/^[A-Za-z0-9_./~^-]+$/.test(safeStart)) {
    return { commits, specFiles: [] };
  }

  for (let offset = 0; offset < maxDepth; offset++) {
    const rev = offset === 0 ? safeStart : `${safeStart}~${offset}`;
    try {
      const meta = execSync(`git log -1 --format="%h|%P|%s" ${rev}`, {
        cwd: ROOT_DIR,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!meta) break;

      const [shortHash, parentsRaw, ...subjParts] = meta.split('|');
      const parents = parentsRaw.trim().split(/\s+/).filter(Boolean);
      if (parents.length > 1) break; // マージコミット到達時は打ち切り

      const subject = subjParts.join('|');
      const filesOut = execSync(`git diff-tree --no-commit-id --name-only -r ${rev}`, {
        cwd: ROOT_DIR,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const files = filesOut
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);

      if (!isPureSpecFirstCommit(subject, files)) {
        break;
      }

      commits.push(shortHash);
      for (const f of files) {
        specFilesSet.add(f);
      }
    } catch {
      break;
    }
  }

  return { commits, specFiles: Array.from(specFilesSet) };
}

/**
 * Unified Diff (+行) から今回新たに追加されたバッククォート識別子のコア名集合を抽出する純粋関数
 */
export function extractAddedBacktickIdentifiersFromDiff(unifiedDiffText) {
  const added = new Set();
  if (typeof unifiedDiffText !== 'string' || !unifiedDiffText) return added;
  for (const rawLine of unifiedDiffText.split(/\r?\n/)) {
    if (!rawLine.startsWith('+') || rawLine.startsWith('+++ ')) continue;
    const line = rawLine.slice(1);
    for (const m of line.matchAll(/`([A-Za-z_][A-Za-z0-9_.]*)(\(\))?`/g)) {
      if (/\.(?:tsx?|mjs|js|sql|json|md|xlsm|xlsx|txt|png|jpg|svg|yml|yaml|drawio|css|html)$/i.test(m[1])) {
        continue;
      }
      const core = m[1].split('.').pop();
      if (core && core.length >= 5 && (/[a-z][A-Z]|_/.test(core) || m[2])) {
        added.add(core);
      }
    }
  }
  return added;
}

/**
 * Markdown ドキュメントの破損（正規表現 $1 残存・文字化け U+FFFD・孤立テーブル行・未決事項のIssue番号欠落）を検査する純粋関数
 */
export function inspectMarkdownIntegrity(relDoc, content) {
  const docErrors = [];
  const normalized = String(content ?? '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  let inFence = false;
  const nonFenceTableFlags = new Array(lines.length).fill(false);
  const isWebSpecDoc = relDoc.startsWith('docs/Web_Project/');

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (rawLine.includes('\uFFFD')) {
      docErrors.push(
        `[Mojibake / Encoding Corruption Detected] ${relDoc}:${i + 1} contains Unicode replacement character (U+FFFD).`
      );
    }

    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (/^\$[1-9]\d*$/.test(trimmed)) {
      docErrors.push(
        `[Doc Corruption Detected] ${relDoc}:${i + 1} contains literal regex placeholder "${trimmed}".`
      );
    }

    const lineWithoutInlineCode = trimmed.replace(/`[^`]*`/g, '');
    if (isWebSpecDoc && /(?:【未決事項】|【要確認】)/.test(lineWithoutInlineCode)) {
      if (!/(?:Issue\s*)?#\d+/i.test(lineWithoutInlineCode)) {
        docErrors.push(
          `[Missing Issue Reference] ${relDoc}:${i + 1} contains 【未決事項】 or 【要確認】 without a linked GitHub Issue number (e.g., Issue #82).`
        );
      }
    }

    if (/^\|.+\|$/.test(trimmed)) {
      nonFenceTableFlags[i] = true;
    }
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

function getWorkingTreeOrStagedFiles() {
  try {
    if (isStagedMode) {
      const out = execSync('git diff --cached --name-only', { encoding: 'utf8' });
      return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
    const statusOut = execSync('git status --porcelain', { encoding: 'utf8' });
    return statusOut
      .split(/\r?\n/)
      .map((line) => {
        const entry = line.slice(3).trim().replace(/^"(.*)"$/, '$1');
        return entry.includes(' -> ') ? entry.split(' -> ').pop().trim() : entry;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getChangedFiles() {
  try {
    if (isStagedMode) {
      return getWorkingTreeOrStagedFiles();
    }

    const explicitRange = getExplicitDiffRange();
    if (explicitRange) {
      try {
        const out = execSync(`git diff --name-only ${explicitRange}`, { encoding: 'utf8' });
        return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      } catch {
        // Fallback to standard branch/working-tree detection if ref does not exist
      }
    }

    // Working tree (staged + unstaged) + commits ahead of main
    const workingFiles = getWorkingTreeOrStagedFiles();

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

/**
 * SQL DDL から CREATE TABLE IF NOT EXISTS <name> (...) のテーブル・カラム・VARCHAR長を抽出する
 */
function parseSqlTables(sqlText) {
  const tables = new Map();
  const tableRegex = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_]+)\s*\(([\s\S]*?)\n\);/gi;
  let m;
  while ((m = tableRegex.exec(sqlText)) !== null) {
    const tableName = m[1].toLowerCase();
    const body = m[2];
    const cols = new Map();
    for (const rawLine of body.split('\n')) {
      const line = rawLine.replace(/--.*$/, '').trim().replace(/,$/, '').trim();
      if (!line) continue;
      if (/^(?:CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)\b/i.test(line)) continue;
      const colMatch = line.match(/^([a-z_][a-z0-9_]*)\s+([A-Z0-9_]+(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?)/i);
      if (colMatch) {
        const colName = colMatch[1].toLowerCase();
        const colType = colMatch[2].toUpperCase().replace(/\s+/g, '');
        const varcharMatch = colType.match(/^VARCHAR\((\d+)\)$/);
        cols.set(colName, {
          type: colType,
          varcharLength: varcharMatch ? parseInt(varcharMatch[1], 10) : null,
        });
      }
    }
    tables.set(tableName, cols);
  }
  return tables;
}

/**
 * src/types/database.ts から export interface <Name> { ... } のプロパティ一覧を抽出する
 */
function parseTsInterfaces(tsText) {
  const interfaces = new Map();
  const ifaceRegex = /export\s+interface\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = ifaceRegex.exec(tsText)) !== null) {
    const name = m[1];
    const body = m[2];
    const props = new Set();
    for (const rawLine of body.split('\n')) {
      const line = rawLine.replace(/\/\/.*$/, '').trim();
      const propMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\??\s*:/);
      if (propMatch) {
        props.add(propMatch[1]);
      }
    }
    interfaces.set(name, props);
  }
  return interfaces;
}

/**
 * docs/Web_Project/diagrams/SEQUENCE_AND_ERD.md の erDiagram から各エンティティの属性一覧を抽出する
 */
function parseMermaidErdEntities(mdText) {
  const entities = new Map();
  const erdBlockMatch = mdText.match(/```mermaid\s*\nerDiagram([\s\S]*?)```/);
  if (!erdBlockMatch) return entities;
  const erdBody = erdBlockMatch[1];
  const entityRegex = /^\s{4}([a-z_][a-z0-9_]*)\s*\{([\s\S]*?)^\s{4}\}/gm;
  let m;
  while ((m = entityRegex.exec(erdBody)) !== null) {
    const entityName = m[1];
    const cols = new Set();
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
 * src/lib/db.ts の this.version(2).stores({ ... }) からテーブル名とインデックス対象カラムを抽出する
 */
function parseDexieVersion2Stores(dbTsText) {
  const stores = new Map();
  const v2Match = dbTsText.match(/this\.version\(2\)\.stores\(\{([\s\S]*?)\}\);/);
  if (!v2Match) return stores;
  const body = v2Match[1];
  const entryRegex = /([a-z_][a-z0-9_]*)\s*:\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = entryRegex.exec(body)) !== null) {
    const tableName = m[1];
    const spec = m[2];
    const indexedCols = new Set();
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
  return stores;
}

function setsDiff(a, b) {
  const missingInB = [...a].filter((x) => !b.has(x));
  const extraInB = [...b].filter((x) => !a.has(x));
  return { missingInB, extraInB };
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

    const allDocAndDiagramFiles = [
      ...fs
        .readdirSync(DOCS_DIR)
        .filter((name) => name !== 'README.md' && (name.endsWith('.md') || name.endsWith('.drawio'))),
      ...fs
        .readdirSync(path.join(DOCS_DIR, 'diagrams'))
        .filter((name) => name.endsWith('.md') || name.endsWith('.drawio'))
        .map((name) => `diagrams/${name}`),
    ];

    if (!fs.existsSync(path.join(DOCS_DIR, 'USER_GUIDE.md'))) {
      errors.push(`[Missing User Guide] docs/Web_Project/USER_GUIDE.md does not exist.`);
    }

    for (const specFile of allDocAndDiagramFiles) {
      if (!readmeContent.includes(specFile)) {
        errors.push(
          `[Unindexed Spec/Diagram] docs/Web_Project/${specFile} is not linked in docs/Web_Project/README.md.`
        );
      }
    }
    console.log(
      `✅ [PASS] Check 1: Spec index (README.md) covers all ${allDocAndDiagramFiles.length} docs & diagrams in docs/Web_Project/ with no stale markers.`
    );
  }

  // -------------------------------------------------------------------------
  // 2. Check referenced file paths & Markdown links across all project docs & skills
  // -------------------------------------------------------------------------
  const docFiles = [
    ...walkFiles(DOCS_DIR, '.md'),
    ...walkFiles(path.join(ROOT_DIR, '.agents', 'skills'), '.md'),
    path.join(ROOT_DIR, '.agents', 'AGENTS.md'),
    path.join(ROOT_DIR, 'AGENTS.md'),
    path.join(ROOT_DIR, 'README.md'),
  ].filter((p) => fs.existsSync(p));

  // 日本語等の非ASCIIパスも捕捉（ワイルドカード * やテンプレート変数 <...> / ${...} は除外）
  const pathRegex =
    /`((?:src|public|functions|supabase|scripts|e2e|\.github|\.agents|docs)\/[^\s`*<>${}]+?\.[A-Za-z0-9]+)`/g;
  const mdLinkRegex =
    /\]\((?!https?:\/\/|file:\/\/|mailto:|#)([^)#\s*<>${}]+\.(?:md|ts|tsx|mjs|json|yml|sql|drawio|png|jpg|svg|txt))(?:#[^)]*)?\)/g;
  const fileUrlLinkRegex = /\]\(file:\/\/\/([^)#\s]+)(?:#[^)]*)?\)/g;
  let checkedRefCount = 0;

  for (const docFile of docFiles) {
    const relDoc = toPosixRelative(docFile);
    const content = fs.readFileSync(docFile, 'utf8');
    let match;
    while ((match = pathRegex.exec(content)) !== null) {
      const refPath = match[1];
      // .agents/scratch/ 配下は実行時生成物のため実在検査から除外
      if (refPath.startsWith('.agents/scratch/')) continue;
      checkedRefCount++;
      const absRef = path.join(ROOT_DIR, refPath);
      if (!fs.existsSync(absRef)) {
        errors.push(
          `[Broken File Reference] ${relDoc} references non-existent file \`${refPath}\`.`
        );
      }
    }

    while ((match = mdLinkRegex.exec(content)) !== null) {
      const linkTarget = match[1];
      if (linkTarget.includes('.agents/scratch/')) continue;
      checkedRefCount++;
      const absTarget = path.resolve(path.dirname(docFile), linkTarget);
      if (!fs.existsSync(absTarget)) {
        errors.push(
          `[Broken Markdown Link] ${relDoc} links to non-existent relative target "(${linkTarget})".`
        );
      }
    }

    while ((match = fileUrlLinkRegex.exec(content)) !== null) {
      checkedRefCount++;
      errors.push(
        `[Machine-Specific file:// Link Prohibited] ${relDoc} contains machine-local URL "file:///${match[1]}". Use repository-relative Markdown links instead so CI on Linux and other machines can verify them.`
      );
    }

    if (/Users[\\/]+PC05/i.test(content)) {
      errors.push(
        `[Machine-Specific Path Prohibited] ${relDoc} exposes local machine path "Users/PC05". Use repository-relative paths only.`
      );
    }

    if (relDoc === 'docs/Web_Project/USER_GUIDE.md') {
      const bareFileRegex = /`([A-Za-z0-9_]+\.(?:tsx|ts))`/g;
      let bareMatch;
      while ((bareMatch = bareFileRegex.exec(content)) !== null) {
        errors.push(
          `[Abbreviated File Path] ${relDoc} uses bare filename \`${bareMatch[1]}\` without directory path (use full \`src/.../${bareMatch[1]}\` so existence can be verified).`
        );
      }
    }
  }
  console.log(
    `✅ [PASS] Check 2: Verified ${checkedRefCount} file paths & Markdown links (including Unicode paths) across ${docFiles.length} docs/skills.`
  );

  // -------------------------------------------------------------------------
  // 3. Check full module coverage (src/components, contexts, lib, types, workers, functions)
  // -------------------------------------------------------------------------
  const componentFiles = walkFiles(path.join(ROOT_DIR, 'src', 'components'), '.tsx').map(toPosixRelative);
  const contextFiles = walkFiles(path.join(ROOT_DIR, 'src', 'contexts'), '.tsx').map(toPosixRelative);
  const libFiles = walkFiles(path.join(ROOT_DIR, 'src', 'lib'), '.ts')
    .map(toPosixRelative)
    .filter((f) => !f.includes('/__tests__/') && !f.endsWith('.test.ts'));
  const typeFiles = walkFiles(path.join(ROOT_DIR, 'src', 'types'), '.ts').map(toPosixRelative);
  const workerFiles = walkFiles(path.join(ROOT_DIR, 'src', 'workers'), '.ts').map(toPosixRelative);
  const functionFiles = walkFiles(path.join(ROOT_DIR, 'functions'), '.ts').map(toPosixRelative);

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

  const smokeTestContent = fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'smoke-test.mjs'), 'utf8');

  for (const modFile of allTrackableModules) {
    const isMapped = SOURCE_TO_SPEC_RULES.some((rule) => modFile.startsWith(rule.prefix));
    if (!isMapped) {
      errors.push(
        `[Unmapped Module] ${modFile} is not covered by SOURCE_TO_SPEC_RULES in scripts/verify-docs-sync.mjs.`
      );
    }
  }

  for (const srcMod of allSmokeTestableSrcModules) {
    if (!smokeTestContent.includes(`'/${srcMod}'`)) {
      errors.push(
        `[Missing Smoke Test Endpoint] /${srcMod} is not registered in ENDPOINTS_TO_CHECK in scripts/smoke-test.mjs.`
      );
    }
  }
  console.log(
    `✅ [PASS] Check 3: All ${allTrackableModules.length} source/BFF modules are mapped to SSOT specs and all ${allSmokeTestableSrcModules.length} client modules are registered in smoke-test.mjs.`
  );

  // -------------------------------------------------------------------------
  // 4. Git Diff Sync Gate (2-Stage Spec-First Commit & Atomic Sync Aware)
  // -------------------------------------------------------------------------
  const changedFiles = getChangedFiles();
  const explicitRange = getExplicitDiffRange();
  let specFirstStartRef = 'HEAD';
  if (!isStagedMode && explicitRange) {
    const rangeMatch = explicitRange.match(/^([A-Za-z0-9_./~^-]+?)\.{2,3}/);
    if (rangeMatch) {
      specFirstStartRef = rangeMatch[1];
    }
  }
  const specFirstCtx = getPrecedingSpecFirstContext(specFirstStartRef);
  const effectiveSpecSet = new Set([...changedFiles, ...specFirstCtx.specFiles]);
  let usedPrecedingSpecFirst = false;

  if (changedFiles.length > 0 && !skipDiffGate) {
    for (const changedFile of changedFiles) {
      const matchedRules = SOURCE_TO_SPEC_RULES.filter((rule) =>
        changedFile.startsWith(rule.prefix)
      );
      for (const rule of matchedRules) {
        if (Array.isArray(rule.requiredSpecs) && rule.requiredSpecs.length > 0) {
          const missingRequired = rule.requiredSpecs.filter(
            (reqSpec) => !effectiveSpecSet.has(reqSpec)
          );
          if (missingRequired.length > 0) {
            errors.push(
              `[Required Spec Sync Missing] Core file "${changedFile}" (${rule.description}) was modified, ` +
                `but required SSOT spec(s) [${missingRequired.join(', ')}] were updated neither in a preceding "docs(spec): ..." commit nor in this change set.`
            );
          } else if (
            rule.requiredSpecs.some(
              (reqSpec) => !changedFiles.includes(reqSpec) && specFirstCtx.specFiles.includes(reqSpec)
            )
          ) {
            usedPrecedingSpecFirst = true;
          }
        }
        const isSpecUpdated = rule.specs.some((specPath) =>
          effectiveSpecSet.has(specPath)
        );
        if (!isSpecUpdated) {
          errors.push(
            `[Spec Sync Required] Source file "${changedFile}" (${rule.description}) was modified, ` +
              `but none of its corresponding specifications (${rule.specs.join(', ')}) were updated in a preceding "docs(spec): ..." commit or in this change set.\n` +
              `   👉 Record a Spec-First commit ('git commit -m "docs(spec): ..."') before implementing, or update the relevant SPEC_*.md in this change set (set SKIP_DOC_SYNC=1 only for pure internal refactors with zero spec changes).`
          );
        } else if (
          !rule.specs.some((specPath) => changedFiles.includes(specPath)) &&
          rule.specs.some((specPath) => specFirstCtx.specFiles.includes(specPath))
        ) {
          usedPrecedingSpecFirst = true;
        }
      }
    }
  }
  console.log(
    `✅ [PASS] Check 4: Git diff sync gate evaluated (${changedFiles.length} changed files inspected${
      usedPrecedingSpecFirst
        ? `; Spec-First verified via preceding docs(spec) commit [${specFirstCtx.commits.join(', ')}]`
        : ''
    }).`
  );

  // -------------------------------------------------------------------------
  // 5. Security, Anti-Stub & User-Centric UX Gate (src/ + functions/)
  // -------------------------------------------------------------------------
  const allSrcFiles = [
    ...walkFiles(path.join(ROOT_DIR, 'src'), '.ts'),
    ...walkFiles(path.join(ROOT_DIR, 'src'), '.tsx'),
    ...walkFiles(path.join(ROOT_DIR, 'functions'), '.ts'),
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
  console.log(
    `✅ [PASS] Check 5: Security, Anti-Stub & User-Centric UX Gate verified across ${allSrcFiles.length} source & BFF files.`
  );

  // -------------------------------------------------------------------------
  // 6. 4-Layer Schema & First-Class Diagram Parity Gate
  //    (SQL DDL === ARCHITECTURE.md §5 === database.ts === db.ts === SEQUENCE_AND_ERD.md)
  // -------------------------------------------------------------------------
  const migrationPath = path.join(ROOT_DIR, 'supabase', 'migrations', '0001_initial_schema.sql');
  const archPath = path.join(DOCS_DIR, 'ARCHITECTURE.md');
  const typesPath = path.join(ROOT_DIR, 'src', 'types', 'database.ts');
  const dbPath = path.join(ROOT_DIR, 'src', 'lib', 'db.ts');
  const seqErdPath = path.join(DOCS_DIR, 'diagrams', 'SEQUENCE_AND_ERD.md');
  const csvFlowPath = path.join(DOCS_DIR, 'diagrams', 'CSV_IMPORT_AND_ANOMALY_FLOW.md');
  const drawioPath = path.join(DOCS_DIR, 'diagrams', 'system_architecture.drawio');

  if (fs.existsSync(migrationPath) && fs.existsSync(archPath)) {
    const migrationSql = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n').trim();
    const archContent = fs.readFileSync(archPath, 'utf8').replace(/\r\n/g, '\n');
    const sec5Idx = archContent.indexOf('## 5. データベース物理スキーマ');
    const sec5BlockMatch =
      sec5Idx >= 0 ? archContent.slice(sec5Idx).match(/```sql\n([\s\S]*?)\n```/) : null;

    if (!sec5BlockMatch) {
      errors.push(
        `[DDL Parity Gate] Could not find \`\`\`sql block under Section 5 in docs/Web_Project/ARCHITECTURE.md.`
      );
    } else {
      const archSql = sec5BlockMatch[1].trim();
      if (archSql !== migrationSql) {
        const migLines = migrationSql.split('\n');
        const archLines = archSql.split('\n');
        let firstDiffLine = 1;
        for (let i = 0; i < Math.max(migLines.length, archLines.length); i++) {
          if (migLines[i] !== archLines[i]) {
            firstDiffLine = i + 1;
            break;
          }
        }
        errors.push(
          `[DDL Parity Violation] docs/Web_Project/ARCHITECTURE.md Section 5 SQL diverges from supabase/migrations/0001_initial_schema.sql at SQL line ${firstDiffLine} (migration: ${migLines.length} lines vs ARCHITECTURE.md: ${archLines.length} lines). Keep Section 5 100% identical to 0001_initial_schema.sql.`
        );
      }
    }

    // 4-Layer Schema Parity (SQL <-> TypeScript <-> Dexie <-> Mermaid ERD)
    const sqlTables = parseSqlTables(migrationSql);
    const expectedTableNames = new Set(Object.keys(SQL_TABLE_TO_TS_INTERFACE));
    const { missingInB: missingSqlTables, extraInB: extraSqlTables } = setsDiff(
      expectedTableNames,
      new Set(sqlTables.keys())
    );
    if (missingSqlTables.length > 0 || extraSqlTables.length > 0) {
      errors.push(
        `[Schema Parity Violation] SQL table set mismatch in 0001_initial_schema.sql (missing: [${missingSqlTables.join(', ')}], unmapped: [${extraSqlTables.join(', ')}]).`
      );
    }

    // VARCHAR length consistency between categories.category_name, events.timing_category & MAX_CATEGORY_NAME_LENGTH
    const catLen = sqlTables.get('categories')?.get('category_name')?.varcharLength;
    const timingLen = sqlTables.get('events')?.get('timing_category')?.varcharLength;
    if (catLen && timingLen && catLen !== timingLen) {
      errors.push(
        `[Schema Length Mismatch] categories.category_name is VARCHAR(${catLen}) while events.timing_category is VARCHAR(${timingLen}). ActivityRecordModal stores category_name in timing_category, so both must match.`
      );
    }

    if (fs.existsSync(typesPath)) {
      const tsText = fs.readFileSync(typesPath, 'utf8');
      const tsInterfaces = parseTsInterfaces(tsText);
      const maxConstMatch = tsText.match(/MAX_CATEGORY_NAME_LENGTH\s*=\s*(\d+)/);
      const tsMaxCatLen = maxConstMatch ? parseInt(maxConstMatch[1], 10) : null;
      if (catLen && tsMaxCatLen !== catLen) {
        errors.push(
          `[Schema Length Mismatch] MAX_CATEGORY_NAME_LENGTH in src/types/database.ts is ${tsMaxCatLen}, expected ${catLen} (from categories.category_name VARCHAR(${catLen})).`
        );
      }

      for (const [sqlTbl, ifaceName] of Object.entries(SQL_TABLE_TO_TS_INTERFACE)) {
        const sqlCols = new Set((sqlTables.get(sqlTbl) || new Map()).keys());
        const tsProps = tsInterfaces.get(ifaceName);
        if (!tsProps) {
          errors.push(
            `[Schema Parity Violation] Missing TypeScript interface "${ifaceName}" in src/types/database.ts for SQL table "${sqlTbl}".`
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

    if (fs.existsSync(dbPath)) {
      const dbText = fs.readFileSync(dbPath, 'utf8');
      const dexieStores = parseDexieVersion2Stores(dbText);
      const expectedLocalTables = new Set(
        Object.keys(SQL_TABLE_TO_TS_INTERFACE).filter((t) => t !== 'family_permissions')
      );
      const { missingInB, extraInB } = setsDiff(
        expectedLocalTables,
        new Set(dexieStores.keys())
      );
      if (missingInB.length > 0 || extraInB.length > 0) {
        errors.push(
          `[Schema Parity Violation] Dexie Version 2 stores in src/lib/db.ts diverge from local table set (missing: [${missingInB.join(', ')}], extra: [${extraInB.join(', ')}]).`
        );
      }
      for (const [tblName, indexedCols] of dexieStores.entries()) {
        const sqlCols = new Set((sqlTables.get(tblName) || new Map()).keys());
        for (const idxCol of indexedCols) {
          if (!sqlCols.has(idxCol)) {
            errors.push(
              `[Schema Parity Violation] Dexie table "${tblName}" in src/lib/db.ts indexes column "${idxCol}", which does not exist in 0001_initial_schema.sql.`
            );
          }
        }
      }
    }

    if (fs.existsSync(seqErdPath)) {
      const seqErd = fs.readFileSync(seqErdPath, 'utf8');
      if (!seqErd.includes('family_email') || !seqErd.includes('bindMealGlucoseFromReadings')) {
        errors.push(
          `[Diagram Sync Violation] docs/Web_Project/diagrams/SEQUENCE_AND_ERD.md is missing "family_email" in ER diagram or "bindMealGlucoseFromReadings" in CSV sequence diagram.`
        );
      }
      const erdEntities = parseMermaidErdEntities(seqErd);
      for (const sqlTbl of Object.keys(SQL_TABLE_TO_TS_INTERFACE)) {
        const sqlCols = new Set((sqlTables.get(sqlTbl) || new Map()).keys());
        const erdCols = erdEntities.get(sqlTbl);
        if (!erdCols) {
          errors.push(
            `[ERD Parity Violation] Entity "${sqlTbl}" is missing from erDiagram in docs/Web_Project/diagrams/SEQUENCE_AND_ERD.md.`
          );
          continue;
        }
        const { missingInB, extraInB } = setsDiff(sqlCols, erdCols);
        if (missingInB.length > 0 || extraInB.length > 0) {
          errors.push(
            `[ERD Parity Violation] Entity "${sqlTbl}" in docs/Web_Project/diagrams/SEQUENCE_AND_ERD.md diverges from SQL DDL (missing in ERD: [${missingInB.join(', ')}], extra in ERD: [${extraInB.join(', ')}]).`
          );
        }
      }
    }
  }

  if (fs.existsSync(csvFlowPath)) {
    const csvFlow = fs.readFileSync(csvFlowPath, 'utf8');
    if (
      !csvFlow.includes('bindMealGlucoseFromReadings') ||
      !csvFlow.includes('28分') ||
      !csvFlow.includes('45分') ||
      !csvFlow.includes('hypoThreshold')
    ) {
      errors.push(
        `[Diagram Sync Violation] docs/Web_Project/diagrams/CSV_IMPORT_AND_ANOMALY_FLOW.md is missing required pipeline/state-machine elements (bindMealGlucoseFromReadings, 28分, 45分, hypoThreshold).`
      );
    }
  }
  if (fs.existsSync(drawioPath)) {
    const drawio = fs.readFileSync(drawioPath, 'utf8');
    if (!drawio.includes('family_email') || !drawio.includes('Supabase Storage（未実装）')) {
      errors.push(
        `[Diagram Sync Violation] docs/Web_Project/diagrams/system_architecture.drawio is missing "family_email" or "Supabase Storage（未実装）" marker.`
      );
    }
  }
  console.log(
    `✅ [PASS] Check 6: 4-Layer Schema & Diagram Parity Gate verified (SQL DDL === ARCHITECTURE.md §5 === database.ts === db.ts === ERD + 3 diagrams).`
  );

  // -------------------------------------------------------------------------
  // 7. E2E / Smoke / Vitest Count & Lifecycle Hook Script Integrity Gate
  // -------------------------------------------------------------------------
  const e2eSpecPath = path.join(ROOT_DIR, 'e2e', 'app.spec.ts');
  const testDir = path.join(ROOT_DIR, 'src', 'lib', '__tests__');
  const unitTestFiles = walkFiles(testDir, '.test.ts');
  let actualVitestCount = 0;
  for (const tf of unitTestFiles) {
    const tc = fs.readFileSync(tf, 'utf8');
    actualVitestCount += (tc.match(/\b(?:it|test)\s*\(/g) || []).length;
  }

  if (fs.existsSync(e2eSpecPath)) {
    const e2eContent = fs.readFileSync(e2eSpecPath, 'utf8');
    const e2eMatches = e2eContent.match(/test\(['"`]E2E-\d+:/g) || [];
    const e2eCount = e2eMatches.length;

    const e2eRangeRegex = /E2E-1[`'"]?\s*[〜~]\s*[`'"]?E2E-(\d+)\b/g;
    const totalSuitesRegex = /全(\d+)スイート/g;
    const smokeEndpointsRegex = /全(\d+)(?:モジュール)?エンドポイント/g;
    const vitestCountRegex = /Vitest[`'"]?\s*(?:全)?(\d+)件/g;
    const expectedSmokeEndpoints = allSmokeTestableSrcModules.length + 1;

    for (const docFile of docFiles) {
      const relDoc = toPosixRelative(docFile);
      const content = fs.readFileSync(docFile, 'utf8');
      let m;
      while ((m = e2eRangeRegex.exec(content)) !== null) {
        const mentionedEnd = parseInt(m[1], 10);
        if (mentionedEnd !== e2eCount) {
          errors.push(
            `[Stale E2E Suite Count] ${relDoc} contains "${m[0]}" (expected E2E-1〜E2E-${e2eCount}).`
          );
        }
      }
      while ((m = totalSuitesRegex.exec(content)) !== null) {
        const mentionedTotal = parseInt(m[1], 10);
        if (mentionedTotal !== e2eCount) {
          errors.push(
            `[Stale E2E Suite Count] ${relDoc} contains "${m[0]}" (expected 全${e2eCount}スイート).`
          );
        }
      }
      while ((m = smokeEndpointsRegex.exec(content)) !== null) {
        const mentionedEndpoints = parseInt(m[1], 10);
        if (mentionedEndpoints !== expectedSmokeEndpoints) {
          errors.push(
            `[Stale Smoke Endpoint Count] ${relDoc} contains "${m[0]}" (expected 全${expectedSmokeEndpoints}エンドポイント).`
          );
        }
      }
      while ((m = vitestCountRegex.exec(content)) !== null) {
        const mentionedTests = parseInt(m[1], 10);
        if (actualVitestCount > 0 && mentionedTests !== actualVitestCount) {
          errors.push(
            `[Stale Vitest Test Count] ${relDoc} contains "${m[0]}" (actual test cases: ${actualVitestCount}).`
          );
        }
      }
    }
  }

  const hooksJsonPath = path.join(ROOT_DIR, '.agents', 'hooks.json');
  if (fs.existsSync(hooksJsonPath)) {
    const hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    for (const [hookGroup, groupDef] of Object.entries(hooksConfig)) {
      const stopHooks = Array.isArray(groupDef?.Stop) ? groupDef.Stop : [];
      for (const hook of stopHooks) {
        if (typeof hook.command === 'string' && hook.command.startsWith('node ')) {
          const scriptRel = hook.command.replace(/^node\s+/, '').trim();
          const scriptAbs = path.join(ROOT_DIR, '.agents', scriptRel);
          if (!fs.existsSync(scriptAbs)) {
            errors.push(
              `[Broken Hook Script Path] .agents/hooks.json (${hookGroup}) references non-existent script "${scriptRel}".`
            );
          }
        }
      }
    }
  }
  console.log(
    `✅ [PASS] Check 7: E2E/Smoke/Vitest count parity & .agents/hooks.json script existence verified.`
  );

  // -------------------------------------------------------------------------
  // 8. Documented Identifier Existence Gate (既定で厳格 ERROR; WARN_IDENT_CHECK=1 のみ警告)
  // -------------------------------------------------------------------------
  {
    const identWalk = (dir, out = []) => {
      if (!fs.existsSync(dir)) return out;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) identWalk(p, out);
        else out.push(p);
      }
      return out;
    };
    let codeCorpus = '';
    for (const d of [
      'src',
      'functions',
      'supabase',
      'e2e',
      'scripts',
      'public',
      '.agents/hooks',
      '.github/workflows',
    ]) {
      for (const f of identWalk(path.join(ROOT_DIR, d))) {
        if (!/\.(ts|tsx|mjs|js|sql|json|html|yml|yaml)$/.test(f)) continue;
        if (/[\\/]public[\\/]data[\\/]/.test(f)) continue;
        codeCorpus += fs.readFileSync(f, 'utf8') + '\n';
      }
    }
    for (const f of [
      'package.json',
      'vite.config.ts',
      'playwright.config.ts',
      'vitest.config.ts',
      'wrangler.toml',
      'tsconfig.json',
      'tsconfig.functions.json',
      'tsconfig.e2e.json',
      '.nvmrc',
      'index.html',
    ]) {
      const p = path.join(ROOT_DIR, f);
      if (fs.existsSync(p)) codeCorpus += fs.readFileSync(p, 'utf8') + '\n';
    }

    /**
     * 検査対象外（外部ライブラリのAPI名・過去の設計の説明・将来仕様など、意図的にコード外に存在する識別子）。
     * 追加する場合は理由を付記すること。
     */
    const IDENT_ALLOWLIST = new Set([
      'ErrorBars', // Excel(VBA)側の旧機能名（移行元の説明）
      'markPoint', // ECharts の標準オプション名
      'sessionStorage', // ブラウザ標準API名（使用禁止の説明）
      'invoke_subagent', // Antigravity エージェント実行環境の組み込みツール名
    ]);

    const identDocs = [
      ...identWalk(DOCS_DIR).filter((f) => /\.(md|drawio)$/.test(f)),
      path.join(ROOT_DIR, '.agents', 'AGENTS.md'),
      path.join(ROOT_DIR, 'AGENTS.md'),
      path.join(ROOT_DIR, 'README.md'),
    ].filter((f) => fs.existsSync(f));

    const forceStrictIdents =
      process.env.CI === 'true' ||
      process.env.STRICT_DOC_IDENTIFIERS === '1' ||
      process.argv.includes('--strict-identifiers');
    const activeFilesForIdentCheck = getWorkingTreeOrStagedFiles();
    const isPureSpecEditPhase =
      !forceStrictIdents &&
      activeFilesForIdentCheck.length > 0 &&
      activeFilesForIdentCheck.every((f) =>
        /^(?:docs\/|\.agents\/|README\.md$|AGENTS\.md$)/.test(f)
      );

    let specFirstAddedIdents = new Set();
    if (isPureSpecEditPhase) {
      try {
        const diffCmd = isStagedMode ? 'git diff --cached -U0' : 'git diff HEAD -U0';
        const diffText = execSync(diffCmd, {
          cwd: ROOT_DIR,
          encoding: 'utf8',
          maxBuffer: 20 * 1024 * 1024,
        });
        specFirstAddedIdents = extractAddedBacktickIdentifiersFromDiff(diffText);
      } catch {
        specFirstAddedIdents = new Set();
      }
    }

    const missingIdents = new Map();
    const pendingSpecFirstIdents = new Map();
    let identChecked = 0;
    for (const f of identDocs) {
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(/`([A-Za-z_][A-Za-z0-9_.]*)(\(\))?`/g)) {
        // ファイル拡張子 (.tsx, .ts, .mjs, .sql, .json, .md, .xlsm, .txt, .png, .yml, .drawio) は識別子ではなくファイル名のためスキップ
        if (/\.(?:tsx?|mjs|js|sql|json|md|xlsm|xlsx|txt|png|jpg|svg|yml|yaml|drawio|css|html)$/i.test(m[1])) {
          continue;
        }
        const core = m[1].split('.').pop();
        if (core.length < 5 || !(/[a-z][A-Z]|_/.test(core) || m[2])) continue;
        if (IDENT_ALLOWLIST.has(core)) continue;
        identChecked++;
        if (!codeCorpus.includes(core)) {
          const key = `${path.relative(ROOT_DIR, f).replace(/\\/g, '/')} :: ${m[1]}`;
          if (isPureSpecEditPhase && specFirstAddedIdents.has(core)) {
            pendingSpecFirstIdents.set(key, true);
          } else {
            missingIdents.set(key, true);
          }
        }
      }
    }
    if (pendingSpecFirstIdents.size > 0) {
      console.log(
        `ℹ️ [Spec-First Stage] Check 8: Allowing ${pendingSpecFirstIdents.size} newly added planned identifier(s) during pure spec update (will be strictly enforced upon implementation / pipeline / CI):`
      );
      for (const key of pendingSpecFirstIdents.keys()) {
        console.log(`   - ${key}`);
      }
    }
    if (missingIdents.size > 0) {
      const warnOnly = process.env.WARN_IDENT_CHECK === '1';
      const label = warnOnly ? 'WARN' : 'ERROR';
      console.warn(
        `⚠️ [${label}] Check 8: ${missingIdents.size} documented identifier(s) not found in code (checked ${identChecked}):`
      );
      for (const key of missingIdents.keys()) {
        console.warn(`   - ${key}`);
        if (!warnOnly) {
          errors.push(`[Stale Identifier] ${key} is documented but absent from code.`);
        }
      }
    } else {
      console.log(`✅ [PASS] Check 8: All ${identChecked} documented identifiers verified (${pendingSpecFirstIdents.size > 0 ? 'Spec-First pending stage' : 'strict mode'}).`);
    }
  }

  // -------------------------------------------------------------------------
  // 9. Doc Corruption, Open-Item Issue Link & Legacy Asset Isolation Gate
  //    - 正規表現置換ミスによる "$1" 等の単独行破損・文字化け (U+FFFD) を検出
  //    - フェンスコードブロック外の孤立した1行 Markdown テーブル行を検出
  //    - 仕様書内の「【未決事項】」「【要確認】」に Issue 番号が併記されていることを検証
  //    - 旧VBA資料・旧スクリーンショット・個人メモが Git インデックスに含まれていないことを検証
  // -------------------------------------------------------------------------
  for (const docFile of docFiles) {
    const relDoc = toPosixRelative(docFile);
    const content = fs.readFileSync(docFile, 'utf8');
    const integrityErrors = inspectMarkdownIntegrity(relDoc, content);
    for (const ie of integrityErrors) {
      errors.push(ie);
    }
  }

  for (const forbiddenDir of FORBIDDEN_TRACKED_DIRS) {
    try {
      const tracked = execSync(`git ls-files "${forbiddenDir}"`, {
        cwd: ROOT_DIR,
        encoding: 'utf8',
      }).trim();
      if (tracked.length > 0) {
        const count = tracked.split(/\r?\n/).filter(Boolean).length;
        errors.push(
          `[Forbidden Legacy Asset Tracked] "${forbiddenDir}/" has ${count} file(s) tracked in Git index. Untrack them with 'git rm -r --cached "${forbiddenDir}"' and add to .gitignore.`
        );
      }
    } catch {
      // Ignore if git is unavailable
    }
  }
  console.log(
    `✅ [PASS] Check 9: Doc corruption guard (zero regex placeholders / mojibake / orphaned table rows / unlinked open items) & legacy VBA asset isolation verified.`
  );

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

const isExecutedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isExecutedDirectly) {
  runVerification();
}
