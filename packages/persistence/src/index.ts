import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  promises as fs,
} from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  buildSessionMarkdownExport,
  resolveDefaultSessionMarkdownExportPath,
  resolveSessionExportPath,
} from "./session-markdown-export.js";
import type {
  ApprovalRecord,
  ArtifactSummary,
  ArtifactPromotionRecord,
  CheckpointRecord,
  CheckpointSummary,
  CheckpointScope,
  CodeArtifact,
  CodeArtifactSummary,
  DiagnosticReportRecord,
  MessageRecord,
  ModelAssignmentSnapshot,
  PlanItem,
  PlanUpdateRecord,
  RuntimeCapabilitySnapshot,
  LifecycleWarning,
  RoutingDecisionRecord,
  SessionEvent,
  SessionRecord,
  SessionsIndex,
  SessionStatus,
  TelemetryMetricName,
  TelemetryMetricRecord,
  TurnRecord,
  VisionArtifact,
  WorkerArtifactRecord,
  WorkerCancellationRecord,
  WorkerDispatchKind,
  WorkerFailureType,
  WorkerMessageRecord,
  RollbackMode,
  RollbackRecord,
  SupervisorDecisionRecord,
  ToolSessionPersistence,
  ToolExecutionAuditRecord,
  ToolActivationRecord,
  ToolCall,
  ToolOutputArtifact,
  ToolOutputArtifactKind,
  ToolResult,
  ToolSelectionRecord,
  UserInputAnswer,
  UserInputRequestRecord,
  UserInputRequestState,
  UserInputResponseRecord,
  UserInputResumeRecord,
  WorkerSessionEvent,
  WorkerSessionLinkRecord,
  WorkerSessionRecord,
  WorkerSessionStatus,
  WorkerStatusRecord,
  WorkerTask,
  WorkerType,
} from "../../shared-schema/src/index.js";
import type { ApprovalGrant } from "../../safety/src/index.js";
import {
  deriveWorkspaceId,
  resolveDeepMixHome,
  resolveLegacyDesktopAttachmentReference,
  resolveLegacyWorkspaceStateDirectory,
  resolveWorkspaceStateDirectory,
  type DeepMixLocationOptions,
} from "../../state-location/src/index.js";
import { validateCodeArtifact } from "../../worker-glm-coding/src/index.js";

function freezeAssignment(snapshot: ModelAssignmentSnapshot | undefined): ModelAssignmentSnapshot | undefined {
  if (!snapshot) return undefined;
  return Object.freeze({
    ...snapshot,
    capabilities: Object.freeze({ ...snapshot.capabilities }),
  });
}

function normalizeLegacyRoutingRecord(event: SessionEvent): SessionEvent {
  if (event.recordType !== "routing_decision") return event;
  const record = event as unknown as Omit<RoutingDecisionRecord, "finalTarget" | "automaticTarget" | "overrideTarget"> & {
    finalTarget: string;
    automaticTarget: string;
    overrideTarget?: string;
  };
  const normalize = (value: string): "governor_direct" | "coding_worker" | "vision_worker" => {
    if (value === "ds_direct" || value === "governor_direct") return "governor_direct";
    if (value === "glm_coding" || value === "coding_worker") return "coding_worker";
    return "vision_worker";
  };
  const legacyTarget = record.finalTarget === "ds_direct" || record.finalTarget === "glm_coding" || record.finalTarget === "kimi_vision"
    ? record.finalTarget
    : undefined;
  return {
    ...record,
    automaticTarget: normalize(record.automaticTarget),
    finalTarget: normalize(record.finalTarget),
    overrideTarget: record.overrideTarget ? normalize(record.overrideTarget) : undefined,
    legacyTarget,
  } as RoutingDecisionRecord;
}

export function selectPendingApprovals(
  events: SessionEvent[],
  sessionStatus: SessionStatus,
): ApprovalRecord[] {
  if (sessionStatus !== "ask_permission") return [];
  const latestByRequest = new Map<string, ApprovalRecord>();
  for (const event of events) {
    if (event.recordType === "approval") latestByRequest.set(event.requestKey, event);
  }
  return [...latestByRequest.values()]
    .filter((approval) => approval.status === "pending")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
import { summarizeVisionArtifact, validateVisionArtifact } from "../../worker-kimi-vision/src/index.js";

export interface StatePaths {
  storageRoot: string;
  stateDir: string;
  exportsDir: string;
  sessionsIndexPath: string;
  sessionsDir: string;
  approvalRecordsDir: string;
  approvalStatePath: string;
  approvalRequestKeySecretPath: string;
  telemetryDir: string;
  telemetrySummaryPath: string;
  fileHistoryDir: string;
  checkpointsDir: string;
  promotionLogPath: string;
  rollbackRecordsDir: string;
  runtimeCapabilitiesPath: string;
  workerSessionsDir: string;
  workerArtifactsDir: string;
  artifactRecordsDir: string;
  artifactPatchesDir: string;
  artifactImagesDir: string;
  toolOutputsDir: string;
  toolOutputRecordsDir: string;
  userInputClaimsDir: string;
  protectedToolCallsDir: string;
  completedToolResultsDir: string;
  codeIndexDir: string;
  desktopAttachmentsDir: string;
  processSessionsDir: string;
  mcpArtifactsDir: string;
  worktreesDir: string;
}

export interface LifecycleCatalogScan<T> {
  items: T[];
  scanned: number;
  partial: boolean;
  warnings: LifecycleWarning[];
}

export interface ResolvedLifecycleArtifact {
  summary: ArtifactSummary;
  absolutePath: string;
  readBytes(signal?: AbortSignal): Promise<Buffer>;
  readRange(offset: number, maxBytes: number, signal?: AbortSignal): Promise<Buffer>;
}

export interface WorkerLifecycleEventScan {
  workerEvents: Array<WorkerStatusRecord | WorkerArtifactRecord | WorkerCancellationRecord>;
  parentEvents: Array<SupervisorDecisionRecord | ArtifactPromotionRecord>;
  linkedFromParentSession: boolean;
  scanned: number;
  partial: boolean;
  warnings: LifecycleWarning[];
}

export interface WorkerStatusTransitionResult {
  session: WorkerSessionRecord;
  previousStatus: WorkerSessionStatus;
  changed: boolean;
}

export interface WorkerCancellationTransitionResult extends WorkerStatusTransitionResult {
  record: WorkerCancellationRecord;
}

interface ApprovalStateFile {
  version: 1;
  sessions: Record<string, Record<string, ApprovalGrant>>;
}

export interface ToolExecutionJournalRecord {
  version: 1;
  sessionId: string;
  callId: string;
  toolName: string;
  status: "started" | "completed";
  createdAt: string;
  completedAt?: string;
  result?: ToolResult;
}

export type UserInputClaimSubmission =
  | {
      status: "answered";
      answers: UserInputAnswer[];
    }
  | {
      status: "cancelled";
      answers: [];
      cancelReason?: string;
    };

interface UserInputClaimFile {
  version: 1;
  sessionId: string;
  requestId: string;
  responseId: string;
  claimedAt: string;
  submission: UserInputClaimSubmission;
}

export interface UserInputClaimResult {
  request: UserInputRequestRecord;
  responseId: string;
  submission: UserInputClaimSubmission;
  recovered: boolean;
  leaseId: string;
}

const USER_INPUT_CLAIM_STALE_MS = 5_000;

function isUserInputClaimSubmission(value: unknown): value is UserInputClaimSubmission {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { status?: unknown; answers?: unknown; cancelReason?: unknown };
  if (!Array.isArray(candidate.answers)) return false;
  if (candidate.status === "answered") return true;
  return candidate.status === "cancelled" &&
    candidate.answers.length === 0 &&
    (candidate.cancelReason === undefined || typeof candidate.cancelReason === "string");
}

function isUserInputClaimFile(value: unknown, sessionId: string, requestId: string): value is UserInputClaimFile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<UserInputClaimFile>;
  return candidate.version === 1 &&
    candidate.sessionId === sessionId &&
    candidate.requestId === requestId &&
    typeof candidate.responseId === "string" &&
    /^[A-Za-z0-9_-]+$/.test(candidate.responseId) &&
    typeof candidate.claimedAt === "string" &&
    Number.isFinite(Date.parse(candidate.claimedAt)) &&
    isUserInputClaimSubmission(candidate.submission);
}

interface CheckpointManifest {
  version?: 2;
  checkpointId: string;
  trackedFiles: Array<{
    path: string;
    existed: boolean;
    /** Absent on phase 6-14 manifests, where every existing entry was a file. */
    kind?: "file" | "directory";
    /** New manifests keep snapshots below a dedicated root to avoid manifest-name collisions. */
    snapshotPath?: string;
    entryCount?: number;
    totalBytes?: number;
  }>;
  sessionEventCount: number;
  sessionSnapshot: SessionRecord;
}

export interface CheckpointFileFingerprint {
  exists: boolean;
  device?: number | bigint;
  inode?: number | bigint;
  sizeBytes?: number;
  mode?: number;
  sha256?: string;
}

interface TelemetrySummary {
  version: 1;
  counters: {
    routingDecisionCount: number;
    routeTargets: Record<"governor_direct" | "coding_worker" | "vision_worker", number>;
    workerRoutedCount: number;
    workerDecisionCount: number;
    workerAcceptedCount: number;
    workerAcceptanceRate: number;
    revisionCount: number;
    fallbackCount: number;
    fallbackRate: number;
    diagnosticFailureCount: number;
    governorDirectSuccessCount: number;
    /** Legacy compatibility mirror; new code writes governorDirectSuccessCount. */
    directDsSuccessCount: number;
    modelInvocations: Record<string, {
      slot: ModelAssignmentSnapshot["slot"];
      adapterId: string;
      provider: string;
      model: string;
      fallbackIndex: number;
      result: "success" | "failure";
      count: number;
      totalLatencyMs: number;
      inputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
    }>;
  };
}

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

const MAX_CHECKPOINT_TREE_ENTRIES = 10_000;
const MAX_CHECKPOINT_TREE_BYTES = 512 * 1024 * 1024;

interface CheckpointTreeBudget {
  entries: number;
  bytes: number;
}

function checkpointPathKey(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function normalizeCheckpointPath(workspaceRoot: string, requestedPath: string): string {
  const absolutePath = path.resolve(workspaceRoot, requestedPath);
  assertPathInside(workspaceRoot, absolutePath, "Checkpoint path");
  const relativePath = toRelative(workspaceRoot, absolutePath);
  if (!relativePath || relativePath === ".") {
    throw new Error("Checkpoint paths must identify a workspace entry, not the workspace root.");
  }
  if (process.platform === "win32") {
    for (const segment of relativePath.split("/")) {
      const stem = segment.split(".")[0] ?? "";
      if (
        segment.includes(":") ||
        /[. ]$/u.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem)
      ) {
        throw new Error("Checkpoint path contains an ambiguous Windows component.");
      }
    }
  }
  return relativePath;
}

function minimizeCheckpointPaths(workspaceRoot: string, requestedPaths: readonly string[]): string[] {
  const normalized = [...new Set(requestedPaths.map((entry) => normalizeCheckpointPath(workspaceRoot, entry)))]
    .sort((left, right) => {
      const depth = left.split("/").length - right.split("/").length;
      return depth !== 0 ? depth : left.localeCompare(right);
    });
  const selected: string[] = [];
  for (const candidate of normalized) {
    const candidateKey = checkpointPathKey(candidate);
    if (selected.some((ancestor) => candidateKey.startsWith(`${checkpointPathKey(ancestor)}/`))) {
      continue;
    }
    if (!selected.some((entry) => checkpointPathKey(entry) === candidateKey)) selected.push(candidate);
  }
  return selected;
}

async function assertNoSymlinkComponents(root: string, targetPath: string, label: string): Promise<void> {
  assertPathInside(root, targetPath, label);
  const resolvedRoot = path.resolve(root);
  const rootStat = await fs.lstat(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`${label} trusted root is not a real directory.`);
  }
  const relativePath = path.relative(path.resolve(root), path.resolve(targetPath));
  let currentPath = resolvedRoot;
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    try {
      const stat = await fs.lstat(currentPath);
      if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic link or junction.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function ensureRealDirectory(
  trustedRoot: string,
  directory: string,
  label: string,
  mode?: number,
): Promise<void> {
  assertPathInside(trustedRoot, directory, label);
  await assertNoSymlinkComponents(trustedRoot, directory, label);
  await fs.mkdir(directory, { recursive: true, ...(mode === undefined ? {} : { mode }) });
  await assertNoSymlinkComponents(trustedRoot, directory, label);
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} is not a trusted real directory.`);
  const [realRoot, realDirectory] = await Promise.all([
    fs.realpath(trustedRoot),
    fs.realpath(directory),
  ]);
  assertPathInside(realRoot, realDirectory, label);
}

async function assertExistingRealDirectory(
  trustedRoot: string,
  directory: string,
  label: string,
): Promise<boolean> {
  assertPathInside(trustedRoot, directory, label);
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} is not a trusted real directory.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await assertNoSymlinkComponents(trustedRoot, directory, label);
  const [realRoot, realDirectory] = await Promise.all([fs.realpath(trustedRoot), fs.realpath(directory)]);
  assertPathInside(realRoot, realDirectory, label);
  return true;
}

async function removePathWithoutFollowing(targetPath: string): Promise<void> {
  try {
    const stat = await fs.lstat(targetPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      await fs.unlink(targetPath);
    } else {
      await fs.rm(targetPath, { recursive: true, force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function consumeCheckpointBudget(
  budget: CheckpointTreeBudget,
  sizeBytes: number,
  label: string,
): void {
  budget.entries += 1;
  budget.bytes += sizeBytes;
  if (budget.entries > MAX_CHECKPOINT_TREE_ENTRIES) {
    throw new Error(`${label} exceeds the checkpoint entry limit (${MAX_CHECKPOINT_TREE_ENTRIES}).`);
  }
  if (budget.bytes > MAX_CHECKPOINT_TREE_BYTES) {
    throw new Error(`${label} exceeds the checkpoint byte limit (${MAX_CHECKPOINT_TREE_BYTES}).`);
  }
}

async function inspectCheckpointTree(
  sourcePath: string,
  budget: CheckpointTreeBudget,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const stat = await fs.lstat(sourcePath);
  if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic link or junction.`);
  if (stat.isFile()) {
    consumeCheckpointBudget(budget, stat.size, label);
    return;
  }
  if (!stat.isDirectory()) throw new Error(`${label} contains an unsupported filesystem entry.`);
  consumeCheckpointBudget(budget, 0, label);
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    signal?.throwIfAborted();
    await inspectCheckpointTree(path.join(sourcePath, entry.name), budget, label, signal);
  }
}

async function copyCheckpointTree(
  sourcePath: string,
  targetPath: string,
  budget: CheckpointTreeBudget,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const stat = await fs.lstat(sourcePath);
  if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic link or junction.`);
  if (stat.isFile()) {
    consumeCheckpointBudget(budget, stat.size, label);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await pipeline(
      createReadStream(sourcePath),
      createWriteStream(targetPath, { flags: "wx", mode: stat.mode }),
      { signal },
    );
    return;
  }
  if (!stat.isDirectory()) throw new Error(`${label} contains an unsupported filesystem entry.`);
  consumeCheckpointBudget(budget, 0, label);
  await fs.mkdir(targetPath, { recursive: true });
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    signal?.throwIfAborted();
    await copyCheckpointTree(
      path.join(sourcePath, entry.name),
      path.join(targetPath, entry.name),
      budget,
      label,
      signal,
    );
  }
}

async function fingerprintRegularFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<CheckpointFileFingerprint> {
  signal?.throwIfAborted();
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Checkpoint fingerprint source is not a regular file.");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || position !== after.size
    ) {
      throw new Error("Checkpoint fingerprint source changed while it was being read.");
    }
    return {
      exists: true,
      device: after.dev,
      inode: after.ino,
      sizeBytes: after.size,
      mode: after.mode,
      sha256: hash.digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

function runGit(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`git ${args.join(" ")} failed with exit code ${code ?? -1}`));
    });
  });
}

function createTelemetrySummary(): TelemetrySummary {
  return {
    version: 1,
    counters: {
      routingDecisionCount: 0,
      routeTargets: {
        governor_direct: 0,
        coding_worker: 0,
        vision_worker: 0,
      },
      workerRoutedCount: 0,
      workerDecisionCount: 0,
      workerAcceptedCount: 0,
      workerAcceptanceRate: 0,
      revisionCount: 0,
      fallbackCount: 0,
      fallbackRate: 0,
      diagnosticFailureCount: 0,
      governorDirectSuccessCount: 0,
      directDsSuccessCount: 0,
      modelInvocations: {},
    },
  };
}

function safeTelemetryDimension(value: string): string {
  const queryIndex = value.indexOf("?");
  const fragmentIndex = value.indexOf("#");
  const cutoff = [queryIndex, fragmentIndex].filter((index) => index >= 0).reduce(
    (lowest, index) => Math.min(lowest, index),
    value.length,
  );
  return value.slice(0, cutoff)
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED_KEY]")
    .slice(0, 160);
}

function toRelative(workspaceRoot: string, targetPath: string): string {
  return path.relative(workspaceRoot, targetPath).replace(/\\/g, "/");
}

function assertPathInside(root: string, targetPath: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(targetPath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its trusted root.`);
  }
}

export function sanitizeToolOutputFilename(input: string): string {
  const base = path.basename(input.replace(/\\/g, "/"));
  let sanitized = base
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!sanitized) sanitized = "tool-output.bin";
  const stem = path.parse(sanitized).name;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) sanitized = `_${sanitized}`;
  if (sanitized.length > 120) {
    const parsed = path.parse(sanitized);
    const maxStem = Math.max(1, 120 - parsed.ext.length);
    sanitized = `${parsed.name.slice(0, maxStem)}${parsed.ext}`;
  }
  return sanitized;
}

function protectedToolCallFileName(toolCallId: string): string {
  return `${createHash("sha256").update(toolCallId).digest("hex")}.json`;
}

async function resolveStableOutputPath(directory: string, requestedName: string): Promise<string> {
  const sanitized = sanitizeToolOutputFilename(requestedName);
  const parsed = path.parse(sanitized);
  let candidate = path.join(directory, sanitized);
  for (let index = 2; await exists(candidate); index += 1) {
    candidate = path.join(directory, `${parsed.name}-${index}${parsed.ext}`);
  }
  return candidate;
}

