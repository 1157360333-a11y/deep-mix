/// <reference path="../../pdfjs-worker.d.ts" />

import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  DocumentMetadata,
  DocumentReadResult,
  DocumentReadWarning,
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
import {
  documentReadBaseProperties,
  resolveDocumentMaxChars,
  type ReadPdfArgs,
} from "./contracts.js";

const PDF_MIME_TYPE = "application/pdf";
const MAX_PDF_FILE_BYTES = 64 * 1024 * 1024;
const MAX_METADATA_TITLE_CHARS = 512;
const MAX_METADATA_AUTHOR_CHARS = 256;
const MAX_METADATA_SUBJECT_CHARS = 1_000;
const MAX_METADATA_KEYWORDS = 20;
const MAX_METADATA_KEYWORD_CHARS = 100;
const MAX_EMPTY_PAGE_REFERENCES = 20;
const MAX_RETURNED_PAGES = 10_000;

interface PdfJsModule {
  getDocument(input: Record<string, unknown>): {
    promise: Promise<PdfDocumentProxy>;
    destroy(): Promise<void>;
  };
}

interface PdfDocumentProxy {
  numPages: number;
  getMetadata(): Promise<{
    info?: Record<string, unknown>;
    metadata?: { get(name: string): string | undefined } | null;
  }>;
  getPage(pageNumber: number): Promise<{
    getTextContent(): Promise<{
      items: Array<{ str?: string; hasEOL?: boolean }>;
    }>;
    cleanup(): void;
  }>;
  destroy(): Promise<void>;
}

interface PdfDocumentFailure {
  code:
    | "document_too_large"
    | "pdf_encrypted"
    | "pdf_invalid_or_damaged"
    | "pdf_read_failed";
  message: string;
}

async function loadPdfJs(): Promise<PdfJsModule> {
  // PDF.js uses a fake worker in Node/Electron main-process contexts. Import the
  // worker module explicitly so production bundlers include its
  // WorkerMessageHandler instead of falling back to a missing ./pdf.worker.mjs
  // asset beside a generated chunk.
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  return import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as Promise<PdfJsModule>;
}

async function pdfAvailability(_context: ToolModuleContext): Promise<ToolAvailability> {
  try {
    await loadPdfJs();
    return { status: "available", available: true };
  } catch (error) {
    return {
      status: "unavailable",
      available: false,
      missingCapabilities: ["pdfjs-dist"],
      reason: `PDF text extraction dependency is unavailable: ${(error as Error).message}`,
    };
  }
}

function normalizePdfText(items: Array<{ str?: string; hasEOL?: boolean }>): string {
  let text = "";
  for (const item of items) {
    if (typeof item.str !== "string" || item.str.length === 0) continue;
    text += item.str;
    text += item.hasEOL ? "\n" : " ";
  }
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stringMetadata(
  info: Record<string, unknown> | undefined,
  infoName: string,
  metadata: { get(name: string): string | undefined } | null | undefined,
  metadataName: string,
): string | undefined {
  const fromInfo = info?.[infoName];
  if (typeof fromInfo === "string" && fromInfo.trim()) return fromInfo.trim();
  const fromMetadata = metadata?.get(metadataName);
  return typeof fromMetadata === "string" && fromMetadata.trim() ? fromMetadata.trim() : undefined;
}

function parsePdfDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(value);
  if (!match) return value;
  const [, year, month = "01", day = "01", hour = "00", minute = "00", second = "00"] = match;
  const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function summarizeDocumentText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "No extractable text was found in the selected PDF pages.";
  return normalized.length <= 600 ? normalized : `${normalized.slice(0, 597)}...`;
}

