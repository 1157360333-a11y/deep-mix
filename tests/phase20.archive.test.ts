import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { deflateRawSync } from "node:zlib";

import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../packages/persistence/src/index.js";
import type {
  ArchiveListResult,
  ToolOutputArtifact,
} from "../packages/shared-schema/src/index.js";
import { ToolRuntime } from "../packages/tool-runtime/src/index.js";
import { builtInToolModules } from "../packages/tool-runtime/src/built-ins/index.js";
import { recoveryToolModule } from "../packages/tool-runtime/src/built-ins/recovery/index.js";
import {
  archiveManageTool,
  archivesToolModule,
} from "../packages/tool-runtime/src/built-ins/structured-documents/archives.js";
import { PHASE20_LIMITS } from "../packages/tool-runtime/src/built-ins/structured-documents/format-policy.js";

const temporaryRoots: string[] = [];

interface ArchiveFixture {
  workspaceRoot: string;
  sessionStore: SessionStore;
  runtime: ToolRuntime;
  sessionId: string;
}

interface RawZipEntryInput {
  name: string;
  nameBytes?: Buffer;
  data?: Buffer | string;
  method?: number;
  flags?: number;
  utf8?: boolean;
  extra?: Buffer;
  externalAttributes?: number;
  versionMadeBy?: number;
  declaredCompressedSize?: number;
  declaredUncompressedSize?: number;
  declaredCrc32?: number;
}

interface ArchiveListBody extends ArchiveListResult {
  action: "list";
  capabilities: Record<string, unknown>;
}

interface ArchiveCreateBody {
  action: "create";
  format: "zip";
  outputPath: string;
  sizeBytes: number;
  entryCount: number;
  artifact: ToolOutputArtifact;
  warnings: Array<{ code: string; message: string }>;
  checkpointId: string;
  undoAvailable: boolean;
  capabilities: Record<string, unknown>;
}

interface ArchiveExtractBody {
  action: "extract";
  format: "zip";
  outputDirectory: string;
  entriesExtracted: number;
  totalBytes: number;
  manifestArtifact: ToolOutputArtifact;
  warnings: Array<{ code: string; message: string }>;
  checkpointId: string;
  undoAvailable: boolean;
  capabilities: Record<string, unknown>;
}

interface ExtractionManifest {
  version: 1;
  format: "zip";
  source: {
    kind: "workspace_path" | "artifact" | "attachment";
    reference: string;
    workspaceRelativePath?: string;
    artifactUri?: string;
    mimeType?: string;
    sizeBytes?: number;
  };
  outputDirectory: string;
  createdAt: string;
  entries: Array<{ path: string; sizeBytes: number; sha256: string }>;
  entryCount: number;
  totalBytes: number;
}

async function createRuntime(): Promise<ArchiveFixture> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase20-archive-"));
  temporaryRoots.push(workspaceRoot);
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("manage ZIP archives through bounded safe paths");
  const runtime = new ToolRuntime({
    workspaceRoot,
    sessionStore,
    permissionMode: "danger-full-access",
    modules: [archivesToolModule, recoveryToolModule],
  });
  return { workspaceRoot, sessionStore, runtime, sessionId: session.sessionId };
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

function normalizeTestPath(value: string): string {
  return value.replace(/\\/gu, "/");
}

