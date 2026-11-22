import type {StorageDomain} from "../types.ts";
import type {KitOptions} from "../options.ts";
import {type ProfileRegistry, renderStageOverlays} from "../skills/profiles.ts";
import {getNextStage, getPipelineStages, isOverlayStage, isWriteStage, type Stage} from "./pipelines.ts";

export interface ResearchRecord {
  readonly summary: string;
  readonly files: readonly string[];
  readonly conventions: readonly string[];
  readonly externalRefs: readonly string[];
  readonly risks: readonly string[];
}

export interface ArchitectureRecord {
  readonly summary: string;
  readonly components: readonly string[];
  readonly contracts: readonly string[];
  readonly dataAndMigrations: readonly string[];
  readonly tradeOffs: readonly string[];
  readonly nonGoals: readonly string[];
}

export interface PlanTask {
  readonly id: string;
  readonly title: string;
  readonly status: "pending" | "in_progress" | "done";
  readonly files?: readonly string[];
  readonly profiles?: readonly string[];
}

export interface TestRecord {
  readonly status: "passed" | "failed";
  readonly commands: readonly string[];
  readonly summary: string;
  readonly gaps: readonly string[];
}

export interface ReviewFinding {
  readonly severity: "critical" | "major" | "minor" | "nit";
  readonly location: string;
  readonly message: string;
}

export interface ReviewRecord {
  readonly verdict: "approved" | "changes_requested";
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
}

export interface PendingGate {
  readonly gate: string;
  readonly targetStage: Stage;
  readonly summary: string;
  readonly userResponded: boolean;
  readonly requestedAt: string;
}

export type WorkflowStatus = "active" | "awaiting_approval";

export const RETRY_LIMIT_GATE = "retry_limit";

export interface WorkflowState {
  readonly sessionID: string;
  readonly pipeline: string;
  readonly stage: Stage;
  readonly status: WorkflowStatus;
  readonly pendingGate?: PendingGate;
  readonly approvedGates: readonly string[];
  readonly fixIterations: number;
  readonly completed?: boolean;
  readonly goal: string;
  readonly reviewTarget?: string;
  readonly profiles: readonly string[];
  readonly tasks: readonly PlanTask[];
  readonly acceptanceCriteria: readonly string[];
  readonly touchedFiles: readonly string[];
  readonly research?: ResearchRecord;
  readonly architecture?: ArchitectureRecord;
  readonly testResult?: TestRecord;
  readonly reviewResult?: ReviewRecord;
  readonly updatedAt: string;
}

const KEY_PREFIX = "software-engineer-kit/workflow/";

export function workflowStorageKey(sessionID: string): string {
  return `${KEY_PREFIX}${sessionID}`;
}

export async function getWorkflowState(
  storage: Pick<StorageDomain, "get">,
  sessionID: string,
): Promise<WorkflowState | undefined> {
  const raw = await storage.get(workflowStorageKey(sessionID));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const candidate = raw as Record<string, unknown>;

  if (
    typeof candidate.sessionID !== "string" ||
    typeof candidate.pipeline !== "string" ||
    typeof candidate.stage !== "string" ||
    (candidate.status !== "active" && candidate.status !== "awaiting_approval")
  ) {
    return undefined;
  }

  const fixIterations =
    typeof candidate.fixIterations === "number" &&
    Number.isFinite(candidate.fixIterations) &&
    candidate.fixIterations >= 0
      ? Math.floor(candidate.fixIterations)
      : 0;

  return {
    ...(candidate as unknown as WorkflowState),
    status: candidate.status,
    fixIterations,
    approvedGates: Array.isArray(candidate.approvedGates)
      ? candidate.approvedGates.filter((x): x is string => typeof x === "string")
      : [],
  };
}

export interface SessionLookup {
  get(input: { readonly sessionID: string }): Promise<{
    readonly id: string;
    readonly parentID?: string;
    readonly agent?: string;
  }>;
}

