import { describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { recordSubagentWaitClaimInRuns, resolveSubagentWaitClaim } from "./subagent-wait-claim.js";

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

  it("includes already-delivered same-turn children in a turn-scoped claim", () => {
    const requester = "agent:main:main";
    const running = makeRun("run-b", requester);
    const deliveredSameTurn = makeRun("run-c", requester, {
      execution: { status: "terminal", endedAt: 2_000 },
      delivery: { status: "delivered" },
    });
    const deliveredOtherTurn = makeRun("run-d", requester, {
      requesterTurnRunId: "run-other-turn",
      execution: { status: "terminal", endedAt: 2_000 },
      delivery: { status: "delivered" },
    });
    const suppressedSameTurn = makeRun("run-e", requester, {
      suppressCompletionDelivery: true,
    });
    const persistOrThrow = vi.fn();

    const result = recordSubagentWaitClaimInRuns({
      requesterSessionKey: requester,
      requesterTurnRunId: "run-requester",
      now: NOW,
      runs: runsMap(running, deliveredSameTurn, deliveredOtherTurn, suppressedSameTurn),
      persistOrThrow,
    });

    expect(result.awaitedRunIds).toEqual(["run-b", "run-c"]);
    expect(deliveredSameTurn.waitClaim).toEqual(running.waitClaim);
    expect(deliveredOtherTurn.waitClaim).toBeUndefined();
    expect(suppressedSameTurn.waitClaim).toBeUndefined();
  });

  it("writes an immediately-satisfiable claim when every turn child delivered before the yield", () => {
    // Root cause #2 tail: yield-after-delivery used to write no claim at all,
    // leaving the wake to the retired timing heuristic.
    const requester = "agent:main:main";
    const delivered = makeRun("run-a", requester, {
      execution: { status: "terminal", endedAt: 2_000 },
      delivery: { status: "delivered" },
    });
    const runs = runsMap(delivered);

    const result = recordSubagentWaitClaimInRuns({
      requesterSessionKey: requester,
      requesterTurnRunId: "run-requester",
      now: NOW,
      runs,
      persistOrThrow: vi.fn(),
    });

    expect(result.awaitedRunIds).toEqual(["run-a"]);
    expect(resolveSubagentWaitClaim({ requesterSessionKey: requester, runs })).toEqual({
      status: "satisfied",
      claim: delivered.waitClaim,
    });
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

describe("resolveSubagentWaitClaim", () => {
  function claimedRuns(requester: string, ...entries: SubagentRunRecord[]) {
    const runs = runsMap(...entries);
    recordSubagentWaitClaimInRuns({
      requesterSessionKey: requester,
      now: NOW,
      runs,
      persistOrThrow: vi.fn(),
    });
    return runs;
  }

  it("returns no_claim when the requester never yielded a claim", () => {
    const runs = runsMap(makeRun("run-a", "agent:main:main"));
    expect(resolveSubagentWaitClaim({ requesterSessionKey: "agent:main:main", runs })).toEqual({
      status: "no_claim",
    });
    expect(resolveSubagentWaitClaim({ requesterSessionKey: " ", runs })).toEqual({
      status: "no_claim",
    });
  });

  it("reports pending with the unsettled subset while children are still running", () => {
    const requester = "agent:main:main";
    const running = makeRun("run-b", requester);
    const delivered = makeRun("run-a", requester, {
      execution: { status: "terminal", endedAt: 2_000 },
      delivery: { status: "pending" },
    });
    const runs = claimedRuns(requester, running, delivered);

    const resolution = resolveSubagentWaitClaim({ requesterSessionKey: requester, runs });
    expect(resolution.status).toBe("pending");
    if (resolution.status === "pending") {
      expect(resolution.unsettledRunIds).toEqual(["run-a", "run-b"]);
      expect(resolution.claim.awaitedRunIds).toEqual(["run-a", "run-b"]);
    }
  });

  it("reports pending for a partially settled claim, then satisfied once all deliver", () => {
    const requester = "agent:main:main";
    const first = makeRun("run-a", requester);
    const second = makeRun("run-b", requester);
    const runs = claimedRuns(requester, first, second);

    first.execution = { status: "terminal", endedAt: 2_000 };
    first.delivery = { status: "delivered" };
    const partial = resolveSubagentWaitClaim({ requesterSessionKey: requester, runs });
    expect(partial).toMatchObject({ status: "pending", unsettledRunIds: ["run-b"] });

    second.execution = { status: "terminal", endedAt: 3_000 };
    second.delivery = { status: "delivered" };
    expect(resolveSubagentWaitClaim({ requesterSessionKey: requester, runs }).status).toBe(
      "satisfied",
    );
  });

  it("treats retired (deleted) rows and suppressed rows as settled", () => {
    const requester = "agent:main:main";
    const retired = makeRun("run-a", requester);
    const suppressed = makeRun("run-b", requester);
    const runs = claimedRuns(requester, retired, suppressed);

    runs.delete("run-a");
    suppressed.suppressCompletionDelivery = true;
    expect(resolveSubagentWaitClaim({ requesterSessionKey: requester, runs }).status).toBe(
      "satisfied",
    );
  });

  it("resolves a newer claim over a stale one from an earlier yield", () => {
    const requester = "agent:main:main";
    const stale = makeRun("run-old", requester, {
      execution: { status: "terminal", endedAt: 2_000 },
      delivery: { status: "delivered" },
      waitClaim: {
        requesterSessionKey: requester,
        awaitedRunIds: ["run-old"],
        claimedAt: NOW - 1_000,
      },
    });
    const current = makeRun("run-new", requester, {
      waitClaim: {
        requesterSessionKey: requester,
        awaitedRunIds: ["run-new"],
        claimedAt: NOW,
      },
    });
    const runs = runsMap(stale, current);

    const resolution = resolveSubagentWaitClaim({ requesterSessionKey: requester, runs });
    expect(resolution).toMatchObject({ status: "pending", unsettledRunIds: ["run-new"] });
  });

  it.each([
    ["intentional_non_delivery", { status: "pending", disposition: "intentional_non_delivery" }],
    ["permanent_failure", { status: "failed", disposition: "permanent_failure" }],
    ["suspended", { status: "suspended", suspendedAt: 4_000 }],
  ] as const)(
    "treats a terminal child whose delivery ended as %s as settled",
    (_label, delivery) => {
      // Settle-terminal per-child delivery means nothing more arrives on its
      // own; the settle wake itself carries these findings, so the claim must
      // resolve satisfied instead of deadlocking pending forever.
      const requester = "agent:main:main";
      const child = makeRun("run-a", requester);
      const runs = claimedRuns(requester, child);

      child.execution = { status: "terminal", endedAt: 2_000 };
      child.delivery = delivery;
      expect(resolveSubagentWaitClaim({ requesterSessionKey: requester, runs }).status).toBe(
        "satisfied",
      );
    },
  );

  it("resolves nested-subagent and cron-session requesters with no special casing", () => {
    // The push path excludes depth>=1 and cron requesters; the resolver must not.
    for (const requester of ["agent:main:subagent:parent-1", "agent:main:cron:nightly-audit"]) {
      const child = makeRun("run-child", requester);
      const runs = claimedRuns(requester, child);
      expect(resolveSubagentWaitClaim({ requesterSessionKey: requester, runs }).status).toBe(
        "pending",
      );
      child.execution = { status: "terminal", endedAt: 2_000 };
      child.delivery = { status: "delivered" };
      expect(resolveSubagentWaitClaim({ requesterSessionKey: requester, runs }).status).toBe(
        "satisfied",
      );
    }
  });
});
