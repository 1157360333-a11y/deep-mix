import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { sanitizeToolOutputFilename } from "../../../../packages/persistence/src/index.js";

export const MAX_DOCUMENT_ATTACHMENT_BYTES = 32 * 1024 * 1024;

const DOCUMENT_IMPORT_SUBDIRECTORY = [".deep-mix", "desktop-attachments", "imports"] as const;
const SUPPORTED_DOCUMENT_MIME_TYPES = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ipynb": "application/x-ipynb+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".gzip": "application/gzip",
} as const satisfies Record<string, string>;

type SupportedDocumentExtension = keyof typeof SUPPORTED_DOCUMENT_MIME_TYPES;

export type DocumentAttachmentImportErrorCode =
  | "source_not_found"
  | "source_not_file"
  | "unsupported_extension"
  | "file_too_large"
  | "workspace_not_directory"
  | "unsafe_import_directory"
  | "import_failed";

export class DocumentAttachmentImportError extends Error {
  public constructor(
    public readonly code: DocumentAttachmentImportErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DocumentAttachmentImportError";
  }
}

export interface ImportedDocumentAttachment {
  name: string;
  relativePath: string;
  ref: `file://${string}`;
  size: number;
  mimeType: string;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isPathInside(root: string, targetPath: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(targetPath));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isSupportedDocumentExtension(extension: string): extension is SupportedDocumentExtension {
  return Object.hasOwn(SUPPORTED_DOCUMENT_MIME_TYPES, extension);
}

export function mimeForDocumentAttachmentPath(filePath: string): string | undefined {
  const extension = path.extname(filePath).toLowerCase();
  return isSupportedDocumentExtension(extension)
    ? SUPPORTED_DOCUMENT_MIME_TYPES[extension]
    : undefined;
}

export function isSupportedDocumentAttachmentPath(filePath: string): boolean {
  return mimeForDocumentAttachmentPath(filePath) !== undefined;
}

async function statSourceFile(sourcePath: string): Promise<Awaited<ReturnType<typeof fs.stat>>> {
  try {
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) {
      throw new DocumentAttachmentImportError(
        "source_not_file",
        "附件必须是普通文件。",
        { sourceName: path.basename(sourcePath) },
      );
    }
    return stat;
  } catch (error) {
    if (error instanceof DocumentAttachmentImportError) throw error;
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new DocumentAttachmentImportError(
        "source_not_found",
        "选择的附件不存在。",
        { sourceName: path.basename(sourcePath) },
      );
    }
    throw new DocumentAttachmentImportError(
      "import_failed",
      "无法读取选择的附件。",
      { sourceName: path.basename(sourcePath) },
    );
  }
}

async function resolveImportDirectory(workspaceRoot: string): Promise<{ workspaceRoot: string; importDirectory: string }> {
  const absoluteWorkspaceRoot = path.resolve(workspaceRoot);
  let workspaceStat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    workspaceStat = await fs.stat(absoluteWorkspaceRoot);
  } catch {
    throw new DocumentAttachmentImportError("workspace_not_directory", "当前工作区目录不存在。", {
      workspaceRoot: absoluteWorkspaceRoot,
    });
  }
  if (!workspaceStat.isDirectory()) {
    throw new DocumentAttachmentImportError("workspace_not_directory", "当前工作区路径不是目录。", {
      workspaceRoot: absoluteWorkspaceRoot,
    });
  }

  const importDirectory = path.join(absoluteWorkspaceRoot, ...DOCUMENT_IMPORT_SUBDIRECTORY);
  try {
    await fs.mkdir(importDirectory, { recursive: true });
    const [realWorkspaceRoot, realImportDirectory] = await Promise.all([
      fs.realpath(absoluteWorkspaceRoot),
      fs.realpath(importDirectory),
    ]);
    if (!isPathInside(realWorkspaceRoot, realImportDirectory)) {
      throw new DocumentAttachmentImportError(
        "unsafe_import_directory",
        "桌面附件导入目录逃逸了当前工作区。",
      );
    }
  } catch (error) {
    if (error instanceof DocumentAttachmentImportError) throw error;
    throw new DocumentAttachmentImportError("import_failed", "无法创建桌面附件导入目录。");
  }

  return { workspaceRoot: absoluteWorkspaceRoot, importDirectory };
}

