import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveCliLaunchConfig } from "../apps/cli/src/launch-config.js";
import { readProfileStatus } from "../apps/cli/src/session-shell.js";
import { GovernorRuntime, isReplayableWorkerFailure } from "../packages/core-governor/src/governor-runtime.js";
import {
  FallbackModelClient,
  ModelAdapterError,
  ModelAdapterRegistry,
  OpenAICompatibleAdapter,
  createDefaultModelAdapterRegistry,
  redactProviderText,
  type ResolvedModelProfile,
} from "../packages/model-adapters/src/index.js";
import { ProfileService } from "../packages/model-adapters/src/profile-service.js";
import { SessionStore } from "../packages/persistence/src/index.js";
import { resolveProjectApiKeyLibraryPath } from "../packages/state-location/src/index.js";
import {
  createCodingWorkerRouteProfile,
  createModelAssignmentSnapshot,
  loadCodingWorkerModelCandidates,
  loadGovernorModelCandidates,
  loadVisionWorkerModelCandidates,
} from "../packages/route-resolver/src/index.js";
import {
  CLASSIC_MODEL_SETTINGS,
  createDeepMixSettingsMigrationPlan,
  loadDeepMixSettingsSync,
  resolveDeepMixSettingsPaths,
  saveDeepMixSettings,
  validateDeepMixSettings,
} from "../packages/settings/src/index.js";
import type {
  DeepMixModelSettings,
  DeepMixSettings,
  ModelCapabilityManifest,
  ModelClient,
  ModelCompletionRequest,
  ModelSlotId,
  RoutingDecisionRecord,
  StreamCallbacks,
  ToolResult,
  WorkerTask,
} from "../packages/shared-schema/src/index.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const temporaryRoots: string[] = [];

async function workspace(prefix = "deep-mix-phase22-"): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, ".deep-mix", "api-key-library"), { recursive: true });
  return root;
}

const capabilities = (overrides: Partial<ModelCapabilityManifest> = {}): ModelCapabilityManifest => ({
  textInput: true,
  imageInput: false,
  streaming: true,
  nativeToolCalling: true,
  structuredOutput: true,
  reasoning: true,
  contextWindow: 128_000,
  ...overrides,
});

async function writeProfiles(root: string): Promise<void> {
  await fs.writeFile(path.join(root, ".deep-mix", "api-key-library", "profiles.local.json"), JSON.stringify({
    version: 2,
    revision: 7,
    profiles: {
      deepseek_governor: {
        provider: "deepseek", role: "governor", apiKey: "classic-governor-secret", baseUrl: "https://classic-g.invalid/v1", chatPath: "/chat/completions", model: "classic-governor",
      },
      glm_coding_worker: {
        provider: "glm", role: "coding_worker", apiKey: "classic-coding-secret", baseUrl: "https://classic-c.invalid/v1", chatPath: "/chat/completions", model: "classic-coding",
      },
      kimi_vision: {
        provider: "kimi", role: "vision_worker", supportsMultimodalInput: true, apiKey: "classic-vision-secret", baseUrl: "https://classic-v.invalid/v1", chatPath: "/chat/completions", model: "classic-vision",
      },
      omni: {
        displayName: "Omni Workspace",
        provider: "provider-a",
        protocol: "openai_chat_completions",
        adapter: "openai_compatible",
        allowedSlots: ["governor", "coding"],
        capabilities: capabilities(),
        apiKey: "sk-phase22-super-secret",
        baseUrl: "https://provider-a.invalid/v1?credential=must-not-leak",
        chatPath: "/chat/completions?tenant=secret",
        model: "omni-code",
        headers: { Authorization: "Bearer header-secret", "X-Trace": "safe" },
      },
      alternate: {
        provider: "provider-b",
        protocol: "openai_chat_completions",
        adapter: "openai_compatible",
        allowedSlots: ["governor", "coding"],
        capabilities: capabilities(),
        apiKey: "alternate-secret",
        baseUrl: "https://provider-b.invalid/v1",
        chatPath: "/chat/completions",
        model: "alternate-model",
      },
      vision: {
        provider: "provider-v",
        protocol: "openai_chat_completions",
        adapter: "openai_compatible",
        allowedSlots: ["vision"],
        capabilities: capabilities({ imageInput: true, streaming: false, nativeToolCalling: false, reasoning: false }),
        apiKeyEnvName: "PHASE22_VISION_KEY",
        baseUrl: "https://provider-v.invalid/v1",
        chatPath: "/chat/completions",
        model: "vision-model",
      },
      text_only_vision: {
        provider: "provider-t",
        protocol: "openai_chat_completions",
        adapter: "openai_compatible",
        allowedSlots: ["vision"],
        capabilities: capabilities({ imageInput: false }),
        apiKey: "text-only-secret",
        baseUrl: "https://provider-t.invalid/v1",
        chatPath: "/chat/completions",
        model: "text-only",
      },
      unknown_adapter: {
        provider: "provider-x",
        protocol: "private_protocol",
        adapter: "not_registered",
        allowedSlots: ["coding"],
        capabilities: capabilities(),
        apiKey: "unknown-adapter-secret",
        baseUrl: "https://provider-x.invalid/v1",
        chatPath: "/messages",
        model: "private-model",
      },
    },
  }, null, 2), "utf8");
}

