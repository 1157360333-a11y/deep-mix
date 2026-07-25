import { promises as fs } from "node:fs";
import path from "node:path";

import type { ToolAccessRequest, ToolResult } from "../../../../shared-schema/src/index.js";
import {
  PROTECTED_READ_PREFIXES,
  RepositoryIgnoreResolver,
  isProtectedReadPath,
  normalizeRepositoryPath,
} from "../../repository-explorer.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolAccessResolutionContext,
  ToolModule,
  ToolPathServices,
} from "../../tool-module.js";

const MAX_RECURSIVE_ENTRIES = 10_000;
const MAX_RECURSIVE_TOTAL_BYTES = 512 * 1024 * 1024;

type ManagePathAction = "mkdir" | "copy" | "move" | "rename" | "delete";

interface ManagePathArgs {
  action: ManagePathAction;
  path?: string;
  source?: string;
  destination?: string;
  recursive?: boolean;
  overwrite?: boolean;
  maxEntries?: number;
  maxTotalBytes?: number;
}

interface ManagedPath {
  relativePath: string;
  absolutePath: string;
  exists: boolean;
  firstMissingRelativePath?: string;
  stat?: Awaited<ReturnType<typeof fs.lstat>>;
}

interface ManagePathPlan {
  action: ManagePathAction;
  path?: ManagedPath;
  source?: ManagedPath;
  destination?: ManagedPath;
  readPaths: string[];
  writePaths: string[];
  recursiveLimits: {
    maxEntries: number;
    maxTotalBytes: number;
  };
}

interface PathPreparationContext {
  workspaceRoot: string;
  paths: ToolPathServices;
}

interface TreeBudget {
  entries: number;
  totalBytes: number;
  maxEntries: number;
  maxTotalBytes: number;
}

interface OperationProgress {
  step: string;
  action: ManagePathAction;
  path?: string;
  source?: string;
  destination?: string;
}

