import { stdin as input, stdout as output } from "node:process";
import { GovernorRuntime } from "../../../packages/core-governor/src/index.js";
import { SessionStore } from "../../../packages/persistence/src/index.js";
import { CliSessionShell, createNodePromptReader, readProfileStatus } from "./session-shell.js";
import { createTerminalTui, detectTerminalTuiSupport } from "./terminal-tui.js";
import { parseArgs } from "./cli-args.js";
import { resolveCliLaunchConfig } from "./launch-config.js";
import { createNodeSystemToolNetworkService } from "../../../packages/tool-runtime/src/network/node-system.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { permissionMode, routeOverride } = resolveCliLaunchConfig(args);
  if (args.routeOverride && !routeOverride) {
    throw new Error(`Unsupported route override: ${args.routeOverride}`);
  }

  const networkService = createNodeSystemToolNetworkService(process.env);
  const createRuntime = () => new GovernorRuntime({
    workspaceRoot: args.workspaceRoot,
    permissionMode,
    networkService,
  });
  let runtime = createRuntime();
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
    reloadRuntime: async () => {
      const nextRuntime = createRuntime();
      await nextRuntime.initialize();
      const previousRuntime = runtime;
      try {
        await previousRuntime.dispose();
      } catch (error) {
        await nextRuntime.dispose();
        throw error;
      }
      runtime = nextRuntime;
      return nextRuntime;
    },
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
