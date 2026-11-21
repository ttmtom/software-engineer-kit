import { execFileSync } from "node:child_process";
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
  createInitialWorkflowState,
  createPendingGate,
  getWorkflowState,
  saveWorkflowState,
} from "../workflows/state.ts";

export interface ParsedCommandArgs {
  readonly profiles: readonly string[];
  readonly text: string;
}

export interface ParsedReviewerArgs {
  readonly profiles: readonly string[];
  readonly commit?: string;
  readonly text: string;
}

export interface GitReviewTarget {
  readonly mode: "uncommitted" | "commit" | "range";
  readonly ref?: string;
  readonly resolvedSha?: string;
  readonly changedFiles: readonly string[];
  readonly gitCommandHint: string;
}

export function parsePipelineArgs(
  rawText: string,
  registry: ProfileRegistry,
): ParsedCommandArgs {
  const tokens = rawText.trim().split(/\s+/).filter(Boolean);
  const profiles: string[] = [];
  const rest: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
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
    profiles: normalizeProfiles(profiles),
    text: rest.join(" "),
  };
}

function runGit(args: readonly string[], cwd: string): string | undefined {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function looksLikeCommitOrRef(token: string, cwd?: string): boolean {
  if (!token || token.startsWith("-")) return false;
  if (token.includes("..")) return true;
  if (/^(HEAD([~^]\d*)*|[0-9a-f]{4,40})$/i.test(token)) {
    return cwd ? runGit(["rev-parse", "--verify", "--quiet", `${token}^{commit}`], cwd) !== undefined : true;
  }
  if (cwd) {
    return runGit(["rev-parse", "--verify", "--quiet", `${token}^{commit}`], cwd) !== undefined;
  }
  return false;
}

export function parseReviewerArgs(
  rawText: string,
  registry: ProfileRegistry,
  cwd?: string,
): ParsedReviewerArgs {
  const tokens = rawText.trim().split(/\s+/).filter(Boolean);
  const profiles: string[] = [];
  let explicitCommit: string | undefined;
  const rest: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if ((token === "--profiles" || token === "-p") && i + 1 < tokens.length) {
      const list = tokens[i + 1].split(",").map(normalizeProfileName);
      for (const p of list) {
        if (isKnownProfile(p, registry)) profiles.push(p);
      }
      i++;
      continue;
    }
    if ((token === "--commit" || token === "-c") && i + 1 < tokens.length) {
      explicitCommit = tokens[i + 1];
      i++;
      continue;
    }
    rest.push(token);
  }

  let commit = explicitCommit;
  let remaining = rest;
  if (!commit && rest.length > 0 && looksLikeCommitOrRef(rest[0], cwd)) {
    commit = rest[0];
    remaining = rest.slice(1);
  }

  return {
    profiles: normalizeProfiles(profiles),
    ...(commit ? { commit } : {}),
    text: remaining.join(" "),
  };
}

export function inspectGitReviewTarget(
  cwd: string,
  commit?: string,
): GitReviewTarget {
  if (!commit) {
    const statusOut = runGit(["status", "--porcelain"], cwd) ?? "";
    const changedFiles = statusOut
      .split("\n")
      .map((line) => line.slice(3).trim())
      .map((entry) => (entry.includes(" -> ") ? entry.split(" -> ").pop()!.trim() : entry))
      .filter(Boolean);

    return {
      mode: "uncommitted",
      changedFiles,
      gitCommandHint: "git status --short && git diff && git diff --cached",
    };
  }

  if (commit.includes("..")) {
    const filesOut = runGit(["diff", "--name-only", commit], cwd) ?? "";
    const changedFiles = filesOut.split("\n").map((f) => f.trim()).filter(Boolean);
    return {
      mode: "range",
      ref: commit,
      changedFiles,
      gitCommandHint: `git diff ${commit}`,
    };
  }

  const resolvedSha = runGit(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], cwd);
  const filesOut = resolvedSha
    ? (runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", resolvedSha], cwd) ?? "")
    : "";
  const changedFiles = filesOut.split("\n").map((f) => f.trim()).filter(Boolean);

  return {
    mode: "commit",
    ref: commit,
    ...(resolvedSha ? { resolvedSha } : {}),
    changedFiles,
    gitCommandHint: `git show ${resolvedSha ?? commit}`,
  };
}

async function resolveSkillNote(ctx: PluginContext, skillId: string): Promise<string> {
  const { data: skills } = await ctx.skill.list();
  const match = skills.find((s) => s.id === skillId);
  return match
    ? `Load and follow skill \`${skillId}\` (\`skill({ id: "${skillId}" })\`).`
    : `Follow the "${skillId}" stage discipline (skill \`${skillId}\` not found in registry).`;
}

type CommandInvocation = Parameters<
  Parameters<Parameters<PluginContext["command"]["transform"]>[0]>[0]["add"]
>[0]["execute"] extends (input: infer I) => Promise<void>
  ? I
  : never;

