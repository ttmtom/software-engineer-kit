import {Error as ToolError} from "@opencode/schema/tool";
import type {PluginContext, Registration} from "../types.ts";
import type {KitOptions} from "../options.ts";
import type {ProfileRegistry} from "../skills/profiles.ts";
import {detectProfiles} from "../skills/profiles.ts";
import {getPipelineStages, isWriteStage, type Stage} from "../workflows/pipelines.ts";
import {
  appendTouchedFiles,
  createInitialWorkflowState,
  createPendingGate,
  getWorkflowState,
  markGateUserResponded,
  renderSubagentWorkflowContext,
  renderWorkflowContext,
  resolveStartGate,
  resolveWorkflowSessionID,
  saveWorkflowState,
  type WorkflowState,
} from "../workflows/state.ts";

const FILE_MUTATION_TOOLS = new Set(["edit", "write", "patch", "apply_patch"]);

const RESEARCH_SAVE_TOOLS = new Set(["swe_research_save", "swe.research_save"]);
const REVIEW_RECORD_TOOLS = new Set(["swe_review_record", "swe.review_record"]);
const WORKFLOW_SET_TOOLS = new Set(["swe_workflow_set", "swe.workflow_set"]);

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
      reason: `Stage "${stage}" is strictly read-only. File modification tool "${toolName}" is blocked. Call \`swe_workflow_set\` with \`{ "advance": true }\` (or \`{ "stage": "implement" }\`) to advance to a write stage first.`,
    };
  }

  return { allowed: true };
}

export function getSubagentRoleForAgent(
  agentId: string,
  options: Pick<KitOptions, "subagentIds">,
): "research" | "review" | undefined {
  if (agentId === options.subagentIds.research) return "research";
  if (agentId === options.subagentIds.review) return "review";
  return undefined;
}

export function checkToolAllowedForDelegation(
  toolName: string,
  input: {
    readonly agent: string;
    readonly stage: Stage;
    readonly isChild: boolean;
    readonly subagentAvailable: boolean;
  },
  options: Pick<KitOptions, "agentId" | "isolateStages" | "subagentIds">,
): { allowed: true } | { allowed: false; reason: string } {
  if (input.isChild || input.agent !== options.agentId || !input.subagentAvailable) {
    return {allowed: true};
  }

  if (
    input.stage === "research" &&
    options.isolateStages.includes("research") &&
    RESEARCH_SAVE_TOOLS.has(toolName)
  ) {
    return {
      allowed: false,
      reason: `Stage "research" is isolated to sub-agent "${options.subagentIds.research}". Delegate via \`subagent({ agent: "${options.subagentIds.research}", ... })\` so it persists findings cleanly.`,
    };
  }

  if (
    input.stage === "review" &&
    options.isolateStages.includes("review") &&
    REVIEW_RECORD_TOOLS.has(toolName)
  ) {
    return {
      allowed: false,
      reason: `Stage "review" is isolated to sub-agent "${options.subagentIds.review}". Delegate via \`subagent({ agent: "${options.subagentIds.review}", ... })\` for an objective, isolated review.`,
    };
  }

  return {allowed: true};
}

export function shouldAutoStartOnPrompt(input: {
  readonly session?: { readonly parentID?: string; readonly agent?: string };
  readonly options: Pick<KitOptions, "agentId" | "autoStartOnAgentPrompt" | "subagentIds">;
}): boolean {
  if (!input.options.autoStartOnAgentPrompt) return false;
  if (input.session?.parentID) return false;
  const sessionAgent = input.session?.agent;
  if (sessionAgent) {
    if (getSubagentRoleForAgent(sessionAgent, input.options)) return false;
    if (sessionAgent !== input.options.agentId) return false;
  }
  return true;
}

