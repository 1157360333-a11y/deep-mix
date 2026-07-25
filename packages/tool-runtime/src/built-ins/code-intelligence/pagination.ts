import { createHash } from "node:crypto";

const CURSOR_VERSION = 1 as const;
const MAX_CURSOR_CHARS = 4_096;
export const ARTIFACT_URI_RESERVE_CHARS = 2_048;

interface CursorPayload {
  v: typeof CURSOR_VERSION;
  workspaceId: string;
  tool: string;
  indexVersion: string;
  requestDigest: string;
  offset: number;
}

export interface CursorBinding extends Omit<CursorPayload, "v" | "offset"> {}

export class ResultPageBudgetError extends Error {
  public constructor(
    public readonly requiredChars: number,
    public readonly maxResultChars: number,
  ) {
    super(
      `maxResultChars=${maxResultChars} cannot contain one complete authoritative item; ` +
      `at least ${requiredChars} characters are required.`,
    );
    this.name = "ResultPageBudgetError";
  }
}

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export function createRequestDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function encodeCursor(binding: CursorBinding, offset: number): string {
  const payload: CursorPayload = { v: CURSOR_VERSION, ...binding, offset };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined, expected: CursorBinding): number {
  if (!cursor) return 0;
  if (cursor.length > MAX_CURSOR_CHARS) throw new Error("Result cursor is invalid.");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Result cursor is invalid.");
  }
  const payload = value as Partial<CursorPayload>;
  if (
    payload.v !== CURSOR_VERSION ||
    payload.workspaceId !== expected.workspaceId ||
    payload.tool !== expected.tool ||
    payload.indexVersion !== expected.indexVersion ||
    payload.requestDigest !== expected.requestDigest ||
    !Number.isSafeInteger(payload.offset) ||
    (payload.offset ?? -1) < 0
  ) {
    throw new Error("Result cursor is invalid, stale, or belongs to a different workspace or query.");
  }
  return payload.offset!;
}

export function paginateAuthoritativeItems<T, TEnvelope>(input: {
  allItems: readonly T[];
  cursor?: string;
  binding: CursorBinding;
  maxItems: number;
  maxResultChars: number;
  artifactReserveChars?: number;
  buildEnvelope(
    items: T[],
    page: { cursor?: string; nextCursor?: string; hasMore: boolean; truncated: boolean },
  ): TEnvelope;
}): { envelope: TEnvelope; offset: number; nextOffset: number; items: T[] } {
  const offset = decodeCursor(input.cursor, input.binding);
  if (offset > input.allItems.length) throw new Error("Result cursor offset is no longer valid.");
  const reserve = input.artifactReserveChars ?? ARTIFACT_URI_RESERVE_CHARS;
  const selected: T[] = [];
  const emptyHasMore = offset < input.allItems.length;
  const emptyEnvelope = input.buildEnvelope([], {
    cursor: input.cursor,
    nextCursor: emptyHasMore ? encodeCursor(input.binding, offset) : undefined,
    hasMore: emptyHasMore,
    truncated: emptyHasMore,
  });
  const emptyRequiredChars = JSON.stringify(emptyEnvelope, null, 2).length + reserve;
  if (emptyRequiredChars > input.maxResultChars) {
    throw new ResultPageBudgetError(emptyRequiredChars, input.maxResultChars);
  }
  let nextOffset = offset;
  while (nextOffset < input.allItems.length && selected.length < input.maxItems) {
    const trial = [...selected, input.allItems[nextOffset]!];
    const trialOffset = nextOffset + 1;
    const hasMore = trialOffset < input.allItems.length;
    const nextCursor = hasMore ? encodeCursor(input.binding, trialOffset) : undefined;
    const envelope = input.buildEnvelope(trial, {
      cursor: input.cursor,
      nextCursor,
      hasMore,
      truncated: hasMore,
    });
    const requiredChars = JSON.stringify(envelope, null, 2).length + reserve;
    if (requiredChars > input.maxResultChars) {
      if (selected.length === 0) {
        throw new ResultPageBudgetError(requiredChars, input.maxResultChars);
      }
      break;
    }
    selected.push(input.allItems[nextOffset]!);
    nextOffset = trialOffset;
  }
  const hasMore = nextOffset < input.allItems.length;
  const nextCursor = hasMore ? encodeCursor(input.binding, nextOffset) : undefined;
  return {
    envelope: input.buildEnvelope(selected, {
      cursor: input.cursor,
      nextCursor,
      hasMore,
      truncated: hasMore,
    }),
    offset,
    nextOffset,
    items: selected,
  };
}
