import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCliLaunchConfig } from "../apps/cli/src/launch-config.js";
import { loadDeepSeekProviderConfig } from "../packages/route-resolver/src/index.js";
import { extractEnabledSkills, loadDeepMixSettingsSync } from "../packages/settings/src/index.js";

const temporaryRoots: string[] = [];

async function createWorkspace(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, ".deep-mix", "api-key-library"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".deep-mix", "api-key-library", "profiles.local.json"),
    JSON.stringify(
      {
        version: 1,
        profiles: {
          deepseek_governor: {
            provider: "deepseek",
            role: "governor",
            apiKey: "fake-local-key",
            baseUrl: "https://example.invalid",
            chatPath: "/chat/completions",
            model: "deepseek-v4-pro",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe("deep-mix settings loader", () => {
  it("merges user and project settings while preserving enabledSkills compatibility", async () => {
    const workspaceRoot = await createWorkspace("deep-mix-settings-merge-");
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-home-"));
    temporaryRoots.push(homeDir);

    await fs.mkdir(path.join(homeDir, ".deep-mix"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".deep-mix", "settings.json"),
      JSON.stringify(
        {
          version: 1,
          defaults: {
            permissionMode: "edit",
          },
          governor: {
            contextWindow: 1000000,
            replyStyle: "friendly",
          },
          skills: {
            enabledSkills: {
              "release-check": true,
            },
          },
          webSearch: {
            braveApiKey: "user-search-key",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await fs.writeFile(
      path.join(workspaceRoot, ".deep-mix", "settings.json"),
      JSON.stringify(
        {
          version: 1,
          defaults: {
            routeOverride: "glm_coding",
          },
          enabledSkills: {
            "release-check": false,
            "manual-only": true,
          },
          webSearch: {
            braveApiKey: "project-search-key",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadDeepMixSettingsSync(workspaceRoot, {
      homeDir,
      collectErrors: false,
    });

    expect(loaded.settings.defaults?.permissionMode).toBe("edit");
    expect(loaded.settings.defaults?.routeOverride).toBe("glm_coding");
    expect(loaded.settings.governor?.contextWindow).toBe(1000000);
    expect(loaded.settings.governor?.replyStyle).toBe("friendly");
    expect(loaded.settings.webSearch?.braveApiKey).toBe("project-search-key");
    expect(extractEnabledSkills(loaded.settings)).toEqual({
      "release-check": false,
      "manual-only": true,
    });
  });

  it("lets CLI defaults come from settings and still gives explicit args higher priority", async () => {
    const workspaceRoot = await createWorkspace("deep-mix-cli-settings-");
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-home-"));
    temporaryRoots.push(homeDir);

    await fs.mkdir(path.join(homeDir, ".deep-mix"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".deep-mix", "settings.json"),
      JSON.stringify(
        {
          defaults: {
            permissionMode: "edit",
            routeOverride: "glm_coding",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await fs.writeFile(
      path.join(workspaceRoot, ".deep-mix", "settings.json"),
      JSON.stringify(
        {
          defaults: {
            permissionMode: "auto",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const fromSettings = resolveCliLaunchConfig(
      {
        workspaceRoot,
        permissionMode: undefined,
        routeOverride: undefined,
      },
      {
        homeDir,
      },
    );
    expect(fromSettings.permissionMode).toBe("auto");
    expect(fromSettings.routeOverride).toBe("coding_worker");

    const fromArgs = resolveCliLaunchConfig(
      {
        workspaceRoot,
        permissionMode: "plan",
        routeOverride: "ds_direct",
      },
      {
        homeDir,
      },
    );
    expect(fromArgs.permissionMode).toBe("plan");
    expect(fromArgs.routeOverride).toBe("governor_direct");
  });

  it("lets governor config come from settings but keeps env overrides highest", async () => {
    const workspaceRoot = await createWorkspace("deep-mix-governor-settings-");
    await fs.writeFile(
      path.join(workspaceRoot, ".deep-mix", "settings.json"),
      JSON.stringify(
        {
          governor: {
            model: "deepseek-v4-pro",
            contextWindow: 1000000,
            contextSoftLimitTokens: 900000,
            contextReserveOutputTokens: 32000,
            temperature: 0.1,
            replyStyle: "friendly",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const configured = loadDeepSeekProviderConfig(workspaceRoot, {});
    expect(configured.contextWindow).toBe(1000000);
    expect(configured.contextSoftLimitTokens).toBe(900000);
    expect(configured.contextReserveOutputTokens).toBe(32000);
    expect(configured.temperature).toBe(0.1);
    expect(configured.replyStyle).toBe("friendly");

    const overridden = loadDeepSeekProviderConfig(workspaceRoot, {
      DEEPSEEK_CONTEXT_WINDOW: "64000",
      DEEPSEEK_CONTEXT_SOFT_LIMIT_TOKENS: "48000",
      DEEPSEEK_MODEL: "deepseek-chat",
      DEEPSEEK_TEMPERATURE: "0.3",
      DEEPSEEK_REPLY_STYLE: "pragmatic",
    });
    expect(overridden.contextWindow).toBe(64000);
    expect(overridden.contextSoftLimitTokens).toBe(32000);
    expect(overridden.model).toBe("deepseek-chat");
    expect(overridden.temperature).toBe(0.3);
    expect(overridden.replyStyle).toBe("pragmatic");
  });
});
