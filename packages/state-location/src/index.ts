import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DeepMixLocationOptions {
  environment?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export const DEEP_MIX_PROJECT_DIRECTORY = ".deep-mix";
export const DEEP_MIX_HOME_ENV = "DEEP_MIX_HOME";
export const LEGACY_DESKTOP_ATTACHMENT_PREFIX = ".deep-mix/desktop-attachments/";

function canonicalWorkspaceRoot(workspaceRoot: string): string {
  let canonicalRoot = path.resolve(workspaceRoot);
  try {
    canonicalRoot = realpathSync.native(canonicalRoot);
  } catch {
    // Callers may resolve a workspace before it has been initialized.
  }
  const normalized = canonicalRoot.replace(/\\/gu, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function deriveWorkspaceId(workspaceRoot: string): string {
  return `workspace_${createHash("sha256").update(canonicalWorkspaceRoot(workspaceRoot)).digest("hex").slice(0, 24)}`;
}

export function resolveDeepMixHome(options: DeepMixLocationOptions = {}): string {
  const configured = options.environment?.[DEEP_MIX_HOME_ENV]
    ?? (options.homeDir === undefined ? process.env[DEEP_MIX_HOME_ENV] : undefined);
  if (configured?.trim()) return path.resolve(configured.trim());
  return path.join(path.resolve(options.homeDir ?? os.homedir()), DEEP_MIX_PROJECT_DIRECTORY);
}

export function resolveWorkspaceStateDirectory(
  workspaceRoot: string,
  options: DeepMixLocationOptions = {},
): string {
  return path.join(resolveDeepMixHome(options), "workspaces", deriveWorkspaceId(workspaceRoot));
}

export function resolveLegacyWorkspaceStateDirectory(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), DEEP_MIX_PROJECT_DIRECTORY);
}

export function resolveProjectSettingsPath(workspaceRoot: string): string {
  return path.join(resolveLegacyWorkspaceStateDirectory(workspaceRoot), "settings.json");
}

export function resolveUserSettingsPath(options: DeepMixLocationOptions = {}): string {
  return path.join(resolveDeepMixHome(options), "settings.json");
}

export function resolveProjectMcpConfigPath(workspaceRoot: string): string {
  return path.join(resolveLegacyWorkspaceStateDirectory(workspaceRoot), "mcp", "servers.json");
}

export function resolveUserMcpConfigPath(options: DeepMixLocationOptions = {}): string {
  return path.join(resolveDeepMixHome(options), "mcp", "servers.json");
}

export function resolveProjectApiKeyLibraryPath(workspaceRoot: string): string {
  return path.join(resolveLegacyWorkspaceStateDirectory(workspaceRoot), "api-key-library", "profiles.local.json");
}

export function resolveUserApiKeyLibraryPath(options: DeepMixLocationOptions = {}): string {
  return path.join(resolveDeepMixHome(options), "api-key-library", "profiles.local.json");
}

export function resolveWorkspaceApiKeyLibraryPath(
  workspaceRoot: string,
  options: DeepMixLocationOptions = {},
): string {
  return path.join(resolveWorkspaceStateDirectory(workspaceRoot, options), "api-key-library", "profiles.local.json");
}

export function resolveLegacyDesktopAttachmentReference(
  workspaceRoot: string,
  value: string,
  options: DeepMixLocationOptions = {},
): string | undefined {
  const normalized = value.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (!normalized.startsWith(LEGACY_DESKTOP_ATTACHMENT_PREFIX)) return undefined;
  const relative = normalized.slice(DEEP_MIX_PROJECT_DIRECTORY.length + 1);
  const absolute = path.resolve(resolveWorkspaceStateDirectory(workspaceRoot, options), relative);
  const attachmentRoot = path.resolve(resolveWorkspaceStateDirectory(workspaceRoot, options), "desktop-attachments");
  const containment = path.relative(attachmentRoot, absolute);
  if (containment === ".." || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) return undefined;
  return absolute;
}
