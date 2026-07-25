import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import ExcelJS from "exceljs";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../packages/persistence/src/index.js";
import type { TableCellSpec, TableReadResult } from "../packages/shared-schema/src/index.js";
import { ToolRuntime } from "../packages/tool-runtime/src/index.js";
import { spreadsheetsToolModule } from "../packages/tool-runtime/src/built-ins/structured-documents/spreadsheets.js";

const temporaryRoots: string[] = [];

interface SpreadsheetFixture {
  workspaceRoot: string;
  sessionStore: SessionStore;
  runtime: ToolRuntime;
  sessionId: string;
}

async function createRuntime(): Promise<SpreadsheetFixture> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase20-read-sheet-"));
  temporaryRoots.push(workspaceRoot);
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("read a bounded spreadsheet safely");
  const runtime = new ToolRuntime({
    workspaceRoot,
    sessionStore,
    permissionMode: "danger-full-access",
    modules: [spreadsheetsToolModule],
  });
  return { workspaceRoot, sessionStore, runtime, sessionId: session.sessionId };
}

function cells(result: TableReadResult): TableCellSpec[] {
  return result.sheets.flatMap((sheet) => sheet.cells);
}

function cellAt(result: TableReadResult, address: string): TableCellSpec | undefined {
  return cells(result).find((cell) => cell.address === address);
}

async function writeTypedWorkbook(filePath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Deep-Mix Phase 20";
  workbook.title = "Typed fixture";
  const visible = workbook.addWorksheet("Data");
  visible.addRow(["name", "enabled", "count", "computed"]);
  visible.getCell("A2").value = "alpha";
  visible.getCell("B2").value = true;
  visible.getCell("C2").value = 7;
  visible.getCell("D2").value = { formula: "C2*2", result: 14 };
  visible.getCell("D3").value = { formula: "C2+1" };
  visible.mergeCells("A5:B5");
  visible.getCell("A5").value = "merged";

  const hidden = workbook.addWorksheet("Secrets");
  hidden.state = "veryHidden";
  hidden.getCell("A1").value = "must be reported as hidden";
  await workbook.xlsx.writeFile(filePath);
}

async function addInertHighRiskParts(filePath: string): Promise<void> {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  zip.file("xl/vbaProject.bin", Buffer.from("inert-test-marker"));
  zip.file(
    "xl/externalLinks/externalLink1.xml",
    "<?xml version=\"1.0\"?><externalLink xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"/>",
  );
  zip.file(
    "xl/externalLinks/_rels/externalLink1.xml.rels",
    "<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath\" Target=\"https://invalid.example.test/source.xlsx\" TargetMode=\"External\"/></Relationships>",
  );

  const contentTypes = await zip.file("[Content_Types].xml")?.async("string");
  if (!contentTypes) throw new Error("fixture is missing [Content_Types].xml");
  zip.file(
    "[Content_Types].xml",
    contentTypes.replace(
      "</Types>",
      "<Override PartName=\"/xl/vbaProject.bin\" ContentType=\"application/vnd.ms-office.vbaProject\"/><Override PartName=\"/xl/externalLinks/externalLink1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml\"/></Types>",
    ),
  );
  const sheetXml = await zip.file("xl/worksheets/sheet1.xml")?.async("string");
  if (!sheetXml) throw new Error("fixture is missing xl/worksheets/sheet1.xml");
  zip.file(
    "xl/worksheets/sheet1.xml",
    sheetXml.replace('ref="A5:B5"', 'ref="A5:ZZ500"'),
  );

  await fs.writeFile(filePath, await zip.generateAsync({ type: "nodebuffer" }));
}

