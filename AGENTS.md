# AGENTS.md (Entrypoint Pointer)

本プロジェクトの開発規約・ドキュメント駆動開発（DDD）原則・4軸評価基準・完了条件の単一真実源（SSOT）は [`.agents/AGENTS.md`](.agents/AGENTS.md) および領域別条件付きルール（`.agents/rules/`）に集約されています。

- 常時適用コアルール (SSOT): [`.agents/AGENTS.md`](.agents/AGENTS.md)
- 領域別条件付きルール (`trigger: model_decision`):
  - DB・RLS・Local-First 同期: [`.agents/rules/db-rls.md`](.agents/rules/db-rls.md)
  - BFF・秘密情報・バンドル分離: [`.agents/rules/bff-gemini.md`](.agents/rules/bff-gemini.md)
  - 24文字ウォールクロック日時: [`.agents/rules/wallclock-date.md`](.agents/rules/wallclock-date.md)
- Web版 システム仕様書索引 (SSOT): [`docs/Web_Project/README.md`](docs/Web_Project/README.md)
- 専門スキル定義:
  - [`.agents/skills/spec-sync-and-review/SKILL.md`](.agents/skills/spec-sync-and-review/SKILL.md)
  - [`.agents/skills/ai-orchestrator-pipeline/SKILL.md`](.agents/skills/ai-orchestrator-pipeline/SKILL.md)
  - [`.agents/skills/visual-design-test/SKILL.md`](.agents/skills/visual-design-test/SKILL.md)
  - [`.agents/skills/post-deploy-verify/SKILL.md`](.agents/skills/post-deploy-verify/SKILL.md)
  - [`.agents/skills/supabase-drift-audit/SKILL.md`](.agents/skills/supabase-drift-audit/SKILL.md)
