import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GovernorRuntime } from "../packages/core-governor/src/index.js";
import type {
  AssistantResponse,
  ModelClient,
  ModelCompletionRequest,
  StreamCallbacks,
} from "../packages/shared-schema/src/index.js";

class ScriptedModelClient implements ModelClient {
  private index = 0;

  public constructor(private readonly responses: AssistantResponse[]) {}

  public async streamCompletion(
    _request: ModelCompletionRequest,
    callbacks?: StreamCallbacks,
  ): Promise<AssistantResponse> {
    const response = this.responses[this.index];
    if (!response) {
      throw new Error(`Unexpected model call index ${this.index}`);
    }
    this.index += 1;

    for (const char of response.content) {
      callbacks?.onTextDelta?.(char);
    }

    return response;
  }
}

const temporaryRoots: string[] = [];

async function createFixtureWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase1-"));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "test"), { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "phase1-fixture",
        private: true,
        type: "module",
        scripts: {
          test: "node --test test/add.test.js",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "src", "add.js"),
    [
      "export function add(a, b) {",
      "  return a - b;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "test", "add.test.js"),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/add.js';",
      "",
      "test('add sums two numbers', () => {",
      "  assert.equal(add(2, 3), 5);",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe("phase 1 baseline", () => {
  it("completes a read -> search -> edit -> test loop, persists session state, and resumes", async () => {
    const workspaceRoot = await createFixtureWorkspace();
    const firstRuntime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([
        {
          content: "",
          toolCalls: [
            {
              id: "plan-1",
              name: "update_plan",
              rawArguments: JSON.stringify({
                items: [
                  { id: "inspect", title: "Inspect failing source", status: "in_progress" },
                  { id: "verify", title: "Run tests", status: "pending" },
                ],
              }),
              arguments: {
                items: [
                  { id: "inspect", title: "Inspect failing source", status: "in_progress" },
                  { id: "verify", title: "Run tests", status: "pending" },
                ],
              },
            },
          ],
        },
        {
          content: "",
          toolCalls: [
            {
              id: "read-1",
              name: "read_file",
              rawArguments: JSON.stringify({ path: "src/add.js" }),
              arguments: { path: "src/add.js" },
            },
          ],
        },
        {
          content: "",
          toolCalls: [
            {
              id: "search-1",
              name: "search_files",
              rawArguments: JSON.stringify({ pattern: "return a - b", cwd: "." }),
              arguments: { pattern: "return a - b", cwd: "." },
            },
          ],
        },
        {
          content: "",
          toolCalls: [
            {
              id: "patch-1",
              name: "apply_patch",
              rawArguments: JSON.stringify({
                reason: "Fix add implementation",
                changes: [
                  {
                    path: "src/add.js",
                    action: "upsert",
                    content: ["export function add(a, b) {", "  return a + b;", "}", ""].join("\n"),
                  },
                ],
              }),
              arguments: {
                reason: "Fix add implementation",
                changes: [
                  {
                    path: "src/add.js",
                    action: "upsert",
                    content: ["export function add(a, b) {", "  return a + b;", "}", ""].join("\n"),
                  },
                ],
              },
            },
          ],
        },
        {
          content: "",
          toolCalls: [
            {
              id: "plan-2",
              name: "update_plan",
              rawArguments: JSON.stringify({
                items: [
                  { id: "inspect", title: "Inspect failing source", status: "completed" },
                  { id: "verify", title: "Run tests", status: "in_progress" },
                ],
              }),
              arguments: {
                items: [
                  { id: "inspect", title: "Inspect failing source", status: "completed" },
                  { id: "verify", title: "Run tests", status: "in_progress" },
                ],
              },
            },
          ],
        },
        {
          content: "",
          toolCalls: [
            {
              id: "test-1",
              name: "run_tests",
              rawArguments: JSON.stringify({ command: "node --test test/add.test.js", cwd: "." }),
              arguments: { command: "node --test test/add.test.js", cwd: "." },
            },
          ],
        },
        {
          content: "",
          toolCalls: [
            {
              id: "plan-3",
              name: "update_plan",
              rawArguments: JSON.stringify({
                items: [
                  { id: "inspect", title: "Inspect failing source", status: "completed" },
                  { id: "verify", title: "Run tests", status: "completed" },
                ],
              }),
              arguments: {
                items: [
                  { id: "inspect", title: "Inspect failing source", status: "completed" },
                  { id: "verify", title: "Run tests", status: "completed" },
                ],
              },
            },
          ],
        },
        {
          content: "Patched src/add.js and verified the tests pass.",
          toolCalls: [],
        },
      ]),
    });

    const presentationEvents: Array<{
      kind: "batch" | "tool";
      assistantMessageId?: string;
      callIds: string[];
    }> = [];
    const firstResult = await firstRuntime.runTurn({
      prompt: "Fix the broken add function so the tests pass.",
      callbacks: {
        onToolBatchStart: (batch) => presentationEvents.push({
          kind: "batch",
          assistantMessageId: batch.assistantMessageId,
          callIds: batch.toolCalls.map((toolCall) => toolCall.id),
        }),
        onToolStart: (toolCall) => presentationEvents.push({
          kind: "tool",
          callIds: [toolCall.id],
        }),
      },
    });

    expect(firstResult.finalResponse).toContain("tests pass");
    const batchEvents = presentationEvents.filter((event) => event.kind === "batch");
    expect(batchEvents).toHaveLength(7);
    expect(new Set(batchEvents.map((event) => event.assistantMessageId)).size).toBe(7);
    for (const batch of batchEvents) {
      const batchIndex = presentationEvents.indexOf(batch);
      const firstToolIndex = presentationEvents.findIndex(
        (event, index) => index > batchIndex && event.kind === "tool" && event.callIds[0] === batch.callIds[0],
      );
      expect(firstToolIndex).toBeGreaterThan(batchIndex);
    }
    const fixedFile = await fs.readFile(path.join(workspaceRoot, "src", "add.js"), "utf8");
    expect(fixedFile).toContain("return a + b;");

    const stateRoot = path.join(workspaceRoot, ".deep-mix");
    const sessionsIndex = JSON.parse(await fs.readFile(path.join(stateRoot, "sessions-index.json"), "utf8")) as {
      sessions: Array<{ sessionId: string; status: string; planItems: Array<{ status: string }> }>;
    };
    expect(sessionsIndex.sessions).toHaveLength(1);
    expect(sessionsIndex.sessions[0]?.status).toBe("waiting_for_user");
    expect(sessionsIndex.sessions[0]?.planItems.every((item) => item.status === "completed")).toBe(true);

    const sessionJsonl = await fs.readFile(
      path.join(stateRoot, "sessions", `${firstResult.sessionId}.jsonl`),
      "utf8",
    );
    expect(sessionJsonl).toContain("\"recordType\":\"message\"");
    expect(sessionJsonl).toContain("\"recordType\":\"turn\"");
    expect(sessionJsonl).toContain("\"recordType\":\"plan_update\"");
    expect(await fs.stat(path.join(stateRoot, "file-history", ".git"))).toBeTruthy();
    expect(await fs.stat(path.join(stateRoot, "checkpoints"))).toBeTruthy();
    await expect(fs.access(path.join(workspaceRoot, ".git"))).rejects.toThrow();

    const resumedRuntime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([
        {
          content: "The previous fix changed add() to use addition and kept tests green.",
          toolCalls: [],
        },
      ]),
    });

    const resumedSession = await resumedRuntime.resolveResumeTarget();
    expect(resumedSession.sessionId).toBe(firstResult.sessionId);

    const resumedResult = await resumedRuntime.runTurn({
      sessionId: resumedSession.sessionId,
      prompt: "Summarize the previous fix in one sentence.",
    });

    expect(resumedResult.sessionId).toBe(firstResult.sessionId);
    const resumedJsonl = await fs.readFile(
      path.join(stateRoot, "sessions", `${firstResult.sessionId}.jsonl`),
      "utf8",
    );
    expect(resumedJsonl).toContain("Summarize the previous fix in one sentence.");
    expect(resumedJsonl).toContain("use addition");
  });
});
