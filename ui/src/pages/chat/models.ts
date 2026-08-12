// Control UI model metadata boundary.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";

const MODEL_CATALOG_CACHE_TTL_MS = 60_000;

type ModelCatalogCacheEntry = {
  expiresAt: number;
  models: ModelCatalogEntry[];
  inFlight?: Promise<ModelCatalogEntry[]>;
  inFlightRefresh?: boolean;
};

const modelCatalogCache = new WeakMap<GatewayBrowserClient, Map<string, ModelCatalogCacheEntry>>();

function modelCatalogCacheFor(client: GatewayBrowserClient): Map<string, ModelCatalogCacheEntry> {
  let cache = modelCatalogCache.get(client);
  if (!cache) {
    cache = new Map();
    modelCatalogCache.set(client, cache);
  }
  return cache;
}

export async function loadModels(
  client: GatewayBrowserClient,
  opts?: { agentId?: string; preparedOnly?: boolean; refresh?: boolean },
): Promise<ModelCatalogEntry[]> {
  const cache = modelCatalogCacheFor(client);
  const agentId = opts?.agentId?.trim() ?? "";
  const preparedCacheKey = `${agentId}\0prepared`;
  const exactCacheKey = `${agentId}\0exact`;
  const cacheKey = opts?.preparedOnly ? preparedCacheKey : exactCacheKey;
  const cached = cache.get(cacheKey);
  const now = Date.now();
  const exact = opts?.preparedOnly ? cache.get(exactCacheKey) : undefined;
  if (!opts?.refresh && exact?.models && exact.expiresAt > now) {
    return exact.models;
  }
  if (!opts?.refresh && cached?.models && cached.expiresAt > now) {
    return cached.models;
  }
  if (cached?.inFlight && (!opts?.refresh || cached.inFlightRefresh === true)) {
    return cached.inFlight;
  }

  // The cache write happens here, gated on inFlight identity: a refresh call
  // replaces inFlight, so an older request resolving late cannot clobber the
  // fresher result with pre-mutation catalog data.
  const inFlight: Promise<ModelCatalogEntry[]> = requestModels(
    client,
    cached?.models,
    agentId || undefined,
    opts?.preparedOnly === true,
  )
    .then((result) => {
      const latest = cache.get(cacheKey);
      if (latest?.inFlight && latest.inFlight !== inFlight) {
        return latest.inFlight;
      }
      if (latest && latest.inFlight !== inFlight) {
        return latest.models;
      }
      if (!latest || latest.inFlight === inFlight) {
        const expiresAt = result.fresh ? Date.now() + MODEL_CATALOG_CACHE_TTL_MS : 0;
        cache.set(cacheKey, {
          expiresAt,
          models: result.models,
        });
        // Exact discovery is authoritative for the same configured view. Promote it over the
        // prepared slot so a later or already-running prepared request cannot revert the UI.
        if (result.fresh && !opts?.preparedOnly) {
          cache.set(preparedCacheKey, { expiresAt, models: result.models });
        }
      }
      return result.models;
    })
    .finally(() => {
      const latest = cache.get(cacheKey);
      if (latest?.inFlight === inFlight) {
        delete latest.inFlight;
      }
    });
  cache.set(cacheKey, {
    expiresAt: cached?.expiresAt ?? 0,
    models: cached?.models ?? [],
    inFlight,
    ...(opts?.refresh ? { inFlightRefresh: true } : {}),
  });
  return inFlight;
}

export function applyModelCatalogResult(models: unknown): ModelCatalogEntry[] | null {
  if (!Array.isArray(models)) {
    return null;
  }
  return models as ModelCatalogEntry[];
}

async function requestModels(
  client: GatewayBrowserClient,
  fallback: ModelCatalogEntry[] | undefined,
  agentId: string | undefined,
  preparedOnly: boolean,
): Promise<{ models: ModelCatalogEntry[]; fresh: boolean }> {
  try {
    const result = await client.request<{ models: ModelCatalogEntry[] }>("models.list", {
      view: "configured",
      ...(agentId ? { agentId } : {}),
      ...(preparedOnly ? { preparedOnly: true } : {}),
    });
    return { models: result?.models ?? [], fresh: true };
  } catch {
    // Failed loads fall back without extending the TTL so the next call retries.
    return { models: fallback ?? [], fresh: false };
  }
}
