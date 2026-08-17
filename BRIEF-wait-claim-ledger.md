# Implementation Brief: Durable Subagent Wait-Claim Ledger

Branch: `wait-claim-ledger`

## Problem statement

Subagent/requester completion delivery is currently modeled as N independent
best-effort push mechanisms (direct steer, queued delivery, requester
settle-wake batching, generated-media handoff, restart-recovery replay), each
with local heuristics about whether "someone else" already covers a given
case. No single source of truth records "requester X is waiting on children
{A,B,C}." This produces at least 11 identified failure modes, most critically
zero safety net for nested subagents (depth >= 1) and cron-triggered
orchestrators.

Reference issues on openclaw/openclaw: #92116, #124343, #112668, #107788,
#90944, #121187, #123548, #111647, #96190, #86684, #123668.

## Objective

Replace push-and-hope delivery with a durable, queryable wait-claim: every
`sessions_yield` writes an explicit claim (requester, awaited child set,
timestamp); every child completion writes its result against that claim;
wake becomes a pull-triggered consequence of "claim satisfied," checked at
defined admission points -- not raced by parallel push paths guessing at
coverage.

## Root causes identified (for reference during implementation)

1. Soft-signal settle-wake -- prose injected as context, not an enforced
   state transition (`subagent-announce.requester-settle-wake.ts`
   `buildRequesterSettleWakeMessage`).
2. Single-child fast-path skip races `sessions_yield` timing
   (`requiredSettled.length < 2 && !hasUndeliveredRequiredCompletion &&
   !requesterYieldedAfterDelivery` gate).
3. Nested subagents (depth >= 1) unconditionally excluded from settle-wake
   (`getSubagentDepthFromSessionStore(...) >= 1` early return).
4. In-memory, non-persisted `setTimeout` retry state in
   `subagent-registry-run-wait.ts` (`scheduleWaitRetry`) -- lost on gateway
   restart.
5. `message_tool_only` delivery mode has no fallback if the completion agent
   skips the message tool.
