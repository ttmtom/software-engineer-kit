import type { StorageDomain } from "../types.ts";
import type { KitOptions } from "../options.ts";
import { renderStageOverlays, type ProfileRegistry } from "../skills/profiles.ts";
import { getNextStage, getPipelineStages, isOverlayStage, type Stage } from "./pipelines.ts";

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

export interface WorkflowState {
  readonly sessionID: string;
  readonly pipeline: string;
  readonly stage: Stage;
  readonly status: WorkflowStatus;
  readonly pendingGate?: PendingGate;
  readonly approvedGates: readonly string[];
  readonly goal: string;
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
  return {
    ...(candidate as unknown as WorkflowState),
    status: candidate.status === "awaiting_approval" ? "awaiting_approval" : "active",
    approvedGates: Array.isArray(candidate.approvedGates)
      ? candidate.approvedGates.filter((x): x is string => typeof x === "string")
      : [],
  };
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
}): WorkflowState {
  return {
    sessionID: input.sessionID,
    pipeline: input.pipeline,
    stage: input.stage,
    status: input.status ?? "active",
    ...(input.pendingGate ? { pendingGate: input.pendingGate } : {}),
    approvedGates: input.approvedGates ?? [],
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
}): string {
  const { state, options, registry } = input;
  const stages = getPipelineStages(state.pipeline, options.workflows);
  const nextStage = getNextStage(state.stage, state.pipeline, options.workflows);
  const mappedSkill = options.stageSkills[state.stage];

  const lines: string[] = [
    `<kit-workflow pipeline="${state.pipeline}" stage="${state.stage}" status="${state.status}" skill="${mappedSkill}">`,
    `Goal: ${state.goal || "(unspecified)"}`,
    `Pipeline Order: ${stages.join(" -> ")}`,
    `Next Stage: ${nextStage ?? "(final stage)"}`,
    `Active Profiles: ${state.profiles.length > 0 ? state.profiles.join(", ") : "none"}`,
  ];

  if (state.status === "awaiting_approval" && state.pendingGate) {
    lines.push(
      `CONFIRMATION GATE ACTIVE: gate="${state.pendingGate.gate}", targetStage="${state.pendingGate.targetStage}", userResponded=${state.pendingGate.userResponded}`,
      `Gate Reason: ${state.pendingGate.summary}`,
      state.pendingGate.userResponded
        ? `User responded since gate prompt. If they approved, call \`kit_workflow_approve\` to unlock "${state.pendingGate.targetStage}". If they requested changes, update the draft/plan first.`
        : `STOP: Do NOT start "${state.pendingGate.targetStage}" or edit files yet. Present the summary/plan to the user and wait for explicit approval (or /kit-approve).`,
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

  if (state.testResult && state.stage === "review") {
    lines.push("", "## Recorded Test Evidence");
    lines.push(`Status: ${state.testResult.status}`);
    lines.push(`Commands: ${state.testResult.commands.join(", ") || "none"}`);
    lines.push(`Summary: ${state.testResult.summary}`);
    if (state.testResult.gaps.length > 0) {
      lines.push(`Gaps: ${state.testResult.gaps.join("; ")}`);
    }
  }

  if (state.status === "active" && isOverlayStage(state.stage) && state.profiles.length > 0) {
    const overlays = renderStageOverlays(state.profiles, state.stage, registry);
    if (overlays) {
      lines.push("", `## Active ${state.stage.toUpperCase()} Overlays`, overlays);
    }
  }

  lines.push("</kit-workflow>");
  return lines.join("\n");
}
