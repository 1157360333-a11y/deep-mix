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
  type ReadDocumentArgs,
} from "./contracts.js";

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_DOCX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_DOCX_METADATA_VALUE_CHARS = 1_000;
const MAX_DOCX_KEYWORDS = 20;
const MAX_RETURNED_BLOCKS = 10_000;

interface MammothApi {
  convertToHtml(
    input: { buffer: Buffer },
    options: Record<string, unknown>,
  ): Promise<{ value: string; messages: Array<{ type: string; message: string }> }>;
  images: {
    imgElement(
      converter: (image: { contentType: string }) => Promise<{ src: string }>,
    ): unknown;
  };
}

interface HtmlElementLike {
  rawTagName: string;
  text: string;
  childNodes: unknown[];
  querySelectorAll(selector: string): HtmlElementLike[];
}

interface HtmlParserApi {
  parse(value: string): HtmlElementLike;
}

interface ZipEntryLike {
  dir: boolean;
  async(type: "string"): Promise<string>;
}

interface ZipArchiveLike {
  files: Record<string, ZipEntryLike>;
  file(name: string): ZipEntryLike | null;
}

interface JsZipApi {
  loadAsync(data: Buffer, options: { checkCRC32: boolean }): Promise<ZipArchiveLike>;
}

interface DocxDependencies {
  mammoth: MammothApi;
  html: HtmlParserApi;
  zip: JsZipApi;
}

interface DocxFailure {
  code: "document_too_large" | "docx_invalid_or_damaged" | "docx_read_failed";
  message: string;
}

async function loadDocxDependencies(): Promise<DocxDependencies> {
  const [mammothModule, htmlModule, zipModule] = await Promise.all([
    import("mammoth"),
    import("node-html-parser"),
    import("jszip"),
  ]);
  const mammoth = ((mammothModule as unknown as { default?: MammothApi }).default
    ?? mammothModule) as unknown as MammothApi;
  const zip = ((zipModule as unknown as { default?: JsZipApi }).default
    ?? zipModule) as unknown as JsZipApi;
  return {
    mammoth,
    html: htmlModule as unknown as HtmlParserApi,
    zip,
  };
}

async function docxAvailability(_context: ToolModuleContext): Promise<ToolAvailability> {
  try {
    await loadDocxDependencies();
    return { status: "available", available: true };
  } catch (error) {
    return {
      status: "unavailable",
      available: false,
      missingCapabilities: ["mammoth", "node-html-parser", "jszip"],
      reason: `DOCX reading dependencies are unavailable: ${(error as Error).message}`,
    };
  }
}

function isHtmlElement(value: unknown): value is HtmlElementLike {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as { rawTagName?: unknown }).rawTagName === "string";
}

function cleanText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function summarizeDocumentText(text: string): string {
  const normalized = cleanText(text).replace(/\s+/g, " ");
  if (!normalized) return "No readable paragraph, list, or table text was found in the DOCX file.";
  return normalized.length <= 600 ? normalized : `${normalized.slice(0, 597)}...`;
}

function boundedMetadataValue(
  value: string | undefined,
  state: { truncated: boolean },
  maxChars = MAX_DOCX_METADATA_VALUE_CHARS,
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxChars) return normalized;
  state.truncated = true;
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function localTagName(element: HtmlElementLike): string {
  return element.rawTagName.split(":").at(-1)?.toLowerCase() ?? "";
}

