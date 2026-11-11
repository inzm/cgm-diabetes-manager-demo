---
name: ai-orchestrator-pipeline
description: >-
  コード修正、仕様書（docs/Web_Project/*.md）の同期更新、Playwrightスクリーンショットによるマルチモーダルデザインテスト、品質ゲート検証、Gitコミット・Push、およびCloudflare Pagesへのデプロイまでを、サブエージェント協調と自動パイプラインスクリプト（orchestrate-pipeline.mjs）でノンストップ実行するオーケストレーションスキル。機能追加・UI改善・バグ修正からデプロイまでを一気通貫で行う際に使用する。
---

# AIオーケストレーション & ノンストップ自動デプロイスキル (`ai-orchestrator-pipeline`)

このスキルは、本リポジトリにおける開発タスク（コード修正・デザイン検証・仕様書更新・Git Push・Cloudflare Pages デプロイ）を、**マルチエージェント協調（Subagent Orchestration）** と **一気通貫パイプラインスクリプト（[`scripts/orchestrate-pipeline.mjs`](../../scripts/orchestrate-pipeline.mjs)）** によって最高速度かつ無欠陥で完遂するための標準オーケストレーション手順です。

---

## 1. オーケストレーション全体アーキテクチャ

親エージェント（Orchestrator）は、タスクの規模と性質に応じて以下の4つの専門ロール（サブエージェントまたはフェーズ）を統括します：

```text
[User Request]
      │
      ▼
[Orchestrator Agent (親エージェント)]
  ├─► 1. Spec & Architecture Role
  │      ・4軸自律評価（セキュリティ・拡張性・保守性・ユーザビリティ）
  │      ・docs/Web_Project/SPEC_*.md の先行・同時更新
  │
  ├─► 2. Frontend & Domain Logic Role
  │      ・React / Tailwind / ECharts / Dexie / Worker の仕様準拠実装
  │      ・単体・統合テスト (src/lib/__tests__/) の追加・更新
  │
  ├─► 3. Visual QA & E2E Role (visual-design-test スキル連携)
  │      ・Playwright E2E回帰テスト & 11画面スクリーンショット自動撮影
  │      ・read_file による PNG スクリーンショットのマルチモーダル視覚検査
  │
  └─► 4. Release & Deploy Role (orchestrate-pipeline.mjs --ship)
         ・全品質ゲート通過確認 → git add/commit → git push → Cloudflare Pages デプロイ
```

---

## 2. サブエージェントの並列・分担起動パターン (`define_subagent` / `invoke_subagent`)

複数画面にまたがる改修や、独立した調査・テスト作成を並行して行う場合は、`invoke_subagent` を活用します：

1. **調査・影響範囲分析の委譲 (`TypeName: "research"`)**:
   - 旧VBAコード（`legacy_vba/`）の計算ロジック照合や、複数コンポーネント間のProps・DB参照箇所の網羅調査は `research` サブエージェントへ委譲し、親エージェントのコンテキストをクリーンに保つ。
2. **実装・検証サブエージェントの起動 (`TypeName: "self"` またはカスタム定義)**:
   - 独立した機能実装やテスト追加を行う際は、対象ファイルスコープと対応する `docs/Web_Project/SPEC_*.md` を明示してサブエージェントを起動する。
   - **重要**: 同一ファイルを複数エージェントが同時に書き換えないよう、親エージェントがファイル境界を割り当てること。

---

## 3. ノンストップ一気通貫パイプラインの実行コマンド

実装と仕様書更新が完了したら、個別のコマンドをバラバラに叩く代わりに、以下の統合パイプラインコマンドを使用します：

### A. 品質検証 + E2E + スクリーンショット撮影までを一括実行する場合
```powershell
npm run pipeline:verify
```
このコマンド1つで以下が順番に自動実行されます：
1. `npm run test:docs`: 仕様書同期・セキュリティ・ハリボテ排除・開発者用語ゼロ検証
2. `npm run typecheck`: TypeScript 厳格型検査
3. `npm test`: Vitest 臨床計算・データ整合性単体テスト
4. `npm run build:portfolio`: ポートフォリオ本番バンドルビルド
5. `npm run test:e2e:regression`: Playwright E2E回帰テスト（E2E-1〜E2E-9）
6. `npm run test:visual`: デスクトップ＆モバイル全11画面のスクリーンショット撮影＆DOMレイアウト監査

実行後、親エージェント（または Visual QA サブエージェント）は `.agents/scratch/screenshots/` 内の対象スクリーンショットを `read_file` で視覚確認します。

### B. 検証から Git Commit / Push / Cloudflare Pages デプロイまでノンストップで完遂する場合

#### 1. 本番アプリ（Private リポジトリ `origin` ＋ `cgm-diabetes-manager-personal`）へ出荷する場合
```powershell
npm run pipeline:ship:personal -- --message "feat(personal): 変更内容の要約"
```

#### 2. デモ公開アプリ（Public リポジトリ `public-demo` ＋ `cgm-diabetes-manager-demo`）へ出荷する場合
本番（`main`）で開発した共通UI改善・デザイン修正をデモ環境にも反映する場合は、`demo-public` ブランチへ `git cherry-pick <commit-sha>` で取り込んだ上で以下を実行します：
```powershell
git checkout demo-public
git cherry-pick <commit-sha>
npm run pipeline:ship:demo -- --message "feat(demo): 変更内容の要約"
git checkout main
```

- **Phase 1〜5（全テスト＆スクリーンショット監査）が100% PASS した場合のみ**、自動的に Phase 6（`git add -A` → `git commit` → `git push` → Cloudflare Pages デプロイ）へ進みます。
- `--target=demo` 実行時は、`demo-public` ブランチ以外からの実行や `legacy_vba/` の混入を機械的にブロックするセキュリティガード（`PHASE-0-GUARD`）が作動します。
- 途中で1つでもテストや仕様書同期エラーが発生した場合は即座に中断（Abort）され、不完全なコードが Push・デプロイされることを100%防ぎます。
- 実行結果のサマリーは `.agents/scratch/pipeline-last-run.json` に自動保存されます。

