import assert from "node:assert/strict";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {checkToolAllowedForDelegation, checkToolAllowedForStage, shouldAutoStartOnPrompt,} from "../src/hooks";
import {
  applyGateApproval,
  applyReviewRecordTransition,
  applyTestRecordTransition,
  BUILTIN_PIPELINES,
  createInitialWorkflowState,
  createPendingGate,
  detectProfiles,
  getWorkflowState,
  isWriteStage,
  loadBundledSkills,
  loadProfileRegistry,
  parseOptions,
  parseSkillMarkdown,
  renderSubagentWorkflowContext,
  renderWorkflowContext,
  resolveStartGate,
  resolveWorkflowSessionID,
  RETRY_LIMIT_GATE,
  saveWorkflowState,
  validateForwardTransition,
} from "../src";
import {registerTools, type ToolsContext} from "../src/tools";
import type {PluginContext, StorageDomain} from "../src/types.ts";

import {runSetup} from "../scripts/setup.ts";

function createMemoryStorage(): Pick<StorageDomain, "get" | "set" | "remove"> {
  const map = new Map<string, Parameters<StorageDomain["set"]>[1]>();
  return {
    async get(key: string) {
      return map.get(key);
    },
    async set(key: string, value: Parameters<StorageDomain["set"]>[1]) {
      map.set(key, value);
    },
    async remove(key: string) {
      map.delete(key);
    },
  };
}

