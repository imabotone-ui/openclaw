// Feishu plugin module implements send result behavior.
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

type FeishuMessageApiResponse = {
  code?: number;
  msg?: string;
  data?: {
    message_id?: string;
  };
};

const FEISHU_PROVIDER_DIAGNOSTIC_MAX_CHARS = 500;

function normalizeFeishuProviderDiagnostic(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized
    ? sliceUtf16Safe(normalized, 0, FEISHU_PROVIDER_DIAGNOSTIC_MAX_CHARS)
    : undefined;
}

function createFeishuMessageRejection(params: {
  response: unknown;
  errorPrefix: string;
  cause: unknown;
  detail?: string;
}): PlatformMessageNotDispatchedError | undefined {
  const response = isRecord(params.response) ? params.response : undefined;
  if (!response) {
    return undefined;
  }
  if (typeof response.code !== "number" || response.code === 0) {
    return undefined;
  }
  const providerMessage = normalizeFeishuProviderDiagnostic(response.msg);
  const detail =
    params.detail ??
    (providerMessage ? `${providerMessage} (code=${response.code})` : `code ${response.code}`);
  return new PlatformMessageNotDispatchedError(`${params.errorPrefix}: ${detail}`, {
    cause: params.cause,
    retryable: false,
  });
}

export function createFeishuRejectedMessageApiError(
  error: unknown,
  errorPrefix: string,
): PlatformMessageNotDispatchedError | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const response = isRecord(error.response) ? error.response : undefined;
  const data = isRecord(response?.data) ? response.data : undefined;
  const nestedError = isRecord(data?.error) ? data.error : undefined;
  return data
    ? createFeishuMessageRejection({
        response: data,
        errorPrefix,
        cause: error,
        detail: JSON.stringify({
          http_status: typeof response?.status === "number" ? response.status : undefined,
          feishu_code: typeof data.code === "number" ? data.code : undefined,
          feishu_msg: normalizeFeishuProviderDiagnostic(data.msg),
          feishu_log_id:
            normalizeFeishuProviderDiagnostic(data.log_id) ??
            normalizeFeishuProviderDiagnostic(nestedError?.log_id),
          feishu_troubleshooter:
            normalizeFeishuProviderDiagnostic(data.troubleshooter) ??
            normalizeFeishuProviderDiagnostic(nestedError?.troubleshooter),
        }),
      })
    : undefined;
}

export function resolveFeishuReceiptKind(msgType?: string): MessageReceiptPartKind {
  switch (msgType) {
    case "audio":
      return "voice";
    case "image":
    case "media":
    case "file":
      return "media";
    case "interactive":
      return "card";
    case "post":
    case "text":
      return "text";
    default:
      return "unknown";
  }
}

export function createFeishuSendReceipt(params: {
  messageId?: string;
  chatId: string;
  kind?: MessageReceiptPartKind;
}): MessageReceipt {
  const messageId = params.messageId?.trim();
  const chatId = params.chatId.trim();
  return createMessageReceiptFromOutboundResults({
    results: messageId
      ? [
          {
            channel: "feishu",
            messageId,
            chatId,
            conversationId: chatId,
          },
        ]
      : [],
    ...(chatId ? { threadId: chatId } : {}),
    kind: params.kind ?? "unknown",
  });
}

export function assertFeishuMessageApiSuccess(
  response: FeishuMessageApiResponse,
  errorPrefix: string,
) {
  if (response.code === 0) {
    return;
  }
  const rejection = createFeishuMessageRejection({ response, errorPrefix, cause: response });
  if (rejection) {
    throw rejection;
  }
  throw new Error(`${errorPrefix}: ${response.msg || `code ${response.code}`}`);
}

export function toFeishuSendResult(
  response: FeishuMessageApiResponse,
  chatId: string,
  kind?: MessageReceiptPartKind,
  errorPrefix = "Feishu send failed",
): {
  messageId: string;
  chatId: string;
  receipt: MessageReceipt;
} {
  const messageId = response.data?.message_id?.trim();
  if (!messageId) {
    // Feishu already accepted this send; an ordinary error would invite a duplicate retry.
    throw createChannelPartialDeliveryError(new Error(`${errorPrefix}: no message_id returned`), {
      messageIds: [],
      visibleReplySent: true,
    });
  }
  return {
    messageId,
    chatId,
    receipt: createFeishuSendReceipt({ messageId, chatId, kind }),
  };
}
