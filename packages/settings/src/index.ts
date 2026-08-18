import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveProjectSettingsPath, resolveUserSettingsPath } from "../../state-location/src/index.js";
import type {
  DeepMixModelSettings,
  DeepMixSettings,
  LegacyRouteTarget,
  ModelProfileRef,
  ModelSlotBinding,
  PermissionMode,
  RouteTarget,
  RouteTargetInput,
  SemanticRouteTarget,
} from "../../shared-schema/src/index.js";

export interface DeepMixSettingsPaths {
  userSettingsPath: string;
  projectSettingsPath: string;
}

export interface LoadedDeepMixSettings {
  settings: DeepMixSettings;
  loadedPaths: string[];
  errors: string[];
  warnings: string[];
  migrationPlan?: DeepMixSettingsMigrationPlan;
  paths: DeepMixSettingsPaths;
}

export interface DeepMixSettingsMigrationPlan {
  fromVersion: 1;
  toVersion: 2;
  warnings: string[];
  changes: string[];
  preview: DeepMixSettings;
}

export interface SaveDeepMixSettingsResult {
  path: string;
  previousRevision: number;
  revision: number;
}

export const CLASSIC_MODEL_SETTINGS: DeepMixModelSettings = {
  preset: "classic",
  slots: {
    governor: {
      primary: { profile: "deepseek_governor" },
      fallbacks: [],
      fallbackPolicy: {
        enabled: false,
        on: ["configuration", "capability", "connection", "rate_limit", "timeout", "provider_error", "invalid_response"],
      },
      requirements: {
        textInput: true,
        streaming: true,
        nativeToolCalling: true,
      },
    },
    coding: {
      primary: { profile: "glm_coding_worker" },
      fallbacks: [],
      fallbackPolicy: {
        enabled: false,
        on: ["configuration", "capability", "connection", "rate_limit", "timeout", "provider_error", "invalid_response"],
        allowGovernorDirectFallback: true,
      },
      requirements: {
        textInput: true,
        structuredOutput: true,
      },
    },
    vision: {
      primary: { profile: "kimi_vision" },
      fallbacks: [],
      fallbackPolicy: {
        enabled: false,
        on: ["configuration", "capability", "connection", "rate_limit", "timeout", "provider_error", "invalid_response"],
        allowGovernorDirectFallback: true,
      },
      requirements: {
        textInput: true,
        imageInput: true,
        structuredOutput: true,
      },
    },
  },
};

