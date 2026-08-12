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
const FEISHU_REJECTION_DIAGNOSTIC_MAX_CHARS = 2_000;
const FEISHU_REJECTION_STRING_FIELDS = [
  "feishu_msg",
  "feishu_log_id",
  "feishu_troubleshooter",
] as const;

function normalizeFeishuProviderDiagnostic(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized
    ? sliceUtf16Safe(normalized, 0, FEISHU_PROVIDER_DIAGNOSTIC_MAX_CHARS)
    : undefined;
}

function serializeFeishuRejectionDiagnostics(details: {
  http_status?: number;
  feishu_code?: number;
  feishu_msg?: string;
  feishu_log_id?: string;
  feishu_troubleshooter?: string;
}): string {
  const serialized = JSON.stringify(details);
  if (serialized.length <= FEISHU_REJECTION_DIAGNOSTIC_MAX_CHARS) {
    return serialized;
  }
  const bounded = { ...details };
  let candidate = serialized;
  // JSON escaping can expand pre-bounded inputs sixfold. Trim the longest encoded
  // field until the final diagnostic, rather than only each input, honors the cap.
  while (candidate.length > FEISHU_REJECTION_DIAGNOSTIC_MAX_CHARS) {
    const field = FEISHU_REJECTION_STRING_FIELDS.filter((key) => bounded[key])
      .toSorted(
        (left, right) =>
          JSON.stringify(bounded[right]).length - JSON.stringify(bounded[left]).length,
      )
      .at(0);
    if (!field) {
      break;
    }
    bounded[field] = sliceUtf16Safe(bounded[field] ?? "", 0, -1);
    candidate = JSON.stringify(bounded);
  }
  return candidate;
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
    publicError: {
      code: String(response.code),
    },
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
        detail: serializeFeishuRejectionDiagnostics({
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
