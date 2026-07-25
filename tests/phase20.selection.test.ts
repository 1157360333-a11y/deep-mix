import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../packages/persistence/src/index.js";
import { ToolRuntime } from "../packages/tool-runtime/src/index.js";

const PHASE20_TOOL_NAMES = [
  "read_spreadsheet",
  "write_spreadsheet",
  "read_presentation",
  "write_presentation",
  "read_notebook",
  "edit_notebook",
  "read_image",
  "archive_manage",
  "convert_document",
] as const;

const temporaryRoots: string[] = [];
const runtimes: ToolRuntime[] = [];

async function createRuntime(): Promise<{ runtime: ToolRuntime; sessionId: string }> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase20-selection-"));
  temporaryRoots.push(workspaceRoot);
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("phase 20 provider selection");
  const runtime = new ToolRuntime({
    workspaceRoot,
    sessionStore,
    permissionMode: "danger-full-access",
  });
  runtimes.push(runtime);
  return { runtime, sessionId: session.sessionId };
}

function selectedPhase20Tools(
  runtime: ToolRuntime,
  options: Parameters<ToolRuntime["selectToolsForTurn"]>[0],
): string[] {
  return runtime.selectToolsForTurn(options).definitions
    .map((tool) => tool.name)
    .filter((name) => PHASE20_TOOL_NAMES.includes(name as (typeof PHASE20_TOOL_NAMES)[number]));
}

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("phase 20 Provider selection and discovery", () => {
  it("registers the nine rich-document tools in stable contiguous order with bilingual selection metadata", async () => {
    const { runtime } = await createRuntime();
    const definitions = runtime.listRegisteredToolDefinitions();

    const phase20ToolStart = definitions.findIndex((tool) => tool.name === PHASE20_TOOL_NAMES[0]);
    expect(phase20ToolStart).toBeGreaterThanOrEqual(0);
    expect(definitions
      .slice(phase20ToolStart, phase20ToolStart + PHASE20_TOOL_NAMES.length)
      .map((tool) => tool.name)).toEqual(PHASE20_TOOL_NAMES);
    for (const name of PHASE20_TOOL_NAMES) {
      const definition = definitions.find((tool) => tool.name === name);
      expect(definition, name).toBeDefined();
      expect(definition?.selection?.groups?.length, name).toBeGreaterThan(0);
      expect(definition?.selection?.keywords?.some((keyword) => /[a-z]/iu.test(keyword)), name).toBe(true);
      expect(definition?.selection?.keywords?.some((keyword) => /[\u3400-\u9fff]/u.test(keyword)), name).toBe(true);
      expect(definition?.selection).toHaveProperty("keywordGroups");
    }
  });

  it("selects only format-compatible Phase 20 tools for attachment extensions", async () => {
    const { runtime } = await createRuntime();
    const cases: Array<[string, string[]]> = [
      [".xlsx", ["read_spreadsheet", "convert_document"]],
      ["csv", ["read_spreadsheet", "convert_document"]],
      [".tsv", ["read_spreadsheet", "convert_document"]],
      [".pptx", ["read_presentation"]],
      [".ipynb", ["read_notebook", "edit_notebook"]],
      [".png", ["read_image"]],
      [".jpg", ["read_image"]],
      [".jpeg", ["read_image"]],
      [".webp", ["read_image"]],
      [".gif", ["read_image"]],
      [".tif", ["read_image"]],
      [".tiff", ["read_image"]],
      [".zip", ["archive_manage"]],
      [".tar", ["archive_manage"]],
      [".gz", ["archive_manage"]],
      [".gzip", ["archive_manage"]],
    ];
    for (const [extension, expected] of cases) {
      expect(selectedPhase20Tools(runtime, { attachmentExtensions: [extension] }), extension).toEqual(expected);
    }
  });

  it("normalizes MIME aliases without activating tools for another format", async () => {
    const { runtime } = await createRuntime();
    const cases: Array<[string, string[]]> = [
      ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ["read_spreadsheet", "convert_document"]],
      ["text/csv; charset=utf-8", ["read_spreadsheet", "convert_document"]],
      ["application/csv", ["read_spreadsheet", "convert_document"]],
      ["text/tab-separated-values", ["read_spreadsheet", "convert_document"]],
      ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ["read_presentation"]],
      ["application/x-ipynb+json", ["read_notebook", "edit_notebook"]],
      ["image/png", ["read_image"]],
      ["image/jpeg", ["read_image"]],
      ["image/webp", ["read_image"]],
      ["image/gif", ["read_image"]],
      ["image/tif", ["read_image"]],
      ["image/tiff", ["read_image"]],
      ["application/zip", ["archive_manage"]],
      ["application/x-zip-compressed", ["archive_manage"]],
      ["application/x-tar", ["archive_manage"]],
      ["application/gzip", ["archive_manage"]],
      ["application/x-gzip", ["archive_manage"]],
    ];
    for (const [mimeType, expected] of cases) {
      expect(selectedPhase20Tools(runtime, { attachmentMimeTypes: [mimeType] }), mimeType).toEqual(expected);
    }
  });

  it("keeps generic JSON out of Notebook selection unless an IPYNB extension corroborates it", async () => {
    const { runtime } = await createRuntime();

    expect(selectedPhase20Tools(runtime, { attachmentMimeTypes: ["application/json"] })).toEqual([]);
    expect(selectedPhase20Tools(runtime, {
      attachmentExtensions: [".json"],
      attachmentMimeTypes: ["application/json"],
    })).toEqual([]);
    expect(selectedPhase20Tools(runtime, {
      attachmentExtensions: [".ipynb"],
      attachmentMimeTypes: ["application/json"],
    })).toEqual(["read_notebook", "edit_notebook"]);
  });

  it("selects every Phase 20 tool from a compact Chinese task", async () => {
    const { runtime } = await createRuntime();
    const cases: Array<[string, string]> = [
      ["请读取这个工作簿中的表格。", "read_spreadsheet"],
      ["请生成 report.xlsx 电子表格。", "write_spreadsheet"],
      ["请读取这个演示文稿。", "read_presentation"],
      ["请生成 slides.pptx 幻灯片。", "write_presentation"],
      ["请读取这个 notebook。", "read_notebook"],
      ["请编辑 analysis.ipynb 的单元格。", "edit_notebook"],
      ["请读取图片元数据和图片尺寸。", "read_image"],
      ["请列出 ZIP 压缩包中的文件。", "archive_manage"],
      ["请将 CSV 转换为 TSV。", "convert_document"],
    ];
    for (const [prompt, expectedTool] of cases) {
      expect(selectedPhase20Tools(runtime, { prompt }), prompt).toContain(expectedTool);
    }
  });

  it("does not inject rich-document tools for ordinary coding tasks or treat output names as inputs", async () => {
    const { runtime } = await createRuntime();

    expect(selectedPhase20Tools(runtime, {
      prompt: "Inspect the TypeScript repository, refactor the parser, and run unit tests.",
    })).toEqual([]);
    expect(selectedPhase20Tools(runtime, {
      prompt: "Implement a TypeScript XLSX parser library and add Vitest coverage.",
    })).toEqual([]);
    expect(selectedPhase20Tools(runtime, {
      prompt: "Write a CSV parser in TypeScript and add unit tests.",
    })).toEqual([]);
    expect(selectedPhase20Tools(runtime, {
      prompt: "Create an XLSX parsing library and unit tests.",
    })).toEqual([]);
    expect(selectedPhase20Tools(runtime, {
      prompt: "实现 PPTX 解析器代码并添加单元测试。",
    })).toEqual([]);
    expect(selectedPhase20Tools(runtime, { prompt: "Create ./out/report.xlsx." })).toEqual(["write_spreadsheet"]);
    expect(selectedPhase20Tools(runtime, { prompt: "Create ./out/slides.pptx." })).toEqual(["write_presentation"]);
    expect(selectedPhase20Tools(runtime, { prompt: "Create ./out/preview.png." })).toEqual([]);
  });

  it("preserves explicit, workflow, and attachment selection inside a coding prompt", async () => {
    const { runtime } = await createRuntime();
    const prompt = "Write a CSV parser in TypeScript and add unit tests.";

    expect(selectedPhase20Tools(runtime, {
      prompt,
      requestedToolNames: ["write_spreadsheet"],
    })).toEqual(["write_spreadsheet"]);
    expect(selectedPhase20Tools(runtime, {
      prompt,
      workflowToolNames: ["convert_document"],
    })).toEqual(["convert_document"]);
    expect(selectedPhase20Tools(runtime, {
      prompt,
      attachmentExtensions: [".xlsx"],
    })).toEqual(["read_spreadsheet", "convert_document"]);
  });

  it("infers CLI artifact URIs and lets explicit Desktop attachment sections override write-intent suppression", async () => {
    const { runtime } = await createRuntime();

    expect(selectedPhase20Tools(runtime, {
      prompt: "Inspect artifact://phase20/source.pptx and summarize the slides.",
    })).toEqual(["read_presentation"]);
    expect(selectedPhase20Tools(runtime, {
      prompt: "Inspect file://outputs/archive.zip safely.",
    })).toEqual(["archive_manage"]);

    const desktopPrompt = [
      "Create report.xlsx from the attached presentation.",
      "[Desktop attachments]",
      "- source.pptx (document, application/vnd.openxmlformats-officedocument.presentationml.presentation)",
    ].join("\n");
    const selected = selectedPhase20Tools(runtime, { prompt: desktopPrompt });
    expect(selected).toEqual(expect.arrayContaining(["write_spreadsheet", "read_presentation"]));
  });

  it("preserves PDF and DOCX inference while tool_search discovers every Phase 20 tool without format activation", async () => {
    const { runtime, sessionId } = await createRuntime();

    expect(runtime.selectToolsForTurn({ prompt: "Inspect artifact://phase14/source.pdf." }).definitions.map((tool) => tool.name))
      .toContain("read_pdf");
    expect(runtime.selectToolsForTurn({ attachmentMimeTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ] }).definitions.map((tool) => tool.name)).toContain("read_docx");

    for (const name of PHASE20_TOOL_NAMES) {
      const result = await runtime.executeManualTool("tool_search", {
        query: name,
        mode: "discover",
        maxResults: 1,
      }, sessionId);
      expect(result.success, `${name}: ${result.output}`).toBe(true);
      expect(result.structuredContent).toMatchObject({
        kind: "tool_search",
        matches: [expect.objectContaining({ name })],
      });
    }

    expect(selectedPhase20Tools(runtime, { prompt: "Opaque task; use tool_search for read_image." }))
      .toEqual([]);
    expect(selectedPhase20Tools(runtime, { prompt: "Opaque task; use tool_search for archive_manage." }))
      .toEqual([]);
  });
});
