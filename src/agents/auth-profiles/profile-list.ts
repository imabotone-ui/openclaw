/**
 * Auth profile list helpers.
 * Provides provider-compatible profile lookup and stable de-duplication used by
 * ordering, repair, and profile mutation paths.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  type ProviderAuthAliasLookupParams,
  resolveProviderIdForAuth,
} from "../provider-auth-aliases.js";
import type { AuthProfileStore } from "./types.js";

/** Deduplicates profile ids while preserving first-seen order. */
export function dedupeProfileIds(profileIds: string[]): string[] {
  return uniqueStrings(profileIds);
}

/** Lists auth profile ids whose credential provider matches the requested provider. */
export function listProfilesForProvider(store: AuthProfileStore, provider: string): string[] {
  return listProfilesForProviderWithAliases(store, provider);
}

/** Internal variant that resolves aliases against an exact prepared metadata generation. */
export function listProfilesForProviderWithAliases(
  store: AuthProfileStore,
  provider: string,
  aliasLookupParams?: ProviderAuthAliasLookupParams,
): string[] {
  const providerKey = resolveProviderIdForAuth(provider, aliasLookupParams);
  return Object.entries(store.profiles)
    .filter(
      ([, cred]) => resolveProviderIdForAuth(cred.provider, aliasLookupParams) === providerKey,
    )
    .map(([id]) => id);
}

export function resolveSubscriptionAuthModeForProfiles(params: {
  store: AuthProfileStore;
  profileIds: ReadonlyArray<string | undefined>;
}): "oauth" | "token" | undefined {
  for (const profileId of params.profileIds) {
    const type = profileId ? params.store.profiles[profileId]?.type : undefined;
    if (type === "oauth" || type === "token") {
      return type;
    }
  }
  return undefined;
}
