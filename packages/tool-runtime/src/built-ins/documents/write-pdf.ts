import { promises as fs } from "node:fs";
import path from "node:path";

import type { PDFDocument, PDFFont, PDFImage, PDFPage } from "pdf-lib";

import type {
  DocumentSpec,
  ToolAvailability,
  ToolOutputArtifact,
  ToolResult,
} from "../../../../shared-schema/src/index.js";
import { ToolArgumentError } from "../../index.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolModuleContext,
} from "../../tool-module.js";
import {
  documentWriteInputSchema,
  listDocumentImageSources,
  type WriteDocumentArgs,
} from "./contracts.js";

const PDF_MIME_TYPE = "application/pdf";
const PAGE_SIZES = {
  A4: [595.28, 841.89],
  Letter: [612, 792],
} as const;
const DEFAULT_MARGIN = 50;

async function loadPdfLib(): Promise<typeof import("pdf-lib")> {
  return import("pdf-lib");
}

async function pdfWriteAvailability(_context: ToolModuleContext): Promise<ToolAvailability> {
  try {
    await loadPdfLib();
    return { status: "available", available: true };
  } catch (error) {
    return {
      status: "unavailable",
      available: false,
      missingCapabilities: ["pdf-lib"],
      reason: `PDF generation dependency is unavailable: ${(error as Error).message}`,
    };
  }
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function safePdfText(value: string, warnings: Set<string>): string {
  let replaced = false;
  const safe = [...value].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\n" || character === "\t" || (code >= 32 && code <= 126)) return character;
    replaced = true;
    return "?";
  }).join("");
  if (replaced) warnings.add("unsupported_characters_replaced");
  return safe;
}

function wrapPdfText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const output: string[] = [];
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    if (!paragraph) {
      output.push("");
      continue;
    }
    const words = paragraph.split(/\s+/g).filter(Boolean);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) output.push(line);
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        line = word;
        continue;
      }
      let chunk = "";
      for (const character of word) {
        const candidateChunk = `${chunk}${character}`;
        if (chunk && font.widthOfTextAtSize(candidateChunk, size) > maxWidth) {
          output.push(chunk);
          chunk = character;
        } else {
          chunk = candidateChunk;
        }
      }
      line = chunk;
    }
    if (line) output.push(line);
  }
  return output.length > 0 ? output : [""];
}

function imageKind(bytes: Buffer): "png" | "jpg" | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return undefined;
}

class BasicPdfRenderer {
  private page!: PDFPage;

  private cursorY = 0;

  private readonly width: number;

  private readonly height: number;

  private readonly margins: { top: number; right: number; bottom: number; left: number };

  public readonly warnings = new Set<string>();

  public constructor(
    private readonly document: PDFDocument,
    private readonly regularFont: PDFFont,
    private readonly boldFont: PDFFont,
    spec: DocumentSpec,
    private readonly colors: {
      text: ReturnType<typeof import("pdf-lib")["rgb"]>;
      border: ReturnType<typeof import("pdf-lib")["rgb"]>;
      header: ReturnType<typeof import("pdf-lib")["rgb"]>;
    },
  ) {
    const base = PAGE_SIZES[spec.page?.size ?? "A4"];
    [this.width, this.height] = spec.page?.orientation === "landscape"
      ? [base[1], base[0]]
      : [base[0], base[1]];
    this.margins = {
      top: spec.page?.margins?.top ?? DEFAULT_MARGIN,
      right: spec.page?.margins?.right ?? DEFAULT_MARGIN,
      bottom: spec.page?.margins?.bottom ?? DEFAULT_MARGIN,
      left: spec.page?.margins?.left ?? DEFAULT_MARGIN,
    };
    if (this.contentWidth <= 40 || this.height - this.margins.top - this.margins.bottom <= 40) {
      throw new ToolArgumentError("Page margins leave no usable PDF content area.", {
        fieldPath: "/document/page/margins",
      });
    }
    this.newPage();
  }

  private get contentWidth(): number {
    return this.width - this.margins.left - this.margins.right;
  }

  private newPage(): void {
    this.page = this.document.addPage([this.width, this.height]);
    this.cursorY = this.height - this.margins.top;
  }

