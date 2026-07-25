import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../packages/persistence/src/index.js";
import { SpecialistBroker } from "../packages/specialist-broker/src/index.js";
import { ToolRuntime } from "../packages/tool-runtime/src/index.js";

const temporaryRoots: string[] = [];

const expectedCoreToolMetadata = [
  ["lsp_diagnostics", true, "read_only", "none", "slow"],
  ["lint_diagnostics", true, "read_only", "none", "slow"],
  ["typecheck_diagnostics", true, "read_only", "none", "slow"],
  ["read_file", true, "read_only", "none", "fast"],
  ["search_files", true, "read_only", "none", "fast"],
  ["list_files", true, "read_only", "none", "fast"],
  ["apply_patch", false, "write_file", "high", "default"],
  ["run_shell", false, "execute_command", "medium", "default"],
  ["run_tests", false, "run_tests", "medium", "slow"],
  ["lint", false, "run_tests", "medium", "slow"],
  ["typecheck", false, "run_tests", "medium", "slow"],
  ["git_status", true, "read_only", "none", "fast"],
  ["git_diff", true, "read_only", "none", "fast"],
  ["apply_artifact_patch", false, "write_file", "high", "slow"],
  ["rollback_checkpoint", false, "write_file", "high", "default"],
  ["undo", false, "write_file", "high", "default"],
  ["invoke_coding_worker", false, "execute_command", "low", "slow"],
  ["invoke_vision_worker", false, "execute_command", "low", "slow"],
  ["update_plan", false, "write_file", "low", "fast"],
] as const;

