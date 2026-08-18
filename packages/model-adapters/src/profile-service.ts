import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  resolveProjectApiKeyLibraryPath,
  resolveUserApiKeyLibraryPath,
  resolveWorkspaceApiKeyLibraryPath,
} from "../../state-location/src/index.js";

import type {
  ModelCapabilityManifest,
  ModelSlotBinding,
  ModelSlotId,
} from "../../shared-schema/src/index.js";
import type { ModelAdapterRegistry, ModelProbeResult, ResolvedModelProfile } from "./index.js";

interface StoredProfile {
  displayName?: string;
  provider: string;
  protocol?: string;
  adapter?: string;
  role?: string;
  allowedSlots?: ModelSlotId[];
  capabilities?: Partial<ModelCapabilityManifest>;
  apiKey?: string;
  apiKeyEnvName?: string;
  baseUrl: string;
  chatPath: string;
  model: string;
  supportsMultimodalInput?: boolean;
  headers?: Record<string, string>;
  requestDefaults?: Record<string, unknown>;
  notes?: string;
}

interface StoredLibrary {
  version: number;
  revision?: number;
  profiles: Record<string, StoredProfile>;
}

export interface PublicModelProfile {
  profileId: string;
  displayName?: string;
  provider: string;
  protocol: string;
  adapterId: string;
  baseUrl: string;
  endpointPath: string;
  model: string;
  capabilities: ModelCapabilityManifest;
  allowedSlots: ModelSlotId[];
  hasCredential: boolean;
  credentialSource: "inline_local" | "environment" | "missing";
  legacyRoleHint?: string;
}

export interface ProfileStatus {
  exists: boolean;
  hasKey: boolean;
  provider?: string;
  model?: string;
  adapterId?: string;
  capabilities?: ModelCapabilityManifest;
  allowedSlots?: ModelSlotId[];
}

export interface ProfileCapabilityGateResult {
  ok: boolean;
  missing: Array<keyof ModelCapabilityManifest | "allowedSlot">;
  profile: PublicModelProfile;
}

export interface ProfileSaveInput extends Omit<StoredProfile, "role"> {
  profileId: string;
  /** Legacy role hints are read but never written by the v2 control plane. */
  role?: never;
}

