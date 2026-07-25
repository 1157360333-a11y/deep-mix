import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  PresentationBoundsSpec,
  PresentationElementSpec,
  PresentationReadResult,
  PresentationSpec,
  PresentationTextStyleSpec,
  SlideSpec,
  StructuredDocumentMetadata,
  StructuredDocumentWarning,
  StructuredDocumentWriteResult,
  StructuredSourceReference,
  TableCellScalar,
  ToolAvailability,
  ToolOutputArtifact,
  ToolResult,
  ToolStructuredError,
} from "../../../../shared-schema/src/index.js";
import { ToolArgumentError } from "../../index.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolModule,
  ToolModuleContext,
} from "../../tool-module.js";

import {
  cursorPropertySchema,
  parseNonNegativeCursor,
  pathPropertySchema,
  presentationSpecSchema,
  structuredWarning,
} from "./contracts.js";
import { PHASE20_LIMITS } from "./format-policy.js";

const PPTX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const ZIP_MAGIC_PREFIXES = new Set(["504b0304", "504b0506", "504b0708"]);
const EMU_PER_INCH = 914_400;
const DEFAULT_LAYOUT = { width: 13.333, height: 7.5 };
const DEFAULT_PAGE_SLIDES = 50;
const MAX_PACKAGE_ENTRIES = 20_000;
const MAX_PACKAGE_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_XML_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_RATIO = 100;
const MAX_WARNINGS = 200;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024;

export interface ReadPresentationArgs {
  path: string;
  cursor?: string;
  maxSlides?: number;
}

export interface WritePresentationArgs {
  outputPath: string;
  overwrite?: boolean;
  presentation: PresentationSpec;
}

type PresentationFailureCode =
  | "unsupported_format"
  | "format_mismatch"
  | "presentation_too_large"
  | "presentation_dependency_unavailable"
  | "pptx_invalid_or_damaged"
  | "pptx_unsafe_package"
  | "presentation_content_too_large"
  | "presentation_generation_failed"
  | "image_invalid_or_unsupported"
  | "output_too_large"
  | "presentation_write_failed";

class PresentationError extends Error {
  constructor(
    readonly code: PresentationFailureCode,
    message: string,
    readonly dependency?: string,
  ) {
    super(message);
    this.name = "PresentationError";
  }
}

interface ZipEntryLike {
  dir: boolean;
  name?: string;
  _data?: {
    compressedSize?: number;
    uncompressedSize?: number;
  };
  async(type: "string" | "nodebuffer"): Promise<string | Buffer>;
}

interface ZipArchiveLike {
  files: Record<string, ZipEntryLike>;
  file(name: string): ZipEntryLike | null;
}

interface JsZipApi {
  loadAsync(
    data: Buffer,
    options: { checkCRC32: boolean; createFolders: boolean },
  ): Promise<ZipArchiveLike>;
}

interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

interface SlideWriterLike {
  background: { color?: string };
  addText(text: unknown, options?: Record<string, unknown>): unknown;
  addImage(options: Record<string, unknown>): unknown;
  addTable(rows: Array<Array<string | number | boolean>>, options?: Record<string, unknown>): unknown;
  addNotes(notes: string): unknown;
}

interface PptxWriterLike {
  title: string;
  author: string;
  subject: string;
  company: string;
  layout: string;
  defineLayout(layout: { name: string; width: number; height: number }): void;
  addSlide(): SlideWriterLike;
  write(options: { outputType: "nodebuffer"; compression: boolean }): Promise<unknown>;
}

interface PptxWriterConstructor {
  new (): PptxWriterLike;
}

function moduleDefault<T>(module: unknown): T {
  return ((module as { default?: T }).default ?? module) as T;
}

async function loadJsZip(): Promise<JsZipApi> {
  try {
    return moduleDefault<JsZipApi>(await import("jszip"));
  } catch (error) {
    throw new PresentationError(
      "presentation_dependency_unavailable",
      `PPTX reading requires the bundled JSZip dependency: ${(error as Error).message}`,
      "jszip",
    );
  }
}

async function loadPptxGenJs(): Promise<PptxWriterConstructor> {
  try {
    return moduleDefault<PptxWriterConstructor>(await import("pptxgenjs"));
  } catch (error) {
    throw new PresentationError(
      "presentation_dependency_unavailable",
      `PPTX generation requires the bundled PptxGenJS dependency: ${(error as Error).message}`,
      "pptxgenjs",
    );
  }
}

export async function readPresentationAvailability(_context: ToolModuleContext): Promise<ToolAvailability> {
  try {
    await import("jszip");
    return { status: "available", available: true };
  } catch (error) {
    return {
      status: "unavailable",
      available: false,
      missingCapabilities: ["pptx-read"],
      reason: `PPTX reading is unavailable because JSZip could not be loaded: ${(error as Error).message}`,
    };
  }
}

export async function writePresentationAvailability(_context: ToolModuleContext): Promise<ToolAvailability> {
  try {
    await import("pptxgenjs");
    return { status: "available", available: true };
  } catch (error) {
    return {
      status: "unavailable",
      available: false,
      missingCapabilities: ["pptx-write"],
      reason: `PPTX generation is unavailable because PptxGenJS could not be loaded: ${(error as Error).message}`,
    };
  }
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/gu, "/");
}

function hasZipMagic(buffer: Buffer): boolean {
  return ZIP_MAGIC_PREFIXES.has(buffer.subarray(0, 4).toString("hex"));
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (source, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return "\"";
    if (entity === "apos") return "'";
    const codePoint = entity.toLowerCase().startsWith("#x")
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : source;
  });
}

function attribute(fragment: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')`, "iu").exec(fragment);
  return match ? decodeXml(match[1] ?? match[2] ?? "") : undefined;
}

function elementBlocks(xml: string, localName: string): Array<{ open: string; inner: string; full: string }> {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const expression = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${escaped}\\b([^>]*)>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${escaped}\\s*>`,
    "giu",
  );
  return [...xml.matchAll(expression)].map((match) => ({
    open: match[1] ?? "",
    inner: match[2] ?? "",
    full: match[0],
  }));
}

function openingTags(xml: string, localName: string): string[] {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [...xml.matchAll(new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${escaped}\\b([^>]*)\\/?\\s*>`, "giu"))]
    .map((match) => match[1] ?? "");
}

function textRuns(xml: string): string {
  return elementBlocks(xml, "t").map((entry) => decodeXml(entry.inner)).join("");
}

function paragraphTexts(xml: string): string[] {
  return elementBlocks(xml, "p")
    .map((paragraph) => textRuns(paragraph.inner).trim())
    .filter(Boolean);
}

