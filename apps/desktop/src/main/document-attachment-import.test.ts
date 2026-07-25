import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Document, Packer, Paragraph } from "docx";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../../../../packages/persistence/src/index.js";
import { ToolRuntime } from "../../../../packages/tool-runtime/src/index.js";
import {
  MAX_DOCUMENT_ATTACHMENT_BYTES,
  importDocumentAttachment,
  isSupportedDocumentAttachmentPath,
  mimeForDocumentAttachmentPath,
} from "./document-attachment-import.js";

const temporaryRoots: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("desktop document attachment import", () => {
  it("copies PDF/DOCX into the workspace with stable collision names and file refs", async () => {
    const workspaceRoot = await temporaryDirectory("deep-mix-desktop-workspace-");
    const outsideRoot = await temporaryDirectory("deep-mix-desktop-outside-");
    const sourcePath = path.join(outsideRoot, "report.pdf");
    await fs.writeFile(sourcePath, "%PDF fixture", "utf8");

    const first = await importDocumentAttachment({ sourcePath, workspaceRoot });
    const second = await importDocumentAttachment({ sourcePath, workspaceRoot });

    expect(first).toMatchObject({
      name: "report.pdf",
      relativePath: ".deep-mix/desktop-attachments/imports/report.pdf",
      ref: "file://.deep-mix/desktop-attachments/imports/report.pdf",
      mimeType: "application/pdf",
    });
    expect(second.name).toBe("report-2.pdf");
    expect(await fs.readFile(path.join(workspaceRoot, first.relativePath), "utf8")).toBe("%PDF fixture");
  });

  it.each([
    ["book.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["analysis.ipynb", "application/x-ipynb+json"],
    ["preview.TIFF", "image/tiff"],
    ["fixtures.zip", "application/zip"],
  ])("imports the Phase 20 representative %s into the trusted workspace directory", async (name, mimeType) => {
    const workspaceRoot = await temporaryDirectory("deep-mix-desktop-structured-workspace-");
    const outsideRoot = await temporaryDirectory("deep-mix-desktop-structured-outside-");
    const sourcePath = path.join(outsideRoot, name);
    const contents = Buffer.from(`fixture:${name}`, "utf8");
    await fs.writeFile(sourcePath, contents);

    const imported = await importDocumentAttachment({ sourcePath, workspaceRoot });

    expect(imported).toMatchObject({
      relativePath: `.deep-mix/desktop-attachments/imports/${name.toLowerCase().endsWith(".tiff") ? "preview.tiff" : name}`,
      mimeType,
    });
    expect(imported.ref).toBe(`file://${imported.relativePath}`);
    expect(path.isAbsolute(imported.relativePath)).toBe(false);
    expect(await fs.readFile(path.join(workspaceRoot, imported.relativePath))).toEqual(contents);
  });

  it("publishes an exact MIME allowlist for every Phase 20 attachment extension", () => {
    const expected = {
      "sample.pdf": "application/pdf",
      "sample.docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "sample.xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "sample.csv": "text/csv",
      "sample.tsv": "text/tab-separated-values",
      "sample.pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "sample.ipynb": "application/x-ipynb+json",
      "sample.png": "image/png",
      "sample.jpg": "image/jpeg",
      "sample.jpeg": "image/jpeg",
      "sample.webp": "image/webp",
      "sample.gif": "image/gif",
      "sample.tif": "image/tiff",
      "sample.tiff": "image/tiff",
      "sample.zip": "application/zip",
      "sample.tar": "application/x-tar",
      "sample.gz": "application/gzip",
      "sample.gzip": "application/gzip",
    } as const;

    for (const [fileName, mimeType] of Object.entries(expected)) {
      expect(isSupportedDocumentAttachmentPath(fileName), fileName).toBe(true);
      expect(mimeForDocumentAttachmentPath(fileName), fileName).toBe(mimeType);
    }
    expect(isSupportedDocumentAttachmentPath("sample.xlsm")).toBe(false);
    expect(mimeForDocumentAttachmentPath("sample.svg")).toBeUndefined();
  });

  it("rejects unsupported, missing, and oversized document inputs before copying", async () => {
    const workspaceRoot = await temporaryDirectory("deep-mix-desktop-workspace-");
    const outsideRoot = await temporaryDirectory("deep-mix-desktop-outside-");
    const unsupported = path.join(outsideRoot, "notes.txt");
    await fs.writeFile(unsupported, "notes", "utf8");
    await expect(importDocumentAttachment({ sourcePath: unsupported, workspaceRoot })).rejects.toMatchObject({
      code: "unsupported_extension",
      details: {
        extension: ".txt",
        supportedExtensions: expect.arrayContaining([".xlsx", ".pptx", ".ipynb", ".png", ".zip"]),
      },
    });
    await expect(importDocumentAttachment({
      sourcePath: path.join(outsideRoot, "missing.pdf"),
      workspaceRoot,
    })).rejects.toMatchObject({ code: "source_not_found" });

    const oversized = path.join(outsideRoot, "oversized.docx");
    const handle = await fs.open(oversized, "w");
    await handle.truncate(MAX_DOCUMENT_ATTACHMENT_BYTES + 1);
    await handle.close();
    await expect(importDocumentAttachment({ sourcePath: oversized, workspaceRoot })).rejects.toMatchObject({
      code: "file_too_large",
    });
  });

  it("imports an external PDF and lets the built-in reader consume the trusted workspace copy", async () => {
    const workspaceRoot = await temporaryDirectory("deep-mix-desktop-reader-workspace-");
    const outsideRoot = await temporaryDirectory("deep-mix-desktop-reader-outside-");
    const sourcePath = path.join(outsideRoot, "external-report.pdf");
    const document = await PDFDocument.create();
    const page = document.addPage([320, 240]);
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText("Desktop attachment PDF is readable", { x: 24, y: 180, size: 16, font });
    await fs.writeFile(sourcePath, await document.save());

    const imported = await importDocumentAttachment({ sourcePath, workspaceRoot });
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const session = await sessionStore.createSession("desktop attachment read");
    const runtime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
    });
    const result = await runtime.executeManualTool("read_pdf", {
      path: imported.relativePath,
      maxChars: 2_000,
    }, session.sessionId);

    expect(result.success).toBe(true);
    expect(result.output).toContain("Desktop attachment PDF is readable");
    expect(result.structuredContent).toMatchObject({
      format: "pdf",
      truncated: false,
      citations: expect.arrayContaining([expect.objectContaining({ page: 1 })]),
    });
    expect(result.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ mimeType: "application/pdf", sourceToolName: "read_pdf" }),
    ]));
  });

  it("imports an external DOCX without Microsoft Word and lets the built-in reader consume it", async () => {
    const workspaceRoot = await temporaryDirectory("deep-mix-desktop-docx-workspace-");
    const outsideRoot = await temporaryDirectory("deep-mix-desktop-docx-outside-");
    const sourcePath = path.join(outsideRoot, "external-report.docx");
    const document = new Document({
      sections: [{ children: [new Paragraph("Desktop attachment DOCX is readable")] }],
    });
    await fs.writeFile(sourcePath, await Packer.toBuffer(document));

    const imported = await importDocumentAttachment({ sourcePath, workspaceRoot });
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const session = await sessionStore.createSession("desktop DOCX attachment read");
    const runtime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
    });
    const result = await runtime.executeManualTool("read_docx", {
      path: imported.relativePath,
      maxChars: 2_000,
    }, session.sessionId);

    expect(result.success).toBe(true);
    expect(result.output).toContain("Desktop attachment DOCX is readable");
    expect(result.structuredContent).toMatchObject({ format: "docx", truncated: false });
    expect(result.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sourceToolName: "read_docx",
      }),
    ]));
  });
});
