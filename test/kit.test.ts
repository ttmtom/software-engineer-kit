import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  inspectGitReviewTarget,
  parsePipelineArgs,
  parseReviewerArgs,
} from "../src/commands/index.ts";
import { checkToolAllowedDuringGate, extractTouchedFilePaths } from "../src/hooks/index.ts";
import { parseOptions } from "../src/options.ts";
import { loadBundledSkills, parseSkillMarkdown } from "../src/skills/loader.ts";
import {
  detectProfiles,
  expandProfileChain,
  loadProfileRegistry,
  normalizeProfiles,
  renderStageOverlays,
} from "../src/skills/profiles.ts";
import { getNextStage } from "../src/workflows/pipelines.ts";
import {
  appendTouchedFiles,
  applyGateApproval,
  createInitialWorkflowState,
  createPendingGate,
  getWorkflowState,
  markGateUserResponded,
  needsGateConfirmation,
  renderWorkflowContext,
  saveWorkflowState,
} from "../src/workflows/state.ts";

function createMemoryStorage() {
  const map = new Map<string, unknown>();
  return {
    async get(key: string) {
      return map.get(key) as never;
    },
    async set(key: string, value: unknown) {
      map.set(key, value);
    },
    async remove(key: string) {
      map.delete(key);
    },
  };
}

test("loadBundledSkills loads all 7 core swe skills", () => {
  const skills = loadBundledSkills();
  const ids = skills.map((s) => s.id);
  assert.deepEqual(ids, [
    "swe-architect",
    "swe-implementer",
    "swe-orchestrator",
    "swe-planner",
    "swe-researcher",
    "swe-reviewer",
    "swe-tester",
  ]);
  for (const skill of skills) {
    assert.ok(skill.description && skill.description.length > 10);
    assert.ok(skill.content.length > 20);
  }
});

test("parseSkillMarkdown extracts metadata.opencode/autoinvoke", () => {
  const parsed = parseSkillMarkdown(
    `---\nname: Custom\ndescription: Desc\nmetadata:\n  opencode/autoinvoke: false\n---\n\nBody text`,
    "custom",
    "/tmp/SKILL.md",
  );
  assert.equal(parsed.id, "custom");
  assert.equal(parsed.name, "Custom");
  assert.equal(parsed.description, "Desc");
  assert.equal(parsed.autoinvoke, false);
  assert.equal(parsed.content, "Body text");
});

test("loadProfileRegistry loads hierarchical built-ins and merges custom profile overrides", () => {
  const registry = loadProfileRegistry({
    "backend/rust": {
      implement: "Use Result.",
      test: "Run cargo test.",
    },
    "backend/golang": {
      test: "Custom go test overlay",
    },
  });

  assert.ok(registry.frontend?.implement);
  assert.ok(registry["frontend/react"]?.implement);
  assert.ok(registry["frontend/typescript"]?.implement);
  assert.ok(registry["frontend/react/typescript"]?.implement);
  assert.ok(registry.backend?.review);
  assert.ok(registry["backend/golang"]?.implement);
  assert.ok(registry["backend/typescript"]?.implement);
  assert.ok(registry.sql?.architecture);
  assert.ok(registry.devops?.test);
  assert.equal(registry["backend/rust"]?.implement, "Use Result.");
  assert.equal(registry["backend/golang"]?.test, "Custom go test overlay");
  assert.ok(registry["backend/golang"]?.implement);
});

