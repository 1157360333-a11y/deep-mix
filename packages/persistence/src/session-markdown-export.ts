import path from "node:path";
import type {
  CodeArtifactSummary,
  ContextBudgetRecord,
  ContextSummaryRecord,
  HistoryIntegrityRecord,
  MessageRecord,
  SessionEvent,
  SessionRecord,
  TurnRecord,
  WorkerArtifactRecord,
  WorkerSessionEvent,
  WorkerSessionRecord,
} from "../../shared-schema/src/index.js";

export interface SessionExportSource {
  workspaceRoot: string;
  loadSession(sessionId: string): Promise<SessionRecord | undefined>;
  loadEvents(sessionId: string): Promise<SessionEvent[]>;
  loadWorkerSession(workerSessionId: string): Promise<WorkerSessionRecord | undefined>;
  loadWorkerEvents(workerSessionId: string): Promise<WorkerSessionEvent[]>;
  readArtifactRef(ref: string): Promise<string | undefined>;
}

export interface SessionMarkdownExportResult {
  outputPath: string;
  content: string;
}

interface BuildMarkdownOptions {
  generatedAt?: string;
}

function now(): string {
  return new Date().toISOString();
}

function createSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "session";
}

function toRelative(workspaceRoot: string, targetPath: string): string {
  return path.relative(workspaceRoot, targetPath).replace(/\\/g, "/");
}

function fenceFor(content: string): string {
  return content.includes("```") ? "````" : "```";
}

function codeBlock(content: string, language = ""): string {
  const fence = fenceFor(content);
  return `${fence}${language}\n${content}\n${fence}`;
}

const SENSITIVE_EXPORT_KEY = /^(?:api[-_]?key|authorization|proxy-authorization|cookie|set-cookie|secret|access[-_]?token|refresh[-_]?token|credential|x-api-key)$/i;

function redactUrlQuery(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>`]+/gu, (candidate) => {
    try {
      const url = new URL(candidate);
      if (!url.search && !url.hash) return candidate;
      return `${url.origin}${url.pathname}?[REDACTED_QUERY]`;
    } catch {
      return candidate.replace(/\?[^\s"'<>`]*/u, "?[REDACTED_QUERY]");
    }
  });
}

export function redactSessionExportText(value: string): string {
  return redactUrlQuery(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED_KEY]")
    .replace(/((?:api[-_]?key|authorization|x-api-key|access[-_]?token|secret)\s*[:=]\s*)[^\s,;]+/giu, "$1[REDACTED]");
}

export function sanitizeSessionExportValue(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[REDACTED_DEPTH]";
  if (typeof value === "string") return redactSessionExportText(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeSessionExportValue(entry, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    SENSITIVE_EXPORT_KEY.test(key) ? "[REDACTED]" : sanitizeSessionExportValue(entry, depth + 1),
  ]));
}

function jsonBlock(value: unknown): string {
  return codeBlock(JSON.stringify(sanitizeSessionExportValue(value), null, 2), "json");
}

function textBlock(value: string): string {
  return codeBlock(redactSessionExportText(value || ""), "text");
}

function patchBlock(value: string): string {
  return codeBlock(redactSessionExportText(value || ""), "diff");
}

function section(title: string, body: string[]): string {
  return [`## ${title}`, ...body].join("\n\n");
}

function renderPlanItems(session: SessionRecord): string[] {
  if (session.planItems.length === 0) {
    return ["- none"];
  }
  return session.planItems.map((item) => {
    const notes = item.notes ? ` | notes=${item.notes}` : "";
    const blocked = item.blockedReason ? ` | blocked=${item.blockedReason}` : "";
    return `- [${item.status}] ${item.title}${notes}${blocked}`;
  });
}

function summarizeEvent(event: SessionEvent): string {
  switch (event.recordType) {
    case "turn":
      return `turn ${event.turnId} status=${event.status}`;
    case "plan_update":
      return `plan_update items=${event.planItems.length}`;
    case "approval":
      return `approval ${event.toolName} status=${event.status} decision=${event.decision}`;
    case "checkpoint":
      return `checkpoint ${event.checkpointId} files=${event.trackedFiles.length}`;
    case "worker_session_link":
      return `worker_session_link ${event.workerType} status=${event.status}`;
    case "supervisor_decision":
      return `supervisor_decision ${event.action} state=${event.resultingState}`;
    case "artifact_promotion":
      return `artifact_promotion files=${event.changedFiles.length}`;
    case "routing_decision":
      return `routing_decision ${event.automaticTarget} -> ${event.finalTarget}`;
    case "diagnostic_report":
      return `diagnostic_report trigger=${event.trigger} diagnostics=${event.diagnostics.length}`;
    case "telemetry_metric":
      return `telemetry_metric ${event.metricName}=${event.value}`;
    case "rollback":
      return `rollback ${event.mode} files=${event.restoredFiles.length}`;
    case "history_integrity":
      return `history_integrity ${event.scope} outcome=${event.outcome}`;
    case "context_summary":
      return `context_summary ${event.sourceToolName ?? event.sourceType}`;
    case "context_budget":
      return `context_budget ${event.scope} used=${event.snapshot.usedInputTokens}`;
    case "message":
      return `message ${event.role}`;
  }
  return "unknown_event";
}