function limitMetadataValue(
  value: string | undefined,
  maxChars: number,
  state: { truncated: boolean },
): string | undefined {
  if (!value) return undefined;
  if (value.length <= maxChars) return value;
  state.truncated = true;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function formatPageSample(pages: number[], totalCount: number): string {
  const listed = pages.join(", ");
  return totalCount > pages.length ? `${listed}, and ${totalCount - pages.length} more` : listed;
}

function classifyPdfFailure(error: unknown): PdfDocumentFailure {
  const value = error as { name?: string; message?: string };
  if (value.name === "PasswordException") {
    return {
      code: "pdf_encrypted",
      message: "The PDF is encrypted and cannot be read without a password.",
    };
  }
  if (
    value.name === "InvalidPDFException" ||
    value.name === "FormatError" ||
    value.name === "UnknownErrorException"
  ) {
    return {
      code: "pdf_invalid_or_damaged",
      message: "The file is not a valid readable PDF or is damaged.",
    };
  }
  return {
    code: "pdf_read_failed",
    message: value.message?.trim() || "The PDF could not be read.",
  };
}

function failureResult(
  failure: PdfDocumentFailure,
  context: RuntimeToolExecutionContext,
): ToolResult {
  const timestamp = context.moduleContext.clock.now();
  const error: ToolStructuredError = {
    type: "command_failed",
    message: failure.message,
    retryable: false,
    toolName: "read_pdf",
  };
  const body = {
    kind: "document_error",
    format: "pdf",
    code: failure.code,
    error,
  };
  return {
    toolName: "read_pdf",
    callId: context.callId,
    startedAt: timestamp,
    endedAt: timestamp,
    success: false,
    output: JSON.stringify(body),
    structuredContent: body,
    error: failure.message,
  };
}

function sourceArtifact(input: {
  argsPath: string;
  absolutePath: string;
  workspaceRelativePath?: string;
  artifactRef?: string;
  sizeBytes: number;
  context: RuntimeToolExecutionContext;
}): ToolOutputArtifact | undefined {
  const uri = input.argsPath.startsWith("file://")
    ? input.argsPath
    : input.artifactRef?.startsWith("artifact://tool-outputs/")
      ? input.artifactRef
      : input.workspaceRelativePath
        ? `file://${input.workspaceRelativePath}`
        : undefined;
  if (!uri) return undefined;
  return {
    uri,
    fileName: path.basename(input.absolutePath),
    mimeType: PDF_MIME_TYPE,
    sizeBytes: input.sizeBytes,
    kind: "document",
    sourceToolName: "read_pdf",
    summary: "PDF source read with bounded text extraction.",
    createdAt: input.context.moduleContext.clock.now(),
    workspaceRelativePath: input.workspaceRelativePath,
  };
}

async function executeReadPdf(
  args: ReadPdfArgs,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  const resolved = await context.moduleContext.paths.resolveReadable(args.path);
  const stat = await fs.stat(resolved.absolutePath);
  if (!stat.isFile()) {
    throw new ToolArgumentError("PDF input must be a file.", { fieldPath: "/path" });
  }
  if (stat.size > MAX_PDF_FILE_BYTES) {
    return failureResult(
      {
        code: "document_too_large",
        message: `PDF input exceeds the ${MAX_PDF_FILE_BYTES / 1024 / 1024} MiB safety limit.`,
      },
      context,
    );
  }
  const bytes = await resolved.readBytes();
  const maxChars = resolveDocumentMaxChars(args.maxChars);
  let loadingTask: ReturnType<PdfJsModule["getDocument"]> | undefined;
  let pdf: PdfDocumentProxy | undefined;

  try {
    const pdfjs = await loadPdfJs();
    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      stopAtErrors: true,
      useWasm: false,
      isEvalSupported: false,
      verbosity: 0,
    });
    pdf = await loadingTask.promise;

    const requestedStart = args.pageRange?.start ?? 1;
    const requestedEnd = args.pageRange?.end ?? pdf.numPages;
    if (requestedStart > requestedEnd) {
      throw new ToolArgumentError("pageRange.end must be greater than or equal to pageRange.start.", {
        fieldPath: "/pageRange/end",
      });
    }
    if (requestedStart > pdf.numPages || requestedEnd > pdf.numPages) {
      throw new ToolArgumentError(`Requested page range exceeds the PDF page count (${pdf.numPages}).`, {
        fieldPath: "/pageRange",
      });
    }

    const warnings: DocumentReadWarning[] = [];
    let metadata: DocumentMetadata & { pageCount?: number } = { pageCount: pdf.numPages };
    try {
      const rawMetadata = await pdf.getMetadata();
      const info = rawMetadata.info;
      const extended = rawMetadata.metadata;
      const metadataLimitState = { truncated: false };
      const rawKeywords = limitMetadataValue(
        stringMetadata(info, "Keywords", extended, "pdf:keywords"),
        MAX_METADATA_KEYWORDS * (MAX_METADATA_KEYWORD_CHARS + 1),
        metadataLimitState,
      );
      const keywords = rawKeywords
        ?.split(/[,;]+/g)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, MAX_METADATA_KEYWORDS)
        .map((entry) => limitMetadataValue(entry, MAX_METADATA_KEYWORD_CHARS, metadataLimitState)!)
        .filter(Boolean);
      if (rawKeywords && rawKeywords.split(/[,;]+/g).filter((entry) => entry.trim()).length > MAX_METADATA_KEYWORDS) {
        metadataLimitState.truncated = true;
      }
      metadata = {
        pageCount: pdf.numPages,
        title: limitMetadataValue(
          stringMetadata(info, "Title", extended, "dc:title"),
          MAX_METADATA_TITLE_CHARS,
          metadataLimitState,
        ),
        author: limitMetadataValue(
          stringMetadata(info, "Author", extended, "dc:creator"),
          MAX_METADATA_AUTHOR_CHARS,
          metadataLimitState,
        ),
        subject: limitMetadataValue(
          stringMetadata(info, "Subject", extended, "dc:description"),
          MAX_METADATA_SUBJECT_CHARS,
          metadataLimitState,
        ),
        keywords: keywords?.length ? keywords : undefined,
        createdAt: limitMetadataValue(
          parsePdfDate(stringMetadata(info, "CreationDate", extended, "xmp:CreateDate")),
          100,
          metadataLimitState,
        ),
        modifiedAt: limitMetadataValue(
          parsePdfDate(stringMetadata(info, "ModDate", extended, "xmp:ModifyDate")),
          100,
          metadataLimitState,
        ),
      };
      if (metadataLimitState.truncated) {
        warnings.push({
          code: "metadata_truncated",
          message: "PDF metadata was bounded before it was returned to the model.",
        });
      }
    } catch {
      warnings.push({
        code: "metadata_unavailable",
        message: "PDF metadata could not be extracted, but page text processing continued.",
      });
    }

    const sections: DocumentReadResult["sections"] = [];
    const citations: DocumentReadResult["citations"] = [];
    const emptyPages: number[] = [];
    let emptyPageCount = 0;
    let extractedChars = 0;
    let truncated = false;
    let processedPages = 0;
    const selectedPageCount = requestedEnd - requestedStart + 1;
    const maxReturnedPages = Math.min(selectedPageCount, MAX_RETURNED_PAGES);

    for (let pageNumber = requestedStart; pageNumber <= requestedEnd; pageNumber += 1) {
      if (extractedChars >= maxChars || processedPages >= maxReturnedPages) {
        truncated = true;
        break;
      }
      const page = await pdf.getPage(pageNumber);
      try {
        const pageText = normalizePdfText((await page.getTextContent()).items);
        if (!pageText) {
          emptyPageCount += 1;
          if (emptyPages.length < MAX_EMPTY_PAGE_REFERENCES) emptyPages.push(pageNumber);
        }
        const remaining = maxChars - extractedChars;
        const boundedText = pageText.slice(0, remaining);
        if (boundedText.length < pageText.length) truncated = true;
        extractedChars += boundedText.length;
        sections.push({ page: pageNumber, text: boundedText });
        citations.push({
          label: `${path.basename(resolved.absolutePath)} page ${pageNumber}`,
          source: args.path,
          page: pageNumber,
        });
        processedPages += 1;
        if (truncated) break;
      } finally {
        page.cleanup();
      }
    }

    if (emptyPageCount > 0) {
      warnings.push({
        code: "ocr_required",
        message: emptyPageCount === processedPages && processedPages === selectedPageCount
          ? `Selected PDF pages contain no extractable text and may require OCR: ${formatPageSample(emptyPages, emptyPageCount)}.`
          : `Some processed PDF pages contain no extractable text and may require OCR: ${formatPageSample(emptyPages, emptyPageCount)}.`,
      });
    }
    if (processedPages < selectedPageCount && processedPages >= maxReturnedPages) {
      warnings.push({
        code: "page_limit_reached",
        message: `PDF structure was limited to ${maxReturnedPages} pages for this ${maxChars}-character request.`,
      });
    }
    if (truncated) {
      warnings.push({
        code: "output_truncated",
        message: `PDF text was limited to ${maxChars} characters.`,
      });
    }

    const combinedText = sections.map((section) => section.text).filter(Boolean).join("\n\n");
    const source = resolved.artifactRef ?? resolved.workspaceRelativePath ?? args.path;
    const result: DocumentReadResult = {
      format: "pdf",
      source,
      metadata,
      summary: summarizeDocumentText(combinedText),
      sections,
      tables: [],
      citations,
      extractedChars,
      truncated,
      warnings,
    };
    const artifact = sourceArtifact({
      argsPath: args.path,
      absolutePath: resolved.absolutePath,
      workspaceRelativePath: resolved.workspaceRelativePath,
      artifactRef: resolved.artifactRef,
      sizeBytes: bytes.byteLength,
      context,
    });
    const timestamp = context.moduleContext.clock.now();
    return {
      toolName: "read_pdf",
      callId: context.callId,
      startedAt: timestamp,
      endedAt: timestamp,
      success: true,
      output: JSON.stringify({
        format: result.format,
        source: result.source,
        metadata: result.metadata,
        returnedPages: result.sections.map((section) => section.page),
        summary: result.summary,
        sections: result.sections,
        truncated: result.truncated,
        warnings: result.warnings,
        citations: result.citations,
      }),
      structuredContent: result,
      artifacts: artifact ? [artifact] : [],
    };
  } catch (error) {
    if (error instanceof ToolArgumentError) throw error;
    return failureResult(classifyPdfFailure(error), context);
  } finally {
    if (pdf) await pdf.destroy().catch(() => undefined);
    else if (loadingTask) await loadingTask.destroy().catch(() => undefined);
  }
}

