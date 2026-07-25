import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  StructuredDocumentMetadata,
  StructuredDocumentWarning,
  StructuredJsonValue,
  StructuredSourceReference,
  TableCellSpec,
  TableReadResult,
  ToolAvailability,
  ToolOutputArtifact,
  ToolResult,
  ToolStructuredError,
} from "../../../../shared-schema/src/index.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolModule,
  ToolModuleContext,
} from "../../tool-module.js";

import { cursorPropertySchema, parseNonNegativeCursor, pathPropertySchema, structuredWarning } from "./contracts.js";
import { PHASE20_LIMITS } from "./format-policy.js";
import {
  SpreadsheetParseError,
  analyzeMergedRanges,
  decodeUtf8Spreadsheet,
  delimitedRowsToSheet,
  isFormulaLikeText,
  normalizeSpreadsheetRange,
  paginateSpreadsheet,
  parseDelimitedText,
  tableScalar,
  type ParsedSpreadsheetSheet,
  type SpreadsheetFormat,
  type SpreadsheetRange,
} from "./spreadsheet-parser.js";
import { writeSpreadsheetTool } from "./spreadsheet-writer.js";

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const FORMAT_MIME_TYPES: Record<SpreadsheetFormat, string> = {
  xlsx: XLSX_MIME_TYPE,
  csv: "text/csv",
  tsv: "text/tab-separated-values",
};
const ZIP_MAGIC_PREFIXES = ["504b0304", "504b0506", "504b0708"];
const OLE_MAGIC = "d0cf11e0a1b11ae1";
const MAX_SPREADSHEET_WARNINGS = 200;

export interface ReadSpreadsheetArgs {
  path: string;
  format?: SpreadsheetFormat;
  /** Exact sheet name or a one-based sheet index. CSV and TSV expose only Sheet1. */
  sheet?: string | number;
  range?: SpreadsheetRange;
  /** Non-negative decimal offset in sheet/row/column order. */
  cursor?: string;
  maxCells?: number;
}

type SpreadsheetFailureCode =
  | "unsupported_format"
  | "format_mismatch"
  | "spreadsheet_too_large"
  | "xlsx_dependency_unavailable"
  | "xlsx_invalid_or_damaged"
  | "text_invalid_encoding"
  | "text_invalid_or_damaged"
  | "cell_too_large"
  | "sheet_not_found"
  | "range_invalid";

interface SpreadsheetFailure {
  code: SpreadsheetFailureCode;
  message: string;
  dependency?: string;
}

interface ZipEntryLike {
  dir: boolean;
  _data?: {
    compressedSize?: number;
    uncompressedSize?: number;
  };
  async(type: "string"): Promise<string>;
}

interface ZipArchiveLike {
  files: Record<string, ZipEntryLike>;
  file(name: string): ZipEntryLike | null;
}

interface JsZipApi {
  loadAsync(data: Buffer, options: { checkCRC32: boolean; createFolders?: boolean }): Promise<ZipArchiveLike>;
}

interface ExcelCellLike {
  row: number;
  col: number;
  address: string;
  type: number;
  value: unknown;
  text: string;
}

interface ExcelRowLike {
  eachCell(options: { includeEmpty: boolean }, callback: (cell: ExcelCellLike, column: number) => void): void;
}

interface ExcelColumnLike {
  width?: number;
  hidden?: boolean;
}

interface ExcelWorksheetLike {
  name: string;
  state: "visible" | "hidden" | "veryHidden";
  rowCount: number;
  actualRowCount: number;
  columnCount: number;
  actualColumnCount: number;
  model: { merges?: string[] };
  views?: Array<{ state?: string; ySplit?: number }> | null;
  eachRow(options: { includeEmpty: boolean }, callback: (row: ExcelRowLike, rowNumber: number) => void): void;
  getColumn(column: number): ExcelColumnLike;
}

interface ExcelWorkbookLike {
  worksheets: ExcelWorksheetLike[];
  views?: Array<{ activeTab?: number }>;
  title?: string;
  subject?: string;
  creator?: string;
  keywords?: string;
  created?: Date;
  modified?: Date;
  company?: string;
  xlsx: { load(buffer: Buffer): Promise<unknown> };
}

interface ExcelJsApi {
  Workbook: new () => ExcelWorkbookLike;
  ValueType?: { Merge?: number };
}

interface XlsxDependencies {
  excel: ExcelJsApi;
  zip: JsZipApi;
}

export interface ParsedSpreadsheetDocument {
  format: SpreadsheetFormat;
  metadata: StructuredDocumentMetadata;
  warnings: StructuredDocumentWarning[];
  totalSheets: number;
  activeSheet?: string;
  sheets: ParsedSpreadsheetSheet[];
}

