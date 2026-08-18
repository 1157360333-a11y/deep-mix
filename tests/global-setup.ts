import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export default async function setup(): Promise<() => Promise<void>> {
  const deepMixTestHome = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-vitest-home-"));
  process.env.DEEP_MIX_HOME = deepMixTestHome;
  const libraryDirectory = path.join(deepMixTestHome, "api-key-library");
  await fs.mkdir(libraryDirectory, { recursive: true });
  await fs.writeFile(path.join(libraryDirectory, "profiles.local.json"), JSON.stringify({
    version: 1,
    profiles: {
      deepseek_governor: {
        provider: "deepseek", role: "governor", apiKey: "fixture-governor-key",
        baseUrl: "https://governor.invalid", chatPath: "/chat/completions", model: "fixture-governor",
        headers: {}, requestDefaults: {},
      },
      glm_coding_worker: {
        provider: "glm", role: "coding_worker", apiKey: "fixture-coding-key",
        baseUrl: "https://coding.invalid", chatPath: "/chat/completions", model: "fixture-coding",
        headers: {}, requestDefaults: {},
      },
      kimi_vision: {
        provider: "kimi", role: "vision_worker", supportsMultimodalInput: true, apiKey: "fixture-vision-key",
        baseUrl: "https://vision.invalid", chatPath: "/chat/completions", model: "fixture-vision",
        headers: {}, requestDefaults: {},
      },
    },
  }, null, 2), "utf8");
  return async () => {
    await fs.rm(deepMixTestHome, { recursive: true, force: true });
  };
}
