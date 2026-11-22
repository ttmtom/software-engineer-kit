import {spawn} from "node:child_process";
import path from "node:path";
import type {PluginContext, Registration, StorageDomain} from "../types.ts";
import type {KitOptions} from "../options.ts";
import {detectProfiles, isKnownProfile, normalizeProfiles, type ProfileRegistry,} from "../skills/profiles.ts";
import {ALL_STAGES, getNextStage, getPipelineStages, isStage, type Stage,} from "../workflows/pipelines.ts";
import {
  applyGateApproval,
  applyReviewRecordTransition,
  applyTestRecordTransition,
  type ArchitectureRecord,
  clearWorkflowState,
  createInitialWorkflowState,
  createPendingGate,
  getWorkflowState,
  needsGateConfirmation,
  type PlanTask,
  type ResearchRecord,
  resolveWorkflowSessionID,
  type ReviewFinding,
  type ReviewRecord,
  saveWorkflowState,
  type SessionLookup,
  type TestRecord,
  validateForwardTransition,
  type WorkflowState,
} from "../workflows/state.ts";
import {asStringArray} from "../utils.ts";

export interface ToolsContext {
  readonly storage: Pick<StorageDomain, "get" | "set" | "remove">;
  readonly session?: SessionLookup;
  readonly location: { readonly directory: string };
  readonly permission: Pick<PluginContext["permission"], "assert">;
  readonly tool: Pick<PluginContext["tool"], "transform">;
}

function asTasks(value: unknown): PlanTask[] {
  if (!Array.isArray(value)) return [];
  const tasks: PlanTask[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id.trim() : "";
    const title = typeof obj.title === "string" ? obj.title.trim() : "";
    if (!id || !title) continue;
    const status =
      obj.status === "in_progress" || obj.status === "done" ? obj.status : "pending";
    const files = asStringArray(obj.files);
    const profiles = normalizeProfiles(asStringArray(obj.profiles));
    tasks.push({
      id,
      title,
      status,
      ...(files.length > 0 ? { files } : {}),
      ...(profiles.length > 0 ? { profiles } : {}),
    });
  }
  return tasks;
}

function asFindings(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) return [];
  const findings: ReviewFinding[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const severity =
      obj.severity === "critical" ||
      obj.severity === "major" ||
      obj.severity === "minor" ||
      obj.severity === "nit"
        ? obj.severity
        : "minor";
    const location = typeof obj.location === "string" ? obj.location : "unknown";
    const message = typeof obj.message === "string" ? obj.message : "";
    if (!message) continue;
    findings.push({ severity, location, message });
  }
  return findings;
}

async function runVerificationCommand(input: {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}): Promise<{ exitCode: number | null; timedOut: boolean; aborted: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const maxBytes = 16 * 1024;
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;

    const appendTail = (
      current: string,
      chunk: Buffer,
      wasTruncated: boolean,
    ): { value: string; truncated: boolean } => {
      const combined = current + chunk.toString("utf8");
      if (Buffer.byteLength(combined, "utf8") <= maxBytes && combined.length <= maxBytes) {
        return {value: combined, truncated: wasTruncated};
      }
      return {value: combined.slice(-maxBytes), truncated: true};
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const next = appendTail(stdout, chunk, stdoutTruncated);
      stdout = next.value;
      stdoutTruncated = next.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const next = appendTail(stderr, chunk, stderrTruncated);
      stderr = next.value;
      stderrTruncated = next.truncated;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);

    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };

    if (input.signal.aborted) {
      onAbort();
    } else {
      input.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      const finalStdout = stdoutTruncated
        ? `...[truncated earlier output; showing last 16KB]\n${stdout}`
        : stdout;
      const finalStderr = stderrTruncated
        ? `...[truncated earlier output; showing last 16KB]\n${stderr}`
        : stderr;
      resolve({exitCode, timedOut, aborted, stdout: finalStdout, stderr: finalStderr});
    });
  });
}

async function ensureState(
  ctx: ToolsContext,
  options: KitOptions,
  registry: ProfileRegistry,
  sessionID: string,
): Promise<WorkflowState> {
  const existing = await getWorkflowState(ctx.storage, sessionID);
  if (existing) return existing;

  const pipeline = options.defaultPipeline;
  const stages = getPipelineStages(pipeline, options.workflows);
  const profiles = options.autoDetectProfiles
    ? detectProfiles({ directory: ctx.location.directory, registry })
    : [];

  return createInitialWorkflowState({
    sessionID,
    pipeline,
    stage: stages[0] ?? "research",
    goal: "",
    profiles,
  });
}

