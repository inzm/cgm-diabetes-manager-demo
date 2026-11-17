/**
 * ツール実行前ガードフック (PreToolUse Hook): pre-tool-guard.mjs
 *
 * 破壊的・規約違反のツール呼び出しを実行前に機械的に遮断 ("deny") または
 * ユーザー承認必須 ("force_ask") に制御する。
 *
 * - deny:
 *   1. git commit/push/merge 等の --no-verify (および git commit -n)
 *   2. main または public-demo への Force Push (--force / -f / --force-with-lease / +refspec)
 *   3. 参照専用の legacy_vba/ 配下への書き込み・削除・移動
 *   4. Excel COM オートメーション (Excel.Application) および excel-manager MCP の実行
 *   5. 検証ゲートを迂回する旧直接デプロイコマンド (deploy:personal / pages:deploy 等)
 * - force_ask:
 *   1. SKIP_DOC_SYNC=1 / WARN_IDENT_CHECK=1 による検証ゲート緩和
 *   2. 本番 Supabase MCP のスキーマ変更・データ更新系ツール呼び出し
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinWithTimeout } from './session-start.mjs';

const WRITE_FILE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'replace_file_content',
  'multi_replace_file_content',
  'create_file',
  'delete_file',
]);

const SUPABASE_MUTATING_MCP_TOOLS = new Set([
  'apply_migration',
  'restore_project',
  'pause_project',
  'delete_branch',
  'merge_branch',
  'rebase_branch',
  'reset_branch',
  'create_branch',
]);

function normalizePathSlashes(str) {
  return String(str ?? '')
    .replace(/\\+"/g, '"')
    .replace(/\\+/g, '/');
}

function extractToolInfo(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const toolObj = p.tool && typeof p.tool === 'object' ? p.tool : {};
  const toolName = String(
    p.tool_name || p.toolName || p.name || toolObj.name || ''
  ).trim();
  const toolInput =
    p.tool_input ??
    p.toolInput ??
    p.args ??
    p.arguments ??
    p.input ??
    toolObj.arguments ??
    toolObj.input ??
    {};
  return { toolName, toolInput };
}

/**
 * PreToolUse ペイロードを純粋評価し、{ decision: "allow" | "deny" | "force_ask", reason?: string } を返す
 */
