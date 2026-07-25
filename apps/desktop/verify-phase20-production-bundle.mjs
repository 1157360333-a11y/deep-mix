import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const desktopRoot = path.dirname(scriptPath);
const mainEntry = path.join(desktopRoot, "out", "main", "index.js");
const desktopRequire = createRequire(path.join(desktopRoot, "package.json"));
const marker = "DEEP_MIX_PHASE20_PRODUCTION_PROBE=";
const expectedTools = [
  "read_spreadsheet",
  "write_spreadsheet",
  "read_presentation",
  "write_presentation",
  "read_notebook",
  "edit_notebook",
  "read_image",
  "archive_manage",
  "convert_document",
];
const expectedBaselineTools = ["read_pdf", "write_pdf", "read_docx", "write_docx"];

await fs.access(mainEntry);
const mainBundle = await fs.readFile(mainEntry, "utf8");
assert.match(
  mainBundle,
  /DEEP_MIX_PHASE20_PRODUCTION_PROBE=/u,
  "Desktop production main bundle does not contain the controlled Phase 20 probe entry.",
);

const electronExecutable = desktopRequire("electron");
const environment = {
  ...process.env,
  DEEP_MIX_PHASE20_PRODUCTION_PROBE: "1",
  ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  NODE_ENV: "production",
};
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawnSync(
  electronExecutable,
  ["--disable-gpu", "--headless", "--no-sandbox", desktopRoot],
  {
    cwd: desktopRoot,
    env: environment,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  },
);

if (child.error) throw child.error;
if (child.status !== 0) {
  throw new Error(
    `Phase 20 production Electron probe exited with status ${String(child.status)}.\n` +
      `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
  );
}

const markerLine = child.stdout
  .split(/\r?\n/gu)
  .find((line) => line.startsWith(marker));
assert.ok(
  markerLine,
  `Phase 20 production Electron probe did not emit its report.\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
);

const report = JSON.parse(markerLine.slice(marker.length));
assert.match(report.runtime, /^Electron \d+/u, "Probe did not run in the real Electron runtime.");
assert.equal(
  path.resolve(report.bundledMainEntry),
  path.resolve(mainEntry),
  "Probe did not execute from the built Desktop main entry.",
);
assert.deepEqual(report.registeredTools, expectedTools, "Production Tool Registry is missing Phase 20 tools.");
assert.deepEqual(report.availableTools, expectedTools, "One or more Phase 20 production capabilities are unavailable.");
assert.deepEqual(
  report.baselineRegisteredTools,
  expectedBaselineTools,
  "Production Tool Registry is missing a Phase 14 PDF/DOCX baseline tool.",
);
assert.deepEqual(
  report.baselineAvailableTools,
  expectedBaselineTools,
  "A Phase 14 PDF/DOCX baseline capability is unavailable in the production bundle.",
);
assert.deepEqual(report.dependencyOperations, {
  exceljsAndJszip: "xlsx_write_read",
  pptxgenjsAndJszip: "pptx_write_read",
  sharp: "image_metadata_and_preview",
  yauzl: "zip_list_and_extract",
  jszip: "zip_create",
});
assert.deepEqual(
  report.toolOperations,
  Object.fromEntries(expectedTools.map((name) => [name, "passed"])),
  "Not every Phase 20 tool completed a representative production operation.",
);
assert.deepEqual(
  report.baselineOperations,
  Object.fromEntries(expectedBaselineTools.map((name) => [name, "passed"])),
  "The Phase 14 PDF/DOCX write/read production round trips did not all complete.",
);
assert.deepEqual(report.boundaries, {
  officeAutomation: false,
  externalConverters: false,
  notebookExecution: false,
  imageOcrOrSemanticAnalysis: false,
});
assert.deepEqual(report.boundaryEvidence, {
  conversionCapabilitiesChecked: true,
  archiveCapabilitiesChecked: true,
  notebookCodeSentinelAbsentAfterRead: true,
  notebookCodeSentinelAbsentAfterEdit: true,
  imageTechnicalFlagsChecked: true,
});

process.stdout.write(`${JSON.stringify({
  runtime: report.runtime,
  mainEntry: path.relative(desktopRoot, mainEntry).replace(/\\/gu, "/"),
  registeredTools: report.registeredTools.length,
  availableTools: report.availableTools.length,
  baselineRegisteredTools: report.baselineRegisteredTools.length,
  baselineAvailableTools: report.baselineAvailableTools.length,
  baselineOperations: report.baselineOperations,
  dependencyOperations: report.dependencyOperations,
  boundaries: report.boundaries,
  boundaryEvidence: report.boundaryEvidence,
})}\n`);
