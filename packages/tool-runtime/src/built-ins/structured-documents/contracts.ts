import type {
  StructuredDocumentWarning,
  StructuredJsonValue,
} from "../../../../shared-schema/src/index.js";

export const STRUCTURED_WARNING_MESSAGES = {
  output_truncated: "The result was paginated or truncated to the declared output budget.",
  formula_not_calculated: "Formula text was preserved, but no formula engine was invoked.",
  formula_cache_missing: "A formula has no cached value and remains uncalculated.",
  formula_like_text: "A text value begins like a spreadsheet formula and was kept as text.",
  csv_formula_escaped: "A formula-like CSV or TSV text value was escaped to prevent formula injection.",
  macro_present: "Macro content is present but was not executed or preserved by a writer.",
  external_link_present: "An external link or data connection is present and was not followed.",
  hidden_sheet_present: "The workbook contains a hidden or very hidden sheet.",
  abnormal_merge: "The workbook contains a merged region outside the basic compatibility boundary.",
  unsupported_presentation_feature: "The presentation contains a feature outside the basic Phase 20 fidelity boundary.",
  metadata_redacted: "Potentially sensitive metadata was redacted from model-visible output.",
  notebook_output_artifact: "A large notebook output was returned as an artifact instead of inline content.",
  image_gps_redacted: "GPS-related image metadata was not exposed.",
  image_preview_skipped: "A preview was skipped because the image exceeded the safe decode budget.",
  archive_unsafe_entry: "The archive contains an entry that is unsafe to extract.",
  archive_encrypted: "The archive contains encrypted content; password handling is unsupported.",
  archive_budget_exceeded: "The archive exceeds a declared entry, size, or compression-ratio budget.",
  conversion_fidelity_loss: "The allowlisted conversion cannot preserve every source capability.",
  unsupported_capability: "The requested or detected capability is outside the Phase 20 support boundary.",
} as const;

export type StructuredWarningCode = keyof typeof STRUCTURED_WARNING_MESSAGES;

export function structuredWarning(
  code: StructuredWarningCode,
  options: Partial<Omit<StructuredDocumentWarning, "code" | "message">> & { message?: string } = {},
): StructuredDocumentWarning {
  return {
    code,
    message: options.message ?? STRUCTURED_WARNING_MESSAGES[code],
    severity: options.severity ?? "warning",
    category: options.category ?? "content",
    scope: options.scope,
    details: options.details,
  };
}

export function jsonSafeRecord(value: unknown): Record<string, StructuredJsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, StructuredJsonValue>;
}

export const structuredMetadataSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", maxLength: 2_000 },
    author: { type: "string", maxLength: 1_000 },
    subject: { type: "string", maxLength: 2_000 },
    keywords: { type: "array", maxItems: 100, items: { type: "string", maxLength: 500 } },
    createdAt: { type: "string", maxLength: 100 },
    modifiedAt: { type: "string", maxLength: 100 },
    language: { type: "string", maxLength: 100 },
    formatVersion: { type: "string", maxLength: 100 },
    creatorApplication: { type: "string", maxLength: 200 },
    sizeBytes: { type: "integer", minimum: 0 },
    properties: { type: "object", maxProperties: 1_000, additionalProperties: true },
  },
} as const;

export const tableFormulaSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expression", "calculationState"],
  properties: {
    expression: { type: "string", minLength: 1, maxLength: 100_000, pattern: "^[^=]" },
    cachedValue: { type: ["string", "number", "boolean", "null"], maxLength: 100_000 },
    cachedType: { type: "string", enum: ["blank", "string", "number", "boolean", "date", "error"] },
    calculationState: { type: "string", enum: ["cached", "missing", "stale", "unknown"] },
  },
} as const;

export const tableCellSchema = {
  type: "object",
  additionalProperties: false,
  required: ["row", "column", "type"],
  properties: {
    row: { type: "integer", minimum: 1, maximum: 100_000 },
    column: { type: "integer", minimum: 1, maximum: 4_096 },
    address: { type: "string", maxLength: 32 },
    type: { type: "string", enum: ["blank", "string", "number", "boolean", "date", "error", "formula"] },
    value: { type: ["string", "number", "boolean", "null"], maxLength: 100_000 },
    displayValue: { type: "string", maxLength: 100_000 },
    formula: tableFormulaSchema,
  },
} as const;

export const tableDocumentSpecSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sheets"],
  properties: {
    title: { type: "string", maxLength: 2_000 },
    metadata: structuredMetadataSchema,
    activeSheet: { type: "string", maxLength: 255 },
    sheets: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "cells"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 31 },
          state: { type: "string", enum: ["visible", "hidden", "very_hidden"] },
          headers: {
            type: "array",
            maxItems: 4_096,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["column", "label"],
              properties: {
                column: { type: "integer", minimum: 1, maximum: 4_096 },
                label: { type: "string", maxLength: 100_000 },
                sourceRow: { type: "integer", minimum: 1, maximum: 100_000 },
              },
            },
          },
          cells: { type: "array", maxItems: 1_000_000, items: tableCellSchema },
          rowCount: { type: "integer", minimum: 0, maximum: 100_000 },
          columnCount: { type: "integer", minimum: 0, maximum: 4_096 },
          mergedRanges: { type: "array", maxItems: 10_000, items: { type: "string", maxLength: 64 } },
          columns: {
            type: "array",
            maxItems: 4_096,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["column"],
              properties: {
                column: { type: "integer", minimum: 1, maximum: 4_096 },
                width: { type: "number", exclusiveMinimum: 0, maximum: 255 },
                hidden: { type: "boolean" },
              },
            },
          },
          freezeHeaderRow: { type: "boolean" },
        },
      },
    },
  },
} as const;

const boundsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y", "width", "height"],
  properties: {
    x: { type: "number", minimum: 0, maximum: 100 },
    y: { type: "number", minimum: 0, maximum: 100 },
    width: { type: "number", exclusiveMinimum: 0, maximum: 100 },
    height: { type: "number", exclusiveMinimum: 0, maximum: 100 },
  },
} as const;

const textStyleSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    fontFace: { type: "string", maxLength: 200 },
    fontSize: { type: "number", minimum: 1, maximum: 400 },
    bold: { type: "boolean" },
    italic: { type: "boolean" },
    color: { type: "string", pattern: "^[0-9A-Fa-f]{6}$" },
    align: { type: "string", enum: ["left", "center", "right"] },
  },
} as const;

export const presentationSpecSchema = {
  type: "object",
  additionalProperties: false,
  required: ["slides"],
  properties: {
    title: { type: "string", maxLength: 2_000 },
    metadata: structuredMetadataSchema,
    layout: {
      type: "object",
      additionalProperties: false,
      required: ["width", "height"],
      properties: {
        width: { type: "number", minimum: 1, maximum: 100 },
        height: { type: "number", minimum: 1, maximum: 100 },
      },
    },
    slides: {
      type: "array",
      minItems: 1,
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["elements"],
        properties: {
          id: { type: "string", maxLength: 255 },
          title: { type: "string", maxLength: 20_000 },
          layoutName: { type: "string", maxLength: 255 },
          backgroundColor: { type: "string", pattern: "^[0-9A-Fa-f]{6}$" },
          speakerNotes: { type: "array", maxItems: 1_000, items: { type: "string", maxLength: 100_000 } },
          elements: {
            type: "array",
            maxItems: 20_000,
            items: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["type", "text"],
                  properties: {
                    type: { type: "string", enum: ["title", "text"] },
                    text: { type: "string", maxLength: 100_000 },
                    bounds: boundsSchema,
                    style: textStyleSchema,
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["type", "items"],
                  properties: {
                    type: { const: "list" },
                    items: { type: "array", maxItems: 1_000, items: { type: "string", maxLength: 10_000 } },
                    ordered: { type: "boolean" },
                    bounds: boundsSchema,
                    style: textStyleSchema,
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["type", "source"],
                  properties: {
                    type: { const: "image" },
                    source: { type: "string", minLength: 1, maxLength: 4_096 },
                    alt: { type: "string", maxLength: 2_000 },
                    bounds: boundsSchema,
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["type", "rows"],
                  properties: {
                    type: { const: "table" },
                    headers: { type: "array", maxItems: 100, items: { type: "string", maxLength: 10_000 } },
                    rows: {
                      type: "array",
                      maxItems: 1_000,
                      items: { type: "array", maxItems: 100, items: { type: ["string", "number", "boolean", "null"], maxLength: 10_000 } },
                    },
                    bounds: boundsSchema,
                  },
                },
              ],
            },
          },
        },
      },
    },
  },
} as const;

const notebookMetadataSchema = {
  type: "object",
  maxProperties: 2_000,
  additionalProperties: true,
} as const;

const notebookOutputSchema = {
  type: "object",
  maxProperties: 12,
  additionalProperties: true,
  required: ["outputType"],
  properties: {
    outputType: { type: "string", enum: ["stream", "display_data", "execute_result", "error"] },
  },
} as const;

export const notebookCellSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cellType", "source", "metadata"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 255 },
    cellType: { type: "string", enum: ["markdown", "code", "raw"] },
    source: { type: "string", maxLength: 2_000_000 },
    metadata: notebookMetadataSchema,
    executionCount: { type: ["integer", "null"], minimum: 0 },
    outputs: { type: "array", maxItems: 10_000, items: notebookOutputSchema },
  },
} as const;

export const notebookSpecSchema = {
  type: "object",
  additionalProperties: false,
  required: ["nbformat", "nbformatMinor", "metadata", "cells"],
  properties: {
    nbformat: { const: 4 },
    nbformatMinor: { type: "integer", minimum: 0, maximum: 99 },
    metadata: notebookMetadataSchema,
    cells: { type: "array", maxItems: 10_000, items: notebookCellSchema },
  },
} as const;

export const pathPropertySchema = { type: "string", minLength: 1, maxLength: 4_096 } as const;
export const cursorPropertySchema = { type: "string", minLength: 1, maxLength: 256 } as const;

export function parseNonNegativeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(0|[1-9]\d*)$/u.test(cursor)) throw new Error("Cursor must be a non-negative decimal offset.");
  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed)) throw new Error("Cursor exceeds the safe integer range.");
  return parsed;
}
