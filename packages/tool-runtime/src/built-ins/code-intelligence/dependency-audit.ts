import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  DependencyAuditResult,
  DependencyFinding,
  DependencyFindingSource,
  NormalizedFindingSeverity,
  ToolAccessRequest,
  ToolOutputArtifact,
  ToolPermissionProfile,
  ToolResult,
  ToolStructuredError,
} from "../../../../shared-schema/src/index.js";
import { redactProcessText } from "../../process-manager.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolProcessResult,
  ToolAccessResolutionContext,
} from "../../tool-module.js";
import {
  createRequestDigest,
  paginateAuthoritativeItems,
  ResultPageBudgetError,
} from "./pagination.js";

export type DependencyAuditMode = "offline" | "online";
export type DependencyAuditScope = "workspace" | "package";

export interface DependencyAuditArguments {
  mode?: DependencyAuditMode;
  scope?: DependencyAuditScope;
  path?: string;
  packageManager?: "auto" | "npm";
  maxResults?: number;
  maxResultChars?: number;
  timeoutMs?: number;
  cursor?: string;
}

export interface DependencyAuditorRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
  readonly signal?: AbortSignal;
}

/** Injectable report-only auditor. Implementations must never install, update, fix, or write lockfiles. */
export interface DependencyAuditor {
  readonly displayName: string;
  readonly version?: string;
  run(request: DependencyAuditorRequest): Promise<ToolProcessResult>;
}

export interface DependencyAuditToolOptions {
  auditor?: DependencyAuditor;
}

interface NormalizedArguments {
  mode: DependencyAuditMode;
  scope: DependencyAuditScope;
  targetPath: string;
  packageManager: "npm";
  maxResults: number;
  maxResultChars: number;
  requestedPackageManager: "auto" | "npm";
  timeoutMs: number;
  cursor?: string;
}

interface NpmPackageRecord {
  name?: unknown;
  version?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
}

interface NpmLockfile {
  name?: unknown;
  version?: unknown;
  lockfileVersion?: unknown;
  packages?: unknown;
  dependencies?: unknown;
}

interface NpmAdvisoryVia {
  source?: unknown;
  name?: unknown;
  dependency?: unknown;
  title?: unknown;
  url?: unknown;
  severity?: unknown;
  range?: unknown;
  cwe?: unknown;
  cves?: unknown;
}

interface NpmVulnerability {
  name?: unknown;
  severity?: unknown;
  isDirect?: unknown;
  via?: unknown;
  effects?: unknown;
  range?: unknown;
  nodes?: unknown;
  fixAvailable?: unknown;
}

interface NpmAuditReport {
  auditReportVersion?: unknown;
  vulnerabilities?: unknown;
  metadata?: unknown;
  error?: unknown;
}

interface AuditTarget {
  targetDirectory: string;
  targetPath: string;
  packageDirectory: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
  lockfilePath: string;
  lockRootDirectory: string;
  lockRootPath: string;
  lockRootManifestPath: string;
  lockRootManifest: Record<string, unknown>;
  packageLockKey: string;
  lockfile: NpmLockfile;
  lockfileText: string;
  lockfileHash: string;
  workspaceName?: string;
}

interface PreparedAudit {
  findings: DependencyFinding[];
  rawReport: unknown;
  status: "available" | "degraded" | "unavailable";
  source: DependencyFindingSource;
  warnings: string[];
  networkAccess: boolean;
  totalExact: boolean;
  snapshotVersion: string;
  networkAttempted: boolean;
  workspaceId: string;
  error?: ToolStructuredError;
}

const NPM_REGISTRY_HOST = "registry.npmjs.org";
const NPM_REGISTRY_URL = `https://${NPM_REGISTRY_HOST}/`;
const MAX_LOCKFILE_BYTES = 32 * 1024 * 1024;
const MAX_AUDIT_OUTPUT_CHARS = 4 * 1024 * 1024;
const MAX_RAW_ARTIFACT_CHARS = 4 * 1024 * 1024;
const MAX_FINDINGS = 50_000;
const AUDIT_CURSOR_VERSION = "npm-audit-v1";
const SECRET_KEY = /(?:api[_-]?key|authorization|cookie|credential|password|secret|token)/iu;
class LockfileIntegrityError extends Error {
  public constructor(
    public readonly beforeHash: string,
    public readonly afterHash: string,
    public readonly rawReport: unknown,
  ) {
    super("package-lock.json changed while the report-only dependency auditor was running; the tool stopped and did not overwrite or restore the file.");
    this.name = "LockfileIntegrityError";
  }
}

class DependencyAuditorExecutionError extends Error {
  public readonly networkAttempted = true;

  public constructor(message: string, public readonly rawReport: unknown) {
    super(message);
    this.name = "DependencyAuditorExecutionError";
  }
}

type AuditResolutionContext = RuntimeToolExecutionContext | ToolAccessResolutionContext;

function auditServices(context: AuditResolutionContext) {
  return "moduleContext" in context ? context.moduleContext : context;
}

const EXTERNAL_DEPENDENCY_DATA_BOUNDARY =
  "Sends package names, installed versions, and the package-lock dependency graph to registry.npmjs.org; no source files are sent.";

function npmAuditArgs(target: AuditTarget): readonly string[] {
  return Object.freeze([
    "audit",
    "--json",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-fund",
    `--registry=${NPM_REGISTRY_URL}`,
    ...(target.workspaceName ? ["--workspace", target.workspaceName] : []),
  ]);
}

function quotedCommandArgument(value: string): string {
  return /^[A-Za-z0-9_./:@=+-]+$/u.test(value) ? value : JSON.stringify(value);
}

function npmAuditCommandDisplay(target: AuditTarget, executable = "npm"): string {
  return [executable, ...npmAuditArgs(target)].map(quotedCommandArgument).join(" ");
}

function frozenAuditorRequest(input: DependencyAuditorRequest): DependencyAuditorRequest {
  return Object.freeze({
    ...input,
    args: Object.freeze([...input.args]),
  });
}

function npmAuditEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(environment).filter(([key]) => key.toLocaleLowerCase("en-US") !== "npm_config_registry"),
  );
  return { ...inherited, npm_config_registry: NPM_REGISTRY_URL };
}


const INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["offline", "online"] },
    scope: { type: "string", enum: ["workspace", "package"] },
    path: { type: "string", minLength: 1, maxLength: 2_048 },
    packageManager: { type: "string", enum: ["auto", "npm"] },
    maxResults: { type: "integer", minimum: 1, maximum: 500 },
    maxResultChars: { type: "integer", minimum: 4_096, maximum: 200_000 },
    timeoutMs: { type: "integer", minimum: 1_000, maximum: 300_000 },
    cursor: { type: "string", minLength: 1, maxLength: 4_096 },
  },
} as const;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeSlash(value: string): string {
  return value.replace(/\\/gu, "/") || ".";
}

function stableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function normalizeDependencySeverity(raw: unknown): {
  severity: NormalizedFindingSeverity;
  rawSeverity?: string;
  severityNormalization?: string;
} {
  const rawSeverity = asString(raw)?.toLocaleLowerCase("en-US");
  const severity: NormalizedFindingSeverity = rawSeverity === "critical"
    ? "critical"
    : rawSeverity === "high"
      ? "high"
      : rawSeverity === "moderate" || rawSeverity === "medium"
        ? "medium"
        : rawSeverity === "low"
          ? "low"
          : rawSeverity === "info"
            ? "info"
            : "unknown";
  return {
    severity,
    ...(rawSeverity ? { rawSeverity } : {}),
    ...(rawSeverity && rawSeverity !== severity
      ? { severityNormalization: `npm severity ${rawSeverity} normalized to ${severity}` }
      : rawSeverity ? { severityNormalization: `npm severity ${rawSeverity} preserved as ${severity}` } : {}),
  };
}
function redactJson(value: unknown, depth = 0): unknown {
  if (depth > 32) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return redactProcessText(value).slice(0, 100_000);
  if (Array.isArray(value)) return value.slice(0, 100_000).map((entry) => redactJson(entry, depth + 1));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100_000)
      .map(([key, entry]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : redactJson(entry, depth + 1)]),
  );
}

function sanitizedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactProcessText(message).slice(0, 1_000);
}

function normalizeArguments(
  raw: DependencyAuditArguments,
  context: AuditResolutionContext,
): NormalizedArguments {
  const mode = raw.mode ?? "offline";
  const scope = raw.scope ?? "workspace";
  const targetPath = auditServices(context).paths.normalize(raw.path ?? ".");
  const segments = normalizeSlash(targetPath).split("/").map((entry) => entry.toLocaleLowerCase("en-US"));
  if (segments.includes(".deep-mix") || segments.includes(".git")) {
    throw new Error("dependency_audit cannot inspect protected runtime or repository-internal state.");
  }
  const result: NormalizedArguments = {
    mode,
    scope,
    targetPath,
    requestedPackageManager: raw.packageManager ?? "auto",
    packageManager: raw.packageManager === "npm" || raw.packageManager === "auto" || raw.packageManager === undefined
      ? "npm"
      : raw.packageManager,
    maxResults: raw.maxResults ?? 100,
    maxResultChars: raw.maxResultChars ?? 60_000,
    timeoutMs: raw.timeoutMs ?? 120_000,
    ...(raw.cursor ? { cursor: raw.cursor } : {}),
  };
  if (!Number.isSafeInteger(result.maxResults) || result.maxResults < 1 || result.maxResults > 500) {
    throw new Error("dependency_audit maxResults is invalid.");
  }
  if (!Number.isSafeInteger(result.maxResultChars) || result.maxResultChars < 4_096 || result.maxResultChars > 200_000) {
    throw new Error("dependency_audit maxResultChars is invalid.");
  }
  if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 1_000 || result.timeoutMs > 300_000) {
    throw new Error("dependency_audit timeoutMs is invalid.");
  }
  return result;
}

function relativeWorkspacePath(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(absolutePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("dependency_audit path escapes the workspace.");
  }
  return normalizeSlash(relative);
}

async function canonicalDirectory(workspaceRoot: string, absolutePath: string): Promise<string> {
  const [root, target] = await Promise.all([fs.realpath(workspaceRoot), fs.realpath(absolutePath)]);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("dependency_audit canonical target escapes the workspace.");
  }
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("dependency_audit target must be a real workspace directory.");
  }
  return target;
}

async function existsFile(value: string): Promise<boolean> {
  try {
    return (await fs.lstat(value)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readWorkspaceJson(
  absolutePath: string,
  context: AuditResolutionContext,
  maxBytes: number,
): Promise<{ text: string; value: Record<string, unknown> }> {
  const relative = relativeWorkspacePath(context.workspaceRoot, absolutePath);
  const stat = await fs.lstat(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${relative} is not a regular file.`);
  if (stat.size > maxBytes) throw new Error(`${relative} exceeds the bounded audit input size.`);
  const resolved = await auditServices(context).paths.resolveReadable(relative);
  const bytes = await resolved.readBytes();
  if (bytes.includes(0)) throw new Error(`${relative} is not valid JSON text.`);
  const text = bytes.toString("utf8");
  const roundTrip = Buffer.from(text, "utf8");
  if (!roundTrip.equals(bytes)) throw new Error(`${relative} is not valid UTF-8.`);
  const value = JSON.parse(text) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${relative} must contain a JSON object.`);
  }
  return { text, value: value as Record<string, unknown> };
}

const UNSUPPORTED_LOCKFILES = ["pnpm-lock.yaml", "pnpm-lock.yml", "yarn.lock", "npm-shrinkwrap.json"] as const;

async function unsupportedLockfiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of UNSUPPORTED_LOCKFILES) {
    if (await existsFile(path.join(directory, name))) found.push(name);
  }
  return found;
}

