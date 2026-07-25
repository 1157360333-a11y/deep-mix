import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  createDesktopMessageMetadata,
  parseLegacyDesktopAttachmentPrompt,
  readDesktopMessagePresentation,
} from "../apps/desktop/src/shared/desktop-message-attachments.js";
import { isChatViewportNearBottom } from "../apps/desktop/src/renderer/chat-scroll.js";
import { buildDisplayHistory } from "../apps/desktop/src/renderer/display-history.js";
import type { MessageRecord } from "../packages/shared-schema/src/index.js";

function userMessage(content: string, metadata?: Record<string, unknown>): MessageRecord {
  return {
    recordType: "message",
    messageId: "user-1",
    sessionId: "session-1",
    turnId: "turn-1",
    role: "user",
    createdAt: "2026-07-18T12:00:00.000Z",
    content,
    metadata,
  };
}

describe("desktop chat scrolling", () => {
  it("follows streaming output only while the viewport remains near the bottom", () => {
    expect(isChatViewportNearBottom({ scrollTop: 900, clientHeight: 500, scrollHeight: 1450 })).toBe(true);
    expect(isChatViewportNearBottom({ scrollTop: 650, clientHeight: 500, scrollHeight: 1450 })).toBe(false);
  });

  it("does not use smooth forced scrolling for streaming updates", () => {
    const source = readFileSync(
      new URL("../apps/desktop/src/renderer/components/ChatPanel.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("else if (isChatViewportNearBottom(viewport)) followLatestRef.current = true");
    expect(source).toContain("if (movedUp) followLatestRef.current = false");
    expect(source).toContain('behavior: "auto"');
    expect(source).not.toContain('behavior: busy ? "smooth"');
  });
});

describe("desktop sent-message presentation", () => {
  const image = {
    id: "image-1",
    name: "screen.png",
    path: ".deep-mix/desktop-attachments/screen.png",
    ref: "file://.deep-mix/desktop-attachments/screen.png" as const,
    workspaceRoot: "C:/workspace",
    size: 2048,
    mimeType: "image/png",
    kind: "image" as const,
    previewUrl: "data:image/png;base64,preview-only",
  };

  it("keeps the original user text and attachment descriptors separate", () => {
    const metadata = createDesktopMessageMetadata("请检查截图", [image]);
    const presentation = readDesktopMessagePresentation("provider prompt", metadata);

    expect(presentation).toMatchObject({ prompt: "请检查截图", source: "metadata" });
    expect(presentation?.attachments).toHaveLength(1);
    expect(presentation?.attachments[0]).not.toHaveProperty("previewUrl");

    const display = buildDisplayHistory([userMessage("provider prompt", {
      ...metadata,
      desktopAttachments: [image],
    })]);
    expect(display[0]).toMatchObject({
      role: "user",
      content: "请检查截图",
      attachments: [{ name: "screen.png", previewUrl: image.previewUrl }],
    });
  });

  it("upgrades legacy protocol text without displaying it as Markdown", () => {
    const persisted = [
      "请分析附件",
      "",
      "[Desktop attachments]",
      "- screen.png (image, image/png): file://.deep-mix/desktop-attachments/screen.png",
      "Use these local files as task inputs.",
    ].join("\n");
    const presentation = parseLegacyDesktopAttachmentPrompt(persisted);
    expect(presentation).toMatchObject({
      prompt: "请分析附件",
      source: "legacy_prompt",
      attachments: [{ name: "screen.png", kind: "image" }],
    });
    expect(buildDisplayHistory([userMessage(persisted)])[0]?.content).toBe("请分析附件");
  });

  it("renders user content as plain selectable text and exposes copy actions for both roles", () => {
    const source = readFileSync(
      new URL("../apps/desktop/src/renderer/components/ChatPanel.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('<PlainMessageBody content={turn.user.content} />');
    expect(source).toContain('onCopy(turn.user!.content, "消息")');
    expect(source).toContain('onCopy(turn.final!.content, "回复")');
    expect(source).toContain("<SentAttachments attachments={turn.user.attachments} />");
  });

  it("clears the composer attachment state before awaiting the agent run", () => {
    const source = readFileSync(
      new URL("../apps/desktop/src/renderer/App.tsx", import.meta.url),
      "utf8",
    );
    const clearIndex = source.indexOf("setAttachments([]);", source.indexOf("const outgoingAttachments = attachments;"));
    const sendIndex = source.indexOf("await runtime.sendPrompt", clearIndex);
    expect(clearIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(clearIndex);
  });
});

describe("desktop preference feedback", () => {
  it("routes every renderer zoom entry through the percentage indicator", () => {
    const appSource = readFileSync(
      new URL("../apps/desktop/src/renderer/App.tsx", import.meta.url),
      "utf8",
    );
    const mainSource = readFileSync(
      new URL("../apps/desktop/src/main/index.ts", import.meta.url),
      "utf8",
    );
    const styles = readFileSync(
      new URL("../apps/desktop/src/renderer/styles/tokens.css", import.meta.url),
      "utf8",
    );

    expect(appSource).toContain('const applyZoom = useCallback(async (action: "in" | "out" | "reset")');
    expect(appSource).toContain('className="zoom-indicator"');
    expect(appSource).toContain("Math.round(zoomFactor * 100)");
    expect(appSource.match(/runtime\.setZoom\(/gu)).toHaveLength(1);
    expect(mainSource).not.toContain('webContents.on("before-input-event"');
    expect(styles).toContain(".zoom-indicator { position: fixed;");
  });

  it("adds reply-style selection and a taller project-name input", () => {
    const settingsSource = readFileSync(
      new URL("../apps/desktop/src/renderer/components/RightPanel.tsx", import.meta.url),
      "utf8",
    );
    const appSource = readFileSync(
      new URL("../apps/desktop/src/renderer/App.tsx", import.meta.url),
      "utf8",
    );
    const styles = readFileSync(
      new URL("../apps/desktop/src/renderer/styles/tokens.css", import.meta.url),
      "utf8",
    );

    expect(settingsSource).toContain('value={settings.replyStyle}');
    expect(settingsSource).toContain('value: "pragmatic", label: "务实"');
    expect(settingsSource).toContain('value: "friendly", label: "亲和"');
    expect(settingsSource).toContain('description: "冷静、严谨"');
    expect(settingsSource).toContain('description: "温暖、协作"');
    expect(settingsSource).not.toContain("不使用 emoji");
    expect(settingsSource).not.toContain("适度放宽表达");
    expect(appSource).toContain('" project-rename-dialog"');
    expect(styles).toContain(".project-rename-dialog .dialog-text-field input");
    expect(styles).toContain("min-height: 40px");
    expect(styles).toContain("font-size: 12px");
    expect(styles).not.toContain(".project-rename-dialog .product-dialog__header");
    expect(styles).not.toContain(".project-rename-dialog .product-dialog__body");
    expect(styles).not.toContain(".project-rename-dialog .product-dialog__footer");
  });

  it("keeps the first prompt out of the title and schedules AI naming after the first result", () => {
    const mainSource = readFileSync(
      new URL("../apps/desktop/src/main/index.ts", import.meta.url),
      "utf8",
    );

    expect(mainSource).toContain('title: "新任务"');
    expect(mainSource).toContain('titleSource: "placeholder"');
    expect(mainSource).toContain("maybeGenerateDesktopSessionTitle(context, result.sessionId");
    expect(mainSource).toContain('titleSource: "generated"');
  });
});
