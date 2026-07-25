import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  StructuredDocumentWarning,
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
  ToolModule,
  ToolModuleContext,
} from "../../tool-module.js";

import { pathPropertySchema, structuredWarning } from "./contracts.js";
import {
  PHASE20_LIMITS,
  PHASE20_OFFLINE_CONVERSION_ALLOWLIST,
} from "./format-policy.js";
import type { ParsedSpreadsheetDocument } from "./spreadsheets.js";
import { parseSpreadsheetDocument, spreadsheetAvailability } from "./spreadsheets.js";
import {
  publishSpreadsheetBufferAtomic,
  renderSpreadsheetDocument,
  writeSpreadsheetAvailability,
} from "./spreadsheet-writer.js";

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MIME_TYPES: Record<TableFormat, string> = {
  xlsx: XLSX_MIME_TYPE,
  csv: "text/csv",
  tsv: "text/tab-separated-values",
};
const KNOWN_DOCUMENT_FORMATS = [
  "xlsx", "csv", "tsv", "pptx", "pdf", "docx", "ipynb",
  "png", "jpeg", "webp", "gif", "tiff", "zip", "tar", "gzip",
] as const;

export type ConversionDocumentFormat = typeof KNOWN_DOCUMENT_FORMATS[number];
export type ConversionFidelity = "lossless" | "structured" | "lossy_single_sheet";

export interface ConvertDocumentArgs {
  inputPath: string;
  outputPath: string;
  sourceFormat: ConversionDocumentFormat;
  targetFormat: ConversionDocumentFormat;
  overwrite?: boolean;
  /** One-based index or exact name; valid only for XLSX -> CSV/TSV. */
  sheet?: string | number;
}

type ConversionFailureCode =
  | "conversion_not_allowed"
  | "format_mismatch"
  | "input_not_file"
  | "input_too_large"
  | "input_invalid_or_damaged"
  | "sheet_not_found"
  | "output_invalid"
  | "output_exists"
  | "output_too_large"
  | "checkpoint_required"
  | "xlsx_dependency_unavailable"
  | "unsupported_capability"
  | "conversion_failed"
  | "write_failed";

interface AllowedConversion {
  source: TableFormat;
  target: TableFormat;
  fidelity: ConversionFidelity;
}

interface ConversionFailure {
  code: ConversionFailureCode;
  message: string;
  errorType?: ToolStructuredError["type"];
  dependency?: string;
  fieldPath?: string;
}

class ConversionInputReadError extends Error {
  public constructor(
    public readonly code: "input_too_large" | "input_invalid_or_damaged",
    message: string,
  ) {
    super(message);
    this.name = "ConversionInputReadError";
  }
}

export const CONVERT_DOCUMENT_CAPABILITIES = {
  offlineOnly: true,
  externalPrograms: false,
  officeAutomation: false,
  formulaCalculation: false,
  allowlist: PHASE20_OFFLINE_CONVERSION_ALLOWLIST.map((entry) => ({ ...entry })),
  maxInputBytes: PHASE20_LIMITS.conversion.maxInputBytes,
  maxOutputBytes: PHASE20_LIMITS.conversion.maxOutputBytes,
} as const;

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/gu, "/");
}

function formatExtension(format: TableFormat): string {
  return `.${format}`;
}

function allowedConversion(
  source: ConversionDocumentFormat,
  target: ConversionDocumentFormat,
): AllowedConversion | undefined {
  return PHASE20_OFFLINE_CONVERSION_ALLOWLIST.find(
    (entry) => entry.source === source && entry.target === target,
  ) as AllowedConversion | undefined;
}

function conversionFailure(
  args: Pick<ConvertDocumentArgs, "sourceFormat" | "targetFormat">,
  failure: ConversionFailure,
  context: RuntimeToolExecutionContext,
): ToolResult {
  const timestamp = context.moduleContext.clock.now();
  const error: ToolStructuredError = {
    type: failure.errorType ?? (failure.dependency ? "missing_dependency" : "command_failed"),
    message: failure.message,
    retryable: false,
    toolName: "convert_document",
    dependency: failure.dependency,
    fieldPath: failure.fieldPath,
  };
  const body = {
    kind: "document_conversion_error",
    sourceFormat: args.sourceFormat,
    targetFormat: args.targetFormat,
    code: failure.code,
    error,
    capabilities: CONVERT_DOCUMENT_CAPABILITIES,
  };
  return {
    toolName: "convert_document",
    callId: context.callId,
    startedAt: timestamp,
    endedAt: timestamp,
    success: false,
    output: JSON.stringify(body),
    structuredContent: body,
    error: failure.message,
  };
}

