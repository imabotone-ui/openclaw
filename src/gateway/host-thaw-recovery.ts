import { TICK_INTERVAL_MS } from "./server-constants.js";

// A real host freeze loses at least 45s beyond the expected maintenance cadence;
// shorter gaps are ordinary event-loop load and must not churn channel sockets.
export const HOST_THAW_MIN_FROZEN_MS = 45_000;

type HostThawDeps = {
  nowMs: () => number;
  restartChannels: () => Promise<void>;
  refreshHealth: () => Promise<void>;
  refreshPresence: () => void;
  resetEventLoopHealth: () => void;
  isAdmissionClosed: () => boolean;
  logger: { info: (message: string) => void; error: (message: string) => void };
};

export function createHostThawRecovery(deps: HostThawDeps): { tick: () => Promise<void> } {
  let lastTickAtMs = deps.nowMs();
  let pendingFrozenMs: number | undefined;
  let activeRecovery: Promise<void> | undefined;

  const runStep = async (label: string, step: () => void | Promise<void>) => {
    try {
      await step();
    } catch (error) {
      deps.logger.error(`host thaw ${label} failed: ${String(error)}`);
    }
  };

  const recover = async (frozenMs: number) => {
    deps.logger.info(
      `host thaw detected: process was frozen ~${Math.round(frozenMs)}ms; restarting channels and refreshing health`,
    );
    await runStep("event-loop reset", deps.resetEventLoopHealth);
    await runStep("channel restart", deps.restartChannels);
    await runStep("health refresh", deps.refreshHealth);
    await runStep("presence refresh", deps.refreshPresence);
  };

  return {
    tick: async () => {
      const nowMs = deps.nowMs();
      const gapMs = nowMs - lastTickAtMs;
      lastTickAtMs = nowMs;
      if (gapMs >= TICK_INTERVAL_MS + HOST_THAW_MIN_FROZEN_MS) {
        pendingFrozenMs = Math.max(pendingFrozenMs ?? 0, gapMs - TICK_INTERVAL_MS);
      }
      // Suspension/restart owns the closed period. Recovery must wait rather than
      // waking channels while the controller deliberately keeps the gateway quiet.
      if (pendingFrozenMs === undefined || deps.isAdmissionClosed() || activeRecovery) {
        return;
      }
      const frozenMs = pendingFrozenMs;
      pendingFrozenMs = undefined;
      activeRecovery = recover(frozenMs);
      try {
        await activeRecovery;
      } finally {
        activeRecovery = undefined;
      }
    },
  };
}
