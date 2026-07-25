import { stdin as input, stdout as output } from "node:process";
import { createRequire } from "node:module";
import { GovernorRuntime } from "../../../packages/core-governor/src/index.js";
import { SessionStore } from "../../../packages/persistence/src/index.js";
import { CliSessionShell, createNodePromptReader, readProfileStatus } from "./session-shell.js";
import { createTerminalTui, detectTerminalTuiSupport } from "./terminal-tui.js";
import { parseArgs } from "./cli-args.js";
import { resolveCliLaunchConfig } from "./launch-config.js";
import { createNodeSystemToolNetworkService } from "../../../packages/tool-runtime/src/network/node-system.js";

const require = createRequire(import.meta.url);
const packageJson = require("../../../package.json") as { version?: string };
const version = packageJson.version ?? "1.0.0";

const HELP = `Deep-Mix v${version}

Usage:
  npm run cli -- [prompt] [options]

Options:
  -h, --help                 Show this help
  -v, --version              Show the installed version
  --prompt <text>            Start with an initial prompt
  --workspace <path>         Set the workspace (default: current directory)
  --mode <mode>              plan | edit | auto | danger-full-access
  --route <route>            ds_direct | glm_coding | kimi_vision
  --resume [session-id]      Resume a session
  --list-skills              Print discovered skills as JSON
  --skill-query <text>       Filter --list-skills results
  --mcp-status               Print MCP server status as JSON
  --run-workflow <name>      Run a configured deterministic workflow
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.showHelp) {
    output.write(HELP);
    return;
  }
  if (args.showVersion) {
    output.write(`${version}\n`);
    return;
  }
  const { permissionMode, routeOverride } = resolveCliLaunchConfig(args);
  if (args.routeOverride && !routeOverride) {
    throw new Error(`Unsupported route override: ${args.routeOverride}`);
  }

  const networkService = createNodeSystemToolNetworkService(process.env);
  const runtime = new GovernorRuntime({
    workspaceRoot: args.workspaceRoot,
    permissionMode,
    networkService,
  });
  await runtime.initialize();

  if (args.listSkills) {
    const skills = await runtime.listSkills(args.skillQuery);
    output.write(
      `${JSON.stringify(
        skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          enabled: skill.enabled,
          allowImplicitInvocation: skill.allowImplicitInvocation,
          sourcePath: skill.sourcePath,
          sourceScope: skill.sourceScope,
        })),
        null,
        2,
      )}\n`,
    );
    await runtime.dispose();
    return;
  }

  if (args.showMcpStatus) {
    const statuses = await runtime.listMcpServerStatuses();
    output.write(`${JSON.stringify(statuses, null, 2)}\n`);
    await runtime.dispose();
    return;
  }

  if (args.runWorkflow) {
    const result = await runtime.runWorkflow({
      name: args.runWorkflow,
      sessionId: args.resumeSessionId,
    });
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    await runtime.dispose();
    return;
  }

  const sessionStore = new SessionStore(args.workspaceRoot);
  const tuiSupport = detectTerminalTuiSupport(input, output);
  const terminalTui = tuiSupport.supported ? createTerminalTui(input, output) : undefined;
  const promptReader = terminalTui?.input ?? createNodePromptReader(input, output);
  const outputWriter = terminalTui?.output ?? output;
  const shell = new CliSessionShell({
    runtime,
    sessionStore,
    input: promptReader,
    output: outputWriter,
    workspaceRoot: args.workspaceRoot,
    permissionMode,
    routeOverride,
    getProfileStatus: () => readProfileStatus(args.workspaceRoot),
  });

  const handleSigint = () => {
    void shell.requestInterrupt();
  };
  process.on("SIGINT", handleSigint);
  terminalTui?.setInterruptHandler(() => {
    void shell.requestInterrupt();
  });

  if (!terminalTui && tuiSupport.reason) {
    output.write(`[fallback] simplified shell: ${tuiSupport.reason}\n`);
  }

  try {
    await shell.run({
      initialPrompt: args.prompt?.trim() || undefined,
      resumeRequested: args.resume,
      resumeSessionId: args.resumeSessionId,
    });
  } finally {
    process.off("SIGINT", handleSigint);
    terminalTui?.close();
    await runtime.dispose();
  }
}

await main();
