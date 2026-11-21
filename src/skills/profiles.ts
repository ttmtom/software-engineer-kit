import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ProfileSections } from "../options.ts";
import type { OverlayStage } from "../workflows/pipelines.ts";
import { getPackageSkillsRoot } from "./loader.ts";

export type ProfileRegistry = Readonly<Record<string, ProfileSections>>;

const SEGMENT_ALIASES: Readonly<Record<string, string>> = {
  go: "golang",
  ts: "typescript",
  fe: "frontend",
  be: "backend",
};

const SHORTHAND_ALIASES: Readonly<Record<string, string>> = {
  go: "backend/golang",
  golang: "backend/golang",
  react: "frontend/react",
  "react-ts": "frontend/react/typescript",
  "react-typescript": "frontend/react/typescript",
  fe: "frontend",
  ui: "frontend",
  be: "backend",
  api: "backend",
  sql: "sql",
  db: "sql",
  postgres: "sql",
  postgresql: "sql",
  mysql: "sql",
  sqlite: "sql",
  devops: "devops",
  infra: "devops",
  ci: "devops",
  docker: "devops",
  k8s: "devops",
};

const SECTION_MAP: Readonly<Record<string, OverlayStage>> = {
  architecture: "architecture",
  implement: "implement",
  test: "test",
  review: "review",
};

export function normalizeProfileName(input: string): string {
  const clean = input.trim().toLowerCase().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!clean) return "";

  if (!clean.includes("/") && SHORTHAND_ALIASES[clean]) {
    return SHORTHAND_ALIASES[clean];
  }

  return clean
    .split("/")
    .filter(Boolean)
    .map((segment) => SEGMENT_ALIASES[segment] ?? segment)
    .join("/");
}

export function normalizeProfiles(inputs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of inputs) {
    const name = normalizeProfileName(raw);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function getProfileAncestors(profileName: string): string[] {
  const clean = normalizeProfileName(profileName);
  if (!clean) return [];
  const parts = clean.split("/");
  const chain: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    chain.push(parts.slice(0, i).join("/"));
  }
  return chain;
}

export function expandProfileChain(
  profiles: readonly string[],
  registry: ProfileRegistry,
): string[] {
  const seen = new Set<string>();
  const expanded: string[] = [];

  for (const raw of normalizeProfiles(profiles)) {
    for (const ancestor of getProfileAncestors(raw)) {
      if (seen.has(ancestor)) continue;
      if (!(ancestor in registry)) continue;
      seen.add(ancestor);
      expanded.push(ancestor);
    }
  }

  return expanded;
}

export function isKnownProfile(profileName: string, registry: ProfileRegistry): boolean {
  const clean = normalizeProfileName(profileName);
  if (!clean) return false;
  if (clean in registry) return true;
  return getProfileAncestors(clean).some((p) => p in registry);
}

export function parseProfileMarkdown(raw: string): ProfileSections {
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  const sections: ProfileSections = {};
  let current: OverlayStage | undefined;
  let buffer: string[] = [];

  const flush = () => {
    if (!current) return;
    const text = buffer.join("\n").trim();
    if (text) sections[current] = text;
    buffer = [];
  };

  for (const line of lines) {
    const heading = line.match(/^##\s+([A-Za-z]+)\s*$/);
    if (heading) {
      const mapped = SECTION_MAP[heading[1].toLowerCase()];
      if (mapped) {
        flush();
        current = mapped;
        continue;
      }
    }
    if (current) {
      buffer.push(line);
    }
  }
  flush();

  return sections;
}

function collectMarkdownFiles(
  dir: string,
  baseDir: string,
  out: Array<{ key: string; filePath: string }>,
  visited: Set<string>,
): void {
  let realDir: string;
  try {
    realDir = statSync(dir).ino ? path.resolve(dir) : dir;
  } catch {
    return;
  }
  if (visited.has(realDir)) return;
  visited.add(realDir);

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMarkdownFiles(fullPath, baseDir, out, visited);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const rel = path.relative(baseDir, fullPath).replace(/\\/g, "/");
      const key = rel.slice(0, -3).toLowerCase();
      out.push({ key, filePath: fullPath });
    }
  }
}

