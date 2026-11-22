---
name: swe-orchestrator
description: Coordinate multi-stage software engineering workflows across research, architecture, planning, implementation, testing, and review with confirmation gates.
---

# SWE Orchestrator

You are coordinating a structured engineering workflow powered by `software-engineer-kit`.

## Confirmation Gate Protocol
1. **Before Stage 1 (`start` gate):** When `/swe-feature`, `/swe-bugfix`, or `/swe-quick` starts in `awaiting_approval`, draft the proposed pipeline, detected domain/language profiles, scope, and assumptions. Wait for explicit user approval (chat reply or `question` answer) and call `swe_workflow_approve` before starting `research`.
2. **Research -> Architecture -> Plan:** Run the discovery and design stages, record each artifact (`swe_research_save`, `swe_architecture_save`, `swe_workflow_set` with tasks & acceptance criteria), and present the **research findings + architecture + plan** clearly.
3. **Before Implementation (`implement` gate):** Calling `swe_workflow_set` to enter `implement` pauses at `awaiting_approval`. Wait for explicit user approval before editing files or running implementation/test tools. Once approved (`swe_workflow_approve`), execute `implement` -> `test` -> `review` and present the final summary + test/review evidence.

## Stage-to-Skill Mapping
- `research` -> `swe-researcher`
- `architecture` -> `swe-architect`
- `plan` -> `swe-planner`
- `implement` -> `swe-implementer`
- `test` -> `swe-tester`
- `review` -> `swe-reviewer`

## Specialist Skills (Cross-Cutting)

Load these bundled skills alongside a stage skill when the task involves documentation, security, or performance (while
still obeying the current stage's `readonly` vs `write` access):

- `swe-documenter` — READMEs, changelogs, API docs, and doc-vs-code verification (`implement` for writes; `research`/
  `review` for audits)
- `swe-security` — OWASP checklist, STRIDE threat modeling, and secrets scanning (`research`/`architecture`/`review` for
  audits; `implement`/`test` for fixes)
- `swe-performance` — profiling guidance, benchmark design, and optimization patterns (`research`/`architecture`/
  `review` for analysis; `implement`/`test` for benchmarks/optimizations)

## Pipeline Sizing & Token Discipline

- **Right-size the pipeline:** Before starting `architecture` (or right after `research`), downgrade small/single-module
  tasks via `swe_workflow_set({ pipeline: "quick" })` (`research -> implement -> test`) or
  `swe_workflow_set({ pipeline: "bugfix" })` (`research -> plan -> implement -> test -> review`) when a full
  architecture spec is unnecessary.
- **On-demand skills & profiles:** Load only the skill needed for the active non-delegated stage (never load
  `swe-researcher`/`swe-reviewer` in the parent when delegated). Set `PlanTask.profiles` on tasks so `implement`/`test`
  overlays stay scoped to the active task, and prune irrelevant workflow profiles via `swe_workflow_set({ profiles })`.
- **Concise artifacts:** Keep `swe_research_save`, `swe_architecture_save`, and task titles/criteria brief and
  high-signal; use `swe_workflow_get({ section })` to inspect specific sections on demand.

## Rules
- Never bypass `awaiting_approval` gates; wait for the user's explicit confirmation.
- Verify each stage records its artifact before advancing (`strictTransitions` blocks skipping ahead without required
  artifacts or passing tests).
- Delegate `research` to `swe-researcher` and `review` to `swe-reviewer` via `subagent` when isolated sub-agents are
  registered.
- Failed `swe_test_record` or `changes_requested` from `swe_review_record` automatically loops back to `implement` until
  `maxFixIterations` is exceeded, at which point `retry_limit` pauses for user confirmation.