test("loadBundledSkills loads all 10 core and specialist swe skills", () => {
  const skills = loadBundledSkills();
  const ids = skills.map((s) => s.id);
  assert.deepEqual(ids, [
    "swe-architect",
    "swe-documenter",
    "swe-implementer",
    "swe-orchestrator",
    "swe-performance",
    "swe-planner",
    "swe-researcher",
    "swe-reviewer",
    "swe-security",
    "swe-tester",
  ]);
  for (const skill of skills) {
    assert.equal(skill.name, skill.id);
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
      JSON.stringify({ dependencies: { react: "^19.0.0" }, devdevDependencies: { typescript: "^5.7.0" } }),
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

test("stage access and checkToolAllowedForStage block file edits in readonly stages", () => {
  const options = parseOptions({});
  assert.equal(isWriteStage("research", options.stageAccess), false);
  assert.equal(isWriteStage("implement", options.stageAccess), true);
  assert.equal(isWriteStage("review", options.stageAccess), false);

  const readonlyCheck = checkToolAllowedForStage("edit", { stage: "research" }, options);
  assert.equal(readonlyCheck.allowed, false);

  const writeCheck = checkToolAllowedForStage("edit", { stage: "implement" }, options);
  assert.equal(writeCheck.allowed, true);
});

test("setup script installs and uninstalls swe-agent and isolated sub-agents", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "kit-setup-"));
  try {
    await runSetup(["--project", tmpDir, "--dry-run"]);
    assert.equal(existsSync(path.join(tmpDir, ".opencode")), false);

    await runSetup(["--project", tmpDir, "--default-agent", "--pipeline", "quick"]);
    assert.ok(existsSync(path.join(tmpDir, ".opencode", "agents", "swe-agent.md")));
    assert.ok(existsSync(path.join(tmpDir, ".opencode", "agents", "swe-researcher.md")));
    assert.ok(existsSync(path.join(tmpDir, ".opencode", "agents", "swe-reviewer.md")));
    assert.ok(existsSync(path.join(tmpDir, "opencode.jsonc")));

    const configContent = readFileSync(path.join(tmpDir, "opencode.jsonc"), "utf8");
    assert.ok(configContent.includes("software-engineer-kit"));
    assert.ok(configContent.includes("swe-agent"));

    await runSetup(["--project", tmpDir, "--uninstall"]);
    assert.equal(existsSync(path.join(tmpDir, ".opencode", "agents", "swe-agent.md")), false);
    assert.equal(existsSync(path.join(tmpDir, ".opencode", "agents", "swe-researcher.md")), false);
    assert.equal(existsSync(path.join(tmpDir, ".opencode", "agents", "swe-reviewer.md")), false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("refactor pipeline is correctly defined", () => {
  assert.deepEqual(BUILTIN_PIPELINES.refactor, [
    "research",
    "architecture",
    "implement",
    "test",
    "review",
  ]);
});

test("parseOptions handles subagent, retry, and strict transition defaults and overrides", () => {
  const defaults = parseOptions({});
  assert.deepEqual(defaults.isolateStages, ["research", "review"]);
  assert.deepEqual(defaults.subagentIds, {
    research: "swe-researcher",
    review: "swe-reviewer",
  });
  assert.equal(defaults.maxFixIterations, 3);
  assert.equal(defaults.strictTransitions, true);

  const custom = parseOptions({
    isolateStages: "none",
    subagents: {research: "custom-researcher", review: "custom-reviewer"},
    maxFixIterations: -2,
    strictTransitions: false,
  });
  assert.deepEqual(custom.isolateStages, []);
  assert.deepEqual(custom.subagentIds, {
    research: "custom-researcher",
    review: "custom-reviewer",
  });
  assert.equal(custom.maxFixIterations, 3);
  assert.equal(custom.strictTransitions, false);
});

test("resolveStartGate honors confirmBefore 'start' and unlocks first stage cleanly", () => {
  const options = parseOptions({confirmBefore: ["start", "implement"]});
  const gate = resolveStartGate("research", {approvedGates: []}, options);
  assert.ok(gate);
  assert.equal(gate.gate, "start");
  assert.equal(gate.targetStage, "research");

  const initial = createInitialWorkflowState({
    sessionID: "ses-start",
    pipeline: "feature",
    stage: "research",
    goal: "Test start gate",
    status: "awaiting_approval",
    pendingGate: createPendingGate({
      gate: gate.gate,
      targetStage: gate.targetStage,
      summary: gate.summary,
    }),
  });

  const unlocked = applyGateApproval(initial);
  assert.equal(unlocked.status, "active");
  assert.equal(unlocked.stage, "research");
  assert.equal(unlocked.pendingGate, undefined);
  assert.ok(unlocked.approvedGates.includes("start"));

  const allConfirmOptions = parseOptions({confirmBefore: "all"});
  const allGate = resolveStartGate("research", {approvedGates: []}, allConfirmOptions);
  assert.equal(allGate?.gate, "start");
  assert.equal(allGate?.targetStage, "research");
});

test("shouldAutoStartOnPrompt skips child subagent sessions and non-swe primary agents", () => {
  const options = parseOptions({});
  assert.equal(
    shouldAutoStartOnPrompt({session: {agent: "swe-agent"}, options}),
    true,
  );
  assert.equal(
    shouldAutoStartOnPrompt({session: {parentID: "ses-parent", agent: "swe-agent"}, options}),
    false,
  );
  assert.equal(
    shouldAutoStartOnPrompt({session: {agent: "swe-researcher"}, options}),
    false,
  );
  assert.equal(
    shouldAutoStartOnPrompt({session: {agent: "swe-reviewer"}, options}),
    false,
  );
  assert.equal(
    shouldAutoStartOnPrompt({session: {agent: "plan"}, options}),
    false,
  );
});

test("bounded retry state machine loops failed tests and review rejections until retry_limit circuit breaker", () => {
  const options = parseOptions({maxFixIterations: 2});
  let state = createInitialWorkflowState({
    sessionID: "ses-retry",
    pipeline: "feature",
    stage: "test",
    goal: "Retry loop",
    approvedGates: ["implement", "test"],
  });

  // Iteration 1: test fails -> back to implement
  const fail1 = applyTestRecordTransition(
    state,
    {status: "failed", commands: ["npm test"], summary: "1 failure", gaps: []},
    options,
  );
  assert.equal(fail1.transition, "implement");
  assert.equal(fail1.circuitBreakerTriggered, false);
  assert.equal(fail1.nextState.stage, "implement");
  assert.equal(fail1.nextState.fixIterations, 1);

  // Iteration 2: review rejects -> back to implement and clears stale passing testResult
  state = {
    ...fail1.nextState,
    stage: "review",
    testResult: {status: "passed", commands: ["npm test"], summary: "ok", gaps: []},
  };
  const reject2 = applyReviewRecordTransition(
    state,
    {
      verdict: "changes_requested",
      summary: "Missing edge-case check",
      findings: [{severity: "major", location: "src/a.ts:10", message: "Handle null input"}],
    },
    options,
  );
  assert.equal(reject2.transition, "implement");
  assert.equal(reject2.circuitBreakerTriggered, false);
  assert.equal(reject2.nextState.stage, "implement");
  assert.equal(reject2.nextState.fixIterations, 2);
  assert.equal(reject2.nextState.testResult, undefined);
  assert.equal(reject2.nextState.reviewResult?.verdict, "changes_requested");

  // Iteration 3 (> maxFixIterations=2): triggers retry_limit gate
  const fail3 = applyTestRecordTransition(
    {...reject2.nextState, stage: "test"},
    {status: "failed", commands: ["npm test"], summary: "Still failing", gaps: []},
    options,
  );
  assert.equal(fail3.transition, null);
  assert.equal(fail3.circuitBreakerTriggered, true);
  assert.equal(fail3.nextState.status, "awaiting_approval");
  assert.equal(fail3.nextState.pendingGate?.gate, RETRY_LIMIT_GATE);
  assert.equal(fail3.nextState.fixIterations, 3);

  // Approving retry_limit resets fixIterations and does NOT stick in approvedGates
  const reset = applyGateApproval(fail3.nextState);
  assert.equal(reset.status, "active");
  assert.equal(reset.stage, "implement");
  assert.equal(reset.fixIterations, 0);
  assert.equal(reset.approvedGates.includes(RETRY_LIMIT_GATE), false);

  // Standalone review pipeline stays in review on changes_requested
  const standalone = createInitialWorkflowState({
    sessionID: "ses-review-only",
    pipeline: "review",
    stage: "review",
    goal: "Review commit",
  });
  const standaloneReject = applyReviewRecordTransition(
    standalone,
    {verdict: "changes_requested", summary: "Issues found", findings: []},
    options,
  );
  assert.equal(standaloneReject.transition, null);
  assert.equal(standaloneReject.circuitBreakerTriggered, false);
  assert.equal(standaloneReject.nextState.stage, "review");
});

test("validateForwardTransition enforces artifact and passing test preconditions", () => {
  const options = parseOptions({strictTransitions: true});
  const base = createInitialWorkflowState({
    sessionID: "ses-strict",
    pipeline: "feature",
    stage: "research",
    goal: "Strict transitions",
  });

  const skipResearch = validateForwardTransition(base, "architecture", options);
  assert.equal(skipResearch.allowed, false);

  const withResearch = {
    ...base,
    research: {summary: "Done", files: [], conventions: [], externalRefs: [], risks: []},
  };
  assert.equal(validateForwardTransition(withResearch, "architecture", options).allowed, true);
  assert.equal(validateForwardTransition(withResearch, "plan", options).allowed, false);

  const atTestFailed = {
    ...withResearch,
    stage: "test" as const,
    testResult: {status: "failed" as const, commands: ["npm test"], summary: "fail", gaps: []},
  };
  assert.equal(validateForwardTransition(atTestFailed, "review", options).allowed, false);
  // Backward transition to implement remains allowed
  assert.equal(validateForwardTransition(atTestFailed, "implement", options).allowed, true);

  const atTestPassed = {
    ...atTestFailed,
    testResult: {status: "passed" as const, commands: ["npm test"], summary: "pass", gaps: []},
  };
  assert.equal(validateForwardTransition(atTestPassed, "review", options).allowed, true);
});

test("resolveWorkflowSessionID walks parentID and renderSubagentWorkflowContext isolates review context", async () => {
  const storage = createMemoryStorage();
  const parentState = {
    ...createInitialWorkflowState({
      sessionID: "ses-root",
      pipeline: "feature",
      stage: "review",
      goal: "Build isolated reviewer",
      profiles: ["backend/typescript"],
    }),
    research: {
      summary: "Internal discovery chatter",
      files: ["src/a.ts"],
      conventions: [],
      externalRefs: [],
      risks: []
    },
    architecture: {
      summary: "Keep API clean",
      components: [],
      contracts: ["Contract A"],
      dataAndMigrations: [],
      tradeOffs: [],
      nonGoals: [],
    },
    acceptanceCriteria: ["Must pass tsc"],
    touchedFiles: ["src/a.ts"],
    testResult: {status: "passed" as const, commands: ["npm test"], summary: "All green", gaps: []},
  };
  await saveWorkflowState(storage, parentState);

  const hydrated = await getWorkflowState(storage, "ses-root");
  assert.equal(hydrated?.fixIterations, 0);

  const mockSession = {
    async get({sessionID}: { readonly sessionID: string }) {
      if (sessionID === "ses-grandchild") return {id: "ses-grandchild", parentID: "ses-child", agent: "swe-reviewer"};
      if (sessionID === "ses-child") return {id: "ses-child", parentID: "ses-root", agent: "swe-reviewer"};
      return {id: sessionID};
    },
  };

  const resolved = await resolveWorkflowSessionID({
    storage,
    session: mockSession,
    sessionID: "ses-grandchild",
  });
  assert.equal(resolved.workflowSessionID, "ses-root");
  assert.equal(resolved.isChild, true);
  assert.equal(resolved.state?.goal, "Build isolated reviewer");

  const registry = loadProfileRegistry();
  const reviewPrompt = renderSubagentWorkflowContext({
    state: parentState,
    role: "review",
    options: parseOptions({}),
    registry,
  });
  assert.ok(reviewPrompt.includes("<swe-workflow-subagent role=\"review\""));
  assert.ok(reviewPrompt.includes("Contract A"));
  assert.ok(reviewPrompt.includes("Must pass tsc"));
  assert.ok(reviewPrompt.includes("Active REVIEW Overlays"));
  assert.equal(reviewPrompt.includes("Internal discovery chatter"), false);
});

test("checkToolAllowedForDelegation enforces subagent delegation only when subagent is available", () => {
  const options = parseOptions({});

  // Parent swe-agent blocked when swe-researcher / swe-reviewer is registered
  assert.equal(
    checkToolAllowedForDelegation(
      "swe_research_save",
      {agent: "swe-agent", stage: "research", isChild: false, subagentAvailable: true},
      options,
    ).allowed,
    false,
  );
  assert.equal(
    checkToolAllowedForDelegation(
      "swe_review_record",
      {agent: "swe-agent", stage: "review", isChild: false, subagentAvailable: true},
      options,
    ).allowed,
    false,
  );

  // Child subagent allowed
  assert.equal(
    checkToolAllowedForDelegation(
      "swe_review_record",
      {agent: "swe-reviewer", stage: "review", isChild: true, subagentAvailable: true},
      options,
    ).allowed,
    true,
  );

  // Fallback: parent swe-agent allowed if subagent definitions are not installed
  assert.equal(
    checkToolAllowedForDelegation(
      "swe_review_record",
      {agent: "swe-agent", stage: "review", isChild: false, subagentAvailable: false},
      options,
    ).allowed,
    true,
  );
});

test("detectProfiles avoids false positives when task files and generic wording are provided", () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "kit-precision-"));
  try {
    mkdirSync(path.join(tmpDir, ".github", "workflows"), {recursive: true});
    writeFileSync(path.join(tmpDir, ".github", "workflows", "ci.yml"), "name: CI\n");
    writeFileSync(path.join(tmpDir, "Dockerfile"), "FROM node:22\n");
    mkdirSync(path.join(tmpDir, "migrations"));
    writeFileSync(path.join(tmpDir, "tsconfig.json"), "{}");
    writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({devDependencies: {typescript: "^5.7.0"}}),
    );
    mkdirSync(path.join(tmpDir, "web"));
    writeFileSync(
      path.join(tmpDir, "web", "package.json"),
      JSON.stringify({dependencies: {react: "^19.0.0"}}),
    );

    const registry = loadProfileRegistry();
    const detected = detectProfiles({
      promptText: "Optimize workflow pipeline, research context paging, JSON schema, and architecture components",
      files: ["src/workflows/state.ts", "src/skills/profiles.ts"],
      directory: tmpDir,
      registry,
    });

    assert.equal(detected.includes("devops"), false);
    assert.equal(detected.includes("sql"), false);
    assert.equal(detected.includes("backend/golang"), false);
    assert.equal(detected.includes("frontend/react/typescript"), false);

    const sqlFilesDetected = detectProfiles({
      promptText: "Add users table migration",
      files: ["migrations/001_users.sql"],
      directory: tmpDir,
      registry,
    });
    assert.deepEqual(sqlFilesDetected, ["sql"]);
  } finally {
    rmSync(tmpDir, {recursive: true, force: true});
  }
});