export function loadProfileRegistry(
  customProfiles: Readonly<Record<string, ProfileSections>> = {},
  profilesDir = path.join(getPackageSkillsRoot(), "profiles"),
): ProfileRegistry {
  const merged: Record<string, ProfileSections> = {};

  if (existsSync(profilesDir)) {
    const files: Array<{ key: string; filePath: string }> = [];
    collectMarkdownFiles(profilesDir, profilesDir, files, new Set());
    files.sort((a, b) => a.key.localeCompare(b.key));

    for (const file of files) {
      const raw = readFileSync(file.filePath, "utf8");
      merged[file.key] = parseProfileMarkdown(raw);
    }
  }

  for (const [rawName, override] of Object.entries(customProfiles)) {
    const name = normalizeProfileName(rawName);
    if (!name) continue;
    merged[name] = {
      ...merged[name],
      ...override,
    };
  }

  return merged;
}

interface PackageHints {
  hasTypeScript: boolean;
  hasReact: boolean;
  hasFrontendFramework: boolean;
  hasBackendFramework: boolean;
}

function readPackageHints(pkgPath: string): PackageHints {
  const hints: PackageHints = {
    hasTypeScript: false,
    hasReact: false,
    hasFrontendFramework: false,
    hasBackendFramework: false,
  };
  if (!existsSync(pkgPath)) return hints;

  try {
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    const deps = {
      ...(typeof parsed.dependencies === "object" && parsed.dependencies ? parsed.dependencies : {}),
      ...(typeof parsed.devDependencies === "object" && parsed.devDependencies
        ? parsed.devDependencies
        : {}),
    } as Record<string, unknown>;
    const names = new Set(Object.keys(deps));

    if (names.has("typescript")) hints.hasTypeScript = true;
    if (names.has("react") || names.has("react-dom") || names.has("next")) {
      hints.hasReact = true;
      hints.hasFrontendFramework = true;
    }
    if (names.has("vue") || names.has("svelte") || names.has("tailwindcss") || names.has("vite")) {
      hints.hasFrontendFramework = true;
    }
    if (
      names.has("express") ||
      names.has("fastify") ||
      names.has("hono") ||
      names.has("koa") ||
      names.has("elysia") ||
      names.has("@nestjs/core")
    ) {
      hints.hasBackendFramework = true;
    }
  } catch {
    // Ignore malformed package.json
  }

  return hints;
}

