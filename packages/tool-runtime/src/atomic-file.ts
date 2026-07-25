import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(typeof signal.reason === "string" ? signal.reason : "Atomic file publication was aborted.");
}

async function assertSafePublicationPath(trustedRoot: string, absolutePath: string): Promise<void> {
  const root = path.resolve(trustedRoot);
  const target = path.resolve(absolutePath);
  const relative = path.relative(root, target);
  if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Object.assign(new Error("Atomic publication target is outside its trusted root."), {
      code: "ERR_TOOL_PERMISSION_DENIED",
    });
  }
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw Object.assign(new Error("Atomic publication trusted root is unsafe."), {
      code: "ERR_TOOL_PERMISSION_DENIED",
    });
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw Object.assign(new Error("Atomic publication path traverses a symbolic link."), {
          code: "ERR_TOOL_PERMISSION_DENIED",
        });
      }
      if (current !== target && !stat.isDirectory()) {
        throw Object.assign(new Error("Atomic publication parent is not a directory."), {
          code: "ERR_TOOL_CONFLICTED",
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

interface PublicationParentSnapshot {
  trustedRoot: string;
  realRoot: string;
  parentPath: string;
  realParent: string;
  device: number | bigint;
  inode: number | bigint;
}

function assertPathInsideRoot(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Object.assign(new Error("Atomic publication path resolved outside its trusted root."), {
      code: "ERR_TOOL_PERMISSION_DENIED",
    });
  }
}

async function capturePublicationParent(
  trustedRoot: string,
  absolutePath: string,
): Promise<PublicationParentSnapshot> {
  const parentPath = path.dirname(absolutePath);
  const parent = await fs.lstat(parentPath);
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw Object.assign(new Error("Atomic publication parent is unsafe."), {
      code: "ERR_TOOL_PERMISSION_DENIED",
    });
  }
  const [realRoot, realParent] = await Promise.all([
    fs.realpath(trustedRoot),
    fs.realpath(parentPath),
  ]);
  assertPathInsideRoot(realRoot, realParent);
  return {
    trustedRoot,
    realRoot,
    parentPath,
    realParent,
    device: parent.dev,
    inode: parent.ino,
  };
}

async function assertPublicationParentStable(snapshot: PublicationParentSnapshot): Promise<void> {
  const parent = await fs.lstat(snapshot.parentPath);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.dev !== snapshot.device ||
    parent.ino !== snapshot.inode
  ) {
    throw Object.assign(new Error("Atomic publication parent changed during publication."), {
      code: "ERR_TOOL_CONFLICTED",
    });
  }
  const realParent = await fs.realpath(snapshot.parentPath);
  assertPathInsideRoot(snapshot.realRoot, realParent);
  if (realParent !== snapshot.realParent) {
    throw Object.assign(new Error("Atomic publication parent identity changed during publication."), {
      code: "ERR_TOOL_CONFLICTED",
    });
  }
}

async function assertOpenedPublicationFile(
  snapshot: PublicationParentSnapshot,
  absolutePath: string,
  handle: Awaited<ReturnType<typeof fs.open>>,
): Promise<void> {
  await assertPublicationParentStable(snapshot);
  await assertSafePublicationPath(snapshot.trustedRoot, absolutePath);
  const [opened, pathStat, realTarget] = await Promise.all([
    handle.stat(),
    fs.lstat(absolutePath),
    fs.realpath(absolutePath),
  ]);
  assertPathInsideRoot(snapshot.realRoot, realTarget);
  if (
    !opened.isFile() ||
    !pathStat.isFile() ||
    pathStat.isSymbolicLink() ||
    opened.dev !== pathStat.dev ||
    opened.ino !== pathStat.ino
  ) {
    throw Object.assign(new Error("Atomic publication staging file identity is unsafe."), {
      code: "ERR_TOOL_CONFLICTED",
    });
  }
}

/**
 * Publish a complete UTF-8 file without ever truncating the live target first.
 * The temporary file is created in the target directory so the final rename
 * stays on the same filesystem. A platform that cannot perform the direct
 * atomic replacement fails closed; a path-based backup swap would reopen a
 * parent-directory race and could also obscure a failed restoration.
 */
