import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEvaluationSummaryPayload,
  buildPhase7Artifacts,
  summarizeAllModes,
  validateEvaluationRunMatrix,
  validateEvaluationTaskSet,
  validateInternalRepoRuntime,
  writePhase7Artifacts,
  type EvaluationRunMatrix,
  type EvaluationTaskSet,
} from "../packages/evals/src/index.js";

const temporaryRoots: string[] = [];

async function createInternalValidationWorkspace(label: string): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), `deep-mix-phase7-${label}-`));
  temporaryRoots.push(workspaceRoot);
  await fs.writeFile(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify(
      {
        name: `phase7-${label}`,
        private: true,
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(path.join(workspaceRoot, "README.md"), `# ${label}\n`, "utf8");
  return workspaceRoot;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe("phase 7 evaluation and internal release", () => {
  it("validates a public synthetic task set, summarizes all three modes, and generates reports", async () => {
    const taskSet = validateEvaluationTaskSet({
      version: "public-phase7-fixture.v1",
      createdAt: "2026-07-08T00:00:00.000Z",
      tasks: [{
        id: "public-simple-patch",
        category: "simple_patch",
        title: "Public synthetic patch",
        prompt: "Apply one bounded synthetic patch.",
        fixedInputs: ["file://src/example.ts"],
        successCriteria: ["The bounded synthetic task succeeds."],
        failureCriteria: ["The task escapes its declared scope."],
        idealRoute: "ds_direct",
      }],
    } satisfies EvaluationTaskSet);
    const matrix = validateEvaluationRunMatrix(taskSet, {
      taskSetVersion: taskSet.version,
      generatedAt: "2026-07-08T00:00:00.000Z",
      runs: (["ds_only", "ds_glm", "ds_glm_kimi"] as const).map((mode) => ({
        taskId: "public-simple-patch",
        mode,
        actualRoute: "ds_direct",
        success: true,
        turnCount: 1,
        latencyMs: 10,
        costUsd: 0,
        baselineMainContextChars: 100,
        actualMainContextChars: 100,
        workerAttempted: false,
        workerAccepted: false,
        revisionCount: 0,
        fallbackToDs: false,
      })),
    } satisfies EvaluationRunMatrix);
    const summaries = summarizeAllModes(taskSet, matrix);

    expect(summaries.ds_only.taskSuccessRate).toBe(1);
    expect(summaries.ds_glm.taskSuccessRate).toBe(1);
    expect(summaries.ds_glm_kimi.taskSuccessRate).toBe(1);
    expect(summaries.ds_glm.routingPrecision).toBe(1);
    expect(summaries.ds_glm_kimi.routingPrecision).toBe(1);
    expect(summaries.ds_glm_kimi.visionUsefulnessScore).toBe(0);

    const artifacts = buildPhase7Artifacts({
      taskSet,
      matrix,
      repoValidations: [],
    });
    expect(artifacts.dsOnlyBaselineReport).toContain("DS-Only Baseline Report");
    expect(artifacts.dsGlmComparisonReport).toContain("复杂编码任务变化");
    expect(artifacts.dsGlmComparisonReport).toContain("Coding Worker");
    expect(artifacts.dsGlmKimiComparisonReport).toContain("图像任务变化");
    expect(artifacts.internalReleaseReport).toContain("反馈模板");
    expect(artifacts.internalReleaseReport).toContain("Governor direct");
    expect(artifacts.internalReleaseReport).toContain("Vision Worker");
    expect(artifacts.internalReleaseReport).toContain("Phase 7 classic 历史评测模式名");

    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase7-reports-"));
    temporaryRoots.push(outputDir);
    const paths = await writePhase7Artifacts(outputDir, artifacts);
    expect(await fs.readFile(paths.dsOnlyBaselineReport, "utf8")).toContain("任务集版本");
    expect(await fs.readFile(paths.internalReleaseReport, "utf8")).toContain("推荐使用姿势");

    const summaryPayload = buildEvaluationSummaryPayload({
      taskSet,
      matrix,
      repoValidations: [],
      artifactPaths: paths,
    });
    expect(summaryPayload.taskSetVersion).toBe(taskSet.version);
  });

  it("runs the internal repo validation flow with artifact promotion, undo, resume, and permission guard checks", async () => {
    const workspaceRoot = await createInternalValidationWorkspace("repo-check");
    const result = await validateInternalRepoRuntime({
      workspaceRoot,
    });

    expect(result.logsVerified).toBe(true);
    expect(result.artifactVerified).toBe(true);
    expect(result.resumeVerified).toBe(true);
    expect(result.undoVerified).toBe(true);
    expect(result.permissionGuardVerified).toBe(true);
    expect(result.scenario).toContain("worker artifact");
  }, 15000);
});
