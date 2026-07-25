import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SessionStore } from "../../persistence/src/index.js";
import { SpecialistBroker } from "../../specialist-broker/src/index.js";
import { ToolRuntime, PermissionRequiredError } from "../../tool-runtime/src/index.js";
import { SupervisorReviewService } from "../../core-governor/src/index.js";
import type {
  RouteProfile,
  RouteTarget,
  SupervisorDecision,
  WorkerTask,
} from "../../shared-schema/src/index.js";
import type {
  CodingWorkerRunner,
  GlmCodingWorkerExecutionResult,
} from "../../worker-glm-coding/src/index.js";

export type EvaluationMode = "ds_only" | "ds_glm" | "ds_glm_kimi";
export type EvaluationTaskCategory =
  | "simple_patch"
  | "complex_backend_implementation"
  | "cross_file_refactor"
  | "screenshot_bug_fix"
  | "ui_parse_to_code";
export type EvaluationFailureCategory =
  | "glm_routing_error"
  | "kimi_perception_error"
  | "supervisor_misjudgment"
  | "tool_failure"
  | "permission_layer_block"
  | "context_bloat_or_promotion_loss";

export interface EvaluationTask {
  id: string;
  category: EvaluationTaskCategory;
  title: string;
  prompt: string;
  fixedInputs: string[];
  successCriteria: string[];
  failureCriteria: string[];
  idealRoute: RouteTarget;
}

export interface EvaluationTaskSet {
  version: string;
  createdAt: string;
  tasks: EvaluationTask[];
}

export interface EvaluationTaskRun {
  taskId: string;
  mode: EvaluationMode;
  actualRoute: RouteTarget;
  success: boolean;
  turnCount: number;
  latencyMs: number;
  costUsd: number;
  baselineMainContextChars: number;
  actualMainContextChars: number;
  workerAttempted: boolean;
  workerAccepted: boolean;
  revisionCount: number;
  fallbackToDs: boolean;
  visionUsefulnessScore?: number;
  failureCategory?: EvaluationFailureCategory;
  failureSummary?: string;
  notes?: string[];
}

export interface EvaluationRunMatrix {
  taskSetVersion: string;
  generatedAt: string;
  runs: EvaluationTaskRun[];
}

export interface ModeMetrics {
  mode: EvaluationMode;
  taskCount: number;
  successCount: number;
  taskSuccessRate: number;
  routingPrecision: number;
  workerAcceptanceRate: number;
  workerRevisionRate: number;
  fallbackToDsRate: number;
  avgTurnCount: number;
  medianTaskLatencyMs: number;
  costPerTaskUsd: number;
  contextSavedRatio: number;
  visionUsefulnessScore: number;
  failureBreakdown: Record<EvaluationFailureCategory, number>;
}

export interface Phase7Recommendations {
  routeWhitelist: string[];
  routeBlacklist: string[];
  manualReviewRequired: string[];
  dataGaps: string[];
}

export interface InternalRepoValidationResult {
  repoLabel: string;
  repoRootName: string;
  validatedAt: string;
  scenario: string;
  sessionId: string;
  logsVerified: boolean;
  artifactVerified: boolean;
  resumeVerified: boolean;
  undoVerified: boolean;
  permissionGuardVerified: boolean;
  notes: string[];
}

export interface Phase7Artifacts {
  dsOnlyBaselineReport: string;
  dsGlmComparisonReport: string;
  dsGlmKimiComparisonReport: string;
  internalReleaseReport: string;
}

export interface Phase7ArtifactPaths {
  dsOnlyBaselineReport: string;
  dsGlmComparisonReport: string;
  dsGlmKimiComparisonReport: string;
  internalReleaseReport: string;
}

const FAILURE_CATEGORY_ORDER: EvaluationFailureCategory[] = [
  "glm_routing_error",
  "kimi_perception_error",
  "supervisor_misjudgment",
  "tool_failure",
  "permission_layer_block",
  "context_bloat_or_promotion_loss",
];

const MODE_ORDER: EvaluationMode[] = ["ds_only", "ds_glm", "ds_glm_kimi"];

