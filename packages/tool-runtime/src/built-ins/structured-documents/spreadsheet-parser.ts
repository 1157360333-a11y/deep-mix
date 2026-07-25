import type {
  StructuredDocumentWarning,
  TableCellScalar,
  TableCellSpec,
  TableCellType,
  TableSheetSpec,
} from "../../../../shared-schema/src/index.js";

import { structuredWarning } from "./contracts.js";
import { PHASE20_LIMITS } from "./format-policy.js";

export type SpreadsheetFormat = "xlsx" | "csv" | "tsv";

export interface SpreadsheetRange {
  startRow?: number;
  endRow?: number;
  startColumn?: number;
  endColumn?: number;
}

export interface ParsedSpreadsheetSheet {
  name: string;
  state: "visible" | "hidden" | "very_hidden";
  rowCount: number;
  columnCount: number;
  cells: TableCellSpec[];
  mergedRanges: string[];
  columns: NonNullable<TableSheetSpec["columns"]>;
  freezeHeaderRow: boolean;
}

export interface SpreadsheetPage {
  sheets: TableSheetSpec[];
  totalCells: number;
  returnedCells: number;
  nextCursor?: string;
  truncated: boolean;
  truncationReason?: "pagination" | "character_limit";
}

export class SpreadsheetParseError extends Error {
  public constructor(
    public readonly code:
      | "text_invalid_encoding"
      | "text_invalid_or_damaged"
      | "cell_too_large"
      | "range_invalid",
    message: string,
  ) {
    super(message);
    this.name = "SpreadsheetParseError";
  }
}

function boundedCellString(value: string, label: string): string {
  if (value.length > PHASE20_LIMITS.spreadsheet.maxCellChars) {
    throw new SpreadsheetParseError(
      "cell_too_large",
      `${label} exceeds the ${PHASE20_LIMITS.spreadsheet.maxCellChars}-character cell limit.`,
    );
  }
  return value;
}

/** Decode only UTF-8 (optionally BOM-prefixed); legacy and UTF-16 encodings are rejected explicitly. */
export function decodeUtf8Spreadsheet(buffer: Buffer): string {
  if (
    (buffer[0] === 0xff && buffer[1] === 0xfe)
    || (buffer[0] === 0xfe && buffer[1] === 0xff)
  ) {
    throw new SpreadsheetParseError(
      "text_invalid_encoding",
      "CSV and TSV inputs must use UTF-8; UTF-16 input is not decoded implicitly.",
    );
  }
  if (buffer.includes(0)) {
    throw new SpreadsheetParseError(
      "text_invalid_encoding",
      "CSV or TSV input contains NUL bytes and is not valid bounded UTF-8 text.",
    );
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch (error) {
    throw new SpreadsheetParseError(
      "text_invalid_encoding",
      `CSV or TSV input is not valid UTF-8: ${(error as Error).message}`,
    );
  }
}

/** RFC 4180-style bounded delimited parser used by both read and future write/convert tests. */
export function parseDelimitedText(text: string, delimiter: "," | "\t"): string[][] {
  if (text.length === 0) return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let afterClosingQuote = false;
  let justEndedRow = false;
  let totalCells = 0;

  const pushField = (): void => {
    row.push(boundedCellString(field, "Delimited field"));
    totalCells += 1;
    if (row.length > PHASE20_LIMITS.spreadsheet.maxColumnsPerSheet) {
      throw new SpreadsheetParseError("range_invalid", "Delimited input exceeds the declared column limit.");
    }
    if (totalCells > PHASE20_LIMITS.spreadsheet.maxWorkbookCells) {
      throw new SpreadsheetParseError("range_invalid", "Delimited input exceeds the declared materialized-cell limit.");
    }
    field = "";
    afterClosingQuote = false;
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    if (rows.length > PHASE20_LIMITS.spreadsheet.maxRowsPerSheet) {
      throw new SpreadsheetParseError("range_invalid", "Delimited input exceeds the declared row limit.");
    }
    row = [];
    justEndedRow = true;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    justEndedRow = false;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterClosingQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (afterClosingQuote && character !== delimiter && character !== "\n" && character !== "\r") {
      throw new SpreadsheetParseError(
        "text_invalid_or_damaged",
        "Unexpected content appeared after a closing quote in the delimited input.",
      );
    }
    if (character === '"') {
      if (field.length > 0) {
        throw new SpreadsheetParseError(
          "text_invalid_or_damaged",
          "A quote appeared after unquoted field content in the delimited input.",
        );
      }
      quoted = true;
    } else if (character === delimiter) {
      pushField();
    } else if (character === "\n") {
      pushRow();
    } else if (character === "\r") {
      if (text[index + 1] === "\n") index += 1;
      pushRow();
    } else {
      field += character;
    }
  }
  if (quoted) {
    throw new SpreadsheetParseError(
      "text_invalid_or_damaged",
      "Delimited input ended inside a quoted field.",
    );
  }
  if (!justEndedRow && (field.length > 0 || row.length > 0 || afterClosingQuote)) pushRow();
  return rows;
}

export function isFormulaLikeText(value: string): boolean {
  return /^[\u0000-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*[=+\-@]/u.test(value);
}

export function tableScalar(
  value: unknown,
): { type: Exclude<TableCellType, "formula">; value: TableCellScalar } {
  if (value === null || value === undefined) return { type: "blank", value: null };
  if (typeof value === "string") return { type: "string", value: boundedCellString(value, "Cell text") };
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { type: "number", value }
      : { type: "error", value: "#NUM!" };
  }
  if (typeof value === "boolean") return { type: "boolean", value };
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { type: "error", value: "#VALUE!" };
    return { type: "date", value: value.toISOString() };
  }
  if (typeof value === "object" && typeof (value as { error?: unknown }).error === "string") {
    return { type: "error", value: boundedCellString((value as { error: string }).error, "Cell error") };
  }
  throw new SpreadsheetParseError(
    "text_invalid_or_damaged",
    "The workbook contains a cached cell value outside the supported scalar type boundary.",
  );
}

