import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inspectApiKeyLibraryProfiles,
  loadDeepSeekProviderConfig,
  resolveApiKeyLibraryPath,
} from "../packages/route-resolver/src/index.js";

const temporaryRoots: string[] = [];
const originalCwd = process.cwd();

async function writeProfilesFile(root: string, model: string): Promise<void> {
  const libraryDir = path.join(root, ".deep-mix", "api-key-library");
  await fs.mkdir(libraryDir, { recursive: true });
  await fs.writeFile(
    path.join(libraryDir, "profiles.local.json"),
    JSON.stringify(
      {
        version: 1,
        profiles: {
          deepseek_governor: {
            provider: "deepseek",
            role: "governor",
            apiKey: "fake-local-key",
            baseUrl: `https://${model}.invalid`,
            chatPath: "/chat/completions",
            model,
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function createWorkspace(prefix: string): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(workspaceRoot);
  return workspaceRoot;
}

beforeEach(() => {
  process.chdir(originalCwd);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe("API key library resolution", () => {
  it("falls back to the launch directory library when the target workspace does not have one", async () => {
    const launchRoot = await createWorkspace("deep-mix-launch-root-");
    const targetWorkspace = await createWorkspace("deep-mix-target-root-");
    await writeProfilesFile(launchRoot, "deepseek-from-launch-root");
    process.chdir(launchRoot);
    const env = { DEEP_MIX_HOME: path.join(targetWorkspace, "isolated-home") };

    expect(resolveApiKeyLibraryPath(targetWorkspace, env)).toBe(
      path.join(launchRoot, ".deep-mix", "api-key-library", "profiles.local.json"),
    );

    const config = loadDeepSeekProviderConfig(targetWorkspace, env);
    expect(config.baseUrl).toBe("https://deepseek-from-launch-root.invalid");
  });

  it("prefers a workspace-local library over the launch directory fallback", async () => {
    const launchRoot = await createWorkspace("deep-mix-launch-root-");
    const targetWorkspace = await createWorkspace("deep-mix-target-root-");
    await writeProfilesFile(launchRoot, "deepseek-from-launch-root");
    await writeProfilesFile(targetWorkspace, "deepseek-from-target-workspace");
    process.chdir(launchRoot);

    expect(resolveApiKeyLibraryPath(targetWorkspace, {})).toBe(
      path.join(targetWorkspace, ".deep-mix", "api-key-library", "profiles.local.json"),
    );

    const config = loadDeepSeekProviderConfig(targetWorkspace, {});
    expect(config.baseUrl).toBe("https://deepseek-from-target-workspace.invalid");
  });

  it("finds the launch workspace library when the desktop process starts from a nested package", async () => {
    const launchRoot = await createWorkspace("deep-mix-launch-root-");
    const targetWorkspace = await createWorkspace("deep-mix-target-root-");
    const nestedDesktopRoot = path.join(launchRoot, "apps", "desktop");
    await fs.mkdir(nestedDesktopRoot, { recursive: true });
    await writeProfilesFile(launchRoot, "deepseek-from-launch-root");
    process.chdir(nestedDesktopRoot);
    const env = { DEEP_MIX_HOME: path.join(targetWorkspace, "isolated-home") };

    expect(resolveApiKeyLibraryPath(targetWorkspace, env)).toBe(
      path.join(launchRoot, ".deep-mix", "api-key-library", "profiles.local.json"),
    );
    expect(loadDeepSeekProviderConfig(targetWorkspace, env).baseUrl).toBe("https://deepseek-from-launch-root.invalid");
  });

  it("uses the explicit desktop fallback root and reports the same effective profile status", async () => {
    const launchRoot = await createWorkspace("deep-mix-launch-root-");
    const targetWorkspace = await createWorkspace("deep-mix-target-root-");
    await writeProfilesFile(launchRoot, "deepseek-from-launch-root");
    process.chdir(launchRoot);
    const env = { DEEP_MIX_API_KEY_LIBRARY_ROOT: launchRoot, DEEP_MIX_HOME: path.join(targetWorkspace, "isolated-home") };

    expect(loadDeepSeekProviderConfig(targetWorkspace, env).baseUrl).toBe("https://deepseek-from-launch-root.invalid");
    expect(inspectApiKeyLibraryProfiles(targetWorkspace, [
      "deepseek_governor",
      "glm_coding_worker",
      "kimi_vision",
    ] as const, env)).toEqual({
      deepseek_governor: { exists: true, hasKey: true },
      glm_coding_worker: { exists: false, hasKey: false },
      kimi_vision: { exists: false, hasKey: false },
    });
  });
});
