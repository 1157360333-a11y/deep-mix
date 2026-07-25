import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillDiscoveryResult, SkillMatch, SkillRecord, SkillScope } from "../../shared-schema/src/index.js";
import { extractEnabledSkills, loadDeepMixSettings } from "../../settings/src/index.js";

interface SkillScanLocation {
  scope: SkillScope;
  root: string;
  priority: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 2);
}

function normalizeSkillName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return {
      frontmatter: {},
      body: normalized.trim(),
    };
  }

  const endIndex = normalized.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    return {
      frontmatter: {},
      body: normalized.trim(),
    };
  }

  const block = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 5).trim();
  const frontmatter: Record<string, unknown> = {};
  let activeSection: Record<string, unknown> | undefined;

  for (const rawLine of block.split("\n")) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
      continue;
    }

    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    if (indent === 0) {
      activeSection = undefined;
      const match = rawLine.match(/^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/);
      if (!match) {
        continue;
      }
      const [, key, value = ""] = match;
      if (!value.trim()) {
        const section: Record<string, unknown> = {};
        frontmatter[key] = section;
        activeSection = section;
      } else {
        frontmatter[key] = parseScalar(value.trim());
      }
      continue;
    }

    if (!activeSection) {
      continue;
    }

    const match = rawLine.match(/^\s+([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const [, key, value = ""] = match;
    activeSection[key] = parseScalar(value.trim());
  }

  return {
    frontmatter,
    body,
  };
}

function parseScalar(value: string): unknown {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walkForSkillFiles(root: string): Promise<string[]> {
  if (!(await exists(root))) {
    return [];
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkForSkillFiles(absolutePath)));
      continue;
    }
    if (entry.isFile() && entry.name === "SKILL.md") {
      results.push(absolutePath);
    }
  }
  return results;
}

function resolveBuiltInRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "builtin-skills");
}

export class SkillEngine {
  public constructor(private readonly workspaceRoot: string) {}

  public listScanLocations(): SkillScanLocation[] {
    const home = os.homedir();
    return [
      {
        scope: "project",
        root: path.join(this.workspaceRoot, ".deep-mix", "skills"),
        priority: 1,
      },
      {
        scope: "project_compat",
        root: path.join(this.workspaceRoot, ".agents", "skills"),
        priority: 2,
      },
      {
        scope: "user",
        root: path.join(home, ".deep-mix", "skills"),
        priority: 3,
      },
      {
        scope: "user_compat",
        root: path.join(home, ".agents", "skills"),
        priority: 4,
      },
      {
        scope: "built_in",
        root: resolveBuiltInRoot(),
        priority: 5,
      },
    ];
  }

  public async discoverSkills(): Promise<SkillDiscoveryResult> {
    const errors: string[] = [];
    const skills: SkillRecord[] = [];
    const seenNames = new Set<string>();
    const settings = await this.loadEnabledSkillSettings(errors);

    for (const location of this.listScanLocations()) {
      const skillFiles = await walkForSkillFiles(location.root);
      for (const skillPath of skillFiles) {
        try {
          const rawContent = await fs.readFile(skillPath, "utf8");
          const { frontmatter, body } = parseFrontmatter(rawContent);
          const configuredName =
            typeof frontmatter.name === "string" && frontmatter.name.trim()
              ? frontmatter.name.trim()
              : path.basename(path.dirname(skillPath));
          const name = normalizeSkillName(configuredName);
          if (!name || seenNames.has(name)) {
            continue;
          }

          const metadata = (frontmatter.metadata ?? {}) as Record<string, unknown>;
          const enabled = settings[name] ?? true;
          skills.push({
            name,
            description:
              typeof frontmatter.description === "string" && frontmatter.description.trim()
                ? frontmatter.description.trim()
                : `Skill loaded from ${skillPath}.`,
            sourcePath: skillPath,
            directoryPath: path.dirname(skillPath),
            sourceScope: location.scope,
            allowImplicitInvocation: metadata["allow-implicit-invocation"] !== false,
            enabled,
            body,
            rawContent,
            frontmatter,
          });
          seenNames.add(name);
        } catch (error) {
          errors.push(`${skillPath}: ${(error as Error).message}`);
        }
      }
    }

    return {
      skills,
      errors,
    };
  }

  public async listSkills(query?: string): Promise<SkillRecord[]> {
    const discovery = await this.discoverSkills();
    const normalizedQuery = query?.trim().toLowerCase();
    if (!normalizedQuery) {
      return discovery.skills;
    }
    return discovery.skills.filter(
      (skill) =>
        skill.name.includes(normalizedQuery) ||
        skill.description.toLowerCase().includes(normalizedQuery),
    );
  }

  public async selectSkills(prompt: string, maxMatches = 3): Promise<SkillMatch[]> {
    const discovery = await this.discoverSkills();
    const promptLower = prompt.toLowerCase();
    const promptTokens = new Set(tokenize(prompt));
    const matches: SkillMatch[] = [];

    for (const skill of discovery.skills) {
      const manuallyRequested = promptLower.includes(`/${skill.name}`) || promptLower.includes(skill.name);
      if (!skill.enabled) {
        continue;
      }
      if (!skill.allowImplicitInvocation && !manuallyRequested) {
        continue;
      }

      const reasons: string[] = [];
      let score = 0;
      if (manuallyRequested) {
        score += 10;
        reasons.push("name match");
      }

      const skillTokens = new Set(tokenize(`${skill.name} ${skill.description}`));
      const overlaps = [...promptTokens].filter((token) => skillTokens.has(token));
      if (overlaps.length > 0) {
        score += overlaps.length;
        reasons.push(`keyword overlap: ${overlaps.slice(0, 5).join(", ")}`);
      }

      if (score > 0) {
        matches.push({
          skill,
          score,
          reasons,
        });
      }
    }

    return matches.sort((left, right) => right.score - left.score).slice(0, maxMatches);
  }

  private async loadEnabledSkillSettings(errors: string[]): Promise<Record<string, boolean>> {
    const loaded = await loadDeepMixSettings(this.workspaceRoot, {
      homeDir: os.homedir(),
      collectErrors: true,
    });
    errors.push(...loaded.errors);
    const extracted = extractEnabledSkills(loaded.settings);
    return Object.fromEntries(
      Object.entries(extracted).map(([name, enabled]) => [normalizeSkillName(name), enabled]),
    );
  }
}