function checkExtensions(
  args: ConvertDocumentArgs,
  absoluteInputPath: string,
): ConversionFailure | undefined {
  const inputExtension = path.extname(absoluteInputPath).toLowerCase();
  const expectedInput = formatExtension(args.sourceFormat as TableFormat);
  if (inputExtension !== expectedInput) {
    return {
      code: "format_mismatch",
      message: `Explicit sourceFormat ${args.sourceFormat.toUpperCase()} requires an ${expectedInput} input filename, not ${inputExtension || "an extensionless path"}.`,
      errorType: "invalid_arguments",
    };
  }
  const outputExtension = path.extname(args.outputPath).toLowerCase();
  const expectedOutput = formatExtension(args.targetFormat as TableFormat);
  if (outputExtension !== expectedOutput) {
    return {
      code: "format_mismatch",
      message: `Explicit targetFormat ${args.targetFormat.toUpperCase()} requires an ${expectedOutput} outputPath, not ${outputExtension || "an extensionless path"}.`,
      errorType: "invalid_arguments",
    };
  }
  return undefined;
}

function mergeWarnings(
  ...groups: readonly StructuredDocumentWarning[][]
): StructuredDocumentWarning[] {
  const output: StructuredDocumentWarning[] = [];
  const keys = new Set<string>();
  for (const warning of groups.flat()) {
    const key = `${warning.code}\0${warning.scope ?? ""}\0${warning.message}`;
    if (!keys.has(key) && output.length < 200) {
      keys.add(key);
      output.push(warning);
    }
  }
  return output;
}

function selectSheet(
  parsed: ParsedSpreadsheetDocument,
  selector: ConvertDocumentArgs["sheet"],
): { sheet: ParsedSpreadsheetDocument["sheets"][number]; implicit: boolean } | undefined {
  if (selector !== undefined) {
    const sheet = typeof selector === "number"
      ? parsed.sheets[selector - 1]
      : parsed.sheets.find((entry) => entry.name === selector);
    return sheet ? { sheet, implicit: false } : undefined;
  }
  const active = parsed.activeSheet
    ? parsed.sheets.find((entry) => entry.name === parsed.activeSheet)
    : undefined;
  const sheet = active ?? parsed.sheets[0];
  return sheet ? { sheet, implicit: true } : undefined;
}

function lostXlsxCapabilities(
  parsed: ParsedSpreadsheetDocument,
  sheet: ParsedSpreadsheetDocument["sheets"][number],
): string[] {
  const lost = new Set<string>([
    "workbook_styles_and_themes",
    "number_formats_and_display_formatting",
    "workbook_metadata",
    "drawings_charts_images_and_embedded_media",
    "comments_validations_named_ranges_and_conditional_formatting",
  ]);
  if (parsed.sheets.length > 1) lost.add("unselected_worksheets");
  if (sheet.mergedRanges.length > 0) lost.add("merged_cells");
  if (sheet.columns.some((column) => column.width !== undefined)) lost.add("column_widths");
  if (sheet.freezeHeaderRow) lost.add("freeze_panes");
  if (sheet.cells.some((cell) => cell.type === "formula")) lost.add("formula_cached_values_and_display_formatting");
  if (parsed.sheets.some((entry) => entry.state !== "visible")) lost.add("hidden_sheet_state");
  if (parsed.warnings.some((warning) => warning.code === "macro_present")) lost.add("macros");
  if (parsed.warnings.some((warning) => warning.code === "external_link_present")) lost.add("external_links_and_connections");
  return [...lost];
}

