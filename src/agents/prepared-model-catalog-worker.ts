/** Runs full model-catalog discovery outside the Gateway event loop. */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  findNormalizedProviderKey,
  findNormalizedProviderValue,
} from "@openclaw/model-catalog-core/provider-id";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import {
  fingerprintPreparedRuntimeFacts,
  markPreparedModelCatalogFull,
  type PreparedModelRuntimeAgentFacts,
} from "./prepared-model-runtime.facts.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";
import type { AuthCredential, AuthStorageData } from "./sessions/auth-storage.js";

export type PreparedModelCatalogWorkerInput = Readonly<{
  generationFingerprint: string;
  input: PreparedModelRuntimeInput;
  credentials: Readonly<AuthStorageData>;
  profileIds: Readonly<Record<string, string>>;
  providerIds: readonly string[];
}>;

export type PreparedModelCatalogWorkerResult =
  | Readonly<{
      status: "ok";
      generationFingerprint: string;
      snapshot: ModelCatalogSnapshot;
    }>
  | Readonly<{ status: "failed"; error: string }>;

// Cold source/plugin loading can take well over a minute. Three minutes preserves exact full-view
// discovery while bounding a wedged provider or worker; expiry rejects and never returns partials.
const PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS = 180_000;
const PREPARED_MODEL_CATALOG_WORKER_GENERATION_POLL_MS = 25;

function fingerprintPreparedModelCatalogPlugins(snapshot: PluginMetadataSnapshot): string {
  return fingerprintPreparedRuntimeFacts({
    config: snapshot.configFingerprint ?? null,
    index: resolveInstalledManifestRegistryIndexFingerprint(snapshot.index),
    pluginIds: snapshot.pluginIds ?? null,
    policy: snapshot.policyHash,
    workspaceDir: snapshot.workspaceDir ?? null,
  });
}

export function fingerprintPreparedModelCatalogGeneration(params: {
  input: PreparedModelRuntimeInput;
  credentials: Readonly<AuthStorageData>;
  profileIds: Readonly<Record<string, string>>;
  providerIds: readonly string[];
  pluginMetadataSnapshot: PluginMetadataSnapshot;
}): string {
  return fingerprintPreparedRuntimeFacts({
    input: params.input,
    credentials: params.credentials,
    profileIds: params.profileIds,
    providerIds: params.providerIds,
    pluginFingerprint: fingerprintPreparedModelCatalogPlugins(params.pluginMetadataSnapshot),
  });
}

function projectWorkerCredential(credential: AuthCredential): AuthCredential {
  // OAuth providers may attach fields consumed by their modifyModels hook.
  const projected = { ...credential } as AuthCredential & Record<string, unknown>;
  delete projected.keyRef;
  delete projected.tokenRef;
  return projected;
}

function projectPreparedModelCatalogWorkerAuth(params: {
  agentFacts: PreparedModelRuntimeAgentFacts;
  pluginMetadataSnapshot: PluginMetadataSnapshot;
}): { credentials: AuthStorageData; profileIds: Record<string, string> } {
  const { input } = params.agentFacts;
  const credentials: AuthStorageData = {};
  const profileIds: Record<string, string> = {};
  // providerIds already closes over configured refs and explicit provider config.
  for (const provider of params.agentFacts.providerIds) {
    const aliasLookupParams = {
      config: input.config,
      env: params.agentFacts.env,
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
      metadataSnapshot: params.pluginMetadataSnapshot,
    };
    const authProvider = resolveProviderIdForAuth(provider, aliasLookupParams);
    // Keep an exact canonical selection authoritative. Alias-only persisted profiles remain
    // valid input, so fall back through the same lifecycle-owned alias snapshot.
    const credentialProvider =
      findNormalizedProviderKey(params.agentFacts.credentials, authProvider) ??
      Object.keys(params.agentFacts.credentials)
        .toSorted((left, right) => left.localeCompare(right))
        .find(
          (candidate) => resolveProviderIdForAuth(candidate, aliasLookupParams) === authProvider,
        );
    if (!credentialProvider) {
      continue;
    }
    const credential = params.agentFacts.credentials[credentialProvider];
    if (!credential) {
      continue;
    }
    credentials[authProvider] = projectWorkerCredential(credential);
    const profileId = findNormalizedProviderValue(
      params.agentFacts.credentialProfileIds,
      credentialProvider,
    );
    if (profileId) {
      profileIds[authProvider] = profileId;
    }
  }
  return { credentials, profileIds };
}