test("detectProfiles identifies backend/golang, frontend/react/typescript, and sql", () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "kit-fullstack-"));
  try {
    writeFileSync(path.join(tmpDir, "go.mod"), "module example.com/orders\n");
    mkdirSync(path.join(tmpDir, "migrations"));
    mkdirSync(path.join(tmpDir, "web"));
    writeFileSync(
      path.join(tmpDir, "web", "package.json"),
      JSON.stringify({ dependencies: { react: "^19.0.0" }, devDependencies: { typescript: "^5.7.0" } }),
    );
    writeFileSync(path.join(tmpDir, "web", "tsconfig.json"), "{}");

    const registry = loadProfileRegistry();
    const detected = detectProfiles({
      promptText: "Add cancel order button in React UI and POST /v1/orders/{id}/cancel endpoint",
      directory: tmpDir,
      registry,
    });

    assert.ok(detected.includes("backend/golang"));
    assert.ok(detected.includes("frontend/react/typescript"));
    assert.ok(detected.includes("sql"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("expandProfileChain and renderStageOverlays inherit ancestors without duplication", () => {
  const registry = loadProfileRegistry();
  const chain = expandProfileChain(["frontend/react/ts", "frontend", "go", "postgres"], registry);
  assert.deepEqual(chain, [
    "frontend",
    "frontend/react",
    "frontend/react/typescript",
    "backend",
    "backend/golang",
    "sql",
  ]);

  const implOverlay = renderStageOverlays(["frontend/react/ts", "go", "postgres"], "implement", registry);
  assert.match(implOverlay, /Profile: frontend \(implement\)/);
  assert.match(implOverlay, /Profile: frontend\/react \(implement\)/);
  assert.match(implOverlay, /Profile: frontend\/react\/typescript \(implement\)/);
  assert.match(implOverlay, /Profile: backend \(implement\)/);
  assert.match(implOverlay, /Profile: backend\/golang \(implement\)/);
  assert.match(implOverlay, /Profile: sql \(implement\)/);

  const testOverlay = renderStageOverlays(["backend/golang"], "test", registry);
  assert.match(testOverlay, /go test -race/);
  assert.doesNotMatch(testOverlay, /defer rows\.Close/);
});

test("parseOptions supports custom stage skills, workflows, and defaultPipeline", () => {
  const opts = parseOptions({
    defaultPipeline: "my-flow",
    skills: {
      research: "company-research",
    },
    workflows: {
      "my-flow": ["research", "plan", "architecture", "implement", "test", "review"],
    },
  });

  assert.equal(opts.defaultPipeline, "my-flow");
  assert.equal(opts.stageSkills.research, "company-research");
  assert.equal(opts.stageSkills.plan, "swe-planner");
  assert.equal(getNextStage("plan", "my-flow", opts.workflows), "architecture");
  assert.equal(getNextStage("test", "quick", opts.workflows), undefined);
  assert.equal(getNextStage("review", "review", opts.workflows), undefined);
});

test("workflow state persists, tracks touched files, and renders context", async () => {
  const storage = createMemoryStorage();
  const options = parseOptions(undefined);
  const registry = loadProfileRegistry();

  const initial = createInitialWorkflowState({
    sessionID: "ses_123",
    pipeline: "feature",
    stage: "implement",
    goal: "Add cancel endpoint",
    profiles: normalizeProfiles(["go", "backend", "sql"]),
  });
  await saveWorkflowState(storage, initial);

  await appendTouchedFiles(storage, "ses_123", [
    "internal/orders/handler.go",
    "internal/orders/handler.go",
    "internal/orders/store.go",
  ]);

  const loaded = await getWorkflowState(storage, "ses_123");
  assert.ok(loaded);
  assert.deepEqual(loaded.touchedFiles, [
    "internal/orders/handler.go",
    "internal/orders/store.go",
  ]);

  const rendered = renderWorkflowContext({ state: loaded, options, registry });
  assert.match(
    rendered,
    /<swe-workflow pipeline="feature" stage="implement" status="active" skill="swe-implementer">/,
  );
  assert.match(rendered, /Active Profiles: backend\/golang, backend, sql/);
  assert.match(rendered, /Active IMPLEMENT Overlays/);
});

test("command argument parser extracts profiles and remaining task text", () => {
  const registry = loadProfileRegistry();
  const parsed = parsePipelineArgs(
    "--profiles frontend/react/ts,go,sql Fix order cancellation",
    registry,
  );
  assert.deepEqual(parsed.profiles, ["frontend/react/typescript", "backend/golang", "sql"]);
  assert.equal(parsed.text, "Fix order cancellation");
});

test("parseReviewerArgs and inspectGitReviewTarget handle commit IDs and uncommitted default", () => {
  const registry = loadProfileRegistry();
  const tmpRepo = mkdtempSync(path.join(os.tmpdir(), "swe-review-git-"));
  try {
    execFileSync("git", ["init"], { cwd: tmpRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpRepo });
    execFileSync("git", ["config", "user.name", "Tester"], { cwd: tmpRepo });

    writeFileSync(path.join(tmpRepo, "handler.go"), "package main\n");
    execFileSync("git", ["add", "handler.go"], { cwd: tmpRepo });
    execFileSync("git", ["commit", "-m", "add handler"], { cwd: tmpRepo, stdio: "ignore" });
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: tmpRepo,
      encoding: "utf8",
    }).trim();

    // Uncommitted default
    writeFileSync(path.join(tmpRepo, "query.sql"), "SELECT 1;\n");
    const uncommittedArgs = parseReviewerArgs("--profiles go", registry, tmpRepo);
    assert.equal(uncommittedArgs.commit, undefined);
    assert.deepEqual(uncommittedArgs.profiles, ["backend/golang"]);

    const uncommittedTarget = inspectGitReviewTarget(tmpRepo, uncommittedArgs.commit);
    assert.equal(uncommittedTarget.mode, "uncommitted");
    assert.deepEqual(uncommittedTarget.changedFiles, ["query.sql"]);
    assert.match(uncommittedTarget.gitCommandHint, /git diff/);

    // Explicit commit ID + focus text
    const commitArgs = parseReviewerArgs(`${sha} check error wrapping`, registry, tmpRepo);
    assert.equal(commitArgs.commit, sha);
    assert.equal(commitArgs.text, "check error wrapping");

    const commitTarget = inspectGitReviewTarget(tmpRepo, commitArgs.commit);
    assert.equal(commitTarget.mode, "commit");
    assert.ok(commitTarget.resolvedSha);
    assert.deepEqual(commitTarget.changedFiles, ["handler.go"]);
    assert.match(commitTarget.gitCommandHint, /^git show /);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("extractTouchedFilePaths extracts paths from edit/write/patch inputs", () => {
  assert.deepEqual(extractTouchedFilePaths("edit", { filePath: "src/a.ts" }), ["src/a.ts"]);
  assert.deepEqual(extractTouchedFilePaths("write", { path: "src/b.ts" }), ["src/b.ts"]);
  assert.deepEqual(extractTouchedFilePaths("read", { filePath: "src/a.ts" }), []);
});

test("confirmation gates block mutating tools until user responds and gate is approved", async () => {
  const storage = createMemoryStorage();
  const options = parseOptions(undefined);
  const registry = loadProfileRegistry();

  assert.deepEqual(options.confirmBefore, ["start", "implement"]);

  const initial = createInitialWorkflowState({
    sessionID: "ses_gate",
    pipeline: "feature",
    stage: "research",
    goal: "Add cancel endpoint",
    profiles: ["golang", "backend", "sql"],
    status: "awaiting_approval",
    pendingGate: createPendingGate({
      gate: "start",
      targetStage: "research",
      summary: "Confirm drafted orchestration plan",
    }),
  });
  await saveWorkflowState(storage, initial);

  assert.equal(checkToolAllowedDuringGate("edit", initial).allowed, false);
  assert.equal(checkToolAllowedDuringGate("swe_research_save", initial).allowed, false);
  assert.equal(checkToolAllowedDuringGate("swe_workflow_get", initial).allowed, true);
  assert.equal(checkToolAllowedDuringGate("read", initial).allowed, true);

  const contextBefore = renderWorkflowContext({ state: initial, options, registry });
  assert.match(contextBefore, /CONFIRMATION GATE ACTIVE/);
  assert.match(contextBefore, /userResponded=false/);

  const afterReply = await markGateUserResponded(storage, "ses_gate");
  assert.ok(afterReply?.pendingGate?.userResponded);

  const unlocked = applyGateApproval(afterReply!);
  assert.equal(unlocked.status, "active");
  assert.equal(unlocked.stage, "research");
  assert.equal(unlocked.pendingGate, undefined);
  assert.deepEqual(unlocked.approvedGates, ["start"]);
  assert.equal(checkToolAllowedDuringGate("swe_research_save", unlocked).allowed, true);

  assert.equal(needsGateConfirmation("implement", unlocked, options), true);
  assert.equal(needsGateConfirmation("architecture", unlocked, options), false);
});

test("parseOptions supports confirmBefore none and all presets", () => {
  assert.deepEqual(parseOptions({ confirmBefore: "none" }).confirmBefore, []);
  assert.equal(parseOptions({ confirmBefore: "all" }).confirmBefore.length, 7);
});
