import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import ExcelJS from "exceljs";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../packages/persistence/src/index.js";
import type {
  StructuredDocumentWarning,
  ToolOutputArtifact,
} from "../packages/shared-schema/src/index.js";
import { ToolRuntime } from "../packages/tool-runtime/src/index.js";
import { builtInToolModules } from "../packages/tool-runtime/src/built-ins/index.js";
import { recoveryToolModule } from "../packages/tool-runtime/src/built-ins/recovery/index.js";
import {
  convertDocumentTool,
  conversionsToolModule,
} from "../packages/tool-runtime/src/built-ins/structured-documents/conversions.js";
import {
  PHASE20_LIMITS,
  PHASE20_OFFLINE_CONVERSION_ALLOWLIST,
} from "../packages/tool-runtime/src/built-ins/structured-documents/format-policy.js";
import { parseDelimitedText } from "../packages/tool-runtime/src/built-ins/structured-documents/spreadsheet-parser.js";

const temporaryRoots: string[] = [];

type SpreadsheetConversionFormat = "xlsx" | "csv" | "tsv";

interface ConversionFixture {
  workspaceRoot: string;
  sessionStore: SessionStore;
  runtime: ToolRuntime;
  sessionId: string;
}

interface ConversionBody {
  sourceFormat: SpreadsheetConversionFormat;
  targetFormat: SpreadsheetConversionFormat;
  fidelity: "lossless" | "structured" | "lossy_single_sheet";
  inputPath: string;
  outputPath: string;
  inputSizeBytes: number;
  sizeBytes: number;
  selectedSheet?: string;
  lostCapabilities: string[];
  warnings: StructuredDocumentWarning[];
  artifact: ToolOutputArtifact;
  checkpointId: string;
  undoAvailable: boolean;
  capabilities: {
    offlineOnly: boolean;
    officeAutomation: boolean;
    externalPrograms: boolean;
    allowlist: Array<{ source: string; target: string; fidelity: string }>;
  };
}

interface ConversionFailureBody {
  kind: "document_conversion_error";
  sourceFormat: string;
  targetFormat: string;
  code: string;
  error: {
    type: string;
    message: string;
    retryable: false;
    toolName: "convert_document";
    fieldPath?: string;
  };
}

async function createRuntime(): Promise<ConversionFixture> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase20-convert-"));
  temporaryRoots.push(workspaceRoot);
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("convert an allowlisted document without Office or shell programs");
  const runtime = new ToolRuntime({
    workspaceRoot,
    sessionStore,
    permissionMode: "danger-full-access",
    modules: [conversionsToolModule, recoveryToolModule],
  });
  return { workspaceRoot, sessionStore, runtime, sessionId: session.sessionId };
}

async function writeSimpleXlsx(absolutePath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");
  sheet.addRow(["name", "value"]);
  sheet.addRow(["alpha", 1]);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await workbook.xlsx.writeFile(absolutePath);
}

async function writeFidelityXlsx(absolutePath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phase 20 conversion fixture";
  const data = workbook.addWorksheet("Data", { views: [{ state: "frozen", ySplit: 1 }] });
  data.getCell("A1").value = "label";
  data.getCell("B1").value = "value";
  data.getCell("A1").font = { bold: true, color: { argb: "FFFF0000" } };
  data.getCell("A2").value = "ordinary";
  data.getCell("B2").value = { formula: "1+1", result: 2 };
  data.getCell("A3").value = "=ordinary-text";
  data.mergeCells("A4:B4");
  data.getCell("A4").value = "merged";
  const hidden = workbook.addWorksheet("Hidden");
  hidden.state = "hidden";
  hidden.addRow(["not", "silently", "lost"]);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await workbook.xlsx.writeFile(absolutePath);
}

async function writeDdeFormulaXlsx(absolutePath: string, expression: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");
  sheet.getCell("A1").value = "payload";
  sheet.getCell("A2").value = { formula: expression };
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await workbook.xlsx.writeFile(absolutePath);
}