export function createPreparedModelCatalogWorkerInput(params: {
  agentFacts: PreparedModelRuntimeAgentFacts;
  pluginMetadataSnapshot: PluginMetadataSnapshot;
}): PreparedModelCatalogWorkerInput {
  const source = params.agentFacts.input;
  // Closures and registries stay process-local. The worker reconstructs them from the exact
  // config/environment generation and receives only already-materialized auth facts.
  const input: PreparedModelRuntimeInput = {
    ...(source.agentId ? { agentId: source.agentId } : {}),
    agentDir: source.agentDir,
    ...(source.inheritedAuthDir ? { inheritedAuthDir: source.inheritedAuthDir } : {}),
    ...(source.workspaceDir ? { workspaceDir: source.workspaceDir } : {}),
    ...(source.readOnly ? { readOnly: true } : {}),
    skipCredentials: true,
    env: { ...params.agentFacts.env },
    ...(source.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
    ...(source.runtimePluginSelections
      ? { runtimePluginSelections: source.runtimePluginSelections }
      : {}),
    config: source.config,
  };
  const { credentials, profileIds } = projectPreparedModelCatalogWorkerAuth(params);
  const providerIds = [...params.agentFacts.providerIds];
  return {
    generationFingerprint: fingerprintPreparedModelCatalogGeneration({
      input,
      credentials,
      profileIds,
      providerIds,
      pluginMetadataSnapshot: params.pluginMetadataSnapshot,
    }),
    input,
    credentials,
    profileIds,
    providerIds,
  };
}

function resolvePreparedModelCatalogWorkerUrl(currentModuleUrl = import.meta.url): URL {
  const currentPath = fileURLToPath(currentModuleUrl);
  const normalized = currentPath.replaceAll(path.sep, "/");
  const distMarker = "/dist/";
  const distIndex = normalized.lastIndexOf(distMarker);
  if (distIndex >= 0) {
    const distRoot = currentPath.slice(0, distIndex + distMarker.length);
    return pathToFileURL(path.join(distRoot, "agents", "prepared-model-catalog.worker.js"));
  }
  const extension = path.extname(currentPath) || ".js";
  return new URL(`./prepared-model-catalog.worker${extension}`, currentModuleUrl);
}

export function runPreparedModelCatalogWorker(params: {
  input: PreparedModelCatalogWorkerInput;
  isCurrent: () => boolean;
}): Promise<ModelCatalogSnapshot> {
  const superseded = () =>
    new PreparedModelRuntimePublicationSupersededError(
      `prepared model runtime catalog generation was superseded for ${params.input.input.agentDir}`,
    );
  if (!params.isCurrent()) {
    return Promise.reject(superseded());
  }

  const workerUrl = resolvePreparedModelCatalogWorkerUrl();
  const sourceWorkerExecArgv = workerUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : undefined;
  let worker: Worker;
  try {
    worker = new Worker(workerUrl, {
      workerData: params.input,
      execArgv: sourceWorkerExecArgv,
      // Establish path/config environment before the worker imports any state owners.
      env: { ...process.env, ...params.input.input.env },
    });
  } catch (error) {
    return Promise.reject(new Error(error instanceof Error ? error.message : String(error)));
  }
  worker.unref?.();

  return new Promise<ModelCatalogSnapshot>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(
      () => fail(new Error("prepared model catalog worker timed out")),
      PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS,
    );
    timeout.unref?.();
    const generationPoll = setInterval(() => {
      if (!params.isCurrent()) {
        fail(superseded());
      }
    }, PREPARED_MODEL_CATALOG_WORKER_GENERATION_POLL_MS);
    generationPoll.unref?.();

    type WorkerOutcome =
      | { status: "resolved"; snapshot: ModelCatalogSnapshot }
      | { status: "rejected"; error: Error };
    const settle = (outcome: WorkerOutcome, terminate = true) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInterval(generationPoll);
      worker.removeAllListeners();
      const finish = () => {
        if (outcome.status === "resolved") {
          resolve(markPreparedModelCatalogFull(outcome.snapshot));
        } else {
          reject(outcome.error);
        }
      };
      if (!terminate) {
        finish();
        return;
      }
      void worker.terminate().then(finish, (terminationError: unknown) => {
        const error =
          terminationError instanceof Error
            ? terminationError
            : new Error(String(terminationError));
        reject(
          outcome.status === "rejected"
            ? new AggregateError([outcome.error, error], outcome.error.message)
            : new Error("prepared model catalog worker termination failed", { cause: error }),
        );
      });
    };
    const fail = (error: Error, terminate = true) =>
      settle({ status: "rejected", error }, terminate);

    worker.once("message", (message: PreparedModelCatalogWorkerResult) => {
      if (!params.isCurrent()) {
        fail(superseded());
        return;
      }
      if (message.status === "failed") {
        fail(new Error(message.error));
        return;
      }
      if (message.generationFingerprint !== params.input.generationFingerprint) {
        fail(new Error("prepared model catalog worker returned a stale generation"));
        return;
      }
      settle({ status: "resolved", snapshot: message.snapshot });
    });
    worker.once("error", (error) => {
      fail(new Error(error instanceof Error ? error.message : String(error)));
    });
    worker.once("exit", (code) => {
      fail(
        new Error(
          `prepared model catalog worker exited with code ${code} before returning a result`,
        ),
        false,
      );
    });
  });
}