function pushWarningOnce(
  warnings: StructuredDocumentWarning[],
  warning: StructuredDocumentWarning,
): void {
  if (warnings.length >= MAX_SPREADSHEET_WARNINGS) return;
  if (!warnings.some((entry) => entry.code === warning.code)) warnings.push(warning);
}

function moduleDefault<T>(module: unknown): T {
  return ((module as { default?: T }).default ?? module) as T;
}

async function loadXlsxDependencies(): Promise<XlsxDependencies> {
  const [excelModule, zipModule] = await Promise.all([import("exceljs"), import("jszip")]);
  const dependencies = {
    excel: moduleDefault<ExcelJsApi>(excelModule),
    zip: moduleDefault<JsZipApi>(zipModule),
  };
  if (typeof dependencies.excel.Workbook !== "function") throw new Error("ExcelJS Workbook API is unavailable.");
  if (typeof dependencies.zip.loadAsync !== "function") throw new Error("JSZip loadAsync API is unavailable.");
  return dependencies;
}

export async function spreadsheetAvailability(_context: ToolModuleContext): Promise<ToolAvailability> {
  try {
    await loadXlsxDependencies();
    return { status: "available", available: true };
  } catch (error) {
    return {
      status: "degraded",
      available: true,
      missingCapabilities: ["xlsx_reader_api"],
      fallbackCapabilities: ["csv", "tsv"],
      reason: `XLSX reading is unavailable because its validated ExcelJS/JSZip APIs could not load; CSV and TSV remain available: ${(error as Error).message}`,
    };
  }
}

function inferFormat(args: ReadSpreadsheetArgs, absolutePath: string): SpreadsheetFormat | SpreadsheetFailure {
  const extension = path.extname(absolutePath).toLowerCase();
  const extensionFormat = extension === ".xlsx"
    ? "xlsx"
    : extension === ".csv"
      ? "csv"
      : extension === ".tsv"
        ? "tsv"
        : undefined;
  if (args.format && extensionFormat && args.format !== extensionFormat) {
    return {
      code: "format_mismatch",
      message: `Requested ${args.format.toUpperCase()} does not match the ${extension} filename extension.`,
    };
  }
  const format = args.format ?? extensionFormat;
  if (!format) {
    return {
      code: "unsupported_format",
      message: "Spreadsheet format must be XLSX, CSV, or TSV and must be explicit for an unknown filename extension.",
    };
  }
  return format;
}

function hasZipMagic(buffer: Buffer): boolean {
  return ZIP_MAGIC_PREFIXES.includes(buffer.subarray(0, 4).toString("hex"));
}

export function validateSpreadsheetFormatMagic(
  format: SpreadsheetFormat,
  buffer: Buffer,
): { code: "format_mismatch"; message: string } | undefined {
  if (format === "xlsx" && !hasZipMagic(buffer)) {
    return {
      code: "format_mismatch",
      message: "The XLSX input does not have an OOXML ZIP signature; the extension or explicit format is spoofed.",
    };
  }
  if (format !== "xlsx" && (hasZipMagic(buffer) || buffer.subarray(0, 8).toString("hex") === OLE_MAGIC)) {
    return {
      code: "format_mismatch",
      message: `The ${format.toUpperCase()} input has a binary archive or legacy Office signature instead of delimited text.`,
    };
  }
  return undefined;
}

function normalizeSheetState(state: ExcelWorksheetLike["state"]): ParsedSpreadsheetSheet["state"] {
  return state === "veryHidden" ? "very_hidden" : state;
}

function formulaValue(value: unknown): {
  expression: string;
  result?: unknown;
} | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { formula?: unknown; sharedFormula?: unknown; result?: unknown };
  const expression = typeof candidate.formula === "string"
    ? candidate.formula
    : typeof candidate.sharedFormula === "string"
      ? candidate.sharedFormula
      : undefined;
  return expression ? { expression, result: candidate.result } : undefined;
}

function richOrHyperlinkText(value: unknown): { text: string; hyperlink?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as {
    text?: unknown;
    hyperlink?: unknown;
    richText?: Array<{ text?: unknown }>;
  };
  if (typeof candidate.text === "string" && typeof candidate.hyperlink === "string") {
    return { text: candidate.text, hyperlink: candidate.hyperlink };
  }
  if (Array.isArray(candidate.richText)) {
    return {
      text: candidate.richText.map((entry) => typeof entry.text === "string" ? entry.text : "").join(""),
    };
  }
  return undefined;
}

