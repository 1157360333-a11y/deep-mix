import type { ToolModule } from "../tool-module.js";

import { catalogToolModule } from "./catalog/index.js";
import { codeIntelligenceToolModule } from "./code-intelligence/index.js";
import { commandsToolModule } from "./commands/index.js";
import { diagnosticsToolModule } from "./diagnostics/index.js";
import { documentsToolModule } from "./documents/index.js";
import { gitToolModule } from "./git/index.js";
import { gitLocalToolModule } from "./git/local-module.js";
import { mcpCompatToolModule } from "./mcp-compat/index.js";
import { mcpResourceLifecycleToolModule } from "./mcp-resources/index.js";
import { processesToolModule } from "./processes/index.js";
import { qualityToolModule } from "./quality/index.js";
import { recoveryToolModule } from "./recovery/index.js";
import { recoveryLifecycleToolModule } from "./recovery/lifecycle.js";
import { repositoryToolModule } from "./repository/index.js";
import { repositoryEnhancementsToolModule } from "./repository/enhancements.js";
import { sessionToolModule } from "./session/index.js";
import { archivesToolModule, conversionsToolModule, imagesToolModule, notebooksToolModule, presentationsToolModule, spreadsheetsToolModule } from "./structured-documents/index.js";
import { webToolModule } from "./web/index.js";
import { workersToolModule } from "./workers/index.js";
import { workerLifecycleToolModule } from "./workers/lifecycle.js";
import { workspaceToolModule } from "./workspace/index.js";
import { workspacePathsToolModule } from "./workspace/paths.js";

/**
 * The only trusted compile-time entry for built-in tools. Phase 14 populates
 * this list with domain modules; workspace JavaScript and TypeScript are never
 * scanned or executed as plugins.
 */
export const builtInToolModules: readonly ToolModule[] = [
  diagnosticsToolModule,
  repositoryToolModule,
  workspaceToolModule,
  commandsToolModule,
  gitToolModule,
  recoveryToolModule,
  mcpCompatToolModule,
  workersToolModule,
  sessionToolModule,
  catalogToolModule,
  documentsToolModule,
  webToolModule,
  repositoryEnhancementsToolModule,
  workspacePathsToolModule,
  // Later-phase tools append after the frozen phase-15 registry baseline so
  // provider ordering and selection metadata for existing tools stay stable.
  processesToolModule,
  qualityToolModule,
  // Phase-18 local Git tools append after every frozen earlier-phase tool.
  gitLocalToolModule,
  // Phase-19 code-intelligence tools append after every frozen earlier-phase tool.
  codeIntelligenceToolModule,
  // Phase-20 rich-document modules append after every frozen earlier-phase tool.
  spreadsheetsToolModule,
  presentationsToolModule,
  notebooksToolModule,
  imagesToolModule,
  archivesToolModule,
  conversionsToolModule,
  // Phase-21 lifecycle modules append after the frozen phase-15-20 registry order.
  recoveryLifecycleToolModule,
  workerLifecycleToolModule,
  mcpResourceLifecycleToolModule,
];

export * from "./code-intelligence/index.js";
export * from "./documents/index.js";
export * from "./structured-documents/index.js";
export * from "./web/index.js";
export * from "./workers/lifecycle.js";
export * from "./mcp-resources/index.js";