export async function resolveWorkflowSessionID(input: {
  readonly storage: Pick<StorageDomain, "get">;
  readonly session?: SessionLookup;
  readonly sessionID: string;
  readonly maxDepth?: number;
}): Promise<{
  readonly workflowSessionID: string;
  readonly state: WorkflowState | undefined;
  readonly isChild: boolean;
}> {
  const direct = await getWorkflowState(input.storage, input.sessionID);
  if (direct) {
    return {workflowSessionID: input.sessionID, state: direct, isChild: false};
  }

  if (!input.session) {
    return {workflowSessionID: input.sessionID, state: undefined, isChild: false};
  }

  const maxDepth = input.maxDepth ?? 5;
  const visited = new Set<string>([input.sessionID]);
  let currentID: string | undefined = input.sessionID;

  for (let depth = 0; depth < maxDepth && currentID; depth++) {
    let info: { readonly id: string; readonly parentID?: string; readonly agent?: string };
    try {
      info = await input.session.get({sessionID: currentID});
    } catch {
      break;
    }

    const parentID = info.parentID;
    if (!parentID || visited.has(parentID)) break;
    visited.add(parentID);

    const parentState = await getWorkflowState(input.storage, parentID);
    if (parentState) {
      return {workflowSessionID: parentID, state: parentState, isChild: true};
    }
    currentID = parentID;
  }

  return {workflowSessionID: input.sessionID, state: undefined, isChild: false};
}

export async function saveWorkflowState(
  storage: Pick<StorageDomain, "set">,
  state: WorkflowState,
): Promise<WorkflowState> {
  const next: WorkflowState = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  await storage.set(workflowStorageKey(state.sessionID), next as unknown as Parameters<StorageDomain["set"]>[1]);
  return next;
}

export async function clearWorkflowState(
  storage: Pick<StorageDomain, "remove">,
  sessionID: string,
): Promise<void> {
  await storage.remove(workflowStorageKey(sessionID));
}

export function createInitialWorkflowState(input: {
  readonly sessionID: string;
  readonly pipeline: string;
  readonly stage: Stage;
  readonly goal: string;
  readonly profiles?: readonly string[];
  readonly status?: WorkflowStatus;
  readonly pendingGate?: PendingGate;
  readonly approvedGates?: readonly string[];
  readonly fixIterations?: number;
}): WorkflowState {
  return {
    sessionID: input.sessionID,
    pipeline: input.pipeline,
    stage: input.stage,
    status: input.status ?? "active",
    ...(input.pendingGate ? { pendingGate: input.pendingGate } : {}),
    approvedGates: input.approvedGates ?? [],
    fixIterations: input.fixIterations ?? 0,
    goal: input.goal,
    profiles: input.profiles ?? [],
    tasks: [],
    acceptanceCriteria: [],
    touchedFiles: [],
    updatedAt: new Date().toISOString(),
  };
}

export function needsGateConfirmation(
  gate: string,
  state: Pick<WorkflowState, "approvedGates">,
  options: Pick<KitOptions, "confirmBefore">,
): boolean {
  return options.confirmBefore.includes(gate) && !state.approvedGates.includes(gate);
}

export function resolveStartGate(
  firstStage: Stage,
  state: Pick<WorkflowState, "approvedGates">,
  options: Pick<KitOptions, "confirmBefore">,
): { readonly gate: string; readonly targetStage: Stage; readonly summary: string } | undefined {
  if (needsGateConfirmation("start", state, options)) {
    return {
      gate: "start",
      targetStage: firstStage,
      summary: `User approval required before starting workflow (first stage: "${firstStage}").`,
    };
  }
  if (needsGateConfirmation(firstStage, state, options)) {
    return {
      gate: firstStage,
      targetStage: firstStage,
      summary: `User approval required before starting "${firstStage}" stage.`,
    };
  }
  return undefined;
}

export function createPendingGate(input: {
  readonly gate: string;
  readonly targetStage: Stage;
  readonly summary: string;
}): PendingGate {
  return {
    gate: input.gate,
    targetStage: input.targetStage,
    summary: input.summary,
    userResponded: false,
    requestedAt: new Date().toISOString(),
  };
}