function parseRelationships(xml: string): Relationship[] {
  return openingTags(xml, "Relationship").map((fragment) => ({
    id: attribute(fragment, "Id") ?? "",
    type: attribute(fragment, "Type") ?? "",
    target: attribute(fragment, "Target") ?? "",
    external: attribute(fragment, "TargetMode")?.toLowerCase() === "external",
  })).filter((relationship) => relationship.id && relationship.type && relationship.target);
}

function isSafePartName(name: string): boolean {
  if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/")) return false;
  const normalized = path.posix.normalize(name);
  return normalized === name && normalized !== ".." && !normalized.startsWith("../");
}

function resolveRelationshipTarget(ownerPart: string, target: string): string {
  const cleaned = target.replace(/\\/gu, "/");
  if (!cleaned || cleaned.startsWith("/") || /^[a-z][a-z\d+.-]*:/iu.test(cleaned)) {
    throw new PresentationError("pptx_unsafe_package", "PPTX contains an unsafe internal relationship target.");
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(ownerPart), cleaned));
  if (!isSafePartName(resolved)) {
    throw new PresentationError("pptx_unsafe_package", "PPTX relationship target escapes the OOXML package.");
  }
  return resolved;
}

function relationshipPart(ownerPart: string): string {
  return path.posix.join(path.posix.dirname(ownerPart), "_rels", `${path.posix.basename(ownerPart)}.rels`);
}

async function readXml(archive: ZipArchiveLike, part: string, required = false): Promise<string | undefined> {
  const entry = archive.file(part);
  if (!entry || entry.dir) {
    if (required) throw new PresentationError("pptx_invalid_or_damaged", `PPTX is missing required package part ${part}.`);
    return undefined;
  }
  const size = entry._data?.uncompressedSize;
  if (size !== undefined && size > MAX_XML_ENTRY_BYTES) {
    throw new PresentationError("pptx_unsafe_package", `PPTX XML part ${part} exceeds the bounded XML size limit.`);
  }
  const value = await entry.async("string");
  const xml = typeof value === "string" ? value : value.toString("utf8");
  if (Buffer.byteLength(xml, "utf8") > MAX_XML_ENTRY_BYTES) {
    throw new PresentationError("pptx_unsafe_package", `PPTX XML part ${part} exceeds the bounded XML size limit.`);
  }
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    throw new PresentationError("pptx_unsafe_package", `PPTX XML part ${part} contains forbidden DTD or entity declarations.`);
  }
  return xml;
}

async function loadValidatedArchive(buffer: Buffer): Promise<ZipArchiveLike> {
  const zip = await loadJsZip();
  let initial: ZipArchiveLike;
  try {
    initial = await zip.loadAsync(buffer, { checkCRC32: false, createFolders: false });
  } catch (error) {
    throw new PresentationError("pptx_invalid_or_damaged", `PPTX ZIP package cannot be opened: ${(error as Error).message}`);
  }
  const entries = Object.entries(initial.files);
  if (entries.length > MAX_PACKAGE_ENTRIES) {
    throw new PresentationError("pptx_unsafe_package", `PPTX package exceeds the ${MAX_PACKAGE_ENTRIES}-entry limit.`);
  }
  let expandedBytes = 0;
  for (const [name, entry] of entries) {
    if (!isSafePartName(name)) {
      throw new PresentationError("pptx_unsafe_package", `PPTX contains unsafe package entry ${name}.`);
    }
    if (entry.dir) continue;
    const compressed = entry._data?.compressedSize;
    const expanded = entry._data?.uncompressedSize;
    if (!Number.isFinite(compressed) || !Number.isFinite(expanded) || compressed! < 0 || expanded! < 0) {
      throw new PresentationError("pptx_invalid_or_damaged", `PPTX entry ${name} has invalid central-directory sizes.`);
    }
    if (expanded! > MAX_PACKAGE_ENTRY_BYTES) {
      throw new PresentationError("pptx_unsafe_package", `PPTX entry ${name} exceeds the single-entry expansion limit.`);
    }
    expandedBytes += expanded!;
    if (expandedBytes > MAX_PACKAGE_EXPANDED_BYTES) {
      throw new PresentationError("pptx_unsafe_package", "PPTX package exceeds the bounded total expansion limit.");
    }
    if (expanded! > MAX_IMAGE_BYTES && (compressed === 0 || expanded! / compressed! > MAX_PACKAGE_RATIO)) {
      throw new PresentationError("pptx_unsafe_package", `PPTX entry ${name} exceeds the compression-ratio safety limit.`);
    }
  }
  try {
    return await zip.loadAsync(buffer, { checkCRC32: true, createFolders: false });
  } catch (error) {
    throw new PresentationError("pptx_invalid_or_damaged", `PPTX CRC validation failed: ${(error as Error).message}`);
  }
}

function pushWarning(warnings: StructuredDocumentWarning[], warning: StructuredDocumentWarning): void {
  if (warnings.length >= MAX_WARNINGS) return;
  if (warnings.some((entry) => entry.code === warning.code && entry.scope === warning.scope && entry.message === warning.message)) return;
  warnings.push(warning);
}

function boundsFromXml(xml: string): PresentationBoundsSpec | undefined {
  const transform = elementBlocks(xml, "xfrm")[0]?.inner;
  if (!transform) return undefined;
  const offset = openingTags(transform, "off")[0];
  const extent = openingTags(transform, "ext")[0];
  if (!offset || !extent) return undefined;
  const values = [attribute(offset, "x"), attribute(offset, "y"), attribute(extent, "cx"), attribute(extent, "cy")]
    .map((value) => Number(value));
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return undefined;
  return {
    x: values[0]! / EMU_PER_INCH,
    y: values[1]! / EMU_PER_INCH,
    width: values[2]! / EMU_PER_INCH,
    height: values[3]! / EMU_PER_INCH,
  };
}

function textStyleFromXml(xml: string): PresentationTextStyleSpec | undefined {
  const run = openingTags(xml, "rPr")[0] ?? openingTags(xml, "defRPr")[0] ?? "";
  const paragraph = openingTags(xml, "pPr")[0] ?? "";
  const fontFace = openingTags(xml, "latin").map((tag) => attribute(tag, "typeface")).find(Boolean);
  const color = openingTags(xml, "srgbClr").map((tag) => attribute(tag, "val")).find((value) => /^[0-9a-f]{6}$/iu.test(value ?? ""));
  const rawSize = Number(attribute(run, "sz"));
  const alignValue = attribute(paragraph, "algn");
  const align = alignValue === "ctr" ? "center" : alignValue === "r" ? "right" : alignValue === "l" ? "left" : undefined;
  const style: PresentationTextStyleSpec = {
    fontFace,
    fontSize: Number.isFinite(rawSize) && rawSize > 0 ? rawSize / 100 : undefined,
    bold: attribute(run, "b") === "1" || attribute(run, "b") === "true" || undefined,
    italic: attribute(run, "i") === "1" || attribute(run, "i") === "true" || undefined,
    color,
    align,
  };
  return Object.values(style).some((value) => value !== undefined) ? style : undefined;
}