function configuredModels(governor = "omni", coding = "omni", vision = "vision"): DeepMixModelSettings {
  const clone = JSON.parse(JSON.stringify(CLASSIC_MODEL_SETTINGS)) as DeepMixModelSettings;
  clone.preset = "custom";
  clone.slots.governor.primary = { profile: governor };
  clone.slots.coding.primary = { profile: coding };
  clone.slots.vision.primary = { profile: vision };
  return clone;
}

async function writeV2Settings(root: string, models = configuredModels()): Promise<void> {
  await fs.mkdir(path.join(root, ".deep-mix"), { recursive: true });
  await fs.writeFile(path.join(root, ".deep-mix", "settings.json"), JSON.stringify({
    version: 2,
    revision: 3,
    models,
  }, null, 2), "utf8");
}

function resolvedProfile(profileId: string, overrides: Partial<ResolvedModelProfile> = {}): ResolvedModelProfile {
  return {
    profileId,
    provider: "fake-provider",
    protocol: "openai_chat_completions",
    adapterId: "openai_compatible",
    baseUrl: "https://fake.invalid/v1",
    endpointPath: "/chat/completions",
    model: `${profileId}-model`,
    capabilities: capabilities(),
    allowedSlots: ["governor", "coding", "vision"],
    apiKey: "fake-key",
    headers: {},
    requestDefaults: {},
    ...overrides,
  };
}

