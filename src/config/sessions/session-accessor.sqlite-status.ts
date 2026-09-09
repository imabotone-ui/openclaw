import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionEntryStatus,
  SessionEntrySummary,
} from "./session-accessor.sqlite-contract.js";
import {
  projectSqliteSessionOwner,
  type SqliteSessionOwnerRow,
} from "./session-accessor.sqlite-owner-projection.js";
import { projectSqliteSessionParticipantsBatch } from "./session-accessor.sqlite-participant-projection.js";
import {
  hasValidSessionEntryIdentity,
  parseSqliteSessionEntryRecord,
} from "./session-entry-json.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import type { SessionEntry } from "./types.js";

type SessionStatusDatabase = Pick<OpenClawAgentKyselyDatabase, "session_nodes">;

export function normalizeStatus(value: unknown): SessionEntryStatus | null {
  return value === "running" ||
    value === "done" ||
    value === "failed" ||
    value === "killed" ||
    value === "timeout"
    ? value
    : null;
}

export { hasValidSessionEntryIdentity };

export function parseSessionEntryJson(
  row: {
    current_session_id?: string;
    entry_json: string;
    updated_at?: number;
  } & SqliteSessionOwnerRow,
): SessionEntry | null {
  const record = parseSqliteSessionEntryRecord(row);
  return record ? projectSqliteSessionOwner(projectCanonicalSessionEntryShape(record), row) : null;
}

export function readSessionEntriesByStatus(
  database: OpenClawAgentDatabase,
  statuses: readonly SessionEntryStatus[],
  sessionKeys?: readonly string[],
): SessionEntrySummary[] {
  const selectedStatuses = [...new Set(statuses)];
  const selectedSessionKeys = sessionKeys ? [...new Set(sessionKeys)] : undefined;
  if (selectedStatuses.length === 0 || selectedSessionKeys?.length === 0) {
    return [];
  }
  const db = getNodeSqliteKysely<SessionStatusDatabase>(database.db);
  let query = db
    .selectFrom("session_nodes")
    .select(["session_key", "entry_json", "current_session_id", "updated_at"])
    .where("status", "in", selectedStatuses);
  if (selectedSessionKeys) {
    query = query.where("session_key", "in", selectedSessionKeys);
  }
  // Multi-row snapshots must project participants exactly like the exact-row read
  // (parseReadableSqliteSessionEntryRow), because optimistic-concurrency revalidation
  // compares whole entries. A field-allowlist comparison would only re-diverge the next
  // time one path grows a projection the other lacks.
  const parsed = new Map(
    executeSqliteQuerySync(database.db, query).rows.flatMap((row) => {
      const entry = parseSessionEntryJson(row);
      return entry ? ([[row.session_key, entry]] as const) : [];
    }),
  );
  return [...projectSqliteSessionParticipantsBatch(database.db, parsed)]
    .map(([sessionKey, entry]) => ({ entry, sessionKey }))
    .toSorted((a, b) => a.sessionKey.localeCompare(b.sessionKey));
}
