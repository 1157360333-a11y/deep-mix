import { promises as fs } from "node:fs";
import path from "node:path";

import { publishTextFileAtomic } from "./atomic-file.js";

export interface ParsedPatchChange {
  action: "add" | "update" | "delete";
  path: string;
  lines: string[];
}

function resolveArtifactPatchTarget(workspaceRoot: string, declaredPath: string): {
  absolutePath: string;
  normalizedPath: string;
  identity: string;
} {
  const absoluteRoot = path.resolve(workspaceRoot);
  const absolutePath = path.resolve(absoluteRoot, declaredPath);
  const relativePath = path.relative(absoluteRoot, absolutePath);
  if (
    !relativePath ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`Artifact patch path escapes or does not name a file: ${declaredPath}`);
  }
  const normalizedPath = relativePath.split(path.sep).join("/");
  return {
    absolutePath,
    normalizedPath,
    identity: process.platform === "win32" ? normalizedPath.toLocaleLowerCase() : normalizedPath,
  };
}

function stripEnvelope(rawPatch: string): string[] {
  const lines = rawPatch.replace(/\r/g, "").split("\n");
  if (lines[0] !== "*** Begin Patch") {
    throw new Error("Patch must start with *** Begin Patch.");
  }
  if (!lines.includes("*** End Patch")) {
    throw new Error("Patch must end with *** End Patch.");
  }
  return lines.slice(1, lines.lastIndexOf("*** End Patch"));
}

function findSequence(lines: string[], needle: string[], fromIndex: number): number {
  if (needle.length === 0) {
    return Math.min(fromIndex, lines.length);
  }
  for (let index = fromIndex; index <= lines.length - needle.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (lines[index + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return index;
    }
  }
  return -1;
}

function applyUpdateLines(originalContent: string, patchLines: string[], filePath: string): string {
  const originalLines = originalContent.replace(/\r/g, "").split("\n");
  const workingLines = [...originalLines];
  const hunks: string[][] = [];
  let currentHunk: string[] = [];

  for (const line of patchLines) {
    if (line.startsWith("@@")) {
      if (currentHunk.length > 0) {
        hunks.push(currentHunk);
        currentHunk = [];
      }
      continue;
    }
    if (line === "*** End of File") {
      continue;
    }
    currentHunk.push(line);
  }
  if (currentHunk.length > 0) {
    hunks.push(currentHunk);
  }

  let searchStart = 0;
  for (const hunk of hunks) {
    const beforeLines: string[] = [];
    const afterLines: string[] = [];
    for (const line of hunk) {
      const prefix = line[0];
      const content = line.slice(1);
      if (prefix === " ") {
        beforeLines.push(content);
        afterLines.push(content);
        continue;
      }
      if (prefix === "-") {
        beforeLines.push(content);
        continue;
      }
      if (prefix === "+") {
        afterLines.push(content);
        continue;
      }
      throw new Error(`Unsupported patch line in ${filePath}: ${line}`);
    }

    let matchIndex = findSequence(workingLines, beforeLines, searchStart);
    if (matchIndex === -1) {
      matchIndex = findSequence(workingLines, beforeLines, 0);
    }
    if (matchIndex === -1) {
      throw new Error(`Failed to match patch hunk in ${filePath}.`);
    }

    workingLines.splice(matchIndex, beforeLines.length, ...afterLines);
    searchStart = matchIndex + afterLines.length;
  }

  return workingLines.join("\n");
}

export function parseArtifactPatch(rawPatch: string): ParsedPatchChange[] {
  const bodyLines = stripEnvelope(rawPatch);
  const changes: ParsedPatchChange[] = [];
  let index = 0;

  while (index < bodyLines.length) {
    const header = bodyLines[index];
    if (!header) {
      index += 1;
      continue;
    }

    if (header.startsWith("*** Add File: ")) {
      const filePath = header.slice("*** Add File: ".length).trim();
      index += 1;
      const lines: string[] = [];
      while (index < bodyLines.length && !bodyLines[index]!.startsWith("*** ")) {
        const line = bodyLines[index]!;
        if (!line.startsWith("+")) {
          throw new Error(`Add file patch expects only + lines for ${filePath}.`);
        }
        lines.push(line.slice(1));
        index += 1;
      }
      changes.push({
        action: "add",
        path: filePath,
        lines,
      });
      continue;
    }

    if (header.startsWith("*** Delete File: ")) {
      changes.push({
        action: "delete",
        path: header.slice("*** Delete File: ".length).trim(),
        lines: [],
      });
      index += 1;
      continue;
    }

    if (header.startsWith("*** Update File: ")) {
      const filePath = header.slice("*** Update File: ".length).trim();
      index += 1;
      const lines: string[] = [];
      while (index < bodyLines.length && !bodyLines[index]!.startsWith("*** ")) {
        lines.push(bodyLines[index]!);
        index += 1;
      }
      changes.push({
        action: "update",
        path: filePath,
        lines,
      });
      continue;
    }

    throw new Error(`Unsupported patch header: ${header}`);
  }

  return changes;
}

export async function applyArtifactPatch(
  workspaceRoot: string,
  rawPatch: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const changes = parseArtifactPatch(rawPatch);
  const touchedFiles: string[] = [];
  const staged = new Map<string, {
    absolutePath: string;
    normalizedPath: string;
    action: "write" | "delete";
    content?: string;
  }>();

  for (const change of changes) {
    const target = resolveArtifactPatchTarget(workspaceRoot, change.path);
    if (change.action === "delete") {
      staged.set(target.identity, { ...target, action: "delete" });
      if (!touchedFiles.includes(target.normalizedPath)) touchedFiles.push(target.normalizedPath);
      continue;
    }

    if (change.action === "add") {
      staged.set(target.identity, { ...target, action: "write", content: change.lines.join("\n") });
      if (!touchedFiles.includes(target.normalizedPath)) touchedFiles.push(target.normalizedPath);
      continue;
    }

    const prior = staged.get(target.identity);
    if (prior?.action === "delete") {
      throw new Error(`Cannot update ${target.normalizedPath} after deleting it in the same artifact patch.`);
    }
    const currentContent = prior?.content ?? await fs.readFile(target.absolutePath, "utf8");
    const updatedContent = applyUpdateLines(currentContent, change.lines, target.normalizedPath);
    staged.set(target.identity, { ...target, action: "write", content: updatedContent });
    if (!touchedFiles.includes(target.normalizedPath)) touchedFiles.push(target.normalizedPath);
  }

  for (const change of staged.values()) {
    if (signal?.aborted) {
      if (signal.reason instanceof Error) throw signal.reason;
      throw new Error(typeof signal.reason === "string" ? signal.reason : "Artifact patch was aborted.");
    }
    if (change.action === "delete") {
      await fs.rm(change.absolutePath, { force: true });
    } else {
      await publishTextFileAtomic(change.absolutePath, change.content!, signal);
    }
  }

  return touchedFiles;
}
