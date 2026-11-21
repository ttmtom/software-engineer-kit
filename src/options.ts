import type { PluginOptions } from "@opencode/plugin";
import {
  BUILTIN_PIPELINES,
  DEFAULT_ORCHESTRATOR_SKILL,
  DEFAULT_STAGE_ACCESS,
  DEFAULT_STAGE_SKILLS,
  isStage,
  type OverlayStage,
  type Stage,
  type StageAccess,
} from "./workflows/pipelines.ts";

export type ProfileSections = Partial<Record<OverlayStage, string>>;

export interface KitOptions {
  readonly agentId: string;
  readonly autoStartOnAgentPrompt: boolean;
  readonly scopeToAgent: boolean;
  readonly setDefaultAgent: boolean;
  readonly registerBundledSkills: boolean;
  readonly overrideExistingSkills: boolean;
  readonly autoInjectContext: boolean;
  readonly trackFileEdits: boolean;
  readonly autoDetectProfiles: boolean;
  readonly defaultPipeline: string;
  readonly confirmBefore: readonly string[];
  readonly orchestratorSkill: string;
  readonly stageSkills: Readonly<Record<Stage, string>>;
  readonly stageAccess: Readonly<Record<Stage, StageAccess>>;
  readonly workflows: Readonly<Record<string, readonly Stage[]>>;
  readonly profiles: Readonly<Record<string, ProfileSections>>;
  readonly verifyCommands: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

import { asStringArray } from "./utils.ts";

function parseStageSkills(raw: unknown): Record<Stage, string> {
  const result: Record<Stage, string> = { ...DEFAULT_STAGE_SKILLS };
  if (!isRecord(raw)) return result;

  for (const stage of Object.keys(result) as Stage[]) {
    const custom = asString(raw[stage]);
    if (custom) result[stage] = custom;
  }
  return result;
}

function parseStageAccess(raw: unknown): Record<Stage, StageAccess> {
  const result: Record<Stage, StageAccess> = { ...DEFAULT_STAGE_ACCESS };
  if (!isRecord(raw)) return result;

  for (const stage of Object.keys(result) as Stage[]) {
    const val = raw[stage];
    if (val === "readonly" || val === "write") {
      result[stage] = val;
    }
  }
  return result;
}

function parseWorkflows(raw: unknown): Record<string, readonly Stage[]> {
  const result: Record<string, readonly Stage[]> = { ...BUILTIN_PIPELINES };
  if (!isRecord(raw)) return result;

  for (const [name, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    const stages = list.filter((item): item is Stage => typeof item === "string" && isStage(item));
    if (stages.length > 0) {
      result[name] = stages;
    }
  }
  return result;
}

function parseProfiles(raw: unknown): Record<string, ProfileSections> {
  const result: Record<string, ProfileSections> = {};
  if (!isRecord(raw)) return result;

  const keys: OverlayStage[] = ["architecture", "implement", "test", "review"];
  for (const [name, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue;
    const normalized = name.trim().toLowerCase();
    if (!normalized) continue;

    const sections: ProfileSections = {};
    for (const key of keys) {
      const text = asString(entry[key]);
      if (text) sections[key] = text;
    }
    if (Object.keys(sections).length > 0) {
      result[normalized] = sections;
    }
  }
  return result;
}

export const DEFAULT_CONFIRM_BEFORE: readonly string[] = ["implement", "test"];

function parseConfirmBefore(raw: unknown): readonly string[] {
  if (raw === undefined) return DEFAULT_CONFIRM_BEFORE;
  if (raw === "none" || raw === false) return [];
  if (raw === "all") return ["start", "research", "architecture", "plan", "implement", "test", "review"];
  if (!Array.isArray(raw)) return DEFAULT_CONFIRM_BEFORE;

  const valid = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const clean = item.trim();
    if (clean === "start" || isStage(clean)) valid.add(clean);
  }
  return Array.from(valid);
}

export function parseOptions(raw: PluginOptions | undefined): KitOptions {
  const obj: Record<string, unknown> = isRecord(raw) ? raw : {};
  const workflows = parseWorkflows(obj.workflows);
  const requestedDefault = asString(obj.defaultPipeline) ?? "feature";
  const defaultPipeline = workflows[requestedDefault] ? requestedDefault : "feature";

  return {
    agentId: asString(obj.agentId) ?? "swe-agent",
    autoStartOnAgentPrompt: asBoolean(obj.autoStartOnAgentPrompt, true),
    scopeToAgent: asBoolean(obj.scopeToAgent, true),
    setDefaultAgent: asBoolean(obj.setDefaultAgent, false),
    registerBundledSkills: asBoolean(obj.registerBundledSkills, true),
    overrideExistingSkills: asBoolean(obj.overrideExistingSkills, false),
    autoInjectContext: asBoolean(obj.autoInjectContext, true),
    trackFileEdits: asBoolean(obj.trackFileEdits, true),
    autoDetectProfiles: asBoolean(obj.autoDetectProfiles, true),
    defaultPipeline,
    confirmBefore: parseConfirmBefore(obj.confirmBefore),
    orchestratorSkill: asString(obj.orchestratorSkill) ?? DEFAULT_ORCHESTRATOR_SKILL,
    stageSkills: parseStageSkills(obj.skills),
    stageAccess: parseStageAccess(obj.stageAccess),
    workflows,
    profiles: parseProfiles(obj.profiles),
    verifyCommands: asStringArray(obj.verifyCommands),
  };
}
