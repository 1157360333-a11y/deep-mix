import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionStore } from "../packages/persistence/src/index.js";
import type { ToolResult } from "../packages/shared-schema/src/index.js";
import { ToolRuntime } from "../packages/tool-runtime/src/index.js";
import { builtInToolModules } from "../packages/tool-runtime/src/built-ins/index.js";
import { recoveryToolModule } from "../packages/tool-runtime/src/built-ins/recovery/index.js";
import {
  archiveManageTool,
  archivesToolModule,
  convertDocumentTool,
  conversionsToolModule,
  editNotebookTool,
  imagesToolModule,
  notebooksToolModule,
  presentationsToolModule,
  readImageTool,
  readNotebookTool,
  readPresentationTool,
  readSpreadsheetTool,
  spreadsheetsToolModule,
  writePresentationTool,
  writeSpreadsheetTool,
} from "../packages/tool-runtime/src/built-ins/structured-documents/index.js";
import {
  PHASE20_FORMAT_CAPABILITY_MATRIX,
  PHASE20_LIMITS,
  PHASE20_OFFLINE_CONVERSION_ALLOWLIST,
} from "../packages/tool-runtime/src/built-ins/structured-documents/format-policy.js";

const temporaryRoots: string[] = [];
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8QAAAABJRU5ErkJggg==",
  "base64",
);

const PHASE20_TOOL_NAMES = [
  "read_spreadsheet",
  "write_spreadsheet",
  "read_presentation",
  "write_presentation",
  "read_notebook",
  "edit_notebook",
  "read_image",
  "archive_manage",
  "convert_document",
] as const;

const PHASE20_MODULE_IDS = [
  "builtin.spreadsheets",
  "builtin.presentations",
  "builtin.notebooks",
  "builtin.images",
  "builtin.archives",
  "builtin.conversions",
] as const;

const PHASE20_MODULES = [
  spreadsheetsToolModule,
  presentationsToolModule,
  notebooksToolModule,
  imagesToolModule,
  archivesToolModule,
  conversionsToolModule,
] as const;

const PHASE20_TOOL_SPECS = [
  readSpreadsheetTool,
  writeSpreadsheetTool,
  readPresentationTool,
  writePresentationTool,
  readNotebookTool,
  editNotebookTool,
  readImageTool,
  archiveManageTool,
  convertDocumentTool,
] as const;

interface Phase20Fixture {
  workspaceRoot: string;
  sessionStore: SessionStore;
  sessionId: string;
  runtime: ToolRuntime;
}

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

async function createRuntime(): Promise<Phase20Fixture> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase20-integration-"));
  temporaryRoots.push(workspaceRoot);
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("phase 20 nine-tool integration gate");
  const runtime = new ToolRuntime({
    workspaceRoot,
    sessionStore,
    permissionMode: "danger-full-access",
    modules: [...PHASE20_MODULES, recoveryToolModule],
  });
  return { workspaceRoot, sessionStore, sessionId: session.sessionId, runtime };
}

function crc32(input: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

/** Minimal stored ZIP fixture that deliberately preserves unsafe names. */
function storedZip(fileName: string, content: string): Buffer {
  const name = Buffer.from(fileName, "utf8");
  const data = Buffer.from(content, "utf8");
  const checksum = crc32(data);
  const flags = 0x0800;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x0403_4b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.byteLength, 18);
  local.writeUInt32LE(data.byteLength, 22);
  local.writeUInt16LE(name.byteLength, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x0201_4b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.byteLength, 20);
  central.writeUInt32LE(data.byteLength, 24);
  central.writeUInt16LE(name.byteLength, 28);

  const centralSize = central.byteLength + name.byteLength;
  const centralOffset = local.byteLength + name.byteLength + data.byteLength;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

function minimalSpreadsheetDocument() {
  return {
    sheets: [{
      name: "Data",
      headers: [
        { column: 1, label: "name" },
        { column: 2, label: "payload" },
      ],
      cells: [
        { row: 2, column: 1, type: "string" as const, value: "alpha" },
        { row: 2, column: 2, type: "string" as const, value: "=2+2" },
      ],
    }],
  };
}

function minimalPresentation() {
  return {
    title: "Phase 20 integration deck",
    slides: [{
      id: "overview",
      title: "Overview",
      elements: [{
        type: "title" as const,
        text: "Phase 20",
        bounds: { x: 0.7, y: 0.5, width: 7, height: 0.8 },
      }],
    }],
  };
}

function rawNotebook() {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { custom: { retained: true } },
    cells: [{
      id: "code-cell",
      cell_type: "code",
      source: "open('phase20-cell-executed.txt', 'w').write('unsafe')",
      metadata: {},
      execution_count: null,
      outputs: [],
    }],
  };
}

