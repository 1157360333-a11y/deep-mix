import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  ImageFormat,
  ImageMetadataResult,
  StructuredDocumentWarning,
  StructuredJsonValue,
  StructuredSourceReference,
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
import { PHASE20_LIMITS } from "./format-policy.js";

const IMAGE_MIME_TYPES: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  tiff: "image/tiff",
};

export interface ReadImageArgs {
  path: string;
  includeExifSummary?: boolean;
  preview?: {
    maxEdge?: number;
  };
}

type ImageFailureCode =
  | "unsupported_format"
  | "format_mismatch"
  | "image_too_large"
  | "image_pixel_budget_exceeded"
  | "image_frame_budget_exceeded"
  | "image_corrupt"
  | "sharp_dependency_unavailable"
  | "preview_too_large"
  | "output_too_large";

interface ImageFailure {
  code: ImageFailureCode;
  message: string;
  dependency?: string;
}

type SharpFactory = typeof import("sharp")["default"];
type SharpMetadata = Awaited<ReturnType<ReturnType<SharpFactory>["metadata"]>>;

function moduleDefault<T>(module: unknown): T {
  return ((module as { default?: T }).default ?? module) as T;
}

async function loadSharp(): Promise<SharpFactory> {
  return moduleDefault<SharpFactory>(await import("sharp"));
}

export async function readImageAvailability(_context: ToolModuleContext): Promise<ToolAvailability> {
  try {
    const sharp = await loadSharp();
    if (typeof sharp !== "function") throw new Error("sharp did not expose its image factory");
    return { status: "available", available: true };
  } catch (error) {
    return {
      status: "unavailable",
      available: false,
      missingCapabilities: ["image_metadata", "image_preview"],
      reason: `Image metadata and preview capability is unavailable because sharp could not load: ${(error as Error).message}`,
    };
  }
}

function formatFromExtension(absolutePath: string): ImageFormat | undefined {
  const extension = path.extname(absolutePath).toLowerCase();
  if (extension === ".png") return "png";
  if (extension === ".jpg" || extension === ".jpeg") return "jpeg";
  if (extension === ".webp") return "webp";
  if (extension === ".gif") return "gif";
  if (extension === ".tif" || extension === ".tiff") return "tiff";
  return undefined;
}

function formatFromMagic(buffer: Buffer): ImageFormat | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  const gif = buffer.subarray(0, 6).toString("ascii");
  if (gif === "GIF87a" || gif === "GIF89a") return "gif";
  if (buffer.length >= 4) {
    const header = buffer.subarray(0, 4).toString("hex");
    if (header === "49492a00" || header === "4d4d002a") return "tiff";
  }
  return undefined;
}

function sourceReference(
  requestedPath: string,
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
  return {
    kind: "workspace_path",
    reference: resolved.workspaceRelativePath ?? requestedPath,
    workspaceRelativePath: resolved.workspaceRelativePath,
    mimeType,
    sizeBytes,
  };
}

function failureResult(
  failure: ImageFailure,
  context: RuntimeToolExecutionContext,
  format: ImageFormat | "unknown" = "unknown",
): ToolResult {
  const timestamp = context.moduleContext.clock.now();
  const error: ToolStructuredError = {
    type: failure.dependency ? "missing_dependency" : "command_failed",
    message: failure.message,
    retryable: false,
    toolName: "read_image",
    dependency: failure.dependency,
  };
  const body = { kind: "image_error", format, code: failure.code, error };
  return {
    toolName: "read_image",
    callId: context.callId,
    startedAt: timestamp,
    endedAt: timestamp,
    success: false,
    output: JSON.stringify(body),
    structuredContent: body,
    error: failure.message,
  };
}

function gpsTagPresent(exif: Buffer): boolean {
  for (let index = 0; index + 1 < exif.length; index += 1) {
    if ((exif[index] === 0x88 && exif[index + 1] === 0x25) || (exif[index] === 0x25 && exif[index + 1] === 0x88)) return true;
  }
  return /GPS|latitude|longitude/iu.test(exif.toString("latin1"));
}

function safeExifSummary(metadata: SharpMetadata): Record<string, StructuredJsonValue> | undefined {
  if (!metadata.exif) return undefined;
  return {
    present: true,
    byteLength: metadata.exif.byteLength,
    rawValuesExposed: false,
    locationValuesExposed: false,
    ...(metadata.orientation ? { orientation: metadata.orientation } : {}),
    ...(metadata.density ? { densityDpi: metadata.density } : {}),
  };
}


