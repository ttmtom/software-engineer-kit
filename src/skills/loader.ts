import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Skill } from "@opencode/plugin";
import type { SkillEditor } from "../types.ts";

export interface ParsedSkillFile {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly autoinvoke?: boolean;
  readonly path: string;
  readonly content: string;
}

export function getPackageSkillsRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../skills");
}

export function parseSkillMarkdown(raw: string, fallbackId: string, filePath: string): ParsedSkillFile {
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);

  let name = fallbackId;
  let description: string | undefined;
  let autoinvoke: boolean | undefined;
  let body = normalized.trim();

  if (match) {
    const frontmatter = match[1];
    body = match[2].trim();

    const lines = frontmatter.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const kv = line.match(/^([A-Za-z0-9_/-]+)\s*:\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1].trim();
      const value = kv[2].trim().replace(/^["']|["']$/g, "");

      if (key === "name" && value) name = value;
      else if (key === "description" && value) description = value;
      else if (key === "disable-model-invocation" && value === "true") {
        if (autoinvoke === undefined) autoinvoke = false;
      } else if (key === "metadata") {
        // Parse indented metadata entries like `opencode/autoinvoke: false`
        for (let j = i + 1; j < lines.length; j++) {
          const sub = lines[j];
          if (!/^\s+/.test(sub)) break;
          const subKv = sub.trim().match(/^([A-Za-z0-9_/-]+)\s*:\s*(.*)$/);
          if (subKv && subKv[1] === "opencode/autoinvoke") {
            autoinvoke = subKv[2].trim() !== "false";
          }
          i = j;
        }
      }
    }
  }

  return {
    id: fallbackId,
    name,
    description,
    autoinvoke,
    path: filePath,
    content: body,
  };
}

export function loadBundledSkills(skillsRoot = getPackageSkillsRoot()): ParsedSkillFile[] {
  if (!existsSync(skillsRoot)) return [];

  const entries = readdirSync(skillsRoot, { withFileTypes: true });
  const skills: ParsedSkillFile[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name === "profiles") continue;

    const skillPath = path.join(skillsRoot, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;

    const raw = readFileSync(skillPath, "utf8");
    skills.push(parseSkillMarkdown(raw, entry.name, skillPath));
  }

  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

export function registerBundledSkillsInEditor(
  editor: SkillEditor,
  skills: readonly ParsedSkillFile[],
  options: { overrideExisting: boolean },
): void {
  for (const skill of skills) {
    if (!options.overrideExisting && editor.get(skill.id)) {
      continue;
    }

    const info: Skill.Info = {
      id: Skill.ID.make(skill.id),
      name: Skill.Name.make(skill.name),
      path: Skill.Info.fields.path.make(path.resolve(skill.path)),
      content: skill.content,
      ...(skill.description ? { description: skill.description } : {}),
      ...(skill.autoinvoke !== undefined ? { autoinvoke: skill.autoinvoke } : {}),
    };

    const existing = editor.get(skill.id);
    if (existing) {
      editor.remove(skill.id);
    }
    try {
      editor.add(info);
    } catch (err) {
      if (existing) {
        editor.add(existing);
      }
      throw err;
    }
  }
}
