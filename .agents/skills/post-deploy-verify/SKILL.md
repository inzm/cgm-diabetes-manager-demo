---
name: post-deploy-verify
description: main または public-demo への出荷 Push 後に、GitHub Actions CD の完了待機と Cloudflare Pages 実環境の HTTP 死活・バンドル分離・BFF JWT 認証境界のスモーク検証を行う。pipeline:ship:* 実行後の本番・デモ確認時に使う。
---

# post-deploy-verify

目的: `npm run pipeline:ship:personal` または `npm run pipeline:ship:demo` の完了後、GitHub Actions 上の自動デプロイ成功と Cloudflare Pages 実エンドポイントの健全性を機械的に確認する。

## 1. GitHub Actions CD 完了監視

Push 直後の対象コミット SHA を取得し、対応リポジトリのワークフロー完了を待機する（ポーリングループの `sleep` は使わず `gh run watch --exit-status` を使用する）。

```powershell
# 1. 直近のワークフロー実行 ID を確認（デュアルリモート環境のため --repo を明示指定）
gh run list --repo inzm/cgm-diabates-manager-web --limit 3 --json databaseId,headSha,status,conclusion,workflowName

# 2. ワークフロー完了まで待機（失敗時は非ゼロ終了）
gh run watch <RUN_ID> --repo inzm/cgm-diabates-manager-web --exit-status
```

- 公開デモ（`public-demo`）側を確認する場合は `--repo inzm/cgm-diabetes-manager-demo` に切り替える。

## 2. ライブ URL スモーク検証 (`scripts/post-deploy-smoke.mjs`)

患者データや秘密キーを一切送信せず、公開 HTTP 応答のみで以下を自動検査する:
1. `GET /`: HTTP `200` かつ SPA ルート要素 `<div id="root">` が返ること。
2. `GET /sw.js`: HTTP `200` かつビルドハッシュ付き `CACHE_NAME = 'cgm-manager-v2-<8hex>'` が刻印されていること。
3. バンドルデータ隔離（`GET /data/real_glucose_recent.json`）:
   - `--target=personal`: デモ用 JSON 配列が配信されていないこと（`dist-personal` のデモデータ除外確認）。
   - `--target=demo`: HTTP `200` でデモ用 JSON が配信されること。
4. BFF 未認証遮断（`--target=personal` のみ）:
   - `POST /api/gemini`（`Authorization` ヘッダーなし・同一 `Origin` 指定）が HTTP `401` で拒否されること（本番 JWT 認証ゲートの稼働証明）。

### 実行コマンド

```powershell
# 本番環境の確認
node scripts/post-deploy-smoke.mjs --target=personal --url=https://<本番Pagesドメイン>

# 公開デモ環境の確認
node scripts/post-deploy-smoke.mjs --target=demo --url=https://<デモPagesドメイン>
```

## 3. 異常検出時の行動原則
- `verify` または `deploy` ジョブが失敗した場合は `gh run view <RUN_ID> --repo <OWNER/REPO> --log-failed` で原因を特定する。
- Cloudflare / Supabase 側の Secrets・環境変数未設定など人の操作が必要な要因であれば、仕様書には書かず Private リポジトリ（`origin`）の GitHub Issue に記録してユーザーへ報告する。
