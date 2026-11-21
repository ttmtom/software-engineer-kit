# AGENTS.md — software-engineer-kit

## Project Purpose

An **OpenCode V2 plugin** that orchestrates multi-stage software engineering workflows with AI agents. It separates standalone skill prompts (`skills/`) from workflow state, tools, hooks, and commands (`src/`), and injects domain/language overlays from hierarchical profiles at appropriate stages.

---

## Dev Commands

```bash
npm run typecheck   # tsc --noEmit — run after every source change
npm test            # node --experimental-strip-types --test test/**/*.test.ts
```

Always run `typecheck` before considering a change complete. There is no build step; OpenCode consumes TypeScript source directly via ESM with runtime type stripping.

---

## Core Invariants & Quick Facts

- **TypeScript ESM only** — all local imports use `.ts` extensions, no CommonJS.
- **State is session-scoped** — `WorkflowState` is stored via `ctx.storage` keyed by `software-engineer-kit/workflow/<sessionID>`.
- **Skills are loaded from `skills/<name>/SKILL.md`** — subdirectories of `skills/` (excluding `profiles/`) are bundled; each must contain a `SKILL.md`.
- **Profile files drive overlays** — hierarchical Markdown files under `skills/profiles/` with `## Architecture`, `## Implement`, `## Test`, and `## Review` sections.
- **Gate enforcement is in the hook** — `checkToolAllowedDuringGate` in `src/hooks/index.ts` is the single source of truth for which tools are blocked during approval (`status === "awaiting_approval"`).

---

## Stages & Pipelines

`Stage` = `research | architecture | plan | implement | test | review`

- **feature** *(default)*: research → architecture → plan → implement → test → review
- **bugfix**: research → plan → implement → test → review
- **quick**: research → implement → test

Commands: `/swe-feature`, `/swe-bugfix`, `/swe-quick`, `/swe-reviewer [commit-id]`.

---

## Testing

Tests live in `test/kit.test.ts` using the **Node.js built-in test runner** (`node:test`).
