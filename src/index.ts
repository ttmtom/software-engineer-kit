import { Plugin } from "@opencode/plugin";
import type { Registration } from "./types.ts";
import { registerCommands } from "./commands/index.ts";
import { registerHooks } from "./hooks/index.ts";
import { parseOptions } from "./options.ts";
import { loadBundledSkills, registerBundledSkillsInEditor } from "./skills/loader.ts";
import { loadProfileRegistry } from "./skills/profiles.ts";
import { registerTools } from "./tools/index.ts";

export { parseOptions } from "./options.ts";
export * from "./workflows/pipelines.ts";
export * from "./workflows/state.ts";
export * from "./skills/loader.ts";
export * from "./skills/profiles.ts";

export default Plugin.define({
  id: "software-engineer-kit",
  async setup(ctx) {
    const options = parseOptions(ctx.options);
    const registry = loadProfileRegistry(options.profiles);
    const registrations: Registration[] = [];

    if (options.registerBundledSkills) {
      const bundledSkills = loadBundledSkills();
      if (bundledSkills.length > 0) {
        registrations.push(
          await ctx.skill.transform((editor) => {
            registerBundledSkillsInEditor(editor, bundledSkills, {
              overrideExisting: options.overrideExistingSkills,
            });
          }),
        );
      }
    }

    registrations.push(await registerTools(ctx, options, registry));
    registrations.push(await registerCommands(ctx, options, registry));
    registrations.push(...(await registerHooks(ctx, options, registry)));

    return async () => {
      await Promise.allSettled(registrations.map((r) => r.dispose()));
    };
  },
});