test("renderWorkflowContext bounds fields, collapses done tasks, omits research in later stages, and scopes overlays to active task", () => {
  const registry = loadProfileRegistry();
  const options = parseOptions({});
  const longGoal = "G".repeat(600);
  const manyFiles = Array.from({length: 20}, (_, i) => `src/file-${i}.ts`);

  const researchState = {
    ...createInitialWorkflowState({
      sessionID: "ses-render-1",
      pipeline: "feature",
      stage: "research",
      goal: longGoal,
      profiles: ["backend/typescript"],
    }),
    research: {
      summary: "R".repeat(1500),
      files: manyFiles,
      conventions: [],
      externalRefs: [],
      risks: ["r1", "r2", "r3", "r4", "r5", "r6"],
    },
  };

  const researchRendered = renderWorkflowContext({state: researchState, options, registry});
  assert.ok(researchRendered.includes("## Saved Research"));
  assert.ok(researchRendered.includes("... (+5 more)"));
  assert.ok(researchRendered.includes("... (+1 more)"));
  assert.equal(researchRendered.includes(longGoal), false);

  const implementState = {
    ...researchState,
    stage: "implement" as const,
    profiles: ["backend/typescript", "frontend/react/typescript", "devops"],
    architecture: {
      summary: "Arch summary",
      components: [],
      contracts: ["Contract 1"],
      dataAndMigrations: [],
      tradeOffs: [],
      nonGoals: [],
    },
    tasks: [
      {id: "T1", title: "Done task", status: "done" as const, profiles: ["devops"]},
      {id: "T2", title: "Active TS task", status: "in_progress" as const, profiles: ["backend/typescript"]},
      {id: "T3", title: "Pending React task", status: "pending" as const, profiles: ["frontend/react/typescript"]},
    ],
  };

  const implementRendered = renderWorkflowContext({state: implementState, options, registry});
  assert.equal(implementRendered.includes("## Saved Research"), false);
  assert.ok(implementRendered.includes("Done (1): T1"));
  assert.equal(implementRendered.includes("Done task"), false);
  assert.ok(implementRendered.includes("### Profile: backend/typescript (implement)"));
  assert.equal(implementRendered.includes("### Profile: frontend/react/typescript (implement)"), false);
  assert.equal(implementRendered.includes("### Profile: devops (implement)"), false);
});

