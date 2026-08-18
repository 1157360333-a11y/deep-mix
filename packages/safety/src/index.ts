import { promises as fs } from "node:fs";
import { createHmac } from "node:crypto";
import path from "node:path";
import type {
  ApprovalPersistence,
  ApprovalRecord,
  PermissionDecision,
  PermissionMode,
  SideEffectLevel,
  ToolExecutionOrigin,
  ToolPermissionCategory,
} from "../../shared-schema/src/index.js";
import { resolveWorkspaceStateDirectory } from "../../state-location/src/index.js";

export interface PermissionPolicy {
  version: 1;
  workspaceWriteRoots: string[];
  shellAllowedCwds: string[];
  networkAccess: {
    mode: "inherit" | "disabled";
    allowedHosts: string[];
  };
  deniedPathPrefixes: string[];
}

export interface ApprovalGrant {
  approvalId: string;
  sessionId: string;
  toolName: string;
  permissionCategory: ToolPermissionCategory;
  requestKey: string;
  decision: Extract<PermissionDecision, "allow" | "deny">;
  persistence: Extract<ApprovalPersistence, "allow_once" | "allow_session" | "deny">;
  createdAt: string;
  reason: string;
  remainingUses?: number;
}

export interface PermissionPersistence {
  claimApprovalGrant: (sessionId: string, requestKey: string) => Promise<ApprovalGrant | undefined>;
  consumeApprovalGrant: (sessionId: string, requestKey: string) => Promise<void>;
  getApprovalRequestKeySecret: () => Promise<Uint8Array>;
  loadApprovalGrant: (sessionId: string, requestKey: string) => Promise<ApprovalGrant | undefined>;
  recordApproval: (record: ApprovalRecord) => Promise<void>;
  saveApprovalGrant: (grant: ApprovalGrant) => Promise<void>;
}

export interface ToolPermissionRequest {
  sessionId: string;
  toolName: string;
  permissionCategory: ToolPermissionCategory;
  sideEffectLevel: SideEffectLevel;
  readOnly: boolean;
  arguments: unknown;
  executionOrigin?: ToolExecutionOrigin;
  parentCallId?: string;
  parentToolName?: string;
}

export interface PermissionOutcome {
  decision: PermissionDecision;
  reason: string;
  requestKey: string;
  grant?: ApprovalGrant;
}

// These runtime-control paths are a non-configurable safety boundary. A
// workspace policy may add denials, but it must never remove these defaults.
export const MANDATORY_DENIED_PATH_PREFIXES = [
  ".git",
  ".deep-mix/api-key-library",
  ".deep-mix/code-index",
  ".deep-mix/approval-records",
  ".deep-mix/approval-state.json",
  ".deep-mix/approval-state.json.lock",
  ".deep-mix/approval-request-key.bin",
  ".deep-mix/checkpoints",
  ".deep-mix/completed-tool-results",
  ".deep-mix/file-history",
  ".deep-mix/permission-policy.json",
  ".deep-mix/process-sessions",
  ".deep-mix/promotion-log.jsonl",
  ".deep-mix/protected-tool-calls",
  ".deep-mix/rollback-records",
  ".deep-mix/runtime-capabilities.json",
  ".deep-mix/sessions",
  ".deep-mix/sessions-index.json",
  ".deep-mix/telemetry",
  ".deep-mix/tool-outputs",
  ".deep-mix/user-input-claims",
  ".deep-mix/worker-artifacts",
  ".deep-mix/worker-sessions",
] as const;

function normalizePathPrefix(value: string): string {
  if (!value || value === ".") {
    return ".";
  }
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  return process.platform === "win32" || process.platform === "darwin"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isPathAllowed(relativePath: string, allowedPrefixes: string[], deniedPrefixes: string[]): boolean {
  const normalized = normalizePathPrefix(relativePath);
  if (
    deniedPrefixes.some((prefix) => {
      const normalizedPrefix = normalizePathPrefix(prefix);
      return normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix}/`);
    })
  ) {
    return false;
  }

  return allowedPrefixes.some((prefix) => {
    const normalizedPrefix = normalizePathPrefix(prefix);
    if (normalizedPrefix === ".") {
      return true;
    }
    return normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix}/`);
  });
}

