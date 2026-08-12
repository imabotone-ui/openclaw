import { describe, expect, it } from "vitest";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import { finalizeDispatchResult } from "./dispatch-delivery-terminal.js";
import { createReplyDispatcher } from "./reply/reply-dispatcher.js";

describe("dispatch delivery terminal", () => {
  it("returns a redacted failed terminal for a permanent provider rejection", async () => {
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        throw new PlatformMessageNotDispatchedError("provider rejected message", {
          cause: new Error("secret provider response"),
          retryable: false,
          publicError: { code: "230099" },
        });
      },
    });
    dispatcher.sendFinalReply({ text: "the final answer" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    const result = finalizeDispatchResult(
      { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } },
      dispatcher,
    );

    expect(result).toMatchObject({
      queuedFinal: false,
      counts: { final: 0 },
      failedCounts: { final: 1 },
      deliveryTerminal: {
        outcome: "failed",
        retryable: false,
        error: { code: "230099" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret provider response");
  });
});
