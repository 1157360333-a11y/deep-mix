import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../../persistence/src/index.js";
import type {
  PlanItem,
  RuntimeEvent,
  RuntimeEventName,
  WorkflowDefinition,
  WorkflowDiscoveryResult,
  WorkflowGovernorStep,
  WorkflowRunResult,
  WorkflowStep,
  WorkflowStepResult,
  WorkflowToolStep,
  WorkflowWorkerStep,
} from "../../shared-schema/src/index.js";
import { ToolRuntime } from "../../tool-runtime/src/index.js";

function now(): string {
  return new Date().toISOString();
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walkWorkflowFiles(root: string): Promise<string[]> {
  if (!(await exists(root))) {
    return [];
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkWorkflowFiles(absolutePath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".workflow.json")) {
      results.push(absolutePath);
    }
  }
  return results;
}

function resolveBuiltInRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "builtin-workflows");
}

function normalizeWorkflowName(filePath: string, rawName: unknown): string {
  if (typeof rawName === "string" && rawName.trim()) {
    return rawName.trim();
  }
  return path.basename(filePath, ".workflow.json");
}

function validateGovernorStep(step: Record<string, unknown>): WorkflowGovernorStep {
  if (step.action !== "record_message" && step.action !== "update_plan") {
    throw new Error(`Unsupported governor action: ${String(step.action)}`);
  }
  if (typeof step.id !== "string" || !step.id.trim()) {
    throw new Error("Governor step requires a non-empty id.");
  }
  return {
    id: step.id,
    type: "governor",
    action: step.action,
    message: typeof step.message === "string" ? step.message : undefined,
    planItems: Array.isArray(step.planItems) ? (step.planItems as PlanItem[]) : undefined,
    onError: step.onError === "continue" ? "continue" : "abort",
  };
}

function validateWorkerStep(step: Record<string, unknown>): WorkflowWorkerStep {
  if (typeof step.id !== "string" || !step.id.trim()) {
    throw new Error("Worker step requires a non-empty id.");
  }
  if (step.workerType !== "coding" && step.workerType !== "vision") {
    throw new Error(`Unsupported worker type: ${String(step.workerType)}`);
  }
  return {
    id: step.id,
    type: "worker",
    workerType: step.workerType,
    input: typeof step.input === "object" && step.input !== null ? (step.input as Record<string, unknown>) : {},
    onError: step.onError === "continue" ? "continue" : "abort",
  };
}

function validateToolStep(step: Record<string, unknown>): WorkflowToolStep {
  if (typeof step.id !== "string" || !step.id.trim()) {
    throw new Error("Tool step requires a non-empty id.");
  }
  if (typeof step.toolName !== "string" || !step.toolName.trim()) {
    throw new Error("Tool step requires a non-empty toolName.");
  }
  return {
    id: step.id,
    type: "tool",
    toolName: step.toolName,
    arguments: step.arguments,
    onError: step.onError === "continue" ? "continue" : "abort",
  };
}

function validateStep(rawStep: unknown): WorkflowStep {
  if (!rawStep || typeof rawStep !== "object") {
    throw new Error("Workflow step must be an object.");
  }

  const step = rawStep as Record<string, unknown>;
  switch (step.type) {
    case "governor":
      return validateGovernorStep(step);
    case "worker":
      return validateWorkerStep(step);
    case "tool":
      return validateToolStep(step);
    default:
      throw new Error(`Unsupported workflow step type: ${String(step.type)}`);
  }
}

export type HookHandler = (event: RuntimeEvent) => void | Promise<void>;

export class HookBus {
  private readonly handlers = new Map<string, HookHandler>();

  public register(name: string, handler: HookHandler): () => void {
    this.handlers.set(name, handler);
    return () => {
      this.handlers.delete(name);
    };
  }

  public async emit(event: RuntimeEvent): Promise<void> {
    for (const handler of this.handlers.values()) {
      await handler(event);
    }
  }
}

export class WorkflowRuntime {
  public constructor(
    private readonly workspaceRoot: string,
    private readonly sessionStore: SessionStore,
    private readonly toolRuntime: ToolRuntime,
    private readonly hookBus: HookBus,
  ) {}

  public async discoverWorkflows(): Promise<WorkflowDiscoveryResult> {
    const locations = [
      {
        scope: "project" as const,
        root: path.join(this.workspaceRoot, ".deep-mix", "workflows"),
      },
      {
        scope: "user" as const,
        root: path.join(os.homedir(), ".deep-mix", "workflows"),
      },
      {
        scope: "built_in" as const,
        root: resolveBuiltInRoot(),
      },
    ];

    const workflows: WorkflowDefinition[] = [];
    const errors: string[] = [];
    const seenNames = new Set<string>();

    for (const location of locations) {
      const files = await walkWorkflowFiles(location.root);
      for (const filePath of files) {
        try {
          const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as {
            name?: string;
            description?: string;
            steps?: unknown[];
          };
          const name = normalizeWorkflowName(filePath, raw.name);
          if (seenNames.has(name)) {
            continue;
          }
          if (!Array.isArray(raw.steps)) {
            throw new Error("Workflow file requires a steps array.");
          }

          workflows.push({
            name,
            description:
              typeof raw.description === "string" && raw.description.trim()
                ? raw.description.trim()
                : `Workflow loaded from ${filePath}.`,
            sourcePath: filePath,
            sourceScope: location.scope,
            steps: raw.steps.map((step) => validateStep(step)),
          });
          seenNames.add(name);
        } catch (error) {
          errors.push(`${filePath}: ${(error as Error).message}`);
        }
      }
    }

    return {
      workflows,
      errors,
    };
  }

