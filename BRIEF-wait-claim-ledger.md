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

### 2026-08-17 — Step 2 landed on this branch (resolver + shadow mode)

What the resolver does:

- `resolveSubagentWaitClaim` in
  `src/agents/subagents/registry/subagent-wait-claim.ts`: pure function over
  the runs map. Finds the requester's latest claim (newest `claimedAt` on any
  row — every child stamped by one yield carries an identical claim), then
  checks each `awaitedRunIds` member. Settled = row deleted (registry only
  retires rows after obligations resolve) or no longer awaited per the same
  `isAwaitedByRequester` predicate the writer uses (terminal + delivered,
  suppressed, collector, cleaned up). Returns a closed
  `no_claim | pending (with unsettledRunIds) | satisfied` union. Deliberately
  no depth>=1 or cron-key exclusions — nested and cron requesters resolve
  identically.

How shadow mode works and how to read it:

- Wired at the single push-path point: in
  `subagent-registry-lifecycle-wake.ts`, `scheduleRequesterSettleWake`'s
  promise chain gained a `.then((pushWake) => logWaitClaimResolverShadow(...))`
  before the existing `.catch`/`.finally`. `pushWake` is
  `maybeWakeRequesterAfterAllChildrenSettled`'s boolean return (true only when
  a settle-wake message was actually delivered).
- `logWaitClaimResolverShadow`
  (`subagent-wait-claim-shadow.ts`) emits one `logDebug` line per comparison:
  `[wait-claim-resolver-shadow] agree|disagree push=<bool>
  resolver=<pending|satisfied> requester=<masked> settledRun=<masked>
  [pending=<masked ids>]`. `no_claim` (requester never yielded) logs nothing.
  Identifiers are masked via `maskLifecycleIdentifier`. Observe-only by
  contract: the whole body is wrapped in try/catch, returns void, and cannot
  alter the wake decision. Grep `wait-claim-resolver-shadow` to find every
  trace and the one wiring site for removal/promotion.
- Reading guide — `disagree push=false resolver=satisfied` is NOT
  automatically a missed wake. `pushWake=true` means "synthetic settle-wake
  delivered", while `resolver=satisfied` means "nothing left awaited". They
  legitimately differ when the per-child completion already reached the
  requester (single-child fast path: push declines the redundant wake) and
  transiently during push retry backoff. The interesting rows are satisfied +
  push=false where the requester had actually yielded
  (`requesterYieldBatch`/`rearmGeneration` present) — those are the missed
  wakes the ledger exists to fix.

Known systematic disagreements found by code inspection (expected, valuable):

1. Cron requesters: push path completes the batch at
   `isCronSessionKey` early-return and never wakes; resolver says satisfied.
   Every cron shadow line will read `disagree push=false resolver=satisfied`.
   This is root cause #6 — by design the resolver disagrees here.
2. Nested requesters (depth >= 1): same shape via the
   `getSubagentDepthFromSessionStore(...) >= 1` completion branch. Root
   cause #3.
3. Descendant scope gap (matters for step 3 design): the push path defers a
   drained batch while `hasDescendantRunAwaitingSettle` sees unsettled
   grandchildren; the claim covers only the requester's direct awaited
   children, so the resolver can say satisfied while push intentionally holds
   the wake. Cutover must decide whether descendant-drain remains a
   delivery-timing gate layered on claim satisfaction, or whether claims
   should be resolved transitively down the requester chain. Do not cut over
   settle-wake before answering this.
4. Membership drift: a claim frozen at yield can include a child the
   settle-wake batch machinery later excludes (rearm-generation mismatch,
   retired rows), so `resolver=pending push=true` is theoretically possible;
   no such line should appear in practice — treat any occurrence as a bug in
   either the batch freeze or the claim writer.

Validation: new resolver unit tests (satisfied / pending / partially settled /
retired+suppressed rows / newest-claim selection / nested + cron uniformity)
in `subagent-wait-claim.test.ts`; shadow tests (agree, disagree, pending
masking, no_claim silence, never-throws on a poisoned runs map) in
`subagent-wait-claim-shadow.test.ts`; full `src/agents/subagents/` suite green
with no existing-test changes.

