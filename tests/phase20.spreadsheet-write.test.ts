import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import ExcelJS from "exceljs";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../packages/persistence/src/index.js";
import type {
  StructuredDocumentWriteResult,
  TableDocumentSpec,
} from "../packages/shared-schema/src/index.js";
import { ToolRuntime } from "../packages/tool-runtime/src/index.js";
import { recoveryToolModule } from "../packages/tool-runtime/src/built-ins/recovery/index.js";
import { parseDelimitedText } from "../packages/tool-runtime/src/built-ins/structured-documents/spreadsheet-parser.js";
import { spreadsheetsToolModule } from "../packages/tool-runtime/src/built-ins/structured-documents/spreadsheets.js";

const temporaryRoots: string[] = [];

interface SpreadsheetFixture {
  workspaceRoot: string;
  sessionStore: SessionStore;
  runtime: ToolRuntime;
  sessionId: string;
}

async function createRuntime(): Promise<SpreadsheetFixture> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase20-write-sheet-"));
  temporaryRoots.push(workspaceRoot);
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("write a checkpointed spreadsheet safely");
  const runtime = new ToolRuntime({
    workspaceRoot,
    sessionStore,
    permissionMode: "danger-full-access",
    // Keep the test focused on the Phase 20 module while adding only the
    // frozen recovery module needed to exercise the real runtime undo path.
    modules: [spreadsheetsToolModule, recoveryToolModule],
  });
  return { workspaceRoot, sessionStore, runtime, sessionId: session.sessionId };
}

function workbookDocument(): TableDocumentSpec {
  return {
    title: "Phase 20 typed workbook",
    metadata: { author: "Deep-Mix", subject: "Spreadsheet writer verification" },
    activeSheet: "Data",
    sheets: [
      {
        name: "Data",
        headers: [
          { column: 1, label: "Name" },
          { column: 2, label: "Enabled" },
          { column: 3, label: "Amount" },
          { column: 4, label: "When" },
          { column: 5, label: "Blank" },
        ],
        columns: [
          { column: 1, width: 24 },
          { column: 2, width: 12 },
        ],
        freezeHeaderRow: true,
        cells: [
          { row: 2, column: 1, type: "string", value: "alpha" },
          { row: 2, column: 2, type: "boolean", value: true },
          { row: 2, column: 3, type: "number", value: 7.5 },
          { row: 2, column: 4, type: "date", value: "2026-07-17T00:00:00.000Z" },
          { row: 2, column: 5, type: "blank", value: null },
          { row: 3, column: 1, type: "string", value: "=SUM(A1:A2)" },
          { row: 3, column: 2, type: "string", value: "+cmd" },
          { row: 3, column: 3, type: "string", value: "-cmd" },
          { row: 3, column: 4, type: "string", value: "@cmd" },
          {
            row: 4,
            column: 3,
            type: "formula",
            formula: {
              expression: "C2*2",
              cachedValue: 15,
              cachedType: "number",
              calculationState: "cached",
            },
          },
        ],
      },
      {
        name: "Summary",
        headers: [{ column: 1, label: "Metric" }, { column: 2, label: "Value" }],
        cells: [
          { row: 2, column: 1, type: "string", value: "rows" },
          { row: 2, column: 2, type: "number", value: 3 },
        ],
      },
    ],
  };
}

function delimitedDocument(): TableDocumentSpec {
  return {
    sheets: [{
      name: "Data",
      headers: [
        { column: 1, label: "danger" },
        { column: 2, label: "spaced" },
        { column: 3, label: "controlled" },
        { column: 4, label: "delimiter" },
        { column: 5, label: "quote" },
        { column: 6, label: "multiline" },
        { column: 7, label: "formula" },
        { column: 8, label: "ordinary" },
      ],
      cells: [
        { row: 2, column: 1, type: "string", value: "=2+2" },
        { row: 2, column: 2, type: "string", value: "  +SUM(A1:A2)" },
        { row: 2, column: 3, type: "string", value: "\t@cmd" },
        { row: 2, column: 4, type: "string", value: "a,b" },
        { row: 2, column: 5, type: "string", value: "said \"hello\"" },
        { row: 2, column: 6, type: "string", value: "line 1\nline 2" },
        {
          row: 2,
          column: 7,
          type: "formula",
          formula: { expression: "SUM(1,2)", calculationState: "missing" },
        },
        { row: 2, column: 8, type: "string", value: "ordinary" },
      ],
    }],
  };
}

function formulaDocument(expressions: readonly string[]): TableDocumentSpec {
  return {
    sheets: [{
      name: "Data",
      cells: expressions.map((expression, index) => ({
        row: index + 1,
        column: 1,
        type: "formula" as const,
        formula: { expression, calculationState: "missing" as const },
      })),
    }],
  };
}

