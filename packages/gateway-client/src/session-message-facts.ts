/** Facts read out of a single session message, independent of any projection state. */

import { asNullableRecord as readRecord } from "@openclaw/normalization-core/record-coerce";

export type SessionMessageEnvelope = {
  messageId?: unknown;
  messageSeq?: unknown;
  clientRunId?: unknown;
  runId?: unknown;
  idempotencyKey?: unknown;
};

export type SessionMessageIdentity = {
  role: string;
  id: string | null;
  sequence: number | null;
  idempotencyKey: string | null;
  runId: string | null;
  isImported: boolean;
  externalSource: string | null;
};

export function readNonemptyString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function readPositiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** History and status markers carry transcript order even when they have no chat role. */
export function readSessionMessageSequence(
  message: unknown,
  envelope?: SessionMessageEnvelope,
): number | null {
  const metadata = readRecord(readRecord(message)?.["__openclaw"]);
  return readPositiveSafeInteger(metadata?.seq) ?? readPositiveSafeInteger(envelope?.messageSeq);
}

/** Run ownership normalizes a user-turn suffix without changing its persisted send key. */
export function normalizeSessionProjectionRunId(value: unknown): string | null {
  const runId = readNonemptyString(value);
  return runId?.endsWith(":user") ? runId.slice(0, -":user".length) || null : runId;
}

/** Persisted transcript facts win over envelope projections and provider-local import IDs. */
export function readSessionMessageIdentity(
  message: unknown,
  envelope?: SessionMessageEnvelope,
): SessionMessageIdentity | null {
  const record = readRecord(message);
  const role = readNonemptyString(record?.role)?.toLowerCase();
  if (!record || !role) {
    return null;
  }
  const metadata = readRecord(record["__openclaw"]);
  const importedFrom = readNonemptyString(metadata?.importedFrom);
  const cliSessionId = readNonemptyString(metadata?.cliSessionId);
  const externalId = readNonemptyString(metadata?.externalId);
  const idempotencyKey =
    readNonemptyString(metadata?.idempotencyKey) ??
    readNonemptyString(record.idempotencyKey) ??
    readNonemptyString(envelope?.idempotencyKey) ??
    readNonemptyString(envelope?.clientRunId);
  return {
    role,
    id: readNonemptyString(metadata?.id) ?? readNonemptyString(envelope?.messageId),
    sequence: readSessionMessageSequence(message, envelope),
    idempotencyKey,
    runId:
      normalizeSessionProjectionRunId(idempotencyKey) ??
      normalizeSessionProjectionRunId(envelope?.runId),
    isImported: Boolean(importedFrom || cliSessionId || externalId),
    // Imported IDs belong to their provider and CLI session, never the native ID namespace.
    externalSource:
      importedFrom && cliSessionId && externalId
        ? JSON.stringify([importedFrom, cliSessionId, externalId])
        : null,
  };
}

/** Local turns have no durable transcript metadata beyond their own optional send key. */
export function isLocallyOptimisticSessionMessage(message: unknown): boolean {
  const identity = readSessionMessageIdentity(message);
  if (!identity || (identity.role !== "user" && identity.role !== "assistant")) {
    return false;
  }
  const metadata = readRecord(readRecord(message)?.["__openclaw"]);
  return !metadata || Object.keys(metadata).every((key) => key === "idempotencyKey");
}

export function readComparableMessageContent(message: unknown): string | null {
  if (typeof message === "string") {
    return message.trim() ? `${message.trim()}\0` : null;
  }
  const record = readRecord(message);
  if (!record) {
    return null;
  }
  const content = record.content;
  let text: string | null = null;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((block) => {
        const entry = readRecord(block);
        if (entry) {
          return entry.type === "text" ? (readNonemptyString(entry.text) ?? "") : "";
        }
        return typeof block === "string" ? block : "";
      })
      .join("\n");
  }
  const media = readRecord(record["__openclaw"])?.media;
  let mediaKey = "";
  if (Array.isArray(media) && media.length > 0) {
    try {
      mediaKey = JSON.stringify(media);
    } catch {
      return null;
    }
  }
  const key = `${(text ?? "").trim()}\0${mediaKey}`;
  return key === "\0" ? null : key;
}

export function sameVisibleMessageContent(left: unknown, right: unknown): boolean {
  const key = readComparableMessageContent(left);
  return key !== null && key === readComparableMessageContent(right);
}

export function hasDisplayableSessionMessage(message: unknown): boolean {
  if (typeof message === "string") {
    return message.trim().length > 0;
  }
  const record = readRecord(message);
  if (!record) {
    return false;
  }
  const displayableBlocks =
    Array.isArray(record.content) &&
    record.content.some((block) => {
      const entry = readRecord(block);
      return entry
        ? entry.type !== "text" || readNonemptyString(entry.text) !== null
        : typeof block === "string" && block.trim().length > 0;
    });
  const media = readRecord(record["__openclaw"])?.media;
  return Boolean(
    (typeof record.content === "string" && record.content.trim()) ||
    displayableBlocks ||
    (Array.isArray(media) && media.length > 0),
  );
}

export function readSessionProjectionFinalMessageIdentity(message: unknown): string | null {
  if (!hasDisplayableSessionMessage(message)) {
    return null;
  }
  const identity = readSessionMessageIdentity(message);
  if (identity?.externalSource) {
    return `import:${identity.role}:${identity.externalSource}`;
  }
  if (identity?.id && !identity.isImported) {
    return `id:${identity.role}:${identity.id}`;
  }
  if (identity?.sequence !== null && identity?.sequence !== undefined) {
    return `seq:${identity.role}:${identity.sequence}`;
  }
  const record = readRecord(message);
  const metadata = readRecord(record?.["__openclaw"]);
  try {
    return `content:${JSON.stringify([
      identity?.role ?? "assistant",
      typeof message === "string" ? message : (record?.content ?? null),
      metadata?.media ?? null,
      identity?.isImported
        ? [
            metadata?.importedFrom ?? null,
            metadata?.cliSessionId ?? null,
            metadata?.externalId ?? null,
          ]
        : null,
    ])}`;
  } catch {
    return null;
  }
}
