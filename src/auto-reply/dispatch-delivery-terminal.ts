import { isChannelPartialDeliveryError } from "../channels/turn/delivery-result.js";
import { resolveChannelDeliveryFailureTerminal } from "../channels/turn/delivery-terminal.js";
import type { ChannelDeliveryTerminal } from "../channels/turn/delivery-terminal.types.js";
import type { DispatchFromConfigResult } from "./reply/dispatch-from-config.types.js";
import { readReplyDispatcherDeliveryFailures } from "./reply/reply-dispatcher-delivery-failures.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.types.js";

function resolveFinalDeliveryTerminal(params: {
  deliveredFinalCount: number;
  failedFinalCount: number;
  dispatcher: ReplyDispatcher;
}): ChannelDeliveryTerminal | undefined {
  if (params.failedFinalCount === 0) {
    return params.deliveredFinalCount > 0 ? { outcome: "delivered" } : undefined;
  }
  const failures = readReplyDispatcherDeliveryFailures(params.dispatcher).filter(
    (failure) => failure.kind === "final",
  );
  const failure = failures.at(-1);
  return resolveChannelDeliveryFailureTerminal({
    error: failure?.error,
    deliveredBeforeFailure:
      params.deliveredFinalCount > 0 ||
      failures.some((candidate) => isChannelPartialDeliveryError(candidate.error)),
    failedBeforeDeliver: failure?.outcome === "failed-before-deliver",
  });
}

export function finalizeDispatchResult(
  result: DispatchFromConfigResult,
  dispatcher: ReplyDispatcher,
): DispatchFromConfigResult {
  const cancelledCounts = dispatcher.getCancelledCounts?.();
  const failedCounts = dispatcher.getFailedCounts?.();
  if (!cancelledCounts && !failedCounts) {
    return result;
  }

  const resultCounts = {
    tool: result.counts?.tool ?? 0,
    block: result.counts?.block ?? 0,
    final: result.counts?.final ?? 0,
  };
  // Queue counters include failures/cancellations; public counts describe visible dispatches.
  const counts = {
    tool: Math.max(0, resultCounts.tool - (cancelledCounts?.tool ?? 0) - (failedCounts?.tool ?? 0)),
    block: Math.max(
      0,
      resultCounts.block - (cancelledCounts?.block ?? 0) - (failedCounts?.block ?? 0),
    ),
    final: Math.max(
      0,
      resultCounts.final - (cancelledCounts?.final ?? 0) - (failedCounts?.final ?? 0),
    ),
  };
  const hasFailedCounts = Object.values(failedCounts ?? {}).some((count) => count > 0);
  const deliveryTerminal = resolveFinalDeliveryTerminal({
    deliveredFinalCount: counts.final,
    failedFinalCount: failedCounts?.final ?? 0,
    dispatcher,
  });
  return {
    ...result,
    queuedFinal: result.queuedFinal && counts.final > 0,
    counts,
    ...(hasFailedCounts ? { failedCounts } : {}),
    ...(deliveryTerminal ? { deliveryTerminal } : {}),
  };
}