6. Cron-session requesters unconditionally excluded from settle-wake
   (`isCronSessionKey(requesterSessionKey)` early return, no replacement
   mechanism -- see RFC #96190).
7. `isInternalAnnounceRequesterSession` conflates nested-depth and cron
   cases under one "internal, handled elsewhere" classifier -- both are
   the underserved categories (#3, #6). Diagnosis, not an independent bug;
   should disappear once #3/#6 are properly covered by the ledger.
8. Delivery-mode contract (`message_tool_only` vs `automatic`) can be
   recomputed differently across retries of the same run
   (`subagent-announce-active-wake.ts`, `source_reply_delivery_mode_mismatch`
   branch strips the field and retries blind instead of reconciling).
9. Restart recovery permanently "wedges" after `MAX_RECOVERY_ATTEMPTS = 2`
   within `RECOVERY_ATTEMPT_WINDOW_MS` (2 min) -- silent beyond a warn log
   (`subagent-registry-restart-recovery.ts`).
10. Compaction-vs-wake race: bounded retry schedule
    (`resolveCompactionSteerRetryDelaysMs`) falls through to fragile fallback
    paths if compaction outlasts the delivery window
    (`subagent-announce-active-wake.ts`).
11. Same mechanism as #8, directly observed in the strip-and-retry code path.

## Scope -- new components

1. **Wait-claim store**: durable table/row keyed by requester session,
   listing awaited `runId`s, claim creation time, and satisfaction state per
   child. Extend existing `SubagentRunRecord` / registry persistence
   (`src/agents/subagents/registry/`) rather than inventing a parallel
   store where possible.
2. **Claim writer**: `sessions_yield` tool
   (`src/agents/tools/sessions-yield-tool.ts`) records the claim before
   ending the turn, instead of just recording pause intent locally via
   `onYield`.
3. **Claim resolver**: single function, called at fixed checkpoints (child
   completion commit, heartbeat, next-turn admission), that answers "is this
   claim satisfied" -- replacing the scattered logic in
   `hasDescendantRunAwaitingSettle`, `buildConnectedSettledWave`,
   `isInternalAnnounceRequesterSession`, depth checks, and cron-key checks.
4. **Single wake trigger**: one code path that fires when the resolver says
   satisfied, replacing `maybeWakeRequesterAfterAllChildrenSettled`'s
   batch/rearm-generation machinery with a claim-satisfied check.

## Directly collapses (no longer need separate handling)

- #1 soft-signal wake -- claim satisfaction is a hard boolean, not injected
  prose.
- #2 single-child fast-path race -- no more timing-dependent
  `requesterYieldedAfterDelivery` flag.
- #3 nested-subagent exclusion -- claim resolver has no depth >= 1 special
  case.
- #6 cron-session exclusion -- claim resolver has no cron-key special case.
- #7 the conflated classifier (`isInternalAnnounceRequesterSession`) becomes
  unnecessary.
- #10 compaction race -- claim persists through compaction; resolver
  re-checks at next admission point regardless of timing.

## Not automatically fixed -- separate follow-up work

- #4 (in-memory `setTimeout` retries) -- migrate to ledger-backed scheduled
  retries.
- #5 / #8 / #11 (message_tool_only fallback, delivery-mode contract drift)
  -- pin delivery mode once per claim, not recomputed per retry attempt.
- #9 (restart-recovery wedge after 2 attempts/2min) -- surface wedge state
  as a queryable claim status rather than a buried warn log.

## User-visible contract (hard requirement, not incidental)

- Success path: exactly one final answer, same as today -- no change.
- Terminal failure/timeout/wedge: exactly one clear notice, once. Currently
  zero.
- Everything else (retries, compaction backoff, reconciliation, restart
  attempts): internal/log-only, never surfaced. Must not become
  wake-progress chatter in-channel.

## Rollout risk

Primary risk is migrating in-flight registry rows across a gateway restart
mid-transition (old push-based state coexisting with new claim-based state).
This is exactly the fragile territory the existing
`subagent-registry-restart-recovery.ts` lifecycle-generation/idempotency-key
machinery exists to guard against -- reuse that pattern rather than invent a
new one.

## Suggested sequencing

1. Add wait-claim store + writer (additive, no behavior change yet).
2. Add claim resolver, run it in shadow/log-only mode alongside existing
   wake paths to validate it agrees with current outcomes.
3. Cut over wake trigger to claim-resolver-driven, one delivery path at a
   time (requester settle-wake batch first -- highest-value, most-tested --
   then direct/steer, then restart-recovery integration).
4. Retire old heuristics (`isInternalAnnounceRequesterSession`, depth/cron
   special cases, `rearmGeneration` batching) once claim-driven path is
   confirmed stable.
5. Backfill #4/#5/#8/#9 fixes using the new ledger as their foundation.

## Estimated effort

Cross-cutting: touches registry + all four announce/delivery mechanisms +
restart-recovery + cron dispatch. Not a single-PR fix -- closer to a
multi-PR initiative with a shadow-mode validation phase before cutover,
given how many closed "narrow fix" PRs already exist for symptoms of this
exact area (see #73628, #87330, #91370, #97922, #95996, #117283 -- all
closed/merged for narrower scopes without resolving the root cause).

## Key files to start with

- `src/agents/subagents/registry/subagent-registry.types.ts` -- add
  wait-claim shape here.
- `src/agents/subagents/registry/subagent-registry-run-wait.ts` --
  `markSubagentRunPausedAfterYield`, `waitForSubagentCompletion`.
- `src/agents/subagents/announce/subagent-announce.requester-settle-wake.ts`
  -- `maybeWakeRequesterAfterAllChildrenSettled`, the main batching logic to
  replace.
- `src/agents/subagents/registry/subagent-registry-lifecycle-completion.ts`
  -- `completeSubagentRunAttempt`, where completions currently get written.
- `src/agents/tools/sessions-yield-tool.ts` -- claim-writing entry point.
- `src/agents/subagents/registry/subagent-registry-restart-recovery.ts` --
  pattern to follow for durable state transitions across restarts.

## Progress Log

### 2026-08-17 — Step 1 landed on this branch (additive store + writer)

Added, per "Suggested sequencing" step 1 (no behavior change):

- `src/agents/subagents/registry/subagent-registry.types.ts`: new
  `SubagentWaitClaim` type (`requesterSessionKey`, optional
  `requesterTurnRunId`, sorted frozen `awaitedRunIds`, `claimedAt`) and an
  optional `waitClaim` field on `SubagentRunRecord`. Persists for free through
  the sqlite store's payload-JSON hydration; no schema change.
- `src/agents/subagents/registry/subagent-wait-claim.ts`: claim writer
  `recordSubagentWaitClaimInRuns`. Awaited = expectsCompletionMessage, not a
  collector, not suppressed, not cleaned up, and not (terminal + delivered).
  Deliberately no depth/cron exclusions. Rolls back on persist failure.
- `src/agents/subagents/registry/subagent-registry-public-api.ts`:
  `markRequesterTurnYielded` (the sessions_yield `onBeforeYield` path via
  `src/agents/openclaw-tools.ts`) now also writes the claim, additive
  alongside the existing yield marking. Existing push paths untouched.
- `src/agents/subagents/registry/subagent-wait-claim.test.ts`: single child,
  multi-child frozen sorted set, nested-subagent requester, cron-session
  requester, skip rules, persist rollback.

Deliberately deferred (out of scope for this run): claim resolver, any wake
trigger or settle-wake changes, restart-recovery integration, retiring
`isInternalAnnounceRequesterSession`/depth/cron heuristics, claim cleanup on
satisfaction (rows currently just carry the last claim; resolver step owns
lifecycle). Known accepted gap: if claim persist fails after yield marking
persisted, the yield mark stands without a claim — harmless while nothing
reads the ledger; revisit when the resolver lands.

Next session (step 2): add the claim resolver as one function answering "is
this claim satisfied", called at child completion commit, heartbeat, and
next-turn admission, running in shadow/log-only mode and comparing its answer
against the existing settle-wake outcomes. No cutover yet.