test("swe_* tools re-evaluate profiles cleanly, return compact JSON, support section filtering, and tail-truncate verify output at 16KB", async () => {
  const storage = createMemoryStorage();
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "kit-tools-"));
  try {
    mkdirSync(path.join(tmpDir, ".github", "workflows"), {recursive: true});
    writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      dependencies: {express: "^4.0.0"},
      devDependencies: {typescript: "^5.7.0"}
    }));

    type ToolEditorArg = Parameters<Parameters<PluginContext["tool"]["transform"]>[0]>[0];
    type ToolAddArg = Parameters<ToolEditorArg["add"]>[0];
    const registered = new Map<string, ToolAddArg>();
    const asText = (content: unknown): string => {
      assert.equal(typeof content, "string");
      return String(content);
    };

    const mockCtx: ToolsContext = {
      storage,
      location: {directory: tmpDir},
      permission: {
        async assert() {
        }
      },
      tool: {
        async transform(fn) {
          fn({
            namespace() {
            },
            add(tool: ToolAddArg) {
              registered.set(tool.name, tool);
            },
            get() {
              return undefined;
            },
            list() {
              return [];
            },
            remove() {
            },
          } as unknown as ToolEditorArg);
          return {
            async dispose() {
            }
          };
        },
      },
    };

    const options = parseOptions({});
    const registry = loadProfileRegistry();
    await registerTools(mockCtx, options, registry);

    const execContext = {
      sessionID: "ses-tools",
      agent: "swe-agent",
      messageID: "msg-1",
      id: "call-1",
      signal: new AbortController().signal,
      async progress() {
      },
    } as unknown as Parameters<ToolAddArg["execute"]>[1];

    // Seed initial state with stale false-positive devops profile
    await saveWorkflowState(storage, createInitialWorkflowState({
      sessionID: "ses-tools",
      pipeline: "feature",
      stage: "research",
      goal: "Update backend endpoint",
      profiles: ["devops", "backend/typescript"],
    }));

    const researchSave = registered.get("research_save")!;
    const researchRes = await researchSave.execute({
      summary: "Found pipeline and sql schema words in prose only",
      files: ["src/server.ts"],
      risks: ["Risk A"],
    }, execContext);
    const researchText = asText(researchRes.content);
    assert.equal(researchText.includes("\n"), false);
    const researchJson = JSON.parse(researchText) as { saved: boolean; profiles: string[]; fileCount: number };
    assert.equal(researchJson.saved, true);
    assert.equal(researchJson.fileCount, 1);
    assert.deepEqual(researchJson.profiles, ["backend/typescript"]);

    const workflowSet = registered.get("workflow_set")!;
    const setRes = await workflowSet.execute({
      profiles: ["sql"],
      advance: true,
    }, execContext);
    const setText = asText(setRes.content);
    assert.equal(setText.includes("\n"), false);
    const setJson = JSON.parse(setText) as { saved: boolean; stage: string; profiles: string[]; state?: unknown };
    assert.equal(setJson.saved, true);
    assert.equal(setJson.stage, "architecture");
    assert.deepEqual(setJson.profiles, ["sql"]);
    assert.equal(setJson.state, undefined);

    // Locked profiles should not be overwritten by subsequent research_save
    const lockedResearchRes = await researchSave.execute({
      summary: "Re-save research",
      files: ["src/server.ts"],
    }, execContext);
    assert.deepEqual((JSON.parse(asText(lockedResearchRes.content)) as { profiles: string[] }).profiles, ["sql"]);

    const workflowGet = registered.get("workflow_get")!;
    const summaryRes = await workflowGet.execute({section: "summary"}, execContext);
    const summaryJson = JSON.parse(asText(summaryRes.content)) as {
      hasResearch: boolean;
      research?: unknown;
      stage: string
    };
    assert.equal(summaryJson.hasResearch, true);
    assert.equal(summaryJson.research, undefined);
    assert.equal(summaryJson.stage, "architecture");

    const researchOnlyRes = await workflowGet.execute({section: "research"}, execContext);
    const researchOnlyJson = JSON.parse(asText(researchOnlyRes.content)) as { research: { summary: string } };
    assert.equal(researchOnlyJson.research.summary, "Re-save research");

    const verify = registered.get("verify")!;
    const verifyRes = await verify.execute({
      command: `node -e "process.stdout.write('HEAD_MARKER_' + 'x'.repeat(25000) + '_TAIL_MARKER')"`,
    }, execContext);
    const verifyJson = JSON.parse(asText(verifyRes.content)) as { passed: boolean; stdout: string };
    assert.equal(verifyJson.passed, true);
    assert.ok(verifyJson.stdout.includes("showing last 16KB"));
    assert.ok(verifyJson.stdout.includes("_TAIL_MARKER"));
    assert.equal(verifyJson.stdout.includes("HEAD_MARKER_"), false);
  } finally {
    rmSync(tmpDir, {recursive: true, force: true});
  }
});