export function detectProfiles(input: {
  readonly promptText?: string;
  readonly files?: readonly string[];
  readonly directory?: string;
  readonly registry: ProfileRegistry;
}): string[] {
  const detected = new Set<string>();
  const text = (input.promptText ?? "").toLowerCase();
  const files = input.files ?? [];

  let hasGo = false;
  let hasTs = false;
  let hasReact = false;
  let hasFrontend = false;
  let hasBackend = false;

  if (input.directory && existsSync(input.directory)) {
    if (existsSync(path.join(input.directory, "go.mod"))) {
      hasGo = true;
      hasBackend = true;
    }
    if (existsSync(path.join(input.directory, "tsconfig.json"))) {
      hasTs = true;
    }

    for (const relPkg of ["package.json", "web/package.json", "frontend/package.json", "apps/web/package.json"]) {
      const pkgDir = path.dirname(path.join(input.directory, relPkg));
      const hints = readPackageHints(path.join(input.directory, relPkg));
      if (hints.hasTypeScript || existsSync(path.join(pkgDir, "tsconfig.json"))) hasTs = true;
      if (hints.hasReact) hasReact = true;
      if (hints.hasFrontendFramework) hasFrontend = true;
      if (hints.hasBackendFramework) hasBackend = true;
    }

    if (
      existsSync(path.join(input.directory, "Dockerfile")) ||
      existsSync(path.join(input.directory, "docker-compose.yml")) ||
      existsSync(path.join(input.directory, "docker-compose.yaml")) ||
      existsSync(path.join(input.directory, ".github", "workflows"))
    ) {
      detected.add("devops");
    }
    if (
      existsSync(path.join(input.directory, "migrations")) ||
      existsSync(path.join(input.directory, "db", "migrations"))
    ) {
      detected.add("sql");
    }
  }

  for (const file of files) {
    const lower = file.toLowerCase();
    if (lower.endsWith(".go")) {
      hasGo = true;
      hasBackend = true;
    }
    if (lower.endsWith(".ts") || lower.endsWith(".tsx")) hasTs = true;
    if (lower.endsWith(".tsx") || lower.endsWith(".jsx")) {
      hasFrontend = true;
      hasReact = true;
    }
    if (
      lower.endsWith(".css") ||
      lower.endsWith(".scss") ||
      lower.endsWith(".vue") ||
      lower.endsWith(".svelte")
    ) {
      hasFrontend = true;
    }
    if (lower.endsWith(".sql") || lower.includes("migration")) detected.add("sql");
    if (
      lower.includes("dockerfile") ||
      lower.endsWith(".tf") ||
      lower.includes(".github/workflows/") ||
      lower.includes("docker-compose")
    ) {
      detected.add("devops");
    }
  }

  if (/\b(go|golang|goroutine|gin|chi|echo|fiber)\b/.test(text)) {
    hasGo = true;
    hasBackend = true;
  }
  if (/\b(typescript|ts|tsc|tsconfig)\b/.test(text)) hasTs = true;
  if (/\b(react|next\.js|nextjs|jsx|tsx)\b/.test(text)) {
    hasReact = true;
    hasFrontend = true;
  }
  if (/\b(frontend|vue|svelte|css|tailwind|ui|component|button|modal|page|a11y)\b/.test(text)) {
    hasFrontend = true;
  }
  if (/\b(backend|endpoint|api|route|handler|controller|middleware|grpc|rest|graphql|webhook|auth)\b/.test(text)) {
    hasBackend = true;
  }
  if (/\b(sql|postgres|postgresql|mysql|sqlite|migration|query|index|schema|table|database|db)\b/.test(text)) {
    detected.add("sql");
  }
  if (/\b(devops|docker|kubernetes|k8s|terraform|helm|ci\/cd|github actions|pipeline|deploy)\b/.test(text)) {
    detected.add("devops");
  }

  if (hasFrontend) {
    if (hasReact && hasTs && "frontend/react/typescript" in input.registry) {
      detected.add("frontend/react/typescript");
    } else if (hasReact && "frontend/react" in input.registry) {
      detected.add("frontend/react");
    } else if (hasTs && "frontend/typescript" in input.registry) {
      detected.add("frontend/typescript");
    } else {
      detected.add("frontend");
    }
  }

  if (hasBackend || hasGo) {
    if (hasGo && "backend/golang" in input.registry) {
      detected.add("backend/golang");
    } else if (hasTs && !hasGo && "backend/typescript" in input.registry) {
      detected.add("backend/typescript");
    } else {
      detected.add("backend");
    }
  }

  return Array.from(detected).filter((name) => isKnownProfile(name, input.registry));
}

export function renderStageOverlays(
  profiles: readonly string[],
  stage: OverlayStage,
  registry: ProfileRegistry,
): string {
  const blocks: string[] = [];

  for (const name of expandProfileChain(profiles, registry)) {
    const entry = registry[name];
    const section = entry?.[stage];
    if (!section) continue;
    blocks.push(`### Profile: ${name} (${stage})\n${section}`);
  }

  return blocks.join("\n\n");
}
