import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../packages/persistence/src/index.js";
import { ToolRuntime } from "../packages/tool-runtime/src/index.js";

const temporaryRoots: string[] = [];
const documentToolNames = ["read_pdf", "read_docx", "write_pdf", "write_docx"];

async function createRuntime(): Promise<{ runtime: ToolRuntime; sessionId: string }> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase14-selection-"));
  temporaryRoots.push(workspaceRoot);
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("phase 14 document selection");
  return {
    runtime: new ToolRuntime({ workspaceRoot, sessionStore, permissionMode: "danger-full-access" }),
    sessionId: session.sessionId,
  };
}

function selectedDocumentTools(runtime: ToolRuntime, options: Parameters<ToolRuntime["selectToolsForTurn"]>[0]): string[] {
  return runtime.selectToolsForTurn(options).definitions
    .map((tool) => tool.name)
    .filter((name) => documentToolNames.includes(name));
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("phase 14 document tool selection", () => {
  it("keeps all document tools in the Registry but excludes them from ordinary code turns", async () => {
    const { runtime } = await createRuntime();

    expect(runtime.listRegisteredToolDefinitions().map((tool) => tool.name)).toEqual(
      expect.arrayContaining(documentToolNames),
    );
    expect(selectedDocumentTools(runtime, { prompt: "Inspect the TypeScript repository and run tests." })).toEqual([]);
  });

  it("injects only the relevant reader for PDF or DOCX attachments", async () => {
    const { runtime } = await createRuntime();

    expect(selectedDocumentTools(runtime, {
      prompt: "Inspect the attached source.",
      attachmentMimeTypes: ["application/pdf"],
    })).toEqual(["read_pdf"]);
    expect(selectedDocumentTools(runtime, {
      prompt: "Inspect the attached source.",
      attachmentExtensions: [".docx"],
    })).toEqual(["read_docx"]);
    expect(selectedDocumentTools(runtime, { prompt: "Read the long PDF and summarize it." })).toEqual(["read_pdf"]);
    expect(selectedDocumentTools(runtime, { prompt: "Analyze this large DOCX document." })).toEqual(["read_docx"]);
  });

  it("recognizes compact Chinese document-reading requests without a literal file extension", async () => {
    const { runtime } = await createRuntime();

    expect(selectedDocumentTools(runtime, {
      prompt: "根据这份根目录pdf中的内容整理行业分类。",
    })).toEqual(["read_pdf"]);
    expect(selectedDocumentTools(runtime, { prompt: "请读取PDF并总结重点。" })).toEqual(["read_pdf"]);
    expect(selectedDocumentTools(runtime, { prompt: "帮我读一下PDF文件。" })).toEqual(["read_pdf"]);
    expect(selectedDocumentTools(runtime, { prompt: "打开这个PDF看看。" })).toEqual(["read_pdf"]);
    expect(selectedDocumentTools(runtime, { prompt: "分析这份DOCX中的表格。" })).toEqual(["read_docx"]);
    expect(selectedDocumentTools(runtime, { prompt: "请阅读Word文档并提炼结论。" })).toEqual(["read_docx"]);
    expect(selectedDocumentTools(runtime, { prompt: "帮我读一下Word文档。" })).toEqual(["read_docx"]);
    expect(selectedDocumentTools(runtime, { prompt: "打开这个Word文件看看。" })).toEqual(["read_docx"]);
  });

  it("injects the requested writer without injecting the complete document catalog", async () => {
    const { runtime } = await createRuntime();

    expect(selectedDocumentTools(runtime, { prompt: "Generate PDF output for the report." })).toEqual(["write_pdf"]);
    expect(selectedDocumentTools(runtime, { prompt: "请创建 DOCX 报告。" })).toEqual(["write_docx"]);
    expect(selectedDocumentTools(runtime, { prompt: "请生成PDF报告。" })).toEqual(["write_pdf"]);
    expect(selectedDocumentTools(runtime, { prompt: "把结果导出为DOCX。" })).toEqual(["write_docx"]);
    expect(selectedDocumentTools(runtime, { prompt: "创建Word文档并保存结果。" })).toEqual(["write_docx"]);
    expect(selectedDocumentTools(runtime, { prompt: "请覆盖 report.pdf。" })).toEqual(["write_pdf"]);
    expect(selectedDocumentTools(runtime, { prompt: "请修改现有PDF。" })).toEqual(["write_pdf"]);
    expect(selectedDocumentTools(runtime, { prompt: "请生成 report.pdf。" })).toEqual(["write_pdf"]);
    expect(selectedDocumentTools(runtime, { prompt: "请更新这个Word文件。" })).toEqual(["write_docx"]);
  });

  it("keeps list_tools always visible while returning the complete Registry without all schemas", async () => {
    const { runtime, sessionId } = await createRuntime();
    const ordinary = runtime.selectToolsForTurn({ prompt: "Inspect the TypeScript repository." });

    expect(ordinary.definitions.map((tool) => tool.name)).toContain("list_tools");
    expect(ordinary.definitions.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(documentToolNames));

    const result = await runtime.executeManualTool("list_tools", {}, sessionId);
    expect(result.success).toBe(true);
    expect(result.structuredContent).toMatchObject({
      kind: "tool_catalog",
      totalRegistered: runtime.listRegisteredToolDefinitions().length,
      returnedCount: runtime.listRegisteredToolDefinitions().length,
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "list_tools", moduleId: "builtin.catalog" }),
        expect.objectContaining({ name: "read_pdf", moduleId: "builtin.documents" }),
        expect.objectContaining({ name: "read_docx", moduleId: "builtin.documents" }),
        expect.objectContaining({ name: "write_pdf", moduleId: "builtin.documents" }),
        expect.objectContaining({ name: "write_docx", moduleId: "builtin.documents" }),
      ]),
    });
    const catalog = result.structuredContent as { tools: Array<Record<string, unknown>> };
    expect(catalog.tools.every((tool) => !("inputSchema" in tool))).toBe(true);
  });

  it("filters the authoritative catalog without changing the complete Registry", async () => {
    const { runtime, sessionId } = await createRuntime();
    const result = await runtime.executeManualTool(
      "list_tools",
      { group: "documents", query: "read" },
      sessionId,
    );

    expect(result.structuredContent).toMatchObject({
      kind: "tool_catalog",
      totalRegistered: runtime.listRegisteredToolDefinitions().length,
      filters: { availableOnly: false, group: "documents", query: "read" },
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "read_pdf" }),
        expect.objectContaining({ name: "read_docx" }),
      ]),
    });
    const filteredCatalog = result.structuredContent as {
      returnedCount: number;
      tools: Array<Record<string, unknown>>;
    };
    expect(filteredCatalog.returnedCount).toBe(filteredCatalog.tools.length);
    expect(filteredCatalog.returnedCount).toBeGreaterThanOrEqual(2);
  });
});
