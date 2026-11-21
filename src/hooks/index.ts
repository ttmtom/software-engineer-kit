import {Error as ToolError} from "@opencode/schema/tool";
import type {PluginContext, Registration} from "../types.ts";
import type {KitOptions} from "../options.ts";
import type {ProfileRegistry} from "../skills/profiles.ts";
import {detectProfiles} from "../skills/profiles.ts";
import {isWriteStage} from "../workflows/pipelines.ts";
import {
  appendTouchedFiles,
  createInitialWorkflowState,
  createPendingGate,
  getWorkflowState,
  markGateUserResponded,
  needsGateConfirmation,
  renderWorkflowContext,
  saveWorkflowState,
  type WorkflowState,
} from "../workflows/state.ts";

const FILE_MUTATION_TOOLS = new Set(["edit", "write", "patch", "apply_patch"]);

const GATE_BLOCKED_TOOLS = new Set([
  "edit",
  "write",
  "patch",
  "apply_patch",
  "swe_verify",
  "swe.verify",
  "swe_research_save",
  "swe.research_save",
  "swe_architecture_save",
  "swe.architecture_save",
  "swe_test_record",
  "swe.test_record",
  "swe_review_record",
  "swe.review_record",
]);

export function checkToolAllowedDuringGate(
  toolName: string,
  state: Pick<WorkflowState, "status" | "pendingGate"> | undefined,
): { allowed: true } | { allowed: false; reason: string } {
  if (!state || state.status !== "awaiting_approval" || !state.pendingGate) {
    return { allowed: true };
  }
  if (!GATE_BLOCKED_TOOLS.has(toolName)) {
    return { allowed: true };
  }
  const responded = state.pendingGate.userResponded;
  return {
    allowed: false,
    reason: responded
      ? `Gate "${state.pendingGate.gate}" is unlocked by the user — call \`swe_workflow_approve\` FIRST to advance to "${state.pendingGate.targetStage}", then you may run "${toolName}".`
      : `Workflow is awaiting user approval for gate "${state.pendingGate.gate}" (targetStage: "${state.pendingGate.targetStage}"). Present the summary/plan to the user and wait for their explicit confirmation. After they confirm, call \`swe_workflow_approve\` to unlock the gate before running "${toolName}".`,
  };
}

export function checkToolAllowedForStage(
  toolName: string,
  state: Pick<WorkflowState, "stage"> | undefined,
  options: KitOptions,
): { allowed: true } | { allowed: false; reason: string } {
  if (!state) return { allowed: true };
  const stage = state.stage;
  const isWrite = isWriteStage(stage, options.stageAccess);

  if (!isWrite && FILE_MUTATION_TOOLS.has(toolName)) {
    return {
      allowed: false,
      reason: `Stage "${stage}" is strictly read-only. File modification tool "${toolName}" is blocked. Advance the workflow to a write stage (such as "implement") via "swe_workflow_set" first.`,
    };
  }

  return { allowed: true };
}

export function extractTouchedFilePaths(toolName: string, input: unknown): string[] {
  if (!FILE_MUTATION_TOOLS.has(toolName)) return [];
  if (!input || typeof input !== "object") return [];

  const record = input as Record<string, unknown>;
  const paths: string[] = [];

  for (const key of ["filePath", "path", "file"]) {
    const val = record[key];
    if (typeof val === "string" && val.trim()) {
      paths.push(val.trim());
    }
  }

  if (Array.isArray(record.files)) {
    for (const item of record.files) {
      if (typeof item === "string" && item.trim()) paths.push(item.trim());
    }
  }

  return paths;
}

export async function registerHooks(
  ctx: PluginContext,
  options: KitOptions,
  registry: ProfileRegistry,
): Promise<Registration> {
  const registrations: Registration[] = [];

  if (options.autoInjectContext) {
    registrations.push(
      await ctx.session.hook("context", async (event) => {
        let state = await getWorkflowState(ctx.storage, event.sessionID);
        const isSweAgent = event.agent === options.agentId;

        if (!state && options.autoStartOnAgentPrompt && isSweAgent) {
          const pipeline = options.defaultPipeline;
          const firstStage = "research";
          const profiles = options.autoDetectProfiles
            ? detectProfiles({ directory: ctx.location.directory, registry })
            : [];
          const requireGate = needsGateConfirmation(firstStage, { approvedGates: [] }, options);

          state = await saveWorkflowState(
            ctx.storage,
            createInitialWorkflowState({
              sessionID: event.sessionID,
              pipeline,
              stage: firstStage,
              goal: "",
              profiles,
              status: requireGate ? "awaiting_approval" : "active",
              ...(requireGate
                ? {
                    pendingGate: createPendingGate({
                      gate: firstStage,
                      targetStage: firstStage,
                      summary: `User approval required before starting "${firstStage}" stage.`,
                    }),
                  }
                : {}),
            }),
          );
        }

        if (!state) return;

        const block = renderWorkflowContext({ state, options, registry });
        event.system.push({ type: "text", text: block });

        const isReadonly = !isWriteStage(state.stage, options.stageAccess) || state.status === "awaiting_approval";
        if (options.scopeToAgent && isReadonly) {
          for (const toolName of FILE_MUTATION_TOOLS) {
            delete event.tools[toolName];
          }
        }
      }),
    );
  }

  registrations.push(
    await ctx.session.hook("prompt", async (event) => {
      await markGateUserResponded(ctx.storage, event.sessionID);

      const state = await getWorkflowState(ctx.storage, event.sessionID);
      if (!state && options.autoStartOnAgentPrompt) {
        const pipeline = options.defaultPipeline;
        const firstStage = "research";
        const goal = event.prompt.text;
        const profiles = options.autoDetectProfiles
          ? detectProfiles({ promptText: goal, directory: ctx.location.directory, registry })
          : [];
        const requireGate = needsGateConfirmation(firstStage, { approvedGates: [] }, options);

        await saveWorkflowState(
          ctx.storage,
          createInitialWorkflowState({
            sessionID: event.sessionID,
            pipeline,
            stage: firstStage,
            goal,
            profiles,
            status: requireGate ? "awaiting_approval" : "active",
            ...(requireGate
              ? {
                  pendingGate: createPendingGate({
                    gate: firstStage,
                    targetStage: firstStage,
                    summary: `User approval required before starting "${firstStage}" stage.`,
                  }),
                }
              : {}),
          }),
        );
      } else if (state && !state.goal && event.prompt.text) {
        await saveWorkflowState(ctx.storage, {
          ...state,
          goal: event.prompt.text,
        });
      }
    }),
  );

  registrations.push(
    await ctx.tool.hook("execute.before", async (event) => {
      const state = await getWorkflowState(ctx.storage, event.sessionID);
      const gateCheck = checkToolAllowedDuringGate(event.tool, state);
      if (!gateCheck.allowed) {
        throw new ToolError({ message: gateCheck.reason });
      }

      const stageCheck = checkToolAllowedForStage(event.tool, state, options);
      if (!stageCheck.allowed) {
        throw new ToolError({ message: stageCheck.reason });
      }
    }),
  );

  registrations.push(
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return;

      if (event.tool === "question") {
        await markGateUserResponded(ctx.storage, event.sessionID);
      }

      if (options.trackFileEdits) {
        const paths = extractTouchedFilePaths(event.tool, event.input);
        if (paths.length > 0) {
          await appendTouchedFiles(ctx.storage, event.sessionID, paths);
        }
      }
    }),
  );

  return {
    async dispose() {
      await Promise.allSettled(registrations.map((r) => r.dispose()));
    },
  };
}