interface LoadSettingsOptions {
  homeDir?: string;
  collectErrors?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}.`);
  }
}

function validateProfileRef(value: unknown, label: string): asserts value is ModelProfileRef {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertKnownKeys(value, ["profile", "model", "adapter", "protocol"], label);
  if (typeof value.profile !== "string" || value.profile.trim().length === 0) {
    throw new Error(`${label}.profile must be a non-empty string.`);
  }
  for (const key of ["model", "adapter", "protocol"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].trim().length === 0)) {
      throw new Error(`${label}.${key} must be a non-empty string when provided.`);
    }
  }
}

function validateSlotBinding(value: unknown, label: string): asserts value is ModelSlotBinding {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertKnownKeys(value, ["primary", "fallbacks", "parameters", "fallbackPolicy", "requirements"], label);
  validateProfileRef(value.primary, `${label}.primary`);
  if (!Array.isArray(value.fallbacks)) {
    throw new Error(`${label}.fallbacks must be an array.`);
  }
  value.fallbacks.forEach((entry, index) => validateProfileRef(entry, `${label}.fallbacks[${index}]`));
  const references = [value.primary.profile, ...value.fallbacks.map((entry) => entry.profile)];
  const duplicates = references.filter((profile, index) => references.indexOf(profile) !== index);
  if (duplicates.length > 0) {
    throw new Error(`${label} contains a duplicate or cyclic profile reference: ${[...new Set(duplicates)].join(", ")}.`);
  }
  if (value.parameters !== undefined && !isPlainObject(value.parameters)) {
    throw new Error(`${label}.parameters must be an object.`);
  }
  if (isPlainObject(value.parameters)) {
    const invalidParameter = Object.entries(value.parameters).find(([, entry]) => !["string", "number", "boolean"].includes(typeof entry));
    if (invalidParameter) {
      throw new Error(`${label}.parameters.${invalidParameter[0]} must be a string, number, or boolean.`);
    }
  }
  if (value.fallbackPolicy !== undefined) {
    if (!isPlainObject(value.fallbackPolicy)) {
      throw new Error(`${label}.fallbackPolicy must be an object.`);
    }
    assertKnownKeys(value.fallbackPolicy, ["enabled", "on", "allowGovernorDirectFallback"], `${label}.fallbackPolicy`);
    if (typeof value.fallbackPolicy.enabled !== "boolean" || !Array.isArray(value.fallbackPolicy.on)) {
      throw new Error(`${label}.fallbackPolicy requires enabled:boolean and on:array.`);
    }
    const allowedTriggers = new Set(["configuration", "capability", "connection", "rate_limit", "timeout", "provider_error", "invalid_response"]);
    if (value.fallbackPolicy.on.some((trigger) => typeof trigger !== "string" || !allowedTriggers.has(trigger))) {
      throw new Error(`${label}.fallbackPolicy.on contains an unsupported trigger.`);
    }
  }
  if (value.requirements !== undefined && !isPlainObject(value.requirements)) {
    throw new Error(`${label}.requirements must be an object.`);
  }
}

export function validateDeepMixSettings(settings: DeepMixSettings, label = "settings"): DeepMixSettings {
  if (!isPlainObject(settings)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  if (settings.version !== 2) {
    return settings;
  }
  assertKnownKeys(
    settings as Record<string, unknown>,
    ["version", "revision", "models", "defaults", "governor", "codingWorker", "visionWorker", "skills", "desktop", "webSearch", "git", "codeIntelligence", "enabledSkills"],
    label,
  );
  if (typeof settings.revision !== "number" || !Number.isInteger(settings.revision) || settings.revision < 0) {
    throw new Error(`${label}.revision must be a non-negative integer for version 2.`);
  }
  if (!isPlainObject(settings.models)) {
    throw new Error(`${label}.models is required for version 2.`);
  }
  assertKnownKeys(settings.models as unknown as Record<string, unknown>, ["preset", "slots"], `${label}.models`);
  if (settings.models.preset !== "classic" && settings.models.preset !== "custom") {
    throw new Error(`${label}.models.preset must be classic or custom.`);
  }
  if (!isPlainObject(settings.models.slots)) {
    throw new Error(`${label}.models.slots is required.`);
  }
  assertKnownKeys(settings.models.slots as unknown as Record<string, unknown>, ["governor", "coding", "vision"], `${label}.models.slots`);
  validateSlotBinding(settings.models.slots.governor, `${label}.models.slots.governor`);
  validateSlotBinding(settings.models.slots.coding, `${label}.models.slots.coding`);
  validateSlotBinding(settings.models.slots.vision, `${label}.models.slots.vision`);
  return settings;
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
  return validateDeepMixSettings(raw as DeepMixSettings, filePath);
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
  return {
    userSettingsPath: resolveUserSettingsPath(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    projectSettingsPath: resolveProjectSettingsPath(workspaceRoot),
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

function migratedProfileRef(profile: string | undefined, classicProfile: string, model?: string): ModelProfileRef {
  return {
    profile: profile?.trim() || classicProfile,
    ...(model?.trim() ? { model: model.trim() } : {}),
  };
}

export function createDeepMixSettingsMigrationPlan(settings: DeepMixSettings): DeepMixSettingsMigrationPlan | undefined {
  if (settings.version === 2) {
    return undefined;
  }
  const hasLegacyBindings = Boolean(settings.governor?.profile || settings.codingWorker?.profile || settings.visionWorker?.profile);
  const models: DeepMixModelSettings = {
    preset: hasLegacyBindings ? "custom" : "classic",
    slots: {
      governor: {
        ...cloneJson(CLASSIC_MODEL_SETTINGS.slots.governor),
        primary: migratedProfileRef(settings.governor?.profile, "deepseek_governor", settings.governor?.model),
      },
      coding: {
        ...cloneJson(CLASSIC_MODEL_SETTINGS.slots.coding),
        primary: migratedProfileRef(settings.codingWorker?.profile, "glm_coding_worker", settings.codingWorker?.model),
      },
      vision: {
        ...cloneJson(CLASSIC_MODEL_SETTINGS.slots.vision),
        primary: migratedProfileRef(settings.visionWorker?.profile, "kimi_vision", settings.visionWorker?.model),
      },
    },
  };
  const normalizedRoute = normalizeRouteTarget(settings.defaults?.routeOverride);
  const migratableTopLevelKeys = new Set([
    "defaults", "governor", "codingWorker", "visionWorker", "skills", "desktop", "webSearch", "git", "codeIntelligence", "enabledSkills",
  ]);
  const legacyBase = Object.fromEntries(
    Object.entries(settings as unknown as Record<string, unknown>)
      .filter(([key]) => migratableTopLevelKeys.has(key)),
  ) as DeepMixSettings;
  const preview: DeepMixSettings = {
    ...cloneJson(legacyBase),
    version: 2,
    revision: 0,
    models,
    defaults: {
      ...(settings.defaults ?? {}),
      ...(normalizedRoute ? { routeOverride: normalizedRoute } : {}),
    },
  };
  validateDeepMixSettings(preview, "migration preview");
  const changes = [
    "Set settings version to 2 with CAS revision 0.",
    `Create ${models.preset} governor/coding/vision slot bindings.`,
  ];
  if (settings.defaults?.routeOverride && normalizedRoute !== settings.defaults.routeOverride) {
    changes.push(`Normalize route target ${settings.defaults.routeOverride} -> ${normalizedRoute}.`);
  }
  return {
    fromVersion: 1,
    toVersion: 2,
    warnings: [
      "Legacy governor/codingWorker/visionWorker fields remain read-only compatibility inputs.",
      "This preview does not rewrite settings or the credential library until explicitly saved.",
    ],
    changes,
    preview,
  };
}

export function resolveEffectiveModelSettings(settings: DeepMixSettings): DeepMixModelSettings {
  if (settings.version === 2 && settings.models) {
    return cloneJson(settings.models);
  }
  return cloneJson(createDeepMixSettingsMigrationPlan(settings)?.preview.models ?? CLASSIC_MODEL_SETTINGS);
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

  const migrationPlan = createDeepMixSettingsMigrationPlan(merged);
  return {
    settings: merged,
    loadedPaths,
    errors,
    warnings: migrationPlan?.warnings ?? [],
    migrationPlan,
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

  const migrationPlan = createDeepMixSettingsMigrationPlan(merged);
  return {
    settings: merged,
    loadedPaths,
    errors,
    warnings: migrationPlan?.warnings ?? [],
    migrationPlan,
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

export function isSemanticRouteTarget(value: unknown): value is SemanticRouteTarget {
  return value === "governor_direct" || value === "coding_worker" || value === "vision_worker";
}

export function isLegacyRouteTarget(value: unknown): value is LegacyRouteTarget {
  return value === "ds_direct" || value === "glm_coding" || value === "kimi_vision";
}

/** Compatibility guard for settings/CLI inputs. New writes must normalize first. */
export function isRouteTarget(value: unknown): value is RouteTargetInput {
  return isSemanticRouteTarget(value) || isLegacyRouteTarget(value);
}

export function normalizeRouteTarget(value: unknown): SemanticRouteTarget | undefined {
  switch (value) {
    case "governor_direct":
    case "ds_direct":
      return "governor_direct";
    case "coding_worker":
    case "glm_coding":
      return "coding_worker";
    case "vision_worker":
    case "kimi_vision":
      return "vision_worker";
    default:
      return undefined;
  }
}

export async function saveDeepMixSettings(
  filePath: string,
  settings: DeepMixSettings,
  expectedRevision: number,
): Promise<SaveDeepMixSettingsResult> {
  let currentRevision = 0;
  if (existsSync(filePath)) {
    const current = ensureSettingsObject(filePath, JSON.parse(await fs.readFile(filePath, "utf8")));
    currentRevision = current.version === 2 ? current.revision ?? 0 : 0;
  }
  if (currentRevision !== expectedRevision) {
    throw new Error(`settings_revision_conflict: expected ${expectedRevision}, current ${currentRevision}.`);
  }
  const next: DeepMixSettings = {
    ...cloneJson(settings),
    version: 2,
    revision: currentRevision + 1,
  };
  validateDeepMixSettings(next, filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    path: filePath,
    previousRevision: currentRevision,
    revision: currentRevision + 1,
  };
}
