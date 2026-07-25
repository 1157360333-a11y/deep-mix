import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../packages/persistence/src/index.js";
import type { DocumentSpec } from "../packages/shared-schema/src/index.js";
import {
  ToolRuntime,
  writePdfTool,
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
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase14-write-pdf-"));
  temporaryRoots.push(workspaceRoot);
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("write a checkpointed PDF");
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
    title: "Phase 14 PDF",
    metadata: { author: "Deep Mix", subject: "Tool architecture", keywords: ["tools", "pdf"] },
    page: { size: "A4", orientation: "portrait" },
    blocks: [
      { type: "heading", level: 1, text: "Overview" },
      { type: "paragraph", text: "Generated through the modular Tool Runtime." },
      { type: "bullet_list", items: ["Registry", "Runtime"] },
      { type: "numbered_list", items: ["Validate", "Checkpoint", "Write"] },
      { type: "table", headers: ["Metric", "Value"], rows: [["Tools", "23"]] },
      ...(imageSource ? [{ type: "image" as const, source: imageSource, alt: "One pixel", width: 20 }] : []),
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

describe("phase 14 write_pdf", () => {
  it("generates a valid PDF with all basic blocks and a persisted artifact", async () => {
    const { workspaceRoot, sessionStore, runtime, sessionId } = await createRuntime();
    await fs.writeFile(path.join(workspaceRoot, "pixel.png"), onePixelPng);

    const result = await runtime.executeManualTool(
      "write_pdf",
      { outputPath: "out/report.pdf", document: completeDocument("pixel.png") },
      sessionId,
    );

    expect(result.success).toBe(true);
    expect(result.structuredContent).toMatchObject({
      format: "pdf",
      outputPath: "out/report.pdf",
      pageCount: 2,
    });
    expect(result.artifacts?.[0]).toMatchObject({
      uri: "file://out/report.pdf",
      fileName: "report.pdf",
      mimeType: "application/pdf",
      kind: "document",
    });
    const parsed = await PDFDocument.load(await fs.readFile(path.join(workspaceRoot, "out/report.pdf")));
    expect(parsed.getPageCount()).toBe(2);
    expect((await sessionStore.listToolOutputArtifacts(sessionId))).toHaveLength(1);
  });

  it("requires explicit overwrite and restores overwritten binary bytes through undo", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    const outputPath = path.join(workspaceRoot, "existing.pdf");
    const original = Buffer.from("original binary bytes");
    await fs.writeFile(outputPath, original);

    const denied = await runtime.executeManualTool(
      "write_pdf",
      { outputPath: "existing.pdf", document: completeDocument() },
      sessionId,
    );
    expect(denied.success).toBe(false);
    expect(denied.structuredContent).toMatchObject({ error: { type: "invalid_arguments", fieldPath: "/overwrite" } });
    expect(await fs.readFile(outputPath)).toEqual(original);

    const written = await runtime.executeManualTool(
      "write_pdf",
      { outputPath: "existing.pdf", overwrite: true, document: completeDocument() },
      sessionId,
    );
    expect(written.success).toBe(true);
    expect(await fs.readFile(outputPath)).not.toEqual(original);

    const undone = await runtime.executeManualTool("undo", { mode: "code" }, sessionId);
    expect(undone.success).toBe(true);
    expect(await fs.readFile(outputPath)).toEqual(original);
  });

  it("rejects lexical, protected, and junction-based output escape", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    const lexical = await runtime.executeManualTool(
      "write_pdf",
      { outputPath: "../outside.pdf", document: completeDocument() },
      sessionId,
    );
    expect(lexical.structuredContent).toMatchObject({ error: { type: "invalid_path" } });

    const protectedResult = await runtime.executeManualTool(
      "write_pdf",
      { outputPath: ".deep-mix/api-key-library/blocked.pdf", document: completeDocument() },
      sessionId,
    );
    expect(protectedResult.structuredContent).toMatchObject({ error: { type: "sandbox_denied" } });

    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase14-write-pdf-outside-"));
    temporaryRoots.push(outsideRoot);
    await fs.symlink(outsideRoot, path.join(workspaceRoot, "outside-link"), "junction");
    const linked = await runtime.executeManualTool(
      "write_pdf",
      { outputPath: "outside-link/escaped.pdf", document: completeDocument() },
      sessionId,
    );
    expect(linked.structuredContent).toMatchObject({ error: { type: "invalid_path" } });
    await expect(fs.stat(path.join(outsideRoot, "escaped.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns invalid_arguments for an invalid image and restores the pre-write checkpoint", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    const original = Buffer.from("keep me");
    await fs.writeFile(path.join(workspaceRoot, "existing.pdf"), original);
    await fs.writeFile(path.join(workspaceRoot, "fake.png"), "not an image", "utf8");

    const result = await runtime.executeManualTool(
      "write_pdf",
      {
        outputPath: "existing.pdf",
        overwrite: true,
        document: completeDocument("fake.png"),
      },
      sessionId,
    );

    expect(result.success).toBe(false);
    expect(result.structuredContent).toMatchObject({
      error: { type: "invalid_arguments", fieldPath: "/document/blocks/5/source" },
    });
    expect(await fs.readFile(path.join(workspaceRoot, "existing.pdf"))).toEqual(original);
  });

  it("returns missing_dependency when the exact writer spec is unavailable", async () => {
    const unavailableModule: ToolModule = {
      manifest: {
        id: "test.unavailable-pdf-writer",
        version: "1.0.0",
        description: "Unavailable PDF writer fixture.",
        source: "built_in",
      },
      create: () => ({
        ...writePdfTool,
        getAvailability: async () => ({
          status: "unavailable",
          available: false,
          missingCapabilities: ["pdf-lib"],
          reason: "pdf-lib fixture is unavailable.",
        }),
      }),
    };
    const { runtime, sessionId } = await createRuntime([unavailableModule]);

    const result = await runtime.executeManualTool(
      "write_pdf",
      { outputPath: "unavailable.pdf", document: { blocks: [] } },
      sessionId,
    );

    expect(result.success).toBe(false);
    expect(result.structuredContent).toMatchObject({
      error: { type: "missing_dependency", dependency: "pdf-lib", toolName: "write_pdf" },
    });
  });
});