function sharpFormat(metadata: SharpMetadata): ImageFormat | undefined {
  return metadata.format === "png" || metadata.format === "jpeg" || metadata.format === "webp"
    || metadata.format === "gif" || metadata.format === "tiff"
    ? metadata.format
    : undefined;
}

function validateMetadataBudget(metadata: SharpMetadata): ImageFailure | undefined {
  const width = metadata.width;
  const rawHeight = metadata.height;
  if (!width || !rawHeight || !Number.isSafeInteger(width) || !Number.isSafeInteger(rawHeight) || width < 1 || rawHeight < 1) {
    return { code: "image_corrupt", message: "Image metadata did not contain valid positive integer dimensions." };
  }
  const frameCount = Math.max(1, metadata.pages ?? 1);
  if (!Number.isSafeInteger(frameCount) || frameCount > PHASE20_LIMITS.image.maxFrames) {
    return {
      code: "image_frame_budget_exceeded",
      message: `Image has ${String(metadata.pages ?? frameCount)} frames/pages, exceeding the ${PHASE20_LIMITS.image.maxFrames}-frame limit.`,
    };
  }
  const frameHeight = metadata.pageHeight && frameCount > 1 ? metadata.pageHeight : rawHeight;
  if (!Number.isSafeInteger(frameHeight) || frameHeight < 1) {
    return { code: "image_corrupt", message: "Image metadata reported an invalid frame height." };
  }
  if (width > PHASE20_LIMITS.image.maxPixels / frameHeight / frameCount) {
    return {
      code: "image_pixel_budget_exceeded",
      message: `Image decode budget exceeds ${PHASE20_LIMITS.image.maxPixels.toLocaleString("en-US")} total pixels across all frames/pages.`,
    };
  }
  return undefined;
}

function metadataDimensions(metadata: SharpMetadata): {
  width: number;
  height: number;
  frameCount: number;
  pixelCount: number;
} {
  const width = metadata.width!;
  const frameCount = Math.max(1, metadata.pages ?? 1);
  const height = metadata.pageHeight && frameCount > 1 ? metadata.pageHeight : metadata.height!;
  return { width, height, frameCount, pixelCount: width * height * frameCount };
}

async function generatePreview(sharp: SharpFactory, buffer: Buffer, maxEdge: number): Promise<Buffer | undefined> {
  const candidates = [
    { edge: maxEdge, quality: 80 },
    { edge: Math.max(64, Math.floor(maxEdge / 2)), quality: 65 },
    { edge: 64, quality: 45 },
  ].filter((candidate, index, all) => all.findIndex((entry) => entry.edge === candidate.edge && entry.quality === candidate.quality) === index);
  for (const candidate of candidates) {
    const preview = await sharp(buffer, {
      animated: false,
      failOn: "warning",
      limitInputPixels: PHASE20_LIMITS.image.maxPixels,
    })
      .rotate()
      .resize({ width: candidate.edge, height: candidate.edge, fit: "inside", withoutEnlargement: true })
      .webp({ quality: candidate.quality, effort: 4 })
      .toBuffer();
    if (preview.byteLength <= PHASE20_LIMITS.image.maxPreviewBytes) return preview;
  }
  return undefined;
}

function sharpFailure(error: unknown): ImageFailure {
  const message = (error as Error).message || String(error);
  if ((error as Error).name === "SharpDependencyError") {
    return { code: "sharp_dependency_unavailable", message, dependency: "sharp" };
  }
  if (/pixel limit|input image exceeds pixel|too many pixels/iu.test(message)) {
    return { code: "image_pixel_budget_exceeded", message: `Image exceeds the safe pixel decode budget: ${message}` };
  }
  return { code: "image_corrupt", message: `Image is damaged, truncated, or unsupported by the bounded decoder: ${message}` };
}