function expectBoundedSuccess(result: ToolResult, toolName: string): void {
  expect(result.success, `${toolName}: ${result.output}`).toBe(true);
  expect(result.toolName).toBe(toolName);
  expect(result.output.length).toBeLessThanOrEqual(PHASE20_LIMITS.maxModelVisibleChars);
  expect(result.structuredContent).toBeDefined();
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("phase 20 structured document integration gate", () => {
  it("registers exactly nine tools with strict schemas, permissions, probes, checkpoints, and frozen ceilings", async () => {
    const fixture = await createRuntime();
    await fixture.runtime.initialize();

    expect(PHASE20_MODULES.map((module) => module.manifest.id)).toEqual(PHASE20_MODULE_IDS);
    const phase20ModuleStart = builtInToolModules.findIndex(
      (module) => module.manifest.id === PHASE20_MODULE_IDS[0],
    );
    expect(phase20ModuleStart).toBeGreaterThanOrEqual(0);
    expect(builtInToolModules
      .slice(phase20ModuleStart, phase20ModuleStart + PHASE20_MODULE_IDS.length)
      .map((module) => module.manifest.id))
      .toEqual(PHASE20_MODULE_IDS);
    expect(PHASE20_TOOL_SPECS.map((tool) => tool.name)).toEqual(PHASE20_TOOL_NAMES);

    const definitions = fixture.runtime.listRegisteredToolDefinitions();
    const phase20Definitions = PHASE20_TOOL_NAMES.map((name) => {
      const definition = definitions.find((candidate) => candidate.name === name);
      expect(definition, name).toBeDefined();
      return definition!;
    });
    expect(phase20Definitions.map((definition) => definition.name)).toEqual(PHASE20_TOOL_NAMES);
    expect(fixture.runtime.listAvailableToolDefinitions().map((definition) => definition.name))
      .toEqual(expect.arrayContaining([...PHASE20_TOOL_NAMES]));

    const readOnlyNames = new Set(["read_spreadsheet", "read_presentation", "read_notebook", "read_image"]);
    const writeNames = new Set(["write_spreadsheet", "write_presentation", "edit_notebook", "convert_document"]);
    for (const definition of phase20Definitions) {
      expect(definition.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(definition.selection).toEqual(expect.any(Object));
      if (readOnlyNames.has(definition.name)) {
        expect(definition).toMatchObject({ readOnly: true, permissionCategory: "read_only", sideEffectLevel: "none" });
      } else if (writeNames.has(definition.name)) {
        expect(definition).toMatchObject({
          readOnly: false,
          permissionCategory: "write_file",
          sideEffectLevel: "high",
          checkpoint: { mode: "before_write", scope: "pre_tool_write" },
        });
      }
      expect(JSON.stringify(definition.inputSchema).length).toBeLessThan(PHASE20_LIMITS.maxModelVisibleChars);
    }

    for (const tool of PHASE20_TOOL_SPECS) {
      expect(tool.getAvailability, tool.name).toEqual(expect.any(Function));
      expect(tool.resolveAccess, tool.name).toEqual(expect.any(Function));
    }
    expect(await archiveManageTool.resolvePermission!(
      { action: "list", archivePath: "fixture.zip" },
      {} as never,
    )).toMatchObject({ readOnly: true, permissionCategory: "read_only", sideEffectLevel: "none" });
    expect(await archiveManageTool.resolvePermission!(
      { action: "extract", archivePath: "fixture.zip", outputDirectory: "out" },
      {} as never,
    )).toMatchObject({ readOnly: false, permissionCategory: "write_file", sideEffectLevel: "high" });

    expect(PHASE20_LIMITS).toMatchObject({
      maxModelVisibleChars: 2_000_000,
      maxArtifactBytes: 128 * 1024 * 1024,
      spreadsheet: { maxInputBytes: 64 * 1024 * 1024, maxOutputBytes: 64 * 1024 * 1024 },
      presentation: { maxInputBytes: 64 * 1024 * 1024, maxOutputBytes: 128 * 1024 * 1024 },
      notebook: { maxInputBytes: 32 * 1024 * 1024, maxOutputBytes: 64 * 1024 * 1024 },
      image: { maxInputBytes: 64 * 1024 * 1024, maxPixels: 100_000_000, maxFrames: 500 },
      archive: { maxInputBytes: 128 * 1024 * 1024, maxEntries: 10_000, maxCompressionRatio: 100 },
      conversion: { maxInputBytes: 64 * 1024 * 1024, maxOutputBytes: 128 * 1024 * 1024 },
    });
    expect(PHASE20_OFFLINE_CONVERSION_ALLOWLIST).toHaveLength(6);
    expect(PHASE20_FORMAT_CAPABILITY_MATRIX.filter((entry) => entry.status === "supported").length)
      .toBeGreaterThanOrEqual(11);
  });

  it("runs one bounded success path through all nine tools in the same Registry and Runtime", async () => {
    const fixture = await createRuntime();
    await fs.writeFile(path.join(fixture.workspaceRoot, "pixel.png"), onePixelPng);
    await fs.writeFile(path.join(fixture.workspaceRoot, "payload.txt"), "safe archive payload", "utf8");
    await fs.writeFile(
      path.join(fixture.workspaceRoot, "source.ipynb"),
      `${JSON.stringify(rawNotebook(), null, 2)}\n`,
      "utf8",
    );

    const results: Array<[string, ToolResult]> = [];
    const writtenSheet = await fixture.runtime.executeManualTool(
      "write_spreadsheet",
      { outputPath: "out/data.csv", document: minimalSpreadsheetDocument() },
      fixture.sessionId,
    );
    results.push(["write_spreadsheet", writtenSheet]);
    const readSheet = await fixture.runtime.executeManualTool(
      "read_spreadsheet",
      { path: "out/data.csv" },
      fixture.sessionId,
    );
    results.push(["read_spreadsheet", readSheet]);
    const converted = await fixture.runtime.executeManualTool(
      "convert_document",
      {
        inputPath: "out/data.csv",
        outputPath: "out/data.tsv",
        sourceFormat: "csv",
        targetFormat: "tsv",
      },
      fixture.sessionId,
    );
    results.push(["convert_document", converted]);

    const writtenPresentation = await fixture.runtime.executeManualTool(
      "write_presentation",
      { outputPath: "out/deck.pptx", presentation: minimalPresentation() },
      fixture.sessionId,
    );
    results.push(["write_presentation", writtenPresentation]);
    const readPresentation = await fixture.runtime.executeManualTool(
      "read_presentation",
      { path: "out/deck.pptx" },
      fixture.sessionId,
    );
    results.push(["read_presentation", readPresentation]);

    const editedNotebook = await fixture.runtime.executeManualTool(
      "edit_notebook",
      {
        path: "source.ipynb",
        outputPath: "out/edited.ipynb",
        operations: [{ type: "update", cellId: "code-cell", patch: { source: "value = 42" } }],
      },
      fixture.sessionId,
    );
    results.push(["edit_notebook", editedNotebook]);
    const readNotebook = await fixture.runtime.executeManualTool(
      "read_notebook",
      { path: "out/edited.ipynb" },
      fixture.sessionId,
    );
    results.push(["read_notebook", readNotebook]);

    const readImage = await fixture.runtime.executeManualTool(
      "read_image",
      { path: "pixel.png" },
      fixture.sessionId,
    );
    results.push(["read_image", readImage]);

    const createdArchive = await fixture.runtime.executeManualTool(
      "archive_manage",
      { action: "create", outputPath: "out/payload.zip", paths: ["payload.txt"] },
      fixture.sessionId,
    );
    results.push(["archive_manage", createdArchive]);
    const listedArchive = await fixture.runtime.executeManualTool(
      "archive_manage",
      { action: "list", archivePath: "out/payload.zip" },
      fixture.sessionId,
    );
    expectBoundedSuccess(listedArchive, "archive_manage");

    for (const [toolName, result] of results) expectBoundedSuccess(result, toolName);
    expect(new Set(results.map(([toolName]) => toolName))).toEqual(new Set(PHASE20_TOOL_NAMES));

    const csv = await fs.readFile(path.join(fixture.workspaceRoot, "out/data.csv"), "utf8");
    expect(csv).toMatch(/'=2\+2/u);
    expect(await fs.readFile(path.join(fixture.workspaceRoot, "out/data.tsv"), "utf8")).toContain("\t");
    expect(await fs.readFile(path.join(fixture.workspaceRoot, "out/edited.ipynb"), "utf8")).toContain("value = 42");
    await expect(fs.stat(path.join(fixture.workspaceRoot, "phase20-cell-executed.txt")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(readImage.structuredContent).toMatchObject({
      metadata: { width: 1, height: 1 },
      visionWorkerHint: { automaticInvocation: false },
    });
    expect(JSON.stringify(readImage.structuredContent)).not.toMatch(/\b(?:ocrText|caption|semanticDescription)\b/iu);
    expect(listedArchive.structuredContent).toMatchObject({ action: "list", totalEntries: 1 });

    const artifacts = await fixture.sessionStore.listToolOutputArtifacts(fixture.sessionId);
    expect(artifacts.map((artifact) => artifact.sourceToolName)).toEqual(expect.arrayContaining([
      "write_spreadsheet",
      "convert_document",
      "write_presentation",
      "edit_notebook",
      "archive_manage",
    ]));
    expect(await fixture.sessionStore.listUndoCandidates(fixture.sessionId)).toHaveLength(5);
  });

  it("returns bounded structured schema errors for every tool without mutating the workspace", async () => {
    const fixture = await createRuntime();
    const invalidCalls: Array<[typeof PHASE20_TOOL_NAMES[number], unknown]> = [
      ["read_spreadsheet", { path: "missing.csv", extra: true }],
      ["write_spreadsheet", { outputPath: "out.csv", document: { sheets: [] } }],
      ["read_presentation", { path: "missing.pptx", extra: true }],
      ["write_presentation", { outputPath: "out.pptx", presentation: { slides: [] } }],
      ["read_notebook", { path: "missing.ipynb", maxCells: 0 }],
      ["edit_notebook", { path: "missing.ipynb", operations: [] }],
      ["read_image", { path: "missing.png", extra: true }],
      ["archive_manage", { action: "unknown", archivePath: "missing.zip" }],
      ["convert_document", {
        inputPath: "missing.csv",
        outputPath: "out.tsv",
        sourceFormat: "made-up",
        targetFormat: "tsv",
      }],
    ];

    for (const [toolName, args] of invalidCalls) {
      const result = await fixture.runtime.executeManualTool(toolName, args, fixture.sessionId);
      expect(result, `${toolName}: ${result.output}`).toMatchObject({
        success: false,
        structuredContent: {
          error: { type: "invalid_arguments", retryable: false, toolName },
        },
      });
      expect(result.output.length).toBeLessThan(20_000);
      expect(result.output).not.toContain(fixture.workspaceRoot);
    }
    expect(await fs.readdir(fixture.workspaceRoot)).toEqual([]);
  });

  it("blocks ZIP traversal and non-allowlisted conversion before publication", async () => {
    const fixture = await createRuntime();
    const escapedName = `escaped-${path.basename(fixture.workspaceRoot)}.txt`;
    await fs.writeFile(path.join(fixture.workspaceRoot, "traversal.zip"), storedZip(`../${escapedName}`, "unsafe"));

    const extracted = await fixture.runtime.executeManualTool(
      "archive_manage",
      { action: "extract", archivePath: "traversal.zip", outputDirectory: "out/extracted" },
      fixture.sessionId,
    );
    expect(extracted).toMatchObject({
      success: false,
      structuredContent: {
        kind: "archive_error",
        action: "extract",
        code: "archive_unsafe_path",
        error: { retryable: false, toolName: "archive_manage" },
      },
    });
    await expect(fs.stat(path.join(fixture.workspaceRoot, "out/extracted"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(path.dirname(fixture.workspaceRoot), escapedName))).rejects.toMatchObject({ code: "ENOENT" });

    const blockedConversion = await fixture.runtime.executeManualTool(
      "convert_document",
      {
        inputPath: "missing.pptx",
        outputPath: "out/blocked.pdf",
        sourceFormat: "pptx",
        targetFormat: "pdf",
      },
      fixture.sessionId,
    );
    expect(blockedConversion).toMatchObject({
      success: false,
      structuredContent: {
        kind: "document_conversion_error",
        sourceFormat: "pptx",
        targetFormat: "pdf",
        code: "conversion_not_allowed",
        error: { retryable: false, toolName: "convert_document" },
      },
    });
    expect(blockedConversion.output).toMatch(/allowlist/iu);
    await expect(fs.stat(path.join(fixture.workspaceRoot, "out/blocked.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fixture.sessionStore.listToolOutputArtifacts(fixture.sessionId)).toHaveLength(0);
    expect(await fixture.sessionStore.listUndoCandidates(fixture.sessionId)).toHaveLength(0);
  });
});