function readCoreMetadata(root: HtmlElementLike | undefined): {
  metadata: DocumentMetadata;
  truncated: boolean;
} {
  if (!root) return { metadata: {}, truncated: false };
  const byName = new Map<string, string>();
  for (const element of root.querySelectorAll("*")) {
    const name = localTagName(element);
    if (!byName.has(name)) byName.set(name, cleanText(element.text));
  }
  const state = { truncated: false };
  const rawKeywords = boundedMetadataValue(byName.get("keywords"), state, 2_000);
  const keywords = rawKeywords
    ?.split(/[,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, MAX_DOCX_KEYWORDS)
    .map((entry) => boundedMetadataValue(entry, state, 100)!)
    .filter(Boolean);
  if (rawKeywords && rawKeywords.split(/[,;]+/g).filter((entry) => entry.trim()).length > MAX_DOCX_KEYWORDS) {
    state.truncated = true;
  }
  return {
    metadata: {
      title: boundedMetadataValue(byName.get("title"), state, 512),
      author: boundedMetadataValue(byName.get("creator"), state, 256),
      subject: boundedMetadataValue(byName.get("subject") ?? byName.get("description"), state),
      keywords: keywords?.length ? keywords : undefined,
      createdAt: boundedMetadataValue(byName.get("created"), state, 100),
      modifiedAt: boundedMetadataValue(byName.get("modified"), state, 100),
      language: boundedMetadataValue(byName.get("language"), state, 100),
    },
    truncated: state.truncated,
  };
}

class CharacterBudget {
  public used = 0;

  public truncated = false;

  public constructor(public readonly maximum: number) {}

  public take(value: string): string {
    const normalized = cleanText(value);
    const remaining = this.maximum - this.used;
    if (remaining <= 0) {
      if (normalized) this.truncated = true;
      return "";
    }
    const bounded = normalized.slice(0, remaining);
    this.used += bounded.length;
    if (bounded.length < normalized.length) this.truncated = true;
    return bounded;
  }
}

function failureResult(failure: DocxFailure, context: RuntimeToolExecutionContext): ToolResult {
  const timestamp = context.moduleContext.clock.now();
  const error: ToolStructuredError = {
    type: "command_failed",
    message: failure.message,
    retryable: false,
    toolName: "read_docx",
  };
  const body = {
    kind: "document_error",
    format: "docx",
    code: failure.code,
    error,
  };
  return {
    toolName: "read_docx",
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
    mimeType: DOCX_MIME_TYPE,
    sizeBytes: input.sizeBytes,
    kind: "document",
    sourceToolName: "read_docx",
    summary: "DOCX source read with bounded semantic extraction.",
    createdAt: input.context.moduleContext.clock.now(),
    workspaceRelativePath: input.workspaceRelativePath,
  };
}

function pushWarningOnce(warnings: DocumentReadWarning[], code: string, message: string): void {
  if (!warnings.some((warning) => warning.code === code)) warnings.push({ code, message });
}

async function executeReadDocx(
  args: ReadDocumentArgs,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  const resolved = await context.moduleContext.paths.resolveReadable(args.path);
  const stat = await fs.stat(resolved.absolutePath);
  if (!stat.isFile()) {
    throw new ToolArgumentError("DOCX input must be a file.", { fieldPath: "/path" });
  }
  if (stat.size > MAX_DOCX_FILE_BYTES) {
    return failureResult(
      {
        code: "document_too_large",
        message: `DOCX input exceeds the ${MAX_DOCX_FILE_BYTES / 1024 / 1024} MiB safety limit.`,
      },
      context,
    );
  }

  try {
    const dependencies = await loadDocxDependencies();
    const buffer = await resolved.readBytes();
    const archive = await dependencies.zip.loadAsync(buffer, { checkCRC32: true });
    const contentTypes = archive.file("[Content_Types].xml");
    const documentEntry = archive.file("word/document.xml");
    if (!contentTypes || !documentEntry) {
      return failureResult(
        {
          code: "docx_invalid_or_damaged",
          message: "The file is not a DOCX package because required OOXML parts are missing.",
        },
        context,
      );
    }

    const warnings: DocumentReadWarning[] = [];
    const documentXml = await documentEntry.async("string");
    const coreXml = await archive.file("docProps/core.xml")?.async("string");
    const coreRoot = coreXml ? dependencies.html.parse(coreXml) : undefined;
    const core = readCoreMetadata(coreRoot);
    if (core.truncated) {
      warnings.push({
        code: "metadata_truncated",
        message: "DOCX metadata was bounded before it was returned to the model.",
      });
    }

    const entryNames = Object.keys(archive.files);
    const imageCount = entryNames.filter((name) => /^word\/media\//i.test(name) && !archive.files[name]!.dir).length;
    if (imageCount > 0 || /<w:drawing\b|<w:pict\b/i.test(documentXml)) {
      warnings.push({
        code: "images_not_extracted",
        message: `DOCX contains ${imageCount || "embedded"} image(s); image bytes and layout were not returned.`,
      });
    }
    if (entryNames.some((name) => /^word\/comments(?:Extended)?\.xml$/i.test(name))) {
      warnings.push({
        code: "comments_not_preserved",
        message: "DOCX comments are not included in the extracted document text.",
      });
    }
    if (/<w:(?:ins|del|moveFrom|moveTo)\b/i.test(documentXml)) {
      warnings.push({
        code: "tracked_changes_simplified",
        message: "Tracked revisions were simplified during semantic text extraction.",
      });
    }
    if (archive.file("word/styles.xml")) {
      warnings.push({
        code: "complex_styles_simplified",
        message: "DOCX styles are represented only as basic headings, paragraphs, lists, and tables.",
      });
    }

    let imagePlaceholder = 0;
    const converted = await dependencies.mammoth.convertToHtml(
      { buffer },
      {
        externalFileAccess: false,
        includeEmbeddedStyleMap: false,
        convertImage: dependencies.mammoth.images.imgElement(async () => ({
          src: `docx-image:${++imagePlaceholder}`,
        })),
      },
    );
    for (const message of converted.messages.slice(0, 20)) {
      warnings.push({
        code: message.type === "error" ? "mammoth_error" : "mammoth_warning",
        message: cleanText(message.message).slice(0, 500),
      });
    }
    if (converted.messages.length > 20) {
      warnings.push({
        code: "conversion_warnings_truncated",
        message: `${converted.messages.length - 20} additional DOCX conversion warnings were omitted.`,
      });
    }

    const root = dependencies.html.parse(converted.value);
    const elements = root.childNodes.filter(isHtmlElement);
    const maxChars = resolveDocumentMaxChars(args.maxChars);
    const budget = new CharacterBudget(maxChars);
    const maxBlocks = MAX_RETURNED_BLOCKS;
    const sections: DocumentReadResult["sections"] = [];
    const tables: DocumentReadResult["tables"] = [];
    const citations: DocumentReadResult["citations"] = [];
    const source = resolved.artifactRef ?? resolved.workspaceRelativePath ?? args.path;
    let blockCount = 0;

    for (const element of elements) {
      if (budget.used >= budget.maximum || blockCount >= maxBlocks) {
        budget.truncated = true;
        break;
      }
      const tag = localTagName(element);
      if (tag === "h1" || tag === "h2" || tag === "h3") {
        const text = budget.take(element.text);
        if (text) {
          const level = Number(tag.slice(1)) as 1 | 2 | 3;
          sections.push({ kind: "heading", heading: text, level, text });
          citations.push({ label: `${path.basename(resolved.absolutePath)} heading ${sections.length}`, source, section: text.slice(0, 100) });
          blockCount += 1;
        }
        continue;
      }
      if (tag === "p") {
        const text = budget.take(element.text);
        if (text) {
          sections.push({ kind: "paragraph", text });
          citations.push({ label: `${path.basename(resolved.absolutePath)} paragraph ${sections.length}`, source, section: `paragraph ${sections.length}` });
          blockCount += 1;
        }
        continue;
      }
      if (tag === "ul" || tag === "ol") {
        const items: string[] = [];
        for (const item of element.querySelectorAll("li")) {
          const text = budget.take(item.text);
          if (text) items.push(text);
          if (budget.truncated) break;
        }
        if (items.length > 0) {
          const numbered = tag === "ol";
          sections.push({
            kind: numbered ? "numbered_list" : "bullet_list",
            items,
            text: items.map((item, index) => numbered ? `${index + 1}. ${item}` : `- ${item}`).join("\n"),
          });
          citations.push({ label: `${path.basename(resolved.absolutePath)} list ${sections.length}`, source, section: `list ${sections.length}` });
          blockCount += 1;
        }
        continue;
      }
      if (tag === "table") {
        const rows: string[][] = [];
        let headers: string[] | undefined;
        for (const row of element.querySelectorAll("tr")) {
          const headerCells = row.querySelectorAll("th");
          const cells = headerCells.length > 0 ? headerCells : row.querySelectorAll("td");
          const boundedCells = cells.map((cell) => budget.take(cell.text));
          if (headerCells.length > 0 && !headers) headers = boundedCells;
          else rows.push(boundedCells);
          if (budget.truncated) break;
        }
        if ((headers?.length ?? 0) > 0 || rows.some((row) => row.some(Boolean))) {
          tables.push({ headers, rows, section: `table ${tables.length + 1}` });
          citations.push({ label: `${path.basename(resolved.absolutePath)} table ${tables.length}`, source, section: `table ${tables.length}` });
          blockCount += 1;
        }
        continue;
      }
      if (cleanText(element.text)) {
        pushWarningOnce(
          warnings,
          "unsupported_structure",
          "Some DOCX structures were omitted because Phase 14 returns only headings, paragraphs, lists, and tables.",
        );
      }
    }

    if (budget.truncated) {
      warnings.push({
        code: "output_truncated",
        message: `DOCX text and structure were limited to ${maxChars} characters and ${maxBlocks} blocks.`,
      });
    }
    const summaryText = [
      ...sections.map((section) => section.text),
      ...tables.flatMap((table) => [table.headers ?? [], ...table.rows].flat()),
    ].join("\n");
    const result: DocumentReadResult = {
      format: "docx",
      source,
      metadata: core.metadata,
      summary: summarizeDocumentText(summaryText),
      sections,
      tables,
      citations,
      extractedChars: budget.used,
      truncated: budget.truncated,
      warnings,
    };
    const artifact = sourceArtifact({
      argsPath: args.path,
      absolutePath: resolved.absolutePath,
      workspaceRelativePath: resolved.workspaceRelativePath,
      artifactRef: resolved.artifactRef,
      sizeBytes: buffer.byteLength,
      context,
    });
    const timestamp = context.moduleContext.clock.now();
    return {
      toolName: "read_docx",
      callId: context.callId,
      startedAt: timestamp,
      endedAt: timestamp,
      success: true,
      output: JSON.stringify({
        format: result.format,
        source: result.source,
        metadata: result.metadata,
        summary: result.summary,
        sections: result.sections,
        tables: result.tables,
        truncated: result.truncated,
        warnings: result.warnings,
        citations: result.citations,
      }),
      structuredContent: result,
      artifacts: artifact ? [artifact] : [],
    };
  } catch (error) {
    if (error instanceof ToolArgumentError) throw error;
    return failureResult(
      {
        code: "docx_invalid_or_damaged",
        message: `The file is not a valid readable DOCX or is damaged: ${(error as Error).message}`,
      },
      context,
    );
  }
}

export const readDocxTool: RuntimeToolSpec = {
  name: "read_docx",
  displayName: "Read DOCX",
  description: "Read bounded headings, paragraphs, lists, tables, metadata, warnings, and citations from DOCX.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: documentReadBaseProperties,
  },
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "slow",
  groups: ["documents", "document-read", "docx"],
  selection: {
    groups: ["documents", "document-read", "docx"],
    keywords: [
      "read docx",
      "extract docx",
      "读取 docx",
      "阅读 docx",
      "解析 docx",
      "读取docx",
      "阅读docx",
      "解析docx",
      "查看docx",
      "读docx",
      "docx中的内容",
      "docx内容",
      "读取word文档",
      "阅读word文档",
      "解析word文档",
      "查看word文档",
    ],
    keywordGroups: [
      ["read", "docx"],
      ["inspect", "docx"],
      ["analyze", "docx"],
      ["extract", "docx"],
      ["读取", "docx"],
      ["阅读", "docx"],
      ["解析", "docx"],
      ["查看", "docx"],
      ["打开", "docx"],
      ["读", "docx"],
      ["看看", "docx"],
      ["分析", "docx"],
      ["总结", "docx"],
      ["提取", "docx"],
      ["读取", "word文档"],
      ["阅读", "word文档"],
      ["解析", "word文档"],
      ["打开", "word"],
      ["读", "word"],
      ["看看", "word"],
      ["查看", "word"],
    ],
    attachmentExtensions: [".docx"],
    mimeTypes: [DOCX_MIME_TYPE],
  },
  getAvailability: docxAvailability,
  resolveAccess: (rawArgs) => {
    const args = rawArgs as ReadDocumentArgs;
    return [
      {
        kind: "filesystem_read",
        paths: [args.path],
        reason: "Read the requested DOCX through the workspace or trusted-artifact path guard.",
      },
    ];
  },
  execute: (rawArgs, context) => executeReadDocx(rawArgs as ReadDocumentArgs, context),
};
