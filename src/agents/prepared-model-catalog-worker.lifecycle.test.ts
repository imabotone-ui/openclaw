import { describe, expect, it, vi } from "vitest";

type WorkerMockState = {
  instances: Array<{
    emit: (event: string, ...args: unknown[]) => boolean;
    resolveTermination: (code: number) => void;
    terminate: ReturnType<typeof vi.fn>;
  }>;
};

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  const state: WorkerMockState = { instances: [] };
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.preparedModelCatalogWorkerLifecycleTest")
  ] = state;
  class Worker extends EventEmitter {
    resolveTermination: (code: number) => void = () => {};
    terminate = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          this.resolveTermination = resolve;
        }),
    );

    constructor() {
      super();
      state.instances.push(this);
    }

    unref() {}
  }

  return { Worker };
});

import { runPreparedModelCatalogWorker } from "./prepared-model-catalog-worker.js";

function getWorkerMockState(): WorkerMockState {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.preparedModelCatalogWorkerLifecycleTest")
  ] as WorkerMockState;
}

describe("prepared model catalog worker lifecycle", () => {
  it.each([
    {
      name: "successful",
      message: {
        status: "ok" as const,
        generationFingerprint: "generation",
        snapshot: { entries: [], routeVariants: [] },
      },
    },
    {
      name: "failed",
      message: { status: "failed" as const, error: "catalog failed" },
    },
    {
      name: "stale",
      message: {
        status: "ok" as const,
        generationFingerprint: "stale-generation",
        snapshot: { entries: [], routeVariants: [] },
      },
    },
  ])("waits for a $name worker to terminate before settling", async ({ message }) => {
    const pending = runPreparedModelCatalogWorker({
      input: {
        generationFingerprint: "generation",
        input: { agentDir: "/tmp/agent", config: {}, env: {}, skipCredentials: true },
        credentials: {},
        profileIds: {},
        providerIds: [],
      },
      isCurrent: () => true,
    });
    const outcome = pending.then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const worker = getWorkerMockState().instances.at(-1);
    expect(worker).toBeDefined();

    worker?.emit("message", message);
    await Promise.resolve();
    expect(worker?.terminate).toHaveBeenCalledOnce();
    await expect(Promise.race([outcome, Promise.resolve("pending")])).resolves.toBe("pending");

    worker?.resolveTermination(1);
    const settled = await outcome;
    expect(settled.status).toBe(
      message.status === "ok" && message.generationFingerprint === "generation"
        ? "resolved"
        : "rejected",
    );
  });
});