/** Pure ExcelJS-value normalization; it intentionally never invokes or emulates a formula engine. */
export function excelCellToTableCell(
  cell: ExcelCellLike,
  warnings: StructuredDocumentWarning[],
): TableCellSpec | undefined {
  const formula = formulaValue(cell.value);
  if (formula) {
    if (formula.expression.length > PHASE20_LIMITS.spreadsheet.maxCellChars) {
      throw new SpreadsheetParseError("cell_too_large", "Formula expression exceeds the declared cell character limit.");
    }
    pushWarningOnce(warnings, structuredWarning("formula_not_calculated", {
      category: "compatibility",
      scope: cell.address,
    }));
    const hasCachedValue = formula.result !== undefined;
    if (!hasCachedValue) {
      pushWarningOnce(warnings, structuredWarning("formula_cache_missing", {
        category: "compatibility",
        scope: cell.address,
      }));
    }
    const cached = hasCachedValue ? tableScalar(formula.result) : undefined;
    return {
      row: cell.row,
      column: cell.col,
      address: cell.address,
      type: "formula",
      displayValue: cell.text || undefined,
      formula: {
        expression: formula.expression.replace(/^=/u, ""),
        cachedValue: cached?.value,
        cachedType: cached?.type,
        calculationState: hasCachedValue ? "cached" : "missing",
      },
    };
  }
  const rich = richOrHyperlinkText(cell.value);
  if (rich) {
    if (rich.text.length > PHASE20_LIMITS.spreadsheet.maxCellChars) {
      throw new SpreadsheetParseError("cell_too_large", "Rich or hyperlink cell text exceeds the declared character limit.");
    }
    if (rich.hyperlink && /^(?:https?|ftp|file):/iu.test(rich.hyperlink)) {
      pushWarningOnce(warnings, structuredWarning("external_link_present", {
        category: "security",
        scope: cell.address,
        details: { kind: "hyperlink" },
      }));
    }
    return {
      row: cell.row,
      column: cell.col,
      address: cell.address,
      type: "string",
      value: rich.text,
      displayValue: cell.text && cell.text !== rich.text ? cell.text : undefined,
    };
  }
  const scalar = tableScalar(cell.value);
  if (scalar.type === "blank") return undefined;
  return {
    row: cell.row,
    column: cell.col,
    address: cell.address,
    type: scalar.type,
    value: scalar.value,
    displayValue: cell.text && cell.text !== String(scalar.value ?? "") ? cell.text : undefined,
  };
}

function xlsxEntrySizes(name: string, entry: ZipEntryLike): { compressed: number; uncompressed: number } {
  const compressed = entry._data?.compressedSize;
  const uncompressed = entry._data?.uncompressedSize;
  if (entry.dir && compressed === undefined && uncompressed === undefined) {
    return { compressed: 0, uncompressed: 0 };
  }
  if (!Number.isSafeInteger(compressed) || !Number.isSafeInteger(uncompressed)
    || (compressed ?? -1) < 0 || (uncompressed ?? -1) < 0) {
    throw new SpreadsheetParseError(
      "text_invalid_or_damaged",
      `XLSX entry '${name}' is missing safe central-directory size metadata.`,
    );
  }
  return { compressed: compressed!, uncompressed: uncompressed! };
}

function preflightXlsxPackage(archive: ZipArchiveLike): void {
  const entries = Object.entries(archive.files);
  if (entries.length > PHASE20_LIMITS.spreadsheet.maxPackageEntries) {
    throw new SpreadsheetParseError(
      "text_invalid_or_damaged",
      `XLSX package exceeds the ${PHASE20_LIMITS.spreadsheet.maxPackageEntries}-entry limit.`,
    );
  }
  let totalExpandedBytes = 0;
  for (const [name, entry] of entries) {
    const { compressed, uncompressed } = xlsxEntrySizes(name, entry);
    if (uncompressed > PHASE20_LIMITS.spreadsheet.maxPackageEntryBytes) {
      throw new SpreadsheetParseError(
        "text_invalid_or_damaged",
        `XLSX entry '${name}' exceeds the ${PHASE20_LIMITS.spreadsheet.maxPackageEntryBytes}-byte expanded-entry limit.`,
      );
    }
    totalExpandedBytes += uncompressed;
    if (!Number.isSafeInteger(totalExpandedBytes)
      || totalExpandedBytes > PHASE20_LIMITS.spreadsheet.maxPackageExpandedBytes) {
      throw new SpreadsheetParseError(
        "text_invalid_or_damaged",
        `XLSX package exceeds the ${PHASE20_LIMITS.spreadsheet.maxPackageExpandedBytes}-byte total expanded limit.`,
      );
    }
    const ratio = uncompressed === 0 ? 0 : compressed === 0 ? Number.POSITIVE_INFINITY : uncompressed / compressed;
    if (ratio > PHASE20_LIMITS.spreadsheet.maxPackageCompressionRatio) {
      throw new SpreadsheetParseError(
        "text_invalid_or_damaged",
        `XLSX entry '${name}' exceeds the ${PHASE20_LIMITS.spreadsheet.maxPackageCompressionRatio}:1 compression-ratio limit.`,
      );
    }
  }
}