export function evaluatePreToolGuard(payload) {
  const { toolName, toolInput } = extractToolInfo(payload);
  const lowerTool = toolName.toLowerCase();

  // 1. ファイル書込系ツールでの legacy_vba/ 編集禁止
  if (
    WRITE_FILE_TOOLS.has(lowerTool) ||
    Array.from(WRITE_FILE_TOOLS).some((t) => lowerTool.endsWith(t))
  ) {
    const rawPath = normalizePathSlashes(
      toolInput?.Path || toolInput?.TargetFile || toolInput?.file_path || toolInput?.path || ''
    );
    if (/(?:^|\/)legacy_vba(?:\/|$)/i.test(rawPath)) {
      return {
        decision: 'deny',
        reason:
          '[PreToolUse Blocked] legacy_vba/ は参照専用（編集禁止）です。Web版の実装またはテストのみを編集してください。',
      };
    }
  }

  // 1b. ローカル秘密情報ファイル (.env / .env.local / .env.*.local / .dev.vars / *.pem / *.key) の読取遮断
  if (lowerTool === 'read_file' || lowerTool.endsWith('read_file') || lowerTool === 'view_file') {
    const rawReadPath = normalizePathSlashes(
      toolInput?.Path || toolInput?.TargetFile || toolInput?.file_path || toolInput?.path || ''
    );
    if (
      /(?:^|\/)(?:\.env|\.env\.local|\.env\.[^/]+\.local|\.dev\.vars(?:\.[^/]+)?|.+\.(?:pem|key))$/i.test(
        rawReadPath
      )
    ) {
      return {
        decision: 'deny',
        reason:
          '[PreToolUse Blocked] ローカル秘密情報ファイル (.env / .env.local / .dev.vars / 秘密鍵) のコンテキスト読取はセキュリティ保護のため禁止されています。',
      };
    }
  }

  // 2. MCP ツール呼び出し検査 (excel-manager 禁止 / 本番DB変更系は force_ask)
  if (lowerTool.includes('call_mcp_tool') || lowerTool.startsWith('mcp_')) {
    const serverName = String(
      toolInput?.ServerName || toolInput?.server_name || toolInput?.server || ''
    ).toLowerCase();
    const mcpToolName = String(
      toolInput?.ToolName || toolInput?.tool_name || lowerTool
    ).toLowerCase();
    const mcpArgs =
      toolInput?.Arguments || toolInput?.arguments || toolInput || {};

    if (serverName.includes('excel-manager') || lowerTool.includes('excel-manager')) {
      return {
        decision: 'deny',
        reason:
          '[PreToolUse Blocked] Excel COM / excel-manager MCP の実行は規約により全面禁止されています。',
      };
    }

    if (serverName.includes('supabase') || lowerTool.includes('supabase')) {
      if (SUPABASE_MUTATING_MCP_TOOLS.has(mcpToolName)) {
        return {
          decision: 'force_ask',
          reason: `[PreToolUse Confirmation] 本番 Supabase 環境への変更操作 (${mcpToolName}) を実行しようとしています。実行してよろしいですか？`,
        };
      }
      if (mcpToolName === 'execute_sql') {
        const query = String(mcpArgs?.query || '').trim();
        const withoutComments = query
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/--.*$/gm, ' ');
        if (
          /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|SECURITY\s+DEFINER)\b/i.test(
            withoutComments
          )
        ) {
          return {
            decision: 'force_ask',
            reason:
              '[PreToolUse Confirmation] execute_sql にスキーマ変更またはデータ更新系 SQL が含まれています。実行してよろしいですか？',
          };
        }
      }
    }
  }

  // 3. シェルコマンド (run_command) 検査
  if (lowerTool.includes('run_command') || lowerTool === 'bash' || lowerTool === 'powershell') {
    const cmd = String(
      toolInput?.CommandLine || toolInput?.command || toolInput?.cmd || ''
    );
    const normCmd = normalizePathSlashes(cmd);

    // 3a. --no-verify / git commit -n によるフックバイパス遮断
    if (
      /\bgit\b[^;|&\n]*\s--no-verify\b/i.test(cmd) ||
      /\bgit\s+commit\b[^;|&\n]*\s-(?:[a-zA-Z]*n[a-zA-Z]*)\b/i.test(cmd)
    ) {
      return {
        decision: 'deny',
        reason:
          '[PreToolUse Blocked] Git フックをバイパスする --no-verify / -n オプションは禁止されています。検証エラーを解消してからコミット・Push してください。',
      };
    }

    // 3b. main ブランチや public-demo への Force Push 遮断
    if (
      /\bgit\s+push\b[^;|&\n]*(?:--force(?:-with-lease)?|\s-f\b)[^;|&\n]*(?:\bmain\b|\bpublic-demo\b)/i.test(
        cmd
      ) ||
      /\bgit\s+push\b[^;|&\n]*(?:\bmain\b|\bpublic-demo\b)[^;|&\n]*(?:--force(?:-with-lease)?|\s-f\b)/i.test(
        cmd
      ) ||
      /\bgit\s+push\b[^;|&\n]*\+[A-Za-z0-9_./-]+:(?:refs\/heads\/)?main\b/i.test(cmd)
    ) {
      return {
        decision: 'deny',
        reason:
          '[PreToolUse Blocked] main ブランチまたは public-demo リモートへの Force Push は禁止されています（Ruleset 27410303 保護対象）。Fast-Forward 公開フローを使用してください。',
      };
    }

    // 3c. Excel COM 実行遮断
    if (
      /Excel\.Application|GetActiveObject\s*\(\s*['"]Excel|-ComObject\s+['"]?Excel/i.test(
        cmd
      )
    ) {
      return {
        decision: 'deny',
        reason:
          '[PreToolUse Blocked] Excel COM オートメーションの実行は規約により禁止されています。',
      };
    }

    // 3d. legacy_vba/ への破壊的シェル操作遮断
    if (
      /(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|\brm\b|\bmv\b|\bcp\b|fs\.(?:writeFile|unlink|rm|appendFile))[^;|&\n]*legacy_vba/i.test(
        normCmd
      ) ||
      /legacy_vba[^;|&\n]*(?:>\s*|>>\s*|Remove-Item|Set-Content|Out-File)/i.test(normCmd)
    ) {
      return {
        decision: 'deny',
        reason:
          '[PreToolUse Blocked] 参照専用の legacy_vba/ に対する変更・削除コマンドは禁止されています。',
      };
    }

    // 3e. 旧直接デプロイスクリプトの呼び出し遮断
    if (
      /\bnpm\s+run\s+(?:deploy:personal|deploy:portfolio|pages:deploy(?::personal|:demo)?)\b/i.test(
        cmd
      )
    ) {
      return {
        decision: 'deny',
        reason:
          '[PreToolUse Blocked] 検証ゲートを迂回する直接 Wrangler デプロイは廃止されました。npm run pipeline:ship:personal または pipeline:ship:demo を使用してください。',
      };
    }

    // 3f. SKIP_DOC_SYNC=1 / WARN_IDENT_CHECK=1 はユーザー確認を強制
    if (/\b(?:SKIP_DOC_SYNC|WARN_IDENT_CHECK)\s*=\s*['"]?1['"]?/i.test(cmd)) {
      return {
        decision: 'force_ask',
        reason:
          '[PreToolUse Confirmation] DDD 仕様同期・識別子実在ゲートを緩和する環境変数 (SKIP_DOC_SYNC=1 / WARN_IDENT_CHECK=1) が指定されています。本当に許可しますか？',
      };
    }
  }

  return { decision: 'allow' };
}

async function main() {
  let payload = {};
  try {
    const raw = await readStdinWithTimeout(500);
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }

  const verdict = evaluatePreToolGuard(payload);
  process.stdout.write(JSON.stringify(verdict) + '\n');
}

const isExecutedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isExecutedDirectly) {
  main().catch(() => {
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
  });
}
