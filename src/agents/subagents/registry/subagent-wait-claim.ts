/**
 * Wait-claim ledger writer (step 1 of the wait-claim ledger).
 *
 * When a requester invokes sessions_yield, record one durable claim naming
 * every child run whose completion the requester still awaits. Deliberately
 * unconditional: nested-subagent and cron-session requesters get a claim too,
 * unlike the depth/cron exclusions in the settle-wake push paths. Nothing
 * reads this yet; the resolver lands separately in shadow mode.
 */
import type { SubagentRunRecord, SubagentWaitClaim } from "./subagent-registry.types.js";

/** A child is awaited until its completion has actually reached the requester. */
function isAwaitedByRequester(entry: SubagentRunRecord): boolean {
  if (
    entry.expectsCompletionMessage !== true ||
    entry.collect === true ||
    entry.suppressCompletionDelivery === true ||
    typeof entry.cleanupCompletedAt === "number"
  ) {
    return false;
  }
  return entry.execution.status !== "terminal" || entry.delivery?.status !== "delivered";
}

export type SubagentWaitClaimResolution =
  | { status: "no_claim" }
  | { status: "pending"; claim: SubagentWaitClaim; unsettledRunIds: string[] }
  | { status: "satisfied"; claim: SubagentWaitClaim };

/**
 * Claim resolver (step 2 of the wait-claim ledger): answers "is this
 * requester's latest wait-claim satisfied?" purely from the runs map.
 * Deliberately no depth/cron exclusions — nested-subagent and cron-session
 * requesters resolve identically; that uniformity is the ledger's purpose.
 * Currently consumed only by the shadow-mode observer; no wake path acts on it.
 */
export function resolveSubagentWaitClaim(params: {
  requesterSessionKey: string;
  runs: ReadonlyMap<string, SubagentRunRecord>;
}): SubagentWaitClaimResolution {
  const requesterSessionKey = params.requesterSessionKey.trim();
  if (!requesterSessionKey) {
    return { status: "no_claim" };
  }
  // Every child stamped by one yield carries an identical claim, so the
  // newest claimedAt seen on any row is the requester's latest claim.
  let claim: SubagentWaitClaim | undefined;
  for (const entry of params.runs.values()) {
    const candidate = entry.waitClaim;
    if (candidate?.requesterSessionKey !== requesterSessionKey) {
      continue;
    }
    if (!claim || candidate.claimedAt > claim.claimedAt) {
      claim = candidate;
    }
  }
  if (!claim) {
    return { status: "no_claim" };
  }
  // A missing row is settled: the registry only deletes rows after their
  // completion obligations resolve (retirement/cleanup), never mid-flight.
  const unsettledRunIds = claim.awaitedRunIds.filter((runId) => {
    const entry = params.runs.get(runId);
    return entry !== undefined && isAwaitedByRequester(entry);
  });
  if (unsettledRunIds.length === 0) {
    return { status: "satisfied", claim };
  }
  return { status: "pending", claim, unsettledRunIds };
}

export type SubagentWaitClaimMutation = {
  entries: SubagentRunRecord[];
  previous: (SubagentWaitClaim | undefined)[];
  awaitedRunIds: string[];
  mutated: boolean;
};

/**
 * Mutates in-memory rows to stamp the wait-claim, without persisting. Exposed
 * so callers that must persist this alongside another mutation (e.g. the
 * requester-turn-yielded marker) can do so in one atomic write instead of two
 * separate ones — see {@link recordSubagentWaitClaimInRuns} for why that
 * matters once a resolver trusts this ledger.
 */
export function applySubagentWaitClaimMutation(params: {
  requesterSessionKey: string;
  requesterTurnRunId?: string;
  now?: number;
  runs: Map<string, SubagentRunRecord>;
}): SubagentWaitClaimMutation {
  const requesterSessionKey = params.requesterSessionKey.trim();
  const requesterTurnRunId = params.requesterTurnRunId?.trim() || undefined;
  if (!requesterSessionKey) {
    return { entries: [], previous: [], awaitedRunIds: [], mutated: false };
  }
  const entries = [...params.runs.values()].filter(
    (entry) => entry.requesterSessionKey === requesterSessionKey && isAwaitedByRequester(entry),
  );
  if (entries.length === 0) {
    return { entries: [], previous: [], awaitedRunIds: [], mutated: false };
  }
  const awaitedRunIds = entries.map((entry) => entry.runId).toSorted();
  const claimedAt = params.now ?? Date.now();
  const previous = entries.map((entry) => entry.waitClaim);
  for (const entry of entries) {
    entry.waitClaim = {
      requesterSessionKey,
      ...(requesterTurnRunId ? { requesterTurnRunId } : {}),
      awaitedRunIds,
      claimedAt,
    };
  }
  return { entries, previous, awaitedRunIds, mutated: true };
}

/** Reverts a mutation produced by {@link applySubagentWaitClaimMutation}. */
export function rollbackSubagentWaitClaimMutation(
  entries: SubagentRunRecord[],
  previous: (SubagentWaitClaim | undefined)[],
): void {
  entries.forEach((entry, index) => {
    entry.waitClaim = previous[index];
  });
}

/** Persists the wait-claim on every awaited child row; rolls back on persist failure. */
export function recordSubagentWaitClaimInRuns(params: {
  requesterSessionKey: string;
  requesterTurnRunId?: string;
  now?: number;
  runs: Map<string, SubagentRunRecord>;
  persistOrThrow(...runIds: string[]): void;
}): { awaitedRunIds: string[] } {
  const mutation = applySubagentWaitClaimMutation(params);
  if (!mutation.mutated) {
    return { awaitedRunIds: [] };
  }
  try {
    params.persistOrThrow(...mutation.entries.map((entry) => entry.runId));
  } catch (error) {
    rollbackSubagentWaitClaimMutation(mutation.entries, mutation.previous);
    throw error;
  }
  return { awaitedRunIds: mutation.awaitedRunIds };
}
