import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  createPreparedModelCatalogWorkerInput,
  fingerprintPreparedModelCatalogGeneration,
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
  it("treats derived and persisted copies of the same plugin registry as one generation", () => {
    const input = { agentDir: "/tmp/agent", config: {}, env: {}, skipCredentials: true };
    const common = {
      input,
      credentials: {},
      profileIds: {},
      providerIds: [],
      pluginMetadataSnapshot: {
        policyHash: "test-policy",
        configFingerprint: "test-config",
        index: {} as never,
        plugins: [],
      } as unknown as PluginMetadataSnapshot,
    };

    expect(
      fingerprintPreparedModelCatalogGeneration({
        ...common,
        pluginMetadataSnapshot: { ...common.pluginMetadataSnapshot, registrySource: "derived" },
      }),
    ).toBe(
      fingerprintPreparedModelCatalogGeneration({
        ...common,
        pluginMetadataSnapshot: { ...common.pluginMetadataSnapshot, registrySource: "persisted" },
      }),
    );
  });

  it("serializes alias-stored credentials while preferring canonical keys", () => {
    const workerInput = createPreparedModelCatalogWorkerInput({
      agentFacts: {
        input: { agentDir: "/tmp/agent", config: {}, workspaceDir: "/tmp/workspace" },
        env: {},
        credentials: {
          "provider-alias": {
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
          "canonical-with-both": { type: "api_key", key: "canonical-key" },
          "provider-with-both-alias": { type: "api_key", key: "alias-key" },
          unrelated: { type: "api_key", key: "unrelated-key" },
        },
        credentialProfileIds: {
          "provider-alias": "provider-alias:named",
          "canonical-with-both": "canonical-with-both:named",
          "provider-with-both-alias": "provider-with-both-alias:named",
        },
        providerIds: ["provider-alias", "provider-with-both-alias", "direct"],
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
            providerAuthAliases: {
              "provider-alias": "canonical",
              "provider-with-both-alias": "canonical-with-both",
            },
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
      "canonical-with-both": { type: "api_key", key: "canonical-key" },
      direct: { type: "api_key", key: "selected-key" },
    });
    expect(workerInput.profileIds).toEqual({
      canonical: "provider-alias:named",
      "canonical-with-both": "canonical-with-both:named",
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
        profileIds: {},
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
