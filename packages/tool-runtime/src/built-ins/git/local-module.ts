import type { RuntimeToolSpec, ToolModule } from "../../tool-module.js";

import {
  gitBranchTool,
  gitHistoryTool,
  gitWorktreeTool,
} from "./history-branch-worktree.js";
import {
  gitCommitTool,
  gitIntegrateTool,
  gitRestoreTool,
  gitStageTool,
} from "./local-change-tools.js";

/**
 * Phase-18 local Git tools are appended as a separate module so the frozen
 * phase-14 registry prefix and the legacy git_status/git_diff contracts remain
 * stable. All seven tools execute through the shared parameterized Git builder.
 */
export const gitLocalToolModule: ToolModule = {
  manifest: {
    id: "builtin.git.local",
    version: "1.0.0",
    description: "Safe local Git history, branch, worktree, change, and integration tools.",
    source: "built_in",
  },
  create: () => [
    gitHistoryTool as RuntimeToolSpec,
    gitBranchTool as RuntimeToolSpec,
    gitWorktreeTool as RuntimeToolSpec,
    gitStageTool as RuntimeToolSpec,
    gitCommitTool as RuntimeToolSpec,
    gitRestoreTool as RuntimeToolSpec,
    gitIntegrateTool as RuntimeToolSpec,
  ],
};