function assertContainedPath(workspaceRoot: string, relativePath: string): void {
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  const relative = path.relative(workspaceRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace root: ${relativePath}`);
  }
}

async function assertRealPathContained(
  workspaceRoot: string,
  relativePath: string,
  label: string,
): Promise<void> {
  const absoluteWorkspaceRoot = path.resolve(workspaceRoot);
  const absoluteTarget = path.resolve(absoluteWorkspaceRoot, relativePath);
  let existingAncestor = absoluteTarget;
  for (;;) {
    try {
      await fs.lstat(existingAncestor);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      existingAncestor = parent;
    }
  }
  const [realWorkspaceRoot, realAncestor] = await Promise.all([
    fs.realpath(absoluteWorkspaceRoot),
    fs.realpath(existingAncestor),
  ]);
  const relative = path.relative(realWorkspaceRoot, realAncestor);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its trusted root.`);
  }
}

function normalizeHost(value: string): string {
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    throw new Error(`Invalid network host declaration: ${value}`);
  }
}

export function createDefaultPermissionPolicy(): PermissionPolicy {
  return {
    version: 1,
    workspaceWriteRoots: ["."],
    shellAllowedCwds: ["."],
    networkAccess: {
      mode: "inherit",
      allowedHosts: [],
    },
    deniedPathPrefixes: [...MANDATORY_DENIED_PATH_PREFIXES],
  };
}

