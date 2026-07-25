import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../packages/persistence/src/index.js";
import type {
  PresentationElementSpec,
  PresentationReadResult,
  PresentationSpec,
  StructuredDocumentWriteResult,
  StructuredDocumentWarning,
} from "../packages/shared-schema/src/index.js";
import { ToolRuntime } from "../packages/tool-runtime/src/index.js";
import { recoveryToolModule } from "../packages/tool-runtime/src/built-ins/recovery/index.js";
import { PHASE20_LIMITS } from "../packages/tool-runtime/src/built-ins/structured-documents/format-policy.js";
import {
  presentationsToolModule,
  readPresentationTool,
  writePresentationTool,
} from "../packages/tool-runtime/src/built-ins/structured-documents/presentations.js";

const temporaryRoots: string[] = [];
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8QAAAABJRU5ErkJggg==",
  "base64",
);
const pptxMimeType = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

interface PresentationFixture {
  workspaceRoot: string;
  sessionStore: SessionStore;
  runtime: ToolRuntime;
  sessionId: string;
}

async function createRuntime(): Promise<PresentationFixture> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase20-presentation-"));
  temporaryRoots.push(workspaceRoot);
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("read and write bounded PPTX presentations safely");
  const runtime = new ToolRuntime({
    workspaceRoot,
    sessionStore,
    permissionMode: "danger-full-access",
    modules: [presentationsToolModule, recoveryToolModule],
  });
  return { workspaceRoot, sessionStore, runtime, sessionId: session.sessionId };
}

function representativePresentation(imageSource: string, slideCount = 2): PresentationSpec {
  const slides: PresentationSpec["slides"] = [
    {
      id: "overview",
      title: "Phase 20 Overview",
      backgroundColor: "F8FAFC",
      speakerNotes: ["Review the generated structure.", "No animation is promised."],
      elements: [
        {
          type: "title",
          text: "Phase 20 Overview",
          bounds: { x: 0.6, y: 0.35, width: 7.2, height: 0.6 },
          style: { fontSize: 28, bold: true, color: "172554" },
        },
        {
          type: "text",
          text: "A bounded presentation round trip.",
          bounds: { x: 0.7, y: 1.15, width: 5.8, height: 0.55 },
          style: { fontSize: 16, color: "334155" },
        },
        {
          type: "list",
          items: ["Stable schemas", "Explicit fidelity warnings"],
          ordered: false,
          bounds: { x: 0.7, y: 1.95, width: 5.8, height: 1.2 },
          style: { fontSize: 15, color: "0F172A" },
        },
        {
          type: "image",
          source: imageSource,
          alt: "One-pixel safe fixture",
          bounds: { x: 6.85, y: 1.15, width: 1.1, height: 1.1 },
        },
        {
          type: "table",
          headers: ["Capability", "Status"],
          rows: [["Basic text", "supported"], ["Animation", "warning"]],
          bounds: { x: 0.7, y: 3.55, width: 7.25, height: 1.55 },
        },
      ],
    },
    {
      id: "second",
      title: "Second Slide",
      speakerNotes: ["Slide order must remain stable."],
      elements: [
        {
          type: "title",
          text: "Second Slide",
          bounds: { x: 0.7, y: 0.45, width: 7, height: 0.7 },
        },
        {
          type: "text",
          text: "The reader returns slides in package order.",
          bounds: { x: 0.7, y: 1.45, width: 7, height: 0.7 },
        },
        {
          type: "list",
          items: ["First", "Second"],
          ordered: true,
          bounds: { x: 0.7, y: 2.25, width: 7, height: 1 },
        },
      ],
    },
  ];
  while (slides.length < slideCount) {
    const number = slides.length + 1;
    slides.push({
      id: `slide-${number}`,
      title: `Slide ${number}`,
      elements: [{
        type: "title",
        text: `Slide ${number}`,
        bounds: { x: 0.7, y: 0.45, width: 7, height: 0.7 },
      }],
    });
  }
  return {
    title: "Phase 20 representative deck",
    metadata: { author: "Deep-Mix", subject: "Presentation safety" },
    layout: { width: 10, height: 5.625 },
    slides,
  };
}

function writeBody(result: Awaited<ReturnType<ToolRuntime["executeManualTool"]>>): StructuredDocumentWriteResult {
  return result.structuredContent as StructuredDocumentWriteResult;
}

function readBody(result: Awaited<ReturnType<ToolRuntime["executeManualTool"]>>): PresentationReadResult {
  return result.structuredContent as PresentationReadResult;
}

