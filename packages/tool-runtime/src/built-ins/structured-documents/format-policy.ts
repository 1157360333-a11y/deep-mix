/**
 * Frozen Phase 20 format, dependency, conversion, and resource policy.
 *
 * This file is intentionally declarative. Format modules must enforce these
 * ceilings before returning model-visible content or publishing artifacts.
 */

export type Phase20Format =
  | "xlsx"
  | "csv"
  | "tsv"
  | "pptx"
  | "ipynb"
  | "png"
  | "jpeg"
  | "webp"
  | "gif"
  | "tiff"
  | "zip"
  | "tar"
  | "gzip";

export type Phase20Operation = "read" | "write" | "list" | "create" | "extract" | "convert";

export interface Phase20FormatCapability {
  format: Phase20Format;
  extensions: string[];
  mimeTypes: string[];
  operations: Phase20Operation[];
  dependencies: string[];
  conversionTargets: Phase20Format[];
  unsupported: string[];
  status: "supported" | "unsupported";
  notes?: string[];
}

export interface Phase20DependencyPolicy {
  name: string;
  version: string;
  license: string;
  runtime: "built_in" | "pure_js" | "node_api_native";
  installedPackageBytes: number;
  platformPayload?: {
    package: string;
    installedBytes: number;
    license: string;
  };
  platforms: string[];
  fallback: string;
  productionRequirement: string;
  licenseReviewNotes?: string[];
  securityReviewNotes?: string[];
}

const MiB = 1024 * 1024;

export const FROZEN_PHASE14_DOCUMENT_BASELINE = {
  tools: ["read_pdf", "read_docx", "write_pdf", "write_docx"],
  contracts: ["DocumentSpec", "DocumentReadResult", "ToolOutputArtifact"],
  maxVisibleChars: 2_000_000,
  requiredRegression: "npm run verify:phase14",
} as const;

export const PHASE20_LIMITS = {
  maxModelVisibleChars: 2_000_000,
  maxArtifactBytes: 128 * MiB,
  spreadsheet: {
    maxInputBytes: 64 * MiB,
    maxOutputBytes: 64 * MiB,
    maxSheets: 64,
    maxRowsPerSheet: 100_000,
    maxColumnsPerSheet: 4_096,
    maxWorkbookCells: 1_000_000,
    defaultPageCells: 2_000,
    maxPageCells: 10_000,
    maxCellChars: 100_000,
    maxMergedRanges: 10_000,
    maxPackageEntries: 10_000,
    maxPackageEntryBytes: 32 * MiB,
    maxPackageExpandedBytes: 128 * MiB,
    maxPackageCompressionRatio: 100,
    maxInspectedXmlBytes: 8 * MiB,
  },
  presentation: {
    maxInputBytes: 64 * MiB,
    maxOutputBytes: 128 * MiB,
    maxSlides: 500,
    maxElements: 20_000,
    maxTableCells: 100_000,
    maxImages: 2_000,
    maxTextChars: 2_000_000,
  },
  notebook: {
    maxInputBytes: 32 * MiB,
    maxOutputBytes: 64 * MiB,
    maxCells: 10_000,
    defaultPageCells: 200,
    maxPageCells: 500,
    maxSourceChars: 2_000_000,
    maxVisibleOutputChars: 2_000_000,
    maxSingleOutputArtifactBytes: 64 * MiB,
  },
  image: {
    maxInputBytes: 64 * MiB,
    maxPixels: 100_000_000,
    maxFrames: 500,
    defaultPreviewEdge: 1_024,
    maxPreviewEdge: 2_048,
    maxPreviewBytes: 8 * MiB,
  },
  archive: {
    maxInputBytes: 128 * MiB,
    maxOutputBytes: 128 * MiB,
    maxEntries: 10_000,
    maxSingleEntryBytes: 256 * MiB,
    maxCreateSourceBytes: 64 * MiB,
    maxExpandedBytes: 512 * MiB,
    maxCompressionRatio: 100,
    maxEntryNameChars: 4_096,
  },
  conversion: {
    maxInputBytes: 64 * MiB,
    maxOutputBytes: 128 * MiB,
  },
} as const;

