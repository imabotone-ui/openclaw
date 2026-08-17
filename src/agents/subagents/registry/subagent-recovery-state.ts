import type { SessionEntry } from "../../../config/sessions.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { isFastTestRuntimeEnv } from "../../../infra/env.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/**
 * Delay before a recoverable completion-wait retry re-fires. Shared by the
 * run-manager's in-memory timer and the sweeper's overdue-marker grace window:
 * a pendingWaitRetryAt older than one full delay means the timer was lost.
 */
export const RECOVERABLE_WAIT_RETRY_DELAY_MS = isFastTestRuntimeEnv() ? 25 : 5_000;

export function shouldSuppressSubagentRecoverySessionEffects(entry: SubagentRunRecord): boolean {
  if (entry.killIntent) {
    const killLifecycleGeneration = entry.killIntent.lifecycleGeneration;
    return (
      typeof killLifecycleGeneration !== "string" ||
      killLifecycleGeneration.length === 0 ||
      !isAgentEventLifecycleGenerationCurrent(killLifecycleGeneration)
    );
  }
  if (entry.execution.suppressSessionEffects === true) {
    return true;
  }
  const lifecycleGeneration = entry.execution.restartRecovery?.lifecycleGeneration;
  return (
    typeof lifecycleGeneration === "string" &&
    lifecycleGeneration.length > 0 &&
    !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)
  );
}

export function isSubagentRecoveryWedgedEntry(entry: unknown): boolean {
  const recovery =
    entry && typeof entry === "object" ? (entry as SessionEntry).subagentRecovery : undefined;
  return (
    typeof recovery?.wedgedAt === "number" &&
    Number.isFinite(recovery.wedgedAt) &&
    recovery.wedgedAt > 0
  );
}

export function formatSubagentRecoveryWedgedReason(entry: SessionEntry): string {
  return (
    entry.subagentRecovery?.wedgedReason?.trim() ||
    "subagent orphan recovery is tombstoned for this session"
  );
}

export function clearWedgedSubagentRecoveryAbort(entry: SessionEntry, now: number): boolean {
  if (!isSubagentRecoveryWedgedEntry(entry) || entry.abortedLastRun !== true) {
    return false;
  }
  entry.abortedLastRun = false;
  entry.updatedAt = now;
  return true;
}
