import { randomUUID } from "node:crypto";

import type { ToolCall } from "../../shared-schema/src/index.js";

const DSML_TOKEN = String.raw`(?:｜\s*｜|\|\s*\|)\s*DSML\s*(?:｜\s*｜|\|\s*\|)`;
const DSML_TOOL_CALL_START = new RegExp(String.raw`<\s*${DSML_TOKEN}\s*tool_calls\s*>`, "iu");
const DSML_TOOL_CALL_END = new RegExp(String.raw`<\/\s*${DSML_TOKEN}\s*tool_calls\s*>`, "iu");
const DSML_TOOL_CALL_BLOCK = new RegExp(
  String.raw`<\s*${DSML_TOKEN}\s*tool_calls\s*>([\s\S]*?)<\/\s*${DSML_TOKEN}\s*tool_calls\s*>`,
  "giu",
);
const DSML_INVOKE_BLOCK = new RegExp(
  String.raw`<\s*${DSML_TOKEN}\s*invoke\b([^>]*)>([\s\S]*?)<\/\s*${DSML_TOKEN}\s*invoke\s*>`,
  "giu",
);
const DSML_PARAMETER_BLOCK = new RegExp(
  String.raw`<\s*${DSML_TOKEN}\s*parameter\b([^>]*)>([\s\S]*?)<\/\s*${DSML_TOKEN}\s*parameter\s*>`,
  "giu",
);
const DSML_MARKER_PREFIXES = [
  "<｜｜DSML｜｜tool_calls>",
  "<||DSML||tool_calls>",
];

function readAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, "iu").exec(attributes);
  return match?.[2];
}

function decodeDsmlParameter(rawValue: string, forceString: boolean): unknown {
  const value = rawValue.trim();
  if (forceString) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseDsmlCalls(body: string): ToolCall[] {
  const parsedCalls: ToolCall[] = [];
  for (const invokeMatch of body.matchAll(DSML_INVOKE_BLOCK)) {
    const name = readAttribute(invokeMatch[1] ?? "", "name")?.trim();
    if (!name) continue;
    const args: Record<string, unknown> = {};
    for (const parameterMatch of (invokeMatch[2] ?? "").matchAll(DSML_PARAMETER_BLOCK)) {
      const attributes = parameterMatch[1] ?? "";
      const parameterName = readAttribute(attributes, "name")?.trim();
      if (!parameterName) continue;
      args[parameterName] = decodeDsmlParameter(
        parameterMatch[2] ?? "",
        readAttribute(attributes, "string")?.toLowerCase() === "true",
      );
    }
    const rawArguments = JSON.stringify(args);
    parsedCalls.push({
      id: `dsml-${randomUUID()}`,
      name,
      arguments: args,
      rawArguments,
    });
  }
  return parsedCalls;
}

function callSignature(call: ToolCall): string {
  return `${call.name}\u0000${call.rawArguments}`;
}

/**
 * Converts tool protocol text emitted by some OpenAI-compatible providers into
 * native ToolCall records. Protocol blocks are always removed from user-visible
 * content, including when the provider also returned native tool calls.
 */
export function normalizeAssistantToolCalls(content: string, existingToolCalls: ToolCall[]): {
  content: string;
  toolCalls: ToolCall[];
} {
  const parsedCalls: ToolCall[] = [];
  let protocolDetected = false;
  let normalizedContent = content.replace(DSML_TOOL_CALL_BLOCK, (_block, body: string) => {
    protocolDetected = true;
    parsedCalls.push(...parseDsmlCalls(body));
    return "";
  });

  const incompleteStart = DSML_TOOL_CALL_START.exec(normalizedContent);
  if (incompleteStart) {
    protocolDetected = true;
    normalizedContent = normalizedContent.slice(0, incompleteStart.index);
  }
  if (!protocolDetected) return { content, toolCalls: existingToolCalls };

  const signatures = new Set(existingToolCalls.map(callSignature));
  const toolCalls = [...existingToolCalls];
  for (const call of parsedCalls) {
    const signature = callSignature(call);
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    toolCalls.push(call);
  }
  return { content: normalizedContent.trim(), toolCalls };
}

function compactMarker(value: string): string {
  return value.replace(/\s+/gu, "");
}

function couldBeMarkerPrefix(value: string): boolean {
  const compact = compactMarker(value);
  return DSML_MARKER_PREFIXES.some((marker) => marker.startsWith(compact));
}

/** Incrementally hides DSML blocks without delaying ordinary streamed text. */
export class DsmlTextStreamFilter {
  private buffer = "";

  private insideProtocol = false;

  public push(chunk: string): string {
    this.buffer += chunk;
    let visible = "";

    while (this.buffer) {
      if (this.insideProtocol) {
        const end = DSML_TOOL_CALL_END.exec(this.buffer);
        if (end) {
          this.buffer = this.buffer.slice(end.index + end[0].length);
          this.insideProtocol = false;
          continue;
        }
        if (this.buffer.length > 160) this.buffer = this.buffer.slice(-160);
        break;
      }

      const start = DSML_TOOL_CALL_START.exec(this.buffer);
      if (start) {
        visible += this.buffer.slice(0, start.index);
        this.buffer = this.buffer.slice(start.index + start[0].length);
        this.insideProtocol = true;
        continue;
      }

      const possibleStart = this.buffer.lastIndexOf("<");
      if (possibleStart >= 0 && couldBeMarkerPrefix(this.buffer.slice(possibleStart))) {
        visible += this.buffer.slice(0, possibleStart);
        this.buffer = this.buffer.slice(possibleStart);
      } else {
        visible += this.buffer;
        this.buffer = "";
      }
      break;
    }
    return visible;
  }

  public finish(): string {
    if (this.insideProtocol || couldBeMarkerPrefix(this.buffer)) {
      this.buffer = "";
      return "";
    }
    const visible = this.buffer;
    this.buffer = "";
    return visible;
  }
}
