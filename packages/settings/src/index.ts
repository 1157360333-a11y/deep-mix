import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DeepMixSettings,
  PermissionMode,
  RouteTarget,
} from "../../shared-schema/src/index.js";

export interface DeepMixSettingsPaths {
  userSettingsPath: string;
  projectSettingsPath: string;
}

export interface LoadedDeepMixSettings {
  settings: DeepMixSettings;
  loadedPaths: string[];
  errors: string[];
  paths: DeepMixSettingsPaths;
}

interface LoadSettingsOptions {
  homeDir?: string;
  collectErrors?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      merged[key] = deepMerge(existing, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function ensureSettingsObject(filePath: string, raw: unknown): DeepMixSettings {
  if (!isPlainObject(raw)) {
    throw new Error(`Settings file must contain a JSON object: ${filePath}`);
  }
  return raw as DeepMixSettings;
}

function readSettingsFileSync(filePath: string): DeepMixSettings {
  if (!existsSync(filePath)) {
    return {};
  }
  const raw = readFileSync(filePath, "utf8");
  return ensureSettingsObject(filePath, JSON.parse(raw));
}

async function readSettingsFile(filePath: string): Promise<DeepMixSettings> {
  if (!existsSync(filePath)) {
    return {};
  }
  const raw = await fs.readFile(filePath, "utf8");
  return ensureSettingsObject(filePath, JSON.parse(raw));
}

export function resolveDeepMixSettingsPaths(
  workspaceRoot: string,
  options: Pick<LoadSettingsOptions, "homeDir"> = {},
): DeepMixSettingsPaths {
  const homeDir = options.homeDir ?? os.homedir();
  return {
    userSettingsPath: path.join(homeDir, ".deep-mix", "settings.json"),
    projectSettingsPath: path.join(workspaceRoot, ".deep-mix", "settings.json"),
  };
}

function loadPathsInOrder(paths: DeepMixSettingsPaths): string[] {
  return [paths.userSettingsPath, paths.projectSettingsPath];
}

function mergeSettingsWithCompatibility(settings: DeepMixSettings): DeepMixSettings {
  if (!settings.enabledSkills) {
    return settings;
  }
  return deepMerge(settings as Record<string, unknown>, {
    skills: {
      enabledSkills: settings.enabledSkills,
    },
  }) as DeepMixSettings;
}

export function loadDeepMixSettingsSync(
  workspaceRoot: string,
  options: LoadSettingsOptions = {},
): LoadedDeepMixSettings {
  const paths = resolveDeepMixSettingsPaths(workspaceRoot, options);
  const loadedPaths: string[] = [];
  const errors: string[] = [];
  let merged: DeepMixSettings = {};

  for (const settingsPath of loadPathsInOrder(paths)) {
    try {
      if (!existsSync(settingsPath)) {
        continue;
      }
      merged = deepMerge(merged as Record<string, unknown>, mergeSettingsWithCompatibility(readSettingsFileSync(settingsPath)) as Record<string, unknown>) as DeepMixSettings;
      loadedPaths.push(settingsPath);
    } catch (error) {
      if (!options.collectErrors) {
        throw error;
      }
      errors.push(`${settingsPath}: ${(error as Error).message}`);
    }
  }

  return {
    settings: merged,
    loadedPaths,
    errors,
    paths,
  };
}

export async function loadDeepMixSettings(
  workspaceRoot: string,
  options: LoadSettingsOptions = {},
): Promise<LoadedDeepMixSettings> {
  const paths = resolveDeepMixSettingsPaths(workspaceRoot, options);
  const loadedPaths: string[] = [];
  const errors: string[] = [];
  let merged: DeepMixSettings = {};

  for (const settingsPath of loadPathsInOrder(paths)) {
    try {
      if (!existsSync(settingsPath)) {
        continue;
      }
      merged = deepMerge(merged as Record<string, unknown>, mergeSettingsWithCompatibility(await readSettingsFile(settingsPath)) as Record<string, unknown>) as DeepMixSettings;
      loadedPaths.push(settingsPath);
    } catch (error) {
      if (!options.collectErrors) {
        throw error;
      }
      errors.push(`${settingsPath}: ${(error as Error).message}`);
    }
  }

  return {
    settings: merged,
    loadedPaths,
    errors,
    paths,
  };
}

export function extractEnabledSkills(settings: DeepMixSettings): Record<string, boolean> {
  return {
    ...(settings.enabledSkills ?? {}),
    ...(settings.skills?.enabledSkills ?? {}),
  };
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "plan" || value === "edit" || value === "auto" || value === "danger-full-access";
}

export function isRouteTarget(value: unknown): value is RouteTarget {
  return value === "ds_direct" || value === "glm_coding" || value === "kimi_vision";
}
