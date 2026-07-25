import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
} from "docx";
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
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase14-read-docx-"));
  temporaryRoots.push(workspaceRoot);
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("read a bounded DOCX");
  const runtime = new ToolRuntime({
    workspaceRoot,
    sessionStore,
    permissionMode: "danger-full-access",
  });
  return { workspaceRoot, sessionStore, runtime, sessionId: session.sessionId };
}

async function writeDocx(
  filePath: string,
  children: Array<Paragraph | Table>,
  metadata: { title?: string; creator?: string; subject?: string; keywords?: string } = {},
): Promise<void> {
  const document = new Document({
    ...metadata,
    sections: [{ children }],
  });
  await fs.writeFile(filePath, await Packer.toBuffer(document));
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("phase 14 read_docx", () => {
  it("extracts headings, paragraphs, metadata, citations, and a source artifact", async () => {
    const { workspaceRoot, sessionStore, runtime, sessionId } = await createRuntime();
    await writeDocx(
      path.join(workspaceRoot, "sample.docx"),
      [
        new Paragraph({ text: "Overview", heading: HeadingLevel.HEADING_1 }),
        new Paragraph("Primary evidence paragraph."),
      ],
      { title: "DOCX report", creator: "Deep Mix", subject: "Phase 14", keywords: "tools,documents" },
    );

    const result = await runtime.executeManualTool("read_docx", { path: "sample.docx" }, sessionId);
    const content = result.structuredContent as DocumentReadResult;

    expect(result.success).toBe(true);
    expect(content).toMatchObject({
      format: "docx",
      source: "sample.docx",
      metadata: { title: "DOCX report", author: "Deep Mix", subject: "Phase 14" },
      truncated: false,
    });
    expect(content.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "heading", heading: "Overview", level: 1 }),
      expect.objectContaining({ kind: "paragraph", text: "Primary evidence paragraph." }),
    ]));
    expect(content.citations.length).toBeGreaterThanOrEqual(2);
    expect(result.artifacts?.[0]).toMatchObject({
      uri: "file://sample.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      kind: "document",
    });
    expect((await sessionStore.listToolOutputArtifacts(sessionId))).toHaveLength(1);
    expect(result.output).not.toContain("word/document.xml");
    expect(result.output).not.toContain("<w:");
  });

  it("extracts basic bullet lists and tables", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    await writeDocx(path.join(workspaceRoot, "structure.docx"), [
      new Paragraph({ text: "Alpha item", bullet: { level: 0 } }),
      new Paragraph({ text: "Beta item", bullet: { level: 0 } }),
      new Table({
        rows: [
          new TableRow({
            tableHeader: true,
            children: [
              new TableCell({ children: [new Paragraph("Metric")] }),
              new TableCell({ children: [new Paragraph("Value")] }),
            ],
          }),
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph("Latency")] }),
              new TableCell({ children: [new Paragraph("42")] }),
            ],
          }),
        ],
      }),
    ]);

    const result = await runtime.executeManualTool("read_docx", { path: "structure.docx" }, sessionId);
    const content = result.structuredContent as DocumentReadResult;

    expect(result.success).toBe(true);
    expect(content.sections).toContainEqual(expect.objectContaining({
      kind: "bullet_list",
      items: ["Alpha item", "Beta item"],
    }));
    expect(content.tables).toContainEqual(expect.objectContaining({
      rows: expect.arrayContaining([["Latency", "42"]]),
    }));
    expect(JSON.stringify(content.tables)).toContain("Metric");
  });

  it("limits returned DOCX text and reports truncation", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    await writeDocx(
      path.join(workspaceRoot, "long.docx"),
      Array.from({ length: 30 }, (_, index) => new Paragraph(`${index}-${"X".repeat(100)}`)),
    );

    const result = await runtime.executeManualTool(
      "read_docx",
      { path: "long.docx", maxChars: 100 },
      sessionId,
    );
    const content = result.structuredContent as DocumentReadResult;

    expect(result.success).toBe(true);
    expect(content.extractedChars).toBe(100);
    expect(content.truncated).toBe(true);
    expect(content.warnings).toContainEqual(expect.objectContaining({ code: "output_truncated" }));
  });

  it("returns document text beyond the old 12,000-character and 200-block defaults", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    const paragraphs = Array.from(
      { length: 220 },
      (_, index) => new Paragraph(`paragraph-${index}-${"X".repeat(100)}`),
    );
    paragraphs.push(new Paragraph("DOCX_DEFAULT_TAIL_SENTINEL"));
    await writeDocx(path.join(workspaceRoot, "default-long.docx"), paragraphs);

    const result = await runtime.executeManualTool("read_docx", { path: "default-long.docx" }, sessionId);
    const content = result.structuredContent as DocumentReadResult;

    expect(result.success).toBe(true);
    expect(content.extractedChars).toBeGreaterThan(12_000);
    expect(content.truncated).toBe(false);
    expect(result.output).toContain("DOCX_DEFAULT_TAIL_SENTINEL");
  });

  it("returns a structured result for a damaged or non-DOCX file", async () => {
    const { workspaceRoot, runtime, sessionId } = await createRuntime();
    await fs.writeFile(path.join(workspaceRoot, "damaged.docx"), Buffer.from("not a zip"));

    const result = await runtime.executeManualTool("read_docx", { path: "damaged.docx" }, sessionId);

    expect(result.success).toBe(false);
    expect(result.structuredContent).toMatchObject({
      kind: "document_error",
      format: "docx",
      code: "docx_invalid_or_damaged",
      error: { type: "command_failed", retryable: false, toolName: "read_docx" },
    });
  });

  it("rejects path escape before opening DOCX content", async () => {
    const { runtime, sessionId } = await createRuntime();

    const result = await runtime.executeManualTool("read_docx", { path: "../outside.docx" }, sessionId);

    expect(result.success).toBe(false);
    expect(result.structuredContent).toMatchObject({
      error: { type: "invalid_path", retryable: false, toolName: "read_docx" },
    });
  });
});
