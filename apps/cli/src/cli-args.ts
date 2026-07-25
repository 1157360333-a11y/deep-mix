import { execFileSync } from "node:child_process";
import path from "node:path";

export interface ParsedArgs {
  prompt?: string;
  resume: boolean;
  resumeSessionId?: string;
  workspaceRoot: string;
  permissionMode?: "plan" | "edit" | "auto" | "danger-full-access";
  routeOverride?: string;
  listSkills: boolean;
  skillQuery?: string;
  showMcpStatus: boolean;
  runWorkflow?: string;
  showHelp: boolean;
  showVersion: boolean;
}

interface ParseArgOptions {
  cwd?: string;
  platform?: NodeJS.Platform;
  rawCommandLine?: string;
  rawCommandLineCandidates?: string[];
  environment?: NodeJS.ProcessEnv;
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractFlagValueFromRawCommandLine(rawCommandLine: string, flag: string): string | undefined {
  const match = rawCommandLine.match(
    new RegExp(
      `(?:^|\\s)${escapeForRegex(flag)}(?:=(?:"([^"]*)"|(\\S+))|\\s+(?:"([^"]*)"|(\\S+)))`,
      "i",
    ),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4];
}

function looksLikeBrokenWindowsDrivePath(value: string): boolean {
  return /^[A-Za-z]:[^\\/]/.test(value);
}

function isGitBashEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(environment.MSYSTEM) || /bash\.exe$/i.test(environment.SHELL ?? "");
}

function readWindowsCommandLineCandidates(): string[] {
  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        [
          "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
          `$processId = ${process.pid}`,
          "$commands = New-Object System.Collections.Generic.List[string]",
          "while ($processId) {",
          '  $proc = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $processId)',
          "  if (-not $proc) { break }",
          "  if ($proc.CommandLine) { [void]$commands.Add($proc.CommandLine) }",
          "  $parentId = [int]$proc.ParentProcessId",
          "  if ($parentId -le 0 -or $parentId -eq $processId) { break }",
          "  $processId = $parentId",
          "}",
          "$commands | ConvertTo-Json -Compress",
        ].join("; "),
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (!output) {
      return [];
    }
    const parsed = JSON.parse(output) as string[] | string;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function recoverWindowsWorkspacePath(parsedValue: string, rawCommandLineCandidates: string[]): string {
  if (!looksLikeBrokenWindowsDrivePath(parsedValue)) {
    return parsedValue;
  }
  for (const rawCommandLine of rawCommandLineCandidates) {
    const recoveredValue = extractFlagValueFromRawCommandLine(rawCommandLine, "--workspace");
    if (recoveredValue && path.win32.isAbsolute(recoveredValue)) {
      return recoveredValue;
    }
  }
  return parsedValue;
}

export function parseArgs(argv: string[], options: ParseArgOptions = {}): ParsedArgs {
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const args: ParsedArgs = {
    resume: false,
    workspaceRoot: cwd,
    listSkills: false,
    showMcpStatus: false,
    showHelp: false,
    showVersion: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--help" || value === "-h") {
      args.showHelp = true;
      continue;
    }

    if (value === "--version" || value === "-v") {
      args.showVersion = true;
      continue;
    }

    if (value === "--prompt" && argv[index + 1]) {
      args.prompt = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--resume") {
      args.resume = true;
      if (argv[index + 1] && !argv[index + 1]?.startsWith("--")) {
        args.resumeSessionId = argv[index + 1];
        index += 1;
      }
      continue;
    }

    if (value === "--workspace" && argv[index + 1]) {
      args.workspaceRoot = argv[index + 1];
      index += 1;
      continue;
    }

    if (value.startsWith("--workspace=")) {
      args.workspaceRoot = value.slice("--workspace=".length);
      continue;
    }

    if (value === "--mode" && argv[index + 1]) {
      args.permissionMode = argv[index + 1] as ParsedArgs["permissionMode"];
      index += 1;
      continue;
    }

    if (value === "--route" && argv[index + 1]) {
      args.routeOverride = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--list-skills") {
      args.listSkills = true;
      continue;
    }

    if (value === "--skill-query" && argv[index + 1]) {
      args.skillQuery = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--mcp-status") {
      args.showMcpStatus = true;
      continue;
    }

    if (value === "--run-workflow" && argv[index + 1]) {
      args.runWorkflow = argv[index + 1];
      index += 1;
      continue;
    }

    if (!value.startsWith("--") && !args.prompt) {
      args.prompt = value;
    }
  }

  if (platform === "win32") {
    if (looksLikeBrokenWindowsDrivePath(args.workspaceRoot)) {
      const explicitCandidates =
        options.rawCommandLineCandidates ??
        (options.rawCommandLine ? [options.rawCommandLine] : []);
      args.workspaceRoot = recoverWindowsWorkspacePath(args.workspaceRoot, explicitCandidates);
      if (
        looksLikeBrokenWindowsDrivePath(args.workspaceRoot) &&
        options.rawCommandLineCandidates === undefined
      ) {
        args.workspaceRoot = recoverWindowsWorkspacePath(
          args.workspaceRoot,
          readWindowsCommandLineCandidates(),
        );
      }
    }
    if (looksLikeBrokenWindowsDrivePath(args.workspaceRoot) && !path.win32.isAbsolute(args.workspaceRoot)) {
      if (isGitBashEnvironment(environment)) {
        throw new Error(
          [
            `Git Bash stripped the backslashes from --workspace before Deep-Mix started: ${args.workspaceRoot}`,
            "Use one of these Git Bash-safe forms instead:",
            `npm run cli -- --workspace 'C:\\path\\to\\repo'`,
            `npm run cli -- --workspace C:/path/to/repo`,
            `npm run cli -- --workspace /c/path/to/repo`,
          ].join("\n"),
        );
      }
      throw new Error(
        [
          `Workspace path was mangled by the Windows npm script launcher: ${args.workspaceRoot}`,
          "Retry with one of these forms:",
          `npm run cli -- --workspace C:\\\\path\\\\to\\\\repo`,
          `npm run cli -- --workspace C:/path/to/repo`,
        ].join("\n"),
      );
    }
  }

  args.workspaceRoot = path.resolve(cwd, args.workspaceRoot);
  return args;
}
