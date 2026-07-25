import type { RuntimeToolSpec, ToolModule } from "../../tool-module.js";
import path from "node:path";
import {
  openLocalCodeIndex,
  type LocalCodeIndex,
} from "../../code-intelligence/index.js";

import {
  createCodeSymbolsTool,
  type CodeSymbolsLspProvider,
} from "./code-symbols.js";
import {
  createDependencyAuditTool,
  type DependencyAuditor,
} from "./dependency-audit.js";
import {
  createCodeNavigationTools,
  type LspNavigationProvider,
} from "./navigation.js";
import {
  createSecurityScanTool,
  type StaticScannerRunner,
} from "./security-scan.js";
import {
  createSemanticSearchTool,
  type ExternalSemanticProvider,
} from "./semantic-search.js";

export interface CodeIntelligenceToolModuleOptions {
  externalSemanticProvider?: ExternalSemanticProvider;
  symbolsLspProvider?: CodeSymbolsLspProvider;
  navigationLspProvider?: LspNavigationProvider;
  dependencyAuditor?: DependencyAuditor;
  securityScanner?: StaticScannerRunner;
  /** Deterministic factory hook; the module always caches one resulting service per workspace. */
  openIndex?: (workspaceRoot: string) => Promise<LocalCodeIndex>;
}

export function createCodeIntelligenceToolModule(
  options: CodeIntelligenceToolModuleOptions = {},
): ToolModule {
  return {
    manifest: {
      id: "builtin.code-intelligence",
      version: "1.0.0",
      description: "Local-first semantic code intelligence with explicit provenance and bounded authoritative pages.",
      source: "built_in",
    },
    capabilityProbes: [{
      name: "semgrep",
      candidates: ["semgrep"],
      args: ["--version", "--disable-version-check", "--metrics=off"],
      timeoutMs: 5_000,
    }],
    create: () => {
      const indexPromises = new Map<string, Promise<LocalCodeIndex>>();
      const factory = options.openIndex ?? openLocalCodeIndex;
      const openSharedIndex = (workspaceRoot: string): Promise<LocalCodeIndex> => {
        const resolved = path.resolve(workspaceRoot);
        const key = process.platform === "win32" || process.platform === "darwin"
          ? resolved.toLocaleLowerCase("en-US")
          : resolved;
        let pending = indexPromises.get(key);
        if (!pending) {
          pending = factory(workspaceRoot).catch((error) => {
            indexPromises.delete(key);
            throw error;
          });
          indexPromises.set(key, pending);
        }
        return pending;
      };
      return [
        createSemanticSearchTool({ externalProvider: options.externalSemanticProvider, openIndex: openSharedIndex }),
        createCodeSymbolsTool({ lspProvider: options.symbolsLspProvider, openIndex: openSharedIndex }),
        ...(createCodeNavigationTools({ lspProvider: options.navigationLspProvider, openIndex: openSharedIndex }) as unknown as RuntimeToolSpec[]),
        createDependencyAuditTool({ auditor: options.dependencyAuditor }),
        createSecurityScanTool({ scanner: options.securityScanner }),
      ];
    },
  };
}

export const codeIntelligenceToolModule = createCodeIntelligenceToolModule();

export * from "./code-symbols.js";
export * from "./dependency-audit.js";
export * from "./navigation.js";
export * from "./pagination.js";
export * from "./security-scan.js";
export * from "./semantic-search.js";
