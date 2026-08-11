import { resolvePublishedModelCatalogOwner } from "../agents/prepared-model-catalog-owner.js";
import type {
  PublishedModelCatalogOwnerCandidate,
  ResolvedPublishedModelCatalogOwner,
} from "../agents/prepared-model-catalog.types.js";
// Gateway catalog reads use the atomic prepared runtime generation.
import { getRuntimeConfig } from "../config/io.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { GatewayModelCatalogSnapshot } from "./server-model-catalog.types.js";

export type GatewayModelChoice = import("../agents/model-catalog.js").ModelCatalogEntry;
export type { GatewayModelCatalogSnapshot } from "./server-model-catalog.types.js";

type GatewayModelCatalogConfig = ReturnType<typeof getRuntimeConfig>;
type LoadPublishedPreparedModelCatalogOwnerSnapshot = (params: {
  agentId?: string;
  agentDir?: string;
  config: GatewayModelCatalogConfig;
  readOnly?: boolean;
  workspaceDir?: string;
}) => Promise<PublishedModelCatalogOwnerCandidate>;
type LoadGatewayModelCatalogParams = {
  agentId?: string;
  agentDir?: string;
  getConfig?: () => GatewayModelCatalogConfig;
  loadPublishedPreparedModelCatalogOwnerSnapshot?: LoadPublishedPreparedModelCatalogOwnerSnapshot;
  readOnly?: boolean;
  workspaceDir?: string;
};

async function resolveLoader(
  params?: LoadGatewayModelCatalogParams,
): Promise<LoadPublishedPreparedModelCatalogOwnerSnapshot> {
  if (params?.loadPublishedPreparedModelCatalogOwnerSnapshot) {
    return params.loadPublishedPreparedModelCatalogOwnerSnapshot;
  }
  const { loadPublishedPreparedModelCatalogOwnerSnapshot } =
    await import("../agents/prepared-model-catalog.js");
  return loadPublishedPreparedModelCatalogOwnerSnapshot;
}

// Isolated gateway tests share process module state with lifecycle-owner tests.
export async function resetPreparedModelCatalogStateForTest(): Promise<void> {
  const [{ resetPreparedModelRuntimeSnapshotsForTest }, { resetModelCatalogBuilderCacheForTest }] =
    await Promise.all([
      import("../agents/prepared-model-runtime.test-support.js"),
      import("../agents/model-catalog.js"),
    ]);
  resetPreparedModelRuntimeSnapshotsForTest();
  resetModelCatalogBuilderCacheForTest();
}

async function loadGatewayModelCatalogOwnerSnapshot(
  params?: LoadGatewayModelCatalogParams,
): Promise<ResolvedPublishedModelCatalogOwner> {
  const loadOwner = await resolveLoader(params);
  return resolvePublishedModelCatalogOwner(
    await loadOwner({
      ...(params?.agentId ? { agentId: params.agentId } : {}),
      ...(params?.agentDir ? { agentDir: params.agentDir } : {}),
      config: (params?.getConfig ?? getRuntimeConfig)(),
      readOnly: params?.readOnly !== false,
      ...(params?.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    }),
  );
}

export type PreparedGatewayModelCatalogSnapshot = GatewayModelCatalogSnapshot & {
  metadataSnapshot: PluginMetadataSnapshot;
};

function projectGatewayModelCatalogSnapshot(
  owner: ResolvedPublishedModelCatalogOwner,
): PreparedGatewayModelCatalogSnapshot {
  return {
    ...owner.modelCatalog,
    agentId: owner.agentId,
    agentDir: owner.agentDir,
    workspaceDir: owner.workspaceDir,
    config: owner.config,
    metadataSnapshot: owner.metadataSnapshot,
  };
}

export async function loadGatewayModelCatalogSnapshot(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelCatalogSnapshot> {
  return projectGatewayModelCatalogSnapshot(await loadGatewayModelCatalogOwnerSnapshot(params));
}

export async function loadGatewayModelCatalog(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelChoice[]> {
  return (await loadGatewayModelCatalogSnapshot(params)).entries;
}

/** Reads the already-published startup catalog without starting provider discovery. */
export async function readPreparedGatewayModelCatalog(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelChoice[] | undefined> {
  const { getPreparedModelCatalogSnapshot } = await import("../agents/prepared-model-catalog.js");
  const config = (params?.getConfig ?? getRuntimeConfig)();
  return getPreparedModelCatalogSnapshot({
    ...(params?.agentId ? { agentId: params.agentId } : {}),
    ...(params?.agentDir ? { agentDir: params.agentDir } : {}),
    config,
    readOnly: true,
    ...(params?.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  })?.entries;
}

/** Reads the published owner generation without activating or materializing catalog discovery. */
export async function readPreparedGatewayModelCatalogSnapshot(
  params?: LoadGatewayModelCatalogParams,
): Promise<PreparedGatewayModelCatalogSnapshot | undefined> {
  const { getPublishedPreparedModelCatalogOwnerSnapshot } =
    await import("../agents/prepared-model-catalog.js");
  const config = (params?.getConfig ?? getRuntimeConfig)();
  const published = getPublishedPreparedModelCatalogOwnerSnapshot({
    ...(params?.agentId ? { agentId: params.agentId } : {}),
    ...(params?.agentDir ? { agentDir: params.agentDir } : {}),
    config,
    ...(params?.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  return published
    ? projectGatewayModelCatalogSnapshot(resolvePublishedModelCatalogOwner(published))
    : undefined;
}