async function createBaselineRuntime(): Promise<{
  workspaceRoot: string;
  sessionStore: SessionStore;
  runtime: ToolRuntime;
  sessionId: string;
}> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase14-baseline-"));
  temporaryRoots.push(workspaceRoot);
  await fs.writeFile(path.join(workspaceRoot, "sample.txt"), "alpha\nbeta\n", "utf8");

  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("phase 14 pre-migration baseline");
  const specialistBroker = new SpecialistBroker({ workspaceRoot, sessionStore });
  const runtime = new ToolRuntime({
    workspaceRoot,
    sessionStore,
    permissionMode: "danger-full-access",
    specialistBroker,
  });

  return { workspaceRoot, sessionStore, runtime, sessionId: session.sessionId };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("phase 14 pre-migration built-in tool baseline", () => {
  it("freezes the 19 Governor core tool names and permission metadata", async () => {
    const { runtime } = await createBaselineRuntime();

    const coreNames = new Set(expectedCoreToolMetadata.map(([name]) => name));
    const actual = runtime.listToolDefinitions()
      .filter((tool) => coreNames.has(tool.name as (typeof expectedCoreToolMetadata)[number][0]))
      .map((tool) => [
        tool.name,
        tool.readOnly,
        tool.permissionCategory,
        tool.sideEffectLevel,
        tool.timeoutCategory,
      ]);

    expect(actual).toEqual(expectedCoreToolMetadata);
    expect(runtime.listToolDefinitions().slice(0, 19).map((tool) => tool.name)).toEqual(
      expectedCoreToolMetadata.map(([name]) => name),
    );
    const readFileDefinition = runtime.listToolDefinitions().find((tool) => tool.name === "read_file");
    const readFileProperties = (readFileDefinition?.inputSchema.properties ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    expect(readFileProperties.maxChars).toMatchObject({
      minimum: 1,
      maximum: 2_000_000,
      default: 2_000_000,
    });
    for (const toolName of ["read_pdf", "read_docx"]) {
      const definition = runtime.listToolDefinitions().find((tool) => tool.name === toolName);
      const properties = (definition?.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
      expect(properties.maxChars, toolName).toMatchObject({
        minimum: 1,
        maximum: 2_000_000,
        default: 2_000_000,
      });
    }
    const propertiesFor = (toolName: string): Record<string, Record<string, unknown>> => {
      const definition = runtime.listToolDefinitions().find((tool) => tool.name === toolName);
      return (definition?.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
    };
    expect(propertiesFor("search_files").maxResults).toMatchObject({ maximum: 5_000, default: 5_000 });
    expect(propertiesFor("search_files").maxFileBytes).toMatchObject({
      maximum: 10 * 1024 * 1024,
      default: 10 * 1024 * 1024,
    });
    expect(propertiesFor("list_files").maxDepth).toMatchObject({ maximum: 64, default: 64 });
    expect(propertiesFor("list_files").maxResults).toMatchObject({ maximum: 5_000, default: 5_000 });
    expect(propertiesFor("glob_files").maxDepth).toMatchObject({ maximum: 64, default: 64 });
    expect(propertiesFor("glob_files").maxResults).toMatchObject({ maximum: 5_000, default: 5_000 });
    expect(propertiesFor("read_many_files").maxFiles).toMatchObject({ maximum: 100, default: 100 });
    expect(propertiesFor("tool_search").maxResults).toMatchObject({ maximum: 256, default: 256 });
  });

  it("freezes representative read and session-plan results before modularization", async () => {
    const { runtime, sessionId } = await createBaselineRuntime();

    const readResult = await runtime.executeManualTool(
      "read_file",
      { path: "sample.txt", startLine: 2, endLine: 2 },
      sessionId,
    );
    expect(readResult).toMatchObject({
      toolName: "read_file",
      success: true,
      output: "   2 | beta",
      structuredContent: {
        kind: "read_file",
        path: "sample.txt",
        startLine: 2,
        endLine: 2,
        content: "beta",
        truncated: false,
      },
    });

    const planResult = await runtime.executeManualTool(
      "update_plan",
      { items: [{ id: "a", title: "Baseline", status: "in_progress" }] },
      sessionId,
    );
    expect(planResult).toMatchObject({
      toolName: "update_plan",
      success: true,
      structuredContent: [{ id: "a", title: "Baseline", status: "in_progress" }],
    });

    const missingResult = await runtime.executeManualTool(
      "read_file",
      { path: "missing.txt" },
      sessionId,
    );
    expect(missingResult.success).toBe(false);
    const missingBody = JSON.parse(missingResult.output) as {
      error?: { type?: string; message?: string; retryable?: boolean; toolName?: string; path?: string };
    };
    expect(missingBody.error).toMatchObject({
      type: "invalid_path",
      retryable: false,
      toolName: "read_file",
    });
    expect(missingBody.error?.message).toBe(missingResult.error);
    expect(missingResult.structuredContent).toEqual(missingBody);
  });

  it("reads more than 20,000 lines in one call when the source stays below the character limit", async () => {
    const { workspaceRoot, runtime, sessionId } = await createBaselineRuntime();
    const source = Array.from({ length: 20_001 }, (_, index) => `line-${index + 1}`).join("\n");
    await fs.writeFile(path.join(workspaceRoot, "many-lines.txt"), source, "utf8");

    const result = await runtime.executeManualTool("read_file", { path: "many-lines.txt" }, sessionId);
    const body = result.structuredContent as {
      content: string;
      totalLines: number;
      totalChars: number;
      returnedStartLine: number;
      returnedEndLine: number;
      returnedChars: number;
      rangeComplete: boolean;
      fileComplete: boolean;
      truncated: boolean;
    };
    expect(result.success).toBe(true);
    expect(body).toMatchObject({
      totalLines: 20_001,
      totalChars: source.length,
      returnedStartLine: 1,
      returnedEndLine: 20_001,
      returnedChars: source.length,
      rangeComplete: true,
      fileComplete: true,
      truncated: false,
    });
    expect(body.content).toContain("line-20001");
    expect(result.output).toContain("20001 | line-20001");
  });

  it("honors the exact 2,000,000-character boundary and reports precise continuation metadata", async () => {
    const { workspaceRoot, runtime, sessionId } = await createBaselineRuntime();
    const exact = "X".repeat(2_000_000);
    await fs.writeFile(path.join(workspaceRoot, "exact-limit.txt"), exact, "utf8");
    const exactResult = await runtime.executeManualTool("read_file", { path: "exact-limit.txt" }, sessionId);
    expect(exactResult.structuredContent).toMatchObject({
      totalChars: 2_000_000,
      returnedChars: 2_000_000,
      returnedStartLine: 1,
      returnedEndLine: 1,
      rangeComplete: true,
      fileComplete: true,
      truncated: false,
    });

    const splitOverflow = `${"A".repeat(1_500_000)}\n${"B".repeat(500_000)}`;
    await fs.writeFile(path.join(workspaceRoot, "split-overflow.txt"), splitOverflow, "utf8");
    const splitResult = await runtime.executeManualTool("read_file", { path: "split-overflow.txt" }, sessionId);
    expect(splitResult.structuredContent).toMatchObject({
      totalLines: 2,
      totalChars: 2_000_001,
      returnedStartLine: 1,
      returnedEndLine: 1,
      returnedChars: 1_500_000,
      nextStartLine: 2,
      rangeComplete: false,
      fileComplete: false,
      truncationReason: "max_chars",
      truncated: true,
    });
    expect(splitResult.output).toContain("reason=max_chars");
    expect(splitResult.output).toContain("nextStartLine=2");

    const oversizedLine = "Z".repeat(2_000_001);
    await fs.writeFile(path.join(workspaceRoot, "oversized-line.txt"), oversizedLine, "utf8");
    const oversizedResult = await runtime.executeManualTool("read_file", { path: "oversized-line.txt" }, sessionId);
    expect(oversizedResult.structuredContent).toMatchObject({
      totalLines: 1,
      totalChars: 2_000_001,
      returnedStartLine: 1,
      returnedEndLine: 1,
      returnedChars: 2_000_000,
      rangeComplete: false,
      fileComplete: false,
      truncationReason: "oversized_line",
      truncated: true,
    });
    expect(oversizedResult.output).toContain("reason=oversized_line");
    expect(oversizedResult.output).toContain("the returned line itself exceeds maxChars");
  }, 30_000);
});
