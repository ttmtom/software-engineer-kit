# software-engineer-kit

An **OpenCode V2** server plugin that separates **standalone skills** (`skills/`) from **workflow orchestration, state, tools, and hooks** (`src/`), with shared domain & language overlays inherited across stages.

## Stages & Skills

| Stage | Default Skill ID | Command | Primary Artifact Tool |
| --- | --- | --- | --- |
| Orchestrator | `kit-orchestrator` | `/kit-orchestrate`, `/kit-approve` | `kit_workflow_get`, `kit_workflow_set`, `kit_workflow_approve` |
| Research | `kit-researcher` | `/kit-research` | `kit_research_save` |
| Architecture | `kit-architect` | `/kit-architect` | `kit_architecture_save` |
| Plan | `kit-planner` | `/kit-plan` | `kit_workflow_set` |
| Implement | `kit-implementer` | `/kit-implement` | *(tracked via `tool.hook("execute.after")`)* |
| Test | `kit-tester` | `/kit-test` | `kit_verify`, `kit_test_record` |
| Review | `kit-reviewer` | `/kit-review` | `kit_review_record` |

## Built-in Pipelines

- **`feature` (default):** `research -> architecture -> plan -> implement -> test -> review`
- **`bugfix`:** `research -> plan -> implement -> test -> review`
- **`quick`:** `research -> implement -> test`

## Shared Domain & Language Overlays (`skills/profiles/`)

Profiles support **hierarchical path inheritance** (`domain/framework/language`):

- `backend.md`
  - `backend/golang` (`skills/profiles/backend/golang.md`)
  - `backend/typescript` (`skills/profiles/backend/typescript.md`)
- `frontend.md`
  - `frontend/typescript` (`skills/profiles/frontend/typescript.md`)
  - `frontend/react` (`skills/profiles/frontend/react.md`)
  - `frontend/react/typescript` (`skills/profiles/frontend/react/typescript.md`)
- `sql.md`
- `devops.md`

Selecting `frontend/react/typescript` automatically inherits `frontend` -> `frontend/react` -> `frontend/react/typescript`, and selecting `backend/golang` automatically inherits `backend` -> `backend/golang`, with stage-specific sections injected for `architecture`, `implement`, `test`, and `review`.

## Configuration (`opencode.jsonc`)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "software-engineer-kit",
      "options": {
        "defaultPipeline": "feature",
        "confirmBefore": ["start", "implement"],
        "registerBundledSkills": true,
        "overrideExistingSkills": false,
        "autoInjectContext": true,
        "trackFileEdits": true,
        "autoDetectProfiles": true,
        "skills": {
          "research": "kit-researcher"
        },
        "profiles": {
          "rust": {
            "implement": "- Prefer Result<T, E> and avoid unwrap() in production code.",
            "test": "- Run cargo test and cargo clippy."
          }
        }
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
