import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  StructuredDocumentWarning,
  StructuredDocumentWriteResult,
  TableCellScalar,
  TableCellSpec,
  TableDocumentSpec,
  TableFormat,
  ToolAvailability,
  ToolOutputArtifact,
  ToolResult,
  ToolStructuredError,
} from "../../../../shared-schema/src/index.js";
import { ToolArgumentError } from "../../index.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolModuleContext,
} from "../../tool-module.js";

import { pathPropertySchema, structuredWarning, tableDocumentSpecSchema } from "./contracts.js";
import { PHASE20_LIMITS } from "./format-policy.js";
import { parseA1Range } from "./spreadsheet-parser.js";

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MIME_TYPES: Record<TableFormat, string> = {
  xlsx: XLSX_MIME_TYPE,
  csv: "text/csv",
  tsv: "text/tab-separated-values",
};
const MAX_WARNINGS = 200;

export interface WriteSpreadsheetArgs {
  outputPath: string;
  format?: TableFormat;
  overwrite?: boolean;
  document: TableDocumentSpec;
}

type WriteFailureCode =
  | "unsupported_format"
  | "format_mismatch"
  | "spreadsheet_too_large"
  | "xlsx_dependency_unavailable"
  | "xlsx_generation_failed"
  | "output_too_large";

interface ExcelCellWriter {
  value: unknown;
}

interface ExcelColumnWriter {
  width?: number;
  hidden?: boolean;
}

interface ExcelWorksheetWriter {
  state: "visible" | "hidden" | "veryHidden";
  views: Array<{ state: "frozen"; ySplit: number }>;
  getCell(row: number, column: number): ExcelCellWriter;
  getColumn(column: number): ExcelColumnWriter;
  mergeCells(range: string): void;
}

interface ExcelWorkbookWriter {
  title?: string;
  subject?: string;
  creator?: string;
  keywords?: string;
  created?: Date;
  modified?: Date;
  company?: string;
  views?: Array<{ activeTab: number }>;
  addWorksheet(name: string, options?: { state?: "visible" }): ExcelWorksheetWriter;
  xlsx: { writeBuffer(): Promise<ArrayBuffer> };
}

interface ExcelJsWriterApi {
  Workbook: new () => ExcelWorkbookWriter;
}

function moduleDefault<T>(module: unknown): T {
  return ((module as { default?: T }).default ?? module) as T;
}

async function loadExcelJs(): Promise<ExcelJsWriterApi> {
  const excel = moduleDefault<ExcelJsWriterApi>(await import("exceljs"));
  if (typeof excel.Workbook !== "function") throw new Error("ExcelJS Workbook API is unavailable.");
  return excel;
}

export async function writeSpreadsheetAvailability(_context: ToolModuleContext): Promise<ToolAvailability> {
  try {
    await loadExcelJs();
    return { status: "available", available: true };
  } catch (error) {
    return {
      status: "degraded",
      available: true,
      missingCapabilities: ["xlsx"],
      fallbackCapabilities: ["csv", "tsv"],
      reason: `XLSX generation is unavailable because ExcelJS could not be loaded; CSV and TSV remain available: ${(error as Error).message}`,
    };
  }
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(typeof signal.reason === "string" ? signal.reason : "Spreadsheet write was aborted.");
}