function shapeElement(shape: { open: string; inner: string; full: string }): PresentationElementSpec | undefined {
  const paragraphs = elementBlocks(shape.inner, "p");
  const texts = paragraphs.map((paragraph) => textRuns(paragraph.inner).trim()).filter(Boolean);
  if (texts.length === 0) return undefined;
  const placeholder = openingTags(shape.inner, "ph")[0] ?? "";
  const placeholderType = attribute(placeholder, "type")?.toLowerCase();
  const nonVisual = openingTags(shape.inner, "cNvPr")[0] ?? "";
  const shapeName = attribute(nonVisual, "name")?.toLowerCase() ?? "";
  const title = placeholderType === "title" || placeholderType === "ctrtitle" || /^title(?:\s|$)/u.test(shapeName);
  const bounds = boundsFromXml(shape.inner);
  const style = textStyleFromXml(shape.inner);
  const bulletParagraphs = paragraphs.filter((paragraph) => /<(?:[A-Za-z_][\w.-]*:)?bu(?:Char|AutoNum)\b/iu.test(paragraph.inner));
  if (!title && bulletParagraphs.length > 0) {
    return {
      type: "list",
      items: texts,
      ordered: bulletParagraphs.some((paragraph) => /<(?:[A-Za-z_][\w.-]*:)?buAutoNum\b/iu.test(paragraph.inner)),
      bounds,
      style,
    };
  }
  return {
    type: title ? "title" : "text",
    text: texts.join("\n"),
    bounds,
    style,
  };
}

function tableElement(frame: { inner: string }): PresentationElementSpec | undefined {
  const table = elementBlocks(frame.inner, "tbl")[0];
  if (!table) return undefined;
  const rows = elementBlocks(table.inner, "tr").map((row) =>
    elementBlocks(row.inner, "tc").map((cell) => paragraphTexts(cell.inner).join("\n")),
  ).filter((row) => row.length > 0);
  if (rows.length === 0) return undefined;
  return { type: "table", rows, bounds: boundsFromXml(frame.inner) };
}

function imageElement(
  picture: { inner: string },
  relationships: Map<string, Relationship>,
  slidePart: string,
  warnings: StructuredDocumentWarning[],
): PresentationElementSpec | undefined {
  const blip = openingTags(picture.inner, "blip")[0];
  const relationshipId = blip ? attribute(blip, "r:embed") ?? attribute(blip, "embed") : undefined;
  if (!relationshipId) return undefined;
  const relationship = relationships.get(relationshipId);
  if (!relationship || !relationship.type.endsWith("/image")) return undefined;
  if (relationship.external) {
    pushWarning(warnings, structuredWarning("external_link_present", {
      category: "security",
      scope: slidePart,
      message: "An externally linked presentation image was not fetched or exposed.",
    }));
    return undefined;
  }
  const target = resolveRelationshipTarget(slidePart, relationship.target);
  const nonVisual = openingTags(picture.inner, "cNvPr")[0] ?? "";
  const alt = attribute(nonVisual, "descr") ?? attribute(nonVisual, "title") ?? attribute(nonVisual, "name");
  return {
    type: "image",
    source: `package:${target}`,
    alt,
    bounds: boundsFromXml(picture.inner),
  };
}

async function notesForSlide(
  archive: ZipArchiveLike,
  slidePart: string,
  relationships: Relationship[],
): Promise<string[] | undefined> {
  const notesRelationship = relationships.find((relationship) => relationship.type.endsWith("/notesSlide") && !relationship.external);
  if (!notesRelationship) return undefined;
  const notesPart = resolveRelationshipTarget(slidePart, notesRelationship.target);
  const xml = await readXml(archive, notesPart);
  if (!xml) return undefined;
  const notes = elementBlocks(xml, "sp").flatMap((shape) => {
    const placeholder = openingTags(shape.inner, "ph")[0] ?? "";
    const type = attribute(placeholder, "type")?.toLowerCase();
    if (type && ["hdr", "ftr", "dt", "sldnum"].includes(type)) return [];
    return paragraphTexts(shape.inner);
  }).filter(Boolean);
  return notes.length > 0 ? notes : undefined;
}

function warnForUnsupportedSlideFeatures(
  slideXml: string,
  relationships: Relationship[],
  slidePart: string,
  warnings: StructuredDocumentWarning[],
): void {
  if (/<(?:[A-Za-z_][\w.-]*:)?timing\b/iu.test(slideXml)) {
    pushWarning(warnings, structuredWarning("unsupported_presentation_feature", {
      category: "unsupported_capability",
      scope: slidePart,
      message: "Slide animations and timing were detected but were not interpreted.",
      details: { capability: "animation_timing" },
    }));
  }
  const relationshipKinds = relationships.map((relationship) => relationship.type.split("/").at(-1) ?? relationship.type);
  if (relationshipKinds.some((kind) => ["audio", "video", "media"].includes(kind))) {
    pushWarning(warnings, structuredWarning("unsupported_presentation_feature", {
      category: "unsupported_capability",
      scope: slidePart,
      message: "Slide audio or video was detected but was not extracted or played.",
      details: { capability: "audio_video" },
    }));
  }
  if (relationshipKinds.some((kind) => kind.startsWith("diagram")) || /<(?:[A-Za-z_][\w.-]*:)?dgm\b/iu.test(slideXml)) {
    pushWarning(warnings, structuredWarning("unsupported_presentation_feature", {
      category: "unsupported_capability",
      scope: slidePart,
      message: "SmartArt or diagram content was detected but was not structurally interpreted.",
      details: { capability: "smartart_diagram" },
    }));
  }
  const supportedRelationships = new Set(["slideLayout", "notesSlide", "image", "hyperlink"]);
  const unsupported = [...new Set(relationshipKinds.filter((kind) => !supportedRelationships.has(kind)))];
  if (unsupported.length > 0) {
    pushWarning(warnings, structuredWarning("unsupported_presentation_feature", {
      category: "unsupported_capability",
      scope: slidePart,
      message: "The slide has relationships outside the basic text, image, table, layout, and notes boundary.",
      details: { relationshipTypes: unsupported.slice(0, 50) },
    }));
  }
  if (relationships.some((relationship) => relationship.external)) {
    pushWarning(warnings, structuredWarning("external_link_present", {
      category: "security",
      scope: slidePart,
      message: "External presentation relationships were reported but never followed.",
    }));
  }
}

