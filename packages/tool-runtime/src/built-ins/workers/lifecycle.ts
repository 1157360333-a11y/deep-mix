import { createHash } from "node:crypto";

import type {
  LifecycleWarning,
  ToolAccessRequest,
  ToolPermissionProfile,
  WorkerCancelResult,
  WorkerOutputPage,
  WorkerOutputRequest,
  WorkerPublicOutputEvent,
  WorkerPublicOutputKind,
  WorkerStatusSummary,
} from "../../../../shared-schema/src/index.js";
import {
  encodeLifecycleCursor,
  LIFECYCLE_MAX_LIMIT,
  paginateLifecycleItems,
} from "../../lifecycle-pagination.js";
import type { RuntimeToolSpec, ToolModule, ToolWorkerServices } from "../../tool-module.js";

const WORKER_STATUS_OUTPUT_MAX_CHARS = 65_536;
const WORKER_OUTPUT_DEFAULT_CHARS = 262_144;
const WORKER_OUTPUT_MAX_CHARS = 2_000_000;
const WORKER_OUTPUT_MIN_CHARS = 65_536;
const WORKER_CANCEL_OUTPUT_MAX_CHARS = 65_536;
const PUBLIC_OUTPUT_KINDS = new Set<WorkerPublicOutputKind>([
  "status",
  "artifact",
  "promotion",
  "verification",
  "error",
]);

function lifecycleError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function requireWorkers(workers: ToolWorkerServices | undefined): ToolWorkerServices {
  if (!workers) throw lifecycleError("ERR_TOOL_UNAVAILABLE", "Worker lifecycle services are unavailable.");
  return workers;
}

function workerId(rawArgs: unknown): string {
  const value = (rawArgs as { workerSessionId?: unknown } | undefined)?.workerSessionId;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) {
    throw lifecycleError("ERR_TOOL_INVALID_ARGUMENTS", "A valid workerSessionId is required.");
  }
  return value;
}

function workerEventKey(event: WorkerPublicOutputEvent): string {
  return `${event.createdAt}|${event.eventId}`;
}

function outputArguments(rawArgs: unknown): Required<Pick<WorkerOutputRequest, "workerSessionId" | "limit" | "maxChars">> & {
  cursor?: string;
  kinds?: WorkerPublicOutputKind[];
} {
  const args = (rawArgs ?? {}) as WorkerOutputRequest;
  const workerSessionId = workerId(args);
  const limit = args.limit ?? 50;
  const maxChars = args.maxChars ?? WORKER_OUTPUT_DEFAULT_CHARS;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIFECYCLE_MAX_LIMIT) {
    throw lifecycleError("ERR_TOOL_INVALID_ARGUMENTS", `limit must be between 1 and ${LIFECYCLE_MAX_LIMIT}.`);
  }
  if (!Number.isInteger(maxChars) || maxChars < WORKER_OUTPUT_MIN_CHARS || maxChars > WORKER_OUTPUT_MAX_CHARS) {
    throw lifecycleError(
      "ERR_TOOL_INVALID_ARGUMENTS",
      `maxChars must be between ${WORKER_OUTPUT_MIN_CHARS} and ${WORKER_OUTPUT_MAX_CHARS}.`,
    );
  }
  let kinds: WorkerPublicOutputKind[] | undefined;
  if (args.kinds !== undefined) {
    if (!Array.isArray(args.kinds) || args.kinds.length === 0) {
      throw lifecycleError("ERR_TOOL_INVALID_ARGUMENTS", "kinds must be a non-empty array when provided.");
    }
    kinds = [...new Set(args.kinds)].sort();
    if (kinds.some((kind) => !PUBLIC_OUTPUT_KINDS.has(kind))) {
      throw lifecycleError("ERR_TOOL_INVALID_ARGUMENTS", "kinds contains an unsupported public worker output kind.");
    }
  }
  return { workerSessionId, cursor: args.cursor, limit, kinds, maxChars };
}

