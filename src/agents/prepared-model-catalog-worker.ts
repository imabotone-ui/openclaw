/** Runs full model-catalog discovery outside the Gateway event loop. */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
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
  providerIds: readonly string[];
  pluginMetadataSnapshot: PluginMetadataSnapshot;
}): string {
  return fingerprintPreparedRuntimeFacts({
    input: params.input,
    credentials: params.credentials,
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

function projectPreparedModelCatalogWorkerCredentials(params: {
  agentFacts: PreparedModelRuntimeAgentFacts;
  pluginMetadataSnapshot: PluginMetadataSnapshot;
}): AuthStorageData {
  const { input } = params.agentFacts;
  const credentials: AuthStorageData = {};
  // providerIds already closes over configured refs and explicit provider config.
  for (const provider of params.agentFacts.providerIds) {
    const authProvider = resolveProviderIdForAuth(provider, {
      config: input.config,
      env: params.agentFacts.env,
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
      metadataSnapshot: params.pluginMetadataSnapshot,
    });
    const credential = findNormalizedProviderValue(params.agentFacts.credentials, authProvider);
    if (credential) {
      credentials[authProvider] = projectWorkerCredential(credential);
    }
  }
  return credentials;
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
  const credentials = projectPreparedModelCatalogWorkerCredentials(params);
  const providerIds = [...params.agentFacts.providerIds];
  return {
    generationFingerprint: fingerprintPreparedModelCatalogGeneration({
      input,
      credentials,
      providerIds,
      pluginMetadataSnapshot: params.pluginMetadataSnapshot,
    }),
    input,
    credentials,
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

    const settle = (finish: () => void, terminate: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInterval(generationPoll);
      worker.removeAllListeners();
      if (terminate) {
        void worker.terminate();
      }
      finish();
    };
    const fail = (error: Error, terminate = true) => settle(() => reject(error), terminate);

    worker.once("message", (message: PreparedModelCatalogWorkerResult) => {
      if (!params.isCurrent()) {
        fail(superseded());
        return;
      }
      if (message.status === "failed") {
        fail(new Error(message.error), false);
        return;
      }
      if (message.generationFingerprint !== params.input.generationFingerprint) {
        fail(new Error("prepared model catalog worker returned a stale generation"), false);
        return;
      }
      settle(() => resolve(markPreparedModelCatalogFull(message.snapshot)), false);
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
