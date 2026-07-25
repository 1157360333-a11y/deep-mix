import { describe, expect, it } from "vitest";
import { parseArgs } from "../apps/cli/src/cli-args.js";

describe("CLI workspace argument parsing", () => {
  it("recognizes help and version flags without turning them into prompts", () => {
    const helpArgs = parseArgs(["-h"], { cwd: ".", platform: "linux" });
    expect(helpArgs.showHelp).toBe(true);
    expect(helpArgs.prompt).toBeUndefined();

    const versionArgs = parseArgs(["--version"], { cwd: ".", platform: "linux" });
    expect(versionArgs.showVersion).toBe(true);
    expect(versionArgs.prompt).toBeUndefined();
  });

  it("recovers a Windows absolute workspace path from the raw command line when npm mangles argv", () => {
    const args = parseArgs(["--workspace", "C:UsersdemoDesktopsample-project"], {
      cwd: "C:\\Users\\demo\\Desktop\\deep-mix",
      platform: "win32",
      rawCommandLine:
        "\"C:\\Program Files\\nodejs\\node.exe\" apps/cli/src/main.ts --workspace C:\\Users\\demo\\Desktop\\sample-project",
    });

    expect(args.workspaceRoot).toBe("C:\\Users\\demo\\Desktop\\sample-project");
  });

  it("can recover from an ancestor command line when the current process line is already mangled", () => {
    const args = parseArgs(["--workspace", "C:UsersdemoDesktopsample-project"], {
      cwd: "C:\\Users\\demo\\Desktop\\deep-mix",
      platform: "win32",
      rawCommandLineCandidates: [
        "\"C:\\Program Files\\nodejs\\node.exe\" apps/cli/src/main.ts --workspace C:UsersdemoDesktopsample-project",
        "\"C:\\Windows\\System32\\cmd.exe\" /d /s /c tsx apps/cli/src/main.ts --workspace C:\\Users\\demo\\Desktop\\sample-project",
      ],
    });

    expect(args.workspaceRoot).toBe("C:\\Users\\demo\\Desktop\\sample-project");
  });

  it("preserves normal relative workspace inputs", () => {
    const args = parseArgs(["--workspace", "..\\test1"], {
      cwd: "C:\\Users\\demo\\Desktop\\deep-mix",
      platform: "win32",
      rawCommandLine: "\"node\" apps/cli/src/main.ts --workspace ..\\test1",
    });

    expect(args.workspaceRoot).toBe("C:\\Users\\demo\\Desktop\\test1");
  });

  it("supports the equals form for workspace arguments", () => {
    const args = parseArgs(["--workspace=C:\\Users\\demo\\Desktop\\sample-project"], {
      cwd: "C:\\Users\\demo\\Desktop\\deep-mix",
      platform: "win32",
    });

    expect(args.workspaceRoot).toBe("C:\\Users\\demo\\Desktop\\sample-project");
  });

  it("fails fast instead of silently using a wrong workspace when recovery is impossible", () => {
    expect(() =>
      parseArgs(["--workspace", "C:UsersdemoDesktopsample-project"], {
        cwd: "C:\\Users\\demo\\Desktop\\deep-mix",
        platform: "win32",
        rawCommandLineCandidates: [
          "\"C:\\Program Files\\nodejs\\node.exe\" apps/cli/src/main.ts --workspace C:UsersdemoDesktopsample-project",
        ],
      }),
    ).toThrow("Workspace path was mangled by the Windows npm script launcher");
  });

  it("shows Git Bash-specific guidance when bash has already stripped backslashes", () => {
    expect(() =>
      parseArgs(["--workspace", "C:UsersdemoDesktopsample-project"], {
        cwd: "C:\\Users\\demo\\Desktop\\deep-mix",
        platform: "win32",
        environment: {
          MSYSTEM: "MINGW64",
          SHELL: "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
        },
        rawCommandLineCandidates: [
          "\"C:\\Program Files\\Git\\usr\\bin\\bash.exe\" \"/c/Program Files/nodejs/npm\" run cli -- --workspace C:UsersdemoDesktopsample-project",
        ],
      }),
    ).toThrow("Git Bash stripped the backslashes from --workspace before Deep-Mix started");
  });
});
