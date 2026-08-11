import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import type { ResolvedPublishedModelCatalogOwner } from "../agents/prepared-model-catalog.types.js";

export type GatewayModelCatalogOwnerSnapshot = Omit<
  ResolvedPublishedModelCatalogOwner,
  "metadataSnapshot" | "pluginRegistry"
>;

export type GatewayModelCatalogSnapshot = ModelCatalogSnapshot &
  Omit<GatewayModelCatalogOwnerSnapshot, "modelCatalog">;
