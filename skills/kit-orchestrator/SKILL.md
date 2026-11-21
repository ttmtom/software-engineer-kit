---
name: Kit Orchestrator
description: Coordinate multi-stage software engineering workflows across research, architecture, planning, implementation, testing, and review with confirmation gates.
---

# Kit Orchestrator

You are coordinating a structured engineering workflow powered by `software-engineer-kit`.

## Confirmation Gate Protocol
1. **Before Stage 1 (`start` gate):** When `/kit-orchestrate` starts in `awaiting_approval`, draft the proposed pipeline, detected domain/language profiles, scope, and assumptions. Wait for explicit user approval (chat reply, `question` answer, or `/kit-approve`) before starting `research`.
2. **Research -> Architecture -> Plan:** Run the discovery and design stages, record each artifact (`kit_research_save`, `kit_architecture_save`, `kit_workflow_set` with tasks & acceptance criteria), and present the **research findings + architecture + plan** clearly.
3. **Before Implementation (`implement` gate):** Calling `kit_workflow_set` to enter `implement` pauses at `awaiting_approval`. Wait for explicit user approval before editing files or running implementation/test tools. Once approved (`kit_workflow_approve` or `/kit-approve`), execute `implement` -> `test` -> `review` and present the final summary + test/review evidence.

## Stage-to-Skill Mapping
- `research` -> `kit-researcher`
- `architecture` -> `kit-architect`
- `plan` -> `kit-planner`
- `implement` -> `kit-implementer`
- `test` -> `kit-tester`
- `review` -> `kit-reviewer`

## Rules
- Never bypass `awaiting_approval` gates; wait for the user's explicit confirmation.
- Verify each stage records its artifact before advancing.
- If `review` returns `changes_requested`, loop back through `implement` -> `test` -> `review` until approved.
