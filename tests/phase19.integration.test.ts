import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionStore } from "../packages/persistence/src/index.js";
import { SpecialistBroker } from "../packages/specialist-broker/src/index.js";
import type {
  ApprovalRecord,
  CodeSearchResult,
  DependencyAuditResult,
  PermissionMode,
  SecurityScanResult,
  ToolResult,
} from "../packages/shared-schema/src/index.js";
import {
  PermissionRequiredError,
  ToolRuntime,
} from "../packages/tool-runtime/src/index.js";
import {
  createCodeSymbolsTool,
  createCodeIntelligenceToolModule,
  createSemanticSearchTool,
  type CodeIntelligenceToolModuleOptions,
  type DependencyAuditorRequest,
  type LspNavigationRequest,
  type StaticScannerRunner,
} from "../packages/tool-runtime/src/built-ins/code-intelligence/index.js";
import {
  openLocalCodeIndex,
  type LanguageAdapter,
  type LocalCodeIndex,
} from "../packages/tool-runtime/src/code-intelligence/index.js";

const temporaryRoots: string[] = [];
const runtimes: ToolRuntime[] = [];

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

interface RuntimeFixture {
  workspaceRoot: string;
  sessionStore: SessionStore;
  sessionId: string;
  runtime: ToolRuntime;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function runGit(workspaceRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", workspaceRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function structured<T>(result: ToolResult): T {
  return result.structuredContent as T;
}

async function createWorkspace(prefix = "deep-mix-phase19-"): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(workspaceRoot);
  return workspaceRoot;
}

async function writeFile(workspaceRoot: string, relativePath: string, content: string | Buffer): Promise<void> {
  const absolutePath = path.join(workspaceRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content);
}

async function createCodeWorkspace(): Promise<string> {
  const workspaceRoot = await createWorkspace();
  await writeFile(workspaceRoot, ".gitignore", "ignored/\n*.generated.ts\n");
  await writeFile(
    workspaceRoot,
    "src/math.ts",
    [
      "export interface Invoice { subtotal: number; tax: number }",
      "export function calculateTotal(invoice: Invoice): number {",
      "  return invoice.subtotal + invoice.tax; // calculate invoice total",
      "}",
      "export const calculateDiscount = (total: number) => total * 0.1; // calculate invoice total",
      "",
    ].join("\n"),
  );
  await writeFile(
    workspaceRoot,
    "src/use.js",
    [
      "import { calculateTotal } from './math.js';",
      "export const result = calculateTotal({ subtotal: 10, tax: 2 }); // calculate invoice total",
      "export function calculateInvoiceTotalAgain(value) { return value; }",
      "",
    ].join("\n"),
  );
  await writeFile(
    workspaceRoot,
    "scripts/report.py",
    [
      "def calculate_total(invoice):",
      "    # calculate invoice total",
      "    return invoice['subtotal'] + invoice['tax']",
      "",
    ].join("\n"),
  );
  await writeFile(workspaceRoot, "ignored/generated.ts", "export const shouldNeverBeIndexed = true;\n");
  await writeFile(workspaceRoot, "src/skip.generated.ts", "export const generatedSecret = true;\n");
  await writeFile(workspaceRoot, "node_modules/pkg/index.js", "export const dependencyCode = true;\n");
  await writeFile(
    workspaceRoot,
    ".deep-mix/api-key-library/profiles.local.json",
    "{\"apiKey\":\"phase19-sensitive-key-must-not-be-indexed\"}\n",
  );
  return workspaceRoot;
}

async function createRuntime(
  workspaceRoot: string,
  options: CodeIntelligenceToolModuleOptions = {},
  permissionMode: PermissionMode = "danger-full-access",
  settings: Record<string, unknown> = { version: 1 },
): Promise<RuntimeFixture> {
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("phase 19 semantic code intelligence integration");
  const runtime = new ToolRuntime({
    workspaceRoot,
    sessionStore,
    permissionMode,
    environment: {
      ...process.env,
      PATH: [workspaceRoot, process.env.PATH].filter(Boolean).join(path.delimiter),
    },
    settings: settings as never,
    modules: [createCodeIntelligenceToolModule(options)],
  });
  runtimes.push(runtime);
  return { workspaceRoot, sessionStore, sessionId: session.sessionId, runtime };
}

async function createSemanticOnlyRuntime(
  workspaceRoot: string,
  options: Parameters<typeof createSemanticSearchTool>[0],
): Promise<RuntimeFixture> {
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("phase 19 bounded semantic ranking integration");
  const runtime = new ToolRuntime({
    workspaceRoot,
    sessionStore,
    permissionMode: "danger-full-access",
    modules: [{
      manifest: {
        id: "test.phase19-semantic-only",
        version: "1.0.0",
        description: "Phase 19 semantic ranking test module.",
        source: "built_in",
      },
      create: () => [createSemanticSearchTool(options)],
    }],
  });
  runtimes.push(runtime);
  return { workspaceRoot, sessionStore, sessionId: session.sessionId, runtime };
}

async function createDefaultRuntime(workspaceRoot: string): Promise<RuntimeFixture> {
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("phase 19 provider and regression integration");
  const runtime = new ToolRuntime({
    workspaceRoot,
    sessionStore,
    permissionMode: "danger-full-access",
    specialistBroker: new SpecialistBroker({ workspaceRoot, sessionStore }),
  });
  runtimes.push(runtime);
  return { workspaceRoot, sessionStore, sessionId: session.sessionId, runtime };
}

async function pendingApproval(promise: Promise<ToolResult>): Promise<ApprovalRecord> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PermissionRequiredError);
    if (!(error instanceof PermissionRequiredError) || !error.approvalRecord) {
      throw new Error("Expected a persisted pending approval record.");
    }
    return error.approvalRecord;
  }
  throw new Error("Expected the tool call to stop for explicit approval.");
}

async function createDependencyWorkspace(): Promise<{
  workspaceRoot: string;
  lockfilePath: string;
  lockfileText: string;
}> {
  const workspaceRoot = await createWorkspace("deep-mix-phase19-deps-");
  const manifest = {
    name: "phase19-audit-fixture",
    version: "1.0.0",
    dependencies: {
      "direct-a": "1.0.0",
      "ghsa-c": "1.0.0",
    },
  };
  const lockfile = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { ...manifest },
      "node_modules/direct-a": {
        version: "1.0.0",
        dependencies: { "transitive-b": "1.0.0", "no-id-d": "1.0.0" },
      },
      "node_modules/transitive-b": { version: "1.0.0" },
      "node_modules/no-id-d": { version: "1.0.0" },
      "node_modules/ghsa-c": { version: "1.0.0" },
    },
  };
  const lockfileText = `${JSON.stringify(lockfile, null, 2)}\n`;
  const lockfilePath = path.join(workspaceRoot, "package-lock.json");
  await writeFile(workspaceRoot, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(workspaceRoot, "package-lock.json", lockfileText);
  if (process.platform === "win32") {
    await writeFile(workspaceRoot, "npm.cmd", "@echo off\r\necho 19.0.0-test\r\n");
  }
  return { workspaceRoot, lockfilePath, lockfileText };
}