function cancellationArguments(rawArgs: unknown): { workerSessionId: string; reason: string } {
  const args = (rawArgs ?? {}) as { workerSessionId?: unknown; reason?: unknown };
  const workerSessionId = workerId(args);
  const reason = args.reason === undefined ? "Cancelled by governor." : args.reason;
  if (typeof reason !== "string" || !reason.trim() || reason.length > 1_000) {
    throw lifecycleError("ERR_TOOL_INVALID_ARGUMENTS", "Cancellation reason must contain 1 to 1,000 characters.");
  }
  return { workerSessionId, reason: reason.trim() };
}

function reasonFingerprint(reason: string): string {
  return createHash("sha256").update(reason).digest("base64url").slice(0, 24);
}

function fitWorkerStatus(status: WorkerStatusSummary): WorkerStatusSummary {
  const bounded: WorkerStatusSummary = {
    ...status,
    recentSummary: status.recentSummary?.slice(0, 4_000),
    progress: status.progress ? { ...status.progress, label: status.progress.label.slice(0, 1_000) } : undefined,
    warnings: status.warnings.slice(0, 32).map((warning) => ({
      ...warning,
      message: warning.message.slice(0, 1_000),
      recordId: warning.recordId?.slice(0, 512),
    })),
  };
  if (JSON.stringify(bounded).length > WORKER_STATUS_OUTPUT_MAX_CHARS) {
    bounded.recentSummary = bounded.recentSummary?.slice(0, 512);
    bounded.warnings = bounded.warnings.slice(0, 4);
    bounded.partial = true;
    bounded.warnings.push({ code: "content_truncated", message: "Worker status was bounded to the public output budget." });
  }
  return bounded;
}

function fitWorkerOutput(input: {
  page: WorkerOutputPage;
  maxChars: number;
  cursorContext: Parameters<typeof encodeLifecycleCursor>[0];
}): WorkerOutputPage {
  const page: WorkerOutputPage = {
    ...input.page,
    events: input.page.events.map((event) => ({
      ...event,
      summary: event.summary.slice(0, 4_000),
    })),
    warnings: input.page.warnings.slice(0, 100),
  };
  if (JSON.stringify(page).length <= input.maxChars) return page;
  const warning: LifecycleWarning = {
    code: "content_truncated",
    message: "Worker output page was shortened to maxChars; continue with nextCursor.",
  };
  page.partial = true;
  page.warnings.push(warning);
  if (page.availableResult !== undefined) delete page.availableResult;
  while (page.events.length > 1 && JSON.stringify(page).length > input.maxChars) page.events.pop();
  page.returned = page.events.length;
  page.hasMore = true;
  page.nextCursor = page.events.length > 0
    ? encodeLifecycleCursor(input.cursorContext, workerEventKey(page.events.at(-1)!))
    : input.page.nextCursor;
  if (JSON.stringify(page).length > input.maxChars && page.events[0]) {
    page.events[0] = {
      ...page.events[0],
      summary: page.events[0].summary.slice(0, 256),
      details: undefined,
      artifact: undefined,
    };
  }
  return page;
}

export const workerStatusTool: RuntimeToolSpec = {
  name: "worker_status",
  description:
    "Return a bounded public lifecycle status for a worker owned by the current workspace and parent session without sending the worker any message.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["workerSessionId"],
    properties: {
      workerSessionId: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" },
    },
  },
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "fast",
  groups: ["workers", "lifecycle"],
  selection: {
    groups: ["workers", "lifecycle"],
    keywords: ["worker status", "worker progress", "worker state", "工作器状态", "任务进度"],
  },
  resolveAccess: async (rawArgs, context): Promise<ToolAccessRequest[]> => {
    const id = workerId(rawArgs);
    await requireWorkers(context.optional.workers).getWorkerStatus(context.sessionId, id);
    return [{ kind: "trusted_state_read", reason: "Read current-session public worker lifecycle state through SpecialistBroker." }];
  },
  redactArguments: (rawArgs) => ({ workerSessionId: (rawArgs as { workerSessionId?: unknown })?.workerSessionId }),
  execute: async (rawArgs, context) => {
    const startedAt = context.moduleContext.clock.now();
    const status = fitWorkerStatus(
      await requireWorkers(context.moduleContext.optional.workers).getWorkerStatus(
        context.sessionId,
        workerId(rawArgs),
      ),
    );
    return {
      toolName: "worker_status",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: true,
      output: JSON.stringify(status),
      structuredContent: status,
    };
  },
};