async function parseSlide(
  archive: ZipArchiveLike,
  slidePart: string,
  index: number,
  warnings: StructuredDocumentWarning[],
): Promise<SlideSpec> {
  const slideXml = await readXml(archive, slidePart, true) ?? "";
  const relationshipXml = await readXml(archive, relationshipPart(slidePart));
  const relationships = relationshipXml ? parseRelationships(relationshipXml) : [];
  const relationshipMap = new Map(relationships.map((relationship) => [relationship.id, relationship]));
  warnForUnsupportedSlideFeatures(slideXml, relationships, slidePart, warnings);

  const elements: PresentationElementSpec[] = [];
  for (const shape of elementBlocks(slideXml, "sp")) {
    const element = shapeElement(shape);
    if (element) elements.push(element);
  }
  for (const frame of elementBlocks(slideXml, "graphicFrame")) {
    const element = tableElement(frame);
    if (element) elements.push(element);
    else if (/<(?:[A-Za-z_][\w.-]*:)?graphicData\b/iu.test(frame.inner)) {
      pushWarning(warnings, structuredWarning("unsupported_presentation_feature", {
        category: "unsupported_capability",
        scope: slidePart,
        message: "A non-table graphic frame was detected and was not structurally interpreted.",
      }));
    }
  }
  for (const picture of elementBlocks(slideXml, "pic")) {
    const element = imageElement(picture, relationshipMap, slidePart, warnings);
    if (element) elements.push(element);
  }
  if (elements.length > PHASE20_LIMITS.presentation.maxElements) {
    throw new PresentationError("presentation_content_too_large", `Slide ${index + 1} exceeds the element safety limit.`);
  }
  const tableCells = elements.reduce((count, element) => element.type === "table"
    ? count + element.rows.reduce((rowCount, row) => rowCount + row.length, element.headers?.length ?? 0)
    : count, 0);
  if (tableCells > PHASE20_LIMITS.presentation.maxTableCells) {
    throw new PresentationError("presentation_content_too_large", `Slide ${index + 1} exceeds the table-cell safety limit.`);
  }
  const textChars = elements.reduce((count, element) => {
    if (element.type === "title" || element.type === "text") return count + element.text.length;
    if (element.type === "list") return count + element.items.reduce((total, item) => total + item.length, 0);
    if (element.type === "table") {
      return count + element.rows.flat().reduce<number>((total, cell) => total + String(cell ?? "").length, 0);
    }
    return count;
  }, 0);
  if (textChars > PHASE20_LIMITS.presentation.maxTextChars) {
    throw new PresentationError("presentation_content_too_large", `Slide ${index + 1} cannot fit the declared visible-text safety limit.`);
  }

  const layoutRelationship = relationships.find((relationship) => relationship.type.endsWith("/slideLayout") && !relationship.external);
  let layoutName: string | undefined;
  if (layoutRelationship) {
    const layoutPart = resolveRelationshipTarget(slidePart, layoutRelationship.target);
    const layoutXml = await readXml(archive, layoutPart);
    layoutName = layoutXml
      ? attribute(openingTags(layoutXml, "cSld")[0] ?? "", "name") ?? path.posix.basename(layoutPart, ".xml")
      : path.posix.basename(layoutPart, ".xml");
  }
  const titleElement = elements.find((element) => element.type === "title");
  const title = titleElement && "text" in titleElement ? titleElement.text : undefined;
  const background = elementBlocks(slideXml, "bg")[0]?.inner;
  const backgroundColor = background
    ? openingTags(background, "srgbClr").map((tag) => attribute(tag, "val")).find((value) => /^[0-9a-f]{6}$/iu.test(value ?? ""))
    : undefined;
  return {
    id: path.posix.basename(slidePart, ".xml"),
    title,
    layoutName,
    backgroundColor,
    elements,
    speakerNotes: await notesForSlide(archive, slidePart, relationships),
  };
}

async function packageMetadata(
  archive: ZipArchiveLike,
  presentationXml: string,
  sizeBytes: number,
): Promise<StructuredDocumentMetadata> {
  const core = await readXml(archive, "docProps/core.xml");
  const app = await readXml(archive, "docProps/app.xml");
  const firstText = (xml: string | undefined, name: string): string | undefined => {
    const value = xml ? elementBlocks(xml, name)[0]?.inner : undefined;
    return value === undefined ? undefined : decodeXml(value.replace(/<[^>]+>/gu, "")).trim() || undefined;
  };
  const slideSize = openingTags(presentationXml, "sldSz")[0] ?? "";
  const width = Number(attribute(slideSize, "cx"));
  const height = Number(attribute(slideSize, "cy"));
  return {
    title: firstText(core, "title"),
    author: firstText(core, "creator"),
    subject: firstText(core, "subject"),
    createdAt: firstText(core, "created"),
    modifiedAt: firstText(core, "modified"),
    creatorApplication: firstText(app, "Application") ?? "Deep-Mix bounded OOXML reader",
    sizeBytes,
    properties: Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
      ? { layout: { width: width / EMU_PER_INCH, height: height / EMU_PER_INCH } }
      : undefined,
  };
}

function sourceReference(
  argsPath: string,
  resolved: { workspaceRelativePath?: string; artifactRef?: string },
  sizeBytes: number,
): StructuredSourceReference {
  if (resolved.artifactRef) {
    return {
      kind: "artifact",
      reference: resolved.artifactRef,
      artifactUri: resolved.artifactRef,
      mimeType: PPTX_MIME_TYPE,
      sizeBytes,
    };
  }
  return {
    kind: "workspace_path",
    reference: resolved.workspaceRelativePath ?? argsPath,
    workspaceRelativePath: resolved.workspaceRelativePath,
    mimeType: PPTX_MIME_TYPE,
    sizeBytes,
  };
}

function recoveryArtifact(input: {
  argsPath: string;
  absolutePath: string;
  workspaceRelativePath?: string;
  artifactRef?: string;
  sizeBytes: number;
  context: RuntimeToolExecutionContext;
}): ToolOutputArtifact | undefined {
  const uri = input.artifactRef?.startsWith("artifact://")
    ? input.artifactRef
    : input.workspaceRelativePath
      ? `file://${input.workspaceRelativePath}`
      : input.argsPath.startsWith("file://")
        ? input.argsPath
        : undefined;
  if (!uri) return undefined;
  return {
    uri,
    fileName: path.basename(input.absolutePath),
    mimeType: PPTX_MIME_TYPE,
    sizeBytes: input.sizeBytes,
    kind: "document",
    sourceToolName: "read_presentation",
    summary: "Original whole PPTX retained only as a recovery/reference artifact for paginated output.",
    createdAt: input.context.moduleContext.clock.now(),
    workspaceRelativePath: input.workspaceRelativePath,
  };
}