function npmAuditReport(): Record<string, unknown> {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      "direct-a": {
        name: "direct-a",
        severity: "high",
        isDirect: false,
        nodes: ["node_modules/direct-a"],
        range: "<2.0.0",
        via: [{ source: 12345, title: "numeric npm advisory", severity: "high", range: "<2.0.0" }],
        fixAvailable: { name: "direct-a", version: "2.0.0" },
      },
      "transitive-b": {
        name: "transitive-b",
        severity: "critical",
        isDirect: true,
        nodes: ["node_modules/transitive-b"],
        range: "<1.5.0",
        via: [{
          source: "legacy-source",
          title: "CVE transitive advisory",
          url: "https://security.example.invalid/CVE-2026-12345",
          cves: ["CVE-2026-12345"],
          severity: "critical",
          range: "<1.5.0",
        }],
        fixAvailable: { name: "direct-a", version: "3.0.0" },
      },
      "ghsa-c": {
        name: "ghsa-c",
        severity: "moderate",
        nodes: ["node_modules/ghsa-c"],
        range: "*",
        via: [{
          source: "source-ghsa",
          title: "GHSA advisory",
          url: "https://github.com/advisories/GHSA-ABCD-2345-EFGH",
          severity: "moderate",
          range: "*",
        }],
        fixAvailable: false,
      },
      "no-id-d": {
        name: "no-id-d",
        severity: "low",
        nodes: ["node_modules/no-id-d"],
        range: "*",
        via: ["aggregate-only"],
        fixAvailable: false,
      },
    },
    metadata: { vulnerabilities: { total: 4 } },
  };
}

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("phase 19 local code index", () => {
  it("indexes TypeScript, JavaScript and Python locally while enforcing incremental, stale, ignore and sensitive boundaries", async () => {
    const workspaceRoot = await createCodeWorkspace();
    const telemetry: unknown[] = [];
    const index = await openLocalCodeIndex(workspaceRoot, {
      telemetry: (event) => telemetry.push(event),
    });
    const initial = await index.refresh();
    const snapshot = index.snapshot();
    const paths = snapshot.files.map((file) => file.path);

    expect(initial.mode).toBe("full");
    expect(paths).toEqual(expect.arrayContaining(["src/math.ts", "src/use.js", "scripts/report.py"]));
    expect(paths).not.toContain("ignored/generated.ts");
    expect(paths).not.toContain("src/skip.generated.ts");
    expect(paths.some((entry) => entry.startsWith("node_modules/"))).toBe(false);
    expect(paths.some((entry) => entry.startsWith(".deep-mix/"))).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain("phase19-sensitive-key-must-not-be-indexed");
    expect(snapshot.files.find((file) => file.path === "src/math.ts")?.language).toBe("typescript");
    expect(snapshot.files.find((file) => file.path === "src/use.js")?.language).toBe("javascript");
    expect(snapshot.files.find((file) => file.path === "scripts/report.py")?.language).toBe("text");

    await writeFile(workspaceRoot, "src/math.ts", `${await fs.readFile(path.join(workspaceRoot, "src/math.ts"), "utf8")}\nexport const incrementalMarker = 19;\n`);
    const incremental = await index.refresh({ paths: ["src/math.ts"] });
    expect(incremental.mode).toBe("incremental");
    expect(incremental.filesUpdated).toBe(1);
    expect(index.snapshot().generation).toBeGreaterThan(snapshot.generation);

    await writeFile(workspaceRoot, "src/math.ts", "export const changedAfterIndex = true;\n");
    const stale = await index.getFile("src/math.ts", { validate: true });
    expect(stale).toMatchObject({ stale: true, reason: "changed" });
    expect(index.snapshot().stale).toBe(true);
    expect(telemetry.length).toBeGreaterThanOrEqual(2);
  });

  it("enforces capacity, cancellation and workspace isolation", async () => {
    const firstRoot = await createCodeWorkspace();
    const secondRoot = await createCodeWorkspace();
    const first = await openLocalCodeIndex(firstRoot, { limits: { maxFiles: 2 } });
    const second = await openLocalCodeIndex(secondRoot);
    const capacity = await first.refresh();
    await second.refresh();

    expect(capacity.skipped.file_capacity).toBeGreaterThan(0);
    expect(first.snapshot().files.length).toBeLessThanOrEqual(2);
    expect(first.workspaceId).not.toBe(second.workspaceId);

    const controller = new AbortController();
    controller.abort(new Error("phase19 index cancellation"));
    await expect(second.refresh({ signal: controller.signal })).rejects.toThrow("phase19 index cancellation");
  });

  it("marks read errors as truncated and propagates an inexact total to local semantic results", async () => {
    const workspaceRoot = await createCodeWorkspace();
    await writeFile(workspaceRoot, "src/read-error.fixture", "this adapter must fail\n");
    const readErrorAdapter: LanguageAdapter = {
      id: "phase19-read-error-fixture",
      priority: 10_000,
      supports: (relativePath) => relativePath.endsWith(".fixture"),
      extract() {
        throw Object.assign(new Error("phase19 injected read failure"), { code: "EACCES" });
      },
    };
    const index = await openLocalCodeIndex(workspaceRoot, { adapters: [readErrorAdapter] });
    const stats = await index.refresh();

    expect(stats.skipped.read_error).toBeGreaterThan(0);
    expect(stats.truncated).toBe(true);
    expect(index.snapshot().truncated).toBe(true);

    const fixture = await createRuntime(workspaceRoot, { openIndex: async () => index });
    const result = await fixture.runtime.executeManualTool("semantic_search", {
      query: "definitely absent read error query", paths: ["src"], provider: "local",
    }, fixture.sessionId);
    expect(result.success).toBe(true);
    expect(structured<CodeSearchResult>(result)).toMatchObject({
      source: "semantic",
      fallbackType: "local_index",
      totalExact: false,
      truncated: true,
    });
  });

  it("invalidates repository fingerprints and index versions when Git index or HEAD state changes", async () => {
    const workspaceRoot = await createCodeWorkspace();
    runGit(workspaceRoot, ["init", "--quiet"]);
    runGit(workspaceRoot, ["config", "user.email", "phase19@example.invalid"]);
    runGit(workspaceRoot, ["config", "user.name", "Phase 19 Fixture"]);
    runGit(workspaceRoot, ["add", "src/math.ts"]);
    runGit(workspaceRoot, ["commit", "--quiet", "-m", "initial phase19 fingerprint"]);

    const index = await openLocalCodeIndex(workspaceRoot);
    await index.refresh();
    const initial = index.snapshot();

    await writeFile(workspaceRoot, "node_modules/phase19-git-state.txt", "staged only\n");
    runGit(workspaceRoot, ["add", "-f", "node_modules/phase19-git-state.txt"]);
    await index.refresh({ paths: ["src"] });
    const staged = index.snapshot();
    expect(staged.fileFingerprint).toBe(initial.fileFingerprint);
    expect(staged.repositoryFingerprint).not.toBe(initial.repositoryFingerprint);
    expect(staged.indexVersion).not.toBe(initial.indexVersion);

    runGit(workspaceRoot, ["commit", "--quiet", "-m", "advance phase19 HEAD"]);
    await index.refresh({ paths: ["src"] });
    const committed = index.snapshot();
    expect(committed.fileFingerprint).toBe(initial.fileFingerprint);
    expect(committed.repositoryFingerprint).not.toBe(staged.repositoryFingerprint);
    expect(committed.indexVersion).not.toBe(staged.indexVersion);
  });
});