  public pageBreak(): void {
    this.newPage();
  }

  private ensureSpace(height: number): void {
    if (this.cursorY - height < this.margins.bottom) this.newPage();
  }

  public text(value: string, options: {
    size?: number;
    bold?: boolean;
    indent?: number;
    spacingAfter?: number;
  } = {}): void {
    const size = options.size ?? 11;
    const indent = options.indent ?? 0;
    const font = options.bold ? this.boldFont : this.regularFont;
    const lineHeight = size * 1.35;
    const safe = safePdfText(value, this.warnings);
    const lines = wrapPdfText(safe, font, size, Math.max(20, this.contentWidth - indent));
    for (const line of lines) {
      this.ensureSpace(lineHeight);
      if (line) {
        this.page.drawText(line, {
          x: this.margins.left + indent,
          y: this.cursorY - size,
          size,
          font,
          color: this.colors.text,
        });
      }
      this.cursorY -= lineHeight;
    }
    this.cursorY -= options.spacingAfter ?? 6;
  }

  public table(headers: string[] | undefined, rows: string[][]): void {
    const allRows = headers ? [headers, ...rows] : rows;
    const originalColumnCount = Math.max(0, ...allRows.map((row) => row.length));
    if (originalColumnCount === 0 || allRows.length === 0) return;
    const columnCount = Math.min(originalColumnCount, 20);
    const renderedRows = allRows.slice(0, 500);
    if (columnCount < originalColumnCount) this.warnings.add("table_columns_truncated");
    if (renderedRows.length < allRows.length) this.warnings.add("table_rows_truncated");
    const columnWidth = this.contentWidth / columnCount;
    const fontSize = 9;
    const lineHeight = 11;

    renderedRows.forEach((row, rowIndex) => {
      const isHeader = Boolean(headers) && rowIndex === 0;
      const font = isHeader ? this.boldFont : this.regularFont;
      const cells = Array.from({ length: columnCount }, (_, index) =>
        wrapPdfText(
          safePdfText(row[index] ?? "", this.warnings).slice(0, 2_000),
          font,
          fontSize,
          Math.max(10, columnWidth - 8),
        ));
      const maximumLines = Math.max(1, ...cells.map((cell) => cell.length));
      const pageLineLimit = Math.max(1, Math.floor((this.height - this.margins.top - this.margins.bottom - 10) / lineHeight));
      const renderedLineCount = Math.min(maximumLines, pageLineLimit);
      if (renderedLineCount < maximumLines) this.warnings.add("table_cell_text_truncated");
      const rowHeight = renderedLineCount * lineHeight + 8;
      this.ensureSpace(rowHeight);
      const rowBottom = this.cursorY - rowHeight;
      cells.forEach((cellLines, columnIndex) => {
        const x = this.margins.left + columnIndex * columnWidth;
        this.page.drawRectangle({
          x,
          y: rowBottom,
          width: columnWidth,
          height: rowHeight,
          borderColor: this.colors.border,
          borderWidth: 0.6,
          color: isHeader ? this.colors.header : undefined,
        });
        cellLines.slice(0, renderedLineCount).forEach((line, lineIndex) => {
          if (!line) return;
          this.page.drawText(line, {
            x: x + 4,
            y: this.cursorY - 4 - fontSize - lineIndex * lineHeight,
            size: fontSize,
            font,
            color: this.colors.text,
          });
        });
      });
      this.cursorY = rowBottom;
    });
    this.cursorY -= 8;
  }

  public async image(
    image: PDFImage,
    options: { width?: number; height?: number; alt?: string },
  ): Promise<void> {
    const intrinsic = image.scale(1);
    let width = options.width ?? (options.height ? intrinsic.width * options.height / intrinsic.height : intrinsic.width);
    let height = options.height ?? (options.width ? intrinsic.height * options.width / intrinsic.width : intrinsic.height);
    const maxWidth = this.contentWidth;
    const maxHeight = this.height - this.margins.top - this.margins.bottom;
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    width *= scale;
    height *= scale;
    this.ensureSpace(height + 6);
    this.page.drawImage(image, {
      x: this.margins.left,
      y: this.cursorY - height,
      width,
      height,
    });
    this.cursorY -= height + 6;
    if (options.alt) this.text(options.alt, { size: 9, spacingAfter: 6 });
  }
}

