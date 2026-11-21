import type { PluginContext, Registration } from "../types.ts";
import type { KitOptions } from "../options.ts";
import {
  detectProfiles,
  isKnownProfile,
  normalizeProfileName,
  normalizeProfiles,
  type ProfileRegistry,
} from "../skills/profiles.ts";
import { getPipelineStages, type Stage } from "../workflows/pipelines.ts";
import {
  applyGateApproval,
  createInitialWorkflowState,
  createPendingGate,
  getWorkflowState,
  saveWorkflowState,
} from "../workflows/state.ts";

export interface ParsedCommandArgs {
  readonly mode?: string;
  readonly profiles: readonly string[];
  readonly text: string;
}

export function parseOrchestrateArgs(
  rawText: string,
  registry: ProfileRegistry,
  workflows: Readonly<Record<string, readonly Stage[]>>,
): ParsedCommandArgs {
  const tokens = rawText.trim().split(/\s+/).filter(Boolean);
  let mode: string | undefined;
  const profiles: string[] = [];
  const rest: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if ((token === "--mode" || token === "-m") && i + 1 < tokens.length) {
      const candidate = tokens[i + 1];
      if (workflows[candidate]) mode = candidate;
      i++;
      continue;
    }
    if ((token === "--profiles" || token === "-p") && i + 1 < tokens.length) {
      const list = tokens[i + 1].split(",").map(normalizeProfileName);
      for (const p of list) {
        if (isKnownProfile(p, registry)) profiles.push(p);
      }
      i++;
      continue;
    }
    rest.push(token);
  }

  return {
    mode,
    profiles: normalizeProfiles(profiles),
    text: rest.join(" "),
  };
}

export function parseImplementArgs(
  rawText: string,
  registry: ProfileRegistry,
): { readonly profiles: readonly string[]; readonly text: string } {
  const parsed = parseOrchestrateArgs(rawText, registry, {});
  const tokens = parsed.text.split(/\s+/).filter(Boolean);
  const profiles = [...parsed.profiles];

  let idx = 0;
  while (idx < tokens.length) {
    const candidate = normalizeProfileName(tokens[idx].replace(/,$/, ""));
    if (isKnownProfile(candidate, registry)) {
      profiles.push(candidate);
      idx++;
    } else {
      break;
    }
  }

  return {
    profiles: normalizeProfiles(profiles),
    text: tokens.slice(idx).join(" "),
  };
}

async function resolveSkillNote(ctx: PluginContext, skillId: string): Promise<string> {
  const { data: skills } = await ctx.skill.list();
  const match = skills.find((s) => s.id === skillId);
  return match
    ? `Load and follow skill \`${skillId}\` (\`skill({ id: "${skillId}" })\`).`
    : `Follow the "${skillId}" stage discipline (skill \`${skillId}\` not found in registry).`;
}

async function enterStage(input: {
  readonly ctx: PluginContext;
  readonly options: KitOptions;
  readonly registry: ProfileRegistry;
  readonly sessionID: string;
  readonly stage: Stage;
  readonly goalText: string;
  readonly explicitProfiles?: readonly string[];
  readonly pipelineOverride?: string;
}): Promise<{ skillId: string; skillNote: string; profiles: readonly string[]; pipeline: string }> {
  const existing = await getWorkflowState(input.ctx.storage, input.sessionID);
  const pipeline = input.pipelineOverride ?? existing?.pipeline ?? input.options.defaultPipeline;
  const goal = input.goalText || existing?.goal || "";

  let profiles = existing?.profiles ?? [];
  if (input.explicitProfiles && input.explicitProfiles.length > 0) {
    profiles = normalizeProfiles([...profiles, ...input.explicitProfiles]);
  } else if (profiles.length === 0 && input.options.autoDetectProfiles) {
    profiles = detectProfiles({
      promptText: goal,
      files: existing?.touchedFiles ?? existing?.research?.files,
      directory: input.ctx.location.directory,
      registry: input.registry,
    });
  }

  const base =
    existing ??
    createInitialWorkflowState({
      sessionID: input.sessionID,
      pipeline,
      stage: input.stage,
      goal,
      profiles,
    });

  const approved = new Set(base.approvedGates);
  approved.add(input.stage);

  await saveWorkflowState(input.ctx.storage, {
    ...base,
    pipeline,
    stage: input.stage,
    status: "active",
    pendingGate: undefined,
    approvedGates: Array.from(approved),
    goal,
    profiles,
  });

  const skillId = input.options.stageSkills[input.stage];
  const skillNote = await resolveSkillNote(input.ctx, skillId);
  return { skillId, skillNote, profiles, pipeline };
}

