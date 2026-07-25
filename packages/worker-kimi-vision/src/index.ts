import type { KimiVisionWorkerConfig } from "../../route-resolver/src/index.js";
import type {
  VisionArtifact,
  VisionArtifactMetadata,
  VisionArtifactSummary,
  VisionArtifactToolSummary,
  VisionComponent,
  VisionImageInputMode,
  VisionImageRef,
  VisionOcrBlock,
  VisionRegion,
  VisionTaskType,
  WorkerFailureType,
  WorkerTask,
} from "../../shared-schema/src/index.js";

export interface PreparedVisionInput {
  taskType: VisionTaskType;
  image: VisionImageRef;
  inputMode: VisionImageInputMode;
  originalImageRef: string;
  processedImageRef: string;
  mimeType: string;
  originalBytes: number;
  processedBytes: number;
  originalWidth: number;
  originalHeight: number;
  processedWidth: number;
  processedHeight: number;
  preprocessing: VisionArtifactMetadata["preprocessing"];
  processedDataUrl: string;
}

export interface VisionArtifactDraft {
  summary: string;
  confidence: number;
  issues: string[];
  ocrBlocks: VisionOcrBlock[];
  regions: VisionRegion[];
  components: VisionComponent[];
  errorText?: string[];
  suspectedCauses?: string[];
  evidenceRegions?: string[];
}

export interface KimiVisionWorkerExecutionResult {
  artifact: VisionArtifactDraft;
  rawResponse: string;
}

export interface KimiVisionWorkerRequest {
  task: WorkerTask;
  preparedInput: PreparedVisionInput;
  workerSessionId: string;
  signal?: AbortSignal;
}

export interface VisionWorkerRunner {
  runTask: (input: KimiVisionWorkerRequest) => Promise<KimiVisionWorkerExecutionResult>;
}

export interface VisionWorkerToolInput {
  workerType: "vision";
  taskType: VisionTaskType;
  image: VisionImageRef;
  instructions?: string;
  constraints?: string[];
}

export class KimiVisionWorkerError extends Error {
  public readonly type: WorkerFailureType;

  public readonly retryable: boolean;

  public readonly rawResponse?: string;

  public constructor(type: WorkerFailureType, message: string, options?: { retryable?: boolean; rawResponse?: string }) {
    super(message);
    this.name = "KimiVisionWorkerError";
    this.type = type;
    this.retryable = options?.retryable ?? false;
    this.rawResponse = options?.rawResponse;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry))) {
    throw new KimiVisionWorkerError("artifact_validation_failed", `Invalid ${fieldName} in vision artifact.`, {
      retryable: false,
    });
  }
  return value.map((entry) => entry.trim());
}

function asConfidence(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new KimiVisionWorkerError("artifact_validation_failed", `${fieldName} must be a number between 0 and 1.`, {
      retryable: false,
    });
  }
  return value;
}

function asBBox(value: unknown, fieldName: string): VisionRegion["bbox"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new KimiVisionWorkerError("artifact_validation_failed", `${fieldName} must be an object.`, {
      retryable: false,
    });
  }

  const record = value as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  const width = Number(record.width);
  const height = Number(record.height);
  if ([x, y, width, height].some((entry) => !Number.isFinite(entry) || entry < 0)) {
    throw new KimiVisionWorkerError("artifact_validation_failed", `${fieldName} must contain non-negative x/y/width/height.`, {
      retryable: false,
    });
  }
  return { x, y, width, height };
}

function asOcrBlocks(value: unknown): VisionOcrBlock[] {
  if (!Array.isArray(value)) {
    throw new KimiVisionWorkerError("artifact_validation_failed", "ocrBlocks must be an array.", {
      retryable: false,
    });
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new KimiVisionWorkerError("artifact_validation_failed", `ocrBlocks[${index}] must be an object.`, {
        retryable: false,
      });
    }
    const record = entry as Record<string, unknown>;
    if (!isNonEmptyString(record.text)) {
      throw new KimiVisionWorkerError("artifact_validation_failed", `ocrBlocks[${index}].text must be non-empty.`, {
        retryable: false,
      });
    }
    return {
      text: record.text.trim(),
      confidence: asConfidence(record.confidence, `ocrBlocks[${index}].confidence`),
      regionId: isNonEmptyString(record.regionId) ? record.regionId.trim() : undefined,
    };
  });
}

