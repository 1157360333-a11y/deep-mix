import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const desktopRoot = path.dirname(scriptPath);
const workspaceRoot = path.resolve(desktopRoot, "../..");
const mainOutputDirectory = path.join(desktopRoot, "out/main");
const desktopRequire = createRequire(path.join(desktopRoot, "package.json"));
const toolRuntimeRequire = createRequire(path.join(workspaceRoot, "packages/tool-runtime/package.json"));

async function verifyProductionPdfBundle() {
  const outputFiles = await fs.readdir(mainOutputDirectory);
  const pdfChunks = outputFiles.filter((fileName) => /^pdf-[^.]+\.js$/u.test(fileName));
  const workerChunks = outputFiles.filter((fileName) => /^pdf\.worker-[^.]+\.js$/u.test(fileName));

  assert.equal(pdfChunks.length, 1, `Expected one production PDF.js chunk, found: ${pdfChunks.join(", ")}`);
  assert.equal(workerChunks.length, 1, `Expected one production PDF.js worker chunk, found: ${workerChunks.join(", ")}`);

  const [pdfChunk] = pdfChunks;
  const [workerChunk] = workerChunks;
  const mainBundle = await fs.readFile(path.join(mainOutputDirectory, "index.js"), "utf8");
  const requireIndex = (chunk) => {
    const indexes = [
      mainBundle.indexOf(`require("./${chunk}")`),
      mainBundle.indexOf(`require('./${chunk}')`),
    ].filter((index) => index >= 0);
    return indexes.length > 0 ? Math.min(...indexes) : -1;
  };
  const workerImportIndex = requireIndex(workerChunk);
  const pdfImportIndex = requireIndex(pdfChunk);

  assert.ok(workerImportIndex >= 0, `Desktop main bundle does not load ${workerChunk}.`);
  assert.ok(pdfImportIndex >= 0, `Desktop main bundle does not load ${pdfChunk}.`);
  assert.ok(workerImportIndex < pdfImportIndex, "Desktop main bundle must initialize the PDF.js worker before PDF.js.");

  const productionRequire = createRequire(path.join(mainOutputDirectory, "index.js"));
  productionRequire(`./${workerChunk}`);
  assert.equal(
    typeof globalThis.pdfjsWorker?.WorkerMessageHandler,
    "function",
    "The production worker chunk did not register WorkerMessageHandler.",
  );
  const pdfjs = productionRequire(`./${pdfChunk}`);
  assert.equal(typeof pdfjs.getDocument, "function", "The production PDF.js chunk does not expose getDocument().");

  const externalPdfPath = process.env.DEEP_MIX_PDF_SMOKE_PATH?.trim();
  let bytes;
  if (externalPdfPath) {
    bytes = await fs.readFile(externalPdfPath);
  } else {
    const { PDFDocument, StandardFonts } = toolRuntimeRequire("pdf-lib");
    const source = await PDFDocument.create();
    const page = source.addPage([320, 240]);
    const font = await source.embedFont(StandardFonts.Helvetica);
    page.drawText("Deep-Mix production PDF bundle", { x: 24, y: 180, size: 18, font });
    bytes = await source.save();
  }

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    stopAtErrors: true,
    useWasm: false,
    isEvalSupported: false,
    verbosity: 0,
  });
  let document;
  try {
    document = await loadingTask.promise;
    if (externalPdfPath) assert.ok(document.numPages > 0, "The external smoke PDF returned no pages.");
    else assert.equal(document.numPages, 1, "Production PDF.js bundle returned an unexpected page count.");
    const firstPage = await document.getPage(1);
    try {
      const textContent = await firstPage.getTextContent();
      const extractedText = textContent.items
        .map((item) => typeof item.str === "string" ? item.str : "")
        .join(" ");
      if (externalPdfPath) assert.ok(extractedText.trim().length > 0, "The external smoke PDF yielded no text.");
      else assert.match(extractedText, /Deep-Mix production PDF bundle/u);
    } finally {
      firstPage.cleanup();
    }
  } finally {
    if (document) await document.destroy();
    else await loadingTask.destroy();
  }

  process.stdout.write(`${JSON.stringify({
    runtime: `Electron ${process.versions.electron} / Node ${process.versions.node}`,
    pdfChunk,
    workerChunk,
    input: externalPdfPath ? "external" : "generated",
    extracted: true,
  })}\n`);
}

if (process.versions.electron) {
  await verifyProductionPdfBundle();
} else {
  const electronExecutable = desktopRequire("electron");
  const result = spawnSync(electronExecutable, [scriptPath], {
    cwd: desktopRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
