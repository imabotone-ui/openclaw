import { dispatchInboundMessageWithRoutedChannelDispatcher } from "../../auto-reply/dispatch.js";
import { copyReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { suppressPendingFinalDelivery } from "../../auto-reply/reply/dispatch-from-config.pending-final.js";
import type { DispatchFromConfigResult } from "../../auto-reply/reply/dispatch-from-config.types.js";
import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.types.js";
import { runWithSessionInitConflictRetry } from "../../auto-reply/reply/session-init-conflict-retry.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  deriveInboundMessageHookContext,
  resolveInboundReplyHookTarget,
} from "../../hooks/message-hook-mappers.js";
import { toErrorObject } from "../../infra/errors.js";
import { applyMessageSendingHook } from "../../infra/outbound/deliver-hooks.js";
import { normalizeEmptyPayloadForDelivery } from "../../infra/outbound/deliver-payload.js";
import { createMessageSentEmitter } from "../../infra/outbound/message-sent-hook.js";
import { summarizeOutboundPayloadForTransport } from "../../infra/outbound/payloads.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { createChannelReplyPipeline } from "../message/reply-pipeline.js";
import { recordInboundSession } from "../session.js";
import { createSuppressedChannelDeliveryResult } from "./delivery-result.js";
import {
  isExplicitlyNonVisibleChannelDelivery,
  resolvePartialChannelDeliveryResult,
  runChannelDeliveryObserver,
  settleChannelDeliveryAttempt,
  settleChannelDeliveryAttempts,
  settleFailedPendingFinalDelivery,
  type PendingChannelDeliveryAttempt,
} from "./delivery-settlement.js";
import {
  applySettledChannelDeliveryFailure,
  emitChannelDeliveryTerminalObservations,
} from "./delivery-terminal.js";
import {
  createDirectPendingFinalCustody,
  NO_PENDING_FINAL_CUSTODY,
  toCoreManagedDeliveryInfo,
} from "./direct-delivery-custody.js";
import {
  deliverInboundReplyWithMessageSendContextCore,
  isDurableInboundReplyDeliveryHandled,
  throwIfDurableInboundReplyDeliveryFailed,
} from "./durable-delivery.js";
import { runPreparedChannelTurnCore } from "./execution.js";
import type {
  AssembledChannelTurn,
  ChannelEventDeliveryAdapter,
  ChannelDeliveryInfo,
  ChannelDeliveryResult,
  ChannelTurnDeliveryAdapter,
  ChannelTurnPlan,
  ChannelProviderOwnedMessageSendingDeliveryAdapter,
  ChannelTurnResolved,
  ChannelTurnResult,
  PreparedChannelTurn,
} from "./types.js";

type RoutedAssembledChannelTurn = Omit<
  AssembledChannelTurn,
  "delivery" | "dispatchReplyWithBufferedBlockDispatcher"
> & {
  delivery: ChannelTurnDeliveryAdapter;
};

type DispatchableChannelTurn = AssembledChannelTurn | RoutedAssembledChannelTurn;
export function assembleResolvedChannelTurn<
  TDispatchResult,
  TDelivery extends ChannelTurnDeliveryAdapter,
>(
  value: ChannelTurnResolved<TDispatchResult, TDelivery>,
): AssembledChannelTurn | RoutedAssembledChannelTurn | PreparedChannelTurn<TDispatchResult> {
  if (!("route" in value)) {
    return value;
  }
  if ("runDispatch" in value) {
    const { cfg, route, ...turn } = value;
    return {
      ...turn,
      ctxPayload: route.dmScope ? { ...turn.ctxPayload, DmScope: route.dmScope } : turn.ctxPayload,
      routeSessionKey: route.sessionKey,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: route.agentId }),
      recordInboundSession,
    };
  }
  const { cfg, route, ...turn } = value;
  const assembled: RoutedAssembledChannelTurn = {
    ...turn,
    ctxPayload: route.dmScope ? { ...turn.ctxPayload, DmScope: route.dmScope } : turn.ctxPayload,
    cfg,
    agentId: route.agentId,
    routeSessionKey: route.sessionKey,
    storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: route.agentId }),
    recordInboundSession,
  };
  return assembled;
}