export const PHASE20_DEPENDENCY_POLICY: readonly Phase20DependencyPolicy[] = [
  {
    name: "exceljs",
    version: "4.4.0",
    license: "MIT",
    runtime: "pure_js",
    installedPackageBytes: 21_949_480,
    platforms: ["Windows", "macOS", "Linux", "Electron/Node"],
    fallback: "XLSX tools report missing_dependency; CSV and TSV remain available.",
    productionRequirement: "Import and read/write smoke must pass inside the built Desktop main bundle.",
    licenseReviewNotes: [
      "The installed ExcelJS dependency closure includes buffers@0.1.1 without a declared package license or LICENSE file; distribution requires explicit legal/notice review.",
    ],
    securityReviewNotes: [
      "npm audit reports GHSA-w5hq-g745-h8pq through ExcelJS's uuid@8.3.2 dependency. The installed ExcelJS code imports only uuid.v4() without a caller-provided buffer, while the advisory concerns caller-supplied buffers for UUID v3/v5/v6, so the affected API is not exposed by the Phase 20 path.",
      "The offered npm audit --force remediation downgrades ExcelJS across a breaking major boundary and is not applied silently; re-evaluate a supported uuid upgrade when ExcelJS publishes one.",
    ],
  },
  {
    name: "pptxgenjs",
    version: "4.0.1",
    license: "MIT",
    runtime: "pure_js",
    installedPackageBytes: 5_127_439,
    platforms: ["Windows", "macOS", "Linux", "Electron/Node"],
    fallback: "write_presentation reports missing_dependency; no PowerPoint automation fallback.",
    productionRequirement:
      "PptxGenJS declares no Node engines range; generation and OOXML validation must pass under the project Desktop Electron 33 / Node 20.18 runtime.",
  },
  {
    name: "jszip",
    version: "3.10.1",
    license: "MIT OR GPL-3.0-or-later (Deep-Mix uses the MIT option)",
    runtime: "pure_js",
    installedPackageBytes: 762_000,
    platforms: ["Windows", "macOS", "Linux", "Electron/Node"],
    fallback: "OOXML and ZIP creation report missing_dependency; no external archive program is invoked.",
    productionRequirement: "ZIP creation and OOXML package smoke must pass in the built Desktop main bundle.",
  },
  {
    name: "yauzl",
    version: "3.4.0",
    license: "MIT",
    runtime: "pure_js",
    installedPackageBytes: 109_901,
    platforms: ["Windows", "macOS", "Linux", "Electron/Node >=12"],
    fallback: "ZIP list and extract report missing_dependency; no external archive program is invoked.",
    productionRequirement:
      "Lazy central-directory listing and bounded entry streaming must pass in the built Desktop main bundle.",
  },
  {
    name: "node-html-parser",
    version: "7.1.0",
    license: "MIT",
    runtime: "pure_js",
    installedPackageBytes: 172_579,
    platforms: ["Windows", "macOS", "Linux", "Electron/Node"],
    fallback: "PPTX semantic extraction reports missing_dependency without dropping unsupported content silently.",
    productionRequirement: "PPTX read smoke must parse slide XML from the built Desktop main bundle.",
  },
  {
    name: "sharp",
    version: "0.35.3",
    license: "Apache-2.0",
    runtime: "node_api_native",
    installedPackageBytes: 958_466,
    platformPayload: {
      package: "@img/sharp-win32-x64@0.35.3",
      installedBytes: 19_199_007,
      license: "Apache-2.0 AND LGPL-3.0-or-later",
    },
    platforms: ["Windows x64/arm64", "macOS", "Linux", "Electron/Node >=20.9"],
    fallback: "read_image reports missing_dependency; it never shells out to ImageMagick or performs OCR.",
    productionRequirement: "The externalized native package and platform binary must load under Desktop Electron.",
  },
  {
    name: "node:json/csv",
    version: "built-in",
    license: "Node.js runtime",
    runtime: "built_in",
    installedPackageBytes: 0,
    platforms: ["Windows", "macOS", "Linux", "Electron/Node"],
    fallback: "No external dependency; malformed input returns a structured format error.",
    productionRequirement: "CSV/TSV and nbformat 4 smoke tests run in the built Desktop bundle.",
  },
] as const;