async function publishFileAtomic(
  absolutePath: string,
  content: string | Uint8Array,
  signal?: AbortSignal,
  options?: { overwrite: boolean; expectedTargetIdentity?: string; trustedRoot?: string },
): Promise<void> {
  throwIfAborted(signal);
  if (options?.trustedRoot) await assertSafePublicationPath(options.trustedRoot, absolutePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  if (options?.trustedRoot) await assertSafePublicationPath(options.trustedRoot, absolutePath);
  const publicationParent = options?.trustedRoot
    ? await capturePublicationParent(options.trustedRoot, absolutePath)
    : undefined;
  const existingStat = await fs.lstat(absolutePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (options && existingStat && (!existingStat.isFile() || existingStat.isSymbolicLink())) {
    throw Object.assign(new Error("Atomic publication target is not a regular file."), {
      code: "ERR_TOOL_CONFLICTED",
    });
  }
  const identity = (stat: Awaited<ReturnType<typeof fs.lstat>> | undefined) => stat
    ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
    : undefined;
  const assertExpectedTarget = async () => {
    if (!options) return;
    const current = await fs.lstat(absolutePath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (current && (!current.isFile() || current.isSymbolicLink())) {
      throw Object.assign(new Error("Atomic publication target became unsafe."), {
        code: "ERR_TOOL_CONFLICTED",
      });
    }
    if (identity(current) !== options.expectedTargetIdentity) {
      throw Object.assign(new Error("Atomic publication target changed before commit."), {
        code: "ERR_TOOL_CONFLICTED",
      });
    }
  };
  const temporaryPath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.${process.pid}.${randomUUID()}.deep-mix.tmp`,
  );
  try {
    const handle = await fs.open(temporaryPath, "wx", existingStat?.mode ?? 0o666);
    try {
      if (publicationParent) await assertOpenedPublicationFile(publicationParent, temporaryPath, handle);
      if (typeof content === "string") await handle.writeFile(content, "utf8");
      else await handle.writeFile(content);
      await handle.sync();
      if (publicationParent) await assertOpenedPublicationFile(publicationParent, temporaryPath, handle);
    } finally {
      await handle.close();
    }
    throwIfAborted(signal);
    if (options?.trustedRoot) await assertSafePublicationPath(options.trustedRoot, absolutePath);
    if (publicationParent) await assertPublicationParentStable(publicationParent);
    await assertExpectedTarget();

    if (options && !options.overwrite) {
      try {
        await fs.link(temporaryPath, absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw Object.assign(new Error("Atomic publication target appeared before commit."), {
            code: "ERR_TOOL_CONFLICTED",
          });
        }
        throw error;
      }
      await fs.rm(temporaryPath, { force: true });
      return;
    }

    if (process.platform !== "win32") {
      if (publicationParent) await assertPublicationParentStable(publicationParent);
      await fs.rename(temporaryPath, absolutePath);
      return;
    }

    try {
      if (publicationParent) await assertPublicationParentStable(publicationParent);
      await fs.rename(temporaryPath, absolutePath);
      return;
    } catch (error) {
      if (!["EACCES", "EBUSY", "EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw error;
      }
      throw Object.assign(
        new Error("This platform could not atomically replace the approved export target."),
        { code: "ERR_TOOL_UNAVAILABLE" },
      );
    }
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function publishTextFileAtomic(
  absolutePath: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  return publishFileAtomic(absolutePath, content, signal);
}

/** Publish arbitrary artifact bytes with the same checkpoint-friendly atomic semantics as text writes. */
export async function publishBinaryFileAtomic(
  absolutePath: string,
  content: Uint8Array,
  signal?: AbortSignal,
  options?: { overwrite?: boolean; expectedTargetIdentity?: string; trustedRoot?: string },
): Promise<void> {
  return publishFileAtomic(
    absolutePath,
    content,
    signal,
    options ? {
      overwrite: options.overwrite === true,
      expectedTargetIdentity: options.expectedTargetIdentity,
      trustedRoot: options.trustedRoot,
    } : undefined,
  );
}