function resolveAssembledReplyPipeline(
  params: DispatchableChannelTurn,
): Pick<AssembledChannelTurn, "dispatcherOptions" | "replyOptions"> {
  const turnAdoptionLifecycle =
    params.turnAdoptionLifecycle ?? params.replyOptions?.turnAdoptionLifecycle;
  if (!params.replyPipeline) {
    return {
      dispatcherOptions: params.dispatcherOptions,
      replyOptions: turnAdoptionLifecycle
        ? { ...params.replyOptions, turnAdoptionLifecycle }
        : params.replyOptions,
    };
  }
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: params.channel,
    accountId: params.accountId,
    ...params.replyPipeline,
  });
  return {
    dispatcherOptions: {
      ...replyPipeline,
      ...params.dispatcherOptions,
    },
    replyOptions: {
      onModelSelected,
      ...params.replyOptions,
      ...(turnAdoptionLifecycle ? { turnAdoptionLifecycle } : {}),
    },
  };
}

async function applyRoutedDirectMessageSending(params: {
  turn: RoutedAssembledChannelTurn;
  payload: ReplyPayload;
}): Promise<{ payload: ReplyPayload; suppression?: ChannelDeliveryResult }> {
  const hookRunner = getGlobalHookRunner();
  const hookCtx = deriveInboundMessageHookContext(params.turn.ctxPayload);
  const hookResult = await applyMessageSendingHook({
    hookRunner,
    enabled: hookRunner?.hasHooks("message_sending") ?? false,
    payload: params.payload,
    payloadSummary: summarizeOutboundPayloadForTransport(params.payload),
    to: resolveInboundReplyHookTarget(params.turn.ctxPayload, hookCtx),
    channel: params.turn.channel,
    accountId: params.turn.accountId,
    replyToId:
      params.payload.replyToId ??
      params.turn.ctxPayload.ReplyToIdFull ??
      params.turn.ctxPayload.ReplyToId,
    threadId: params.turn.ctxPayload.MessageThreadId,
    sessionKey: params.turn.routeSessionKey,
  });
  if (hookResult.cancelled) {
    return {
      payload: params.payload,
      suppression: createSuppressedChannelDeliveryResult({
        reason: "cancelled_by_message_sending_hook",
        cancelReason: hookResult.cancelReason,
        metadata: hookResult.hookMetadata,
      }),
    };
  }
  const payload = normalizeEmptyPayloadForDelivery(hookResult.payload);
  if (!payload) {
    return {
      payload: hookResult.payload,
      suppression: createSuppressedChannelDeliveryResult({
        reason: hookResult.contentRewritten
          ? "empty_after_message_sending_hook"
          : "no_visible_payload",
      }),
    };
  }
  return { payload: copyReplyPayloadMetadata(params.payload, payload) };
}

function reconcileNonVisibleChannelDeliveries(
  result: DispatchFromConfigResult,
  nonVisibleCounts: Readonly<Record<ReplyDispatchKind, number>>,
): DispatchFromConfigResult {
  const counts = {
    tool: Math.max(0, result.counts.tool - nonVisibleCounts.tool),
    block: Math.max(0, result.counts.block - nonVisibleCounts.block),
    final: Math.max(0, result.counts.final - nonVisibleCounts.final),
  };
  return {
    ...result,
    queuedFinal: result.queuedFinal && counts.final > 0,
    counts,
  };
}

function createObserveOnlyDeliveryAdapter(): ChannelEventDeliveryAdapter {
  // Observe-only turns still run the agent, but transport delivery must remain impossible for
  // every assembled-turn entry point, including direct SDK dispatch.
  return {
    deliver: async () => ({ visibleReplySent: false }),
  };
}