async function writePagedWorkbook(filePath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");
  for (let row = 1; row <= 6; row += 1) {
    sheet.addRow([`r${row}c1`, row * 10, row % 2 === 0]);
  }
  workbook.addWorksheet("Other").addRow(["not selected"]);
  await workbook.xlsx.writeFile(filePath);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("phase 20 read_spreadsheet", () => {
  it("preserves XLSX raw cell types and formulas while warning about inert high-risk parts", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    const filePath = path.join(workspaceRoot, "typed-risk.xlsx");
    await writeTypedWorkbook(filePath);
    await addInertHighRiskParts(filePath);

    const result = await runtime.executeManualTool(
      "read_spreadsheet",
      { path: "typed-risk.xlsx", maxCells: 100 },
      sessionId,
    );
    const content = result.structuredContent as TableReadResult;

    expect(result.success, result.output).toBe(true);
    expect(content).toMatchObject({
      format: "xlsx",
      source: {
        kind: "workspace_path",
        reference: "typed-risk.xlsx",
        workspaceRelativePath: "typed-risk.xlsx",
      },
      totalSheets: 2,
      truncation: { truncated: false },
    });
    expect(cellAt(content, "A2")).toMatchObject({ type: "string", value: "alpha" });
    expect(cellAt(content, "B2")).toMatchObject({ type: "boolean", value: true });
    expect(cellAt(content, "C2")).toMatchObject({ type: "number", value: 7 });
    expect(cellAt(content, "D2")).toMatchObject({
      type: "formula",
      formula: { expression: "C2*2", cachedValue: 14, calculationState: "cached" },
    });
    expect(cellAt(content, "D3")).toMatchObject({
      type: "formula",
      formula: { expression: "C2+1", calculationState: "missing" },
    });
    expect(content.sheets).toContainEqual(expect.objectContaining({ name: "Secrets", state: "very_hidden" }));
    expect(content.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      "formula_not_calculated",
      "formula_cache_missing",
      "macro_present",
      "external_link_present",
      "hidden_sheet_present",
      "abnormal_merge",
    ]));
    expect(result.output).not.toContain("vbaProject.bin");
    expect(result.output).not.toContain("invalid.example.test");
  });

  it("reads CSV and TSV as text without inventing scalar types", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    await fs.writeFile(
      path.join(workspaceRoot, "sample.csv"),
      "name,count,note\r\nalpha,42,\"comma, inside\"\r\nformula,=2+2,kept as text\r\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceRoot, "sample.tsv"),
      "name\tcount\tnote\r\nbeta\t7\ttabular\r\n",
      "utf8",
    );

    const csv = await runtime.executeManualTool("read_spreadsheet", { path: "sample.csv" }, sessionId);
    const csvContent = csv.structuredContent as TableReadResult;
    expect(csv.success).toBe(true);
    expect(csvContent.format).toBe("csv");
    expect(cells(csvContent)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "string", value: "42" }),
      expect.objectContaining({ type: "string", value: "comma, inside" }),
      expect.objectContaining({ type: "string", value: "=2+2" }),
    ]));
    expect(csvContent.warnings).toContainEqual(expect.objectContaining({ code: "formula_like_text" }));

    const tsv = await runtime.executeManualTool("read_spreadsheet", { path: "sample.tsv" }, sessionId);
    const tsvContent = tsv.structuredContent as TableReadResult;
    expect(tsv.success).toBe(true);
    expect(tsvContent.format).toBe("tsv");
    expect(cells(tsvContent)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "string", value: "7" }),
      expect.objectContaining({ type: "string", value: "tabular" }),
    ]));
  });

  it("applies sheet and range selection before explicit cursor pagination", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    await writePagedWorkbook(path.join(workspaceRoot, "paged.xlsx"));
    const args = {
      path: "paged.xlsx",
      sheet: "Data",
      range: { startRow: 2, endRow: 5, startColumn: 1, endColumn: 3 },
      maxCells: 4,
    };

    const first = await runtime.executeManualTool("read_spreadsheet", args, sessionId);
    const firstContent = first.structuredContent as TableReadResult;
    expect(first.success, first.output).toBe(true);
    expect(firstContent).toMatchObject({
      totalSheets: 2,
      totalCells: 12,
      returnedCells: 4,
      truncation: {
        truncated: true,
        reason: "pagination",
        returnedItems: 4,
        totalItems: 12,
        nextCursor: expect.any(String),
      },
    });
    expect(firstContent.sheets).toHaveLength(1);
    expect(firstContent.sheets[0]?.name).toBe("Data");
    expect(firstContent.metadata.properties).toMatchObject({
      selection: expect.objectContaining({ sheets: ["Data"], requestedSheet: "Data" }),
    });
    expect(firstContent.warnings).toContainEqual(expect.objectContaining({ code: "output_truncated" }));

    const second = await runtime.executeManualTool(
      "read_spreadsheet",
      { ...args, cursor: firstContent.truncation.nextCursor },
      sessionId,
    );
    const secondContent = second.structuredContent as TableReadResult;
    expect(second.success).toBe(true);
    expect(secondContent.returnedCells).toBe(4);
    expect(new Set(cells(firstContent).map((cell) => cell.address))).not.toEqual(
      new Set(cells(secondContent).map((cell) => cell.address)),
    );
    expect(cells(firstContent).map((cell) => cell.address)).not.toEqual(
      expect.arrayContaining(cells(secondContent).map((cell) => cell.address)),
    );
    expect(resultArtifactIsRecoveryCopy(first)).toBe(true);
    expect(first.output.length).toBeLessThan(2_000_000);
  });

  it("returns structured errors for invalid UTF-8, damaged XLSX, and format spoofing", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    await fs.writeFile(path.join(workspaceRoot, "invalid.csv"), Buffer.from([0x61, 0x2c, 0xc3, 0x28]));
    await fs.writeFile(path.join(workspaceRoot, "damaged.xlsx"), Buffer.from("PK\u0003\u0004not-a-valid-zip"));
    await fs.writeFile(path.join(workspaceRoot, "spoofed.xlsx"), Buffer.from("name,count\nalpha,1\n"));

    const encoding = await runtime.executeManualTool("read_spreadsheet", { path: "invalid.csv" }, sessionId);
    expect(encoding).toMatchObject({
      success: false,
      structuredContent: {
        kind: "spreadsheet_error",
        format: "csv",
        code: "text_invalid_encoding",
        error: { type: "command_failed", retryable: false, toolName: "read_spreadsheet" },
      },
    });

    const damaged = await runtime.executeManualTool("read_spreadsheet", { path: "damaged.xlsx" }, sessionId);
    expect(damaged).toMatchObject({
      success: false,
      structuredContent: { kind: "spreadsheet_error", format: "xlsx", code: "xlsx_invalid_or_damaged" },
    });

    const spoofed = await runtime.executeManualTool("read_spreadsheet", { path: "spoofed.xlsx" }, sessionId);
    expect(spoofed).toMatchObject({
      success: false,
      structuredContent: { kind: "spreadsheet_error", format: "xlsx", code: "format_mismatch" },
    });
  });

  it("enforces schema, range, sheet, cursor, and workspace permission boundaries", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    await writePagedWorkbook(path.join(workspaceRoot, "bounds.xlsx"));

    for (const invalidArgs of [
      { path: "bounds.xlsx", maxCells: 0 },
      { path: "bounds.xlsx", maxCells: 10_001 },
      { path: "bounds.xlsx", extra: true },
    ]) {
      const invalid = await runtime.executeManualTool("read_spreadsheet", invalidArgs, sessionId);
      expect(invalid.success).toBe(false);
      expect(invalid.structuredContent).toMatchObject({ error: { type: "invalid_arguments", retryable: false } });
    }


    const invalidCursor = await runtime.executeManualTool("read_spreadsheet", { path: "bounds.xlsx", cursor: "-1" }, sessionId);
    expect(invalidCursor).toMatchObject({
      success: false,
      structuredContent: { kind: "spreadsheet_error", code: "range_invalid" },
    });

    const badRange = await runtime.executeManualTool(
      "read_spreadsheet",
      { path: "bounds.xlsx", range: { startRow: 5, endRow: 2 } },
      sessionId,
    );
    expect(badRange).toMatchObject({
      success: false,
      structuredContent: { kind: "spreadsheet_error", code: "range_invalid" },
    });

    const missingSheet = await runtime.executeManualTool(
      "read_spreadsheet",
      { path: "bounds.xlsx", sheet: "Missing" },
      sessionId,
    );
    expect(missingSheet).toMatchObject({
      success: false,
      structuredContent: { kind: "spreadsheet_error", code: "sheet_not_found" },
    });

    const escaped = await runtime.executeManualTool(
      "read_spreadsheet",
      { path: "../outside.xlsx" },
      sessionId,
    );
    expect(escaped).toMatchObject({
      success: false,
      structuredContent: { error: { type: "invalid_path", retryable: false, toolName: "read_spreadsheet" } },
    });
  });

  it("declares a stable read-only schema, permission, availability, and output ceiling", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    await runtime.initialize();
    const definition = runtime.listRegisteredToolDefinitions().find((tool) => tool.name === "read_spreadsheet");
    expect(definition).toMatchObject({
      name: "read_spreadsheet",
      readOnly: true,
      permissionCategory: "read_only",
      sideEffectLevel: "none",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: expect.any(Object),
          format: expect.objectContaining({ enum: ["xlsx", "csv", "tsv"] }),
          maxCells: expect.objectContaining({ minimum: 1, maximum: 10_000 }),
        },
      },
    });
    expect(runtime.listAvailableToolDefinitions().map((tool) => tool.name)).toContain("read_spreadsheet");

    const missing = await runtime.executeManualTool("read_spreadsheet", { path: "missing.xlsx" }, sessionId);
    expect(missing.success).toBe(false);
    expect(missing.output.length).toBeLessThan(20_000);
    expect(missing.output).not.toContain(workspaceRoot);
  });
});

function resultArtifactIsRecoveryCopy(result: Awaited<ReturnType<ToolRuntime["executeManualTool"]>>): boolean {
  const artifact = result.artifacts?.[0];
  return Boolean(
    artifact
      && artifact.sourceToolName === "read_spreadsheet"
      && artifact.fileName.endsWith(".xlsx")
      && artifact.sizeBytes > 0,
  );
}