function assertInspectableXmlPart(name: string, entry: ZipEntryLike): void {
  const { uncompressed } = xlsxEntrySizes(name, entry);
  if (uncompressed > PHASE20_LIMITS.spreadsheet.maxInspectedXmlBytes) {
    throw new SpreadsheetParseError(
      "text_invalid_or_damaged",
      `XLSX metadata part '${name}' exceeds the ${PHASE20_LIMITS.spreadsheet.maxInspectedXmlBytes}-byte inspection limit.`,
    );
  }
}

async function inspectXlsxPackage(
  buffer: Buffer,
  zip: JsZipApi,
  warnings: StructuredDocumentWarning[],
): Promise<void> {
  let archive: ZipArchiveLike;
  try {
    // CRC checking in JSZip expands every entry during load and would defeat
    // the central-directory bomb preflight. ExcelJS validates the selected
    // OOXML payload after these strict expansion ceilings pass.
    archive = await zip.loadAsync(buffer, { checkCRC32: false, createFolders: false });
  } catch (error) {
    throw new SpreadsheetParseError(
      "text_invalid_or_damaged",
      `The XLSX ZIP package is damaged or failed CRC validation: ${(error as Error).message}`,
    );
  }
  preflightXlsxPackage(archive);
  const names = Object.keys(archive.files);
  const contentTypesEntry = archive.file("[Content_Types].xml");
  const workbookEntry = archive.file("xl/workbook.xml");
  if (!contentTypesEntry || !workbookEntry) {
    throw new SpreadsheetParseError(
      "text_invalid_or_damaged",
      "Required XLSX OOXML parts [Content_Types].xml or xl/workbook.xml are missing.",
    );
  }
  assertInspectableXmlPart("[Content_Types].xml", contentTypesEntry);
  assertInspectableXmlPart("xl/workbook.xml", workbookEntry);
  const contentTypes = await contentTypesEntry.async("string");
  if (!/spreadsheetml\.(?:sheet|template)\.main\+xml/iu.test(contentTypes)) {
    throw new SpreadsheetParseError(
      "text_invalid_or_damaged",
      "The OOXML package is not a spreadsheet workbook and appears to be format-spoofed.",
    );
  }
  if (
    names.some((name) => /(?:^|\/)vbaProject\.bin$/iu.test(name))
    || /macroEnabled\.main\+xml/iu.test(contentTypes)
  ) {
    pushWarningOnce(warnings, structuredWarning("macro_present", {
      severity: "high",
      category: "security",
      details: { executed: false },
    }));
  }
  const hasExternalParts = names.some((name) => /^xl\/(?:externalLinks\/|connections\.xml$)/iu.test(name));
  let hasExternalRelationship = false;
  for (const name of names.filter((entry) => /^xl\/.*\.rels$/iu.test(entry)).slice(0, 512)) {
    const relationshipEntry = archive.file(name);
    if (relationshipEntry) assertInspectableXmlPart(name, relationshipEntry);
    const relationshipXml = await relationshipEntry?.async("string");
    if (relationshipXml && /TargetMode\s*=\s*["']External["']/iu.test(relationshipXml)) {
      hasExternalRelationship = true;
      break;
    }
  }
  if (hasExternalParts || hasExternalRelationship) {
    pushWarningOnce(warnings, structuredWarning("external_link_present", {
      severity: "high",
      category: "security",
      details: { followed: false, refreshed: false },
    }));
  }
}

function selectWorksheets(
  worksheets: readonly ExcelWorksheetLike[],
  selector: ReadSpreadsheetArgs["sheet"],
): ExcelWorksheetLike[] {
  if (selector === undefined) return [...worksheets];
  const selected = typeof selector === "number"
    ? worksheets[selector - 1]
    : worksheets.find((worksheet) => worksheet.name === selector);
  return selected ? [selected] : [];
}

async function parseXlsx(
  buffer: Buffer,
  args: ReadSpreadsheetArgs,
): Promise<ParsedSpreadsheetDocument> {
  let dependencies: XlsxDependencies;
  try {
    dependencies = await loadXlsxDependencies();
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND"
      ? (error as Error).message
      : String((error as Error).message);
    const dependencyError = new Error(`XLSX dependencies are unavailable: ${missing}`);
    dependencyError.name = "XlsxDependencyError";
    throw dependencyError;
  }
  const warnings: StructuredDocumentWarning[] = [];
  await inspectXlsxPackage(buffer, dependencies.zip, warnings);
  const workbook = new dependencies.excel.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (error) {
    throw new SpreadsheetParseError(
      "text_invalid_or_damaged",
      `ExcelJS could not read the damaged or unsupported XLSX package: ${(error as Error).message}`,
    );
  }
  if (workbook.worksheets.length > PHASE20_LIMITS.spreadsheet.maxSheets) {
    throw new SpreadsheetParseError(
      "range_invalid",
      `Workbook has ${workbook.worksheets.length} sheets, exceeding the ${PHASE20_LIMITS.spreadsheet.maxSheets}-sheet limit.`,
    );
  }

  for (const worksheet of workbook.worksheets) {
    if (
      Math.max(worksheet.actualRowCount, worksheet.rowCount) > PHASE20_LIMITS.spreadsheet.maxRowsPerSheet
      || Math.max(worksheet.actualColumnCount, worksheet.columnCount) > PHASE20_LIMITS.spreadsheet.maxColumnsPerSheet
    ) {
      throw new SpreadsheetParseError(
        "range_invalid",
        `Sheet ${worksheet.name} exceeds the ${PHASE20_LIMITS.spreadsheet.maxRowsPerSheet}-row or ${PHASE20_LIMITS.spreadsheet.maxColumnsPerSheet}-column safety limit.`,
      );
    }
    if (worksheet.state !== "visible") {
      pushWarningOnce(warnings, structuredWarning("hidden_sheet_present", {
        severity: worksheet.state === "veryHidden" ? "high" : "warning",
        category: "security",
        scope: worksheet.name,
        details: { state: normalizeSheetState(worksheet.state) },
      }));
    }
    const mergeAnalysis = analyzeMergedRanges(worksheet.model.merges ?? []);
    if (mergeAnalysis.abnormal) {
      pushWarningOnce(warnings, structuredWarning("abnormal_merge", {
        category: "compatibility",
        scope: worksheet.name,
        details: { reasons: mergeAnalysis.reasons },
      }));
    }
  }

  const selected = selectWorksheets(workbook.worksheets, args.sheet);
  if (selected.length === 0) {
    const error = new SpreadsheetParseError("range_invalid", `Requested sheet ${String(args.sheet)} was not found.`);
    error.name = "SheetNotFoundError";
    throw error;
  }
  const normalizedRange = normalizeSpreadsheetRange(args.range);
  let totalMaterializedCells = 0;
  const sheets = selected.map((worksheet): ParsedSpreadsheetSheet => {
    const cells: TableCellSpec[] = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber < normalizedRange.startRow || rowNumber > normalizedRange.endRow) return;
      row.eachCell({ includeEmpty: false }, (cell, column) => {
        if (column < normalizedRange.startColumn || column > normalizedRange.endColumn) return;
        if (dependencies.excel.ValueType?.Merge !== undefined && cell.type === dependencies.excel.ValueType.Merge) return;
        const normalized = excelCellToTableCell(cell, warnings);
        if (normalized) {
          totalMaterializedCells += 1;
          if (totalMaterializedCells > PHASE20_LIMITS.spreadsheet.maxWorkbookCells) {
            throw new SpreadsheetParseError(
              "range_invalid",
              `Workbook exceeds the ${PHASE20_LIMITS.spreadsheet.maxWorkbookCells}-cell materialization limit.`,
            );
          }
          cells.push(normalized);
        }
      });
    });
    const mergeAnalysis = analyzeMergedRanges(worksheet.model.merges ?? []);
    const columnLimit = Math.min(
      worksheet.columnCount,
      PHASE20_LIMITS.spreadsheet.maxColumnsPerSheet,
    );
    const columns: ParsedSpreadsheetSheet["columns"] = [];
    for (let column = 1; column <= columnLimit; column += 1) {
      const source = worksheet.getColumn(column);
      if (source.width !== undefined || source.hidden) {
        columns.push({ column, width: source.width, hidden: source.hidden || undefined });
      }
    }
    return {
      name: worksheet.name,
      state: normalizeSheetState(worksheet.state),
      rowCount: worksheet.actualRowCount || worksheet.rowCount,
      columnCount: worksheet.actualColumnCount || worksheet.columnCount,
      cells,
      mergedRanges: mergeAnalysis.returnedRanges,
      columns,
      freezeHeaderRow: (worksheet.views ?? []).some((view) => view.state === "frozen" && (view.ySplit ?? 0) >= 1),
    };
  });
  const keywords = typeof workbook.keywords === "string"
    ? workbook.keywords.split(/[,;]+/gu).map((entry) => entry.trim()).filter(Boolean).slice(0, 100)
    : undefined;
  return {
    format: "xlsx",
    metadata: {
      title: workbook.title || undefined,
      author: workbook.creator || undefined,
      subject: workbook.subject || undefined,
      keywords: keywords?.length ? keywords : undefined,
      createdAt: workbook.created instanceof Date && !Number.isNaN(workbook.created.getTime())
        ? workbook.created.toISOString()
        : undefined,
      modifiedAt: workbook.modified instanceof Date && !Number.isNaN(workbook.modified.getTime())
        ? workbook.modified.toISOString()
        : undefined,
      creatorApplication: "ExcelJS OOXML reader",
      properties: workbook.company ? { company: workbook.company } : undefined,
    },
    warnings,
    totalSheets: workbook.worksheets.length,
    activeSheet: workbook.worksheets[workbook.views?.[0]?.activeTab ?? 0]?.name,
    sheets,
  };
}

