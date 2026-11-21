import type { Plugin } from "@opencode/plugin";

export type PluginContext = Parameters<Plugin.Plugin["setup"]>[0];
export type Registration = Awaited<ReturnType<PluginContext["tool"]["transform"]>>;
export type SkillEditor = Parameters<Parameters<PluginContext["skill"]["transform"]>[0]>[0];
export type StorageDomain = PluginContext["storage"];