export function normalizeSpreadsheetRange(range: SpreadsheetRange | undefined): Required<SpreadsheetRange> {
  const normalized = {
    startRow: range?.startRow ?? 1,
    endRow: range?.endRow ?? PHASE20_LIMITS.spreadsheet.maxRowsPerSheet,
    startColumn: range?.startColumn ?? 1,
    endColumn: range?.endColumn ?? PHASE20_LIMITS.spreadsheet.maxColumnsPerSheet,
  };
  if (normalized.startRow > normalized.endRow || normalized.startColumn > normalized.endColumn) {
    throw new SpreadsheetParseError(
      "range_invalid",
      "Spreadsheet range start values must not exceed their corresponding end values.",
    );
  }
  return normalized;
}

export function cellIsInRange(cell: TableCellSpec, range: Required<SpreadsheetRange>): boolean {
  return cell.row >= range.startRow
    && cell.row <= range.endRow
    && cell.column >= range.startColumn
    && cell.column <= range.endColumn;
}

interface A1Range {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}

function columnNumber(label: string): number {
  let value = 0;
  for (const character of label.toUpperCase()) value = value * 26 + character.charCodeAt(0) - 64;
  return value;
}

export function parseA1Range(value: string): A1Range | undefined {
  const match = /^\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})\$?(\d+)$/iu.exec(value);
  if (!match) return undefined;
  const startColumn = columnNumber(match[1]!);
  const startRow = Number(match[2]);
  const endColumn = columnNumber(match[3]!);
  const endRow = Number(match[4]);
  if (
    !Number.isSafeInteger(startRow)
    || !Number.isSafeInteger(endRow)
    || startRow < 1
    || endRow < startRow
    || startColumn < 1
    || endColumn < startColumn
  ) return undefined;
  return { startRow, endRow, startColumn, endColumn };
}