async function publishStagedOutput(input: {
  directory: string;
  requestedName: string;
  stagedPath: string;
  trustedRoot: string;
}): Promise<{ absolutePath: string; device: number | bigint; inode: number | bigint }> {
  const staged = await fingerprintRegularFile(input.stagedPath);
  if (!staged.exists || staged.device === undefined || staged.inode === undefined) {
    throw new Error("Tool output staging file is not a trusted regular file.");
  }
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const candidate = await resolveStableOutputPath(input.directory, input.requestedName);
    assertPathInside(input.trustedRoot, candidate, "Tool output path");
    try {
      // link() is an atomic, non-overwriting commit point on POSIX and Windows.
      // Cancellation wins before this point; a complete published artifact wins after it.
      await fs.link(input.stagedPath, candidate);
      try {
        const published = await fs.lstat(candidate);
        if (
          published.isSymbolicLink() || !published.isFile() ||
          published.dev !== staged.device || published.ino !== staged.inode
        ) {
          throw new Error("Tool output publication identity changed at commit.");
        }
        return { absolutePath: candidate, device: published.dev, inode: published.ino };
      } catch (error) {
        const current = await fs.lstat(candidate).catch(() => undefined);
        if (current && current.dev === staged.device && current.ino === staged.inode) {
          await fs.rm(candidate, { force: true });
        }
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("Could not allocate a unique tool output path.");
}

async function removeFileIfIdentity(
  filePath: string,
  identity: { device: number | bigint; inode: number | bigint } | undefined,
): Promise<boolean> {
  if (!identity) return false;
  const current = await fs.lstat(filePath).catch(() => undefined);
  if (!current) return true;
  if (current.dev !== identity.device || current.ino !== identity.inode) return false;
  await fs.rm(filePath, { force: true });
  return true;
}

function ensureArtifactPatchRef(ref: string): string {
  if (!/^artifact:\/\/patches\/.+\.patch$/.test(ref)) {
    throw new Error(`Invalid artifact patch ref: ${ref}`);
  }
  return ref;
}

function toCodeArtifactSummary(artifact: CodeArtifact): CodeArtifactSummary {
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

export interface CreateStatePathOptions extends DeepMixLocationOptions {
  stateDir?: string;
}

export function createStatePaths(
  workspaceRoot: string,
  options: CreateStatePathOptions = {},
): StatePaths {
  const stateDir = options.stateDir
    ? path.resolve(options.stateDir)
    : resolveWorkspaceStateDirectory(workspaceRoot, options);
  const storageRoot = options.stateDir ? path.dirname(stateDir) : resolveDeepMixHome(options);
  const telemetryDir = path.join(stateDir, "telemetry");
  const workerArtifactsDir = path.join(stateDir, "worker-artifacts");
  const toolOutputsDir = path.join(stateDir, "tool-outputs");
  return {
    storageRoot,
    stateDir,
    exportsDir: path.join(stateDir, "exports"),
    sessionsIndexPath: path.join(stateDir, "sessions-index.json"),
    sessionsDir: path.join(stateDir, "sessions"),
    approvalRecordsDir: path.join(stateDir, "approval-records"),
    approvalStatePath: path.join(stateDir, "approval-state.json"),
    approvalRequestKeySecretPath: path.join(stateDir, "approval-request-key.bin"),
    telemetryDir,
    telemetrySummaryPath: path.join(telemetryDir, "metrics.json"),
    fileHistoryDir: path.join(stateDir, "file-history"),
    checkpointsDir: path.join(stateDir, "checkpoints"),
    promotionLogPath: path.join(stateDir, "promotion-log.jsonl"),
    rollbackRecordsDir: path.join(stateDir, "rollback-records"),
    runtimeCapabilitiesPath: path.join(stateDir, "runtime-capabilities.json"),
    workerSessionsDir: path.join(stateDir, "worker-sessions"),
    workerArtifactsDir,
    artifactRecordsDir: path.join(workerArtifactsDir, "records"),
    artifactPatchesDir: path.join(workerArtifactsDir, "patches"),
    artifactImagesDir: path.join(workerArtifactsDir, "images"),
    toolOutputsDir,
    toolOutputRecordsDir: path.join(toolOutputsDir, "records"),
    userInputClaimsDir: path.join(stateDir, "user-input-claims"),
    protectedToolCallsDir: path.join(stateDir, "protected-tool-calls"),
    completedToolResultsDir: path.join(stateDir, "completed-tool-results"),
    codeIndexDir: path.join(stateDir, "code-index"),
    desktopAttachmentsDir: path.join(stateDir, "desktop-attachments"),
    processSessionsDir: path.join(stateDir, "process-sessions"),
    mcpArtifactsDir: path.join(stateDir, "mcp-artifacts"),
    worktreesDir: path.join(stateDir, "worktrees"),
  };
}

const LIFECYCLE_JSONL_MAX_BYTES = 16 * 1024 * 1024;
const LIFECYCLE_JSONL_MAX_RECORDS = 20_000;
const LIFECYCLE_DIRECTORY_MAX_BYTES = 32 * 1024 * 1024;
const LIFECYCLE_METADATA_MAX_BYTES = 1024 * 1024;
const LIFECYCLE_ARTIFACT_READ_MAX_BYTES = 256 * 1024 * 1024;
const LIFECYCLE_ARTIFACT_RANGE_MAX_BYTES = 2_000_000;
const LIFECYCLE_WARNING_LIMIT = 100;

interface TolerantJsonlScan {
  records: unknown[];
  scanned: number;
  bytesRead: number;
  partial: boolean;
  warnings: LifecycleWarning[];
}

function isProtectedLifecyclePath(value: string): boolean {
  const normalized = value.replace(/\\/gu, "/").replace(/^\.\//u, "").toLowerCase();
  return normalized === ".deep-mix/api-key-library" || normalized.startsWith(".deep-mix/api-key-library/");
}

function redactLifecycleText(value: string, workspaceRoot: string): string {
  const escapeRegExp = (entry: string) => entry.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  let redacted = value;
  if (process.platform === "win32") {
    const normalized = workspaceRoot.replace(/^\\\\\?\\/u, "").replace(/[\\/]+/gu, "/");
    const mixedSeparatorPattern = normalized.split("/").map(escapeRegExp).join("[\\\\/]+");
    redacted = redacted.replace(
      new RegExp(`${String.raw`(?:\\\\\?\\)?`}${mixedSeparatorPattern}`, "giu"),
      "<workspace>",
    );
  } else {
    redacted = redacted.replace(new RegExp(escapeRegExp(workspaceRoot), "gu"), "<workspace>");
  }
  return redacted
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{4,}/giu, "$1 [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED_JWT]")
    .replace(
      /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{10,}|npm_[A-Za-z0-9]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/gu,
      "[REDACTED_TOKEN]",
    )
    .replace(
      /((?:["']?(?:api[-_]?key|authorization|cookie|credential|password|secret|session[-_]?id|token)["']?)\s*:\s*)["'][^"'\r\n]*["']/giu,
      "$1\"[REDACTED]\"",
    )
    .replace(
      /((?:api[-_]?key|authorization|cookie|credential|password|secret|session[-_]?id|token)\s*[:=]\s*)[^\s,;]+/giu,
      "$1[REDACTED]",
    )
    .slice(0, 4_000);
}

function boundedLifecycleWarnings(warnings: LifecycleWarning[]): LifecycleWarning[] {
  if (warnings.length <= LIFECYCLE_WARNING_LIMIT) return warnings;
  return [
    ...warnings.slice(0, LIFECYCLE_WARNING_LIMIT - 1),
    {
      code: "scan_limit_reached",
      message: `${warnings.length - (LIFECYCLE_WARNING_LIMIT - 1)} additional lifecycle warning(s) were omitted.`,
    },
  ];
}

function isLifecycleObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLifecycleStringArray(value: unknown, maxEntries = 10_000): value is string[] {
  return Array.isArray(value) && value.length <= maxEntries && value.every((entry) => typeof entry === "string");
}

function isOptionalLifecycleString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isFiniteLifecycleNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidVisionArtifactMetadata(value: unknown): boolean {
  if (!isLifecycleObject(value) || !isLifecycleObject(value.preprocessing)) return false;
  return (
    ["local_path", "uploaded_file", "browser_capture"].includes(String(value.sourceType)) &&
    ["base64_data_url", "file_id"].includes(String(value.inputMode)) &&
    typeof value.inputImageRef === "string" &&
    typeof value.originalImageRef === "string" &&
    typeof value.processedImageRef === "string" &&
    typeof value.mimeType === "string" &&
    isFiniteLifecycleNumber(value.originalBytes) && value.originalBytes >= 0 &&
    isFiniteLifecycleNumber(value.processedBytes) && value.processedBytes >= 0 &&
    isFiniteLifecycleNumber(value.originalWidth) && value.originalWidth >= 0 &&
    isFiniteLifecycleNumber(value.originalHeight) && value.originalHeight >= 0 &&
    isFiniteLifecycleNumber(value.processedWidth) && value.processedWidth >= 0 &&
    isFiniteLifecycleNumber(value.processedHeight) && value.processedHeight >= 0 &&
    typeof value.preprocessing.resized === "boolean" &&
    typeof value.preprocessing.cropped === "boolean" &&
    typeof value.preprocessing.recompressed === "boolean"
  );
}

function isValidWorkerArtifactSummary(value: unknown): boolean {
  if (
    !isLifecycleObject(value) ||
    typeof value.summary !== "string" ||
    !isFiniteLifecycleNumber(value.confidence)
  ) return false;
  if (value.kind === "code_artifact") {
    return (
      typeof value.patchRef === "string" &&
      isLifecycleStringArray(value.changedFiles) &&
      isLifecycleStringArray(value.testCommands) &&
      isLifecycleStringArray(value.risks) &&
      (value.notes === undefined || isLifecycleStringArray(value.notes))
    );
  }
  if (value.kind === "vision_artifact") {
    return (
      ["ocr_extract", "ui_parse", "error_screenshot", "diagram_parse"].includes(String(value.taskType)) &&
      isLifecycleStringArray(value.issues) &&
      isValidVisionArtifactMetadata(value.metadata)
    );
  }
  return false;
}

function isValidSupervisorDecisionEvent(value: Record<string, unknown>): boolean {
  return (
    isSafeLifecycleId(typeof value.decisionId === "string" ? value.decisionId : "") &&
    ["accept", "revise", "retryWithMoreContext", "fallbackToGovernor", "continueVerification", "abort"].includes(
      String(value.action),
    ) &&
    typeof value.reason === "string" &&
    isLifecycleStringArray(value.evidenceRefs) &&
    [
      "artifact_ready",
      "verifying",
      "revising",
      "retrying",
      "accepted",
      "applying_patch",
      "governor_fallback",
      "aborted",
    ].includes(String(value.resultingState)) &&
    isOptionalLifecycleString(value.artifactRef) &&
    (value.verificationCommands === undefined || isLifecycleStringArray(value.verificationCommands))
  );
}

function isValidArtifactPromotionEvent(value: Record<string, unknown>): boolean {
  return (
    isSafeLifecycleId(typeof value.promotionId === "string" ? value.promotionId : "") &&
    typeof value.artifactRef === "string" &&
    isLifecycleStringArray(value.promotedFields) &&
    isLifecycleStringArray(value.changedFiles) &&
    isLifecycleStringArray(value.riskSummary) &&
    isLifecycleStringArray(value.verificationSummary)
  );
}

async function readJsonlTailTolerant(
  trustedRoot: string,
  filePath: string,
  maxBytes = LIFECYCLE_JSONL_MAX_BYTES,
  maxRecords = LIFECYCLE_JSONL_MAX_RECORDS,
): Promise<TolerantJsonlScan> {
  try {
    await assertNoSymlinkComponents(trustedRoot, filePath, "Lifecycle event storage");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [], scanned: 0, bytesRead: 0, partial: false, warnings: [] };
    }
    return {
      records: [],
      scanned: 0,
      bytesRead: 0,
      partial: true,
      warnings: [{ code: "corrupt_record", message: "Lifecycle event storage path is unsafe or invalid." }],
    };
  }
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [], scanned: 0, bytesRead: 0, partial: false, warnings: [] };
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return {
      records: [],
      scanned: 0,
      bytesRead: 0,
      partial: true,
      warnings: [{ code: "corrupt_record", message: "Lifecycle event storage is not a regular file." }],
    };
  }

  const bytesToRead = Math.min(stat.size, Math.max(0, Math.min(maxBytes, LIFECYCLE_JSONL_MAX_BYTES)));
  if (bytesToRead === 0) {
    return {
      records: [],
      scanned: 0,
      bytesRead: 0,
      partial: stat.size > 0,
      warnings: stat.size > 0 ? [{ code: "scan_limit_reached", message: "Lifecycle event scan budget was exhausted." }] : [],
    };
  }
  const start = Math.max(0, stat.size - bytesToRead);
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let bytesRead = 0;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
      throw new Error("Lifecycle event storage changed before it could be read safely.");
    }
    bytesRead = (await handle.read(buffer, 0, bytesToRead, start)).bytesRead;
    const after = await handle.stat();
    const pathAfter = await fs.lstat(filePath);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      pathAfter.isSymbolicLink() ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino ||
      pathAfter.size !== opened.size
    ) {
      throw new Error("Lifecycle event storage changed while it was being read.");
    }
  } finally {
    await handle.close();
  }

  let text = buffer.subarray(0, bytesRead).toString("utf8");
  const warnings: LifecycleWarning[] = [];
  let partial = start > 0;
  if (start > 0) {
    const firstNewline = text.indexOf("\n");
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    warnings.push({
      code: "scan_limit_reached",
      message: `Only the newest ${bytesToRead} bytes of lifecycle events were scanned.`,
    });
  }

  let lines = text.split(/\r?\n/u).filter(Boolean);
  const recordLimit = Math.max(0, Math.min(maxRecords, LIFECYCLE_JSONL_MAX_RECORDS));
  if (recordLimit === 0 && lines.length > 0) {
    lines = [];
    partial = true;
    warnings.push({ code: "scan_limit_reached", message: "Lifecycle record scan budget was exhausted." });
  }
  if (lines.length > recordLimit) {
    lines = lines.slice(-recordLimit);
    partial = true;
    warnings.push({
      code: "scan_limit_reached",
      message: `Only the newest ${recordLimit} lifecycle records were scanned.`,
    });
  }

  const records: unknown[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      records.push(JSON.parse(lines[index]!) as unknown);
    } catch {
      partial = true;
      warnings.push({
        code: "corrupt_record",
        message: "A malformed lifecycle JSONL record was skipped.",
        recordId: `tail-line-${index + 1}`,
      });
    }
  }
  return {
    records,
    scanned: lines.length,
    bytesRead,
    partial,
    warnings: boundedLifecycleWarnings(warnings),
  };
}

const LIFECYCLE_DIRECTORY_MAX_RECORDS = 20_000;

interface JsonDirectoryEntry {
  fileName: string;
  value: unknown;
}

async function readJsonDirectoryTolerant(
  trustedRoot: string,
  directory: string,
  label: string,
): Promise<{ entries: JsonDirectoryEntry[]; scanned: number; partial: boolean; warnings: LifecycleWarning[] }> {
  try {
    await assertNoSymlinkComponents(trustedRoot, directory, label);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [], scanned: 0, partial: false, warnings: [] };
    }
    throw error;
  }
  let directoryEntries;
  try {
    directoryEntries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [], scanned: 0, partial: false, warnings: [] };
    }
    throw error;
  }
  const entries: JsonDirectoryEntry[] = [];
  const warnings: LifecycleWarning[] = [];
  let scanned = 0;
  let totalBytes = 0;
  let partial = false;
  for (const entry of directoryEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (scanned >= LIFECYCLE_DIRECTORY_MAX_RECORDS) {
        partial = true;
        warnings.push({
          code: "scan_limit_reached",
          message: `Only ${LIFECYCLE_DIRECTORY_MAX_RECORDS} ${label} records were scanned.`,
        });
        break;
      }
      if (!entry.name.endsWith(".json")) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        partial = true;
        warnings.push({
          code: "corrupt_record",
          message: `A non-regular ${label} metadata entry was hidden.`,
          recordId: entry.name.slice(0, 160),
        });
        continue;
      }
      scanned += 1;
      const filePath = path.join(directory, entry.name);
      try {
        await assertNoSymlinkComponents(trustedRoot, filePath, label);
        const pathBefore = await fs.lstat(filePath);
        if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size > LIFECYCLE_METADATA_MAX_BYTES) {
          throw new Error(`${label} metadata record exceeds its bounded size or is not a regular file.`);
        }
        const file = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        try {
          const before = await file.stat();
          if (
            !before.isFile() ||
            before.size > LIFECYCLE_METADATA_MAX_BYTES ||
            before.dev !== pathBefore.dev ||
            before.ino !== pathBefore.ino ||
            before.size !== pathBefore.size
          ) {
            throw new Error(`${label} metadata record exceeds its bounded size or is not a regular file.`);
          }
          if (totalBytes + before.size > LIFECYCLE_DIRECTORY_MAX_BYTES) {
            partial = true;
            warnings.push({
              code: "scan_limit_reached",
              message: `${label} metadata scan stopped at ${LIFECYCLE_DIRECTORY_MAX_BYTES} bytes.`,
            });
            break;
          }
          totalBytes += before.size;
          const content = await file.readFile("utf8");
          const after = await file.stat();
          const pathAfter = await fs.lstat(filePath);
          if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs ||
            pathAfter.isSymbolicLink() ||
            pathAfter.dev !== before.dev ||
            pathAfter.ino !== before.ino ||
            pathAfter.size !== before.size
          ) {
            throw new Error(`${label} metadata changed while it was being read.`);
          }
          const value = JSON.parse(content) as unknown;
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error(`${label} metadata must be a JSON object.`);
          }
          entries.push({ fileName: entry.name, value });
        } finally {
          await file.close();
        }
      } catch {
        partial = true;
        warnings.push({
          code: "corrupt_record",
          message: `A malformed ${label} metadata record was skipped.`,
          recordId: entry.name.slice(0, 160),
        });
      }
  }
  return { entries, scanned, partial, warnings: boundedLifecycleWarnings(warnings) };
}

function isSafeLifecycleId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
}

function canonicalArtifactUriSegments(uri: string, expectedPrefix?: string): string[] {
  if (
    !uri.startsWith("artifact://") ||
    uri.length > 4_096 ||
    uri.includes("\\") ||
    uri.includes("?") ||
    uri.includes("#") ||
    /%2f|%5c/iu.test(uri)
  ) {
    throw Object.assign(new Error("Artifact URI is not canonical."), { code: "ERR_TOOL_INVALID_ARGUMENTS" });
  }
  const relative = uri.slice("artifact://".length);
  const segments = relative.split("/");
  if (
    segments.length < 2 ||
    segments.some((segment) =>
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.length > 255 ||
      segment.includes(":") ||
      /[. ]$/u.test(segment)
    ) ||
    (expectedPrefix && segments[0] !== expectedPrefix)
  ) {
    throw Object.assign(new Error("Artifact URI namespace or path segments are invalid."), {
      code: "ERR_TOOL_INVALID_ARGUMENTS",
    });
  }
  return segments;
}

async function readBoundedVerifiedFile(
  trustedRoot: string,
  absolutePath: string,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  await assertNoSymlinkComponents(trustedRoot, absolutePath, label);
  const pathBefore = await fs.lstat(absolutePath);
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size > maxBytes) {
    throw new Error(`${label} is not a bounded regular file.`);
  }
  const [realRoot, realTarget] = await Promise.all([fs.realpath(trustedRoot), fs.realpath(absolutePath)]);
  assertPathInside(realRoot, realTarget, label);
  const handle = await fs.open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size > maxBytes ||
      before.dev !== pathBefore.dev ||
      before.ino !== pathBefore.ino ||
      before.size !== pathBefore.size
    ) {
      throw new Error(`${label} identity changed before it could be read.`);
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await fs.lstat(absolutePath);
    const realTargetAfter = await fs.realpath(absolutePath);
    assertPathInside(realRoot, realTargetAfter, label);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      pathAfter.isSymbolicLink() ||
      pathAfter.dev !== before.dev ||
      pathAfter.ino !== before.ino ||
      pathAfter.size !== before.size ||
      realTargetAfter !== realTarget ||
      content.byteLength !== before.size
    ) {
      throw new Error(`${label} changed while it was being read.`);
    }
    return content;
  } finally {
    await handle.close();
  }
}

function isStructuredMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase().split(";", 1)[0]!.trim();
  return normalized === "application/json" || normalized.endsWith("+json") || normalized === "application/x-ndjson";
}

function isTextMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase().split(";", 1)[0]!.trim();
  return normalized.startsWith("text/") ||
    isStructuredMimeType(normalized) ||
    normalized === "application/xml" ||
    normalized.endsWith("+xml") ||
    normalized === "application/javascript" ||
    normalized === "application/sql" ||
    normalized === "application/yaml" ||
    normalized === "application/x-yaml";
}

function inferArtifactReadMode(mimeType: string, kind?: ToolOutputArtifactKind): ArtifactSummary["readMode"] {
  if (kind === "binary" || kind === "image") return "binary_metadata";
  if (isStructuredMimeType(mimeType)) return "structured";
  return isTextMimeType(mimeType) ? "text" : "binary_metadata";
}

function inferMimeTypeFromName(fileName: string): string {
  switch (path.extname(fileName).toLowerCase()) {
    case ".json": return "application/json";
    case ".patch":
    case ".diff": return "text/x-diff";
    case ".txt":
    case ".log":
    case ".md": return "text/plain";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}

function safeLifecycleName(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return path.basename(value).slice(0, 255);
}

async function readApprovalState(filePath: string): Promise<ApprovalStateFile> {
  if (!(await exists(filePath))) {
    return {
      version: 1,
      sessions: {},
    };
  }
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content) as ApprovalStateFile;
}

async function writeApprovalState(filePath: string, state: ApprovalStateFile): Promise<void> {
  await writeJsonAtomic(filePath, state, 0o600);
}

const jsonWriteLocks = new Map<string, Promise<void>>();
const approvalStateLocks = new Map<string, Promise<void>>();

async function acquireApprovalStateFileLock(filePath: string): Promise<() => Promise<void>> {
  const lockPath = `${filePath}.lock`;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await fs.mkdir(lockPath);
      return async () => fs.rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.stat(lockPath).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > 30_000) {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Timed out acquiring the approval-state transaction lock.");
}

async function withApprovalStateLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = approvalStateLocks.get(filePath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const release = await acquireApprovalStateFileLock(filePath);
    try {
      return await operation();
    } finally {
      await release();
    }
  });
  const settled = current.then(() => undefined, () => undefined);
  approvalStateLocks.set(filePath, settled);
  try {
    return await current;
  } finally {
    if (approvalStateLocks.get(filePath) === settled) approvalStateLocks.delete(filePath);
  }
}

async function replaceFileWithRetry(tempPath: string, filePath: string): Promise<void> {
  const retryable = new Set(["EPERM", "EACCES", "EBUSY", "EEXIST"]);
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rename(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!retryable.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      try {
        await fs.rm(filePath, { force: true });
      } catch (removeError) {
        if (!retryable.has((removeError as NodeJS.ErrnoException).code ?? "")) throw removeError;
      }
      await new Promise((resolve) => setTimeout(resolve, 12 * (attempt + 1) ** 2));
    }
  }
  throw lastError;
}

async function writeJsonAtomic(filePath: string, value: unknown, mode?: number): Promise<void> {
  const previous = jsonWriteLocks.get(filePath) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(async () => {
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(value, null, 2), {
        encoding: "utf8",
        ...(mode === undefined ? {} : { mode }),
      });
      await replaceFileWithRetry(tempPath, filePath);
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  });
  jsonWriteLocks.set(filePath, write);
  try {
    await write;
  } finally {
    if (jsonWriteLocks.get(filePath) === write) jsonWriteLocks.delete(filePath);
  }
}