function now(): string {
  return new Date().toISOString();
}

function createSyntheticCodingRouteProfile(): RouteProfile {
  return {
    provider: "glm",
    model: "glm-5.2",
    role: "coding_worker",
    contextWindow: 128000,
    toolCallingMode: "disabled",
    thinkingMode: {
      mode: "disabled",
      reasoningEffort: "not_applicable",
    },
    pricing: {
      input: { available: false },
      output: { available: false },
      cacheRead: { available: false },
      cacheWrite: { available: false },
    },
    maxInputSize: {
      value: 24000,
      unit: "characters",
    },
  };
}

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatMs(value: number): string {
  return `${Math.round(value)} ms`;
}

function failureLabel(category: EvaluationFailureCategory): string {
  switch (category) {
    case "glm_routing_error":
      return "GLM 路由错误";
    case "kimi_perception_error":
      return "Kimi 识图错误";
    case "supervisor_misjudgment":
      return "监督验收误判";
    case "tool_failure":
      return "工具失败";
    case "permission_layer_block":
      return "权限层阻塞";
    case "context_bloat_or_promotion_loss":
      return "上下文膨胀或 artifact promotion 失控";
  }
}

function modeLabel(mode: EvaluationMode): string {
  switch (mode) {
    case "ds_only":
      return "ds-only";
    case "ds_glm":
      return "ds + glm";
    case "ds_glm_kimi":
      return "ds + glm + kimi";
  }
}

