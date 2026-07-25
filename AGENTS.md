# Deep-Mix Repository Rules

`AGENTS.md` in this repository is only for long-lived repository rules. It is not a place for reusable workflows, one-off task scripts, or external tool instructions.

## Boundary Contract

- `AGENTS.md`: repository rules, safety constraints, verification commands, and collaboration conventions only.
- `Skills`: reusable knowledge and process guidance loaded from `/.deep-mix/skills` or `/.agents/skills`.
- `Workflows`: deterministic multi-step orchestration loaded from `/.deep-mix/workflows`.
- `MCP`: external systems and real-time tools configured under `/.deep-mix/mcp`.
- `Workers`: model-specialized roles that return structured artifacts; they do not replace the governor.

## Runtime Rules

- `DeepSeek` remains the only governor and supervisor.
- `GLM-5.2` and `Kimi` stay isolated workers and do not write workspace files directly.
- Final file writes, shell commands, tests, git actions, and MCP calls must go through `Tool Runtime + Permission Layer`.
- New reusable process guidance belongs in a `SKILL.md`, not in this file.
- New deterministic orchestration belongs in a workflow file, not in this file.

## Verification Commands

- TypeScript check: `npm run check`
- Fast release tests: `npm run test`
- Full tests: `npm run test:full`
- Phase 6 tests: `npm run verify:phase6`

## Protected Paths

- Never edit `.deep-mix/api-key-library/` through normal runtime write tools.
- Worker artifacts, worker sessions, and checkpoints stay under `.deep-mix/` state directories.