function summarizeWorkerEvent(event: WorkerSessionEvent): string {
  switch (event.recordType) {
    case "worker_status":
      return `worker_status status=${event.status} dispatch=${event.dispatchKind} attempt=${event.attemptNumber}`;
    case "worker_message":
      return `worker_message role=${event.role}`;
    case "worker_artifact":
      return `worker_artifact ref=${event.artifactRef}`;
  }
  return "unknown_worker_event";
}

function renderMessage(message: MessageRecord, index: number): string {
  const lines: string[] = [
    `### ${index + 1}. ${message.role} · ${message.createdAt}`,
    `- messageId: \`${message.messageId}\``,
    `- turnId: \`${message.turnId}\``,
  ];
  if (message.name) {
    lines.push(`- name: \`${message.name}\``);
  }
  if (message.toolCallId) {
    lines.push(`- toolCallId: \`${message.toolCallId}\``);
  }
  if (message.toolCalls && message.toolCalls.length > 0) {
    lines.push("#### Tool Calls", jsonBlock(message.toolCalls));
  }
  if (message.metadata && Object.keys(message.metadata).length > 0) {
    lines.push("#### Metadata", jsonBlock(message.metadata));
  }
  lines.push("#### Content", textBlock(message.content));
  return lines.join("\n\n");
}

function renderEventLog(events: SessionEvent[]): string[] {
  const nonMessages = events.filter((event) => event.recordType !== "message");
  if (nonMessages.length === 0) {
    return ["- none"];
  }
  return nonMessages.map((event, index) =>
    [
      `### ${index + 1}. ${event.createdAt} · ${summarizeEvent(event)}`,
      jsonBlock(event),
    ].join("\n\n"),
  );
}

function exportSafeSessionEvent(event: SessionEvent): SessionEvent {
  if (event.recordType !== "message") {
    return event;
  }
  const safeMessage = { ...event };
  delete safeMessage.reasoningContent;
  return safeMessage;
}

async function renderWorkerArtifactDetails(
  source: SessionExportSource,
  artifactEvent: WorkerArtifactRecord,
): Promise<string[]> {
  const blocks: string[] = [
    `- artifactId: \`${artifactEvent.artifactId}\``,
    `- artifactRef: \`${artifactEvent.artifactRef}\``,
    "#### Summary",
    jsonBlock(artifactEvent.summary),
  ];

  const artifactPayload = await source.readArtifactRef(artifactEvent.artifactRef);
  if (artifactPayload) {
    blocks.push("#### Artifact Payload", jsonBlock(JSON.parse(artifactPayload)));
  }

  if (artifactEvent.summary.kind === "code_artifact") {
    const codeSummary = artifactEvent.summary as CodeArtifactSummary;
    const patchPayload = await source.readArtifactRef(codeSummary.patchRef);
    if (patchPayload) {
      blocks.push(`#### Patch (\`${codeSummary.patchRef}\`)`, patchBlock(patchPayload));
    }
  }

  return blocks;
}

