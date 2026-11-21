# software-engineer-kit

An **OpenCode V2** server plugin that separates **standalone skills** (`skills/`) from **workflow orchestration, state, tools, and hooks** (`src/`), with shared domain & language overlays inherited across stages.

## Commands

Four commands are exposed in OpenCode:

- **`/swe-feature [--profiles ...] <task>`** (`feature`, default): `research -> architecture -> plan -> implement -> test -> review`
- **`/swe-bugfix [--profiles ...] <task>`** (`bugfix`): `research -> plan -> implement -> test -> review`
- **`/swe-quick [--profiles ...] <task>`** (`quick`): `research -> implement -> test`
- **`/swe-reviewer [commit-id] [--profiles ...] [focus]`** (`review`): code review for a commit/range or uncommitted changes (defaults to uncommitted) with active domain/language review overlays

## Stages, Skills & Tools

| Stage | Default Skill ID | Primary Artifact Tool |
| --- | --- | --- |
| Orchestrator | `swe-orchestrator` | `swe_workflow_get`, `swe_workflow_set`, `swe_workflow_approve` |
| Research | `swe-researcher` | `swe_research_save` |
| Architecture | `swe-architect` | `swe_architecture_save` |
| Plan | `swe-planner` | `swe_workflow_set` |
| Implement | `swe-implementer` | *(tracked via `tool.hook("execute.after")`)* |
| Test | `swe-tester` | `swe_verify`, `swe_test_record` |
| Review | `swe-reviewer` | `swe_review_record` |

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
          "research": "swe-researcher"
        },
        "profiles": {
          "backend/rust": {
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
