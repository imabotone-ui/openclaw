import { describe, expect, it } from "vitest";
import type { TrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "../../audit/message-audit-events.test-support.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { createChannelPartialDeliveryError } from "./delivery-result.js";
import {
  emitChannelDeliveryTerminalObservations,
  resolveChannelDeliveryFailureTerminal,
} from "./delivery-terminal.js";

describe("channel delivery terminal", () => {
  it("exposes only the provider code for a permanent pre-dispatch rejection", () => {
    const raw = new Error("secret transport detail");
    const error = new PlatformMessageNotDispatchedError("provider rejected message", {
      cause: raw,
      retryable: false,
      publicError: { code: "230099" },
    });

    const terminal = resolveChannelDeliveryFailureTerminal({
      error,
      deliveredBeforeFailure: false,
    });

    expect(terminal).toEqual({
      outcome: "failed",
      retryable: false,
      error: { code: "230099" },
    });
    expect(JSON.stringify(terminal)).not.toContain("secret");
  });

  it("keeps visible partial delivery terminal and non-retryable", () => {
    const error = createChannelPartialDeliveryError(new Error("edit failed"), {
      visibleReplySent: true,
      messageIds: ["om-visible"],
    });

    expect(resolveChannelDeliveryFailureTerminal({ error, deliveredBeforeFailure: false })).toEqual(
      { outcome: "partial_failure", retryable: false },
    );
  });

  it("does not invent a failed disposition for an ambiguous provider error", () => {
    expect(
      resolveChannelDeliveryFailureTerminal({
        error: new Error("socket closed"),
        deliveredBeforeFailure: false,
      }),
    ).toEqual({ outcome: "unknown", retryable: false });
  });

  it("records delivery failure separately without raw terminal details", () => {
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
    try {
      emitChannelDeliveryTerminalObservations({
        terminal: { outcome: "failed", retryable: false, error: { code: "230099" } },
        channel: "feishu",
        to: "chat:redacted",
        agentId: "main",
        sessionKey: "agent:main:feishu:direct:redacted",
        chatType: "direct",
        startedAt: Date.now(),
      });
    } finally {
      unsubscribe();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "message.outbound.finished",
      direction: "outbound",
      status: "failed",
      outcome: "failed",
      errorCode: "message_delivery_failed",
      failureStage: "platform_send",
      resultCount: 0,
    });
    expect(JSON.stringify(events)).not.toContain("230099");
    expect(JSON.stringify(events)).not.toContain("agent:main:feishu");
  });
});
