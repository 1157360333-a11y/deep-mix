import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../packages/persistence/src/index.js";
import type { DocumentReadResult } from "../packages/shared-schema/src/index.js";
import { ToolRuntime } from "../packages/tool-runtime/src/index.js";

const temporaryRoots: string[] = [];

async function createRuntime(): Promise<{
  workspaceRoot: string;
  sessionStore: SessionStore;
  runtime: ToolRuntime;
  sessionId: string;
}> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase14-read-pdf-"));
  temporaryRoots.push(workspaceRoot);
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("read a bounded PDF");
  const runtime = new ToolRuntime({
    workspaceRoot,
    sessionStore,
    permissionMode: "danger-full-access",
  });
  return { workspaceRoot, sessionStore, runtime, sessionId: session.sessionId };
}

async function writePdf(
  filePath: string,
  pages: string[],
  metadata: { title?: string; author?: string; subject?: string; keywords?: string[] } = {},
): Promise<void> {
  const document = await PDFDocument.create();
  if (metadata.title) document.setTitle(metadata.title);
  if (metadata.author) document.setAuthor(metadata.author);
  if (metadata.subject) document.setSubject(metadata.subject);
  if (metadata.keywords) document.setKeywords(metadata.keywords);
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = document.addPage([612, 792]);
    if (text) page.drawText(text, { x: 48, y: 720, size: 12, font, maxWidth: 516 });
  }
  await fs.writeFile(filePath, await document.save());
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("phase 14 read_pdf", () => {
  it("returns bounded page text, metadata, citations, and a source artifact", async () => {
    const { workspaceRoot, sessionStore, runtime, sessionId } = await createRuntime();
    await writePdf(
      path.join(workspaceRoot, "sample.pdf"),
      ["First page content", "Second page evidence"],
      { title: "Sample report", author: "Deep Mix" },
    );

    const result = await runtime.executeManualTool(
      "read_pdf",
      { path: "sample.pdf", pageRange: { start: 2, end: 2 }, maxChars: 2_000 },
      sessionId,
    );
    const content = result.structuredContent as DocumentReadResult;

    expect(result.success).toBe(true);
    expect(content).toMatchObject({
      format: "pdf",
      source: "sample.pdf",
      metadata: { title: "Sample report", author: "Deep Mix", pageCount: 2 },
      truncated: false,
    });
    expect(content.sections).toEqual([{ page: 2, text: "Second page evidence" }]);
    expect(content.citations).toEqual([
      { label: "sample.pdf page 2", source: "sample.pdf", page: 2 },
    ]);
    expect(result.artifacts?.[0]).toMatchObject({
      uri: "file://sample.pdf",
      fileName: "sample.pdf",
      mimeType: "application/pdf",
      kind: "document",
      workspaceRelativePath: "sample.pdf",
    });
    expect((await sessionStore.listToolOutputArtifacts(sessionId))).toHaveLength(1);
  });

  it("stops extraction at maxChars and reports truncation", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    await writePdf(path.join(workspaceRoot, "long.pdf"), ["A".repeat(300), "B".repeat(300)]);

    const result = await runtime.executeManualTool(
      "read_pdf",
      { path: "long.pdf", maxChars: 100 },
      sessionId,
    );
    const content = result.structuredContent as DocumentReadResult;

    expect(result.success).toBe(true);
    expect(content.extractedChars).toBe(100);
    expect(content.truncated).toBe(true);
    expect(content.sections.map((section) => section.text).join("").length).toBe(100);
    expect(content.warnings).toContainEqual(expect.objectContaining({ code: "output_truncated" }));
  });

  it("returns all selected pages and text beyond the old document defaults", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    const pages = Array.from({ length: 30 }, (_, pageIndex) =>
      Array.from(
        { length: 12 },
        (_, lineIndex) => `page-${pageIndex + 1}-line-${lineIndex + 1} ${"word ".repeat(12)}`,
      ).join("\n"));
    pages[29] = `${pages[29]}\nPDF_DEFAULT_TAIL_SENTINEL`;
    await writePdf(path.join(workspaceRoot, "default-long.pdf"), pages);

    const result = await runtime.executeManualTool("read_pdf", { path: "default-long.pdf" }, sessionId);
    const content = result.structuredContent as DocumentReadResult;

    expect(result.success).toBe(true);
    expect(content.sections).toHaveLength(30);
    expect(content.extractedChars).toBeGreaterThan(12_000);
    expect(content.truncated).toBe(false);
    expect(result.output).toContain("PDF_DEFAULT_TAIL_SENTINEL");
  });

  it("does not mistake empty scanned pages for a text-budget overflow and still returns ocr_required", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    await writePdf(path.join(workspaceRoot, "scanned.pdf"), Array.from({ length: 40 }, () => ""));

    const result = await runtime.executeManualTool(
      "read_pdf",
      { path: "scanned.pdf", maxChars: 100 },
      sessionId,
    );
    const content = result.structuredContent as DocumentReadResult;

    expect(result.success).toBe(true);
    expect(content.sections).toHaveLength(40);
    expect(content.truncated).toBe(false);
    expect(content.warnings).toContainEqual(expect.objectContaining({ code: "ocr_required" }));
    expect(content.warnings).not.toContainEqual(expect.objectContaining({ code: "page_limit_reached" }));
    expect(JSON.stringify(content.warnings).length).toBeLessThan(1_000);
    expect(result.output).not.toContain("invoke_vision_worker");
  });

  it("bounds hostile metadata before returning it to the model", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    await writePdf(path.join(workspaceRoot, "metadata.pdf"), ["Evidence"], {
      title: "T".repeat(2_000),
      author: "A".repeat(1_000),
      subject: "S".repeat(3_000),
      keywords: Array.from({ length: 40 }, (_, index) => `keyword-${index}-${"K".repeat(150)}`),
    });

    const result = await runtime.executeManualTool("read_pdf", { path: "metadata.pdf" }, sessionId);
    const content = result.structuredContent as DocumentReadResult;

    expect(result.success).toBe(true);
    expect(content.metadata.title?.length).toBeLessThanOrEqual(512);
    expect(content.metadata.author?.length).toBeLessThanOrEqual(256);
    expect(content.metadata.subject?.length).toBeLessThanOrEqual(1_000);
    expect(content.metadata.keywords?.length).toBeLessThanOrEqual(20);
    expect(content.warnings).toContainEqual(expect.objectContaining({ code: "metadata_truncated" }));
  });

  it("returns a structured damaged-PDF result", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    await fs.writeFile(path.join(workspaceRoot, "damaged.pdf"), Buffer.from("not a pdf"));

    const result = await runtime.executeManualTool("read_pdf", { path: "damaged.pdf" }, sessionId);

    expect(result.success).toBe(false);
    expect(result.structuredContent).toMatchObject({
      kind: "document_error",
      format: "pdf",
      code: "pdf_invalid_or_damaged",
      error: { type: "command_failed", retryable: false, toolName: "read_pdf" },
    });
  });

  it("rejects workspace path escape before PDF parsing", async () => {
    const { runtime, sessionId } = await createRuntime();

    const result = await runtime.executeManualTool("read_pdf", { path: "../outside.pdf" }, sessionId);

    expect(result.success).toBe(false);
    expect(result.structuredContent).toMatchObject({
      error: { type: "invalid_path", retryable: false, toolName: "read_pdf" },
    });
  });

  it("rejects a workspace junction or symlink that resolves outside the trusted root", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase14-outside-pdf-"));
    temporaryRoots.push(outsideRoot);
    await writePdf(path.join(outsideRoot, "outside.pdf"), ["must not be readable"]);
    await fs.symlink(outsideRoot, path.join(workspaceRoot, "outside-link"), "junction");

    const result = await runtime.executeManualTool(
      "read_pdf",
      { path: "outside-link/outside.pdf" },
      sessionId,
    );

    expect(result.success).toBe(false);
    expect(result.structuredContent).toMatchObject({
      error: { type: "invalid_path", retryable: false, toolName: "read_pdf" },
    });
  });

  it("reads a trusted tool-output artifact and rejects invalid page ranges structurally", async () => {
    const { workspaceRoot, sessionStore, runtime, sessionId } = await createRuntime();
    const sourcePath = path.join(workspaceRoot, "artifact-source.pdf");
    await writePdf(sourcePath, ["Artifact page"]);
    const artifact = await sessionStore.storeToolOutputArtifact({
      sessionId,
      toolCallId: "fixture-call",
      sourceToolName: "fixture",
      fileName: "artifact.pdf",
      mimeType: "application/pdf",
      kind: "document",
      summary: "PDF fixture",
      content: await fs.readFile(sourcePath),
    });

    const read = await runtime.executeManualTool("read_pdf", { path: artifact.uri }, sessionId);
    expect(read.success).toBe(true);
    expect(read.structuredContent).toMatchObject({ format: "pdf", source: artifact.uri });

    const invalidRange = await runtime.executeManualTool(
      "read_pdf",
      { path: artifact.uri, pageRange: { start: 2, end: 1 } },
      sessionId,
    );
    expect(invalidRange.success).toBe(false);
    expect(invalidRange.structuredContent).toMatchObject({
      error: { type: "invalid_arguments", fieldPath: "/pageRange/end" },
    });
  });

  it("selects read_pdf for PDF context but not for an ordinary code task", async () => {
    const { runtime } = await createRuntime();

    const ordinary = runtime.selectToolsForTurn({ prompt: "Inspect the TypeScript repository." });
    const byPrompt = runtime.selectToolsForTurn({ prompt: "请读取 reports/sample.pdf" });
    const byMime = runtime.selectToolsForTurn({
      prompt: "Inspect the attachment.",
      attachmentMimeTypes: ["application/pdf"],
    });

    expect(ordinary.definitions.map((tool) => tool.name)).not.toContain("read_pdf");
    expect(byPrompt.definitions.map((tool) => tool.name)).toContain("read_pdf");
    expect(byMime.definitions.map((tool) => tool.name)).toContain("read_pdf");
  });
});
