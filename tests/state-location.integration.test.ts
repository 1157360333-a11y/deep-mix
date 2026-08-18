import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../packages/persistence/src/index.js";
import { loadDeepMixSettingsSync } from "../packages/settings/src/index.js";

const temporaryRoots: string[] = [];

async function createRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("user-level workspace state", () => {
  it("initializes an ordinary workspace without creating a project .deep-mix directory", async () => {
    const workspaceRoot = await createRoot("deep-mix-clean-workspace-");
    const homeDir = await createRoot("deep-mix-clean-home-");

    const loaded = loadDeepMixSettingsSync(workspaceRoot, { homeDir });
    expect(loaded.settings).toEqual({});
    expect(await fs.readdir(workspaceRoot)).toEqual([]);

    const store = new SessionStore(workspaceRoot, { homeDir });
    await store.ensureInitialized();

    expect(path.relative(workspaceRoot, store.paths.stateDir)).toMatch(/^\.\./u);
    expect((await fs.stat(store.paths.sessionsDir)).isDirectory()).toBe(true);
    expect(await fs.readdir(workspaceRoot)).toEqual([]);
  });

  it("moves legacy runtime data out of the project and removes an otherwise empty .deep-mix directory", async () => {
    const workspaceRoot = await createRoot("deep-mix-legacy-workspace-");
    const homeDir = await createRoot("deep-mix-legacy-home-");
    const legacyRoot = path.join(workspaceRoot, ".deep-mix");
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.writeFile(
      path.join(legacyRoot, "runtime-capabilities.json"),
      JSON.stringify({ checkedAt: "2026-08-16T00:00:00.000Z", capabilities: {} }),
      "utf8",
    );

    const store = new SessionStore(workspaceRoot, { homeDir });
    await store.ensureInitialized();

    expect(JSON.parse(await fs.readFile(store.paths.runtimeCapabilitiesPath, "utf8"))).toMatchObject({
      checkedAt: "2026-08-16T00:00:00.000Z",
    });
    await expect(fs.access(legacyRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an existing project settings file while migrating adjacent runtime data", async () => {
    const workspaceRoot = await createRoot("deep-mix-configured-workspace-");
    const homeDir = await createRoot("deep-mix-configured-home-");
    const legacyRoot = path.join(workspaceRoot, ".deep-mix");
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.writeFile(
      path.join(legacyRoot, "settings.json"),
      JSON.stringify({ defaults: { permissionMode: "plan" } }),
      "utf8",
    );
    await fs.writeFile(path.join(legacyRoot, "promotion-log.jsonl"), "{\"recordType\":\"legacy\"}\n", "utf8");

    const store = new SessionStore(workspaceRoot, { homeDir });
    await store.ensureInitialized();

    expect(await fs.readdir(legacyRoot)).toEqual(["settings.json"]);
    expect(await fs.readFile(store.paths.promotionLogPath, "utf8")).toContain("legacy");
    expect(loadDeepMixSettingsSync(workspaceRoot, { homeDir }).settings.defaults?.permissionMode).toBe("plan");
  });
});
