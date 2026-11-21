import { Error as ToolError } from "@opencode/schema/tool";
import type { PluginContext, Registration } from "../types.ts";
import type { KitOptions } from "../options.ts";
import type { ProfileRegistry } from "../skills/profiles.ts";
import {
  appendTouchedFiles,
  getWorkflowState,
  markGateUserResponded,
  renderWorkflowContext,
  type WorkflowState,
} from "../workflows/state.ts";

const FILE_MUTATION_TOOLS = new Set(["edit", "write", "patch", "apply_patch"]);

const GATE_BLOCKED_TOOLS = new Set([
  "edit",
  "write",
  "patch",
  "apply_patch",
  "kit_verify",
  "kit_research_save",
  "kit_architecture_save",
  "kit_test_record",
  "kit_review_record",
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
  return {
    allowed: false,
    reason: `Workflow is awaiting user approval for gate "${state.pendingGate.gate}" (targetStage: "${state.pendingGate.targetStage}"). Present the summary/plan to the user and wait for explicit approval (or /kit-approve) before running "${toolName}".`,
  };
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
): Promise<Registration[]> {
  const registrations: Registration[] = [];

  if (options.autoInjectContext) {
    registrations.push(
      await ctx.session.hook("context", async (event) => {
        const state = await getWorkflowState(ctx.storage, event.sessionID);
        if (!state) return;

        const block = renderWorkflowContext({ state, options, registry });
        event.system.push({ type: "text", text: block });
      }),
    );
  }

  registrations.push(
    await ctx.session.hook("prompt", async (event) => {
      await markGateUserResponded(ctx.storage, event.sessionID);
    }),
  );

  registrations.push(
    await ctx.tool.hook("execute.before", async (event) => {
      const state = await getWorkflowState(ctx.storage, event.sessionID);
      const check = checkToolAllowedDuringGate(event.tool, state);
      if (!check.allowed) {
        throw new ToolError({ message: check.reason });
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

  return registrations;
}
