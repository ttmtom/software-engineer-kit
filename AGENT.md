# AGENT.md — software-engineer-kit

## Project Purpose

An **OpenCode V2 plugin** that orchestrates multi-stage software engineering workflows with AI agents. It separates standalone skill prompts (`skills/`) from workflow state, tools, hooks, and commands (`src/`), and injects domain/language overlays from profiles at the appropriate stages.

---

## Dev Commands

```bash
npm run typecheck   # tsc --noEmit — run after every source change
npm test            # node --experimental-strip-types --test test/**/*.test.ts
```

Always run `typecheck` before considering a change complete. There is no build step; the package exports TypeScript source directly (consumed by OpenCode at runtime).

---

## Repository Layout

```
src/
  index.ts              # Plugin entry point — wires tools, commands, hooks
  types.ts              # Shared type aliases (PluginContext, Registration, etc.)
  options.ts            # KitOptions parser (parseOptions)
  commands/index.ts     # All /kit-* command registrations
  tools/index.ts        # All kit_* tool registrations
  hooks/index.ts        # session.context, session.prompt, tool.execute.* hooks
  workflows/
    pipelines.ts        # Stage type, pipeline definitions, getNextStage
    state.ts            # WorkflowState CRUD + renderWorkflowContext
  skills/
    loader.ts           # loadBundledSkills, parseSkillMarkdown
    profiles.ts         # loadProfileRegistry, detectProfiles, renderStageOverlays

skills/
  kit-orchestrator/SKILL.md
  kit-researcher/SKILL.md
  kit-poc/SKILL.md
  kit-architect/SKILL.md
  kit-planner/SKILL.md
  kit-implementer/SKILL.md
  kit-tester/SKILL.md
  kit-reviewer/SKILL.md
  profiles/             # Markdown profile overlays (backend.md, frontend/react.md, …)

test/
  kit.test.ts           # Node built-in test runner
```

---

## Core Concepts

### Stages & Pipeline

`Stage` = `research | poc | architecture | plan | implement | test | review`

Built-in pipelines (defined in `src/workflows/pipelines.ts`):

| Pipeline | Stages |
|---|---|
| `feature` *(default)* | research → architecture → plan → implement → test → review |
| `feature-with-poc` | research → poc → architecture → plan → implement → test → review |
| `poc` | research → poc |
| `bugfix` | research → plan → implement → test → review |
| `quick` | research → implement → test |

### Commands

| Command | Handler | Purpose |
|---|---|---|
| `/kit-orchestrate` | `registerCommands` | Start a full pipeline; supports `--mode` and `--profiles` |
| `/kit-approve` | `registerCommands` | Approve a pending confirmation gate |
| `/kit-research` | `registerCommands` | Enter research stage |
| `/kit-poc` | `registerCommands` | Enter poc stage |
| `/kit-architect` | `registerCommands` | Enter architecture stage |
| `/kit-plan` | `registerCommands` | Enter plan stage |
| `/kit-implement` | `registerCommands` | Enter implement stage (also parses inline profiles) |
| `/kit-test` | `registerCommands` | Enter test stage |
| `/kit-review` | `registerCommands` | Enter review stage |

### Tools (registered in `src/tools/index.ts`)

Kit-specific tools exposed to the AI agent:

- `kit_workflow_get` / `kit_workflow_set` — read/write workflow state
- `kit_workflow_approve` — approve a pending gate programmatically
- `kit_research_save` — save ResearchRecord
- `kit_poc_save` — save PocRecord
- `kit_architecture_save` — save ArchitectureRecord
- `kit_verify` — run verification commands and record results
- `kit_test_record` — save TestRecord
- `kit_review_record` — save ReviewRecord

### Hooks (`src/hooks/index.ts`)

| Hook | Behaviour |
|---|---|
| `session.context` | Injects `renderWorkflowContext(...)` into every system prompt when `autoInjectContext: true` |
| `session.prompt` | Calls `markGateUserResponded` on every user message |
| `tool.execute.before` | Blocks mutating tools (`edit`, `write`, `kit_verify`, …) while `status === "awaiting_approval"` |
| `tool.execute.after` | Tracks touched file paths into `WorkflowState.touchedFiles` when `trackFileEdits: true` |

### Confirmation Gates

When `confirmBefore` includes a stage name (or `"start"`), the workflow enters `status: "awaiting_approval"` and sets a `pendingGate`. The gate blocks all mutating tools until the user approves via `/kit-approve` or the `kit_workflow_approve` tool.

Default `confirmBefore`: `["start", "implement"]`

### Profiles & Overlays

Profiles are Markdown files under `skills/profiles/` with `## Architecture`, `## Implement`, `## Test`, `## Review` sections. The registry is hierarchical — selecting `frontend/react/typescript` automatically inherits `frontend` → `frontend/react` → `frontend/react/typescript`.

**Auto-detection** (`autoDetectProfiles: true`) inspects `go.mod`, `tsconfig.json`, `package.json`, and file extensions to pick matching profiles automatically.

**Shorthand aliases** (defined in `src/skills/profiles.ts`):
`go` → `backend/golang`, `react` → `frontend/react`, `be` → `backend`, `sql` → `sql`, `devops` → `devops`, etc.

---

## Key Invariants

- **TypeScript ESM only** — all imports use `.ts` extensions, no CommonJS.
- **No build step** — `exports` points at `./src/index.ts`; OpenCode strips types at runtime.
- **State is session-scoped** — `WorkflowState` is stored via `ctx.storage` keyed by `sessionID`.
- **Skills are loaded from `skills/<name>/SKILL.md`** — subdirectories of `skills/` (excluding `profiles/`) are bundled; each must contain a `SKILL.md`.
- **Profile files drive overlays** — adding a new profile means adding `skills/profiles/<path>.md` with the appropriate `## Stage` sections; no code changes needed.
- **Gate enforcement is in the hook** — `checkToolAllowedDuringGate` in `src/hooks/index.ts` is the single source of truth for which tools are blocked during approval.

---

## Adding a New Stage Skill

1. Create `skills/<skill-id>/SKILL.md` with YAML frontmatter (`name:`, optional `description:`).
2. Add the stage to `ALL_STAGES` and `DEFAULT_STAGE_SKILLS` in `src/workflows/pipelines.ts` if it is a new stage type.
3. Register a command in `src/commands/index.ts` using the `stageCommands` array pattern.
4. Add the skill ID to `OVERLAY_STAGES` if it needs profile overlays injected.

## Adding a New Profile

1. Create `skills/profiles/<domain>[/<sub>].md`.
2. Add `## Implement`, `## Architecture`, `## Test`, `## Review` sections as needed.
3. Add shorthand aliases to `SHORTHAND_ALIASES` and/or detection logic to `detectProfiles` in `src/skills/profiles.ts` if auto-detection is desired.

---

## Testing

Tests live in `test/kit.test.ts` using the **Node.js built-in test runner** (`node:test`). No Jest or Vitest.

```bash
npm test
```

Add tests for any new parsing logic, state transitions, or profile resolution. The test file imports source directly with `--experimental-strip-types`.