async function renderWorkerSession(
  source: SessionExportSource,
  workerSessionId: string,
): Promise<string> {
  const workerSession = await source.loadWorkerSession(workerSessionId);
  const workerEvents = await source.loadWorkerEvents(workerSessionId);
  const lines: string[] = [`### Worker Session \`${workerSessionId}\``];

  if (!workerSession) {
    lines.push("- worker session metadata missing");
    return lines.join("\n\n");
  }

  lines.push(
    `- workerType: \`${workerSession.workerType}\``,
    `- status: \`${workerSession.status}\``,
    `- createdAt: ${workerSession.createdAt}`,
    `- updatedAt: ${workerSession.updatedAt}`,
    `- objective: ${workerSession.objective}`,
    "#### Worker Session Record",
    jsonBlock(workerSession),
  );

  const workerMessages = workerEvents.filter((event): event is Extract<WorkerSessionEvent, { recordType: "worker_message" }> => event.recordType === "worker_message");
  if (workerMessages.length > 0) {
    lines.push(
      "#### Worker Messages",
      ...workerMessages.map((message, index) =>
        [
          `##### ${index + 1}. ${message.role} · ${message.createdAt}`,
          message.metadata ? jsonBlock(message.metadata) : "",
          textBlock(message.content),
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
    );
  }

  const artifacts = workerEvents.filter((event): event is WorkerArtifactRecord => event.recordType === "worker_artifact");
  if (artifacts.length > 0) {
    lines.push("#### Worker Artifacts");
    for (const artifact of artifacts) {
      lines.push(`##### Artifact \`${artifact.artifactId}\``, ...(await renderWorkerArtifactDetails(source, artifact)));
    }
  }

  const statusEvents = workerEvents.filter((event) => event.recordType !== "worker_message" && event.recordType !== "worker_artifact");
  if (statusEvents.length > 0) {
    lines.push(
      "#### Worker Event Timeline",
      ...statusEvents.map((event, index) =>
        [
          `##### ${index + 1}. ${event.createdAt} · ${summarizeWorkerEvent(event)}`,
          jsonBlock(event),
        ].join("\n\n"),
      ),
    );
  }

  lines.push(
    "#### Worker Event JSON",
    jsonBlock(workerEvents),
  );
  return lines.join("\n\n");
}

function renderLatestSnapshotSection(session: SessionRecord): string[] {
  return [
    "### Latest Task Duration",
    session.latestTaskDuration ? jsonBlock(session.latestTaskDuration) : "- none",
    "### Latest Token Usage",
    session.latestTokenUsage ? jsonBlock(session.latestTokenUsage) : "- none",
    "### Cumulative Token Usage",
    session.cumulativeTokenUsage ? jsonBlock(session.cumulativeTokenUsage) : "- none",
    "### Latest Context Budget",
    session.latestContextBudget ? jsonBlock(session.latestContextBudget) : "- none",
    "### Latest Compaction",
    session.latestCompaction ? jsonBlock(session.latestCompaction) : "- none",
  ];
}

export async function buildSessionMarkdownExport(
  source: SessionExportSource,
  sessionId: string,
  options: BuildMarkdownOptions = {},
): Promise<string> {
  const session = await source.loadSession(sessionId);
  if (!session) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  const events = await source.loadEvents(sessionId);
  const messages = events.filter((event): event is MessageRecord => event.recordType === "message");
  const workerSessionIds = [
    ...new Set(
      events
        .filter((event): event is Extract<SessionEvent, { recordType: "worker_session_link" }> => event.recordType === "worker_session_link")
        .map((event) => event.workerSessionId),
    ),
  ];
  const generatedAt = options.generatedAt ?? now();
  const title = session.title || `Session ${session.sessionId}`;

  const sections: string[] = [
    `# Deep-Mix Session Export: ${title}`,
    [
      `- generatedAt: ${generatedAt}`,
      `- sessionId: \`${session.sessionId}\``,
      `- status: \`${session.status}\``,
      `- workspaceRoot: \`${session.workspaceRoot}\``,
      `- jsonlPath: \`${session.jsonlPath}\``,
      `- createdAt: ${session.createdAt}`,
      `- updatedAt: ${session.updatedAt}`,
      `- messageCount: ${session.messageCount}`,
      session.activeTurnId ? `- activeTurnId: \`${session.activeTurnId}\`` : undefined,
      session.lastTurnId ? `- lastTurnId: \`${session.lastTurnId}\`` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
    section("Plan Items", renderPlanItems(session)),
    section("Latest Snapshots", renderLatestSnapshotSection(session)),
    section("Transcript", messages.length > 0 ? messages.map(renderMessage) : ["- none"]),
    section("Event Timeline", renderEventLog(events)),
  ];

  if (workerSessionIds.length > 0) {
    const workerSections: string[] = [];
    for (const workerSessionId of workerSessionIds) {
      workerSections.push(await renderWorkerSession(source, workerSessionId));
    }
    sections.push(section("Worker Sessions", workerSections));
  } else {
    sections.push(section("Worker Sessions", ["- none"]));
  }

  const contextSummaryEvents = events.filter((event): event is ContextSummaryRecord => event.recordType === "context_summary");
  const contextBudgetEvents = events.filter((event): event is ContextBudgetRecord => event.recordType === "context_budget");
  const historyIntegrityEvents = events.filter((event): event is HistoryIntegrityRecord => event.recordType === "history_integrity");

  sections.push(
    section("Context Summary Records", contextSummaryEvents.length > 0 ? [jsonBlock(contextSummaryEvents)] : ["- none"]),
    section("Context Budget Records", contextBudgetEvents.length > 0 ? [jsonBlock(contextBudgetEvents)] : ["- none"]),
    section("History Integrity Records", historyIntegrityEvents.length > 0 ? [jsonBlock(historyIntegrityEvents)] : ["- none"]),
    section("Raw Session Record JSON", [jsonBlock(session)]),
    section("Raw Session Events JSON", [jsonBlock(events.map(exportSafeSessionEvent))]),
  );

  return sections.join("\n\n");
}

export function resolveDefaultSessionMarkdownExportPath(
  workspaceRoot: string,
  stateDir: string,
  session: SessionRecord,
): string {
  const stamp = now().replace(/[:.]/g, "-");
  const slug = createSlug(session.title);
  const fileName = `${slug || "session"}-${session.sessionId.slice(0, 8)}-${stamp}.md`;
  return path.join(stateDir, "exports", fileName);
}

export function resolveSessionExportPath(
  workspaceRoot: string,
  defaultPath: string,
  customPath?: string,
): string {
  if (!customPath || !customPath.trim()) {
    return defaultPath;
  }
  return path.isAbsolute(customPath) ? customPath : path.resolve(workspaceRoot, customPath);
}
