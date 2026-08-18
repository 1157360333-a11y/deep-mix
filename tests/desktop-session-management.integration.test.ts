import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GovernorRuntime } from "../packages/core-governor/src/index.js";
import { selectPendingApprovals, SessionStore } from "../packages/persistence/src/index.js";
import type { ApprovalRecord, ModelClient, SessionEvent } from "../packages/shared-schema/src/index.js";

const workspaces: string[] = [];

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "deep-mix-desktop-session-"));
  workspaces.push(workspace);
  return workspace;
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
});

describe("desktop session management", () => {
  it("supports a neutral placeholder until the desktop generates a task title", async () => {
    const workspace = await createWorkspace();
    const store = new SessionStore(workspace);
    const session = await store.createSession("这是一段很长的首条用户提示词", {
      title: "新任务",
      titleSource: "placeholder",
    });

    expect(session.title).toBe("新任务");
    expect(session.titleSource).toBe("placeholder");
  });

  it("persists rename, pin, archive, unread state and deletes the session payload", async () => {
    const workspace = await createWorkspace();
    const store = new SessionStore(workspace);
    const session = await store.createSession("initial title");
    const updated = await store.updateSession(session.sessionId, (current) => ({
      ...current,
      title: "renamed session",
      pinnedAt: "2026-07-10T00:00:00.000Z",
      archivedAt: "2026-07-10T00:01:00.000Z",
      unread: true,
    }));

    expect(updated.title).toBe("renamed session");
    expect(updated.pinnedAt).toBeTruthy();
    expect(updated.archivedAt).toBeTruthy();
    expect(updated.unread).toBe(true);

    const payloadPath = store.getSessionJsonlPath(session.sessionId);
    expect(await store.deleteSession(session.sessionId)).toBe(true);
    expect(await store.loadSession(session.sessionId)).toBeUndefined();
    await expect(access(payloadPath)).rejects.toThrow();
  });

  it("compacts earlier turns into a durable history summary while preserving the transcript", async () => {
    const workspace = await createWorkspace();
    const store = new SessionStore(workspace);
    const session = await store.createSession("compact me");
    for (let turn = 1; turn <= 4; turn += 1) {
      await store.appendMessage({ sessionId: session.sessionId, turnId: `turn-${turn}`, role: "user", content: `user request ${turn} with useful context` });
      await store.appendMessage({ sessionId: session.sessionId, turnId: `turn-${turn}`, role: "assistant", content: `assistant result ${turn} with decisions` });
    }
    await store.setSessionStatus(session.sessionId, "waiting_for_user");
    const modelClient: ModelClient = {
      streamCompletion: async () => { throw new Error("model should not be called by compactSession"); },
    };
    const runtime = new GovernorRuntime({ workspaceRoot: workspace, modelClient, permissionMode: "auto" });
    const result = await runtime.compactSession(session.sessionId);

    expect(result.compacted).toBe(true);
    expect(result.messageCountCompacted).toBe(4);
    expect((await store.loadMessages(session.sessionId))).toHaveLength(8);
    const summary = (await store.loadEvents(session.sessionId)).find(
      (event) => event.recordType === "context_summary" && event.sourceType === "history_compaction",
    );
    expect(summary).toBeTruthy();
    expect((await store.loadSession(session.sessionId))?.latestCompaction?.triggerReason).toBe("manual /compact command");
  });

  it("keeps only the latest approval state for each request and hides stale approvals after completion", () => {
    const base: ApprovalRecord = {
      recordType: "approval",
      approvalId: "approval-1",
      sessionId: "session-1",
      createdAt: "2026-07-10T00:00:00.000Z",
      toolName: "run_shell",
      permissionCategory: "execute_command",
      requestKey: "same-request",
      decision: "ask",
      reason: "needs approval",
      status: "pending",
      persistence: "mode_default",
    };
    const events: SessionEvent[] = [
      base,
      { ...base, createdAt: "2026-07-10T00:00:01.000Z", decision: "allow", status: "resolved", persistence: "allow_once" },
    ];

    expect(selectPendingApprovals(events, "ask_permission")).toEqual([]);
    expect(selectPendingApprovals([base], "completed")).toEqual([]);
  });

  it("coalesces concurrent runtime initialization without leaving Windows rename temp files", async () => {
    const workspace = await createWorkspace();
    const modelClient: ModelClient = {
      streamCompletion: async () => { throw new Error("model should not be called during initialization"); },
    };
    const runtime = new GovernorRuntime({ workspaceRoot: workspace, modelClient, permissionMode: "auto" });

    await Promise.all([
      runtime.initialize(),
      runtime.initialize(),
      runtime.getRuntimeCapabilities(),
      runtime.listSkills(),
      runtime.listWorkflows(),
      runtime.listMcpServerStatuses(),
    ]);

    const stateDirectory = new SessionStore(workspace).paths.stateDir;
    const capabilities = JSON.parse(await readFile(path.join(stateDirectory, "runtime-capabilities.json"), "utf8")) as { checkedAt?: string };
    expect(capabilities.checkedAt).toBeTruthy();
    expect((await readdir(stateDirectory)).filter((name) => name.includes("runtime-capabilities.json.") && name.endsWith(".tmp"))).toEqual([]);
    await expect(access(path.join(workspace, ".deep-mix"))).rejects.toThrow();
  });
});
