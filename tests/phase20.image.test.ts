import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../packages/persistence/src/index.js";
import type { ImageMetadataResult } from "../packages/shared-schema/src/index.js";
import { ToolRuntime } from "../packages/tool-runtime/src/index.js";
import { builtInToolModules } from "../packages/tool-runtime/src/built-ins/index.js";
import { PHASE20_LIMITS } from "../packages/tool-runtime/src/built-ins/structured-documents/format-policy.js";
import {
  imagesToolModule,
  readImageTool,
} from "../packages/tool-runtime/src/built-ins/structured-documents/images.js";

const temporaryRoots: string[] = [];

interface ImageFixture {
  workspaceRoot: string;
  sessionStore: SessionStore;
  runtime: ToolRuntime;
  sessionId: string;
}

interface ImageResult extends ImageMetadataResult {
  visionWorkerHint: {
    toolName: "invoke_vision_worker";
    automaticInvocation: false;
    reason: string;
  };
}

async function createRuntime(): Promise<ImageFixture> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase20-image-"));
  temporaryRoots.push(workspaceRoot);
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("inspect bounded image metadata without OCR");
  const runtime = new ToolRuntime({
    workspaceRoot,
    sessionStore,
    permissionMode: "danger-full-access",
    modules: [imagesToolModule],
  });
  return { workspaceRoot, sessionStore, runtime, sessionId: session.sessionId };
}

function imageBody(result: Awaited<ReturnType<ToolRuntime["executeManualTool"]>>): ImageResult {
  return result.structuredContent as ImageResult;
}

function baseImage(width = 12, height = 8) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 20, g: 80, b: 160, alpha: 0.75 },
    },
  });
}

async function createFormatFixtures(root: string): Promise<Array<{
  fileName: string;
  format: ImageResult["format"];
  mimeType: string;
  hasAlpha: boolean;
}>> {
  const fixtures = [
    { fileName: "small.png", format: "png", mimeType: "image/png", hasAlpha: true },
    { fileName: "small.jpg", format: "jpeg", mimeType: "image/jpeg", hasAlpha: false },
    { fileName: "small.webp", format: "webp", mimeType: "image/webp", hasAlpha: true },
    { fileName: "small.gif", format: "gif", mimeType: "image/gif", hasAlpha: true },
    { fileName: "small.tiff", format: "tiff", mimeType: "image/tiff", hasAlpha: true },
  ] as const;
  await Promise.all([
    baseImage().png().toFile(path.join(root, "small.png")),
    baseImage().jpeg({ quality: 85 }).toFile(path.join(root, "small.jpg")),
    baseImage().webp({ quality: 85 }).toFile(path.join(root, "small.webp")),
    baseImage().gif({ effort: 1 }).toFile(path.join(root, "small.gif")),
    baseImage().tiff({ compression: "lzw" }).toFile(path.join(root, "small.tiff")),
  ]);
  return fixtures.map((fixture) => ({ ...fixture }));
}

