/** Worker-thread entrypoint for full model-catalog discovery. */
import { parentPort, workerData } from "node:worker_threads";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  fingerprintPreparedModelCatalogGeneration,
  type PreparedModelCatalogWorkerInput,
  type PreparedModelCatalogWorkerResult,
} from "./prepared-model-catalog-worker.js";
import {
  prepareAgentCatalogSource,
  prepareFullCatalogFacts,
  prepareWorkspaceBuildGroup,
} from "./prepared-model-runtime.facts.js";
import { AuthStorage } from "./sessions/auth-storage.js";

function projectWorkerAuthStore(
  credentials: PreparedModelCatalogWorkerInput["credentials"],
  profileIds: PreparedModelCatalogWorkerInput["profileIds"],
): AuthProfileStore {
  // Only selected stored profiles regain profile identity. Ambient credentials stay in the
  // prepared credential map so the worker cannot misreport env/config auth as a profile.
  return {
    version: 1,
    profiles: Object.fromEntries(
      Object.entries(credentials).flatMap(([provider, credential]) => {
        const profileId = profileIds[provider];
        return profileId ? [[profileId, { ...credential, provider }]] : [];
      }),
    ),
  };
}

export async function runPreparedModelCatalogWorkerInput(
  value: PreparedModelCatalogWorkerInput,
): Promise<PreparedModelCatalogWorkerResult> {
  try {
    const prepared = await prepareWorkspaceBuildGroup([value.input], "live");
    const agentFacts = prepared.agentFacts[0];
    if (!agentFacts) {
      throw new Error("prepared model catalog worker produced no agent facts");
    }
    const exactAgentFacts = {
      ...agentFacts,
      templateAuthStorage: AuthStorage.inMemory({ ...value.credentials }),
      credentials: value.credentials,
      credentialProfileIds: value.profileIds,
      providerIds: [...value.providerIds],
    };
    const reconstructedFingerprint = fingerprintPreparedModelCatalogGeneration({
      input: value.input,
      credentials: value.credentials,
      profileIds: value.profileIds,
      providerIds: value.providerIds,
      pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
    });
    if (reconstructedFingerprint !== value.generationFingerprint) {
      throw new Error("prepared model catalog worker reconstructed a different runtime generation");
    }
    const source = await prepareAgentCatalogSource(
      exactAgentFacts,
      prepared.pluginGeneration,
      "live",
      false,
      { authStore: projectWorkerAuthStore(value.credentials, value.profileIds) },
    );
    const facts = await prepareFullCatalogFacts(
      exactAgentFacts,
      prepared.pluginGeneration,
      "live",
      source,
    );
    return {
      status: "ok",
      generationFingerprint: value.generationFingerprint,
      snapshot: facts.modelCatalog,
    };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

if (parentPort) {
  const send: (message: PreparedModelCatalogWorkerResult) => void =
    parentPort.postMessage.bind(parentPort);
  send(await runPreparedModelCatalogWorkerInput(workerData as PreparedModelCatalogWorkerInput));
}
