import { afterEach, describe, expect, it } from "vitest";
import { createSqliteAuditRecordStore } from "../infra/sqlite-audit-record-store.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  appendTranscriptReset,
  appendTranscriptTurn,
  readTranscriptTail,
} from "./transcript-store.js";

// Mirrors the store's internal retention bound (kept module-local there).
const SYSTEM_AGENT_TRANSCRIPT_MAX_ENTRIES = 1_000;
const SESSION_ONE = { sessionId: "session-one", incarnationId: "incarnation-one" };
const SESSION_TWO = { sessionId: "session-two", incarnationId: "incarnation-two" };

describe("system-agent transcript store", () => {
  afterEach(() => {
    closeOpenClawStateDatabase();
  });

  it("appends turns and returns a bounded tail oldest-first", async () => {
    await withTestDir({ prefix: "openclaw-system-agent-transcript-" }, async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      appendTranscriptTurn({ role: "assistant", text: "welcome", at: 1 }, { env });
      appendTranscriptTurn({ role: "user", text: "status", at: 2 }, { env });
      appendTranscriptTurn({ role: "assistant", text: "healthy", at: 2 }, { env });
      closeOpenClawStateDatabase();

      expect(readTranscriptTail(2, { env })).toEqual([
        { role: "user", text: "status", at: 2 },
        { role: "assistant", text: "healthy", at: 2 },
      ]);
      expect(readTranscriptTail(0, { env })).toEqual([]);
    });
  });

  it("returns only turns owned by a recovered session", async () => {
    await withTestDir({ prefix: "openclaw-system-agent-transcript-session-" }, async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      appendTranscriptTurn(
        { role: "user", text: "session one question", at: 1 },
        { env, session: SESSION_ONE },
      );
      appendTranscriptTurn(
        { role: "user", text: "session two question", at: 2 },
        { env, session: SESSION_TWO },
      );
      appendTranscriptTurn(
        { role: "assistant", text: "session one answer", at: 3 },
        { env, session: SESSION_ONE },
      );
      closeOpenClawStateDatabase();

      expect(readTranscriptTail(2, { env, session: SESSION_ONE })).toEqual([
        {
          role: "user",
          text: "session one question",
          at: 1,
          sessionId: "session-one",
        },
        {
          role: "assistant",
          text: "session one answer",
          at: 3,
          sessionId: "session-one",
        },
      ]);
      expect(readTranscriptTail(0, { env, session: SESSION_ONE })).toEqual([]);
    });
  });

  it("does not recover an earlier incarnation that reused the same session id", async () => {
    await withTestDir(
      { prefix: "openclaw-system-agent-transcript-incarnation-" },
      async (stateDir) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const earlierSession = { sessionId: "reused-session", incarnationId: "earlier" };
        const currentSession = { sessionId: "reused-session", incarnationId: "current" };
        appendTranscriptTurn(
          { role: "user", text: "earlier owner secret", at: 1 },
          { env, session: earlierSession },
        );
        appendTranscriptTurn(
          { role: "user", text: "current owner request", at: 2 },
          { env, session: currentSession },
        );

        expect(readTranscriptTail(10, { env, session: currentSession })).toEqual([
          { role: "user", text: "current owner request", at: 2, sessionId: "reused-session" },
        ]);
      },
    );
  });

  it("keeps session attribution out of payloads read by released versions", async () => {
    await withTestDir(
      { prefix: "openclaw-system-agent-transcript-downgrade-" },
      async (stateDir) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        appendTranscriptTurn(
          { role: "user", text: "scoped question", at: 1 },
          { env, session: SESSION_ONE },
        );

        const releasedReader = createSqliteAuditRecordStore<{
          role: "user" | "assistant" | "reset";
          text: string;
          at: number;
        }>({
          scope: "system-agent-transcript",
          maxEntries: SYSTEM_AGENT_TRANSCRIPT_MAX_ENTRIES,
          env,
        });
        expect(releasedReader.latest({ limit: 1 })[0]?.value).toEqual({
          role: "user",
          text: "scoped question",
          at: 1,
        });
        expect(readTranscriptTail(1, { env, session: SESSION_ONE })).toEqual([
          { role: "user", text: "scoped question", at: 1, sessionId: "session-one" },
        ]);
      },
    );
  });

  it("round-trips typed wizard-action presentation metadata", async () => {
    await withTestDir({ prefix: "openclaw-system-agent-transcript-action-" }, async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      appendTranscriptTurn(
        {
          role: "user",
          text: "Slack bot",
          at: 1,
          wizardAction: {
            kind: "answer",
            step: {
              id: "slack-mode",
              type: "select",
              message: "How should OpenClaw appear in Slack?",
            },
          },
        },
        {
          env,
          session: { sessionId: "slack-session", incarnationId: "slack-incarnation" },
        },
      );
      closeOpenClawStateDatabase();

      expect(
        readTranscriptTail(1, {
          env,
          session: { sessionId: "slack-session", incarnationId: "slack-incarnation" },
        }),
      ).toEqual([
        expect.objectContaining({
          role: "user",
          text: "Slack bot",
          sessionId: "slack-session",
          wizardAction: expect.objectContaining({ kind: "answer" }),
        }),
      ]);
    });
  });
  it("prunes the oldest rows beyond the rolling retention limit", async () => {
    await withTestDir({ prefix: "openclaw-system-agent-transcript-prune-" }, async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      for (let index = 0; index <= SYSTEM_AGENT_TRANSCRIPT_MAX_ENTRIES; index += 1) {
        appendTranscriptTurn({ role: "user", text: `turn-${index}`, at: index }, { env });
      }

      const turns = readTranscriptTail(SYSTEM_AGENT_TRANSCRIPT_MAX_ENTRIES + 1, { env });
      expect(turns).toHaveLength(SYSTEM_AGENT_TRANSCRIPT_MAX_ENTRIES);
      expect(turns[0]?.text).toBe("turn-1");
      expect(turns.at(-1)?.text).toBe(`turn-${SYSTEM_AGENT_TRANSCRIPT_MAX_ENTRIES}`);
    });
  });

  it("hides reset markers and seeds only turns after a marker within the tail window", async () => {
    await withTestDir({ prefix: "openclaw-system-agent-transcript-reset-" }, async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      appendTranscriptTurn({ role: "user", text: "before reset", at: 1 }, { env });
      appendTranscriptTurn({ role: "assistant", text: "old answer", at: 2 }, { env });
      appendTranscriptTurn({ role: "reset", text: "", at: 3 }, { env });
      appendTranscriptTurn({ role: "user", text: "after reset", at: 4 }, { env });
      appendTranscriptTurn({ role: "assistant", text: "new answer", at: 5 }, { env });
      closeOpenClawStateDatabase();

      expect(readTranscriptTail(10, { env })).toEqual([
        { role: "user", text: "before reset", at: 1 },
        { role: "assistant", text: "old answer", at: 2 },
        { role: "user", text: "after reset", at: 4 },
        { role: "assistant", text: "new answer", at: 5 },
      ]);
      expect(readTranscriptTail(10, { afterLastReset: true, env })).toEqual([
        { role: "user", text: "after reset", at: 4 },
        { role: "assistant", text: "new answer", at: 5 },
      ]);
    });
  });

  it("does not let one session reset truncate another session's recovery", async () => {
    await withTestDir(
      { prefix: "openclaw-system-agent-transcript-scoped-reset-" },
      async (stateDir) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        appendTranscriptTurn(
          { role: "user", text: "session one before", at: 1 },
          { env, session: SESSION_ONE },
        );
        appendTranscriptTurn(
          { role: "user", text: "session two before", at: 2 },
          { env, session: SESSION_TWO },
        );
        appendTranscriptReset({ env, session: SESSION_ONE });
        appendTranscriptTurn(
          { role: "assistant", text: "session one after", at: 4 },
          { env, session: SESSION_ONE },
        );
        appendTranscriptTurn(
          { role: "assistant", text: "session two after", at: 5 },
          { env, session: SESSION_TWO },
        );

        expect(readTranscriptTail(10, { afterLastReset: true, env, session: SESSION_ONE })).toEqual(
          [{ role: "assistant", text: "session one after", at: 4, sessionId: "session-one" }],
        );
        expect(readTranscriptTail(10, { afterLastReset: true, env, session: SESSION_TWO })).toEqual(
          [
            { role: "user", text: "session two before", at: 2, sessionId: "session-two" },
            { role: "assistant", text: "session two after", at: 5, sessionId: "session-two" },
          ],
        );
        expect(readTranscriptTail(10, { afterLastReset: true, env })).toEqual([
          { role: "assistant", text: "session one after", at: 4, sessionId: "session-one" },
          { role: "assistant", text: "session two after", at: 5, sessionId: "session-two" },
        ]);
      },
    );
  });

  it("does not let a reset marker older than the requested tail truncate newer turns", async () => {
    await withTestDir(
      { prefix: "openclaw-system-agent-transcript-old-reset-" },
      async (stateDir) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        appendTranscriptTurn({ role: "user", text: "before reset", at: 1 }, { env });
        appendTranscriptTurn({ role: "reset", text: "", at: 2 }, { env });
        appendTranscriptTurn({ role: "user", text: "newer one", at: 3 }, { env });
        appendTranscriptTurn({ role: "assistant", text: "newer two", at: 4 }, { env });
        appendTranscriptTurn({ role: "user", text: "newer three", at: 5 }, { env });
        closeOpenClawStateDatabase();

        expect(readTranscriptTail(2, { afterLastReset: true, env })).toEqual([
          { role: "assistant", text: "newer two", at: 4 },
          { role: "user", text: "newer three", at: 5 },
        ]);
      },
    );
  });
});
