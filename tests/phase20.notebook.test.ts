import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../packages/persistence/src/index.js";
import type {
  NotebookReadResult,
  StructuredDocumentWriteResult,
} from "../packages/shared-schema/src/index.js";
import { ToolRuntime } from "../packages/tool-runtime/src/index.js";
import { recoveryToolModule } from "../packages/tool-runtime/src/built-ins/recovery/index.js";
import { PHASE20_LIMITS } from "../packages/tool-runtime/src/built-ins/structured-documents/format-policy.js";
import {
  editNotebookTool,
  notebooksToolModule,
  readNotebookTool,
} from "../packages/tool-runtime/src/built-ins/structured-documents/notebooks.js";

const temporaryRoots: string[] = [];
const notebookMimeType = "application/x-ipynb+json";

interface NotebookFixture {
  workspaceRoot: string;
  sessionStore: SessionStore;
  runtime: ToolRuntime;
  sessionId: string;
}

interface RawNotebookCell {
  id?: string;
  cell_type: "markdown" | "code" | "raw";
  source: string | string[];
  metadata: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: Array<Record<string, unknown>>;
}

interface RawNotebook {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: RawNotebookCell[];
}

async function createRuntime(): Promise<NotebookFixture> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase20-notebook-"));
  temporaryRoots.push(workspaceRoot);
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("read and edit notebook structure without execution");
  const runtime = new ToolRuntime({
    workspaceRoot,
    sessionStore,
    permissionMode: "danger-full-access",
    modules: [notebooksToolModule, recoveryToolModule],
  });
  return { workspaceRoot, sessionStore, runtime, sessionId: session.sessionId };
}

function representativeNotebook(): RawNotebook {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python", version: "3.12" },
      custom_root: { owner: "Deep-Mix", nested: { retained: true } },
    },
    cells: [
      {
        id: "intro",
        cell_type: "markdown",
        source: ["# Phase 20\n", "Notebook structure only."],
        metadata: { tags: ["phase20"], custom_cell: { retained: "yes" } },
      },
      {
        id: "code-a",
        cell_type: "code",
        source: ["value = 21\n", "value * 2"],
        metadata: { collapsed: false, custom_code: { retained: 7 } },
        execution_count: 7,
        outputs: [
          { output_type: "stream", name: "stdout", text: ["line one\n", "line two\n"] },
          {
            output_type: "display_data",
            data: { "text/plain": ["<result 42>"], "application/json": { answer: 42 } },
            metadata: { isolated: true },
          },
          {
            output_type: "error",
            ename: "ValueError",
            evalue: "representative error",
            traceback: ["Traceback fixture", "ValueError: representative error"],
          },
        ],
      },
      {
        id: "raw-a",
        cell_type: "raw",
        source: "Raw content is data, not code.",
        metadata: { raw_mimetype: "text/plain", custom_raw: { retained: [1, 2, 3] } },
      },
      {
        id: "code-b",
        cell_type: "code",
        source: "6 * 7",
        metadata: {},
        execution_count: 8,
        outputs: [{
          output_type: "execute_result",
          execution_count: 8,
          data: { "text/plain": "42" },
          metadata: { trusted: false },
        }],
      },
    ],
  };
}

