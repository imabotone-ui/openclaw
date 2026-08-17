/**
 * Wait-claim ledger writer (step 1 of the wait-claim ledger).
 *
 * When a requester invokes sessions_yield, record one durable claim naming
 * every child run whose completion the requester still awaits. Deliberately
 * unconditional: nested-subagent and cron-session requesters get a claim too,
 * unlike the depth/cron exclusions in the settle-wake push paths. Nothing
 * reads this yet; the resolver lands separately in shadow mode.
 */
import type { SubagentRunRecord } from "./subagent-registry.types.js";

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

/** Persists the wait-claim on every awaited child row; rolls back on persist failure. */
export function recordSubagentWaitClaimInRuns(params: {
  requesterSessionKey: string;
  requesterTurnRunId?: string;
  now?: number;
  runs: Map<string, SubagentRunRecord>;
  persistOrThrow(...runIds: string[]): void;
}): { awaitedRunIds: string[] } {
  const requesterSessionKey = params.requesterSessionKey.trim();
  const requesterTurnRunId = params.requesterTurnRunId?.trim() || undefined;
  if (!requesterSessionKey) {
    return { awaitedRunIds: [] };
  }
  const entries = [...params.runs.values()].filter(
    (entry) => entry.requesterSessionKey === requesterSessionKey && isAwaitedByRequester(entry),
  );
  if (entries.length === 0) {
    return { awaitedRunIds: [] };
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
  try {
    params.persistOrThrow(...entries.map((entry) => entry.runId));
  } catch (error) {
    entries.forEach((entry, index) => {
      entry.waitClaim = previous[index];
    });
    throw error;
  }
  return { awaitedRunIds };
}