function asRegions(value: unknown): VisionRegion[] {
  if (!Array.isArray(value)) {
    throw new KimiVisionWorkerError("artifact_validation_failed", "regions must be an array.", {
      retryable: false,
    });
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new KimiVisionWorkerError("artifact_validation_failed", `regions[${index}] must be an object.`, {
        retryable: false,
      });
    }
    const record = entry as Record<string, unknown>;
    if (!isNonEmptyString(record.id) || !isNonEmptyString(record.label)) {
      throw new KimiVisionWorkerError("artifact_validation_failed", `regions[${index}] must include non-empty id and label.`, {
        retryable: false,
      });
    }
    return {
      id: record.id.trim(),
      label: record.label.trim(),
      confidence: asConfidence(record.confidence, `regions[${index}].confidence`),
      bbox: asBBox(record.bbox, `regions[${index}].bbox`),
    };
  });
}

function asComponents(value: unknown): VisionComponent[] {
  if (!Array.isArray(value)) {
    throw new KimiVisionWorkerError("artifact_validation_failed", "components must be an array.", {
      retryable: false,
    });
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new KimiVisionWorkerError("artifact_validation_failed", `components[${index}] must be an object.`, {
        retryable: false,
      });
    }
    const record = entry as Record<string, unknown>;
    if (!isNonEmptyString(record.id) || !isNonEmptyString(record.type) || !isNonEmptyString(record.label)) {
      throw new KimiVisionWorkerError(
        "artifact_validation_failed",
        `components[${index}] must include non-empty id, type, and label.`,
        { retryable: false },
      );
    }

    const attributes =
      record.attributes && typeof record.attributes === "object" && !Array.isArray(record.attributes)
        ? (Object.fromEntries(
            Object.entries(record.attributes as Record<string, unknown>).filter(([, value]) =>
              ["string", "number", "boolean"].includes(typeof value),
            ),
          ) as Record<string, string | number | boolean>)
        : undefined;

    return {
      id: record.id.trim(),
      type: record.type.trim(),
      label: record.label.trim(),
      confidence: asConfidence(record.confidence, `components[${index}].confidence`),
      regionId: isNonEmptyString(record.regionId) ? record.regionId.trim() : undefined,
      attributes,
    };
  });
}

function taskLabel(taskType: VisionTaskType): string {
  switch (taskType) {
    case "ocr_extract":
      return "extract readable text from the image";
    case "ui_parse":
      return "parse the user interface structure from the screenshot or design";
    case "error_screenshot":
      return "analyze the visible error screenshot and identify likely causes";
    case "diagram_parse":
      return "parse the diagram structure and key relationships";
  }
}

function minimumFieldGuidance(taskType: VisionTaskType): string {
  switch (taskType) {
    case "ocr_extract":
      return "ocrBlocks must include every salient text block; regions should mark text areas; components may be empty.";
    case "ui_parse":
      return "components and regions must describe the visible UI hierarchy; ocrBlocks should capture visible labels.";
    case "error_screenshot":
      return "errorText, suspectedCauses, and evidenceRegions are required and must align with visible evidence.";
    case "diagram_parse":
      return "components and regions must identify nodes, labels, and connectors needed to understand the diagram.";
  }
}