export async function markGateUserResponded(
  storage: Pick<StorageDomain, "get" | "set">,
  sessionID: string,
): Promise<WorkflowState | undefined> {
  const existing = await getWorkflowState(storage, sessionID);
  if (!existing || existing.status !== "awaiting_approval" || !existing.pendingGate) {
    return existing;
  }
  if (existing.pendingGate.userResponded) return existing;

  return saveWorkflowState(storage, {
    ...existing,
    pendingGate: {
      ...existing.pendingGate,
      userResponded: true,
    },
  });
}

export function applyGateApproval(state: WorkflowState): WorkflowState {
  if (!state.pendingGate) {
    return { ...state, status: "active" };
  }
  if (state.pendingGate.gate === RETRY_LIMIT_GATE) {
    return {
      ...state,
      status: "active",
      stage: state.pendingGate.targetStage,
      pendingGate: undefined,
      fixIterations: 0,
      completed: false,
    };
  }
  const approved = new Set(state.approvedGates);
  approved.add(state.pendingGate.gate);
  return {
    ...state,
    status: "active",
    stage: state.pendingGate.targetStage,
    pendingGate: undefined,
    approvedGates: Array.from(approved),
  };
}

export function validateForwardTransition(
  current: WorkflowState,
  targetStage: Stage,
  options: Pick<KitOptions, "workflows" | "strictTransitions">,
): { readonly allowed: true } | { readonly allowed: false; readonly reason: string } {
  if (!options.strictTransitions) {
    return {allowed: true};
  }

  const stages = getPipelineStages(current.pipeline, options.workflows);
  const currentIdx = stages.indexOf(current.stage);
  const targetIdx = stages.indexOf(targetStage);
  if (currentIdx === -1 || targetIdx === -1 || targetIdx <= currentIdx) {
    return {allowed: true};
  }

  for (let i = currentIdx; i < targetIdx; i++) {
    const stageToLeave = stages[i];
    if (stageToLeave === "research" && !current.research) {
      return {
        allowed: false,
        reason: `Cannot advance past "research" before saving findings via \`swe_research_save\`.`,
      };
    }
    if (stageToLeave === "architecture" && !current.architecture) {
      return {
        allowed: false,
        reason: `Cannot advance past "architecture" before saving an architecture spec via \`swe_architecture_save\`.`,
      };
    }
    if (stageToLeave === "plan" && current.tasks.length === 0) {
      return {
        allowed: false,
        reason: `Cannot advance past "plan" before recording tasks via \`swe_workflow_set\`.`,
      };
    }
    if (stageToLeave === "test" && current.testResult?.status !== "passed") {
      return {
        allowed: false,
        reason: `Cannot advance past "test" without a passing test record (\`swe_test_record\` with status: "passed").`,
      };
    }
  }

  return {allowed: true};
}

export interface RetryTransitionResult {
  readonly nextState: WorkflowState;
  readonly transition: Stage | null;
  readonly circuitBreakerTriggered: boolean;
}

export function applyTestRecordTransition(
  state: WorkflowState,
  testResult: TestRecord,
  options: Pick<KitOptions, "workflows" | "maxFixIterations">,
): RetryTransitionResult {
  const base: WorkflowState = {
    ...state,
    testResult,
  };

  if (testResult.status === "passed") {
    const isFinalTestStage = !getNextStage("test", state.pipeline, options.workflows);
    return {
      nextState: isFinalTestStage ? {...base, completed: true} : base,
      transition: null,
      circuitBreakerTriggered: false,
    };
  }

  const stages = getPipelineStages(state.pipeline, options.workflows);
  if (!stages.includes("implement")) {
    return {
      nextState: {...base, completed: false},
      transition: null,
      circuitBreakerTriggered: false,
    };
  }

  const nextIterations = state.fixIterations + 1;
  if (nextIterations <= options.maxFixIterations) {
    return {
      nextState: {
        ...base,
        stage: "implement",
        status: "active",
        pendingGate: undefined,
        fixIterations: nextIterations,
        completed: false,
        reviewResult: undefined,
      },
      transition: "implement",
      circuitBreakerTriggered: false,
    };
  }

  return {
    nextState: {
      ...base,
      status: "awaiting_approval",
      fixIterations: nextIterations,
      completed: false,
      pendingGate: createPendingGate({
        gate: RETRY_LIMIT_GATE,
        targetStage: "implement",
        summary: `Verification failed after ${nextIterations} fix iteration(s) (maxFixIterations=${options.maxFixIterations}). Inspect failures and approve to reset retry budget or revise plan.`,
      }),
    },
    transition: null,
    circuitBreakerTriggered: true,
  };
}

