---
trigger: model_decision
description: Cloudflare Pages Functions BFF (functions/api/gemini.ts)、糖質量推定クライアント (src/lib/gemini.ts)、wrangler.toml、またはデプロイワークフロー (.github/workflows/deploy-pages.yml) を編集・監査するときに適用する。
---

# ルール: Cloudflare Pages BFF・秘密情報・バンドル分離 (`bff-gemini`)

## 1. 秘密情報の完全隔離
- `GEMINI_API_KEY`・`SUPABASE_SERVICE_ROLE_KEY`・`CLOUDFLARE_API_TOKEN` 等の秘密情報を、クライアントコード（`src/`）、`VITE_*` 環境変数、`localStorage` / `sessionStorage`、ログ、または Git 追跡ファイル（`.env.personal` / `.env.portfolio` / `wrangler.toml` / 仕様書 / テスト）に記述・保存することを厳禁とする。
- クライアントバンドルに含めてよい環境変数は RLS 前提の `VITE_SUPABASE_URL` と `VITE_SUPABASE_ANON_KEY`、および `VITE_APP_MODE` のみとする。
- 本番環境の `GEMINI_API_KEY` は Cloudflare Pages の Secrets にのみ格納し、公開デモ環境には設定しない。

## 2. `/api/gemini` BFF 多層防御 (`functions/api/gemini.ts`)
1. **ランタイム制約**: `functions/api/gemini.ts` は Cloudflare Workers 標準 Web API（`Request`, `Response`, `crypto.subtle`, `fetch`）のみで実装し、`node_modules` 依存を持ち込まない。
2. **CSRF / Cross-Origin 遮断**: `Sec-Fetch-Site: cross-site` または不一致 `Origin` からの POST リクエストは即座に HTTP `403` で拒否する。
3. **Supabase JWT 検証必須**: 本番モードでは `Origin` ヘッダー単独を認証とみなさず、`Authorization: Bearer <token>` を Supabase Auth（`/auth/v1/user`）で検証し、未認証・無効トークンは HTTP `401` で遮断する。
4. **ユーザー単位レート制限**: JWT の `sub` 単位でスライディングウィンドウ制限（`checkBffUserRateLimit`）を適用し、上限超過時は `Retry-After` ヘッダー付き HTTP `429` を返す。
5. **安全なローカル辞書フォールバック**: `GEMINI_API_KEY` 未設定時・オフライン時・`401` / `429` / `5xx` 応答時は、クライアント側の内蔵食品辞書（`estimateCarbsLocally`）へ透過的にフォールバックさせる。

## 3. 出力ディレクトリ分離と公開設定の衛生管理
- ビルド出力先は `dist-portfolio`（`VITE_APP_MODE=portfolio`）と `dist-personal`（`VITE_APP_MODE=personal`）に物理分離し、`dist-personal` からはデモ用 JSON（`data/real_glucose_*.json`）を完全除外する。
- クライアントコード内にテスト用バックドアフラグ（`window` グローバル変数によるモード偽装等）を設けてはならない。
- 公開リポジトリにも同期される `wrangler.toml` および `.github/workflows/deploy-pages.yml` には、非公開の個人本番プロジェクト名や Private GitHub Issue 番号をハードコードせず、GitHub Secrets / Variables（`CF_PAGES_PROJECT_NAME`）経由で注入する。