export function buildVisionWorkerTask(rawArgs: unknown): { input: VisionWorkerToolInput; task: WorkerTask } {
  const args = (rawArgs ?? {}) as Partial<VisionWorkerToolInput>;
  if (args.workerType !== "vision") {
    throw new Error("invoke_vision_worker requires workerType=vision.");
  }
  if (
    args.taskType !== "ocr_extract" &&
    args.taskType !== "ui_parse" &&
    args.taskType !== "error_screenshot" &&
    args.taskType !== "diagram_parse"
  ) {
    throw new Error("invoke_vision_worker requires a supported taskType.");
  }
  if (!args.image || typeof args.image !== "object") {
    throw new Error("invoke_vision_worker requires an image object.");
  }
  if (
    args.image.sourceType !== "local_path" &&
    args.image.sourceType !== "uploaded_file" &&
    args.image.sourceType !== "browser_capture"
  ) {
    throw new Error("invoke_vision_worker image.sourceType must be local_path, uploaded_file, or browser_capture.");
  }
  if (typeof args.image.ref !== "string" || (!args.image.ref.startsWith("file://") && !args.image.ref.startsWith("artifact://"))) {
    throw new Error("invoke_vision_worker image.ref must start with file:// or artifact://.");
  }

  const constraints = Array.isArray(args.constraints)
    ? args.constraints.filter((entry): entry is string => isNonEmptyString(entry)).map((entry) => entry.trim())
    : [];
  if (args.image.crop) {
    const { x, y, width, height } = args.image.crop;
    if ([x, y, width, height].some((entry) => !Number.isFinite(entry) || entry < 0)) {
      throw new Error("invoke_vision_worker image.crop must contain non-negative numeric x/y/width/height.");
    }
  }

  const instructions = isNonEmptyString(args.instructions) ? args.instructions.trim() : undefined;
  return {
    input: {
      workerType: "vision",
      taskType: args.taskType,
      image: args.image,
      instructions,
      constraints,
    },
    task: {
      workerType: "vision",
      objective: instructions
        ? `Use vision to ${taskLabel(args.taskType)}. Additional instructions: ${instructions}`
        : `Use vision to ${taskLabel(args.taskType)}.`,
      constraints: [
        "Return only a structured VisionArtifact-compatible JSON object.",
        "Do not claim to edit files or invoke tools.",
        ...constraints,
      ],
      contextRefs: [
        {
          refType: "summary",
          label: "Vision input",
          summary: `taskType=${args.taskType}; sourceType=${args.image.sourceType}; imageRef=${args.image.ref}`,
        },
      ],
      expectedOutput: "vision_artifact",
      acceptanceChecks: [
        "Return valid JSON compatible with VisionArtifact.",
        "Include summary, confidence, issues, metadata, ocrBlocks, regions, and components.",
        minimumFieldGuidance(args.taskType),
      ],
    },
  };
}

export function buildVisionArtifact(
  draft: VisionArtifactDraft,
  preparedInput: PreparedVisionInput,
): VisionArtifact {
  return validateVisionArtifact({
    kind: "vision_artifact",
    taskType: preparedInput.taskType,
    summary: draft.summary,
    confidence: draft.confidence,
    issues: draft.issues,
    risks: [...draft.issues],
    metadata: {
      sourceType: preparedInput.image.sourceType,
      inputMode: preparedInput.inputMode,
      inputImageRef: preparedInput.image.ref,
      originalImageRef: preparedInput.originalImageRef,
      processedImageRef: preparedInput.processedImageRef,
      mimeType: preparedInput.mimeType,
      originalBytes: preparedInput.originalBytes,
      processedBytes: preparedInput.processedBytes,
      originalWidth: preparedInput.originalWidth,
      originalHeight: preparedInput.originalHeight,
      processedWidth: preparedInput.processedWidth,
      processedHeight: preparedInput.processedHeight,
      preprocessing: preparedInput.preprocessing,
    },
    ocrBlocks: draft.ocrBlocks,
    regions: draft.regions,
    components: draft.components,
    errorText: draft.errorText,
    suspectedCauses: draft.suspectedCauses,
    evidenceRegions: draft.evidenceRegions,
  });
}

