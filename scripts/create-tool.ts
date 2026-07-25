import { promises as fs } from "node:fs";
import path from "node:path";

interface Arguments {
  module: string;
  name: string;
  root: string;
}

function readArguments(argv: string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new Error("Unexpected positional argument: " + token);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + token + ".");
    values.set(token.slice(2), value);
    index += 1;
  }
  const moduleName = values.get("module") ?? "";
  const toolName = values.get("name") ?? "";
  const root = path.resolve(values.get("root") ?? process.cwd());
  if (!/^[a-z][a-z0-9-]*$/.test(moduleName)) {
    throw new Error("--module must use lowercase kebab-case.");
  }
  if (!/^[a-z][a-z0-9_]*$/.test(toolName)) {
    throw new Error("--name must use lowercase snake_case.");
  }
  return { module: moduleName, name: toolName, root };
}

function pascalCase(value: string): string {
  return value
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

function schemaSource(symbol: string): string {
  return [
    "export const " + symbol + "InputSchema = {",
    "  type: \"object\",",
    "  additionalProperties: false,",
    "  required: [\"path\"],",
    "  properties: {",
    "    path: { type: \"string\", minLength: 1, maxLength: 4096 },",
    "    maxChars: { type: \"integer\", minimum: 100, maximum: 50000 },",
    "  },",
    "} as const;",
    "",
  ].join("\n");
}

function toolSource(toolName: string, symbol: string, moduleName: string): string {
  return [
    "import { promises as fs } from \"node:fs\";",
    "",
    "import type { RuntimeToolSpec } from \"../../../tool-module.js\";",
    "import { " + symbol + "InputSchema } from \"./schema.js\";",
    "",
    "interface " + symbol + "Args {",
    "  path: string;",
    "  maxChars?: number;",
    "}",
    "",
    "export const " + symbol + "Tool: RuntimeToolSpec = {",
    "  name: \"" + toolName + "\",",
    "  description: \"Read and inspect a bounded UTF-8 workspace file. Replace this description with the domain contract.\",",
    "  inputSchema: " + symbol + "InputSchema,",
    "  readOnly: true,",
    "  permissionCategory: \"read_only\",",
    "  sideEffectLevel: \"none\",",
    "  timeoutCategory: \"fast\",",
    "  groups: [\"" + moduleName + "\"],",
    "  selection: {",
    "    groups: [\"" + moduleName + "\"],",
    "    keywords: [\"" + toolName.replace(/_/g, " ") + "\"],",
    "  },",
    "  resolveAccess: (rawArgs) => [{",
    "    kind: \"filesystem_read\",",
    "    paths: [(rawArgs as " + symbol + "Args).path],",
    "    reason: \"Read the declared input through the Runtime path guard.\",",
    "  }],",
    "  execute: async (rawArgs, context) => {",
    "    const args = rawArgs as " + symbol + "Args;",
    "    const resolved = await context.moduleContext.paths.resolveReadable(args.path);",
    "    const content = await fs.readFile(resolved.absolutePath, \"utf8\");",
    "    const maxChars = args.maxChars ?? 12000;",
    "    const bounded = content.slice(0, maxChars);",
    "    const timestamp = context.moduleContext.clock.now();",
    "    return {",
    "      toolName: \"" + toolName + "\",",
    "      callId: context.callId,",
    "      startedAt: timestamp,",
    "      endedAt: timestamp,",
    "      success: true,",
    "      output: bounded,",
    "      structuredContent: {",
    "        path: resolved.workspaceRelativePath ?? resolved.artifactRef ?? args.path,",
    "        content: bounded,",
    "        truncated: bounded.length < content.length,",
    "      },",
    "    };",
    "  },",
    "};",
    "",
  ].join("\n");
}

function moduleSource(toolName: string, symbol: string, moduleName: string): string {
  const moduleSymbol = symbol[0]!.toLowerCase() + symbol.slice(1) + "ToolModule";
  return [
    "import type { ToolModule } from \"../../../tool-module.js\";",
    "import { " + symbol + "Tool } from \"./tool.js\";",
    "",
    "export const " + moduleSymbol + ": ToolModule = {",
    "  manifest: {",
    "    id: \"builtin." + moduleName + "." + toolName + "\",",
    "    version: \"1.0.0\",",
    "    description: \"Built-in " + toolName + " module.\",",
    "    source: \"built_in\",",
    "  },",
    "  create: () => [" + symbol + "Tool],",
    "};",
    "",
    "export { " + symbol + "Tool } from \"./tool.js\";",
    "export { " + symbol + "InputSchema } from \"./schema.js\";",
    "",
  ].join("\n");
}

function testSource(toolName: string, symbol: string, moduleName: string): string {
  const moduleSymbol = symbol[0]!.toLowerCase() + symbol.slice(1) + "ToolModule";
  const importPath = "../packages/tool-runtime/src/built-ins/" + moduleName + "/" + toolName.replace(/_/g, "-") + "/index.js";
  return [
    "import { promises as fs } from \"node:fs\";",
    "import os from \"node:os\";",
    "import path from \"node:path\";",
    "",
    "import { afterEach, describe, expect, it } from \"vitest\";",
    "import { SessionStore } from \"../packages/persistence/src/index.js\";",
    "import { ToolRuntime } from \"../packages/tool-runtime/src/index.js\";",
    "import { " + moduleSymbol + " } from \"" + importPath + "\";",
    "",
    "let workspaceRoot: string | undefined;",
    "afterEach(async () => {",
    "  if (workspaceRoot) await fs.rm(workspaceRoot, { recursive: true, force: true });",
    "  workspaceRoot = undefined;",
    "});",
    "",
    "describe(\"" + toolName + " scaffold\", () => {",
    "  it(\"runs through Registry validation and Runtime file access\", async () => {",
    "    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), \"deep-mix-tool-scaffold-\"));",
    "    await fs.writeFile(path.join(workspaceRoot, \"fixture.txt\"), \"scaffold fixture\", \"utf8\");",
    "    const sessionStore = new SessionStore(workspaceRoot);",
    "    await sessionStore.ensureInitialized();",
    "    const session = await sessionStore.createSession(\"scaffold test\");",
    "    const runtime = new ToolRuntime({",
    "      workspaceRoot,",
    "      sessionStore,",
    "      permissionMode: \"danger-full-access\",",
    "      modules: [" + moduleSymbol + "],",
    "    });",
    "    const result = await runtime.executeManualTool(\"" + toolName + "\", { path: \"fixture.txt\" }, session.sessionId);",
    "    expect(result).toMatchObject({ success: true, output: \"scaffold fixture\" });",
    "  });",
    "});",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = readArguments(process.argv.slice(2));
  const symbol = pascalCase(args.name);
  const directory = path.join(
    args.root,
    "packages",
    "tool-runtime",
    "src",
    "built-ins",
    args.module,
    args.name.replace(/_/g, "-"),
  );
  const testPath = path.join(args.root, "tests", args.module + "." + args.name + ".test.ts");
  const files = [
    { path: path.join(directory, "schema.ts"), content: schemaSource(symbol) },
    { path: path.join(directory, "tool.ts"), content: toolSource(args.name, symbol, args.module) },
    { path: path.join(directory, "index.ts"), content: moduleSource(args.name, symbol, args.module) },
    { path: testPath, content: testSource(args.name, symbol, args.module) },
  ];
  for (const file of files) {
    try {
      await fs.access(file.path);
      throw new Error("Refusing to overwrite existing scaffold file: " + file.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(path.dirname(testPath), { recursive: true });
  await Promise.all(files.map((file) => fs.writeFile(file.path, file.content, "utf8")));
  process.stdout.write([
    "Created trusted built-in tool scaffold:",
    ...files.map((file) => "- " + path.relative(args.root, file.path).replace(/\\/g, "/")),
    "Next: import the generated ToolModule in packages/tool-runtime/src/built-ins/index.ts and add it to builtInToolModules.",
    "No Governor or Permission Layer source was modified.",
    "",
  ].join("\n"));
}

main().catch((error) => {
  process.stderr.write((error as Error).message + "\n");
  process.exitCode = 1;
});