async function dispatchChannelTurnWithDeliveryOwner(
  ...args:
    | [params: AssembledChannelTurn, ownership: "legacy-dispatcher"]
    | [params: RoutedAssembledChannelTurn, ownership: "routed-delivery"]
): Promise<ChannelTurnResult> {
  const [params, ownership] = args;
  const replyPipeline = resolveAssembledReplyPipeline(params);
  const turnAdoptionLifecycle =
    params.turnAdoptionLifecycle ?? params.replyOptions?.turnAdoptionLifecycle;
  const delivery =
    params.admission?.kind === "observeOnly" ? createObserveOnlyDeliveryAdapter() : params.delivery;
  const pendingDeliveryAttempts: PendingChannelDeliveryAttempt[] = [];
  const normalizationSuppressionAttempts: PendingChannelDeliveryAttempt[] = [];
  const nonVisibleDeliveryCounts: Record<ReplyDispatchKind, number> = {
    tool: 0,
    block: 0,
    final: 0,
  };
  const recordSettledDelivery = (
    info: ChannelDeliveryInfo,
    result: ChannelDeliveryResult | undefined,
  ) => {
    if (isExplicitlyNonVisibleChannelDelivery(result)) {
      nonVisibleDeliveryCounts[info.kind] += 1;
    }
  };
  let agentRunId: string | undefined;
  const onAgentRunStart = replyPipeline.replyOptions?.onAgentRunStart;
  const replyOptions = delivery.observeMessageSent
    ? {
        ...replyPipeline.replyOptions,
        onAgentRunStart: (runId: string) => {
          agentRunId = runId;
          onAgentRunStart?.(runId);
        },
      }
    : replyPipeline.replyOptions;
  const hookCtx = delivery.observeMessageSent
    ? deriveInboundMessageHookContext(params.ctxPayload)
    : undefined;
  let messageSentEmitter: ReturnType<typeof createMessageSentEmitter> | undefined;
  const getMessageSentEmitter = () => {
    if (!delivery.observeMessageSent || !hookCtx) {
      return undefined;
    }
    messageSentEmitter ??= createMessageSentEmitter({
      hookRunner: getGlobalHookRunner(),
      channel: params.channel,
      to: resolveInboundReplyHookTarget(params.ctxPayload, hookCtx),
      accountId: params.accountId,
      sessionKeyForInternalHooks: params.routeSessionKey,
      runId: agentRunId,
      isGroup: hookCtx.isGroup,
      groupId: hookCtx.groupId,
      logPrefix: "dispatchAssembledChannelTurn",
    });
    return messageSentEmitter;
  };
  return await runPreparedChannelTurnCore(
    {
      channel: params.channel,
      accountId: params.accountId,
      routeSessionKey: params.routeSessionKey,
      storePath: params.storePath,
      ctxPayload: params.ctxPayload,
      recordInboundSession: params.recordInboundSession,
      afterRecord: params.afterRecord,
      record: params.record,
      history: params.history,
      admission: params.admission,
      botLoopProtection: params.botLoopProtection,
      outboundEchoSourceId: params.outboundEchoSourceId,
      log: params.log,
      messageId: params.messageId,
      ...(turnAdoptionLifecycle
        ? {
            runDispatchLifecycle: {
              turnAdoptionLifecycle,
              onDispatchSkipped: async () => await turnAdoptionLifecycle.onAdopted(),
            },
          }
        : {}),
      runDispatch: async () => {
        const deliveryStartedAt = Date.now();
        let dispatchResult:
          | Awaited<ReturnType<AssembledChannelTurn["dispatchReplyWithBufferedBlockDispatcher"]>>
          | undefined;
        let dispatchError: unknown;
        try {
          dispatchResult = await runWithSessionInitConflictRetry(
            () =>
              (ownership === "routed-delivery"
                ? dispatchInboundMessageWithRoutedChannelDispatcher
                : params.dispatchReplyWithBufferedBlockDispatcher)({
                ctx: params.ctxPayload,
                cfg: params.cfg,
                ...(ownership === "routed-delivery"
                  ? {
                      ...(params.admission?.kind === "observeOnly"
                        ? { suppressOutboundHooks: true as const }
                        : {}),
                      onReplyPayloadSuppressed: async (
                        payload: ReplyPayload,
                        info: ChannelDeliveryInfo,
                        reason:
                          | "cancelled_by_reply_payload_sending_hook"
                          | "empty_after_reply_payload_sending_hook",
                      ) => {
                        await suppressPendingFinalDelivery(payload);
                        await runChannelDeliveryObserver({
                          onDelivered: delivery.onDelivered,
                          payload,
                          info,
                          result: createSuppressedChannelDeliveryResult({ reason }),
                        });
                      },
                    }
                  : {}),
                dispatcherOptions: {
                  ...replyPipeline.dispatcherOptions,
                  onSkip: (payload, info) => {
                    replyPipeline.dispatcherOptions?.onSkip?.(payload, info);
                    if (info.reason !== "channel_transform") {
                      return;
                    }
                    const { reason: _reason, ...deliveryInfo } = info;
                    normalizationSuppressionAttempts.push({
                      payload,
                      info: deliveryInfo,
                      result: createSuppressedChannelDeliveryResult({ reason: info.reason }),
                    });
                  },
                  deliver: async (payload: ReplyPayload, info: ChannelDeliveryInfo) => {
                    const preparedPayloadResult = delivery.preparePayload
                      ? await delivery.preparePayload(payload, info)
                      : payload;
                    const preparedPayload =
                      preparedPayloadResult === null
                        ? null
                        : copyReplyPayloadMetadata(payload, preparedPayloadResult);
                    if (preparedPayload === null) {
                      const suppression = createSuppressedChannelDeliveryResult({
                        reason: "no_visible_payload",
                      });
                      await suppressPendingFinalDelivery(payload);
                      await runChannelDeliveryObserver({
                        onDelivered: delivery.onDelivered,
                        payload,
                        info,
                        result: suppression,
                      });
                      recordSettledDelivery(info, suppression);
                      return suppression;
                    }
                    const declaredDurable = "durable" in delivery ? delivery.durable : undefined;
                    const durableOptions =
                      typeof declaredDurable === "function"
                        ? await declaredDurable(preparedPayload, info)
                        : declaredDurable;
                    if (durableOptions) {
                      const durable = await deliverInboundReplyWithMessageSendContextCore({
                        cfg: params.cfg,
                        channel: params.channel,
                        accountId: params.accountId,
                        agentId: params.agentId,
                        ctxPayload: params.ctxPayload,
                        payload: preparedPayload,
                        info,
                        ...durableOptions,
                      });
                      throwIfDurableInboundReplyDeliveryFailed(durable);
                      if (isDurableInboundReplyDeliveryHandled(durable)) {
                        // Durable sends already emit canonical message_sent from
                        // deliverOutboundPayloadsInternal after outbound hooks settle.
                        await runChannelDeliveryObserver({
                          onDelivered: delivery.onDelivered,
                          payload: preparedPayload,
                          info,
                          result: durable.delivery,
                        });
                        recordSettledDelivery(info, durable.delivery);
                        return durable.delivery;
                      }
                    }
                    let effectivePayload = preparedPayload;
                    let result: ChannelDeliveryResult | void = undefined;
                    let directInfo: ChannelDeliveryInfo = info;
                    try {
                      if (
                        ownership === "routed-delivery" &&
                        "deliverWithProviderMessageSending" in delivery &&
                        delivery.deliverWithProviderMessageSending
                      ) {
                        const providerInfo = {
                          ...info,
                          ...(createDirectPendingFinalCustody(effectivePayload) ??
                            NO_PENDING_FINAL_CUSTODY),
                        };
                        directInfo = providerInfo;
                        result = await delivery.deliverWithProviderMessageSending(
                          effectivePayload,
                          providerInfo,
                        );
                      } else {
                        if (
                          ownership === "routed-delivery" &&
                          params.admission?.kind !== "observeOnly"
                        ) {
                          const hook = await applyRoutedDirectMessageSending({
                            turn: params as RoutedAssembledChannelTurn,
                            payload: effectivePayload,
                          });
                          effectivePayload = hook.payload;
                          if (hook.suppression) {
                            result = hook.suppression;
                          }
                        }
                        if (!result) {
                          if (!("deliver" in delivery) || !delivery.deliver) {
                            throw new Error(
                              "channel delivery adapter is missing a direct deliverer",
                            );
                          }
                          const custody = createDirectPendingFinalCustody(effectivePayload);
                          await custody?.onPlatformSendDispatch();
                          result = await delivery.deliver(
                            effectivePayload,
                            toCoreManagedDeliveryInfo(info),
                          );
                        }
                      }
                    } catch (error: unknown) {
                      await settleFailedPendingFinalDelivery(effectivePayload, error);
                      if (delivery.observeMessageSent) {
                        await settleChannelDeliveryAttempt({
                          attempt: {
                            payload: effectivePayload,
                            info: directInfo,
                            error,
                          },
                          onDelivered: delivery.onDelivered,
                          emitMessageSent: getMessageSentEmitter()?.emitMessageSent,
                        });
                      }
                      throw error;
                    }
                    if (result?.finalization) {
                      // Finalization can reject while the buffered dispatcher is still unwinding.
                      // Observe it now; settlement still awaits the original promise and its error.
                      void result.finalization.catch(() => undefined);
                      pendingDeliveryAttempts.push({
                        payload: effectivePayload,
                        info: directInfo,
                        result,
                      });
                    } else {
                      const finalized = await settleChannelDeliveryAttempt({
                        attempt: {
                          payload: effectivePayload,
                          info: directInfo,
                          result,
                        },
                        onDelivered: delivery.onDelivered,
                        emitMessageSent: delivery.observeMessageSent
                          ? getMessageSentEmitter()?.emitMessageSent
                          : undefined,
                      });
                      recordSettledDelivery(info, finalized);
                    }
                    return result;
                  },
                  onError: delivery.onError,
                },
                toolsAllow: params.toolsAllow,
                replyOptions,
                replyResolver: params.replyResolver,
              }),
            params.sessionInitRetry
              ? {
                  retryDelaysMs: params.sessionInitRetry.delaysMs,
                  signal: params.sessionInitRetry.signal,
                  sleep: params.sessionInitRetry.sleep,
                }
              : undefined,
          );
        } catch (error: unknown) {
          dispatchError = error;
        }

        const settlementFailures = [
          ...(await settleChannelDeliveryAttempts({
            attempts: normalizationSuppressionAttempts,
            delivery,
          })),
          ...(await settleChannelDeliveryAttempts({
            attempts: pendingDeliveryAttempts,
            delivery,
            emitMessageSent: getMessageSentEmitter()?.emitMessageSent,
            onSettled: recordSettledDelivery,
          })),
        ];
        if (dispatchError !== undefined) {
          // A visible partial settlement owns replay safety even when dispatch also failed.
          // Preserve that typed error so callers do not retry an already-visible payload.
          const partialFailure = settlementFailures.find(
            (failure) => resolvePartialChannelDeliveryResult(failure.error) !== undefined,
          );
          if (partialFailure) {
            throw toErrorObject(partialFailure.error, "channel delivery settlement failed");
          }
          throw toErrorObject(dispatchError, "channel dispatch failed");
        }
        const settledResult =
          ownership === "routed-delivery"
            ? reconcileNonVisibleChannelDeliveries(dispatchResult!, nonVisibleDeliveryCounts)
            : dispatchResult!;
        const finalResult = settlementFailures.reduce(
          (result, failure) =>
            applySettledChannelDeliveryFailure(result, {
              error: failure.error,
              kind: failure.info.kind,
            }),
          settledResult,
        );
        const deliveryTerminal = finalResult.deliveryTerminal;
        if (deliveryTerminal && deliveryTerminal.outcome !== "delivered") {
          const target = resolveInboundReplyHookTarget(
            params.ctxPayload,
            hookCtx ?? deriveInboundMessageHookContext(params.ctxPayload),
          );
          emitChannelDeliveryTerminalObservations({
            terminal: deliveryTerminal,
            channel: params.channel,
            to: target,
            ...(params.accountId ? { accountId: params.accountId } : {}),
            agentId: params.agentId,
            ...(agentRunId ? { runId: agentRunId } : {}),
            sessionKey: params.routeSessionKey,
            chatType: params.ctxPayload.ChatType,
            startedAt: deliveryStartedAt,
          });
        }
        return finalResult;
      },
    },
    { suppressObserveOnlyDispatch: false },
  );
}

export async function dispatchAssembledChannelTurn(
  params: AssembledChannelTurn,
): Promise<ChannelTurnResult> {
  return await dispatchChannelTurnWithDeliveryOwner(params, "legacy-dispatcher");
}

export function dispatchRoutedChannelTurn(
  params: ChannelTurnPlan<ChannelTurnDeliveryAdapter>,
): Promise<ChannelTurnResult>;
export function dispatchRoutedChannelTurn(
  params: ChannelTurnPlan<ChannelProviderOwnedMessageSendingDeliveryAdapter>,
): Promise<ChannelTurnResult>;
export function dispatchRoutedChannelTurn(params: ChannelTurnPlan): Promise<ChannelTurnResult>;
export async function dispatchRoutedChannelTurn(
  params: ChannelTurnPlan<ChannelTurnDeliveryAdapter>,
): Promise<ChannelTurnResult> {
  const assembled = assembleResolvedChannelTurn(params);
  return await dispatchChannelTurnWithDeliveryOwner(
    assembled as RoutedAssembledChannelTurn,
    "routed-delivery",
  );
}
