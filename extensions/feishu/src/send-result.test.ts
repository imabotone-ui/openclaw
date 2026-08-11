import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { describe, expect, it } from "vitest";
import { assertFeishuMessageApiSuccess, toFeishuSendResult } from "./send-result.js";

describe("assertFeishuMessageApiSuccess", () => {
  it("classifies a fulfilled permanent provider rejection without exposing raw response data", () => {
    const secretBearingResponse = {
      code: 230099,
      msg: "card table number over limit",
      requestHeaders: { authorization: "secret" },
      card: { body: "private" },
    };

    let caught: unknown;
    try {
      assertFeishuMessageApiSuccess(secretBearingResponse, "Feishu card send failed");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(caught).toMatchObject({ retryable: false, cause: secretBearingResponse });
    expect((caught as Error).message).toBe(
      "Feishu card send failed: card table number over limit (code=230099)",
    );
    expect((caught as Error).message).not.toContain("secret");
    expect((caught as Error).message).not.toContain("private");
  });

  it("keeps a code-less fulfilled response ambiguous instead of accepting it", () => {
    let caught: unknown;
    try {
      assertFeishuMessageApiSuccess({ msg: "malformed gateway response" }, "Feishu send failed");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect((caught as Error).message).toBe("Feishu send failed: malformed gateway response");
  });
});

describe("toFeishuSendResult", () => {
  it.each([undefined, "", "   "])(
    "rejects an acknowledged send without a real message identifier: %s",
    (messageId) => {
      let caught: unknown;
      try {
        toFeishuSendResult({ code: 0, data: { message_id: messageId } }, "oc_chat", "text");
      } catch (error) {
        caught = error;
      }

      expect(isChannelPartialDeliveryError(caught)).toBe(true);
      if (!(caught instanceof Error) || !isChannelPartialDeliveryError(caught)) {
        throw new Error("expected an accepted Feishu delivery without an identity");
      }
      expect(caught.message).toBe("Feishu send failed: no message_id returned");
      expect(caught.deliveryResult).toEqual({ messageIds: [], visibleReplySent: true });
    },
  );

  it("normalizes the accepted platform identifier consistently across the result and receipt", () => {
    const result = toFeishuSendResult(
      { code: 0, data: { message_id: "  om_accepted  " } },
      "oc_chat",
      "card",
    );

    expect(result.messageId).toBe("om_accepted");
    expect(result.receipt.primaryPlatformMessageId).toBe("om_accepted");
  });
});