function metadataWarnings(metadata: SharpMetadata): StructuredDocumentWarning[] {
  const warnings: StructuredDocumentWarning[] = [structuredWarning("unsupported_capability", {
    severity: "info",
    category: "unsupported_capability",
    message: "read_image returned technical metadata only. It did not perform OCR, semantic image analysis, or implicitly invoke a vision worker.",
    details: { ocrPerformed: false, semanticAnalysisPerformed: false, visionWorkerInvoked: false },
  })];
  if (metadata.exif) {
    warnings.push(structuredWarning("metadata_redacted", {
      severity: "warning",
      category: "security",
      message: "Raw EXIF and potentially identifying metadata were withheld; only an optional bounded technical summary may be returned.",
      details: { rawExifExposed: false },
    }));
    if (gpsTagPresent(metadata.exif)) {
      warnings.push(structuredWarning("image_gps_redacted", {
        severity: "high",
        category: "security",
        details: { locationValuesExposed: false },
      }));
    }
  }
  return warnings;
}
export async function executeReadImage(args: ReadImageArgs, context: RuntimeToolExecutionContext): Promise<ToolResult> {
  const resolved = await context.moduleContext.paths.resolveReadable(args.path);
  const stat = await fs.stat(resolved.absolutePath);
  if (!stat.isFile()) throw new ToolArgumentError("read_image path must identify a regular file.", { fieldPath: "/path" });
  const expectedFormat = formatFromExtension(resolved.absolutePath);
  if (stat.size > PHASE20_LIMITS.image.maxInputBytes) {
    return failureResult({
      code: "image_too_large",
      message: `Image input exceeds the ${PHASE20_LIMITS.image.maxInputBytes / 1024 / 1024} MiB safety limit.`,
    }, context, expectedFormat);
  }
  if (!expectedFormat) {
    return failureResult({
      code: "unsupported_format",
      message: "read_image supports only PNG, JPEG, WebP, GIF, and TIFF extensions.",
    }, context, "unknown");
  }
  const buffer = await resolved.readBytes();
  if (buffer.byteLength > PHASE20_LIMITS.image.maxInputBytes) {
    return failureResult({
      code: "image_too_large",
      message: `Image bytes exceed the ${PHASE20_LIMITS.image.maxInputBytes / 1024 / 1024} MiB safety limit after the guarded read.`,
    }, context, expectedFormat);
  }
  const magicFormat = formatFromMagic(buffer);
  if (!magicFormat || magicFormat !== expectedFormat) {
    return failureResult({
      code: "format_mismatch",
      message: `Image extension declares ${expectedFormat.toUpperCase()}, but the file signature ${magicFormat ? `declares ${magicFormat.toUpperCase()}` : "is not a supported image signature"}.`,
    }, context, expectedFormat);
  }

  let sharp: SharpFactory;
  try {
    sharp = await loadSharp();
  } catch (error) {
    const dependencyError = new Error(`sharp is unavailable: ${(error as Error).message}`);
    dependencyError.name = "SharpDependencyError";
    return failureResult(sharpFailure(dependencyError), context, expectedFormat);
  }

  let metadata: SharpMetadata;
  try {
    metadata = await sharp(buffer, {
      animated: true,
      failOn: "warning",
      limitInputPixels: PHASE20_LIMITS.image.maxPixels,
    }).metadata();
  } catch (error) {
    return failureResult(sharpFailure(error), context, expectedFormat);
  }
  const decodedFormat = sharpFormat(metadata);
  if (!decodedFormat || decodedFormat !== expectedFormat || decodedFormat !== magicFormat) {
    return failureResult({
      code: "format_mismatch",
      message: `Image decoder identified ${decodedFormat?.toUpperCase() ?? "an unsupported format"}, which does not match the extension and signature.`,
    }, context, expectedFormat);
  }
  const budgetFailure = validateMetadataBudget(metadata);
  if (budgetFailure) return failureResult(budgetFailure, context, expectedFormat);

  const warnings = metadataWarnings(metadata);
  let preview: ToolOutputArtifact | undefined;
  if (args.preview) {
    let previewBytes: Buffer | undefined;
    try {
      previewBytes = await generatePreview(sharp, buffer, args.preview.maxEdge ?? PHASE20_LIMITS.image.defaultPreviewEdge);
    } catch (error) {
      return failureResult(sharpFailure(error), context, expectedFormat);
    }
    if (!previewBytes) {
      return failureResult({
        code: "preview_too_large",
        message: `A bounded WebP preview could not fit within the ${PHASE20_LIMITS.image.maxPreviewBytes / 1024 / 1024} MiB preview limit.`,
      }, context, expectedFormat);
    }
    preview = await context.moduleContext.persistence.storeToolOutputArtifact({
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.callId,
      sourceToolName: "read_image",
      fileName: `${path.basename(resolved.absolutePath, path.extname(resolved.absolutePath))}.preview.webp`,
      mimeType: "image/webp",
      kind: "image",
      summary: "Bounded technical preview only; no OCR or semantic image analysis was performed.",
      content: previewBytes,
      signal: context.signal,
    });
  }

  const dimensions = metadataDimensions(metadata);
  const result: ImageMetadataResult = {
    format: decodedFormat,
    source: sourceReference(args.path, resolved, buffer.byteLength, IMAGE_MIME_TYPES[decodedFormat]),
    metadata: {
      sizeBytes: buffer.byteLength,
      creatorApplication: "sharp bounded metadata reader",
      width: dimensions.width,
      height: dimensions.height,
      pixelCount: dimensions.pixelCount,
      colorSpace: metadata.space,
      channels: metadata.channels,
      bitDepth: metadata.depth,
      densityDpi: metadata.density,
      orientation: metadata.orientation,
      frameCount: dimensions.frameCount,
      hasAlpha: metadata.hasAlpha,
      isProgressive: metadata.isProgressive,
      exif: args.includeExifSummary ? safeExifSummary(metadata) : undefined,
      properties: {
        mimeType: IMAGE_MIME_TYPES[decodedFormat],
        previewGenerated: Boolean(preview),
        rawExifExposed: false,
        ocrPerformed: false,
        semanticAnalysisPerformed: false,
      },
    },
    warnings,
    truncation: { truncated: false, returnedItems: 1, totalItems: 1 },
    preview,
    visionWorkerHint: {
      toolName: "invoke_vision_worker",
      automaticInvocation: false,
      reason: "For OCR or semantic interpretation, explicitly invoke the configured Vision Worker with the original image reference; read_image never does so automatically.",
    },
  };
  const serialized = JSON.stringify(result);
  if (serialized.length > PHASE20_LIMITS.maxModelVisibleChars) {
    return failureResult({
      code: "output_too_large",
      message: "Image metadata result exceeds the model-visible output character limit.",
    }, context, expectedFormat);
  }
  const timestamp = context.moduleContext.clock.now();
  return {
    toolName: "read_image",
    callId: context.callId,
    startedAt: timestamp,
    endedAt: timestamp,
    success: true,
    output: serialized,
    structuredContent: result,
    artifacts: preview ? [preview] : [],
  };
}