function parseDelimited(
  buffer: Buffer,
  format: "csv" | "tsv",
  args: ReadSpreadsheetArgs,
): ParsedSpreadsheetDocument {
  if (args.sheet !== undefined && args.sheet !== 1 && args.sheet !== "Sheet1") {
    const error = new SpreadsheetParseError("range_invalid", `Delimited ${format.toUpperCase()} input exposes only Sheet1.`);
    error.name = "SheetNotFoundError";
    throw error;
  }
  const warnings: StructuredDocumentWarning[] = [];
  const text = decodeUtf8Spreadsheet(buffer);
  const rows = parseDelimitedText(text, format === "csv" ? "," : "\t");
  const sheet = delimitedRowsToSheet(rows, warnings);
  return {
    format,
    metadata: { creatorApplication: "Deep-Mix bounded delimited-text reader" },
    warnings,
    totalSheets: 1,
    activeSheet: "Sheet1",
    sheets: [sheet],
  };
}

/**
 * Parse one complete bounded spreadsheet into the frozen TableDocumentSpec
 * intermediate representation. This helper performs no permission checks,
 * writes, formula calculation, Office automation, or output pagination; it is
 * exported only so the allowlisted converter can reuse the exact reader path.
 */
export async function parseSpreadsheetDocument(
  buffer: Buffer,
  format: SpreadsheetFormat,
): Promise<ParsedSpreadsheetDocument> {
  const magicFailure = validateSpreadsheetFormatMagic(format, buffer);
  if (magicFailure) {
    const error = new SpreadsheetParseError("text_invalid_or_damaged", magicFailure.message);
    error.name = "SpreadsheetFormatMismatchError";
    throw error;
  }
  return format === "xlsx"
    ? parseXlsx(buffer, { path: "<conversion-input>", format })
    : parseDelimited(buffer, format, { path: "<conversion-input>", format });
}

