import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  findPlatformMessageRejectedError,
  isProvenDeliveryNotSentError,
} from "../../infra/delivery-recovery.shared.js";
import { collectErrorGraphCandidates } from "../../infra/errors.js";
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";

export type ReplyDispatchDeliveryFailure = {
  kind: ReplyDispatchKind;
  outcome: "failed-before-deliver" | "failed-deliver";
  error: unknown;
};

const failuresByDispatcher = new WeakMap<ReplyDispatcher, ReplyDispatchDeliveryFailure[]>();

export function isRetryableNoSendFailure(error: unknown): boolean {
  return (
    isProvenDeliveryNotSentError(error) &&
    !findPlatformMessageRejectedError(error) &&
    !collectErrorGraphCandidates(error, (candidate) => [
      candidate.cause,
      candidate.original,
      candidate.error,
      candidate.reason,
      ...(Array.isArray(candidate.errors) ? candidate.errors : []),
    ]).some(
      (candidate) =>
        isRecord(candidate) &&
        (candidate.sentBeforeError === true ||
          candidate.visibleReplySent === true ||
          (isRecord(candidate.deliveryResult) &&
            candidate.deliveryResult.visibleReplySent === true)),
    )
  );
}

/** Keeps raw delivery errors private while the controller derives a redacted terminal. */
export function registerReplyDispatcherDeliveryFailures(
  dispatcher: ReplyDispatcher,
  failures: ReplyDispatchDeliveryFailure[],
): void {
  failuresByDispatcher.set(dispatcher, failures);
}

export function readReplyDispatcherDeliveryFailures(
  dispatcher: ReplyDispatcher,
): readonly ReplyDispatchDeliveryFailure[] {
  return failuresByDispatcher.get(dispatcher)?.slice() ?? [];
}