function conversionDocument(
  parsed: ParsedSpreadsheetDocument,
  args: ConvertDocumentArgs,
  warnings: StructuredDocumentWarning[],
): { document: TableDocumentSpec; selectedSheet?: string; lostCapabilities: string[] } | ConversionFailure {
  if (args.sourceFormat !== "xlsx") {
    if (args.sheet !== undefined) {
      return {
        code: "unsupported_capability",
        message: "sheet may be used only when converting XLSX to CSV or TSV.",
        errorType: "invalid_arguments",
      };
    }
    const lostCapabilities: string[] = [];
    if (
      args.targetFormat !== "xlsx"
      && parsed.warnings.some((warning) => warning.code === "formula_like_text")
    ) {
      lostCapabilities.push("formula_like_text_identity_after_injection_sanitization");
      warnings.push(structuredWarning("conversion_fidelity_loss", {
        message: `${args.sourceFormat.toUpperCase()} to ${args.targetFormat.toUpperCase()} applies formula-injection sanitization; formula-like text fields are apostrophe-prefixed and may differ from the source text.`,
        severity: "high",
        category: "security",
        scope: parsed.activeSheet ?? parsed.sheets[0]?.name,
        details: {
          fidelity: "structured",
          transformation: "apostrophe_prefix_for_formula_like_text",
          lostCapabilities,
        },
      }));
    }
    return {
      document: {
        metadata: parsed.metadata,
        activeSheet: parsed.activeSheet,
        sheets: parsed.sheets.map((sheet) => ({ ...sheet, state: "visible" as const })),
      },
      lostCapabilities,
    };
  }

  const selected = selectSheet(parsed, args.sheet);
  if (!selected) {
    return {
      code: "sheet_not_found",
      message: `Requested worksheet ${String(args.sheet)} was not found.`,
      errorType: "invalid_arguments",
    };
  }
  const lostCapabilities = lostXlsxCapabilities(parsed, selected.sheet);
  if (selected.implicit) {
    warnings.push(structuredWarning("conversion_fidelity_loss", {
      message: `No worksheet was specified; the active or first worksheet '${selected.sheet.name}' was selected deterministically.`,
      category: "compatibility",
      scope: selected.sheet.name,
      details: { reason: "implicit_sheet_selection", selectedSheet: selected.sheet.name },
    }));
  }
  warnings.push(structuredWarning("conversion_fidelity_loss", {
    message: `XLSX to ${args.targetFormat.toUpperCase()} exports only worksheet '${selected.sheet.name}' and cannot preserve workbook-only capabilities.`,
    severity: "high",
    category: "compatibility",
    scope: selected.sheet.name,
    details: { fidelity: "lossy_single_sheet", lostCapabilities },
  }));
  return {
    document: {
      metadata: parsed.metadata,
      activeSheet: selected.sheet.name,
      sheets: [{
        ...selected.sheet,
        state: "visible",
        // Delimited formats have no workbook layout channel. Fidelity loss was
        // recorded above before these unsupported properties are removed.
        mergedRanges: [],
        columns: [],
        freezeHeaderRow: false,
      }],
    },
    selectedSheet: selected.sheet.name,
    lostCapabilities,
  };
}

function parseFailure(error: unknown): ConversionFailure {
  const source = error as Error & { code?: string };
  if (source.name === "SpreadsheetFormatMismatchError") {
    return { code: "format_mismatch", message: source.message, errorType: "invalid_arguments" };
  }
  if (source.name === "XlsxDependencyError" || /dependencies are unavailable/iu.test(source.message)) {
    return {
      code: "xlsx_dependency_unavailable",
      message: source.message,
      errorType: "missing_dependency",
      dependency: "exceljs/jszip",
    };
  }
  return { code: "input_invalid_or_damaged", message: source.message || "Spreadsheet input is invalid or damaged." };
}

function renderFailure(error: unknown): ConversionFailure {
  const source = error as Error;
  if (source.name === "XlsxDependencyError") {
    return {
      code: "xlsx_dependency_unavailable",
      message: source.message,
      errorType: "missing_dependency",
      dependency: "exceljs",
    };
  }
  if (source.name === "OutputTooLargeError") return { code: "output_too_large", message: source.message };
  if (error instanceof ToolArgumentError) {
    return { code: "unsupported_capability", message: error.message, errorType: "invalid_arguments" };
  }
  return { code: "conversion_failed", message: source.message || "Spreadsheet conversion failed." };
}

function outputArtifact(input: {
  outputPath: string;
  absolutePath: string;
  targetFormat: TableFormat;
  content: Buffer;
  context: RuntimeToolExecutionContext;
}): ToolOutputArtifact {
  return {
    uri: `file://${input.outputPath}`,
    fileName: path.basename(input.absolutePath),
    mimeType: MIME_TYPES[input.targetFormat],
    sizeBytes: input.content.byteLength,
    sha256: createHash("sha256").update(input.content).digest("hex"),
    kind: input.targetFormat === "xlsx" ? "document" : "text",
    sourceToolName: "convert_document",
    summary: `Generated an allowlisted offline ${input.targetFormat.toUpperCase()} conversion without Office or external programs.`,
    createdAt: input.context.moduleContext.clock.now(),
    workspaceRelativePath: input.outputPath,
  };
}

