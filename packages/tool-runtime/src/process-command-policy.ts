import path from "node:path";

type InlineRuntime = "node" | "python" | "ruby";

function maskQuotedText(command: string, platform: NodeJS.Platform): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let masked = "";
  for (const character of command) {
    if (escaped) {
      masked += character === "\n" || character === "\r" ? character : " ";
      escaped = false;
      continue;
    }
    const escapeCharacter = platform === "win32" ? "`" : "\\";
    if (character === escapeCharacter && quote !== "'") {
      masked += " ";
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
        masked += character;
      } else {
        masked += character === "\n" || character === "\r" ? character : " ";
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      masked += character;
      continue;
    }
    masked += character;
  }
  return masked;
}

function readNestedPayload(command: string, startIndex: number): string | undefined {
  let index = startIndex;
  while (/\s/u.test(command[index] ?? "")) index += 1;
  if (command[index] === "$" && (command[index + 1] === "'" || command[index + 1] === '"')) index += 1;
  const quote = command[index];
  if (quote !== "'" && quote !== '"') return command.slice(index).trim() || undefined;

  index += 1;
  let payload = "";
  let escaped = false;
  for (; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      payload += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      payload += character;
      continue;
    }
    if (character === quote) return payload;
    payload += character;
  }
  return payload || undefined;
}