function sourceReference(
  argsPath: string,
  resolved: { workspaceRelativePath?: string; artifactRef?: string },
  sizeBytes: number,
  mimeType: string,
): StructuredSourceReference {
  if (resolved.artifactRef) {
    return {
      kind: "artifact",
      reference: resolved.artifactRef,
      artifactUri: resolved.artifactRef,
      mimeType,
      sizeBytes,
    };
  }
  const reference = resolved.workspaceRelativePath ?? argsPath;
  return {
    kind: "workspace_path",
    reference,
    workspaceRelativePath: resolved.workspaceRelativePath,
    mimeType,
    sizeBytes,
  };
}

function sourceRecoveryArtifact(input: {
  argsPath: string;
  absolutePath: string;
  workspaceRelativePath?: string;
  artifactRef?: string;
  format: SpreadsheetFormat;
  sizeBytes: number;
  context: RuntimeToolExecutionContext;
}): ToolOutputArtifact | undefined {
  const uri = input.artifactRef?.startsWith("artifact://")
    ? input.artifactRef
    : input.workspaceRelativePath
      ? `file://${input.workspaceRelativePath}`
      : input.argsPath.startsWith("file://")
        ? input.argsPath
        : undefined;
  if (!uri) return undefined;
  return {
    uri,
    fileName: path.basename(input.absolutePath),
    mimeType: FORMAT_MIME_TYPES[input.format],
    sizeBytes: input.sizeBytes,
    kind: input.format === "xlsx" ? "document" : "text",
    sourceToolName: "read_spreadsheet",
    summary: "Original whole spreadsheet retained only as a recovery/reference artifact for paginated output.",
    createdAt: input.context.moduleContext.clock.now(),
    workspaceRelativePath: input.workspaceRelativePath,
  };
}

function failureResult(
  failure: SpreadsheetFailure,
  format: SpreadsheetFormat | "unknown",
  context: RuntimeToolExecutionContext,
): ToolResult {
  const timestamp = context.moduleContext.clock.now();
  const error: ToolStructuredError = {
    type: failure.dependency ? "missing_dependency" : "command_failed",
    message: failure.message,
    retryable: false,
    toolName: "read_spreadsheet",
    dependency: failure.dependency,
  };
  const body = { kind: "spreadsheet_error", format, code: failure.code, error };
  return {
    toolName: "read_spreadsheet",
    callId: context.callId,
    startedAt: timestamp,
    endedAt: timestamp,
    success: false,
    output: JSON.stringify(body),
    structuredContent: body,
    error: failure.message,
  };
}

