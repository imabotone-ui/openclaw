import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import type { ResolvedPublishedModelCatalogOwner } from "../agents/prepared-model-catalog.types.js";

export type GatewayModelCatalogSnapshot = ModelCatalogSnapshot &
  Omit<ResolvedPublishedModelCatalogOwner, "metadataSnapshot" | "modelCatalog" | "pluginRegistry">;