function writeBody(result: Awaited<ReturnType<ToolRuntime["executeManualTool"]>>): StructuredDocumentWriteResult {
  return result.structuredContent as StructuredDocumentWriteResult;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("phase 20 write_spreadsheet", () => {
  it("creates a multi-sheet typed XLSX that ExcelJS can open and a real new-file undo deletes", async () => {
    const { workspaceRoot, sessionStore, runtime, sessionId } = await createRuntime();
    const result = await runtime.executeManualTool(
      "write_spreadsheet",
      { outputPath: "out/typed.xlsx", document: workbookDocument() },
      sessionId,
    );
    const body = writeBody(result);

    expect(result.success, result.output).toBe(true);
    expect(body).toMatchObject({
      format: "xlsx",
      outputPath: "out/typed.xlsx",
      sizeBytes: expect.any(Number),
      warnings: expect.any(Array),
      checkpointId: expect.any(String),
      undoAvailable: true,
      artifact: {
        uri: "file://out/typed.xlsx",
        fileName: "typed.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        kind: "document",
        sourceToolName: "write_spreadsheet",
        workspaceRelativePath: "out/typed.xlsx",
      },
    });
    expect(result.artifacts?.[0]).toMatchObject(body.artifact);
    expect(body.sizeBytes).toBeGreaterThan(1_000);
    expect(body.artifact.sizeBytes).toBe(body.sizeBytes);
    expect((await sessionStore.listToolOutputArtifacts(sessionId))).toContainEqual(
      expect.objectContaining({ uri: "file://out/typed.xlsx", sourceToolName: "write_spreadsheet" }),
    );
    expect((await sessionStore.listUndoCandidates(sessionId)).map((candidate) => candidate.checkpointId))
      .toContain(body.checkpointId);

    const outputPath = path.join(workspaceRoot, "out/typed.xlsx");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["Data", "Summary"]);
    const data = workbook.getWorksheet("Data");
    expect(data).toBeDefined();
    expect(data!.getRow(1).values).toEqual([undefined, "Name", "Enabled", "Amount", "When", "Blank"]);
    expect(data!.getCell("A2").value).toBe("alpha");
    expect(data!.getCell("B2").value).toBe(true);
    expect(data!.getCell("C2").value).toBe(7.5);
    expect(data!.getCell("D2").value).toBeInstanceOf(Date);
    expect((data!.getCell("D2").value as Date).toISOString()).toBe("2026-07-17T00:00:00.000Z");
    expect(data!.getCell("E2").value).toBeNull();
    expect(data!.getCell("A3").value).toBe("=SUM(A1:A2)");
    expect(data!.getCell("B3").value).toBe("+cmd");
    expect(data!.getCell("C3").value).toBe("-cmd");
    expect(data!.getCell("D3").value).toBe("@cmd");
    expect(data!.getCell("C4").value).toMatchObject({ formula: "C2*2", result: 15 });
    expect(data!.getColumn(1).width).toBeCloseTo(24, 5);
    expect(data!.getColumn(2).width).toBeCloseTo(12, 5);
    expect(data!.views).toContainEqual(expect.objectContaining({ state: "frozen", ySplit: 1 }));

    const archive = await JSZip.loadAsync(await fs.readFile(outputPath), { checkCRC32: true });
    const entryNames = Object.keys(archive.files);
    expect(entryNames).toContain("xl/workbook.xml");
    expect(entryNames.some((name) => /vbaProject|externalLinks|connections\.xml/iu.test(name))).toBe(false);

    const undone = await runtime.executeManualTool(
      "undo",
      { checkpointId: body.checkpointId, mode: "code" },
      sessionId,
    );
    expect(undone.success, undone.output).toBe(true);
    await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("neutralizes CSV and TSV formula injection, preserves explicit formulas, and uses RFC quoting", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();

    for (const format of ["csv", "tsv"] as const) {
      const result = await runtime.executeManualTool(
        "write_spreadsheet",
        { outputPath: `out/safe.${format}`, format, document: delimitedDocument() },
        sessionId,
      );
      const body = writeBody(result);
      expect(result.success, result.output).toBe(true);
      expect(body).toMatchObject({
        format,
        outputPath: `out/safe.${format}`,
        warnings: expect.arrayContaining([
          expect.objectContaining({ code: "csv_formula_escaped", severity: "high", category: "security" }),
          expect.objectContaining({ code: "formula_not_calculated" }),
        ]),
      });

      const text = await fs.readFile(path.join(workspaceRoot, `out/safe.${format}`), "utf8");
      const rows = parseDelimitedText(text, format === "csv" ? "," : "\t");
      expect(rows).toHaveLength(2);
      expect(rows[1]).toEqual([
        "'=2+2",
        "'  +SUM(A1:A2)",
        "'\t@cmd",
        "a,b",
        "said \"hello\"",
        "line 1\nline 2",
        "=SUM(1,2)",
        "ordinary",
      ]);
      expect(text).toContain('"said ""hello"""');
      expect(text).toContain('"line 1\nline 2"');
      if (format === "csv") {
        expect(text).toContain('"a,b"');
        expect(text).toContain('"=SUM(1,2)"');
      } else {
        expect(text).toContain('"\'\t@cmd"');
      }
    }
  });

  it("rejects pipe/DDE external-execution formulas for XLSX, CSV, and TSV without rejecting ordinary formulas", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    const unsafeExpressions = [
      "cmd|'/C calc'!A0",
      " \tCMD.EXE | ' /c whoami' ! $A$1",
      "PoWeRsHeLl|'-NoProfile -Command whoami'!R1C1",
      "1+pwsh.exe|'-NoLogo'!A1",
      "%COMSPEC%|'/c whoami'!A1",
      "'C:\\Windows\\System32\\cmd.exe'|'/c whoami'!A1",
    ] as const;

    for (const format of ["xlsx", "csv", "tsv"] as const) {
      for (const [index, expression] of unsafeExpressions.entries()) {
        const outputPath = `blocked-${format}-${index}.${format}`;
        const result = await runtime.executeManualTool(
          "write_spreadsheet",
          { outputPath, format, document: formulaDocument([expression]) },
          sessionId,
        );
        expect(result).toMatchObject({
          success: false,
          structuredContent: {
            error: {
              type: "invalid_arguments",
              retryable: false,
              fieldPath: "/document/sheets/0/cells/0/formula/expression",
            },
          },
        });
        expect(result.output).toMatch(/external-reference|external-execution|safe spreadsheet/iu);
        await expect(fs.stat(path.join(workspaceRoot, outputPath))).rejects.toMatchObject({ code: "ENOENT" });
      }

      const safeOutputPath = `ordinary-formulas.${format}`;
      const safe = await runtime.executeManualTool(
        "write_spreadsheet",
        {
          outputPath: safeOutputPath,
          format,
          document: formulaDocument([
            "SUM(A1:A2)",
            "IF(A1=\"cmd|'not executable'!A0\",1,0)",
            "CONCAT(\"pipe|text\",\"!A0\")",
            "'Data|Set'!A1",
          ]),
        },
        sessionId,
      );
      expect(safe.success, safe.output).toBe(true);
      expect((await fs.stat(path.join(workspaceRoot, safeOutputPath))).isFile()).toBe(true);
    }
  });

  it("rejects hidden content and unsupported macro or external-data fields instead of generating them", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    const hiddenSheet = workbookDocument();
    hiddenSheet.sheets[0]!.state = "hidden";
    const hiddenSheetResult = await runtime.executeManualTool(
      "write_spreadsheet",
      { outputPath: "hidden-sheet.xlsx", document: hiddenSheet },
      sessionId,
    );
    expect(hiddenSheetResult).toMatchObject({
      success: false,
      structuredContent: { error: { type: "invalid_arguments", fieldPath: "/document/sheets/0/state" } },
    });

    const hiddenColumn = workbookDocument();
    hiddenColumn.sheets[0]!.columns![0]!.hidden = true;
    const hiddenColumnResult = await runtime.executeManualTool(
      "write_spreadsheet",
      { outputPath: "hidden-column.xlsx", document: hiddenColumn },
      sessionId,
    );
    expect(hiddenColumnResult).toMatchObject({
      success: false,
      structuredContent: { error: { type: "invalid_arguments", fieldPath: "/document/sheets/0/columns/0/hidden" } },
    });

    for (const [name, extra] of [
      ["macro.xlsx", { macros: ["Auto_Open"] }],
      ["external.xlsx", { externalConnections: ["https://invalid.example.test/data"] }],
    ] as const) {
      const document = { ...workbookDocument(), ...extra };
      const result = await runtime.executeManualTool(
        "write_spreadsheet",
        { outputPath: name, document },
        sessionId,
      );
      expect(result).toMatchObject({
        success: false,
        structuredContent: { error: { type: "invalid_arguments", retryable: false } },
      });
      await expect(fs.stat(path.join(workspaceRoot, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(fs.stat(path.join(workspaceRoot, "hidden-sheet.xlsx"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(workspaceRoot, "hidden-column.xlsx"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces its strict schema, declared workbook limits, and format/extension agreement", async () => {
    const { runtime, sessionId } = await createRuntime();
    const tooManySheets: TableDocumentSpec = {
      sheets: Array.from({ length: 65 }, (_, index) => ({ name: `S${index + 1}`, cells: [] })),
    };
    const oversizedCell: TableDocumentSpec = {
      sheets: [{
        name: "Data",
        cells: [{ row: 1, column: 1, type: "string", value: "x".repeat(100_001) }],
      }],
    };
    const invalidCases: unknown[] = [
      { outputPath: "empty.xlsx", document: { sheets: [] } },
      { outputPath: "too-many.xlsx", document: tooManySheets },
      { outputPath: "oversized.xlsx", document: oversizedCell },
      { outputPath: "extra.xlsx", document: workbookDocument(), extra: true },
      { outputPath: "mismatch.xlsx", format: "csv", document: workbookDocument() },
    ];

    for (const args of invalidCases) {
      const result = await runtime.executeManualTool("write_spreadsheet", args, sessionId);
      expect(result).toMatchObject({
        success: false,
        structuredContent: { error: { type: "invalid_arguments", retryable: false } },
      });
    }
  });

  it("requires explicit overwrite and restores exact previous binary bytes through checkpointed undo", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    const outputPath = path.join(workspaceRoot, "existing.xlsx");
    const original = Buffer.from("original spreadsheet binary bytes\u0000\u00ff", "latin1");
    await fs.writeFile(outputPath, original);

    const denied = await runtime.executeManualTool(
      "write_spreadsheet",
      { outputPath: "existing.xlsx", document: workbookDocument() },
      sessionId,
    );
    expect(denied).toMatchObject({
      success: false,
      structuredContent: { error: { type: "invalid_arguments", fieldPath: "/overwrite" } },
    });
    expect(await fs.readFile(outputPath)).toEqual(original);

    const written = await runtime.executeManualTool(
      "write_spreadsheet",
      { outputPath: "existing.xlsx", overwrite: true, document: workbookDocument() },
      sessionId,
    );
    const body = writeBody(written);
    expect(written.success, written.output).toBe(true);
    expect(body).toMatchObject({ checkpointId: expect.any(String), undoAvailable: true });
    expect(await fs.readFile(outputPath)).not.toEqual(original);

    const undone = await runtime.executeManualTool(
      "undo",
      { checkpointId: body.checkpointId, mode: "code" },
      sessionId,
    );
    expect(undone.success, undone.output).toBe(true);
    expect(await fs.readFile(outputPath)).toEqual(original);
  });

  it("rejects lexical, protected, and junction-based output-path escapes", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    const lexical = await runtime.executeManualTool(
      "write_spreadsheet",
      { outputPath: "../outside.xlsx", document: workbookDocument() },
      sessionId,
    );
    expect(lexical).toMatchObject({
      success: false,
      structuredContent: { error: { type: "invalid_path", retryable: false, toolName: "write_spreadsheet" } },
    });

    const protectedResult = await runtime.executeManualTool(
      "write_spreadsheet",
      { outputPath: ".deep-mix/api-key-library/blocked.xlsx", document: workbookDocument() },
      sessionId,
    );
    expect(protectedResult).toMatchObject({
      success: false,
      structuredContent: { error: { type: "sandbox_denied", retryable: false, toolName: "write_spreadsheet" } },
    });

    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase20-write-sheet-outside-"));
    temporaryRoots.push(outsideRoot);
    await fs.symlink(outsideRoot, path.join(workspaceRoot, "outside-link"), "junction");
    const linked = await runtime.executeManualTool(
      "write_spreadsheet",
      { outputPath: "outside-link/escaped.xlsx", document: workbookDocument() },
      sessionId,
    );
    expect(linked).toMatchObject({
      success: false,
      structuredContent: { error: { type: "invalid_path", retryable: false, toolName: "write_spreadsheet" } },
    });
    await expect(fs.stat(path.join(outsideRoot, "escaped.xlsx"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("declares stable write schema, permission, checkpoint, capability probe, and output ceilings", async () => {
    const { runtime } = await createRuntime();
    await runtime.initialize();
    const definition = runtime.listRegisteredToolDefinitions().find((tool) => tool.name === "write_spreadsheet");
    expect(definition).toMatchObject({
      name: "write_spreadsheet",
      readOnly: false,
      permissionCategory: "write_file",
      sideEffectLevel: "high",
      checkpoint: { mode: "before_write", scope: "pre_tool_write" },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["outputPath", "document"],
        properties: {
          outputPath: expect.any(Object),
          format: expect.objectContaining({ enum: ["xlsx", "csv", "tsv"] }),
          overwrite: { type: "boolean" },
          document: expect.objectContaining({
            type: "object",
            properties: expect.objectContaining({
              sheets: expect.objectContaining({ minItems: 1, maxItems: 64 }),
            }),
          }),
        },
      },
    });
    expect(runtime.listAvailableToolDefinitions().map((tool) => tool.name)).toContain("write_spreadsheet");
  });
});