export const workerOutputTool: RuntimeToolSpec = {
  name: "worker_output",
  description:
    "Page through bounded public worker status, artifact, promotion, verification, and error events; private reasoning and raw provider messages are never read.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["workerSessionId"],
    properties: {
      workerSessionId: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" },
      cursor: { type: "string", minLength: 1, maxLength: 4_096 },
      limit: { type: "integer", minimum: 1, maximum: LIFECYCLE_MAX_LIMIT, default: 50 },
      maxChars: { type: "integer", minimum: WORKER_OUTPUT_MIN_CHARS, maximum: WORKER_OUTPUT_MAX_CHARS, default: WORKER_OUTPUT_DEFAULT_CHARS },
      kinds: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: { type: "string", enum: [...PUBLIC_OUTPUT_KINDS] },
      },
    },
  },
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "fast",
  groups: ["workers", "lifecycle"],
  selection: {
    groups: ["workers", "lifecycle"],
    keywords: ["worker output", "worker result", "worker artifact", "工作器输出", "任务结果"],
  },
  resolveAccess: async (rawArgs, context): Promise<ToolAccessRequest[]> => {
    const args = outputArguments(rawArgs);
    await requireWorkers(context.optional.workers).getWorkerStatus(context.sessionId, args.workerSessionId);
    return [{ kind: "trusted_state_read", reason: "Read only the current-session public worker event projection through SpecialistBroker." }];
  },
  redactArguments: (rawArgs) => {
    const args = (rawArgs ?? {}) as WorkerOutputRequest;
    return {
      workerSessionId: args.workerSessionId,
      kinds: args.kinds,
      limit: args.limit,
      maxChars: args.maxChars,
      cursorProvided: Boolean(args.cursor),
    };
  },
  execute: async (rawArgs, context) => {
    const args = outputArguments(rawArgs);
    const startedAt = context.moduleContext.clock.now();
    const snapshot = await requireWorkers(context.moduleContext.optional.workers).getWorkerPublicOutput(
      context.sessionId,
      args.workerSessionId,
    );
    const filters = { workerSessionId: args.workerSessionId, kinds: args.kinds ?? [...PUBLIC_OUTPUT_KINDS].sort() };
    const filtered = snapshot.events.filter((event) => !args.kinds || args.kinds.includes(event.kind));
    const cursorContext = {
      scope: "worker_output",
      workspaceId: snapshot.status.ownership.workspaceId,
      sessionId: context.sessionId,
      filters,
      integrityKey: await context.moduleContext.persistence.getLifecycleCursorIntegrityKey(),
    };
    const pagination = paginateLifecycleItems({
      items: filtered,
      cursor: args.cursor,
      limit: args.limit,
      context: cursorContext,
      stableKey: workerEventKey,
    });
    const page = fitWorkerOutput({
      maxChars: args.maxChars,
      cursorContext,
      page: {
        workerSessionId: args.workerSessionId,
        workerType: snapshot.status.workerType,
        status: snapshot.status.status,
        events: pagination.items,
        limit: pagination.limit,
        returned: pagination.returned,
        scanned: snapshot.scanned,
        hasMore: pagination.hasMore,
        nextCursor: pagination.nextCursor,
        availableResult: snapshot.availableResult,
        ownership: snapshot.status.ownership,
        partial: snapshot.partial,
        warnings: snapshot.warnings,
      },
    });
    return {
      toolName: "worker_output",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: true,
      output: JSON.stringify(page),
      structuredContent: page,
    };
  },
};

