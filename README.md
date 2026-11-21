# software-engineer-kit

An **OpenCode V2** server plugin and master **`swe-agent`** that separates **standalone skills** (`skills/`) from **workflow orchestration, state, tools, and hooks** (`src/`), with shared domain & language overlays inherited across stages and strict read-only/write stage separation.

## Master `swe-agent` & Setup

Select **`swe-agent`** in OpenCode (or set it as your default agent) and converse naturally to orchestrate engineering tasks.

To install `swe-agent` and configure the plugin globally (`~/.config/opencode/`):

```bash
npm run setup
```

Options:
- `--project [dir]` — install into a specific project directory (`.opencode/` + `opencode.jsonc`).
- `--default-agent` — automatically set `swe-agent` as OpenCode's default agent.
- `--pipeline <feature|bugfix|quick>` — set default pipeline.
- `--uninstall` — remove agent definition and plugin configuration.

## Commands

Four commands are also available as shortcuts:

- **`/swe-feature [--profiles ...] <task>`** (`feature`, default): `research -> architecture -> plan -> implement -> test -> review`
- **`/swe-bugfix [--profiles ...] <task>`** (`bugfix`): `research -> plan -> implement -> test -> review`
- **`/swe-quick [--profiles ...] <task>`** (`quick`): `research -> implement -> test`
- **`/swe-reviewer [commit-id] [--profiles ...] [focus]`** (`review`): code review for a commit/range or uncommitted changes with active domain/language review overlays

## Stages, Access Rules, Skills & Tools

| Stage | Access | Default Skill ID | Primary Artifact / Action Tool |
| --- | --- | --- | --- |
| Orchestrator | — | `swe-orchestrator` | `swe_workflow_get`, `swe_workflow_set`, `swe_workflow_approve` |
| Research | **Readonly** | `swe-researcher` | `swe_research_save` |
| Architecture | **Readonly** | `swe-architect` | `swe_architecture_save` |
| Plan | **Readonly** | `swe-planner` | `swe_workflow_set` |
| Implement | **Write** | `swe-implementer` | *(File edits / tracked via hook)* |
| Test | **Write** | `swe-tester` | `swe_verify`, `swe_test_record` |
| Review | **Readonly** | `swe-reviewer` | `swe_review_record` |

- **Read-only vs Write**: File modification tools (`edit`, `write`, `patch`) are strictly blocked during `research`, `architecture`, `plan`, and `review` stages.
- **Confirmation Gates**: Entering `implement` or `test` pauses at `awaiting_approval`. Present the plan, wait for user confirmation, and call `swe_workflow_approve` before executing writes.

## Shared Domain & Language Overlays (`skills/profiles/`)

Profiles support **hierarchical path inheritance** (`domain/framework/language`):

- `backend.md`
  - `backend/golang`
  - `backend/typescript`
- `frontend.md`
  - `frontend/typescript`
  - `frontend/react`
  - `frontend/react/typescript`
- `sql.md`
- `devops.md`

## Configuration (`opencode.jsonc`)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "software-engineer-kit",
      "options": {
        "agentId": "swe-agent",
        "autoStartOnAgentPrompt": true,
        "scopeToAgent": true,
        "defaultPipeline": "feature",
        "confirmBefore": ["implement", "test"],
        "stageAccess": {
          "research": "readonly",
          "architecture": "readonly",
          "plan": "readonly",
          "implement": "write",
          "test": "write",
          "review": "readonly"
        },
        "registerBundledSkills": true,
        "autoInjectContext": true,
        "trackFileEdits": true,
        "autoDetectProfiles": true
      }
    }
  ]
}
```

## Development

```bash
npm install
npm run typecheck
npm test
```
