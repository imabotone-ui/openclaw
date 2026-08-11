/** Worker-thread entrypoint for full model-catalog discovery. */
import { parentPort, workerData } from "node:worker_threads";
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
      providerIds: [...value.providerIds],
    };
    const reconstructedFingerprint = fingerprintPreparedModelCatalogGeneration({
      input: value.input,
      credentials: value.credentials,
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