async function startPipelineWorkflow(input: {
  readonly ctx: PluginContext;
  readonly options: KitOptions;
  readonly registry: ProfileRegistry;
  readonly sessionID: CommandInvocation["sessionID"];
  readonly prompt: CommandInvocation["prompt"];
  readonly delivery: CommandInvocation["delivery"];
  readonly pipeline: string;
}): Promise<void> {
  const { ctx, options, registry, sessionID, prompt, delivery, pipeline } = input;
  const parsed = parsePipelineArgs(prompt.text, registry);
  const stages: readonly Stage[] = getPipelineStages(pipeline, options.workflows);
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
          `Draft an SWE orchestration plan and ask the user for approval before starting.`,
          `- Pipeline: \`${pipeline}\` (${stages.join(" -> ")})`,
          `- First stage after approval: \`${firstStage}\` (mapped skill: \`${firstStageSkill}\`)`,
          `- Detected profiles: ${profiles.length > 0 ? profiles.join(", ") : "none"}`,
          `- Confirmation gates configured before: ${options.confirmBefore.join(", ") || "none"}`,
          `- ${orchestratorNote}`,
          `- DO NOT start \`${firstStage}\` or edit files yet. Present the proposed pipeline, profiles, and high-level plan, then wait for the user's approval.`,
          parsed.text ? `\nTask:\n${parsed.text}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : [
          `Start SWE workflow.`,
          `- Pipeline: \`${pipeline}\` (${stages.join(" -> ")})`,
          `- Starting stage: \`${firstStage}\` (mapped skill: \`${firstStageSkill}\`)`,
          `- Active profiles: ${profiles.length > 0 ? profiles.join(", ") : "auto/none"}`,
          `- ${orchestratorNote}`,
          `- Also load \`${firstStageSkill}\` for stage 1, record its artifact, and advance with \`swe_workflow_set\`.`,
          parsed.text ? `\nTask:\n${parsed.text}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
  });
}

export async function registerCommands(
  ctx: PluginContext,
  options: KitOptions,
  registry: ProfileRegistry,
): Promise<Registration> {
  return ctx.command.transform((editor) => {
    editor.add({
      name: "swe-feature",
      description:
        "Start the feature pipeline (research -> architecture -> plan -> implement -> test -> review)",
      execute: async ({ sessionID, prompt, delivery }) => {
        await startPipelineWorkflow({
          ctx,
          options,
          registry,
          sessionID,
          prompt,
          delivery,
          pipeline: "feature",
        });
      },
    });

    editor.add({
      name: "swe-bugfix",
      description:
        "Start the bugfix pipeline (research -> plan -> implement -> test -> review)",
      execute: async ({ sessionID, prompt, delivery }) => {
        await startPipelineWorkflow({
          ctx,
          options,
          registry,
          sessionID,
          prompt,
          delivery,
          pipeline: "bugfix",
        });
      },
    });

    editor.add({
      name: "swe-quick",
      description: "Start the quick pipeline (research -> implement -> test)",
      execute: async ({ sessionID, prompt, delivery }) => {
        await startPipelineWorkflow({
          ctx,
          options,
          registry,
          sessionID,
          prompt,
          delivery,
          pipeline: "quick",
        });
      },
    });

    editor.add({
      name: "swe-reviewer",
      description:
        "Run SWE code review for a commit ID or uncommitted changes (default: uncommitted)",
      execute: async ({ sessionID, prompt, delivery }) => {
        const parsed = parseReviewerArgs(prompt.text, registry, ctx.location.directory);
        const gitTarget = inspectGitReviewTarget(ctx.location.directory, parsed.commit);
        const existing = await getWorkflowState(ctx.storage, sessionID);
        const pipeline = existing?.pipeline ?? "review";
        const reviewTargetLabel =
          gitTarget.mode === "uncommitted"
            ? "uncommitted changes"
            : gitTarget.mode === "range"
              ? `range ${gitTarget.ref}`
              : `commit ${gitTarget.resolvedSha ?? gitTarget.ref}`;
        const goal = parsed.text || existing?.goal || `Review ${reviewTargetLabel}`;

        const candidateFiles =
          gitTarget.changedFiles.length > 0
            ? gitTarget.changedFiles
            : (existing?.touchedFiles ?? existing?.research?.files);

        const profiles =
          parsed.profiles.length > 0
            ? normalizeProfiles([...(existing?.profiles ?? []), ...parsed.profiles])
            : existing && existing.profiles.length > 0 && !parsed.commit
              ? existing.profiles
              : options.autoDetectProfiles
                ? detectProfiles({
                    promptText: goal,
                    files: candidateFiles,
                    directory: ctx.location.directory,
                    registry,
                  })
                : [];

        const base =
          existing ??
          createInitialWorkflowState({
            sessionID,
            pipeline,
            stage: "review",
            goal,
            profiles,
          });

        const approved = new Set(base.approvedGates);
        approved.add("review");

        await saveWorkflowState(ctx.storage, {
          ...base,
          pipeline,
          stage: "review",
          status: "active",
          pendingGate: undefined,
          approvedGates: Array.from(approved),
          goal,
          reviewTarget: reviewTargetLabel,
          profiles,
        });

        const reviewSkill = options.stageSkills.review;
        const skillNote = await resolveSkillNote(ctx, reviewSkill);

        await ctx.session.prompt({
          ...prompt,
          sessionID,
          delivery,
          text: [
            `Run SWE code review (\`review\` stage).`,
            `- Target: ${reviewTargetLabel}`,
            `- Inspect diff via: \`${gitTarget.gitCommandHint}\``,
            gitTarget.changedFiles.length > 0
              ? `- Changed files (${gitTarget.changedFiles.length}): ${gitTarget.changedFiles.join(", ")}`
              : "",
            `- ${skillNote}`,
            `- Active profiles: ${profiles.length > 0 ? profiles.join(", ") : "none"}`,
            parsed.text ? `\nFocus:\n${parsed.text}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        });
      },
    });
  });
}
