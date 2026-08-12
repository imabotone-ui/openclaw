import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { loadModelProvidersData } from "./load.ts";

describe("loadModelProvidersData", () => {
  it("keeps full catalog discovery out of the initial page load", async () => {
    const request = vi.fn(async (method: string, _params?: unknown) => {
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [], providerCapabilities: [] };
        case "models.list":
          return { models: [] };
        case "config.get":
          return { config: {}, hash: "hash" };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;

    const result = await loadModelProvidersData(client);

    expect(
      request.mock.calls.filter(
        ([method, params]) =>
          method === "models.list" && (params as { view?: string } | undefined)?.view === "all",
      ),
    ).toHaveLength(0);
    expect(request).toHaveBeenCalledWith("models.list", {
      view: "configured",
      preparedOnly: true,
    });
    expect(result.providerOutcomes).toEqual([]);
    expect(result.verificationFailed).toBe(false);
  });

  it("scopes credential and catalog verification to the selected agent", async () => {
    const request = vi.fn(async (method: string, _params?: unknown) => {
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [] };
        case "models.list":
          return { models: [] };
        case "config.get":
          return { config: {}, hash: "hash" };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;

    await loadModelProvidersData(client, { refresh: true, agentId: "writer" });

    expect(request).toHaveBeenCalledWith("models.authStatus", {
      refresh: true,
      agentId: "writer",
    });
    expect(request).toHaveBeenCalledWith("usage.status");
    expect(request).toHaveBeenCalledWith("models.list", { view: "all", agentId: "writer" });
    const sessionUsageCall = request.mock.calls.find(([method]) => method === "sessions.usage");
    expect(sessionUsageCall?.[1]).not.toHaveProperty("agentId");
    expect(sessionUsageCall?.[1]).toHaveProperty("agentScope", "all");
  });

  it("degrades an invalid auth-status response without discarding other provider data", async () => {
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "models.authStatus":
          return {};
        case "models.list":
          return { models: [] };
        case "config.get":
          return { config: {}, hash: "hash" };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;

    const result = await loadModelProvidersData(client);

    expect(result.authStatus).toBeNull();
    expect(result.models).toEqual([]);
    expect(result.config).toEqual({});
    expect(result.providerUsage).toEqual({ updatedAt: 1, providers: [] });
    expect(result.costByProvider).toEqual([]);
    expect(result.error).toBeNull();
  });

  it("surfaces an exact catalog verification failure", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "models.list" && (params as { view?: string } | undefined)?.view === "all") {
        throw new Error("catalog unavailable");
      }
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [] };
        case "models.list":
          return { models: [] };
        case "config.get":
          return { config: {}, hash: "hash" };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });

    const result = await loadModelProvidersData({ request } as unknown as GatewayBrowserClient, {
      refresh: true,
    });

    expect(result.providerOutcomes).toEqual([]);
    expect(result.verificationFailed).toBe(true);
  });
});
