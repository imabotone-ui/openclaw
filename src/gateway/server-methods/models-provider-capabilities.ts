import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveManifestProviderAuthChoices } from "../../plugins/provider-auth-choices.js";
import { supportsSetupManualSecret } from "../../system-agent/setup-inference-auth-options.js";
import type { ModelProviderCapability } from "./models-auth-status.types.js";

export type ResolvedModelProviderCapabilities = {
  byProvider: ReadonlyMap<string, ModelProviderCapability>;
  entries: ModelProviderCapability[];
  resolveProvider(provider: string): string;
};

/** Resolves one generation-owned capability inventory for auth status and model rows. */
export function resolveModelProviderCapabilities(params: {
  config: OpenClawConfig;
  workspaceDir: string;
  metadataSnapshot: PluginMetadataSnapshot;
}): ResolvedModelProviderCapabilities {
  const byProvider = new Map<string, ModelProviderCapability>();
  const resolveProvider = (provider: string) =>
    resolveProviderIdForAuth(provider, {
      config: params.config,
      workspaceDir: params.workspaceDir,
      includeUntrustedWorkspacePlugins: false,
      metadataSnapshot: params.metadataSnapshot,
    });
  for (const choice of resolveManifestProviderAuthChoices({
    config: params.config,
    workspaceDir: params.workspaceDir,
    includeUntrustedWorkspacePlugins: false,
    metadataSnapshot: params.metadataSnapshot,
  })) {
    const provider = resolveProvider(choice.providerId);
    if (!provider) {
      continue;
    }
    const current = byProvider.get(provider);
    const apiKeySupported = choice.methodId === "api-key";
    const quickApiKeySetup = apiKeySupported && supportsSetupManualSecret(choice);
    byProvider.set(provider, {
      provider,
      apiKeySupported: current?.apiKeySupported === true || apiKeySupported,
      quickApiKeySetup: current?.quickApiKeySetup === true || quickApiKeySetup,
    });
  }
  const entries = [...byProvider.values()].toSorted((a, b) => a.provider.localeCompare(b.provider));
  return { byProvider, entries, resolveProvider };
}