async function readBoundedConversionInput(
  absolutePath: string,
  initialStat: Awaited<ReturnType<typeof fs.stat>>,
  signal?: AbortSignal,
): Promise<Buffer> {
  const handle = await fs.open(absolutePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()
      || before.dev !== initialStat.dev
      || before.ino !== initialStat.ino
      || before.size !== initialStat.size
      || before.mtimeMs !== initialStat.mtimeMs) {
      throw new ConversionInputReadError(
        "input_invalid_or_damaged",
        "Conversion input changed identity before the guarded read.",
      );
    }
    if (before.size > PHASE20_LIMITS.conversion.maxInputBytes) {
      throw new ConversionInputReadError(
        "input_too_large",
        `Conversion input exceeds the ${PHASE20_LIMITS.conversion.maxInputBytes}-byte limit.`,
      );
    }

    const chunks: Buffer[] = [];
    let actualBytes = 0;
    while (true) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Conversion input read was aborted.");
      const remaining = PHASE20_LIMITS.conversion.maxInputBytes - actualBytes;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      actualBytes += bytesRead;
      if (actualBytes > PHASE20_LIMITS.conversion.maxInputBytes) {
        throw new ConversionInputReadError(
          "input_too_large",
          `Actual conversion input exceeds the ${PHASE20_LIMITS.conversion.maxInputBytes}-byte limit.`,
        );
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }

    const after = await handle.stat();
    if (!after.isFile()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || actualBytes !== after.size) {
      throw new ConversionInputReadError(
        "input_invalid_or_damaged",
        "Conversion input changed during the guarded read.",
      );
    }
    return Buffer.concat(chunks, actualBytes);
  } finally {
    await handle.close();
  }
}

export async function convertDocumentAvailability(_context: ToolModuleContext): Promise<ToolAvailability> {
  const [reader, writer] = await Promise.all([
    spreadsheetAvailability(_context),
    writeSpreadsheetAvailability(_context),
  ]);
  const readerReady = reader.status === "available";
  const writerReady = writer.status === "available";
  if (readerReady && writerReady) return { status: "available", available: true };
  const missingCapabilities = [
    ...(!readerReady ? ["xlsx_to_csv_tsv"] : []),
    ...(!writerReady ? ["csv_tsv_to_xlsx"] : []),
  ];
  const fallbackCapabilities = [
    "csv_to_tsv",
    "tsv_to_csv",
    ...(readerReady ? ["xlsx_to_csv", "xlsx_to_tsv"] : []),
    ...(writerReady ? ["csv_to_xlsx", "tsv_to_xlsx"] : []),
  ];
  return {
    status: "degraded",
    available: true,
    missingCapabilities,
    fallbackCapabilities,
    reason: `Some XLSX conversion directions are unavailable after API-level dependency probing: ${missingCapabilities.join(", ")}.`,
  };
}

