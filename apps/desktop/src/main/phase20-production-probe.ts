import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";

import { SessionStore } from "../../../../packages/persistence/src/index.js";
import type { ToolResult } from "../../../../packages/shared-schema/src/index.js";
import { ToolRuntime } from "../../../../packages/tool-runtime/src/index.js";

export const PHASE20_PRODUCTION_PROBE_MARKER = "DEEP_MIX_PHASE20_PRODUCTION_PROBE=";

const PHASE20_TOOL_NAMES = [
  "read_spreadsheet",
  "write_spreadsheet",
  "read_presentation",
  "write_presentation",
  "read_notebook",
  "edit_notebook",
  "read_image",
  "archive_manage",
  "convert_document",
] as const;

const PHASE14_BASELINE_TOOL_NAMES = [
  "read_pdf",
  "write_pdf",
  "read_docx",
  "write_docx",
] as const;

type Phase20ToolName = typeof PHASE20_TOOL_NAMES[number];
type Phase14BaselineToolName = typeof PHASE14_BASELINE_TOOL_NAMES[number];
type ProductionProbeToolName = Phase20ToolName | Phase14BaselineToolName;

export interface Phase20ProductionProbeReport {
  runtime: string;
  bundledMainEntry: string;
  registeredTools: Phase20ToolName[];
  availableTools: Phase20ToolName[];
  baselineRegisteredTools: Phase14BaselineToolName[];
  baselineAvailableTools: Phase14BaselineToolName[];
  dependencyOperations: {
    exceljsAndJszip: "xlsx_write_read";
    pptxgenjsAndJszip: "pptx_write_read";
    sharp: "image_metadata_and_preview";
    yauzl: "zip_list_and_extract";
    jszip: "zip_create";
  };
  toolOperations: Record<Phase20ToolName, "passed">;
  baselineOperations: Record<Phase14BaselineToolName, "passed">;
  boundaries: {
    officeAutomation: boolean;
    externalConverters: boolean;
    notebookExecution: boolean;
    imageOcrOrSemanticAnalysis: boolean;
  };
  boundaryEvidence: {
    conversionCapabilitiesChecked: boolean;
    archiveCapabilitiesChecked: boolean;
    notebookCodeSentinelAbsentAfterRead: boolean;
    notebookCodeSentinelAbsentAfterEdit: boolean;
    imageTechnicalFlagsChecked: boolean;
  };
}

