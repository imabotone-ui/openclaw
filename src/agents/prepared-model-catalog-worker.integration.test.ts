import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./auth-profiles/runtime-snapshots.js";
import {
  encodePluginModelCatalogRelativePath,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "./plugin-model-catalog.js";
import { startSerializedSnapshotBuild } from "./prepared-model-runtime.build.js";

const PROVIDER_ID = "worker-catalog-fixture";
const PLUGIN_ID = "worker-catalog-fixture";
const MATERIALIZED_SECRET = "materialized-worker-secret-not-real";
const UNRELATED_SECRET = "unrelated-worker-secret-not-real";
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  });
});

function writeFixturePlugin(params: { root: string; spinMs: number }) {
  const pluginDir = path.join(params.root, "plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  const pluginFile = path.join(pluginDir, "index.cjs");
  fs.writeFileSync(
    pluginFile,
    `const fs = require("node:fs");
module.exports = {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(PROVIDER_ID)},
      label: "Worker catalog fixture",
      auth: [],
      catalog: {
        run: async (context) => {
          const hasAuth = context.resolveProviderApiKey(${JSON.stringify(PROVIDER_ID)}).apiKey === ${JSON.stringify(MATERIALIZED_SECRET)};
          return {
            provider: {
              baseUrl: "https://worker-catalog.invalid/v1",
              api: "openai-completions",
              apiKey: "WORKER_CATALOG_API_KEY",
              models: [
                { id: "sqlite-model", name: "SQLite model" },
                { id: \`catalog-auth-\${hasAuth}\`, name: "Catalog auth proof" },
              ],
            },
          };
        },
      },
      augmentModelCatalog(context) {
        fs.appendFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, "start\\n");
        const until = Date.now() + ${params.spinMs};
        while (Date.now() < until) {}
        const hasSqlite = context.entries.some(
          (entry) => entry.provider === ${JSON.stringify(PROVIDER_ID)} && entry.id === "sqlite-model",
        );
        const hasAuth = context.resolveProviderApiKey(${JSON.stringify(PROVIDER_ID)}).apiKey === ${JSON.stringify(MATERIALIZED_SECRET)};
        const leakedUnrelated = context.resolveProviderApiKey("unrelated-provider").apiKey === ${JSON.stringify(UNRELATED_SECRET)};
        fs.appendFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, "done\\n");
        return [{
          provider: ${JSON.stringify(PROVIDER_ID)},
          id: \`proof-sqlite-\${hasSqlite}-auth-\${hasAuth}-unrelated-\${leakedUnrelated}\`,
          name: "Worker boundary proof",
        }];
      },
    });
  },
};
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: PLUGIN_ID,
      providers: [PROVIDER_ID],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      modelCatalog: {
        discovery: { [PROVIDER_ID]: "runtime" },
        runtimeAugment: true,
      },
    }),
    "utf8",
  );
  return pluginFile;
}

async function createStaticSnapshot(params: { spinMs: number }) {
  const root = tempDirs.make("openclaw-model-catalog-worker-");
  const stateDir = path.join(root, "state");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const workspaceDir = path.join(root, "workspace");
  const marker = path.join(root, "worker-marker.txt");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  const pluginFile = writeFixturePlugin({ root, spinMs: params.spinMs });
  const env = {
    ...process.env,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_WORKER_CATALOG_MARKER: marker,
  };
  const config = {
    agents: { defaults: { model: `${PROVIDER_ID}/sqlite-model` } },
    plugins: {
      allow: [PLUGIN_ID],
      load: { paths: [pluginFile] },
      entries: { [PLUGIN_ID]: { enabled: true } },
    },
  } satisfies OpenClawConfig;
  replaceRuntimeAuthProfileStoreSnapshots([
    {
      agentDir,
      store: {
        version: 1,
        profiles: {
          [`${PROVIDER_ID}:default`]: {
            type: "api_key",
            provider: PROVIDER_ID,
            key: MATERIALIZED_SECRET,
            keyRef: { source: "env", provider: "default", id: "FIXTURE_SECRET_REF" },
          },
          "unrelated-provider:default": {
            type: "api_key",
            provider: "unrelated-provider",
            key: UNRELATED_SECRET,
            keyRef: { source: "env", provider: "default", id: "UNRELATED_SECRET_REF" },
          },
        },
      },
    },
  ]);
  replacePersistedPluginModelCatalogs({
    agentDir,
    pluginCatalogWrites: {
      [encodePluginModelCatalogRelativePath(PLUGIN_ID)]: JSON.stringify({
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          [PROVIDER_ID]: {
            baseUrl: "https://worker-catalog.invalid/v1",
            api: "openai-completions",
            apiKey: "WORKER_CATALOG_API_KEY",
            models: [{ id: "sqlite-model", name: "SQLite model" }],
          },
        },
      }),
    },
  });
  const input = {
    agentId: "main",
    agentDir,
    inheritedAuthDir: agentDir,
    workspaceDir,
    config,
    env,
  };
  let current = true;
  const build = await startSerializedSnapshotBuild(
    input,
    new Map(),
    30_000,
    "static",
    () => current,
  ).pending;
  return { marker, snapshot: build.snapshot, supersede: () => (current = false) };
}

async function waitForMarker(marker: string): Promise<void> {
  await expect.poll(() => fs.existsSync(marker), { timeout: 30_000 }).toBe(true);
}

describe("prepared model catalog worker boundary", () => {
  it("keeps the event loop responsive and returns exact auth and SQLite catalog facts once", async () => {
    const fixture = await createStaticSnapshot({ spinMs: 750 });
    let settled = false;
    const first = fixture.snapshot.loadFullModelCatalog?.().finally(() => {
      settled = true;
    });
    const second = fixture.snapshot.loadFullModelCatalog?.();
    await waitForMarker(fixture.marker);

    // Before the worker boundary, observing this marker was delayed until the synchronous hook
    // completed and the catalog promise had already settled on the Gateway thread.
    expect(settled).toBe(false);
    const [catalog, sharedCatalog] = await Promise.all([first, second]);
    expect(sharedCatalog).toBe(catalog);
    expect(catalog?.entries).toContainEqual(
      expect.objectContaining({
        provider: PROVIDER_ID,
        id: "proof-sqlite-true-auth-true-unrelated-false",
      }),
    );
    expect(catalog?.entries).toContainEqual(
      expect.objectContaining({ provider: PROVIDER_ID, id: "catalog-auth-true" }),
    );
    await expect(fixture.snapshot.loadFullModelCatalog?.()).resolves.toBe(catalog);
    expect(fs.readFileSync(fixture.marker, "utf8")).toBe("start\ndone\n");
  });

  it("terminates discovery when its owning generation is superseded", async () => {
    const fixture = await createStaticSnapshot({ spinMs: 10_000 });
    const catalog = fixture.snapshot.loadFullModelCatalog?.();
    await waitForMarker(fixture.marker);
    fixture.supersede();

    await expect(catalog).rejects.toThrow("superseded");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(fs.readFileSync(fixture.marker, "utf8")).toBe("start\n");
  });
});
