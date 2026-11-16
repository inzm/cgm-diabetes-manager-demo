---
name: ai-orchestrator-pipeline
description: 検証・コミット・Push・Cloudflare Pagesデプロイ・ブランチ運用・サブエージェント分担を、scripts/orchestrate-pipeline.mjs の統合パイプラインで実行する。機能追加・UI改善・バグ修正の出荷時に使う。
---

# ai-orchestrator-pipeline

目的: 実装後の検証から出荷までを `scripts/orchestrate-pipeline.mjs` で一括実行する。

## 役割分担 (親エージェントが統括)
- Spec: 4軸評価、docs/Web_Project/SPEC_*.md の先行・同時更新。
- Frontend/Domain: React / Tailwind / ECharts / Dexie / Worker の実装、src/lib/__tests__/ のテスト追加。
- Visual QA: Playwright E2E回帰と11画面の撮影、PNGの目視確認 (skill: visual-design-test)。
- Release: 全ゲート通過後に git add / commit / push（デプロイは GitHub Actions CD に一本化。緊急時のみ `--local-deploy`）。

## サブエージェント
- 調査・影響範囲分析 (legacy_vba/ の計算照合、Props・DB参照箇所の網羅調査) → TypeName: research に委譲する。親のコンテキストを汚さないため。
- 独立した実装・テスト追加 → TypeName: self またはカスタム定義。対象ファイルのスコープと対応する SPEC_*.md を明示して起動する。
- 禁止: 複数エージェントが同一ファイルを同時に書き換えること。親がファイル境界を割り当てる。
- 禁止: 指定スコープ外のファイルの修正。

## 検査の3段階 (早い段階は軽く、出荷に近づくほど広く深く)

| 段階 | タイミング | 仕組み | 実行内容 |
| :--- | :--- | :--- | :--- |
| 1 | AIの作業終了時 | .agents/hooks/stop-guard.mjs (Stop Hook) | npm run test:docs。そのターンで src/ ・ functions/ ・ supabase/ ・ scripts/ ・ e2e/ ・ .agents/ ・ docs/Web_Project/ を編集していなければ検査しない |
| 2 | git commit 時 | .git/hooks/pre-commit (scripts/install-git-hooks.mjs が npm install 時に設置) | test:docs --staged + typecheck + npm test |
| 2' | 手動の中間確認 | npm run pipeline:verify:quick | test:docs + typecheck + npm test + test:smoke (ビルド・E2E・撮影なし) |
| 3 | 出荷・公開前 | npm run pipeline:verify / pipeline:ship:* | 下記の全フェーズ (E2E回帰・全11画面の撮影とDOM監査を含む) |

- 画面撮影PNGのAIによる目視確認は、UIを変更したときに skill: visual-design-test で行う。毎回は行わない。
- pipeline:ship:* は Phase 3 で npm test を通過済みのため、Phase 6 のコミット時は環境変数 PIPELINE_TESTS_PASSED=1 を渡し、pre-commit の npm test 重複実行を省く (test:docs と typecheck は常に実行)。

## コマンド

### 中間確認 (軽量)
```powershell
npm run pipeline:verify:quick
```
test:docs → typecheck → npm test → test:smoke のみ実行する。--ship とは併用できない。

### 検証のみ (総合)
```powershell
npm run pipeline:verify
```
実行順 (1つでも失敗したら中断):
1. npm run test:docs — 仕様書・図面・DDLの同期、ハリボテ・開発者用語の検出
2. npm run typecheck — TypeScript厳格型検査
3. npm test — Vitest 臨床計算の単体テストと、画面間データ整合性の統合テスト
4. npm run test:smoke — Vite開発サーバー全56エンドポイントが HTTP 200 かつエラーなし
5. npm run build:portfolio — デモ用ビルド
6. npm run test:e2e:regression — Playwright E2E-1〜E2E-14
7. npm run test:visual — デスクトップ・モバイル全11画面の撮影とDOM監査
8. npm run build:personal — 本番用ビルド (target=personal のみ)

実行後、.agents/scratch/screenshots/ の対象PNGを read_file で確認する。

### 出荷: 本番 (Private origin -> GitHub Actions CD -> Cloudflare Pages: cgm-diabetes-manager-personal)
Git 履歴上で「仕様先行」を証明するため、先に `docs(spec)` コミットを記録してから実装・出荷を実行する。
```powershell
# 1. 仕様先行コミット (ユーザー合意後、実装着手の前)
git add docs/Web_Project
git commit -m "docs(spec): 仕様変更内容の要約"

# 2. 実装・テスト完了後、全ゲート検証＋実装コミット＋Push
npm run pipeline:ship:personal -- --message "feat(personal): 実装内容の要約"
```