function failureResult(
  toolName: "read_presentation" | "write_presentation",
  code: PresentationFailureCode,
  message: string,
  context: RuntimeToolExecutionContext,
  dependency?: string,
): ToolResult {
  const timestamp = context.moduleContext.clock.now();
  const error: ToolStructuredError = {
    type: dependency ? "missing_dependency" : "command_failed",
    message,
    retryable: false,
    toolName,
    dependency,
  };
  const body = { kind: "presentation_error", format: "pptx", code, error };
  return {
    toolName,
    callId: context.callId,
    startedAt: timestamp,
    endedAt: timestamp,
    success: false,
    output: JSON.stringify(body),
    structuredContent: body,
    error: message,
  };
}

export async function executeReadPresentation(
  args: ReadPresentationArgs,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  const resolved = await context.moduleContext.paths.resolveReadable(args.path);
  const stat = await fs.stat(resolved.absolutePath);
  if (!stat.isFile()) {
    return failureResult("read_presentation", "format_mismatch", "Presentation input must resolve to a file.", context);
  }
  if (path.extname(resolved.absolutePath).toLowerCase() !== ".pptx") {
    return failureResult("read_presentation", "unsupported_format", "read_presentation accepts PPTX files only.", context);
  }
  if (stat.size > PHASE20_LIMITS.presentation.maxInputBytes) {
    return failureResult(
      "read_presentation",
      "presentation_too_large",
      `PPTX input exceeds the ${PHASE20_LIMITS.presentation.maxInputBytes / 1024 / 1024} MiB safety limit.`,
      context,
    );
  }
  let cursor: number;
  try {
    cursor = parseNonNegativeCursor(args.cursor);
  } catch (error) {
    throw new ToolArgumentError((error as Error).message, { fieldPath: "/cursor" });
  }
  const maxSlides = args.maxSlides ?? DEFAULT_PAGE_SLIDES;
  const buffer = await resolved.readBytes();
  if (buffer.byteLength > PHASE20_LIMITS.presentation.maxInputBytes) {
    return failureResult(
      "read_presentation",
      "presentation_too_large",
      `PPTX input exceeds the ${PHASE20_LIMITS.presentation.maxInputBytes / 1024 / 1024} MiB safety limit.`,
      context,
    );
  }
  if (!hasZipMagic(buffer)) {
    return failureResult("read_presentation", "format_mismatch", "The PPTX input does not have an OOXML ZIP signature.", context);
  }

  try {
    const archive = await loadValidatedArchive(buffer);
    const contentTypes = await readXml(archive, "[Content_Types].xml", true) ?? "";
    if (!/presentationml\.presentation(?:\.macroEnabled)?\.main\+xml/iu.test(contentTypes)) {
      throw new PresentationError("format_mismatch", "OOXML package is not a PowerPoint presentation package.");
    }
    const presentationXml = await readXml(archive, "ppt/presentation.xml", true) ?? "";
    const presentationRelationshipsXml = await readXml(archive, "ppt/_rels/presentation.xml.rels", true) ?? "";
    const warnings: StructuredDocumentWarning[] = [];
    const entryNames = Object.keys(archive.files);
    if (entryNames.some((name) => /(?:^|\/)vbaProject\.bin$/iu.test(name)) || /macroEnabled/iu.test(contentTypes)) {
      pushWarning(warnings, structuredWarning("macro_present", {
        severity: "high",
        category: "security",
        message: "Macro content was detected but was never executed or interpreted.",
      }));
    }
    if (entryNames.some((name) => /^ppt\/media\/.*\.(?:mp4|m4v|mov|avi|wmv|mp3|m4a|wav|aac)$/iu.test(name))) {
      pushWarning(warnings, structuredWarning("unsupported_presentation_feature", {
        category: "unsupported_capability",
        message: "Presentation audio or video media was detected but was not extracted or played.",
        details: { capability: "audio_video_media" },
      }));
    }
    if (entryNames.some((name) => /^ppt\/diagrams\//iu.test(name))) {
      pushWarning(warnings, structuredWarning("unsupported_presentation_feature", {
        category: "unsupported_capability",
        message: "SmartArt or diagram package parts were detected but were not structurally interpreted.",
        details: { capability: "smartart_diagram" },
      }));
    }
    const masters = entryNames.filter((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/iu.test(name));
    if (masters.length > 1 || entryNames.some((name) => /^ppt\/(?:theme|slideLayouts)\//iu.test(name))) {
      pushWarning(warnings, structuredWarning("unsupported_presentation_feature", {
        category: "compatibility",
        message: "Themes, masters, and complex layout inheritance are reported only at a basic compatibility level.",
        details: { capability: "complex_masters", masterCount: masters.length },
      }));
    }
    pushWarning(warnings, structuredWarning("unsupported_presentation_feature", {
      severity: "info",
      category: "compatibility",
      message: "PPTX extraction preserves basic content and bounds but does not promise pixel-perfect round-trip fidelity.",
      details: { capability: "pixel_perfect_roundtrip" },
    }));

    const relationships = new Map(parseRelationships(presentationRelationshipsXml).map((relationship) => [relationship.id, relationship]));
    const slideIds = openingTags(presentationXml, "sldId");
    const slideParts = slideIds.map((slideId) => {
      const relationshipId = attribute(slideId, "r:id") ?? attribute(slideId, "id");
      const relationship = relationshipId ? relationships.get(relationshipId) : undefined;
      if (!relationship || relationship.external || !relationship.type.endsWith("/slide")) {
        throw new PresentationError("pptx_invalid_or_damaged", "Presentation slide order references a missing or invalid slide relationship.");
      }
      return resolveRelationshipTarget("ppt/presentation.xml", relationship.target);
    });
    if (slideParts.length > PHASE20_LIMITS.presentation.maxSlides) {
      throw new PresentationError(
        "presentation_too_large",
        `Presentation has ${slideParts.length} slides, exceeding the ${PHASE20_LIMITS.presentation.maxSlides}-slide limit.`,
      );
    }
    if (new Set(slideParts).size !== slideParts.length) {
      throw new PresentationError("pptx_invalid_or_damaged", "Presentation slide order contains duplicate slide targets.");
    }

    const slides: SlideSpec[] = [];
    let budgetChars = 0;
    for (let index = cursor; index < slideParts.length && slides.length < maxSlides; index += 1) {
      const slide = await parseSlide(archive, slideParts[index]!, index, warnings);
      const chars = JSON.stringify(slide).length;
      if (chars > PHASE20_LIMITS.maxModelVisibleChars - 20_000) {
        throw new PresentationError("presentation_content_too_large", `Slide ${index + 1} cannot fit one bounded response page.`);
      }
      if (budgetChars + chars > PHASE20_LIMITS.maxModelVisibleChars - 40_000) break;
      budgetChars += chars;
      slides.push(slide);
    }
    const nextOffset = cursor + slides.length;
    const truncated = nextOffset < slideParts.length;
    if (truncated) {
      pushWarning(warnings, structuredWarning("output_truncated", {
        category: "truncation",
        details: { nextCursor: String(nextOffset), order: "presentation_relationship_order" },
      }));
    }
    const metadata = await packageMetadata(archive, presentationXml, buffer.byteLength);
    metadata.properties = {
      ...(metadata.properties ?? {}),
      selection: { cursor: String(cursor), maxSlides, order: "presentation_relationship_order" },
    };
    const result: PresentationReadResult = {
      format: "pptx",
      source: sourceReference(args.path, resolved, buffer.byteLength),
      metadata,
      warnings,
      truncation: {
        truncated,
        reason: truncated ? (slides.length < maxSlides ? "character_limit" : "pagination") : undefined,
        returnedItems: slides.length,
        totalItems: slideParts.length,
        nextCursor: truncated ? String(nextOffset) : undefined,
      },
      summary: `PPTX presentation: ${slideParts.length} slide(s), ${slides.length} returned in package relationship order.`,
      totalSlides: slideParts.length,
      returnedSlides: slides.length,
      slides,
    };
    const output = JSON.stringify(result);
    if (output.length > PHASE20_LIMITS.maxModelVisibleChars) {
      throw new PresentationError("presentation_content_too_large", "Presentation response exceeds the declared visible-output budget.");
    }
    const artifact = truncated ? recoveryArtifact({
      argsPath: args.path,
      absolutePath: resolved.absolutePath,
      workspaceRelativePath: resolved.workspaceRelativePath,
      artifactRef: resolved.artifactRef,
      sizeBytes: buffer.byteLength,
      context,
    }) : undefined;
    const timestamp = context.moduleContext.clock.now();
    return {
      toolName: "read_presentation",
      callId: context.callId,
      startedAt: timestamp,
      endedAt: timestamp,
      success: true,
      output,
      structuredContent: result,
      artifacts: artifact ? [artifact] : [],
    };
  } catch (error) {
    const failure = error instanceof PresentationError
      ? error
      : new PresentationError("pptx_invalid_or_damaged", `PPTX input is damaged or unsupported: ${(error as Error).message}`);
    return failureResult("read_presentation", failure.code, failure.message, context, failure.dependency);
  }
}

function validateBounds(bounds: PresentationBoundsSpec | undefined, width: number, height: number, fieldPath: string): void {
  if (!bounds) return;
  if (
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.x < 0
    || bounds.y < 0
    || bounds.width <= 0
    || bounds.height <= 0
    || bounds.x + bounds.width > width
    || bounds.y + bounds.height > height
  ) {
    throw new ToolArgumentError("Presentation element bounds must be positive and fit within the declared slide layout.", { fieldPath });
  }
}

function validatePresentationSpec(document: PresentationSpec): void {
  if (document.slides.length < 1 || document.slides.length > PHASE20_LIMITS.presentation.maxSlides) {
    throw new ToolArgumentError(`Presentation must contain 1-${PHASE20_LIMITS.presentation.maxSlides} slides.`, {
      fieldPath: "/presentation/slides",
    });
  }
  const layout = document.layout ?? DEFAULT_LAYOUT;
  let elements = 0;
  let tableCells = 0;
  let images = 0;
  let textChars = 0;
  document.slides.forEach((slide, slideIndex) => {
    if (slide.layoutName) {
      throw new ToolArgumentError("write_presentation does not accept inherited or custom master layout names; use explicit basic bounds.", {
        fieldPath: `/presentation/slides/${slideIndex}/layoutName`,
      });
    }
    elements += slide.elements.length;
    textChars += slide.title?.length ?? 0;
    textChars += slide.speakerNotes?.reduce((total, note) => total + note.length, 0) ?? 0;
    slide.elements.forEach((element, elementIndex) => {
      validateBounds(element.bounds, layout.width, layout.height, `/presentation/slides/${slideIndex}/elements/${elementIndex}/bounds`);
      if (element.type === "title" || element.type === "text") textChars += element.text.length;
      else if (element.type === "list") textChars += element.items.reduce((total, item) => total + item.length, 0);
      else if (element.type === "image") images += 1;
      else if (element.type === "table") {
        tableCells += element.rows.reduce<number>((total, row) => total + row.length, element.headers?.length ?? 0);
        textChars += element.rows.flat().reduce<number>((total, cell) => total + String(cell ?? "").length, 0);
      }
    });
  });
  if (elements > PHASE20_LIMITS.presentation.maxElements) {
    throw new ToolArgumentError("Presentation exceeds the declared element limit.", { fieldPath: "/presentation/slides" });
  }
  if (tableCells > PHASE20_LIMITS.presentation.maxTableCells) {
    throw new ToolArgumentError("Presentation exceeds the declared table-cell limit.", { fieldPath: "/presentation/slides" });
  }
  if (images > PHASE20_LIMITS.presentation.maxImages) {
    throw new ToolArgumentError("Presentation exceeds the declared image limit.", { fieldPath: "/presentation/slides" });
  }
  if (textChars > PHASE20_LIMITS.presentation.maxTextChars) {
    throw new ToolArgumentError("Presentation exceeds the declared text-character limit.", { fieldPath: "/presentation/slides" });
  }
}

function imageInfo(bytes: Buffer): { mimeType: "image/png" | "image/jpeg"; width: number; height: number } | undefined {
  if (bytes.byteLength >= 24 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return { mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 3 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1]!;
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.byteLength) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.byteLength) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) return undefined;
      return { mimeType: "image/jpeg", height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return undefined;
}

function isNetworkReference(source: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//iu.test(source) && !source.startsWith("artifact://") && !source.startsWith("file://");
}

async function resolveImages(
  document: PresentationSpec,
  context: RuntimeToolExecutionContext,
): Promise<Map<string, { data: string; width: number; height: number }>> {
  const sources = [...new Set(document.slides.flatMap((slide) => slide.elements
    .filter((element): element is Extract<PresentationElementSpec, { type: "image" }> => element.type === "image")
    .map((element) => element.source)))];
  const images = new Map<string, { data: string; width: number; height: number }>();
  let totalBytes = 0;
  for (const source of sources) {
    if (isNetworkReference(source) || source.startsWith("package:")) {
      throw new ToolArgumentError("Presentation images must use trusted workspace or artifact references; network and package pseudo-references are not fetched.", {
        fieldPath: "/presentation/slides/elements/source",
      });
    }
    const resolved = await context.moduleContext.paths.resolveReadable(source);
    const bytes = await resolved.readBytes();
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new ToolArgumentError(`Presentation image exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MiB per-image limit.`, {
        fieldPath: "/presentation/slides/elements/source",
      });
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new ToolArgumentError("Presentation images exceed the bounded total image-byte limit.", {
        fieldPath: "/presentation/slides/elements/source",
      });
    }
    const info = imageInfo(bytes);
    if (!info || info.width < 1 || info.height < 1 || info.width * info.height > PHASE20_LIMITS.image.maxPixels) {
      throw new ToolArgumentError("Presentation images must be valid bounded PNG or JPEG files.", {
        fieldPath: "/presentation/slides/elements/source",
      });
    }
    images.set(source, {
      data: `${info.mimeType};base64,${bytes.toString("base64")}`,
      width: info.width,
      height: info.height,
    });
  }
  return images;
}

function defaultBounds(type: PresentationElementSpec["type"], index: number, layout: { width: number; height: number }): PresentationBoundsSpec {
  if (type === "title") return { x: 0.5, y: 0.3, width: Math.max(1, layout.width - 1), height: 0.7 };
  const y = Math.min(layout.height - 1.2, 1.2 + index * 0.65);
  return { x: 0.5, y: Math.max(0.5, y), width: Math.max(1, layout.width - 1), height: Math.max(0.5, layout.height - Math.max(0.5, y) - 0.5) };
}

function positionOptions(bounds: PresentationBoundsSpec): Record<string, number> {
  return { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height };
}

function tableScalar(value: TableCellScalar): string | number | boolean {
  return value === null ? "" : value;
}

async function generatePresentation(
  document: PresentationSpec,
  images: Map<string, { data: string; width: number; height: number }>,
): Promise<Buffer> {
  const PptxGenJS = await loadPptxGenJs();
  const pptx = new PptxGenJS();
  const layout = document.layout ?? DEFAULT_LAYOUT;
  pptx.defineLayout({ name: "DEEP_MIX_PHASE20", width: layout.width, height: layout.height });
  pptx.layout = "DEEP_MIX_PHASE20";
  pptx.title = document.title ?? document.metadata?.title ?? "";
  pptx.author = document.metadata?.author ?? "";
  pptx.subject = document.metadata?.subject ?? "";
  pptx.company = typeof document.metadata?.properties?.company === "string"
    ? document.metadata.properties.company
    : "";

  document.slides.forEach((slideSpec) => {
    const slide = pptx.addSlide();
    if (slideSpec.backgroundColor) slide.background = { color: slideSpec.backgroundColor };
    slideSpec.elements.forEach((element, elementIndex) => {
      const bounds = element.bounds ?? defaultBounds(element.type, elementIndex, layout);
      if (element.type === "title" || element.type === "text") {
        slide.addText(element.text, {
          ...positionOptions(bounds),
          fontFace: element.style?.fontFace,
          fontSize: element.style?.fontSize,
          bold: element.type === "title" ? element.style?.bold ?? true : element.style?.bold,
          italic: element.style?.italic,
          color: element.style?.color,
          align: element.style?.align,
          margin: 0.08,
          breakLine: false,
          objectName: element.type === "title" ? `Title ${elementIndex + 1}` : undefined,
        });
      } else if (element.type === "list") {
        const runs = element.items.map((item, index) => ({
          text: item,
          options: {
            bullet: element.ordered
              ? { type: "number" as const, style: "arabicPeriod", numberStartAt: index + 1 }
              : true,
            breakLine: index < element.items.length - 1,
          },
        }));
        slide.addText(runs, {
          ...positionOptions(bounds),
          fontFace: element.style?.fontFace,
          fontSize: element.style?.fontSize,
          bold: element.style?.bold,
          italic: element.style?.italic,
          color: element.style?.color,
          align: element.style?.align,
          margin: 0.08,
          breakLine: false,
        });
      } else if (element.type === "image") {
        const image = images.get(element.source);
        if (!image) throw new PresentationError("image_invalid_or_unsupported", "A validated presentation image is unavailable.");
        slide.addImage({ data: image.data, altText: element.alt, ...positionOptions(bounds) });
      } else if (element.type === "table") {
        const rows = [
          ...(element.headers ? [element.headers] : []),
          ...element.rows.map((row) => row.map(tableScalar)),
        ];
        slide.addTable(rows, {
          ...positionOptions(bounds),
          border: { type: "solid", color: "B7C3D0", pt: 0.5 },
          margin: 0.05,
          fontSize: 12,
          autoPage: false,
        });
      }
    });
    if (slideSpec.speakerNotes?.length) slide.addNotes(slideSpec.speakerNotes.join("\n\n"));
  });
  const generated = await pptx.write({ outputType: "nodebuffer", compression: true });
  if (Buffer.isBuffer(generated)) return generated;
  if (generated instanceof Uint8Array) return Buffer.from(generated);
  if (generated instanceof ArrayBuffer) return Buffer.from(generated);
  throw new PresentationError("presentation_generation_failed", "PptxGenJS returned an unsupported output representation.");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(typeof signal.reason === "string" ? signal.reason : "Presentation write was aborted.");
}

async function publishBufferAtomic(
  absolutePath: string,
  content: Buffer,
  overwrite: boolean,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.${process.pid}.${randomUUID()}.deep-mix.tmp`);
  const backupPath = `${absolutePath}.${process.pid}.${randomUUID()}.deep-mix.bak`;
  let backupCreated = false;
  try {
    const handle = await fs.open(temporaryPath, "wx", 0o666);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    throwIfAborted(signal);
    if (!overwrite) {
      try {
        await fs.link(temporaryPath, absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new ToolArgumentError("Output already exists; set overwrite=true to replace it.", { fieldPath: "/overwrite" });
        }
        throw error;
      }
      return;
    }
    if (process.platform !== "win32") {
      await fs.rename(temporaryPath, absolutePath);
      return;
    }
    try {
      await fs.rename(temporaryPath, absolutePath);
      return;
    } catch (error) {
      if (!["EACCES", "EBUSY", "EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    try {
      await fs.rename(absolutePath, backupPath);
      backupCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await fs.rename(temporaryPath, absolutePath);
      if (backupCreated) await fs.rm(backupPath, { force: true });
      backupCreated = false;
    } catch (error) {
      if (backupCreated) await fs.rename(backupPath, absolutePath).catch(() => undefined);
      backupCreated = false;
      throw error;
    }
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    if (backupCreated) await fs.rename(backupPath, absolutePath).catch(() => undefined);
  }
}

function writeArtifact(
  relativePath: string,
  absolutePath: string,
  content: Buffer,
  context: RuntimeToolExecutionContext,
): ToolOutputArtifact {
  return {
    uri: `file://${relativePath}`,
    fileName: path.basename(absolutePath),
    mimeType: PPTX_MIME_TYPE,
    sizeBytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
    kind: "document",
    sourceToolName: "write_presentation",
    summary: "Generated a bounded basic PPTX presentation without PowerPoint automation, macros, animation, or master authoring.",
    createdAt: context.moduleContext.clock.now(),
    workspaceRelativePath: relativePath,
  };
}