const completionRequest = (): ModelCompletionRequest => ({
  route: {
    provider: "fake",
    model: "fake-model",
    role: "governor",
    contextWindow: 128_000,
    toolCallingMode: "provider_native",
    thinkingMode: { mode: "enabled", reasoningEffort: "medium" },
    pricing: { input: { available: false }, output: { available: false }, cacheRead: { available: false }, cacheWrite: { available: false } },
    maxInputSize: { value: 128_000, unit: "tokens" },
  },
  systemPrompt: "synthetic",
  messages: [],
  tools: [],
  stream: true,
  temperature: 0,
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("phase 22 settings and migration", () => {
  it("preserves the classic preset and legacy environment compatibility only before v2 activation", async () => {
    const root = await workspace();
    await writeProfiles(root);
    const classic = loadGovernorModelCandidates(root, {});
    expect(classic).toMatchObject({ preset: "classic", source: "classic" });
    expect(classic.configs[0]?.profileId).toBe("deepseek_governor");
    expect((await loadCodingWorkerModelCandidates(root, {})).configs[0]?.profileId).toBe("glm_coding_worker");
    expect((await loadVisionWorkerModelCandidates(root, {})).configs[0]?.profileId).toBe("kimi_vision");
    const legacyOverride = loadGovernorModelCandidates(root, { DEEPSEEK_GOVERNOR_PROFILE: "alternate" });
    expect(legacyOverride.configs[0]?.profileId).toBe("alternate");
    expect(legacyOverride.source).toBe("environment");
  });

  it("freezes v2 slot contracts, previews v1 deterministically, and never rewrites without explicit save", async () => {
    const root = await workspace();
    const settingsPath = resolveDeepMixSettingsPaths(root).projectSettingsPath;
    const legacy = {
      version: 1,
      defaults: { routeOverride: "glm_coding" },
      governor: { profile: "omni", model: "governor-override" },
      codingWorker: { profile: "alternate" },
      visionWorker: { profile: "vision" },
      _comment: "ignored compatibility annotation",
    };
    await fs.writeFile(settingsPath, JSON.stringify(legacy, null, 2), "utf8");
    const before = await fs.readFile(settingsPath, "utf8");
    const loaded = loadDeepMixSettingsSync(root, { collectErrors: false });
    expect(loaded.migrationPlan?.preview).toMatchObject({
      version: 2,
      revision: 0,
      defaults: { routeOverride: "coding_worker" },
      models: { preset: "custom", slots: { governor: { primary: { profile: "omni", model: "governor-override" } } } },
    });
    expect(await fs.readFile(settingsPath, "utf8")).toBe(before);

    const preview = createDeepMixSettingsMigrationPlan(legacy as DeepMixSettings)!.preview;
    const saved = await saveDeepMixSettings(settingsPath, preview, 0);
    expect(saved.revision).toBe(1);
    await expect(saveDeepMixSettings(settingsPath, preview, 0)).rejects.toThrow("settings_revision_conflict");
    expect(validateDeepMixSettings(JSON.parse(await fs.readFile(settingsPath, "utf8")) as DeepMixSettings).version).toBe(2);
  });

  it("uses deterministic project array replacement and rejects malformed bindings", async () => {
    const root = await workspace();
    const home = await workspace("deep-mix-phase22-home-");
    const userModels = configuredModels();
    userModels.slots.coding.fallbacks = [{ profile: "alternate" }];
    userModels.slots.coding.fallbackPolicy = { enabled: true, on: ["timeout"] };
    await fs.mkdir(path.join(home, ".deep-mix"), { recursive: true });
    await fs.writeFile(path.join(home, ".deep-mix", "settings.json"), JSON.stringify({ version: 2, revision: 1, models: userModels }), "utf8");
    const projectModels = configuredModels();
    projectModels.slots.coding.fallbacks = [];
    await fs.writeFile(path.join(root, ".deep-mix", "settings.json"), JSON.stringify({ version: 2, revision: 2, models: projectModels }), "utf8");
    const loaded = loadDeepMixSettingsSync(root, { homeDir: home, collectErrors: false });
    expect(loaded.settings.models?.slots.coding.fallbacks).toEqual([]);
    expect(() => validateDeepMixSettings({ version: 2, revision: 0, models: {
      ...configuredModels(),
      slots: { ...configuredModels().slots, coding: { ...configuredModels().slots.coding, fallbacks: [{ profile: "omni" }] } },
    } })).toThrow(/duplicate or cyclic/);
  });

  it("reports corrupted v2 settings without silently activating them", async () => {
    const root = await workspace();
    const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase22-empty-home-"));
    temporaryRoots.push(emptyHome);
    await fs.writeFile(path.join(root, ".deep-mix", "settings.json"), JSON.stringify({
      version: 2, revision: 0, models: configuredModels(), unknownField: "must fail",
    }), "utf8");
    const loaded = loadDeepMixSettingsSync(root, { homeDir: emptyHome, collectErrors: true });
    expect(loaded.errors).toHaveLength(1);
    expect(loaded.errors[0]).toContain("unknown field");
    expect(loaded.settings.version).toBeUndefined();
  });
});

describe("phase 22 profile service, capability gates, and candidates", () => {
  it("keeps credentials and headers behind ProfileService while independently gating reused profiles", async () => {
    const root = await workspace();
    await writeProfiles(root);
    const service = new ProfileService(root, { PHASE22_VISION_KEY: "vision-env-secret" });
    expect(service.gate("governor", "omni", { streaming: true, nativeToolCalling: true }).ok).toBe(true);
    expect(service.gate("coding", "omni", { structuredOutput: true }).ok).toBe(true);
    expect(service.gate("vision", "text_only_vision", { imageInput: true }).missing).toContain("imageInput");
    const publicJson = JSON.stringify(service.listPublicProfiles());
    expect(publicJson).not.toContain("sk-phase22-super-secret");
    expect(publicJson).not.toContain("header-secret");
    expect(publicJson).not.toContain("must-not-leak");
    expect(publicJson).toContain("[REDACTED_QUERY]");
    expect(service.listPublicProfiles().find((profile) => profile.profileId === "omni")?.displayName).toBe("Omni Workspace");
    expect(service.resolveProfile("omni").apiKey).toBe("sk-phase22-super-secret");
    expect(service.resolveProfile("vision").apiKey).toBe("vision-env-secret");
  });

  it("creates and edits a local profile without returning its credential or reviving stale auth headers", async () => {
    const root = await workspace();
    const service = new ProfileService(root);
    const created = await service.saveProfile({
      profileId: "custom_governor",
      displayName: "My Governor",
      provider: "custom-provider",
      protocol: "openai_chat_completions",
      adapter: "openai_compatible",
      allowedSlots: ["governor"],
      capabilities: capabilities(),
      apiKey: "synthetic-first-key",
      baseUrl: "https://custom.invalid/v1",
      chatPath: "/chat/completions",
      model: "custom-model",
      headers: { Authorization: "Bearer stale-header" },
      requestDefaults: { temperature: 0.2 },
    }, 0);
    expect(created.revision).toBe(1);
    expect(created.profile.displayName).toBe("My Governor");
    expect(JSON.stringify(created.profile)).not.toMatch(/synthetic-first-key|stale-header/);

    const retained = await service.saveProfile({
      profileId: "custom_governor",
      provider: "custom-provider",
      protocol: "openai_chat_completions",
      adapter: "openai_compatible",
      allowedSlots: ["governor", "coding"],
      capabilities: capabilities(),
      baseUrl: "https://custom.invalid/v2",
      chatPath: "/chat/completions",
      model: "custom-model-v2",
    }, 1, { preserveCredential: true, preserveAdvancedDefaults: true });
    expect(retained.profile.allowedSlots).toEqual(["governor", "coding"]);
    expect(retained.profile.displayName).toBe("My Governor");
    expect(service.resolveProfile("custom_governor")).toMatchObject({
      apiKey: "synthetic-first-key",
      headers: { Authorization: "Bearer stale-header" },
      requestDefaults: { temperature: 0.2 },
    });

    await service.saveProfile({
      profileId: "custom_governor",
      provider: "custom-provider",
      protocol: "openai_chat_completions",
      adapter: "openai_compatible",
      allowedSlots: ["governor", "coding"],
      capabilities: capabilities(),
      apiKey: "synthetic-replacement-key",
      baseUrl: "https://custom.invalid/v2",
      chatPath: "/chat/completions",
      model: "custom-model-v2",
    }, 2, { preserveCredential: true, preserveAdvancedDefaults: true });
    const replaced = service.resolveProfile("custom_governor");
    expect(replaced.apiKey).toBe("synthetic-replacement-key");
    expect(replaced.headers).toEqual({});
    expect(replaced.requestDefaults).toEqual({ temperature: 0.2 });
  });

  it("loads two non-classic cross-provider combinations without changing role runtime code", async () => {
    const root = await workspace();
    await writeProfiles(root);
    await writeV2Settings(root, configuredModels("omni", "alternate", "vision"));
    const env = { PHASE22_VISION_KEY: "vision-secret" };
    expect(loadGovernorModelCandidates(root, env).configs[0]).toMatchObject({ profileId: "omni", provider: "provider-a" });
    expect((await loadCodingWorkerModelCandidates(root, env)).configs[0]).toMatchObject({ profileId: "alternate", provider: "provider-b" });
    expect((await loadVisionWorkerModelCandidates(root, env)).configs[0]).toMatchObject({ profileId: "vision", provider: "provider-v" });

    await writeV2Settings(root, configuredModels("alternate", "omni", "vision"));
    expect(loadGovernorModelCandidates(root, env).configs[0]).toMatchObject({ profileId: "alternate", provider: "provider-b" });
    expect((await loadCodingWorkerModelCandidates(root, env)).configs[0]).toMatchObject({ profileId: "omni", provider: "provider-a" });
  });

  it("ignores legacy brand environment overrides for v2 and records explicit semantic overrides", async () => {
    const root = await workspace();
    await writeProfiles(root);
    await writeV2Settings(root);
    const ignored = loadGovernorModelCandidates(root, { DEEPSEEK_GOVERNOR_PROFILE: "alternate" });
    expect(ignored.configs[0]?.profileId).toBe("omni");
    expect(ignored.source).toBe("settings");
    const explicit = loadGovernorModelCandidates(root, { DEEP_MIX_GOVERNOR_PROFILE: "alternate" });
    expect(explicit.configs[0]?.profileId).toBe("alternate");
    expect(explicit.source).toBe("environment");
  });

  it("fails closed on missing profiles, vision image capability, and unregistered adapters", async () => {
    const root = await workspace();
    await writeProfiles(root);
    const service = new ProfileService(root);
    expect(() => service.resolveProfile("renamed_or_deleted")).toThrow("profile_unavailable");
    expect(() => createDefaultModelAdapterRegistry().resolve("not_registered")).toThrow("adapter_not_found");
    const registry = new ModelAdapterRegistry();
    registry.register(new OpenAICompatibleAdapter());
    expect(() => registry.resolve(service.resolveProfile("unknown_adapter").adapterId)).toThrow("adapter_not_found");
    await writeV2Settings(root, configuredModels("omni", "alternate", "text_only_vision"));
    await expect(loadVisionWorkerModelCandidates(root, {})).rejects.toThrow("capability_unavailable");
  });

  it("fails closed when an explicit vision route has no concrete image reference", async () => {
    const root = await workspace();
    await writeProfiles(root);
    await writeV2Settings(root);
    const client: ModelClient = { streamCompletion: vi.fn(async () => ({ content: "must not run", toolCalls: [] })) };
    const runtime = new GovernorRuntime({ workspaceRoot: root, permissionMode: "danger-full-access", modelClient: client });
    try {
      await expect(runtime.runTurn({ prompt: "analyze a screenshot", routeOverride: "vision_worker" })).rejects.toThrow("explicit vision_worker route requires a concrete image reference");
      expect(client.streamCompletion).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });
});

describe("phase 22 adapter normalization and replay-safe fallback", () => {
  it("normalizes text, structured tool calls, usage, and vision requests", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "OK", reasoning_content: "hidden", tool_calls: [{ id: "call-22", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const adapter = new OpenAICompatibleAdapter();
    const text = await adapter.completeText(resolvedProfile("text"), { messages: [{ role: "user", content: "fixed" }], responseFormat: "json_object" });
    expect(text.toolCalls[0]).toMatchObject({ id: "call-22", name: "read_file", arguments: { path: "README.md" } });
    expect(text.usage).toMatchObject({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });
    const vision = await adapter.completeVision(resolvedProfile("vision", { capabilities: capabilities({ imageInput: true }) }), {
      messages: [],
      text: "fixed vision probe",
      image: { mode: "base64_data_url", value: "data:image/png;base64,AA==" },
      responseFormat: "json_object",
    });
    expect(vision.content).toBe("OK");
    expect(JSON.stringify(requests[1])).toContain("image_url");
    await expect(Promise.resolve().then(() => adapter.completeVision(resolvedProfile("no-vision"), {
      messages: [], text: "fixed", image: { mode: "base64_data_url", value: "data:image/png;base64,AA==" },
    }))).rejects.toMatchObject({ failureType: "capability" });
  });

  it("normalizes streamed deltas and stable tool-call IDs", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "A", tool_calls: [{ index: 0, id: "stream-call", function: { name: "search_files", arguments: "{\"query\":" } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "R", tool_calls: [{ index: 0, function: { arguments: "\"slot\"}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\n`,
      "data: [DONE]\n\n",
    ];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(chunks.join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }));
    const client = new OpenAICompatibleAdapter().createTextClient(resolvedProfile("stream", {
      requestDefaults: { stream: false, reasoning_effort: "low" },
    }), { maxRetries: 0, timeoutMs: 1000, stream: true, temperature: 0 });
    const visible: string[] = [];
    const result = await client.streamCompletion(completionRequest(), { onTextDelta: (chunk) => visible.push(chunk) });
    expect(visible).toEqual(["A"]);
    expect(result.reasoningContent).toBe("R");
    expect(result.toolCalls[0]).toMatchObject({ id: "stream-call", name: "search_files", arguments: { query: "slot" } });
    expect(requests[0]).toMatchObject({ stream: true, stream_options: { include_usage: true }, reasoning_effort: "medium" });
  });

  it("converts leaked DSML to native tool calls without streaming protocol text", async () => {
    const dsmlChunks = [
      "先检查 ",
      "<｜｜DS",
      "ML｜｜tool_calls>\n<｜｜DSML｜｜invoke name=\"search_files\">\n",
      "<｜｜DSML｜｜parameter name=\"cwd\" string=\"true\">apps/desktop/src/renderer/App.tsx</｜｜DSML｜｜parameter>\n",
      "<｜｜DSML｜｜parameter name=\"pattern\" string=\"true\">onStreamText</｜｜DSML｜｜parameter>\n",
      "</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls> 然后继续",
    ];
    const events = dsmlChunks.map((content, index) => `data: ${JSON.stringify({
      choices: [{ delta: { content }, ...(index === dsmlChunks.length - 1 ? { finish_reason: "tool_calls" } : {}) }],
    })}\n\n`);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`${events.join("")}data: [DONE]\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })));
    const client = new OpenAICompatibleAdapter().createTextClient(
      resolvedProfile("dsml-stream"),
      { maxRetries: 0, timeoutMs: 1000, stream: true, temperature: 0 },
    );
    const visible: string[] = [];
    const result = await client.streamCompletion(completionRequest(), {
      onTextDelta: (chunk) => visible.push(chunk),
    });

    expect(visible.join("")).toBe("先检查  然后继续");
    expect(visible.join("")).not.toContain("DSML");
    expect(result.content).toBe("先检查  然后继续");
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: "search_files",
        arguments: {
          cwd: "apps/desktop/src/renderer/App.tsx",
          pattern: "onStreamText",
        },
      }),
    ]);
  });

  it("keeps runtime transport fields authoritative over legacy profile request defaults", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
    await new OpenAICompatibleAdapter().completeText(resolvedProfile("non-stream", {
      requestDefaults: { stream: true, stream_options: { include_usage: true } },
    }), { messages: [{ role: "user", content: "fixed" }] });
    expect(requests[0]?.stream).toBe(false);
    expect(requests[0]).not.toHaveProperty("stream_options");
  });

  it("falls back only before visible output and rejects forbidden or post-stream replay", async () => {
    let secondCalls = 0;
    const failing = (visible: boolean): ModelClient => ({
      streamCompletion: async (_request: ModelCompletionRequest, callbacks?: StreamCallbacks) => {
        if (visible) callbacks?.onTextDelta?.("visible");
        throw new ModelAdapterError({ adapterId: "a", profileId: "primary", failureType: "connection", retryable: true, message: "connection failed" });
      },
    });
    const succeeding: ModelClient = { streamCompletion: async () => { secondCalls += 1; return { content: "fallback", toolCalls: [] }; } };
    const allowed = new FallbackModelClient([
      { profile: resolvedProfile("primary"), client: failing(false) },
      { profile: resolvedProfile("fallback"), client: succeeding },
    ], new Set(["connection"]));
    expect((await allowed.streamCompletion(completionRequest())).content).toBe("fallback");
    expect(allowed.lastSelection?.fallbackIndex).toBe(1);

    secondCalls = 0;
    const postVisible = new FallbackModelClient([
      { profile: resolvedProfile("primary"), client: failing(true) },
      { profile: resolvedProfile("fallback"), client: succeeding },
    ], new Set(["connection"]));
    await expect(postVisible.streamCompletion(completionRequest(), { onTextDelta: () => undefined })).rejects.toThrow("connection failed");
    expect(secondCalls).toBe(0);

    const forbidden = new FallbackModelClient([
      { profile: resolvedProfile("primary"), client: failing(false) },
      { profile: resolvedProfile("fallback"), client: succeeding },
    ], new Set(["timeout"]));
    await expect(forbidden.streamCompletion(completionRequest())).rejects.toThrow("connection failed");
    expect(secondCalls).toBe(0);
    expect(isReplayableWorkerFailure({ success: false, output: "provider unavailable" } as ToolResult)).toBe(true);
    expect(isReplayableWorkerFailure({ success: false, output: "provider unavailable", artifacts: [{ uri: "artifact://published" }] } as ToolResult)).toBe(false);
    expect(isReplayableWorkerFailure({ success: false, output: "permission denied" } as ToolResult)).toBe(false);
  });
});

describe("phase 22 immutable snapshots, compatibility, telemetry, and redaction", () => {
  it("persists immutable redacted turn/worker snapshots and restores legacy route targets", async () => {
    const root = await workspace();
    const store = new SessionStore(root);
    await store.ensureInitialized();
    const session = await store.createSession("snapshot test");
    const config = {
      apiKey: "snapshot-secret",
      profileId: "omni",
      provider: "provider-a",
      adapterId: "openai_compatible",
      protocol: "openai_chat_completions",
      capabilities: capabilities(),
      baseUrl: "https://provider.invalid",
      endpointPath: "/chat/completions",
      model: "snapshot-model",
      role: "coding_worker" as const,
      contextWindow: 128_000,
      maxRetries: 1,
      timeoutMs: 1000,
      temperature: 0,
      maxContextChars: 1000,
      maxContextFiles: 2,
      headers: { Authorization: "secret" },
      requestDefaults: {},
      workspaceWriteAccess: false as const,
    };
    const snapshot = createModelAssignmentSnapshot({ slot: "coding", config, configRevision: 9, selectionReason: "primary", source: "settings" });
    expect(JSON.stringify(snapshot)).not.toContain("snapshot-secret");
    expect(JSON.stringify(snapshot)).not.toContain("Authorization");
    const turn = await store.startTurn({ sessionId: session.sessionId, requestSummary: "fixed", userMessageId: "user", modelAssignment: snapshot });
    config.model = "mutated-after-dispatch";
    await store.finishTurn({ sessionId: session.sessionId, turnId: turn.turnId, startedAt: turn.startedAt, requestSummary: "fixed", userMessageId: "user", toolCallIds: [], status: "completed" });
    const task: WorkerTask = { workerType: "coding", objective: "fixed", constraints: [], contextRefs: [], expectedOutput: "code_artifact", acceptanceChecks: [] };
    const worker = await store.createWorkerSession({ parentSessionId: session.sessionId, task, route: createCodingWorkerRouteProfile(config), modelAssignment: snapshot, timeoutMs: 1000, maxRetries: 0 });
    expect((await store.loadWorkerSession(worker.workerSessionId))?.modelAssignment?.model).toBe("snapshot-model");
    const legacyWorker = await store.createWorkerSession({ parentSessionId: session.sessionId, task, route: createCodingWorkerRouteProfile(config), timeoutMs: 1000, maxRetries: 0 });
    const restoredLegacyWorker = await store.loadWorkerSession(legacyWorker.workerSessionId);
    expect(restoredLegacyWorker?.modelAssignment).toBeUndefined();
    expect(restoredLegacyWorker).toMatchObject({
      route: { role: "coding_worker", provider: "provider-a", model: "mutated-after-dispatch" },
    });

    await store.appendEvent(session.sessionId, {
      recordType: "routing_decision", sessionId: session.sessionId, turnId: turn.turnId, createdAt: new Date().toISOString(), mode: "override",
      automaticTarget: "ds_direct", finalTarget: "glm_coding", overrideTarget: "glm_coding", ruleId: "legacy", reasonCodes: ["explicit_override"], reasonSummary: "legacy", features: { isScreenshotTask: false, isComplexCodingTask: true, isCrossFile: false, requiresBackend: false, isSmallPatch: false },
    } as unknown as RoutingDecisionRecord);
    const legacy = (await store.loadEvents(session.sessionId)).find((event) => event.recordType === "routing_decision");
    expect(legacy).toMatchObject({ automaticTarget: "governor_direct", finalTarget: "coding_worker", legacyTarget: "glm_coding" });
  });

  it("aggregates safe model dimensions and redacts exports, provider errors, URLs, and headers", async () => {
    const root = await workspace();
    const store = new SessionStore(root);
    await store.ensureInitialized();
    const session = await store.createSession("secret export test");
    const assignment = createModelAssignmentSnapshot({
      slot: "governor",
      config: {
        apiKey: "telemetry-secret", profileId: "public-profile", provider: "provider-a", adapterId: "openai_compatible", protocol: "openai_chat_completions", capabilities: capabilities(), baseUrl: "https://provider.invalid", endpointPath: "/chat", model: "public-model", role: "governor", stream: true, contextWindow: 128_000, maxRetries: 0, timeoutMs: 1000, contextSoftLimitTokens: 100_000, contextCompactThresholdTokens: 90_000, contextReserveOutputTokens: 4_000, contextSummaryMaxTokens: 1_000, contextRecentTailMaxTokens: 20_000, maxHistoryMessages: 0, historyCharBudget: 10_000, temperature: 0, thinking: { type: "enabled", reasoningEffort: "medium" }, headers: { Authorization: "Bearer telemetry-secret" }, requestDefaults: {}, replyStyle: "pragmatic",
      },
      configRevision: 4, selectionReason: "primary", source: "settings",
    });
    await store.recordModelInvocation(session.sessionId, assignment, { result: "success", latencyMs: 25, inputTokens: 10, outputTokens: 5, reasoningTokens: 2 });
    await store.recordGovernorDirectSuccess(session.sessionId, "turn-22");
    const telemetry = await store.loadTelemetrySummary();
    expect(telemetry.counters.governorDirectSuccessCount).toBe(1);
    expect(Object.values(telemetry.counters.modelInvocations)[0]).toMatchObject({ slot: "governor", adapterId: "openai_compatible", provider: "provider-a", model: "public-model", result: "success", count: 1, totalLatencyMs: 25, inputTokens: 10 });
    expect(JSON.stringify(telemetry)).not.toContain("telemetry-secret");

    const turn = await store.startTurn({ sessionId: session.sessionId, requestSummary: "safe", userMessageId: "user", modelAssignment: assignment });
    await store.appendMessage({ sessionId: session.sessionId, turnId: turn.turnId, role: "assistant", content: "Authorization: Bearer export-super-secret https://api.invalid/path?token=secret#fragment", metadata: { apiKey: "metadata-super-secret", headers: { authorization: "Bearer header-super-secret" } } });
    await store.finishTurn({ sessionId: session.sessionId, turnId: turn.turnId, startedAt: turn.startedAt, requestSummary: "safe", userMessageId: "user", toolCallIds: [], status: "completed", error: "provider https://api.invalid/error?signature=secret" });
    const exported = await store.exportSessionMarkdown({ sessionId: session.sessionId });
    expect(exported.content).not.toMatch(/export-super-secret|metadata-super-secret|header-super-secret|signature=secret/);
    expect(exported.content).toContain("[REDACTED]");
    expect(exported.content).toContain("[REDACTED_QUERY]");
    expect(redactProviderText("failed https://api.invalid/x?opaque=value Authorization: Bearer provider-secret", resolvedProfile("redact", { apiKey: "provider-secret" }))).not.toContain("provider-secret");
  });

  it("keeps settings and profile resolution isolated across workspaces while historical snapshots survive deletion", async () => {
    const first = await workspace("deep-mix-phase22-first-");
    const second = await workspace("deep-mix-phase22-second-");
    await writeProfiles(first);
    await writeV2Settings(first);
    await writeV2Settings(second, configuredModels("missing", "missing", "missing"));
    expect(new ProfileService(first).listPublicProfiles().some((entry) => entry.profileId === "omni")).toBe(true);
    expect(new ProfileService(second, {},).listPublicProfiles().some((entry) => entry.profileId === "omni")).toBe(false);
    expect(loadDeepMixSettingsSync(second, { collectErrors: false }).settings.models?.slots.governor.primary.profile).toBe("missing");

    const store = new SessionStore(first);
    await store.ensureInitialized();
    const session = await store.createSession("history survives profile deletion");
    const snapshot = createModelAssignmentSnapshot({ slot: "coding", config: (await loadCodingWorkerModelCandidates(first, {})).configs[0]!, configRevision: 3, selectionReason: "primary", source: "settings" });
    const turn = await store.startTurn({ sessionId: session.sessionId, requestSummary: "fixed", userMessageId: "user", modelAssignment: snapshot });
    await fs.writeFile(resolveProjectApiKeyLibraryPath(first), JSON.stringify({ version: 2, revision: 8, profiles: {} }), "utf8");
    const historicalTurn = (await store.loadEvents(session.sessionId)).find((event) => event.recordType === "turn" && event.turnId === turn.turnId);
    expect(historicalTurn?.recordType === "turn" ? historicalTurn.modelAssignment?.profileId : undefined).toBe("omni");
    await expect(loadCodingWorkerModelCandidates(first, {})).rejects.toThrow("profile_unavailable");
  });
});

describe("phase 22 CLI and Desktop model-center surface", () => {
  it("shows semantic slots, keeps Desktop routing automatic, normalizes old CLI route inputs, and keeps UI labels brand neutral", async () => {
    const root = await workspace();
    await writeProfiles(root);
    await writeV2Settings(root);
    const status = await readProfileStatus(root);
    expect(status.slots?.governor.primary).toMatchObject({ profileId: "omni", status: { provider: "provider-a", adapterId: "openai_compatible" } });
    expect(status.slots?.coding.primary.profileId).toBe("omni");
    expect(status.slots?.vision.primary.profileId).toBe("vision");
    expect(resolveCliLaunchConfig({ workspaceRoot: root, permissionMode: undefined, routeOverride: "glm_coding" })).toMatchObject({ routeOverride: "coding_worker" });
    const settingsDialog = await fs.readFile(path.resolve("apps/desktop/src/renderer/components/SettingsDialog.tsx"), "utf8");
    expect(settingsDialog).not.toContain('title="模型路由"');
    expect(settingsDialog).not.toContain('ariaLabel="模型路由"');
    expect(settingsDialog).not.toMatch(/label:\s*"(?:DeepSeek|GLM|Kimi)"/);
    expect(settingsDialog).toContain("restoreClassic");
    expect(settingsDialog).toContain("onProbeModel");
    expect(settingsDialog).toContain("ModelProfileEditor");
    expect(settingsDialog).toContain("onSaveModelProfile");
    expect(settingsDialog).toContain("label: candidate.displayName");
    expect(settingsDialog).toContain("state.primary.displayName");
    expect(settingsDialog).not.toContain("label: candidate.profileId");
    expect(settingsDialog).not.toContain("<strong>{state.primary.profileId}");
    const profileEditor = await fs.readFile(path.resolve("apps/desktop/src/renderer/components/ModelProfileEditor.tsx"), "utf8");
    expect(profileEditor).toContain('type="password"');
    expect(profileEditor).toContain('autoComplete="new-password"');
    expect(profileEditor).toContain("apiKeyRef");
    expect(profileEditor).not.toContain("setApiKey");
    expect(profileEditor).toContain("Base URL");
    expect(profileEditor).toContain("openai_compatible");
    expect(profileEditor).toContain("接入名称");
    expect(profileEditor).toContain("内部 Profile ID");
    const preload = await fs.readFile(path.resolve("apps/desktop/src/preload/index.ts"), "utf8");
    expect(preload).toContain('ipcRenderer.invoke("deep-mix:saveModelProfile"');
    const desktopMain = await fs.readFile(path.resolve("apps/desktop/src/main/index.ts"), "utf8");
    expect(desktopMain).toContain('ipcMain.handle("deep-mix:saveModelProfile"');
    expect(desktopMain).toContain("expectedProfileRevision");
    expect(desktopMain).toContain('deepseek_governor: "经典总线接入"');
    expect(desktopMain).toContain('glm_coding_worker: "经典编程接入"');
    expect(desktopMain).toContain('kimi_vision: "经典视觉接入"');
    expect(desktopMain).not.toContain("routeOverride: context.routeOverride");
    expect(desktopMain).not.toContain("routeOverride: input.routeOverride");
    const inputBar = await fs.readFile(path.resolve("apps/desktop/src/renderer/components/InputBar.tsx"), "utf8");
    expect(inputBar).not.toContain('ariaLabel="模型路由"');
    expect(inputBar).not.toContain("onSetRoute");
    expect(inputBar).not.toMatch(/label:\s*"(?:DeepSeek|GLM|Kimi)/);
    const sessionSidebar = await fs.readFile(path.resolve("apps/desktop/src/renderer/components/SessionSidebar.tsx"), "utf8");
    expect(sessionSidebar).toContain("models.slots.governor.primary.status.hasKey");
    const promptCompiler = await fs.readFile(path.resolve("packages/core-governor/src/prompt-compiler.ts"), "utf8");
    expect(promptCompiler).toContain("the runtime's only orchestration bus");
    expect(promptCompiler).not.toContain("Deep-Mix DeepSeek governor");
    const workerTools = await fs.readFile(path.resolve("packages/tool-runtime/src/built-ins/workers/index.ts"), "utf8");
    expect(workerTools).toContain("selected by the coding model slot");
    expect(workerTools).toContain("selected by the vision model slot");
    expect(workerTools).toContain('systems: ["coding_worker"]');
    expect(workerTools).toContain('systems: ["vision_worker"]');
    expect(workerTools).not.toMatch(/isolated (?:GLM|Kimi) (?:coding|vision) worker/i);
    const imageTools = await fs.readFile(path.resolve("packages/tool-runtime/src/built-ins/structured-documents/images.ts"), "utf8");
    expect(imageTools).toContain("configured Vision Worker");
    expect(imageTools).not.toContain("Kimi Vision Worker");
    const repositoryRules = await fs.readFile(path.resolve("AGENTS.md"), "utf8");
    expect(repositoryRules).toContain("configured `governor` model slot");
    expect(repositoryRules).toContain("`classic` compatibility preset");
    expect(repositoryRules).not.toContain("`DeepSeek` remains the only governor");
    const cliMain = await fs.readFile(path.resolve("apps/cli/src/main.ts"), "utf8");
    const cliShell = await fs.readFile(path.resolve("apps/cli/src/session-shell.ts"), "utf8");
    expect(cliMain).toContain("reloadRuntime: async");
    expect(cliShell).toContain("apply to subsequent Provider cycles and worker dispatches");
  });
});