export const workerCancelTool: RuntimeToolSpec = {
  name: "worker_cancel",
  description:
    "Request an explicitly approved, idempotent cancellation for a worker owned by the current workspace and parent session while preserving artifacts and audit records.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["workerSessionId"],
    properties: {
      workerSessionId: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" },
      reason: { type: "string", minLength: 1, maxLength: 1_000, default: "Cancelled by governor." },
    },
  },
  readOnly: false,
  permissionCategory: "execute_command",
  sideEffectLevel: "medium",
  timeoutCategory: "fast",
  groups: ["workers", "lifecycle", "cancellation"],
  selection: {
    groups: ["workers", "lifecycle", "cancellation"],
    keywords: ["cancel worker", "stop worker", "取消工作器", "停止任务"],
  },
  resolveAccess: async (rawArgs, context): Promise<ToolAccessRequest[]> => {
    const args = cancellationArguments(rawArgs);
    await requireWorkers(context.optional.workers).previewWorkerCancellation(context.sessionId, args.workerSessionId);
    return [
      { kind: "trusted_state_read", reason: "Validate current workspace and parent-session worker ownership before cancellation." },
      { kind: "external_system", systems: ["specialist_broker"], reason: "Control only the owned worker through SpecialistBroker cancellation." },
    ];
  },
  resolvePermission: async (rawArgs, context): Promise<ToolPermissionProfile> => {
    const args = cancellationArguments(rawArgs);
    const preview = await requireWorkers(context.optional.workers).previewWorkerCancellation(
      context.sessionId,
      args.workerSessionId,
    );
    return {
      permissionCategory: "execute_command",
      sideEffectLevel: "medium",
      readOnly: false,
      approvalContext: {
        workerSessionId: args.workerSessionId,
        requestingSessionId: context.sessionId,
        status: preview.status,
        statusVersion: preview.statusVersion,
        artifactCount: preview.artifactCount,
        reasonFingerprint: reasonFingerprint(args.reason),
      },
      approvalPresentation: {
        action: "cancel worker",
        summary: `Request cancellation of owned ${preview.workerType} worker ${args.workerSessionId} in ${preview.status} state.`,
        argumentSummary: {
          workerSessionId: args.workerSessionId,
          status: preview.status,
          reason: args.reason.slice(0, 200),
          artifactCountPreserved: preview.artifactCount,
        },
      },
    };
  },
  redactArguments: (rawArgs) => {
    const args = (rawArgs ?? {}) as { workerSessionId?: unknown; reason?: unknown };
    return {
      workerSessionId: args.workerSessionId,
      reasonChars: typeof args.reason === "string" ? args.reason.length : 0,
      reasonFingerprint: typeof args.reason === "string" ? reasonFingerprint(args.reason) : undefined,
    };
  },
  execute: async (rawArgs, context) => {
    const args = cancellationArguments(rawArgs);
    const startedAt = context.moduleContext.clock.now();
    const approved = (context.approvalContext ?? {}) as Record<string, unknown>;
    if (
      approved.workerSessionId !== args.workerSessionId ||
      approved.requestingSessionId !== context.sessionId ||
      approved.reasonFingerprint !== reasonFingerprint(args.reason) ||
      !Number.isSafeInteger(approved.statusVersion)
    ) {
      throw lifecycleError("ERR_TOOL_CONFLICTED", "Worker cancellation approval context is missing or stale.");
    }
    const result: WorkerCancelResult = await requireWorkers(
      context.moduleContext.optional.workers,
    ).cancelOwnedWorkerSession({
      parentSessionId: context.sessionId,
      workerSessionId: args.workerSessionId,
      reason: args.reason,
      approvedStatusVersion: approved.statusVersion as number,
    });
    if (JSON.stringify(result).length > WORKER_CANCEL_OUTPUT_MAX_CHARS) {
      result.warnings = [{ code: "content_truncated", message: "Cancellation result warnings were bounded." }];
      result.partial = true;
    }
    return {
      toolName: "worker_cancel",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: true,
      output: JSON.stringify(result),
      structuredContent: result,
    };
  },
};

export const workerLifecycleToolModule: ToolModule = {
  manifest: {
    id: "builtin.worker-lifecycle",
    version: "1.0.0",
    description: "Owner-aware public worker status, output, and idempotent cancellation tools.",
    source: "built_in",
  },
  create: (context) => context.optional.workers
    ? [workerStatusTool, workerOutputTool, workerCancelTool]
    : [],
};
