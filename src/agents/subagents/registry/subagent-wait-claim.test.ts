import { describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { recordSubagentWaitClaimInRuns } from "./subagent-wait-claim.js";

const NOW = 5_000;

function makeRun(
  runId: string,
  requesterSessionKey: string,
  overrides: Partial<SubagentRunRecord> = {},
): SubagentRunRecord {
  return {
    runId,
    requesterTurnRunId: "run-requester",
    childSessionKey: `${requesterSessionKey}:subagent:${runId}`,
    requesterSessionKey,
    requesterDisplayKey: "main",
    task: "finish",
    cleanup: "keep",
    createdAt: 1_000,
    execution: { status: "running" },
    expectsCompletionMessage: true,
    ...overrides,
  };
}

function runsMap(...entries: SubagentRunRecord[]) {
  return new Map(entries.map((entry) => [entry.runId, entry] as const));
}

describe("recordSubagentWaitClaimInRuns", () => {
  it("writes and persists a claim for a single awaited child", () => {
    const entry = makeRun("run-a", "agent:main:main");
    const persistOrThrow = vi.fn();

    const result = recordSubagentWaitClaimInRuns({
      requesterSessionKey: "agent:main:main",
      requesterTurnRunId: "run-requester",
      now: NOW,
      runs: runsMap(entry),
      persistOrThrow,
    });

    expect(result.awaitedRunIds).toEqual(["run-a"]);
    expect(entry.waitClaim).toEqual({
      requesterSessionKey: "agent:main:main",
      requesterTurnRunId: "run-requester",
      awaitedRunIds: ["run-a"],
      claimedAt: NOW,
    });
    expect(persistOrThrow).toHaveBeenCalledExactlyOnceWith("run-a");
  });

  it("stamps the same sorted awaited set on every child, skipping settled or foreign rows", () => {
    const requester = "agent:main:main";
    const running = makeRun("run-b", requester);
    const terminalUndelivered = makeRun("run-a", requester, {
      execution: { status: "terminal", endedAt: 2_000 },
      delivery: { status: "pending" },
    });
    const delivered = makeRun("run-c", requester, {
      execution: { status: "terminal", endedAt: 2_000 },
      delivery: { status: "delivered" },
    });
    const otherRequester = makeRun("run-d", "agent:main:other");
    const persistOrThrow = vi.fn();

    const result = recordSubagentWaitClaimInRuns({
      requesterSessionKey: requester,
      now: NOW,
      runs: runsMap(running, terminalUndelivered, delivered, otherRequester),
      persistOrThrow,
    });

    expect(result.awaitedRunIds).toEqual(["run-a", "run-b"]);
    expect(running.waitClaim?.awaitedRunIds).toEqual(["run-a", "run-b"]);
    expect(terminalUndelivered.waitClaim).toEqual(running.waitClaim);
    expect(delivered.waitClaim).toBeUndefined();
    expect(otherRequester.waitClaim).toBeUndefined();
    expect(persistOrThrow).toHaveBeenCalledExactlyOnceWith("run-b", "run-a");
  });

  it("writes a claim for a nested subagent requester", () => {
    // Nested requesters are excluded from settle-wake push paths; the ledger
    // must still cover them — that gap is the point of the claim.
    const nestedRequester = "agent:main:subagent:parent-1";
    const entry = makeRun("run-grandchild", nestedRequester);
    const persistOrThrow = vi.fn();

    const result = recordSubagentWaitClaimInRuns({
      requesterSessionKey: nestedRequester,
      now: NOW,
      runs: runsMap(entry),
      persistOrThrow,
    });

    expect(result.awaitedRunIds).toEqual(["run-grandchild"]);
    expect(entry.waitClaim?.requesterSessionKey).toBe(nestedRequester);
    expect(persistOrThrow).toHaveBeenCalledOnce();
  });

  it("writes a claim for a cron-session requester", () => {
    const cronRequester = "agent:main:cron:nightly-audit";
    const entry = makeRun("run-cron-child", cronRequester);
    const persistOrThrow = vi.fn();

    const result = recordSubagentWaitClaimInRuns({
      requesterSessionKey: cronRequester,
      now: NOW,
      runs: runsMap(entry),
      persistOrThrow,
    });

    expect(result.awaitedRunIds).toEqual(["run-cron-child"]);
    expect(entry.waitClaim?.requesterSessionKey).toBe(cronRequester);
    expect(persistOrThrow).toHaveBeenCalledOnce();
  });

  it("skips collector, suppressed, and cleaned-up rows and persists nothing when nothing is awaited", () => {
    const requester = "agent:main:main";
    const collector = makeRun("run-collect", requester, { collect: true });
    const suppressed = makeRun("run-supp", requester, { suppressCompletionDelivery: true });
    const cleaned = makeRun("run-clean", requester, { cleanupCompletedAt: 3_000 });
    const persistOrThrow = vi.fn();

    const result = recordSubagentWaitClaimInRuns({
      requesterSessionKey: requester,
      now: NOW,
      runs: runsMap(collector, suppressed, cleaned),
      persistOrThrow,
    });

    expect(result.awaitedRunIds).toEqual([]);
    expect(persistOrThrow).not.toHaveBeenCalled();
  });

  it("rolls back claim writes when persistence throws", () => {
    const entry = makeRun("run-a", "agent:main:main");
    const persistOrThrow = vi.fn(() => {
      throw new Error("disk full");
    });

    expect(() =>
      recordSubagentWaitClaimInRuns({
        requesterSessionKey: "agent:main:main",
        now: NOW,
        runs: runsMap(entry),
        persistOrThrow,
      }),
    ).toThrow("disk full");
    expect(entry.waitClaim).toBeUndefined();
  });
});