function selectionProperties(
  args: ReadSpreadsheetArgs,
  sheetNames: string[],
  cursor: number,
  maxCells: number,
): Record<string, StructuredJsonValue> {
  const range = normalizeSpreadsheetRange(args.range);
  const selection: Record<string, StructuredJsonValue> = {
    sheets: sheetNames,
    range: {
      startRow: range.startRow,
      endRow: range.endRow,
      startColumn: range.startColumn,
      endColumn: range.endColumn,
    },
    cursor: String(cursor),
    maxCells,
    order: "sheet_row_column",
  };
  if (args.sheet !== undefined) selection.requestedSheet = args.sheet;
  return selection;
}

function spreadsheetFailureFromError(error: unknown, format: SpreadsheetFormat): SpreadsheetFailure {
  if ((error as Error).name === "XlsxDependencyError") {
    return {
      code: "xlsx_dependency_unavailable",
      message: (error as Error).message,
      dependency: "exceljs/jszip",
    };
  }
  if ((error as Error).name === "SheetNotFoundError") {
    return { code: "sheet_not_found", message: (error as Error).message };
  }
  if (error instanceof SpreadsheetParseError) {
    if (error.code === "text_invalid_or_damaged") {
      return { code: format === "xlsx" ? "xlsx_invalid_or_damaged" : "text_invalid_or_damaged", message: error.message };
    }
    return { code: error.code, message: error.message };
  }
  return {
    code: "xlsx_invalid_or_damaged",
    message: `Spreadsheet input is damaged or unsupported: ${(error as Error).message}`,
  };
}

export async function executeReadSpreadsheet(
  args: ReadSpreadsheetArgs,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  const resolved = await context.moduleContext.paths.resolveReadable(args.path);
  const stat = await fs.stat(resolved.absolutePath);
  if (!stat.isFile()) {
    return failureResult(
      { code: "format_mismatch", message: "Spreadsheet input must resolve to a file." },
      "unknown",
      context,
    );
  }
  const inferred = inferFormat(args, resolved.absolutePath);
  if (typeof inferred !== "string") return failureResult(inferred, "unknown", context);
  if (stat.size > PHASE20_LIMITS.spreadsheet.maxInputBytes) {
    return failureResult(
      {
        code: "spreadsheet_too_large",
        message: `Spreadsheet input exceeds the ${PHASE20_LIMITS.spreadsheet.maxInputBytes / 1024 / 1024} MiB safety limit.`,
      },
      inferred,
      context,
    );
  }

  let cursor: number;
  try {
    cursor = parseNonNegativeCursor(args.cursor);
  } catch (error) {
    return failureResult({ code: "range_invalid", message: (error as Error).message }, inferred, context);
  }
  const maxCells = args.maxCells ?? PHASE20_LIMITS.spreadsheet.defaultPageCells;
  const buffer = await resolved.readBytes();
  const magicFailure = validateSpreadsheetFormatMagic(inferred, buffer);
  if (magicFailure) return failureResult(magicFailure, inferred, context);

  try {
    const parsed = inferred === "xlsx"
      ? await parseXlsx(buffer, args)
      : parseDelimited(buffer, inferred, args);
    const page = paginateSpreadsheet(parsed.sheets, {
      range: args.range,
      cursor,
      maxCells,
      maxVisibleChars: PHASE20_LIMITS.maxModelVisibleChars,
    });
    const warnings = [...parsed.warnings];
    if (page.truncated) {
      pushWarningOnce(warnings, structuredWarning("output_truncated", {
        category: "truncation",
        details: {
          reason: page.truncationReason ?? "pagination",
          nextCursor: page.nextCursor ?? String(cursor + page.returnedCells),
        },
      }));
    }
    parsed.metadata.sizeBytes = buffer.byteLength;
    parsed.metadata.properties = {
      ...(parsed.metadata.properties ?? {}),
      selection: selectionProperties(args, parsed.sheets.map((sheet) => sheet.name), cursor, maxCells),
      pagination: {
        totalCells: page.totalCells,
        returnedCells: page.returnedCells,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      },
    };
    const result: TableReadResult = {
      format: parsed.format,
      source: sourceReference(args.path, resolved, buffer.byteLength, FORMAT_MIME_TYPES[parsed.format]),
      metadata: parsed.metadata,
      warnings,
      truncation: {
        truncated: page.truncated,
        reason: page.truncated
          ? page.truncationReason === "character_limit" ? "character_limit" : "pagination"
          : undefined,
        returnedItems: page.returnedCells,
        totalItems: page.totalCells,
        nextCursor: page.nextCursor,
      },
      summary: `${parsed.format.toUpperCase()} spreadsheet: ${parsed.totalSheets} total sheet(s), ${page.totalCells} selected materialized cell(s), ${page.returnedCells} returned.`,
      totalSheets: parsed.totalSheets,
      totalCells: page.totalCells,
      returnedCells: page.returnedCells,
      sheets: page.sheets,
    };
    let output = JSON.stringify(result);
    if (output.length > PHASE20_LIMITS.maxModelVisibleChars) {
      return failureResult(
        {
          code: "cell_too_large",
          message: "Spreadsheet selection metadata and one complete page cannot fit the 2,000,000-character visible-output budget; narrow the range.",
        },
        inferred,
        context,
      );
    }
    const recoveryArtifact = page.truncated
      ? sourceRecoveryArtifact({
          argsPath: args.path,
          absolutePath: resolved.absolutePath,
          workspaceRelativePath: resolved.workspaceRelativePath,
          artifactRef: resolved.artifactRef,
          format: inferred,
          sizeBytes: buffer.byteLength,
          context,
        })
      : undefined;
    const timestamp = context.moduleContext.clock.now();
    output = JSON.stringify(result);
    return {
      toolName: "read_spreadsheet",
      callId: context.callId,
      startedAt: timestamp,
      endedAt: timestamp,
      success: true,
      output,
      structuredContent: result,
      artifacts: recoveryArtifact ? [recoveryArtifact] : [],
    };
  } catch (error) {
    return failureResult(spreadsheetFailureFromError(error, inferred), inferred, context);
  }
}