  public async runWorkflow(input: {
    name: string;
    sessionId?: string;
  }): Promise<WorkflowRunResult> {
    const discovery = await this.discoverWorkflows();
    const workflow = discovery.workflows.find((entry) => entry.name === input.name);
    if (!workflow) {
      throw new Error(`Unknown workflow: ${input.name}`);
    }

    const session =
      input.sessionId !== undefined
        ? await this.sessionStore.loadSession(input.sessionId)
        : await this.sessionStore.createSession(`workflow:${workflow.name}`);
    if (!session) {
      throw new Error(`Unknown session: ${input.sessionId}`);
    }

    const runId = randomUUID();
    const stepResults: WorkflowStepResult[] = [];
    const errors = [...discovery.errors];

    await this.hookBus.emit({
      name: "session_start",
      createdAt: now(),
      sessionId: session.sessionId,
      workflowRunId: runId,
      payload: {
        workflowName: workflow.name,
      },
    });

    for (const step of workflow.steps) {
      const result = await this.runWorkflowStep(session.sessionId, runId, step);
      stepResults.push(result);
      if (!result.success) {
        errors.push(`${step.id}: ${result.error ?? result.output}`);
        if (!result.continuedAfterError) {
          await this.hookBus.emit({
            name: "task_failed",
            createdAt: now(),
            sessionId: session.sessionId,
            workflowRunId: runId,
            stepId: step.id,
            payload: {
              workflowName: workflow.name,
              error: result.error ?? result.output,
            },
          });
          return {
            runId,
            workflowName: workflow.name,
            sessionId: session.sessionId,
            success: false,
            stepResults,
            errors,
          };
        }
      }
    }

    return {
      runId,
      workflowName: workflow.name,
      sessionId: session.sessionId,
      success: errors.length === 0,
      stepResults,
      errors,
    };
  }

  private async runWorkflowStep(sessionId: string, runId: string, step: WorkflowStep): Promise<WorkflowStepResult> {
    try {
      switch (step.type) {
        case "governor":
          return await this.runGovernorStep(sessionId, step);
        case "tool":
          return await this.runToolStep(sessionId, runId, step);
        case "worker":
          return await this.runWorkerStep(sessionId, runId, step);
      }
    } catch (error) {
      return {
        stepId: step.id,
        type: step.type,
        success: false,
        output: "",
        error: (error as Error).message,
        continuedAfterError: step.onError === "continue",
      };
    }
  }

  private async runGovernorStep(sessionId: string, step: WorkflowGovernorStep): Promise<WorkflowStepResult> {
    if (step.action === "record_message") {
      const content = step.message ?? `[workflow:${step.id}] governor step completed`;
      await this.sessionStore.appendMessage({
        sessionId,
        turnId: `workflow-${step.id}`,
        role: "assistant",
        content,
      });
      return {
        stepId: step.id,
        type: "governor",
        success: true,
        output: content,
        continuedAfterError: false,
      };
    }

    const planItems = step.planItems ?? [];
    await this.sessionStore.updatePlanItems(sessionId, planItems);
    return {
      stepId: step.id,
      type: "governor",
      success: true,
      output: `Updated plan with ${planItems.length} item(s).`,
      structuredContent: planItems,
      continuedAfterError: false,
    };
  }

  private async runToolStep(sessionId: string, runId: string, step: WorkflowToolStep): Promise<WorkflowStepResult> {
    await this.emitToolEvent("tool_before", sessionId, runId, step.id, step.toolName, step.arguments);
    const result = await this.toolRuntime.executeManualTool(step.toolName, step.arguments ?? {}, sessionId);
    await this.emitToolEvent("tool_after", sessionId, runId, step.id, step.toolName, {
      success: result.success,
      output: result.output,
    });

    return {
      stepId: step.id,
      type: "tool",
      success: result.success,
      output: result.output,
      structuredContent: result.structuredContent,
      error: result.error,
      continuedAfterError: !result.success && step.onError === "continue",
    };
  }

  private async runWorkerStep(sessionId: string, runId: string, step: WorkflowWorkerStep): Promise<WorkflowStepResult> {
    const toolName = step.workerType === "coding" ? "invoke_coding_worker" : "invoke_vision_worker";
    await this.emitToolEvent("tool_before", sessionId, runId, step.id, toolName, step.input);
    const result = await this.toolRuntime.executeManualTool(toolName, step.input, sessionId);
    await this.emitToolEvent("tool_after", sessionId, runId, step.id, toolName, {
      success: result.success,
      output: result.output,
    });

    if (result.success) {
      const structured = (result.structuredContent ?? {}) as {
        workerSessionId?: string;
      };
      await this.hookBus.emit({
        name: "worker_completed",
        createdAt: now(),
        sessionId,
        workflowRunId: runId,
        stepId: step.id,
        workerSessionId: structured.workerSessionId,
        payload: {
          workerType: step.workerType,
          output: result.output,
        },
      });
    }

    return {
      stepId: step.id,
      type: "worker",
      success: result.success,
      output: result.output,
      structuredContent: result.structuredContent,
      error: result.error,
      continuedAfterError: !result.success && step.onError === "continue",
    };
  }

  private async emitToolEvent(
    name: Extract<RuntimeEventName, "tool_before" | "tool_after">,
    sessionId: string,
    workflowRunId: string,
    stepId: string,
    toolName: string,
    payload: Record<string, unknown> | unknown,
  ): Promise<void> {
    await this.hookBus.emit({
      name,
      createdAt: now(),
      sessionId,
      workflowRunId,
      stepId,
      toolName,
      payload: payload && typeof payload === "object" ? (payload as Record<string, unknown>) : { value: payload },
    });
  }
}
