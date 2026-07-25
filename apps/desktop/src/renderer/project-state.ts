export interface ProjectPreference {
  name?: string;
  pinnedAt?: string;
}

export type ProjectPreferences = Record<string, ProjectPreference>;

export function parseProjectPreferences(value: string | null): ProjectPreferences {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([root, preference]) => {
      if (!preference || typeof preference !== "object" || Array.isArray(preference)) return [];
      const candidate = preference as Record<string, unknown>;
      const name = typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim().slice(0, 80) : undefined;
      const pinnedAt = typeof candidate.pinnedAt === "string" && candidate.pinnedAt ? candidate.pinnedAt : undefined;
      return [[root, { ...(name ? { name } : {}), ...(pinnedAt ? { pinnedAt } : {}) }]];
    }));
  } catch {
    return {};
  }
}

export function rememberProject(roots: string[], workspaceRoot: string, limit = 32): string[] {
  return [workspaceRoot, ...roots.filter((root) => root !== workspaceRoot)].slice(0, limit);
}

export function removeProject(roots: string[], workspaceRoot: string): string[] {
  return roots.filter((root) => root !== workspaceRoot);
}
