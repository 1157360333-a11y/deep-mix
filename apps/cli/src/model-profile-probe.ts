import { createDefaultModelAdapterRegistry, ProfileService } from "../../../packages/model-adapters/src/index.js";

interface ProbeArgs {
  profile?: string;
  timeoutMs: number;
}

function parseArgs(argv: string[]): ProbeArgs {
  const args: ProbeArgs = { timeoutMs: 30_000 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--profile" && argv[index + 1]) {
      args.profile = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--timeout-ms" && argv[index + 1]) {
      args.timeoutMs = Number(argv[index + 1]);
      index += 1;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.profile) throw new Error("Missing required --profile <name>.");
  const service = new ProfileService(process.cwd(), process.env);
  const profile = service.listPublicProfiles().find((entry) => entry.profileId === args.profile);
  if (!profile) throw new Error(`Unknown profile: ${args.profile}`);
  if (!profile.hasCredential) {
    console.log(JSON.stringify({
      ok: false,
      skipped: true,
      reason: "missing_credential",
      profile: {
        profileId: profile.profileId,
        provider: profile.provider,
        model: profile.model,
        adapterId: profile.adapterId,
        protocol: profile.protocol,
        capabilities: profile.capabilities,
      },
    }, null, 2));
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const result = await service.probe(args.profile, createDefaultModelAdapterRegistry(), controller.signal);
    console.log(JSON.stringify({
      ...result,
      profile: {
        profileId: profile.profileId,
        provider: profile.provider,
        model: profile.model,
      },
    }, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
  }
}

await main();
