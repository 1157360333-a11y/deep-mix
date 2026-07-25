import type { ToolModule } from "../../tool-module.js";

import { buildTool } from "./build.js";
import { formatTool } from "./format.js";
import { inspectLogsTool } from "./inspect-logs.js";
import { testCoverageTool } from "./test-coverage.js";

export const qualityToolModule: ToolModule = {
  manifest: {
    id: "builtin.quality",
    version: "1.0.0",
    description: "Structured build, formatting, coverage, and log inspection tools.",
    source: "built_in",
  },
  create: () => [buildTool, formatTool, testCoverageTool, inspectLogsTool],
};

export { buildTool } from "./build.js";
export { formatTool } from "./format.js";
export { inspectLogsTool, redactLogText } from "./inspect-logs.js";
export { testCoverageTool } from "./test-coverage.js";
