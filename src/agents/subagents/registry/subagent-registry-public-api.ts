import { isCronSessionKey } from "../../../sessions/session-key-utils.js";
import {
  ackLeasedAgentSteeringItemsFromSubagentRuns,
  leasePendingAgentSteeringItemsFromSubagentRuns,
  releaseLeasedAgentSteeringItemsFromSubagentRuns,
} from "../../agent-steering-queue.js";
import { getSubagentDepthFromSessionStore } from "../spawn/subagent-depth.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { getSubagentRunsForChildSession } from "./subagent-registry-memory.js";
import {
  countActiveRunsForSessionFromRuns,
  getLatestSubagentRunByChildSessionKeyFromRuns,
} from "./subagent-registry-queries.js";
import {
  applyRequesterTurnYieldedMutation,
  rollbackRequesterTurnYieldedMutation,
} from "./subagent-registry-requester-yield.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import type { SubagentRunRecord, SwarmStructuredOutputState } from "./subagent-registry.types.js";
import {
  applySubagentWaitClaimMutation,
  rollbackSubagentWaitClaimMutation,
} from "./subagent-wait-claim.js";

export function createSubagentRegistryPublicApi(config: {
  runs: Map<string, SubagentRunRecord>;
  persist: (...runIds: string[]) => void;
  persistOrThrow: (...runIds: string[]) => void;
  restoreOnce: () => void;
  startAnnounceCleanup: (runId: string, entry: SubagentRunRecord) => boolean;
  settleRequesterTurn: SubagentLifecycleController["settleRequesterTurnAfterSessionSpawns"];
}) {
  const { runs, persist, persistOrThrow, restoreOnce, startAnnounceCleanup, settleRequesterTurn } =
    config;
  const readRuns = () => getSubagentRunsSnapshotForRead(runs);
  const findRunById = (records: Map<string, SubagentRunRecord>, runId: string) =>
    records.get(runId) ?? [...records.values()].find((entry) => entry.swarmRunId === runId);

  function leasePendingAgentSteeringItems(params: {
    requesterSessionKey: string;
    leaseId: string;
    now?: number;
  }) {
    restoreOnce();
    const leased = leasePendingAgentSteeringItemsFromSubagentRuns({ ...params, runs });
    if (leased) {
      persist(...leased.runIds);
    }
    return leased;
  }

  function ackPendingAgentSteeringItems(params: {
    runIds: readonly string[];
    leaseId: string;
    now?: number;
  }): number {
    const updated = ackLeasedAgentSteeringItemsFromSubagentRuns({ ...params, runs });
    if (updated > 0) {
      persist(...params.runIds);
      for (const runId of params.runIds) {
        const entry = runs.get(runId);
        if (!entry || typeof entry.cleanupCompletedAt === "number") {
          continue;
        }
        entry.cleanupHandled = false;
        startAnnounceCleanup(runId, entry);
      }
    }
    return updated;
  }

  function releasePendingAgentSteeringItems(params: {
    runIds: readonly string[];
    leaseId: string;
    error?: string;
  }): number {
    const updated = releaseLeasedAgentSteeringItemsFromSubagentRuns({ ...params, runs });
    if (updated > 0) {
      persist(...params.runIds);
    }
    return updated;
  }

  function getSubagentRunByRunId(runId: string): SubagentRunRecord | undefined {
    return findRunById(readRuns(), runId.trim());
  }

  function getSubagentRunsByRunIds(runIds: readonly string[]): {
    entries: Map<string, SubagentRunRecord>;
  } {
    const byId = new Map<string, SubagentRunRecord>();
    for (const entry of readRuns().values()) {
      byId.set(entry.runId, entry);
      if (entry.swarmRunId) {
        byId.set(entry.swarmRunId, entry);
      }
    }
    return {
      entries: new Map(
        runIds.flatMap((runId) => {
          const entry = byId.get(runId.trim());
          return entry ? [[runId, entry] as const] : [];
        }),
      ),
    };
  }

  function completeCollectorLaunchCleanup(runId: string): void {
    const entry = findRunById(runs, runId.trim());
    if (!entry?.collectorLaunchCleanupPending) {
      return;
    }
    entry.collectorLaunchCleanupPending = false;
    entry.cleanupCompletedAt = Date.now();
    entry.contextEngineCleanupCompletedAt ??= entry.cleanupCompletedAt;
    persist(entry.runId);
  }

  function recordSwarmStructuredOutput(
    identity: { runId?: string; childSessionKey?: string },
    state: SwarmStructuredOutputState,
  ): void {
    const runId = identity.runId?.trim();
    const childSessionKey = identity.childSessionKey?.trim();
    const entry =
      (runId ? findRunById(runs, runId) : undefined) ??
      (childSessionKey
        ? getLatestSubagentRunByChildSessionKeyFromRuns(
            getSubagentRunsForChildSession(childSessionKey),
            childSessionKey,
          )
        : undefined);
    if (!entry?.collect || entry.collectorCompletion) {
      throw new Error("collector run is unavailable");
    }
    const previous = entry.structuredOutput;
    entry.structuredOutput = structuredClone(state);
    try {
      persistOrThrow(entry.runId);
    } catch (error) {
      entry.structuredOutput = previous;
      throw error;
    }
  }

  function listSwarmRunsForGroup(
    groupId: string,
    requesterSessionKey?: string,
    requesterAgentId?: string,
  ): SubagentRunRecord[] {
    const key = groupId.trim();
    const requesterKey = requesterSessionKey?.trim();
    return [...readRuns().values()].filter(
      (entry) =>
        entry.collect === true &&
        entry.groupId === key &&
        (!requesterKey ||
          (entry.swarmRequesterSessionKey ?? entry.requesterSessionKey) === requesterKey) &&
        (!requesterAgentId || entry.requesterAgentId === requesterAgentId),
    );
  }

  /** Resolve a collector reserved by a replay-safe host bridge request. */
  function getSwarmRunByLaunchReplayKey(
    replayKey: string,
    requesterSessionKey?: string,
    requesterAgentId?: string,
  ): SubagentRunRecord | undefined {
    const key = replayKey.trim();
    const requesterKey = requesterSessionKey?.trim();
    if (!key) {
      return undefined;
    }
    return [...readRuns().values()].find(
      (entry) =>
        entry.collect === true &&
        entry.swarmLaunchReplayKey === key &&
        (!requesterKey ||
          (entry.swarmRequesterSessionKey ?? entry.requesterSessionKey) === requesterKey) &&
        (!requesterAgentId || entry.requesterAgentId === requesterAgentId),
    );
  }

  function countActiveRunsForSession(
    requesterSessionKey: string,
    options?: { collect?: boolean; requesterAgentId?: string },
  ): number {
    return countActiveRunsForSessionFromRuns(readRuns(), requesterSessionKey, options);
  }

  /** Records sessions_yield before the active requester run is aborted. */
  function markRequesterTurnYielded(params: {
    requesterSessionKey: string;
    requesterAgentId?: string;
    requesterTurnRunId: string;
  }): number {
    restoreOnce();
    // Both mutations below must land in a single persist call. Persisting the
    // yield marker and the wait-claim stamp separately would let a crash or a
    // throw between the two writes leave a yield-marked row with no claim —
    // harmless while nothing reads the ledger, but indistinguishable from
    // "never yielded" once a resolver trusts it (see BRIEF-wait-claim-ledger.md).
    const yieldMutation = applyRequesterTurnYieldedMutation({
      ...params,
      runs,
    });
    // Pin the visible-reply contract at claim-write time. A nested requester's
    // final answer is its completion message to its own parent, never a
    // user-visible reply; every other yielding requester (cron included) must
    // end its yielded turn with a visible final answer.
    const requesterIsNested =
      !isCronSessionKey(params.requesterSessionKey) &&
      getSubagentDepthFromSessionStore(params.requesterSessionKey) >= 1;
    const claimMutation = applySubagentWaitClaimMutation({
      ...params,
      requireVisibleReply: !requesterIsNested,
      runs,
    });
    if (!yieldMutation.mutated && !claimMutation.mutated) {
      return yieldMutation.markedCount;
    }
    const runIdsToPersist = new Set<string>();
    for (const entry of yieldMutation.entries) {
      runIdsToPersist.add(entry.runId);
    }
    for (const entry of claimMutation.entries) {
      runIdsToPersist.add(entry.runId);
    }
    try {
      persistOrThrow(...runIdsToPersist);
    } catch (error) {
      rollbackRequesterTurnYieldedMutation(yieldMutation.entries, yieldMutation.previous);
      rollbackSubagentWaitClaimMutation(claimMutation.entries, claimMutation.previous);
      throw error;
    }
    return yieldMutation.markedCount;
  }

  return {
    leasePendingAgentSteeringItems,
    ackPendingAgentSteeringItems,
    releasePendingAgentSteeringItems,
    getSubagentRunByRunId,
    getSubagentRunsByRunIds,
    completeCollectorLaunchCleanup,
    recordSwarmStructuredOutput,
    listSwarmRunsForGroup,
    getSwarmRunByLaunchReplayKey,
    countActiveRunsForSession,
    settleRequesterAfterSessionSpawns: settleRequesterTurn,
    markRequesterTurnYielded,
  };
}