export async function publishSpreadsheetBufferAtomic(
  absolutePath: string,
  content: Buffer,
  overwrite: boolean,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.${process.pid}.${randomUUID()}.deep-mix.tmp`,
  );
  const backupPath = `${absolutePath}.${process.pid}.${randomUUID()}.deep-mix.bak`;
  let backupCreated = false;
  try {
    const handle = await fs.open(temporaryPath, "wx", 0o666);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    throwIfAborted(signal);
    if (!overwrite) {
      try {
        await fs.link(temporaryPath, absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new ToolArgumentError("Output already exists; set overwrite=true to replace it.", {
            fieldPath: "/overwrite",
          });
        }
        throw error;
      }
      return;
    }
    if (process.platform !== "win32") {
      await fs.rename(temporaryPath, absolutePath);
      return;
    }
    try {
      await fs.rename(temporaryPath, absolutePath);
      return;
    } catch (error) {
      if (!["EACCES", "EBUSY", "EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw error;
      }
    }
    try {
      await fs.rename(absolutePath, backupPath);
      backupCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await fs.rename(temporaryPath, absolutePath);
      if (backupCreated) await fs.rm(backupPath, { force: true });
      backupCreated = false;
    } catch (error) {
      if (backupCreated) {
        await fs.rm(absolutePath, { force: true }).catch(() => undefined);
        await fs.rename(backupPath, absolutePath).catch(() => undefined);
        backupCreated = false;
      }
      throw error;
    }
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    if (backupCreated) {
      await fs.rm(absolutePath, { force: true }).catch(() => undefined);
      await fs.rename(backupPath, absolutePath).catch(() => undefined);
    }
  }
}

function inferOutputFormat(args: WriteSpreadsheetArgs): TableFormat {
  const extension = path.extname(args.outputPath).toLowerCase();
  const extensionFormat = extension === ".xlsx" ? "xlsx" : extension === ".csv" ? "csv" : extension === ".tsv" ? "tsv" : undefined;
  if (!extensionFormat) {
    throw new ToolArgumentError("write_spreadsheet outputPath must end with .xlsx, .csv, or .tsv.", {
      fieldPath: "/outputPath",
    });
  }
  if (args.format && args.format !== extensionFormat) {
    throw new ToolArgumentError(`Requested ${args.format.toUpperCase()} does not match the ${extension} output extension.`, {
      fieldPath: "/format",
    });
  }
  return extensionFormat;
}

function pushWarningOnce(warnings: StructuredDocumentWarning[], warning: StructuredDocumentWarning): void {
  if (warnings.length >= MAX_WARNINGS) return;
  if (!warnings.some((entry) => entry.code === warning.code)) warnings.push(warning);
}

function cellPath(sheetIndex: number, cellIndex: number, suffix = ""): string {
  return `/document/sheets/${sheetIndex}/cells/${cellIndex}${suffix}`;
}

/**
 * Replace Excel double-quoted string literals with spaces before inspecting
 * formula code. This keeps harmless text such as
 * IF(A1="cmd|'not executable'!A0", 1, 0) from being treated as DDE while
 * preserving character boundaries for the security patterns below.
 */
function formulaCodeWithoutStringLiterals(expression: string): string {
  let output = "";
  let inString = false;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index]!;
    if (character !== '"') {
      output += inString ? " " : character;
      continue;
    }
    output += " ";
    if (inString && expression[index + 1] === '"') {
      output += " ";
      index += 1;
      continue;
    }
    inString = !inString;
  }
  return output;
}

function hasUnsafeExternalFormula(expression: string): boolean {
  const formulaCode = formulaCodeWithoutStringLiterals(expression);
  const externalReferenceOrFunction = /\[[^\]]+\]|(?:https?|ftp|file):|(?:^|[^A-Z0-9_])(?:WEBSERVICE|HYPERLINK|RTD|DDE|CALL|EXEC)\s*\(/iu;
  // Excel's DDE syntax is `<application>|'<topic>'!<item>`. Treat every
  // application/protocol token as unsafe instead of trying to maintain an
  // executable allow/deny list; a pipe is not a normal Excel formula operator.
  // The operator boundary also catches forms such as `1+cmd|'...'!A0`, while
  // double-quoted string literals and quoted sheet names containing `|` remain
  // valid ordinary formula text/references.
  const ddePipeReference = /(?:^|[=+\-*/,(;])\s*@?\s*(?:'[^'|\r\n]{1,260}'|[^'|!(),+*=&<>\r\n"]{1,260})\s*\|\s*(?:'[^'\r\n]*'|[^!\r\n]{0,4096})\s*!\s*(?:\$?[A-Z]{1,3}\$?\d{1,7}|R\d+C\d+|[A-Z_][A-Z0-9_.]*)/iu;
  return externalReferenceOrFunction.test(formulaCode) || ddePipeReference.test(formulaCode);
}

function assertCellScalar(cell: TableCellSpec, sheetIndex: number, cellIndex: number): void {
  const fieldPath = cellPath(sheetIndex, cellIndex, "/value");
  if (cell.type === "blank") return;
  if (cell.type === "formula") {
    if (!cell.formula?.expression) {
      throw new ToolArgumentError("Formula cells require an explicit formula object and expression.", {
        fieldPath: cellPath(sheetIndex, cellIndex, "/formula"),
      });
    }
    if (/^\s*=/u.test(cell.formula.expression)) {
      throw new ToolArgumentError("Formula expressions must omit the leading '='.", {
        fieldPath: cellPath(sheetIndex, cellIndex, "/formula/expression"),
      });
    }
    if (hasUnsafeExternalFormula(cell.formula.expression)) {
      throw new ToolArgumentError("External-reference and external-execution formulas are outside the safe spreadsheet writer contract.", {
        fieldPath: cellPath(sheetIndex, cellIndex, "/formula/expression"),
      });
    }
    return;
  }
  const value = cell.value;
  const valid = cell.type === "string" || cell.type === "date" || cell.type === "error"
    ? typeof value === "string"
    : cell.type === "number"
      ? typeof value === "number" && Number.isFinite(value)
      : cell.type === "boolean"
        ? typeof value === "boolean"
        : false;
  if (!valid) throw new ToolArgumentError(`Cell type ${cell.type} requires a matching primitive value.`, { fieldPath });
  if (typeof value === "string" && value.length > PHASE20_LIMITS.spreadsheet.maxCellChars) {
    throw new ToolArgumentError("Cell text exceeds the declared character limit.", { fieldPath });
  }
  if (cell.type === "date" && Number.isNaN(Date.parse(value as string))) {
    throw new ToolArgumentError("Date cells require an ISO-compatible date string.", { fieldPath });
  }
}

export function validateSpreadsheetDocument(document: TableDocumentSpec, format: TableFormat): void {
  if (document.sheets.length < 1 || document.sheets.length > PHASE20_LIMITS.spreadsheet.maxSheets) {
    throw new ToolArgumentError(`Spreadsheet must contain 1-${PHASE20_LIMITS.spreadsheet.maxSheets} sheets.`, {
      fieldPath: "/document/sheets",
    });
  }
  if (format !== "xlsx" && document.sheets.length !== 1) {
    throw new ToolArgumentError("CSV and TSV outputs require exactly one sheet.", { fieldPath: "/document/sheets" });
  }
  const names = new Set<string>();
  let totalMaterializedCells = 0;
  document.sheets.forEach((sheet, sheetIndex) => {
    const normalizedName = sheet.name.toLocaleLowerCase();
    if (names.has(normalizedName)) {
      throw new ToolArgumentError("Sheet names must be unique (case-insensitive).", {
        fieldPath: `/document/sheets/${sheetIndex}/name`,
      });
    }
    names.add(normalizedName);
    if (/[:\\/?*\[\]]/u.test(sheet.name)) {
      throw new ToolArgumentError("Sheet names cannot contain : \\ / ? * [ or ].", {
        fieldPath: `/document/sheets/${sheetIndex}/name`,
      });
    }
    if (sheet.state && sheet.state !== "visible") {
      throw new ToolArgumentError("write_spreadsheet does not create hidden or very-hidden sheets.", {
        fieldPath: `/document/sheets/${sheetIndex}/state`,
      });
    }
    sheet.columns?.forEach((column, columnIndex) => {
      if (column.hidden) {
        throw new ToolArgumentError("write_spreadsheet does not create hidden columns.", {
          fieldPath: `/document/sheets/${sheetIndex}/columns/${columnIndex}/hidden`,
        });
      }
    });
    if (format !== "xlsx" && (sheet.mergedRanges?.length ?? 0) > 0) {
      throw new ToolArgumentError("CSV and TSV outputs do not support merged ranges.", {
        fieldPath: `/document/sheets/${sheetIndex}/mergedRanges`,
      });
    }
    for (const [rangeIndex, rangeValue] of (sheet.mergedRanges ?? []).entries()) {
      const parsedRange = parseA1Range(rangeValue);
      const area = parsedRange
        ? (parsedRange.endRow - parsedRange.startRow + 1) * (parsedRange.endColumn - parsedRange.startColumn + 1)
        : Number.POSITIVE_INFINITY;
      if (
        !parsedRange
        || parsedRange.endRow > PHASE20_LIMITS.spreadsheet.maxRowsPerSheet
        || parsedRange.endColumn > PHASE20_LIMITS.spreadsheet.maxColumnsPerSheet
        || area > 10_000
      ) {
        throw new ToolArgumentError("Merged ranges must be valid A1 ranges within the basic 10,000-cell compatibility boundary.", {
          fieldPath: `/document/sheets/${sheetIndex}/mergedRanges/${rangeIndex}`,
        });
      }
    }
    const occupied = new Set<string>();
    let maxRow = sheet.rowCount ?? 0;
    let maxColumn = sheet.columnCount ?? 0;
    for (const [headerIndex, header] of (sheet.headers ?? []).entries()) {
      maxRow = Math.max(maxRow, header.sourceRow ?? 1);
      maxColumn = Math.max(maxColumn, header.column);
      const key = `${header.sourceRow ?? 1}:${header.column}`;
      if (occupied.has(key)) {
        throw new ToolArgumentError("Header coordinates must be unique.", {
          fieldPath: `/document/sheets/${sheetIndex}/headers/${headerIndex}`,
        });
      }
      occupied.add(key);
      totalMaterializedCells += 1;
    }
    for (const [cellIndex, cell] of sheet.cells.entries()) {
      assertCellScalar(cell, sheetIndex, cellIndex);
      maxRow = Math.max(maxRow, cell.row);
      maxColumn = Math.max(maxColumn, cell.column);
      const key = `${cell.row}:${cell.column}`;
      if (occupied.has(key)) {
        throw new ToolArgumentError("Each output cell coordinate may be declared only once, including headers.", {
          fieldPath: cellPath(sheetIndex, cellIndex),
        });
      }
      occupied.add(key);
      totalMaterializedCells += 1;
    }
    if (maxRow > PHASE20_LIMITS.spreadsheet.maxRowsPerSheet || maxColumn > PHASE20_LIMITS.spreadsheet.maxColumnsPerSheet) {
      throw new ToolArgumentError("Sheet dimensions exceed the declared row or column limit.", {
        fieldPath: `/document/sheets/${sheetIndex}`,
      });
    }
    if (format !== "xlsx" && maxRow * maxColumn > PHASE20_LIMITS.spreadsheet.maxWorkbookCells) {
      throw new ToolArgumentError("Delimited output's rectangular area exceeds the workbook cell budget.", {
        fieldPath: `/document/sheets/${sheetIndex}`,
      });
    }
  });
  if (totalMaterializedCells > PHASE20_LIMITS.spreadsheet.maxWorkbookCells) {
    throw new ToolArgumentError("Spreadsheet exceeds the materialized workbook cell limit.", {
      fieldPath: "/document/sheets",
    });
  }
  if (document.activeSheet && !document.sheets.some((sheet) => sheet.name === document.activeSheet)) {
    throw new ToolArgumentError("activeSheet must identify one of the declared sheets.", {
      fieldPath: "/document/activeSheet",
    });
  }
}


function explicitFormulaWarning(
  warnings: StructuredDocumentWarning[],
  format: TableFormat,
  scope: string,
): void {
  pushWarningOnce(warnings, structuredWarning("formula_not_calculated", {
    message: `An explicitly declared formula was emitted to ${format.toUpperCase()}; Deep-Mix did not calculate it and the opening spreadsheet application may do so.`,
    severity: "high",
    category: "security",
    scope,
    details: { explicit: true, calculatedByDeepMix: false, format },
  }));
}

function cachedFormulaResult(cell: TableCellSpec): unknown {
  const formula = cell.formula!;
  const value = formula.cachedValue;
  if (value === undefined || value === null || formula.cachedType === "blank") return undefined;
  if (formula.cachedType === "date") {
    const parsed = new Date(String(value));
    if (Number.isNaN(parsed.getTime())) return undefined;
    return parsed;
  }
  if (formula.cachedType === "error") return { error: String(value) };
  return value;
}

function excelValue(cell: TableCellSpec): unknown {
  if (cell.type === "blank") return null;
  if (cell.type === "formula") {
    const result = cachedFormulaResult(cell);
    return {
      formula: cell.formula!.expression,
      ...(result === undefined ? {} : { result }),
    };
  }
  if (cell.type === "date") return new Date(cell.value as string);
  if (cell.type === "error") return { error: String(cell.value) };
  return cell.value;
}

function applyWorkbookMetadata(workbook: ExcelWorkbookWriter, document: TableDocumentSpec): void {
  const metadata = document.metadata;
  workbook.title = document.title ?? metadata?.title;
  workbook.subject = metadata?.subject;
  workbook.creator = metadata?.author;
  workbook.keywords = metadata?.keywords?.join(", ");
  if (metadata?.createdAt) {
    const created = new Date(metadata.createdAt);
    if (!Number.isNaN(created.getTime())) workbook.created = created;
  }
  if (metadata?.modifiedAt) {
    const modified = new Date(metadata.modifiedAt);
    if (!Number.isNaN(modified.getTime())) workbook.modified = modified;
  }
  const company = metadata?.properties?.company;
  if (typeof company === "string") workbook.company = company;
}

async function generateXlsx(
  document: TableDocumentSpec,
  warnings: StructuredDocumentWarning[],
): Promise<Buffer> {
  let excel: ExcelJsWriterApi;
  try {
    excel = await loadExcelJs();
  } catch (error) {
    const missing = new Error(`ExcelJS is unavailable: ${(error as Error).message}`);
    missing.name = "XlsxDependencyError";
    throw missing;
  }
  try {
    const workbook = new excel.Workbook();
    applyWorkbookMetadata(workbook, document);
    document.sheets.forEach((sheet) => {
      const worksheet = workbook.addWorksheet(sheet.name, { state: "visible" });
      worksheet.state = "visible";
      for (const header of sheet.headers ?? []) {
        worksheet.getCell(header.sourceRow ?? 1, header.column).value = header.label;
      }
      for (const cell of sheet.cells) {
        worksheet.getCell(cell.row, cell.column).value = excelValue(cell);
        if (cell.type === "formula") explicitFormulaWarning(warnings, "xlsx", `${sheet.name}!${cell.address ?? `${cell.row}:${cell.column}`}`);
      }
      for (const column of sheet.columns ?? []) {
        if (column.width !== undefined) worksheet.getColumn(column.column).width = column.width;
      }
      if (sheet.freezeHeaderRow) worksheet.views = [{ state: "frozen", ySplit: 1 }];
      for (const range of sheet.mergedRanges ?? []) worksheet.mergeCells(range);
    });
    if (document.activeSheet) {
      workbook.views = [{ activeTab: document.sheets.findIndex((sheet) => sheet.name === document.activeSheet) }];
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
  } catch (error) {
    if ((error as Error).name === "XlsxDependencyError") throw error;
    const generation = new Error(`ExcelJS could not generate the bounded XLSX workbook: ${(error as Error).message}`);
    generation.name = "XlsxGenerationError";
    throw generation;
  }
}

function delimitedCellText(
  cell: TableCellSpec,
  format: "csv" | "tsv",
  warnings: StructuredDocumentWarning[],
  scope: string,
): string {
  if (cell.type === "blank" || cell.value === null) return "";
  if (cell.type === "formula") {
    explicitFormulaWarning(warnings, format, scope);
    return `=${cell.formula!.expression}`;
  }
  let text = cell.type === "date"
    ? new Date(cell.value as string).toISOString()
    : String(cell.value);
  if (cell.type === "string" && /^[\u0000-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*[=+\-@]/u.test(text)) {
    text = `'${text}`;
    pushWarningOnce(warnings, structuredWarning("csv_formula_escaped", {
      severity: "high",
      category: "security",
      scope,
      details: { format, strategy: "apostrophe_prefix" },
    }));
  }
  return text;
}