function pathKey(value: string): string {
  const normalized = normalizeRepositoryPath(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function uniquePaths(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = pathKey(value);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function isSameOrNestedPath(candidate: string, ancestor: string): boolean {
  const candidateKey = pathKey(candidate);
  const ancestorKey = pathKey(ancestor);
  return candidateKey === ancestorKey || candidateKey.startsWith(`${ancestorKey}/`);
}

function assertNotProtectedMutationPath(relativePath: string): void {
  const normalized = normalizeRepositoryPath(relativePath).replace(/^\.\//, "");
  if (process.platform === "win32") {
    for (const segment of normalized.split("/")) {
      const stem = segment.split(".")[0] ?? "";
      if (
        segment.includes(":") ||
        /[. ]$/u.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem)
      ) {
        throw new Error("manage_path rejects ambiguous Windows path components.");
      }
    }
  }
  const candidate = pathKey(normalized);
  if (!normalized || normalized === ".") {
    throw new Error("manage_path cannot mutate the workspace root.");
  }
  if (isProtectedReadPath(normalized)) {
    throw new Error("manage_path cannot operate on a protected repository path.");
  }
  const protectsDescendant = PROTECTED_READ_PREFIXES.some((prefix) =>
    pathKey(prefix).startsWith(`${candidate}/`));
  if (protectsDescendant) {
    throw new Error("manage_path cannot operate on an ancestor of protected runtime state.");
  }
}

async function resolveManagedPath(
  requestedPath: string,
  context: PathPreparationContext,
): Promise<ManagedPath> {
  if (!requestedPath.trim() || requestedPath.includes("://")) {
    throw new Error("manage_path requires a non-empty workspace-relative path.");
  }
  const absolutePath = context.paths.resolveWorkspace(requestedPath);
  const relativePath = normalizeRepositoryPath(path.relative(context.workspaceRoot, absolutePath)) || ".";
  assertNotProtectedMutationPath(relativePath);

  let currentPath = path.resolve(context.workspaceRoot);
  let firstMissingRelativePath: string | undefined;
  const segments = relativePath.split("/").filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    currentPath = path.join(currentPath, segments[index]!);
    try {
      const stat = await fs.lstat(currentPath);
      if (stat.isSymbolicLink()) {
        throw new Error("manage_path does not follow symbolic links or junctions.");
      }
      if (index < segments.length - 1 && !stat.isDirectory()) {
        throw new Error("A parent component of the managed path is not a directory.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        firstMissingRelativePath = normalizeRepositoryPath(path.relative(context.workspaceRoot, currentPath));
        break;
      }
      throw error;
    }
  }

  let stat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  try {
    stat = await fs.lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (stat?.isSymbolicLink()) throw new Error("manage_path does not follow symbolic links or junctions.");
  return {
    relativePath,
    absolutePath,
    exists: stat !== undefined,
    firstMissingRelativePath,
    stat,
  };
}

function consumeTreeBudget(budget: TreeBudget, sizeBytes: number): void {
  budget.entries += 1;
  budget.totalBytes += sizeBytes;
  if (budget.entries > budget.maxEntries) {
    throw new Error(`Recursive operation exceeds maxEntries (${budget.maxEntries}).`);
  }
  if (budget.totalBytes > budget.maxTotalBytes) {
    throw new Error(`Recursive operation exceeds maxTotalBytes (${budget.maxTotalBytes}).`);
  }
}

async function assertManagedTree(
  absolutePath: string,
  context: PathPreparationContext,
  ignoreResolver: RepositoryIgnoreResolver,
  budget: TreeBudget,
): Promise<void> {
  const stat = await fs.lstat(absolutePath);
  if (stat.isSymbolicLink()) throw new Error("Recursive operation encountered a symbolic link or junction.");
  const relativePath = normalizeRepositoryPath(path.relative(context.workspaceRoot, absolutePath));
  assertNotProtectedMutationPath(relativePath);
  if (await ignoreResolver.isIgnored(relativePath, stat.isDirectory())) {
    throw new Error("manage_path cannot read a path excluded by repository ignore rules.");
  }
  if (stat.isFile()) {
    consumeTreeBudget(budget, stat.size);
    return;
  }
  if (!stat.isDirectory()) throw new Error("manage_path supports regular files and directories only.");
  consumeTreeBudget(budget, 0);
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    await assertManagedTree(path.join(absolutePath, entry.name), context, ignoreResolver, budget);
  }
}

function requireRecursiveLimits(args: ManagePathArgs): { maxEntries: number; maxTotalBytes: number } {
  if (args.recursive !== true || args.maxEntries === undefined || args.maxTotalBytes === undefined) {
    throw new Error("Directory operations require recursive=true with explicit maxEntries and maxTotalBytes.");
  }
  return {
    maxEntries: args.maxEntries,
    maxTotalBytes: args.maxTotalBytes,
  };
}

function semanticArguments(args: ManagePathArgs): void {
  if (args.action === "mkdir" || args.action === "delete") {
    if (!args.path || args.source !== undefined || args.destination !== undefined) {
      throw new Error(`${args.action} requires path and does not accept source or destination.`);
    }
    return;
  }
  if (!args.source || !args.destination || args.path !== undefined) {
    throw new Error(`${args.action} requires source and destination and does not accept path.`);
  }
}

async function prepareManagePath(
  args: ManagePathArgs,
  context: PathPreparationContext,
): Promise<ManagePathPlan> {
  semanticArguments(args);
  const defaultLimits = {
    maxEntries: MAX_RECURSIVE_ENTRIES,
    maxTotalBytes: MAX_RECURSIVE_TOTAL_BYTES,
  };
  const ignoreResolver = new RepositoryIgnoreResolver(context.workspaceRoot);

  if (args.action === "mkdir") {
    const target = await resolveManagedPath(args.path!, context);
    if (target.exists) throw new Error("mkdir target already exists.");
    const missingAncestor = target.firstMissingRelativePath ?? target.relativePath;
    if (args.recursive !== true && pathKey(missingAncestor) !== pathKey(target.relativePath)) {
      throw new Error("mkdir parent does not exist; set recursive=true to create parent directories.");
    }
    const limits = args.recursive === true ? requireRecursiveLimits(args) : defaultLimits;
    if (args.recursive === true) {
      const missingDepth = missingAncestor.split("/").length;
      const targetDepth = target.relativePath.split("/").length;
      const directoriesCreated = targetDepth - missingDepth + 1;
      if (directoriesCreated > limits.maxEntries) {
        throw new Error(`Recursive mkdir exceeds maxEntries (${limits.maxEntries}).`);
      }
    }
    return {
      action: args.action,
      path: target,
      readPaths: [],
      writePaths: uniquePaths([missingAncestor, target.relativePath]),
      recursiveLimits: limits,
    };
  }

  if (args.action === "delete") {
    const target = await resolveManagedPath(args.path!, context);
    if (!target.exists || !target.stat) throw new Error("delete target does not exist.");
    const limits = target.stat.isDirectory() ? requireRecursiveLimits(args) : defaultLimits;
    const budget: TreeBudget = { entries: 0, totalBytes: 0, ...limits };
    await assertManagedTree(target.absolutePath, context, ignoreResolver, budget);
    return {
      action: args.action,
      path: target,
      readPaths: [target.relativePath],
      writePaths: [target.relativePath],
      recursiveLimits: limits,
    };
  }

  const source = await resolveManagedPath(args.source!, context);
  const destination = await resolveManagedPath(args.destination!, context);
  if (!source.exists || !source.stat) throw new Error(`${args.action} source does not exist.`);
  if (pathKey(source.relativePath) === pathKey(destination.relativePath)) {
    if (process.platform === "win32" && source.relativePath !== destination.relativePath) {
      throw new Error("Case-only rename or move is not supported safely on Windows.");
    }
    throw new Error("Source and destination must be different paths.");
  }
  if (
    isSameOrNestedPath(source.relativePath, destination.relativePath) ||
    isSameOrNestedPath(destination.relativePath, source.relativePath)
  ) {
    throw new Error("Source and destination cannot be ancestors or descendants of each other.");
  }
  const destinationParent = normalizeRepositoryPath(path.dirname(destination.relativePath));
  if (
    destination.firstMissingRelativePath &&
    pathKey(destination.firstMissingRelativePath) !== pathKey(destination.relativePath)
  ) {
    throw new Error("Destination parent directory does not exist.");
  }
  const destinationParentStat = await fs.lstat(context.paths.resolveWorkspace(destinationParent));
  if (!destinationParentStat.isDirectory() || destinationParentStat.isSymbolicLink()) {
    throw new Error("Destination parent must be a real directory.");
  }
  if (args.action === "rename") {
    const sourceParent = normalizeRepositoryPath(path.dirname(source.relativePath));
    if (pathKey(sourceParent) !== pathKey(destinationParent)) {
      throw new Error("rename requires source and destination to share the same parent; use move otherwise.");
    }
  }
  if (destination.exists && args.overwrite !== true) {
    throw new Error("Destination exists; set overwrite=true for an exact replacement.");
  }

  const includesDirectory = source.stat.isDirectory() || destination.stat?.isDirectory() === true;
  const limits = includesDirectory ? requireRecursiveLimits(args) : defaultLimits;
  const budget: TreeBudget = { entries: 0, totalBytes: 0, ...limits };
  await assertManagedTree(source.absolutePath, context, ignoreResolver, budget);
  if (destination.exists) {
    await assertManagedTree(destination.absolutePath, context, ignoreResolver, budget);
  }
  return {
    action: args.action,
    source,
    destination,
    readPaths: uniquePaths([
      source.relativePath,
      ...(destination.exists ? [destination.relativePath] : []),
    ]),
    writePaths: args.action === "copy"
      ? [destination.relativePath]
      : uniquePaths([source.relativePath, destination.relativePath]),
    recursiveLimits: limits,
  };
}

async function copyManagedTree(
  sourcePath: string,
  destinationPath: string,
  context: PathPreparationContext,
  ignoreResolver: RepositoryIgnoreResolver,
  budget: TreeBudget,
): Promise<void> {
  const stat = await fs.lstat(sourcePath);
  if (stat.isSymbolicLink()) throw new Error("Copy encountered a symbolic link or junction.");
  const sourceRelativePath = normalizeRepositoryPath(path.relative(context.workspaceRoot, sourcePath));
  assertNotProtectedMutationPath(sourceRelativePath);
  if (await ignoreResolver.isIgnored(sourceRelativePath, stat.isDirectory())) {
    throw new Error("Copy encountered a path excluded by repository ignore rules.");
  }
  if (stat.isFile()) {
    consumeTreeBudget(budget, stat.size);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
    return;
  }
  if (!stat.isDirectory()) throw new Error("Copy supports regular files and directories only.");
  consumeTreeBudget(budget, 0);
  await fs.mkdir(destinationPath, { recursive: true });
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    await copyManagedTree(
      path.join(sourcePath, entry.name),
      path.join(destinationPath, entry.name),
      context,
      ignoreResolver,
      budget,
    );
  }
}

function operationDescriptor(plan: ManagePathPlan, step: string): OperationProgress {
  return {
    step,
    action: plan.action,
    path: plan.path?.relativePath,
    source: plan.source?.relativePath,
    destination: plan.destination?.relativePath,
  };
}

function safeRequestedPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeRepositoryPath(value);
  if (
    path.isAbsolute(value) ||
    normalized.includes(":") ||
    normalized.split("/").includes("..")
  ) {
    return "<invalid-path>";
  }
  return normalized;
}

function preExecutionDescriptor(args: ManagePathArgs): OperationProgress & { reason: string } {
  return {
    step: "preflight",
    action: args.action,
    path: safeRequestedPath(args.path),
    source: safeRequestedPath(args.source),
    destination: safeRequestedPath(args.destination),
    reason: "The operation did not pass guarded preflight and no workspace write was attempted.",
  };
}

function safeOperationFailure(error: unknown): { code?: string; message: string } {
  const code = (error as NodeJS.ErrnoException).code;
  const knownCodes = new Set(["EACCES", "EEXIST", "ENOENT", "ENOTEMPTY", "EPERM", "EXDEV"]);
  if (code && knownCodes.has(code)) return { code, message: `Filesystem operation failed with ${code}.` };
  const message = (error as Error).message;
  if (
    message.includes("symbolic link") ||
    message.includes("junction") ||
    message.includes("protected") ||
    message.includes("ignore rules") ||
    message.includes("maxEntries") ||
    message.includes("maxTotalBytes")
  ) {
    return { message };
  }
  return { message: "The path operation could not be completed safely." };
}

function result(
  context: RuntimeToolExecutionContext,
  success: boolean,
  output: string,
  structuredContent: Record<string, unknown>,
): ToolResult {
  const timestamp = context.moduleContext.clock.now();
  const fullResult = { message: output, ...structuredContent };
  return {
    toolName: "manage_path",
    callId: context.callId,
    startedAt: timestamp,
    endedAt: timestamp,
    success,
    output: JSON.stringify(fullResult),
    structuredContent: fullResult,
    error: success ? undefined : output,
  };
}

const managePathTool: RuntimeToolSpec = {
  name: "manage_path",
  displayName: "Manage Path / 路径操作",
  description: "Checkpointed mkdir, exact copy, move, rename, or delete for guarded workspace paths.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    oneOf: [
      { properties: { action: { const: "mkdir" } }, required: ["path"] },
      { properties: { action: { const: "delete" } }, required: ["path"] },
      { properties: { action: { const: "copy" } }, required: ["source", "destination"] },
      { properties: { action: { const: "move" } }, required: ["source", "destination"] },
      { properties: { action: { const: "rename" } }, required: ["source", "destination"] },
    ],
    properties: {
      action: { type: "string", enum: ["mkdir", "copy", "move", "rename", "delete"] },
      path: { type: "string", minLength: 1, maxLength: 2_000, pattern: "\\S" },
      source: { type: "string", minLength: 1, maxLength: 2_000, pattern: "\\S" },
      destination: { type: "string", minLength: 1, maxLength: 2_000, pattern: "\\S" },
      recursive: { type: "boolean", default: false },
      overwrite: { type: "boolean", default: false },
      maxEntries: { type: "integer", minimum: 1, maximum: MAX_RECURSIVE_ENTRIES },
      maxTotalBytes: { type: "integer", minimum: 0, maximum: MAX_RECURSIVE_TOTAL_BYTES },
    },
  },
  readOnly: false,
  permissionCategory: "write_file",
  sideEffectLevel: "high",
  timeoutCategory: "slow",
  groups: ["workspace", "paths", "repository_enhancements"],
  selection: {
    groups: ["workspace", "paths", "repository_enhancements"],
    keywords: ["manage path", "mkdir", "copy path", "move path", "rename path", "delete path", "路径操作", "创建目录", "复制路径", "移动路径", "重命名", "删除路径"],
    attachmentExtensions: [],
    mimeTypes: [],
  },
  capabilityRequirements: [],
  checkpoint: {
    mode: "before_write",
    scope: "pre_tool_write",
    reason: "Before a guarded manage_path mutation.",
    restoreOnFailure: true,
  },
  resolveAccess: async (rawArgs, context): Promise<ToolAccessRequest[]> => {
    const plan = await prepareManagePath(rawArgs as ManagePathArgs, {
      workspaceRoot: context.workspaceRoot,
      paths: context.paths,
    });
    return [
      ...(plan.readPaths.length > 0 ? [{
        kind: "filesystem_read" as const,
        paths: plan.readPaths,
        reason: `Inspect and checkpoint sources for manage_path ${plan.action}.`,
      }] : []),
      {
        kind: "filesystem_write" as const,
        paths: plan.writePaths,
        reason: `Apply checkpointed manage_path ${plan.action} to declared workspace paths.`,
      },
    ];
  },
  formatPreExecutionFailure: (failure, rawArgs) => {
    const args = rawArgs as ManagePathArgs;
    const safeFailure = safeOperationFailure(new Error(failure.error.message));
    const structuredContent = {
        kind: "manage_path",
        action: args.action,
        stage: failure.stage,
        completed: [],
        uncompleted: [preExecutionDescriptor(args)],
        failure: {
          ...safeFailure,
          type: failure.error.type,
        },
        automaticRestore: "not_required",
      };
    return {
      output: JSON.stringify(structuredContent),
      structuredContent,
    };
  },
  execute: async (rawArgs, context) => {
    const args = rawArgs as ManagePathArgs;
    const completed: OperationProgress[] = [];
    let plan: ManagePathPlan | undefined;
    try {
      if (!context.checkpoint) throw new Error("manage_path requires a runtime checkpoint before writing.");
      const preparationContext: PathPreparationContext = {
        workspaceRoot: context.workspaceRoot,
        paths: context.moduleContext.paths,
      };
      plan = await prepareManagePath(args, preparationContext);
      if (plan.action === "mkdir") {
        await fs.mkdir(plan.path!.absolutePath, { recursive: args.recursive === true });
      } else if (plan.action === "delete") {
        await fs.rm(plan.path!.absolutePath, { recursive: plan.path!.stat!.isDirectory(), force: false });
      } else {
        if (plan.destination!.exists) {
          await fs.rm(plan.destination!.absolutePath, { recursive: true, force: false });
          completed.push(operationDescriptor(plan, "remove_destination"));
        }
        if (plan.action === "copy") {
          const budget: TreeBudget = {
            entries: 0,
            totalBytes: 0,
            ...plan.recursiveLimits,
          };
          await copyManagedTree(
            plan.source!.absolutePath,
            plan.destination!.absolutePath,
            preparationContext,
            new RepositoryIgnoreResolver(context.workspaceRoot),
            budget,
          );
        } else {
          await fs.rename(plan.source!.absolutePath, plan.destination!.absolutePath);
        }
      }
      completed.push(operationDescriptor(plan, plan.action));
      return result(
        context,
        true,
        `manage_path completed ${plan.action}; checkpoint=${context.checkpoint.checkpointId}`,
        {
          kind: "manage_path",
          action: plan.action,
          checkpointId: context.checkpoint.checkpointId,
          completed,
          uncompleted: [],
          undoAvailable: true,
        },
      );
    } catch (error) {
      const failure = safeOperationFailure(error);
      const uncompleted = [operationDescriptor(plan ?? {
        action: args.action,
        readPaths: [],
        writePaths: [],
        recursiveLimits: {
          maxEntries: args.maxEntries ?? MAX_RECURSIVE_ENTRIES,
          maxTotalBytes: args.maxTotalBytes ?? MAX_RECURSIVE_TOTAL_BYTES,
        },
      }, args.action)];
      return result(
        context,
        false,
        `manage_path did not complete ${args.action}; runtime checkpoint restore is required. ${failure.message}`,
        {
          kind: "manage_path",
          action: args.action,
          checkpointId: context.checkpoint?.checkpointId,
          completed,
          uncompleted,
          failure,
          automaticRestore: context.checkpoint ? "runtime_pending" : "not_available",
        },
      );
    }
  },
};

export const workspacePathsToolModule: ToolModule = {
  manifest: {
    id: "builtin.workspace.paths",
    version: "1.0.0",
    description: "Checkpointed guarded workspace path operations.",
    source: "built_in",
  },
  create: () => managePathTool,
};