export async function loadPermissionPolicy(workspaceRoot: string): Promise<PermissionPolicy> {
  const policyPath = path.join(resolveWorkspaceStateDirectory(workspaceRoot), "permission-policy.json");
  try {
    const content = await fs.readFile(policyPath, "utf8");
    const configured = JSON.parse(content) as PermissionPolicy;
    return {
      ...configured,
      deniedPathPrefixes: [...new Set([
        ...MANDATORY_DENIED_PATH_PREFIXES,
        ...(Array.isArray(configured.deniedPathPrefixes) ? configured.deniedPathPrefixes : []),
      ])],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const defaultPolicy = createDefaultPermissionPolicy();
  await fs.mkdir(path.dirname(policyPath), { recursive: true });
  await fs.writeFile(policyPath, JSON.stringify(defaultPolicy, null, 2), "utf8");
  return defaultPolicy;
}

export function buildApprovalRequestKey(toolName: string, args: unknown, secret: Uint8Array): string {
  const digest = createHmac("sha256", secret).update(stableStringify(args)).digest("hex");
  return `${toolName}:hmac-sha256:${digest}`;
}

export class PermissionLayer {
  private policyPromise?: Promise<PermissionPolicy>;

  public constructor(
    private readonly workspaceRoot: string,
    private readonly mode: PermissionMode,
    private readonly persistence: PermissionPersistence,
  ) {}

  public async evaluate(request: ToolPermissionRequest): Promise<PermissionOutcome> {
    const requestKey = buildApprovalRequestKey(
      request.toolName,
      request.arguments,
      await this.persistence.getApprovalRequestKeySecret(),
    );
    // Plan mode is fail-closed before persisted grants are considered. A grant
    // created in auto mode must never authorize a later side effect in plan mode.
    if (this.mode === "plan" && !request.readOnly) {
      return {
        decision: "deny",
        reason: "Plan mode denies side-effecting tools.",
        requestKey,
      };
    }
    // One-time grants are atomically claimed before any external side effect.
    // A concurrent identical call therefore cannot observe the same use.
    const grant = await this.persistence.claimApprovalGrant(request.sessionId, requestKey);
    if (grant) {
      if (grant.decision === "deny") {
        return {
          decision: "deny",
          reason: `Stored approval policy denied ${request.toolName}.`,
          requestKey,
          grant,
        };
      }

      return {
        decision: "allow",
        reason:
          grant.persistence === "allow_once"
            ? `Stored one-time approval allows ${request.toolName}.`
            : `Stored session approval allows ${request.toolName}.`,
        requestKey,
        grant,
      };
    }

    if (this.mode === "danger-full-access") {
      return {
        decision: "allow",
        reason: "Mode danger-full-access allows the tool call.",
        requestKey,
      };
    }

    if (this.mode === "plan") {
      return {
        decision: "allow",
        reason: "Plan mode allows read-only tools.",
        requestKey,
      };
    }

    if (
      request.permissionCategory === "read_only" ||
      request.permissionCategory === "mcp_read_only"
    ) {
      return {
        decision: "allow",
        reason: `${request.permissionCategory} tools are allowed in ${this.mode} mode.`,
        requestKey,
      };
    }

    if (
      request.permissionCategory === "run_tests" &&
      request.executionOrigin === "runtime_post_edit_verification" &&
      (request.toolName === "run_tests" || request.toolName === "lint" || request.toolName === "typecheck") &&
      (request.parentToolName === "apply_patch" || request.parentToolName === "apply_artifact_patch") &&
      typeof request.parentCallId === "string" &&
      request.parentCallId.length > 0
    ) {
      return {
        decision: "allow",
        reason: `Runtime post-edit verification is covered by parent ${request.parentToolName} call ${request.parentCallId}.`,
        requestKey,
      };
    }

    if (this.mode === "auto" && request.sideEffectLevel === "low") {
      return {
        decision: "allow",
        reason: "Auto mode allows low-risk tool calls.",
        requestKey,
      };
    }

    return {
      decision: "ask",
      reason: `${request.toolName} requires explicit approval in ${this.mode} mode.`,
      requestKey,
    };
  }

  public async resolveApproval(input: {
    approvalId: string;
    sessionId: string;
    toolName: string;
    permissionCategory: ToolPermissionCategory;
    requestKey: string;
    persistence: Extract<ApprovalPersistence, "allow_once" | "allow_session" | "deny">;
    reason: string;
  }): Promise<ApprovalGrant> {
    const grant: ApprovalGrant = {
      approvalId: input.approvalId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      permissionCategory: input.permissionCategory,
      requestKey: input.requestKey,
      decision: input.persistence === "deny" ? "deny" : "allow",
      persistence: input.persistence,
      createdAt: new Date().toISOString(),
      reason: input.reason,
      remainingUses: input.persistence === "allow_once" ? 1 : undefined,
    };
    await this.persistence.saveApprovalGrant(grant);
    return grant;
  }

  public async consumeGrantIfNeeded(grant: ApprovalGrant | undefined): Promise<void> {
    if (!grant || grant.persistence !== "allow_once") {
      return;
    }
    await this.persistence.consumeApprovalGrant(grant.sessionId, grant.requestKey);
  }

  public async assertWritablePaths(pathsToWrite: string[]): Promise<void> {
    const policy = await this.loadPolicy();
    for (const targetPath of pathsToWrite) {
      assertContainedPath(this.workspaceRoot, targetPath);
      await assertRealPathContained(this.workspaceRoot, targetPath, "Writable path");
      if (!isPathAllowed(targetPath, policy.workspaceWriteRoots, policy.deniedPathPrefixes)) {
        throw new Error(`Path is outside the writable sandbox: ${targetPath}`);
      }
    }
  }

  public async assertShellCwd(relativeCwd: string): Promise<void> {
    const policy = await this.loadPolicy();
    assertContainedPath(this.workspaceRoot, relativeCwd);
    await assertRealPathContained(this.workspaceRoot, relativeCwd, "Shell cwd");
    if (!isPathAllowed(relativeCwd, policy.shellAllowedCwds, policy.deniedPathPrefixes)) {
      throw new Error(`Shell cwd is outside the sandbox: ${relativeCwd}`);
    }
  }

  public async assertNetworkHosts(hosts: string[]): Promise<void> {
    const policy = await this.loadPolicy();
    if (policy.networkAccess.mode === "disabled" && hosts.length > 0) {
      throw new Error("Network access is disabled by the permission policy.");
    }
    if (policy.networkAccess.allowedHosts.length === 0) return;
    const allowed = new Set(policy.networkAccess.allowedHosts.map(normalizeHost));
    for (const host of hosts.map(normalizeHost)) {
      if (!allowed.has(host)) {
        throw new Error(`Network host is outside the sandbox: ${host}`);
      }
    }
  }

  public async readPolicy(): Promise<PermissionPolicy> {
    return this.loadPolicy();
  }

  private async loadPolicy(): Promise<PermissionPolicy> {
    this.policyPromise ??= loadPermissionPolicy(this.workspaceRoot);
    return this.policyPromise;
  }
}