function asRecord(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} did not return an object.`);
  }
  return value as Record<string, unknown>;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireToolSuccess(toolName: ProductionProbeToolName, result: ToolResult): Record<string, unknown> {
  if (!result.success) {
    const boundedOutput = result.output.slice(0, 2_000);
    throw new Error(`${toolName} failed inside the production bundle: ${boundedOutput}`);
  }
  return asRecord(result.structuredContent, `${toolName} structuredContent`);
}

async function pathExists(inputPath: string): Promise<boolean> {
  try {
    await fs.stat(inputPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function removeProbeWorkspace(workspaceRoot: string): Promise<void> {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedTemporaryDirectory = path.resolve(os.tmpdir());
  assertCondition(
    path.dirname(resolvedRoot) === resolvedTemporaryDirectory &&
      path.basename(resolvedRoot).startsWith("deep-mix-phase20-production-"),
    `Refusing to remove unexpected production-probe path: ${resolvedRoot}`,
  );
  await fs.rm(resolvedRoot, { recursive: true, force: true });
}

/**
 * Runs only when the Desktop main process is launched with the explicit Phase 20
 * probe environment variable. Every operation below goes through ToolRuntime,
 * its registry, permission layer, path guards, checkpoints, and artifact store.
 */
export async function runPhase20ProductionProbe(): Promise<Phase20ProductionProbeReport> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase20-production-"));
  let runtime: ToolRuntime | undefined;

  try {
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const session = await sessionStore.createSession(
      "Verify Phase 20 dependencies and tools inside the Desktop production bundle.",
    );
    runtime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
    });
    await runtime.initialize();

    const registered = new Set(runtime.listRegisteredToolDefinitions().map((tool) => tool.name));
    const available = new Set(runtime.listAvailableToolDefinitions().map((tool) => tool.name));
    const missingRegistered = PHASE20_TOOL_NAMES.filter((name) => !registered.has(name));
    const missingAvailable = PHASE20_TOOL_NAMES.filter((name) => !available.has(name));
    const missingBaselineRegistered = PHASE14_BASELINE_TOOL_NAMES.filter((name) => !registered.has(name));
    const missingBaselineAvailable = PHASE14_BASELINE_TOOL_NAMES.filter((name) => !available.has(name));
    assertCondition(
      missingRegistered.length === 0,
      `Phase 20 tools missing from the production Tool Registry: ${missingRegistered.join(", ")}`,
    );
    assertCondition(
      missingAvailable.length === 0,
      `Phase 20 tools unavailable in the production bundle: ${missingAvailable.join(", ")}`,
    );
    assertCondition(
      missingBaselineRegistered.length === 0,
      `Phase 14 baseline tools missing from the production Tool Registry: ${missingBaselineRegistered.join(", ")}`,
    );
    assertCondition(
      missingBaselineAvailable.length === 0,
      `Phase 14 baseline tools unavailable in the production bundle: ${missingBaselineAvailable.join(", ")}`,
    );

    const sessionId = session.sessionId;
    const completedOperations = new Set<ProductionProbeToolName>();
    const requireCompletedToolSuccess = (
      toolName: ProductionProbeToolName,
      result: ToolResult,
    ): Record<string, unknown> => {
      const body = requireToolSuccess(toolName, result);
      completedOperations.add(toolName);
      return body;
    };

    const spreadsheetWritten = requireCompletedToolSuccess(
      "write_spreadsheet",
      await runtime.executeManualTool(
        "write_spreadsheet",
        {
          outputPath: "artifacts/production.xlsx",
          document: {
            title: "Desktop production probe",
            activeSheet: "Data",
            sheets: [{
              name: "Data",
              headers: [
                { column: 1, label: "name" },
                { column: 2, label: "value" },
              ],
              cells: [
                { row: 2, column: 1, type: "string", value: "alpha" },
                { row: 2, column: 2, type: "number", value: 42 },
              ],
            }],
          },
        },
        sessionId,
      ),
    );
    assertCondition(spreadsheetWritten.format === "xlsx", "write_spreadsheet did not publish XLSX output.");

    const spreadsheetRead = requireCompletedToolSuccess(
      "read_spreadsheet",
      await runtime.executeManualTool(
        "read_spreadsheet",
        { path: "artifacts/production.xlsx", maxCells: 20 },
        sessionId,
      ),
    );
    assertCondition(spreadsheetRead.totalSheets === 1, "read_spreadsheet did not read the generated workbook.");

    const presentationWritten = requireCompletedToolSuccess(
      "write_presentation",
      await runtime.executeManualTool(
        "write_presentation",
        {
          outputPath: "artifacts/production.pptx",
          presentation: {
            title: "Desktop production probe",
            layout: { width: 10, height: 5.625 },
            slides: [{
              id: "probe",
              title: "Phase 20 production",
              elements: [
                {
                  type: "title",
                  text: "Phase 20 production",
                  bounds: { x: 0.6, y: 0.4, width: 8.8, height: 0.7 },
                },
                {
                  type: "table",
                  headers: ["dependency", "status"],
                  rows: [["PptxGenJS", "available"], ["JSZip", "available"]],
                  bounds: { x: 0.8, y: 1.6, width: 8.4, height: 2.2 },
                },
              ],
            }],
          },
        },
        sessionId,
      ),
    );
    assertCondition(presentationWritten.format === "pptx", "write_presentation did not publish PPTX output.");

    const presentationRead = requireCompletedToolSuccess(
      "read_presentation",
      await runtime.executeManualTool(
        "read_presentation",
        { path: "artifacts/production.pptx", maxSlides: 5 },
        sessionId,
      ),
    );
    assertCondition(presentationRead.totalSlides === 1, "read_presentation did not read the generated deck.");

    const notebookSentinelPath = path.join(workspaceRoot, "phase20-production-cell-executed.txt");
    const notebookCode = `open(${JSON.stringify(notebookSentinelPath.replace(/\\/gu, "/"))}, 'w').write('unsafe')`;
    await fs.writeFile(
      path.join(workspaceRoot, "production.ipynb"),
      `${JSON.stringify({
        cells: [{
          cell_type: "code",
          id: "intro",
          metadata: {},
          source: [notebookCode],
          execution_count: null,
          outputs: [],
        }],
        metadata: { language_info: { name: "python" } },
        nbformat: 4,
        nbformat_minor: 5,
      }, null, 2)}\n`,
      "utf8",
    );

    const notebookRead = requireCompletedToolSuccess(
      "read_notebook",
      await runtime.executeManualTool(
        "read_notebook",
        { path: "production.ipynb", maxCells: 5 },
        sessionId,
      ),
    );
    assertCondition(notebookRead.totalCells === 1, "read_notebook did not read the nbformat fixture.");
    const notebookCodeSentinelAbsentAfterRead = !(await pathExists(notebookSentinelPath));
    assertCondition(notebookCodeSentinelAbsentAfterRead, "read_notebook executed the production code-cell fixture.");

    const notebookEdited = requireCompletedToolSuccess(
      "edit_notebook",
      await runtime.executeManualTool(
        "edit_notebook",
        {
          path: "production.ipynb",
          outputPath: "artifacts/production-edited.ipynb",
          operations: [{
            type: "update",
            cellId: "intro",
            patch: { source: `${notebookCode}\n# edited structurally without execution` },
          }],
        },
        sessionId,
      ),
    );
    assertCondition(
      notebookEdited.format === "ipynb",
      "edit_notebook did not publish the edited notebook structure.",
    );
    const notebookCodeSentinelAbsentAfterEdit = !(await pathExists(notebookSentinelPath));
    assertCondition(notebookCodeSentinelAbsentAfterEdit, "edit_notebook executed the production code-cell fixture.");

    await sharp({
      create: {
        width: 4,
        height: 3,
        channels: 4,
        background: { r: 20, g: 80, b: 160, alpha: 0.75 },
      },
    }).png().toFile(path.join(workspaceRoot, "production.png"));
    const imageRead = requireCompletedToolSuccess(
      "read_image",
      await runtime.executeManualTool(
        "read_image",
        { path: "production.png", preview: { maxEdge: 64 } },
        sessionId,
      ),
    );
    const imageMetadata = asRecord(imageRead.metadata, "read_image metadata");
    const visionWorkerHint = asRecord(imageRead.visionWorkerHint, "read_image visionWorkerHint");
    assertCondition(imageMetadata.width === 4 && imageMetadata.height === 3, "sharp returned unexpected PNG dimensions.");
    assertCondition(
      visionWorkerHint.automaticInvocation === false,
      "read_image crossed the explicit Kimi Vision Worker boundary.",
    );

    await fs.mkdir(path.join(workspaceRoot, "archive-input"));
    await fs.writeFile(path.join(workspaceRoot, "archive-input", "unicode-文件.txt"), "bounded archive payload", "utf8");
    const archiveCreated = requireCompletedToolSuccess(
      "archive_manage",
      await runtime.executeManualTool(
        "archive_manage",
        {
          action: "create",
          outputPath: "artifacts/production.zip",
          paths: ["archive-input/unicode-文件.txt"],
        },
        sessionId,
      ),
    );
    assertCondition(archiveCreated.action === "create", "archive_manage did not create a ZIP artifact.");

    const archiveListed = requireCompletedToolSuccess(
      "archive_manage",
      await runtime.executeManualTool(
        "archive_manage",
        { action: "list", archivePath: "artifacts/production.zip" },
        sessionId,
      ),
    );
    const archiveCapabilities = asRecord(archiveListed.capabilities, "archive_manage capabilities");
    assertCondition(Array.isArray(archiveListed.entries), "archive_manage list did not return bounded entries.");
    assertCondition(
      archiveListed.entries.some((entry) =>
        Boolean(entry) && typeof entry === "object" &&
        (entry as Record<string, unknown>).path === "archive-input/unicode-文件.txt"),
      "yauzl did not list the generated Unicode ZIP entry.",
    );
    assertCondition(
      archiveCapabilities.externalProgramsInvoked === false,
      "archive_manage reported an external-program fallback.",
    );

    const archiveExtracted = requireCompletedToolSuccess(
      "archive_manage",
      await runtime.executeManualTool(
        "archive_manage",
        {
          action: "extract",
          archivePath: "artifacts/production.zip",
          outputDirectory: "artifacts/extracted",
        },
        sessionId,
      ),
    );
    assertCondition(
      typeof archiveExtracted.entriesExtracted === "number" && archiveExtracted.entriesExtracted >= 1,
      "yauzl did not extract the generated ZIP entry.",
    );
    assertCondition(
      await fs.readFile(path.join(workspaceRoot, "artifacts", "extracted", "archive-input", "unicode-文件.txt"), "utf8") ===
        "bounded archive payload",
      "archive_manage extracted unexpected content.",
    );

    const conversion = requireCompletedToolSuccess(
      "convert_document",
      await runtime.executeManualTool(
        "convert_document",
        {
          inputPath: "artifacts/production.xlsx",
          outputPath: "artifacts/production.csv",
          sourceFormat: "xlsx",
          targetFormat: "csv",
          sheet: "Data",
        },
        sessionId,
      ),
    );
    const conversionCapabilities = asRecord(conversion.capabilities, "convert_document capabilities");
    assertCondition(
      conversionCapabilities.externalPrograms === false,
      "convert_document reported an external-program fallback.",
    );
    assertCondition(
      (await fs.readFile(path.join(workspaceRoot, "artifacts", "production.csv"), "utf8")).includes("alpha"),
      "convert_document did not preserve the representative table value.",
    );

    const baselineSentinel = "Deep-Mix Phase 14 production round trip";
    const baselineDocument = {
      title: "Phase 14 production baseline",
      metadata: { author: "Deep-Mix", subject: "Production bundle regression" },
      page: { size: "A4", orientation: "portrait" },
      blocks: [
        { type: "heading", level: 1, text: "Production baseline" },
        { type: "paragraph", text: baselineSentinel },
        { type: "bullet_list", items: ["Tool Registry", "Tool Runtime"] },
        { type: "table", headers: ["format", "status"], rows: [["baseline", "available"]] },
      ],
    };

    const pdfWritten = requireCompletedToolSuccess(
      "write_pdf",
      await runtime.executeManualTool(
        "write_pdf",
        { outputPath: "artifacts/phase14-production.pdf", document: baselineDocument },
        sessionId,
      ),
    );
    assertCondition(
      pdfWritten.format === "pdf" && typeof pdfWritten.pageCount === "number" && pdfWritten.pageCount >= 1,
      "write_pdf did not publish a readable production PDF.",
    );
    const pdfRead = requireCompletedToolSuccess(
      "read_pdf",
      await runtime.executeManualTool(
        "read_pdf",
        { path: "artifacts/phase14-production.pdf", maxChars: 20_000 },
        sessionId,
      ),
    );
    assertCondition(
      pdfRead.format === "pdf" && JSON.stringify(pdfRead).includes(baselineSentinel),
      "read_pdf did not recover the production round-trip sentinel.",
    );

    const docxWritten = requireCompletedToolSuccess(
      "write_docx",
      await runtime.executeManualTool(
        "write_docx",
        { outputPath: "artifacts/phase14-production.docx", document: baselineDocument },
        sessionId,
      ),
    );
    assertCondition(docxWritten.format === "docx", "write_docx did not publish production DOCX output.");
    const docxRead = requireCompletedToolSuccess(
      "read_docx",
      await runtime.executeManualTool(
        "read_docx",
        { path: "artifacts/phase14-production.docx", maxChars: 20_000 },
        sessionId,
      ),
    );
    assertCondition(
      docxRead.format === "docx" && JSON.stringify(docxRead).includes(baselineSentinel),
      "read_docx did not recover the production round-trip sentinel.",
    );

    const incompletePhase20Operations = PHASE20_TOOL_NAMES.filter((name) => !completedOperations.has(name));
    const incompleteBaselineOperations = PHASE14_BASELINE_TOOL_NAMES.filter((name) => !completedOperations.has(name));
    assertCondition(
      incompletePhase20Operations.length === 0,
      `Phase 20 production operations did not complete: ${incompletePhase20Operations.join(", ")}`,
    );
    assertCondition(
      incompleteBaselineOperations.length === 0,
      `Phase 14 baseline production operations did not complete: ${incompleteBaselineOperations.join(", ")}`,
    );
    const toolOperations = Object.fromEntries(
      PHASE20_TOOL_NAMES.map((name) => [name, completedOperations.has(name) ? "passed" : "failed"]),
    ) as Record<Phase20ToolName, "passed">;
    const baselineOperations = Object.fromEntries(
      PHASE14_BASELINE_TOOL_NAMES.map((name) => [name, completedOperations.has(name) ? "passed" : "failed"]),
    ) as Record<Phase14BaselineToolName, "passed">;

    const imageProperties = asRecord(imageMetadata.properties, "read_image metadata properties");
    const officeAutomation = conversionCapabilities.officeAutomation !== false;
    const externalConverters = conversionCapabilities.externalPrograms !== false ||
      archiveCapabilities.externalProgramsInvoked !== false;
    const notebookExecution = !notebookCodeSentinelAbsentAfterRead || !notebookCodeSentinelAbsentAfterEdit;
    const imageOcrOrSemanticAnalysis = imageProperties.ocrPerformed !== false ||
      imageProperties.semanticAnalysisPerformed !== false || visionWorkerHint.automaticInvocation !== false;
    assertCondition(!officeAutomation, "Production conversion evidence reported Office automation.");
    assertCondition(!externalConverters, "Production structured-document evidence reported an external converter.");
    assertCondition(!notebookExecution, "Production notebook code-cell sentinel was executed.");
    assertCondition(!imageOcrOrSemanticAnalysis, "Production image evidence reported OCR or semantic analysis.");

    return {
      runtime: `Electron ${process.versions.electron ?? "unknown"} / Node ${process.versions.node}`,
      bundledMainEntry: __filename,
      registeredTools: [...PHASE20_TOOL_NAMES],
      availableTools: [...PHASE20_TOOL_NAMES],
      baselineRegisteredTools: [...PHASE14_BASELINE_TOOL_NAMES],
      baselineAvailableTools: [...PHASE14_BASELINE_TOOL_NAMES],
      dependencyOperations: {
        exceljsAndJszip: "xlsx_write_read",
        pptxgenjsAndJszip: "pptx_write_read",
        sharp: "image_metadata_and_preview",
        yauzl: "zip_list_and_extract",
        jszip: "zip_create",
      },
      toolOperations,
      baselineOperations,
      boundaries: {
        officeAutomation,
        externalConverters,
        notebookExecution,
        imageOcrOrSemanticAnalysis,
      },
      boundaryEvidence: {
        conversionCapabilitiesChecked: conversionCapabilities.officeAutomation === false &&
          conversionCapabilities.externalPrograms === false,
        archiveCapabilitiesChecked: archiveCapabilities.externalProgramsInvoked === false,
        notebookCodeSentinelAbsentAfterRead,
        notebookCodeSentinelAbsentAfterEdit,
        imageTechnicalFlagsChecked: imageProperties.ocrPerformed === false &&
          imageProperties.semanticAnalysisPerformed === false && visionWorkerHint.automaticInvocation === false,
      },
    };
  } finally {
    await runtime?.dispose();
    await removeProbeWorkspace(workspaceRoot);
  }
}