function elementText(element: PresentationElementSpec): string {
  if ("text" in element) return element.text;
  if ("items" in element) return element.items.join("\n");
  if ("rows" in element) {
    return [...(element.headers ?? []), ...element.rows.flat()].map(String).join("\n");
  }
  return element.alt ?? element.source;
}

function warningEvidence(warnings: readonly StructuredDocumentWarning[]): string {
  return warnings
    .map((warning) => `${warning.code} ${warning.message} ${JSON.stringify(warning.details ?? {})}`)
    .join("\n");
}

async function writeSafeDeck(fixture: PresentationFixture, outputPath = "out/deck.pptx", slideCount = 2) {
  await fs.writeFile(path.join(fixture.workspaceRoot, "pixel.png"), onePixelPng);
  const result = await fixture.runtime.executeManualTool(
    "write_presentation",
    { outputPath, presentation: representativePresentation("pixel.png", slideCount) },
    fixture.sessionId,
  );
  expect(result.success, result.output).toBe(true);
  return { result, body: writeBody(result), absolutePath: path.join(fixture.workspaceRoot, outputPath) };
}

async function addUnsupportedFeatureMarkers(sourcePath: string, destinationPath: string): Promise<void> {
  const archive = await JSZip.loadAsync(await fs.readFile(sourcePath), { checkCRC32: true });
  const slideEntry = archive.file("ppt/slides/slide1.xml");
  expect(slideEntry).not.toBeNull();
  const slideXml = await slideEntry!.async("string");
  archive.file(
    "ppt/slides/slide1.xml",
    slideXml.replace(
      "</p:sld>",
      '<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"/><p:timing><p:tnLst><p:par><p:cTn id="99" dur="indefinite"/></p:par></p:tnLst></p:timing></p:sld>',
    ),
  );
  const relationshipsEntry = archive.file("ppt/slides/_rels/slide1.xml.rels");
  expect(relationshipsEntry).not.toBeNull();
  const relationships = await relationshipsEntry!.async("string");
  archive.file(
    "ppt/slides/_rels/slide1.xml.rels",
    relationships.replace(
      "</Relationships>",
      '<Relationship Id="rIdPhase20Video" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="../media/video1.mp4"/></Relationships>',
    ),
  );
  archive.file("ppt/media/video1.mp4", Buffer.from("phase20 inert video marker"));
  archive.file(
    "ppt/diagrams/data1.xml",
    '<?xml version="1.0"?><dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"/>',
  );
  archive.file("ppt/vbaProject.bin", Buffer.from("phase20 inert macro marker"));
  archive.file(
    "ppt/slideMasters/slideMaster99.xml",
    '<?xml version="1.0"?><p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:graphicFrame/></p:spTree></p:cSld></p:sldMaster>',
  );
  const contentTypesEntry = archive.file("[Content_Types].xml");
  expect(contentTypesEntry).not.toBeNull();
  const contentTypes = await contentTypesEntry!.async("string");
  archive.file(
    "[Content_Types].xml",
    contentTypes.replace(
      "</Types>",
      '<Override PartName="/ppt/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>',
    ),
  );
  await fs.writeFile(destinationPath, await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("phase 20 presentation tools", () => {
  it("writes a representative PPTX, validates OOXML, reads the basic model back, and undoes a new file", async () => {
    const fixture = await createRuntime();
    const { result, body, absolutePath } = await writeSafeDeck(fixture);

    expect(body).toMatchObject({
      format: "pptx",
      outputPath: "out/deck.pptx",
      sizeBytes: expect.any(Number),
      warnings: expect.any(Array),
      checkpointId: expect.any(String),
      undoAvailable: true,
      artifact: {
        uri: "file://out/deck.pptx",
        fileName: "deck.pptx",
        mimeType: pptxMimeType,
        kind: "document",
        sourceToolName: "write_presentation",
        workspaceRelativePath: "out/deck.pptx",
      },
    });
    expect(result.artifacts?.[0]).toMatchObject(body.artifact);
    expect(body.sizeBytes).toBeGreaterThan(5_000);
    expect(body.artifact.sizeBytes).toBe(body.sizeBytes);
    expect((await fixture.sessionStore.listToolOutputArtifacts(fixture.sessionId))).toContainEqual(
      expect.objectContaining({ uri: "file://out/deck.pptx", sourceToolName: "write_presentation" }),
    );
    expect((await fixture.sessionStore.listUndoCandidates(fixture.sessionId)).map((candidate) => candidate.checkpointId))
      .toContain(body.checkpointId);

    const archive = await JSZip.loadAsync(await fs.readFile(absolutePath), { checkCRC32: true });
    const names = Object.keys(archive.files);
    expect(names).toEqual(expect.arrayContaining([
      "[Content_Types].xml",
      "ppt/presentation.xml",
      "ppt/slides/slide1.xml",
      "ppt/slides/slide2.xml",
    ]));
    expect(names.some((name) => /^ppt\/media\/image[^/]*\.(?:png|jpeg|jpg)$/iu.test(name))).toBe(true);
    expect(names.some((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/u.test(name))).toBe(true);
    expect(names.some((name) => /vbaProject|ppt\/diagrams\/|ppt\/timing\//iu.test(name))).toBe(false);

    const read = await fixture.runtime.executeManualTool(
      "read_presentation",
      { path: "out/deck.pptx", cursor: "0", maxSlides: 10 },
      fixture.sessionId,
    );
    const content = readBody(read);
    expect(read.success, read.output).toBe(true);
    expect(content).toMatchObject({
      format: "pptx",
      source: { kind: "workspace_path", workspaceRelativePath: "out/deck.pptx", mimeType: pptxMimeType },
      totalSlides: 2,
      returnedSlides: 2,
      truncation: { truncated: false, returnedItems: 2, totalItems: 2 },
    });
    expect(content.slides.map((slide) => slide.title)).toEqual(["Phase 20 Overview", "Second Slide"]);
    const firstElements = content.slides[0]!.elements;
    expect(firstElements.some((element) => element.type === "text" && element.text.includes("bounded presentation"))).toBe(true);
    expect(firstElements.some((element) => element.type === "list" && element.items.includes("Stable schemas"))).toBe(true);
    expect(firstElements.some((element) => element.type === "table" && elementText(element).includes("Basic text"))).toBe(true);
    const image = firstElements.find((element) => element.type === "image");
    expect(image).toMatchObject({ type: "image", source: expect.any(String), bounds: expect.any(Object) });
    expect(image?.source).not.toMatch(/^data:/iu);
    const boundedText = firstElements.find(
      (element) => element.type === "text" && element.text.includes("bounded presentation"),
    );
    expect(boundedText?.bounds).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number),
    });
    expect(content.slides[0]!.speakerNotes?.join(" ")).toContain("Review the generated structure");
    expect(content.slides[1]!.elements).toContainEqual(expect.objectContaining({
      type: "list",
      items: ["First", "Second"],
      ordered: true,
    }));

    const undone = await fixture.runtime.executeManualTool(
      "undo",
      { checkpointId: body.checkpointId, mode: "code" },
      fixture.sessionId,
    );
    expect(undone.success, undone.output).toBe(true);
    await expect(fs.stat(absolutePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts a trusted image artifact without exposing its binary in model-visible output", async () => {
    const fixture = await createRuntime();
    const imageArtifact = await fixture.sessionStore.storeToolOutputArtifact({
      sessionId: fixture.sessionId,
      toolCallId: "presentation-image-fixture",
      sourceToolName: "phase20_fixture",
      fileName: "pixel.png",
      mimeType: "image/png",
      kind: "image",
      summary: "Trusted one-pixel fixture",
      content: onePixelPng,
    });
    const result = await fixture.runtime.executeManualTool(
      "write_presentation",
      { outputPath: "artifact-image.pptx", presentation: representativePresentation(imageArtifact.uri) },
      fixture.sessionId,
    );
    expect(result.success, result.output).toBe(true);
    expect(result.output).not.toContain(onePixelPng.toString("base64"));
    const archive = await JSZip.loadAsync(
      await fs.readFile(path.join(fixture.workspaceRoot, "artifact-image.pptx")),
      { checkCRC32: true },
    );
    expect(Object.keys(archive.files).some((name) => /^ppt\/media\/image[^/]*\.png$/u.test(name))).toBe(true);
  });

  it("warns explicitly for timing, audio/video, SmartArt, macros, and complex masters", async () => {
    const fixture = await createRuntime();
    const { absolutePath } = await writeSafeDeck(fixture, "safe.pptx");
    const mutatedPath = path.join(fixture.workspaceRoot, "unsupported-features.pptx");
    await addUnsupportedFeatureMarkers(absolutePath, mutatedPath);

    const result = await fixture.runtime.executeManualTool(
      "read_presentation",
      { path: "unsupported-features.pptx" },
      fixture.sessionId,
    );
    const content = readBody(result);
    expect(result.success, result.output).toBe(true);
    expect(content.slides[0]?.title).toBe("Phase 20 Overview");
    const evidence = warningEvidence(content.warnings);
    expect(evidence).toMatch(/animation|timing/iu);
    expect(evidence).toMatch(/audio|video|media/iu);
    expect(evidence).toMatch(/smartart|diagram/iu);
    expect(evidence).toMatch(/macro|vba/iu);
    expect(evidence).toMatch(/complex.{0,20}master|master.{0,20}complex/iu);
    expect(content.warnings).toContainEqual(expect.objectContaining({
      code: "macro_present",
      severity: "high",
    }));
    expect(content.warnings.some((warning) => warning.code === "unsupported_presentation_feature")).toBe(true);
    expect(evidence).not.toMatch(/pixel[- ]perfect.{0,20}(preserved|supported)|fully preserved/iu);
  });

  it("paginates by stable slide cursor and enforces the model-visible character budget", async () => {
    const fixture = await createRuntime();
    const { absolutePath } = await writeSafeDeck(fixture, "paged.pptx", 3);

    const first = await fixture.runtime.executeManualTool(
      "read_presentation",
      { path: "paged.pptx", cursor: "0", maxSlides: 1 },
      fixture.sessionId,
    );
    const firstContent = readBody(first);
    expect(first.success, first.output).toBe(true);
    expect(firstContent).toMatchObject({
      totalSlides: 3,
      returnedSlides: 1,
      truncation: { truncated: true, reason: "pagination", nextCursor: "1" },
    });
    expect(firstContent.slides[0]?.title).toBe("Phase 20 Overview");
    expect(firstContent.warnings).toContainEqual(expect.objectContaining({ code: "output_truncated" }));

    const second = await fixture.runtime.executeManualTool(
      "read_presentation",
      { path: "paged.pptx", cursor: firstContent.truncation.nextCursor, maxSlides: 1 },
      fixture.sessionId,
    );
    const secondContent = readBody(second);
    expect(second.success, second.output).toBe(true);
    expect(secondContent.slides[0]?.title).toBe("Second Slide");
    expect(secondContent.truncation.nextCursor).toBe("2");

    const archive = await JSZip.loadAsync(await fs.readFile(absolutePath), { checkCRC32: true });
    for (let slide = 1; slide <= 3; slide += 1) {
      const entryName = `ppt/slides/slide${slide}.xml`;
      const entry = archive.file(entryName);
      expect(entry).not.toBeNull();
      const xml = await entry!.async("string");
      const incompressibleText = randomBytes(600_000).toString("base64");
      archive.file(entryName, xml.replace("</a:t>", `${incompressibleText}</a:t>`));
    }
    await fs.writeFile(
      path.join(fixture.workspaceRoot, "character-budget.pptx"),
      await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    );
    const bounded = await fixture.runtime.executeManualTool(
      "read_presentation",
      { path: "character-budget.pptx", cursor: "0", maxSlides: 3 },
      fixture.sessionId,
    );
    const boundedContent = readBody(bounded);
    expect(bounded.success, bounded.output).toBe(true);
    expect(bounded.output.length).toBeLessThanOrEqual(PHASE20_LIMITS.maxModelVisibleChars);
    expect(boundedContent.returnedSlides).toBeGreaterThan(0);
    expect(boundedContent.returnedSlides).toBeLessThan(3);
    expect(boundedContent.truncation).toMatchObject({
      truncated: true,
      reason: "character_limit",
      nextCursor: expect.any(String),
    });
    expect(boundedContent.warnings).toContainEqual(expect.objectContaining({ code: "output_truncated" }));
  });

  it("returns structured failures for damaged, format-spoofed, and oversized PPTX input", async () => {
    const fixture = await createRuntime();
    await fs.writeFile(path.join(fixture.workspaceRoot, "damaged.pptx"), Buffer.from("PK\u0003\u0004damaged"));
    const spoof = new JSZip();
    spoof.file(
      "[Content_Types].xml",
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    spoof.file("word/document.xml", "<w:document/>");
    await fs.writeFile(
      path.join(fixture.workspaceRoot, "spoofed.pptx"),
      await spoof.generateAsync({ type: "nodebuffer" }),
    );
    const oversizedPath = path.join(fixture.workspaceRoot, "oversized.pptx");
    const oversized = await fs.open(oversizedPath, "w");
    try {
      await oversized.truncate(PHASE20_LIMITS.presentation.maxInputBytes + 1);
    } finally {
      await oversized.close();
    }

    for (const [fileName, expectedCode] of [
      ["damaged.pptx", /invalid|damaged/iu],
      ["spoofed.pptx", /format|spoof/iu],
      ["oversized.pptx", /too_large|oversized|size/iu],
    ] as const) {
      const result = await fixture.runtime.executeManualTool(
        "read_presentation",
        { path: fileName },
        fixture.sessionId,
      );
      expect(result.success, fileName).toBe(false);
      expect(result.structuredContent).toMatchObject({
        kind: "presentation_error",
        format: expect.stringMatching(/pptx|unknown/u),
        code: expect.stringMatching(expectedCode),
        error: { type: "command_failed", retryable: false, toolName: "read_presentation" },
      });
    }
  });

  it("rejects strict-schema violations before reading or writing", async () => {
    const fixture = await createRuntime();
    await writeSafeDeck(fixture, "schema-source.pptx");
    const validPresentation = representativePresentation("pixel.png");
    const cases: Array<[string, unknown]> = [
      ["read_presentation", { path: "schema-source.pptx", cursor: "not-a-cursor" }],
      ["read_presentation", { path: "schema-source.pptx", maxSlides: 0 }],
      ["read_presentation", { path: "schema-source.pptx", extra: true }],
      ["write_presentation", { outputPath: "empty.pptx", presentation: { slides: [] } }],
      ["write_presentation", { outputPath: "extra.pptx", presentation: validPresentation, extra: true }],
      ["write_presentation", {
        outputPath: "bad-bounds.pptx",
        presentation: {
          slides: [{ elements: [{ type: "text", text: "bad", bounds: { x: -1, y: 0, width: 1, height: 1 } }] }],
        },
      }],
      ["write_presentation", {
        outputPath: "unsupported.pptx",
        presentation: {
          slides: [{ elements: [{ type: "video", source: "movie.mp4" }] }],
        },
      }],
    ];
    for (const [toolName, args] of cases) {
      const result = await fixture.runtime.executeManualTool(toolName, args, fixture.sessionId);
      expect(result, `${toolName}: ${JSON.stringify(args).slice(0, 120)}`).toMatchObject({
        success: false,
        structuredContent: { error: { type: "invalid_arguments", retryable: false, toolName } },
      });
    }
  });

  it("guards workspace, protected, and junction image paths and rolls back an invalid image", async () => {
    const fixture = await createRuntime();
    for (const [source, expectedType] of [
      ["../outside.png", "invalid_path"],
      [".deep-mix/api-key-library/blocked.png", "sandbox_denied"],
    ] as const) {
      const result = await fixture.runtime.executeManualTool(
        "write_presentation",
        { outputPath: `blocked-${expectedType}.pptx`, presentation: representativePresentation(source) },
        fixture.sessionId,
      );
      expect(result).toMatchObject({
        success: false,
        structuredContent: { error: { type: expectedType, retryable: false, toolName: "write_presentation" } },
      });
    }

    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase20-presentation-outside-"));
    temporaryRoots.push(outsideRoot);
    await fs.writeFile(path.join(outsideRoot, "outside.png"), onePixelPng);
    await fs.symlink(outsideRoot, path.join(fixture.workspaceRoot, "outside-link"), "junction");
    const linked = await fixture.runtime.executeManualTool(
      "write_presentation",
      { outputPath: "linked.pptx", presentation: representativePresentation("outside-link/outside.png") },
      fixture.sessionId,
    );
    expect(linked).toMatchObject({
      success: false,
      structuredContent: { error: { type: "invalid_path", retryable: false, toolName: "write_presentation" } },
    });

    const outputPath = path.join(fixture.workspaceRoot, "existing-invalid-image.pptx");
    const original = Buffer.from("retain exact previous presentation bytes\u0000\u00ff", "latin1");
    await fs.writeFile(outputPath, original);
    await fs.writeFile(path.join(fixture.workspaceRoot, "fake.png"), "not a PNG", "utf8");
    const invalidImage = await fixture.runtime.executeManualTool(
      "write_presentation",
      {
        outputPath: "existing-invalid-image.pptx",
        overwrite: true,
        presentation: representativePresentation("fake.png"),
      },
      fixture.sessionId,
    );
    expect(invalidImage).toMatchObject({
      success: false,
      structuredContent: {
        error: { type: "invalid_arguments", retryable: false, toolName: "write_presentation" },
      },
    });
    expect(JSON.stringify(invalidImage.structuredContent)).toMatch(/source|image/iu);
    expect(await fs.readFile(outputPath)).toEqual(original);
  });

  it("requires overwrite and restores the exact previous PPTX bytes through checkpointed undo", async () => {
    const fixture = await createRuntime();
    await fs.writeFile(path.join(fixture.workspaceRoot, "pixel.png"), onePixelPng);
    const outputPath = path.join(fixture.workspaceRoot, "existing.pptx");
    const original = Buffer.from("original presentation binary bytes\u0000\u00ff", "latin1");
    await fs.writeFile(outputPath, original);

    const denied = await fixture.runtime.executeManualTool(
      "write_presentation",
      { outputPath: "existing.pptx", presentation: representativePresentation("pixel.png") },
      fixture.sessionId,
    );
    expect(denied).toMatchObject({
      success: false,
      structuredContent: { error: { type: "invalid_arguments", fieldPath: "/overwrite" } },
    });
    expect(await fs.readFile(outputPath)).toEqual(original);

    const written = await fixture.runtime.executeManualTool(
      "write_presentation",
      { outputPath: "existing.pptx", overwrite: true, presentation: representativePresentation("pixel.png") },
      fixture.sessionId,
    );
    const body = writeBody(written);
    expect(written.success, written.output).toBe(true);
    expect(body).toMatchObject({ checkpointId: expect.any(String), undoAvailable: true });
    expect(await fs.readFile(outputPath)).not.toEqual(original);

    const undone = await fixture.runtime.executeManualTool(
      "undo",
      { checkpointId: body.checkpointId, mode: "code" },
      fixture.sessionId,
    );
    expect(undone.success, undone.output).toBe(true);
    expect(await fs.readFile(outputPath)).toEqual(original);
  });

  it("declares stable schemas, permissions, capability probes, and presentation selection metadata", async () => {
    const fixture = await createRuntime();
    await fixture.runtime.initialize();
    const definitions = fixture.runtime.listRegisteredToolDefinitions();
    const read = definitions.find((tool) => tool.name === "read_presentation");
    const write = definitions.find((tool) => tool.name === "write_presentation");
    expect(read).toMatchObject({
      name: "read_presentation",
      readOnly: true,
      permissionCategory: "read_only",
      sideEffectLevel: "none",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: expect.any(Object),
          cursor: expect.any(Object),
          maxSlides: expect.objectContaining({
            minimum: 1,
            maximum: PHASE20_LIMITS.presentation.maxSlides,
          }),
        },
      },
      selection: {
        attachmentExtensions: expect.arrayContaining([".pptx"]),
        mimeTypes: expect.arrayContaining([pptxMimeType]),
        keywords: expect.any(Array),
        keywordGroups: expect.any(Array),
      },
    });
    expect(write).toMatchObject({
      name: "write_presentation",
      readOnly: false,
      permissionCategory: "write_file",
      sideEffectLevel: "high",
      checkpoint: { mode: "before_write", scope: "pre_tool_write" },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["outputPath", "presentation"],
        properties: {
          outputPath: expect.any(Object),
          overwrite: { type: "boolean" },
          presentation: expect.objectContaining({
            type: "object",
            properties: expect.objectContaining({
              slides: expect.objectContaining({ minItems: 1, maxItems: PHASE20_LIMITS.presentation.maxSlides }),
            }),
          }),
        },
      },
      selection: {
        keywords: expect.any(Array),
        keywordGroups: expect.any(Array),
      },
    });

    expect(readPresentationTool.getAvailability).toEqual(expect.any(Function));
    expect(writePresentationTool.getAvailability).toEqual(expect.any(Function));
    expect(fixture.runtime.listAvailableToolDefinitions().map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["read_presentation", "write_presentation"]),
    );
    expect(fixture.runtime.selectToolsForTurn({ attachmentExtensions: [".pptx"] }).definitions.map((tool) => tool.name))
      .toContain("read_presentation");
    expect(fixture.runtime.selectToolsForTurn({ prompt: "Read this PPTX presentation." }).definitions.map((tool) => tool.name))
      .toContain("read_presentation");
    expect(fixture.runtime.selectToolsForTurn({ prompt: "Create a basic PowerPoint presentation." }).definitions.map((tool) => tool.name))
      .toContain("write_presentation");
  });
});