export async function executeConvertDocument(
  args: ConvertDocumentArgs,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  const allowed = allowedConversion(args.sourceFormat, args.targetFormat);
  if (!allowed) {
    return conversionFailure(args, {
      code: "conversion_not_allowed",
      message: `${args.sourceFormat.toUpperCase()} to ${args.targetFormat.toUpperCase()} is not in the frozen offline conversion allowlist.`,
      errorType: "invalid_arguments",
    }, context);
  }

  const resolved = await context.moduleContext.paths.resolveReadable(args.inputPath);
  const absoluteOutput = context.moduleContext.paths.resolveWorkspace(args.outputPath);
  const normalizedInput = path.resolve(resolved.absolutePath);
  const normalizedOutput = path.resolve(absoluteOutput);
  if (process.platform === "win32"
    ? normalizedInput.toLocaleLowerCase("en-US") === normalizedOutput.toLocaleLowerCase("en-US")
    : normalizedInput === normalizedOutput) {
    return conversionFailure(args, {
      code: "output_invalid",
      message: "inputPath and outputPath must identify different files.",
      errorType: "invalid_path",
    }, context);
  }
  const extensionFailure = checkExtensions(args, resolved.absolutePath);
  if (extensionFailure) return conversionFailure(args, extensionFailure, context);

  let inputStat;
  try {
    inputStat = await fs.stat(resolved.absolutePath);
  } catch (error) {
    return conversionFailure(args, {
      code: "input_not_file",
      message: `Conversion input could not be inspected: ${(error as Error).message}`,
      errorType: "not_found",
    }, context);
  }
  if (!inputStat.isFile()) {
    return conversionFailure(args, {
      code: "input_not_file",
      message: "Conversion input must resolve to a regular file.",
      errorType: "invalid_path",
    }, context);
  }
  if (inputStat.size > PHASE20_LIMITS.conversion.maxInputBytes) {
    return conversionFailure(args, {
      code: "input_too_large",
      message: `Conversion input exceeds the ${PHASE20_LIMITS.conversion.maxInputBytes}-byte limit.`,
      errorType: "invalid_arguments",
    }, context);
  }

  try {
    const existing = await fs.lstat(absoluteOutput);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      return conversionFailure(args, {
        code: "output_invalid",
        message: "Existing outputPath must be a regular non-symbolic-link file.",
        errorType: "invalid_path",
      }, context);
    }
    if (!args.overwrite) {
      return conversionFailure(args, {
        code: "output_exists",
        message: "Output already exists; set overwrite=true to replace it.",
        errorType: "invalid_arguments",
        fieldPath: "/overwrite",
      }, context);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let buffer: Buffer;
  try {
    buffer = await readBoundedConversionInput(resolved.absolutePath, inputStat, context.signal);
  } catch (error) {
    if (error instanceof ConversionInputReadError) {
      return conversionFailure(args, {
        code: error.code,
        message: error.message,
        errorType: error.code === "input_too_large" ? "invalid_arguments" : "command_failed",
      }, context);
    }
    throw error;
  }

  let parsed: ParsedSpreadsheetDocument;
  try {
    parsed = await parseSpreadsheetDocument(buffer, allowed.source);
  } catch (error) {
    return conversionFailure(args, parseFailure(error), context);
  }
  const conversionWarnings: StructuredDocumentWarning[] = [];
  const prepared = conversionDocument(parsed, args, conversionWarnings);
  if ("code" in prepared) return conversionFailure(args, prepared, context);
  if (!context.checkpoint) {
    return conversionFailure(args, {
      code: "checkpoint_required",
      message: "The runtime did not create the required pre-write checkpoint.",
      errorType: "invalid_state",
    }, context);
  }

  let content: Buffer;
  let renderWarnings: StructuredDocumentWarning[];
  try {
    ({ content, warnings: renderWarnings } = await renderSpreadsheetDocument(
      prepared.document,
      allowed.target,
      PHASE20_LIMITS.conversion.maxOutputBytes,
    ));
  } catch (error) {
    return conversionFailure(args, renderFailure(error), context);
  }
  if (content.byteLength > PHASE20_LIMITS.conversion.maxOutputBytes) {
    return conversionFailure(args, {
      code: "output_too_large",
      message: `Actual conversion output exceeds the ${PHASE20_LIMITS.conversion.maxOutputBytes}-byte limit.`,
    }, context);
  }

  try {
    await publishSpreadsheetBufferAtomic(absoluteOutput, content, Boolean(args.overwrite), context.signal);
  } catch (error) {
    if (error instanceof ToolArgumentError) {
      return conversionFailure(args, { code: "output_exists", message: error.message, errorType: "conflicted" }, context);
    }
    return conversionFailure(args, {
      code: "write_failed",
      message: `Conversion output could not be published atomically: ${(error as Error).message}`,
    }, context);
  }

  const relativeOutput = normalizeRelativePath(path.relative(context.workspaceRoot, absoluteOutput));
  const artifact = outputArtifact({
    outputPath: relativeOutput,
    absolutePath: absoluteOutput,
    targetFormat: allowed.target,
    content,
    context,
  });
  const warnings = mergeWarnings(parsed.warnings, conversionWarnings, renderWarnings);
  const inputReference = resolved.artifactRef ?? resolved.workspaceRelativePath ?? args.inputPath;
  const result = {
    sourceFormat: allowed.source,
    targetFormat: allowed.target,
    fidelity: allowed.fidelity,
    inputPath: inputReference,
    outputPath: relativeOutput,
    inputSizeBytes: buffer.byteLength,
    sizeBytes: content.byteLength,
    selectedSheet: prepared.selectedSheet,
    lostCapabilities: prepared.lostCapabilities,
    warnings,
    artifact,
    checkpointId: context.checkpoint.checkpointId,
    undoAvailable: true,
    capabilities: CONVERT_DOCUMENT_CAPABILITIES,
  };
  const timestamp = context.moduleContext.clock.now();
  return {
    toolName: "convert_document",
    callId: context.callId,
    startedAt: timestamp,
    endedAt: timestamp,
    success: true,
    output: JSON.stringify(result),
    structuredContent: result,
    artifacts: [artifact],
  };
}

export const convertDocumentTool: RuntimeToolSpec = {
  name: "convert_document",
  displayName: "Convert Document",
  description: "Convert only the six frozen offline CSV/TSV/XLSX pairs through the TableDocumentSpec reader/writer path, with explicit fidelity loss, formula safety, checkpoint, artifact, and undo metadata. No Office, shell, or external converter is invoked.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["inputPath", "outputPath", "sourceFormat", "targetFormat"],
    properties: {
      inputPath: pathPropertySchema,
      outputPath: pathPropertySchema,
      sourceFormat: { type: "string", enum: KNOWN_DOCUMENT_FORMATS },
      targetFormat: { type: "string", enum: KNOWN_DOCUMENT_FORMATS },
      overwrite: { type: "boolean", default: false },
      sheet: {
        oneOf: [
          { type: "string", minLength: 1, maxLength: 31 },
          { type: "integer", minimum: 1, maximum: PHASE20_LIMITS.spreadsheet.maxSheets },
        ],
      },
    },
  },
  readOnly: false,
  permissionCategory: "write_file",
  sideEffectLevel: "high",
  timeoutCategory: "slow",
  groups: ["documents", "structured-data", "conversion", "spreadsheet-conversion"],
  selection: {
    groups: ["documents", "structured-data", "conversion", "spreadsheet-conversion"],
    keywords: [
      "convert document", "convert spreadsheet", "convert xlsx to csv", "convert xlsx to tsv",
      "convert csv to xlsx", "convert tsv to xlsx", "convert csv to tsv", "convert tsv to csv",
      "转换文档", "转换表格", "xlsx转csv", "xlsx转tsv",
      "csv转xlsx", "tsv转xlsx", "csv转tsv", "tsv转csv",
    ],
    keywordGroups: [
      ["convert", "document"], ["convert", "spreadsheet"], ["xlsx", "csv"],
      ["xlsx", "tsv"], ["csv", "xlsx"], ["tsv", "xlsx"],
      ["转换", "文档"], ["转换", "表格"],
      ["转换", "xlsx", "csv"], ["转换", "xlsx", "tsv"],
      ["转换", "csv", "xlsx"], ["转换", "tsv", "xlsx"],
      ["转换", "csv", "tsv"], ["转换", "tsv", "csv"],
    ],
    attachmentExtensions: [".xlsx", ".csv", ".tsv"],
    mimeTypes: [XLSX_MIME_TYPE, "text/csv", "application/csv", "text/tab-separated-values"],
  },
  checkpoint: {
    mode: "before_write",
    scope: "pre_tool_write",
    reason: "Before publishing an allowlisted offline document conversion.",
  },
  getAvailability: convertDocumentAvailability,
  resolveAccess: (rawArgs) => {
    const args = rawArgs as ConvertDocumentArgs;
    if (!allowedConversion(args.sourceFormat, args.targetFormat)) return [];
    return [
      {
        kind: "filesystem_read",
        paths: [args.inputPath],
        reason: "Read the explicitly declared conversion input through the trusted workspace/artifact path guard.",
      },
      {
        kind: "filesystem_write",
        paths: [args.outputPath],
        reason: "Checkpoint and atomically publish the allowlisted conversion output inside the workspace.",
      },
    ];
  },
  formatPreExecutionFailure: (failure, rawArgs) => {
    const args = rawArgs as ConvertDocumentArgs;
    const body = {
      kind: "document_conversion_error",
      sourceFormat: args.sourceFormat,
      targetFormat: args.targetFormat,
      code: failure.stage === "resolve_access" ? "output_invalid" : "conversion_failed",
      error: failure.error,
      capabilities: CONVERT_DOCUMENT_CAPABILITIES,
    };
    return { output: JSON.stringify(body), structuredContent: body };
  },
  execute: (rawArgs, context) => executeConvertDocument(rawArgs as ConvertDocumentArgs, context),
};

export const conversionsToolModule: ToolModule = {
  manifest: {
    id: "builtin.conversions",
    version: "1.0.0",
    description: "Six-pair offline spreadsheet conversion allowlist with explicit fidelity and no external programs.",
    source: "built_in",
  },
  create: () => [convertDocumentTool],
};
