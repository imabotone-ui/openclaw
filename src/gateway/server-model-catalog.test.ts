import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const getPublishedPreparedModelCatalogOwnerSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../agents/prepared-model-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/prepared-model-catalog.js")>()),
  getPublishedPreparedModelCatalogOwnerSnapshot: getPublishedPreparedModelCatalogOwnerSnapshotMock,
}));

import {
  loadGatewayModelCatalog,
  loadGatewayModelCatalogSnapshot,
  readPreparedGatewayModelCatalogSnapshot,
  type PreparedGatewayModelCatalogSnapshot,
} from "./server-model-catalog.js";

const snapshot: ModelCatalogSnapshot = {
  entries: [{ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" }],
  routeVariants: [],
};
const metadataSnapshot = { plugins: [] } as never;

function ownerConfig(agentId = "main", extra: OpenClawConfig = {}): OpenClawConfig {
  return {
    ...extra,
    agents: {
      ...extra.agents,
      list: [
        {
          id: agentId,
          default: true,
          agentDir: "/tmp/gateway-agent",
          workspace: "/tmp/gateway-workspace",
        },
      ],
    },
  };
}

function ownerSnapshot(
  config: OpenClawConfig,
  modelCatalog: ModelCatalogSnapshot = snapshot,
  agentId?: string,
) {
  return {
    ...(agentId ? { agentId } : {}),
    agentDir: "/tmp/gateway-agent",
    config,
    metadataSnapshot,
    modelCatalog,
  };
}

describe("gateway prepared model catalog", () => {
  beforeEach(() => {
    getPublishedPreparedModelCatalogOwnerSnapshotMock.mockReset();
  });

  it("reads the published owner metadata without materializing discovery", async () => {
    const config = ownerConfig();
    getPublishedPreparedModelCatalogOwnerSnapshotMock.mockReturnValue(ownerSnapshot(config));

    await expect(
      readPreparedGatewayModelCatalogSnapshot({ getConfig: () => config }),
    ).resolves.toMatchObject({
      config,
      entries: snapshot.entries,
      metadataSnapshot,
    });
    expect(getPublishedPreparedModelCatalogOwnerSnapshotMock).toHaveBeenCalledWith({ config });
  });

  it("reads the published read-only generation directly", async () => {
    const config = ownerConfig();
    const loadPublishedPreparedModelCatalogOwnerSnapshot = vi.fn(async () => ownerSnapshot(config));

    await expect(
      loadGatewayModelCatalog({
        getConfig: () => config,
        loadPublishedPreparedModelCatalogOwnerSnapshot,
      }),
    ).resolves.toBe(snapshot.entries);
    expect(loadPublishedPreparedModelCatalogOwnerSnapshot).toHaveBeenCalledWith({
      config,
      readOnly: true,
    });
  });

  it("forwards the requested agent lifecycle owner", async () => {
    const config = ownerConfig("worker");
    const loadPublishedPreparedModelCatalogOwnerSnapshot = vi.fn(async () => ({
      ...ownerSnapshot(config, snapshot, "worker"),
      workspaceDir: "/tmp/gateway-workspace",
    }));

    await expect(
      loadGatewayModelCatalogSnapshot({
        agentId: "worker",
        agentDir: "/tmp/gateway-agent",
        getConfig: () => config,
        loadPublishedPreparedModelCatalogOwnerSnapshot,
        workspaceDir: "/tmp/gateway-workspace",
      }),
    ).resolves.toMatchObject({
      agentId: "worker",
      agentDir: "/tmp/gateway-agent",
      config,
      metadataSnapshot,
      workspaceDir: "/tmp/gateway-workspace",
    } satisfies Partial<PreparedGatewayModelCatalogSnapshot>);

    expect(loadPublishedPreparedModelCatalogOwnerSnapshot).toHaveBeenCalledWith({
      agentId: "worker",
      agentDir: "/tmp/gateway-agent",
      config,
      readOnly: true,
      workspaceDir: "/tmp/gateway-workspace",
    });
  });

  it("rejects an ambiguous owner without an authoritative agent identity", async () => {
    const config = {
      agents: {
        list: [
          {
            id: "main",
            default: true,
            agentDir: "/tmp/gateway-agent",
            workspace: "/tmp/main-workspace",
          },
          {
            id: "worker",
            agentDir: "/tmp/gateway-agent",
            workspace: "/tmp/worker-workspace",
          },
        ],
      },
    } as OpenClawConfig;
    const loadPublishedPreparedModelCatalogOwnerSnapshot = vi.fn(async () => ownerSnapshot(config));

    await expect(
      loadGatewayModelCatalogSnapshot({
        agentId: "worker",
        getConfig: () => config,
        loadPublishedPreparedModelCatalogOwnerSnapshot,
      }),
    ).rejects.toThrow("did not identify one configured agent");
  });

  it("returns an equivalent replacement owner without repeating discovery", async () => {
    const initialConfig = ownerConfig("main", { logging: { level: "info" as const } });
    const latestConfig = ownerConfig("main", { logging: { level: "info" as const } });
    const latestSnapshot: ModelCatalogSnapshot = {
      entries: [{ provider: "openai", id: "latest", name: "Latest" }],
      routeVariants: [],
    };
    const loadPublishedPreparedModelCatalogOwnerSnapshot = vi.fn(async () =>
      ownerSnapshot(latestConfig, latestSnapshot),
    );

    await expect(
      loadGatewayModelCatalogSnapshot({
        getConfig: () => initialConfig,
        loadPublishedPreparedModelCatalogOwnerSnapshot,
      }),
    ).resolves.toMatchObject({ config: latestConfig, entries: latestSnapshot.entries });
    expect(loadPublishedPreparedModelCatalogOwnerSnapshot).toHaveBeenCalledOnce();
  });

  it("selects the full prepared owner when requested", async () => {
    const config = ownerConfig();
    const loadPublishedPreparedModelCatalogOwnerSnapshot = vi.fn(async () => ownerSnapshot(config));

    await expect(
      loadGatewayModelCatalogSnapshot({
        getConfig: () => config,
        loadPublishedPreparedModelCatalogOwnerSnapshot,
        readOnly: false,
      }),
    ).resolves.toMatchObject(snapshot);
    expect(loadPublishedPreparedModelCatalogOwnerSnapshot).toHaveBeenCalledWith({
      config,
      readOnly: false,
    });
  });

  it("carries provider outcomes through the gateway owner projection", async () => {
    const config = ownerConfig();
    const modelCatalog: ModelCatalogSnapshot = {
      entries: [],
      routeVariants: [],
      providerOutcomes: [{ provider: "openai", status: "auth-rejected" }],
    };
    const loadPublishedPreparedModelCatalogOwnerSnapshot = vi.fn(async () =>
      ownerSnapshot(config, modelCatalog),
    );

    await expect(
      loadGatewayModelCatalogSnapshot({
        getConfig: () => config,
        loadPublishedPreparedModelCatalogOwnerSnapshot,
        readOnly: false,
      }),
    ).resolves.toMatchObject({ providerOutcomes: modelCatalog.providerOutcomes });
  });

  it("does not hide lifecycle publication failures behind stale data", async () => {
    const error = new Error("generation failed");
    const loadPublishedPreparedModelCatalogOwnerSnapshot = vi.fn(async () => {
      throw error;
    });

    await expect(
      loadGatewayModelCatalogSnapshot({ loadPublishedPreparedModelCatalogOwnerSnapshot }),
    ).rejects.toBe(error);
  });
});