function warningDetails(codes: Set<string>): Array<{ code: string; message: string }> {
  const messages: Record<string, string> = {
    unsupported_characters_replaced: "Characters unsupported by the built-in PDF standard font were replaced with '?'.",
    table_columns_truncated: "A table exceeded 20 columns; extra columns were omitted.",
    table_rows_truncated: "A table exceeded 500 rows; extra rows were omitted.",
    table_cell_text_truncated: "A table cell exceeded one printable page; excess cell text was omitted.",
    invalid_created_date_ignored: "The document creation date was invalid and was not written.",
    invalid_modified_date_ignored: "The document modification date was invalid and was not written.",
    unsupported_block_omitted: "A future DocumentSpec block unsupported by this renderer was omitted.",
  };
  return [...codes].map((code) => ({ code, message: messages[code] ?? code }));
}

async function renderPdf(
  args: WriteDocumentArgs,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  if (path.extname(args.outputPath).toLowerCase() !== ".pdf") {
    throw new ToolArgumentError("write_pdf outputPath must end with .pdf.", { fieldPath: "/outputPath" });
  }
  const outputPath = context.moduleContext.paths.resolveWorkspace(args.outputPath);
  try {
    const existing = await fs.stat(outputPath);
    if (!existing.isFile()) {
      throw new ToolArgumentError("write_pdf outputPath must identify a file.", { fieldPath: "/outputPath" });
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

  const pdfLib = await loadPdfLib();
  const document = await pdfLib.PDFDocument.create();
  const regularFont = await document.embedFont(pdfLib.StandardFonts.Helvetica);
  const boldFont = await document.embedFont(pdfLib.StandardFonts.HelveticaBold);
  const renderer = new BasicPdfRenderer(document, regularFont, boldFont, args.document, {
    text: pdfLib.rgb(0.12, 0.14, 0.17),
    border: pdfLib.rgb(0.72, 0.74, 0.78),
    header: pdfLib.rgb(0.94, 0.95, 0.97),
  });

  const metadata = args.document.metadata;
  if (args.document.title ?? metadata?.title) document.setTitle(args.document.title ?? metadata!.title!);
  if (metadata?.author) document.setAuthor(metadata.author);
  if (metadata?.subject) document.setSubject(metadata.subject);
  if (metadata?.keywords?.length) document.setKeywords(metadata.keywords);
  if (metadata?.language) document.setLanguage(metadata.language);
  if (metadata?.createdAt) {
    const date = new Date(metadata.createdAt);
    if (Number.isNaN(date.getTime())) renderer.warnings.add("invalid_created_date_ignored");
    else document.setCreationDate(date);
  }
  if (metadata?.modifiedAt) {
    const date = new Date(metadata.modifiedAt);
    if (Number.isNaN(date.getTime())) renderer.warnings.add("invalid_modified_date_ignored");
    else document.setModificationDate(date);
  }

  if (args.document.title) renderer.text(args.document.title, { size: 24, bold: true, spacingAfter: 14 });
  for (let index = 0; index < args.document.blocks.length; index += 1) {
    const block = args.document.blocks[index]!;
    if (block.type === "paragraph") {
      renderer.text(block.text);
    } else if (block.type === "heading") {
      renderer.text(block.text, {
        size: block.level === 1 ? 20 : block.level === 2 ? 16 : 14,
        bold: true,
        spacingAfter: 9,
      });
    } else if (block.type === "bullet_list" || block.type === "numbered_list") {
      block.items.forEach((item, itemIndex) => {
        const prefix = block.type === "bullet_list" ? "- " : `${itemIndex + 1}. `;
        renderer.text(`${prefix}${item}`, { indent: 14, spacingAfter: 2 });
      });
    } else if (block.type === "table") {
      renderer.table(block.headers, block.rows);
    } else if (block.type === "page_break") {
      renderer.pageBreak();
    } else if (block.type === "image") {
      const resolved = await context.moduleContext.paths.resolveReadable(block.source);
      const bytes = await resolved.readBytes();
      const kind = imageKind(bytes);
      if (!kind) {
        throw new ToolArgumentError("PDF images must be valid PNG or JPEG files.", {
          fieldPath: `/document/blocks/${index}/source`,
        });
      }
      const image = kind === "png" ? await document.embedPng(bytes) : await document.embedJpg(bytes);
      await renderer.image(image, block);
    } else {
      renderer.warnings.add("unsupported_block_omitted");
    }
  }

  const bytes = await document.save();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, bytes);
  const relativePath = normalizeRelativePath(path.relative(context.workspaceRoot, outputPath));
  const warnings = warningDetails(renderer.warnings);
  const artifact: ToolOutputArtifact = {
    uri: `file://${relativePath}`,
    fileName: path.basename(outputPath),
    mimeType: PDF_MIME_TYPE,
    sizeBytes: bytes.byteLength,
    kind: "document",
    sourceToolName: "write_pdf",
    summary: `Generated ${document.getPageCount()}-page PDF.`,
    createdAt: context.moduleContext.clock.now(),
    workspaceRelativePath: relativePath,
  };
  const timestamp = context.moduleContext.clock.now();
  return {
    toolName: "write_pdf",
    callId: context.callId,
    startedAt: timestamp,
    endedAt: timestamp,
    success: true,
    output: JSON.stringify({
      outputPath: relativePath,
      pageCount: document.getPageCount(),
      sizeBytes: bytes.byteLength,
      warnings,
      artifact: { uri: artifact.uri, fileName: artifact.fileName, mimeType: artifact.mimeType },
    }),
    structuredContent: {
      format: "pdf",
      outputPath: relativePath,
      pageCount: document.getPageCount(),
      sizeBytes: bytes.byteLength,
      warnings,
    },
    artifacts: [artifact],
  };
}

export const writePdfTool: RuntimeToolSpec = {
  name: "write_pdf",
  displayName: "Write PDF",
  description: "Generate a basic PDF from DocumentSpec through writable-path, checkpoint, artifact, and undo controls.",
  inputSchema: documentWriteInputSchema,
  readOnly: false,
  permissionCategory: "write_file",
  sideEffectLevel: "high",
  timeoutCategory: "slow",
  groups: ["documents", "document-write", "pdf"],
  selection: {
    groups: ["documents", "document-write", "pdf"],
    keywords: [
      "write pdf",
      "create pdf",
      "generate pdf",
      "export pdf",
      "生成 pdf",
      "创建 pdf",
      "写入 pdf",
      "生成pdf",
      "创建pdf",
      "写入pdf",
      "导出pdf",
      "制作pdf",
      "保存为pdf",
      "输出pdf",
    ],
    keywordGroups: [
      ["write", "pdf"],
      ["create", "pdf"],
      ["generate", "pdf"],
      ["export", "pdf"],
      ["生成", "pdf"],
      ["创建", "pdf"],
      ["写入", "pdf"],
      ["导出", "pdf"],
      ["制作", "pdf"],
      ["保存", "pdf"],
      ["覆盖", "pdf"],
      ["修改", "pdf"],
      ["更新", "pdf"],
      ["重写", "pdf"],
    ],
  },
  checkpoint: {
    mode: "before_write",
    scope: "pre_tool_write",
    reason: "Before generating a PDF document.",
  },
  getAvailability: pdfWriteAvailability,
  resolveAccess: (rawArgs) => {
    const args = rawArgs as WriteDocumentArgs;
    const imageSources = listDocumentImageSources(args.document);
    return [
      {
        kind: "filesystem_write",
        paths: [args.outputPath],
        reason: "Generate the requested PDF inside the writable workspace sandbox.",
      },
      ...(imageSources.length > 0
        ? [{
            kind: "filesystem_read" as const,
            paths: imageSources,
            reason: "Read declared PDF image references through the readable path guard.",
          }]
        : []),
    ];
  },
  execute: (rawArgs, context) => renderPdf(rawArgs as WriteDocumentArgs, context),
};
