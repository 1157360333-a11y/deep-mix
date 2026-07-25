import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([".git", "node_modules", "coverage", "dist", "out", "output"]);
const textExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const requiredPaths = [
  "README.md",
  "README.zh-CN.md",
  "LICENSE",
  "NOTICE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "CHANGELOG.md",
  "docs/getting-started.md",
  "docs/configuration.md",
  "docs/security-model.md",
  "docs/releases/v1.0.0.md",
];

const allowedDeepMixFiles = new Set([
  ".deep-mix/mcp/README.md",
  ".deep-mix/mcp/servers.json",
  ".deep-mix/skills/README.md",
  ".deep-mix/workflows/README.md",
]);

const regexEscape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const currentWindowsUser = process.env.USERNAME?.trim();
const forbiddenPatterns = [
  { label: "numeric Windows user profile path", pattern: new RegExp(["C:", "Users", "[0-9]{4,}"].join("\\\\"), "iu") },
  { label: "private QQ email", pattern: new RegExp(["[A-Z0-9._%+-]+@", "qq\\.com"].join(""), "iu") },
  { label: "legacy release version", pattern: new RegExp(["v0", "\\.1\\.0"].join(""), "iu") },
  ...(currentWindowsUser
    ? [{
        label: "current Windows user profile path",
        pattern: new RegExp(["C:", "Users", regexEscape(currentWindowsUser)].join("\\\\"), "iu"),
      }]
    : []),
];

const knownTokenPattern = /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{10,}|npm_[A-Za-z0-9]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/gu;
const privateKeyPattern = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/gu;

async function walk(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(absolute));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  }
  return files;
}

function relativeLinkTarget(source: string, target: string): string | undefined {
  const clean = target.trim().replace(/^<|>$/g, "").split("#", 1)[0]?.split("?", 1)[0];
  if (!clean || /^(?:https?:|mailto:|data:)/iu.test(clean)) return undefined;
  return path.resolve(root, path.dirname(source), decodeURIComponent(clean));
}

async function main(): Promise<void> {
  const errors: string[] = [];
  const files = await walk(root);
  const fileSet = new Set(files);

  for (const required of requiredPaths) {
    if (!fileSet.has(required)) errors.push(`Missing required public file: ${required}`);
  }

  for (const file of files) {
    if (file.startsWith(".deep-mix/") && !allowedDeepMixFiles.has(file)) {
      errors.push(`Unexpected tracked-style runtime file: ${file}`);
    }
    if (file.endsWith(".local.json")) {
      errors.push(`Machine-local JSON must not be published: ${file}`);
    }
    if (!textExtensions.has(path.extname(file).toLowerCase())) continue;

    const content = await fs.readFile(path.join(root, file), "utf8");
    for (const forbidden of forbiddenPatterns) {
      if (forbidden.pattern.test(content)) {
        errors.push(`Forbidden private/legacy content in ${file}: ${forbidden.label}`);
      }
    }
    if (knownTokenPattern.test(content)) errors.push(`Potential provider token in ${file}`);
    knownTokenPattern.lastIndex = 0;
    if (privateKeyPattern.test(content)) errors.push(`Potential private key in ${file}`);
    privateKeyPattern.lastIndex = 0;

    if (file.endsWith(".json")) {
      try {
        JSON.parse(content);
      } catch (error) {
        errors.push(`Invalid JSON in ${file}: ${(error as Error).message}`);
      }
    }

    if (file.endsWith(".md")) {
      const links = content.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/gu);
      for (const match of links) {
        const target = relativeLinkTarget(file, match[1] ?? "");
        if (!target) continue;
        try {
          await fs.access(target);
        } catch {
          errors.push(`Broken relative Markdown link in ${file}: ${match[1]}`);
        }
      }
    }
  }

  const packageFiles = files.filter((file) => file === "package.json" || file.endsWith("/package.json"));
  for (const packageFile of packageFiles) {
    const manifest = JSON.parse(await fs.readFile(path.join(root, packageFile), "utf8")) as { name?: string; version?: string };
    if (manifest.version && manifest.version !== "1.0.0") {
      errors.push(`Package version is not 1.0.0: ${packageFile} (${manifest.version})`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Public release verification failed:\n- ${errors.join("\n- ")}`);
  }
  process.stdout.write(`Public release verification passed (${files.length} files checked).\n`);
}

await main();