describe("phase 19 code symbols and navigation", () => {
  it("accepts fresh LSP symbols, definitions and references as exact", async () => {
    const workspaceRoot = await createCodeWorkspace();
    const fixture = await createRuntime(workspaceRoot, {
      symbolsLspProvider: {
        async listSymbols(request) {
          const document = request.documentVersions.find((entry) => entry.path === "src/math.ts")!;
          return {
            available: true,
            indexVersion: request.indexVersion,
            stale: false,
            symbols: [{
              name: "calculateTotal",
              kind: "function",
              language: "typescript",
              location: {
                path: document.path,
                language: "typescript",
                contentHash: document.contentHash,
                range: { start: { line: 2, column: 1 }, end: { line: 4, column: 2 } },
              },
            }],
          };
        },
      },
      navigationLspProvider: {
        async goToDefinition(request) {
          return navigationResponse(request, [{ path: "src/math.ts", line: 2, column: 17 }]);
        },
        async findReferences(request) {
          return navigationResponse(request, [
            { path: "src/math.ts", line: 2, column: 17, relation: "declaration" },
            { path: "src/use.js", line: 2, column: 23, relation: "reference_read" },
          ]);
        },
      },
    });

    async function navigationResponse(
      request: LspNavigationRequest,
      targets: Array<{ path: string; line: number; column: number; relation?: "declaration" | "reference_read" }>,
    ) {
      return {
        workspaceId: request.workspaceId,
        indexVersion: request.indexVersion,
        sourceContentHash: request.sourceContentHash,
        stale: false,
        complete: true,
        targets: await Promise.all(targets.map(async (target) => ({
          ...(target.relation ? { relation: target.relation } : {}),
          location: {
            path: target.path,
            language: path.extname(target.path) === ".ts" ? "typescript" : "javascript",
            contentHash: sha256(await fs.readFile(path.join(workspaceRoot, target.path))),
            range: {
              start: { line: target.line, column: target.column },
              end: { line: target.line, column: target.column + "calculateTotal".length },
            },
          },
        }))),
      };
    }

    const symbols = structured<Record<string, unknown> & { items: Array<Record<string, unknown>> }>(
      await fixture.runtime.executeManualTool("code_symbols", { scope: "file", path: "src/math.ts" }, fixture.sessionId),
    );
    expect(symbols).toMatchObject({ source: "lsp", fallbackType: "none", precision: "exact", stale: false });
    expect(symbols.items[0]).toMatchObject({ name: "calculateTotal", source: "lsp", precision: "exact" });

    const definition = structured<Record<string, unknown> & { items: Array<Record<string, unknown>> }>(
      await fixture.runtime.executeManualTool("go_to_definition", {
        file: "src/use.js", line: 2, column: 23, symbol: "calculateTotal",
      }, fixture.sessionId),
    );
    expect(definition).toMatchObject({ exact: true, candidateOnly: false, source: "lsp", fallbackType: "none" });
    expect(definition.items[0]).toMatchObject({ kind: "definition", source: "lsp", precision: "exact" });

    const references = structured<Record<string, unknown> & { items: Array<Record<string, unknown>> }>(
      await fixture.runtime.executeManualTool("find_references", {
        file: "src/use.js", line: 2, column: 23, symbol: "calculateTotal",
      }, fixture.sessionId),
    );
    expect(references).toMatchObject({ exact: true, candidateOnly: false, source: "lsp" });
    expect(references.items.map((item) => item.kind)).toEqual(["declaration", "reference_read"]);
  });

  it("rejects out-of-bounds LSP symbols and navigation targets and fails an invalid origin position", async () => {
    const workspaceRoot = await createCodeWorkspace();
    const navigationCall = vi.fn(async (request: LspNavigationRequest) => ({
      workspaceId: request.workspaceId,
      indexVersion: request.indexVersion,
      sourceContentHash: request.sourceContentHash,
      stale: false,
      complete: true,
      targets: [{
        location: {
          path: "src/math.ts",
          language: "typescript",
          contentHash: sha256(await fs.readFile(path.join(workspaceRoot, "src/math.ts"))),
          range: { start: { line: 999, column: 1 }, end: { line: 999, column: 2 } },
        },
      }],
    }));
    const fixture = await createRuntime(workspaceRoot, {
      symbolsLspProvider: {
        async listSymbols(request) {
          const document = request.documentVersions.find((entry) => entry.path === "src/math.ts")!;
          return {
            available: true,
            indexVersion: request.indexVersion,
            stale: false,
            symbols: [{
              name: "impossibleExactSymbol",
              kind: "function",
              language: "typescript",
              location: {
                path: document.path,
                language: "typescript",
                contentHash: document.contentHash,
                range: { start: { line: 999, column: 1 }, end: { line: 999, column: 2 } },
              },
            }],
          };
        },
      },
      navigationLspProvider: { goToDefinition: navigationCall },
    });

    const symbols = structured<Record<string, unknown> & {
      items: Array<{ source: string }>;
      warnings: string[];
    }>(await fixture.runtime.executeManualTool("code_symbols", {
      scope: "file", path: "src/math.ts",
    }, fixture.sessionId));
    expect(symbols).toMatchObject({ source: "ast", fallbackType: "ast", precision: "approximate" });
    expect(symbols.items.every((item) => item.source !== "lsp")).toBe(true);
    expect(symbols.warnings.join(" ")).toMatch(/UTF-16|outside/iu);

    const definition = structured<Record<string, unknown> & {
      items: Array<{ source: string }>;
      warnings: string[];
    }>(await fixture.runtime.executeManualTool("go_to_definition", {
      file: "src/use.js", line: 2, column: 23, symbol: "calculateTotal",
    }, fixture.sessionId));
    expect(definition).toMatchObject({ exact: false, candidateOnly: true, precision: "approximate" });
    expect(definition.items.every((item) => item.source !== "lsp")).toBe(true);
    expect(definition.warnings.join(" ")).toMatch(/UTF-16|outside/iu);

    const providerCallsBeforeInvalidOrigin = navigationCall.mock.calls.length;
    const invalidOrigin = await fixture.runtime.executeManualTool("go_to_definition", {
      file: "src/use.js", line: 999, column: 1, symbol: "calculateTotal",
    }, fixture.sessionId);
    expect(invalidOrigin.success).toBe(false);
    expect(invalidOrigin.structuredContent).toMatchObject({ errorCode: "invalid_position" });
    expect(navigationCall).toHaveBeenCalledTimes(providerCallsBeforeInvalidOrigin);
  });

  it("marks null and primitive navigation responses as fallback and ignores malformed warning entries", async () => {
    const workspaceRoot = await createCodeWorkspace();
    let malformedCalls = 0;
    const fixture = await createRuntime(workspaceRoot, {
      navigationLspProvider: {
        async goToDefinition() {
          malformedCalls += 1;
          return malformedCalls === 1 ? null as never : 19 as never;
        },
        async findReferences(request) {
          return {
            workspaceId: request.workspaceId,
            indexVersion: request.indexVersion,
            sourceContentHash: request.sourceContentHash,
            stale: false,
            complete: true,
            warnings: ["provider warning retained", 19, { malformed: true }] as never,
            targets: [{
              relation: "declaration",
              location: {
                path: "src/math.ts",
                language: "typescript",
                contentHash: sha256(await fs.readFile(path.join(workspaceRoot, "src/math.ts"))),
                range: { start: { line: 2, column: 17 }, end: { line: 2, column: 31 } },
              },
            }],
          };
        },
      },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const malformed = structured<Record<string, unknown> & { warnings: string[] }>(
        await fixture.runtime.executeManualTool("go_to_definition", {
          file: "src/use.js", line: 2, column: 23, symbol: "calculateTotal",
        }, fixture.sessionId),
      );
      expect(malformed).toMatchObject({ exact: false, candidateOnly: true, precision: "approximate" });
      expect(malformed.warnings.join(" ")).toMatch(/not an object|marked local fallback/iu);
    }

    const references = structured<Record<string, unknown> & { warnings: string[] }>(
      await fixture.runtime.executeManualTool("find_references", {
        file: "src/use.js", line: 2, column: 23, symbol: "calculateTotal",
      }, fixture.sessionId),
    );
    expect(references).toMatchObject({ exact: true, source: "lsp", precision: "exact" });
    expect(references.warnings).toEqual(expect.arrayContaining([
      "provider warning retained",
      expect.stringMatching(/malformed warning metadata|ignored/iu),
    ]));
  });

  it("rejects complete LSP references when an omitted indexable file appears during the request", async () => {
    const workspaceRoot = await createCodeWorkspace();
    const fixture = await createRuntime(workspaceRoot, {
      navigationLspProvider: {
        async findReferences(request) {
          await writeFile(
            workspaceRoot,
            "src/late-reference.ts",
            "import { calculateTotal } from './math.js';\nexport const late = calculateTotal({ subtotal: 1, tax: 1 });\n",
          );
          return {
            workspaceId: request.workspaceId,
            indexVersion: request.indexVersion,
            sourceContentHash: request.sourceContentHash,
            stale: false,
            complete: true,
            targets: [{
              relation: "declaration",
              location: {
                path: "src/math.ts",
                language: "typescript",
                contentHash: sha256(await fs.readFile(path.join(workspaceRoot, "src/math.ts"))),
                range: { start: { line: 2, column: 17 }, end: { line: 2, column: 31 } },
              },
            }],
          };
        },
      },
    });

    const references = structured<Record<string, unknown> & {
      items: Array<{ source: string; to: { path: string } }>;
      warnings: string[];
    }>(await fixture.runtime.executeManualTool("find_references", {
      file: "src/use.js", line: 2, column: 23, symbol: "calculateTotal",
    }, fixture.sessionId));

    expect(references).toMatchObject({
      exact: false,
      candidateOnly: true,
      totalExact: false,
      precision: "approximate",
      source: "ast",
      fallbackType: "ast",
    });
    expect(references.items.every((item) => item.source !== "lsp")).toBe(true);
    expect(references.warnings.length).toBeGreaterThan(0);
  });

  it("refreshes code_symbols fallback after an LSP provider mutates the workspace and throws", async () => {
    const workspaceRoot = await createCodeWorkspace();
    let requestedIndexVersion = "";
    const fixture = await createRuntime(workspaceRoot, {
      symbolsLspProvider: {
        async listSymbols(request) {
          requestedIndexVersion = request.indexVersion;
          await writeFile(
            workspaceRoot,
            "src/late-symbol.ts",
            "export function lateSymbol(): number { return 19; }\n",
          );
          throw new Error("phase19 injected LSP failure after mutation");
        },
      },
    });
    const symbols = structured<Record<string, unknown> & {
      indexVersion: string;
      items: Array<{ name: string; source: string; precision: string }>;
    }>(await fixture.runtime.executeManualTool("code_symbols", {
      scope: "workspace", query: "lateSymbol",
    }, fixture.sessionId));

    expect(symbols).toMatchObject({ source: "ast", fallbackType: "ast", precision: "approximate" });
    expect(symbols.indexVersion).not.toBe(requestedIndexVersion);
    expect(symbols.items).toContainEqual(expect.objectContaining({
      name: "lateSymbol", source: "ast", precision: "approximate",
    }));
  });

  it("refreshes navigation fallback after a provider mutates the workspace and returns malformed output", async () => {
    const workspaceRoot = await createCodeWorkspace();
    let requestedIndexVersion = "";
    const fixture = await createRuntime(workspaceRoot, {
      navigationLspProvider: {
        async findReferences(request) {
          requestedIndexVersion = request.indexVersion;
          await writeFile(
            workspaceRoot,
            "src/late-navigation.ts",
            "import { calculateTotal } from './math.js';\nexport const lateNavigation = calculateTotal({ subtotal: 2, tax: 1 });\n",
          );
          return {
            workspaceId: request.workspaceId,
            indexVersion: request.indexVersion,
            sourceContentHash: request.sourceContentHash,
            stale: false,
            complete: true,
            targets: null as never,
          };
        },
      },
    });
    const references = structured<Record<string, unknown> & {
      indexVersion: string;
      items: Array<{ source: string; precision: string; to: { path: string } }>;
    }>(await fixture.runtime.executeManualTool("find_references", {
      file: "src/use.js", line: 2, column: 23, symbol: "calculateTotal",
    }, fixture.sessionId));

    expect(references).toMatchObject({
      exact: false, candidateOnly: true, precision: "approximate", source: "ast", fallbackType: "ast",
    });
    expect(references.indexVersion).not.toBe(requestedIndexVersion);
    expect(
      references.items.some((item) =>
        item.to.path === "src/late-navigation.ts" && item.source === "ast" && item.precision === "approximate"
      ),
      JSON.stringify(references, null, 2),
    ).toBe(true);
  });

  it("labels missing LSP TypeScript AST and Python lexical fallbacks as approximate", async () => {
    const workspaceRoot = await createCodeWorkspace();
    const fixture = await createRuntime(workspaceRoot);
    const astSymbols = structured<Record<string, unknown> & { items: Array<Record<string, unknown>> }>(
      await fixture.runtime.executeManualTool("code_symbols", { scope: "file", path: "src/math.ts" }, fixture.sessionId),
    );
    expect(astSymbols).toMatchObject({ source: "ast", fallbackType: "ast", precision: "approximate" });
    expect(astSymbols.items.every((item) => item.precision === "approximate" && item.source === "ast")).toBe(true);

    const emptyAstSymbols = structured<Record<string, unknown> & { items: unknown[] }>(
      await fixture.runtime.executeManualTool("code_symbols", {
        scope: "file", path: "src/math.ts", query: "definitely_missing_symbol",
      }, fixture.sessionId),
    );
    expect(emptyAstSymbols).toMatchObject({
      items: [], source: "ast", fallbackType: "ast", precision: "approximate", confidence: 0.88,
    });

    const lexicalSymbols = structured<Record<string, unknown> & { items: Array<Record<string, unknown>> }>(
      await fixture.runtime.executeManualTool("code_symbols", {
        scope: "file", path: "scripts/report.py", query: "calculate_total",
      }, fixture.sessionId),
    );
    expect(lexicalSymbols).toMatchObject({ source: "lexical", fallbackType: "lexical", precision: "approximate" });
    expect(lexicalSymbols.items[0]).toMatchObject({ kind: "unknown", source: "lexical", precision: "approximate" });

    const astDefinition = structured<Record<string, unknown>>(
      await fixture.runtime.executeManualTool("go_to_definition", {
        file: "src/use.js", line: 2, column: 23, symbol: "calculateTotal",
      }, fixture.sessionId),
    );
    expect(astDefinition).toMatchObject({ exact: false, candidateOnly: true, source: "ast", fallbackType: "ast" });

    const lexicalReferences = structured<Record<string, unknown>>(
      await fixture.runtime.executeManualTool("find_references", {
        file: "scripts/report.py", line: 1, column: 5, symbol: "calculate_total",
      }, fixture.sessionId),
    );
    expect(lexicalReferences).toMatchObject({ exact: false, candidateOnly: true, source: "lexical", fallbackType: "lexical" });
  });

  it("rejects stale LSP responses and falls back without an exactness claim", async () => {
    const workspaceRoot = await createCodeWorkspace();
    const fixture = await createRuntime(workspaceRoot, {
      symbolsLspProvider: {
        async listSymbols(request) {
          return { available: true, symbols: [], indexVersion: request.indexVersion, stale: true };
        },
      },
      navigationLspProvider: {
        async goToDefinition(request) {
          return {
            workspaceId: request.workspaceId,
            indexVersion: request.indexVersion,
            sourceContentHash: request.sourceContentHash,
            stale: true,
            complete: true,
            targets: [],
          };
        },
      },
    });
    const symbols = structured<Record<string, unknown>>(
      await fixture.runtime.executeManualTool("code_symbols", { scope: "file", path: "src/math.ts" }, fixture.sessionId),
    );
    expect(symbols).toMatchObject({ source: "ast", fallbackType: "ast", precision: "approximate" });
    expect(JSON.stringify(symbols)).toMatch(/stale|freshness/iu);

    const definition = structured<Record<string, unknown>>(
      await fixture.runtime.executeManualTool("go_to_definition", {
        file: "src/use.js", line: 2, column: 23, symbol: "calculateTotal",
      }, fixture.sessionId),
    );
    expect(definition).toMatchObject({ exact: false, candidateOnly: true, precision: "approximate" });
    expect(JSON.stringify(definition)).toMatch(/freshness|version/iu);
  });
});

describe("phase 19 semantic search", () => {
  it("ranks and paginates complete local-only matches with bounded artifacts", async () => {
    const workspaceRoot = await createCodeWorkspace();
    const fixture = await createRuntime(workspaceRoot);
    const args = {
      query: "calculate invoice total",
      provider: "local",
      maxResults: 20,
      maxResultChars: 20_000,
      maxSnippetChars: 160,
    };
    const ranked = structured<CodeSearchResult>(
      await fixture.runtime.executeManualTool("semantic_search", args, fixture.sessionId),
    );
    expect(ranked).toMatchObject({
      localOnly: true,
      externalDataShared: false,
      dataBoundary: "local_only",
      precision: "approximate",
    });
    expect(ranked.items.length).toBeGreaterThan(1);
    expect(ranked.items.map((item) => item.score)).toEqual(
      [...ranked.items.map((item) => item.score)].sort((left, right) => right - left),
    );
    expect(ranked.items.every((item) => item.location.path && item.location.range && item.explanation)).toBe(true);

    const first = structured<CodeSearchResult>(
      await fixture.runtime.executeManualTool("semantic_search", { ...args, maxResults: 1 }, fixture.sessionId),
    );
    expect(first.returned).toBe(1);
    expect(first.hasMore).toBe(true);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = structured<CodeSearchResult>(
      await fixture.runtime.executeManualTool("semantic_search", {
        ...args,
        maxResults: 1,
        cursor: first.nextCursor,
      }, fixture.sessionId),
    );
    expect(second.items[0]?.location).not.toEqual(first.items[0]?.location);
    expect(first.artifactUri).toMatch(/^artifact:\/\/tool-outputs\//u);
  });

  it("keeps zero local matches semantic when a verified semantic adapter is available", async () => {
    const workspaceRoot = await createCodeWorkspace();
    const fixture = await createRuntime(workspaceRoot);
    const result = await fixture.runtime.executeManualTool("semantic_search", {
      query: "phase19-no-such-semantic-token-7f91",
      paths: ["src"],
      languages: ["typescript"],
      provider: "local",
    }, fixture.sessionId);
    expect(result.success).toBe(true);
    expect(structured<CodeSearchResult>(result)).toMatchObject({
      items: [],
      source: "semantic",
      fallbackType: "local_index",
      precision: "approximate",
      totalExact: true,
    });
  });

  it("locates CR-only lexical fallback matches with U+0130 expansion in UTF-16 columns", async () => {
    const workspaceRoot = await createCodeWorkspace();
    const crOnlySource = "header\rmiddle\rxx\u0130dent = 1\rtail";
    await writeFile(workspaceRoot, "scripts/cr-only.py", crOnlySource);
    const fixture = await createRuntime(workspaceRoot);
    const result = await fixture.runtime.executeManualTool("semantic_search", {
      query: "\u0130dent",
      paths: ["scripts"],
      languages: ["python"],
      provider: "local",
    }, fixture.sessionId);
    const body = structured<CodeSearchResult>(result);
    const match = body.items.find((item) => item.location.path === "scripts/cr-only.py");

    expect(result.success).toBe(true);
    expect(crOnlySource).not.toContain("\n");
    expect(body).toMatchObject({ source: "lexical", fallbackType: "lexical", precision: "approximate" });
    expect(match?.location.range).toEqual({
      start: { line: 3, column: 3 },
      end: { line: 3, column: 8 },
    });
  });

  it("marks a zero-hit local ranking truncated when its bounded work budget is reached", async () => {
    const workspaceRoot = await createCodeWorkspace();
    const index = await openLocalCodeIndex(workspaceRoot);
    const fixture = await createSemanticOnlyRuntime(workspaceRoot, {
      openIndex: async () => index,
      localRankingLimits: { maxScannedSnippets: 1, deadlineMs: 5_000, yieldEvery: 1 },
    });
    const result = await fixture.runtime.executeManualTool("semantic_search", {
      query: "phase19-budget-zero-hit-query",
      paths: ["src"],
      provider: "local",
    }, fixture.sessionId);
    const body = structured<CodeSearchResult>(result);

    expect(result.success).toBe(true);
    expect(body).toMatchObject({
      items: [],
      source: "semantic",
      fallbackType: "local_index",
      totalExact: false,
      truncated: true,
    });
    expect(body.warnings.join(" ")).toMatch(/budget|bounded/iu);
  });

  it("fails fast before local ranking work when the execution signal is already aborted", async () => {
    const workspaceRoot = await createCodeWorkspace();
    const realIndex = await openLocalCodeIndex(workspaceRoot);
    await realIndex.refresh();
    const snapshot = realIndex.snapshot();
    const originalFile = snapshot.files.find((file) => file.path === "src/math.ts")!;
    let rankingWorkObserved = false;
    const guardedFile = { ...originalFile };
    Object.defineProperty(guardedFile, "tokens", {
      enumerable: true,
      get() {
        rankingWorkObserved = true;
        return originalFile.tokens;
      },
    });
    const inertIndex = {
      async refresh() {
        return undefined as never;
      },
      snapshot() {
        return { ...snapshot, files: [guardedFile] };
      },
    } as unknown as LocalCodeIndex;
    const fixture = await createSemanticOnlyRuntime(workspaceRoot, {
      openIndex: async () => inertIndex,
      localRankingLimits: { maxScannedSnippets: 10_000, deadlineMs: 5_000, yieldEvery: 1 },
    });
    const controller = new AbortController();
    controller.abort(new Error("phase19 pre-aborted local rank"));
    const result = await fixture.runtime.executeManualTool("semantic_search", {
      query: "calculate invoice total", provider: "local",
    }, fixture.sessionId, { signal: controller.signal });

    expect(result.success).toBe(false);
    expect(rankingWorkObserved).toBe(false);
    expect(result.output).toMatch(/pre-aborted local rank|cancel/iu);
  });

  it("does not call or share data with a configured implementation when external semantic search is disabled", async () => {
    const workspaceRoot = await createCodeWorkspace();
    const search = vi.fn(async () => ({ rankings: [] }));
    const fixture = await createRuntime(workspaceRoot, {
      externalSemanticProvider: { search },
    });
    const result = await fixture.runtime.executeManualTool("semantic_search", {
      query: "phase19 private semantic query",
      provider: "external",
    }, fixture.sessionId);
    expect(result.success).toBe(false);
    expect(search).not.toHaveBeenCalled();
    expect(result.output).toMatch(/disabled|external_provider_disabled/iu);
    expect(result.output).not.toContain("phase19 private semantic query");
  });

  it("rejects an external semantic continuation when provider ordering changes after page one", async () => {
    const workspaceRoot = await createCodeWorkspace();
    let providerCalls = 0;
    const fixture = await createRuntime(
      workspaceRoot,
      {
        externalSemanticProvider: {
          async search(request) {
            const candidates = providerCalls++ === 0
              ? [...request.candidates]
              : [...request.candidates].reverse();
            return {
              rankings: candidates.map((candidate, index) => ({
                candidateId: candidate.id,
                score: 1 - index / Math.max(2, candidates.length + 1),
                confidence: 0.7,
                explanation: `fixture ranking ${index}`,
              })),
            };
          },
        },
      },
      "danger-full-access",
      {
        version: 1,
        codeIntelligence: {
          externalEmbedding: {
            enabled: true,
            provider: "phase19-fixture",
            endpoint: "https://semantic.example.invalid/rank",
            allowedHosts: ["semantic.example.invalid"],
            dataBoundary: "Only bounded local snippets selected by semantic_search.",
          },
        },
      },
    );
    const args = {
      query: "calculate invoice total",
      provider: "external",
      maxResults: 1,
      maxResultChars: 20_000,
      maxSnippetChars: 160,
    };
    const first = structured<CodeSearchResult>(
      await fixture.runtime.executeManualTool("semantic_search", args, fixture.sessionId),
    );
    expect(first.nextCursor).toEqual(expect.any(String));
    const continuation = await fixture.runtime.executeManualTool("semantic_search", {
      ...args,
      cursor: first.nextCursor,
    }, fixture.sessionId);
    expect(providerCalls).toBe(2);
    expect(continuation.success).toBe(false);
    expect(continuation.structuredContent).toMatchObject({ errorCode: "invalid_cursor", items: [] });
  });

  it("marks incomplete or invalid external rankings inexact without emitting non-finite values", async () => {
    const workspaceRoot = await createCodeWorkspace();
    const fixture = await createRuntime(
      workspaceRoot,
      {
        externalSemanticProvider: {
          async search(request) {
            const first = request.candidates[0]!;
            const second = request.candidates[1]!;
            return {
              rankings: [
                { candidateId: first.id, score: 0.9, confidence: 0.8, explanation: "accepted" },
                { candidateId: first.id, score: 0.7, confidence: 0.7, explanation: "duplicate" },
                { candidateId: "phase19-unknown-candidate", score: 0.6, confidence: 0.6 },
                { candidateId: second.id, score: 0.5, confidence: Number.NaN },
              ],
            };
          },
        },
      },
      "danger-full-access",
      {
        version: 1,
        codeIntelligence: {
          externalEmbedding: {
            enabled: true,
            provider: "phase19-incomplete-ranking-fixture",
            endpoint: "https://semantic.example.invalid/rank",
            allowedHosts: ["semantic.example.invalid"],
            dataBoundary: "Only bounded local snippets selected by semantic_search.",
          },
        },
      },
    );
    const result = await fixture.runtime.executeManualTool("semantic_search", {
      query: "calculate invoice total",
      provider: "external",
      maxResults: 20,
      maxResultChars: 20_000,
      maxSnippetChars: 160,
    }, fixture.sessionId);
    const body = structured<CodeSearchResult>(result);

    expect(result.success).toBe(true);
    expect(body).toMatchObject({ totalExact: false, truncated: true, externalDataShared: true });
    expect(body.items).toHaveLength(1);
    expect(body.items.every((item) => Number.isFinite(item.score) && Number.isFinite(item.confidence))).toBe(true);
    expect(JSON.stringify(body.items)).not.toContain("null");
    expect(body.warnings.join(" ")).toMatch(/omitted|invalid|duplicate|not exact/iu);
  });

  it("fails closed when external semantic approval context drifts before execution", async () => {
    const workspaceRoot = await createCodeWorkspace();
    const search = vi.fn(async () => ({ rankings: [] }));
    const settings = {
      version: 1,
      codeIntelligence: {
        externalEmbedding: {
          enabled: true,
          provider: "phase19-approval-fixture",
          endpoint: "https://semantic.example.invalid/rank",
          allowedHosts: ["semantic.example.invalid"],
          dataBoundary: "Initial approved bounded snippets.",
        },
      },
    };
    const fixture = await createRuntime(
      workspaceRoot,
      { externalSemanticProvider: { search } },
      "auto",
      settings,
    );
    const args = {
      query: "calculate invoice total",
      provider: "external",
      maxSnippetChars: 160,
    };
    const initial = await pendingApproval(
      fixture.runtime.executeManualTool("semantic_search", args, fixture.sessionId),
    );
    await fixture.runtime.resolveApproval({
      sessionId: fixture.sessionId,
      approvalId: initial.approvalId,
      toolName: initial.toolName,
      requestKey: initial.requestKey,
      persistence: "allow_once",
      reason: "Approve only the initial external semantic data boundary.",
    });

    settings.codeIntelligence.externalEmbedding.dataBoundary = "Drifted and not yet approved boundary.";
    const drifted = await pendingApproval(
      fixture.runtime.executeManualTool("semantic_search", args, fixture.sessionId),
    );
    expect(drifted.requestKey).not.toBe(initial.requestKey);
    expect(drifted).toMatchObject({
      status: "pending",
      decision: "ask",
      permissionCategory: "external_system",
    });
    expect(search).not.toHaveBeenCalled();
  });
});

describe("phase 19 dependency audit", () => {
  it("keeps offline inspection local, report-only and artifact-backed", async () => {
    const { workspaceRoot, lockfilePath, lockfileText } = await createDependencyWorkspace();
    const fixture = await createRuntime(workspaceRoot);
    const result = await fixture.runtime.executeManualTool("dependency_audit", {
      mode: "offline",
      scope: "workspace",
      path: ".",
    }, fixture.sessionId);
    const body = structured<DependencyAuditResult>(result);
    expect(result.success).toBe(true);
    expect(body).toMatchObject({
      status: "degraded",
      networkAccess: false,
      networkAttempted: false,
      advisoryCoverage: "local_metadata_only",
      dependencyInstallAttempted: false,
      lockfileModified: false,
      automaticChangesApplied: false,
    });
    expect(body.artifactUri).toMatch(/^artifact:\/\/tool-outputs\//u);
    expect(JSON.parse(await fixture.sessionStore.readTextToolOutputArtifact(body.artifactUri))).toMatchObject({
      reportType: "npm_lockfile_local_metadata",
      advisoryDatabaseConsulted: false,
    });
    expect(await fs.readFile(lockfilePath, "utf8")).toBe(lockfileText);
  });

  it("binds online audit to phase-16 permission context and normalizes real IDs, chains and remediation without modifying the lock", async () => {
    const { workspaceRoot, lockfilePath, lockfileText } = await createDependencyWorkspace();
    const requests: DependencyAuditorRequest[] = [];
    const auditor = {
      displayName: "Injected npm audit fixture",
      version: "19.0.0-test",
      async run(request: DependencyAuditorRequest) {
        requests.push(request);
        return {
          command: request.command,
          cwd: request.cwd,
          stdout: JSON.stringify(npmAuditReport()),
          stderr: "",
          exitCode: 1,
          timedOut: false,
          outputTruncated: false,
        };
      },
    };
    const fixture = await createRuntime(workspaceRoot, { dependencyAuditor: auditor }, "auto");
    const args = { mode: "online", scope: "workspace", path: ".", maxResults: 20 };
    const pending = await pendingApproval(fixture.runtime.executeManualTool("dependency_audit", args, fixture.sessionId));
    expect(pending).toMatchObject({
      status: "pending",
      decision: "ask",
      permissionCategory: "external_system",
      requestKey: expect.any(String),
    });
    expect(requests).toHaveLength(0);
    await fixture.runtime.resolveApproval({
      sessionId: fixture.sessionId,
      approvalId: pending.approvalId,
      toolName: pending.toolName,
      requestKey: pending.requestKey,
      persistence: "allow_once",
      reason: "Approve the immutable report-only npm audit request.",
    });
    const result = await fixture.runtime.executeManualTool("dependency_audit", args, fixture.sessionId);
    const body = structured<DependencyAuditResult>(result);

    expect(result.success).toBe(true);
    expect(body).toMatchObject({
      status: "available",
      networkAccess: true,
      networkAttempted: true,
      advisoryCoverage: "online_audit",
      dependencyInstallAttempted: false,
      lockfileModified: false,
      automaticChangesApplied: false,
    });
    expect(requests).toHaveLength(1);
    expect(Object.isFrozen(requests[0])).toBe(true);
    expect(Object.isFrozen(requests[0]!.args)).toBe(true);
    expect(requests[0]!.args).toEqual(expect.arrayContaining([
      "audit",
      "--json",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-fund",
      "--registry=https://registry.npmjs.org/",
    ]));
    expect(requests[0]!.args).not.toEqual(expect.arrayContaining(["install", "update", "upgrade", "fix", "--fix"]));

    const byPackage = new Map(body.items.map((item) => [item.packageName, item]));
    expect(byPackage.get("direct-a")).toMatchObject({
      advisoryId: "NPM-12345",
      advisoryIdStatus: "reported",
      direct: true,
      dependencyChain: ["direct-a"],
      fixedVersions: ["2.0.0"],
    });
    expect(byPackage.get("transitive-b")).toMatchObject({
      advisoryId: "CVE-2026-12345",
      advisoryIdStatus: "reported",
      direct: false,
      dependencyChain: ["direct-a", "transitive-b"],
      fixedVersions: [],
    });
    expect(byPackage.get("transitive-b")?.recommendation).toContain("upstream dependency direct-a");
    expect(byPackage.get("ghsa-c")?.advisoryId).toBe("GHSA-ABCD-2345-EFGH");
    expect(byPackage.get("no-id-d")).toMatchObject({ advisoryIdStatus: "unavailable", direct: false });
    expect(byPackage.get("no-id-d")).not.toHaveProperty("advisoryId");
    expect(body.items.every((item) => item.source.reportArtifactUri === body.artifactUri)).toBe(true);
    const rawArtifact = JSON.parse(await fixture.sessionStore.readTextToolOutputArtifact(body.artifactUri));
    expect(rawArtifact.command).toContain("--registry=https://registry.npmjs.org/");
    expect(rawArtifact.dataBoundary).toMatch(/package names.*installed versions.*dependency graph/iu);
    const executionAudit = (await fixture.sessionStore.loadEvents(fixture.sessionId)).find((event) =>
      event.recordType === "tool_execution_audit" && event.toolName === "dependency_audit" && event.success
    );
    expect(executionAudit?.recordType === "tool_execution_audit" ? executionAudit.accessKinds : [])
      .toEqual(expect.arrayContaining(["filesystem_read", "command_execute", "network_access"]));
    expect(await fs.readFile(lockfilePath, "utf8")).toBe(lockfileText);
  });

  it("records networkAttempted and a raw artifact when post-run report processing fails", async () => {
    const { workspaceRoot, lockfilePath, lockfileText } = await createDependencyWorkspace();
    const auditor = {
      displayName: "Malformed report fixture",
      async run(request: DependencyAuditorRequest) {
        return {
          command: request.command,
          cwd: request.cwd,
          stdout: JSON.stringify({ auditReportVersion: 2, metadata: {} }),
          stderr: "runner completed before normalization failed",
          exitCode: 0,
          timedOut: false,
          outputTruncated: false,
        };
      },
    };
    const fixture = await createRuntime(workspaceRoot, { dependencyAuditor: auditor });
    const result = await fixture.runtime.executeManualTool("dependency_audit", {
      mode: "online", scope: "workspace", path: ".",
    }, fixture.sessionId);
    const body = structured<DependencyAuditResult>(result);
    expect(result.success).toBe(false);
    expect(body).toMatchObject({ networkAttempted: true, networkAccess: true, lockfileModified: false });
    expect(body.artifactUri).toMatch(/^artifact:\/\/tool-outputs\//u);
    const artifact = JSON.parse(await fixture.sessionStore.readTextToolOutputArtifact(body.artifactUri));
    expect(artifact).toMatchObject({ reportType: "npm_audit_execution_error", networkAttempted: true });
    expect(await fs.readFile(lockfilePath, "utf8")).toBe(lockfileText);
  });
});

describe("phase 19 security scan", () => {
  const syntheticToken = ["github", "pat", "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"].join("_");

  async function createSecurityWorkspace(): Promise<{ workspaceRoot: string; source: string }> {
    const workspaceRoot = await createWorkspace("deep-mix-phase19-security-");
    const source = `export const token = '${syntheticToken}';\n`;
    await writeFile(workspaceRoot, "src/secret.ts", source);
    await writeFile(workspaceRoot, "rules/security.yml", "rules: []\n");
    return { workspaceRoot, source };
  }

  it("returns explicit unavailable and timeout states without installing a scanner or patching", async () => {
    const missingWorkspace = await createSecurityWorkspace();
    const missingScan = vi.fn();
    const missing: StaticScannerRunner = {
      async probe() {
        return { available: false, name: "semgrep", message: "semgrep missing" };
      },
      scan: missingScan,
    };
    const missingFixture = await createRuntime(missingWorkspace.workspaceRoot, { securityScanner: missing });
    const missingResult = await missingFixture.runtime.executeManualTool("security_scan", {
      paths: ["src"], rules: ["rules/security.yml"],
    }, missingFixture.sessionId);
    expect(missingResult.success).toBe(false);
    expect(missingResult.structuredContent).toMatchObject({
      status: "unavailable",
      errorCode: "capability_unavailable",
      scannerInstallAttempted: false,
      patchesApplied: false,
    });
    expect(missingScan).not.toHaveBeenCalled();

    const timeoutWorkspace = await createSecurityWorkspace();
    const timeout: StaticScannerRunner = {
      async probe() {
        return { available: true, name: "semgrep", version: "test", message: "available" };
      },
      async scan(request) {
        return {
          name: "semgrep",
          version: "test",
          rawReport: "",
          exitCode: null,
          timedOut: true,
          outputTruncated: false,
          request,
        } as never;
      },
    };
    const timeoutFixture = await createRuntime(timeoutWorkspace.workspaceRoot, { securityScanner: timeout });
    const timeoutResult = await timeoutFixture.runtime.executeManualTool("security_scan", {
      paths: ["src"], rules: ["rules/security.yml"], timeoutMs: 1_000,
    }, timeoutFixture.sessionId);
    expect(timeoutResult.success).toBe(false);
    expect(timeoutResult.structuredContent).toMatchObject({
      status: "degraded",
      errorCode: "timeout",
      scannerInstallAttempted: false,
      patchesApplied: false,
    });
    expect(await fs.readFile(path.join(timeoutWorkspace.workspaceRoot, "src/secret.ts"), "utf8"))
      .toBe(timeoutWorkspace.source);
  });

  it("deduplicates and normalizes findings while redacting the required artifact and applying no patch", async () => {
    const { workspaceRoot, source } = await createSecurityWorkspace();
    const interpolatedSecret = syntheticToken;
    const rawFinding = {
      check_id: "security.hardcoded-secret-token",
      path: "src/secret.ts",
      start: { line: 1, col: 14 },
      end: { line: 1, col: 65 },
      extra: {
        message: `Hardcoded secret token ${interpolatedSecret}`,
        severity: "ERROR",
        lines: source.trim(),
        metadata: {
          cwe: ["CWE-798: Use of Hard-coded Credentials"],
          remediation: "Move the credential to an approved secret store.",
        },
      },
    };
    const scanner: StaticScannerRunner = {
      async probe() {
        return { available: true, name: "semgrep-fixture", version: "1.2.3", message: "available" };
      },
      async scan() {
        return {
          name: "semgrep-fixture",
          version: "1.2.3",
          rawReport: JSON.stringify({ version: "1.2.3", results: [rawFinding, rawFinding], errors: [] }),
          exitCode: 0,
          timedOut: false,
          outputTruncated: false,
        };
      },
    };
    const fixture = await createRuntime(workspaceRoot, { securityScanner: scanner });
    const result = await fixture.runtime.executeManualTool("security_scan", {
      paths: ["src"],
      rules: ["rules/security.yml"],
      maxEvidenceChars: 200,
    }, fixture.sessionId);
    const body = structured<SecurityScanResult>(result);
    expect(result.success).toBe(true);
    expect(body).toMatchObject({
      status: "available",
      total: 1,
      returned: 1,
      scannerInstallAttempted: false,
      patchesApplied: false,
      automaticChangesApplied: false,
    });
    expect(body.items[0]).toMatchObject({
      ruleId: "security.hardcoded-secret-token",
      severity: "high",
      rawSeverity: "ERROR",
      cwe: ["CWE-798"],
      location: { path: "src/secret.ts", language: "typescript" },
      title: "Sensitive static-analysis finding; interpolated details were redacted.",
      evidence: { redacted: true, snippet: "[REDACTED_SENSITIVE_EVIDENCE]" },
      recommendation: expect.stringMatching(/approved secret store/iu),
    });
    expect(body.artifactUri).toMatch(/^artifact:\/\/tool-outputs\//u);
    const artifact = await fixture.sessionStore.readTextToolOutputArtifact(body.artifactUri);
    expect(result.output).not.toContain(interpolatedSecret);
    expect(artifact).not.toContain(interpolatedSecret);
    expect(artifact).toContain("[REDACTED_SENSITIVE_MESSAGE]");
    expect(artifact).toContain("[REDACTED_SENSITIVE_EVIDENCE]");
    expect(await fs.readFile(path.join(workspaceRoot, "src/secret.ts"), "utf8")).toBe(source);
  });

  it("drops out-of-scope, missing and out-of-bounds findings and fully redacts multi-word evidence", async () => {
    const workspaceRoot = await createWorkspace("deep-mix-phase19-security-scope-");
    const source = 'const password = "very secret value";\nexport const enabled = true;\n';
    const unicodeLine = 'export const \u6807\u7b7e = "\u{1f510}";';
    const utf16OutOfBoundsColumn = unicodeLine.length + 2;
    await writeFile(workspaceRoot, "src/config.ts", source);
    await writeFile(workspaceRoot, "src/unicode.ts", `${unicodeLine}\n`);
    await writeFile(workspaceRoot, "tests/outside.ts", "export const outside = true;\n");
    await writeFile(workspaceRoot, "rules/security.yml", "rules: []\n");
    const finding = (
      pathValue: string,
      start: { line: number; col: number },
      end: { line: number; col: number },
      suffix: string,
    ) => ({
      check_id: `configuration.literal.${suffix}`,
      path: pathValue,
      start,
      end,
      extra: {
        message: "Unsafe literal configuration",
        severity: "WARNING",
        lines: 'password = "very secret value"',
        metadata: {
          cwe: ["CWE-798"],
          remediation: "Move the literal to an approved runtime configuration source.",
        },
      },
    });
    const rawReport = {
      version: "scope-test",
      results: [
        finding("src/config.ts", { line: 1, col: 1 }, { line: 1, col: 20 }, "valid"),
        finding("tests/outside.ts", { line: 1, col: 1 }, { line: 1, col: 10 }, "outside"),
        finding("src/missing.ts", { line: 1, col: 1 }, { line: 1, col: 10 }, "missing"),
        finding("src/config.ts", { line: 99, col: 1 }, { line: 99, col: 10 }, "bounds"),
        finding(
          "src/unicode.ts",
          { line: 1, col: utf16OutOfBoundsColumn },
          { line: 1, col: utf16OutOfBoundsColumn },
          "utf8-byte-column",
        ),
      ],
      errors: [],
    };
    const requests: Array<{ paths: string[] }> = [];
    const scanner: StaticScannerRunner = {
      async probe() {
        return { available: true, name: "semgrep-scope-fixture", version: "1", message: "available" };
      },
      async scan(request) {
        requests.push({ paths: [...request.paths] });
        return {
          name: "semgrep-scope-fixture",
          version: "1",
          rawReport: JSON.stringify(rawReport),
          exitCode: 0,
          timedOut: false,
          outputTruncated: false,
        };
      },
    };
    const fixture = await createRuntime(workspaceRoot, { securityScanner: scanner });
    const result = await fixture.runtime.executeManualTool("security_scan", {
      paths: ["src"],
      rules: ["rules/security.yml"],
      maxEvidenceChars: 200,
    }, fixture.sessionId);
    const body = structured<SecurityScanResult>(result);

    expect(utf16OutOfBoundsColumn).toBeLessThanOrEqual(Buffer.byteLength(unicodeLine, "utf8") + 1);
    expect(utf16OutOfBoundsColumn).toBeGreaterThan(unicodeLine.length + 1);
    expect(requests).toEqual([{ paths: ["src"] }]);
    expect(result.success).toBe(true);
    expect(body).toMatchObject({
      status: "degraded",
      total: 1,
      returned: 1,
      totalExact: false,
      scannerInstallAttempted: false,
      patchesApplied: false,
    });
    expect(body.items[0]).toMatchObject({
      ruleId: "configuration.literal.valid",
      location: { path: "src/config.ts" },
      evidence: { redacted: true },
    });
    expect(body.warnings.some((warning) => /Dropped 4/iu.test(warning))).toBe(true);
    const mainOutput = result.output.toLocaleLowerCase("en-US");
    const artifact = (await fixture.sessionStore.readTextToolOutputArtifact(body.artifactUri))
      .toLocaleLowerCase("en-US");
    for (const leaked of ["very", "secret", "value"]) {
      expect(mainOutput, leaked).not.toContain(leaked);
      expect(artifact, leaked).not.toContain(leaked);
    }
    expect(await fs.readFile(path.join(workspaceRoot, "src/config.ts"), "utf8")).toBe(source);
  });

  it("retains the redacted artifact when finding normalization exceeds its safety deadline", async () => {
    const { workspaceRoot, source } = await createSecurityWorkspace();
    let dateNowSpy: ReturnType<typeof vi.spyOn> | undefined;
    const scanner: StaticScannerRunner = {
      async probe() {
        return { available: true, name: "semgrep-deadline-fixture", version: "1", message: "available" };
      },
      async scan() {
        let mockedNow = Date.now();
        dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
          mockedNow += 20_001;
          return mockedNow;
        });
        return {
          name: "semgrep-deadline-fixture",
          version: "1",
          rawReport: JSON.stringify({
            version: "deadline-test",
            results: [{
              check_id: "security.normalization-deadline",
              path: "src/secret.ts",
              start: { line: 1, col: 1 },
              end: { line: 1, col: 10 },
              extra: {
                message: "Deadline fixture finding",
                severity: "WARNING",
                lines: source.trim(),
                metadata: {},
              },
            }],
            errors: [],
          }),
          exitCode: 0,
          timedOut: false,
          outputTruncated: false,
        };
      },
    };
    const fixture = await createRuntime(workspaceRoot, { securityScanner: scanner });
    let result: ToolResult;
    try {
      result = await fixture.runtime.executeManualTool("security_scan", {
        paths: ["src"], rules: ["rules/security.yml"],
      }, fixture.sessionId);
    } finally {
      dateNowSpy?.mockRestore();
    }

    expect(result.success).toBe(false);
    const body = result.structuredContent as Record<string, unknown>;
    expect(body).toMatchObject({ status: "degraded", errorCode: "normalization_timeout" });
    expect(body.artifactUri).toMatch(/^artifact:\/\/tool-outputs\//u);
    expect(result.artifacts).toContainEqual(expect.objectContaining({ uri: body.artifactUri }));
    const artifact = await fixture.sessionStore.readTextToolOutputArtifact(body.artifactUri as string);
    expect(artifact).toContain("security.normalization-deadline");
  });
});

describe("phase 19 provider selection and regressions", () => {
  it("declares workspace-root filesystem access for semantic_search and workspace code_symbols", async () => {
    const workspaceRoot = await createCodeWorkspace();
    const accessContext = {
      workspaceRoot,
      sessionId: "phase19-access-session",
      callId: "phase19-access-call",
      settings: { version: 1 },
      paths: {
        normalize(value: string) {
          return value.replace(/\\/gu, "/").replace(/^\.\//u, "") || ".";
        },
      },
    } as never;
    const semanticAccess = await createSemanticSearchTool().resolveAccess?.({
      query: "calculate invoice total",
      provider: "local",
    }, accessContext);
    const symbolAccess = await createCodeSymbolsTool().resolveAccess?.({
      scope: "workspace",
    }, accessContext);
    const filesystemPaths = (requests: typeof semanticAccess): string[] => (requests ?? [])
      .filter((request) => request.kind === "filesystem_read")
      .flatMap((request) => request.paths ?? []);

    expect(filesystemPaths(semanticAccess)).toEqual(["."]);
    expect(filesystemPaths(symbolAccess)).toEqual(["."]);
    expect(semanticAccess).toContainEqual(expect.objectContaining({
      kind: "filesystem_read",
      reason: expect.stringMatching(/local source index/iu),
    }));
    expect(symbolAccess).toContainEqual(expect.objectContaining({
      kind: "filesystem_read",
      reason: expect.stringMatching(/repository-wide guarded local index/iu),
    }));
  });

  it("shares one workspace local-index service across the four code-intelligence tools", async () => {
    const workspaceRoot = await createCodeWorkspace();
    const openIndex = vi.fn(async (requestedRoot: string) => openLocalCodeIndex(requestedRoot));
    const fixture = await createRuntime(workspaceRoot, { openIndex });
    const results = [];
    results.push(await fixture.runtime.executeManualTool("semantic_search", {
      query: "calculate invoice total", provider: "local",
    }, fixture.sessionId));
    results.push(await fixture.runtime.executeManualTool("code_symbols", {
      scope: "workspace", query: "calculateTotal",
    }, fixture.sessionId));
    results.push(await fixture.runtime.executeManualTool("go_to_definition", {
      file: "src/use.js", line: 2, column: 23, symbol: "calculateTotal",
    }, fixture.sessionId));
    results.push(await fixture.runtime.executeManualTool("find_references", {
      file: "src/use.js", line: 2, column: 23, symbol: "calculateTotal",
    }, fixture.sessionId));

    expect(results.every((result) => result.success)).toBe(true);
    expect(openIndex).toHaveBeenCalledTimes(1);
    expect(path.resolve(openIndex.mock.calls[0]![0])).toBe(path.resolve(workspaceRoot));
  });

  it("registers and selects phase-19 tools without regressing diagnostics or search_files", async () => {
    const workspaceRoot = await createCodeWorkspace();
    const fixture = await createDefaultRuntime(workspaceRoot);
    const registered = new Set(fixture.runtime.listRegisteredToolDefinitions().map((tool) => tool.name));
    for (const name of [
      "semantic_search",
      "code_symbols",
      "go_to_definition",
      "find_references",
      "dependency_audit",
      "security_scan",
    ]) expect(registered.has(name), name).toBe(true);

    const selected = (prompt: string): string[] => fixture.runtime.selectToolsForTurn({ prompt })
      .definitions.map((tool) => tool.name);
    expect(selected("semantic search for related code")).toContain("semantic_search");
    expect(selected("list code symbols and find references")).toEqual(expect.arrayContaining(["code_symbols", "find_references"]));
    expect(selected("run dependency audit for vulnerabilities")).toContain("dependency_audit");
    expect(selected("run a security scan on source code")).toContain("security_scan");
    expect(selected("\u8fd9\u4e2a\u7b26\u53f7\u5728\u54ea\u91cc\u5b9a\u4e49")).toContain("go_to_definition");
    expect(selected("\u8c01\u5f15\u7528\u4e86 calculateTotal")).toContain("find_references");
    expect(selected("\u67e5\u627e\u5b9e\u73b0\u7c7b\u4f3c\u529f\u80fd")).toContain("semantic_search");
    expect(selected("plain text search for calculateTotal")).not.toContain("semantic_search");
    const phase19Names = new Set([
      "semantic_search", "code_symbols", "go_to_definition", "find_references", "dependency_audit", "security_scan",
    ]);
    expect(fixture.runtime.selectToolsForTurn({ workerRoutes: ["coding"] }).definitions
      .some((tool) => phase19Names.has(tool.name))).toBe(false);

    const search = await fixture.runtime.executeManualTool("search_files", {
      pattern: "calculateTotal",
      cwd: ".",
      maxResults: 20,
    }, fixture.sessionId);
    expect(search.success).toBe(true);
    expect((search.structuredContent as { matches: Array<{ path: string }> }).matches
      .some((match) => match.path.replace(/^\.\//u, "") === "src/math.ts")).toBe(true);

    const diagnostics = await fixture.runtime.executeManualTool("lsp_diagnostics", {
      paths: ["src/math.ts"],
    }, fixture.sessionId);
    expect(diagnostics.structuredContent).toMatchObject({ kind: "lsp" });
    expect((diagnostics.structuredContent as { status: string }).status).toMatch(/ok|failed|unavailable/iu);
  });
});