export const readSpreadsheetTool: RuntimeToolSpec = {
  name: "read_spreadsheet",
  displayName: "Read Spreadsheet",
  description: "Read bounded XLSX, CSV, or TSV cells with raw types, formula/cache separation, warnings, ranges, and cursor pagination; formulas are never calculated.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: pathPropertySchema,
      format: { type: "string", enum: ["xlsx", "csv", "tsv"] },
      sheet: {
        oneOf: [
          { type: "string", minLength: 1, maxLength: 255 },
          { type: "integer", minimum: 1, maximum: PHASE20_LIMITS.spreadsheet.maxSheets },
        ],
      },
      range: {
        type: "object",
        additionalProperties: false,
        properties: {
          startRow: { type: "integer", minimum: 1, maximum: PHASE20_LIMITS.spreadsheet.maxRowsPerSheet },
          endRow: { type: "integer", minimum: 1, maximum: PHASE20_LIMITS.spreadsheet.maxRowsPerSheet },
          startColumn: { type: "integer", minimum: 1, maximum: PHASE20_LIMITS.spreadsheet.maxColumnsPerSheet },
          endColumn: { type: "integer", minimum: 1, maximum: PHASE20_LIMITS.spreadsheet.maxColumnsPerSheet },
        },
      },
      cursor: cursorPropertySchema,
      maxCells: {
        type: "integer",
        minimum: 1,
        maximum: PHASE20_LIMITS.spreadsheet.maxPageCells,
        default: PHASE20_LIMITS.spreadsheet.defaultPageCells,
      },
    },
  },
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "slow",
  groups: ["documents", "structured-data", "spreadsheet", "spreadsheet-read"],
  selection: {
    groups: ["documents", "structured-data", "spreadsheet", "spreadsheet-read"],
    keywords: [
      "read spreadsheet", "read xlsx", "read csv", "read tsv", "inspect workbook",
      "读取表格", "读取电子表格", "读取xlsx", "读取csv", "读取tsv", "查看工作簿",
    ],
    keywordGroups: [
      ["read", "spreadsheet"], ["read", "xlsx"], ["read", "csv"], ["read", "tsv"],
      ["读取", "表格"], ["读取", "xlsx"], ["读取", "csv"], ["读取", "tsv"],
    ],
    attachmentExtensions: [".xlsx", ".csv", ".tsv"],
    mimeTypes: [XLSX_MIME_TYPE, "text/csv", "text/tab-separated-values"],
  },
  getAvailability: spreadsheetAvailability,
  resolveAccess: (rawArgs) => {
    const args = rawArgs as ReadSpreadsheetArgs;
    return [{
      kind: "filesystem_read",
      paths: [args.path],
      reason: "Read the requested spreadsheet through the workspace or trusted-artifact path guard.",
    }];
  },
  execute: (rawArgs, context) => executeReadSpreadsheet(rawArgs as ReadSpreadsheetArgs, context),
};

export const spreadsheetsToolModule: ToolModule = {
  manifest: {
    id: "builtin.spreadsheets",
    version: "1.1.0",
    description: "Bounded spreadsheet read and write tools with raw types and formula safety.",
    source: "built_in",
  },
  create: () => [readSpreadsheetTool, writeSpreadsheetTool],
};

export * from "./spreadsheet-parser.js";
export * from "./spreadsheet-writer.js";