export async function registerTools(
  ctx: ToolsContext,
  options: KitOptions,
  registry: ProfileRegistry,
): Promise<Registration> {
  return ctx.tool.transform((editor) => {
    editor.namespace({
      name: "swe",
      description: "Software Engineer workflow state, artifact persistence, and verification tools",
    });

    editor.add({
      name: "workflow_get",
      description:
        "Inspect the current session's SWE workflow stage, pipeline, active profiles, tasks, touched files, and saved artifacts. Use `section` to fetch a compact slice instead of full state.",
      input: {
        type: "object",
        properties: {
          section: {
            type: "string",
            enum: ["all", "summary", "research", "architecture", "plan", "test", "review"],
          },
        },
        additionalProperties: false,
      },
      options: { namespace: "swe", codemode: true },
      execute: async (rawInput, context) => {
        const input = (rawInput ?? {}) as Record<string, unknown>;
        const section = typeof input.section === "string" ? input.section : "all";
        const resolved = await resolveWorkflowSessionID({
          storage: ctx.storage,
          session: ctx.session,
          sessionID: context.sessionID,
        });
        const state = resolved.state;
        if (!state) {
          return {
            content: JSON.stringify({
              active: false,
              availablePipelines: options.workflows,
              stageSkills: options.stageSkills,
              availableProfiles: Object.keys(registry),
            }),
          };
        }

        const nextStage = getNextStage(state.stage, state.pipeline, options.workflows) ?? null;
        const mappedSkill = options.stageSkills[state.stage];

        if (section === "summary") {
          return {
            content: JSON.stringify({
              active: true,
              isSubagentChild: resolved.isChild,
              sessionID: state.sessionID,
              pipeline: state.pipeline,
              stage: state.stage,
              status: state.status,
              nextStage,
              mappedSkill,
              goal: state.goal,
              profiles: state.profiles,
              approvedGates: state.approvedGates,
              fixIterations: state.fixIterations,
              completed: Boolean(state.completed),
              ...(state.pendingGate ? {pendingGate: state.pendingGate} : {}),
              hasResearch: Boolean(state.research),
              hasArchitecture: Boolean(state.architecture),
              taskCounts: {
                total: state.tasks.length,
                done: state.tasks.filter((t) => t.status === "done").length,
                inProgress: state.tasks.filter((t) => t.status === "in_progress").length,
                pending: state.tasks.filter((t) => t.status === "pending").length,
              },
              touchedFilesCount: state.touchedFiles.length,
              testStatus: state.testResult?.status ?? null,
              reviewVerdict: state.reviewResult?.verdict ?? null,
            }),
          };
        }

        if (section === "research") {
          return {
            content: JSON.stringify({
              active: true,
              stage: state.stage,
              research: state.research ?? null,
            }),
          };
        }

        if (section === "architecture") {
          return {
            content: JSON.stringify({
              active: true,
              stage: state.stage,
              architecture: state.architecture ?? null,
            }),
          };
        }

        if (section === "plan") {
          return {
            content: JSON.stringify({
              active: true,
              stage: state.stage,
              tasks: state.tasks,
              acceptanceCriteria: state.acceptanceCriteria,
            }),
          };
        }

        if (section === "test") {
          return {
            content: JSON.stringify({
              active: true,
              stage: state.stage,
              touchedFiles: state.touchedFiles,
              testResult: state.testResult ?? null,
            }),
          };
        }

        if (section === "review") {
          return {
            content: JSON.stringify({
              active: true,
              stage: state.stage,
              reviewTarget: state.reviewTarget ?? null,
              touchedFiles: state.touchedFiles,
              reviewResult: state.reviewResult ?? null,
            }),
          };
        }

        return {
          content: JSON.stringify({
            active: true,
            isSubagentChild: resolved.isChild,
            state,
            nextStage,
            mappedSkill,
          }),
        };
      },
    });

    editor.add({
      name: "workflow_set",
      description:
        "Create, update, advance, or reset the SWE workflow state for the current session.",
      input: {
        type: "object",
        properties: {
          pipeline: { type: "string" },
          stage: { type: "string", enum: [...ALL_STAGES] },
          advance: { type: "boolean" },
          goal: { type: "string" },
          profiles: { type: "array", items: { type: "string" } },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "done"] },
                files: { type: "array", items: { type: "string" } },
                profiles: { type: "array", items: { type: "string" } },
              },
              required: ["id", "title"],
            },
          },
          acceptanceCriteria: { type: "array", items: { type: "string" } },
          reset: { type: "boolean" },
        },
        additionalProperties: false,
      },
      options: { namespace: "swe", codemode: true },
      execute: async (rawInput, context) => {
        const input = (rawInput ?? {}) as Record<string, unknown>;
        if (input.reset === true) {
          await clearWorkflowState(ctx.storage, context.sessionID);
          return { content: "Workflow state cleared for this session." };
        }

        const current = await ensureState(ctx, options, registry, context.sessionID);
        const pipeline =
          typeof input.pipeline === "string" && options.workflows[input.pipeline]
            ? input.pipeline
            : current.pipeline;

        let requestedStage: Stage | undefined;
        if (typeof input.stage === "string" && isStage(input.stage)) {
          requestedStage = input.stage;
        } else if (input.advance === true) {
          requestedStage = getNextStage(current.stage, pipeline, options.workflows);
        }

        const hasExplicitProfiles = input.profiles !== undefined;
        const profiles = hasExplicitProfiles
          ? normalizeProfiles(asStringArray(input.profiles)).filter((p) =>
            isKnownProfile(p, registry),
          )
          : current.profiles;

        const baseUpdated: WorkflowState = {
          ...current,
          pipeline,
          goal: typeof input.goal === "string" ? input.goal : current.goal,
          profiles,
          ...(hasExplicitProfiles ? {profilesLocked: true} : {}),
          tasks: input.tasks !== undefined ? asTasks(input.tasks) : current.tasks,
          acceptanceCriteria:
            input.acceptanceCriteria !== undefined
              ? asStringArray(input.acceptanceCriteria)
              : current.acceptanceCriteria,
        };

        if (requestedStage && requestedStage !== current.stage) {
          const transitionCheck = validateForwardTransition(baseUpdated, requestedStage, options);
          if (!transitionCheck.allowed) {
            return {
              content: JSON.stringify({
                error: transitionCheck.reason,
                stage: current.stage,
                pipeline: current.pipeline,
              }),
            };
          }
        }

        let nextState: WorkflowState;
        if (
          requestedStage &&
          requestedStage !== current.stage &&
          needsGateConfirmation(requestedStage, baseUpdated, options)
        ) {
          nextState = await saveWorkflowState(ctx.storage, {
            ...baseUpdated,
            completed: false,
            status: "awaiting_approval",
            pendingGate: createPendingGate({
              gate: requestedStage,
              targetStage: requestedStage,
              summary: `User approval required before entering "${requestedStage}" stage.`,
            }),
          });
        } else {
          nextState = await saveWorkflowState(ctx.storage, {
            ...baseUpdated,
            ...(requestedStage && requestedStage !== current.stage ? {completed: false} : {}),
            stage: requestedStage ?? current.stage,
          });
        }

        return {
          content: JSON.stringify({
            saved: true,
            sessionID: nextState.sessionID,
            pipeline: nextState.pipeline,
            stage: nextState.stage,
            status: nextState.status,
            profiles: nextState.profiles,
            taskCount: nextState.tasks.length,
            mappedSkill: options.stageSkills[nextState.stage],
            nextStage: getNextStage(nextState.stage, nextState.pipeline, options.workflows) ?? null,
            ...(nextState.pendingGate ? {pendingGate: nextState.pendingGate} : {}),
          }),
        };
      },
    });

    editor.add({
      name: "workflow_approve",
      description:
        "Unlock the active confirmation gate ONLY after the user has explicitly approved in chat or via question tool.",
      input: {
        type: "object",
        properties: {
          note: { type: "string" },
        },
        additionalProperties: false,
      },
      options: { namespace: "swe", codemode: true },
      execute: async (rawInput, context) => {
        const input = (rawInput ?? {}) as Record<string, unknown>;
        const current = await getWorkflowState(ctx.storage, context.sessionID);
        if (!current) {
          return { content: JSON.stringify({ approved: false, error: "No active workflow in this session." }) };
        }
        if (current.status !== "awaiting_approval" || !current.pendingGate) {
          return {
            content: JSON.stringify({
              approved: true,
              stage: current.stage,
              status: current.status,
              approvedGates: current.approvedGates,
            }),
          };
        }
        if (!current.pendingGate.userResponded) {
          return {
            content: JSON.stringify({
              approved: false,
              error:
                "Cannot approve gate before the user responds. Present the plan/summary to the user and wait for their reply.",
              pendingGate: current.pendingGate,
            }),
          };
        }

        const approvedState = await saveWorkflowState(ctx.storage, applyGateApproval(current));
        return {
          content: JSON.stringify({
            approved: true,
            ...(typeof input.note === "string" ? {note: input.note} : {}),
            stage: approvedState.stage,
            status: approvedState.status,
            approvedGates: approvedState.approvedGates,
            mappedSkill: options.stageSkills[approvedState.stage],
            nextStage: getNextStage(approvedState.stage, approvedState.pipeline, options.workflows) ?? null,
          }),
        };
      },
    });

    editor.add({
      name: "research_save",
      description:
        "Save structured research findings (relevant files, conventions, external docs, risks) to workflow state.",
      input: {
        type: "object",
        properties: {
          summary: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          conventions: { type: "array", items: { type: "string" } },
          externalRefs: { type: "array", items: { type: "string" } },
          risks: { type: "array", items: { type: "string" } },
        },
        required: ["summary"],
        additionalProperties: false,
      },
      options: { namespace: "swe", codemode: true },
      execute: async (rawInput, context) => {
        const input = (rawInput ?? {}) as Record<string, unknown>;
        const resolved = await resolveWorkflowSessionID({
          storage: ctx.storage,
          session: ctx.session,
          sessionID: context.sessionID,
        });
        const current = resolved.state ?? (await ensureState(ctx, options, registry, resolved.workflowSessionID));
        const files = asStringArray(input.files);

        const research: ResearchRecord = {
          summary: String(input.summary ?? ""),
          files,
          conventions: asStringArray(input.conventions),
          externalRefs: asStringArray(input.externalRefs),
          risks: asStringArray(input.risks),
        };

        let profiles = current.profiles;
        if (options.autoDetectProfiles && !current.profilesLocked) {
          const detected = detectProfiles({
            promptText: current.goal,
            files,
            directory: ctx.location.directory,
            registry,
          });
          profiles = normalizeProfiles(detected);
        }

        const saved = await saveWorkflowState(ctx.storage, {
          ...current,
          profiles,
          research,
        });

        return {
          content: JSON.stringify({
            saved: true,
            workflowSessionID: saved.sessionID,
            profiles: saved.profiles,
            fileCount: saved.research?.files.length ?? 0,
            riskCount: saved.research?.risks.length ?? 0,
          }),
        };
      },
    });

    editor.add({
      name: "architecture_save",
      description:
        "Save the technical architecture spec (components, API/type contracts, SQL/data migrations, trade-offs, non-goals).",
      input: {
        type: "object",
        properties: {
          summary: { type: "string" },
          components: { type: "array", items: { type: "string" } },
          contracts: { type: "array", items: { type: "string" } },
          dataAndMigrations: { type: "array", items: { type: "string" } },
          tradeOffs: { type: "array", items: { type: "string" } },
          nonGoals: { type: "array", items: { type: "string" } },
        },
        required: ["summary"],
        additionalProperties: false,
      },
      options: { namespace: "swe", codemode: true },
      execute: async (rawInput, context) => {
        const input = (rawInput ?? {}) as Record<string, unknown>;
        const current = await ensureState(ctx, options, registry, context.sessionID);
        const architecture: ArchitectureRecord = {
          summary: String(input.summary ?? ""),
          components: asStringArray(input.components),
          contracts: asStringArray(input.contracts),
          dataAndMigrations: asStringArray(input.dataAndMigrations),
          tradeOffs: asStringArray(input.tradeOffs),
          nonGoals: asStringArray(input.nonGoals),
        };

        const saved = await saveWorkflowState(ctx.storage, {
          ...current,
          architecture,
        });

        return {
          content: JSON.stringify({
            saved: true,
            stage: saved.stage,
            componentCount: saved.architecture?.components.length ?? 0,
            contractCount: saved.architecture?.contracts.length ?? 0,
          }),
        };
      },
    });

    editor.add({
      name: "verify",
      description:
        "Execute a test, typecheck, or lint verification command in the project workspace with OpenCode permission checks.",
      input: {
        type: "object",
        properties: {
          command: { type: "string" },
          subdir: { type: "string" },
          timeoutMs: { type: "number" },
        },
        required: ["command"],
        additionalProperties: false,
      },
      options: { namespace: "swe", codemode: true },
      execute: async (rawInput, context) => {
        const input = (rawInput ?? {}) as Record<string, unknown>;
        const command = typeof input.command === "string" ? input.command.trim() : "";
        if (!command) {
          return { content: JSON.stringify({ error: "command must be a non-empty string" }) };
        }

        const rawSubdir = typeof input.subdir === "string" ? input.subdir.trim() : "";
        const cwd = rawSubdir
          ? path.resolve(ctx.location.directory, rawSubdir)
          : ctx.location.directory;
        const rel = path.relative(ctx.location.directory, cwd);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          return { content: JSON.stringify({ error: "subdir must stay within project directory" }) };
        }

        await ctx.permission.assert({
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.messageID, id: context.id },
          action: "shell",
          resources: [command],
          save: [command],
        });

        await context.progress({ status: "running", command });

        const timeoutMs =
          typeof input.timeoutMs === "number" && input.timeoutMs > 0
            ? Math.min(input.timeoutMs, 300_000)
            : 120_000;

        const result = await runVerificationCommand({
          command,
          cwd,
          timeoutMs,
          signal: context.signal,
        });

        return {
          content: JSON.stringify({
            command,
            cwd,
            passed: result.exitCode === 0 && !result.timedOut && !result.aborted,
            ...result,
          }),
        };
      },
    });

    editor.add({
      name: "test_record",
      description:
        "Record structured Tester stage results (status, commands executed, summary, untested gaps) for Reviewer inspection.",
      input: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["passed", "failed"] },
          commands: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
          gaps: { type: "array", items: { type: "string" } },
        },
        required: ["status", "summary"],
        additionalProperties: false,
      },
      options: { namespace: "swe", codemode: true },
      execute: async (rawInput, context) => {
        const input = (rawInput ?? {}) as Record<string, unknown>;
        const current = await ensureState(ctx, options, registry, context.sessionID);
        const testResult: TestRecord = {
          status: input.status === "failed" ? "failed" : "passed",
          commands: asStringArray(input.commands),
          summary: String(input.summary ?? ""),
          gaps: asStringArray(input.gaps),
        };

        const transitionResult = applyTestRecordTransition(current, testResult, options);
        const saved = await saveWorkflowState(ctx.storage, transitionResult.nextState);

        return {
          content: JSON.stringify({
            saved: true,
            status: saved.testResult?.status,
            stage: saved.stage,
            workflowStatus: saved.status,
            transition: transitionResult.transition,
            fixIterations: saved.fixIterations,
            maxFixIterations: options.maxFixIterations,
            circuitBreakerTriggered: transitionResult.circuitBreakerTriggered,
            ...(saved.pendingGate ? {pendingGate: saved.pendingGate} : {}),
          }),
        };
      },
    });

    editor.add({
      name: "review_record",
      description:
        "Record the Reviewer stage verdict (approved or changes_requested) and severity-ordered file:line findings.",
      input: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["approved", "changes_requested"] },
          summary: { type: "string" },
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                severity: { type: "string", enum: ["critical", "major", "minor", "nit"] },
                location: { type: "string" },
                message: { type: "string" },
              },
              required: ["severity", "location", "message"],
            },
          },
        },
        required: ["verdict", "summary"],
        additionalProperties: false,
      },
      options: { namespace: "swe", codemode: true },
      execute: async (rawInput, context) => {
        const input = (rawInput ?? {}) as Record<string, unknown>;
        const resolved = await resolveWorkflowSessionID({
          storage: ctx.storage,
          session: ctx.session,
          sessionID: context.sessionID,
        });
        const current = resolved.state ?? (await ensureState(ctx, options, registry, resolved.workflowSessionID));
        const reviewResult: ReviewRecord = {
          verdict: input.verdict === "changes_requested" ? "changes_requested" : "approved",
          summary: String(input.summary ?? ""),
          findings: asFindings(input.findings),
        };

        const stages = getPipelineStages(current.pipeline, options.workflows);
        if (
          options.strictTransitions &&
          reviewResult.verdict === "approved" &&
          stages.includes("test") &&
          current.testResult?.status !== "passed"
        ) {
          return {
            content: JSON.stringify({
              saved: false,
              error:
                'Cannot record review verdict "approved" when pipeline includes "test" and testResult.status is not "passed". Record passing test evidence via `swe_test_record` or submit "changes_requested".',
            }),
          };
        }

        const transitionResult = applyReviewRecordTransition(current, reviewResult, options);
        const saved = await saveWorkflowState(ctx.storage, transitionResult.nextState);

        return {
          content: JSON.stringify({
            saved: true,
            workflowSessionID: saved.sessionID,
            verdict: saved.reviewResult?.verdict,
            findingCount: saved.reviewResult?.findings.length ?? 0,
            stage: saved.stage,
            workflowStatus: saved.status,
            completed: Boolean(saved.completed),
            transition: transitionResult.transition,
            fixIterations: saved.fixIterations,
            maxFixIterations: options.maxFixIterations,
            circuitBreakerTriggered: transitionResult.circuitBreakerTriggered,
            ...(saved.pendingGate ? {pendingGate: saved.pendingGate} : {}),
          }),
        };
      },
    });
  });
}