async function writeCompressedXlsxBomb(absolutePath: string): Promise<void> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/></Types>",
  );
  zip.file(
    "xl/workbook.xml",
    "<?xml version=\"1.0\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheets/></workbook>",
  );
  zip.file("xl/sharedStrings.xml", "A".repeat(2 * 1024 * 1024));
  await fs.writeFile(absolutePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

function conversionBody(
  result: Awaited<ReturnType<ToolRuntime["executeManualTool"]>>,
): ConversionBody {
  return result.structuredContent as ConversionBody;
}

function warningEvidence(body: Pick<ConversionBody, "warnings" | "lostCapabilities">): string {
  return [
    ...body.lostCapabilities,
    ...body.warnings.flatMap((warning) => [warning.code, warning.message, JSON.stringify(warning.details ?? {})]),
  ].join("\n");
}

async function expectConversionFailure(
  result: Awaited<ReturnType<ToolRuntime["executeManualTool"]>>,
  code: string,
): Promise<ConversionFailureBody> {
  expect(result.success, result.output).toBe(false);
  expect(result.output.length).toBeLessThan(20_000);
  expect(result.structuredContent).toMatchObject({
    kind: "document_conversion_error",
    code,
    error: {
      retryable: false,
      toolName: "convert_document",
    },
  });
  return result.structuredContent as ConversionFailureBody;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("phase 20 convert_document", () => {
  it("executes exactly the frozen six-pair offline allowlist with stable fidelity and usable output", async () => {
    const fixture = await createRuntime();
    await fs.writeFile(path.join(fixture.workspaceRoot, "safe.csv"), "name,value\r\nalpha,1\r\n", "utf8");
    await fs.writeFile(path.join(fixture.workspaceRoot, "safe.tsv"), "name\tvalue\r\nbeta\t2\r\n", "utf8");
    await writeSimpleXlsx(path.join(fixture.workspaceRoot, "safe.xlsx"));

    const expectedAllowlist = [
      ["csv", "tsv", "structured"],
      ["tsv", "csv", "structured"],
      ["csv", "xlsx", "structured"],
      ["tsv", "xlsx", "structured"],
      ["xlsx", "csv", "lossy_single_sheet"],
      ["xlsx", "tsv", "lossy_single_sheet"],
    ] as const;
    expect(PHASE20_OFFLINE_CONVERSION_ALLOWLIST.map((entry) => [entry.source, entry.target, entry.fidelity]))
      .toEqual(expectedAllowlist);

    for (const [sourceFormat, targetFormat, fidelity] of expectedAllowlist) {
      const outputPath = `out/${sourceFormat}-to-${targetFormat}.${targetFormat}`;
      const args = {
        inputPath: `safe.${sourceFormat}`,
        outputPath,
        sourceFormat,
        targetFormat,
        ...(sourceFormat === "xlsx" ? { sheet: "Data" } : {}),
      };
      const result = await fixture.runtime.executeManualTool("convert_document", args, fixture.sessionId);
      const body = conversionBody(result);

      expect(result.success, `${sourceFormat}->${targetFormat}: ${result.output}`).toBe(true);
      expect(body).toMatchObject({
        sourceFormat,
        targetFormat,
        fidelity,
        inputPath: `safe.${sourceFormat}`,
        outputPath,
        inputSizeBytes: expect.any(Number),
        sizeBytes: expect.any(Number),
        warnings: expect.any(Array),
        lostCapabilities: expect.any(Array),
        checkpointId: expect.any(String),
        undoAvailable: true,
        artifact: {
          uri: `file://${outputPath}`,
          fileName: `${sourceFormat}-to-${targetFormat}.${targetFormat}`,
          sourceToolName: "convert_document",
          workspaceRelativePath: outputPath,
          sizeBytes: expect.any(Number),
        },
        capabilities: {
          offlineOnly: true,
          officeAutomation: false,
          externalPrograms: false,
          allowlist: expect.any(Array),
        },
      });
      expect(body.inputSizeBytes).toBeGreaterThan(0);
      expect(body.sizeBytes).toBeGreaterThan(0);
      expect(body.sizeBytes).toBeLessThanOrEqual(PHASE20_LIMITS.conversion.maxOutputBytes);
      expect(body.artifact.sizeBytes).toBe(body.sizeBytes);
      expect(result.artifacts).toContainEqual(expect.objectContaining(body.artifact));
      expect(result.output.length).toBeLessThanOrEqual(PHASE20_LIMITS.maxModelVisibleChars);

      const absoluteOutput = path.join(fixture.workspaceRoot, outputPath);
      if (targetFormat === "xlsx") {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(absoluteOutput);
        expect(workbook.worksheets).toHaveLength(1);
        expect(workbook.worksheets[0]?.getCell("A2").value).toMatch(/alpha|beta/u);
      } else {
        const text = await fs.readFile(absoluteOutput, "utf8");
        const rows = parseDelimitedText(text, targetFormat === "csv" ? "," : "\t");
        expect(rows[0]).toEqual(["name", "value"]);
        expect(rows[1]?.[0]).toMatch(/alpha|beta/u);
      }
    }

    expect((await fixture.sessionStore.listToolOutputArtifacts(fixture.sessionId)))
      .toHaveLength(expectedAllowlist.length);
  });

  it("neutralizes ordinary CSV/TSV formula injection while retaining explicit XLSX formula risk evidence", async () => {
    const fixture = await createRuntime();
    await fs.writeFile(
      path.join(fixture.workspaceRoot, "danger.csv"),
      "kind,payload\r\nplain,=2+2\r\nplus,+cmd\r\nminus,-cmd\r\nat,@cmd\r\nspace,  =SUM(A1:A2)\r\n",
      "utf8",
    );
    const csvToTsv = await fixture.runtime.executeManualTool(
      "convert_document",
      {
        inputPath: "danger.csv",
        outputPath: "out/safe.tsv",
        sourceFormat: "csv",
        targetFormat: "tsv",
      },
      fixture.sessionId,
    );
    const csvBody = conversionBody(csvToTsv);
    expect(csvToTsv.success, csvToTsv.output).toBe(true);
    expect(csvBody.fidelity).toBe("structured");
    expect(csvBody.lostCapabilities).toContain("formula_like_text_identity_after_injection_sanitization");
    const rows = parseDelimitedText(await fs.readFile(path.join(fixture.workspaceRoot, "out/safe.tsv"), "utf8"), "\t");
    for (const row of rows.slice(1)) {
      expect(row[1]).toMatch(/^'/u);
    }
    expect(warningEvidence(csvBody)).toMatch(/formula|injection|escaped|neutral/iu);
    expect(warningEvidence(csvBody)).toMatch(/apostrophe|sanitiz|source text|identity/iu);

    await writeFidelityXlsx(path.join(fixture.workspaceRoot, "formula.xlsx"));
    const xlsxToCsv = await fixture.runtime.executeManualTool(
      "convert_document",
      {
        inputPath: "formula.xlsx",
        outputPath: "out/formula.csv",
        sourceFormat: "xlsx",
        targetFormat: "csv",
        sheet: "Data",
      },
      fixture.sessionId,
    );
    const xlsxBody = conversionBody(xlsxToCsv);
    expect(xlsxToCsv.success, xlsxToCsv.output).toBe(true);
    expect(warningEvidence(xlsxBody)).toMatch(/formula|cached|calculat|CSV|risk/iu);
    expect(warningEvidence(xlsxBody)).toMatch(/conversion_fidelity_loss|fidelity/iu);
  });

  it("rejects pipe/DDE formulas during XLSX to CSV/TSV conversion before publishing output", async () => {
    const fixture = await createRuntime();
    await writeDdeFormulaXlsx(
      path.join(fixture.workspaceRoot, "dde.xlsx"),
      " \tCmD.ExE | ' /c whoami' ! A0",
    );
    const existingOutput = path.join(fixture.workspaceRoot, "out/existing.tsv");
    const original = Buffer.from("existing target must survive\u0000\u00ff", "latin1");
    await fs.mkdir(path.dirname(existingOutput), { recursive: true });
    await fs.writeFile(existingOutput, original);

    const cases = [
      { targetFormat: "csv" as const, outputPath: "out/blocked.csv", overwrite: false },
      { targetFormat: "tsv" as const, outputPath: "out/existing.tsv", overwrite: true },
    ];
    for (const testCase of cases) {
      const result = await fixture.runtime.executeManualTool(
        "convert_document",
        {
          inputPath: "dde.xlsx",
          outputPath: testCase.outputPath,
          sourceFormat: "xlsx",
          targetFormat: testCase.targetFormat,
          sheet: "Data",
          overwrite: testCase.overwrite,
        },
        fixture.sessionId,
      );
      const body = await expectConversionFailure(result, "unsupported_capability");
      expect(body.error).toMatchObject({ type: "invalid_arguments" });
      expect(body.error.message).toMatch(/external-reference|external-execution|safe spreadsheet/iu);
    }

    await expect(fs.stat(path.join(fixture.workspaceRoot, "out/blocked.csv"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(existingOutput)).toEqual(original);
    expect(await fixture.sessionStore.listToolOutputArtifacts(fixture.sessionId)).toHaveLength(0);
  });

  it("reports multi-sheet, hidden-sheet, style, merge, and formula fidelity loss instead of silent dropping", async () => {
    const fixture = await createRuntime();
    await writeFidelityXlsx(path.join(fixture.workspaceRoot, "rich.xlsx"));

    const explicit = await fixture.runtime.executeManualTool(
      "convert_document",
      {
        inputPath: "rich.xlsx",
        outputPath: "out/rich.tsv",
        sourceFormat: "xlsx",
        targetFormat: "tsv",
        sheet: "Data",
      },
      fixture.sessionId,
    );
    const explicitBody = conversionBody(explicit);
    expect(explicit.success, explicit.output).toBe(true);
    expect(explicitBody).toMatchObject({ fidelity: "lossy_single_sheet", selectedSheet: "Data" });
    expect(explicitBody.lostCapabilities.length).toBeGreaterThan(0);
    const evidence = warningEvidence(explicitBody);
    expect(evidence).toMatch(/conversion_fidelity_loss|fidelity/iu);
    expect(evidence).toMatch(/sheet|hidden/iu);
    expect(evidence).toMatch(/style|format|merge/iu);
    expect(evidence).toMatch(/formula|cached|calculat/iu);

    const implicit = await fixture.runtime.executeManualTool(
      "convert_document",
      {
        inputPath: "rich.xlsx",
        outputPath: "out/default.csv",
        sourceFormat: "xlsx",
        targetFormat: "csv",
      },
      fixture.sessionId,
    );
    const implicitBody = conversionBody(implicit);
    expect(implicit.success, implicit.output).toBe(true);
    expect(implicitBody.selectedSheet).toBe("Data");
    expect(warningEvidence(implicitBody)).toMatch(/default|active|first|selected|sheet/iu);
  });

  it("rejects known non-allowlisted document pairs with a structured error before reading or writing", async () => {
    const fixture = await createRuntime();
    const cases = [
      ["pptx", "pdf"],
      ["pdf", "docx"],
      ["docx", "xlsx"],
      ["ipynb", "csv"],
      ["xlsx", "pptx"],
      ["csv", "csv"],
    ] as const;

    for (const [sourceFormat, targetFormat] of cases) {
      const result = await fixture.runtime.executeManualTool(
        "convert_document",
        {
          inputPath: `missing.${sourceFormat}`,
          outputPath: `out/blocked.${targetFormat}`,
          sourceFormat,
          targetFormat,
        },
        fixture.sessionId,
      );
      const body = await expectConversionFailure(result, "conversion_not_allowed");
      expect(body).toMatchObject({ sourceFormat, targetFormat });
      expect(result.output).toMatch(/allowlist|not allowed|unsupported/iu);
      await expect(fs.stat(path.join(fixture.workspaceRoot, `out/blocked.${targetFormat}`)))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects explicit format/extension disagreement and XLSX magic spoofing", async () => {
    const fixture = await createRuntime();
    await fs.writeFile(path.join(fixture.workspaceRoot, "data.csv"), "a,b\r\n1,2\r\n", "utf8");
    await fs.writeFile(path.join(fixture.workspaceRoot, "spoofed.xlsx"), "a,b\r\n1,2\r\n", "utf8");
    await writeSimpleXlsx(path.join(fixture.workspaceRoot, "real.xlsx"));

    const cases: Array<[Record<string, unknown>, string]> = [
      [{
        inputPath: "data.csv",
        outputPath: "out/source-mismatch.csv",
        sourceFormat: "tsv",
        targetFormat: "csv",
      }, "format_mismatch"],
      [{
        inputPath: "data.csv",
        outputPath: "out/mismatch.csv",
        sourceFormat: "csv",
        targetFormat: "tsv",
      }, "format_mismatch"],
      [{
        inputPath: "spoofed.xlsx",
        outputPath: "out/spoofed.csv",
        sourceFormat: "xlsx",
        targetFormat: "csv",
      }, "format_mismatch"],
      [{
        inputPath: "real.xlsx",
        outputPath: "out/wrong.xlsx",
        sourceFormat: "xlsx",
        targetFormat: "csv",
      }, "format_mismatch"],
    ];

    for (const [args, code] of cases) {
      const result = await fixture.runtime.executeManualTool("convert_document", args, fixture.sessionId);
      await expectConversionFailure(result, code);
    }
  });

  it("returns structured bounded failures for damaged/invalid input and the actual input-byte ceiling", async () => {
    const fixture = await createRuntime();
    await fs.writeFile(path.join(fixture.workspaceRoot, "damaged.xlsx"), Buffer.from("PK\u0003\u0004damaged"));
    await writeCompressedXlsxBomb(path.join(fixture.workspaceRoot, "bomb.xlsx"));
    await fs.writeFile(path.join(fixture.workspaceRoot, "invalid.csv"), Buffer.from([0x61, 0x2c, 0xc3, 0x28]));
    const oversized = path.join(fixture.workspaceRoot, "oversized.csv");
    const oversizedHandle = await fs.open(oversized, "w");
    try {
      await oversizedHandle.truncate(PHASE20_LIMITS.conversion.maxInputBytes + 1);
    } finally {
      await oversizedHandle.close();
    }

    for (const [inputPath, sourceFormat, targetFormat, code] of [
      ["damaged.xlsx", "xlsx", "csv", "input_invalid_or_damaged"],
      ["bomb.xlsx", "xlsx", "csv", "input_invalid_or_damaged"],
      ["invalid.csv", "csv", "tsv", "input_invalid_or_damaged"],
      ["oversized.csv", "csv", "tsv", "input_too_large"],
    ] as const) {
      const result = await fixture.runtime.executeManualTool(
        "convert_document",
        { inputPath, outputPath: `out/${inputPath}.${targetFormat}`, sourceFormat, targetFormat },
        fixture.sessionId,
      );
      await expectConversionFailure(result, code);
      await expect(fs.stat(path.join(fixture.workspaceRoot, `out/${inputPath}.${targetFormat}`)))
        .rejects.toMatchObject({ code: "ENOENT" });
      if (inputPath === "bomb.xlsx") expect(result.output).toMatch(/compression-ratio|expanded|package/iu);
    }
  });

  it("uses guarded paths and refuses lexical, protected, and junction escapes", async () => {
    const fixture = await createRuntime();
    await fs.writeFile(path.join(fixture.workspaceRoot, "safe.csv"), "a,b\r\n1,2\r\n", "utf8");

    for (const [args, type] of [
      [{
        inputPath: "../outside.csv",
        outputPath: "out/a.tsv",
        sourceFormat: "csv",
        targetFormat: "tsv",
      }, "invalid_path"],
      [{
        inputPath: ".deep-mix/api-key-library/protected.csv",
        outputPath: "out/b.tsv",
        sourceFormat: "csv",
        targetFormat: "tsv",
      }, "sandbox_denied"],
      [{
        inputPath: "safe.csv",
        outputPath: ".deep-mix/api-key-library/protected.tsv",
        sourceFormat: "csv",
        targetFormat: "tsv",
      }, "sandbox_denied"],
      [{
        inputPath: "safe.csv",
        outputPath: "../escaped.tsv",
        sourceFormat: "csv",
        targetFormat: "tsv",
      }, "invalid_path"],
    ] as const) {
      const result = await fixture.runtime.executeManualTool("convert_document", args, fixture.sessionId);
      expect(result).toMatchObject({
        success: false,
        structuredContent: { error: { type, retryable: false, toolName: "convert_document" } },
      });
    }

    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase20-convert-outside-"));
    temporaryRoots.push(outsideRoot);
    await fs.symlink(outsideRoot, path.join(fixture.workspaceRoot, "outside-link"), "junction");
    const linked = await fixture.runtime.executeManualTool(
      "convert_document",
      {
        inputPath: "safe.csv",
        outputPath: "outside-link/escaped.tsv",
        sourceFormat: "csv",
        targetFormat: "tsv",
      },
      fixture.sessionId,
    );
    expect(linked).toMatchObject({
      success: false,
      structuredContent: { error: { type: "invalid_path", retryable: false, toolName: "convert_document" } },
    });
    await expect(fs.stat(path.join(outsideRoot, "escaped.tsv"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes artifacts and checkpoints, undoes new files, and restores overwritten bytes exactly", async () => {
    const fixture = await createRuntime();
    await fs.writeFile(path.join(fixture.workspaceRoot, "safe.csv"), "a,b\r\n1,2\r\n", "utf8");

    const created = await fixture.runtime.executeManualTool(
      "convert_document",
      {
        inputPath: "safe.csv",
        outputPath: "out/new.tsv",
        sourceFormat: "csv",
        targetFormat: "tsv",
      },
      fixture.sessionId,
    );
    const createdBody = conversionBody(created);
    expect(created.success, created.output).toBe(true);
    expect(await fs.readFile(path.join(fixture.workspaceRoot, "out/new.tsv"), "utf8")).toContain("\t");
    expect((await fixture.sessionStore.listUndoCandidates(fixture.sessionId)).map((item) => item.checkpointId))
      .toContain(createdBody.checkpointId);
    expect(await fixture.sessionStore.listToolOutputArtifacts(fixture.sessionId))
      .toContainEqual(expect.objectContaining({
        uri: "file://out/new.tsv",
        sourceToolName: "convert_document",
      }));
    const undoCreated = await fixture.runtime.executeManualTool(
      "undo",
      { checkpointId: createdBody.checkpointId, mode: "code" },
      fixture.sessionId,
    );
    expect(undoCreated.success, undoCreated.output).toBe(true);
    await expect(fs.stat(path.join(fixture.workspaceRoot, "out/new.tsv"))).rejects.toMatchObject({ code: "ENOENT" });

    const existingPath = path.join(fixture.workspaceRoot, "existing.tsv");
    const original = Buffer.from("original conversion target\u0000\u00ff", "latin1");
    await fs.writeFile(existingPath, original);
    const denied = await fixture.runtime.executeManualTool(
      "convert_document",
      {
        inputPath: "safe.csv",
        outputPath: "existing.tsv",
        sourceFormat: "csv",
        targetFormat: "tsv",
      },
      fixture.sessionId,
    );
    const deniedBody = await expectConversionFailure(denied, "output_exists");
    expect(deniedBody.error).toMatchObject({ type: "invalid_arguments", fieldPath: "/overwrite" });
    expect(denied.output).toMatch(/overwrite/iu);
    expect(await fs.readFile(existingPath)).toEqual(original);

    const overwritten = await fixture.runtime.executeManualTool(
      "convert_document",
      {
        inputPath: "safe.csv",
        outputPath: "existing.tsv",
        sourceFormat: "csv",
        targetFormat: "tsv",
        overwrite: true,
      },
      fixture.sessionId,
    );
    const overwrittenBody = conversionBody(overwritten);
    expect(overwritten.success, overwritten.output).toBe(true);
    expect(await fs.readFile(existingPath)).not.toEqual(original);
    const undoOverwrite = await fixture.runtime.executeManualTool(
      "undo",
      { checkpointId: overwrittenBody.checkpointId, mode: "code" },
      fixture.sessionId,
    );
    expect(undoOverwrite.success, undoOverwrite.output).toBe(true);
    expect(await fs.readFile(existingPath)).toEqual(original);
  });

  it("enforces a strict schema and sheet selection boundary", async () => {
    const fixture = await createRuntime();
    await fs.writeFile(path.join(fixture.workspaceRoot, "safe.csv"), "a,b\r\n1,2\r\n", "utf8");
    await writeSimpleXlsx(path.join(fixture.workspaceRoot, "safe.xlsx"));
    const invalidCases: unknown[] = [
      {},
      { inputPath: "safe.csv", outputPath: "out.tsv", sourceFormat: "csv" },
      { inputPath: "safe.csv", outputPath: "out.tsv", targetFormat: "tsv" },
      {
        inputPath: "safe.csv",
        outputPath: "out.tsv",
        sourceFormat: "csv",
        targetFormat: "tsv",
        extra: true,
      },
      {
        inputPath: "safe.csv",
        outputPath: "out.tsv",
        sourceFormat: "made-up",
        targetFormat: "tsv",
      },
      {
        inputPath: "safe.csv",
        outputPath: "out.tsv",
        sourceFormat: "csv",
        targetFormat: "made-up",
      },
      {
        inputPath: "safe.csv",
        outputPath: "out.tsv",
        sourceFormat: "csv",
        targetFormat: "tsv",
        overwrite: "yes",
      },
      {
        inputPath: "safe.xlsx",
        outputPath: "out.csv",
        sourceFormat: "xlsx",
        targetFormat: "csv",
        sheet: 0,
      },
    ];
    for (const args of invalidCases) {
      const result = await fixture.runtime.executeManualTool("convert_document", args, fixture.sessionId);
      expect(result, JSON.stringify(args)).toMatchObject({
        success: false,
        structuredContent: { error: { type: "invalid_arguments", retryable: false, toolName: "convert_document" } },
      });
    }

    const inappropriateSheet = await fixture.runtime.executeManualTool(
      "convert_document",
      {
        inputPath: "safe.csv",
        outputPath: "out/sheet.tsv",
        sourceFormat: "csv",
        targetFormat: "tsv",
        sheet: "Data",
      },
      fixture.sessionId,
    );
    expect(inappropriateSheet.success).toBe(false);
    expect(inappropriateSheet.output).toMatch(/sheet.*XLSX|XLSX.*sheet/iu);
  });

  it("declares capability, write permission/access, registry selection, ceilings, and no shell or Office path", async () => {
    const fixture = await createRuntime();
    await fixture.runtime.initialize();
    const definition = fixture.runtime.listRegisteredToolDefinitions().find((tool) => tool.name === "convert_document");
    expect(definition).toMatchObject({
      name: "convert_document",
      readOnly: false,
      permissionCategory: "write_file",
      sideEffectLevel: "high",
      checkpoint: { mode: "before_write", scope: "pre_tool_write" },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["inputPath", "outputPath", "sourceFormat", "targetFormat"],
        properties: {
          inputPath: expect.any(Object),
          outputPath: expect.any(Object),
          sourceFormat: expect.objectContaining({
            enum: expect.arrayContaining(["xlsx", "csv", "tsv", "pptx", "pdf", "docx", "ipynb"]),
          }),
          targetFormat: expect.objectContaining({
            enum: expect.arrayContaining(["xlsx", "csv", "tsv", "pptx", "pdf", "docx", "ipynb"]),
          }),
          overwrite: { type: "boolean" },
          sheet: expect.any(Object),
        },
      },
      selection: {
        attachmentExtensions: [".xlsx", ".csv", ".tsv"],
        keywords: expect.any(Array),
        keywordGroups: expect.any(Array),
      },
    });
    expect(definition?.selection?.mimeTypes).toEqual(expect.arrayContaining([
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv",
      "text/tab-separated-values",
    ]));
    expect(convertDocumentTool.getAvailability).toEqual(expect.any(Function));
    expect(convertDocumentTool.resolveAccess).toEqual(expect.any(Function));
    const access = await convertDocumentTool.resolveAccess!(
      {
        inputPath: "safe.csv",
        outputPath: "out/safe.tsv",
        sourceFormat: "csv",
        targetFormat: "tsv",
      },
      {} as never,
    );
    expect(access).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "filesystem_read" }),
      expect.objectContaining({ kind: "filesystem_write" }),
    ]));

    expect(fixture.runtime.listAvailableToolDefinitions().map((tool) => tool.name)).toContain("convert_document");
    expect(builtInToolModules.map((module) => module.manifest.id)).toContain("builtin.conversions");
    expect(fixture.runtime.selectToolsForTurn({ attachmentExtensions: [".xlsx"] }).definitions.map((tool) => tool.name))
      .toContain("convert_document");
    expect(fixture.runtime.selectToolsForTurn({ attachmentMimeTypes: ["text/csv"] }).definitions.map((tool) => tool.name))
      .toContain("convert_document");
    expect(fixture.runtime.selectToolsForTurn({ prompt: "Convert this CSV spreadsheet to XLSX." }).definitions.map((tool) => tool.name))
      .toContain("convert_document");
    expect(fixture.runtime.selectToolsForTurn({ prompt: "Explain this TypeScript function." }).definitions.map((tool) => tool.name))
      .not.toContain("convert_document");

    expect(PHASE20_LIMITS.conversion).toEqual({
      maxInputBytes: 64 * 1024 * 1024,
      maxOutputBytes: 128 * 1024 * 1024,
    });
    const implementation = await fs.readFile(
      path.join(process.cwd(), "packages/tool-runtime/src/built-ins/structured-documents/conversions.ts"),
      "utf8",
    );
    expect(implementation).not.toMatch(/from\s+["']node:(?:child_process|worker_threads)["']/u);
    expect(implementation).not.toMatch(/\b(?:execFile|exec|spawn|fork)\s*\(/u);
    expect(implementation).not.toMatch(/(?:libreoffice|soffice|winword|excel\.exe|powerpnt|Microsoft\.Office\.Interop|COM automation)/iu);
    expect(implementation).toMatch(/PHASE20_OFFLINE_CONVERSION_ALLOWLIST/u);
    expect(implementation).toMatch(/maxInputBytes/u);
    expect(implementation).toMatch(/maxOutputBytes/u);
  });
});
