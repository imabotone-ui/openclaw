import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { logWaitClaimResolverShadow } from "./subagent-wait-claim-shadow.js";

const logDebug = vi.hoisted(() => vi.fn());
vi.mock("../../../logger.js", () => ({ logDebug }));

vi.mock("../spawn/subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: (sessionKey: string) =>
    sessionKey.split(":subagent:").length - 1,
}));

function makeRun(
  runId: string,
  requesterSessionKey: string,
  overrides: Partial<SubagentRunRecord> = {},
): SubagentRunRecord {
  return {
    runId,
    childSessionKey: `${requesterSessionKey}:subagent:${runId}`,
    requesterSessionKey,
    requesterDisplayKey: "main",
    task: "finish",
    cleanup: "keep",
    createdAt: 1_000,
    execution: { status: "running" },
    expectsCompletionMessage: true,
    waitClaim: {
      requesterSessionKey,
      awaitedRunIds: [runId],
      claimedAt: 5_000,
    },
    ...overrides,
  };
}

describe("logWaitClaimResolverShadow", () => {
  beforeEach(() => {
    logDebug.mockClear();
  });

  it("logs nothing when the requester has no claim", () => {
    logWaitClaimResolverShadow({
      requesterSessionKey: "agent:main:main",
      settledRunId: "run-a",
      pushWake: false,
      runs: new Map(),
    });
    expect(logDebug).not.toHaveBeenCalled();
  });

  it("logs agreement when both push and resolver would wake", () => {
    const entry = makeRun("run-a", "agent:main:main", {
      execution: { status: "terminal", endedAt: 2_000 },
      delivery: { status: "delivered" },
    });
    logWaitClaimResolverShadow({
      requesterSessionKey: "agent:main:main",
      settledRunId: "run-a",
      pushWake: true,
      runs: new Map([[entry.runId, entry]]),
    });
    expect(logDebug).toHaveBeenCalledOnce();
    const line = logDebug.mock.calls[0]?.[0] as string;
    expect(line).toContain("[wait-claim-resolver-shadow] agree push=true resolver=satisfied");
  });

  it("logs disagreement when the resolver says satisfied but the push path did not wake", () => {
    const entry = makeRun("run-a", "agent:main:main", {
      execution: { status: "terminal", endedAt: 2_000 },
      delivery: { status: "delivered" },
    });
    logWaitClaimResolverShadow({
      requesterSessionKey: "agent:main:main",
      settledRunId: "run-a",
      pushWake: false,
      runs: new Map([[entry.runId, entry]]),
    });
    const line = logDebug.mock.calls[0]?.[0] as string;
    expect(line).toContain("[wait-claim-resolver-shadow] disagree push=false resolver=satisfied");
  });

  // Cron and nested requesters were cut over to real claim-driven wake in
  // step 3; their shadow comparison is retired while ordinary requesters
  // remain shadow-observed.
  it.each([
    ["cron", "agent:main:cron:nightly"],
    ["nested", "agent:main:subagent:middle"],
  ])("logs nothing for a cut-over %s requester", (_kind, requesterSessionKey) => {
    const entry = makeRun("run-a", requesterSessionKey, {
      execution: { status: "terminal", endedAt: 2_000 },
      delivery: { status: "delivered" },
    });
    logWaitClaimResolverShadow({
      requesterSessionKey,
      settledRunId: "run-a",
      pushWake: false,
      runs: new Map([[entry.runId, entry]]),
    });
    expect(logDebug).not.toHaveBeenCalled();
  });

  it("logs pending run ids masked when the claim is not yet satisfied", () => {
    const entry = makeRun("run-still-going-1234", "agent:main:main", {
      waitClaim: {
        requesterSessionKey: "agent:main:main",
        awaitedRunIds: ["run-still-going-1234"],
        claimedAt: 5_000,
      },
    });
    logWaitClaimResolverShadow({
      requesterSessionKey: "agent:main:main",
      settledRunId: "run-still-going-1234",
      pushWake: false,
      runs: new Map([[entry.runId, entry]]),
    });
    const line = logDebug.mock.calls[0]?.[0] as string;
    expect(line).toContain("agree push=false resolver=pending");
    expect(line).toContain("pending=");
    expect(line).not.toContain("run-still-going-1234");
  });

  it("never throws even when the runs map itself is broken", () => {
    const broken = new Proxy(new Map<string, SubagentRunRecord>(), {
      get() {
        throw new Error("boom");
      },
    });
    expect(() =>
      logWaitClaimResolverShadow({
        requesterSessionKey: "agent:main:main",
        settledRunId: "run-a",
        pushWake: true,
        runs: broken,
      }),
    ).not.toThrow();
  });
});
