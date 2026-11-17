---
name: ai-orchestrator-pipeline
description: 検証・明示ステージングコミット・Ruleset準拠Fast-Forward Push・Cloudflare Pages CD・並列サブエージェント Worktree 分担を scripts/orchestrate-pipeline.mjs で統合実行する。機能追加・UI改善・バグ修正の出荷時に使う。
---

# ai-orchestrator-pipeline

目的: 実装後の段階的検証から原子的コミット・出荷までを `scripts/orchestrate-pipeline.mjs` で安全に一括実行する。

## 1. サブエージェント編成と並列 Worktree 隔離規約
- **調査・影響範囲分析**（`legacy_vba/` の臨床計算照合、参照箇所の網羅調査） → `research` サブエージェントへ委譲し、親のコンテキスト肥大化を防ぐ。
- **並列実装時の Worktree 分離**:
  - 同一ワーキングツリー（`Workspace: "share"`）で複数の編集系サブエージェントを同時実行する場合、親エージェントが重複しない対象ファイル境界と対応 `SPEC_*.md` を厳密に割り当てる（同一ファイルの同時編集は厳禁）。
  - ビルドやテストを伴う独立タスクを並列化する場合は、`git worktree add .agents/scratch/worktrees/<task-name> -b <branch>` で物理ディレクトリを分離して競合を根絶する（`.githooks/` は `core.hooksPath` により全 Worktree で自動有効化される）。
- **出荷前 Read-Only 監査サブエージェント**:
  - 大規模変更の出荷前には、編集権限を使わない監査役（仕様整合・セキュリティ境界・`visual-design-test` 画像検査）を分離して客観レビューを行う。
- **コミット・Push 統括**: サブエージェントは原則として `git push` や本番 DB 変更を行わず、親エージェントが最終検証と出荷を統括する。

## 2. 検査の4段階と Verify Stamp

| 段階 | タイミング | 仕組み | 実行内容 |
| :--- | :--- | :--- | :--- |
| 1 | AIのターン終了時 | `.agents/hooks/stop-guard.mjs` (`Stop` Hook) | 未コミット変更または当ターン内のコミットがある場合、`npm run test:docs` を自動実行 |
| 2 | `git commit` 時 | `.githooks/pre-commit` | Staged Index Blob モードの `verify-docs-sync.mjs --staged` ＋ Partial Staging 遮断 ＋ `typecheck` ＋ `npm test`（純粋 `docs(spec)` コミット時は高速スキップ） |
| 2' | 実装中の中間確認 | `npm run pipeline:verify:quick` | `test:docs` (Strict) + 4プロジェクト並列 `typecheck` + `npm test` (`src` + `scripts`) + 8並列 `test:smoke` |
| 3 | 出荷・UI変更前 | `npm run pipeline:verify` / `pipeline:ship:*` | 上記 ＋ `audit:prod` ＋ 分離ビルド (`dist-portfolio` & `dist-personal`) ＋ 2プロジェクト隔離 Playwright E2E (`E2E-1`〜`E2E-14`) ＋ 11画面撮影監査 (`test:visual`) |
| 4 | `git push` / CD完了後 | `.githooks/pre-push` + `post-deploy-verify` | `main` への Force Push 遮断・未検証 Push 防止、および CD 完了後の `scripts/post-deploy-smoke.mjs` 疎通確認 |

- **Strict Verify Stamp (`.agents/scratch/verify-stamp.json`)**: `npm run pipeline:verify` 成功時に一時 `GIT_INDEX_FILE` から算出した Working Tree 全体の決定論的ツリー SHA・`HEAD`・環境変数ハッシュを記録する。15分以内にファイル変更なしで `pipeline:ship:*` を実行した場合、重複する再ビルド・Playwright 再実行を安全に省略する。

## 3. コマンドと明示的ステージング原則 (`git add -A` 廃止)

### 中間確認 (軽量高速ループ)
```powershell
npm run pipeline:verify:quick
```

### 総合検証・画面撮影のみ
```powershell
npm run pipeline:verify
```
UIを変更した場合は、完了後に `.agents/scratch/screenshots/` の対象 PNG と `visual-audit-report.json` を `visual-design-test` スキルで確認する。

