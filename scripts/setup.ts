import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

interface SetupArgs {
  readonly global: boolean;
  readonly projectDir?: string;
  readonly defaultAgent: boolean;
  readonly pipeline?: string;
  readonly uninstall: boolean;
  readonly dryRun: boolean;
}

function parseArgs(args: readonly string[]): SetupArgs {
  let isGlobal = true;
  let projectDir: string | undefined;
  let defaultAgent = false;
  let pipeline: string | undefined;
  let uninstall = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--project" && i + 1 < args.length) {
      isGlobal = false;
      projectDir = path.resolve(args[i + 1]);
      i++;
    } else if (arg === "--global") {
      isGlobal = true;
      projectDir = undefined;
    } else if (arg === "--default-agent") {
      defaultAgent = true;
    } else if (arg === "--pipeline" && i + 1 < args.length) {
      pipeline = args[i + 1];
      i++;
    } else if (arg === "--uninstall") {
      uninstall = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  return {
    global: isGlobal,
    projectDir,
    defaultAgent,
    pipeline,
    uninstall,
    dryRun,
  };
}

function loadJsonc(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, "utf8");
    // Strip simple JSONC comments
    const cleaned = raw.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJsonc(filePath: string, data: Record<string, unknown>): void {
  const content = JSON.stringify(data, null, 2) + "\n";
  writeFileSync(filePath, content, "utf8");
}

export async function runSetup(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(here, "..");

  const targetConfigDir = args.global
    ? path.join(os.homedir(), ".config", "opencode")
    : path.join(args.projectDir ?? process.cwd(), ".opencode");

  const agentsDir = path.join(targetConfigDir, "agents");
  const agentDest = path.join(agentsDir, "swe-agent.md");
  const agentSource = path.join(packageRoot, "agents", "swe-agent.md");

  const configFilePath = args.global
    ? path.join(targetConfigDir, "opencode.jsonc")
    : path.join(args.projectDir ?? process.cwd(), "opencode.jsonc");

  console.log(`[swe-kit setup] Mode: ${args.uninstall ? "Uninstall" : "Install"}`);
  console.log(`[swe-kit setup] Scope: ${args.global ? "Global (~/.config/opencode)" : `Project (${args.projectDir ?? process.cwd()})`}`);
  if (args.dryRun) {
    console.log(`[swe-kit setup] Dry run enabled. No files will be modified.`);
  }

  if (args.uninstall) {
    if (!args.dryRun) {
      if (existsSync(agentDest)) {
        rmSync(agentDest);
        console.log(`[swe-kit setup] Removed ${agentDest}`);
      }
      if (existsSync(configFilePath)) {
        const config = loadJsonc(configFilePath);
        const plugins = Array.isArray(config.plugins) ? config.plugins : [];
        const filtered = plugins.filter((p) => {
          if (typeof p === "string") return p !== "software-engineer-kit" && !p.includes("software-engineer-kit");
          if (p && typeof p === "object" && "package" in p) {
            const pkg = String((p as Record<string, unknown>).package ?? "");
            return pkg !== "software-engineer-kit" && !pkg.includes("software-engineer-kit");
          }
          return true;
        });
        config.plugins = filtered;
        if (config.default_agent === "swe-agent") {
          delete config.default_agent;
        }
        writeJsonc(configFilePath, config);
        console.log(`[swe-kit setup] Cleaned ${configFilePath}`);
      }
    }
    console.log(`[swe-kit setup] Uninstallation complete.`);
    return;
  }

  // Install
  if (!args.dryRun) {
    mkdirSync(agentsDir, { recursive: true });
    if (existsSync(agentSource)) {
      const agentContent = readFileSync(agentSource, "utf8");
      writeFileSync(agentDest, agentContent, "utf8");
      console.log(`[swe-kit setup] Written agent file to ${agentDest}`);
    } else {
      console.warn(`[swe-kit setup] Warning: source agent file not found at ${agentSource}`);
    }

    const config = loadJsonc(configFilePath);
    if (!config.$schema) {
      config.$schema = "https://opencode.ai/config.json";
    }

    const plugins = Array.isArray(config.plugins) ? [...config.plugins] : [];
    const pluginEntry: Record<string, unknown> = {
      package: packageRoot,
      options: {
        defaultPipeline: args.pipeline ?? "feature",
        confirmBefore: ["implement", "test"],
        registerBundledSkills: true,
        autoInjectContext: true,
        trackFileEdits: true,
        autoDetectProfiles: true,
      },
    };

    let found = false;
    for (let i = 0; i < plugins.length; i++) {
      const p = plugins[i];
      if (p === "software-engineer-kit" || (p && typeof p === "object" && "package" in p && String((p as Record<string, unknown>).package).includes("software-engineer-kit"))) {
        plugins[i] = pluginEntry;
        found = true;
        break;
      }
    }
    if (!found) {
      plugins.push(pluginEntry);
    }
    config.plugins = plugins;

    if (args.defaultAgent) {
      config.default_agent = "swe-agent";
    }

    writeJsonc(configFilePath, config);
    console.log(`[swe-kit setup] Updated configuration at ${configFilePath}`);
  }

  console.log(`[swe-kit setup] Setup completed successfully! To use swe-agent, restart OpenCode or run /reload.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  void runSetup();
}
