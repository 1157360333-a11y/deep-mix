import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { GovernorRuntime } from "../packages/core-governor/src/index.js";
import { SessionStore } from "../packages/persistence/src/index.js";
import { SpecialistBroker } from "../packages/specialist-broker/src/index.js";
import type {
  AssistantResponse,
  ModelClient,
  ModelCompletionRequest,
  StreamCallbacks,
} from "../packages/shared-schema/src/index.js";
import { ToolRuntime } from "../packages/tool-runtime/src/index.js";
import type { KimiVisionWorkerExecutionResult, VisionWorkerRunner } from "../packages/worker-kimi-vision/src/index.js";

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

async function writeSvgPng(filePath: string, options: { width: number; height: number; body: string }): Promise<void> {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}" viewBox="0 0 ${options.width} ${options.height}">
      ${options.body}
    </svg>
  `;
  await sharp(Buffer.from(svg)).png().toFile(filePath);
}

async function createFixtureWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase4-"));
  temporaryRoots.push(workspaceRoot);
  await fs.mkdir(path.join(workspaceRoot, "fixtures"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, ".deep-mix", "api-key-library"), { recursive: true });

  await fs.writeFile(
    path.join(workspaceRoot, "src", "note.ts"),
    ["export const note = 'vision follow-up target';", ""].join("\n"),
    "utf8",
  );

  await fs.writeFile(
    path.join(workspaceRoot, ".deep-mix", "api-key-library", "profiles.local.json"),
    JSON.stringify(
      {
        version: 1,
        profiles: {
          kimi_vision: {
            provider: "kimi",
            role: "vision_worker",
            apiKey: "fake-local-key",
            baseUrl: "https://example.invalid",
            chatPath: "/v1/chat/completions",
            model: "kimi-k2.6",
            supportsMultimodalInput: true,
            headers: {
              "Content-Type": "application/json",
            },
            requestDefaults: {},
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  await writeSvgPng(path.join(workspaceRoot, "fixtures", "error.png"), {
    width: 4200,
    height: 2400,
    body: `
      <rect width="4200" height="2400" fill="#111827"/>
      <rect x="220" y="220" width="3760" height="1960" rx="48" fill="#1f2937" stroke="#ef4444" stroke-width="12"/>
      <text x="320" y="520" font-size="128" fill="#fca5a5" font-family="Arial">TypeError: Cannot read properties of undefined</text>
      <text x="320" y="760" font-size="88" fill="#f8fafc" font-family="Arial">at renderDashboard (src/dashboard.ts:42)</text>
      <text x="320" y="920" font-size="88" fill="#f8fafc" font-family="Arial">at updatePanel (src/panel.ts:18)</text>
    `,
  });
  await writeSvgPng(path.join(workspaceRoot, "fixtures", "ui.png"), {
    width: 1600,
    height: 900,
    body: `
      <rect width="1600" height="900" fill="#f8fafc"/>
      <rect x="120" y="96" width="1360" height="88" rx="20" fill="#0f172a"/>
      <text x="180" y="154" font-size="42" fill="#e2e8f0" font-family="Arial">Deploy Preview</text>
      <rect x="120" y="240" width="420" height="240" rx="28" fill="#ffffff" stroke="#cbd5e1" stroke-width="6"/>
      <text x="164" y="324" font-size="54" fill="#0f172a" font-family="Arial">Build Status</text>
      <text x="164" y="402" font-size="40" fill="#16a34a" font-family="Arial">Healthy</text>
      <rect x="980" y="260" width="260" height="80" rx="16" fill="#2563eb"/>
      <text x="1044" y="314" font-size="34" fill="#eff6ff" font-family="Arial">Publish</text>
    `,
  });
  await writeSvgPng(path.join(workspaceRoot, "fixtures", "ocr.png"), {
    width: 1200,
    height: 420,
    body: `
      <rect width="1200" height="420" fill="#ffffff"/>
      <text x="72" y="180" font-size="96" fill="#0f172a" font-family="Arial">Invoice #A-2048</text>
      <text x="72" y="310" font-size="72" fill="#334155" font-family="Arial">Amount Due: 5180 CNY</text>
    `,
  });

  return workspaceRoot;
}

function createVisionWorkerFactory(): () => VisionWorkerRunner {
  return () =>
    ({
      runTask: async ({ preparedInput }) => {
        if (preparedInput.taskType === "error_screenshot") {
          expect(preparedInput.originalWidth).toBeGreaterThan(preparedInput.processedWidth);
          return createVisionResult({
            taskType: "error_screenshot",
            summary: "Detected a TypeError in the dashboard render path.",
            issues: ["The lower part of the stack trace may be truncated."],
            ocrBlocks: [
              { text: "TypeError: Cannot read properties of undefined", confidence: 0.98, regionId: "region-error" },
            ],
            regions: [
              {
                id: "region-error",
                label: "stack-trace",
                confidence: 0.95,
                bbox: { x: 120, y: 220, width: 3600, height: 900 },
              },
            ],
            components: [
              {
                id: "component-error-panel",
                type: "error_panel",
                label: "Runtime exception panel",
                confidence: 0.92,
                regionId: "region-error",
                attributes: { tone: "critical" },
              },
            ],
            errorText: ["TypeError: Cannot read properties of undefined"],
            suspectedCauses: ["A missing object was dereferenced inside renderDashboard()."],
            evidenceRegions: ["region-error"],
          });
        }

        if (preparedInput.taskType === "ui_parse") {
          return createVisionResult({
            taskType: "ui_parse",
            summary: "Parsed a dashboard UI with a status card and publish button.",
            issues: [],
            ocrBlocks: [
              { text: "Deploy Preview", confidence: 0.94, regionId: "region-header" },
              { text: "Publish", confidence: 0.91, regionId: "region-button" },
            ],
            regions: [
              {
                id: "region-header",
                label: "header",
                confidence: 0.93,
                bbox: { x: 120, y: 96, width: 1360, height: 88 },
              },
              {
                id: "region-button",
                label: "primary-action",
                confidence: 0.92,
                bbox: { x: 980, y: 260, width: 260, height: 80 },
              },
            ],
            components: [
              {
                id: "component-card",
                type: "card",
                label: "Build Status",
                confidence: 0.9,
                regionId: "region-header",
                attributes: { emphasis: "summary" },
              },
              {
                id: "component-button",
                type: "button",
                label: "Publish",
                confidence: 0.95,
                regionId: "region-button",
                attributes: { variant: "primary" },
              },
            ],
          });
        }

        return createVisionResult({
          taskType: "ocr_extract",
          summary: "Extracted invoice text from the image.",
          issues: [],
          ocrBlocks: [
            { text: "Invoice #A-2048", confidence: 0.99, regionId: "region-title" },
            { text: "Amount Due: 5180 CNY", confidence: 0.97, regionId: "region-amount" },
          ],
          regions: [
            {
              id: "region-title",
              label: "title",
              confidence: 0.95,
              bbox: { x: 72, y: 96, width: 700, height: 120 },
            },
            {
              id: "region-amount",
              label: "amount",
              confidence: 0.95,
              bbox: { x: 72, y: 236, width: 760, height: 90 },
            },
          ],
          components: [],
        });
      },
    }) satisfies VisionWorkerRunner;
}

function createVisionResult(input: {
  taskType: "ocr_extract" | "ui_parse" | "error_screenshot";
  summary: string;
  issues: string[];
  ocrBlocks: Array<{ text: string; confidence: number; regionId?: string }>;
  regions: Array<{
    id: string;
    label: string;
    confidence: number;
    bbox: { x: number; y: number; width: number; height: number };
  }>;
  components: Array<{
    id: string;
    type: string;
    label: string;
    confidence: number;
    regionId?: string;
    attributes?: Record<string, string | number | boolean>;
  }>;
  errorText?: string[];
  suspectedCauses?: string[];
  evidenceRegions?: string[];
}): KimiVisionWorkerExecutionResult {
  return {
    artifact: {
      summary: input.summary,
      confidence: 0.92,
      issues: input.issues,
      ocrBlocks: input.ocrBlocks,
      regions: input.regions,
      components: input.components,
      errorText: input.errorText,
      suspectedCauses: input.suspectedCauses,
      evidenceRegions: input.evidenceRegions,
    },
    rawResponse: JSON.stringify(
      {
        summary: input.summary,
        confidence: 0.92,
        issues: input.issues,
        ocrBlocks: input.ocrBlocks,
        regions: input.regions,
        components: input.components,
        errorText: input.errorText,
        suspectedCauses: input.suspectedCauses,
        evidenceRegions: input.evidenceRegions,
      },
      null,
      2,
    ),
  };
}

async function seedArtifactImage(
  sessionStore: SessionStore,
  workspaceRoot: string,
  filename: string,
  label: string,
): Promise<string> {
  const content = await fs.readFile(path.join(workspaceRoot, "fixtures", filename));
  const stored = await sessionStore.storeBinaryArtifact({
    workerSessionId: `seed-${label}`,
    namespace: "images",
    filename,
    content,
  });
  return stored.artifactRef;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe("phase 4 Kimi vision worker integration", () => {
  it("processes a local error screenshot through invoke_vision_worker, stores source artifacts, and returns the complete structured VisionArtifact", async () => {
    const workspaceRoot = await createFixtureWorkspace();
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const session = await sessionStore.createSession("phase 4 error screenshot test");
    const broker = new SpecialistBroker({
      workspaceRoot,
      sessionStore,
      visionWorkerFactory: createVisionWorkerFactory(),
    });
    const runtime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
      specialistBroker: broker,
    });

    const result = await runtime.executeManualTool(
      "invoke_vision_worker",
      {
        workerType: "vision",
        taskType: "error_screenshot",
        image: {
          sourceType: "local_path",
          ref: "file://fixtures/error.png",
        },
        instructions: "Focus on the visible exception and the highest-signal stack line.",
      },
      session.sessionId,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("\"workerSessionId\":");
    expect(result.output).toContain("\"kind\": \"vision_artifact\"");
    expect(result.output).toContain("\"artifactRef\": \"artifact://records/");
    expect(result.output).not.toContain("data:image/webp;base64");

    const structured = result.structuredContent as {
      workerSessionId: string;
      artifact: { artifactRef: string; metadata: { processedImageRef: string; originalImageRef: string } };
    };
    expect(JSON.parse(result.output)).toEqual(structured);
    const workerMeta = await sessionStore.loadWorkerSession(structured.workerSessionId);
    expect(workerMeta?.route.role).toBe("vision_worker");
    expect(workerMeta?.status).toBe("completed");

    const originalPath = sessionStore.resolveArtifactPath(structured.artifact.metadata.originalImageRef);
    const processedPath = sessionStore.resolveArtifactPath(structured.artifact.metadata.processedImageRef);
    const processedMetadata = await sharp(await fs.readFile(processedPath)).metadata();
    expect(await fs.stat(originalPath)).toBeDefined();
    expect(await fs.stat(processedPath)).toBeDefined();
    expect(processedMetadata.width).toBeLessThanOrEqual(2048);
    expect(processedMetadata.height).toBeLessThanOrEqual(2048);

    const storedArtifactRaw = await sessionStore.readArtifactRef(structured.artifact.artifactRef);
    expect(storedArtifactRaw).toContain("\"errorText\"");
    expect(storedArtifactRaw).toContain("\"suspectedCauses\"");
  });

  it("accepts artifact-backed browser capture refs for ui_parse and preserves the structured VisionArtifact shape", async () => {
    const workspaceRoot = await createFixtureWorkspace();
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const session = await sessionStore.createSession("phase 4 ui parse test");
    const browserCaptureRef = await seedArtifactImage(sessionStore, workspaceRoot, "ui.png", "browser");

    const broker = new SpecialistBroker({
      workspaceRoot,
      sessionStore,
      visionWorkerFactory: createVisionWorkerFactory(),
    });
    const runtime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
      specialistBroker: broker,
    });

    const result = await runtime.executeManualTool(
      "invoke_vision_worker",
      {
        workerType: "vision",
        taskType: "ui_parse",
        image: {
          sourceType: "browser_capture",
          ref: browserCaptureRef,
        },
      },
      session.sessionId,
    );

    expect(result.success).toBe(true);
    const structured = result.structuredContent as {
      workerSessionId: string;
      artifact: {
        taskType: string;
        summary: string;
        artifactRef: string;
        metadata: { sourceType: string; inputImageRef: string };
      };
    };
    expect(structured.artifact.taskType).toBe("ui_parse");
    expect(structured.artifact.summary).toContain("dashboard UI");
    expect(structured.artifact.metadata.sourceType).toBe("browser_capture");
    expect(structured.artifact.metadata.inputImageRef).toBe(browserCaptureRef);

    const storedArtifact = JSON.parse((await sessionStore.readArtifactRef(structured.artifact.artifactRef)) ?? "{}") as {
      components?: Array<{ label: string }>;
      regions?: Array<{ label: string }>;
    };
    expect(storedArtifact.components?.some((entry) => entry.label === "Publish")).toBe(true);
    expect(storedArtifact.regions?.some((entry) => entry.label === "primary-action")).toBe(true);
  });

  it("lets the governor continue with normal runtime tools after OCR via invoke_vision_worker", async () => {
    const workspaceRoot = await createFixtureWorkspace();
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const uploadedFileRef = await seedArtifactImage(sessionStore, workspaceRoot, "ocr.png", "upload");

    const broker = new SpecialistBroker({
      workspaceRoot,
      sessionStore,
      visionWorkerFactory: createVisionWorkerFactory(),
    });
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      specialistBroker: broker,
      modelClient: new ScriptedModelClient([
        {
          content: "",
          toolCalls: [
            {
              id: "vision-1",
              name: "invoke_vision_worker",
              rawArguments: JSON.stringify({
                workerType: "vision",
                taskType: "ocr_extract",
                image: {
                  sourceType: "uploaded_file",
                  ref: uploadedFileRef,
                },
              }),
              arguments: {
                workerType: "vision",
                taskType: "ocr_extract",
                image: {
                  sourceType: "uploaded_file",
                  ref: uploadedFileRef,
                },
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
              rawArguments: JSON.stringify({
                path: "src/note.ts",
              }),
              arguments: {
                path: "src/note.ts",
              },
            },
          ],
        },
        {
          content: "OCR summary collected and the governor continued into the normal file-inspection loop.",
          toolCalls: [],
        },
      ]),
    });

    const result = await runtime.runTurn({
      prompt: "Read the uploaded OCR image, then inspect src/note.ts as the next step.",
    });

    expect(result.session.status).toBe("waiting_for_user");
    expect(result.finalResponse).toContain("OCR summary collected");

    const sessionJsonl = await fs.readFile(
      path.join(workspaceRoot, ".deep-mix", "sessions", `${result.sessionId}.jsonl`),
      "utf8",
    );
    expect(sessionJsonl).toContain("\"name\":\"invoke_vision_worker\"");
    expect(sessionJsonl).toContain("\"name\":\"read_file\"");
    expect(sessionJsonl).not.toContain("data:image/webp;base64");
    expect(sessionJsonl).toContain("artifact://records/");

    const recordsDir = path.join(workspaceRoot, ".deep-mix", "worker-artifacts", "records");
    const recordFiles = await fs.readdir(recordsDir);
    expect(recordFiles.length).toBeGreaterThan(0);
    const storedArtifact = await fs.readFile(path.join(recordsDir, recordFiles[0]!), "utf8");
    expect(storedArtifact).toContain("Invoice #A-2048");
  });
});