function nestedShellPayloads(
  command: string,
  platform: NodeJS.Platform,
): Array<{ payload: string; platform: NodeJS.Platform }> {
  const payloads: Array<{ payload: string; platform: NodeJS.Platform }> = [];
  const visible = maskQuotedText(command, platform);
  const launchers: Array<{ pattern: RegExp; platform: NodeJS.Platform }> = [
    { pattern: /\b(?:bash|sh|zsh|dash|ksh)(?:\.exe)?\b[^\r\n;&|]*?\s+-(?:c|lc)\s+/giu, platform: "linux" },
    { pattern: /\b(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*?\s-(?:command|c)\s+/giu, platform: "win32" },
  ];
  for (const launcher of launchers) {
    for (const match of visible.matchAll(launcher.pattern)) {
      const payload = readNestedPayload(command, (match.index ?? 0) + match[0].length);
      if (payload) payloads.push({ payload, platform: launcher.platform });
    }
  }
  return payloads;
}

function nestedProgramPayloads(
  command: string,
  platform: NodeJS.Platform,
): Array<{ payload: string; runtime: InlineRuntime }> {
  const payloads: Array<{ payload: string; runtime: InlineRuntime }> = [];
  const visible = maskQuotedText(command, platform);
  const launchers: Array<{ pattern: RegExp; runtime: InlineRuntime }> = [
    { pattern: /\b(?:node|nodejs)(?:\.exe)?\b[^\r\n;&|]*?\s+(?:-e|--eval)\s+/giu, runtime: "node" },
    { pattern: /\b(?:python|python3|py)(?:\.exe)?\b[^\r\n;&|]*?\s+-c\s+/giu, runtime: "python" },
    { pattern: /\bruby(?:\.exe)?\b[^\r\n;&|]*?\s+-e\s+/giu, runtime: "ruby" },
  ];
  for (const launcher of launchers) {
    for (const match of visible.matchAll(launcher.pattern)) {
      const payload = readNestedPayload(command, (match.index ?? 0) + match[0].length);
      if (payload) payloads.push({ payload, runtime: launcher.runtime });
    }
  }
  return payloads;
}

function programmaticChildPattern(payload: string, runtime: InlineRuntime): string | undefined {
  if (/\b(?:DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP|start_new_session\s*=\s*true|setsid|daemonize)\b|\.unref\s*\(/iu.test(payload)) {
    return "programmatic detached child";
  }
  if (
    runtime === "node" &&
    /(?:child_process|node:child_process)/iu.test(payload) &&
    /\b(?:spawn|fork|exec|execFile)\b/u.test(payload)
  ) return "opaque inline Node child-process launch";
  if (runtime === "python" && /\b(?:subprocess\s*\.\s*Popen|os\s*\.\s*fork)\b/u.test(payload)) {
    return "opaque inline Python child-process launch";
  }
  if (runtime === "ruby" && /\b(?:Process\s*\.\s*(?:spawn|fork)|daemon)\b/u.test(payload)) {
    return "opaque inline Ruby child-process launch";
  }
  return undefined;
}

/** Reject shell detachment forms that would escape phase-17 process ownership. */
export function detachedShellPattern(
  command: string,
  platform: NodeJS.Platform = process.platform,
  recursionDepth = 0,
): string | undefined {
  const visible = maskQuotedText(command, platform);
  const commandPosition = String.raw`(?:^|[;|\r\n({]\s*|\$[A-Za-z_][\w:]*\s*=\s*)(?:&\s*)?`;
  const patterns: Array<[RegExp, string]> = [
    [/\b(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*\s-(?:encodedcommand|enc|e)(?:\s|$)/iu, "opaque encoded PowerShell command"],
    [new RegExp(`${commandPosition}eval\\b`, "iu"), "opaque dynamic shell evaluation"],
  ];
  if (platform === "win32") {
    patterns.push(
      [new RegExp(`${commandPosition}(?:(?:start-process|saps)\\b|start(?![-\\w]))`, "iu"), "PowerShell process launcher"],
      [/\s-asjob(?:\s|$)/iu, "PowerShell background job"],
      [new RegExp(`${commandPosition}start-job\\b`, "iu"), "PowerShell background job"],
      [/\bcmd(?:\.exe)?\b[^\r\n]*\/(?:c|k)\s+start(?:\s|$)/iu, "cmd start"],
    );
  } else {
    patterns.push([
      new RegExp(`${commandPosition}(?:(?:sudo|env|command|exec|time)\\s+)*(?:nohup|disown|setsid|daemonize|systemd-run)\\b`, "iu"),
      "detached POSIX launcher",
    ]);
  }
  patterns.push(
    [new RegExp(`${commandPosition}(?:screen|tmux)\\b[^\\r\\n]*(?:\\s-dm?\\b|new-session\\s+-d\\b)`, "iu"), "detached terminal multiplexer"],
    [new RegExp(`${commandPosition}(?:docker|podman)\\b[^\\r\\n]*\\s-d(?:\\s|$)`, "iu"), "detached container command"],
  );
  for (const [pattern, description] of patterns) {
    if (pattern.test(visible)) return description;
  }

  if (recursionDepth < 3) {
    for (const nested of nestedShellPayloads(command, platform)) {
      if (/(?:\$\(|\$\{|\$[A-Za-z_]|`)/u.test(nested.payload)) return "opaque dynamic nested shell payload";
      const nestedPattern = detachedShellPattern(nested.payload, nested.platform, recursionDepth + 1);
      if (nestedPattern) return `nested shell: ${nestedPattern}`;
    }
    for (const nested of nestedProgramPayloads(command, platform)) {
      const nestedPattern = programmaticChildPattern(nested.payload, nested.runtime);
      if (nestedPattern) return nestedPattern;
    }
  }

  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === (platform === "win32" ? "`" : "\\") && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character !== "&" || command[index - 1] === "&" || command[index + 1] === "&") continue;
    if (command[index - 1] === ">" || command[index + 1] === ">") continue;

    const before = command.slice(0, index).trimEnd();
    const after = command.slice(index + 1).trimStart();
    if (!before && platform !== "win32") continue;
    if (platform === "win32") {
      const previous = before.at(-1);
      const isPowerShellCallOperator = !before || previous === ";" || previous === "|" || previous === "(" || previous === "{";
      if (isPowerShellCallOperator && after) continue;
    }
    if (before && (!after || platform !== "win32")) return "unowned shell background operator";
  }
  return undefined;
}

function executableName(command: string): string {
  return path.basename(command).toLocaleLowerCase("en-US").replace(/\.(?:exe|cmd|bat)$/u, "");
}

/** Inspect direct executable argv without reconstructing it as a shell string. */
export function detachedExecutablePattern(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const executable = executableName(command);
  if (["nohup", "setsid", "daemonize", "systemd-run"].includes(executable)) return "detached POSIX launcher";
  if (["screen", "tmux"].includes(executable) && args.some((value) => /^(?:-dm?|-d)$/u.test(value))) {
    return "detached terminal multiplexer";
  }
  if (["docker", "podman"].includes(executable) && args.includes("-d")) return "detached container command";

  const shellPayloadIndex = ["bash", "sh", "zsh", "dash", "ksh"].includes(executable)
    ? args.findIndex((value) => /^(?:-c|-lc)$/u.test(value))
    : ["powershell", "pwsh"].includes(executable)
      ? args.findIndex((value) => /^(?:-command|-c)$/iu.test(value))
      : executable === "cmd"
        ? args.findIndex((value) => /^(?:\/c|\/k)$/iu.test(value))
        : -1;
  if (shellPayloadIndex >= 0 && args[shellPayloadIndex + 1]) {
    const nestedPlatform = ["powershell", "pwsh", "cmd"].includes(executable) ? "win32" : "linux";
    const nested = detachedShellPattern(args[shellPayloadIndex + 1]!, nestedPlatform);
    if (nested) return `direct shell: ${nested}`;
  }

  const runtime: InlineRuntime | undefined = ["node", "nodejs"].includes(executable)
    ? "node"
    : ["python", "python3", "py"].includes(executable)
      ? "python"
      : executable === "ruby" ? "ruby" : undefined;
  if (runtime) {
    const evalIndex = args.findIndex((value) => runtime === "python" ? value === "-c" : /^(?:-e|--eval)$/u.test(value));
    if (evalIndex >= 0 && args[evalIndex + 1]) return programmaticChildPattern(args[evalIndex + 1]!, runtime);
  }

  if (platform === "win32" && ["powershell", "pwsh"].includes(executable) && args.some((value) => /^(?:-encodedcommand|-enc|-e)$/iu.test(value))) {
    return "opaque encoded PowerShell command";
  }
  return undefined;
}

export function assertForegroundShellCommand(
  toolName: string,
  command: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const pattern = detachedShellPattern(command, platform);
  if (!pattern) return;
  throw Object.assign(
    new Error(`${toolName} cannot launch a background or detached process (${pattern}); use start_process and the managed process lifecycle.`),
    { code: "ERR_TOOL_INVALID_ARGUMENTS" },
  );
}

export function assertManagedExecutable(
  toolName: string,
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): void {
  const pattern = detachedExecutablePattern(command, args, platform);
  if (!pattern) return;
  throw Object.assign(
    new Error(`${toolName} cannot launch an untrackable child process (${pattern}).`),
    { code: "ERR_TOOL_INVALID_ARGUMENTS" },
  );
}