export const readPdfTool: RuntimeToolSpec = {
  name: "read_pdf",
  displayName: "Read PDF",
  description: "Read bounded text, metadata, warnings, and page citations from a PDF without OCR.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      ...documentReadBaseProperties,
      pageRange: {
        type: "object",
        additionalProperties: false,
        required: ["start"],
        properties: {
          start: { type: "integer", minimum: 1 },
          end: { type: "integer", minimum: 1 },
        },
      },
    },
  },
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "slow",
  groups: ["documents", "document-read", "pdf"],
  selection: {
    groups: ["documents", "document-read", "pdf"],
    keywords: [
      "read pdf",
      "extract pdf",
      "读取 pdf",
      "阅读 pdf",
      "解析 pdf",
      "读取pdf",
      "阅读pdf",
      "解析pdf",
      "查看pdf",
      "读pdf",
      "pdf中的内容",
      "pdf内容",
      "根目录pdf",
    ],
    keywordGroups: [
      ["read", "pdf"],
      ["inspect", "pdf"],
      ["analyze", "pdf"],
      ["extract", "pdf"],
      ["读取", "pdf"],
      ["阅读", "pdf"],
      ["解析", "pdf"],
      ["查看", "pdf"],
      ["打开", "pdf"],
      ["读", "pdf"],
      ["看看", "pdf"],
      ["分析", "pdf"],
      ["总结", "pdf"],
      ["提取", "pdf"],
    ],
    attachmentExtensions: [".pdf"],
    mimeTypes: [PDF_MIME_TYPE],
  },
  getAvailability: pdfAvailability,
  resolveAccess: (rawArgs) => {
    const args = rawArgs as ReadPdfArgs;
    return [
      {
        kind: "filesystem_read",
        paths: [args.path],
        reason: "Read the requested PDF through the workspace or trusted-artifact path guard.",
      },
    ];
  },
  execute: (rawArgs, context) => executeReadPdf(rawArgs as ReadPdfArgs, context),
};