export function validateVisionArtifact(artifact: VisionArtifact): VisionArtifact {
  if (artifact.kind !== "vision_artifact") {
    throw new KimiVisionWorkerError("artifact_validation_failed", `Expected vision_artifact, received ${artifact.kind}.`);
  }
  if (!isNonEmptyString(artifact.summary)) {
    throw new KimiVisionWorkerError("artifact_validation_failed", "Vision artifact summary must be non-empty.");
  }
  if (
    artifact.taskType !== "ocr_extract" &&
    artifact.taskType !== "ui_parse" &&
    artifact.taskType !== "error_screenshot" &&
    artifact.taskType !== "diagram_parse"
  ) {
    throw new KimiVisionWorkerError("artifact_validation_failed", `Unsupported taskType ${artifact.taskType}.`);
  }
  artifact.confidence = asConfidence(artifact.confidence, "confidence");
  artifact.issues = asStringArray(artifact.issues, "issues");
  artifact.risks = Array.isArray(artifact.risks) ? asStringArray(artifact.risks, "risks") : [...artifact.issues];

  if (!artifact.metadata || typeof artifact.metadata !== "object" || Array.isArray(artifact.metadata)) {
    throw new KimiVisionWorkerError("artifact_validation_failed", "Vision artifact metadata must be an object.");
  }

  const metadata = artifact.metadata as VisionArtifactMetadata;
  if (
    metadata.sourceType !== "local_path" &&
    metadata.sourceType !== "uploaded_file" &&
    metadata.sourceType !== "browser_capture"
  ) {
    throw new KimiVisionWorkerError("artifact_validation_failed", "metadata.sourceType is invalid.");
  }
  if (metadata.inputMode !== "base64_data_url" && metadata.inputMode !== "file_id") {
    throw new KimiVisionWorkerError("artifact_validation_failed", "metadata.inputMode is invalid.");
  }
  for (const field of ["inputImageRef", "originalImageRef", "processedImageRef", "mimeType"] as const) {
    if (!isNonEmptyString(metadata[field])) {
      throw new KimiVisionWorkerError("artifact_validation_failed", `metadata.${field} must be non-empty.`);
    }
  }
  for (const field of [
    "originalBytes",
    "processedBytes",
    "originalWidth",
    "originalHeight",
    "processedWidth",
    "processedHeight",
  ] as const) {
    const value = Number(metadata[field]);
    if (!Number.isFinite(value) || value < 0) {
      throw new KimiVisionWorkerError("artifact_validation_failed", `metadata.${field} must be non-negative.`);
    }
  }
  if (!metadata.preprocessing || typeof metadata.preprocessing !== "object" || Array.isArray(metadata.preprocessing)) {
    throw new KimiVisionWorkerError("artifact_validation_failed", "metadata.preprocessing must be an object.");
  }

  artifact.ocrBlocks = asOcrBlocks(artifact.ocrBlocks);
  artifact.regions = asRegions(artifact.regions);
  artifact.components = asComponents(artifact.components);

  if (artifact.taskType === "error_screenshot") {
    artifact.errorText = asStringArray(artifact.errorText, "errorText");
    artifact.suspectedCauses = asStringArray(artifact.suspectedCauses, "suspectedCauses");
    artifact.evidenceRegions = asStringArray(artifact.evidenceRegions, "evidenceRegions");
  } else {
    if (artifact.errorText !== undefined) {
      artifact.errorText = asStringArray(artifact.errorText, "errorText");
    }
    if (artifact.suspectedCauses !== undefined) {
      artifact.suspectedCauses = asStringArray(artifact.suspectedCauses, "suspectedCauses");
    }
    if (artifact.evidenceRegions !== undefined) {
      artifact.evidenceRegions = asStringArray(artifact.evidenceRegions, "evidenceRegions");
    }
  }

  return artifact;
}

export function summarizeVisionArtifact(artifact: VisionArtifact): VisionArtifactSummary {
  return {
    kind: "vision_artifact",
    taskType: artifact.taskType,
    summary: artifact.summary,
    confidence: artifact.confidence,
    issues: artifact.issues,
    metadata: artifact.metadata,
  };
}

export function toVisionToolSummary(artifact: VisionArtifact, artifactRef: string): VisionArtifactToolSummary {
  return {
    ...summarizeVisionArtifact(artifact),
    artifactRef,
  };
}

function buildSystemPrompt(taskType: VisionTaskType): string {
  return [
    "You are the isolated Kimi vision worker inside Deep-Mix phase 4.",
    "You are not the governor.",
    "You do not have workspace write access or tool access.",
    "Return a single JSON object only. Do not wrap it in markdown fences.",
    "Focus on visible evidence in the image.",
    `Current task type: ${taskType}.`,
  ].join("\n");
}