export const PHASE20_FORMAT_CAPABILITY_MATRIX: readonly Phase20FormatCapability[] = [
  {
    format: "xlsx",
    extensions: [".xlsx"],
    mimeTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    operations: ["read", "write", "convert"],
    dependencies: ["exceljs", "jszip"],
    conversionTargets: ["csv", "tsv"],
    unsupported: ["formula calculation", "macros", "external data refresh", "encrypted workbooks"],
    status: "supported",
    notes: ["Formula text and cached results are returned separately; unknown formulas remain uncalculated."],
  },
  {
    format: "csv",
    extensions: [".csv"],
    mimeTypes: ["text/csv", "application/csv"],
    operations: ["read", "write", "convert"],
    dependencies: ["node:json/csv"],
    conversionTargets: ["tsv", "xlsx"],
    unsupported: ["embedded macros", "formula inference", "multiple sheets"],
    status: "supported",
    notes: ["Ordinary strings beginning with formula sigils are escaped on write."],
  },
  {
    format: "tsv",
    extensions: [".tsv"],
    mimeTypes: ["text/tab-separated-values"],
    operations: ["read", "write", "convert"],
    dependencies: ["node:json/csv"],
    conversionTargets: ["csv", "xlsx"],
    unsupported: ["embedded macros", "formula inference", "multiple sheets"],
    status: "supported",
    notes: ["Ordinary strings beginning with formula sigils are escaped on write."],
  },
  {
    format: "pptx",
    extensions: [".pptx"],
    mimeTypes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    operations: ["read", "write"],
    dependencies: ["pptxgenjs", "jszip", "node-html-parser"],
    conversionTargets: [],
    unsupported: ["animation", "macros", "complex masters", "SmartArt", "pixel-perfect round trip"],
    status: "supported",
  },
  {
    format: "ipynb",
    extensions: [".ipynb"],
    mimeTypes: ["application/x-ipynb+json", "application/json"],
    operations: ["read", "write"],
    dependencies: ["node:json/csv"],
    conversionTargets: [],
    unsupported: ["cell execution", "kernel installation", "remote Jupyter connection"],
    status: "supported",
  },
  ...(["png", "jpeg", "webp", "gif", "tiff"] as const).map((format): Phase20FormatCapability => ({
    format,
    extensions: format === "jpeg" ? [".jpg", ".jpeg"] : [`.${format === "tiff" ? "tif" : format}`, ...(format === "tiff" ? [".tiff"] : [])],
    mimeTypes: [format === "jpeg" ? "image/jpeg" : format === "tiff" ? "image/tiff" : `image/${format}`],
    operations: ["read"],
    dependencies: ["sharp"],
    conversionTargets: [],
    unsupported: ["OCR", "semantic image understanding", "unbounded full-resolution preview"],
    status: "supported",
  })),
  {
    format: "zip",
    extensions: [".zip"],
    mimeTypes: ["application/zip"],
    operations: ["list", "create", "extract"],
    dependencies: ["yauzl", "jszip"],
    conversionTargets: [],
    unsupported: ["encrypted archives", "password decryption", "symlink extraction"],
    status: "supported",
    notes: ["yauzl is used for lazy list/extract preflight; JSZip is limited to bounded ZIP creation."],
  },
  {
    format: "tar",
    extensions: [".tar"],
    mimeTypes: ["application/x-tar"],
    operations: [],
    dependencies: [],
    conversionTargets: [],
    unsupported: ["list", "create", "extract"],
    status: "unsupported",
    notes: ["Deferred until an offline parser passes the same path, link, and expansion-budget tests as ZIP."],
  },
  {
    format: "gzip",
    extensions: [".gz", ".gzip"],
    mimeTypes: ["application/gzip"],
    operations: [],
    dependencies: [],
    conversionTargets: [],
    unsupported: ["list", "create", "extract"],
    status: "unsupported",
    notes: ["Not exposed as an archive container in the Phase 20 allowlist."],
  },
] as const;

export const PHASE20_OFFLINE_CONVERSION_ALLOWLIST = [
  { source: "csv", target: "tsv", fidelity: "structured" },
  { source: "tsv", target: "csv", fidelity: "structured" },
  { source: "csv", target: "xlsx", fidelity: "structured" },
  { source: "tsv", target: "xlsx", fidelity: "structured" },
  { source: "xlsx", target: "csv", fidelity: "lossy_single_sheet" },
  { source: "xlsx", target: "tsv", fidelity: "lossy_single_sheet" },
] as const;