function crc32(input: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngWithDeclaredDimensions(source: Buffer, width: number, height: number): Buffer {
  const output = Buffer.from(source);
  expect(output.subarray(12, 16).toString("ascii")).toBe("IHDR");
  output.writeUInt32BE(width, 16);
  output.writeUInt32BE(height, 20);
  output.writeUInt32BE(crc32(output.subarray(12, 29)), 29);
  return output;
}

function warningText(body: ImageResult): string {
  return body.warnings
    .map((warning) => `${warning.code} ${warning.message} ${JSON.stringify(warning.details ?? {})}`)
    .join("\n");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("phase 20 read_image", () => {
  it("reads real Sharp-generated PNG, JPEG, WebP, GIF, and TIFF technical metadata", async () => {
    const fixture = await createRuntime();
    const formats = await createFormatFixtures(fixture.workspaceRoot);

    for (const expected of formats) {
      const result = await fixture.runtime.executeManualTool(
        "read_image",
        { path: expected.fileName },
        fixture.sessionId,
      );
      const body = imageBody(result);
      expect(result.success, `${expected.fileName}: ${result.output}`).toBe(true);
      expect(body).toMatchObject({
        format: expected.format,
        source: {
          kind: "workspace_path",
          workspaceRelativePath: expected.fileName,
          mimeType: expected.mimeType,
          sizeBytes: expect.any(Number),
        },
        metadata: {
          width: 12,
          height: 8,
          pixelCount: 96,
          colorSpace: expect.any(String),
          channels: expect.any(Number),
          bitDepth: expect.any(String),
          frameCount: 1,
          hasAlpha: expected.hasAlpha,
          sizeBytes: expect.any(Number),
        },
        truncation: { truncated: false },
        visionWorkerHint: {
          toolName: "invoke_vision_worker",
          automaticInvocation: false,
          reason: expect.any(String),
        },
      });
      expect(body.metadata.sizeBytes).toBe(body.source.sizeBytes);
      expect(result.output.length).toBeLessThanOrEqual(PHASE20_LIMITS.maxModelVisibleChars);
      expect(body.preview).toBeUndefined();
      expect(result.artifacts ?? []).toHaveLength(0);
      expect(warningText(body)).toMatch(/OCR|semantic|vision/iu);
    }
  });

  it("returns orientation and a safe EXIF summary while redacting GPS and raw EXIF values", async () => {
    const fixture = await createRuntime();
    const gpsLatitude = "31/1 14/1 0/1";
    const gpsLongitude = "121/1 28/1 0/1";
    await baseImage()
      .jpeg({ quality: 90 })
      .withMetadata({ orientation: 6, density: 144 })
      .withExifMerge({
        IFD0: { Artist: "Deep-Mix safe fixture" },
        IFD3: {
          GPSLatitudeRef: "N",
          GPSLatitude: gpsLatitude,
          GPSLongitudeRef: "E",
          GPSLongitude: gpsLongitude,
        },
      })
      .toFile(path.join(fixture.workspaceRoot, "gps.jpg"));

    const result = await fixture.runtime.executeManualTool(
      "read_image",
      { path: "gps.jpg", includeExifSummary: true },
      fixture.sessionId,
    );
    const body = imageBody(result);
    expect(result.success, result.output).toBe(true);
    expect(body.metadata).toMatchObject({
      width: 12,
      height: 8,
      orientation: 6,
      densityDpi: 144,
      exif: expect.any(Object),
    });
    const visible = JSON.stringify(body);
    expect(visible).not.toContain(gpsLatitude);
    expect(visible).not.toContain(gpsLongitude);
    expect(visible).not.toContain(Buffer.from(gpsLatitude).toString("base64"));
    expect(JSON.stringify(body.metadata.exif)).not.toMatch(/latitude|longitude|gps.{0,20}(31|121)/iu);
    expect(body.warnings).toContainEqual(expect.objectContaining({
      code: "metadata_redacted",
      category: "security",
    }));
    expect(body.warnings).toContainEqual(expect.objectContaining({
      code: "image_gps_redacted",
      category: "security",
    }));
    expect(warningText(body)).toMatch(/GPS/iu);
  });

  it("creates a bounded persisted WebP preview artifact without inline binary or base64", async () => {
    const fixture = await createRuntime();
    await baseImage(120, 60).png().toFile(path.join(fixture.workspaceRoot, "preview-source.png"));

    const result = await fixture.runtime.executeManualTool(
      "read_image",
      { path: "preview-source.png", preview: { maxEdge: 64 } },
      fixture.sessionId,
    );
    const body = imageBody(result);
    expect(result.success, result.output).toBe(true);
    expect(body.preview).toMatchObject({
      uri: expect.stringMatching(/^artifact:\/\/tool-outputs\//u),
      fileName: expect.stringMatching(/\.webp$/u),
      mimeType: "image/webp",
      kind: "image",
      sourceToolName: "read_image",
      sizeBytes: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(result.artifacts).toEqual([expect.objectContaining({ uri: body.preview!.uri })]);
    const artifactPath = fixture.sessionStore.resolveToolOutputArtifactPath(body.preview!.uri);
    const previewBytes = await fs.readFile(artifactPath);
    const previewMetadata = await sharp(previewBytes).metadata();
    expect(previewMetadata.format).toBe("webp");
    expect(Math.max(previewMetadata.width, previewMetadata.height)).toBeLessThanOrEqual(64);
    expect(previewMetadata).toMatchObject({ width: 64, height: 32 });
    expect(previewBytes.byteLength).toBe(body.preview!.sizeBytes);
    expect(result.output).not.toContain(previewBytes.toString("base64").slice(0, 100));
    expect(result.output).not.toMatch(/data:image\//iu);
    expect(result.output.length).toBeLessThanOrEqual(PHASE20_LIMITS.maxModelVisibleChars);
    expect((await fixture.sessionStore.listToolOutputArtifacts(fixture.sessionId))).toContainEqual(
      expect.objectContaining({ uri: body.preview!.uri, mimeType: "image/webp", sourceToolName: "read_image" }),
    );
  });

  it("enforces the 100M pixel budget from headers without decoding and the 64 MiB file limit", async () => {
    const fixture = await createRuntime();
    const tiny = await baseImage(2, 2).png().toBuffer();
    await fs.writeFile(
      path.join(fixture.workspaceRoot, "exact-budget.png"),
      pngWithDeclaredDimensions(tiny, 10_000, 10_000),
    );
    await fs.writeFile(
      path.join(fixture.workspaceRoot, "over-budget.png"),
      pngWithDeclaredDimensions(tiny, 10_001, 10_000),
    );
    const tooLargePath = path.join(fixture.workspaceRoot, "too-large.png");
    await fs.writeFile(tooLargePath, tiny);
    const tooLargeHandle = await fs.open(tooLargePath, "r+");
    try {
      await tooLargeHandle.truncate(PHASE20_LIMITS.image.maxInputBytes + 1);
    } finally {
      await tooLargeHandle.close();
    }

    const exact = await fixture.runtime.executeManualTool(
      "read_image",
      { path: "exact-budget.png" },
      fixture.sessionId,
    );
    expect(exact.success, exact.output).toBe(true);
    expect(imageBody(exact).metadata).toMatchObject({
      width: 10_000,
      height: 10_000,
      pixelCount: PHASE20_LIMITS.image.maxPixels,
    });
    expect(imageBody(exact).preview).toBeUndefined();

    for (const [fileName, code] of [
      ["over-budget.png", "image_pixel_budget_exceeded"],
      ["too-large.png", "image_too_large"],
    ] as const) {
      const result = await fixture.runtime.executeManualTool(
        "read_image",
        { path: fileName },
        fixture.sessionId,
      );
      expect(result.success, `${fileName}: ${result.output}`).toBe(false);
      expect(result.structuredContent).toMatchObject({
        kind: "image_error",
        format: expect.stringMatching(/png|unknown/u),
        code,
        error: { type: "command_failed", retryable: false, toolName: "read_image" },
      });
    }
  });

  it("returns structured failures for corrupt, format-spoofed, and unsupported images", async () => {
    const fixture = await createRuntime();
    const jpeg = await baseImage().jpeg().toBuffer();
    await fs.writeFile(
      path.join(fixture.workspaceRoot, "corrupt.png"),
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("damaged")]),
    );
    await fs.writeFile(path.join(fixture.workspaceRoot, "spoofed.png"), jpeg);
    await fs.writeFile(
      path.join(fixture.workspaceRoot, "unsupported.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>',
      "utf8",
    );

    for (const [fileName, code] of [
      ["corrupt.png", "image_corrupt"],
      ["spoofed.png", "format_mismatch"],
      ["unsupported.svg", "unsupported_format"],
    ] as const) {
      const result = await fixture.runtime.executeManualTool(
        "read_image",
        { path: fileName },
        fixture.sessionId,
      );
      expect(result.success, `${fileName}: ${result.output}`).toBe(false);
      expect(result.structuredContent).toMatchObject({
        kind: "image_error",
        code,
        error: { type: "command_failed", retryable: false, toolName: "read_image" },
      });
    }
  });

  it("rejects strict-schema violations and never accepts cursor or flat preview controls", async () => {
    const fixture = await createRuntime();
    await baseImage().png().toFile(path.join(fixture.workspaceRoot, "schema.png"));
    for (const args of [
      { path: "schema.png", cursor: "0" },
      { path: "schema.png", preview: true },
      { path: "schema.png", preview: { maxEdge: 63 } },
      { path: "schema.png", preview: { maxEdge: PHASE20_LIMITS.image.maxPreviewEdge + 1 } },
      { path: "schema.png", preview: { maxEdge: 64, extra: true } },
      { path: "schema.png", previewMaxEdge: 64 },
      { path: "schema.png", includeExifSummary: "yes" },
      { path: "schema.png", extra: true },
    ]) {
      const result = await fixture.runtime.executeManualTool("read_image", args, fixture.sessionId);
      expect(result, JSON.stringify(args)).toMatchObject({
        success: false,
        structuredContent: {
          error: { type: "invalid_arguments", retryable: false, toolName: "read_image" },
        },
      });
    }
  });

  it("does not perform OCR, semantic analysis, network access, or implicit worker invocation", async () => {
    const fixture = await createRuntime();
    await baseImage().png().toFile(path.join(fixture.workspaceRoot, "inert.png"));
    const previousFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("read_image must not access the network.");
    }) as typeof fetch;
    let result: Awaited<ReturnType<ToolRuntime["executeManualTool"]>>;
    try {
      result = await fixture.runtime.executeManualTool(
        "read_image",
        { path: "inert.png" },
        fixture.sessionId,
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
    const body = imageBody(result!);
    expect(result!.success, result!.output).toBe(true);
    expect(fetchCalls).toBe(0);
    expect(body.visionWorkerHint).toMatchObject({
      toolName: "invoke_vision_worker",
      automaticInvocation: false,
      reason: expect.stringMatching(/semantic|understand|OCR|vision/iu),
    });
    expect(result!.output).toContain("invoke_vision_worker");
    expect(body.warnings).toContainEqual(expect.objectContaining({
      code: "unsupported_capability",
      severity: "info",
    }));
    expect(warningText(body)).toMatch(/does not|not perform|no OCR|without OCR/iu);

    const implementation = await fs.readFile(
      path.join(process.cwd(), "packages/tool-runtime/src/built-ins/structured-documents/images.ts"),
      "utf8",
    );
    expect(implementation).not.toMatch(/from\s+["']node:(?:child_process|http|https|net|tls|worker_threads)["']/u);
    expect(implementation).not.toMatch(/from\s+["'][^"']*(?:tesseract|ocr|vision)[^"']*["']/iu);
    expect(implementation).not.toMatch(/\b(?:fetch|eval)\s*\(/u);
    expect(implementation).not.toMatch(/\b(?:invokeVisionWorker|invoke_worker|invokeWorker)\s*\(/u);
  });

  it("guards traversal, protected, and junction image paths", async () => {
    const fixture = await createRuntime();
    for (const [inputPath, expectedType] of [
      ["../outside.png", "invalid_path"],
      [".deep-mix/api-key-library/blocked.png", "sandbox_denied"],
    ] as const) {
      const result = await fixture.runtime.executeManualTool(
        "read_image",
        { path: inputPath },
        fixture.sessionId,
      );
      expect(result).toMatchObject({
        success: false,
        structuredContent: {
          error: { type: expectedType, retryable: false, toolName: "read_image" },
        },
      });
    }

    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase20-image-outside-"));
    temporaryRoots.push(outsideRoot);
    await baseImage().png().toFile(path.join(outsideRoot, "outside.png"));
    await fs.symlink(outsideRoot, path.join(fixture.workspaceRoot, "outside-link"), "junction");
    const linked = await fixture.runtime.executeManualTool(
      "read_image",
      { path: "outside-link/outside.png" },
      fixture.sessionId,
    );
    expect(linked).toMatchObject({
      success: false,
      structuredContent: {
        error: { type: "invalid_path", retryable: false, toolName: "read_image" },
      },
    });
  });

  it("declares stable schema, read permission, capability probe, registry, and format selection metadata", async () => {
    const fixture = await createRuntime();
    await fixture.runtime.initialize();
    const definition = fixture.runtime.listRegisteredToolDefinitions().find((tool) => tool.name === "read_image");
    expect(definition).toMatchObject({
      name: "read_image",
      readOnly: true,
      permissionCategory: "read_only",
      sideEffectLevel: "none",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: expect.any(Object),
          includeExifSummary: { type: "boolean", default: false },
          preview: {
            type: "object",
            additionalProperties: false,
            properties: {
              maxEdge: expect.objectContaining({
                type: "integer",
                minimum: 64,
                maximum: PHASE20_LIMITS.image.maxPreviewEdge,
              }),
            },
          },
        },
      },
      selection: {
        attachmentExtensions: expect.arrayContaining([".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff"]),
        mimeTypes: expect.arrayContaining(["image/png", "image/jpeg", "image/webp", "image/gif", "image/tiff"]),
        keywords: expect.any(Array),
        keywordGroups: expect.any(Array),
      },
    });
    expect(Object.keys((definition!.inputSchema as { properties: Record<string, unknown> }).properties)).not.toContain("cursor");
    expect(readImageTool.getAvailability).toEqual(expect.any(Function));
    expect(fixture.runtime.listAvailableToolDefinitions().map((tool) => tool.name)).toContain("read_image");
    expect(builtInToolModules.map((module) => module.manifest.id)).toContain("builtin.images");
    expect(fixture.runtime.selectToolsForTurn({ attachmentExtensions: [".png"] }).definitions.map((tool) => tool.name))
      .toContain("read_image");
    expect(fixture.runtime.selectToolsForTurn({ attachmentMimeTypes: ["image/webp"] }).definitions.map((tool) => tool.name))
      .toContain("read_image");
    expect(fixture.runtime.selectToolsForTurn({ prompt: "Read the dimensions and metadata of this TIFF image." }).definitions.map((tool) => tool.name))
      .toContain("read_image");
    expect(fixture.runtime.selectToolsForTurn({ prompt: "Refactor this TypeScript function." }).definitions.map((tool) => tool.name))
      .not.toContain("read_image");
  });
});
