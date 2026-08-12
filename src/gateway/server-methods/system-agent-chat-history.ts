import {
  validateSystemAgentChatHistoryParams,
  type SystemAgentChatHistoryWizardAction,
  type SystemAgentChatParams,
  type WizardStep,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import { resolveSystemAgentDelegationKey } from "../../system-agent/delegation-session.js";
import { appendTranscriptTurn, readTranscriptTail } from "../../system-agent/transcript-store.js";
import { runSystemAgentGatewayTask } from "./system-agent-gateway-queue.js";
import { getSystemAgentSessionQueue } from "./system-agent-session-queue.js";
import type { GatewayClient, GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

const DEFAULT_SYSTEM_AGENT_HISTORY_LIMIT = 100;

function projectWizardReceiptStep(step: WizardStep): SystemAgentChatHistoryWizardAction["step"] {
  // Auth controls mirror one-time codes and URLs into their prompt copy. Active recovery
  // owns the full live step; durable receipts keep only ordinary, non-sensitive prompts.
  const promptIsDurable = !step.sensitive && !step.deviceCode && !step.externalUrl;
  return {
    id: step.id,
    type: step.type,
    ...(promptIsDurable && step.title ? { title: step.title } : {}),
    ...(promptIsDurable && step.message ? { message: step.message } : {}),
  };
}

export async function captureSystemAgentWizardAction(
  engine: Pick<SystemAgentChatEngine, "activeWizardStep">,
  input: SystemAgentChatParams,
): Promise<SystemAgentChatHistoryWizardAction | undefined> {
  const kind = input.wizardAnswer ? "answer" : input.wizardCancel ? "cancel" : undefined;
  const stepId = input.wizardAnswer?.stepId ?? input.wizardCancel?.stepId;
  if (!kind || !stepId) {
    return undefined;
  }
  const step = await engine.activeWizardStep();
  return step?.id === stepId ? { kind, step: projectWizardReceiptStep(step) } : undefined;
}

export function persistSystemAgentEngineHistory(
  engine: Pick<SystemAgentChatEngine, "historySince">,
  startIndex: number,
  params: {
    sessionId: string;
    incarnationId: string;
    wizardAction?: SystemAgentChatHistoryWizardAction;
    wizardActionAccepted?: boolean;
  },
): void {
  const at = Date.now();
  let wizardAction = params.wizardActionAccepted === true ? params.wizardAction : undefined;
  for (const turn of engine.historySince(startIndex)) {
    const action = turn.role === "user" ? wizardAction : undefined;
    appendTranscriptTurn(
      {
        ...turn,
        at,
        ...(action ? { wizardAction: action } : {}),
      },
      {
        session: {
          sessionId: params.sessionId,
          incarnationId: params.incarnationId,
        },
      },
    );
    if (action) {
      wizardAction = undefined;
    }
  }
}

export function resolveSystemAgentSessionOwnerKey(params: {
  delegation?: { agentId?: string; sessionKey?: string };
  client: GatewayClient | null;
}): string | undefined {
  const delegationKey = resolveSystemAgentDelegationKey(params.delegation);
  if (delegationKey !== undefined) {
    // Delegation is the host-only, cross-connection owner asserted by the regular-agent
    // tool path. Keep its agent/session tuple authoritative across gateway reconnects.
    return delegationKey;
  }
  // Authenticated users survive reconnects and may span paired devices. Otherwise
  // bind to the verified device, with the server-issued connection as a last resort.
  const userId = params.client?.authenticatedUserId?.trim();
  if (userId) {
    return `user:${userId}`;
  }
  const deviceId = params.client?.connect.device?.id.trim();
  if (deviceId) {
    return `device:${deviceId}`;
  }
  const connId = params.client?.connId?.trim();
  return connId ? `connection:${connId}` : undefined;
}

export const systemAgentChatHistoryHandler: GatewayRequestHandler = async ({
  params,
  respond,
  client,
  context,
}) => {
  if (
    !assertValidParams(
      params,
      validateSystemAgentChatHistoryParams,
      "openclaw.chat.history",
      respond,
    )
  ) {
    return;
  }
  const requestedSessionId = params.sessionId;
  const session = requestedSessionId
    ? context.systemAgentSessions.get(requestedSessionId)
    : undefined;
  const ownerKey = resolveSystemAgentSessionOwnerKey({ client });
  const recovery =
    requestedSessionId && session && ownerKey === session.ownerKey
      ? await runSystemAgentGatewayTask(
          async () =>
            await getSystemAgentSessionQueue(context.systemAgentSessions).enqueue(
              requestedSessionId,
              async () => {
                if (context.systemAgentSessions.get(requestedSessionId) !== session) {
                  return undefined;
                }
                session.lastUsedAt = Date.now();
                return {
                  turns: readTranscriptTail(params.limit ?? DEFAULT_SYSTEM_AGENT_HISTORY_LIMIT, {
                    afterLastReset: true,
                    session: {
                      sessionId: requestedSessionId,
                      incarnationId: session.transcriptIncarnationId,
                    },
                  }),
                  step: await session.engine.activeWizardStep(),
                };
              },
            ),
        )
      : undefined;
  const turns =
    recovery?.turns ?? readTranscriptTail(params.limit ?? DEFAULT_SYSTEM_AGENT_HISTORY_LIMIT);
  respond(
    true,
    {
      turns,
      ...(requestedSessionId && recovery?.step
        ? { activeWizard: { sessionId: requestedSessionId, step: recovery.step } }
        : {}),
    },
    undefined,
  );
};
