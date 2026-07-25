import { promises as fs } from "node:fs";
import path from "node:path";

import type { Paragraph as DocxParagraph, Table as DocxTable } from "docx";

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

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_PAGE_SIZES = {
  A4: [11_906, 16_838],
  Letter: [12_240, 15_840],
} as const;
const NUMBERING_REFERENCE = "deep-mix-numbered-list";

async function loadDocx(): Promise<typeof import("docx")> {
  return import("docx");
}

async function docxWriteAvailability(_context: ToolModuleContext): Promise<ToolAvailability> {
  try {
    await loadDocx();
    return { status: "available", available: true };
  } catch (error) {
    return {
      status: "unavailable",
      available: false,
      missingCapabilities: ["docx"],
      reason: `DOCX generation dependency is unavailable: ${(error as Error).message}`,
    };
  }
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/");
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

function warningDetails(codes: Set<string>): Array<{ code: string; message: string }> {
  const messages: Record<string, string> = {
    image_default_dimensions: "An image used the basic 320x180 default because dimensions were not fully specified.",
    table_columns_truncated: "A table exceeded 20 columns; extra columns were omitted.",
    table_rows_truncated: "A table exceeded 500 rows; extra rows were omitted.",
    metadata_fields_not_supported: "Creation date, modification date, or language metadata is outside the basic DOCX generator contract.",
    unsupported_block_omitted: "A future DocumentSpec block unsupported by this generator was omitted.",
  };
  return [...codes].map((code) => ({ code, message: messages[code] ?? code }));
}

async function renderDocx(
  args: WriteDocumentArgs,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  if (path.extname(args.outputPath).toLowerCase() !== ".docx") {
    throw new ToolArgumentError("write_docx outputPath must end with .docx.", { fieldPath: "/outputPath" });
  }
  const outputPath = context.moduleContext.paths.resolveWorkspace(args.outputPath);
  try {
    const existing = await fs.stat(outputPath);
    if (!existing.isFile()) {
      throw new ToolArgumentError("write_docx outputPath must identify a file.", { fieldPath: "/outputPath" });
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

  const docx = await loadDocx();
  const warnings = new Set<string>();
  const children: Array<DocxParagraph | DocxTable> = [];
  if (args.document.title) {
    children.push(new docx.Paragraph({ text: args.document.title, heading: docx.HeadingLevel.TITLE }));
  }

  for (let index = 0; index < args.document.blocks.length; index += 1) {
    const block = args.document.blocks[index]!;
    if (block.type === "paragraph") {
      children.push(new docx.Paragraph({ text: block.text }));
    } else if (block.type === "heading") {
      const heading = block.level === 1
        ? docx.HeadingLevel.HEADING_1
        : block.level === 2
          ? docx.HeadingLevel.HEADING_2
          : docx.HeadingLevel.HEADING_3;
      children.push(new docx.Paragraph({ text: block.text, heading }));
    } else if (block.type === "bullet_list") {
      children.push(...block.items.map((item) => new docx.Paragraph({ text: item, bullet: { level: 0 } })));
    } else if (block.type === "numbered_list") {
      children.push(...block.items.map((item) => new docx.Paragraph({
        text: item,
        numbering: { reference: NUMBERING_REFERENCE, level: 0 },
      })));
    } else if (block.type === "table") {
      const allRows = block.headers ? [block.headers, ...block.rows] : block.rows;
      const originalColumnCount = Math.max(0, ...allRows.map((row) => row.length));
      const columnCount = Math.min(originalColumnCount, 20);
      const renderedRows = allRows.slice(0, 500);
      if (columnCount < originalColumnCount) warnings.add("table_columns_truncated");
      if (renderedRows.length < allRows.length) warnings.add("table_rows_truncated");
      if (columnCount > 0 && renderedRows.length > 0) {
        children.push(new docx.Table({
          rows: renderedRows.map((row, rowIndex) => new docx.TableRow({
            tableHeader: Boolean(block.headers) && rowIndex === 0,
            children: Array.from({ length: columnCount }, (_, columnIndex) => new docx.TableCell({
              children: [new docx.Paragraph({ text: row[columnIndex] ?? "" })],
            })),
          })),
        }));
      }
    } else if (block.type === "page_break") {
      children.push(new docx.Paragraph({ children: [new docx.PageBreak()] }));
    } else if (block.type === "image") {
      const resolved = await context.moduleContext.paths.resolveReadable(block.source);
      const bytes = await resolved.readBytes();
      const type = imageKind(bytes);
      if (!type) {
        throw new ToolArgumentError("DOCX images must be valid PNG or JPEG files.", {
          fieldPath: `/document/blocks/${index}/source`,
        });
      }
      if (!block.width || !block.height) warnings.add("image_default_dimensions");
      const width = block.width ?? 320;
      const height = block.height ?? 180;
      children.push(new docx.Paragraph({
        children: [new docx.ImageRun({
          type,
          data: bytes,
          transformation: { width, height },
          altText: {
            name: block.alt ?? path.basename(resolved.absolutePath),
            title: block.alt,
            description: block.alt,
          },
        })],
      }));
    } else {
      warnings.add("unsupported_block_omitted");
    }
  }

  const metadata = args.document.metadata;
  if (metadata?.createdAt || metadata?.modifiedAt || metadata?.language) {
    warnings.add("metadata_fields_not_supported");
  }
  const basePageSize = DOCX_PAGE_SIZES[args.document.page?.size ?? "A4"];
  const orientation = args.document.page?.orientation === "landscape"
    ? docx.PageOrientation.LANDSCAPE
    : docx.PageOrientation.PORTRAIT;
  const document = new docx.Document({
    title: args.document.title ?? metadata?.title,
    creator: metadata?.author,
    subject: metadata?.subject,
    keywords: metadata?.keywords?.join(", "),
    numbering: {
      config: [{
        reference: NUMBERING_REFERENCE,
        levels: [{
          level: 0,
          format: docx.LevelFormat.DECIMAL,
          text: "%1.",
          alignment: docx.AlignmentType.START,
          style: {
            paragraph: {
              indent: { left: 720, hanging: 260 },
            },
          },
        }],
      }],
    },
    sections: [{
      properties: {
        page: {
          size: {
            width: basePageSize[0],
            height: basePageSize[1],
            orientation,
          },
          margin: {
            top: (args.document.page?.margins?.top ?? 50) * 20,
            right: (args.document.page?.margins?.right ?? 50) * 20,
            bottom: (args.document.page?.margins?.bottom ?? 50) * 20,
            left: (args.document.page?.margins?.left ?? 50) * 20,
          },
        },
      },
      children,
    }],
  });
  const buffer = await docx.Packer.toBuffer(document);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buffer);
  const relativePath = normalizeRelativePath(path.relative(context.workspaceRoot, outputPath));
  const renderedWarnings = warningDetails(warnings);
  const artifact: ToolOutputArtifact = {
    uri: `file://${relativePath}`,
    fileName: path.basename(outputPath),
    mimeType: DOCX_MIME_TYPE,
    sizeBytes: buffer.byteLength,
    kind: "document",
    sourceToolName: "write_docx",
    summary: "Generated a standard OOXML DOCX document.",
    createdAt: context.moduleContext.clock.now(),
    workspaceRelativePath: relativePath,
  };
  const timestamp = context.moduleContext.clock.now();
  return {
    toolName: "write_docx",
    callId: context.callId,
    startedAt: timestamp,
    endedAt: timestamp,
    success: true,
    output: JSON.stringify({
      outputPath: relativePath,
      sizeBytes: buffer.byteLength,
      warnings: renderedWarnings,
      artifact: { uri: artifact.uri, fileName: artifact.fileName, mimeType: artifact.mimeType },
    }),
    structuredContent: {
      format: "docx",
      outputPath: relativePath,
      sizeBytes: buffer.byteLength,
      warnings: renderedWarnings,
    },
    artifacts: [artifact],
  };
}

export const writeDocxTool: RuntimeToolSpec = {
  name: "write_docx",
  displayName: "Write DOCX",
  description: "Generate a standard DOCX from DocumentSpec through writable-path, checkpoint, artifact, and undo controls.",
  inputSchema: documentWriteInputSchema,
  readOnly: false,
  permissionCategory: "write_file",
  sideEffectLevel: "high",
  timeoutCategory: "slow",
  groups: ["documents", "document-write", "docx"],
  selection: {
    groups: ["documents", "document-write", "docx"],
    keywords: [
      "write docx",
      "create docx",
      "generate docx",
      "export docx",
      "生成 docx",
      "创建 docx",
      "写入 docx",
      "生成docx",
      "创建docx",
      "写入docx",
      "导出docx",
      "制作docx",
      "保存为docx",
      "输出docx",
      "生成word文档",
      "创建word文档",
      "导出word文档",
    ],
    keywordGroups: [
      ["write", "docx"],
      ["create", "docx"],
      ["generate", "docx"],
      ["export", "docx"],
      ["生成", "docx"],
      ["创建", "docx"],
      ["写入", "docx"],
      ["导出", "docx"],
      ["制作", "docx"],
      ["保存", "docx"],
      ["覆盖", "docx"],
      ["修改", "docx"],
      ["更新", "docx"],
      ["重写", "docx"],
      ["输出", "word"],
      ["生成", "word"],
      ["创建", "word"],
      ["制作", "word"],
      ["保存", "word"],
      ["生成", "word文档"],
      ["创建", "word文档"],
      ["导出", "word文档"],
      ["覆盖", "word"],
      ["修改", "word"],
      ["更新", "word"],
      ["重写", "word"],
    ],
  },
  checkpoint: {
    mode: "before_write",
    scope: "pre_tool_write",
    reason: "Before generating a DOCX document.",
  },
  getAvailability: docxWriteAvailability,
  resolveAccess: (rawArgs) => {
    const args = rawArgs as WriteDocumentArgs;
    const imageSources = listDocumentImageSources(args.document);
    return [
      {
        kind: "filesystem_write",
        paths: [args.outputPath],
        reason: "Generate the requested DOCX inside the writable workspace sandbox.",
      },
      ...(imageSources.length > 0
        ? [{
            kind: "filesystem_read" as const,
            paths: imageSources,
            reason: "Read declared DOCX image references through the readable path guard.",
          }]
        : []),
    ];
  },
  execute: (rawArgs, context) => renderDocx(rawArgs as WriteDocumentArgs, context),
};