export async function registerCommands(
  ctx: PluginContext,
  options: KitOptions,
  registry: ProfileRegistry,
): Promise<Registration> {
  return ctx.command.transform((editor) => {
    editor.add({
      name: "kit-orchestrate",
      description:
        "Start a Software Engineer Kit workflow (--mode feature|bugfix|quick, --profiles backend/golang,sql)",
      execute: async ({ sessionID, prompt, delivery }) => {
        const parsed = parseOrchestrateArgs(prompt.text, registry, options.workflows);
        const pipeline = parsed.mode ?? options.defaultPipeline;
        const stages = getPipelineStages(pipeline, options.workflows);
        const firstStage = stages[0] ?? "research";

        const profiles =
          parsed.profiles.length > 0
            ? parsed.profiles
            : options.autoDetectProfiles
              ? detectProfiles({
                  promptText: parsed.text,
                  directory: ctx.location.directory,
                  registry,
                })
              : [];

        const requireStartConfirm = options.confirmBefore.includes("start");
        const initialState = createInitialWorkflowState({
          sessionID,
          pipeline,
          stage: firstStage,
          goal: parsed.text,
          profiles,
          status: requireStartConfirm ? "awaiting_approval" : "active",
          ...(requireStartConfirm
            ? {
                pendingGate: createPendingGate({
                  gate: "start",
                  targetStage: firstStage,
                  summary:
                    "Draft the orchestration plan (pipeline, detected profiles, scope, and assumptions) and wait for user approval before starting research.",
                }),
              }
            : {}),
        });

        await saveWorkflowState(ctx.storage, initialState);

        const orchestratorNote = await resolveSkillNote(ctx, options.orchestratorSkill);
        const firstStageSkill = options.stageSkills[firstStage];

        await ctx.session.prompt({
          ...prompt,
          sessionID,
          delivery,
          text: requireStartConfirm
            ? [
                `Draft a Software Engineer Kit orchestration plan and ask the user for approval before starting.`,
                `- Pipeline: \`${pipeline}\` (${stages.join(" -> ")})`,
                `- First stage after approval: \`${firstStage}\` (mapped skill: \`${firstStageSkill}\`)`,
                `- Detected profiles: ${profiles.length > 0 ? profiles.join(", ") : "none"}`,
                `- Confirmation gates configured before: ${options.confirmBefore.join(", ") || "none"}`,
                `- ${orchestratorNote}`,
                `- DO NOT start \`${firstStage}\` or edit files yet. Present the proposed pipeline, profiles, and high-level plan, then wait for the user's approval (or \`/kit-approve\`).`,
                parsed.text ? `\nTask:\n${parsed.text}` : "",
              ]
                .filter(Boolean)
                .join("\n")
            : [
                `Start Software Engineer Kit workflow.`,
                `- Pipeline: \`${pipeline}\` (${stages.join(" -> ")})`,
                `- Starting stage: \`${firstStage}\` (mapped skill: \`${firstStageSkill}\`)`,
                `- Active profiles: ${profiles.length > 0 ? profiles.join(", ") : "auto/none"}`,
                `- ${orchestratorNote}`,
                `- Also load \`${firstStageSkill}\` for stage 1, record its artifact, and advance with \`kit_workflow_set\`.`,
                parsed.text ? `\nTask:\n${parsed.text}` : "",
              ]
                .filter(Boolean)
                .join("\n"),
        });
      },
    });

    editor.add({
      name: "kit-approve",
      description: "Approve the pending Software Engineer Kit confirmation gate and proceed",
      execute: async ({ sessionID, prompt, delivery }) => {
        const current = await getWorkflowState(ctx.storage, sessionID);
        if (!current) {
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            delivery,
            text: "No Software Engineer Kit workflow is active in this session. Start one with `/kit-orchestrate <task>`.",
          });
          return;
        }

        const approvedState = await saveWorkflowState(ctx.storage, applyGateApproval(current));
        const stageSkill = options.stageSkills[approvedState.stage];
        const skillNote = await resolveSkillNote(ctx, stageSkill);

        await ctx.session.prompt({
          ...prompt,
          sessionID,
          delivery,
          text: [
            `User approved the pending gate. Proceed with stage \`${approvedState.stage}\`.`,
            `- Pipeline: \`${approvedState.pipeline}\``,
            `- ${skillNote}`,
            `- Active profiles: ${approvedState.profiles.length > 0 ? approvedState.profiles.join(", ") : "none"}`,
            prompt.text.trim() ? `\nUser note:\n${prompt.text.trim()}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        });
      },
    });

    const stageCommands: readonly { name: string; stage: Stage; description: string }[] = [
      {
        name: "kit-research",
        stage: "research",
        description: "Run read-only codebase + web research and save findings",
      },
      {
        name: "kit-architect",
        stage: "architecture",
        description: "Design architecture contracts, schemas, and trade-offs",
      },
      {
        name: "kit-plan",
        stage: "plan",
        description: "Break requirements & architecture into tasks and acceptance criteria",
      },
      {
        name: "kit-test",
        stage: "test",
        description: "Author tests, execute verification commands, and record evidence",
      },
      {
        name: "kit-review",
        stage: "review",
        description: "Review diff against architecture, acceptance criteria, and test results",
      },
    ];

    for (const cmd of stageCommands) {
      editor.add({
        name: cmd.name,
        description: cmd.description,
        execute: async ({ sessionID, prompt, delivery }) => {
          const { skillNote, profiles } = await enterStage({
            ctx,
            options,
            registry,
            sessionID,
            stage: cmd.stage,
            goalText: prompt.text.trim(),
          });

          await ctx.session.prompt({
            ...prompt,
            sessionID,
            delivery,
            text: [
              `Enter Software Engineer Kit stage: \`${cmd.stage}\`.`,
              `- ${skillNote}`,
              `- Active profiles: ${profiles.length > 0 ? profiles.join(", ") : "none"}`,
              prompt.text.trim() ? `\nFocus:\n${prompt.text.trim()}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          });
        },
      });
    }

    editor.add({
      name: "kit-implement",
      description:
        "Implement planned changes using domain/language profiles (e.g. /kit-implement backend sql golang)",
      execute: async ({ sessionID, prompt, delivery }) => {
        const parsed = parseImplementArgs(prompt.text, registry);
        const { skillNote, profiles } = await enterStage({
          ctx,
          options,
          registry,
          sessionID,
          stage: "implement",
          goalText: parsed.text,
          explicitProfiles: parsed.profiles,
        });

        await ctx.session.prompt({
          ...prompt,
          sessionID,
          delivery,
          text: [
            `Enter Software Engineer Kit stage: \`implement\`.`,
            `- ${skillNote}`,
            `- Active domain/language profiles: ${profiles.length > 0 ? profiles.join(", ") : "none"}`,
            parsed.text ? `\nFocus:\n${parsed.text}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        });
      },
    });
  });
}