export function applyReviewRecordTransition(
  state: WorkflowState,
  reviewResult: ReviewRecord,
  options: Pick<KitOptions, "workflows" | "maxFixIterations">,
): RetryTransitionResult {
  const base: WorkflowState = {
    ...state,
    reviewResult,
  };

  if (reviewResult.verdict === "approved") {
    return {
      nextState: {
        ...base,
        completed: true,
      },
      transition: null,
      circuitBreakerTriggered: false,
    };
  }

  const stages = getPipelineStages(state.pipeline, options.workflows);
  if (!stages.includes("implement")) {
    return {
      nextState: {...base, completed: false},
      transition: null,
      circuitBreakerTriggered: false,
    };
  }

  const nextIterations = state.fixIterations + 1;
  if (nextIterations <= options.maxFixIterations) {
    return {
      nextState: {
        ...base,
        stage: "implement",
        status: "active",
        pendingGate: undefined,
        fixIterations: nextIterations,
        completed: false,
        testResult: undefined,
      },
      transition: "implement",
      circuitBreakerTriggered: false,
    };
  }

  return {
    nextState: {
      ...base,
      status: "awaiting_approval",
      fixIterations: nextIterations,
      completed: false,
      pendingGate: createPendingGate({
        gate: RETRY_LIMIT_GATE,
        targetStage: "implement",
        summary: `Code review requested changes after ${nextIterations} fix iteration(s) (maxFixIterations=${options.maxFixIterations}). Review unresolved findings and approve to reset retry budget.`,
      }),
    },
    transition: null,
    circuitBreakerTriggered: true,
  };
}

export async function appendTouchedFiles(
  storage: Pick<StorageDomain, "get" | "set">,
  sessionID: string,
  paths: readonly string[],
): Promise<WorkflowState | undefined> {
  if (paths.length === 0) return undefined;
  const existing = await getWorkflowState(storage, sessionID);
  if (!existing) return undefined;

  const set = new Set(existing.touchedFiles);
  let changed = false;
  for (const item of paths) {
    if (!item || set.has(item)) continue;
    set.add(item);
    changed = true;
  }
  if (!changed) return existing;

  return saveWorkflowState(storage, {
    ...existing,
    touchedFiles: Array.from(set),
  });
}

