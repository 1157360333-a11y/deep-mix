import type { ToolModule } from "../../tool-module.js";
import { readDocxTool } from "./read-docx.js";
import { readPdfTool } from "./read-pdf.js";
import { writePdfTool } from "./write-pdf.js";
import { writeDocxTool } from "./write-docx.js";

export const documentsToolModule: ToolModule = {
  manifest: {
    id: "builtin.documents",
    version: "1.0.0",
    description: "Bounded PDF and DOCX document tools.",
    source: "built_in",
  },
  create: () => [readPdfTool, readDocxTool, writePdfTool, writeDocxTool],
};

export { readDocxTool } from "./read-docx.js";
export { readPdfTool } from "./read-pdf.js";
export { writePdfTool } from "./write-pdf.js";
export { writeDocxTool } from "./write-docx.js";
export * from "./contracts.js";
