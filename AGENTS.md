# AGENTS.md — software-engineer-kit

## Project Purpose

An **OpenCode V2 plugin** that orchestrates multi-stage software engineering workflows with AI agents. It separates standalone skill prompts (`skills/`) from workflow state, tools, hooks, and commands (`src/`), and injects domain/language overlays from hierarchical profiles at the appropriate stages.

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
  index.ts              # Plugin entry point — wires skills, tools, commands, hooks
  types.ts              # Shared type aliases derived from @opencode/plugin
  options.ts            # KitOptions parser (parseOptions)
  commands/index.ts     # All /kit-* command registrations
  tools/index.ts        # All kit_* tool registrations (namespace: "kit")
  hooks/index.ts        # session.context, session.prompt, tool.execute.* hooks
  workflows/
    pipelines.ts        # Stage type, pipeline definitions, getNextStage
    state.ts            # WorkflowState CRUD, gate helpers, renderWorkflowContext
  skills/
    loader.ts           # loadBundledSkills, parseSkillMarkdown, registerBundledSkillsInEditor
    profiles.ts         # loadProfileRegistry, detectProfiles, expandProfileChain, renderStageOverlays

skills/
  kit-orchestrator/SKILL.md
  kit-researcher/SKILL.md
  kit-architect/SKILL.md
  kit-planner/SKILL.md
  kit-implementer/SKILL.md
  kit-tester/SKILL.md
  kit-reviewer/SKILL.md
  profiles/             # Hierarchical Markdown overlays:
                        #   backend.md, backend/golang.md, backend/typescript.md
                        #   frontend.md, frontend/typescript.md, frontend/react.md, frontend/react/typescript.md
                        #   sql.md, devops.md

test/
  kit.test.ts           # Node built-in test runner
```

---

## Core Concepts

### Stages & Pipelines

`Stage` = `research | architecture | plan | implement | test | review`

Built-in pipelines (defined in `src/workflows/pipelines.ts`):

| Pipeline | Stages |
|---|---|
| `feature` *(default)* | research → architecture → plan → implement → test → review |
| `bugfix` | research → plan → implement → test → review |
| `quick` | research → implement → test |

### Commands

| Command | Handler | Purpose |
|---|---|---|
| `/kit-orchestrate` | `registerCommands` | Start a pipeline; supports `--mode` and `--profiles` |
| `/kit-approve` | `registerCommands` | Approve the pending confirmation gate and continue |
| `/kit-research` | `registerCommands` | Enter research stage |
| `/kit-architect` | `registerCommands` | Enter architecture stage |
| `/kit-plan` | `registerCommands` | Enter plan stage |
| `/kit-implement` | `registerCommands` | Enter implement stage (parses leading/inline profiles) |
| `/kit-test` | `registerCommands` | Enter test stage |
| `/kit-review` | `registerCommands` | Enter review stage |

### Tools (registered in `src/tools/index.ts`, namespace `kit`)

- `kit_workflow_get` / `kit_workflow_set` — read, initialize, update, advance, or reset workflow state (including `tasks` with optional per-task `profiles` and `acceptanceCriteria`)
- `kit_workflow_approve` — unlock a pending gate after the user has responded
- `kit_research_save` — save `ResearchRecord`
- `kit_architecture_save` — save `ArchitectureRecord`
- `kit_verify` — execute verification commands in the workspace (guarded by `ctx.permission.assert` and `context.signal`)
- `kit_test_record` — save `TestRecord`
- `kit_review_record` — save `ReviewRecord`

### Hooks (`src/hooks/index.ts`)

| Hook | Behaviour |
|---|---|
| `session.context` | Injects `renderWorkflowContext(...)` into `event.system` when `autoInjectContext: true` |
| `session.prompt` | Calls `markGateUserResponded` on incoming user prompts |
| `tool.execute.before` | Blocks mutating/stage tools (`edit`, `write`, `patch`, `apply_patch`, `kit_verify`, `kit_*_save`, `kit_*_record`) while `status === "awaiting_approval"` |
| `tool.execute.after` | Calls `markGateUserResponded` when `question` completes; tracks edited file paths into `WorkflowState.touchedFiles` when `trackFileEdits: true` |

### Confirmation Gates

When `confirmBefore` includes `"start"` or a stage name (or `"all"` / `"none"`), entering that gate sets `status: "awaiting_approval"` with a `pendingGate`. Mutating and stage-artifact tools stay blocked until:

1. The user runs `/kit-approve`, **or**
2. The user responds in chat (`session.prompt`) or answers a `question` tool (`tool.execute.after`) and the agent calls `kit_workflow_approve`.

Direct stage commands (`/kit-research`, `/kit-implement`, etc.) treat direct user invocation as approval for that stage.

Default `confirmBefore`: `["start", "implement"]`

### Profiles & Overlays

Profiles are Markdown files under `skills/profiles/` with `## Architecture`, `## Implement`, `## Test`, and `## Review` sections. Resolution is hierarchical and deduplicated (`expandProfileChain`) — selecting `frontend/react/typescript` inherits `frontend` → `frontend/react` → `frontend/react/typescript`.

