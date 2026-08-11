import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";

export type PublishedModelCatalogOwnerCandidate = Readonly<{
  agentId?: string;
  agentDir: string;
  workspaceDir?: string;
  config: OpenClawConfig;
  metadataSnapshot: PluginMetadataSnapshot;
  modelCatalog: ModelCatalogSnapshot;
}>;

export type ResolvedPublishedModelCatalogOwner = Readonly<{
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  config: OpenClawConfig;
  metadataSnapshot: PluginMetadataSnapshot;
  modelCatalog: ModelCatalogSnapshot;
}>;