function buildUserPrompt(task: WorkerTask, preparedInput: PreparedVisionInput): string {
  return [
    `Objective: ${task.objective}`,
    `Constraints: ${task.constraints.join(" | ") || "None."}`,
    `Acceptance Checks: ${task.acceptanceChecks.join(" | ") || "None."}`,
    `Image metadata: sourceType=${preparedInput.image.sourceType}; mimeType=${preparedInput.mimeType}; original=${preparedInput.originalWidth}x${preparedInput.originalHeight}; processed=${preparedInput.processedWidth}x${preparedInput.processedHeight}.`,
    minimumFieldGuidance(preparedInput.taskType),
    "Return exactly one JSON object with this shape:",
    JSON.stringify(
      {
        summary: "Concise visual summary",
        confidence: 0.5,
        issues: ["Potential uncertainty or ambiguity, if any"],
        ocrBlocks: [
          {
            text: "Visible text",
            confidence: 0.8,
            regionId: "region-1",
          },
        ],
        regions: [
          {
            id: "region-1",
            label: "text-or-ui-region",
            confidence: 0.8,
            bbox: {
              x: 0,
              y: 0,
              width: 100,
              height: 40,
            },
          },
        ],
        components: [
          {
            id: "component-1",
            type: "button",
            label: "Submit",
            confidence: 0.7,
            regionId: "region-1",
            attributes: {
              state: "visible",
            },
          },
        ],
        errorText: preparedInput.taskType === "error_screenshot" ? ["Visible error line"] : undefined,
        suspectedCauses: preparedInput.taskType === "error_screenshot" ? ["Likely cause"] : undefined,
        evidenceRegions: preparedInput.taskType === "error_screenshot" ? ["region-1"] : undefined,
      },
      null,
      2,
    ),
  ].join("\n\n");
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new KimiVisionWorkerError("response_parse_failed", `Failed to parse Kimi JSON response: ${(error as Error).message}`, {
      retryable: true,
      rawResponse: raw,
    });
  }
}

function parseVisionArtifactDraft(raw: string): VisionArtifactDraft {
  const parsed = parseJsonObject(raw);
  if (!isNonEmptyString(parsed.summary)) {
    throw new KimiVisionWorkerError("artifact_validation_failed", "Vision artifact summary must be non-empty.", {
      retryable: false,
      rawResponse: raw,
    });
  }

  return {
    summary: parsed.summary.trim(),
    confidence: asConfidence(parsed.confidence, "confidence"),
    issues: asStringArray(parsed.issues, "issues"),
    ocrBlocks: asOcrBlocks(parsed.ocrBlocks),
    regions: asRegions(parsed.regions),
    components: asComponents(parsed.components),
    errorText: parsed.errorText === undefined ? undefined : asStringArray(parsed.errorText, "errorText"),
    suspectedCauses:
      parsed.suspectedCauses === undefined ? undefined : asStringArray(parsed.suspectedCauses, "suspectedCauses"),
    evidenceRegions:
      parsed.evidenceRegions === undefined ? undefined : asStringArray(parsed.evidenceRegions, "evidenceRegions"),
  };
}

export class KimiVisionWorkerClient implements VisionWorkerRunner {
  private readonly config: KimiVisionWorkerConfig;

  public constructor(config: KimiVisionWorkerConfig) {
    this.config = config;
  }

  public async runTask(input: KimiVisionWorkerRequest): Promise<KimiVisionWorkerExecutionResult> {
    if (!this.config.apiKey) {
      throw new KimiVisionWorkerError("configuration_error", "Missing API key for kimi_vision profile.");
    }
    if (!this.config.supportsMultimodalInput) {
      throw new KimiVisionWorkerError("configuration_error", "The configured Kimi profile does not support multimodal input.");
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
            content: buildSystemPrompt(input.preparedInput.taskType),
          },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: input.preparedInput.processedDataUrl,
                },
              },
              {
                type: "text",
                text: buildUserPrompt(input.task, input.preparedInput),
              },
            ],
          },
        ],
        response_format: { type: this.config.responseFormat },
        thinking: { type: "disabled" },
        ...this.config.requestDefaults,
      }),
      signal: input.signal,
    });

    if (!response.ok) {
      throw new KimiVisionWorkerError(
        "model_call_failed",
        `Kimi request failed with ${response.status}: ${(await response.text()).slice(0, 400)}`,
        { retryable: response.status >= 500 },
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const rawResponse = payload.choices?.[0]?.message?.content?.trim();
    if (!rawResponse) {
      throw new KimiVisionWorkerError("response_parse_failed", "Kimi response did not contain assistant content.", {
        retryable: true,
      });
    }

    return {
      artifact: parseVisionArtifactDraft(rawResponse),
      rawResponse,
    };
  }
}
