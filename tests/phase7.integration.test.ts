import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEvaluationSummaryPayload,
  buildPhase7Artifacts,
  readJsonFile,
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
  it("validates the frozen task set, summarizes all three modes, and generates reports", async () => {
    const taskSet = validateEvaluationTaskSet(
      await readJsonFile<EvaluationTaskSet>("docs/evaluation/phase7-task-set.v1.json"),
    );
    const matrix = validateEvaluationRunMatrix(
      taskSet,
      await readJsonFile<EvaluationRunMatrix>("docs/evaluation/phase7-run-matrix.v1.json"),
    );
    const summaries = summarizeAllModes(taskSet, matrix);

    expect(summaries.ds_only.taskSuccessRate).toBe(0.2);
    expect(summaries.ds_glm.taskSuccessRate).toBe(0.6);
    expect(summaries.ds_glm_kimi.taskSuccessRate).toBe(1);
    expect(summaries.ds_glm.routingPrecision).toBe(0.6);
    expect(summaries.ds_glm_kimi.routingPrecision).toBe(1);
    expect(summaries.ds_glm_kimi.visionUsefulnessScore).toBeGreaterThan(
      summaries.ds_glm.visionUsefulnessScore,
    );

    const artifacts = buildPhase7Artifacts({
      taskSet,
      matrix,
      repoValidations: [],
    });
    expect(artifacts.dsOnlyBaselineReport).toContain("DS-Only Baseline Report");
    expect(artifacts.dsGlmComparisonReport).toContain("复杂编码任务变化");
    expect(artifacts.dsGlmKimiComparisonReport).toContain("图像任务变化");
    expect(artifacts.internalReleaseReport).toContain("反馈模板");

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
    expect(summaryPayload.taskSetVersion).toBe("phase7-task-set.v1");
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