export function analyzeMergedRanges(ranges: readonly string[]): {
  returnedRanges: string[];
  abnormal: boolean;
  reasons: string[];
} {
  const returnedRanges = ranges.slice(0, PHASE20_LIMITS.spreadsheet.maxMergedRanges);
  const reasons: string[] = [];
  if (ranges.length > 1_000) reasons.push("more than 1,000 merged regions");
  if (ranges.length > returnedRanges.length) reasons.push("merged-region metadata exceeds the declared limit");
  const seen = new Set<string>();
  for (const rawRange of returnedRanges) {
    const range = parseA1Range(rawRange);
    if (!range) {
      reasons.push(`invalid merged range ${rawRange.slice(0, 64)}`);
      continue;
    }
    const area = (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1);
    if (
      area > 10_000
      || range.endRow > PHASE20_LIMITS.spreadsheet.maxRowsPerSheet
      || range.endColumn > PHASE20_LIMITS.spreadsheet.maxColumnsPerSheet
    ) reasons.push(`oversized merged range ${rawRange.slice(0, 64)}`);
    const key = rawRange.replace(/\$/gu, "").toUpperCase();
    if (seen.has(key)) reasons.push(`duplicate merged range ${rawRange.slice(0, 64)}`);
    seen.add(key);
  }
  return { returnedRanges, abnormal: reasons.length > 0, reasons: [...new Set(reasons)].slice(0, 20) };
}

export function delimitedRowsToSheet(
  rows: readonly string[][],
  warnings: StructuredDocumentWarning[],
): ParsedSpreadsheetSheet {
  const cells: TableCellSpec[] = [];
  let columnCount = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    columnCount = Math.max(columnCount, row.length);
    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      const value = row[columnIndex]!;
      if (isFormulaLikeText(value) && !warnings.some((warning) => warning.code === "formula_like_text")) {
        warnings.push(structuredWarning("formula_like_text", {
          category: "security",
          scope: `Sheet1!R${rowIndex + 1}C${columnIndex + 1}`,
        }));
      }
      cells.push({
        row: rowIndex + 1,
        column: columnIndex + 1,
        type: value.length === 0 ? "blank" : "string",
        value: value.length === 0 ? null : value,
      });
    }
  }
  return {
    name: "Sheet1",
    state: "visible",
    rowCount: rows.length,
    columnCount,
    cells,
    mergedRanges: [],
    columns: [],
    freezeHeaderRow: false,
  };
}

export function paginateSpreadsheet(
  sheets: readonly ParsedSpreadsheetSheet[],
  options: {
    range?: SpreadsheetRange;
    cursor: number;
    maxCells: number;
    maxVisibleChars: number;
  },
): SpreadsheetPage {
  const range = normalizeSpreadsheetRange(options.range);
  const candidates = sheets.flatMap((sheet, sheetIndex) => sheet.cells
    .filter((cell) => cellIsInRange(cell, range))
    .sort((left, right) => left.row - right.row || left.column - right.column)
    .map((cell) => ({ sheetIndex, cell })));
  if (candidates.length > PHASE20_LIMITS.spreadsheet.maxWorkbookCells) {
    throw new SpreadsheetParseError(
      "range_invalid",
      `The selected range contains more than ${PHASE20_LIMITS.spreadsheet.maxWorkbookCells} materialized cells. Narrow the range.`,
    );
  }
  if (options.cursor > candidates.length) {
    throw new SpreadsheetParseError(
      "range_invalid",
      `Cursor ${options.cursor} exceeds the selected cell total ${candidates.length}.`,
    );
  }

  const selected: Array<{ sheetIndex: number; cell: TableCellSpec }> = [];
  let usedChars = 0;
  let hitCharacterLimit = false;
  for (const candidate of candidates.slice(options.cursor, options.cursor + options.maxCells)) {
    const cost = JSON.stringify(candidate.cell).length + 32;
    if (usedChars + cost > Math.max(1, options.maxVisibleChars - 32_768)) {
      hitCharacterLimit = true;
      break;
    }
    selected.push(candidate);
    usedChars += cost;
  }

  const outputSheets = sheets.map((sheet, sheetIndex): TableSheetSpec => ({
    name: sheet.name,
    state: sheet.state,
    cells: selected.filter((entry) => entry.sheetIndex === sheetIndex).map((entry) => entry.cell),
    rowCount: sheet.rowCount,
    columnCount: sheet.columnCount,
    mergedRanges: sheet.mergedRanges,
    columns: sheet.columns,
    freezeHeaderRow: sheet.freezeHeaderRow,
  }));
  const consumed = options.cursor + selected.length;
  const truncated = consumed < candidates.length;
  return {
    sheets: outputSheets,
    totalCells: candidates.length,
    returnedCells: selected.length,
    nextCursor: truncated ? String(consumed) : undefined,
    truncated,
    truncationReason: truncated
      ? hitCharacterLimit
        ? "character_limit"
        : "pagination"
      : undefined,
  };
}
