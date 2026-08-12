import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext } from "./types.js";

const getCurrentPluginMetadataSnapshotMock = vi.hoisted(() => vi.fn());
const loadPluginRegistrySnapshotWithMetadataMock = vi.hoisted(() => vi.fn());
const resolveManifestProviderAuthChoicesMock = vi.hoisted(() => vi.fn(() => []));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: getCurrentPluginMetadataSnapshotMock,
}));

vi.mock("../../plugins/plugin-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-registry.js")>()),
  loadPluginRegistrySnapshotWithMetadata: loadPluginRegistrySnapshotWithMetadataMock,
}));

vi.mock("../../plugins/provider-auth-choices.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/provider-auth-choices.js")>()),
  resolveManifestProviderAuthChoices: resolveManifestProviderAuthChoicesMock,
}));

import {
  buildModelsListResult,
  createGatewayAgentModelCatalogProjector,
} from "./models-list-result.js";

function catalogEntry(id: string): ModelCatalogEntry {
  return { id, name: id, provider: "custom", api: "openai-responses" };
}

function preparedMetadataSnapshot() {
  return {
    index: {
      plugins: [
        {
          enabled: true,
          syntheticAuthRefs: ["custom"],
        },
      ],
    },
    plugins: [
      {
        modelIdNormalization: {
          providers: {
            custom: {
              aliases: {
                legacy: "modern",
              },
            },
          },
        },
      },
    ],
  } as never;
}

describe("models.list plugin metadata handoff", () => {
  beforeEach(() => {
    getCurrentPluginMetadataSnapshotMock.mockReset();
    loadPluginRegistrySnapshotWithMetadataMock.mockReset();
    loadPluginRegistrySnapshotWithMetadataMock.mockReturnValue({
      source: "derived",
      snapshot: { plugins: [] },
    });
    resolveManifestProviderAuthChoicesMock.mockReset();
    resolveManifestProviderAuthChoicesMock.mockReturnValue([]);
  });

  it("reuses one Gateway-owned metadata snapshot across startup projection and browse", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-models-list-plugin-runtime-",
        agentEnv: "main",
      },
      async (state) => {
        const cfg = {
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              model: { primary: "custom/legacy" },
              models: {
                "custom/legacy": {},
                "custom/another": {},
              },
            },
          },
        } as OpenClawConfig;
        const snapshot: ModelCatalogSnapshot = {
          entries: [catalogEntry("modern"), catalogEntry("another")],
          routeVariants: [],
        };
        const metadataSnapshot = preparedMetadataSnapshot();
        const projector = createGatewayAgentModelCatalogProjector({
          cfg,
          agentId: "main",
          snapshot,
          metadataSnapshot,
        });
        await projector.projectCatalog();

        const context = {
          getRuntimeConfig: () => cfg,
          loadGatewayModelCatalogSnapshot: vi.fn(),
          logGateway: { debug: vi.fn() },
        } as unknown as GatewayRequestContext;
        await buildModelsListResult({
          context,
          agentId: "main",
          params: { view: "configured" },
          preloadedCatalog: { agentId: "main", config: cfg, snapshot },
          preparedOnly: true,
          catalogProjector: projector,
        });

        expect(getCurrentPluginMetadataSnapshotMock).not.toHaveBeenCalled();
        expect(loadPluginRegistrySnapshotWithMetadataMock).not.toHaveBeenCalled();
      },
    );
  });

  it("uses the catalog owner's metadata snapshot for an explicit Gateway browse", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-models-list-plugin-runtime-explicit-",
        agentEnv: "main",
      },
      async (state) => {
        const cfg = {
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              model: { primary: "custom/modern" },
              models: { "custom/modern": {} },
            },
          },
        } as OpenClawConfig;
        const metadataSnapshot = preparedMetadataSnapshot();
        const context = {
          getRuntimeConfig: () => cfg,
          loadGatewayModelCatalogSnapshot: vi.fn(async () => ({
            agentId: "main",
            agentDir: state.agentDir,
            workspaceDir: state.workspaceDir,
            config: cfg,
            entries: [catalogEntry("modern")],
            routeVariants: [],
            metadataSnapshot,
          })),
          logGateway: { debug: vi.fn() },
        } as unknown as GatewayRequestContext;

        await buildModelsListResult({
          context,
          agentId: "main",
          params: { view: "configured", includeProviderCapabilities: true },
        });

        expect(getCurrentPluginMetadataSnapshotMock).not.toHaveBeenCalled();
        expect(loadPluginRegistrySnapshotWithMetadataMock).not.toHaveBeenCalled();
        expect(resolveManifestProviderAuthChoicesMock).toHaveBeenCalledWith(
          expect.objectContaining({ metadataSnapshot }),
        );
      },
    );
  });
});
