/** Converts auth-profile credentials into agent runtime credential maps. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import { resolveAuthProfileOrder } from "./auth-profiles/order.js";
import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles/types.js";
import { AGENT_SECRET_REF_CONFIGURED_MARKER } from "./model-auth-marker-values.js";
import type { AuthStorageData } from "./sessions/auth-storage.js";

// Converts auth-profile credentials into the compact credential map consumed by
// agent runtimes. Secret refs can be represented by markers without reading
// secret values.
type AgentApiKeyCredential = { type: "api_key"; key: string };
type AgentTokenCredential = { type: "token"; token: string; expires?: number };
type AgentOAuthCredential = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
};

/** Credential value shape consumed by agent runtimes after auth-profile normalization. */
type AgentCredential = AgentApiKeyCredential | AgentTokenCredential | AgentOAuthCredential;
export type AgentCredentialMap = Record<string, AgentCredential>;
export type AgentCredentialProfileIds = Record<string, string>;
export type PreparedAgentCredentialModes = Readonly<Record<string, "api_key" | "oauth" | "token">>;

type ResolveAgentCredentialMapOptions = {
  includeSecretRefPlaceholders?: boolean;
  config?: OpenClawConfig;
};

/** Records only credential modes whose secret material is usable by a prepared runtime owner. */
export function resolveUsableAgentCredentialModes(
  credentials: Readonly<AuthStorageData>,
): PreparedAgentCredentialModes {
  const modes: Record<string, "api_key" | "oauth" | "token"> = {};
  for (const [rawProvider, credential] of Object.entries(credentials)) {
    const provider = normalizeProviderId(rawProvider);
    if (!provider) {
      continue;
    }
    if (
      credential.type === "api_key" &&
      credential.key &&
      credential.key !== AGENT_SECRET_REF_CONFIGURED_MARKER
    ) {
      modes[provider] = "api_key";
    } else if (
      credential.type === "token" &&
      credential.token &&
      credential.token !== AGENT_SECRET_REF_CONFIGURED_MARKER &&
      (credential.expires === undefined || credential.expires > Date.now())
    ) {
      modes[provider] = "token";
    } else if (
      credential.type === "oauth" &&
      credential.access &&
      credential.refresh &&
      credential.expires > 0
    ) {
      modes[provider] = "oauth";
    }
  }
  return Object.freeze(modes);
}

function hasConfiguredSecretRef(value: unknown): boolean {
  return coerceSecretRef(value) !== null;
}

function secretRefPlaceholder(
  type: "api_key" | "token",
  options: ResolveAgentCredentialMapOptions | undefined,
  expires?: number,
): AgentCredential | null {
  if (options?.includeSecretRefPlaceholders !== true) {
    return null;
  }
  return type === "token"
    ? {
        type,
        token: AGENT_SECRET_REF_CONFIGURED_MARKER,
        ...(expires !== undefined ? { expires } : {}),
      }
    : { type, key: AGENT_SECRET_REF_CONFIGURED_MARKER };
}

function convertAuthProfileCredentialToAgent(
  cred: AuthProfileCredential,
  options?: ResolveAgentCredentialMapOptions,
): AgentCredential | null {
  if (cred.type === "api_key") {
    const key = normalizeOptionalString(cred.key) ?? "";
    if (!key) {
      // A configured secret ref proves the credential exists, but this converter
      // must not resolve or leak the actual secret value.
      return hasConfiguredSecretRef(cred.keyRef) ? secretRefPlaceholder("api_key", options) : null;
    }
    return { type: "api_key", key };
  }

  if (cred.type === "token") {
    let expires: number | undefined;
    if (cred.expires !== undefined) {
      expires = asDateTimestampMs(cred.expires);
      if (expires === undefined || Date.now() >= expires) {
        return null;
      }
    }
    const token = normalizeOptionalString(cred.token) ?? "";
    if (!token) {
      return hasConfiguredSecretRef(cred.tokenRef)
        ? secretRefPlaceholder("token", options, expires)
        : null;
    }
    return { type: "token", token, ...(expires !== undefined ? { expires } : {}) };
  }

  if (cred.type === "oauth") {
    const access = normalizeOptionalString(cred.access) ?? "";
    const refresh = normalizeOptionalString(cred.refresh) ?? "";
    const expires = asDateTimestampMs(cred.expires);
    if (!access || !refresh || expires === undefined || expires <= 0) {
      return null;
    }
    return {
      type: "oauth",
      access,
      refresh,
      expires,
    };
  }

  return null;
}

/** Build one canonically selected credential per normalized provider. */
export function resolveAgentCredentialSelectionFromStore(
  store: AuthProfileStore,
  options?: ResolveAgentCredentialMapOptions,
): { credentials: AgentCredentialMap; profileIds: AgentCredentialProfileIds } {
  const credentials: AgentCredentialMap = {};
  const profileIds: AgentCredentialProfileIds = {};
  for (const credential of Object.values(store.profiles)) {
    const provider = normalizeProviderId(credential.provider ?? "");
    if (!provider) {
      continue;
    }
    if (credentials[provider]) {
      continue;
    }
    // Discovery must not grow a second auth policy: explicit order, provider
    // aliases, eligibility, and automatic preference all belong to this resolver.
    const orderedProfileIds = resolveAuthProfileOrder({
      cfg: options?.config,
      store,
      provider,
      ...(options?.includeSecretRefPlaceholders === true ? { readinessMode: "read-only" } : {}),
    });
    for (const profileId of orderedProfileIds) {
      const profile = store.profiles[profileId];
      if (!profile) {
        continue;
      }
      const converted = convertAuthProfileCredentialToAgent(profile, options);
      if (converted) {
        credentials[provider] = converted;
        profileIds[provider] = profileId;
        break;
      }
    }
  }
  return { credentials, profileIds };
}
