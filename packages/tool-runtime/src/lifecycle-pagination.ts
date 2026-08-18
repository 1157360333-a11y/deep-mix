import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";

export const LIFECYCLE_DEFAULT_LIMIT = 50;
export const LIFECYCLE_MAX_LIMIT = 200;

interface LifecycleCursorPayload {
  version: 1;
  scope: string;
  workspaceId: string;
  sessionId: string;
  filterFingerprint: string;
  lastKey: string;
}

export interface LifecycleCursorContext {
  scope: string;
  workspaceId: string;
  sessionId: string;
  filters: unknown;
  integrityKey: Uint8Array;
}

function invalidCursor(message: string): Error {
  return Object.assign(new Error(message), { code: "ERR_TOOL_INVALID_ARGUMENTS" });
}

function decodeCanonicalBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw invalidCursor("Lifecycle cursor contains non-canonical base64url data.");
  }
  return decoded;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function lifecycleFilterFingerprint(filters: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(filters)))
    .digest("base64url")
    .slice(0, 24);
}

function cursorKey(context: LifecycleCursorContext): Buffer {
  if (!(context.integrityKey instanceof Uint8Array) || context.integrityKey.byteLength < 32) {
    throw invalidCursor("Lifecycle cursor integrity key is unavailable.");
  }
  return createHmac("sha256", context.integrityKey)
    .update("deep-mix:lifecycle-cursor:v1\0", "utf8")
    .update(context.workspaceId, "utf8")
    .update("\0", "utf8")
    .update(context.sessionId, "utf8")
    .update("\0", "utf8")
    .update(context.scope, "utf8")
    .digest();
}

export function encodeLifecycleCursor(context: LifecycleCursorContext, lastKey: string): string {
  const payload: LifecycleCursorPayload = {
    version: 1,
    scope: context.scope,
    workspaceId: context.workspaceId,
    sessionId: context.sessionId,
    filterFingerprint: lifecycleFilterFingerprint(context.filters),
    lastKey,
  };
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cursorKey(context), nonce);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `lc1.${nonce.toString("base64url")}.${encrypted.toString("base64url")}.${tag.toString("base64url")}`;
}

export function decodeLifecycleCursor(
  cursor: string | undefined,
  context: LifecycleCursorContext,
): string | undefined {
  if (!cursor) return undefined;
  if (cursor.length > 4_096 || !/^lc1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/u.test(cursor)) {
    throw invalidCursor("Lifecycle cursor is malformed.");
  }
  let payload: Partial<LifecycleCursorPayload>;
  try {
    const [, nonceText, encryptedText, tagText] = cursor.split(".");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      cursorKey(context),
      decodeCanonicalBase64Url(nonceText!),
    );
    decipher.setAuthTag(decodeCanonicalBase64Url(tagText!));
    const decrypted = Buffer.concat([
      decipher.update(decodeCanonicalBase64Url(encryptedText!)),
      decipher.final(),
    ]);
    payload = JSON.parse(decrypted.toString("utf8")) as Partial<LifecycleCursorPayload>;
  } catch {
    throw invalidCursor("Lifecycle cursor failed its integrity check.");
  }
  if (
    payload.version !== 1 ||
    payload.scope !== context.scope ||
    payload.workspaceId !== context.workspaceId ||
    payload.sessionId !== context.sessionId ||
    payload.filterFingerprint !== lifecycleFilterFingerprint(context.filters) ||
    typeof payload.lastKey !== "string" ||
    payload.lastKey.length === 0 ||
    payload.lastKey.length > 8_192
  ) {
    throw invalidCursor("Lifecycle cursor does not match the current workspace, session, or filters.");
  }
  return payload.lastKey;
}

export function paginateLifecycleItems<T>(input: {
  items: readonly T[];
  cursor?: string;
  limit?: number;
  context: LifecycleCursorContext;
  stableKey: (item: T) => string;
}): {
  items: T[];
  limit: number;
  returned: number;
  hasMore: boolean;
  nextCursor?: string;
} {
  const limit = Math.min(
    LIFECYCLE_MAX_LIMIT,
    Math.max(1, Math.trunc(input.limit ?? LIFECYCLE_DEFAULT_LIMIT)),
  );
  const sorted = [...input.items].sort((left, right) =>
    input.stableKey(right).localeCompare(input.stableKey(left)),
  );
  const lastKey = decodeLifecycleCursor(input.cursor, input.context);
  const start = lastKey
    ? sorted.findIndex((item) => input.stableKey(item).localeCompare(lastKey) < 0)
    : 0;
  const safeStart = start < 0 ? sorted.length : start;
  const items = sorted.slice(safeStart, safeStart + limit);
  const hasMore = safeStart + items.length < sorted.length;
  return {
    items,
    limit,
    returned: items.length,
    hasMore,
    nextCursor: hasMore && items.length > 0
      ? encodeLifecycleCursor(input.context, input.stableKey(items.at(-1)!))
      : undefined,
  };
}
