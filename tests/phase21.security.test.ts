import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionStore } from "../packages/persistence/src/index.js";
import { createCodingWorkerRouteProfile } from "../packages/route-resolver/src/index.js";
import type { ApprovalRecord, ToolResult, WorkerTask } from "../packages/shared-schema/src/index.js";
import {
  PermissionRequiredError,
  ToolRuntime,
} from "../packages/tool-runtime/src/index.js";
import { publishBinaryFileAtomic } from "../packages/tool-runtime/src/atomic-file.js";
import { recoveryLifecycleToolModule } from "../packages/tool-runtime/src/built-ins/recovery/lifecycle.js";

const temporaryRoots: string[] = [];
const runtimes: ToolRuntime[] = [];

async function temporaryWorkspace(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function pendingApproval(promise: Promise<ToolResult>): Promise<ApprovalRecord> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PermissionRequiredError);
    if (!(error instanceof PermissionRequiredError) || !error.approvalRecord) throw error;
    return error.approvalRecord;
  }
  throw new Error("Expected an explicit lifecycle approval request.");
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose().catch(() => undefined)));
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("phase 21 lifecycle security regressions", () => {
  it("binds legacy worker artifact export approval to the exact source bytes", async () => {
    const workspaceRoot = await temporaryWorkspace("deep-mix-phase21-export-approval-");
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const parent = await sessionStore.createSession("phase21 export approval owner");
    const task: WorkerTask = {
      workerType: "coding",
      objective: "produce one approval-binding artifact",
      constraints: ["structured output only"],
      contextRefs: [{ refType: "summary", label: "fixture", summary: "phase21" }],
      expectedOutput: "code_artifact",
      acceptanceChecks: ["approval binds exact bytes"],
    };
    const route = createCodingWorkerRouteProfile({
      apiKey: "fixture-key-never-sent",
      baseUrl: "https://example.invalid",
      endpointPath: "/chat/completions",
      model: "glm-5.2",
      role: "coding_worker",
      contextWindow: 128_000,
      maxRetries: 1,
      timeoutMs: 180_000,
      temperature: 0.1,
      maxContextChars: 24_000,
      maxContextFiles: 6,
      headers: { "Content-Type": "application/json" },
      requestDefaults: {},
      workspaceWriteAccess: false,
    });
    const worker = await sessionStore.createWorkerSession({
      parentSessionId: parent.sessionId,
      task,
      route,
      timeoutMs: 180_000,
      maxRetries: 1,
    });
    const artifact = await sessionStore.storeCodeArtifact({
      workerSessionId: worker.workerSessionId,
      artifact: {
        kind: "code_artifact",
        summary: "SOURCE_A",
        confidence: 0.9,
        risks: [],
        metadata: {},
        changedFiles: ["src/example.ts"],
        testCommands: ["npm test"],
        notes: [],
      },
      patchContent: "*** Begin Patch\n*** End Patch",
    });
    const runtime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "auto",
      modules: [recoveryLifecycleToolModule],
    });
    runtimes.push(runtime);

    const args = { uri: artifact.artifactRef, targetPath: "exports/approved.json" };
    const firstApproval = await pendingApproval(
      runtime.executeManualTool("export_artifact", args, parent.sessionId),
    );
    const artifactPath = sessionStore.resolveArtifactPath(artifact.artifactRef);
    const original = await fs.readFile(artifactPath, "utf8");
    const changed = original.replace("SOURCE_A", "SOURCE_B");
    expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
    await fs.writeFile(artifactPath, changed, "utf8");

    await runtime.resolveApproval({
      sessionId: parent.sessionId,
      approvalId: firstApproval.approvalId,
      toolName: firstApproval.toolName,
      requestKey: firstApproval.requestKey,
      persistence: "allow_once",
      reason: "Approve only the originally inspected artifact bytes.",
    });
    const replacementApproval = await pendingApproval(
      runtime.executeManualTool("export_artifact", args, parent.sessionId),
    );
    expect(replacementApproval.requestKey).not.toBe(firstApproval.requestKey);
    await expect(fs.stat(path.join(workspaceRoot, args.targetPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks an opened publication staging handle before writing artifact bytes", async () => {
    const workspaceRoot = await temporaryWorkspace("deep-mix-phase21-publication-root-");
    const outsideRoot = await temporaryWorkspace("deep-mix-phase21-publication-outside-");
    const parentPath = path.join(workspaceRoot, "exports");
    const preservedParentPath = path.join(workspaceRoot, "exports-preserved");
    await fs.mkdir(parentPath, { recursive: true });
    const originalOpen = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const requestedPath = String(args[0]);
      if (!swapped && requestedPath.endsWith(".deep-mix.tmp")) {
        swapped = true;
        await fs.rename(parentPath, preservedParentPath);
        await fs.symlink(outsideRoot, parentPath, process.platform === "win32" ? "junction" : "dir");
      }
      return originalOpen(...args);
    }) as typeof fs.open);

    const secretBytes = Buffer.from("PHASE21_PRIVATE_ARTIFACT_BYTES", "utf8");
    await expect(publishBinaryFileAtomic(
      path.join(parentPath, "published.bin"),
      secretBytes,
      undefined,
      { overwrite: false, trustedRoot: workspaceRoot },
    )).rejects.toThrow(/parent changed|symbolic link|outside|unsafe/iu);
    expect(swapped).toBe(true);
    const outsideEntries = await fs.readdir(outsideRoot);
    for (const entry of outsideEntries) {
      const bytes = await fs.readFile(path.join(outsideRoot, entry));
      expect(bytes.includes(secretBytes)).toBe(false);
    }
  });

  it("returns one bounded structured representation and redacts Windows workspace path variants", async () => {
    const workspaceRoot = await temporaryWorkspace("deep-mix-phase21-structured-budget-");
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const session = await sessionStore.createSession("phase21 structured artifact budget");
    const windowsPathVariants = process.platform === "win32"
      ? [
          workspaceRoot.toLocaleLowerCase(),
          workspaceRoot.replaceAll("\\", "/"),
          `\\\\?\\${workspaceRoot}`,
          workspaceRoot.split("\\").map((entry, index) => index % 2 === 0 ? entry : entry.toLocaleUpperCase()).join("/"),
        ]
      : [workspaceRoot];
    const standaloneSk = "sk-phase21CatalogSecret123456";
    const bearerSecret = "Bearer phase21CatalogBearer123456";
    const bareJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYXRhbG9nIn0.c2lnbmF0dXJlc2VjcmV0";
    const artifact = await sessionStore.storeToolOutputArtifact({
      sessionId: session.sessionId,
      toolCallId: "phase21-structured-budget",
      sourceToolName: "phase21_security_fixture",
      fileName: "large.json",
      mimeType: "application/json",
      kind: "text",
      summary: `bounded structured artifact ${windowsPathVariants.join(" ")} ${standaloneSk} ${bearerSecret} ${bareJwt}`,
      content: JSON.stringify({ payload: "A".repeat(1_200_000), paths: windowsPathVariants }),
    });
    const runtime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
      modules: [recoveryLifecycleToolModule],
    });
    runtimes.push(runtime);

    const catalog = await runtime.executeManualTool(
      "list_artifacts",
      { sessionId: session.sessionId, limit: 10 },
      session.sessionId,
    );
    expect(catalog.success).toBe(true);
    expect(catalog.output).not.toContain(standaloneSk);
    expect(catalog.output).not.toContain("phase21CatalogBearer123456");
    expect(catalog.output).not.toContain(bareJwt);
    expect(catalog.output).toContain("[REDACTED_TOKEN]");
    expect(catalog.output).toContain("[REDACTED_JWT]");
    for (const variant of windowsPathVariants) {
      expect(catalog.output.toLocaleLowerCase()).not.toContain(variant.toLocaleLowerCase());
    }

    const result = await runtime.executeManualTool(
      "read_artifact",
      { uri: artifact.uri, limit: 2_000_000 },
      session.sessionId,
    );
    expect(result.success).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(2_100_000);
    expect(result.structuredContent).toHaveProperty("structuredData");
    expect(result.structuredContent).not.toHaveProperty("content");
    for (const variant of windowsPathVariants) {
      expect(result.output.toLocaleLowerCase()).not.toContain(variant.toLocaleLowerCase());
    }
    expect(result.output).toContain("<workspace>");
  });
});