export async function executeWritePresentation(
  args: WritePresentationArgs,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  if (path.extname(args.outputPath).toLowerCase() !== ".pptx") {
    throw new ToolArgumentError("write_presentation outputPath must end with .pptx.", { fieldPath: "/outputPath" });
  }
  validatePresentationSpec(args.presentation);
  const absolutePath = context.moduleContext.paths.resolveWorkspace(args.outputPath);
  try {
    const existing = await fs.stat(absolutePath);
    if (!existing.isFile()) throw new ToolArgumentError("write_presentation outputPath must identify a regular file.", { fieldPath: "/outputPath" });
    if (!args.overwrite) throw new ToolArgumentError("Output already exists; set overwrite=true to replace it.", { fieldPath: "/overwrite" });
  } catch (error) {
    if (error instanceof ToolArgumentError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!context.checkpoint) {
    return failureResult(
      "write_presentation",
      "presentation_write_failed",
      "The runtime did not create the required pre-write checkpoint.",
      context,
    );
  }
  try {
    const images = await resolveImages(args.presentation, context);
    const content = await generatePresentation(args.presentation, images);
    if (content.byteLength > PHASE20_LIMITS.presentation.maxOutputBytes) {
      return failureResult(
        "write_presentation",
        "output_too_large",
        `PPTX output exceeds the ${PHASE20_LIMITS.presentation.maxOutputBytes / 1024 / 1024} MiB safety limit.`,
        context,
      );
    }
    await publishBufferAtomic(absolutePath, content, Boolean(args.overwrite), context.signal);
    const relativePath = normalizeRelativePath(path.relative(context.workspaceRoot, absolutePath));
    const artifact = writeArtifact(relativePath, absolutePath, content, context);
    const warnings: StructuredDocumentWarning[] = [structuredWarning("unsupported_presentation_feature", {
      severity: "info",
      category: "compatibility",
      message: "The basic PPTX writer does not author animations, macros, complex masters, or pixel-perfect layout inheritance.",
    })];
    const structured: StructuredDocumentWriteResult = {
      format: "pptx",
      outputPath: relativePath,
      sizeBytes: content.byteLength,
      artifact,
      warnings,
      checkpointId: context.checkpoint.checkpointId,
      undoAvailable: true,
    };
    const timestamp = context.moduleContext.clock.now();
    return {
      toolName: "write_presentation",
      callId: context.callId,
      startedAt: timestamp,
      endedAt: timestamp,
      success: true,
      output: JSON.stringify(structured),
      structuredContent: structured,
      artifacts: [artifact],
    };
  } catch (error) {
    if (error instanceof ToolArgumentError) throw error;
    const failure = error instanceof PresentationError
      ? error
      : new PresentationError("presentation_generation_failed", `PPTX generation failed: ${(error as Error).message}`);
    return failureResult("write_presentation", failure.code, failure.message, context, failure.dependency);
  }
}

export const readPresentationTool: RuntimeToolSpec = {
  name: "read_presentation",
  displayName: "Read Presentation",
  description: "Read bounded PPTX slides in package order with basic text, image references, tables, bounds, notes, pagination, and explicit unsupported-feature warnings.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: pathPropertySchema,
      cursor: { ...cursorPropertySchema, pattern: "^(0|[1-9]\\d*)$" },
      maxSlides: { type: "integer", minimum: 1, maximum: PHASE20_LIMITS.presentation.maxSlides, default: DEFAULT_PAGE_SLIDES },
    },
  },
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "slow",
  groups: ["documents", "presentation", "presentation-read"],
  selection: {
    groups: ["documents", "presentation", "presentation-read"],
    keywords: [
      "read presentation", "read pptx", "inspect slides", "extract powerpoint",
      "读取演示文稿", "读取pptx", "查看幻灯片", "提取PPT内容",
    ],
    keywordGroups: [
      ["read", "presentation"], ["read", "pptx"], ["inspect", "slides"],
      ["读取", "演示文稿"], ["读取", "pptx"], ["查看", "幻灯片"],
    ],
    attachmentExtensions: [".pptx"],
    mimeTypes: [PPTX_MIME_TYPE],
  },
  getAvailability: readPresentationAvailability,
  resolveAccess: (rawArgs) => [{
    kind: "filesystem_read",
    paths: [(rawArgs as ReadPresentationArgs).path],
    reason: "Read the requested PPTX through the workspace or trusted-artifact path guard.",
  }],
  execute: (rawArgs, context) => executeReadPresentation(rawArgs as ReadPresentationArgs, context),
};