function rawZip(entries: readonly RawZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const input of entries) {
    const name = input.nameBytes ?? Buffer.from(input.name, "utf8");
    const extra = input.extra ?? Buffer.alloc(0);
    const plain = typeof input.data === "string" ? Buffer.from(input.data, "utf8") : (input.data ?? Buffer.alloc(0));
    const method = input.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(plain) : plain;
    const flags = (input.flags ?? 0) | (input.utf8 === false ? 0 : 0x0800);
    const compressedSize = input.declaredCompressedSize ?? compressed.byteLength;
    const uncompressedSize = input.declaredUncompressedSize ?? plain.byteLength;
    const checksum = input.declaredCrc32 ?? crc32(plain);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x0403_4b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(name.byteLength, 26);
    localHeader.writeUInt16LE(extra.byteLength, 28);
    const local = Buffer.concat([localHeader, name, extra, compressed]);
    localParts.push(local);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x0201_4b50, 0);
    centralHeader.writeUInt16LE(input.versionMadeBy ?? 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt16LE(extra.byteLength, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(input.externalAttributes ?? 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(Buffer.concat([centralHeader, name, extra]));
    localOffset += local.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function unicodePathExtra(rawName: Buffer, unicodeName: string): Buffer {
  const encoded = Buffer.from(unicodeName, "utf8");
  const data = Buffer.alloc(5 + encoded.byteLength);
  data[0] = 1;
  data.writeUInt32LE(crc32(rawName), 1);
  encoded.copy(data, 5);
  const field = Buffer.alloc(4 + data.byteLength);
  field.writeUInt16LE(0x7075, 0);
  field.writeUInt16LE(data.byteLength, 2);
  data.copy(field, 4);
  return field;
}

async function writeZip(fixture: ArchiveFixture, fileName: string, entries: readonly RawZipEntryInput[]): Promise<string> {
  const absolutePath = path.join(fixture.workspaceRoot, fileName);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, rawZip(entries));
  return absolutePath;
}

function listBody(result: Awaited<ReturnType<ToolRuntime["executeManualTool"]>>): ArchiveListBody {
  return result.structuredContent as ArchiveListBody;
}

function createBody(result: Awaited<ReturnType<ToolRuntime["executeManualTool"]>>): ArchiveCreateBody {
  return result.structuredContent as ArchiveCreateBody;
}

function extractBody(result: Awaited<ReturnType<ToolRuntime["executeManualTool"]>>): ArchiveExtractBody {
  return result.structuredContent as ArchiveExtractBody;
}

function warningEvidence(value: { warnings: Array<{ code: string; message: string }> }): string {
  return value.warnings.map((warning) => `${warning.code} ${warning.message}`).join("\n");
}

async function expectArchiveFailure(
  result: Awaited<ReturnType<ToolRuntime["executeManualTool"]>>,
  action: "list" | "create" | "extract",
  code: string,
): Promise<void> {
  expect(result.success, result.output).toBe(false);
  expect(result.structuredContent).toMatchObject({
    kind: "archive_error",
    action,
    format: expect.stringMatching(/zip|unknown/u),
    code,
    error: { type: "command_failed", retryable: false, toolName: "archive_manage" },
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("phase 20 archive_manage", () => {
  it("lists ZIP entries with stable fields and cursor pagination without creating a checkpoint", async () => {
    const fixture = await createRuntime();
    await writeZip(fixture, "representative.zip", [
      { name: "alpha.txt", data: "alpha", method: 8 },
      { name: "folder/", data: "" },
      { name: "folder/beta.txt", data: "beta", method: 8 },
    ]);

    const first = await fixture.runtime.executeManualTool(
      "archive_manage",
      { action: "list", archivePath: "representative.zip", cursor: "0", maxEntries: 1 },
      fixture.sessionId,
    );
    const firstBody = listBody(first);
    expect(first.success, first.output).toBe(true);
    expect(firstBody).toMatchObject({
      action: "list",
      format: "zip",
      source: {
        kind: "workspace_path",
        workspaceRelativePath: "representative.zip",
        mimeType: "application/zip",
      },
      totalEntries: 3,
      returnedEntries: 1,
      totalCompressedBytes: expect.any(Number),
      totalUncompressedBytes: 9,
      truncation: {
        truncated: true,
        reason: "pagination",
        returnedItems: 1,
        totalItems: 3,
        nextCursor: "1",
      },
      capabilities: expect.any(Object),
    });
    expect(firstBody.entries[0]).toMatchObject({
      path: "alpha.txt",
      kind: "file",
      compressedSize: expect.any(Number),
      uncompressedSize: 5,
      compressionRatio: expect.any(Number),
      encrypted: false,
      unsafe: false,
      warnings: [],
    });
    expect(firstBody.warnings).toContainEqual(expect.objectContaining({ code: "output_truncated" }));
    expect(first.output.length).toBeLessThanOrEqual(PHASE20_LIMITS.maxModelVisibleChars);
    expect(await fixture.sessionStore.listUndoCandidates(fixture.sessionId)).toHaveLength(0);

    const second = await fixture.runtime.executeManualTool(
      "archive_manage",
      { action: "list", archivePath: "representative.zip", cursor: firstBody.truncation.nextCursor, maxEntries: 2 },
      fixture.sessionId,
    );
    const secondBody = listBody(second);
    expect(second.success, second.output).toBe(true);
    expect(secondBody.entries.map((entry) => entry.path)).toEqual(["folder/", "folder/beta.txt"]);
    expect(secondBody.entries.map((entry) => entry.kind)).toEqual(["directory", "file"]);
    expect(secondBody.truncation).toMatchObject({ truncated: false, returnedItems: 2, totalItems: 3 });
  });

  it("decodes CP437 and Info-ZIP Unicode Path entry names without lossy replacement", async () => {
    const fixture = await createRuntime();
    const cp437Name = Buffer.from([0x63, 0x61, 0x66, 0x82, 0x2e, 0x74, 0x78, 0x74]);
    const fallbackName = Buffer.from("fallback.txt", "ascii");
    await writeZip(fixture, "encoded-names.zip", [
      { name: "café.txt", nameBytes: cp437Name, utf8: false, data: "cp437" },
      {
        name: "文件.txt",
        nameBytes: fallbackName,
        utf8: false,
        extra: unicodePathExtra(fallbackName, "文件.txt"),
        data: "unicode-extra",
      },
    ]);
    const listed = await fixture.runtime.executeManualTool(
      "archive_manage",
      { action: "list", archivePath: "encoded-names.zip" },
      fixture.sessionId,
    );
    const body = listBody(listed);
    expect(listed.success, listed.output).toBe(true);
    expect(body.entries.map((entry) => entry.path)).toEqual(["café.txt", "文件.txt"]);
    expect(body.entries.every((entry) => !entry.unsafe)).toBe(true);
    expect(listed.output).not.toContain("�");

    const extracted = await fixture.runtime.executeManualTool(
      "archive_manage",
      { action: "extract", archivePath: "encoded-names.zip", outputDirectory: "out/encoded" },
      fixture.sessionId,
    );
    expect(extracted.success, extracted.output).toBe(true);
    expect(await fs.readFile(path.join(fixture.workspaceRoot, "out/encoded/café.txt"), "utf8")).toBe("cp437");
    expect(await fs.readFile(path.join(fixture.workspaceRoot, "out/encoded/文件.txt"), "utf8")).toBe("unicode-extra");
  });

  it("creates a ZIP from explicit regular files only and returns a checkpointed artifact with new-file undo", async () => {
    const fixture = await createRuntime();
    await fs.mkdir(path.join(fixture.workspaceRoot, "inputs/sub"), { recursive: true });
    await fs.writeFile(path.join(fixture.workspaceRoot, "inputs/alpha.txt"), "alpha", "utf8");
    await fs.writeFile(path.join(fixture.workspaceRoot, "inputs/sub/beta.txt"), "beta", "utf8");
    const streamedPayload = randomBytes(512 * 1024);
    await fs.writeFile(path.join(fixture.workspaceRoot, "inputs/stream.bin"), streamedPayload);
    await fs.writeFile(path.join(fixture.workspaceRoot, "inputs/not-listed-secret.txt"), "not listed", "utf8");

    const result = await fixture.runtime.executeManualTool(
      "archive_manage",
      {
        action: "create",
        outputPath: "out/created.zip",
        paths: ["inputs/alpha.txt", "inputs/sub/beta.txt", "inputs/stream.bin"],
      },
      fixture.sessionId,
    );
    const body = createBody(result);
    expect(result.success, result.output).toBe(true);
    expect(body).toMatchObject({
      action: "create",
      format: "zip",
      outputPath: "out/created.zip",
      sizeBytes: expect.any(Number),
      entryCount: 3,
      checkpointId: expect.any(String),
      undoAvailable: true,
      artifact: {
        uri: "file://out/created.zip",
        fileName: "created.zip",
        mimeType: "application/zip",
        kind: "binary",
        sourceToolName: "archive_manage",
        workspaceRelativePath: "out/created.zip",
      },
      capabilities: expect.any(Object),
    });
    expect(result.artifacts).toContainEqual(expect.objectContaining({ uri: body.artifact.uri }));
    expect((await fixture.sessionStore.listToolOutputArtifacts(fixture.sessionId))).toContainEqual(
      expect.objectContaining({ uri: body.artifact.uri, sourceToolName: "archive_manage" }),
    );
    expect((await fixture.sessionStore.listUndoCandidates(fixture.sessionId)).map((candidate) => candidate.checkpointId))
      .toContain(body.checkpointId);

    const outputPath = path.join(fixture.workspaceRoot, "out/created.zip");
    const outputBytes = await fs.readFile(outputPath);
    expect(body.artifact.sha256).toBe(createHash("sha256").update(outputBytes).digest("hex"));
    expect(body.artifact.sizeBytes).toBe(outputBytes.byteLength);
    const archive = await JSZip.loadAsync(outputBytes, { checkCRC32: true });
    const files = Object.keys(archive.files).filter((name) => !archive.files[name]!.dir);
    expect(files).toHaveLength(3);
    expect(files.some((name) => name.endsWith("alpha.txt"))).toBe(true);
    expect(files.some((name) => name.endsWith("sub/beta.txt"))).toBe(true);
    expect(files.some((name) => name.endsWith("stream.bin"))).toBe(true);
    expect(files.some((name) => name.includes("not-listed-secret"))).toBe(false);
    expect(await archive.file(files.find((name) => name.endsWith("alpha.txt"))!)!.async("string")).toBe("alpha");
    expect(await archive.file(files.find((name) => name.endsWith("stream.bin"))!)!.async("nodebuffer"))
      .toEqual(streamedPayload);

    const undone = await fixture.runtime.executeManualTool(
      "undo",
      { checkpointId: body.checkpointId, mode: "code" },
      fixture.sessionId,
    );
    expect(undone.success, undone.output).toBe(true);
    await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe create inputs and restores exact overwritten ZIP bytes through undo", async () => {
    const fixture = await createRuntime();
    await fs.writeFile(path.join(fixture.workspaceRoot, "safe.txt"), "safe", "utf8");

    for (const [candidate, expectedType] of [
      ["../outside.txt", "invalid_path"],
      [".deep-mix/api-key-library/blocked.txt", "sandbox_denied"],
    ] as const) {
      const result = await fixture.runtime.executeManualTool(
        "archive_manage",
        { action: "create", outputPath: `blocked-${expectedType}.zip`, paths: [candidate] },
        fixture.sessionId,
      );
      expect(result).toMatchObject({
        success: false,
        structuredContent: { error: { type: expectedType, retryable: false, toolName: "archive_manage" } },
      });
    }

    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase20-archive-outside-"));
    temporaryRoots.push(outsideRoot);
    await fs.writeFile(path.join(outsideRoot, "outside.txt"), "outside", "utf8");
    await fs.symlink(outsideRoot, path.join(fixture.workspaceRoot, "outside-link"), "junction");
    const linked = await fixture.runtime.executeManualTool(
      "archive_manage",
      { action: "create", outputPath: "linked.zip", paths: ["outside-link/outside.txt"] },
      fixture.sessionId,
    );
    expect(linked).toMatchObject({
      success: false,
      structuredContent: { error: { type: "invalid_path", retryable: false, toolName: "archive_manage" } },
    });

    const oversizedSource = path.join(fixture.workspaceRoot, "oversized-source.bin");
    const oversizedHandle = await fs.open(oversizedSource, "w");
    try {
      await oversizedHandle.truncate(PHASE20_LIMITS.archive.maxCreateSourceBytes + 1);
    } finally {
      await oversizedHandle.close();
    }
    const oversized = await fixture.runtime.executeManualTool(
      "archive_manage",
      { action: "create", outputPath: "oversized.zip", paths: ["oversized-source.bin"] },
      fixture.sessionId,
    );
    expect(oversized).toMatchObject({
      success: false,
      structuredContent: { error: { type: "invalid_arguments", retryable: false, toolName: "archive_manage" } },
    });
    expect(oversized.output).toMatch(/64 MiB|source limit|in-memory/iu);
    await expect(fs.stat(path.join(fixture.workspaceRoot, "oversized.zip"))).rejects.toMatchObject({ code: "ENOENT" });

    const existingPath = path.join(fixture.workspaceRoot, "existing.zip");
    const original = rawZip([{ name: "original.txt", data: "original bytes" }]);
    await fs.writeFile(existingPath, original);
    const denied = await fixture.runtime.executeManualTool(
      "archive_manage",
      { action: "create", outputPath: "existing.zip", paths: ["safe.txt"] },
      fixture.sessionId,
    );
    expect(denied).toMatchObject({
      success: false,
      structuredContent: { error: { type: "invalid_arguments", fieldPath: "/overwrite" } },
    });
    expect(await fs.readFile(existingPath)).toEqual(original);

    const overwritten = await fixture.runtime.executeManualTool(
      "archive_manage",
      { action: "create", outputPath: "existing.zip", paths: ["safe.txt"], overwrite: true },
      fixture.sessionId,
    );
    const overwrittenBody = createBody(overwritten);
    expect(overwritten.success, overwritten.output).toBe(true);
    expect(await fs.readFile(existingPath)).not.toEqual(original);
    const undone = await fixture.runtime.executeManualTool(
      "undo",
      { checkpointId: overwrittenBody.checkpointId, mode: "code" },
      fixture.sessionId,
    );
    expect(undone.success, undone.output).toBe(true);
    expect(await fs.readFile(existingPath)).toEqual(original);
  });

  it("extracts a valid ZIP only to a new directory, persists a manifest artifact, and undoes all files", async () => {
    const fixture = await createRuntime();
    await writeZip(fixture, "valid.zip", [
      { name: "alpha.txt", data: "alpha", method: 8 },
      { name: "nested/beta.bin", data: Buffer.from([0, 1, 2, 3, 255]), method: 8 },
    ]);
    const result = await fixture.runtime.executeManualTool(
      "archive_manage",
      { action: "extract", archivePath: "valid.zip", outputDirectory: "out/extracted" },
      fixture.sessionId,
    );
    const body = extractBody(result);
    expect(result.success, result.output).toBe(true);
    expect(body).toMatchObject({
      action: "extract",
      format: "zip",
      outputDirectory: "out/extracted",
      entriesExtracted: 2,
      totalBytes: 10,
      checkpointId: expect.any(String),
      undoAvailable: true,
      manifestArtifact: {
        uri: expect.stringMatching(/^artifact:\/\/tool-outputs\//u),
        fileName: expect.stringMatching(/\.json$/u),
        mimeType: "application/json",
        sourceToolName: "archive_manage",
      },
      capabilities: expect.any(Object),
    });
    expect(result.artifacts).toContainEqual(expect.objectContaining({ uri: body.manifestArtifact.uri }));
    expect(await fs.readFile(path.join(fixture.workspaceRoot, "out/extracted/alpha.txt"), "utf8")).toBe("alpha");
    expect(await fs.readFile(path.join(fixture.workspaceRoot, "out/extracted/nested/beta.bin"))).toEqual(
      Buffer.from([0, 1, 2, 3, 255]),
    );

    const manifestPath = fixture.sessionStore.resolveToolOutputArtifactPath(body.manifestArtifact.uri);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as ExtractionManifest;
    expect(manifest).toMatchObject({
      version: 1,
      format: "zip",
      source: {
        kind: "workspace_path",
        reference: "valid.zip",
        workspaceRelativePath: "valid.zip",
        mimeType: "application/zip",
      },
      outputDirectory: "out/extracted",
      entryCount: 2,
      totalBytes: 10,
      entries: expect.arrayContaining([
        { path: "alpha.txt", sizeBytes: 5, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
        { path: "nested/beta.bin", sizeBytes: 5, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      ]),
    });
    expect(result.output).not.toContain(Buffer.from([0, 1, 2, 3, 255]).toString("base64"));
    expect(result.output.length).toBeLessThanOrEqual(PHASE20_LIMITS.maxModelVisibleChars);

    const undone = await fixture.runtime.executeManualTool(
      "undo",
      { checkpointId: body.checkpointId, mode: "code" },
      fixture.sessionId,
    );
    expect(undone.success, undone.output).toBe(true);
    await expect(fs.stat(path.join(fixture.workspaceRoot, "out/extracted"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports path traversal variants, symlink/special entries, and rejects extraction before staging", async () => {
    const fixture = await createRuntime();
    const unixSymlink = (0o120777 << 16) >>> 0;
    const unixFifo = (0o010644 << 16) >>> 0;
    const unsafeNames = [
      "../escape.txt",
      "/absolute.txt",
      "\\\\server\\share\\evil.txt",
      "C:\\drive-escape.txt",
      "folder\\..\\backslash-escape.txt",
      "safe.txt:stream",
      "CON.txt",
      "folder/trailing. ",
    ];
    await writeZip(fixture, "unsafe-paths.zip", [
      ...unsafeNames.map((name) => ({ name, data: "unsafe" })),
      { name: "link", data: "../outside", versionMadeBy: 0x0314, externalAttributes: unixSymlink },
      { name: "fifo", data: "", versionMadeBy: 0x0314, externalAttributes: unixFifo },
    ]);

    const listed = await fixture.runtime.executeManualTool(
      "archive_manage",
      { action: "list", archivePath: "unsafe-paths.zip", maxEntries: 100 },
      fixture.sessionId,
    );
    const body = listBody(listed);
    expect(listed.success, listed.output).toBe(true);
    expect(body.entries).toHaveLength(unsafeNames.length + 2);
    expect(body.entries.every((entry) => entry.unsafe)).toBe(true);
    for (const name of unsafeNames) {
      expect(body.entries).toContainEqual(expect.objectContaining({
        path: name,
        unsafe: true,
        unsafeReason: expect.any(String),
      }));
    }
    expect(body.entries).toContainEqual(expect.objectContaining({ path: "link", kind: "symlink", unsafe: true }));
    expect(body.entries).toContainEqual(expect.objectContaining({ path: "fifo", kind: "other", unsafe: true }));
    expect(warningEvidence(body)).toMatch(/unsafe|path|symlink|special/iu);

    const destination = path.join(fixture.workspaceRoot, "out/unsafe-extract");
    const extracted = await fixture.runtime.executeManualTool(
      "archive_manage",
      { action: "extract", archivePath: "unsafe-paths.zip", outputDirectory: "out/unsafe-extract" },
      fixture.sessionId,
    );
    expect(extracted.success).toBe(false);
    expect(JSON.stringify(extracted.structuredContent)).toMatch(/archive_(?:unsafe_path|symlink_or_special)/u);
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects case-insensitive collisions and leaves no destination or staging residue", async () => {
    const fixture = await createRuntime();
    await writeZip(fixture, "collision.zip", [
      { name: "Folder/File.txt", data: "one" },
      { name: "folder/file.TXT", data: "two" },
    ]);
    const listed = await fixture.runtime.executeManualTool(
      "archive_manage",
      { action: "list", archivePath: "collision.zip" },
      fixture.sessionId,
    );
    const listedBody = listBody(listed);
    expect(listed.success, listed.output).toBe(true);
    expect(listedBody.entries.some((entry) => entry.unsafe)).toBe(true);
    expect(listedBody.entries.map((entry) => entry.unsafeReason).join("\n")).toMatch(/collision|case/iu);

    const extracted = await fixture.runtime.executeManualTool(
      "archive_manage",
      { action: "extract", archivePath: "collision.zip", outputDirectory: "out/collision" },
      fixture.sessionId,
    );
    await expectArchiveFailure(extracted, "extract", "archive_path_collision");
    await expect(fs.stat(path.join(fixture.workspaceRoot, "out/collision"))).rejects.toMatchObject({ code: "ENOENT" });
    const outEntries = await fs.readdir(path.join(fixture.workspaceRoot, "out")).catch(() => [] as string[]);
    expect(outEntries.some((entry) => /collision.*(?:stage|tmp)|(?:stage|tmp).*collision/iu.test(entry))).toBe(false);
  });

  it("blocks ratio bombs, oversized entries, and archives over the entry-count limit", async () => {
    const fixture = await createRuntime();
    await writeZip(fixture, "ratio-bomb.zip", [
      { name: "zeros.bin", data: Buffer.alloc(50_000, 0), method: 8 },
    ]);
    await writeZip(fixture, "oversized-entry.zip", [{
      name: "declared-huge.bin",
      // Keep the compressed size above 1/100 of the declared expanded size so
      // this fixture isolates the single-entry limit from the ratio limit.
      data: randomBytes(3 * 1024 * 1024),
      method: 8,
      declaredUncompressedSize: PHASE20_LIMITS.archive.maxSingleEntryBytes + 1,
    }]);
    const manyEntries = Array.from({ length: PHASE20_LIMITS.archive.maxEntries + 1 }, (_, index) => ({
      name: `entry-${String(index).padStart(5, "0")}.txt`,
      data: "",
    }));
    await writeZip(fixture, "too-many.zip", manyEntries);

    for (const [fileName, code] of [
      ["ratio-bomb.zip", "archive_ratio_exceeded"],
      ["oversized-entry.zip", "archive_entry_too_large"],
    ] as const) {
      const listed = await fixture.runtime.executeManualTool(
        "archive_manage",
        { action: "list", archivePath: fileName },
        fixture.sessionId,
      );
      const body = listBody(listed);
      expect(listed.success, listed.output).toBe(true);
      expect(body.entries[0]).toMatchObject({ unsafe: true, warnings: expect.any(Array) });
      expect(`${warningEvidence(body)} ${warningEvidence(body.entries[0]!)}`).toMatch(/budget|ratio|large|size/iu);
      const destination = `out/${fileName.replace(/\.zip$/u, "")}`;
      const extracted = await fixture.runtime.executeManualTool(
        "archive_manage",
        { action: "extract", archivePath: fileName, outputDirectory: destination },
        fixture.sessionId,
      );
      await expectArchiveFailure(extracted, "extract", code);
      await expect(fs.stat(path.join(fixture.workspaceRoot, destination))).rejects.toMatchObject({ code: "ENOENT" });
    }

    const tooMany = await fixture.runtime.executeManualTool(
      "archive_manage",
      { action: "list", archivePath: "too-many.zip" },
      fixture.sessionId,
    );
    await expectArchiveFailure(tooMany, "list", "archive_entry_limit_exceeded");
  });

  it("reports encryption/password and unsupported methods and rejects damaged or unsupported formats", async () => {
    const fixture = await createRuntime();
    await writeZip(fixture, "encrypted.zip", [{
      name: "secret.txt",
      data: Buffer.alloc(22, 0xa5),
      flags: 0x0001,
      declaredUncompressedSize: 10,
    }]);
    await writeZip(fixture, "unsupported-method.zip", [{ name: "legacy.bin", data: "legacy", method: 12 }]);
    await writeZip(fixture, "crc-mismatch.zip", [{ name: "corrupt.txt", data: "integrity", declaredCrc32: 0 }]);
    await fs.writeFile(path.join(fixture.workspaceRoot, "damaged.zip"), Buffer.from("PK\u0003\u0004damaged"));
    await fs.writeFile(path.join(fixture.workspaceRoot, "spoofed.zip"), Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0]));
    await fs.writeFile(path.join(fixture.workspaceRoot, "unsupported.tar"), Buffer.alloc(512));
    await fs.writeFile(path.join(fixture.workspaceRoot, "unsupported.gz"), Buffer.from([0x1f, 0x8b, 0x08, 0]));

    for (const [fileName, expected] of [
      ["encrypted.zip", { code: "archive_encrypted", evidence: /password|required|encrypted/iu }],
      ["unsupported-method.zip", { code: "archive_unsupported_method", evidence: /method|compression|unsupported/iu }],
    ] as const) {
      const listed = await fixture.runtime.executeManualTool(
        "archive_manage",
        { action: "list", archivePath: fileName },
        fixture.sessionId,
      );
      const listedBody = listBody(listed);
      expect(listed.success, listed.output).toBe(true);
      expect(listedBody.entries[0]).toMatchObject({ unsafe: true });
      if (fileName === "encrypted.zip") expect(listedBody.entries[0]?.encrypted).toBe(true);
      expect(`${listed.output} ${warningEvidence(listedBody)} ${warningEvidence(listedBody.entries[0]!)}`)
        .toMatch(expected.evidence);
      const outputDirectory = `out/${fileName.replace(/\.zip$/u, "")}`;
      const extracted = await fixture.runtime.executeManualTool(
        "archive_manage",
        { action: "extract", archivePath: fileName, outputDirectory },
        fixture.sessionId,
      );
      await expectArchiveFailure(extracted, "extract", expected.code);
      expect(extracted.output).toMatch(expected.evidence);
      await expect(fs.stat(path.join(fixture.workspaceRoot, outputDirectory))).rejects.toMatchObject({ code: "ENOENT" });
    }

    for (const [fileName, code] of [
      ["damaged.zip", "archive_invalid_or_damaged"],
      ["spoofed.zip", "format_mismatch"],
      ["unsupported.tar", "unsupported_format"],
      ["unsupported.gz", "unsupported_format"],
    ] as const) {
      const result = await fixture.runtime.executeManualTool(
        "archive_manage",
        { action: "list", archivePath: fileName },
        fixture.sessionId,
      );
      await expectArchiveFailure(result, "list", code);
    }

    const crcOutputDirectory = "out/crc-mismatch";
    const crcMismatch = await fixture.runtime.executeManualTool(
      "archive_manage",
      { action: "extract", archivePath: "crc-mismatch.zip", outputDirectory: crcOutputDirectory },
      fixture.sessionId,
    );
    await expectArchiveFailure(crcMismatch, "extract", "archive_invalid_or_damaged");
    expect(crcMismatch.output).toMatch(/CRC32|integrity/iu);
    await expect(fs.stat(path.join(fixture.workspaceRoot, crcOutputDirectory))).rejects.toMatchObject({ code: "ENOENT" });
    const rootEntries = await fs.readdir(fixture.workspaceRoot, { recursive: true });
    expect(rootEntries.some((entry) => String(entry).includes(".deep-mix-stage-"))).toBe(false);
  });

  it("rejects strict action schemas and pre-existing extract destinations", async () => {
    const fixture = await createRuntime();
    await writeZip(fixture, "schema.zip", [{ name: "safe.txt", data: "safe" }]);
    await fs.writeFile(path.join(fixture.workspaceRoot, "safe.txt"), "safe", "utf8");
    await fs.mkdir(path.join(fixture.workspaceRoot, "already-exists"));
    const cases: unknown[] = [
      { action: "list" },
      { action: "list", archivePath: "schema.zip", cursor: "-1" },
      { action: "list", archivePath: "schema.zip", maxEntries: 0 },
      { action: "list", archivePath: "schema.zip", outputPath: "bad.zip" },
      { action: "create", outputPath: "empty.zip", paths: [] },
      { action: "create", archivePath: "schema.zip", outputPath: "bad.zip", paths: ["safe.txt"] },
      { action: "extract", archivePath: "schema.zip" },
      { action: "extract", archivePath: "schema.zip", outputDirectory: "out", overwrite: true },
      { action: "unknown", archivePath: "schema.zip" },
    ];
    for (const args of cases) {
      const result = await fixture.runtime.executeManualTool("archive_manage", args, fixture.sessionId);
      expect(result, JSON.stringify(args)).toMatchObject({
        success: false,
        structuredContent: { error: { type: "invalid_arguments", retryable: false, toolName: "archive_manage" } },
      });
    }

    const existing = await fixture.runtime.executeManualTool(
      "archive_manage",
      { action: "extract", archivePath: "schema.zip", outputDirectory: "already-exists" },
      fixture.sessionId,
    );
    expect(existing.success).toBe(false);
    expect(JSON.stringify(existing.structuredContent)).toMatch(/outputDirectory|exist|archive_write_failed/iu);
    expect(await fs.readdir(path.join(fixture.workspaceRoot, "already-exists"))).toEqual([]);
  });

  it("declares conditional permissions, access, probe, registry, selection, limits, and no external program path", async () => {
    const fixture = await createRuntime();
    await fixture.runtime.initialize();
    const runtimeRequire = createRequire(path.join(process.cwd(), "packages/tool-runtime/package.json"));
    const resolvedYauzl = runtimeRequire.resolve("yauzl");
    const yauzl = runtimeRequire(resolvedYauzl) as {
      fromBuffer?: unknown;
      fromBufferPromise?: unknown;
      getFileNameLowLevel?: unknown;
    };
    const yauzlPackage = runtimeRequire("yauzl/package.json") as { version: string };
    const normalizedResolvedYauzl = normalizeTestPath(path.resolve(resolvedYauzl));
    const normalizedRepositoryRoot = `${normalizeTestPath(path.resolve(process.cwd()))}/`;
    expect(normalizedResolvedYauzl.startsWith(normalizedRepositoryRoot)).toBe(true);
    expect(normalizedResolvedYauzl).toMatch(/\/node_modules\/yauzl\//u);
    expect(yauzlPackage.version).toBe("3.4.0");
    expect(yauzl).toMatchObject({
      fromBuffer: expect.any(Function),
      fromBufferPromise: expect.any(Function),
      getFileNameLowLevel: expect.any(Function),
    });
    const definition = fixture.runtime.listRegisteredToolDefinitions().find((tool) => tool.name === "archive_manage");
    expect(definition).toMatchObject({
      name: "archive_manage",
      inputSchema: {
        oneOf: expect.any(Array),
      },
      checkpoint: { mode: "before_write", scope: "pre_tool_write" },
      selection: {
        attachmentExtensions: [".zip", ".tar", ".gz", ".gzip"],
        mimeTypes: ["application/zip", "application/x-tar", "application/gzip"],
        keywords: expect.any(Array),
        keywordGroups: expect.any(Array),
      },
    });
    expect(archiveManageTool.getAvailability).toEqual(expect.any(Function));
    expect(archiveManageTool.resolvePermission).toEqual(expect.any(Function));
    expect(archiveManageTool.resolveAccess).toEqual(expect.any(Function));
    expect(await archiveManageTool.resolvePermission!(
      { action: "list", archivePath: "a.zip" },
      {} as never,
    )).toMatchObject({ permissionCategory: "read_only", sideEffectLevel: "none", readOnly: true });
    expect(await archiveManageTool.resolvePermission!(
      { action: "create", outputPath: "a.zip", paths: ["a.txt"] },
      {} as never,
    )).toMatchObject({ permissionCategory: "write_file", sideEffectLevel: "high", readOnly: false });
    expect(await archiveManageTool.resolvePermission!(
      { action: "extract", archivePath: "a.zip", outputDirectory: "out" },
      {} as never,
    )).toMatchObject({ permissionCategory: "write_file", sideEffectLevel: "high", readOnly: false });

    expect(fixture.runtime.listAvailableToolDefinitions().map((tool) => tool.name)).toContain("archive_manage");
    expect(builtInToolModules.map((module) => module.manifest.id)).toContain("builtin.archives");
    expect(fixture.runtime.selectToolsForTurn({ attachmentExtensions: [".zip"] }).definitions.map((tool) => tool.name))
      .toContain("archive_manage");
    expect(fixture.runtime.selectToolsForTurn({ attachmentMimeTypes: ["application/zip"] }).definitions.map((tool) => tool.name))
      .toContain("archive_manage");
    expect(fixture.runtime.selectToolsForTurn({ prompt: "Safely extract this ZIP archive." }).definitions.map((tool) => tool.name))
      .toContain("archive_manage");
    expect(fixture.runtime.selectToolsForTurn({ prompt: "Refactor this TypeScript function." }).definitions.map((tool) => tool.name))
      .not.toContain("archive_manage");

    const implementation = await fs.readFile(
      path.join(process.cwd(), "packages/tool-runtime/src/built-ins/structured-documents/archives.ts"),
      "utf8",
    );
    expect(implementation).not.toMatch(/from\s+["']node:(?:child_process|process|worker_threads)["']/u);
    expect(implementation).not.toMatch(/\b(?:execFile|exec|spawn|fork)\s*\(/u);
    expect(implementation).not.toMatch(/(?:7z|unzip|tar\.exe|powershell|cmd\.exe)/iu);
    expect(implementation).toMatch(/maxCompressionRatio|maxExpandedBytes|maxEntries/u);
  });
});
