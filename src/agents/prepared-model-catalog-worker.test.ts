import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  createPreparedModelCatalogWorkerInput,
  runPreparedModelCatalogWorker,
} from "./prepared-model-catalog-worker.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.facts.js";

vi.mock("../plugins/manifest-registry-installed.js", () => ({
  resolveInstalledManifestRegistryIndexFingerprint: () => "test-plugin-index",
}));

afterEach(() => {
  vi.useRealTimers();
});

describe("prepared model catalog worker", () => {
  it("serializes only selected alias credentials without SecretRef provenance", () => {
    const workerInput = createPreparedModelCatalogWorkerInput({
      agentFacts: {
        input: { agentDir: "/tmp/agent", config: {}, workspaceDir: "/tmp/workspace" },
        env: {},
        credentials: {
          canonical: {
            type: "oauth",
            access: "selected-access",
            refresh: "selected-refresh",
            expires: 4_102_444_800_000,
            accountId: "selected-account",
            keyRef: { source: "env", id: "SELECTED_OAUTH_KEY" },
          },
          direct: {
            type: "api_key",
            key: "selected-key",
            keyRef: { source: "env", id: "SELECTED_KEY" },
          } as never,
          unrelated: { type: "api_key", key: "unrelated-key" },
        },
        providerIds: ["provider-alias", "direct"],
        configuredModelRefs: [],
        configuredRuntimeModels: [],
        configuredGeneratedCatalogPluginIds: [],
        templateAuthStorage: {} as never,
      } satisfies PreparedModelRuntimeAgentFacts,
      pluginMetadataSnapshot: {
        policyHash: "test-policy",
        configFingerprint: "test-config",
        index: {} as never,
        plugins: [
          {
            id: "provider-plugin",
            origin: "bundled",
            providerAuthAliases: { "provider-alias": "canonical" },
          } as never,
        ],
      } as unknown as PluginMetadataSnapshot,
    });

    expect(structuredClone(workerInput).credentials).toEqual({
      canonical: {
        type: "oauth",
        access: "selected-access",
        refresh: "selected-refresh",
        expires: 4_102_444_800_000,
        accountId: "selected-account",
      },
      direct: { type: "api_key", key: "selected-key" },
    });
  });

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