### 出荷: 個人本番 (`origin` `main` -> GitHub Actions CD)
`pipeline:ship:*` は無差別な `git add -A` を一切行わない。未ステージ変更や未追跡ファイルが残っていると `PHASE-0-GUARD` で即座に中断するため、**必ず対象ファイルを明示的に `git add` してから実行する**。

```powershell
# 1. 第1コミット: 仕様先行の記録 (純粋ドキュメントのみ・高速 pre-commit)
git add docs/Web_Project/SPEC_XXX.md
git commit -m "docs(spec): 仕様変更内容の要約"

# 2. 第2コミット & 出荷: 実装ファイルを明示的に git add して総合検証・コミット・Push
git add src/... supabase/... tests/...
npm run pipeline:ship:personal -- --message "feat(personal): 実装内容の要約"
```

### 出荷: 公開デモ (`public-demo` Ruleset `27410303` 準拠・ブランチ切替ゼロ Fast-Forward 昇格)
ローカルのワーキングツリーは `main` のまま一切切り替えず（`legacy_vba/` 等のローカル参照資産を保護）、`scripts/rebuild-demo-branch.mjs` が一時インデックス（`GIT_INDEX_FILE`）と `git commit-tree -p refs/heads/demo-public` でクリーンな Fast-Forward 子コミットを生成する。

```powershell
# main ブランチがクリーン（または明示 git add 済み）の状態でそのまま実行
npm run pipeline:ship:demo -- --message "feat(demo): 公開デモ更新内容の要約"
```

`pipeline:ship:demo` の自動実行フロー:
1. 全品質ゲート（`dist-portfolio` + `dist-personal` 分離ビルド & 2プロジェクト E2E）を通過。
2. `rebuild-demo-branch.mjs` が非公開ディレクトリ除外・UTF-8 BOM 検査・ローカルパス/内部 Issue 番号スキャンを実行し、`refs/heads/demo-public` 上に Fast-Forward 子コミットを生成。
3. `public-demo` のステージングブランチ `refs/heads/release/demo` へ Push し、`gh run watch --exit-status` で Ruleset `27410303` の必須ステータスチェック（`"Verify Quality Gates (DDD / Types / Vitest / Smoke / Playwright E2E)"`）通過を待機。
4. CI 通過済みコミット SHA を `public-demo` の `refs/heads/main` へ Fast-Forward Push（Force Push ゼロ）し、`release/demo` を削除の上、`origin` の `demo-public` バックアップも更新。

## 4. ブランチ構成

| ブランチ | リモート / 出力バンドル | 用途と保護制約 |
| :--- | :--- | :--- |
| `main` | Private: `origin/main` (`dist-personal`) | 日常開発・個人本番運用。GitHub Actions `verify` が本番バンドルを検証・アーティファクト化し、`deploy` ジョブが Cloudflare Pages へ反映 |
| `demo-public` | Public: `public-demo/main` (`dist-portfolio`) | 公開ポートフォリオ用クリーン履歴ブランチ。`main` チェックアウトのまま `rebuild-demo-branch.mjs` で Fast-Forward 更新し、`release/demo` CI 通過後に `public-demo/main` へ昇格 |
| `feature/*`, `fix/*`, `docs/*`, `refactor/*` | Private: `origin/<branch>` | 並行開発・PR用トピックブランチ。`main` 統合時は Squash せず `docs(spec)` → `feat`/`fix` の2段階履歴を保持する |

## 5. 人の手が必要な項目の Issue 記録手順
- 作成先: `origin` (`inzm/cgm-diabates-manager-web`, Private) のみ（`public-demo` への作成および仕様書への内部 `Issue #XX`・未決タグ記載は厳禁）。
- 本文ファイルは `.agents/scratch/` に作成し、秘密情報・実測データ・個人情報を一切含めない。
```powershell
gh issue list --repo inzm/cgm-diabates-manager-web --state open --search "<キーワード>"
gh issue create --repo inzm/cgm-diabates-manager-web --title "[要対応] <要約>" --label "human-action,question" --body-file .agents/scratch/issue_human_action.md
```
