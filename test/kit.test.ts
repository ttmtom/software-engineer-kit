import assert from "node:assert/strict";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {checkToolAllowedForStage} from "../src/hooks";
import {
  BUILTIN_PIPELINES,
  detectProfiles,
  isWriteStage,
  loadBundledSkills,
  loadProfileRegistry,
  parseOptions,
  parseSkillMarkdown
} from "../src";
import {runSetup} from "../scripts/setup.ts";

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

test("setup script runs dry-run and project install successfully", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "kit-setup-"));
  try {
    await runSetup(["--project", tmpDir, "--dry-run"]);
    assert.equal(existsSync(path.join(tmpDir, ".opencode")), false);

    await runSetup(["--project", tmpDir, "--default-agent", "--pipeline", "quick"]);
    assert.ok(existsSync(path.join(tmpDir, ".opencode", "agents", "swe-agent.md")));
    assert.ok(existsSync(path.join(tmpDir, "opencode.jsonc")));

    const configContent = readFileSync(path.join(tmpDir, "opencode.jsonc"), "utf8");
    assert.ok(configContent.includes("software-engineer-kit"));
    assert.ok(configContent.includes("swe-agent"));

    await runSetup(["--project", tmpDir, "--uninstall"]);
    assert.equal(existsSync(path.join(tmpDir, ".opencode", "agents", "swe-agent.md")), false);
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