**Auto-detection** (`autoDetectProfiles: true`) inspects `go.mod`, `tsconfig.json`, `package.json`, `migrations/`, `Dockerfile`, file extensions, and prompt keywords to select matching profiles.

**Aliases** (defined in `src/skills/profiles.ts`):
- `SEGMENT_ALIASES`: `go` → `golang`, `ts` → `typescript`, `fe` → `frontend`, `be` → `backend`
- `SHORTHAND_ALIASES`: `go`/`golang` → `backend/golang`, `react` → `frontend/react`, `react-ts` → `frontend/react/typescript`, `be`/`api` → `backend`, `fe`/`ui` → `frontend`, `db`/`postgres` → `sql`, `docker`/`k8s`/`infra` → `devops`

---

## Key Invariants

- **TypeScript ESM only** — all local imports use `.ts` extensions, no CommonJS.
- **No build step** — `exports` points at `./src/index.ts`; OpenCode strips types at runtime.
- **State is session-scoped** — `WorkflowState` is stored via `ctx.storage` keyed by `software-engineer-kit/workflow/<sessionID>`.
- **Skills are loaded from `skills/<name>/SKILL.md`** — subdirectories of `skills/` (excluding `profiles/`) are bundled; each must contain a `SKILL.md`.
- **Profile files drive overlays** — adding a new profile only requires adding `skills/profiles/<path>.md` with `## <Stage>` sections (or configuring `options.profiles` in `opencode.jsonc`).
- **Gate enforcement is in the hook** — `checkToolAllowedDuringGate` in `src/hooks/index.ts` is the single source of truth for which tools are blocked during approval.

---

## Adding a New Stage Skill

1. Create `skills/<skill-id>/SKILL.md` with YAML frontmatter (`name:`, optional `description:`).
2. Add the stage to `Stage`, `ALL_STAGES`, and `DEFAULT_STAGE_SKILLS` in `src/workflows/pipelines.ts` (plus `parseConfirmBefore` `"all"` in `src/options.ts` if applicable).
3. Register a command in `src/commands/index.ts` using the `stageCommands` array pattern.
4. If it needs profile overlays injected, add the stage name to `OVERLAY_STAGES` / `OverlayStage` in `src/workflows/pipelines.ts` and `SECTION_MAP` in `src/skills/profiles.ts`.

## Adding a New Profile

1. Create `skills/profiles/<domain>[/<sub>].md`.
2. Add `## Architecture`, `## Implement`, `## Test`, `## Review` sections as needed.
3. Add shorthand/segment aliases or detection rules in `src/skills/profiles.ts` if auto-detection or short names are desired.

---

## Testing

Tests live in `test/kit.test.ts` using the **Node.js built-in test runner** (`node:test`). No Jest or Vitest.

```bash
npm test
```

Add tests for any new parsing logic, state transitions, gate rules, or profile resolution. The test file imports source directly with `--experimental-strip-types`.