async function writeRawNotebook(
  fixture: NotebookFixture,
  fileName: string,
  notebook: RawNotebook = representativeNotebook(),
): Promise<string> {
  const absolutePath = path.join(fixture.workspaceRoot, fileName);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(notebook, null, 2)}\n`, "utf8");
  return absolutePath;
}

function readBody(result: Awaited<ReturnType<ToolRuntime["executeManualTool"]>>): NotebookReadResult {
  return result.structuredContent as NotebookReadResult;
}

function writeBody(result: Awaited<ReturnType<ToolRuntime["executeManualTool"]>>): StructuredDocumentWriteResult {
  return result.structuredContent as StructuredDocumentWriteResult;
}

function outputData(cell: NotebookReadResult["notebook"]["cells"][number], outputIndex: number) {
  const output = cell.outputs?.[outputIndex];
  if (!output || !("data" in output)) throw new Error(`Expected MIME output at index ${outputIndex}.`);
  return output.data;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("phase 20 notebook tools", () => {
  it("reads nbformat 4 cells and complete requested outputs with stable cursor pagination", async () => {
    const fixture = await createRuntime();
    await writeRawNotebook(fixture, "representative.ipynb");

    const first = await fixture.runtime.executeManualTool(
      "read_notebook",
      { path: "representative.ipynb", cursor: "0", maxCells: 2 },
      fixture.sessionId,
    );
    const firstBody = readBody(first);
    expect(first.success, first.output).toBe(true);
    expect(firstBody).toMatchObject({
      format: "ipynb",
      source: {
        kind: "workspace_path",
        workspaceRelativePath: "representative.ipynb",
        mimeType: notebookMimeType,
      },
      totalCells: 4,
      returnedCells: 2,
      notebook: { nbformat: 4, nbformatMinor: 5 },
      truncation: {
        truncated: true,
        reason: "pagination",
        returnedItems: 2,
        totalItems: 4,
        nextCursor: "2",
      },
    });
    expect(firstBody.notebook.cells.map((cell) => [cell.id, cell.cellType])).toEqual([
      ["intro", "markdown"],
      ["code-a", "code"],
    ]);
    expect(firstBody.notebook.cells[0]?.source).toBe("# Phase 20\nNotebook structure only.");
    expect(firstBody.notebook.cells[0]?.metadata).toMatchObject({
      tags: ["phase20"],
      custom_cell: { retained: "yes" },
    });
    expect(firstBody.notebook.cells[1]).toMatchObject({
      id: "code-a",
      source: "value = 21\nvalue * 2",
      executionCount: 7,
      outputs: [
        { outputType: "stream", name: "stdout", text: "line one\nline two\n" },
        {
          outputType: "display_data",
          data: { "text/plain": ["<result 42>"], "application/json": { answer: 42 } },
          metadata: { isolated: true },
        },
        {
          outputType: "error",
          errorName: "ValueError",
          errorValue: "representative error",
          traceback: ["Traceback fixture", "ValueError: representative error"],
        },
      ],
    });
    expect(firstBody.warnings).toContainEqual(expect.objectContaining({ code: "output_truncated" }));

    const second = await fixture.runtime.executeManualTool(
      "read_notebook",
      { path: "representative.ipynb", cursor: firstBody.truncation.nextCursor, maxCells: 2 },
      fixture.sessionId,
    );
    const secondBody = readBody(second);
    expect(second.success, second.output).toBe(true);
    expect(secondBody.notebook.cells.map((cell) => [cell.id, cell.cellType])).toEqual([
      ["raw-a", "raw"],
      ["code-b", "code"],
    ]);
    expect(secondBody.notebook.cells[1]?.outputs?.[0]).toMatchObject({
      outputType: "execute_result",
      executionCount: 8,
      data: { "text/plain": "42" },
      metadata: { trusted: false },
    });
    expect(secondBody.truncation).toMatchObject({
      truncated: false,
      returnedItems: 2,
      totalItems: 4,
    });
    expect(JSON.stringify(secondBody)).not.toContain("nextCursor");
  });

  it("moves large image and HTML outputs into artifacts without binary model exposure", async () => {
    const fixture = await createRuntime();
    const imageBytes = Buffer.alloc(300_000, 0xab);
    const imagePayload = imageBytes.toString("base64");
    const htmlSentinel = "PHASE20_LARGE_HTML_SENTINEL_";
    const htmlPayload = `<article>${htmlSentinel}${"H".repeat(300_000)}</article>`;
    const notebook = representativeNotebook();
    notebook.cells = [{
      id: "large-output",
      cell_type: "code",
      source: "display outputs already stored in the notebook",
      metadata: {},
      execution_count: 1,
      outputs: [{
        output_type: "display_data",
        data: { "image/png": imagePayload, "text/html": htmlPayload, "text/plain": "bounded fallback" },
        metadata: {},
      }],
    }];
    await writeRawNotebook(fixture, "large-output.ipynb", notebook);

    const result = await fixture.runtime.executeManualTool(
      "read_notebook",
      { path: "large-output.ipynb" },
      fixture.sessionId,
    );
    const body = readBody(result);
    expect(result.success, result.output).toBe(true);
    expect(result.output).not.toContain(imagePayload.slice(0, 1_000));
    expect(result.output).not.toContain(`${htmlSentinel}${"H".repeat(2_000)}`);
    expect(result.output.length).toBeLessThanOrEqual(PHASE20_LIMITS.maxModelVisibleChars);
    expect(body.warnings).toContainEqual(expect.objectContaining({ code: "notebook_output_artifact" }));

    const data = outputData(body.notebook.cells[0]!, 0);
    const imageReference = data["image/png"] as Record<string, unknown>;
    const htmlReference = data["text/html"] as Record<string, unknown>;
    for (const [reference, mimeType] of [
      [imageReference, "image/png"],
      [htmlReference, "text/html"],
    ] as const) {
      expect(reference).toMatchObject({
        artifactUri: expect.stringMatching(/^(?:artifact:\/\/tool-outputs\/|file:\/\/)/u),
        jsonPointer: expect.stringMatching(/^\/cells\/0\/outputs\/0\/data\//u),
        mimeType,
      });
    }
    expect(imageReference.artifactUri).toBe(htmlReference.artifactUri);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      uri: imageReference.artifactUri,
      mimeType: notebookMimeType,
      sourceToolName: "read_notebook",
    }));
    const artifactPath = fixture.sessionStore.resolveToolOutputArtifactPath(String(imageReference.artifactUri));
    expect((await fs.stat(artifactPath)).size).toBeGreaterThan(100_000);
    expect(data["text/plain"]).toBe("bounded fallback");
    const stored = await fixture.sessionStore.listToolOutputArtifacts(fixture.sessionId);
    expect(stored.map((artifact) => artifact.uri)).toContain(imageReference.artifactUri);
  });

  it("redacts sensitive metadata from model output but preserves unknown metadata and secrets on edit", async () => {
    const fixture = await createRuntime();
    const notebook = representativeNotebook();
    notebook.metadata = {
      ...notebook.metadata,
      api_key: "root-secret-api-key",
      nested_credentials: { access_token: "root-secret-token", ordinary: "visible" },
    };
    notebook.cells[0]!.metadata = {
      ...notebook.cells[0]!.metadata,
      password: "cell-secret-password",
      auth: { bearer_token: "cell-secret-bearer", unknown_safe_field: 17 },
    };
    await writeRawNotebook(fixture, "sensitive.ipynb", notebook);

    const read = await fixture.runtime.executeManualTool(
      "read_notebook",
      { path: "sensitive.ipynb" },
      fixture.sessionId,
    );
    const readContent = JSON.stringify(read.structuredContent);
    expect(read.success, read.output).toBe(true);
    for (const secret of [
      "root-secret-api-key",
      "root-secret-token",
      "cell-secret-password",
      "cell-secret-bearer",
    ]) {
      expect(read.output).not.toContain(secret);
      expect(readContent).not.toContain(secret);
    }
    expect(readBody(read).notebook.metadata).toMatchObject({
      api_key: "[REDACTED]",
      nested_credentials: "[REDACTED]",
      custom_root: { owner: "Deep-Mix", nested: { retained: true } },
    });
    expect(readBody(read).notebook.cells[0]?.metadata).toMatchObject({
      password: "[REDACTED]",
      auth: { bearer_token: "[REDACTED]", unknown_safe_field: 17 },
      custom_cell: { retained: "yes" },
    });
    expect(readBody(read).warnings).toContainEqual(expect.objectContaining({ code: "metadata_redacted" }));

    const edited = await fixture.runtime.executeManualTool(
      "edit_notebook",
      {
        path: "sensitive.ipynb",
        outputPath: "out/preserved.ipynb",
        operations: [{ type: "update", cellId: "intro", patch: { source: "# Edited safely" } }],
      },
      fixture.sessionId,
    );
    expect(edited.success, edited.output).toBe(true);
    const persisted = JSON.parse(
      await fs.readFile(path.join(fixture.workspaceRoot, "out/preserved.ipynb"), "utf8"),
    ) as RawNotebook;
    expect(persisted.metadata).toMatchObject({
      api_key: "root-secret-api-key",
      nested_credentials: { access_token: "root-secret-token", ordinary: "visible" },
      custom_root: { owner: "Deep-Mix", nested: { retained: true } },
    });
    expect(persisted.cells[0]?.metadata).toMatchObject({
      password: "cell-secret-password",
      auth: { bearer_token: "cell-secret-bearer", unknown_safe_field: 17 },
      custom_cell: { retained: "yes" },
    });
    expect(persisted.cells[0]?.source).toBe("# Edited safely");
  });

  it("edits cells with insert, update, move, and delete selectors by id and index", async () => {
    const fixture = await createRuntime();
    await writeRawNotebook(fixture, "operations.ipynb");

    const result = await fixture.runtime.executeManualTool(
      "edit_notebook",
      {
        path: "operations.ipynb",
        outputPath: "out/operations-edited.ipynb",
        operations: [
          {
            type: "insert",
            index: 1,
            cell: { id: "inserted", cellType: "markdown", source: "Inserted", metadata: { custom: true } },
          },
          { type: "update", cellId: "code-a", patch: { source: "value = 84", metadata: { updated: true } } },
          { type: "move", cellId: "code-a", destinationIndex: 0 },
          { type: "delete", index: 3 },
        ],
      },
      fixture.sessionId,
    );
    expect(result.success, result.output).toBe(true);
    const persisted = JSON.parse(
      await fs.readFile(path.join(fixture.workspaceRoot, "out/operations-edited.ipynb"), "utf8"),
    ) as RawNotebook;
    expect(persisted.cells.map((cell) => cell.id)).toEqual(["code-a", "intro", "inserted", "code-b"]);
    expect(persisted.cells[0]).toMatchObject({
      id: "code-a",
      cell_type: "code",
      source: "value = 84",
      metadata: { updated: true },
      execution_count: 7,
    });
    expect(persisted.cells[0]?.outputs).toHaveLength(3);
    expect(persisted.cells[2]).toMatchObject({
      id: "inserted",
      cell_type: "markdown",
      source: "Inserted",
      metadata: { custom: true },
    });
  });

  it("rejects duplicate IDs, malformed, spoofed, and oversized notebooks with structured failures", async () => {
    const fixture = await createRuntime();
    const duplicate = representativeNotebook();
    duplicate.cells[1]!.id = duplicate.cells[0]!.id;
    await writeRawNotebook(fixture, "duplicate.ipynb", duplicate);
    await fs.writeFile(path.join(fixture.workspaceRoot, "malformed.ipynb"), "{not valid JSON", "utf8");
    await writeRawNotebook(fixture, "spoofed.ipynb", {
      nbformat: 3,
      nbformat_minor: 0,
      metadata: {},
      cells: [],
    });
    const oversizedPath = path.join(fixture.workspaceRoot, "oversized.ipynb");
    const oversized = await fs.open(oversizedPath, "w");
    try {
      await oversized.truncate(PHASE20_LIMITS.notebook.maxInputBytes + 1);
    } finally {
      await oversized.close();
    }

    for (const [fileName, expectedCode] of [
      ["duplicate.ipynb", "notebook_structure_invalid"],
      ["malformed.ipynb", "notebook_invalid_or_damaged"],
      ["spoofed.ipynb", "unsupported_format"],
      ["oversized.ipynb", "notebook_too_large"],
    ] as const) {
      const result = await fixture.runtime.executeManualTool(
        "read_notebook",
        { path: fileName },
        fixture.sessionId,
      );
      expect(result.success, fileName).toBe(false);
      expect(result.structuredContent).toMatchObject({
        kind: "notebook_error",
        format: expect.stringMatching(/ipynb|unknown/u),
        code: expectedCode,
        error: { type: "command_failed", retryable: false, toolName: "read_notebook" },
      });
      if (fileName === "duplicate.ipynb") {
        expect(JSON.stringify(result.structuredContent)).toMatch(/duplicate|cell.{0,10}id/iu);
      }
    }
  });

  it("rejects strict schema and edit-selector violations without changing the source", async () => {
    const fixture = await createRuntime();
    const sourcePath = await writeRawNotebook(fixture, "schema-source.ipynb");
    const original = await fs.readFile(sourcePath);
    const cases: Array<[string, unknown]> = [
      ["read_notebook", { path: "schema-source.ipynb", cursor: "-1" }],
      ["read_notebook", { path: "schema-source.ipynb", maxCells: 0 }],
      ["read_notebook", { path: "schema-source.ipynb", extra: true }],
      ["edit_notebook", { path: "schema-source.ipynb", operations: [] }],
      ["edit_notebook", {
        path: "schema-source.ipynb",
        operations: [{ type: "update", patch: { source: "missing selector" } }],
      }],
      ["edit_notebook", {
        path: "schema-source.ipynb",
        operations: [{ type: "delete", cellId: "intro", index: 0 }],
      }],
      ["edit_notebook", {
        path: "schema-source.ipynb",
        operations: [{ type: "insert", index: 0, cell: { cellType: "executable", source: "bad", metadata: {} } }],
      }],
      ["edit_notebook", {
        path: "schema-source.ipynb",
        operations: [{ type: "move", cellId: "intro", destinationIndex: -1 }],
      }],
      ["edit_notebook", {
        path: "schema-source.ipynb",
        operations: [{ type: "delete", index: 0 }],
        extra: true,
      }],
    ];
    for (const [toolName, args] of cases) {
      const result = await fixture.runtime.executeManualTool(toolName, args, fixture.sessionId);
      expect(result, `${toolName}: ${JSON.stringify(args).slice(0, 180)}`).toMatchObject({
        success: false,
        structuredContent: { error: { type: "invalid_arguments", retryable: false, toolName } },
      });
      expect(await fs.readFile(sourcePath)).toEqual(original);
    }

    const duplicateInsert = await fixture.runtime.executeManualTool(
      "edit_notebook",
      {
        path: "schema-source.ipynb",
        operations: [{
          type: "insert",
          index: 0,
          cell: { id: "intro", cellType: "markdown", source: "duplicate", metadata: {} },
        }],
      },
      fixture.sessionId,
    );
    expect(duplicateInsert.success).toBe(false);
    expect(JSON.stringify(duplicateInsert.structuredContent)).toMatch(/duplicate|cell.{0,10}id/iu);
    expect(await fs.readFile(sourcePath)).toEqual(original);
  });

  it("never executes cells, starts kernels, installs packages, or calls network APIs", async () => {
    const fixture = await createRuntime();
    const notebook = representativeNotebook();
    notebook.cells[1]!.source = [
      "raise RuntimeError('CELL MUST NOT EXECUTE')\n",
      "open('phase20-cell-executed.txt', 'w').write('unsafe')\n",
      "# pip install forbidden-package\n",
      "# https://example.invalid/remote-kernel",
    ];
    await writeRawNotebook(fixture, "inert.ipynb", notebook);

    const previousFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("Notebook tools must not access the network.");
    }) as typeof fetch;
    try {
      const read = await fixture.runtime.executeManualTool(
        "read_notebook",
        { path: "inert.ipynb" },
        fixture.sessionId,
      );
      expect(read.success, read.output).toBe(true);
      const edit = await fixture.runtime.executeManualTool(
        "edit_notebook",
        {
          path: "inert.ipynb",
          outputPath: "out/inert-copy.ipynb",
          operations: [{ type: "update", cellId: "intro", patch: { source: "Still inert" } }],
        },
        fixture.sessionId,
      );
      expect(edit.success, edit.output).toBe(true);
    } finally {
      globalThis.fetch = previousFetch;
    }
    expect(fetchCalls).toBe(0);
    await expect(fs.stat(path.join(fixture.workspaceRoot, "phase20-cell-executed.txt")))
      .rejects.toMatchObject({ code: "ENOENT" });

    const implementation = await fs.readFile(
      path.join(process.cwd(), "packages/tool-runtime/src/built-ins/structured-documents/notebooks.ts"),
      "utf8",
    );
    expect(implementation).not.toMatch(/from\s+["']node:(?:child_process|http|https|net|tls|vm|worker_threads)["']/u);
    expect(implementation).not.toMatch(/\b(?:fetch|eval)\s*\(/u);
    expect(implementation).not.toMatch(/\bnew\s+Function\s*\(/u);
  });

  it("guards workspace, protected, and junction paths for reads and writes", async () => {
    const fixture = await createRuntime();
    await writeRawNotebook(fixture, "safe.ipynb");

    for (const [toolName, args, expectedType] of [
      ["read_notebook", { path: "../outside.ipynb" }, "invalid_path"],
      ["read_notebook", { path: ".deep-mix/api-key-library/blocked.ipynb" }, "sandbox_denied"],
      ["edit_notebook", {
        path: ".deep-mix/api-key-library/blocked.ipynb",
        operations: [{ type: "delete", index: 0 }],
      }, "sandbox_denied"],
      ["edit_notebook", {
        path: "safe.ipynb",
        outputPath: ".deep-mix/api-key-library/blocked.ipynb",
        operations: [{ type: "delete", index: 0 }],
      }, "sandbox_denied"],
      ["edit_notebook", {
        path: "safe.ipynb",
        outputPath: "../outside.ipynb",
        operations: [{ type: "delete", index: 0 }],
      }, "invalid_path"],
    ] as const) {
      const result = await fixture.runtime.executeManualTool(toolName, args, fixture.sessionId);
      expect(result).toMatchObject({
        success: false,
        structuredContent: { error: { type: expectedType, retryable: false, toolName } },
      });
    }

    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase20-notebook-outside-"));
    temporaryRoots.push(outsideRoot);
    await fs.writeFile(
      path.join(outsideRoot, "outside.ipynb"),
      `${JSON.stringify(representativeNotebook())}\n`,
      "utf8",
    );
    await fs.symlink(outsideRoot, path.join(fixture.workspaceRoot, "outside-link"), "junction");
    for (const [toolName, args] of [
      ["read_notebook", { path: "outside-link/outside.ipynb" }],
      ["edit_notebook", {
        path: "safe.ipynb",
        outputPath: "outside-link/escaped.ipynb",
        operations: [{ type: "delete", index: 0 }],
      }],
    ] as const) {
      const result = await fixture.runtime.executeManualTool(toolName, args, fixture.sessionId);
      expect(result).toMatchObject({
        success: false,
        structuredContent: { error: { type: "invalid_path", retryable: false, toolName } },
      });
    }
  });

  it("creates artifacts and checkpoints and restores exact bytes for new-file and overwrite undo", async () => {
    const fixture = await createRuntime();
    await writeRawNotebook(fixture, "source.ipynb");

    const created = await fixture.runtime.executeManualTool(
      "edit_notebook",
      {
        path: "source.ipynb",
        outputPath: "out/created.ipynb",
        operations: [{ type: "update", cellId: "intro", patch: { source: "Created copy" } }],
      },
      fixture.sessionId,
    );
    const createdBody = writeBody(created);
    expect(created.success, created.output).toBe(true);
    expect(createdBody).toMatchObject({
      format: "ipynb",
      outputPath: "out/created.ipynb",
      sizeBytes: expect.any(Number),
      checkpointId: expect.any(String),
      undoAvailable: true,
      artifact: {
        uri: "file://out/created.ipynb",
        fileName: "created.ipynb",
        mimeType: notebookMimeType,
        kind: "document",
        sourceToolName: "edit_notebook",
        workspaceRelativePath: "out/created.ipynb",
      },
    });
    expect(created.artifacts).toContainEqual(expect.objectContaining(createdBody.artifact));
    expect((await fixture.sessionStore.listUndoCandidates(fixture.sessionId)).map((candidate) => candidate.checkpointId))
      .toContain(createdBody.checkpointId);
    expect((await fixture.sessionStore.listToolOutputArtifacts(fixture.sessionId))).toContainEqual(
      expect.objectContaining({ uri: "file://out/created.ipynb", sourceToolName: "edit_notebook" }),
    );

    const createdPath = path.join(fixture.workspaceRoot, "out/created.ipynb");
    const undoCreated = await fixture.runtime.executeManualTool(
      "undo",
      { checkpointId: createdBody.checkpointId, mode: "code" },
      fixture.sessionId,
    );
    expect(undoCreated.success, undoCreated.output).toBe(true);
    await expect(fs.stat(createdPath)).rejects.toMatchObject({ code: "ENOENT" });

    const sourcePath = path.join(fixture.workspaceRoot, "source.ipynb");
    const originalSource = await fs.readFile(sourcePath);
    const inPlace = await fixture.runtime.executeManualTool(
      "edit_notebook",
      {
        path: "source.ipynb",
        operations: [{ type: "update", cellId: "intro", patch: { source: "In-place edit" } }],
      },
      fixture.sessionId,
    );
    const inPlaceBody = writeBody(inPlace);
    expect(inPlace.success, inPlace.output).toBe(true);
    expect(inPlaceBody).toMatchObject({ outputPath: "source.ipynb", checkpointId: expect.any(String) });
    expect(await fs.readFile(sourcePath)).not.toEqual(originalSource);
    const undoInPlace = await fixture.runtime.executeManualTool(
      "undo",
      { checkpointId: inPlaceBody.checkpointId, mode: "code" },
      fixture.sessionId,
    );
    expect(undoInPlace.success, undoInPlace.output).toBe(true);
    expect(await fs.readFile(sourcePath)).toEqual(originalSource);

    const existingPath = path.join(fixture.workspaceRoot, "existing.ipynb");
    const original = Buffer.from(`${JSON.stringify(representativeNotebook())}\r\n`, "utf8");
    await fs.writeFile(existingPath, original);
    const denied = await fixture.runtime.executeManualTool(
      "edit_notebook",
      {
        path: "source.ipynb",
        outputPath: "existing.ipynb",
        operations: [{ type: "delete", index: 0 }],
      },
      fixture.sessionId,
    );
    expect(denied).toMatchObject({
      success: false,
      structuredContent: { error: { type: "invalid_arguments", fieldPath: "/overwrite" } },
    });
    expect(await fs.readFile(existingPath)).toEqual(original);

    const overwritten = await fixture.runtime.executeManualTool(
      "edit_notebook",
      {
        path: "source.ipynb",
        outputPath: "existing.ipynb",
        overwrite: true,
        operations: [{ type: "delete", index: 0 }],
      },
      fixture.sessionId,
    );
    const overwrittenBody = writeBody(overwritten);
    expect(overwritten.success, overwritten.output).toBe(true);
    expect(await fs.readFile(existingPath)).not.toEqual(original);
    const undoOverwrite = await fixture.runtime.executeManualTool(
      "undo",
      { checkpointId: overwrittenBody.checkpointId, mode: "code" },
      fixture.sessionId,
    );
    expect(undoOverwrite.success, undoOverwrite.output).toBe(true);
    expect(await fs.readFile(existingPath)).toEqual(original);
  });

  it("declares stable schemas, permission, capability probes, registry, and selection metadata", async () => {
    const fixture = await createRuntime();
    await fixture.runtime.initialize();
    const definitions = fixture.runtime.listRegisteredToolDefinitions();
    const read = definitions.find((tool) => tool.name === "read_notebook");
    const edit = definitions.find((tool) => tool.name === "edit_notebook");
    expect(read).toMatchObject({
      name: "read_notebook",
      readOnly: true,
      permissionCategory: "read_only",
      sideEffectLevel: "none",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: expect.any(Object),
          cursor: expect.any(Object),
          maxCells: expect.objectContaining({
            minimum: 1,
            maximum: PHASE20_LIMITS.notebook.maxPageCells,
          }),
        },
      },
      selection: {
        attachmentExtensions: expect.arrayContaining([".ipynb"]),
        mimeTypes: expect.arrayContaining([notebookMimeType, "application/json"]),
        keywords: expect.any(Array),
        keywordGroups: expect.any(Array),
      },
    });
    expect(edit).toMatchObject({
      name: "edit_notebook",
      readOnly: false,
      permissionCategory: "write_file",
      sideEffectLevel: "high",
      checkpoint: { mode: "before_write", scope: "pre_tool_write" },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "operations"],
        properties: {
          path: expect.any(Object),
          outputPath: expect.any(Object),
          overwrite: { type: "boolean" },
          operations: expect.objectContaining({
            type: "array",
            minItems: 1,
            maxItems: expect.any(Number),
          }),
        },
      },
      selection: {
        attachmentExtensions: expect.arrayContaining([".ipynb"]),
        mimeTypes: expect.arrayContaining([notebookMimeType, "application/json"]),
        keywords: expect.any(Array),
        keywordGroups: expect.any(Array),
      },
    });

    expect(readNotebookTool.getAvailability).toEqual(expect.any(Function));
    expect(editNotebookTool.getAvailability).toEqual(expect.any(Function));
    expect(fixture.runtime.listAvailableToolDefinitions().map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["read_notebook", "edit_notebook"]),
    );
    expect(fixture.runtime.selectToolsForTurn({ attachmentExtensions: [".ipynb"] }).definitions.map((tool) => tool.name))
      .toContain("read_notebook");
    expect(fixture.runtime.selectToolsForTurn({ prompt: "Read this Jupyter notebook without executing it." }).definitions.map((tool) => tool.name))
      .toContain("read_notebook");
    expect(fixture.runtime.selectToolsForTurn({ prompt: "Edit notebook cells by ID." }).definitions.map((tool) => tool.name))
      .toContain("edit_notebook");
  });
});