export const writePresentationTool: RuntimeToolSpec = {
  name: "write_presentation",
  displayName: "Write Presentation",
  description: "Generate a bounded basic PPTX from PresentationSpec with trusted PNG/JPEG images, checkpoint, atomic publish, artifact, and undo metadata.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["outputPath", "presentation"],
    properties: {
      outputPath: pathPropertySchema,
      overwrite: { type: "boolean" },
      presentation: presentationSpecSchema,
    },
  },
  readOnly: false,
  permissionCategory: "write_file",
  sideEffectLevel: "high",
  timeoutCategory: "slow",
  groups: ["documents", "presentation", "presentation-write"],
  selection: {
    groups: ["documents", "presentation", "presentation-write"],
    keywords: [
      "write presentation", "create pptx", "create powerpoint", "generate slides", "export powerpoint",
      "写入演示文稿", "创建pptx", "生成幻灯片", "导出PPT",
    ],
    keywordGroups: [
      ["write", "presentation"], ["create", "pptx"], ["create", "powerpoint"], ["generate", "slides"],
      ["写入", "演示文稿"], ["创建", "pptx"], ["生成", "幻灯片"],
    ],
  },
  checkpoint: {
    mode: "before_write",
    scope: "pre_tool_write",
    reason: "Before generating or replacing a PPTX presentation.",
  },
  getAvailability: writePresentationAvailability,
  resolveAccess: (rawArgs) => {
    const args = rawArgs as WritePresentationArgs;
    const imageSources = [...new Set(args.presentation.slides.flatMap((slide) => slide.elements
      .filter((element): element is Extract<PresentationElementSpec, { type: "image" }> => element.type === "image")
      .map((element) => element.source)))];
    return [
      {
        kind: "filesystem_write" as const,
        paths: [args.outputPath],
        reason: "Write the generated PPTX inside the writable workspace sandbox.",
      },
      ...(imageSources.length > 0 ? [{
        kind: "filesystem_read" as const,
        paths: imageSources,
        reason: "Read declared presentation images through the workspace or trusted-artifact path guard.",
      }] : []),
    ];
  },
  execute: (rawArgs, context) => executeWritePresentation(rawArgs as WritePresentationArgs, context),
};

export const presentationsToolModule: ToolModule = {
  manifest: {
    id: "builtin.presentations",
    version: "1.0.0",
    description: "Bounded basic PPTX read and write tools with explicit compatibility warnings.",
    source: "built_in",
  },
  create: () => [readPresentationTool, writePresentationTool],
};
