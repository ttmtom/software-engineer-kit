# AGENTS.md — software-engineer-kit

## Project Purpose

An **OpenCode V2 plugin and master `swe-agent`** that orchestrates multi-stage software engineering workflows. It separates standalone skill prompts (`skills/`) from workflow state, tools, hooks, and commands (`src/`), injects domain/language overlays from hierarchical profiles at appropriate stages, and strictly enforces read-only vs. write stage access.

---

## Dev Commands

```bash
npm run setup       # Run setup script (global install by default)
npm run typecheck   # tsc --noEmit — run after every source change
npm test            # node --experimental-strip-types --test test/**/*.test.ts
```

Always run `typecheck` before considering a change complete. There is no build step; OpenCode consumes TypeScript source directly via ESM with runtime type stripping.

---

## Core Invariants & Quick Facts

- **TypeScript ESM only** — all local imports use `.ts` extensions, no CommonJS.
- **State is session-scoped** — `WorkflowState` is stored via `ctx.storage` keyed by `software-engineer-kit/workflow/<sessionID>`.
- **Master Agent** — `swe-agent` (`agents/swe-agent.md`) acts as the primary conversational orchestrator.
- **Stage Access Enforcement** — `research`, `architecture`, `plan`, and `review` are strictly `readonly` (file mutation tools blocked). `implement` and `test` are `write` stages.
- **Gate Enforcement** — `checkToolAllowedDuringGate` and `checkToolAllowedForStage` in `src/hooks/index.ts` enforce approval gates (`status === "awaiting_approval"`) before write stages.
- **Setup script** — `scripts/setup.ts` (`npm run setup`) installs `swe-agent.md` and updates `opencode.jsonc`.

---

## Stages & Pipelines

`Stage` = `research | architecture | plan | implement | test | review`

- **feature** *(default)*: research (readonly) → architecture (readonly) → plan (readonly) → implement (write) → test (write) → review (readonly)
- **bugfix**: research (readonly) → plan (readonly) → implement (write) → test (write) → review (readonly)
- **quick**: research (readonly) → implement (write) → test (write)

Commands: `/swe-feature`, `/swe-bugfix`, `/swe-quick`, `/swe-reviewer [commit-id]`.

---

## Testing

Tests live in `test/kit.test.ts` using the **Node.js built-in test runner** (`node:test`).
