import path from "node:path";
import {
  buildEvaluationSummaryPayload,
  buildPhase7Artifacts,
  readJsonFile,
  validateEvaluationRunMatrix,
  validateEvaluationTaskSet,
  validateInternalRepoRuntime,
  writeJsonFile,
  writePhase7Artifacts,
  type EvaluationRunMatrix,
  type EvaluationTaskSet,
  type InternalRepoValidationResult,
} from "../../../packages/evals/src/index.js";

interface Args {
  taskSetPath: string;
  runMatrixPath: string;
  outputDir: string;
  repoValidationFile: string;
  validateRepos: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    taskSetPath: path.resolve(process.cwd(), "docs/evaluation/phase7-task-set.v1.json"),
    runMatrixPath: path.resolve(process.cwd(), "docs/evaluation/phase7-run-matrix.v1.json"),
    outputDir: path.resolve(process.cwd(), "docs/evaluation"),
    repoValidationFile: path.resolve(process.cwd(), "docs/evaluation/phase7-repo-validations.json"),
    validateRepos: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--task-set" && argv[index + 1]) {
      args.taskSetPath = path.resolve(process.cwd(), argv[index + 1]!);
      index += 1;
      continue;
    }
    if (value === "--run-matrix" && argv[index + 1]) {
      args.runMatrixPath = path.resolve(process.cwd(), argv[index + 1]!);
      index += 1;
      continue;
    }
    if (value === "--output-dir" && argv[index + 1]) {
      args.outputDir = path.resolve(process.cwd(), argv[index + 1]!);
      index += 1;
      continue;
    }
    if (value === "--repo-validation-file" && argv[index + 1]) {
      args.repoValidationFile = path.resolve(process.cwd(), argv[index + 1]!);
      index += 1;
      continue;
    }
    if (value === "--validate-repo" && argv[index + 1]) {
      args.validateRepos.push(path.resolve(process.cwd(), argv[index + 1]!));
      index += 1;
    }
  }

  return args;
}

async function loadRepoValidations(filePath: string): Promise<InternalRepoValidationResult[]> {
  try {
    return await readJsonFile<InternalRepoValidationResult[]>(filePath);
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const taskSet = validateEvaluationTaskSet(await readJsonFile<EvaluationTaskSet>(args.taskSetPath));
  const runMatrix = validateEvaluationRunMatrix(taskSet, await readJsonFile<EvaluationRunMatrix>(args.runMatrixPath));

  let repoValidations = await loadRepoValidations(args.repoValidationFile);
  if (args.validateRepos.length > 0) {
    repoValidations = [];
    for (const repoPath of args.validateRepos) {
      repoValidations.push(
        await validateInternalRepoRuntime({
          workspaceRoot: repoPath,
        }),
      );
    }
    await writeJsonFile(args.repoValidationFile, repoValidations);
  }

  const artifacts = buildPhase7Artifacts({
    taskSet,
    matrix: runMatrix,
    repoValidations,
  });
  const artifactPaths = await writePhase7Artifacts(args.outputDir, artifacts);
  const summaryPayload = buildEvaluationSummaryPayload({
    taskSet,
    matrix: runMatrix,
    repoValidations,
    artifactPaths,
  });
  console.log(JSON.stringify(summaryPayload, null, 2));
}

await main();