async function writeJsonExclusiveAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(tempPath, "wx");
    try {
      await handle.writeFile(JSON.stringify(value), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.link(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

const LEGACY_RUNTIME_STATE_ENTRIES = new Set([
  "approval-records",
  "approval-request-key.bin",
  "approval-state.json",
  "checkpoints",
  "code-index",
  "completed-tool-results",
  "desktop-attachments",
  "exports",
  "file-history",
  "mcp-artifacts",
  "permission-policy.json",
  "process-sessions",
  "promotion-log.jsonl",
  "protected-tool-calls",
  "rollback-records",
  "runtime-capabilities.json",
  "sessions",
  "sessions-index.json",
  "telemetry",
  "tool-outputs",
  "user-input-claims",
  "worker-artifacts",
  "worker-sessions",
]);

function isLegacyRuntimeStateEntry(name: string): boolean {
  if (LEGACY_RUNTIME_STATE_ENTRIES.has(name)) return true;
  return ["approval-state.json", "runtime-capabilities.json", "sessions-index.json"]
    .some((base) => name.startsWith(`${base}.`) && name.endsWith(".tmp"));
}

export interface SessionStoreOptions extends CreateStatePathOptions {
  migrateLegacyState?: boolean;
}

export class SessionStore implements ToolSessionPersistence {
  public readonly workspaceRoot: string;

  public readonly workspaceId: string;

  public readonly paths: StatePaths;

  public readonly legacyStateDir: string;

  private readonly workerSessionLocks = new Map<string, Promise<void>>();

  private initializationPromise?: Promise<void>;

  private readonly migrateLegacyState: boolean;

  public constructor(workspaceRoot: string, options: SessionStoreOptions = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.workspaceId = deriveWorkspaceId(this.workspaceRoot);
    this.paths = createStatePaths(this.workspaceRoot, options);
    this.legacyStateDir = resolveLegacyWorkspaceStateDirectory(this.workspaceRoot);
    this.migrateLegacyState = options.migrateLegacyState !== false;
  }

  public async ensureInitialized(): Promise<void> {
    if (this.initializationPromise) return this.initializationPromise;
    this.initializationPromise = this.initializeState().catch((error) => {
      this.initializationPromise = undefined;
      throw error;
    });
    return this.initializationPromise;
  }

  private async initializeState(): Promise<void> {
    await fs.mkdir(this.paths.storageRoot, { recursive: true, mode: 0o700 });
    const storageStat = await fs.lstat(this.paths.storageRoot);
    if (storageStat.isSymbolicLink() || !storageStat.isDirectory()) {
      throw new Error("Deep-Mix storage root is not a trusted real directory.");
    }
    await this.migrateLegacyWorkspaceState();

    for (const [label, directory] of Object.entries({
      state: this.paths.stateDir,
      exports: this.paths.exportsDir,
      sessions: this.paths.sessionsDir,
      approvalRecords: this.paths.approvalRecordsDir,
      telemetry: this.paths.telemetryDir,
      fileHistory: this.paths.fileHistoryDir,
      checkpoints: this.paths.checkpointsDir,
      rollbackRecords: this.paths.rollbackRecordsDir,
      workerSessions: this.paths.workerSessionsDir,
      workerArtifacts: this.paths.workerArtifactsDir,
      artifactRecords: this.paths.artifactRecordsDir,
      artifactPatches: this.paths.artifactPatchesDir,
      artifactImages: this.paths.artifactImagesDir,
      toolOutputs: this.paths.toolOutputsDir,
      toolOutputRecords: this.paths.toolOutputRecordsDir,
      userInputClaims: this.paths.userInputClaimsDir,
      protectedToolCalls: this.paths.protectedToolCallsDir,
      completedToolResults: this.paths.completedToolResultsDir,
    })) {
      await ensureRealDirectory(this.paths.storageRoot, directory, `State directory ${label}`);
    }

    if (!(await exists(this.paths.sessionsIndexPath))) {
      const index: SessionsIndex = {
        version: 1,
        sessions: [],
      };
      await this.writeSessionsIndex(index);
    }

    if (!(await exists(this.paths.approvalStatePath))) {
      await writeApprovalState(this.paths.approvalStatePath, {
        version: 1,
        sessions: {},
      });
    }
    if (!(await exists(this.paths.approvalRequestKeySecretPath))) {
      try {
        await fs.writeFile(this.paths.approvalRequestKeySecretPath, randomBytes(32), {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }

    if (!(await exists(this.paths.telemetrySummaryPath))) {
      await writeJsonAtomic(this.paths.telemetrySummaryPath, createTelemetrySummary());
    }

    await this.garbageCollectProtectedToolCalls();

    const gitDir = path.join(this.paths.fileHistoryDir, ".git");
    if (!(await exists(gitDir))) {
      await runGit(["init"], this.paths.fileHistoryDir);
      await runGit(["config", "user.name", "Deep Mix Runtime"], this.paths.fileHistoryDir);
      await runGit(["config", "user.email", "deep-mix@local.invalid"], this.paths.fileHistoryDir);
    }
  }

  private async migrateLegacyWorkspaceState(): Promise<void> {
    if (!this.migrateLegacyState || path.resolve(this.legacyStateDir) === path.resolve(this.paths.stateDir)) return;
    const legacyStat = await fs.lstat(this.legacyStateDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!legacyStat) return;
    if (legacyStat.isSymbolicLink() || !legacyStat.isDirectory()) {
      throw new Error("Legacy workspace state is not a trusted real directory.");
    }
    await fs.mkdir(this.paths.stateDir, { recursive: true, mode: 0o700 });
    const entries = await fs.readdir(this.legacyStateDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!isLegacyRuntimeStateEntry(entry.name) || entry.isSymbolicLink()) continue;
      const source = path.join(this.legacyStateDir, entry.name);
      const destination = path.join(this.paths.stateDir, entry.name);
      if (await exists(destination)) continue;
      try {
        await fs.rename(source, destination);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" && (await exists(destination))) continue;
        if (code !== "EXDEV") throw error;
        try {
          await fs.cp(source, destination, { recursive: entry.isDirectory(), errorOnExist: true, force: false });
          await removePathWithoutFollowing(source);
        } catch (copyError) {
          if (!["EEXIST", "ENOENT"].includes((copyError as NodeJS.ErrnoException).code ?? "") || !(await exists(destination))) {
            throw copyError;
          }
        }
      }
    }
    const remaining = await fs.readdir(this.legacyStateDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (remaining?.length === 0) {
      await fs.rmdir(this.legacyStateDir).catch((error: NodeJS.ErrnoException) => {
        if (!["ENOENT", "ENOTEMPTY"].includes(error.code ?? "")) throw error;
      });
    }
  }

  private async garbageCollectProtectedToolCalls(): Promise<void> {
    const index = JSON.parse(await fs.readFile(this.paths.sessionsIndexPath, "utf8")) as SessionsIndex;
    const sessionsByDirectory = new Map(index.sessions.map((session) => [
      sanitizeToolOutputFilename(session.sessionId),
      session.sessionId,
    ]));
    const directories = await fs.readdir(this.paths.protectedToolCallsDir, { withFileTypes: true });
    for (const entry of directories) {
      const directory = path.join(this.paths.protectedToolCallsDir, entry.name);
      const sessionId = sessionsByDirectory.get(entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink() || !sessionId) {
        await removePathWithoutFollowing(directory);
        continue;
      }
      await assertExistingRealDirectory(this.paths.storageRoot, directory, "Protected tool-call session directory");
      const events = await this.loadEvents(sessionId);
      const responded = new Set(events.flatMap((event) => (
        event.recordType === "message" && event.role === "tool" && event.toolCallId ? [event.toolCallId] : []
      )));
      const pending = new Set(events.flatMap((event) => (
        event.recordType === "message" && event.role === "assistant"
          ? (event.toolCalls ?? []).map((call) => call.id).filter((callId) => !responded.has(callId))
          : []
      )));
      for (const file of await fs.readdir(directory, { withFileTypes: true })) {
        const filePath = path.join(directory, file.name);
        if (!file.isFile() || file.isSymbolicLink()) {
          await removePathWithoutFollowing(filePath);
          continue;
        }
        let callId: string | undefined;
        try {
          const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
          try {
            const parsed = JSON.parse(await handle.readFile("utf8")) as Partial<ToolCall>;
            if (typeof parsed.id === "string") callId = parsed.id;
          } finally {
            await handle.close();
          }
        } catch {
          // Invalid protected payloads have no safe resumable owner.
        }
        if (!callId || !pending.has(callId)) await fs.rm(filePath, { force: true });
      }
    }
  }

  public async loadSessionsIndex(): Promise<SessionsIndex> {
    await this.ensureInitialized();
    const content = await fs.readFile(this.paths.sessionsIndexPath, "utf8");
    return JSON.parse(content) as SessionsIndex;
  }

  public async loadRuntimeCapabilities(): Promise<RuntimeCapabilitySnapshot | undefined> {
    await this.ensureInitialized();
    if (!(await exists(this.paths.runtimeCapabilitiesPath))) {
      return undefined;
    }
    const content = await fs.readFile(this.paths.runtimeCapabilitiesPath, "utf8");
    return JSON.parse(content) as RuntimeCapabilitySnapshot;
  }

  public async saveRuntimeCapabilities(snapshot: RuntimeCapabilitySnapshot): Promise<void> {
    await this.ensureInitialized();
    await writeJsonAtomic(this.paths.runtimeCapabilitiesPath, snapshot);
  }

  public async writeSessionsIndex(index: SessionsIndex): Promise<void> {
    await writeJsonAtomic(this.paths.sessionsIndexPath, index);
  }

  public async createSession(
    initialPrompt: string,
    options: { title?: string; titleSource?: SessionRecord["titleSource"] } = {},
  ): Promise<SessionRecord> {
    await this.ensureInitialized();
    const createdAt = now();
    const sessionId = randomUUID();
    const session: SessionRecord = {
      sessionId,
      title: options.title?.trim().slice(0, 120) || initialPrompt.slice(0, 80) || "New session",
      ...(options.titleSource ? { titleSource: options.titleSource } : {}),
      status: "pending",
      createdAt,
      updatedAt: createdAt,
      workspaceRoot: this.workspaceRoot,
      jsonlPath: `sessions/${sessionId}.jsonl`,
      messageCount: 0,
      planItems: [],
    };

    const jsonlPath = this.getSessionJsonlPath(sessionId);
    await fs.writeFile(jsonlPath, "", "utf8");

    const index = await this.loadSessionsIndex();
    index.sessions.push(session);
    index.activeSessionId = sessionId;
    await this.writeSessionsIndex(index);
    return session;
  }

  public async loadSession(sessionId: string): Promise<SessionRecord | undefined> {
    const index = await this.loadSessionsIndex();
    return index.sessions.find((session) => session.sessionId === sessionId);
  }

  public async deleteSession(sessionId: string): Promise<boolean> {
    await this.ensureInitialized();
    const index = await this.loadSessionsIndex();
    const sessionIndex = index.sessions.findIndex((session) => session.sessionId === sessionId);
    if (sessionIndex === -1) {
      return false;
    }

    index.sessions.splice(sessionIndex, 1);
    if (index.activeSessionId === sessionId) {
      index.activeSessionId = undefined;
    }
    await this.writeSessionsIndex(index);

    await Promise.allSettled([
      fs.rm(this.getSessionJsonlPath(sessionId), { force: true }),
      fs.rm(this.getApprovalRecordPath(sessionId), { force: true }),
      fs.rm(this.getRollbackRecordPath(sessionId), { force: true }),
      fs.rm(path.join(this.paths.userInputClaimsDir, sessionId), { recursive: true, force: true }),
      removePathWithoutFollowing(path.join(
        this.paths.protectedToolCallsDir,
        sanitizeToolOutputFilename(sessionId),
      )),
      removePathWithoutFollowing(path.join(
        this.paths.completedToolResultsDir,
        sanitizeToolOutputFilename(sessionId),
      )),
    ]);

    await withApprovalStateLock(this.paths.approvalStatePath, async () => {
      const approvalState = await readApprovalState(this.paths.approvalStatePath);
      if (approvalState.sessions[sessionId]) {
        delete approvalState.sessions[sessionId];
        await writeApprovalState(this.paths.approvalStatePath, approvalState);
      }
    });
    return true;
  }

  public async exportSessionMarkdown(input: {
    sessionId: string;
    outputPath?: string;
  }): Promise<{
    outputPath: string;
    content: string;
  }> {
    await this.ensureInitialized();
    const session = await this.loadSession(input.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${input.sessionId}`);
    }
    const content = await buildSessionMarkdownExport(this, input.sessionId);
    const outputPath = resolveSessionExportPath(
      this.workspaceRoot,
      resolveDefaultSessionMarkdownExportPath(this.workspaceRoot, this.paths.stateDir, session),
      input.outputPath,
    );
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, content, "utf8");
    return {
      outputPath,
      content,
    };
  }

  public async updateSession(sessionId: string, updater: (session: SessionRecord) => SessionRecord): Promise<SessionRecord> {
    const index = await this.loadSessionsIndex();
    const sessionIndex = index.sessions.findIndex((session) => session.sessionId === sessionId);
    if (sessionIndex === -1) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    const updated = updater(index.sessions[sessionIndex]!);
    updated.updatedAt = now();
    index.sessions[sessionIndex] = updated;
    index.activeSessionId = updated.status === "completed" ? undefined : updated.sessionId;
    await this.writeSessionsIndex(index);
    return updated;
  }

  public async setSessionStatus(sessionId: string, status: SessionStatus): Promise<SessionRecord> {
    return this.updateSession(sessionId, (session) => ({ ...session, status }));
  }

  public async appendEvent(sessionId: string, event: SessionEvent): Promise<void> {
    const jsonlPath = this.getSessionJsonlPath(sessionId);
    await fs.appendFile(jsonlPath, `${JSON.stringify(event)}\n`, "utf8");
  }

  public async appendMessage(input: Omit<MessageRecord, "recordType" | "messageId" | "createdAt">): Promise<MessageRecord> {
    const message: MessageRecord = {
      recordType: "message",
      messageId: randomUUID(),
      createdAt: now(),
      ...input,
    };

    await this.appendEvent(input.sessionId, message);
    await this.updateSession(input.sessionId, (session) => ({
      ...session,
      messageCount: session.messageCount + 1,
      lastAssistantMessage: input.role === "assistant" ? input.content : session.lastAssistantMessage,
    }));
    return message;
  }

  public async startTurn(input: {
    sessionId: string;
    requestSummary: string;
    userMessageId: string;
    modelAssignment?: TurnRecord["modelAssignment"];
  }): Promise<TurnRecord> {
    const startedAt = now();
    const turn: TurnRecord = {
      recordType: "turn",
      turnId: randomUUID(),
      sessionId: input.sessionId,
      createdAt: startedAt,
      startedAt,
      status: "running",
      requestSummary: input.requestSummary,
      userMessageId: input.userMessageId,
      toolCallIds: [],
      modelAssignment: input.modelAssignment,
    };

    await this.appendEvent(input.sessionId, turn);
    await this.updateSession(input.sessionId, (session) => ({
      ...session,
      status: "running",
      activeTurnId: turn.turnId,
      lastTurnId: turn.turnId,
      latestTaskDuration: {
        startedAt,
        status: "running",
      },
    }));
    return turn;
  }

  public async finishTurn(input: {
    sessionId: string;
    turnId: string;
    startedAt: string;
    requestSummary: string;
    userMessageId: string;
    assistantMessageId?: string;
    toolCallIds: string[];
    status: SessionStatus;
    error?: string;
  }): Promise<TurnRecord> {
    const finishedAt = now();
    const durationMs = Math.max(0, new Date(finishedAt).getTime() - new Date(input.startedAt).getTime());
    const existingAssignment = (await this.loadEvents(input.sessionId))
      .find((event): event is TurnRecord => event.recordType === "turn" && event.turnId === input.turnId && event.modelAssignment !== undefined)
      ?.modelAssignment;
    const turn: TurnRecord = {
      recordType: "turn",
      turnId: input.turnId,
      sessionId: input.sessionId,
      createdAt: finishedAt,
      startedAt: input.startedAt,
      endedAt: finishedAt,
      durationMs,
      status: input.status,
      requestSummary: input.requestSummary,
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
      toolCallIds: input.toolCallIds,
      modelAssignment: existingAssignment,
      error: input.error,
    };

    await this.appendEvent(input.sessionId, turn);
    await this.updateSession(input.sessionId, (session) => ({
      ...session,
      status: input.status,
      activeTurnId: undefined,
      lastTurnId: input.turnId,
      latestTaskDuration: {
        startedAt: input.startedAt,
        endedAt: finishedAt,
        durationMs,
        status: input.status,
      },
    }));
    return turn;
  }

  public async loadMessages(sessionId: string): Promise<MessageRecord[]> {
    const events = await this.loadEvents(sessionId);
    return events.filter((event): event is MessageRecord => event.recordType === "message");
  }

  public async loadEvents(sessionId: string): Promise<SessionEvent[]> {
    const jsonlPath = this.getSessionJsonlPath(sessionId);
    if (!(await exists(jsonlPath))) {
      return [];
    }

    const content = await fs.readFile(jsonlPath, "utf8");
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionEvent)
      .map(normalizeLegacyRoutingRecord)
      .map((event) => event.recordType === "turn" && event.modelAssignment
        ? { ...event, modelAssignment: freezeAssignment(event.modelAssignment) }
        : event);
  }

  public async resolveMostRecentResumableSession(sessionId?: string): Promise<SessionRecord | undefined> {
    const index = await this.loadSessionsIndex();
    if (sessionId) {
      return index.sessions.find((session) => session.sessionId === sessionId);
    }

    return [...index.sessions]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .find((session) => !session.archivedAt && session.status !== "completed");
  }

  public async recoverActiveSession(): Promise<void> {
    const index = await this.loadSessionsIndex();
    if (!index.activeSessionId) {
      return;
    }

    const active = index.sessions.find((session) => session.sessionId === index.activeSessionId);
    if (!active || active.status !== "running") {
      return;
    }

    const events = await this.loadEvents(active.sessionId);
    const messages = events.filter((event): event is MessageRecord => event.recordType === "message");
    const activeTurnId = active.activeTurnId;
    const activeTurnMessages = messages.filter((message) => message.turnId === activeTurnId);
    let pendingAssistant: MessageRecord | undefined;
    let pendingAssistantResultIds = new Set<string>();
    let pendingAssistantResults: MessageRecord[] = [];
    for (let index = activeTurnMessages.length - 1; index >= 0; index -= 1) {
      const message = activeTurnMessages[index]!;
      if (message.role !== "assistant" || !message.toolCalls?.length) continue;
      const followingGroup: MessageRecord[] = [];
      for (let resultIndex = index + 1; resultIndex < activeTurnMessages.length; resultIndex += 1) {
        const candidate = activeTurnMessages[resultIndex]!;
        if (candidate.role === "assistant" || candidate.role === "user") break;
        if (candidate.role === "tool") followingGroup.push(candidate);
      }
      const resultIds = new Set(
        followingGroup.filter((candidate) => candidate.toolCallId).map((candidate) => candidate.toolCallId!),
      );
      if (message.toolCalls.some((call) => !resultIds.has(call.id))) {
        pendingAssistant = message;
        pendingAssistantResultIds = resultIds;
        pendingAssistantResults = followingGroup;
        break;
      }
    }
    const openUserInputs = await this.listUnsettledUserInputRequests(active.sessionId);
    const openBlocking = [...openUserInputs].reverse().find(
      (state) => state.request.mode === "blocking" && state.request.turnId === activeTurnId,
    );

    const finishRecoveredTurn = async (
      status: Extract<SessionStatus, "waiting_for_user" | "interrupted">,
      error?: string,
      assistantMessage?: MessageRecord,
    ): Promise<void> => {
      if (!activeTurnId) {
        await this.updateSession(active.sessionId, (session) => ({
          ...session,
          status,
          activeTurnId: undefined,
        }));
        return;
      }
      const turn = [...events].reverse().find(
        (event): event is TurnRecord => event.recordType === "turn" && event.turnId === activeTurnId,
      );
      const userMessage = messages.find(
        (message) => message.turnId === activeTurnId && message.role === "user",
      );
      const assistant = assistantMessage ?? [...messages].reverse().find(
        (message) => message.turnId === activeTurnId && message.role === "assistant",
      );
      if (!turn || !userMessage) {
        await this.updateSession(active.sessionId, (session) => ({
          ...session,
          status,
          activeTurnId: undefined,
        }));
        return;
      }
      await this.finishTurn({
        sessionId: active.sessionId,
        turnId: activeTurnId,
        startedAt: turn.startedAt,
        requestSummary: turn.requestSummary,
        userMessageId: userMessage.messageId,
        assistantMessageId: assistant?.messageId,
        toolCallIds: [...new Set(messages
          .filter((message) => message.turnId === activeTurnId && message.role === "assistant")
          .flatMap((message) => message.toolCalls?.map((call) => call.id) ?? []))],
        status,
        error,
      });
    };

    if (pendingAssistant?.toolCalls?.length) {
      const requestCalls = pendingAssistant.toolCalls.filter(
        (call) => call.name === "request_user_input",
      );
      const requestStateForCall = (toolCallId: string) =>
        [...openUserInputs].reverse().find((state) =>
          state.request.toolCallId === toolCallId &&
          state.request.turnId === activeTurnId &&
          state.request.createdAt >= pendingAssistant!.createdAt);
      const legalWaitState = requestCalls
        .map((call) => {
          const result = pendingAssistantResults.find(
            (message) => message.role === "tool" && message.toolCallId === call.id,
          );
          const control = result?.metadata?.control as
            | { type?: string; requestId?: string }
            | undefined;
          const state = requestStateForCall(call.id);
          return state?.request.mode === "blocking" &&
            control?.type === "wait_for_user" &&
            control.requestId === state.request.requestId
            ? state
            : undefined;
        })
        .find((state) => state !== undefined);
      const incompleteRequestState = requestCalls
        .filter((call) => !pendingAssistantResultIds.has(call.id))
        .map((call) => requestStateForCall(call.id))
        .find((state) => state !== undefined);
      const invalidBlockingRequestState = requestCalls
        .map((call) => requestStateForCall(call.id))
        .find((state) => state?.request.mode === "blocking");
      const requestStateToInterrupt = legalWaitState
        ? undefined
        : incompleteRequestState ?? invalidBlockingRequestState;
      const legalWait = Boolean(legalWaitState);
      for (const call of pendingAssistant.toolCalls) {
        if (pendingAssistantResultIds.has(call.id)) continue;
        await this.appendMessage({
          sessionId: active.sessionId,
          turnId: pendingAssistant.turnId,
          role: "tool",
          content: legalWait
            ? `[waiting_for_user] ${call.name} was not executed before the persisted user-input pause.`
            : `[interrupted] ${call.name} did not complete before runtime restart.`,
          name: call.name,
          toolCallId: call.id,
          metadata: {
            success: false,
            errorType: legalWait ? "waiting_for_user" : "interrupted",
            recoveredAfterRestart: true,
          },
        });
      }
      const openBlockingBelongsToCurrentGroup = Boolean(openBlocking) && requestCalls.some(
        (call) => call.id === openBlocking!.request.toolCallId,
      );
      const shouldRestoreWait = legalWait || Boolean(openBlocking && !openBlockingBelongsToCurrentGroup);
      if (requestStateToInterrupt) {
        await this.recordUserInputResume({
          recordType: "user_input_resume",
          requestId: requestStateToInterrupt.request.requestId,
          sessionId: active.sessionId,
          turnId: requestStateToInterrupt.request.turnId,
          toolCallId: requestStateToInterrupt.request.toolCallId,
          createdAt: now(),
          status: "interrupted",
          error: "The request_user_input tool result was not durably committed before restart.",
        });
      }
      await finishRecoveredTurn(
        shouldRestoreWait ? "waiting_for_user" : "interrupted",
        shouldRestoreWait
          ? "Recovered a durable user-input pause after restart."
          : "Recovered and closed an incomplete tool-call group after restart.",
        pendingAssistant,
      );
      return;
    }

    if (openBlocking) {
      let requestToolResult: MessageRecord | undefined;
      for (let index = activeTurnMessages.length - 1; index >= 0; index -= 1) {
        const message = activeTurnMessages[index]!;
        if (
          message.role !== "assistant" ||
          message.createdAt > openBlocking.request.createdAt ||
          !message.toolCalls?.some(
            (call) => call.name === "request_user_input" && call.id === openBlocking.request.toolCallId,
          )
        ) {
          continue;
        }
        for (let resultIndex = index + 1; resultIndex < activeTurnMessages.length; resultIndex += 1) {
          const candidate = activeTurnMessages[resultIndex]!;
          if (candidate.role === "assistant" || candidate.role === "user") break;
          if (candidate.role === "tool" && candidate.toolCallId === openBlocking.request.toolCallId) {
            requestToolResult = candidate;
            break;
          }
        }
        break;
      }
      const control = requestToolResult?.metadata?.control as
        | { type?: string; requestId?: string }
        | undefined;
      if (
        control?.type === "wait_for_user" &&
        control.requestId === openBlocking.request.requestId
      ) {
        await finishRecoveredTurn(
          "waiting_for_user",
          "Recovered a durable user-input pause after restart.",
        );
        return;
      }
      await this.recordUserInputResume({
        recordType: "user_input_resume",
        requestId: openBlocking.request.requestId,
        sessionId: active.sessionId,
        turnId: openBlocking.request.turnId,
        toolCallId: openBlocking.request.toolCallId,
        createdAt: now(),
        status: "interrupted",
        error: "The persisted user-input request had no legal tool result after restart.",
      });
      await finishRecoveredTurn(
        "interrupted",
        "Closed an incomplete user-input request after restart.",
      );
      return;
    }

    await finishRecoveredTurn(
      "interrupted",
      "The active turn was interrupted by runtime restart.",
    );
  }

  public async updatePlanItems(sessionId: string, items: PlanItem[]): Promise<PlanItem[]> {
    await this.updateSession(sessionId, (session) => ({
      ...session,
      planItems: items,
    }));

    const record: PlanUpdateRecord = {
      recordType: "plan_update",
      sessionId,
      createdAt: now(),
      planItems: items,
    };

    await this.appendEvent(sessionId, record);
    return items;
  }

  public async recordApproval(record: ApprovalRecord): Promise<void> {
    await this.appendEvent(record.sessionId, record);
    await fs.appendFile(this.getApprovalRecordPath(record.sessionId), `${JSON.stringify(record)}\n`, "utf8");
  }

  public async storeProtectedToolCall(sessionId: string, toolCall: ToolCall): Promise<void> {
    await this.ensureInitialized();
    if (!(await this.loadSession(sessionId))) throw new Error(`Unknown session for protected tool call: ${sessionId}`);
    const directory = path.join(this.paths.protectedToolCallsDir, sanitizeToolOutputFilename(sessionId));
    await ensureRealDirectory(this.paths.storageRoot, this.paths.protectedToolCallsDir, "Protected tool-call root", 0o700);
    await ensureRealDirectory(this.paths.storageRoot, directory, "Protected tool-call session directory", 0o700);
    const targetPath = path.join(directory, protectedToolCallFileName(toolCall.id));
    assertPathInside(this.paths.protectedToolCallsDir, targetPath, "Protected tool call path");
    await assertExistingRealDirectory(this.paths.storageRoot, directory, "Protected tool-call session directory");
    await writeJsonAtomic(targetPath, toolCall, 0o600);
  }

  public async loadProtectedToolCall(sessionId: string, toolCallId: string): Promise<ToolCall | undefined> {
    await this.ensureInitialized();
    const targetPath = path.join(
      this.paths.protectedToolCallsDir,
      sanitizeToolOutputFilename(sessionId),
      protectedToolCallFileName(toolCallId),
    );
    assertPathInside(this.paths.protectedToolCallsDir, targetPath, "Protected tool call path");
    const directory = path.dirname(targetPath);
    if (!(await assertExistingRealDirectory(this.paths.storageRoot, directory, "Protected tool-call session directory"))) {
      return undefined;
    }
    try {
      const handle = await fs.open(targetPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      let content: string;
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error("Protected tool call payload is not a regular file.");
        content = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
      const parsed = JSON.parse(content) as Partial<ToolCall>;
      if (
        parsed.id !== toolCallId ||
        typeof parsed.name !== "string" ||
        typeof parsed.rawArguments !== "string" ||
        !("arguments" in parsed)
      ) {
        throw new Error("Protected tool call payload is invalid.");
      }
      return parsed as ToolCall;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  public async deleteProtectedToolCall(sessionId: string, toolCallId: string): Promise<void> {
    const targetPath = path.join(
      this.paths.protectedToolCallsDir,
      sanitizeToolOutputFilename(sessionId),
      protectedToolCallFileName(toolCallId),
    );
    assertPathInside(this.paths.protectedToolCallsDir, targetPath, "Protected tool call path");
    if (!(await assertExistingRealDirectory(
      this.paths.storageRoot,
      path.dirname(targetPath),
      "Protected tool-call session directory",
    ))) return;
    await fs.rm(targetPath, { force: true });
  }

  public async loadToolExecutionJournal(
    sessionId: string,
    callId: string,
  ): Promise<ToolExecutionJournalRecord | undefined> {
    await this.ensureInitialized();
    const directory = path.join(this.paths.completedToolResultsDir, sanitizeToolOutputFilename(sessionId));
    if (!(await assertExistingRealDirectory(this.paths.storageRoot, directory, "Tool-execution journal directory"))) {
      return undefined;
    }
    const targetPath = path.join(directory, protectedToolCallFileName(callId));
    assertPathInside(this.paths.completedToolResultsDir, targetPath, "Tool-execution journal path");
    try {
      const handle = await fs.open(targetPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        const parsed = JSON.parse(await handle.readFile("utf8")) as ToolExecutionJournalRecord;
        if (
          parsed.version !== 1 || parsed.sessionId !== sessionId || parsed.callId !== callId ||
          !["started", "completed"].includes(parsed.status) || typeof parsed.toolName !== "string" ||
          (parsed.status === "completed" && !parsed.result)
        ) {
          throw new Error("Tool-execution journal payload is invalid.");
        }
        return parsed;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  public async recordToolExecutionIntent(input: {
    sessionId: string;
    callId: string;
    toolName: string;
  }): Promise<{ record: ToolExecutionJournalRecord; claimed: boolean }> {
    await this.ensureInitialized();
    if (!(await this.loadSession(input.sessionId))) {
      throw new Error(`Unknown session for tool-execution journal: ${input.sessionId}`);
    }
    const directory = path.join(this.paths.completedToolResultsDir, sanitizeToolOutputFilename(input.sessionId));
    await ensureRealDirectory(this.paths.storageRoot, this.paths.completedToolResultsDir, "Tool-execution journal root", 0o700);
    await ensureRealDirectory(this.paths.storageRoot, directory, "Tool-execution journal directory", 0o700);
    const targetPath = path.join(directory, protectedToolCallFileName(input.callId));
    const record: ToolExecutionJournalRecord = {
      version: 1,
      sessionId: input.sessionId,
      callId: input.callId,
      toolName: input.toolName,
      status: "started",
      createdAt: now(),
    };
    try {
      await writeJsonExclusiveAtomic(targetPath, record);
      return { record, claimed: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.loadToolExecutionJournal(input.sessionId, input.callId);
      if (!existing || existing.toolName !== input.toolName) {
        throw new Error("Tool-execution journal identity conflict.");
      }
      return { record: existing, claimed: false };
    }
  }

  public async storeCompletedToolResult(
    sessionId: string,
    result: ToolResult,
  ): Promise<ToolExecutionJournalRecord> {
    await this.ensureInitialized();
    const directory = path.join(this.paths.completedToolResultsDir, sanitizeToolOutputFilename(sessionId));
    await ensureRealDirectory(this.paths.storageRoot, this.paths.completedToolResultsDir, "Tool-execution journal root", 0o700);
    await ensureRealDirectory(this.paths.storageRoot, directory, "Tool-execution journal directory", 0o700);
    const existing = await this.loadToolExecutionJournal(sessionId, result.callId);
    if (existing && existing.toolName !== result.toolName) {
      throw new Error("Tool-execution journal identity conflict.");
    }
    const record: ToolExecutionJournalRecord = {
      version: 1,
      sessionId,
      callId: result.callId,
      toolName: result.toolName,
      status: "completed",
      createdAt: existing?.createdAt ?? now(),
      completedAt: now(),
      result,
    };
    const targetPath = path.join(directory, protectedToolCallFileName(result.callId));
    await writeJsonAtomic(targetPath, record, 0o600);
    return record;
  }

  public async recordToolExecutionAudit(record: ToolExecutionAuditRecord): Promise<void> {
    await this.appendEvent(record.sessionId, record);
  }

  public async recordToolSelection(record: ToolSelectionRecord): Promise<void> {
    await this.appendEvent(record.sessionId, record);
  }

  public async recordToolActivation(record: ToolActivationRecord): Promise<void> {
    await this.appendEvent(record.sessionId, record);
  }

  public async recordUserInputRequest(record: UserInputRequestRecord): Promise<void> {
    await this.appendEvent(record.sessionId, record);
  }

  public async recordUserInputResponse(record: UserInputResponseRecord): Promise<void> {
    await this.appendEvent(record.sessionId, record);
  }

  public async recordUserInputResume(record: UserInputResumeRecord): Promise<void> {
    await this.appendEvent(record.sessionId, record);
  }

  public async hasPersistedUserInputClaim(sessionId: string, requestId: string): Promise<boolean> {
    for (const [label, value] of Object.entries({ sessionId, requestId })) {
      if (!/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error(`Invalid ${label} for user-input claim lookup.`);
      }
    }
    return exists(path.join(this.paths.userInputClaimsDir, sessionId, `${requestId}.json`));
  }

  public async claimUserInputRequest(input: {
    sessionId: string;
    requestId: string;
    responseId: string;
    submission?: UserInputClaimSubmission;
  }): Promise<UserInputClaimResult> {
    await this.ensureInitialized();
    for (const [label, value] of Object.entries({
      sessionId: input.sessionId,
      requestId: input.requestId,
      responseId: input.responseId,
    })) {
      if (!/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error(`Invalid ${label} for user-input claim.`);
      }
    }
    const claimDirectory = path.join(this.paths.userInputClaimsDir, input.sessionId);
    const claimPath = path.join(claimDirectory, `${input.requestId}.json`);
    const leasePath = `${claimPath}.lease`;
    const takeoverLockPath = `${leasePath}.takeover`;
    const leaseId = randomUUID();
    const leaseGenerationPath = path.join(leasePath, leaseId);
    await fs.mkdir(claimDirectory, { recursive: true });
    let state = await this.loadUserInputRequestState(input.sessionId, input.requestId);
    if (!state) throw new Error(`Unknown user-input request: ${input.requestId}.`);
    if (!["pending", "resuming", "resume_failed", "answered"].includes(state.status)) {
      throw new Error(`User-input request ${input.requestId} is already ${state.status}.`);
    }
    let claim: UserInputClaimFile | undefined;
    let recovered = false;
    let leaseAcquired = false;

    const readLeaseHeartbeatMs = async (): Promise<number> => {
      const entries = await fs.readdir(leasePath, { withFileTypes: true }).catch(() => []);
      const generationStats = await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => fs.stat(path.join(leasePath, entry.name))));
      if (generationStats.length > 0) {
        return Math.max(...generationStats.map((stat) => stat.mtimeMs));
      }
      return (await fs.stat(leasePath)).mtimeMs;
    };

    try {
      if (await exists(takeoverLockPath)) {
        const takeoverStat = await fs.stat(takeoverLockPath);
        if (Date.now() - takeoverStat.mtimeMs < USER_INPUT_CLAIM_STALE_MS) {
          throw new Error(`User-input request ${input.requestId} recovery is already in progress.`);
        }
        await fs.rm(takeoverLockPath, { recursive: true, force: true });
      }
      await fs.mkdir(leasePath);
      await fs.mkdir(leaseGenerationPath);
      leaseAcquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const heartbeatMs = await readLeaseHeartbeatMs();
        if (Date.now() - heartbeatMs < USER_INPUT_CLAIM_STALE_MS) {
          throw new Error(`User-input request ${input.requestId} was already claimed.`);
        }
      } catch (heartbeatError) {
        if ((heartbeatError as NodeJS.ErrnoException).code === "ENOENT") {
          try {
            await fs.mkdir(leasePath);
            await fs.mkdir(leaseGenerationPath);
            leaseAcquired = true;
          } catch (retryError) {
            if ((retryError as NodeJS.ErrnoException).code !== "EEXIST") throw retryError;
            throw new Error(`User-input request ${input.requestId} was claimed concurrently.`);
          }
        } else {
          throw heartbeatError;
        }
      }
      if (leaseAcquired) {
        // The previous owner completed between the failed mkdir and the heartbeat read.
      } else {
      try {
        await fs.mkdir(takeoverLockPath);
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code === "EEXIST") {
          const lockStat = await fs.stat(takeoverLockPath);
          const staleLock = Date.now() - lockStat.mtimeMs >= USER_INPUT_CLAIM_STALE_MS;
          if (!staleLock) {
            throw new Error(`User-input request ${input.requestId} recovery is already in progress.`);
          }
          await fs.rm(takeoverLockPath, { recursive: true, force: true });
          try {
            await fs.mkdir(takeoverLockPath);
          } catch (retryError) {
            if ((retryError as NodeJS.ErrnoException).code === "EEXIST") {
              throw new Error(`User-input request ${input.requestId} recovery was claimed concurrently.`);
            }
            throw retryError;
          }
        } else {
          throw lockError;
        }
      }
      let staleLeasePath: string | undefined;
      try {
        const heartbeatMs = await readLeaseHeartbeatMs();
        if (Date.now() - heartbeatMs < USER_INPUT_CLAIM_STALE_MS) {
          throw new Error(`User-input request ${input.requestId} was already claimed.`);
        }
        staleLeasePath = `${leasePath}.stale.${randomUUID()}`;
        await fs.rename(leasePath, staleLeasePath);
        await fs.mkdir(leasePath);
        await fs.mkdir(leaseGenerationPath);
        leaseAcquired = true;
      } finally {
        if (staleLeasePath) {
          await fs.rm(staleLeasePath, { recursive: true, force: true }).catch(() => undefined);
        }
        await fs.rm(takeoverLockPath, { recursive: true, force: true }).catch(() => undefined);
      }
      }
    }

    try {
      state = await this.loadUserInputRequestState(input.sessionId, input.requestId);
      if (!state || !["pending", "resuming", "resume_failed", "answered"].includes(state.status)) {
        throw new Error(`User-input request ${input.requestId} is no longer recoverable.`);
      }

      if (await exists(claimPath)) {
        recovered = true;
        let parsed: unknown;
        try {
          parsed = JSON.parse(await fs.readFile(claimPath, "utf8"));
        } catch {
          parsed = undefined;
        }
        if (isUserInputClaimFile(parsed, input.sessionId, input.requestId)) {
          claim = parsed;
          if (
            input.submission &&
            JSON.stringify(claim.submission) !== JSON.stringify(input.submission)
          ) {
            throw new Error(
              `User-input request ${input.requestId} already has a different committed answer.`,
            );
          }
        } else if (input.submission) {
          claim = {
            version: 1,
            sessionId: input.sessionId,
            requestId: input.requestId,
            responseId: input.responseId,
            claimedAt: now(),
            submission: input.submission,
          };
          await writeJsonAtomic(claimPath, claim);
        } else {
          throw new Error(
            `User-input request ${input.requestId} has an unreadable persisted claim; submit the answer again to rebuild it.`,
          );
        }
      } else {
        if (!input.submission) {
          throw new Error(
            `User-input request ${input.requestId} cannot recover without its persisted claim payload; submit the answer again.`,
          );
        }
        claim = {
          version: 1,
          sessionId: input.sessionId,
          requestId: input.requestId,
          responseId: input.responseId,
          claimedAt: now(),
          submission: input.submission,
        };
        await writeJsonExclusiveAtomic(claimPath, claim);
      }

      if (state.request.mode === "blocking" && claim!.submission.status === "answered") {
        await this.updateSession(input.sessionId, (session) => {
          if (
            session.status === "interrupted" ||
            (session.status === "running" && session.activeTurnId !== state!.request.turnId)
          ) {
            throw new Error(`Session ${input.sessionId} cannot resume the interrupted user-input turn.`);
          }
          return {
            ...session,
            status: "running",
            activeTurnId: state!.request.turnId,
            lastTurnId: state!.request.turnId,
          };
        });
      }
      await this.recordUserInputResume({
        recordType: "user_input_resume",
        requestId: input.requestId,
        responseId: claim!.responseId,
        sessionId: input.sessionId,
        turnId: state.request.turnId,
        toolCallId: state.request.toolCallId,
        createdAt: now(),
        status: "resuming",
      });
      const sessionAfterClaim = await this.loadSession(input.sessionId);
      if (
        sessionAfterClaim?.status === "interrupted" &&
        claim!.submission.status === "answered"
      ) {
        await this.recordUserInputResume({
          recordType: "user_input_resume",
          requestId: input.requestId,
          responseId: claim!.responseId,
          sessionId: input.sessionId,
          turnId: state.request.turnId,
          toolCallId: state.request.toolCallId,
          createdAt: now(),
          status: "interrupted",
          error: "The session was interrupted while claiming the user-input response.",
        });
        throw new Error(`Session ${input.sessionId} was interrupted during user-input claim.`);
      }
      return {
        request: state.request,
        responseId: claim!.responseId,
        submission: claim!.submission,
        recovered,
        leaseId,
      };
    } catch (error) {
      if (leaseAcquired) {
        await this.releaseUserInputClaim(input.sessionId, input.requestId, leaseId, {
          preservePayload: true,
        });
      }
      throw error;
    }
  }

  public async renewUserInputClaim(sessionId: string, requestId: string, leaseId: string): Promise<void> {
    for (const [label, value] of Object.entries({ sessionId, requestId, leaseId })) {
      if (!/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error(`Invalid ${label} for user-input claim renewal.`);
      }
    }
    const claimPath = path.join(this.paths.userInputClaimsDir, sessionId, `${requestId}.json`);
    const takeoverPath = `${claimPath}.lease.takeover`;
    if (await exists(takeoverPath)) {
      const takeoverStat = await fs.stat(takeoverPath);
      if (Date.now() - takeoverStat.mtimeMs < USER_INPUT_CLAIM_STALE_MS) {
        throw new Error(`User-input request ${requestId} lease takeover is in progress.`);
      }
      await fs.rm(takeoverPath, { recursive: true, force: true });
    }
    const generationPath = path.join(`${claimPath}.lease`, leaseId);
    const timestamp = new Date();
    try {
      await fs.utimes(generationPath, timestamp, timestamp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`User-input request ${requestId} lease is no longer owned by this responder.`);
      }
      throw error;
    }
  }

  public async releaseUserInputClaim(
    sessionId: string,
    requestId: string,
    leaseId: string,
    options: { preservePayload?: boolean } = {},
  ): Promise<void> {
    for (const [label, value] of Object.entries({ sessionId, requestId, leaseId })) {
      if (!/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error(`Invalid ${label} for user-input claim release.`);
      }
    }
    const claimPath = path.join(this.paths.userInputClaimsDir, sessionId, `${requestId}.json`);
    const leasePath = `${claimPath}.lease`;
    const generationPath = path.join(leasePath, leaseId);
    if (!(await exists(generationPath))) return;
    if (!options.preservePayload) await fs.rm(claimPath, { force: true });
    await fs.rmdir(generationPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await fs.rmdir(leasePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
    });
  }

  public async loadUserInputRequestState(
    sessionId: string,
    requestId: string,
  ): Promise<UserInputRequestState | undefined> {
    const events = await this.loadEvents(sessionId);
    const request = events.find(
      (event): event is UserInputRequestRecord =>
        event.recordType === "user_input_request" && event.requestId === requestId,
    );
    if (!request) return undefined;
    const response = [...events].reverse().find(
      (event): event is UserInputResponseRecord =>
        event.recordType === "user_input_response" && event.requestId === requestId,
    );
    const latestResume = [...events].reverse().find(
      (event): event is UserInputResumeRecord =>
        event.recordType === "user_input_resume" && event.requestId === requestId,
    );
    return {
      request,
      response,
      latestResume,
      status: response?.status === "cancelled"
        ? "cancelled"
        : latestResume?.status ?? response?.status ?? "pending",
    };
  }

  public async listPendingUserInputRequests(sessionId: string): Promise<UserInputRequestState[]> {
    const states = await this.listUnsettledUserInputRequests(sessionId);
    const session = await this.loadSession(sessionId);
    return states.filter((state) =>
      state.status === "pending" ||
      (session?.status !== "running" &&
        ["resuming", "resume_failed", "answered"].includes(state.status)),
    );
  }

  public async listUnsettledUserInputRequests(sessionId: string): Promise<UserInputRequestState[]> {
    const events = await this.loadEvents(sessionId);
    const requests = events.filter(
      (event): event is UserInputRequestRecord => event.recordType === "user_input_request",
    );
    const states = await Promise.all(
      requests.map((request) => this.loadUserInputRequestState(sessionId, request.requestId)),
    );
    return states.filter((state): state is UserInputRequestState => Boolean(
      state && ["pending", "resuming", "resume_failed", "answered"].includes(state.status),
    ));
  }

  public async loadApprovalGrant(sessionId: string, requestKey: string): Promise<ApprovalGrant | undefined> {
    return withApprovalStateLock(this.paths.approvalStatePath, async () => {
      const state = await readApprovalState(this.paths.approvalStatePath);
      return state.sessions[sessionId]?.[requestKey];
    });
  }

  public async claimApprovalGrant(sessionId: string, requestKey: string): Promise<ApprovalGrant | undefined> {
    return withApprovalStateLock(this.paths.approvalStatePath, async () => {
      const state = await readApprovalState(this.paths.approvalStatePath);
      const grant = state.sessions[sessionId]?.[requestKey];
      if (!grant || grant.persistence !== "allow_once") return grant;
      delete state.sessions[sessionId]![requestKey];
      if (Object.keys(state.sessions[sessionId]!).length === 0) delete state.sessions[sessionId];
      await writeApprovalState(this.paths.approvalStatePath, state);
      return grant;
    });
  }

  public async getApprovalRequestKeySecret(): Promise<Uint8Array> {
    await this.ensureInitialized();
    const handle = await fs.open(
      this.paths.approvalRequestKeySecretPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== 32) throw new Error("Approval request-key secret is invalid.");
      return new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
  }

  public async getLifecycleCursorIntegrityKey(): Promise<Uint8Array> {
    const rootSecret = await this.getApprovalRequestKeySecret();
    return new Uint8Array(
      createHmac("sha256", rootSecret)
        .update("deep-mix:lifecycle-cursor-integrity:v1", "utf8")
        .digest(),
    );
  }

  public async saveApprovalGrant(grant: ApprovalGrant): Promise<void> {
    await withApprovalStateLock(this.paths.approvalStatePath, async () => {
      const state = await readApprovalState(this.paths.approvalStatePath);
      state.sessions[grant.sessionId] ??= {};
      state.sessions[grant.sessionId]![grant.requestKey] = grant;
      await writeApprovalState(this.paths.approvalStatePath, state);
    });
  }

  public async consumeApprovalGrant(sessionId: string, requestKey: string): Promise<void> {
    await withApprovalStateLock(this.paths.approvalStatePath, async () => {
      const state = await readApprovalState(this.paths.approvalStatePath);
      const grant = state.sessions[sessionId]?.[requestKey];
      if (!grant) return;
      if (grant.persistence === "allow_once") {
        delete state.sessions[sessionId]![requestKey];
        if (Object.keys(state.sessions[sessionId]!).length === 0) {
          delete state.sessions[sessionId];
        }
        await writeApprovalState(this.paths.approvalStatePath, state);
      }
    });
  }

  public async createCheckpoint(input: {
    sessionId: string;
    scope: CheckpointScope;
    trackedFiles: string[];
    reason: string;
    turnId?: string;
    toolCallId?: string;
    sourceToolName?: string;
    signal?: AbortSignal;
  }): Promise<CheckpointRecord> {
    input.signal?.throwIfAborted();
    const sessionSnapshot = await this.loadSession(input.sessionId);
    if (!sessionSnapshot) {
      throw new Error(`Unknown session for checkpoint: ${input.sessionId}`);
    }
    const checkpointId = randomUUID();
    const checkpointRoot = path.join(this.paths.checkpointsDir, checkpointId);
    const normalizedTrackedFiles = minimizeCheckpointPaths(this.workspaceRoot, input.trackedFiles);
    await fs.mkdir(checkpointRoot, { recursive: true });
    const trackedFiles: CheckpointManifest["trackedFiles"] = [];
    const checkpointBudget: CheckpointTreeBudget = { entries: 0, bytes: 0 };

    try {
      for (const relativeFile of normalizedTrackedFiles) {
        input.signal?.throwIfAborted();
        const sourcePath = path.resolve(this.workspaceRoot, relativeFile);
        const snapshotPath = path.posix.join("workspace", relativeFile);
        const targetPath = path.resolve(checkpointRoot, snapshotPath);
        assertPathInside(checkpointRoot, targetPath, "Checkpoint snapshot path");
        await assertNoSymlinkComponents(this.workspaceRoot, sourcePath, "Checkpoint source path");

        let sourceStat;
        try {
          sourceStat = await fs.lstat(sourcePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!sourceStat) {
          trackedFiles.push({
            path: relativeFile,
            existed: false,
            snapshotPath,
            entryCount: 0,
            totalBytes: 0,
          });
          continue;
        }
        if (sourceStat.isSymbolicLink()) {
          throw new Error(`Checkpoint source path contains a symbolic link or junction: ${relativeFile}.`);
        }
        if (!sourceStat.isFile() && !sourceStat.isDirectory()) {
          throw new Error(`Checkpoint source path is not a regular file or directory: ${relativeFile}.`);
        }
        const entryCountBefore = checkpointBudget.entries;
        const bytesBefore = checkpointBudget.bytes;
        await copyCheckpointTree(
          sourcePath,
          targetPath,
          checkpointBudget,
          `Checkpoint source ${relativeFile}`,
          input.signal,
        );
        trackedFiles.push({
          path: relativeFile,
          existed: true,
          kind: sourceStat.isDirectory() ? "directory" : "file",
          snapshotPath,
          entryCount: checkpointBudget.entries - entryCountBefore,
          totalBytes: checkpointBudget.bytes - bytesBefore,
        });
      }

      const record: CheckpointRecord = {
        recordType: "checkpoint",
        checkpointId,
        sessionId: input.sessionId,
        workspaceId: this.workspaceId,
        turnId: input.turnId,
        toolCallId: input.toolCallId,
        sourceToolName: input.sourceToolName,
        createdAt: now(),
        scope: input.scope,
        trackedFiles: normalizedTrackedFiles,
        gitRef: `file-history/.git#${checkpointId}`,
        reason: input.reason,
      };

      input.signal?.throwIfAborted();
      const sessionEventCount = (await this.loadEvents(input.sessionId)).length;
      const manifest: CheckpointManifest = {
        version: 2,
        checkpointId,
        trackedFiles,
        sessionEventCount,
        sessionSnapshot,
      };
      input.signal?.throwIfAborted();
      await writeJsonAtomic(this.getCheckpointManifestPath(checkpointId), manifest);
      input.signal?.throwIfAborted();
      await this.appendEvent(input.sessionId, record);
      return record;
    } catch (error) {
      await fs.rm(checkpointRoot, { recursive: true, force: true });
      throw error;
    }
  }

  public async recordSupervisorDecision(record: SupervisorDecisionRecord): Promise<void> {
    await this.appendEvent(record.sessionId, record);
    if (record.action === "continueVerification") {
      return;
    }

    const summary = await this.updateTelemetrySummary((current) => {
      current.counters.workerDecisionCount += 1;
      if (record.action === "accept") {
        current.counters.workerAcceptedCount += 1;
      }
      if (record.action === "revise") {
        current.counters.revisionCount += 1;
      }
      if (record.action === "fallbackToGovernor") {
        current.counters.fallbackCount += 1;
      }
      current.counters.workerAcceptanceRate =
        current.counters.workerDecisionCount === 0
          ? 0
          : current.counters.workerAcceptedCount / current.counters.workerDecisionCount;
      current.counters.fallbackRate =
        current.counters.workerRoutedCount === 0
          ? 0
          : current.counters.fallbackCount / current.counters.workerRoutedCount;
      return current;
    });
    await this.recordTelemetryMetricSnapshot(record.sessionId, "worker_acceptance_rate", {
      value: summary.counters.workerAcceptanceRate,
      numerator: summary.counters.workerAcceptedCount,
      denominator: summary.counters.workerDecisionCount,
      metadata: {
        action: record.action,
        workerSessionId: record.workerSessionId,
      },
    });
    if (record.action === "revise") {
      await this.recordTelemetryMetricSnapshot(record.sessionId, "revision_count", {
        value: summary.counters.revisionCount,
        metadata: {
          workerSessionId: record.workerSessionId,
        },
      });
    }
    if (record.action === "fallbackToGovernor") {
      await this.recordTelemetryMetricSnapshot(record.sessionId, "fallback_rate", {
        value: summary.counters.fallbackRate,
        numerator: summary.counters.fallbackCount,
        denominator: summary.counters.workerRoutedCount,
        metadata: {
          workerSessionId: record.workerSessionId,
        },
      });
    }
  }

  public async loadSupervisorDecisions(
    sessionId: string,
    workerSessionId: string,
  ): Promise<SupervisorDecisionRecord[]> {
    const events = await this.loadEvents(sessionId);
    return events.filter(
      (event): event is SupervisorDecisionRecord =>
        event.recordType === "supervisor_decision" && event.workerSessionId === workerSessionId,
    );
  }

  public async recordPromotion(record: ArtifactPromotionRecord): Promise<void> {
    await this.appendEvent(record.sessionId, record);
    await fs.appendFile(this.paths.promotionLogPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  public async recordRollback(record: RollbackRecord): Promise<void> {
    await this.appendEvent(record.sessionId, record);
    await fs.appendFile(this.getRollbackRecordPath(record.sessionId), `${JSON.stringify(record)}\n`, "utf8");
  }

  public async restoreCheckpoint(input: {
    sessionId: string;
    checkpointId: string;
    mode: RollbackMode;
    reason: string;
  }): Promise<RollbackRecord> {
    const manifest = await this.loadCheckpointManifest(input.checkpointId);
    if (manifest.checkpointId !== input.checkpointId) {
      throw new Error(`Checkpoint manifest identity mismatch for ${input.checkpointId}.`);
    }
    if (manifest.sessionSnapshot.sessionId !== input.sessionId) {
      throw new Error(`Checkpoint ${input.checkpointId} does not belong to session ${input.sessionId}.`);
    }

    const restoredFiles: string[] = [];
    let restoredEventCount: number | undefined;

    if (input.mode === "code" || input.mode === "both") {
      if (!Array.isArray(manifest.trackedFiles) || (manifest.version !== undefined && manifest.version !== 2)) {
        throw new Error(`Checkpoint ${input.checkpointId} has an unsupported manifest.`);
      }
      const checkpointRoot = path.join(this.paths.checkpointsDir, input.checkpointId);
      const prepared: Array<{
        relativePath: string;
        snapshotPath: string;
        targetPath: string;
        existed: boolean;
        kind: "file" | "directory";
      }> = [];
      const snapshotBudget: CheckpointTreeBudget = { entries: 0, bytes: 0 };
      const currentBudget: CheckpointTreeBudget = { entries: 0, bytes: 0 };

      // Validate every entry before changing any workspace path. This keeps a
      // malformed second entry from causing a deterministic half-restore.
      for (const entry of manifest.trackedFiles) {
        if (!entry || typeof entry.path !== "string" || typeof entry.existed !== "boolean") {
          throw new Error(`Checkpoint ${input.checkpointId} contains an invalid tracked entry.`);
        }
        if (entry.kind !== undefined && entry.kind !== "file" && entry.kind !== "directory") {
          throw new Error(`Checkpoint ${input.checkpointId} contains an invalid tracked entry kind.`);
        }
        const relativePath = normalizeCheckpointPath(this.workspaceRoot, entry.path);
        if (entry.snapshotPath !== undefined && typeof entry.snapshotPath !== "string") {
          throw new Error(`Checkpoint ${input.checkpointId} contains an invalid snapshot path.`);
        }
        const snapshotPath = path.resolve(checkpointRoot, entry.snapshotPath ?? relativePath);
        const targetPath = path.resolve(this.workspaceRoot, relativePath);
        assertPathInside(checkpointRoot, snapshotPath, "Checkpoint snapshot path");
        await assertNoSymlinkComponents(this.workspaceRoot, targetPath, "Checkpoint restore path");
        const kind = entry.kind ?? "file";
        if (entry.existed) {
          await assertNoSymlinkComponents(checkpointRoot, snapshotPath, "Checkpoint snapshot path");
          await inspectCheckpointTree(snapshotPath, snapshotBudget, `Checkpoint snapshot ${relativePath}`);
          const snapshotStat = await fs.lstat(snapshotPath);
          if (kind === "directory" && !snapshotStat.isDirectory()) {
            throw new Error(`Checkpoint snapshot type mismatch for ${relativePath}.`);
          }
          if (kind === "file" && !snapshotStat.isFile()) {
            throw new Error(`Checkpoint snapshot type mismatch for ${relativePath}.`);
          }
        }
        if (await exists(targetPath)) {
          await inspectCheckpointTree(targetPath, currentBudget, `Current restore target ${relativePath}`);
        }
        prepared.push({ relativePath, snapshotPath, targetPath, existed: entry.existed, kind });
      }

      const restoreCopyBudget: CheckpointTreeBudget = { entries: 0, bytes: 0 };
      for (const entry of prepared) {
        if (await exists(entry.targetPath)) {
          await fs.rm(entry.targetPath, { recursive: true, force: true });
        }
        if (entry.existed) {
          await fs.mkdir(path.dirname(entry.targetPath), { recursive: true });
          await copyCheckpointTree(
            entry.snapshotPath,
            entry.targetPath,
            restoreCopyBudget,
            `Checkpoint snapshot ${entry.relativePath}`,
          );
        }
        restoredFiles.push(entry.relativePath);
      }
    }

    if (input.mode === "conversation" || input.mode === "both") {
      const jsonlPath = this.getSessionJsonlPath(input.sessionId);
      const lines = (await fs.readFile(jsonlPath, "utf8"))
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, manifest.sessionEventCount);
      await fs.writeFile(jsonlPath, lines.map((line) => `${line}\n`).join(""), "utf8");
      restoredEventCount = manifest.sessionEventCount;
      await this.updateSession(input.sessionId, () => ({
        ...manifest.sessionSnapshot,
        activeTurnId: undefined,
      }));
    }

    const record: RollbackRecord = {
      recordType: "rollback",
      rollbackId: randomUUID(),
      sessionId: input.sessionId,
      createdAt: now(),
      checkpointId: input.checkpointId,
      mode: input.mode,
      restoredFiles,
      restoredEventCount,
      reason: input.reason,
    };
    await this.recordRollback(record);
    return record;
  }

  public async listUndoCandidates(sessionId: string): Promise<CheckpointRecord[]> {
    const events = await this.loadEvents(sessionId);
    const restored = new Set(
      events
        .filter((event): event is RollbackRecord => event.recordType === "rollback")
        .map((event) => event.checkpointId),
    );
    return events
      .filter(
        (event): event is CheckpointRecord =>
          event.recordType === "checkpoint" &&
          (event.scope === "pre_patch" ||
            event.scope === "pre_tool_write" ||
            event.scope === "manual_undo_anchor") &&
          !restored.has(event.checkpointId),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  public async scanCheckpointCatalog(sessionId: string): Promise<LifecycleCatalogScan<CheckpointSummary>> {
    const session = await this.loadSession(sessionId);
    if (!session) throw new Error(`Unknown session for checkpoint catalog: ${sessionId}`);

    const scan = await readJsonlTailTolerant(this.paths.storageRoot, this.getSessionJsonlPath(sessionId));
    const warnings = [...scan.warnings];
    const restored = new Set<string>();
    for (const raw of scan.records) {
      if (!raw || typeof raw !== "object") continue;
      const candidate = raw as Partial<RollbackRecord> & { recordType?: unknown };
      if (
        candidate.recordType === "rollback" &&
        candidate.sessionId === sessionId &&
        typeof candidate.checkpointId === "string"
      ) {
        restored.add(candidate.checkpointId);
      }
    }

    const validScopes = new Set<CheckpointScope>([
      "pre_patch",
      "post_patch",
      "pre_tool_batch",
      "pre_tool_write",
      "manual_undo_anchor",
    ]);
    const items: CheckpointSummary[] = [];
    for (const raw of scan.records) {
      if (!raw || typeof raw !== "object") continue;
      const candidate = raw as Partial<CheckpointRecord> & { recordType?: unknown };
      if (candidate.recordType !== "checkpoint") continue;

      const checkpointId = typeof candidate.checkpointId === "string" ? candidate.checkpointId : "";
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(checkpointId)) {
        warnings.push({
          code: "corrupt_record",
          message: "A checkpoint with an unsafe or missing identifier was skipped.",
        });
        continue;
      }
      if (candidate.sessionId !== sessionId) {
        warnings.push({
          code: "corrupt_record",
          message: "A checkpoint whose session ownership did not match its event stream was hidden.",
          recordId: checkpointId,
        });
        continue;
      }
      if (candidate.workspaceId && candidate.workspaceId !== this.workspaceId) {
        warnings.push({
          code: "corrupt_record",
          message: "A checkpoint owned by another workspace was hidden.",
          recordId: checkpointId,
        });
        continue;
      }
      if (!candidate.scope || !validScopes.has(candidate.scope)) {
        warnings.push({
          code: "corrupt_record",
          message: "A checkpoint with an unsupported scope was skipped.",
          recordId: checkpointId,
        });
        continue;
      }

      const recordWarnings: LifecycleWarning[] = [];
      if (!candidate.workspaceId) {
        recordWarnings.push({
          code: "legacy_record",
          message: "Workspace ownership was inferred from the workspace-scoped session store.",
          recordId: checkpointId,
        });
      }
      const createdAt =
        typeof candidate.createdAt === "string" && Number.isFinite(Date.parse(candidate.createdAt))
          ? candidate.createdAt
          : "1970-01-01T00:00:00.000Z";
      if (createdAt !== candidate.createdAt) {
        recordWarnings.push({
          code: "missing_field",
          message: "Checkpoint creation time was missing or invalid; a stable legacy fallback was used.",
          recordId: checkpointId,
        });
      }

      let manifest: CheckpointManifest | undefined;
      let status: CheckpointSummary["status"] = "available";
      try {
        manifest = await this.loadCheckpointManifest(checkpointId);
        if (
          manifest.checkpointId !== checkpointId ||
          manifest.sessionSnapshot?.sessionId !== sessionId ||
          !Array.isArray(manifest.trackedFiles)
        ) {
          throw new Error("Checkpoint manifest ownership or shape mismatch.");
        }
        if (manifest.version !== 2) {
          recordWarnings.push({
            code: "legacy_record",
            message: "Legacy checkpoint manifest fields were interpreted read-only.",
            recordId: checkpointId,
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          status = "missing";
          recordWarnings.push({
            code: "missing_payload",
            message: "Checkpoint manifest is missing.",
            recordId: checkpointId,
          });
        } else {
          status = "corrupt";
          recordWarnings.push({
            code: "corrupt_record",
            message: "Checkpoint manifest could not be safely parsed or did not match its owner.",
            recordId: checkpointId,
          });
        }
      }
      if (status === "available" && restored.has(checkpointId)) status = "restored";

      const rawPaths = Array.isArray(candidate.trackedFiles)
        ? candidate.trackedFiles.filter((entry): entry is string => typeof entry === "string")
        : manifest?.trackedFiles.map((entry) => entry.path) ?? [];
      const affectedPaths = rawPaths.map((entry) => {
        if (!isProtectedLifecyclePath(entry)) return entry.replace(/\\/gu, "/");
        if (!recordWarnings.some((warning) => warning.code === "content_redacted")) {
          recordWarnings.push({
            code: "content_redacted",
            message: "A protected checkpoint path was redacted.",
            recordId: checkpointId,
          });
        }
        return "[protected]";
      });

      const summary: CheckpointSummary = {
        checkpointId,
        sessionId,
        turnId: typeof candidate.turnId === "string" ? candidate.turnId : undefined,
        toolCallId: typeof candidate.toolCallId === "string" ? candidate.toolCallId : undefined,
        sourceToolName: typeof candidate.sourceToolName === "string" ? candidate.sourceToolName : undefined,
        createdAt,
        reason: redactLifecycleText(
          typeof candidate.reason === "string" ? candidate.reason : "Legacy checkpoint",
          this.workspaceRoot,
        ),
        scope: candidate.scope,
        affectedPaths,
        status,
        recoverable: status === "available",
        ownership: {
          workspaceId: this.workspaceId,
          sessionId,
          visibility: candidate.workspaceId ? "current_session" : "legacy_inferred",
        },
        partial: recordWarnings.length > 0,
        warnings: recordWarnings,
      };
      items.push(summary);
      warnings.push(...recordWarnings);
    }

    return {
      items,
      scanned: scan.scanned,
      partial: scan.partial || items.some((item) => item.partial),
      warnings: boundedLifecycleWarnings(warnings),
    };
  }

  public async createWorkerSession(input: {
    parentSessionId: string;
    task: WorkerTask;
    route: WorkerSessionRecord["route"];
    modelAssignment?: WorkerSessionRecord["modelAssignment"];
    timeoutMs: number;
    maxRetries: number;
    dispatchKind?: WorkerDispatchKind;
    retryOfWorkerSessionId?: string;
    reviseOfWorkerSessionId?: string;
  }): Promise<WorkerSessionRecord> {
    await this.ensureInitialized();
    if (!(await this.loadSession(input.parentSessionId))) {
      throw new Error(`Unknown parent session for worker: ${input.parentSessionId}`);
    }
    const createdAt = now();
    const workerSessionId = randomUUID();
    const record: WorkerSessionRecord = {
      workerSessionId,
      workspaceId: this.workspaceId,
      parentSessionId: input.parentSessionId,
      workerType: input.task.workerType,
      route: input.route,
      modelAssignment: input.modelAssignment,
      status: "queued",
      statusVersion: 0,
      dispatchKind: input.dispatchKind ?? "initial",
      createdAt,
      updatedAt: createdAt,
      objective: input.task.objective,
      constraints: input.task.constraints,
      contextRefs: input.task.contextRefs,
      expectedOutput: input.task.expectedOutput,
      acceptanceChecks: input.task.acceptanceChecks,
      timeoutMs: input.timeoutMs,
      maxRetries: input.maxRetries,
      retryCount: 0,
      revisionCount: 0,
      messageCount: 0,
      artifactCount: 0,
      jsonlPath: `worker-sessions/${workerSessionId}.jsonl`,
      retryOfWorkerSessionId: input.retryOfWorkerSessionId,
      reviseOfWorkerSessionId: input.reviseOfWorkerSessionId,
    };

    await writeJsonAtomic(this.getWorkerSessionMetaPath(workerSessionId), record);
    await fs.writeFile(this.getWorkerSessionJsonlPath(workerSessionId), "", "utf8");
    await this.linkWorkerSession(record.parentSessionId, {
      workerSessionId,
      workerType: record.workerType,
      dispatchKind: record.dispatchKind,
      status: record.status,
    });
    await this.appendWorkerEvent(workerSessionId, {
      recordType: "worker_status",
      workerSessionId,
      workspaceId: this.workspaceId,
      parentSessionId: input.parentSessionId,
      createdAt,
      status: "queued",
      dispatchKind: record.dispatchKind,
      attemptNumber: 0,
      reason: "Worker session created.",
    });
    return record;
  }

  public async loadWorkerSession(workerSessionId: string): Promise<WorkerSessionRecord | undefined> {
    const filePath = this.getWorkerSessionMetaPath(workerSessionId);
    let raw: Buffer | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!(await exists(filePath))) {
        if (attempt === 4) return undefined;
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      try {
        raw = await readBoundedVerifiedFile(
          this.paths.storageRoot,
          filePath,
          LIFECYCLE_METADATA_MAX_BYTES,
          "Worker session metadata",
        );
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const transientReplacement = (error as NodeJS.ErrnoException).code === "ENOENT"
          || message === "Worker session metadata identity changed before it could be read."
          || message === "Worker session metadata changed while it was being read.";
        if (!transientReplacement || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    if (!raw) return undefined;
    const record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as WorkerSessionRecord;
    return record.modelAssignment
      ? { ...record, modelAssignment: freezeAssignment(record.modelAssignment) }
      : record;
  }

  public async updateWorkerSession(
    workerSessionId: string,
    updater: (session: WorkerSessionRecord) => WorkerSessionRecord,
  ): Promise<WorkerSessionRecord> {
    return this.withWorkerSessionLock(workerSessionId, async () => {
      const current = await this.loadWorkerSession(workerSessionId);
      if (!current) {
        throw new Error(`Unknown worker session: ${workerSessionId}`);
      }
      const updated = updater(current);
      updated.updatedAt = now();
      await writeJsonAtomic(this.getWorkerSessionMetaPath(workerSessionId), updated);
      return updated;
    });
  }

  public async loadWorkerEvents(workerSessionId: string): Promise<WorkerSessionEvent[]> {
    const jsonlPath = this.getWorkerSessionJsonlPath(workerSessionId);
    if (!(await exists(jsonlPath))) {
      return [];
    }

    const content = await fs.readFile(jsonlPath, "utf8");
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WorkerSessionEvent);
  }

  public async scanWorkerLifecycleEvents(
    parentSessionId: string,
    workerSessionId: string,
  ): Promise<WorkerLifecycleEventScan> {
    if (!isSafeLifecycleId(parentSessionId) || !isSafeLifecycleId(workerSessionId)) {
      throw Object.assign(new Error("Worker lifecycle identity is unsafe."), {
        code: "ERR_TOOL_INVALID_ARGUMENTS",
      });
    }
    const warnings: LifecycleWarning[] = [];
    const workerScan = await readJsonlTailTolerant(
      this.paths.storageRoot,
      this.getWorkerSessionJsonlPath(workerSessionId),
    );
    warnings.push(...workerScan.warnings);
    const workerEvents: WorkerLifecycleEventScan["workerEvents"] = [];
    for (const raw of workerScan.records) {
      if (!raw || typeof raw !== "object") continue;
      const event = raw as Partial<WorkerSessionEvent> & { recordType?: unknown };
      if (event.recordType === "worker_message") continue;
      if (!event.recordType || !["worker_status", "worker_artifact", "worker_cancellation"].includes(event.recordType)) {
        continue;
      }
      if (
        event.workerSessionId !== workerSessionId ||
        ("workspaceId" in event && event.workspaceId && event.workspaceId !== this.workspaceId) ||
        ("parentSessionId" in event && event.parentSessionId && event.parentSessionId !== parentSessionId) ||
        typeof (event as { createdAt?: unknown }).createdAt !== "string" ||
        !Number.isFinite(Date.parse((event as { createdAt: string }).createdAt))
      ) {
        warnings.push({
          code: "corrupt_record",
          message: "A worker lifecycle event with invalid ownership or time was hidden.",
          recordId: workerSessionId,
        });
        continue;
      }
      if (event.recordType === "worker_status") {
        const status = event as Partial<WorkerStatusRecord>;
        if (
          !status.status ||
          !["queued", "running", "completed", "failed", "cancelled"].includes(status.status) ||
          !status.dispatchKind ||
          !["initial", "retry", "revise"].includes(status.dispatchKind) ||
          !Number.isSafeInteger(status.attemptNumber) ||
          (status.attemptNumber ?? -1) < 0 ||
          !isOptionalLifecycleString(status.reason)
        ) {
          warnings.push({ code: "corrupt_record", message: "A malformed worker status event was hidden.", recordId: workerSessionId });
          continue;
        }
        workerEvents.push(event as WorkerStatusRecord);
      } else if (event.recordType === "worker_artifact") {
        const artifact = event as Partial<WorkerArtifactRecord>;
        if (
          !isSafeLifecycleId(typeof artifact.artifactId === "string" ? artifact.artifactId : "") ||
          typeof artifact.artifactRef !== "string" ||
          !isValidWorkerArtifactSummary(artifact.summary)
        ) {
          warnings.push({ code: "corrupt_record", message: "A malformed worker artifact event was hidden.", recordId: workerSessionId });
          continue;
        }
        workerEvents.push(event as WorkerArtifactRecord);
      } else {
        const cancellation = event as Partial<WorkerCancellationRecord>;
        if (
          !isSafeLifecycleId(typeof cancellation.cancellationId === "string" ? cancellation.cancellationId : "") ||
          cancellation.workspaceId !== this.workspaceId ||
          cancellation.parentSessionId !== parentSessionId ||
          cancellation.requestedBySessionId !== parentSessionId ||
          typeof cancellation.reason !== "string" ||
          !cancellation.previousStatus || !["queued", "running", "completed", "failed", "cancelled"].includes(cancellation.previousStatus) ||
          !cancellation.finalStatus || !["queued", "running", "completed", "failed", "cancelled"].includes(cancellation.finalStatus) ||
          typeof cancellation.cancelled !== "boolean" ||
          typeof cancellation.idempotent !== "boolean" ||
          !Number.isSafeInteger(cancellation.artifactCountPreserved) ||
          (cancellation.artifactCountPreserved ?? -1) < 0
        ) {
          warnings.push({ code: "corrupt_record", message: "A malformed worker cancellation event was hidden.", recordId: workerSessionId });
          continue;
        }
        workerEvents.push(event as WorkerCancellationRecord);
      }
    }

    const parentScan = await readJsonlTailTolerant(
      this.paths.storageRoot,
      this.getSessionJsonlPath(parentSessionId),
    );
    warnings.push(...parentScan.warnings);
    const parentEvents: WorkerLifecycleEventScan["parentEvents"] = [];
    let linkedFromParentSession = false;
    for (const raw of parentScan.records) {
      if (!raw || typeof raw !== "object") continue;
      const event = raw as Record<string, unknown> & { recordType?: unknown };
      if (
        event.recordType === "worker_session_link" &&
        event.sessionId === parentSessionId &&
        event.workerSessionId === workerSessionId
      ) {
        linkedFromParentSession = true;
        continue;
      }
      if (event.recordType !== "supervisor_decision" && event.recordType !== "artifact_promotion") continue;
      if (event.sessionId !== parentSessionId || event.workerSessionId !== workerSessionId) continue;
      if (typeof event.createdAt !== "string" || !Number.isFinite(Date.parse(event.createdAt))) {
        warnings.push({ code: "corrupt_record", message: "A worker parent lifecycle event had an invalid time.", recordId: workerSessionId });
        continue;
      }
      if (event.recordType === "supervisor_decision") {
        if (!isValidSupervisorDecisionEvent(event)) {
          warnings.push({ code: "corrupt_record", message: "A malformed supervisor decision was hidden.", recordId: workerSessionId });
          continue;
        }
        parentEvents.push(event as unknown as SupervisorDecisionRecord);
      } else if (event.recordType === "artifact_promotion") {
        if (!isValidArtifactPromotionEvent(event)) {
          warnings.push({ code: "corrupt_record", message: "A malformed artifact promotion was hidden.", recordId: workerSessionId });
          continue;
        }
        parentEvents.push(event as unknown as ArtifactPromotionRecord);
      }
    }
    return {
      workerEvents,
      parentEvents,
      linkedFromParentSession,
      scanned: workerScan.scanned + parentScan.scanned,
      partial: workerScan.partial || parentScan.partial || warnings.some((warning) => warning.code === "corrupt_record"),
      warnings: boundedLifecycleWarnings(warnings),
    };
  }

  public async appendWorkerEvent(workerSessionId: string, event: WorkerSessionEvent): Promise<void> {
    if (!isSafeLifecycleId(workerSessionId) || event.workerSessionId !== workerSessionId) {
      throw new Error("Worker event identity is unsafe or mismatched.");
    }
    const jsonlPath = this.getWorkerSessionJsonlPath(workerSessionId);
    await fs.appendFile(jsonlPath, `${JSON.stringify(event)}\n`, "utf8");
  }

  public async appendWorkerMessage(input: {
    workerSessionId: string;
    role: WorkerMessageRecord["role"];
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<WorkerMessageRecord> {
    const message: WorkerMessageRecord = {
      recordType: "worker_message",
      workerSessionId: input.workerSessionId,
      createdAt: now(),
      role: input.role,
      content: input.content,
      metadata: input.metadata,
    };
    await this.appendWorkerEvent(input.workerSessionId, message);
    await this.updateWorkerSession(input.workerSessionId, (session) => ({
      ...session,
      messageCount: session.messageCount + 1,
    }));
    return message;
  }

  public async setWorkerSessionStatus(input: {
    workerSessionId: string;
    status: WorkerSessionStatus;
    dispatchKind: WorkerDispatchKind;
    attemptNumber: number;
    reason?: string;
    errorType?: WorkerFailureType;
    errorMessage?: string;
  }): Promise<WorkerSessionRecord> {
    return (await this.transitionWorkerSessionStatus(input)).session;
  }

  public async transitionWorkerSessionStatus(input: {
    workerSessionId: string;
    status: WorkerSessionStatus;
    dispatchKind: WorkerDispatchKind;
    attemptNumber: number;
    reason?: string;
    errorType?: WorkerFailureType;
    errorMessage?: string;
    expectedStatusVersion?: number;
  }): Promise<WorkerStatusTransitionResult> {
    return this.withWorkerSessionLock(input.workerSessionId, async () => {
      const current = await this.loadWorkerSession(input.workerSessionId);
      if (!current) throw new Error(`Unknown worker session: ${input.workerSessionId}`);
      const previousStatus = current.status;
      const currentVersion = current.statusVersion ?? 0;
      if (input.expectedStatusVersion !== undefined && input.expectedStatusVersion !== currentVersion) {
        throw Object.assign(new Error("Worker status changed before the requested transition."), {
          code: "ERR_TOOL_CONFLICTED",
        });
      }
      const previousTerminal = ["completed", "failed", "cancelled"].includes(previousStatus);
      const explicitReopen = input.status === "running" &&
        ((previousStatus === "completed" && (input.dispatchKind === "revise" || input.dispatchKind === "retry")) ||
          (previousStatus === "failed" && input.dispatchKind === "retry"));
      if ((previousTerminal && !explicitReopen) || previousStatus === input.status && previousTerminal) {
        return { session: current, previousStatus, changed: false };
      }

      const event: WorkerStatusRecord = {
        recordType: "worker_status",
        workerSessionId: input.workerSessionId,
        workspaceId: this.workspaceId,
        parentSessionId: current.parentSessionId,
        createdAt: now(),
        status: input.status,
        dispatchKind: input.dispatchKind,
        attemptNumber: input.attemptNumber,
        reason: input.reason?.slice(0, 4_000),
      };
      const updated: WorkerSessionRecord = {
        ...current,
        status: input.status,
        statusVersion: currentVersion + 1,
        dispatchKind: input.dispatchKind,
        updatedAt: event.createdAt,
        startedAt: input.status === "running" ? current.startedAt ?? event.createdAt : current.startedAt,
        endedAt: input.status === "running"
          ? undefined
          : input.status === "completed" || input.status === "failed" || input.status === "cancelled"
            ? event.createdAt
            : current.endedAt,
        retryCount:
          input.dispatchKind === "retry" && input.status === "running" ? current.retryCount + 1 : current.retryCount,
        revisionCount:
          input.dispatchKind === "revise" && input.status === "running" ? current.revisionCount + 1 : current.revisionCount,
        lastErrorType: input.errorType,
        lastErrorMessage: input.errorMessage?.slice(0, 4_000),
      };
      await this.appendWorkerEvent(input.workerSessionId, event);
      await writeJsonAtomic(this.getWorkerSessionMetaPath(input.workerSessionId), updated);
      return { session: updated, previousStatus, changed: true };
    });
  }

  public async cancelOwnedWorkerSession(input: {
    workerSessionId: string;
    parentSessionId: string;
    requestedBySessionId: string;
    requestedAt: string;
    reason: string;
    expectedStatusVersion?: number;
  }): Promise<WorkerCancellationTransitionResult> {
    return this.withWorkerSessionLock(input.workerSessionId, async () => {
      const current = await this.loadWorkerSession(input.workerSessionId);
      if (!current) throw Object.assign(new Error("Worker session was not found."), { code: "ERR_TOOL_NOT_FOUND" });
      if (current.parentSessionId !== input.parentSessionId || input.requestedBySessionId !== input.parentSessionId) {
        throw Object.assign(new Error("Worker session is not owned by the requesting session."), {
          code: "ERR_TOOL_PERMISSION_DENIED",
        });
      }
      if (current.workspaceId && current.workspaceId !== this.workspaceId) {
        throw Object.assign(new Error("Worker session belongs to another workspace."), {
          code: "ERR_TOOL_PERMISSION_DENIED",
        });
      }
      const previousStatus = current.status;
      const currentVersion = current.statusVersion ?? 0;
      if (
        input.expectedStatusVersion !== undefined &&
        input.expectedStatusVersion !== currentVersion &&
        (previousStatus === "queued" || previousStatus === "running")
      ) {
        throw Object.assign(new Error("Worker status changed after cancellation approval."), {
          code: "ERR_TOOL_CONFLICTED",
        });
      }
      const changed = previousStatus === "queued" || previousStatus === "running";
      const finalStatus: WorkerSessionStatus = changed ? "cancelled" : previousStatus;
      const reason = redactLifecycleText(input.reason, this.workspaceRoot).slice(0, 1_000);
      let session = current;
      if (changed) {
        const statusEvent: WorkerStatusRecord = {
          recordType: "worker_status",
          workerSessionId: input.workerSessionId,
          workspaceId: this.workspaceId,
          parentSessionId: current.parentSessionId,
          createdAt: input.requestedAt,
          status: "cancelled",
          dispatchKind: current.dispatchKind,
          attemptNumber: current.retryCount + current.revisionCount + 1,
          reason,
        };
        session = {
          ...current,
          status: "cancelled",
          statusVersion: currentVersion + 1,
          updatedAt: input.requestedAt,
          endedAt: input.requestedAt,
          lastErrorType: "worker_interrupted",
          lastErrorMessage: reason,
        };
        await this.appendWorkerEvent(input.workerSessionId, statusEvent);
        await writeJsonAtomic(this.getWorkerSessionMetaPath(input.workerSessionId), session);
      }
      const record: WorkerCancellationRecord = {
        recordType: "worker_cancellation",
        cancellationId: randomUUID(),
        workerSessionId: input.workerSessionId,
        workspaceId: this.workspaceId,
        parentSessionId: current.parentSessionId,
        createdAt: input.requestedAt,
        requestedBySessionId: input.requestedBySessionId,
        reason,
        previousStatus,
        finalStatus,
        cancelled: finalStatus === "cancelled",
        idempotent: !changed,
        artifactCountPreserved: session.artifactCount,
      };
      await this.appendWorkerEvent(input.workerSessionId, record);
      return { session, previousStatus, changed, record };
    });
  }

  public async storeCodeArtifact(input: {
    workerSessionId: string;
    artifact: Omit<CodeArtifact, "patchRef">;
    patchContent: string;
  }): Promise<WorkerArtifactRecord> {
    const artifactId = randomUUID();
    const workerPatchDir = path.join(this.paths.artifactPatchesDir, input.workerSessionId);
    await fs.mkdir(workerPatchDir, { recursive: true });
    await fs.mkdir(this.paths.artifactRecordsDir, { recursive: true });
    const patchRelativePath = `patches/${input.workerSessionId}/${artifactId}.patch`;
    const patchRef = ensureArtifactPatchRef(`artifact://${patchRelativePath}`);
    const patchPath = path.join(this.paths.workerArtifactsDir, patchRelativePath);
    await fs.mkdir(path.dirname(patchPath), { recursive: true });
    await fs.writeFile(patchPath, input.patchContent, "utf8");

    const artifact = validateCodeArtifact({
      ...input.artifact,
      kind: "code_artifact",
      patchRef,
    });
    const summary = toCodeArtifactSummary(artifact);
    const record: WorkerArtifactRecord = {
      recordType: "worker_artifact",
      workerSessionId: input.workerSessionId,
      workspaceId: this.workspaceId,
      parentSessionId: (await this.loadWorkerSession(input.workerSessionId))?.parentSessionId,
      artifactId,
      createdAt: now(),
      artifactRef: `artifact://records/${artifactId}.json`,
      summary,
    };

    await writeJsonAtomic(path.join(this.paths.artifactRecordsDir, `${artifactId}.json`), artifact);
    await this.appendWorkerEvent(input.workerSessionId, record);
    await this.updateWorkerSession(input.workerSessionId, (session) => ({
      ...session,
      artifactCount: session.artifactCount + 1,
    }));
    return record;
  }

  public async storeVisionArtifact(input: {
    workerSessionId: string;
    artifact: VisionArtifact;
  }): Promise<WorkerArtifactRecord> {
    const artifactId = randomUUID();
    const artifact = validateVisionArtifact(input.artifact);
    const record: WorkerArtifactRecord = {
      recordType: "worker_artifact",
      workerSessionId: input.workerSessionId,
      workspaceId: this.workspaceId,
      parentSessionId: (await this.loadWorkerSession(input.workerSessionId))?.parentSessionId,
      artifactId,
      createdAt: now(),
      artifactRef: `artifact://records/${artifactId}.json`,
      summary: summarizeVisionArtifact(artifact),
    };

    await writeJsonAtomic(path.join(this.paths.artifactRecordsDir, `${artifactId}.json`), artifact);
    await this.appendWorkerEvent(input.workerSessionId, record);
    await this.updateWorkerSession(input.workerSessionId, (session) => ({
      ...session,
      artifactCount: session.artifactCount + 1,
    }));
    return record;
  }

  public async storeBinaryArtifact(input: {
    workerSessionId: string;
    namespace: string;
    filename: string;
    content: Uint8Array;
  }): Promise<{ artifactRef: string; absolutePath: string }> {
    const namespace = sanitizeToolOutputFilename(input.namespace).replace(/\./g, "_");
    const workerSessionId = sanitizeToolOutputFilename(input.workerSessionId);
    const directory = path.join(this.paths.workerArtifactsDir, namespace, workerSessionId);
    const absolutePath = await resolveStableOutputPath(directory, input.filename);
    assertPathInside(this.paths.workerArtifactsDir, absolutePath, "Worker binary artifact path");
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, input.content);
    const relativePath = toRelative(this.paths.workerArtifactsDir, absolutePath);
    return {
      artifactRef: `artifact://${relativePath}`,
      absolutePath,
    };
  }

  public async storeToolOutputArtifact(input: {
    sessionId: string;
    namespace?: string;
    turnId?: string;
    toolCallId: string;
    sourceToolName: string;
    fileName: string;
    mimeType: string;
    kind: ToolOutputArtifact["kind"];
    summary: string;
    content: string | Uint8Array;
    signal?: AbortSignal;
  }): Promise<ToolOutputArtifact> {
    input.signal?.throwIfAborted();
    await this.ensureInitialized();
    input.signal?.throwIfAborted();
    const session = await this.loadSession(input.sessionId);
    if (!session) throw new Error(`Unknown session for tool output: ${input.sessionId}`);
    const sessionDirectory = path.join(
      this.paths.toolOutputsDir,
      ...(input.namespace ? [sanitizeToolOutputFilename(input.namespace)] : []),
      sanitizeToolOutputFilename(input.sessionId),
    );
    await ensureRealDirectory(this.paths.storageRoot, this.paths.toolOutputsDir, "Tool-output root");
    await ensureRealDirectory(this.paths.storageRoot, sessionDirectory, "Tool-output session directory");
    const stagedPath = path.join(sessionDirectory, `.deep-mix-tool-output-${randomUUID()}.tmp`);
    assertPathInside(this.paths.toolOutputsDir, stagedPath, "Tool output staging path");
    let absolutePath: string | undefined;
    let publicationIdentity: { device: number | bigint; inode: number | bigint } | undefined;
    try {
      await fs.writeFile(stagedPath, input.content, {
        flag: "wx",
        mode: 0o600,
        signal: input.signal,
      });
      input.signal?.throwIfAborted();
      await assertExistingRealDirectory(this.paths.storageRoot, sessionDirectory, "Tool-output session directory");
      const publication = await publishStagedOutput({
        directory: sessionDirectory,
        requestedName: input.fileName,
        stagedPath,
        trustedRoot: this.paths.toolOutputsDir,
      });
      absolutePath = publication.absolutePath;
      publicationIdentity = { device: publication.device, inode: publication.inode };
      await fs.unlink(stagedPath);
      const contentSize =
        typeof input.content === "string" ? Buffer.byteLength(input.content, "utf8") : input.content.byteLength;
      const contentSha256 = createHash("sha256").update(
        typeof input.content === "string" ? Buffer.from(input.content, "utf8") : input.content,
      ).digest("hex");
      const artifact: ToolOutputArtifact = {
        uri: `artifact://tool-outputs/${toRelative(this.paths.toolOutputsDir, absolutePath)}`,
        fileName: path.basename(absolutePath),
        mimeType: input.mimeType,
        sizeBytes: contentSize,
        sha256: contentSha256,
        kind: input.kind,
        sourceToolName: input.sourceToolName,
        summary: input.summary,
        createdAt: now(),
        workspaceId: this.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId ?? session.activeTurnId,
        toolCallId: input.toolCallId,
      };
      await this.recordToolOutputArtifact(artifact, publicationIdentity);
      return artifact;
    } catch (error) {
      await fs.rm(stagedPath, { force: true }).catch(() => undefined);
      if (absolutePath) await removeFileIfIdentity(absolutePath, publicationIdentity).catch(() => undefined);
      throw error;
    }
  }

  public async storeToolOutputArtifactFromFile(input: {
    sessionId: string;
    namespace?: string;
    turnId?: string;
    toolCallId: string;
    sourceToolName: string;
    fileName: string;
    mimeType: string;
    kind: ToolOutputArtifact["kind"];
    summary: string;
    sourcePath: string;
    maxBytes?: number;
    expectedSizeBytes?: number;
    expectedSha256?: string;
    signal?: AbortSignal;
  }): Promise<ToolOutputArtifact> {
    input.signal?.throwIfAborted();
    await this.ensureInitialized();
    input.signal?.throwIfAborted();
    const session = await this.loadSession(input.sessionId);
    if (!session) throw new Error(`Unknown session for tool output: ${input.sessionId}`);
    const sourceStat = await fs.lstat(input.sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error("Tool output source must be a regular file.");
    }
    if (input.maxBytes !== undefined && sourceStat.size > input.maxBytes) {
      throw new Error(`Tool output exceeded ${input.maxBytes} bytes.`);
    }
    const sessionDirectory = path.join(
      this.paths.toolOutputsDir,
      ...(input.namespace ? [sanitizeToolOutputFilename(input.namespace)] : []),
      sanitizeToolOutputFilename(input.sessionId),
    );
    await ensureRealDirectory(this.paths.storageRoot, this.paths.toolOutputsDir, "Tool-output root");
    await ensureRealDirectory(this.paths.storageRoot, sessionDirectory, "Tool-output session directory");
    const stagedPath = path.join(sessionDirectory, `.deep-mix-tool-output-${randomUUID()}.tmp`);
    assertPathInside(this.paths.toolOutputsDir, stagedPath, "Tool output staging path");
    let absolutePath: string | undefined;
    let publicationIdentity: { device: number | bigint; inode: number | bigint } | undefined;
    try {
      let copiedBytes = 0;
      const copiedHash = createHash("sha256");
      const enforceCopyLimit = new Transform({
        transform(chunk, _encoding, callback) {
          copiedBytes += Buffer.byteLength(chunk);
          if (input.maxBytes !== undefined && copiedBytes > input.maxBytes) {
            callback(new Error(`Tool output exceeded ${input.maxBytes} bytes.`));
            return;
          }
          copiedHash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        createReadStream(input.sourcePath),
        enforceCopyLimit,
        createWriteStream(stagedPath, { flags: "wx", mode: 0o600 }),
        { signal: input.signal },
      );
      input.signal?.throwIfAborted();
      const stagedStat = await fs.stat(stagedPath);
      if (input.maxBytes !== undefined && stagedStat.size > input.maxBytes) {
        throw new Error(`Tool output exceeded ${input.maxBytes} bytes.`);
      }
      if (input.expectedSizeBytes !== undefined && stagedStat.size !== input.expectedSizeBytes) {
        throw new Error("Tool output source size changed during staging.");
      }
      const stagedSha256 = copiedHash.digest("hex");
      if (input.expectedSha256 !== undefined && stagedSha256 !== input.expectedSha256) {
        throw new Error("Tool output source hash changed during staging.");
      }
      input.signal?.throwIfAborted();
      await assertExistingRealDirectory(this.paths.storageRoot, sessionDirectory, "Tool-output session directory");
      const publication = await publishStagedOutput({
        directory: sessionDirectory,
        requestedName: input.fileName,
        stagedPath,
        trustedRoot: this.paths.toolOutputsDir,
      });
      absolutePath = publication.absolutePath;
      publicationIdentity = { device: publication.device, inode: publication.inode };
      await fs.unlink(stagedPath);
      const artifact: ToolOutputArtifact = {
        uri: `artifact://tool-outputs/${toRelative(this.paths.toolOutputsDir, absolutePath)}`,
        fileName: path.basename(absolutePath),
        mimeType: input.mimeType,
        sizeBytes: stagedStat.size,
        sha256: stagedSha256,
        kind: input.kind,
        sourceToolName: input.sourceToolName,
        summary: input.summary,
        createdAt: now(),
        workspaceId: this.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId ?? session.activeTurnId,
        toolCallId: input.toolCallId,
      };
      await this.recordToolOutputArtifact(artifact, publicationIdentity);
      return artifact;
    } catch (error) {
      await fs.rm(stagedPath, { force: true }).catch(() => undefined);
      if (absolutePath) await removeFileIfIdentity(absolutePath, publicationIdentity).catch(() => undefined);
      throw error;
    }
  }

  public async recordToolOutputArtifact(
    input: ToolOutputArtifact,
    expectedIdentity?: { device: number | bigint; inode: number | bigint },
  ): Promise<ToolOutputArtifact> {
    await this.ensureInitialized();
    if (!input.sessionId || !input.toolCallId) {
      throw new Error("Tool output artifact requires sessionId and toolCallId.");
    }
    const session = await this.loadSession(input.sessionId);
    if (!session) throw new Error(`Unknown session for tool output: ${input.sessionId}`);
    if (input.workspaceId && input.workspaceId !== this.workspaceId) {
      throw new Error("Tool output artifact workspace ownership mismatch.");
    }
    const recordDirectory = path.join(
      this.paths.toolOutputRecordsDir,
      sanitizeToolOutputFilename(input.sessionId),
    );
    await ensureRealDirectory(this.paths.storageRoot, this.paths.toolOutputRecordsDir, "Tool-output record root");
    await ensureRealDirectory(this.paths.storageRoot, recordDirectory, "Tool-output record session directory");
    const existing = await this.listToolOutputArtifacts(input.sessionId);
    const prior = existing.find(
      (artifact) => artifact.uri === input.uri && artifact.toolCallId === input.toolCallId,
    );
    if (prior) return prior;
    const absolutePath = this.resolveToolOutputArtifactPath(input.uri);
    if (input.uri.startsWith("artifact://tool-outputs/")) {
      await assertNoSymlinkComponents(this.paths.toolOutputsDir, absolutePath, "Tool output artifact path");
    }
    const fingerprint = await fingerprintRegularFile(absolutePath);
    if (
      expectedIdentity &&
      (fingerprint.device !== expectedIdentity.device || fingerprint.inode !== expectedIdentity.inode)
    ) {
      throw new Error("Tool output artifact identity changed before recording.");
    }
    if (input.sha256 && fingerprint.sha256 !== input.sha256) {
      throw new Error("Tool output artifact hash changed before recording.");
    }
    const normalized: ToolOutputArtifact = {
      ...input,
      workspaceId: this.workspaceId,
      fileName: sanitizeToolOutputFilename(input.fileName),
      sizeBytes: fingerprint.sizeBytes ?? 0,
      sha256: fingerprint.sha256,
      createdAt: input.createdAt || now(),
      turnId: input.turnId ?? session.activeTurnId,
    };
    await writeJsonAtomic(path.join(recordDirectory, `${randomUUID()}.json`), normalized);
    return normalized;
  }

  public async listToolOutputArtifacts(sessionId: string): Promise<ToolOutputArtifact[]> {
    const recordDirectory = path.join(
      this.paths.toolOutputRecordsDir,
      sanitizeToolOutputFilename(sessionId),
    );
    if (!(await assertExistingRealDirectory(
      this.paths.storageRoot,
      recordDirectory,
      "Tool-output record session directory",
    ))) return [];
    const entries = await fs.readdir(recordDirectory, { withFileTypes: true });
    const artifacts: ToolOutputArtifact[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
      const handle = await fs.open(
        path.join(recordDirectory, entry.name),
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      let content: string;
      try {
        content = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
      artifacts.push(JSON.parse(content) as ToolOutputArtifact);
    }
    return artifacts.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  public async scanArtifactCatalog(sessionId: string): Promise<LifecycleCatalogScan<ArtifactSummary>> {
    if (!(await this.loadSession(sessionId))) {
      throw new Error(`Unknown session for artifact catalog: ${sessionId}`);
    }
    if (!isSafeLifecycleId(sessionId)) {
      throw Object.assign(new Error("Artifact catalog session identifier is unsafe."), {
        code: "ERR_TOOL_INVALID_ARGUMENTS",
      });
    }

    const warnings: LifecycleWarning[] = [];
    const items = new Map<string, ArtifactSummary>();
    let scanned = 0;
    let partial = false;
    const add = (summary: ArtifactSummary) => {
      const prior = items.get(summary.uri);
      if (!prior) {
        items.set(summary.uri, summary);
        return;
      }
      if (JSON.stringify(prior) === JSON.stringify(summary)) return;
      partial = true;
      const warning: LifecycleWarning = {
        code: "corrupt_record",
        message: "Conflicting metadata records referenced the same artifact URI; a deterministic record was retained.",
        recordId: summary.uri.slice(0, 512),
      };
      warnings.push(warning);
      const selected = JSON.stringify(prior).localeCompare(JSON.stringify(summary)) <= 0 ? prior : summary;
      items.set(summary.uri, {
        ...selected,
        partial: true,
        warnings: [...selected.warnings, warning],
      });
    };
    const inspect = async (trustedRoot: string, absolutePath: string, recordId: string) => {
      try {
        await assertNoSymlinkComponents(trustedRoot, absolutePath, "Lifecycle artifact path");
        const stat = await fs.lstat(absolutePath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Artifact is not a regular file.");
        return { exists: true as const, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
      } catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        warnings.push({
          code: missing ? "missing_payload" : "corrupt_record",
          message: missing ? "Artifact payload is missing." : "Artifact payload path is unsafe or invalid.",
          recordId,
        });
        partial = true;
        return { exists: false as const, sizeBytes: 0, createdAt: "1970-01-01T00:00:00.000Z" };
      }
    };

    const sessionEventScan = await readJsonlTailTolerant(
      this.paths.storageRoot,
      this.getSessionJsonlPath(sessionId),
    );
    scanned += sessionEventScan.scanned;
    partial ||= sessionEventScan.partial;
    warnings.push(...sessionEventScan.warnings);
    const linkedWorkerIds = new Set(
      sessionEventScan.records.flatMap((record) => {
        if (!record || typeof record !== "object") return [];
        const event = record as Partial<WorkerSessionLinkRecord> & { recordType?: unknown };
        return event.recordType === "worker_session_link" &&
          event.sessionId === sessionId &&
          typeof event.workerSessionId === "string" &&
          isSafeLifecycleId(event.workerSessionId)
          ? [event.workerSessionId]
          : [];
      }),
    );

    const toolRecordDirectory = path.join(
      this.paths.toolOutputRecordsDir,
      sanitizeToolOutputFilename(sessionId),
    );
    const toolRecords = await readJsonDirectoryTolerant(
      this.paths.storageRoot,
      toolRecordDirectory,
      "tool-output artifact",
    );
    scanned += toolRecords.scanned;
    partial ||= toolRecords.partial;
    warnings.push(...toolRecords.warnings);
    const validToolKinds = new Set<ToolOutputArtifactKind>(["file", "document", "image", "text", "binary"]);
    for (const entry of toolRecords.entries) {
      const candidate = entry.value as Partial<ToolOutputArtifact>;
      const uri = typeof candidate.uri === "string" ? candidate.uri : "";
      if (
        candidate.sessionId !== sessionId ||
        !uri.startsWith("artifact://tool-outputs/") ||
        (candidate.workspaceId && candidate.workspaceId !== this.workspaceId)
      ) {
        partial = true;
        warnings.push({
          code: "corrupt_record",
          message: "A tool-output artifact with invalid ownership or namespace was hidden.",
          recordId: entry.fileName,
        });
        continue;
      }
      let uriParts: string[];
      try {
        const segments = canonicalArtifactUriSegments(uri, "tool-outputs");
        uriParts = segments.slice(1);
        if (uriParts.length < 2 || uriParts.length > 3 || uriParts.at(-2) !== sessionId) {
          throw new Error("Tool-output artifact URI is outside the current session namespace.");
        }
      } catch {
        partial = true;
        warnings.push({
          code: "unsupported_namespace",
          message: "A tool-output artifact URI did not carry the current session namespace and was hidden.",
          recordId: entry.fileName,
        });
        continue;
      }
      let absolutePath: string;
      try {
        absolutePath = this.resolveToolOutputArtifactPath(uri);
      } catch {
        partial = true;
        warnings.push({
          code: "unsupported_namespace",
          message: "A tool-output artifact URI could not be resolved safely.",
          recordId: entry.fileName,
        });
        continue;
      }
      const expectedDirectory = path.resolve(
        this.paths.toolOutputsDir,
        ...uriParts.slice(0, -1),
      );
      if (path.dirname(absolutePath) !== expectedDirectory) {
        partial = true;
        warnings.push({
          code: "unsupported_namespace",
          message: "A tool-output artifact URI escaped its exact session directory and was hidden.",
          recordId: entry.fileName,
        });
        continue;
      }
      const file = await inspect(this.paths.storageRoot, absolutePath, uri);
      const recordWarnings: LifecycleWarning[] = [];
      if (!candidate.workspaceId) {
        recordWarnings.push({
          code: "legacy_record",
          message: "Artifact workspace ownership was inferred from its session metadata partition.",
          recordId: uri,
        });
      }
      const kind = validToolKinds.has(candidate.kind as ToolOutputArtifactKind)
        ? candidate.kind as ToolOutputArtifactKind
        : "binary";
      if (kind !== candidate.kind) {
        recordWarnings.push({
          code: "missing_field",
          message: "Artifact kind was missing or invalid; binary-safe metadata mode was selected.",
          recordId: uri,
        });
      }
      const mimeType = typeof candidate.mimeType === "string" && candidate.mimeType
        ? redactLifecycleText(candidate.mimeType, this.workspaceRoot).slice(0, 255)
        : inferMimeTypeFromName(uriParts.at(-1)!);
      const recordedSize = typeof candidate.sizeBytes === "number" &&
        Number.isSafeInteger(candidate.sizeBytes) &&
        candidate.sizeBytes >= 0
        ? candidate.sizeBytes
        : undefined;
      if (recordedSize === undefined) {
        recordWarnings.push({
          code: "missing_field",
          message: "Artifact size metadata was missing or invalid and was inferred from the payload.",
          recordId: uri,
        });
      } else if (file.exists && recordedSize !== file.sizeBytes) {
        recordWarnings.push({
          code: "corrupt_record",
          message: "Artifact payload size no longer matches its trusted metadata.",
          recordId: uri,
        });
      }
      const sha256 = typeof candidate.sha256 === "string" && /^[a-f0-9]{64}$/iu.test(candidate.sha256)
        ? candidate.sha256.toLowerCase()
        : undefined;
      if (!sha256) {
        recordWarnings.push({
          code: typeof candidate.sha256 === "string" ? "corrupt_record" : "missing_field",
          message: typeof candidate.sha256 === "string"
            ? "Artifact hash metadata was malformed and could not be trusted."
            : "Legacy artifact has no recorded content hash.",
          recordId: uri,
        });
      }
      add({
        uri,
        name: redactLifecycleText(
          safeLifecycleName(candidate.fileName, uriParts.at(-1)!),
          this.workspaceRoot,
        ),
        source: "tool_output",
        artifactType: kind,
        mimeType,
        sizeBytes: recordedSize ?? file.sizeBytes,
        sha256,
        createdAt:
          typeof candidate.createdAt === "string" && Number.isFinite(Date.parse(candidate.createdAt))
            ? candidate.createdAt
            : file.createdAt,
        summary: redactLifecycleText(
          typeof candidate.summary === "string" ? candidate.summary : "Tool output artifact",
          this.workspaceRoot,
        ),
        readMode: inferArtifactReadMode(mimeType, kind),
        sourceToolName:
          typeof candidate.sourceToolName === "string"
            ? redactLifecycleText(candidate.sourceToolName, this.workspaceRoot).slice(0, 128)
            : undefined,
        ownership: {
          workspaceId: this.workspaceId,
          sessionId,
          visibility: candidate.workspaceId ? "current_session" : "legacy_inferred",
        },
        partial: !file.exists || recordWarnings.length > 0,
        warnings: recordWarnings,
      });
      warnings.push(...recordWarnings);
    }

    const workerMeta = await readJsonDirectoryTolerant(
      this.paths.storageRoot,
      this.paths.workerSessionsDir,
      "worker-session",
    );
    scanned += workerMeta.scanned;
    partial ||= workerMeta.partial;
    warnings.push(...workerMeta.warnings);
    let workerEventBytes = 0;
    let workerEventRecords = 0;
    for (const metaEntry of workerMeta.entries) {
      const worker = metaEntry.value as Partial<WorkerSessionRecord>;
      if (worker.parentSessionId !== sessionId) continue;
      const workerSessionId = typeof worker.workerSessionId === "string" ? worker.workerSessionId : "";
      if (
        !isSafeLifecycleId(workerSessionId) ||
        metaEntry.fileName !== `${workerSessionId}.json` ||
        !linkedWorkerIds.has(workerSessionId) ||
        (worker.workspaceId && worker.workspaceId !== this.workspaceId)
      ) {
        partial = true;
        warnings.push({
          code: "corrupt_record",
          message: "A worker session with invalid identity or workspace ownership was hidden.",
          recordId: metaEntry.fileName,
        });
        continue;
      }
      const remainingEventBytes = Math.max(0, LIFECYCLE_JSONL_MAX_BYTES * 2 - workerEventBytes);
      const remainingEventRecords = Math.max(0, LIFECYCLE_JSONL_MAX_RECORDS - workerEventRecords);
      if (remainingEventBytes === 0 || remainingEventRecords === 0) {
        partial = true;
        warnings.push({
          code: "scan_limit_reached",
          message: "Artifact discovery stopped at the global worker-event scan budget.",
        });
        break;
      }
      const workerEvents = await readJsonlTailTolerant(
        this.paths.storageRoot,
        this.getWorkerSessionJsonlPath(workerSessionId),
        remainingEventBytes,
        remainingEventRecords,
      );
      workerEventBytes += workerEvents.bytesRead;
      workerEventRecords += workerEvents.scanned;
      scanned += workerEvents.scanned;
      partial ||= workerEvents.partial;
      warnings.push(...workerEvents.warnings);
      for (const rawEvent of workerEvents.records) {
        if (!rawEvent || typeof rawEvent !== "object") continue;
        const event = rawEvent as Partial<WorkerArtifactRecord> & { recordType?: unknown };
        if (event.recordType !== "worker_artifact") continue;
        if (
          event.workerSessionId !== workerSessionId ||
          (event.parentSessionId && event.parentSessionId !== sessionId) ||
          (event.workspaceId && event.workspaceId !== this.workspaceId)
        ) {
          partial = true;
          warnings.push({
            code: "corrupt_record",
            message: "A worker artifact whose ownership did not match its worker session was hidden.",
          });
          continue;
        }
        const artifactId = typeof event.artifactId === "string" ? event.artifactId : "";
        const artifactRef = typeof event.artifactRef === "string" ? event.artifactRef : "";
        if (
          !isSafeLifecycleId(artifactId) ||
          artifactRef !== `artifact://records/${artifactId}.json`
        ) {
          partial = true;
          warnings.push({
            code: "unsupported_namespace",
            message: "A worker artifact used an invalid or ambiguous record namespace and was hidden.",
            recordId: artifactId || workerSessionId,
          });
          continue;
        }
        const absoluteRecord = this.resolveArtifactPath(artifactRef);
        const recordFile = await inspect(this.paths.storageRoot, absoluteRecord, artifactRef);
        const eventSummary = event.summary;
        if (
          !eventSummary ||
          (eventSummary.kind !== "code_artifact" && eventSummary.kind !== "vision_artifact") ||
          typeof eventSummary.summary !== "string"
        ) {
          partial = true;
          warnings.push({
            code: "corrupt_record",
            message: "A worker artifact with an unsupported summary kind was hidden.",
            recordId: artifactId,
          });
          continue;
        }
        const kind = eventSummary.kind;
        const recordWarnings: LifecycleWarning[] = [];
        if (!event.workspaceId || !worker.workspaceId) {
          recordWarnings.push({
            code: "legacy_record",
            message: "Worker artifact ownership was inferred from its parent worker session.",
            recordId: artifactId,
          });
        }
        const createdAt =
          typeof event.createdAt === "string" && Number.isFinite(Date.parse(event.createdAt))
            ? event.createdAt
            : recordFile.createdAt;
        const ownership = {
          workspaceId: this.workspaceId,
          sessionId,
          parentSessionId: sessionId,
          visibility: (!event.workspaceId || !worker.workspaceId ? "legacy_inferred" : "current_session") as
            "legacy_inferred" | "current_session",
        };
        add({
          uri: artifactRef,
          name: `${kind}-${artifactId}.json`,
          source: "worker",
          artifactType: kind,
          mimeType: "application/json",
          sizeBytes: recordFile.sizeBytes,
          createdAt,
          summary: redactLifecycleText(eventSummary.summary, this.workspaceRoot),
          readMode: "structured",
          sourceToolName: kind === "code_artifact" ? "invoke_coding_worker" : "invoke_vision_worker",
          workerSessionId,
          artifactId,
          ownership,
          partial: !recordFile.exists || recordWarnings.length > 0,
          warnings: [...recordWarnings],
        });

        const addWorkerPayload = async (
          uri: string,
          artifactType: "worker_patch" | "worker_binary",
          mimeType: string,
          summary: string,
        ) => {
          let absolutePath: string;
          try {
            absolutePath = this.resolveArtifactPath(uri);
          } catch {
            partial = true;
            warnings.push({
              code: "unsupported_namespace",
              message: "A worker artifact payload URI was rejected.",
              recordId: artifactId,
            });
            return;
          }
          const payload = await inspect(this.paths.storageRoot, absolutePath, uri);
          const payloadWarnings = [...recordWarnings];
          if (!payload.exists) payloadWarnings.push({ code: "missing_payload", message: "Worker artifact payload is missing.", recordId: uri });
          add({
            uri,
            name: path.basename(absolutePath).slice(0, 255),
            source: "worker",
            artifactType,
            mimeType,
            sizeBytes: payload.sizeBytes,
            createdAt,
            summary,
            readMode: artifactType === "worker_patch" ? "text" : "binary_metadata",
            sourceToolName: kind === "code_artifact" ? "invoke_coding_worker" : "invoke_vision_worker",
            workerSessionId,
            artifactId,
            ownership,
            partial: payloadWarnings.length > 0,
            warnings: payloadWarnings,
          });
        };

        if (kind === "code_artifact") {
          const patchRef = eventSummary.patchRef;
          let validPatchRef = false;
          if (typeof patchRef === "string") {
            try {
              const segments = canonicalArtifactUriSegments(patchRef, "patches");
              validPatchRef = segments.length === 3 &&
                segments[1] === workerSessionId &&
                segments[2] === `${artifactId}.patch`;
            } catch {
              validPatchRef = false;
            }
          }
          if (typeof patchRef === "string" && validPatchRef) {
            await addWorkerPayload(
              patchRef,
              "worker_patch",
              "text/x-diff",
              `Patch payload for ${redactLifecycleText(eventSummary.summary, this.workspaceRoot)}`,
            );
          }
        } else if (recordFile.exists && recordFile.sizeBytes <= 16 * 1024 * 1024) {
          try {
            const recordBytes = await readBoundedVerifiedFile(
              this.paths.storageRoot,
              absoluteRecord,
              16 * 1024 * 1024,
              "Vision artifact metadata",
            );
            const artifact = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(recordBytes)) as {
              metadata?: { originalImageRef?: unknown; processedImageRef?: unknown; mimeType?: unknown };
            };
            const imageRefs = [artifact.metadata?.originalImageRef, artifact.metadata?.processedImageRef]
              .filter((value): value is string => typeof value === "string");
            for (const imageRef of [...new Set(imageRefs)]) {
              try {
                const segments = canonicalArtifactUriSegments(imageRef, "images");
                if (segments.length !== 3 || segments[1] !== workerSessionId) continue;
              } catch {
                continue;
              }
              const mimeType = inferMimeTypeFromName(imageRef);
              await addWorkerPayload(
                imageRef,
                "worker_binary",
                mimeType === "application/octet-stream" && typeof artifact.metadata?.mimeType === "string"
                  ? artifact.metadata.mimeType
                  : mimeType,
                `Binary image payload for ${redactLifecycleText(eventSummary.summary, this.workspaceRoot)}`,
              );
            }
          } catch {
            partial = true;
            warnings.push({
              code: "corrupt_record",
              message: "Vision artifact metadata could not be parsed for binary payload discovery.",
              recordId: artifactId,
            });
          }
        }
        warnings.push(...recordWarnings);
      }
    }

    const catalog = [...items.values()].sort((left, right) => {
      const byTime = right.createdAt.localeCompare(left.createdAt);
      return byTime !== 0 ? byTime : right.uri.localeCompare(left.uri);
    });
    return {
      items: catalog,
      scanned,
      partial: partial || catalog.some((item) => item.partial),
      warnings: boundedLifecycleWarnings(warnings),
    };
  }

  public async resolveLifecycleArtifact(
    sessionId: string,
    uri: string,
  ): Promise<ResolvedLifecycleArtifact> {
    const uriSegments = canonicalArtifactUriSegments(uri);
    const namespace = uriSegments[0];
    if (!namespace || !["tool-outputs", "records", "patches", "images"].includes(namespace)) {
      throw Object.assign(new Error("Artifact URI namespace is unsupported."), {
        code: "ERR_TOOL_UNSUPPORTED_PROTOCOL",
      });
    }
    if (namespace === "tool-outputs" && uriSegments.at(-2) !== sessionId) {
      throw Object.assign(new Error("Artifact is not owned by the current session."), {
        code: "ERR_TOOL_PERMISSION_DENIED",
      });
    }

    const catalog = await this.scanArtifactCatalog(sessionId);
    const summary = catalog.items.find((item) => item.uri === uri);
    if (!summary) {
      throw Object.assign(
        new Error("Artifact was not found in the current session catalog."),
        { code: "ERR_TOOL_NOT_FOUND" },
      );
    }

    const toolOutput = uri.startsWith("artifact://tool-outputs/");
    const absolutePath = toolOutput
      ? this.resolveToolOutputArtifactPath(uri)
      : this.resolveArtifactPath(uri);
    const namespaceRoot = toolOutput ? this.paths.toolOutputsDir : this.paths.workerArtifactsDir;

    const openVerified = async () => {
      await assertNoSymlinkComponents(this.paths.storageRoot, absolutePath, "Lifecycle artifact path");
      let pathBefore;
      try {
        pathBefore = await fs.lstat(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw Object.assign(new Error("Artifact payload is missing."), { code: "ERR_TOOL_NOT_FOUND" });
        }
        throw error;
      }
      if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
        throw Object.assign(new Error("Artifact payload is not a regular file."), {
          code: "ERR_TOOL_CORRUPT_RECORD",
        });
      }
      const [realNamespaceRoot, realTarget] = await Promise.all([
        fs.realpath(namespaceRoot),
        fs.realpath(absolutePath),
      ]);
      assertPathInside(realNamespaceRoot, realTarget, "Lifecycle artifact path");
      let handle;
      try {
        handle = await fs.open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw Object.assign(new Error("Artifact payload is missing."), { code: "ERR_TOOL_NOT_FOUND" });
        }
        throw error;
      }
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.dev !== pathBefore.dev ||
        before.ino !== pathBefore.ino ||
        before.size !== pathBefore.size
      ) {
        await handle.close();
        throw Object.assign(new Error("Artifact payload identity changed before it could be read."), {
          code: "ERR_TOOL_CONFLICTED",
        });
      }
      if (before.size !== summary.sizeBytes) {
        await handle.close();
        throw Object.assign(new Error("Artifact payload size does not match its catalog metadata."), {
          code: "ERR_TOOL_CORRUPT_RECORD",
        });
      }
      return { handle, before, realNamespaceRoot, realTarget };
    };
    const assertStable = async (
      before: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>["stat"]>>,
      after: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>["stat"]>>,
      realNamespaceRoot: string,
      realTarget: string,
    ) => {
      const pathAfter = await fs.lstat(absolutePath);
      const realTargetAfter = await fs.realpath(absolutePath);
      assertPathInside(realNamespaceRoot, realTargetAfter, "Lifecycle artifact path");
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        pathAfter.isSymbolicLink() ||
        pathAfter.dev !== before.dev ||
        pathAfter.ino !== before.ino ||
        pathAfter.size !== before.size ||
        realTargetAfter !== realTarget
      ) {
        throw Object.assign(new Error("Artifact payload changed while it was being read."), {
          code: "ERR_TOOL_CONFLICTED",
        });
      }
    };

    return {
      summary,
      absolutePath,
      readBytes: async (signal) => {
        if (summary.sizeBytes > LIFECYCLE_ARTIFACT_READ_MAX_BYTES) {
          throw Object.assign(new Error("Artifact exceeds the bounded lifecycle read limit."), {
            code: "ERR_TOOL_UNAVAILABLE",
          });
        }
        signal?.throwIfAborted();
        const { handle, before, realNamespaceRoot, realTarget } = await openVerified();
        try {
          const content = await handle.readFile();
          signal?.throwIfAborted();
          const after = await handle.stat();
          await assertStable(before, after, realNamespaceRoot, realTarget);
          if (content.byteLength !== after.size) {
            throw Object.assign(new Error("Artifact payload read was incomplete."), {
              code: "ERR_TOOL_CONFLICTED",
            });
          }
          const sha256 = createHash("sha256").update(content).digest("hex");
          if (summary.sha256 && summary.sha256 !== sha256) {
            throw Object.assign(new Error("Artifact payload failed its recorded hash check."), {
              code: "ERR_TOOL_CORRUPT_RECORD",
            });
          }
          return content;
        } finally {
          await handle.close();
        }
      },
      readRange: async (offset, maxBytes, signal) => {
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(maxBytes) ||
          maxBytes < 1 ||
          maxBytes > LIFECYCLE_ARTIFACT_RANGE_MAX_BYTES
        ) {
          throw Object.assign(new Error("Artifact range offset and maxBytes are invalid."), {
            code: "ERR_TOOL_INVALID_ARGUMENTS",
          });
        }
        signal?.throwIfAborted();
        const { handle, before, realNamespaceRoot, realTarget } = await openVerified();
        try {
          if (offset >= before.size) return Buffer.alloc(0);
          const length = Math.min(maxBytes, before.size - offset);
          const content = Buffer.alloc(length);
          const { bytesRead } = await handle.read(content, 0, length, offset);
          signal?.throwIfAborted();
          const after = await handle.stat();
          await assertStable(before, after, realNamespaceRoot, realTarget);
          return content.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
      },
    };
  }

  public async readLifecycleArtifactBytes(
    sessionId: string,
    uri: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    return (await this.resolveLifecycleArtifact(sessionId, uri)).readBytes(signal);
  }

  public resolveToolOutputArtifactPath(uri: string): string {
    if (uri.startsWith("artifact://tool-outputs/")) {
      const segments = canonicalArtifactUriSegments(uri, "tool-outputs");
      const relativePath = segments.slice(1).join("/");
      const absolutePath = path.resolve(this.paths.toolOutputsDir, relativePath);
      assertPathInside(this.paths.toolOutputsDir, absolutePath, "Tool output artifact URI");
      return absolutePath;
    }
    if (uri.startsWith("file://")) {
      const value = uri.slice("file://".length);
      const stateAttachmentPath = resolveLegacyDesktopAttachmentReference(this.workspaceRoot, value);
      const absolutePath = stateAttachmentPath
        ?? (path.isAbsolute(value) ? path.resolve(value) : path.resolve(this.workspaceRoot, value));
      assertPathInside(
        stateAttachmentPath ? this.paths.desktopAttachmentsDir : this.workspaceRoot,
        absolutePath,
        stateAttachmentPath ? "Desktop attachment URI" : "Workspace artifact URI",
      );
      return absolutePath;
    }
    throw new Error(`Unsupported tool output artifact URI: ${uri}`);
  }

  private async readVerifiedToolOutputArtifact(uri: string): Promise<Buffer> {
    const absolutePath = this.resolveToolOutputArtifactPath(uri);
    let artifact: ToolOutputArtifact | undefined;
    if (uri.startsWith("artifact://tool-outputs/")) {
      await assertNoSymlinkComponents(this.paths.toolOutputsDir, absolutePath, "Tool output artifact path");
      const parts = uri.slice("artifact://tool-outputs/".length).split("/").filter(Boolean);
      const sessionId = parts.at(-2);
      if (!sessionId) throw new Error("Tool output artifact URI is missing its session identity.");
      artifact = (await this.listToolOutputArtifacts(sessionId)).find((candidate) => candidate.uri === uri);
      if (!artifact) throw new Error("Tool output artifact has no trusted metadata record.");
    }
    const handle = await fs.open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error("Tool output artifact is not a regular file.");
      if (artifact && before.size !== artifact.sizeBytes) {
        throw new Error("Tool output artifact failed its recorded size check.");
      }
      const content = await handle.readFile();
      const after = await handle.stat();
      if (
        before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || content.byteLength !== after.size
      ) {
        throw new Error("Tool output artifact changed while it was being read.");
      }
      const sha256 = createHash("sha256").update(content).digest("hex");
      if (artifact && (artifact.sizeBytes !== content.byteLength || !artifact.sha256 || artifact.sha256 !== sha256)) {
        throw new Error("Tool output artifact failed its recorded integrity check.");
      }
      return content;
    } finally {
      await handle.close();
    }
  }

  public async readTextToolOutputArtifact(uri: string): Promise<string> {
    return (await this.readVerifiedToolOutputArtifact(uri)).toString("utf8");
  }

  public async readBinaryToolOutputArtifact(uri: string): Promise<Buffer> {
    return this.readVerifiedToolOutputArtifact(uri);
  }

  public async loadLatestWorkerArtifact(workerSessionId: string): Promise<WorkerArtifactRecord | undefined> {
    const events = await this.loadWorkerEvents(workerSessionId);
    return [...events]
      .reverse()
      .find((event): event is WorkerArtifactRecord => event.recordType === "worker_artifact");
  }

  public async readArtifactRef(ref: string): Promise<string | undefined> {
    if (ref.startsWith("artifact://tool-outputs/")) {
      throw new Error("Tool output artifacts require readTextToolOutputArtifact() or readBinaryToolOutputArtifact().");
    }
    const targetPath = this.resolveArtifactPath(ref);
    if (!(await exists(targetPath))) {
      return undefined;
    }
    return fs.readFile(targetPath, "utf8");
  }

  public resolveArtifactPath(ref: string): string {
    const segments = canonicalArtifactUriSegments(ref);
    const relativePath = segments.join("/");
    const absolutePath = path.resolve(this.paths.workerArtifactsDir, relativePath);
    assertPathInside(this.paths.workerArtifactsDir, absolutePath, "Worker artifact ref");
    return absolutePath;
  }

  public async linkWorkerSession(
    sessionId: string,
    input: {
      workerSessionId: string;
      workerType: WorkerType;
      dispatchKind: WorkerDispatchKind;
      status: WorkerSessionStatus;
    },
  ): Promise<WorkerSessionLinkRecord> {
    const record: WorkerSessionLinkRecord = {
      recordType: "worker_session_link",
      sessionId,
      workerSessionId: input.workerSessionId,
      createdAt: now(),
      workerType: input.workerType,
      dispatchKind: input.dispatchKind,
      status: input.status,
    };
    await this.appendEvent(sessionId, record);
    return record;
  }

  public async recordRoutingDecision(record: RoutingDecisionRecord): Promise<void> {
    await this.appendEvent(record.sessionId, record);
    const summary = await this.updateTelemetrySummary((current) => {
      current.counters.routingDecisionCount += 1;
      current.counters.routeTargets[record.finalTarget] += 1;
      if (record.finalTarget !== "governor_direct" && record.mode !== "fallback") {
        current.counters.workerRoutedCount += 1;
      }
      if (record.mode === "fallback") {
        current.counters.fallbackCount += 1;
      }
      current.counters.fallbackRate =
        current.counters.workerRoutedCount === 0
          ? 0
          : current.counters.fallbackCount / current.counters.workerRoutedCount;
      return current;
    });

    if (record.mode === "fallback") {
      await this.recordTelemetryMetricSnapshot(record.sessionId, "fallback_rate", {
        value: summary.counters.fallbackRate,
        numerator: summary.counters.fallbackCount,
        denominator: summary.counters.workerRoutedCount,
        metadata: {
          automaticTarget: record.automaticTarget,
          finalTarget: record.finalTarget,
          turnId: record.turnId,
        },
      });
    }
  }

  public async recordDiagnosticReport(record: DiagnosticReportRecord): Promise<void> {
    await this.appendEvent(record.sessionId, record);
    const failures = record.diagnostics.filter((entry) => entry.status !== "ok").length;
    const summary = await this.updateTelemetrySummary((current) => {
      current.counters.diagnosticFailureCount += failures;
      return current;
    });
    await this.recordTelemetryMetricSnapshot(record.sessionId, "diagnostic_failure_count", {
      value: summary.counters.diagnosticFailureCount,
      metadata: {
        trigger: record.trigger,
        trackedFiles: record.trackedFiles,
        failures,
      },
    });
  }

  public async recordModelInvocation(
    sessionId: string,
    assignment: ModelAssignmentSnapshot,
    input: {
      result: "success" | "failure";
      latencyMs: number;
      inputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
    },
  ): Promise<void> {
    const dimensions = {
      slot: assignment.slot,
      adapterId: safeTelemetryDimension(assignment.adapterId),
      provider: safeTelemetryDimension(assignment.provider),
      model: safeTelemetryDimension(assignment.model),
      fallbackIndex: assignment.fallbackIndex,
      result: input.result,
    } as const;
    const key = [dimensions.slot, dimensions.adapterId, dimensions.provider, dimensions.model, dimensions.fallbackIndex, dimensions.result].join("|");
    const summary = await this.updateTelemetrySummary((current) => {
      const existing = current.counters.modelInvocations[key] ?? {
        ...dimensions,
        count: 0,
        totalLatencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      };
      current.counters.modelInvocations[key] = {
        ...existing,
        count: existing.count + 1,
        totalLatencyMs: existing.totalLatencyMs + Math.max(0, Math.round(input.latencyMs)),
        inputTokens: existing.inputTokens + Math.max(0, Math.round(input.inputTokens ?? 0)),
        outputTokens: existing.outputTokens + Math.max(0, Math.round(input.outputTokens ?? 0)),
        reasoningTokens: existing.reasoningTokens + Math.max(0, Math.round(input.reasoningTokens ?? 0)),
      };
      return current;
    });
    const aggregate = summary.counters.modelInvocations[key]!;
    await this.recordTelemetryMetricSnapshot(sessionId, "model_invocation", {
      value: aggregate.count,
      metadata: {
        ...dimensions,
        latencyMs: Math.max(0, Math.round(input.latencyMs)),
        inputTokens: Math.max(0, Math.round(input.inputTokens ?? 0)),
        outputTokens: Math.max(0, Math.round(input.outputTokens ?? 0)),
        reasoningTokens: Math.max(0, Math.round(input.reasoningTokens ?? 0)),
      },
    });
  }

  public async recordGovernorDirectSuccess(sessionId: string, turnId: string): Promise<void> {
    const summary = await this.updateTelemetrySummary((current) => {
      current.counters.governorDirectSuccessCount += 1;
      current.counters.directDsSuccessCount = current.counters.governorDirectSuccessCount;
      return current;
    });
    await this.recordTelemetryMetricSnapshot(sessionId, "governor_direct_success_count", {
      value: summary.counters.governorDirectSuccessCount,
      metadata: {
        turnId,
      },
    });
  }

  /** @deprecated Phase 22 compatibility alias. */
  public async recordDirectDsSuccess(sessionId: string, turnId: string): Promise<void> {
    await this.recordGovernorDirectSuccess(sessionId, turnId);
  }

  public async loadTelemetrySummary(): Promise<TelemetrySummary> {
    await this.ensureInitialized();
    const content = await fs.readFile(this.paths.telemetrySummaryPath, "utf8");
    const parsed = JSON.parse(content) as TelemetrySummary & {
      counters: TelemetrySummary["counters"] & {
        routeTargets: TelemetrySummary["counters"]["routeTargets"] & Partial<Record<"ds_direct" | "glm_coding" | "kimi_vision", number>>;
      };
    };
    parsed.counters.routeTargets = {
      governor_direct: parsed.counters.routeTargets.governor_direct ?? parsed.counters.routeTargets.ds_direct ?? 0,
      coding_worker: parsed.counters.routeTargets.coding_worker ?? parsed.counters.routeTargets.glm_coding ?? 0,
      vision_worker: parsed.counters.routeTargets.vision_worker ?? parsed.counters.routeTargets.kimi_vision ?? 0,
    };
    parsed.counters.governorDirectSuccessCount = parsed.counters.governorDirectSuccessCount ?? parsed.counters.directDsSuccessCount ?? 0;
    parsed.counters.directDsSuccessCount = parsed.counters.directDsSuccessCount ?? parsed.counters.governorDirectSuccessCount;
    parsed.counters.modelInvocations ??= {};
    return parsed;
  }

  public getSessionJsonlPath(sessionId: string): string {
    return path.join(this.paths.sessionsDir, `${sessionId}.jsonl`);
  }

  public getApprovalRecordPath(sessionId: string): string {
    return path.join(this.paths.approvalRecordsDir, `${sessionId}.jsonl`);
  }

  public getRollbackRecordPath(sessionId: string): string {
    return path.join(this.paths.rollbackRecordsDir, `${sessionId}.jsonl`);
  }

  public getCheckpointManifestPath(checkpointId: string): string {
    return path.join(this.paths.checkpointsDir, checkpointId, "manifest.json");
  }

  public async loadCheckpointManifest(checkpointId: string): Promise<CheckpointManifest> {
    const filePath = this.getCheckpointManifestPath(checkpointId);
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content) as CheckpointManifest;
  }

  public async fingerprintCheckpointFile(input: {
    checkpointId: string;
    relativePath: string;
    signal?: AbortSignal;
  }): Promise<CheckpointFileFingerprint> {
    input.signal?.throwIfAborted();
    const manifest = await this.loadCheckpointManifest(input.checkpointId);
    const normalized = normalizeCheckpointPath(this.workspaceRoot, input.relativePath);
    const entry = manifest.trackedFiles.find((candidate) => candidate.path === normalized);
    if (!entry) throw new Error(`Checkpoint does not track ${normalized}.`);
    if (!entry.existed) return { exists: false };
    if ((entry.kind ?? "file") !== "file") throw new Error(`Checkpoint path ${normalized} is not a file.`);
    const checkpointRoot = path.join(this.paths.checkpointsDir, input.checkpointId);
    const snapshotPath = path.resolve(checkpointRoot, entry.snapshotPath ?? normalized);
    assertPathInside(checkpointRoot, snapshotPath, "Checkpoint fingerprint path");
    await assertNoSymlinkComponents(this.paths.checkpointsDir, snapshotPath, "Checkpoint fingerprint path");
    return fingerprintRegularFile(snapshotPath, input.signal);
  }

  public getWorkerSessionMetaPath(workerSessionId: string): string {
    if (!isSafeLifecycleId(workerSessionId)) throw new Error("Worker session identifier is unsafe.");
    return path.join(this.paths.workerSessionsDir, `${workerSessionId}.json`);
  }

  public getWorkerSessionJsonlPath(workerSessionId: string): string {
    if (!isSafeLifecycleId(workerSessionId)) throw new Error("Worker session identifier is unsafe.");
    return path.join(this.paths.workerSessionsDir, `${workerSessionId}.jsonl`);
  }

  private async updateTelemetrySummary(updater: (summary: TelemetrySummary) => TelemetrySummary): Promise<TelemetrySummary> {
    const current = await this.loadTelemetrySummary();
    const updated = updater(current);
    await writeJsonAtomic(this.paths.telemetrySummaryPath, updated);
    return updated;
  }

  private async recordTelemetryMetricSnapshot(
    sessionId: string,
    metricName: TelemetryMetricName,
    input: {
      value: number;
      numerator?: number;
      denominator?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    const record: TelemetryMetricRecord = {
      recordType: "telemetry_metric",
      sessionId,
      createdAt: now(),
      metricName,
      value: input.value,
      numerator: input.numerator,
      denominator: input.denominator,
      metadata: input.metadata,
    };
    await this.appendEvent(sessionId, record);
  }

  public getDisplayPath(targetPath: string): string {
    return toRelative(this.workspaceRoot, targetPath);
  }

  private async withWorkerSessionLock<T>(workerSessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.workerSessionLocks.get(workerSessionId) ?? Promise.resolve();
    let releaseLock!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const queued = previous.then(() => current);
    this.workerSessionLocks.set(workerSessionId, queued);

    await previous;
    try {
      return await operation();
    } finally {
      releaseLock();
      if (this.workerSessionLocks.get(workerSessionId) === queued) {
        this.workerSessionLocks.delete(workerSessionId);
      }
    }
  }
}
