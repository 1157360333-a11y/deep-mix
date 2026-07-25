import type {
  CodeArtifact,
  CodeArtifactSummary,
  WorkerFailureType,
  WorkerTask,
} from "../../shared-schema/src/index.js";
import type { GlmCodingWorkerConfig } from "../../route-resolver/src/index.js";

export interface CodeArtifactDraft {
  summary: string;
  changedFiles: string[];
  testCommands: string[];
  risks: string[];
  confidence: number;
  notes?: string[];
  metadata?: Record<string, unknown>;
}

export interface GlmCodingWorkerExecutionResult {
  artifact: CodeArtifactDraft;
  patch: string;
  rawResponse: string;
}

export interface GlmCodingWorkerRequest {
  task: WorkerTask;
  resolvedContext: string;
  workerSessionId: string;
  signal?: AbortSignal;
}

export interface CodingWorkerRunner {
  runTask: (input: GlmCodingWorkerRequest) => Promise<GlmCodingWorkerExecutionResult>;
}

export class GlmWorkerError extends Error {
  public readonly type: WorkerFailureType;

  public readonly retryable: boolean;

  public readonly rawResponse?: string;

  public constructor(type: WorkerFailureType, message: string, options?: { retryable?: boolean; rawResponse?: string }) {
    super(message);
    this.name = "GlmWorkerError";
    this.type = type;
    this.retryable = options?.retryable ?? false;
    this.rawResponse = options?.rawResponse;
  }
}

function asStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new GlmWorkerError("artifact_validation_failed", `Invalid ${fieldName} in code artifact.`, {
      retryable: false,
    });
  }
  return value.map((entry) => entry.trim());
}

function extractTaggedBlock(raw: string, tagName: string): string {
  const match = raw.match(new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, "i"));
  if (!match?.[1]) {
    throw new GlmWorkerError("response_parse_failed", `Missing <${tagName}> block in worker response.`, {
      retryable: true,
      rawResponse: raw,
    });
  }
  return match[1].trim();
}

function parseJsonBlock(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new GlmWorkerError("response_parse_failed", `Failed to parse worker JSON block: ${(error as Error).message}`, {
      retryable: true,
      rawResponse: raw,
    });
  }
}

function buildSystemPrompt(): string {
  return [
    "You are the isolated GLM-5.2 coding worker inside Deep-Mix phase 2.",
    "You are not the governor.",
    "You do not have workspace write access.",
    "You must not ask to use tools or directly claim that files were edited.",
    "Return only a structured code artifact plus an apply_patch-style patch draft.",
    "Do not include any prose outside the required XML-like blocks.",
    "The patch must start with *** Begin Patch and end with *** End Patch.",
    "The artifact JSON must not include patchRef because the runtime assigns artifact storage paths.",
  ].join("\n");
}

function buildUserPrompt(task: WorkerTask, resolvedContext: string): string {
  return [
    `Objective:\n${task.objective}`,
    `Constraints:\n${task.constraints.map((item, index) => `${index + 1}. ${item}`).join("\n") || "None."}`,
    `Acceptance Checks:\n${task.acceptanceChecks.map((item, index) => `${index + 1}. ${item}`).join("\n") || "None."}`,
    `Resolved Context:\n${resolvedContext || "No additional context provided."}`,
    "Return exactly the following shape:",
    "<code_artifact>",
    JSON.stringify(
      {
        summary: "one concise summary",
        changedFiles: ["relative/path.ts"],
        testCommands: ["npm test -- some-target"],
        risks: ["known risk"],
        confidence: 0.5,
        notes: ["optional extra note"],
      },
      null,
      2,
    ),
    "</code_artifact>",
    "<patch>",
    "*** Begin Patch",
    "*** Update File: relative/path.ts",
    "@@",
    "-old line",
    "+new line",
    "*** End Patch",
    "</patch>",
  ].join("\n\n");
}

export function buildCodingWorkerTask(rawArgs: unknown): WorkerTask {
  const args = (rawArgs ?? {}) as Partial<WorkerTask>;
  if (typeof args.objective !== "string" || args.objective.trim().length === 0) {
    throw new Error("invoke_coding_worker requires a non-empty objective.");
  }

  return {
    workerType: "coding",
    objective: args.objective.trim(),
    constraints: Array.isArray(args.constraints)
      ? args.constraints.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [],
    contextRefs: Array.isArray(args.contextRefs) ? args.contextRefs : [],
    expectedOutput: "code_artifact",
    acceptanceChecks: Array.isArray(args.acceptanceChecks)
      ? args.acceptanceChecks.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [],
  };
}

