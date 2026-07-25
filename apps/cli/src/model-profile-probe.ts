import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type ProviderName = "deepseek" | "glm" | "kimi";
type RoleName = "governor" | "coding_worker" | "vision_worker";

interface ApiKeyProfile {
  provider: ProviderName;
  role: RoleName;
  apiKey?: string;
  apiKeyEnvName?: string;
  baseUrl: string;
  chatPath: string;
  model: string;
  supportsMultimodalInput?: boolean;
  headers: Record<string, string>;
  requestDefaults: Record<string, unknown>;
  notes?: string;
}

interface ApiKeyLibrary {
  version: number;
  profiles: Record<string, ApiKeyProfile>;
}

interface ProbeArgs {
  profile?: string;
  message: string;
  timeoutMs: number;
}

function parseArgs(argv: string[]): ProbeArgs {
  const args: ProbeArgs = {
    message: "Reply with a short JSON object: {\"ok\": true, \"provider\": \"...\"}.",
    timeoutMs: 30000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--profile" && argv[index + 1]) {
      args.profile = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--message" && argv[index + 1]) {
      args.message = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--timeout-ms" && argv[index + 1]) {
      args.timeoutMs = Number(argv[index + 1]);
      index += 1;
    }
  }

  return args;
}

async function loadLibrary(): Promise<ApiKeyLibrary> {
  const libraryPath = resolve(process.cwd(), ".deep-mix/api-key-library/profiles.local.json");
  const raw = await readFile(libraryPath, "utf8");
  return JSON.parse(raw) as ApiKeyLibrary;
}

function resolveApiKey(profile: ApiKeyProfile): string {
  const inline = profile.apiKey?.trim();
  if (inline) {
    return inline;
  }

  if (profile.apiKeyEnvName) {
    const fromEnv = process.env[profile.apiKeyEnvName]?.trim();
    if (fromEnv) {
      return fromEnv;
    }
  }

  throw new Error(
    `No API key available for profile. Fill apiKey or set ${profile.apiKeyEnvName ?? "the configured env var"}.`,
  );
}

function buildUrl(baseUrl: string, chatPath: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${chatPath.startsWith("/") ? chatPath : `/${chatPath}`}`;
}

function redactProfile(profileName: string, profile: ApiKeyProfile) {
  return {
    profile: profileName,
    provider: profile.provider,
    role: profile.role,
    baseUrl: profile.baseUrl,
    chatPath: profile.chatPath,
    model: profile.model,
    supportsMultimodalInput: profile.supportsMultimodalInput ?? false,
    apiKeySource: profile.apiKey?.trim() ? "inline-local-file" : `env:${profile.apiKeyEnvName ?? "unset"}`,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.profile) {
    throw new Error("Missing required --profile <name>.");
  }

  const library = await loadLibrary();
  const profile = library.profiles[args.profile];
  if (!profile) {
    throw new Error(`Unknown profile: ${args.profile}`);
  }

  const apiKey = resolveApiKey(profile);
  const url = buildUrl(profile.baseUrl, profile.chatPath);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);

  const requestBody = {
    model: profile.model,
    messages: [
      {
        role: "system",
        content: "You are a connectivity probe. Return a concise result only.",
      },
      {
        role: "user",
        content: args.message,
      },
    ],
    ...profile.requestDefaults,
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...profile.headers,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    const contentType = response.headers.get("content-type") ?? "";
    const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
    const rawBody = await response.text();

    let responsePreview = rawBody;
    if (contentType.includes("application/json")) {
      try {
        const parsed = JSON.parse(rawBody) as {
          choices?: Array<{ message?: { content?: string } }>;
          error?: { message?: string };
        };
        responsePreview =
          parsed.choices?.[0]?.message?.content ??
          parsed.error?.message ??
          rawBody;
      } catch {
        responsePreview = rawBody;
      }
    }

    const safePreview = responsePreview.slice(0, 400);
    const payload = {
      ok: response.ok,
      status: response.status,
      requestId,
      profile: redactProfile(args.profile, profile),
      responsePreview: safePreview,
    };

    console.log(JSON.stringify(payload, null, 2));

    if (!response.ok) {
      process.exitCode = 1;
    }
  } finally {
    clearTimeout(timeout);
  }
}

await main();