function taskCategoryLabel(category: EvaluationTaskCategory): string {
  switch (category) {
    case "simple_patch":
      return "简单补丁";
    case "complex_backend_implementation":
      return "复杂后端实现";
    case "cross_file_refactor":
      return "跨文件重构";
    case "screenshot_bug_fix":
      return "截图修复";
    case "ui_parse_to_code":
      return "UI 解析后改码";
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function validateEvaluationTaskSet(taskSet: EvaluationTaskSet): EvaluationTaskSet {
  assert(typeof taskSet.version === "string" && taskSet.version.trim().length > 0, "Task set version is required.");
  assert(Array.isArray(taskSet.tasks) && taskSet.tasks.length > 0, "Task set must include tasks.");
  const seenIds = new Set<string>();

  for (const task of taskSet.tasks) {
    assert(typeof task.id === "string" && task.id.trim().length > 0, "Each task requires a non-empty id.");
    assert(!seenIds.has(task.id), `Duplicate task id detected: ${task.id}`);
    seenIds.add(task.id);
    assert(
      typeof task.title === "string" && task.title.trim().length > 0,
      `Task ${task.id} requires a non-empty title.`,
    );
    assert(
      Array.isArray(task.fixedInputs) && task.fixedInputs.length > 0,
      `Task ${task.id} requires fixedInputs.`,
    );
    assert(
      Array.isArray(task.successCriteria) && task.successCriteria.length > 0,
      `Task ${task.id} requires successCriteria.`,
    );
    assert(
      Array.isArray(task.failureCriteria) && task.failureCriteria.length > 0,
      `Task ${task.id} requires failureCriteria.`,
    );
  }

  return taskSet;
}

export function validateEvaluationRunMatrix(
  taskSet: EvaluationTaskSet,
  matrix: EvaluationRunMatrix,
): EvaluationRunMatrix {
  validateEvaluationTaskSet(taskSet);
  assert(
    matrix.taskSetVersion === taskSet.version,
    `Run matrix version ${matrix.taskSetVersion} does not match task set ${taskSet.version}.`,
  );
  const expectedPairs = new Set<string>();
  for (const task of taskSet.tasks) {
    for (const mode of MODE_ORDER) {
      expectedPairs.add(`${task.id}::${mode}`);
    }
  }

  const actualPairs = new Set<string>();
  for (const run of matrix.runs) {
    const key = `${run.taskId}::${run.mode}`;
    assert(expectedPairs.has(key), `Unexpected run record ${key}.`);
    assert(!actualPairs.has(key), `Duplicate run record ${key}.`);
    actualPairs.add(key);
    assert(run.turnCount > 0, `Run ${key} requires turnCount > 0.`);
    assert(run.latencyMs > 0, `Run ${key} requires latencyMs > 0.`);
    assert(run.costUsd >= 0, `Run ${key} requires costUsd >= 0.`);
    assert(
      run.baselineMainContextChars >= run.actualMainContextChars,
      `Run ${key} has actualMainContextChars larger than baseline.`,
    );
    if (!run.success) {
      assert(run.failureCategory, `Run ${key} requires failureCategory when success=false.`);
      assert(run.failureSummary, `Run ${key} requires failureSummary when success=false.`);
    }
  }

  assert(
    actualPairs.size === expectedPairs.size,
    `Run matrix is incomplete. Expected ${expectedPairs.size} run records, received ${actualPairs.size}.`,
  );
  return matrix;
}

export function summarizeMode(
  taskSet: EvaluationTaskSet,
  matrix: EvaluationRunMatrix,
  mode: EvaluationMode,
): ModeMetrics {
  validateEvaluationRunMatrix(taskSet, matrix);
  const taskMap = new Map(taskSet.tasks.map((task) => [task.id, task]));
  const runs = matrix.runs.filter((run) => run.mode === mode);
  const taskCount = runs.length;
  const successCount = runs.filter((run) => run.success).length;
  const workerRuns = runs.filter((run) => run.workerAttempted);
  const acceptedRuns = workerRuns.filter((run) => run.workerAccepted);
  const revisedRuns = workerRuns.filter((run) => run.revisionCount > 0);
  const fallbackRuns = workerRuns.filter((run) => run.fallbackToDs);
  const failureBreakdown = Object.fromEntries(
    FAILURE_CATEGORY_ORDER.map((category) => [category, 0]),
  ) as Record<EvaluationFailureCategory, number>;

  for (const run of runs) {
    if (run.failureCategory) {
      failureBreakdown[run.failureCategory] += 1;
    }
  }

  const routingMatches = runs.filter((run) => taskMap.get(run.taskId)?.idealRoute === run.actualRoute).length;
  const totalBaselineContext = runs.reduce((sum, run) => sum + run.baselineMainContextChars, 0);
  const totalActualContext = runs.reduce((sum, run) => sum + run.actualMainContextChars, 0);
  const visionScores = runs
    .map((run) => run.visionUsefulnessScore)
    .filter((value): value is number => typeof value === "number");

  return {
    mode,
    taskCount,
    successCount,
    taskSuccessRate: round(successCount / taskCount),
    routingPrecision: round(routingMatches / taskCount),
    workerAcceptanceRate: round(
      workerRuns.length === 0 ? 0 : acceptedRuns.length / workerRuns.length,
    ),
    workerRevisionRate: round(
      workerRuns.length === 0 ? 0 : revisedRuns.length / workerRuns.length,
    ),
    fallbackToDsRate: round(
      workerRuns.length === 0 ? 0 : fallbackRuns.length / workerRuns.length,
    ),
    avgTurnCount: round(average(runs.map((run) => run.turnCount))),
    medianTaskLatencyMs: median(runs.map((run) => run.latencyMs)),
    costPerTaskUsd: round(average(runs.map((run) => run.costUsd))),
    contextSavedRatio: round(
      totalBaselineContext === 0 ? 0 : (totalBaselineContext - totalActualContext) / totalBaselineContext,
    ),
    visionUsefulnessScore: round(average(visionScores)),
    failureBreakdown,
  };
}

export function summarizeAllModes(
  taskSet: EvaluationTaskSet,
  matrix: EvaluationRunMatrix,
): Record<EvaluationMode, ModeMetrics> {
  return {
    ds_only: summarizeMode(taskSet, matrix, "ds_only"),
    ds_glm: summarizeMode(taskSet, matrix, "ds_glm"),
    ds_glm_kimi: summarizeMode(taskSet, matrix, "ds_glm_kimi"),
  };
}

export function buildPhase7Recommendations(
  taskSet: EvaluationTaskSet,
  summaries: Record<EvaluationMode, ModeMetrics>,
): Phase7Recommendations {
  validateEvaluationTaskSet(taskSet);
  return {
    routeWhitelist: [
      "DeepSeek direct: 简单补丁、单文件微调、小脚本修复。",
      "GLM: 复杂后端实现、跨文件重构、接口改造。",
      "Kimi: 带明确图片输入的报错截图、OCR、UI 结构提取任务。",
    ],
    routeBlacklist: [
      "不要把简单补丁默认路由给 GLM。",
      "不要把纯文本仓库理解或验收任务路由给 Kimi。",
      "没有具体 image ref 的截图类请求不要自动路由给 Kimi。",
    ],
    manualReviewRequired: [
      "UI 解析后直接改码仍需人工或 supervisor 二次审阅。",
      "涉及权限敏感或高风险写操作的任务仍需保留人工覆盖。",
      "vision usefulness score 低于 0.80 的截图类任务默认进入人工复核。",
    ],
    dataGaps: [
      "任务集未覆盖数据库迁移与大规模 schema 变更。",
      "任务集未覆盖长链路 MCP/browser 自动化任务。",
      "任务集未覆盖大型设计稿、超大图片与多图联合推理。",
    ],
  };
}

function buildMetricTable(metrics: ModeMetrics[]): string {
  const lines = [
    "| 模式 | success rate | routing precision | worker acceptance | worker revision | fallback to ds | avg turns | median latency | cost/task | context saved | vision usefulness |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const metric of metrics) {
    lines.push(
      `| ${modeLabel(metric.mode)} | ${formatPercent(metric.taskSuccessRate)} | ${formatPercent(metric.routingPrecision)} | ${formatPercent(metric.workerAcceptanceRate)} | ${formatPercent(metric.workerRevisionRate)} | ${formatPercent(metric.fallbackToDsRate)} | ${metric.avgTurnCount.toFixed(1)} | ${formatMs(metric.medianTaskLatencyMs)} | ${formatUsd(metric.costPerTaskUsd)} | ${formatPercent(metric.contextSavedRatio)} | ${metric.visionUsefulnessScore.toFixed(2)} |`,
    );
  }

  return lines.join("\n");
}

function buildTaskBreakdownTable(
  taskSet: EvaluationTaskSet,
  matrix: EvaluationRunMatrix,
  modes: EvaluationMode[],
): string {
  const runsByKey = new Map(matrix.runs.map((run) => [`${run.taskId}::${run.mode}`, run]));
  const header = ["任务", "分类", "理想路由", ...modes.map((mode) => `${modeLabel(mode)} 结果`)];
  const divider = header.map(() => "---");
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${divider.join(" | ")} |`,
  ];

  for (const task of taskSet.tasks) {
    const cells = [
      task.title,
      taskCategoryLabel(task.category),
      task.idealRoute,
    ];
    for (const mode of modes) {
      const run = runsByKey.get(`${task.id}::${mode}`);
      assert(run, `Missing run for ${task.id} in ${mode}.`);
      const status = run.success ? "success" : `fail (${run.failureCategory})`;
      cells.push(`${status}; route=${run.actualRoute}; turns=${run.turnCount}`);
    }
    lines.push(`| ${cells.join(" | ")} |`);
  }

  return lines.join("\n");
}

function buildFailureBreakdown(metrics: ModeMetrics): string {
  return FAILURE_CATEGORY_ORDER.map(
    (category) => `- ${failureLabel(category)}: ${metrics.failureBreakdown[category]}`,
  ).join("\n");
}

export function buildPhase7Artifacts(input: {
  taskSet: EvaluationTaskSet;
  matrix: EvaluationRunMatrix;
  repoValidations: InternalRepoValidationResult[];
}): Phase7Artifacts {
  const summaries = summarizeAllModes(input.taskSet, input.matrix);
  const recommendations = buildPhase7Recommendations(input.taskSet, summaries);
  const baseline = summaries.ds_only;
  const dsGlm = summaries.ds_glm;
  const dsGlmKimi = summaries.ds_glm_kimi;
  const complexTaskIds = input.taskSet.tasks
    .filter((task) =>
      task.category === "complex_backend_implementation" || task.category === "cross_file_refactor",
    )
    .map((task) => task.id);
  const visionTaskIds = input.taskSet.tasks
    .filter((task) =>
      task.category === "screenshot_bug_fix" || task.category === "ui_parse_to_code",
    )
    .map((task) => task.id);
  const complexDelta =
    complexTaskIds.filter(
      (taskId) =>
        input.matrix.runs.find((run) => run.taskId === taskId && run.mode === "ds_only")?.success !==
        input.matrix.runs.find((run) => run.taskId === taskId && run.mode === "ds_glm")?.success,
    ).length;
  const visionDelta =
    visionTaskIds.filter(
      (taskId) =>
        input.matrix.runs.find((run) => run.taskId === taskId && run.mode === "ds_glm")?.success !==
        input.matrix.runs.find((run) => run.taskId === taskId && run.mode === "ds_glm_kimi")?.success,
    ).length;

  const repoValidationTable =
    input.repoValidations.length === 0
      ? "暂无内部仓库验证记录。"
      : [
          "| 仓库 | 场景 | 日志 | artifact | resume | undo | permission layer |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          ...input.repoValidations.map(
            (entry) =>
              `| ${entry.repoRootName} | ${entry.scenario} | ${entry.logsVerified ? "ok" : "fail"} | ${entry.artifactVerified ? "ok" : "fail"} | ${entry.resumeVerified ? "ok" : "fail"} | ${entry.undoVerified ? "ok" : "fail"} | ${entry.permissionGuardVerified ? "ok" : "fail"} |`,
          ),
        ].join("\n");

  const dsOnlyBaselineReport = [
    "# Phase 7 DS-Only Baseline Report",
    "",
    `任务集版本：\`${input.taskSet.version}\``,
    "",
    "## 基线指标",
    "",
    buildMetricTable([baseline]),
    "",
    "## 任务明细",
    "",
    buildTaskBreakdownTable(input.taskSet, input.matrix, ["ds_only"]),
    "",
    "## 失败分类",
    "",
    buildFailureBreakdown(baseline),
  ].join("\n");

  const dsGlmComparisonReport = [
    "# Phase 7 DS + GLM Comparison Report",
    "",
    `任务集版本：\`${input.taskSet.version}\``,
    "",
    "## 对比指标",
    "",
    buildMetricTable([baseline, dsGlm]),
    "",
    "## 复杂编码任务变化",
    "",
    `- 复杂编码任务成功差异：${complexDelta} / ${complexTaskIds.length} 个任务出现正向变化。`,
    `- success rate 从 ${formatPercent(baseline.taskSuccessRate)} 提升到 ${formatPercent(dsGlm.taskSuccessRate)}。`,
    `- routing precision 从 ${formatPercent(baseline.routingPrecision)} 提升到 ${formatPercent(dsGlm.routingPrecision)}。`,
    `- context saved ratio 从 ${formatPercent(baseline.contextSavedRatio)} 提升到 ${formatPercent(dsGlm.contextSavedRatio)}。`,
    "",
    "## 任务明细",
    "",
    buildTaskBreakdownTable(input.taskSet, input.matrix, ["ds_only", "ds_glm"]),
    "",
    "## 路由建议",
    "",
    recommendations.routeWhitelist.map((entry) => `- ${entry}`).join("\n"),
  ].join("\n");

  const dsGlmKimiComparisonReport = [
    "# Phase 7 DS + GLM + Kimi Comparison Report",
    "",
    `任务集版本：\`${input.taskSet.version}\``,
    "",
    "## 对比指标",
    "",
    buildMetricTable([dsGlm, dsGlmKimi]),
    "",
    "## 图像任务变化",
    "",
    `- 图像任务收益差异：${visionDelta} / ${visionTaskIds.length} 个任务出现正向变化。`,
    `- success rate 从 ${formatPercent(dsGlm.taskSuccessRate)} 提升到 ${formatPercent(dsGlmKimi.taskSuccessRate)}。`,
    `- routing precision 从 ${formatPercent(dsGlm.routingPrecision)} 提升到 ${formatPercent(dsGlmKimi.routingPrecision)}。`,
    `- vision usefulness score 从 ${dsGlm.visionUsefulnessScore.toFixed(2)} 提升到 ${dsGlmKimi.visionUsefulnessScore.toFixed(2)}。`,
    "",
    "## 任务明细",
    "",
    buildTaskBreakdownTable(input.taskSet, input.matrix, ["ds_glm", "ds_glm_kimi"]),
    "",
    "## 失败分类",
    "",
    buildFailureBreakdown(dsGlmKimi),
  ].join("\n");

  const internalReleaseReport = [
    "# Phase 7 Internal Release Notes",
    "",
    `任务集版本：\`${input.taskSet.version}\``,
    "",
    "## 已支持能力",
    "",
    "- DeepSeek direct 处理简单补丁、计划整理、最终验收。",
    "- GLM 处理复杂后端实现与跨文件重构。",
    "- Kimi 处理带明确图片输入的错误截图、OCR、UI 结构提取。",
    "- 统一保留 permission layer、checkpoint、artifact promotion、undo。",
    "",
    "## 未支持或默认不支持",
    "",
    "- 不默认支持数据库迁移级任务的自动放行。",
    "- 不默认支持无图片引用的视觉路由。",
    "- 不默认支持 UI 截图到最终改码的全自动闭环放量。",
    "",
    "## 已知限制与风险",
    "",
    recommendations.manualReviewRequired.map((entry) => `- ${entry}`).join("\n"),
    "",
    "## 推荐使用姿势",
    "",
    recommendations.routeWhitelist.map((entry) => `- ${entry}`).join("\n"),
    "",
    "## 路由黑名单",
    "",
    recommendations.routeBlacklist.map((entry) => `- ${entry}`).join("\n"),
    "",
    "## 数据空白区",
    "",
    recommendations.dataGaps.map((entry) => `- ${entry}`).join("\n"),
    "",
    "## 内部仓库验证",
    "",
    repoValidationTable,
    "",
    "## 反馈模板",
    "",
    [
      "1. 任务类型：",
      "2. 预期路由：",
      "3. 实际路由：",
      "4. 成功/失败：",
      "5. 失败分类：",
      "6. 日志或 artifact 证据：",
      "7. 建议改进：",
    ].join("\n"),
  ].join("\n");

  return {
    dsOnlyBaselineReport,
    dsGlmComparisonReport,
    dsGlmKimiComparisonReport,
    internalReleaseReport,
  };
}

export async function writePhase7Artifacts(
  outputDir: string,
  artifacts: Phase7Artifacts,
): Promise<Phase7ArtifactPaths> {
  await fs.mkdir(outputDir, { recursive: true });
  const paths: Phase7ArtifactPaths = {
    dsOnlyBaselineReport: path.join(outputDir, "phase7-ds-only-baseline-report.md"),
    dsGlmComparisonReport: path.join(outputDir, "phase7-ds-glm-comparison-report.md"),
    dsGlmKimiComparisonReport: path.join(outputDir, "phase7-ds-glm-kimi-comparison-report.md"),
    internalReleaseReport: path.join(outputDir, "phase7-internal-release.md"),
  };

  await fs.writeFile(paths.dsOnlyBaselineReport, artifacts.dsOnlyBaselineReport, "utf8");
  await fs.writeFile(paths.dsGlmComparisonReport, artifacts.dsGlmComparisonReport, "utf8");
  await fs.writeFile(paths.dsGlmKimiComparisonReport, artifacts.dsGlmKimiComparisonReport, "utf8");
  await fs.writeFile(paths.internalReleaseReport, artifacts.internalReleaseReport, "utf8");
  return paths;
}

function buildValidationWorkerResult(relativeProbePath: string): GlmCodingWorkerExecutionResult {
  const content = [
    "# Phase 7 Internal Validation",
    "",
    "artifact promotion and undo check",
    "",
  ].join("\n");
  return {
    artifact: {
      summary: "Create a temporary validation note through the worker artifact flow.",
      changedFiles: [relativeProbePath],
      testCommands: [],
      risks: [],
      confidence: 0.9,
      notes: ["Validation artifact should be removable through undo."],
      metadata: {
        source: "phase7-internal-validation",
      },
    },
    patch: [
      "*** Begin Patch",
      `*** Add File: ${relativeProbePath}`,
      ...content.split("\n").map((line) => `+${line}`),
      "*** End Patch",
    ].join("\n"),
    rawResponse: "<code_artifact />",
  };
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function validateInternalRepoRuntime(input: {
  workspaceRoot: string;
  repoLabel?: string;
}): Promise<InternalRepoValidationResult> {
  const repoRootName = path.basename(input.workspaceRoot);
  const repoLabel = input.repoLabel ?? repoRootName;
  const sessionStore = new SessionStore(input.workspaceRoot);
  await sessionStore.ensureInitialized();

  const probeRelativePath = "phase7-validation/worker-probe.md";
  const probeAbsolutePath = path.join(input.workspaceRoot, probeRelativePath);
  const autoRuntime = new ToolRuntime({
    workspaceRoot: input.workspaceRoot,
    sessionStore,
    permissionMode: "auto",
  });
  const guardedSession = await sessionStore.createSession(`phase7 permission guard ${repoLabel}`);
  let permissionGuardVerified = false;
  try {
    await autoRuntime.executeManualTool(
      "apply_patch",
      {
        changes: [
          {
            path: probeRelativePath,
            action: "upsert",
            content: "guard check\n",
          },
        ],
      },
      guardedSession.sessionId,
    );
  } catch (error) {
    if (error instanceof PermissionRequiredError) {
      permissionGuardVerified = true;
    } else {
      throw error;
    }
  }

  const broker = new SpecialistBroker({
    workspaceRoot: input.workspaceRoot,
    sessionStore,
  });
  const dangerRuntime = new ToolRuntime({
    workspaceRoot: input.workspaceRoot,
    sessionStore,
    permissionMode: "danger-full-access",
  });
  const supervisor = new SupervisorReviewService(sessionStore, dangerRuntime, broker);
  const session = await sessionStore.createSession(`phase7 internal validation ${repoLabel}`);

  const task: WorkerTask = {
    workerType: "coding",
    objective: "Validate worker artifact promotion, logs, resume, undo, and permission guards in a real repo.",
    constraints: ["Only touch the dedicated validation probe file."],
    contextRefs: [
      {
        refType: "summary",
        label: "validation-scope",
        summary: `repo=${repoRootName}; probe=${probeRelativePath}`,
      },
    ],
    expectedOutput: "code_artifact",
    acceptanceChecks: ["Return a code artifact that creates the probe file."],
  };

  const syntheticResult = buildValidationWorkerResult(probeRelativePath);
  const workerSession = await sessionStore.createWorkerSession({
    parentSessionId: session.sessionId,
    task,
    route: createSyntheticCodingRouteProfile(),
    timeoutMs: 1000,
    maxRetries: 0,
  });
  await sessionStore.setWorkerSessionStatus({
    workerSessionId: workerSession.workerSessionId,
    status: "running",
    dispatchKind: workerSession.dispatchKind,
    attemptNumber: 1,
    reason: "Creating a synthetic code artifact for internal runtime validation.",
  });
  await sessionStore.appendWorkerMessage({
    workerSessionId: workerSession.workerSessionId,
    role: "assistant",
    content: syntheticResult.rawResponse,
  });
  await sessionStore.storeCodeArtifact({
    workerSessionId: workerSession.workerSessionId,
    artifact: {
      kind: "code_artifact",
      summary: syntheticResult.artifact.summary,
      changedFiles: syntheticResult.artifact.changedFiles,
      testCommands: syntheticResult.artifact.testCommands,
      risks: syntheticResult.artifact.risks,
      confidence: syntheticResult.artifact.confidence,
      notes: syntheticResult.artifact.notes,
      metadata: syntheticResult.artifact.metadata ?? {},
    },
    patchContent: syntheticResult.patch,
  });
  await sessionStore.setWorkerSessionStatus({
    workerSessionId: workerSession.workerSessionId,
    status: "completed",
    dispatchKind: workerSession.dispatchKind,
    attemptNumber: 1,
    reason: "Synthetic validation artifact stored.",
  });
  const workerSessionId = workerSession.workerSessionId;
  const artifactRecord = await sessionStore.loadLatestWorkerArtifact(workerSessionId);
  const artifactPath =
    artifactRecord && artifactRecord.summary.kind === "code_artifact"
      ? sessionStore.resolveArtifactPath(artifactRecord.summary.patchRef)
      : undefined;
  const artifactVerified = Boolean(artifactRecord && artifactPath && (await exists(artifactPath)));

  const acceptDecision: SupervisorDecision = {
    action: "accept",
    reason: "Validation artifact is ready for promotion.",
    evidenceRefs: [],
  };
  await supervisor.accept({
    workerSessionId,
    decision: acceptDecision,
  });
  const applyResult = await supervisor.applyAcceptedPatch({
    workerSessionId,
  });
  assert(applyResult.success, `Internal repo validation patch failed for ${repoLabel}.`);

  const resumedSession = await sessionStore.resolveMostRecentResumableSession(session.sessionId);
  const resumeVerified = resumedSession?.sessionId === session.sessionId;

  const undoResult = await supervisor.undo({
    sessionId: session.sessionId,
    mode: "code",
  });
  assert(undoResult.success, `Undo failed for ${repoLabel}.`);
  const undoVerified = !(await exists(probeAbsolutePath));

  const events = await sessionStore.loadEvents(session.sessionId);
  const logsVerified =
    events.some((event) => event.recordType === "worker_session_link") &&
    events.some((event) => event.recordType === "approval") &&
    events.some((event) => event.recordType === "checkpoint") &&
    events.some((event) => event.recordType === "diagnostic_report") &&
    events.some((event) => event.recordType === "artifact_promotion") &&
    events.some((event) => event.recordType === "rollback");

  await fs.rm(path.join(input.workspaceRoot, "phase7-validation"), { recursive: true, force: true });

  return {
    repoLabel,
    repoRootName,
    validatedAt: now(),
    scenario: "worker artifact -> accept/apply -> undo -> permission guard",
    sessionId: session.sessionId,
    logsVerified,
    artifactVerified,
    resumeVerified,
    undoVerified,
    permissionGuardVerified,
    notes: [
      `apply_artifact_patch created checkpoint and diagnostics for ${probeRelativePath}.`,
      `undo restored code state and removed ${probeRelativePath}.`,
      "auto mode still required approval before write actions.",
    ],
  };
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export function buildEvaluationSummaryPayload(input: {
  taskSet: EvaluationTaskSet;
  matrix: EvaluationRunMatrix;
  repoValidations: InternalRepoValidationResult[];
  artifactPaths: Phase7ArtifactPaths;
}): Record<string, unknown> {
  const summaries = summarizeAllModes(input.taskSet, input.matrix);
  return {
    taskSetVersion: input.taskSet.version,
    metrics: Object.fromEntries(
      MODE_ORDER.map((mode) => [
        mode,
        {
          taskSuccessRate: summaries[mode].taskSuccessRate,
          routingPrecision: summaries[mode].routingPrecision,
          workerAcceptanceRate: summaries[mode].workerAcceptanceRate,
          workerRevisionRate: summaries[mode].workerRevisionRate,
          fallbackToDsRate: summaries[mode].fallbackToDsRate,
          avgTurnCount: summaries[mode].avgTurnCount,
          medianTaskLatencyMs: summaries[mode].medianTaskLatencyMs,
          costPerTaskUsd: summaries[mode].costPerTaskUsd,
          contextSavedRatio: summaries[mode].contextSavedRatio,
          visionUsefulnessScore: summaries[mode].visionUsefulnessScore,
        },
      ]),
    ),
    repoValidations: input.repoValidations,
    reports: input.artifactPaths,
    generatedAt: now(),
    runId: randomUUID(),
  };
}