Step 3 next: cut over one delivery path at a time, starting with the
requester settle-wake batch. Concretely: (a) resolve the descendant-scope
question above; (b) make the settle-wake completion path consult
`resolveSubagentWaitClaim` as the wake gate for yielded requesters instead of
the depth/cron early-returns, keeping the existing delivery/retry machinery;
(c) add claim lifecycle (clear or tombstone the claim once its wake
delivers) so satisfied claims don't re-trigger; (d) promote or remove the
shadow log lines at that point.

### 2026-08-17 — Step 2 follow-up: fixed a timing regression before merge

The worker that landed the above left its own background full-suite test run
running and never committed, pushed, or sent its completion notification
(its process was killed mid-run). Picking that up directly rather than
re-running the same task from scratch:

Running the full `src/agents/subagents/` suite surfaced a real regression
introduced by the shadow wiring: 4 test files failed, all the same assertion
in `subagent-registry.test.ts` — a retry-after-worker-error test expected
`maybeWakeRequesterAfterAllChildrenSettled` to be called twice across two
sweeps and only saw one call.

Root cause: the original wiring chained the shadow observer inline —
`wakePromise.then((pushWake) => logWaitClaimResolverShadow(...)).catch(...).finally(...)`.
Inserting a `.then()` ahead of `.catch()`/`.finally()` adds one extra
microtask tick before that `.finally()` runs. That `.finally()` is what calls
`context.unmarkRequesterSettleWakeRunScheduled(runId)` — the flag a same-tick
retry sweep checks via `context.hasScheduledRequesterSettleWakeRun(runId)`
before deciding whether to re-invoke the wake. With the shadow `.then()` in
the chain, a same-tick second sweep can observe the run as still scheduled
and skip re-invoking the wake — i.e. shadow-mode *observation* was changing
real retry timing, exactly the failure class this whole ledger effort exists
to eliminate. Ironic, and a useful proof that "observe-only" needs to be
verified against the async chain shape, not just against direct return
values.

Fix: attach the shadow `.then()`/rejection-swallow as an independent branch
off the same `wakePromise`, in parallel with (not chained ahead of) the
existing `.catch()`/`.finally()` chain, so shadow logging can never delay the
real cleanup/retry logic regardless of how many microtask ticks it takes.
See `subagent-registry-lifecycle-wake.ts`.

Validation after the fix: `subagent-registry.test.ts` alone (148 tests × 2
projects = 296) all green; full `src/agents/subagents/` suite: 179 files,
4496 tests, all green, zero existing-test changes.

Lesson for step 3: any future wiring of the resolver into a real decision
path must audit the exact promise-chain shape it's inserted into, not just
its logical effect — an async instrumentation point that looks purely
additive can still shift ordering-sensitive cleanup/retry behavior. Prefer
attaching observers as parallel branches off the original promise rather
than chaining them inline, as a default pattern for any future shadow/log
instrumentation in this codebase.

### 2026-08-17 — Step 3 (cron + nested cutover) landed on this branch

Deliberately a scoped subset of the brief's step 3: only the two categories
with ZERO wake coverage were cut over. Ordinary (non-cron, non-nested)
requesters — the single-child fast path and multi-child batch logic — are
completely untouched and remain push-path + shadow-observed.

What was cut over, in
`subagent-announce.requester-settle-wake.ts`:

