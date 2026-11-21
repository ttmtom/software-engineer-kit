export type Stage =
  | "research"
  | "architecture"
  | "plan"
  | "implement"
  | "test"
  | "review";

export const ALL_STAGES: readonly Stage[] = [
  "research",
  "architecture",
  "plan",
  "implement",
  "test",
  "review",
] as const;

export type OverlayStage = "architecture" | "implement" | "test" | "review";

export const OVERLAY_STAGES: ReadonlySet<Stage> = new Set<Stage>([
  "architecture",
  "implement",
  "test",
  "review",
]);

export type BuiltinPipelineName = "feature" | "bugfix" | "quick" | "review";

export const DEFAULT_STAGE_SKILLS: Readonly<Record<Stage, string>> = {
  research: "swe-researcher",
  architecture: "swe-architect",
  plan: "swe-planner",
  implement: "swe-implementer",
  test: "swe-tester",
  review: "swe-reviewer",
};

export const DEFAULT_ORCHESTRATOR_SKILL = "swe-orchestrator";

export const BUILTIN_PIPELINES: Readonly<Record<BuiltinPipelineName, readonly Stage[]>> = {
  feature: ["research", "architecture", "plan", "implement", "test", "review"],
  bugfix: ["research", "plan", "implement", "test", "review"],
  quick: ["research", "implement", "test"],
  review: ["review"],
};

export function isStage(value: string): value is Stage {
  return (ALL_STAGES as readonly string[]).includes(value);
}

export function isOverlayStage(stage: Stage): stage is OverlayStage {
  return OVERLAY_STAGES.has(stage);
}

export function getPipelineStages(
  pipeline: string,
  workflows: Readonly<Record<string, readonly Stage[]>>,
): readonly Stage[] {
  return workflows[pipeline] ?? workflows.feature ?? BUILTIN_PIPELINES.feature;
}

export function getNextStage(
  current: Stage,
  pipeline: string,
  workflows: Readonly<Record<string, readonly Stage[]>>,
): Stage | undefined {
  const stages = getPipelineStages(pipeline, workflows);
  const index = stages.indexOf(current);
  if (index === -1 || index + 1 >= stages.length) return undefined;
  return stages[index + 1];
}
