import { normalizeRouteOverride } from "../../../packages/route-resolver/src/index.js";
import { isPermissionMode, isRouteTarget, loadDeepMixSettingsSync } from "../../../packages/settings/src/index.js";
import type { ParsedArgs } from "./cli-args.js";

export interface ResolvedCliLaunchConfig {
  permissionMode: "plan" | "edit" | "auto" | "danger-full-access";
  routeOverride?: "ds_direct" | "glm_coding" | "kimi_vision";
}

export function resolveCliLaunchConfig(
  args: Pick<ParsedArgs, "workspaceRoot" | "permissionMode" | "routeOverride">,
  options: { homeDir?: string } = {},
): ResolvedCliLaunchConfig {
  const loadedSettings = loadDeepMixSettingsSync(args.workspaceRoot, {
    homeDir: options.homeDir,
    collectErrors: false,
  });
  const configuredPermissionMode = isPermissionMode(loadedSettings.settings.defaults?.permissionMode)
    ? loadedSettings.settings.defaults?.permissionMode
    : undefined;
  const configuredRouteOverride = isRouteTarget(loadedSettings.settings.defaults?.routeOverride)
    ? loadedSettings.settings.defaults?.routeOverride
    : undefined;

  return {
    permissionMode: args.permissionMode ?? configuredPermissionMode ?? "auto",
    routeOverride: normalizeRouteOverride(args.routeOverride ?? configuredRouteOverride),
  };
}