- The unconditional `isCronSessionKey` early-return (root cause #6) and the
  `getSubagentDepthFromSessionStore(...) >= 1` zero-delivery completion
  (root cause #3) are gone. Both categories now consult
  `resolveSubagentWaitClaim` at the point where the drained batch decides
  between completing and delivering: `satisfied` proceeds into the SAME
  existing `deliverSubagentAnnouncement` batch machinery (idempotency keys,
  retries, replay, dispatch bookkeeping all shared); `pending`/`no_claim`
  keeps the pre-cutover zero-delivery completion for now (a requester that
  never yielded or is still waiting is out of scope for this run).
- Nested requesters deliver with `requesterIsSubagent: true` (internal-only
  delivery — a subagent session has no external channel target) and never
  with `requireVisibleReply` (its "final answer" is its completion message to
  its own parent, not a user-visible reply; enforcing visibility would
  dead-end it). Cron requesters get the standard top-level treatment.

Descendant-scope decision (implemented as directed, and agreed with after
inspection): `hasDescendantRunAwaitingSettle` remains an additional gate
layered on claim satisfaction. Claim satisfaction is a necessary condition to
ATTEMPT the wake for cron/nested requesters (replacing the unconditional
skip); the existing descendant checks — the pre-batch defer and the
pre-dispatch recheck inside the delivery section — continue to defer exactly
as they do for every other category. Reasoning: the claim ledger records only
the requester's DIRECT awaited children (`awaitedRunIds` frozen at yield), so
"claim satisfied" cannot see unsettled grandchildren spawned by those
children. Waking while a grandchild is mid-flight would hand the requester a
"everything settled" message that is false at the tree level — exactly the
class of premature/false wake this ledger exists to eliminate. Resolving
claims transitively down the requester chain was considered and deferred: it
would require walking child claims (which nested children now also write),
and the existing descendant check already answers the same question from live
registry rows without new claim semantics. Revisit transitive resolution only
if step 3b finds the dual mechanism (claim + descendant scan) drifting.

Claim lifecycle: a DELIVERED claim-gated wake consumes the claim.
`completeRequesterSettleWakeBatch` in `subagent-registry-lifecycle-wake.ts`
takes a new `clearWaitClaims` flag (threaded through the existing
`completeBatch` callback as an optional 4th arg); when set with a delivered
outcome it clears `waitClaim` on every retained row carrying that requester's
claim — not just the batch rows, since one yield stamps all awaited siblings —
staged in memory and persisted in the SAME `persistOrThrow` call as the batch
completion bookkeeping, rolled back together on persist failure (step 1's
atomicity discipline; no second unguarded persist). Failed/exhausted wakes do
not clear the claim (nothing re-triggers anyway without `requesterSettleWake`
state; step 3b owns richer failure lifecycle).

Shadow mode: `logWaitClaimResolverShadow` now returns early (inside its
try/catch, no promise-chain change — see the step 2 follow-up lesson) for
cron and depth>=1 requesters, since they are no longer observe-only; the
comparison line is unchanged for ordinary requesters. Grep
`wait-claim-resolver-shadow` still finds the one wiring site.

Existing-test changes, all confined to old zero-coverage cron/nested
assertions (expected per scope): the "skips cron requester sessions" test
became "completes a cron batch with zero delivery when the requester holds no
claim"; the nested equivalent was reworded the same way; the mixed-obligation
test's cron leg now feeds the cron child through `listSubagentRunsForRequester`
(previously the early-return never listed runs); the shadow "disagreement"
test moved off a cron requester to an ordinary one. No ordinary-requester
test expectation was modified.

New tests: cron satisfied-claim wake through the real delivery machinery
(incl. `clearWaitClaims` handoff), nested satisfied-claim internal-only wake,
satisfied-claim-but-unsettled-descendants still defers (both categories),
pending-claim zero-delivery completion (both categories), no-claim
zero-delivery regression locks (both categories), shadow silence for
cut-over categories, and a registry-level test that a delivered claim-gated
wake clears `waitClaim` across requester rows in the lifecycle persist.

Validation: focused files green; full `src/agents/subagents/` suite green
(179 files / 4532 tests — up from 179/4496 via the new tests, no
reductions); `pnpm tsgo` + `pnpm check:test-types` clean.

Step 3b next (future session): cut the ordinary single-child fast path and
multi-child batch logic over to the claim gate (removing the
`requesterYieldedAfterDelivery` timing flag, root cause #2), then retire
shadow logging entirely (`subagent-wait-claim-shadow.ts` and its wiring in
`subagent-registry-lifecycle-wake.ts`), retire
`isInternalAnnounceRequesterSession` (root cause #7), and decide the
pending/no_claim story for cron/nested (today still zero-delivery completion
— the remaining silent path). Also fold the descendant-scope question into
3b: either keep the descendant gate as the one non-claim input to wake
timing, or make claims resolve transitively and delete the scan.