export function renderWorkflowContext(input: {
  readonly state: WorkflowState;
  readonly options: KitOptions;
  readonly registry: ProfileRegistry;
  readonly delegatedSubagent?: string;
}): string {
  const {state, options, registry, delegatedSubagent} = input;
  const stages = getPipelineStages(state.pipeline, options.workflows);
  const nextStage = getNextStage(state.stage, state.pipeline, options.workflows);
  const mappedSkill = options.stageSkills[state.stage];
  const access = options.stageAccess[state.stage] ?? (isWriteStage(state.stage, options.stageAccess) ? "write" : "readonly");

  const lines: string[] = [
    `<swe-workflow pipeline="${state.pipeline}" stage="${state.stage}" access="${access}" status="${state.status}" skill="${mappedSkill}">`,
    `Goal: ${state.goal || "(unspecified)"}`,
    `Stage Access: ${access.toUpperCase()} (${access === "readonly" ? "Do NOT edit files" : "File modifications permitted"})`,
    `Pipeline Order: ${stages.join(" -> ")}`,
    `Next Stage: ${nextStage ?? "(final stage)"}`,
    ...(state.fixIterations > 0
      ? [`Fix Iterations: ${state.fixIterations}/${options.maxFixIterations}`]
      : []),
    ...(state.stage === "review" && state.reviewTarget
      ? [`Review Target: ${state.reviewTarget}`]
      : []),
    `Active Profiles: ${state.profiles.length > 0 ? state.profiles.join(", ") : "none"}`,
  ];

  if (state.status === "awaiting_approval" && state.pendingGate) {
    lines.push(
      `CONFIRMATION GATE ACTIVE: gate="${state.pendingGate.gate}", targetStage="${state.pendingGate.targetStage}", userResponded=${state.pendingGate.userResponded}`,
      `Gate Reason: ${state.pendingGate.summary}`,
      state.pendingGate.userResponded
        ? `User has responded. If they approved, call \`swe_workflow_approve\` NOW to unlock "${state.pendingGate.targetStage}" before proceeding. If they requested changes, update the plan first then wait for re-approval.`
        : `STOP: Do NOT start "${state.pendingGate.targetStage}" or call \`swe_workflow_approve\` yet. Present the summary/plan to the user and wait for their explicit confirmation reply.`,
    );
  } else if (delegatedSubagent) {
    lines.push(
      `Instruction: Delegate the "${state.stage}" stage to sub-agent "${delegatedSubagent}" via the \`subagent\` tool. Do NOT perform this stage inline; wait for the sub-agent to persist its artifact to workflow state, inspect via \`swe_workflow_get\`, then advance.`,
    );
  } else {
    lines.push(`Instruction: Follow skill "${mappedSkill}" for the current "${state.stage}" stage.`);
  }

  if (state.research) {
    lines.push("", "## Saved Research");
    lines.push(state.research.summary);
    if (state.research.files.length > 0) {
      lines.push(`Key Files: ${state.research.files.join(", ")}`);
    }
    if (state.research.risks.length > 0) {
      lines.push(`Risks: ${state.research.risks.join("; ")}`);
    }
  }

  if (state.architecture) {
    lines.push("", "## Saved Architecture Spec");
    lines.push(state.architecture.summary);
    if (state.architecture.contracts.length > 0) {
      lines.push(`Contracts:\n- ${state.architecture.contracts.join("\n- ")}`);
    }
    if (state.architecture.dataAndMigrations.length > 0) {
      lines.push(`Data/SQL:\n- ${state.architecture.dataAndMigrations.join("\n- ")}`);
    }
  }

  if (state.tasks.length > 0 || state.acceptanceCriteria.length > 0) {
    lines.push("", "## Active Plan");
    if (state.tasks.length > 0) {
      lines.push(
        "Tasks:\n" +
          state.tasks
            .map((t) => {
              const tags = t.profiles && t.profiles.length > 0 ? ` [${t.profiles.join(", ")}]` : "";
              return `- [${t.status}] ${t.id}: ${t.title}${tags}`;
            })
            .join("\n"),
      );
    }
    if (state.acceptanceCriteria.length > 0) {
      lines.push(
        "Acceptance Criteria:\n" +
          state.acceptanceCriteria.map((c) => `- ${c}`).join("\n"),
      );
    }
  }

  if (state.touchedFiles.length > 0 && (state.stage === "test" || state.stage === "review")) {
    lines.push("", `## Touched Files (${state.touchedFiles.length})`);
    lines.push(state.touchedFiles.map((f) => `- ${f}`).join("\n"));
  }

  if (state.testResult && (state.stage === "review" || (state.stage === "implement" && state.testResult.status === "failed"))) {
    lines.push("", "## Recorded Test Evidence");
    lines.push(`Status: ${state.testResult.status}`);
    lines.push(`Commands: ${state.testResult.commands.join(", ") || "none"}`);
    lines.push(`Summary: ${state.testResult.summary}`);
    if (state.testResult.gaps.length > 0) {
      lines.push(`Gaps: ${state.testResult.gaps.join("; ")}`);
    }
  }

  if (state.reviewResult && state.reviewResult.verdict === "changes_requested" && state.stage !== "review") {
    lines.push("", `## Unresolved Review Findings (${state.reviewResult.findings.length})`);
    lines.push(state.reviewResult.summary);
    for (const f of state.reviewResult.findings) {
      lines.push(`- [${f.severity}] ${f.location}: ${f.message}`);
    }
  }

  if (state.status === "active" && isOverlayStage(state.stage) && state.profiles.length > 0) {
    const overlays = renderStageOverlays(state.profiles, state.stage, registry);
    if (overlays) {
      lines.push("", `## Active ${state.stage.toUpperCase()} Overlays`, overlays);
    }
  }

  lines.push("</swe-workflow>");
  return lines.join("\n");
}