async function isAgentRegistered(ctx: PluginContext, agentId: string): Promise<boolean> {
  try {
    const {data: agents} = await ctx.agent.list();
    return agents.some((a) => a.id === agentId || a.name === agentId);
  } catch {
    return false;
  }
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
        const subagentRole = getSubagentRoleForAgent(event.agent, options);
        const resolved = await resolveWorkflowSessionID({
          storage: ctx.storage,
          session: ctx.session,
          sessionID: event.sessionID,
        });

        if (subagentRole || resolved.isChild) {
          if (resolved.state) {
            const role: "research" | "review" =
              subagentRole ?? (resolved.state.stage === "review" ? "review" : "research");
            const block = renderSubagentWorkflowContext({
              state: resolved.state,
              role,
              options,
              registry,
            });
            event.system.push({type: "text", text: block});
          }

          if (options.scopeToAgent) {
            for (const toolName of FILE_MUTATION_TOOLS) {
              delete event.tools[toolName];
            }
            for (const toolName of WORKFLOW_SET_TOOLS) {
              delete event.tools[toolName];
            }
          }
          return;
        }

        let state = resolved.state;
        const isSweAgent = event.agent === options.agentId;

        if (!state && options.autoStartOnAgentPrompt && isSweAgent) {
          const pipeline = options.defaultPipeline;
          const firstStage = getPipelineStages(pipeline, options.workflows)[0] ?? "research";
          const profiles = options.autoDetectProfiles
            ? detectProfiles({ directory: ctx.location.directory, registry })
            : [];
          const startGate = resolveStartGate(firstStage, {approvedGates: []}, options);

          state = await saveWorkflowState(
            ctx.storage,
            createInitialWorkflowState({
              sessionID: event.sessionID,
              pipeline,
              stage: firstStage,
              goal: "",
              profiles,
              status: startGate ? "awaiting_approval" : "active",
              ...(startGate
                ? {
                    pendingGate: createPendingGate({
                      gate: startGate.gate,
                      targetStage: startGate.targetStage,
                      summary: startGate.summary,
                    }),
                  }
                : {}),
            }),
          );
        }

        if (!state) return;

        let delegatedSubagent: string | undefined;
        if (
          state.status === "active" &&
          isSweAgent &&
          (state.stage === "research" || state.stage === "review") &&
          options.isolateStages.includes(state.stage)
        ) {
          const candidateId = options.subagentIds[state.stage];
          if (await isAgentRegistered(ctx, candidateId)) {
            delegatedSubagent = candidateId;
          }
        }

        const block = renderWorkflowContext({state, options, registry, delegatedSubagent});
        event.system.push({ type: "text", text: block });

        const isReadonly = !isWriteStage(state.stage, options.stageAccess) || state.status === "awaiting_approval";
        if (options.scopeToAgent && isReadonly) {
          for (const toolName of FILE_MUTATION_TOOLS) {
            delete event.tools[toolName];
          }
        }
        if (options.scopeToAgent && state.status === "awaiting_approval") {
          for (const toolName of GATE_BLOCKED_TOOLS) {
            delete event.tools[toolName];
          }
        }
        if (options.scopeToAgent && delegatedSubagent) {
          const blocked = state.stage === "research" ? RESEARCH_SAVE_TOOLS : REVIEW_RECORD_TOOLS;
          for (const toolName of blocked) {
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
        let sessionInfo: { readonly parentID?: string; readonly agent?: string } | undefined;
        try {
          sessionInfo = await ctx.session.get({sessionID: event.sessionID});
        } catch {
          sessionInfo = undefined;
        }

        if (!shouldAutoStartOnPrompt({session: sessionInfo, options})) {
          return;
        }

        const pipeline = options.defaultPipeline;
        const firstStage = getPipelineStages(pipeline, options.workflows)[0] ?? "research";
        const goal = event.prompt.text;
        const profiles = options.autoDetectProfiles
          ? detectProfiles({ promptText: goal, directory: ctx.location.directory, registry })
          : [];
        const startGate = resolveStartGate(firstStage, {approvedGates: []}, options);

        await saveWorkflowState(
          ctx.storage,
          createInitialWorkflowState({
            sessionID: event.sessionID,
            pipeline,
            stage: firstStage,
            goal,
            profiles,
            status: startGate ? "awaiting_approval" : "active",
            ...(startGate
              ? {
                  pendingGate: createPendingGate({
                    gate: startGate.gate,
                    targetStage: startGate.targetStage,
                    summary: startGate.summary,
                  }),
                }
              : {}),
          }),
        );
      } else if (state && !state.goal && event.prompt.text) {
        const goal = event.prompt.text;
        const profiles =
          options.autoDetectProfiles && !state.profilesLocked
            ? detectProfiles({promptText: goal, directory: ctx.location.directory, registry})
            : state.profiles;
        await saveWorkflowState(ctx.storage, {
          ...state,
          goal,
          profiles,
        });
      }
    }),
  );

  registrations.push(
    await ctx.tool.hook("execute.before", async (event) => {
      const subagentRole = getSubagentRoleForAgent(event.agent, options);
      const resolved = await resolveWorkflowSessionID({
        storage: ctx.storage,
        session: ctx.session,
        sessionID: event.sessionID,
      });

      if (subagentRole || resolved.isChild) {
        const gateCheck = checkToolAllowedDuringGate(event.tool, resolved.state);
        if (!gateCheck.allowed) {
          throw new ToolError({message: gateCheck.reason});
        }
        if (FILE_MUTATION_TOOLS.has(event.tool)) {
          throw new ToolError({
            message: `Sub-agent "${event.agent}" is strictly read-only. File modification tool "${event.tool}" is blocked.`,
          });
        }
        if (WORKFLOW_SET_TOOLS.has(event.tool)) {
          throw new ToolError({
            message: `Sub-agent "${event.agent}" cannot advance or modify workflow stages via "${event.tool}". Persist your artifact and let the parent agent manage transitions.`,
          });
        }
        return;
      }

      const state = resolved.state;
      const gateCheck = checkToolAllowedDuringGate(event.tool, state);
      if (!gateCheck.allowed) {
        throw new ToolError({ message: gateCheck.reason });
      }

      const stageCheck = checkToolAllowedForStage(event.tool, state, options);
      if (!stageCheck.allowed) {
        throw new ToolError({ message: stageCheck.reason });
      }

      if (
        state &&
        event.agent === options.agentId &&
        (state.stage === "research" || state.stage === "review") &&
        options.isolateStages.includes(state.stage) &&
        (RESEARCH_SAVE_TOOLS.has(event.tool) || REVIEW_RECORD_TOOLS.has(event.tool))
      ) {
        const subagentAvailable = await isAgentRegistered(ctx, options.subagentIds[state.stage]);
        const delegationCheck = checkToolAllowedForDelegation(
          event.tool,
          {
            agent: event.agent,
            stage: state.stage,
            isChild: false,
            subagentAvailable,
          },
          options,
        );
        if (!delegationCheck.allowed) {
          throw new ToolError({message: delegationCheck.reason});
        }
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
