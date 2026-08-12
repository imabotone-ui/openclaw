import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import {
  isPlatformMessageNotDispatchedError,
  isPlatformMessageRejectedError,
} from "../../infra/outbound/deliver-types.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import type { createMessageSentEmitter } from "../../infra/outbound/message-sent-hook.js";
import { resolveMessageReceiptPrimaryId } from "../message/receipt.js";
import {
  isChannelPartialDeliveryError,
  type ChannelPartialDeliveryError,
} from "./delivery-result.js";
import { resolvePendingFinalCompletion } from "./direct-delivery-custody.js";
import type {
  ChannelDeliveryInfo,
  ChannelDeliveryOutcome,
  ChannelDeliveryResult,
  ChannelEventDeliveryAdapter,
  ChannelTurnDeliveryAdapter,
} from "./types.js";

type AnyChannelDeliveryAdapter = ChannelEventDeliveryAdapter | ChannelTurnDeliveryAdapter;

export type PendingChannelDeliveryAttempt = {
  payload: ReplyPayload;
  info: ChannelDeliveryInfo;
  result?: ChannelDeliveryResult | void;
  error?: unknown;
};

type SettledChannelDeliveryFailure = {
  error: unknown;
  info: ChannelDeliveryInfo;
};

export function resolvePartialChannelDeliveryResult(
  error: unknown,
): ChannelPartialDeliveryError["deliveryResult"] | undefined {
  return isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
}

export function isExplicitlyNonVisibleChannelDelivery(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    (result as { visibleReplySent?: unknown }).visibleReplySent === false
  );
}

function markChannelDeliveryErrorVisible(error: unknown): unknown {
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    try {
      Object.assign(error, { sentBeforeError: true, visibleReplySent: true });
      return error;
    } catch {
      // Fall back to a wrapper when a platform error object is non-extensible.
    }
  }
  const visibleError = new Error("visible channel reply delivery failed", { cause: error });
  Object.assign(visibleError, { sentBeforeError: true, visibleReplySent: true });
  return visibleError;
}

export async function runChannelDeliveryObserver(params: {
  onDelivered: AnyChannelDeliveryAdapter["onDelivered"] | undefined;
  payload: ReplyPayload;
  info: Parameters<NonNullable<ChannelEventDeliveryAdapter["onDelivered"]>>[1];
  result: Parameters<NonNullable<ChannelEventDeliveryAdapter["onDelivered"]>>[2];
}): Promise<void> {
  if (!params.onDelivered) {
    return;
  }
  try {
    await params.onDelivered(params.payload, params.info, params.result);
  } catch (error: unknown) {
    throw isExplicitlyNonVisibleChannelDelivery(params.result)
      ? error
      : markChannelDeliveryErrorVisible(error);
  }
}

function resolveChannelDeliveryMessageId(
  result: ChannelDeliveryOutcome | undefined,
): string | undefined {
  return result?.receipt
    ? resolveMessageReceiptPrimaryId(result.receipt)
    : result?.messageIds?.find((messageId) => messageId.trim());
}

// Partial delivery is terminally delivered; permanent no-send is suppressed;
// retryable no-send is replayable; ambiguity remains unknown for later notice.
export async function settleFailedPendingFinalDelivery(
  payload: ReplyPayload,
  error: unknown,
): Promise<void> {
  const completion = resolvePendingFinalCompletion(payload);
  if (!completion) {
    return;
  }
  if (resolvePartialChannelDeliveryResult(error) !== undefined) {
    await settlePendingFinalDelivery(completion, "delivered", ["queued", "unknown"]);
  } else if (isPlatformMessageRejectedError(error)) {
    await settlePendingFinalDelivery(completion, "suppressed", ["prepared", "queued", "unknown"]);
  } else if (isPlatformMessageNotDispatchedError(error)) {
    await settlePendingFinalDelivery(completion, "prepared", ["queued", "unknown"]);
  } else {
    await settlePendingFinalDelivery(completion, "unknown", ["queued", "unknown"]);
  }
}

export async function settleChannelDeliveryAttempt(params: {
  attempt: PendingChannelDeliveryAttempt;
  onDelivered: AnyChannelDeliveryAdapter["onDelivered"] | undefined;
  onFinalizationError?: (error: unknown) => Promise<void> | void;
  emitMessageSent?: ReturnType<typeof createMessageSentEmitter>["emitMessageSent"];
}): Promise<ChannelDeliveryResult | undefined> {
  const { attempt } = params;
  if ("error" in attempt) {
    const partial = resolvePartialChannelDeliveryResult(attempt.error);
    if (!isPlatformMessageNotDispatchedError(attempt.error)) {
      params.emitMessageSent?.({
        success: false,
        content: partial?.content ?? attempt.payload.text ?? "",
        error: formatErrorMessage(attempt.error),
        messageId: resolveChannelDeliveryMessageId(partial),
      });
    }
    return undefined;
  }

  let finalized: ChannelDeliveryResult | undefined;
  try {
    const result = attempt.result;
    finalized = result
      ? result.finalization
        ? { ...result, ...(await result.finalization), finalization: undefined }
        : result
      : undefined;
  } catch (error: unknown) {
    try {
      await params.onFinalizationError?.(error);
    } catch {
      // Error observers are best-effort and must not replace the native settlement failure.
    }
    await settleFailedPendingFinalDelivery(attempt.payload, error);
    const partial = resolvePartialChannelDeliveryResult(error);
    if (!isPlatformMessageNotDispatchedError(error)) {
      params.emitMessageSent?.({
        success: false,
        content: partial?.content ?? attempt.payload.text ?? "",
        error: formatErrorMessage(error),
        messageId: resolveChannelDeliveryMessageId(partial),
      });
    }
    throw toErrorObject(error, "channel delivery finalization failed");
  }

  if (!isExplicitlyNonVisibleChannelDelivery(finalized)) {
    params.emitMessageSent?.({
      success: true,
      content: finalized?.content ?? attempt.payload.text ?? "",
      messageId: resolveChannelDeliveryMessageId(finalized),
    });
  }
  const completion = resolvePendingFinalCompletion(attempt.payload);
  if (completion) {
    await settlePendingFinalDelivery(
      completion,
      isExplicitlyNonVisibleChannelDelivery(finalized) ? "suppressed" : "delivered",
    );
  }
  await runChannelDeliveryObserver({
    onDelivered: params.onDelivered,
    payload: attempt.payload,
    info: attempt.info,
    result: finalized,
  });
  return finalized;
}

export async function settleChannelDeliveryAttempts(params: {
  attempts: readonly PendingChannelDeliveryAttempt[];
  delivery: AnyChannelDeliveryAdapter;
  emitMessageSent?: ReturnType<typeof createMessageSentEmitter>["emitMessageSent"];
  onSettled?: (info: ChannelDeliveryInfo, result: ChannelDeliveryResult | undefined) => void;
}): Promise<SettledChannelDeliveryFailure[]> {
  const failures: SettledChannelDeliveryFailure[] = [];
  for (const attempt of params.attempts) {
    try {
      const finalized = await settleChannelDeliveryAttempt({
        attempt,
        onDelivered: params.delivery.onDelivered,
        onFinalizationError: async (error) => {
          await Promise.resolve(params.delivery.onError?.(error, attempt.info));
        },
        emitMessageSent: params.emitMessageSent,
      });
      params.onSettled?.(attempt.info, finalized);
    } catch (error: unknown) {
      failures.push({ error, info: attempt.info });
    }
  }
  return failures;
}