### 出荷: デモ公開 (Public public-demo -> GitHub Actions CD -> Cloudflare Pages: cgm-diabetes-manager-demo)
main の成果物を履歴ゼロの孤立ブランチとして再生成（または cherry-pick）してから出荷する。
```powershell
# A. 過去履歴ごとクリーン再構築する場合 (旧VBA資産・個人パス完全抹消)
npm run demo:rebuild-branch
git checkout demo-public
npm run pipeline:verify
git push --force public-demo demo-public:main
git push --force origin demo-public
git checkout main

# B. 既存のクリーンな demo-public に2段階の差分コミットを取り込む場合
git checkout demo-public
git cherry-pick <spec-commit-sha> <feat-commit-sha>
npm run pipeline:ship:demo -- --message "feat(demo): 変更内容の要約"
git checkout main
```

### 出荷の挙動
- Phase 1〜5 (全テスト・撮影・監査) が全て成功した場合のみ、Phase 6 (git add -A → commit → push) へ進む。
- Cloudflare Pages へのデプロイは GitHub Actions (`deploy-pages.yml` の `deploy` ジョブ) に一本化されており、ローカルとCIの二重デプロイを起こさない（GitHub Secrets 設定前の緊急時のみ `--local-deploy` フラグで `main` / `demo-public` ブランチからのローカルデプロイを許可）。
- 1つでも失敗したら中断する。不完全なコードは push・デプロイされない。
- --target=demo は PHASE-0-GUARD で、demo-public 以外のブランチからの実行と旧VBA関連資産（legacy_vba/・docs/VBA_Project/・docs/screenshot/・docs/動画作成用資料/）の混入を拒否する。--local-deploy 時は --target=personal でも main ブランチを強制する。
- 結果は .agents/scratch/pipeline-last-run.json に保存される。

## ブランチ

| ブランチ | リモート / デプロイ先 | 用途と制約 |
| :--- | :--- | :--- |
| main | Private: origin/main / cgm-diabetes-manager-personal | 日常の開発・検証・個人本番運用。pipeline:ship:personal で Push し、GitHub Actions CD が `REQUIRE_SUPABASE_ENV=1` 検証の上デプロイ |
| demo-public | Public: public-demo/main / cgm-diabetes-manager-demo | 公開ポートフォリオ専用。`scripts/rebuild-demo-branch.mjs` により過去コミット履歴および旧VBA関連資産（legacy_vba/・docs/VBA_Project/・docs/screenshot/・docs/動画作成用資料/）を完全除外した孤立ブランチ。pipeline:ship:demo で出荷 |
| feature/*, fix/*, docs/*, refactor/* | Private: origin/<branch> | 並行開発・PRレビュー用のトピックブランチ。Push 時に GitHub Actions `verify` ジョブ（CIのみ、デプロイなし）が自動実行される |

## コミット (2段階記録: Spec-First の証明)
- 第1コミット (仕様先行): 仕様書・図面 (`docs/Web_Project/`) を先に更新し、`docs(spec): <仕様変更の要約>` でコミットする（実装コード `src/`・`functions/`・`supabase/` は含めない）。
- 第2コミット (実装・検証): 合意した仕様のとおりに実装コード・型定義・DDL・テストを更新し、`feat(personal): <実装の要約>`（または `fix` / `refactor`）でコミットする（実装中に判明した仕様書の微調整を含めてよい）。
- トピックブランチを `main` へ統合する際は、Squash マージを行わず2コミットの履歴を保持する。
- git commit 時に `.git/hooks/pre-commit` が `npm run test:docs` (`--staged`)、`npm run typecheck`、`npm test` を実行する（第2コミット時は直前の連続する純粋 `docs(spec):` コミットの更新仕様書も Spec-First 同期済みとして自動照合する）。

## 人の手が必要な項目のIssue記録
対象と禁止事項は AGENTS.md の「ルール: 人の手が必要な項目」に従う。

- リポジトリ: origin (inzm/cgm-diabates-manager-web, Private)
- タイトル: `[要対応] <内容を一文で>`
- ラベル: `human-action` と、種別 (`bug` / `enhancement` / `documentation` / `question`) のうち1つ
- 本文の構成:
  1. 背景 (何が見つかったか、関連する仕様書・コミット)
  2. 人が行うこと (チェックボックスで列挙)
  3. 完了条件
  4. 影響 (4軸: セキュリティ / 拡張性 / 保守性 / ユーザビリティ のうち該当するもの)
- 本文ファイルは .agents/scratch/ に作る (Git管理外)。

手順:
1. 重複確認
   ```powershell
   gh issue list --repo inzm/cgm-diabates-manager-web --state open --search "<キーワード>"
   ```
2. 本文ファイルを作成する (例: .agents/scratch/issue_human_action.md)。
3. 作成
   ```powershell
   gh issue create --repo inzm/cgm-diabates-manager-web --title "[要対応] <内容>" --label "human-action,question" --body-file .agents/scratch/issue_human_action.md
   ```
4. 出力されたIssue番号をユーザーへ報告する（仕様書には `【未決事項】` / `【要確認】` タグや内部 Issue 番号を書かず、必須環境要件または確定動作のみを記述する）。
5. 完了したらIssueをクローズする（仕様・実装変更を伴う場合は `docs(spec)` → `feat` / `fix` の2段階記録で反映する）。