function quoteDelimited(text: string, delimiter: "," | "\t"): string {
  if (!text.includes(delimiter) && !/["\r\n]/u.test(text)) return text;
  return `"${text.replace(/"/gu, '""')}"`;
}

function generateDelimited(
  document: TableDocumentSpec,
  format: "csv" | "tsv",
  warnings: StructuredDocumentWarning[],
  maxOutputBytes = PHASE20_LIMITS.spreadsheet.maxOutputBytes,
): Buffer {
  const sheet = document.sheets[0]!;
  const cells = new Map<string, TableCellSpec>();
  let maxRow = sheet.rowCount ?? 0;
  let maxColumn = sheet.columnCount ?? 0;
  for (const header of sheet.headers ?? []) {
    maxRow = Math.max(maxRow, header.sourceRow ?? 1);
    maxColumn = Math.max(maxColumn, header.column);
    cells.set(`${header.sourceRow ?? 1}:${header.column}`, {
      row: header.sourceRow ?? 1,
      column: header.column,
      type: "string",
      value: header.label,
    });
  }
  for (const cell of sheet.cells) {
    cells.set(`${cell.row}:${cell.column}`, cell);
    maxRow = Math.max(maxRow, cell.row);
    maxColumn = Math.max(maxColumn, cell.column);
  }
  const delimiter = format === "csv" ? "," : "\t";
  const rows: string[] = [];
  let byteLength = 0;
  for (let row = 1; row <= maxRow; row += 1) {
    const values: string[] = [];
    for (let column = 1; column <= maxColumn; column += 1) {
      const cell = cells.get(`${row}:${column}`);
      const value = cell ? delimitedCellText(cell, format, warnings, `${sheet.name}!${row}:${column}`) : "";
      values.push(quoteDelimited(value, delimiter));
    }
    const rendered = `${values.join(delimiter)}${row < maxRow ? "\r\n" : ""}`;
    byteLength += Buffer.byteLength(rendered, "utf8");
    if (byteLength > maxOutputBytes) {
      const error = new Error("Delimited spreadsheet output exceeds the declared byte limit.");
      error.name = "OutputTooLargeError";
      throw error;
    }
    rows.push(rendered);
  }
  return Buffer.from(rows.join(""), "utf8");
}

export interface RenderedSpreadsheetDocument {
  content: Buffer;
  warnings: StructuredDocumentWarning[];
}

/**
 * Render the frozen TableDocumentSpec without publishing it. Permission,
 * checkpoint, artifact, and undo handling remain the responsibility of the
 * calling runtime tool. No formula engine, Office process, or external
 * converter is invoked.
 */
export async function renderSpreadsheetDocument(
  document: TableDocumentSpec,
  format: TableFormat,
  maxOutputBytes = PHASE20_LIMITS.spreadsheet.maxOutputBytes,
): Promise<RenderedSpreadsheetDocument> {
  validateSpreadsheetDocument(document, format);
  const warnings: StructuredDocumentWarning[] = [];
  const content = format === "xlsx"
    ? await generateXlsx(document, warnings)
    : generateDelimited(document, format, warnings, maxOutputBytes);
  if (content.byteLength > maxOutputBytes) {
    const error = new Error(`Spreadsheet output exceeds the ${maxOutputBytes}-byte limit.`);
    error.name = "OutputTooLargeError";
    throw error;
  }
  return { content, warnings };
}

function writeFailureResult(
  code: WriteFailureCode | "spreadsheet_write_failed",
  message: string,
  format: TableFormat,
  context: RuntimeToolExecutionContext,
  dependency?: string,
): ToolResult {
  const timestamp = context.moduleContext.clock.now();
  const error: ToolStructuredError = {
    type: dependency ? "missing_dependency" : "command_failed",
    message,
    retryable: false,
    toolName: "write_spreadsheet",
    dependency,
  };
  const body = { kind: "spreadsheet_write_error", format, code, error };
  return {
    toolName: "write_spreadsheet",
    callId: context.callId,
    startedAt: timestamp,
    endedAt: timestamp,
    success: false,
    output: JSON.stringify(body),
    structuredContent: body,
    error: message,
  };
}

function outputArtifact(input: {
  relativePath: string;
  absolutePath: string;
  format: TableFormat;
  content: Buffer;
  context: RuntimeToolExecutionContext;
}): ToolOutputArtifact {
  return {
    uri: `file://${input.relativePath}`,
    fileName: path.basename(input.absolutePath),
    mimeType: MIME_TYPES[input.format],
    sizeBytes: input.content.byteLength,
    sha256: createHash("sha256").update(input.content).digest("hex"),
    kind: input.format === "xlsx" ? "document" : "text",
    sourceToolName: "write_spreadsheet",
    summary: `Generated a bounded ${input.format.toUpperCase()} spreadsheet without Office automation.`,
    createdAt: input.context.moduleContext.clock.now(),
    workspaceRelativePath: input.relativePath,
  };
}

export async function executeWriteSpreadsheet(
  args: WriteSpreadsheetArgs,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  const format = inferOutputFormat(args);
  validateSpreadsheetDocument(args.document, format);
  const absolutePath = context.moduleContext.paths.resolveWorkspace(args.outputPath);
  try {
    const existing = await fs.stat(absolutePath);
    if (!existing.isFile()) {
      throw new ToolArgumentError("write_spreadsheet outputPath must identify a regular file.", {
        fieldPath: "/outputPath",
      });
    }
    if (!args.overwrite) {
      throw new ToolArgumentError("Output already exists; set overwrite=true to replace it.", {
        fieldPath: "/overwrite",
      });
    }
  } catch (error) {
    if (error instanceof ToolArgumentError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (!context.checkpoint) {
    return writeFailureResult(
      "spreadsheet_write_failed",
      "The runtime did not create the required pre-write checkpoint.",
      format,
      context,
    );
  }

  let content: Buffer;
  let warnings: StructuredDocumentWarning[];
  try {
    ({ content, warnings } = await renderSpreadsheetDocument(
      args.document,
      format,
      PHASE20_LIMITS.spreadsheet.maxOutputBytes,
    ));
  } catch (error) {
    if (error instanceof ToolArgumentError) throw error;
    if ((error as Error).name === "XlsxDependencyError") {
      return writeFailureResult("xlsx_dependency_unavailable", (error as Error).message, format, context, "exceljs");
    }
    if ((error as Error).name === "OutputTooLargeError") {
      return writeFailureResult("output_too_large", (error as Error).message, format, context);
    }
    return writeFailureResult("xlsx_generation_failed", (error as Error).message, format, context);
  }
  if (content.byteLength > PHASE20_LIMITS.spreadsheet.maxOutputBytes) {
    return writeFailureResult(
      "output_too_large",
      `Spreadsheet output exceeds the ${PHASE20_LIMITS.spreadsheet.maxOutputBytes / 1024 / 1024} MiB limit.`,
      format,
      context,
    );
  }

  try {
    await publishSpreadsheetBufferAtomic(absolutePath, content, Boolean(args.overwrite), context.signal);
  } catch (error) {
    if (error instanceof ToolArgumentError) throw error;
    return writeFailureResult(
      "spreadsheet_write_failed",
      `Spreadsheet output could not be published safely: ${(error as Error).message}`,
      format,
      context,
    );
  }
  const relativePath = normalizeRelativePath(path.relative(context.workspaceRoot, absolutePath));
  const artifact = outputArtifact({ relativePath, absolutePath, format, content, context });
  const structured: StructuredDocumentWriteResult = {
    format,
    outputPath: relativePath,
    sizeBytes: content.byteLength,
    artifact,
    warnings,
    checkpointId: context.checkpoint.checkpointId,
    undoAvailable: true,
  };
  const timestamp = context.moduleContext.clock.now();
  return {
    toolName: "write_spreadsheet",
    callId: context.callId,
    startedAt: timestamp,
    endedAt: timestamp,
    success: true,
    output: JSON.stringify(structured),
    structuredContent: structured,
    artifacts: [artifact],
  };
}

export const writeSpreadsheetTool: RuntimeToolSpec = {
  name: "write_spreadsheet",
  displayName: "Write Spreadsheet",
  description: "Create bounded XLSX, CSV, or TSV output with explicit formulas, CSV injection protection, checkpoint, artifact, and undo controls.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["outputPath", "document"],
    properties: {
      outputPath: pathPropertySchema,
      format: { type: "string", enum: ["xlsx", "csv", "tsv"] },
      overwrite: { type: "boolean" },
      document: tableDocumentSpecSchema,
    },
  },
  readOnly: false,
  permissionCategory: "write_file",
  sideEffectLevel: "high",
  timeoutCategory: "slow",
  groups: ["documents", "structured-data", "spreadsheet", "spreadsheet-write"],
  selection: {
    groups: ["documents", "structured-data", "spreadsheet", "spreadsheet-write"],
    keywords: [
      "write spreadsheet", "create xlsx", "write csv", "write tsv", "export workbook",
      "写入表格", "创建电子表格", "生成xlsx", "生成csv", "生成tsv", "导出工作簿",
    ],
    keywordGroups: [
      ["write", "spreadsheet"], ["create", "xlsx"], ["write", "csv"], ["write", "tsv"],
      ["生成", "表格"], ["创建", "xlsx"], ["生成", "csv"], ["生成", "tsv"],
    ],
  },
  checkpoint: {
    mode: "before_write",
    scope: "pre_tool_write",
    reason: "Before generating or replacing a spreadsheet.",
  },
  getAvailability: writeSpreadsheetAvailability,
  resolveAccess: (rawArgs) => [{
    kind: "filesystem_write",
    paths: [(rawArgs as WriteSpreadsheetArgs).outputPath],
    reason: "Write the generated spreadsheet inside the writable workspace sandbox.",
  }],
  execute: (rawArgs, context) => executeWriteSpreadsheet(rawArgs as WriteSpreadsheetArgs, context),
};