export function validateCodeArtifact(artifact: CodeArtifact): CodeArtifact {
  if (artifact.kind !== "code_artifact") {
    throw new GlmWorkerError("artifact_validation_failed", `Expected code_artifact, received ${artifact.kind}.`);
  }
  if (typeof artifact.summary !== "string" || artifact.summary.trim().length === 0) {
    throw new GlmWorkerError("artifact_validation_failed", "Code artifact summary must be non-empty.");
  }
  if (!/^artifact:\/\/patches\/.+\.patch$/.test(artifact.patchRef)) {
    throw new GlmWorkerError("artifact_validation_failed", "Code artifact patchRef must point to artifact://patches/*.patch.");
  }
  if (typeof artifact.confidence !== "number" || artifact.confidence < 0 || artifact.confidence > 1) {
    throw new GlmWorkerError("artifact_validation_failed", "Code artifact confidence must be between 0 and 1.");
  }
  artifact.changedFiles = asStringArray(artifact.changedFiles, "changedFiles");
  artifact.testCommands = asStringArray(artifact.testCommands, "testCommands");
  artifact.risks = asStringArray(artifact.risks, "risks");
  if (artifact.notes !== undefined) {
    artifact.notes = asStringArray(artifact.notes, "notes");
  }
  if (!artifact.metadata || typeof artifact.metadata !== "object" || Array.isArray(artifact.metadata)) {
    throw new GlmWorkerError("artifact_validation_failed", "Code artifact metadata must be an object.");
  }
  return artifact;
}

export function summarizeCodeArtifact(artifact: CodeArtifact): CodeArtifactSummary {
  return {
    kind: "code_artifact",
    summary: artifact.summary,
    patchRef: artifact.patchRef,
    changedFiles: artifact.changedFiles,
    testCommands: artifact.testCommands,
    risks: artifact.risks,
    confidence: artifact.confidence,
    notes: artifact.notes,
  };
}

export class GlmCodingWorkerClient implements CodingWorkerRunner {
  private readonly config: GlmCodingWorkerConfig;

  public constructor(config: GlmCodingWorkerConfig) {
    this.config = config;
  }

  public async runTask(input: GlmCodingWorkerRequest): Promise<GlmCodingWorkerExecutionResult> {
    if (!this.config.apiKey) {
      throw new GlmWorkerError("configuration_error", "Missing API key for glm_coding_worker profile.");
    }

    const response = await fetch(`${this.config.baseUrl}${this.config.endpointPath}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
        ...this.config.headers,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(),
          },
          {
            role: "user",
            content: buildUserPrompt(input.task, input.resolvedContext),
          },
        ],
        stream: false,
        temperature: this.config.temperature,
        ...this.config.requestDefaults,
      }),
      signal: input.signal,
    });

    if (!response.ok) {
      throw new GlmWorkerError(
        "response_parse_failed",
        `GLM request failed with ${response.status}: ${(await response.text()).slice(0, 400)}`,
        { retryable: response.status >= 500 },
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const rawResponse = payload.choices?.[0]?.message?.content?.trim();
    if (!rawResponse) {
      throw new GlmWorkerError("response_parse_failed", "GLM response did not contain assistant content.", {
        retryable: true,
      });
    }

    const codeArtifactBlock = extractTaggedBlock(rawResponse, "code_artifact");
    const patchBlock = extractTaggedBlock(rawResponse, "patch");
    const parsed = parseJsonBlock(codeArtifactBlock) as Record<string, unknown>;

    const artifact: CodeArtifactDraft = {
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
      changedFiles: asStringArray(parsed.changedFiles, "changedFiles"),
      testCommands: asStringArray(parsed.testCommands, "testCommands"),
      risks: asStringArray(parsed.risks, "risks"),
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : Number.NaN,
      notes: parsed.notes === undefined ? undefined : asStringArray(parsed.notes, "notes"),
      metadata:
        parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata)
          ? (parsed.metadata as Record<string, unknown>)
          : {},
    };

    if (!artifact.summary) {
      throw new GlmWorkerError("artifact_validation_failed", "Worker returned an empty summary.", {
        retryable: false,
        rawResponse,
      });
    }
    if (!Number.isFinite(artifact.confidence) || artifact.confidence < 0 || artifact.confidence > 1) {
      throw new GlmWorkerError("artifact_validation_failed", "Worker confidence must be between 0 and 1.", {
        retryable: false,
        rawResponse,
      });
    }
    if (!patchBlock.startsWith("*** Begin Patch") || !patchBlock.includes("*** End Patch")) {
      throw new GlmWorkerError("artifact_validation_failed", "Worker patch must use the apply_patch envelope.", {
        retryable: false,
        rawResponse,
      });
    }

    return {
      artifact,
      patch: patchBlock,
      rawResponse,
    };
  }
}
