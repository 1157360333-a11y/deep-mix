import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../packages/persistence/src/index.js";
import type { DocumentReadResult, DocumentSpec } from "../packages/shared-schema/src/index.js";
import {
  ToolRuntime,
  writeDocxTool,
  type ToolModule,
} from "../packages/tool-runtime/src/index.js";

const temporaryRoots: string[] = [];
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8QAAAABJRU5ErkJggg==",
  "base64",
);

async function createRuntime(modules?: readonly ToolModule[]): Promise<{
  workspaceRoot: string;
  sessionStore: SessionStore;
  runtime: ToolRuntime;
  sessionId: string;
}> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase14-write-docx-"));
  temporaryRoots.push(workspaceRoot);
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("write a checkpointed DOCX");
  const runtime = new ToolRuntime({
    workspaceRoot,
    sessionStore,
    permissionMode: "danger-full-access",
    modules,
  });
  return { workspaceRoot, sessionStore, runtime, sessionId: session.sessionId };
}

function completeDocument(imageSource?: string): DocumentSpec {
  return {
    title: "Phase 14 DOCX",
    metadata: {
      author: "Deep Mix",
      subject: "Tool architecture",
      keywords: ["tools", "docx"],
      createdAt: "2026-07-11T00:00:00.000Z",
    },
    page: { size: "A4", orientation: "portrait" },
    blocks: [
      { type: "heading", level: 1, text: "Overview" },
      { type: "paragraph", text: "Generated through the modular Tool Runtime." },
      { type: "bullet_list", items: ["Registry", "Runtime"] },
      { type: "numbered_list", items: ["Validate", "Checkpoint", "Write"] },
      { type: "table", headers: ["Metric", "Value"], rows: [["Tools", "23"]] },
      ...(imageSource ? [{ type: "image" as const, source: imageSource, alt: "One pixel", width: 20, height: 20 }] : []),
      { type: "page_break" },
      { type: "heading", level: 2, text: "Second page" },
    ],
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("phase 14 write_docx", () => {
  it("generates a valid OOXML DOCX with basic blocks and a persisted artifact", async () => {
    const { workspaceRoot, sessionStore, runtime, sessionId } = await createRuntime();
    await fs.writeFile(path.join(workspaceRoot, "pixel.png"), onePixelPng);

    const result = await runtime.executeManualTool(
      "write_docx",
      { outputPath: "out/report.docx", document: completeDocument("pixel.png") },
      sessionId,
    );

    expect(result.success).toBe(true);
    expect(result.structuredContent).toMatchObject({
      format: "docx",
      outputPath: "out/report.docx",
      warnings: expect.arrayContaining([expect.objectContaining({ code: "metadata_fields_not_supported" })]),
    });
    expect(result.artifacts?.[0]).toMatchObject({
      uri: "file://out/report.docx",
      fileName: "report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      kind: "document",
    });
    const bytes = await fs.readFile(path.join(workspaceRoot, "out/report.docx"));
    const archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
    expect(archive.file("[Content_Types].xml")).not.toBeNull();
    expect(archive.file("word/document.xml")).not.toBeNull();
    expect((await sessionStore.listToolOutputArtifacts(sessionId))).toHaveLength(1);

    const read = await runtime.executeManualTool("read_docx", { path: "out/report.docx" }, sessionId);
    const content = read.structuredContent as DocumentReadResult;
    expect(read.success).toBe(true);
    expect(content.sections).toContainEqual(expect.objectContaining({ kind: "numbered_list" }));
    expect(content.tables).toContainEqual(expect.objectContaining({ rows: expect.arrayContaining([["Tools", "23"]]) }));
  });

  it("requires explicit overwrite and restores overwritten DOCX bytes through undo", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    const outputPath = path.join(workspaceRoot, "existing.docx");
    const original = Buffer.from("original docx bytes");
    await fs.writeFile(outputPath, original);

    const denied = await runtime.executeManualTool(
      "write_docx",
      { outputPath: "existing.docx", document: completeDocument() },
      sessionId,
    );
    expect(denied.success).toBe(false);
    expect(denied.structuredContent).toMatchObject({ error: { type: "invalid_arguments", fieldPath: "/overwrite" } });
    expect(await fs.readFile(outputPath)).toEqual(original);

    const written = await runtime.executeManualTool(
      "write_docx",
      { outputPath: "existing.docx", overwrite: true, document: completeDocument() },
      sessionId,
    );
    expect(written.success).toBe(true);
    expect(await fs.readFile(outputPath)).not.toEqual(original);

    const undone = await runtime.executeManualTool("undo", { mode: "code" }, sessionId);
    expect(undone.success).toBe(true);
    expect(await fs.readFile(outputPath)).toEqual(original);
  });

  it("rejects escaped and protected output paths", async () => {
    const { runtime, sessionId } = await createRuntime();
    const escaped = await runtime.executeManualTool(
      "write_docx",
      { outputPath: "../outside.docx", document: completeDocument() },
      sessionId,
    );
    expect(escaped.structuredContent).toMatchObject({ error: { type: "invalid_path" } });

    const protectedResult = await runtime.executeManualTool(
      "write_docx",
      { outputPath: ".deep-mix/api-key-library/blocked.docx", document: completeDocument() },
      sessionId,
    );
    expect(protectedResult.structuredContent).toMatchObject({ error: { type: "sandbox_denied" } });
  });

  it("returns invalid_arguments for an invalid image and restores the checkpoint", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    const original = Buffer.from("keep docx");
    await fs.writeFile(path.join(workspaceRoot, "existing.docx"), original);
    await fs.writeFile(path.join(workspaceRoot, "fake.jpg"), "not an image", "utf8");

    const result = await runtime.executeManualTool(
      "write_docx",
      {
        outputPath: "existing.docx",
        overwrite: true,
        document: completeDocument("fake.jpg"),
      },
      sessionId,
    );

    expect(result.success).toBe(false);
    expect(result.structuredContent).toMatchObject({
      error: { type: "invalid_arguments", fieldPath: "/document/blocks/5/source" },
    });
    expect(await fs.readFile(path.join(workspaceRoot, "existing.docx"))).toEqual(original);
  });

  it("returns missing_dependency when the exact DOCX writer spec is unavailable", async () => {
    const unavailableModule: ToolModule = {
      manifest: {
        id: "test.unavailable-docx-writer",
        version: "1.0.0",
        description: "Unavailable DOCX writer fixture.",
        source: "built_in",
      },
      create: () => ({
        ...writeDocxTool,
        getAvailability: async () => ({
          status: "unavailable",
          available: false,
          missingCapabilities: ["docx"],
          reason: "docx fixture is unavailable.",
        }),
      }),
    };
    const { runtime, sessionId } = await createRuntime([unavailableModule]);

    const result = await runtime.executeManualTool(
      "write_docx",
      { outputPath: "unavailable.docx", document: { blocks: [] } },
      sessionId,
    );

    expect(result.success).toBe(false);
    expect(result.structuredContent).toMatchObject({
      error: { type: "missing_dependency", dependency: "docx", toolName: "write_docx" },
    });
  });
});