export interface ProfileSaveOptions {
  preserveCredential?: boolean;
  preserveAdvancedDefaults?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ancestorLibraryPaths(start: string): string[] {
  const candidates: string[] = [];
  let current = path.resolve(start);
  while (true) {
    candidates.push(path.join(current, ".deep-mix", "api-key-library", "profiles.local.json"));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return candidates;
}

export function apiKeyLibraryCandidates(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const configuredFallbackRoot = env.DEEP_MIX_API_KEY_LIBRARY_ROOT?.trim();
  return [...new Set([
    resolveWorkspaceApiKeyLibraryPath(workspaceRoot, { environment: env }),
    resolveProjectApiKeyLibraryPath(workspaceRoot),
    resolveUserApiKeyLibraryPath({ environment: env }),
    ...(configuredFallbackRoot ? [path.resolve(configuredFallbackRoot, ".deep-mix", "api-key-library", "profiles.local.json")] : []),
    ...ancestorLibraryPaths(process.cwd()),
  ])];
}

function adapterFor(profile: StoredProfile): string {
  if (profile.adapter?.trim()) return profile.adapter.trim();
  switch (profile.provider.toLowerCase()) {
    case "deepseek": return "deepseek_compat";
    case "glm": return "glm_compat";
    case "kimi": return "kimi_compat";
    default: return profile.protocol === "openai_chat_completions" ? "openai_compatible" : "";
  }
}

function protocolFor(profile: StoredProfile): string {
  return profile.protocol?.trim() || "openai_chat_completions";
}

function legacySlots(role: string | undefined): ModelSlotId[] {
  switch (role) {
    case "governor": return ["governor"];
    case "coding_worker": return ["coding"];
    case "vision_worker": return ["vision"];
    default: return [];
  }
}

function legacyCapabilities(profile: StoredProfile): ModelCapabilityManifest {
  const role = profile.role;
  return {
    textInput: true,
    imageInput: role === "vision_worker" ? profile.supportsMultimodalInput ?? true : profile.supportsMultimodalInput ?? false,
    streaming: role === "governor",
    nativeToolCalling: role === "governor",
    structuredOutput: role === "coding_worker" || role === "vision_worker",
    reasoning: role === "governor",
    contextWindow: role === "vision_worker" ? 256_000 : 128_000,
  };
}

function capabilitiesFor(profile: StoredProfile): ModelCapabilityManifest {
  const legacy = legacyCapabilities(profile);
  return {
    textInput: profile.capabilities?.textInput ?? legacy.textInput,
    imageInput: profile.capabilities?.imageInput ?? legacy.imageInput,
    streaming: profile.capabilities?.streaming ?? legacy.streaming,
    nativeToolCalling: profile.capabilities?.nativeToolCalling ?? legacy.nativeToolCalling,
    structuredOutput: profile.capabilities?.structuredOutput ?? legacy.structuredOutput,
    reasoning: profile.capabilities?.reasoning ?? legacy.reasoning,
    contextWindow: profile.capabilities?.contextWindow ?? legacy.contextWindow,
  };
}

function resolveCredential(profile: StoredProfile, env: NodeJS.ProcessEnv): { value?: string; source: PublicModelProfile["credentialSource"] } {
  if (profile.apiKey?.trim()) return { value: profile.apiKey.trim(), source: "inline_local" };
  const fromEnvironment = profile.apiKeyEnvName ? env[profile.apiKeyEnvName]?.trim() : undefined;
  return fromEnvironment ? { value: fromEnvironment, source: "environment" } : { source: "missing" };
}

function validateStoredProfile(profileId: string, value: unknown): asserts value is StoredProfile {
  if (!isPlainObject(value)) throw new Error(`Profile ${profileId} must be an object.`);
  for (const key of ["provider", "baseUrl", "chatPath", "model"] as const) {
    if (typeof value[key] !== "string" || !(value[key] as string).trim()) throw new Error(`Profile ${profileId}.${key} must be non-empty.`);
  }
  if (value.displayName !== undefined
    && (typeof value.displayName !== "string" || !value.displayName.trim() || value.displayName.trim().length > 80)) {
    throw new Error(`Profile ${profileId}.displayName must contain 1-80 characters.`);
  }
  if (value.allowedSlots !== undefined && (!Array.isArray(value.allowedSlots) || value.allowedSlots.some((slot) => slot !== "governor" && slot !== "coding" && slot !== "vision"))) {
    throw new Error(`Profile ${profileId}.allowedSlots is invalid.`);
  }
  if (value.capabilities !== undefined && !isPlainObject(value.capabilities)) throw new Error(`Profile ${profileId}.capabilities must be an object.`);
  if (value.headers !== undefined && (!isPlainObject(value.headers) || Object.values(value.headers).some((entry) => typeof entry !== "string"))) {
    throw new Error(`Profile ${profileId}.headers must contain string values.`);
  }
  if (value.requestDefaults !== undefined && !isPlainObject(value.requestDefaults)) throw new Error(`Profile ${profileId}.requestDefaults must be an object.`);
}

function readLibrary(filePath: string): StoredLibrary {
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!isPlainObject(raw) || !Number.isInteger(raw.version) || !isPlainObject(raw.profiles)) throw new Error(`Invalid API key library: ${filePath}`);
  for (const [profileId, profile] of Object.entries(raw.profiles)) validateStoredProfile(profileId, profile);
  return raw as unknown as StoredLibrary;
}

function toPublic(profileId: string, profile: StoredProfile, env: NodeJS.ProcessEnv): PublicModelProfile {
  const credential = resolveCredential(profile, env);
  const publicEndpoint = (value: string): string => value.replace(/\?[^#]*/u, "?[REDACTED_QUERY]").replace(/#.*/u, "#[REDACTED_FRAGMENT]");
  return {
    profileId,
    ...(profile.displayName?.trim() ? { displayName: profile.displayName.trim() } : {}),
    provider: profile.provider,
    protocol: protocolFor(profile),
    adapterId: adapterFor(profile),
    baseUrl: publicEndpoint(profile.baseUrl),
    endpointPath: publicEndpoint(profile.chatPath),
    model: profile.model,
    capabilities: capabilitiesFor(profile),
    allowedSlots: profile.allowedSlots?.length ? [...new Set(profile.allowedSlots)] : legacySlots(profile.role),
    hasCredential: Boolean(credential.value),
    credentialSource: credential.source,
    legacyRoleHint: profile.role,
  };
}

export class ProfileService {
  public constructor(
    private readonly workspaceRoot: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  public resolveLibraryPath(): string | undefined {
    return apiKeyLibraryCandidates(this.workspaceRoot, this.env).find((candidate) => existsSync(candidate));
  }

  public getLocalLibraryRevision(): number {
    const libraryPath = [
      resolveWorkspaceApiKeyLibraryPath(this.workspaceRoot, { environment: this.env }),
      resolveProjectApiKeyLibraryPath(this.workspaceRoot),
    ].find((candidate) => existsSync(candidate));
    if (!libraryPath) return 0;
    return existsSync(libraryPath) ? readLibrary(libraryPath).revision ?? 0 : 0;
  }

  public listPublicProfiles(): PublicModelProfile[] {
    const profiles = new Map<string, PublicModelProfile>();
    for (const libraryPath of apiKeyLibraryCandidates(this.workspaceRoot, this.env)) {
      if (!existsSync(libraryPath)) continue;
      const library = readLibrary(libraryPath);
      for (const [profileId, profile] of Object.entries(library.profiles)) {
        if (!profiles.has(profileId)) profiles.set(profileId, toPublic(profileId, profile, this.env));
      }
    }
    return [...profiles.values()];
  }

  public inspect<const TName extends string>(profileNames: readonly TName[]): Record<TName, ProfileStatus> {
    const profiles = new Map(this.listPublicProfiles().map((profile) => [profile.profileId, profile]));
    return Object.fromEntries(profileNames.map((profileName) => {
      const profile = profiles.get(profileName);
      return [profileName, profile ? {
        exists: true,
        hasKey: profile.hasCredential,
        provider: profile.provider,
        model: profile.model,
        adapterId: profile.adapterId,
        capabilities: profile.capabilities,
        allowedSlots: profile.allowedSlots,
      } : { exists: false, hasKey: false }];
    })) as Record<TName, ProfileStatus>;
  }

  public resolveProfile(profileId: string, modelOverride?: string): ResolvedModelProfile {
    for (const libraryPath of apiKeyLibraryCandidates(this.workspaceRoot, this.env)) {
      if (!existsSync(libraryPath)) continue;
      const profile = readLibrary(libraryPath).profiles[profileId];
      if (!profile) continue;
      const publicProfile = toPublic(profileId, profile, this.env);
      return {
        profileId,
        provider: publicProfile.provider,
        protocol: publicProfile.protocol,
        adapterId: publicProfile.adapterId,
        baseUrl: profile.baseUrl,
        endpointPath: profile.chatPath,
        model: modelOverride?.trim() || publicProfile.model,
        capabilities: publicProfile.capabilities,
        allowedSlots: publicProfile.allowedSlots,
        apiKey: resolveCredential(profile, this.env).value,
        headers: { ...(profile.headers ?? {}) },
        requestDefaults: { ...(profile.requestDefaults ?? {}) },
      };
    }
    throw new Error(`profile_unavailable: ${profileId}`);
  }

  public gate(slot: ModelSlotId, profileId: string, requirements: ModelSlotBinding["requirements"] = {}): ProfileCapabilityGateResult {
    const profile = this.listPublicProfiles().find((entry) => entry.profileId === profileId);
    if (!profile) throw new Error(`profile_unavailable: ${profileId}`);
    const missing: ProfileCapabilityGateResult["missing"] = [];
    if (!profile.allowedSlots.includes(slot)) missing.push("allowedSlot");
    for (const capability of ["textInput", "imageInput", "streaming", "nativeToolCalling", "structuredOutput", "reasoning"] as const) {
      if (requirements[capability] === true && profile.capabilities[capability] !== true) missing.push(capability);
    }
    if (requirements.minimumContextWindow !== undefined && profile.capabilities.contextWindow < requirements.minimumContextWindow) missing.push("contextWindow");
    return { ok: missing.length === 0, missing, profile };
  }

  public async probe(profileId: string, registry: ModelAdapterRegistry, signal?: AbortSignal): Promise<ModelProbeResult> {
    const profile = this.resolveProfile(profileId);
    return registry.resolve(profile.adapterId).probe(profile, signal);
  }

  public async saveProfile(
    input: ProfileSaveInput,
    expectedRevision: number,
    options: ProfileSaveOptions = {},
  ): Promise<{ profile: PublicModelProfile; revision: number }> {
    const libraryPath = resolveWorkspaceApiKeyLibraryPath(this.workspaceRoot, { environment: this.env });
    const inheritedLibraryPath = [libraryPath, resolveProjectApiKeyLibraryPath(this.workspaceRoot)]
      .find((candidate) => existsSync(candidate));
    const current: StoredLibrary = inheritedLibraryPath
      ? readLibrary(inheritedLibraryPath)
      : { version: 2, revision: 0, profiles: {} };
    const revision = current.revision ?? 0;
    if (revision !== expectedRevision) throw new Error(`profile_revision_conflict: expected ${expectedRevision}, current ${revision}.`);
    const { profileId, ...provided } = input;
    const credentialChanged = provided.apiKey !== undefined || provided.apiKeyEnvName !== undefined;
    let inherited: StoredProfile | undefined = current.profiles[profileId];
    if (!inherited && (options.preserveCredential || options.preserveAdvancedDefaults)) {
      for (const candidate of apiKeyLibraryCandidates(this.workspaceRoot, this.env)) {
        if (!existsSync(candidate)) continue;
        const profile = readLibrary(candidate).profiles[profileId];
        if (profile) {
          inherited = profile;
          break;
        }
      }
    }
    const stored: StoredProfile = {
      ...provided,
      ...(options.preserveAdvancedDefaults && !credentialChanged && provided.headers === undefined && inherited?.headers
        ? { headers: { ...inherited.headers } }
        : {}),
      ...(options.preserveAdvancedDefaults && provided.requestDefaults === undefined && inherited?.requestDefaults
        ? { requestDefaults: { ...inherited.requestDefaults } }
        : {}),
      ...(options.preserveAdvancedDefaults && provided.notes === undefined && inherited?.notes
        ? { notes: inherited.notes }
        : {}),
      ...(options.preserveAdvancedDefaults && provided.displayName === undefined && inherited?.displayName
        ? { displayName: inherited.displayName }
        : {}),
      ...(options.preserveCredential && provided.apiKey === undefined && provided.apiKeyEnvName === undefined
        ? inherited?.apiKey
          ? { apiKey: inherited.apiKey }
          : inherited?.apiKeyEnvName
            ? { apiKeyEnvName: inherited.apiKeyEnvName }
            : {}
        : {}),
    };
    validateStoredProfile(profileId, stored);
    const next: StoredLibrary = { version: Math.max(2, current.version), revision: revision + 1, profiles: { ...current.profiles, [profileId]: stored } };
    await fs.mkdir(path.dirname(libraryPath), { recursive: true });
    const temporaryPath = `${libraryPath}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temporaryPath, libraryPath);
      await fs.chmod(libraryPath, 0o600).catch(() => undefined);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return { profile: toPublic(profileId, stored, this.env), revision: revision + 1 };
  }
}