function validatedLockPackages(lockfile: NpmLockfile, lockfilePath: string): Record<string, NpmPackageRecord> {
  if (lockfile.lockfileVersion !== 2 && lockfile.lockfileVersion !== 3) {
    throw new Error(
      `${lockfilePath} uses unsupported npm lockfileVersion ${String(lockfile.lockfileVersion)}; only versions 2 and 3 are supported.`,
    );
  }
  if (lockfile.packages === null || typeof lockfile.packages !== "object" || Array.isArray(lockfile.packages)) {
    throw new Error(`${lockfilePath} has no valid npm packages map.`);
  }
  const packages = lockfile.packages as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(packages, "")) {
    throw new Error(`${lockfilePath} has no root package record and is not a supported npm lockfile.`);
  }
  const root = packages[""];
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    throw new Error(`${lockfilePath} has an invalid root package record.`);
  }
  for (const [key, value] of Object.entries(packages)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${lockfilePath} contains an invalid packages entry at ${key || "<root>"}.`);
    }
  }
  return packages as Record<string, NpmPackageRecord>;
}

async function locateAuditTarget(
  args: NormalizedArguments,
  context: AuditResolutionContext,
): Promise<AuditTarget> {
  const services = auditServices(context);
  const requested = services.paths.resolveWorkspace(args.targetPath);
  const targetDirectory = await canonicalDirectory(context.workspaceRoot, requested);
  const packageDirectory = targetDirectory;
  const manifestAbsolute = path.join(packageDirectory, "package.json");
  if (!(await existsFile(manifestAbsolute))) {
    throw new Error(`No package.json exists at ${relativeWorkspacePath(context.workspaceRoot, packageDirectory)}.`);
  }
  const manifestRead = await readWorkspaceJson(manifestAbsolute, context, 4 * 1024 * 1024);

  const workspaceRoot = await fs.realpath(context.workspaceRoot);
  let lockRootDirectory: string | undefined;
  let unsupported: string[] = [];
  if (args.scope === "workspace") {
    unsupported = await unsupportedLockfiles(packageDirectory);
    if (args.requestedPackageManager === "auto" && unsupported.length > 0) {
      throw new Error(`Unsupported package-manager lockfile detected for auto mode: ${unsupported.join(", ")}.`);
    }
    if (await existsFile(path.join(packageDirectory, "package-lock.json"))) {
      lockRootDirectory = packageDirectory;
    }
  } else {
    let cursor = packageDirectory;
    while (true) {
      const detected = await unsupportedLockfiles(cursor);
      unsupported.push(...detected.map((name) => `${relativeWorkspacePath(context.workspaceRoot, cursor)}/${name}`));
      if (args.requestedPackageManager === "auto" && detected.length > 0) {
        throw new Error(`Unsupported package-manager lockfile detected for auto mode: ${detected.join(", ")}.`);
      }
      if (await existsFile(path.join(cursor, "package-lock.json"))) {
        lockRootDirectory = cursor;
        break;
      }
      if (cursor === workspaceRoot) break;
      const parent = path.dirname(cursor);
      if (parent === cursor || path.relative(workspaceRoot, parent).startsWith("..")) break;
      cursor = parent;
    }
  }
  if (!lockRootDirectory) {
    const unsupportedDetail = unsupported.length > 0
      ? ` Unsupported lockfiles found: ${[...new Set(unsupported)].sort(stableText).join(", ")}.`
      : "";
    const scopeRule = args.scope === "workspace"
      ? "Workspace scope requires package-lock.json in the target directory and never searches ancestors."
      : "Package scope found no supported ancestor package-lock.json.";
    throw new Error(`${scopeRule}${unsupportedDetail}`);
  }
  const lockfileAbsolute = path.join(lockRootDirectory, "package-lock.json");
  const lockfilePath = relativeWorkspacePath(context.workspaceRoot, lockfileAbsolute);
  const lockRead = await readWorkspaceJson(lockfileAbsolute, context, MAX_LOCKFILE_BYTES);
  const packages = validatedLockPackages(lockRead.value, lockfilePath);
  const lockRootManifestAbsolute = path.join(lockRootDirectory, "package.json");
  if (!(await existsFile(lockRootManifestAbsolute))) {
    throw new Error(`${lockfilePath} has no package.json at its lock root.`);
  }
  const lockRootManifestRead = await readWorkspaceJson(
    lockRootManifestAbsolute,
    context,
    4 * 1024 * 1024,
  );
  const relativePackage = normalizeSlash(path.relative(lockRootDirectory, packageDirectory));
  const packageLockKey = relativePackage === "." ? "" : relativePackage;
  if (!Object.prototype.hasOwnProperty.call(packages, packageLockKey)) {
    throw new Error(
      `${relativeWorkspacePath(context.workspaceRoot, packageDirectory)} is not represented by a valid packages entry in ${lockfilePath}.`,
    );
  }
  const workspaceName = packageLockKey ? asString(manifestRead.value.name) : undefined;
  if (packageLockKey && !workspaceName) {
    throw new Error("Package scope requires a named npm workspace when using an ancestor package-lock.json.");
  }
  return {
    targetDirectory,
    targetPath: relativeWorkspacePath(context.workspaceRoot, targetDirectory),
    packageDirectory,
    manifestPath: relativeWorkspacePath(context.workspaceRoot, manifestAbsolute),
    manifest: manifestRead.value,
    lockRootDirectory,
    lockRootPath: relativeWorkspacePath(context.workspaceRoot, lockRootDirectory),
    lockRootManifestPath: relativeWorkspacePath(context.workspaceRoot, lockRootManifestAbsolute),
    lockRootManifest: lockRootManifestRead.value,
    packageLockKey,
    lockfilePath,
    lockfile: lockRead.value,
    lockfileText: lockRead.text,
    lockfileHash: sha256(lockRead.text),
    ...(workspaceName ? { workspaceName } : {}),
  };
}
async function currentLockfileHash(
  target: AuditTarget,
  context: RuntimeToolExecutionContext,
): Promise<string> {
  const absolute = context.moduleContext.paths.resolveWorkspace(target.lockfilePath);
  const current = await readWorkspaceJson(absolute, context, MAX_LOCKFILE_BYTES);
  return sha256(current.text);
}


function lockPackages(lockfile: NpmLockfile): Record<string, NpmPackageRecord> {
  return objectRecord(lockfile.packages) as Record<string, NpmPackageRecord>;
}

function dependencyNames(record: Record<string, unknown>): string[] {
  const values = [
    objectRecord(record.dependencies),
    objectRecord(record.devDependencies),
    objectRecord(record.optionalDependencies),
    objectRecord(record.peerDependencies),
  ];
  return [...new Set(values.flatMap((entry) => Object.keys(entry)))].sort(stableText);
}

function offlineMetadata(target: AuditTarget, args: NormalizedArguments): unknown {
  const packages = lockPackages(target.lockfile);
  const entries = Object.entries(packages)
    .slice(0, 100_000)
    .map(([packagePath, value]) => ({
      packagePath: normalizeSlash(packagePath),
      name: asString(value.name),
      version: asString(value.version),
    }));
  return {
    reportType: "npm_lockfile_local_metadata",
    generatedBy: "dependency_audit",
    scope: args.scope,
    targetPath: target.targetPath,
    manifestPath: target.manifestPath,
    lockfilePath: target.lockfilePath,
    lockfileVersion: target.lockfile.lockfileVersion,
    packageName: asString(target.manifest.name),
    packageVersion: asString(target.manifest.version),
    directDependencies: dependencyNames(target.manifest),
    installedPackages: entries,
    advisoryDatabaseConsulted: false,
    automaticChangesApplied: false,
  };
}


function packageChain(node: string, fallbackName: string): string[] {
  const normalized = normalizeSlash(node);
  const parts = normalized.split("/");
  const chain: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] !== "node_modules") continue;
    const first = parts[index + 1];
    if (!first) continue;
    if (first.startsWith("@") && parts[index + 2]) {
      chain.push(`${first}/${parts[index + 2]}`);
      index += 2;
    } else {
      chain.push(first);
      index += 1;
    }
  }
  if (chain.at(-1) !== fallbackName) chain.push(fallbackName);
  return chain;
}
interface ResolvedDependencyChain {
  chain: string[];
  graphResolved: boolean;
}

function dependencyRecordKey(
  packages: Record<string, NpmPackageRecord>,
  parentKey: string,
  dependencyName: string,
): string | undefined {
  let directory = parentKey;
  const visited = new Set<string>();
  while (true) {
    const candidate = normalizeSlash(
      directory ? `${directory}/node_modules/${dependencyName}` : `node_modules/${dependencyName}`,
    );
    if (!visited.has(candidate) && packages[candidate]) return candidate;
    visited.add(candidate);
    if (!directory) break;
    const parent = path.posix.dirname(directory);
    directory = parent === "." || parent === directory ? "" : parent;
  }
  return undefined;
}

function resolvedDependencyChain(
  target: AuditTarget,
  node: string,
  fallbackName: string,
): ResolvedDependencyChain {
  const packages = lockPackages(target.lockfile);
  const targetNode = normalizeSlash(node);
  const queue: Array<{ key: string; chain: string[] }> = [{ key: target.packageLockKey, chain: [] }];
  const visited = new Set<string>();
  while (queue.length > 0 && visited.size < 20_000) {
    const current = queue.shift()!;
    if (visited.has(current.key) || current.chain.length >= 64) continue;
    visited.add(current.key);
    const record = packages[current.key];
    if (!record) continue;
    for (const dependencyName of dependencyNames(record as Record<string, unknown>)) {
      const childKey = dependencyRecordKey(packages, current.key, dependencyName);
      if (!childKey) continue;
      const chain = [...current.chain, dependencyName];
      if (childKey === targetNode) return { chain, graphResolved: true };
      queue.push({ key: childKey, chain });
    }
  }
  return { chain: packageChain(targetNode, fallbackName), graphResolved: false };
}


function installedVersion(lockfile: NpmLockfile, node: string, packageName: string): string | undefined {
  const packages = lockPackages(lockfile);
  const exact = packages[normalizeSlash(node)];
  if (exact) return asString(exact.version);
  const suffix = `/node_modules/${packageName}`;
  const candidate = Object.entries(packages)
    .filter(([key]) => key === `node_modules/${packageName}` || key.endsWith(suffix))
    .sort(([left], [right]) => stableText(left, right))[0]?.[1];
  return asString(candidate?.version);
}

interface FixResolution {
  fixedVersions: string[];
  recommendation: string;
}

function resolveFix(
  value: unknown,
  vulnerablePackage: string,
  advisoryId: string | undefined,
): FixResolution {
  const findingLabel = advisoryId ? `npm advisory ${advisoryId}` : `the npm audit finding for ${vulnerablePackage}`;
  const base = `Review ${findingLabel} and the dependency chain before choosing a remediation; this report made no changes.`;
  if (value === true) {
    return {
      fixedVersions: [],
      recommendation: `npm reports an available remediation for ${vulnerablePackage} but supplied no exact target version. ${base}`,
    };
  }
  if (value === false || value === null || typeof value !== "object") {
    return { fixedVersions: [], recommendation: base };
  }
  const record = value as Record<string, unknown>;
  const targetName = asString(record.name);
  const targetVersion = asString(record.version);
  if (targetName === vulnerablePackage && targetVersion) {
    return {
      fixedVersions: [targetVersion],
      recommendation: `Review and upgrade ${vulnerablePackage} to ${targetVersion} if compatible; this report made no changes.`,
    };
  }
  if (targetName) {
    return {
      fixedVersions: [],
      recommendation: `Remediation targets upstream dependency ${targetName}${targetVersion ? ` at ${targetVersion}` : ""}; no exact fixed version was attributed to vulnerable package ${vulnerablePackage}. ${base}`,
    };
  }
  return { fixedVersions: [], recommendation: base };
}

function extractedAdvisoryIds(value: string): string[] {
  const matches = value.toLocaleUpperCase("en-US").match(
    /(?:CVE-\d{4}-\d{4,}|GHSA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/gu,
  );
  return matches ?? [];
}

function advisoryIdentifiers(advisory: NpmAdvisoryVia): string[] {
  const record = advisory as Record<string, unknown>;
  const strings = [
    ...asStringArray(advisory.cves),
    ...Object.values(record).filter((value): value is string => typeof value === "string"),
  ];
  const standardized = [...new Set(strings.flatMap(extractedAdvisoryIds))].sort((left, right) => {
    const leftRank = left.startsWith("CVE-") ? 0 : 1;
    const rightRank = right.startsWith("CVE-") ? 0 : 1;
    return leftRank - rightRank || stableText(left, right);
  });
  if (standardized.length > 0) return standardized;
  if (typeof advisory.source === "number") return [`NPM-${advisory.source}`];
  const source = asString(advisory.source);
  if (source && /^\d+$/u.test(source)) return [`NPM-${source}`];
  if (source) {
    const sourceIds = extractedAdvisoryIds(source);
    if (sourceIds.length > 0) return [...new Set(sourceIds)].sort(stableText);
  }
  return [];
}

function normalizeNpmReport(
  report: NpmAuditReport,
  target: AuditTarget,
  source: DependencyFindingSource,
): { findings: DependencyFinding[]; truncated: boolean } {
  const vulnerabilities = objectRecord(report.vulnerabilities) as Record<string, NpmVulnerability>;
  const manifestDirectDependencies = new Set(dependencyNames(target.manifest));
  const findings: DependencyFinding[] = [];
  let truncated = false;
  outer: for (const [mapName, vulnerability] of Object.entries(vulnerabilities).sort(([a], [b]) => stableText(a, b))) {
    const packageName = asString(vulnerability.name) ?? mapName;
    const nodes = asStringArray(vulnerability.nodes).sort(stableText);
    const normalizedNodes = nodes.length > 0 ? nodes : [`node_modules/${packageName}`];
    const via = Array.isArray(vulnerability.via) ? vulnerability.via : [];
    const advisories = via.filter((entry): entry is NpmAdvisoryVia => entry !== null && typeof entry === "object");
    const normalizedAdvisories = advisories.length > 0 ? advisories : [{
      source: `aggregate-${packageName}`,
      title: `Vulnerability affecting ${packageName}`,
      severity: vulnerability.severity,
      range: vulnerability.range,
    }];
    for (const advisory of normalizedAdvisories) {
      const identifiers = advisoryIdentifiers(advisory);
      const advisoryId = identifiers[0];
      const rawSeverity = advisory.severity ?? vulnerability.severity;
      const severity = normalizeDependencySeverity(rawSeverity);
      const affected = asString(advisory.range) ?? asString(vulnerability.range);
      const title = asString(advisory.title) ?? `Vulnerability affecting ${packageName}`;
      const url = asString(advisory.url);
      const advisoryIdentity = advisoryId ?? sha256(JSON.stringify({
        packageName,
        source: typeof advisory.source === "number" ? advisory.source : asString(advisory.source) ?? null,
        title,
        url: url ?? null,
      }));
      const fix = resolveFix(vulnerability.fixAvailable, packageName, advisoryId);
      for (const node of normalizedNodes) {
        if (findings.length >= MAX_FINDINGS) {
          truncated = true;
          break outer;
        }
        const chainResolution = resolvedDependencyChain(target, node, packageName);
        const chain = chainResolution.chain;
        const direct = chainResolution.graphResolved && chain.length === 1 && manifestDirectDependencies.has(packageName);
        findings.push({
          id: `npm-${sha256(`${advisoryIdentity}\u0000${packageName}\u0000${node}`).slice(0, 24)}`,
          ...(advisoryId ? { advisoryId } : {}),
          advisoryIdStatus: advisoryId ? "reported" : "unavailable",
          packageName,
          ...(installedVersion(target.lockfile, node, packageName) ? {
            installedVersion: installedVersion(target.lockfile, node, packageName),
          } : {}),
          ...(affected ? { affectedVersions: affected } : {}),
          fixedVersions: fix.fixedVersions,
          ...severity,
          dependencyChain: chain,
          direct,
          manifestPath: target.manifestPath,
          lockfilePath: target.lockfilePath,
          evidence: {
            summary: redactProcessText(
              `${title}${identifiers.length > 1 ? ` (${identifiers.join(", ")})` : ""}${url ? `; ${url}` : ""}${advisoryId ? "" : "; source-native advisory identifier unavailable"}`,
            ).slice(0, 1_000),
            redacted: true,
          },
          recommendation: fix.recommendation,
          source,
        });
      }
    }
  }
  const deduplicated = new Map<string, DependencyFinding>();
  for (const finding of findings) deduplicated.set(finding.id, finding);
  return { findings: sortFindings([...deduplicated.values()]), truncated };
}

const SEVERITY_ORDER: Record<NormalizedFindingSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
  unknown: 5,
};

function sortFindings(findings: DependencyFinding[]): DependencyFinding[] {
  return findings.sort((left, right) =>
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
    stableText(left.packageName, right.packageName) ||
    stableText(left.advisoryId ?? "", right.advisoryId ?? "") ||
    stableText(left.dependencyChain.join("/"), right.dependencyChain.join("/")) ||
    stableText(left.id, right.id)
  );
}

function parseAuditJson(stdout: string): NpmAuditReport {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("npm audit did not return a JSON report.");
  const value = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("npm audit returned an invalid report object.");
  }
  const report = value as NpmAuditReport;
  if (report.error) {
    throw new Error(`npm audit reported a capability error: ${JSON.stringify(redactJson(report.error)).slice(0, 800)}`);
  }
  if (report.vulnerabilities === undefined) {
    throw new Error("npm audit report does not contain a vulnerabilities map.");
  }
  return report;
}

function defaultAuditor(context: RuntimeToolExecutionContext): DependencyAuditor {
  return {
    displayName: "npm audit",
    run: (request) => context.moduleContext.processes.run({
      command: request.command,
      args: [...request.args],
      mode: "direct",
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      maxOutputChars: request.maxOutputChars,
      signal: request.signal,
      environment: npmAuditEnvironment(context.moduleContext.environment),
    }),
  };
}

function unavailableError(message: string, dependency?: string): ToolStructuredError {
  return {
    type: "missing_dependency",
    message: redactProcessText(message).slice(0, 1_000),
    retryable: false,
    toolName: "dependency_audit",
    ...(dependency ? { dependency } : {}),
  };
}

function auditorExecutionError(
  message: string,
  result: ToolProcessResult,
  target: AuditTarget,
  executable: string,
): DependencyAuditorExecutionError {
  return new DependencyAuditorExecutionError(message, {
    reportType: "npm_audit_execution_error",
    command: npmAuditCommandDisplay(target, executable),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    outputTruncated: Boolean(result.outputTruncated),
    stdout: redactProcessText(result.stdout),
    stderr: redactProcessText(result.stderr),
    networkAttempted: true,
    automaticChangesApplied: false,
  });
}

async function prepareOffline(
  args: NormalizedArguments,
  target: AuditTarget,
  context: RuntimeToolExecutionContext,
): Promise<PreparedAudit> {
  const workspaceId = sha256(await fs.realpath(context.workspaceRoot));
  return {
    findings: [],
    rawReport: offlineMetadata(target, args),
    status: "degraded",
    source: { name: "npm package-lock local metadata", kind: "local_metadata" },
    warnings: [
      "Offline mode inspected only package-lock metadata; no vulnerability advisory database was queried.",
      "An empty finding list is not evidence that dependencies are vulnerability-free.",
    ],
    networkAccess: false,
    networkAttempted: false,
    totalExact: true,
    snapshotVersion: sha256(`${AUDIT_CURSOR_VERSION}\u0000offline\u0000${target.lockfileHash}`),
    workspaceId,
  };
}

async function prepareOnline(
  args: NormalizedArguments,
  target: AuditTarget,
  context: RuntimeToolExecutionContext,
  injected: DependencyAuditor | undefined,
): Promise<PreparedAudit> {
  const workspaceId = sha256(await fs.realpath(context.workspaceRoot));
  const capability = await context.moduleContext.capabilities.get("npm");
  if (!capability?.available || !capability.command) {
    const message = "npm is unavailable; dependency_audit did not install an auditor or modify dependencies.";
    return {
      findings: [],
      rawReport: { reportType: "capability_unavailable", reason: message },
      status: "unavailable",
      source: { name: injected?.displayName ?? "npm audit", kind: "dependency_auditor" },
      warnings: [message],
      networkAccess: false,
      networkAttempted: false,
      totalExact: true,
      snapshotVersion: sha256(`${AUDIT_CURSOR_VERSION}\u0000unavailable\u0000${target.lockfileHash}`),
      workspaceId,
      error: unavailableError(message, "npm"),
    };
  }
  const auditor = injected ?? defaultAuditor(context);
  const approved = context.approvalContext;
  const resolvedCommand = npmAuditCommandDisplay(target, capability.command);
  if (approved && (
    approved.lockfileHash !== target.lockfileHash ||
    approved.lockfilePath !== target.lockfilePath ||
    approved.cwd !== target.lockRootPath ||
    approved.command !== resolvedCommand ||
    approved.dataBoundary !== EXTERNAL_DEPENDENCY_DATA_BOUNDARY
  )) {
    throw new Error("Resolved dependency audit scope no longer matches the approved lock root, command, or external data boundary.");
  }
  await context.moduleContext.permissions.assertNetworkHosts([NPM_REGISTRY_HOST]);
  const beforeCommandLockfileHash = await currentLockfileHash(target, context);
  if (beforeCommandLockfileHash !== target.lockfileHash) {
    throw new Error(
      "package-lock.json changed after audit input discovery; no audit command was started. Retry with a fresh scope snapshot.",
    );
  }

  const request = frozenAuditorRequest({
    command: capability.command,
    args: npmAuditArgs(target),
    cwd: target.lockRootDirectory,
    timeoutMs: args.timeoutMs,
    maxOutputChars: MAX_AUDIT_OUTPUT_CHARS,
    signal: context.signal,
  });
  let result: ToolProcessResult | undefined;
  let runError: unknown;
  try {
    result = await auditor.run(request);
  } catch (error) {
    runError = error;
  }
  let afterCommandLockfileHash: string;
  try {
    afterCommandLockfileHash = await currentLockfileHash(target, context);
  } catch (error) {
    throw new DependencyAuditorExecutionError(
      `npm audit completed but post-command lockfile verification failed: ${sanitizedMessage(error)}`,
      {
        reportType: "npm_audit_postcondition_error",
        command: npmAuditCommandDisplay(target, capability.command),
        stdout: result ? redactProcessText(result.stdout) : undefined,
        stderr: result ? redactProcessText(result.stderr) : sanitizedMessage(runError),
        networkAttempted: true,
        automaticChangesApplied: false,
      },
    );
  }
  if (afterCommandLockfileHash !== beforeCommandLockfileHash) {
    throw new LockfileIntegrityError(
      beforeCommandLockfileHash,
      afterCommandLockfileHash,
      {
        reportType: "lockfile_integrity_violation",
        command: npmAuditCommandDisplay(target, capability.command),
        networkAttempted: true,
        stdout: result ? redactProcessText(result.stdout) : undefined,
        stderr: result ? redactProcessText(result.stderr) : sanitizedMessage(runError),
        automaticChangesApplied: false,
      },
    );
  }
  if (runError) {
    throw new DependencyAuditorExecutionError(
      `npm audit execution failed: ${sanitizedMessage(runError)}`,
      {
        reportType: "npm_audit_execution_error",
        command: npmAuditCommandDisplay(target, capability.command),
        error: sanitizedMessage(runError),
        networkAttempted: true,
        automaticChangesApplied: false,
      },
    );
  }
  if (!result) throw new DependencyAuditorExecutionError("npm audit did not return a process result.", { networkAttempted: true });
  if (result.spawnError?.code === "ENOENT") {
    const message = "npm audit command is unavailable; no dependency was installed or changed.";
    return {
      findings: [],
      rawReport: { reportType: "capability_unavailable", reason: message, stderr: redactProcessText(result.stderr) },
      status: "unavailable",
      source: { name: auditor.displayName, kind: "dependency_auditor", version: auditor.version ?? capability.version },
      warnings: [message],
      networkAccess: false,
      networkAttempted: false,
      totalExact: true,
      snapshotVersion: sha256(`${AUDIT_CURSOR_VERSION}\u0000spawn-unavailable\u0000${target.lockfileHash}`),
      workspaceId,
      error: unavailableError(message, capability.command),
    };
  }
  if (result.timedOut) {
    throw auditorExecutionError("npm audit timed out.", result, target, capability.command);
  }
  if (result.outputTruncated) {
    throw auditorExecutionError("npm audit report exceeded the bounded command-output capacity.", result, target, capability.command);
  }
  let report: NpmAuditReport;
  try {
    report = parseAuditJson(result.stdout);
  } catch (error) {
    const detail = redactProcessText(`${sanitizedMessage(error)} ${result.stderr}`).slice(0, 1_000);
    throw auditorExecutionError(detail, result, target, capability.command);
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw auditorExecutionError(
      `npm audit exited with code ${result.exitCode ?? -1}: ${redactProcessText(result.stderr).slice(0, 800)}`, result, target, capability.command,
    );
  }
  try {
  const source: DependencyFindingSource = {
    name: auditor.displayName,
    kind: "dependency_auditor",
    ...((auditor.version ?? capability.version) ? { version: auditor.version ?? capability.version } : {}),
  };
  const normalized = normalizeNpmReport(report, target, source);
  const redactedReport = redactJson(report);
  return {
    findings: normalized.findings,
    rawReport: {
      reportType: "npm_audit",
      command: npmAuditCommandDisplay(target, capability.command),
      cwd: relativeWorkspacePath(context.workspaceRoot, result.cwd),
      exitCode: result.exitCode,
      dataBoundary: EXTERNAL_DEPENDENCY_DATA_BOUNDARY,
      lockfileHashBefore: beforeCommandLockfileHash,
      lockfileHashAfter: afterCommandLockfileHash,
      lockfileModified: false,
      report: redactedReport,
      stderr: redactProcessText(result.stderr),
      automaticChangesApplied: false,
    },
    status: "available",
    source,
    warnings: [
      "package-lock.json hash was unchanged before and after the report-only audit command.",
      ...(normalized.truncated
        ? [`Finding normalization stopped at the ${MAX_FINDINGS} item capacity.`]
        : []),
    ],
    networkAccess: true,
    networkAttempted: true,
    totalExact: !normalized.truncated,
    snapshotVersion: sha256(
      `${AUDIT_CURSOR_VERSION}\u0000online\u0000${target.lockfileHash}\u0000${JSON.stringify(redactedReport)}`,
    ),
    workspaceId,
  };
  } catch (error) {
    if (error instanceof DependencyAuditorExecutionError || error instanceof LockfileIntegrityError) throw error;
    throw new DependencyAuditorExecutionError(
      `npm audit report normalization failed after the auditor ran: ${sanitizedMessage(error)}`,
      {
        reportType: "npm_audit_normalization_error",
        command: npmAuditCommandDisplay(target, capability.command),
        cwd: result.cwd,
        report: redactJson(report),
        error: sanitizedMessage(error),
        networkAttempted: true,
        automaticChangesApplied: false,
      },
    );
  }
}

function boundedRawReportContent(rawReport: unknown): { content: string; truncated: boolean } {
  const serialized = JSON.stringify(redactJson(rawReport), null, 2);
  if (serialized.length <= MAX_RAW_ARTIFACT_CHARS) return { content: serialized, truncated: false };
  const base = {
    reportType: "truncated_dependency_audit_raw_report",
    truncated: true,
    originalChars: serialized.length,
    originalSha256: sha256(serialized),
  };
  let low = 0;
  let high = serialized.length;
  let content = JSON.stringify({ ...base, preview: "" }, null, 2);
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = JSON.stringify({ ...base, preview: serialized.slice(0, midpoint) }, null, 2);
    if (candidate.length <= MAX_RAW_ARTIFACT_CHARS) {
      content = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return { content, truncated: true };
}

async function persistRawReport(
  context: RuntimeToolExecutionContext,
  rawReport: unknown,
): Promise<{ artifact: ToolOutputArtifact; truncated: boolean }> {
  const { content, truncated } = boundedRawReportContent(rawReport);
  const artifact = await context.moduleContext.persistence.storeToolOutputArtifact({
    sessionId: context.sessionId,
    namespace: "security-diagnostics",
    turnId: context.turnId,
    toolCallId: context.callId,
    sourceToolName: "dependency_audit",
    fileName: `dependency-audit-${context.callId}.json`,
    mimeType: "application/json",
    kind: "text",
    summary: "Redacted raw dependency audit report; inline current-page findings remain authoritative",
    content,
    signal: context.signal,
  });
  return { artifact, truncated };
}

function failureResult(
  context: RuntimeToolExecutionContext,
  startedAt: string,
  error: ToolStructuredError,
  details: Record<string, unknown> = {},
): ToolResult {
  const body = {
    kind: "dependency_audit",
    status: "unavailable",
    capabilityUnavailable: error.type === "missing_dependency" || error.type === "unsupported_environment",
    automaticChangesApplied: false,
    dependencyInstallAttempted: false,
    lockfileModified: false,
    networkAccess: false,
    networkAttempted: false,
    ...details,
    error,
  };
  return {
    toolName: "dependency_audit",
    callId: context.callId,
    startedAt,
    endedAt: context.moduleContext.clock.now(),
    success: false,
    output: JSON.stringify(body),
    structuredContent: body,
    error: error.message,
  };
}

async function unavailableWithArtifact(
  context: RuntimeToolExecutionContext,
  startedAt: string,
  args: NormalizedArguments,
  message: string,
  dependency?: string,
  options: { rawReport?: unknown; networkAttempted?: boolean } = {},
): Promise<ToolResult> {
  const source: DependencyFindingSource = args.mode === "online"
    ? { name: "npm audit", kind: "dependency_auditor" }
    : { name: "npm package-lock local metadata", kind: "local_metadata" };
  const persisted = await persistRawReport(context, options.rawReport ?? {
    reportType: "capability_unavailable",
    reason: message,
    targetPath: args.targetPath,
    scope: args.scope,
    mode: args.mode,
    networkAttempted: Boolean(options.networkAttempted),
    automaticChangesApplied: false,
  });
  const result: DependencyAuditResult & { networkAttempted: boolean } = {
    kind: "dependency_audit",
    items: [],
    total: 0,
    totalExact: true,
    returned: 0,
    hasMore: false,
    truncated: persisted.truncated,
    maxResultChars: args.maxResultChars,
    warnings: [message, ...(persisted.truncated ? ["Raw report artifact was truncated at its capacity limit."] : [])],
    status: "unavailable",
    source: { ...source, reportArtifactUri: persisted.artifact.uri },
    artifactUri: persisted.artifact.uri,
    automaticChangesApplied: false,
    packageManager: "npm",
    networkAccess: Boolean(options.networkAttempted),
    networkAttempted: Boolean(options.networkAttempted),
    advisoryCoverage: args.mode === "online" ? "online_audit" : "local_metadata_only",
    dependencyInstallAttempted: false,
    lockfileModified: false,
  };
  return {
    toolName: "dependency_audit",
    callId: context.callId,
    startedAt,
    endedAt: context.moduleContext.clock.now(),
    success: false,
    output: JSON.stringify(result, null, 2),
    structuredContent: result,
    artifacts: [persisted.artifact],
    error: unavailableError(message, dependency).message,
  };
}

async function integrityFailureWithArtifact(
  context: RuntimeToolExecutionContext,
  startedAt: string,
  error: LockfileIntegrityError,
): Promise<ToolResult> {
  const persisted = await persistRawReport(context, error.rawReport);
  const body = {
    kind: "dependency_audit",
    status: "unavailable",
    capabilityUnavailable: false,
    automaticChangesApplied: false,
    dependencyInstallAttempted: false,
    lockfileModified: true,
    networkAccess: true,
    networkAttempted: true,
    artifactUri: persisted.artifact.uri,
    integrityCheck: { beforeHash: error.beforeHash, afterHash: error.afterHash },
    error: {
      type: "invalid_state",
      message: error.message,
      retryable: false,
      toolName: "dependency_audit",
    },
  };
  return {
    toolName: "dependency_audit",
    callId: context.callId,
    startedAt,
    endedAt: context.moduleContext.clock.now(),
    success: false,
    output: JSON.stringify(body, null, 2),
    structuredContent: body,
    artifacts: [persisted.artifact],
    error: error.message,
  };
}

async function executeDependencyAudit(
  raw: DependencyAuditArguments,
  context: RuntimeToolExecutionContext,
  options: DependencyAuditToolOptions,
): Promise<ToolResult> {
  const startedAt = context.moduleContext.clock.now();
  let args: NormalizedArguments;
  try {
    args = normalizeArguments(raw, context);
  } catch (error) {
    return failureResult(context, startedAt, {
      type: "invalid_arguments",
      message: sanitizedMessage(error),
      retryable: false,
      toolName: "dependency_audit",
    });
  }

  let target: AuditTarget;
  try {
    target = await locateAuditTarget(args, context);
  } catch (error) {
    try {
      return await unavailableWithArtifact(
        context,
        startedAt,
        args,
        sanitizedMessage(error),
        "package-lock.json",
      );
    } catch (artifactError) {
      return failureResult(context, startedAt, unavailableError(
        `Dependency audit capability and report persistence are unavailable: ${sanitizedMessage(artifactError)}`,
        "package-lock.json",
      ));
    }
  }

  let prepared: PreparedAudit;
  try {
    prepared = args.mode === "online"
      ? await prepareOnline(args, target, context, options.auditor)
      : await prepareOffline(args, target, context);
  } catch (error) {
    if (error instanceof LockfileIntegrityError) {
      try {
        return await integrityFailureWithArtifact(context, startedAt, error);
      } catch (artifactError) {
        return failureResult(context, startedAt, {
          type: "invalid_state",
          message: `${error.message} Raw integrity report persistence also failed: ${sanitizedMessage(artifactError)}`,
          retryable: false,
          toolName: "dependency_audit",
        }, {
          capabilityUnavailable: false,
          lockfileModified: true,
          networkAccess: true,
          networkAttempted: true,
          integrityCheck: { beforeHash: error.beforeHash, afterHash: error.afterHash },
        });
      }
    }
    try {
      return await unavailableWithArtifact(
        context,
        startedAt,
        args,
        `Dependency auditor unavailable: ${sanitizedMessage(error)}`,
        "npm audit",
        error instanceof DependencyAuditorExecutionError
          ? { rawReport: error.rawReport, networkAttempted: true }
          : {},
      );
    } catch (artifactError) {
      return failureResult(context, startedAt, unavailableError(
        `Dependency auditor and report persistence are unavailable: ${sanitizedMessage(artifactError)}`,
        "npm audit",
      ), {
        networkAccess: error instanceof DependencyAuditorExecutionError,
        networkAttempted: error instanceof DependencyAuditorExecutionError,
      });
    }
  }

  let persisted: { artifact: ToolOutputArtifact; truncated: boolean };
  try {
    persisted = await persistRawReport(context, prepared.rawReport);
  } catch (error) {
    return failureResult(context, startedAt, {
      type: "invalid_state",
      message: `Dependency audit raw report could not be persisted: ${sanitizedMessage(error)}`,
      retryable: true,
      toolName: "dependency_audit",
    }, {
      networkAccess: prepared.networkAccess,
      networkAttempted: prepared.networkAttempted,
    });
  }
  const source: DependencyFindingSource = {
    ...prepared.source,
    reportArtifactUri: persisted.artifact.uri,
  };
  const findings = prepared.findings.map((finding) => ({ ...finding, source }));
  const warnings = [...new Set([
    ...prepared.warnings,
    ...(persisted.truncated ? ["Raw report artifact was truncated at its bounded character capacity."] : []),
  ])].slice(0, 20);
  const requestDigest = createRequestDigest({
    version: AUDIT_CURSOR_VERSION,
    mode: args.mode,
    scope: args.scope,
    targetPath: args.targetPath,
    packageManager: args.packageManager,
  });
  const buildEnvelope = (
    items: DependencyFinding[],
    page: { cursor?: string; nextCursor?: string; hasMore: boolean; truncated: boolean },
  ): DependencyAuditResult & { networkAttempted: boolean } => ({
    kind: "dependency_audit",
    items,
    total: findings.length,
    totalExact: prepared.totalExact,
    returned: items.length,
    ...(page.cursor ? { cursor: page.cursor } : {}),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    hasMore: page.hasMore,
    truncated: page.truncated || !prepared.totalExact || persisted.truncated,
    maxResultChars: args.maxResultChars,
    warnings,
    status: prepared.status,
    source,
    artifactUri: persisted.artifact.uri,
    automaticChangesApplied: false,
    packageManager: "npm",
    networkAccess: prepared.networkAccess,
    networkAttempted: prepared.networkAttempted,
    advisoryCoverage: args.mode === "online" ? "online_audit" : "local_metadata_only",
    dependencyInstallAttempted: false,
    lockfileModified: false,
  });
  let result: DependencyAuditResult & { networkAttempted: boolean };
  try {
    result = paginateAuthoritativeItems({
      allItems: findings,
      cursor: args.cursor,
      binding: {
        workspaceId: prepared.workspaceId,
        tool: "dependency_audit",
        indexVersion: prepared.snapshotVersion,
        requestDigest,
      },
      maxItems: args.maxResults,
      maxResultChars: args.maxResultChars,
      buildEnvelope,
    }).envelope;
  } catch (error) {
    const type = error instanceof ResultPageBudgetError ? "invalid_arguments" : "invalid_state";
    const failure = failureResult(context, startedAt, {
      type,
      message: sanitizedMessage(error),
      retryable: false,
      toolName: "dependency_audit",
    }, {
      artifactUri: persisted.artifact.uri,
      items: [],
      networkAccess: prepared.networkAccess,
      networkAttempted: prepared.networkAttempted,
      ...(error instanceof ResultPageBudgetError ? {
        requiredChars: error.requiredChars,
        maxResultChars: error.maxResultChars,
      } : {}),
    });
    return { ...failure, artifacts: [persisted.artifact] };
  }
  return {
    toolName: "dependency_audit",
    callId: context.callId,
    startedAt,
    endedAt: context.moduleContext.clock.now(),
    success: prepared.status !== "unavailable",
    output: JSON.stringify(result, null, 2),
    structuredContent: result,
    artifacts: [persisted.artifact],
    ...(prepared.error ? { error: prepared.error.message } : {}),
  };
}

export function createDependencyAuditTool(
  options: DependencyAuditToolOptions = {},
): RuntimeToolSpec {
  return {
    name: "dependency_audit",
    description: "Report npm dependency metadata or explicitly approved npm audit advisories without installing, upgrading, fixing, or rewriting dependencies.",
    inputSchema: INPUT_SCHEMA,
    readOnly: true,
    permissionCategory: "read_only",
    sideEffectLevel: "none",
    timeoutCategory: "slow",
    groups: ["code_intelligence", "security", "dependencies", "diagnostics"],
    selection: {
      groups: ["code_intelligence", "security", "dependencies"],
      keywords: [
        "dependency_audit",
        "dependency audit",
        "dependency risk",
        "vulnerability audit",
        "npm audit",
        "package-lock",
        "依赖审计",
        "依赖漏洞",
        "依赖风险",
      ],
      keywordGroups: [["dependency", "vulnerability"], ["依赖", "安全"]],
    },
    resolveAccess: async (rawArgs, context): Promise<ToolAccessRequest[]> => {
      const args = normalizeArguments(rawArgs as DependencyAuditArguments, context);
      const target = await locateAuditTarget(args, context);
      const paths = [...new Set([
        target.manifestPath,
        target.lockRootManifestPath,
        target.lockfilePath,
      ])].sort(stableText);
      const requests: ToolAccessRequest[] = [{
        kind: "filesystem_read",
        paths,
        reason: "Read the resolved package manifest, npm lock-root manifest, and validated package-lock.json.",
      }];
      if (args.mode === "online") {
        const capability = await context.capabilities.get("npm");
        if (!capability?.available || !capability.command) {
          throw new Error("npm executable is unavailable; no online dependency audit command can be approved.");
        }
        requests.push({
          kind: "command_execute",
          cwd: target.lockRootPath,
          command: npmAuditCommandDisplay(target, capability.command),
          reason: "Run the capability-resolved npm executable with the fixed report-only audit arguments.",
        }, {
          kind: "network_access",
          hosts: [NPM_REGISTRY_HOST],
          reason: `Query npm advisories after approval. ${EXTERNAL_DEPENDENCY_DATA_BOUNDARY}`,
        });
      }
      return requests;
    },
    resolvePermission: async (rawArgs, context): Promise<ToolPermissionProfile> => {
      const args = normalizeArguments(rawArgs as DependencyAuditArguments, context);
      const target = await locateAuditTarget(args, context);
      if (args.mode === "offline") {
        return { permissionCategory: "read_only", sideEffectLevel: "none", readOnly: true };
      }
      const capability = await context.capabilities.get("npm");
      if (!capability?.available || !capability.command) {
        throw new Error("npm executable is unavailable; no online dependency audit command can be approved.");
      }
      const command = npmAuditCommandDisplay(target, capability.command);
      return {
        permissionCategory: "external_system",
        sideEffectLevel: "medium",
        readOnly: false,
        approvalContext: {
          action: "npm_audit_report_only",
          registryHost: NPM_REGISTRY_HOST,
          command,
          cwd: target.lockRootPath,
          targetManifestPath: target.manifestPath,
          lockRootManifestPath: target.lockRootManifestPath,
          lockfilePath: target.lockfilePath,
          lockfileHash: target.lockfileHash,
          workspaceName: target.workspaceName,
          dataBoundary: EXTERNAL_DEPENDENCY_DATA_BOUNDARY,
          externalPayload: ["package_names", "installed_versions", "dependency_graph"],
          scopeDigest: createRequestDigest({
            scope: args.scope,
            targetPath: target.targetPath,
            lockRootPath: target.lockRootPath,
            packageManager: args.requestedPackageManager,
            command,
          }),
          automaticChangesApplied: false,
        },
      };
    },
    redactArguments: (rawArgs) => {
      const args = rawArgs as DependencyAuditArguments;
      return { ...args, ...(args.cursor ? { cursor: "[OPAQUE_CURSOR_REDACTED]" } : {}) };
    },
    resolveExecutionTimeoutMs: (rawArgs) =>
      Math.min(305_000, ((rawArgs as DependencyAuditArguments).timeoutMs ?? 120_000) + 5_000),
    formatPreExecutionFailure: (failure) => {
      const body = {
        kind: "dependency_audit",
        status: "unavailable",
        capabilityUnavailable: true,
        reason: "Dependency audit capability resolution failed before execution; no audit command or dependency change was started.",
        automaticChangesApplied: false,
        dependencyInstallAttempted: false,
        lockfileModified: false,
        networkAccess: false,
        networkAttempted: false,
        error: failure.error,
      };
      return { output: JSON.stringify(body), structuredContent: body };
    },
    execute: (rawArgs, context) => executeDependencyAudit(
      rawArgs as DependencyAuditArguments,
      context,
      options,
    ),
  };
}
