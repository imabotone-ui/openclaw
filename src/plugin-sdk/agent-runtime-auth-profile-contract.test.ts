import { describe, expect, it } from "vitest";
import { type AuthProfileStore, resolveAuthProfileEligibility } from "./agent-runtime.js";

type PublicEligibilityParams = Parameters<typeof resolveAuthProfileEligibility>[0];

const aliasProfileStore: AuthProfileStore = {
  version: 1,
  profiles: {
    "provider-two:named": {
      type: "api_key",
      provider: "provider-two",
      key: "test-key",
    },
  },
};

describe("agent-runtime auth profile contract", () => {
  it("accepts and applies caller-provided auth alias metadata", () => {
    const params = {
      cfg: {},
      authAliasLookupParams: {
        config: {},
        metadataSnapshot: {
          plugins: [
            {
              id: "alias-owner",
              origin: "global",
              providerAuthAliases: { fixture: "provider-two" },
            },
          ],
        } as never,
      },
      store: aliasProfileStore,
      provider: "fixture",
      profileId: "provider-two:named",
    } satisfies PublicEligibilityParams;

    expect(resolveAuthProfileEligibility(params)).toEqual({ eligible: true, reasonCode: "ok" });
  });
});
