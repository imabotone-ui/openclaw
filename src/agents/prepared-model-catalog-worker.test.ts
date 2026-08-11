import { afterEach, describe, expect, it, vi } from "vitest";
import { runPreparedModelCatalogWorker } from "./prepared-model-catalog-worker.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("prepared model catalog worker failure contract", () => {
  it("rejects a timed-out exact discovery instead of returning an empty or partial catalog", async () => {
    vi.useFakeTimers();
    const pending = runPreparedModelCatalogWorker({
      input: {
        generationFingerprint: "timeout-generation",
        input: {
          agentDir: "/tmp/openclaw-worker-timeout-fixture",
          config: {},
          env: {},
          skipCredentials: true,
        },
        credentials: {},
        providerIds: [],
      },
      isCurrent: () => true,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      message: "prepared model catalog worker timed out",
    });

    vi.advanceTimersByTime(180_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