export function renderSubagentWorkflowContext(input: {
  readonly state: WorkflowState;
  readonly role: "research" | "review";
  readonly options: KitOptions;
  readonly registry: ProfileRegistry;
}): string {
  const {state, role, options, registry} = input;
  const mappedSkill = options.stageSkills[role];

  if (role === "research") {
    const lines: string[] = [
      `<swe-workflow-subagent role="research" pipeline="${state.pipeline}" access="readonly" skill="${mappedSkill}">`,
      `Goal: ${state.goal || "(unspecified)"}`,
      `Stage Access: READONLY (Do NOT edit files)`,
      `Active Profiles: ${state.profiles.length > 0 ? state.profiles.join(", ") : "none"}`,
      `Instruction: Follow skill "${mappedSkill}" and persist findings to the parent workflow via \`swe_research_save\`. Do NOT call \`swe_workflow_set\`.`,
      "</swe-workflow-subagent>",
    ];
    return lines.join("\n");
  }

  const lines: string[] = [
    `<swe-workflow-subagent role="review" pipeline="${state.pipeline}" access="readonly" skill="${mappedSkill}">`,
    `Goal: ${state.goal || "(unspecified)"}`,
    `Stage Access: READONLY (Do NOT edit files)`,
    ...(state.reviewTarget ? [`Review Target: ${state.reviewTarget}`] : []),
    `Active Profiles: ${state.profiles.length > 0 ? state.profiles.join(", ") : "none"}`,
    `Instruction: Perform an objective, isolated code review using skill "${mappedSkill}" and persist the verdict via \`swe_review_record\`. Do NOT call \`swe_workflow_set\`.`,
  ];

  if (state.architecture) {
    lines.push("", "## Architecture Spec");
    lines.push(state.architecture.summary);
    if (state.architecture.contracts.length > 0) {
      lines.push(`Contracts:\n- ${state.architecture.contracts.join("\n- ")}`);
    }
    if (state.architecture.dataAndMigrations.length > 0) {
      lines.push(`Data/SQL:\n- ${state.architecture.dataAndMigrations.join("\n- ")}`);
    }
  }

  if (state.acceptanceCriteria.length > 0) {
    lines.push(
      "",
      "## Acceptance Criteria",
      state.acceptanceCriteria.map((c) => `- ${c}`).join("\n"),
    );
  }

  if (state.touchedFiles.length > 0) {
    lines.push("", `## Touched Files (${state.touchedFiles.length})`);
    lines.push(state.touchedFiles.map((f) => `- ${f}`).join("\n"));
  }

  if (state.testResult) {
    lines.push("", "## Recorded Test Evidence");
    lines.push(`Status: ${state.testResult.status}`);
    lines.push(`Commands: ${state.testResult.commands.join(", ") || "none"}`);
    lines.push(`Summary: ${state.testResult.summary}`);
    if (state.testResult.gaps.length > 0) {
      lines.push(`Gaps: ${state.testResult.gaps.join("; ")}`);
    }
  }

  if (state.profiles.length > 0) {
    const overlays = renderStageOverlays(state.profiles, "review", registry);
    if (overlays) {
      lines.push("", "## Active REVIEW Overlays", overlays);
    }
  }

  lines.push("</swe-workflow-subagent>");
  return lines.join("\n");
}