async function copyWithoutOverwrite(
  sourcePath: string,
  importDirectory: string,
  requestedName: string,
): Promise<string> {
  const parsed = path.parse(sanitizeToolOutputFilename(requestedName));
  const safeStem = parsed.name || "attachment";
  const safeExtension = parsed.ext.toLowerCase();

  for (let index = 1; ; index += 1) {
    const candidateName = index === 1 ? `${safeStem}${safeExtension}` : `${safeStem}-${index}${safeExtension}`;
    const candidatePath = path.join(importDirectory, candidateName);
    try {
      await fs.copyFile(sourcePath, candidatePath, fsConstants.COPYFILE_EXCL);
      return candidatePath;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") continue;
      throw new DocumentAttachmentImportError(
        "import_failed",
        "无法将附件复制到当前工作区。",
        { sourceName: path.basename(sourcePath) },
      );
    }
  }
}

export async function importDocumentAttachment(input: {
  sourcePath: string;
  workspaceRoot: string;
}): Promise<ImportedDocumentAttachment> {
  const sourcePath = path.resolve(input.sourcePath);
  const extension = path.extname(sourcePath).toLowerCase();
  if (!isSupportedDocumentExtension(extension)) {
    throw new DocumentAttachmentImportError(
      "unsupported_extension",
      "该附件格式不在 Desktop 受信导入 allowlist 中。",
      {
        extension: extension || "none",
        supportedExtensions: Object.keys(SUPPORTED_DOCUMENT_MIME_TYPES),
      },
    );
  }

  const sourceStat = await statSourceFile(sourcePath);
  if (sourceStat.size > MAX_DOCUMENT_ATTACHMENT_BYTES) {
    throw new DocumentAttachmentImportError(
      "file_too_large",
      "Desktop 受信附件不能超过 32 MiB。",
      { size: sourceStat.size, maxBytes: MAX_DOCUMENT_ATTACHMENT_BYTES },
    );
  }

  const { workspaceRoot, importDirectory } = await resolveImportDirectory(input.workspaceRoot);
  const [realSourcePath, realImportDirectory] = await Promise.all([
    fs.realpath(sourcePath),
    fs.realpath(importDirectory),
  ]);
  const safeName = sanitizeToolOutputFilename(path.basename(sourcePath));

  let importedPath: string;
  if (pathsEqual(path.dirname(realSourcePath), realImportDirectory) && path.basename(sourcePath) === safeName) {
    importedPath = sourcePath;
  } else {
    importedPath = await copyWithoutOverwrite(realSourcePath, importDirectory, safeName);
  }

  const importedStat = await fs.stat(importedPath);
  if (importedStat.size > MAX_DOCUMENT_ATTACHMENT_BYTES) {
    if (!pathsEqual(importedPath, sourcePath)) await fs.rm(importedPath, { force: true });
    throw new DocumentAttachmentImportError(
      "file_too_large",
      "Desktop 受信附件不能超过 32 MiB。",
      { size: importedStat.size, maxBytes: MAX_DOCUMENT_ATTACHMENT_BYTES },
    );
  }

  const relativePath = path.relative(workspaceRoot, importedPath).replace(/\\/g, "/");
  if (!relativePath || relativePath === ".." || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
    if (!pathsEqual(importedPath, sourcePath)) await fs.rm(importedPath, { force: true });
    throw new DocumentAttachmentImportError(
      "unsafe_import_directory",
      "导入后的附件不在当前工作区中。",
    );
  }

  return {
    name: path.basename(importedPath),
    relativePath,
    ref: `file://${relativePath}`,
    size: importedStat.size,
    mimeType: SUPPORTED_DOCUMENT_MIME_TYPES[extension],
  };
}
