import type { DocumentSpec } from "../../../../shared-schema/src/index.js";

export const DEFAULT_DOCUMENT_MAX_CHARS = 2_000_000;
export const MAX_DOCUMENT_MAX_CHARS = 2_000_000;

const stringArraySchema = {
  type: "array",
  items: { type: "string", maxLength: 10_000 },
  maxItems: 1_000,
} as const;

const documentMetadataSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", maxLength: 2_000 },
    author: { type: "string", maxLength: 1_000 },
    subject: { type: "string", maxLength: 2_000 },
    keywords: { type: "array", items: { type: "string", maxLength: 500 }, maxItems: 100 },
    createdAt: { type: "string", maxLength: 100 },
    modifiedAt: { type: "string", maxLength: 100 },
    language: { type: "string", maxLength: 100 },
  },
} as const;

export const documentSpecSchema = {
  type: "object",
  additionalProperties: false,
  required: ["blocks"],
  properties: {
    title: { type: "string", maxLength: 2_000 },
    metadata: documentMetadataSchema,
    page: {
      type: "object",
      additionalProperties: false,
      properties: {
        size: { type: "string", enum: ["A4", "Letter"] },
        orientation: { type: "string", enum: ["portrait", "landscape"] },
        margins: {
          type: "object",
          additionalProperties: false,
          properties: {
            top: { type: "number", minimum: 0, maximum: 288 },
            right: { type: "number", minimum: 0, maximum: 288 },
            bottom: { type: "number", minimum: 0, maximum: 288 },
            left: { type: "number", minimum: 0, maximum: 288 },
          },
        },
      },
    },
    blocks: {
      type: "array",
      maxItems: 2_000,
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "text"],
            properties: {
              type: { const: "paragraph" },
              text: { type: "string", maxLength: 100_000 },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "level", "text"],
            properties: {
              type: { const: "heading" },
              level: { type: "integer", enum: [1, 2, 3] },
              text: { type: "string", maxLength: 20_000 },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "items"],
            properties: {
              type: { type: "string", enum: ["bullet_list", "numbered_list"] },
              items: stringArraySchema,
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "rows"],
            properties: {
              type: { const: "table" },
              headers: { type: "array", items: { type: "string", maxLength: 10_000 }, maxItems: 100 },
              rows: {
                type: "array",
                maxItems: 1_000,
                items: {
                  type: "array",
                  items: { type: "string", maxLength: 10_000 },
                  maxItems: 100,
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type"],
            properties: { type: { const: "page_break" } },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "source"],
            properties: {
              type: { const: "image" },
              source: { type: "string", minLength: 1, maxLength: 4_096 },
              alt: { type: "string", maxLength: 2_000 },
              width: { type: "number", exclusiveMinimum: 0, maximum: 5_000 },
              height: { type: "number", exclusiveMinimum: 0, maximum: 5_000 },
            },
          },
        ],
      },
    },
  },
} as const;

export const documentReadBaseProperties = {
  path: { type: "string", minLength: 1, maxLength: 4_096 },
  maxChars: {
    type: "integer",
    minimum: 1,
    maximum: MAX_DOCUMENT_MAX_CHARS,
    default: DEFAULT_DOCUMENT_MAX_CHARS,
  },
} as const;

export const documentWriteInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outputPath", "document"],
  properties: {
    outputPath: { type: "string", minLength: 1, maxLength: 4_096 },
    overwrite: { type: "boolean" },
    document: documentSpecSchema,
  },
} as const;

export interface ReadDocumentArgs {
  path: string;
  maxChars?: number;
}

export interface ReadPdfArgs extends ReadDocumentArgs {
  pageRange?: {
    start: number;
    end?: number;
  };
}

export interface WriteDocumentArgs {
  outputPath: string;
  overwrite?: boolean;
  document: DocumentSpec;
}

export function resolveDocumentMaxChars(value: number | undefined): number {
  return value ?? DEFAULT_DOCUMENT_MAX_CHARS;
}

export function listDocumentImageSources(document: DocumentSpec): string[] {
  return document.blocks
    .filter((block): block is Extract<DocumentSpec["blocks"][number], { type: "image" }> => block.type === "image")
    .map((block) => block.source);
}