export const readImageTool: RuntimeToolSpec = {
  name: "read_image",
  displayName: "Read Image Metadata",
  description: "Read bounded PNG, JPEG, WebP, GIF, or TIFF technical metadata and optionally create an artifact-only WebP preview; never performs OCR, semantic analysis, or implicit vision-worker calls.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: pathPropertySchema,
      includeExifSummary: { type: "boolean", default: false },
      preview: {
        type: "object",
        additionalProperties: false,
        properties: {
          maxEdge: {
            type: "integer",
            minimum: 64,
            maximum: PHASE20_LIMITS.image.maxPreviewEdge,
            default: PHASE20_LIMITS.image.defaultPreviewEdge,
          },
        },
      },
    },
  },
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "slow",
  groups: ["documents", "media", "image", "image-read"],
  selection: {
    groups: ["documents", "media", "image", "image-read"],
    keywords: [
      "read image metadata", "inspect image", "image dimensions", "image technical info",
      "读取图片元数据", "检查图片", "图片尺寸", "图片技术信息",
    ],
    keywordGroups: [
      ["read", "image", "metadata"], ["inspect", "image"], ["image", "dimensions"],
      ["读取", "图片", "元数据"], ["检查", "图片"], ["图片", "尺寸"],
    ],
    attachmentExtensions: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff"],
    mimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif", "image/tiff"],
  },
  getAvailability: readImageAvailability,
  resolveAccess: (rawArgs) => [{
    kind: "filesystem_read",
    paths: [(rawArgs as ReadImageArgs).path],
    reason: "Read the requested image through the workspace or trusted-artifact guard for bounded technical metadata only.",
  }],
  execute: (rawArgs, context) => executeReadImage(rawArgs as ReadImageArgs, context),
};

export const imagesToolModule: ToolModule = {
  manifest: {
    id: "builtin.images",
    version: "1.0.0",
    description: "Bounded technical image metadata and artifact-only preview tools with an explicit configured Vision Worker boundary.",
    source: "built_in",
  },
  create: () => [readImageTool],
};
