import type { DispatchFromConfigResult } from "../../auto-reply/reply/dispatch-from-config.types.js";
import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.types.js";
import {
  findPlatformMessageNotDispatchedError,
  isProvenDeliveryNotSentError,
} from "../../infra/delivery-recovery.shared.js";
import { emitInternalDiagnosticEvent } from "../../infra/diagnostic-events.js";
import {
  emitOutboundAuditTerminals,
  uniformOutboundAuditTerminals,
} from "../../infra/outbound/outbound-audit.js";
import { normalizeChatType } from "../chat-type.js";
import { isChannelPartialDeliveryError } from "./delivery-result.js";
import type { ChannelDeliveryTerminal } from "./delivery-terminal.types.js";

/** Classifies one settled delivery failure without exposing its raw error graph. */
export function resolveChannelDeliveryFailureTerminal(params: {
  error: unknown;
  deliveredBeforeFailure: boolean;
  failedBeforeDeliver?: boolean;
}): Exclude<ChannelDeliveryTerminal, { outcome: "delivered" }> {
  const platformFailure = findPlatformMessageNotDispatchedError(params.error);
  const publicError = platformFailure?.publicError;
  if (params.deliveredBeforeFailure || isChannelPartialDeliveryError(params.error)) {
    return {
      outcome: "partial_failure",
      retryable: false,
      ...(publicError ? { error: publicError } : {}),
    };
  }
  if (platformFailure) {
    return {
      outcome: "failed",
      retryable: platformFailure.retryable,
      ...(publicError ? { error: publicError } : {}),
    };
  }
  if (params.failedBeforeDeliver || isProvenDeliveryNotSentError(params.error)) {
    return { outcome: "failed", retryable: false };
  }
  return { outcome: "unknown", retryable: false };
}

/** Keeps the most conservative settled fact when more than one delivery path failed. */
function mergeChannelDeliveryTerminal(
  current: ChannelDeliveryTerminal | undefined,
  next: ChannelDeliveryTerminal,
): ChannelDeliveryTerminal {
  if (!current || current.outcome === "delivered") {
    return next;
  }
  if (next.outcome === "delivered") {
    return current;
  }
  const rank = { failed: 1, unknown: 2, partial_failure: 3 } as const;
  return rank[current.outcome] >= rank[next.outcome] ? current : next;
}

export function applySettledChannelDeliveryFailure(
  result: DispatchFromConfigResult,
  failure: { error: unknown; kind: ReplyDispatchKind },
): DispatchFromConfigResult {
  const visiblePartial = isChannelPartialDeliveryError(failure.error);
  const remainingKindCount = visiblePartial
    ? result.counts[failure.kind]
    : Math.max(0, result.counts[failure.kind] - 1);
  const terminal = resolveChannelDeliveryFailureTerminal({
    error: failure.error,
    deliveredBeforeFailure: visiblePartial || remainingKindCount > 0,
  });
  return {
    ...result,
    queuedFinal: failure.kind === "final" && remainingKindCount === 0 ? false : result.queuedFinal,
    counts: visiblePartial
      ? result.counts
      : { ...result.counts, [failure.kind]: remainingKindCount },
    ...(!visiblePartial
      ? {
          failedCounts: {
            ...result.failedCounts,
            [failure.kind]: (result.failedCounts?.[failure.kind] ?? 0) + 1,
          },
        }
      : {}),
    deliveryTerminal: mergeChannelDeliveryTerminal(result.deliveryTerminal, terminal),
  };
}

export function emitChannelDeliveryTerminalObservations(params: {
  terminal: Exclude<ChannelDeliveryTerminal, { outcome: "delivered" }>;
  channel: string;
  to: string;
  accountId?: string;
  agentId: string;
  runId?: string;
  sessionKey: string;
  chatType: string | undefined;
  startedAt: number;
}): void {
  const conversationKind = normalizeChatType(params.chatType);
  const auditTerminal =
    params.terminal.outcome === "unknown"
      ? ({ outcome: "unknown", failureStage: "platform_send" } as const)
      : ({
          outcome: "failed",
          failureStage: "platform_send",
          sentBeforeError: params.terminal.outcome === "partial_failure",
        } as const);
  emitOutboundAuditTerminals({
    context: {
      channel: params.channel,
      to: params.to,
      ...(params.accountId ? { accountId: params.accountId } : {}),
      ...(params.runId ? { replyPayloadSendingHook: { runId: params.runId } } : {}),
      session: {
        key: params.sessionKey,
        agentId: params.agentId,
        ...(conversationKind ? { conversationKind } : {}),
      },
    },
    terminals: uniformOutboundAuditTerminals(1, auditTerminal),
    startedAt: params.startedAt,
  });
  emitInternalDiagnosticEvent({
    type: "message.delivery.error",
    channel: params.channel,
    sessionKey: params.sessionKey,
    deliveryKind: "other",
    durationMs: Math.max(0, Date.now() - params.startedAt),
    errorCategory: `channel_${params.terminal.outcome}`,
  });
}
