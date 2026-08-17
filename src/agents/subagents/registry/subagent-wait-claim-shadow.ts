/**
 * Shadow-mode observer for the wait-claim resolver (step 2 of the ledger).
 *
 * Runs at the same point as the push-path settle-wake and logs one
 * "[wait-claim-resolver-shadow]" line comparing the resolver's answer against
 * the push outcome. Observe-only by contract: never throws and never
 * influences any wake or delivery decision. Remove or promote at cutover
 * (step 3 of BRIEF-wait-claim-ledger.md).
 */
import { logDebug } from "../../../logger.js";
import { isCronSessionKey } from "../../../sessions/session-key-utils.js";
import { getSubagentDepthFromSessionStore } from "../spawn/subagent-depth.js";
import { maskLifecycleIdentifier } from "./subagent-registry-lifecycle-delivery.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentWaitClaim } from "./subagent-wait-claim.js";

export function logWaitClaimResolverShadow(params: {
  requesterSessionKey: string;
  settledRunId: string;
  /** Whether the push-path settle-wake actually delivered a wake this pass. */
  pushWake: boolean;
  runs: ReadonlyMap<string, SubagentRunRecord>;
}): void {
  try {
    // Step 3 cut cron and nested (depth >= 1) requesters over to real
    // claim-driven wake; the push-vs-resolver comparison stays meaningful only
    // for ordinary requesters still on the push path (retire at step 3b).
    if (
      isCronSessionKey(params.requesterSessionKey) ||
      getSubagentDepthFromSessionStore(params.requesterSessionKey) >= 1
    ) {
      return;
    }
    const resolution = resolveSubagentWaitClaim(params);
    if (resolution.status === "no_claim") {
      return;
    }
    const resolverWouldWake = resolution.status === "satisfied";
    const verdict = resolverWouldWake === params.pushWake ? "agree" : "disagree";
    const pendingSuffix =
      resolution.status === "pending"
        ? ` pending=${resolution.unsettledRunIds
            .map((runId) => maskLifecycleIdentifier(runId, "run"))
            .join(",")}`
        : "";
    logDebug(
      `[wait-claim-resolver-shadow] ${verdict} push=${params.pushWake} resolver=${resolution.status}` +
        ` requester=${maskLifecycleIdentifier(params.requesterSessionKey, "session")}` +
        ` settledRun=${maskLifecycleIdentifier(params.settledRunId, "run")}${pendingSuffix}`,
    );
  } catch {
    // Shadow mode must never affect wake behavior; swallow everything.
  }
}
