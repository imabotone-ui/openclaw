/** Redacted terminal state for the final recipient-visible delivery. */
export type ChannelDeliveryTerminal =
  | { outcome: "delivered" }
  | {
      outcome: "failed";
      retryable: boolean;
      error?: { code?: string };
    }
  | {
      outcome: "partial_failure";
      retryable: false;
      error?: { code?: string };
    }
  | { outcome: "unknown"; retryable: false };
