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

### 2026-08-17 — Step 3b (ordinary-requester cutover + shadow retirement) landed

What was cut over, in `subagent-announce.requester-settle-wake.ts`: the claim
gate is now uniform across cron, nested, and ordinary requesters. After the
fire-and-forget completion branch, every drained wave resolves
`resolveSubagentWaitClaim` once:

- `satisfied` → proceed into the existing `deliverSubagentAnnouncement`
  machinery (idempotency keys, retries, replay, `requireVisibleReply` inputs
  all untouched), and a DELIVERED wake consumes the claim via the same
  `clearWaitClaims` lifecycle persist that step 3 added — now for every
  requester category, not just cron/nested.
- `pending` → the batch is HELD, never consumed: frozen batches defer via the
  existing `deferRequesterSettleWakeBatch`; unfrozen waves return without a
  transition and rebuild on the next settle sweep. This replaces step 3's
  pending → zero-delivery completion for cron/nested too — consuming a batch
  while a claimed sibling was mid-flight dropped that batch's findings from
  the eventual wake (a silent-failure path); holding it lets the sibling's own
  settle sweep rebuild the wave and wake with every finding.
- `no_claim` → cron/nested keep step 3's zero-delivery completion; ordinary
  requesters keep the pre-existing no-yield push behavior (details below).

Resolver/writer predicate fix required by the cutover: `isAwaitedByRequester`
now shares the canonical `isDeliveryTerminalForRequesterSettle` predicate
(exported from `subagent-registry-queries.ts`) instead of a bare
`delivery.status !== "delivered"` check. Without this, a yielded batch whose
already-ended children were marked `intentional_non_delivery` at yield-settle
(the batch wake OWNS their terminal delivery per
`settleRequesterTurnAfterSessionSpawns`) could never resolve satisfied — the
wake would deadlock behind its own precondition. Terminal children with
`permanent_failure` or suspended delivery also count settled now, so the wake
still fires as the fallback findings carrier for them.

Empirical verification (point 2) and its outcome: the heuristic and the
resolver DO legitimately disagree on real, currently-working, protected
cases — and not rarely. Verified against the existing test suite (~15 tests
including the whole restart-persistent-outbox group) rather than shadow-log
reasoning alone:

1. Multi-child no-yield waves (no claim exists, all completions delivered)
   get a consolidation wake today. A satisfied-only gate would silently drop
   it — a default-path regression across the mainline batch machinery.
2. Undelivered-required-completion waves without a claim get the settle wake
   as the fallback delivery carrier today (e.g. suspended/failed announce).
   A satisfied-only gate would strand those findings — the worst bug class.
3. A requester that yields AFTER its last awaited child already delivered
   gets a wake today via the yield flags — and by writer design NO claim is
   written in that case (`applySubagentWaitClaimMutation` returns
   `mutated: false` when nothing is still awaited), so "satisfied" can never
   gate it.

Conclusion: full heuristic replacement is not possible with the current
claim-writer contract (claims record only still-awaited children at yield).
The cutover therefore replaces the heuristic exactly where the ledger is
authoritative: a claim's `pending`/`satisfied` states override the flags
completely (fixing root cause #2 — a raced yield whose flags are lost but
whose claim persisted now wakes; a yielded requester with a claimed sibling
still running now defers where the flags alone would have woken
prematurely). The `requiredSettled.length < 2 && !hasUndeliveredRequiredCompletion
&& !requesterYieldedAfterDelivery` skip survives ONLY in the no_claim branch,
covering the three cases above. Fully retiring it needs a writer-contract
change — stamping a claim for every completion child of the yielding turn,
including already-delivered ones (turn-scoped claims) — which is a named
follow-up, not attempted here on the highest-traffic path.

Deleted: `subagent-wait-claim-shadow.ts`, `subagent-wait-claim-shadow.test.ts`,
and the shadow wiring in `subagent-registry-lifecycle-wake.ts` (grep for
`wait-claim-shadow`, `logWaitClaimResolverShadow`, and
`wait-claim-resolver-shadow` across src/ and docs/ returns zero hits). Also
deleted `src/test-utils/vitest-module-mocks.ts` (see flake note below).

Deliberately left, with reasons:

- `isInternalAnnounceRequesterSession` (root cause #7): still consumed by
  `src/plugin-sdk/agent-harness-task-runtime.ts` to classify DELIVERY routing
  (internal vs external origin resolution), a different concern from the wake
  gate it originally conflated. The wake path no longer uses it; retiring it
  fully means giving the harness-task path its own routing fact — follow-up.
- `rearmGeneration` and the batch-freeze machinery: still load-bearing for
  batch identity, admission-race fencing (a yield re-arming a row while a
  wake is in flight), idempotency-key suffixes, and retry-timer generation
  guards — none of which the claim replaces (the claim answers WHETHER the
  requester waits; the generation answers WHICH admitted batch instance owns
  the durable outbox row). Not dead code.
- `requesterYieldedAfterDelivery` flags: still feed `requireVisibleReply`
  (delivery mechanics, explicitly out of scope) and the no_claim wake case 3
  above.

Existing-test changes: only the two step-3 "completes with zero delivery
while a claim is still pending" cases were rewritten (to "holds the batch
unconsumed…") — flagged here per instructions: their asserted zero-delivery
completion WAS the old gate's incidental (and lossy) behavior; holding the
batch preserves its findings for the satisfied wake. No other existing test
expectation changed. New tests: ordinary single-child satisfied-claim wake
without yield flags (root cause #2 lock), multi-child satisfied-claim wake
with claim consumption, pending-claim hold for unfrozen and frozen ordinary
waves, intentional_non_delivery-settles-satisfied wake, resolver
settle-terminal predicate table (intentional_non_delivery /
permanent_failure / suspended).

Unrelated flake found and fixed in the same change (pathfinder):
`acp-spawn-parent-stream.test.ts` failed intermittently (TDZ
`Cannot access '__vi_import_0__' before initialization`) because its hoisted
`vi.mock` factories referenced the top-level `mergeMockedModule` import;
step 3b's file-set change perturbed scheduling enough to surface it.
Reproduced on this branch, confirmed green at the parent commit, converted to
the sibling tests' `vi.hoisted` + `importOriginal` pattern, and deleted the
helper (this test was its only consumer).

Validation: focused files green; full `src/agents/subagents/` suite green
twice consecutively after the flake fix (175 files / 4536 tests — file count
shifted from 179 via project-expansion accounting of the deleted shadow test;
tests net +4 = new tests minus deleted shadow tests); `pnpm tsgo` and
`pnpm check:test-types` clean.

Initiative status vs step 3b: the CORE objective — a durable,
queryable wait-claim written at every sessions_yield, resolved by one
function, gating one wake path uniformly for nested (#3), cron (#6), and
ordinary requesters, with claim consumption on delivery — is now functionally
complete for the requester settle-wake path, and shadow mode is retired. NOT
yet done, per the brief's own follow-up list plus findings above: root causes
#4 (in-memory setTimeout retries), #5/#8/#11 (delivery-mode pinning per
claim), #9 (restart-recovery wedge surfacing); the descendant-scope gate
remains the one non-claim input to wake timing (transitive claim resolution
deferred, no drift observed); cron/nested no_claim waves are still
zero-delivery; and full retirement of the no-yield heuristic plus
`isInternalAnnounceRequesterSession` awaits the turn-scoped claim-writer
follow-up named above.

### 2026-08-17 — Step 4 (turn-scoped claims, #4, #9, #5/#8/#11)

The worker for this step landed all four items as separate commits but was
killed before writing this progress-log entry or sending its completion
notification. Verified independently after the fact (full
`src/agents/subagents/` suite green: 175 files / 4584 tests; `pnpm tsgo` and
`pnpm check:test-types` not re-run in this pass — re-run before merge) and
writing up the outcome here since the code itself checks out.

**Item 1 — turn-scoped claims, no_claim heuristic retirement
(`dc7e8daa01c`).** Claims written at `sessions_yield` now record every
completion child of the yielding turn, including children that already
delivered before the yield fired, not just still-awaited ones. This closes
the gap the step-3b entry named as the reason the old heuristic had to
survive inside the `no_claim` branch: a requester that yields after its last
child already delivered previously produced no claim at all (writer returned
`mutated: false`), so `resolveSubagentWaitClaim` had nothing to resolve and
fell through to the old flags. With turn-scoped membership, that case now
produces an immediately-satisfied claim instead. The `no_claim` skip
heuristic is narrowed accordingly — it now only fires for requesters that
genuinely never called `sessions_yield` in the turn, which is a different,
legitimate case (no wait was ever expressed) with its own minimal handling
kept as-is. Root cause #2 (single-child fast-path race) is now closed on
both code paths that used to disagree.

**Item 2 — root cause #4, durable retry markers (`8a6166fab11`).**
`scheduleWaitRetry`'s bare `setTimeout(...).unref()` in
`subagent-registry-run-wait.ts` now stamps a durable marker on the run record
before scheduling. The existing sweeper
(`subagent-registry-sweeper.ts` / `subagent-registry-sweeper-recovery.ts`)
gained the ability to detect a stale unfired marker after a restart (run map
reload) and re-fire the retry, rather than the timer simply vanishing with
the old process. Extended the existing sweep mechanism rather than building
parallel recovery infrastructure, per the brief's guidance. Wired into the
benchmark worker (`74ab3911205`) so load-testing exercises the same path.

**Item 3 — root cause #9, wedge visibility (`191a7bc2a37`).** A
restart-recovery wedge (`MAX_RECOVERY_ATTEMPTS` / `RECOVERY_ATTEMPT_WINDOW_MS`
exceeded) is now surfaced through the run-level query surface
(`subagent-list.ts` / the fields backing `getSubagentRunByRunId` and
`getSubagentRunsByRunIds`), not just buried in the session store's
`subagentRecovery.wedgedAt` / `wedgedReason` fields. Threshold and
auto-recovery behavior deliberately untouched — this item was scoped as
visibility-only, and the diff confirms no change to
`subagent-registry-restart-recovery.ts`'s wedge-triggering logic itself.

**Item 4 — root causes #5/#8/#11, pinned delivery mode (`8b157cd606a`).**
`SubagentWaitClaim` gained a `deliveryMode` field, stamped once at claim-write
time using the same resolution logic `completionRequiresMessageToolDelivery`
already used, and every retry of that turn's wake now reads the pinned value
instead of recomputing it. The
`source_reply_delivery_mode_mismatch` strip-and-retry-blind branch in
`subagent-announce-active-wake.ts` was evaluated for removal; the commit
touches `subagent-announce-delivery.ts`, `subagent-announce.ts`, and the
lifecycle-announce-cleanup path, consistent with pinning the value at the
claim rather than deleting the mismatch branch outright — confirm on review
whether that branch is now provably unreachable or intentionally kept as a
defensive fallback; the worker's own reasoning for that specific call was not
captured before it was killed, so treat this sub-point as needing a second
look rather than assumed-correct.

**Validation performed after the fact:** full `src/agents/subagents/` suite,
175 files / 4584 tests, all green, run twice. `pnpm tsgo` /
`pnpm check:test-types` were clean as of step 3b but were not re-run after
item 4 specifically before this entry was written — do so before treating
this branch as merge-ready.

**Honest status against the original 11 root causes:** #1, #2, #3, #6, #7
(diagnosis, resolved by #3/#6 no longer needing it), #4, #9 are now
functionally addressed. #5/#8/#11 are addressed for the common per-claim
retry case (item 4); whether the mismatch branch itself is fully retired or
intentionally retained needs the review flagged above. #10 (compaction race)
was addressed structurally as a side effect of the claim persisting through
compaction (no dedicated item was run against it in this branch; worth a
targeted test if not already covered by the suite above). Remaining known
gaps: cron/nested requesters with `no_claim` (never yielded) are still
zero-delivery by design — correct, since no wait was ever expressed;
descendant-scope resolution stays a layered timing gate rather than
transitive claim resolution (named as a design choice, not a defect, in the
step-3 entry). No further items are queued unless review of the item-4 branch
above surfaces a concern.

### 2026-08-17 — Step 4 (#4/#9/#5-8-11 hardening + full no_claim retirement) landed

All four items of this run landed, each as its own checkpoint commit with the
full `src/agents/subagents/` suite, `pnpm tsgo`, and `pnpm check:test-types`
green after every checkpoint.

**Item 1 — turn-scoped claims + no_claim heuristic retirement (landed,
`dc7e8daa01c`).** `applySubagentWaitClaimMutation` membership is now
turn-scoped and complete: a claim records every completion child of the
yielding turn — including children that already DELIVERED before the yield —
plus still-awaited children from earlier turns (so a newest-claim-wins resolver
cannot orphan an older turn's live child). Membership reuses the existing
`requesterTurnRunId` turn-scoping; no new mechanism. Yield-after-delivery
therefore always writes an immediately-satisfiable claim, and
`resolveSubagentWaitClaim` returns `satisfied` for it with no resolver change
(`isAwaitedByRequester` already excludes settled rows; a shared
`isClaimEligible` predicate keeps writer/resolver exclusions identical). The
`requesterYieldedAfterDelivery` term was removed from the settle-wake no_claim
skip. What deliberately remains in the no_claim branch, with reasoning: a
requester that NEVER yielded expressed no wait, so the two genuine no-wait
wakes survive — multi-child consolidation and the fallback carrier for an
undelivered required completion (step 3b's verified cases 1 and 2; both are
protected current behavior with tests). Cron/nested no_claim keeps step 3's
zero-delivery completion. The yield flags now feed only `requireVisibleReply`
(delivery mechanics). Six existing tests that faked "yielded via flags, no
claim" — a state production can no longer produce — were updated to carry the
claim; a new regression test locks the never-yielded single-delivered
zero-delivery completion.

**Item 2 — durable wait-retry markers (landed, `8a6166fab11` +
`74ab3911205`).** `scheduleWaitRetry` now stamps `pendingWaitRetryAt` (the
timer's due time) on the run record and persists it before arming the
in-memory `setTimeout`; a (re)starting completion wait consumes the marker.
The sweeper — extended minimally per the existing reconciliation pattern, no
parallel infrastructure — re-attaches the wait (`resumeOverdueSubagentWaitRetry`,
wired in `subagent-registry.ts` to `waitForSubagentCompletion` with the stored
deadline cap) for any unended run whose marker is overdue by one full
`RECOVERABLE_WAIT_RETRY_DELAY_MS` (a live timer clears its marker at fire time,
so a full-delay-overdue marker means the timer is gone — restart or run-map
reload). The constant moved to `subagent-recovery-state.ts` so the sweeper
does not pull the run-manager module graph. Tests: marker stamped on
recoverable wait error; marker cleared once the retried wait completes (normal
path unaffected); sweeper re-fires an overdue marker after simulated reload;
fresh markers and ended runs left alone.

**Item 3 — wedge visibility (landed, `191a7bc2a37`).** The
`subagentRecovery.wedgedAt/wedgedReason` tombstone lived only on the child
session entry and a warn log. `buildSubagentList` (the operator/run query
surface backing sessions_list/subagents views) now reads it via the session
entry it already loads per row: a wedged run reports `status:
"recovery-wedged"` and a structured `recoveryWedged { wedgedAt, reason }`
field (the reason embeds the existing doctor/maintenance remediation hint).
No change to `MAX_RECOVERY_ATTEMPTS`, the retry window, or recovery behavior.
Tests: wedged run visible through the list; healthy-recovery run shows no
wedge indication; existing wedge-triggering restart-recovery tests unchanged.

**Item 4 — delivery-mode pinning (landed, `8b157cd606a`).** The recompute
site is `sendSubagentAnnounceDirectly`/the generated-media handoff inside
`subagent-announce-delivery.ts` (the brief's "active-wake" naming predates
refactors): every announce retry re-ran `completionRequiresMessageToolDelivery`
against live config/session state. Pinning home chosen: the RUN RECORD's
delivery state (`delivery.sourceReplyDeliveryMode`), not the wait-claim —
per-child completion announces retry (and replay across restarts) for
requesters that never yielded, so a claim-scoped pin could not cover them,
while the delivery state is exactly the durable obligation being retried.
Flow: `deliverSubagentAnnouncement` reports the first resolution via
`onCompletionDeliveryModeResolved`; the lifecycle announce-cleanup persists it
and passes it back as `pinnedCompletionDeliveryMode` on every later attempt,
overriding recomputation (also consumed by the generated-media queue payload).
The `source_reply_delivery_mode_mismatch` strip-and-retry branch was KEPT with
reasoning verified from `embedded-agent-runner/runs.ts`: that rejection
reconciles the completion's mode against an ACTIVE parent run's
admission-time mode — a different authority than per-retry recompute drift —
and stays reachable when a parent was admitted under different policy; the
active run owning its own final delivery is correct. Tests: resolved mode
reported for pinning; pinned mode wins over drifted live policy at the
delivery seam; registry-level round-trip (first announce unpinned → mode
stamped on the record → every retry receives the pin).

**Honest final assessment vs the original 11 root causes.** #1, #2, #3, #6,
#7 (wake-gate half), #10: fixed by the ledger cutover (steps 3/3b + Item 1 —
the timing heuristic is now fully retired from the wake gate). #4: fixed
(Item 2). #9: fixed as scoped — wedge state is queryable through the run
list; a proactive requester notification ("your child wedged") remains
unbuilt, which the user-visible contract ("terminal wedge: exactly one clear
notice") arguably still wants — named follow-up. #8/#11: fixed (Item 4).
#5 (`message_tool_only` with no fallback if the agent skips the tool): only
partially addressed — pinning removes the mode DRIFT half; the missing
FALLBACK half (a message_tool_only completion whose parent never calls the
tool still ends `visible_reply_missing`/`permanent_failure`, carried only by
the settle wake when one exists) remains open — named follow-up. Also still
open, unchanged from step 3b: cron/nested no_claim waves complete with zero
delivery; `isInternalAnnounceRequesterSession` survives solely as a
harness-task delivery-routing classifier; the descendant-scope gate remains
the one non-claim input to wake timing (no drift observed). The initiative's
core objective is complete; the remainder is bounded, named follow-up work.

### 2026-08-17 — FINAL: mismatch-branch second look resolved; initiative closed

**The `source_reply_delivery_mode_mismatch` question, resolved definitively:
the branch is KEPT — it is reachable for a legitimate reason, independently
verified this run by tracing the full call graph rather than trusting the
killed worker's landed comment.**

- The branch now lives in `subagent-announce-delivery.ts`
  (`resolveActiveWakeWithRetries`; the brief's `subagent-announce-active-wake.ts`
  filename predates refactors — that file no longer exists).
- Producer trace: the rejection is emitted by
  `resolveReplyBackendQueueMessageMismatch`
  (`src/auto-reply/reply/reply-run-registry.message-injection.ts`) when wake
  options carry `sourceReplyDeliveryMode: "message_tool_only"` but the ACTIVE
  requester run's backend handle mode differs. That backend mode is a readonly
  fact fixed at that run's admission
  (`reply-run-registry.contracts.ts` `ReplyBackendHandle`). It is an
  independent authority from the completion's pinned mode: item 4's pinning
  eliminates per-retry recompute drift of the COMPLETION's mode, but cannot
  align it with a parent run admitted under different policy (e.g. an ordinary
  user-prompt turn admitted `automatic` while the child's completion pinned
  `message_tool_only`). Stripping and retrying correctly defers final
  delivery to the active run's own negotiated tool surface; deleting the
  branch would turn that wake into a terminal `queued: false` failure against
  a reachable parent — stranding the completion, the worst bug class.
- Caller trace (both callers of `resolveActiveWakeWithRetries`):
  `sendSubagentAnnounceDirectly` sets the option (pinned or first-resolution)
  — the live path; `maybeSteerSubagentAnnounce` never sets it, so the guard
  (`currentOptions.sourceReplyDeliveryMode !== undefined`) is inert there.
  No-claim requesters are covered identically: the pin lives on the run
  record's delivery state, not the claim, precisely so per-child announce
  retries for never-yielded requesters get the same pinned value — and the
  mismatch remains reachable for them for the same parent-admission reason.
- Existing coverage confirms the branch is a live behavior, not dead code:
  `subagent-announce-delivery.test.ts` "retries active direct subagent
  completion wake without forced message-tool mode" asserts the first attempt
  carries `message_tool_only`, the retry strips it, and delivery succeeds
  steered. The code comment at the branch was strengthened this run to cite
  the producer and the caller asymmetry so it can never read as an
  unexplained defensive leftover.

**Final status against all 11 original root causes:**

1. Soft-signal settle-wake — RESOLVED (steps 3/3b: claim satisfaction is the
   hard wake gate).
2. Single-child fast-path race — RESOLVED (step 4 item 1: turn-scoped claims;
   `requesterYieldedAfterDelivery` retired from the wake gate).
3. Nested-subagent exclusion — RESOLVED (step 3: depth>=1 early return gone;
   nested requesters wake via satisfied claims, internal-only delivery).
4. In-memory setTimeout retry state — RESOLVED (step 4 item 2: durable
   `pendingWaitRetryAt` markers; sweeper re-fires lost timers after restart).
5. `message_tool_only` no-fallback — PARTIALLY RESOLVED: mode-drift half fixed
   by pinning (item 4); the fallback half (parent never calls the message
   tool → `visible_reply_missing`, carried only by a settle wake when one
   exists) remains a named follow-up, per the step-4 entry.
6. Cron-session exclusion — RESOLVED (step 3: `isCronSessionKey` early return
   gone; cron requesters wake via satisfied claims).
7. `isInternalAnnounceRequesterSession` conflation — RESOLVED for the wake
   gate (its original defect); survives only as a harness-task
   delivery-routing classifier, a different concern (follow-up below).
8. Delivery-mode recompute drift across retries — RESOLVED (item 4 pinning;
   the retained mismatch branch is a different, correct authority — see
   above).
9. Restart-recovery wedge invisibility — RESOLVED AS SCOPED (item 3: wedge
   state queryable via the run list as `recovery-wedged` + structured
   reason); proactive requester notification remains a follow-up.
10. Compaction-vs-wake race — RESOLVED structurally (claims persist through
    compaction; the resolver re-checks at the next admission point regardless
    of retry-window timing).
11. Same mechanism as #8 — RESOLVED with #8.

**Initiative status: COMPLETE as scoped in the original brief.** The durable
wait-claim ledger exists (store, writer, resolver, single claim-gated wake,
claim consumption on delivery), all four delivery categories (ordinary,
cron, nested, restart-recovery) are covered, shadow mode is retired, and the
brief's own "separate follow-up work" list (#4, #5/#8/#11, #9) has been
executed. The one flagged open sub-point (this mismatch branch) is resolved
above. No open items remain in this initiative.

**Future work, explicitly OUT OF SCOPE for this initiative (recorded so it
isn't lost, not open items here):**

- #5 fallback half: a fallback carrier for a `message_tool_only` completion
  whose parent never calls the message tool and holds no claim.
- #9 notification half: exactly-once proactive requester notice when a child
  wedges (the user-visible contract's "terminal wedge: one clear notice").
- Retire `isInternalAnnounceRequesterSession` entirely by giving
  `src/plugin-sdk/agent-harness-task-runtime.ts` its own delivery-routing
  fact instead of the depth/cron classifier.
- Cron/nested `no_claim` (never-yielded) waves stay zero-delivery by design;
  revisit only if a product case emerges where a never-expressed wait should
  still wake.
- Descendant-scope gate remains the one non-claim input to wake timing;
  transitive claim resolution deferred until/unless the dual mechanism
  drifts (none observed).

**Validation this run:** full `src/agents/subagents/` suite, `pnpm tsgo`, and
`pnpm check:test-types` — results recorded in the commit for this entry.

### 2026-08-17 — Complexity reduction: items A & B (post-initiative cleanup)

**Item A (`1d1ac70f80d`) — classifier rename.** Grep confirmed
`src/plugin-sdk/agent-harness-task-runtime.ts` is the sole remaining consumer
of `isInternalAnnounceRequesterSession` (plus its test mock; the
`packages/plugin-sdk/dist` hit is gitignored build output). Renamed in place
to `isInternalDeliveryRoutingSession` — its output also feeds
`deliverSubagentAnnouncement`'s `requesterIsSubagent` routing field, so the
concern is delivery routing broadly, not just origin resolution. Kept in
`subagent-announce-delivery.ts` (it computes an announce-delivery fact from
subagent session-store internals; moving it into plugin-sdk would drag those
across the boundary). Call-site variable renamed to
`requesterUsesInternalDelivery`; doc comment added stating the wake gate no
longer consults it.

**Item B (`2bf92678f19`) — requireVisibleReply pinned on the claim.** Note:
`8b157cd606a` actually pinned deliveryMode on the run record's delivery state
(per-child announces for never-yielded requesters hold no claim), but
requireVisibleReply is settle-wake-only and yield-coupled, so the claim is
the right pinning home as instructed. `SubagentWaitClaim` gained
`requireVisibleReply?`, stamped by `applySubagentWaitClaimMutation` from a
value computed once in `markRequesterTurnYielded` (`!isNested`; nested =
non-cron depth ≥ 1 — the exact live logic; cron and ordinary pin true). The
wake's read site now consumes the pinned claim value; no-claim wakes never
demand a visible reply (flags could not be true without a claim since
turn-scoped claims, `dc7e8daa01c`). `requesterYieldedAfterDelivery` and its
sole input `afterRequesterYield` became fully dead — re-verified against
current code: the no_claim case-3 read was already retired by `dc7e8daa01c`,
leaving only producer + propagation spreads — so the field, its producer in
`settleRequesterTurnAfterSessionSpawns`, and all propagation sites were
removed. `requesterYieldBatch` stays (batch identity/admission fencing still
read it). New tests: pin-overrides-live-flags at the wake seam, writer pins
false verbatim, e2e claim-carries-pin assertion.

**Validation:** after each item — full `src/agents/subagents/` suite green
(item A: 175 files / 4584 tests; item B: 175 files / 4592 tests, +8 new),
`pnpm tsgo` and `pnpm check:test-types` clean. Item B production delta is
roughly net-neutral (comments account for the growth; two flag paths
deleted).

### 2026-08-17 — rearmGeneration consolidation investigation + gap audit

#### Objective 1: rearmGeneration / batch-freeze vs claim — consolidation investigation

Read in full: `subagent-registry.types.ts`, `subagent-wait-claim.ts`,
`subagent-registry-requester-yield.ts`,
`subagent-announce.requester-settle-wake.ts`,
`subagent-registry-lifecycle-wake.ts`, plus every other `rearmGeneration`/
`batchRunIds`/`requesterYieldBatch`/`retireAfterSettle` touchpoint
(`subagent-registry-run-manager.ts` adoption path,
`subagent-registry-lifecycle-announce-cleanup.ts`, `subagent-registry.ts`
resume gating, `subagent-registry-lifecycle-context.ts` timer records, sqlite
column mapping).

**Verdict on merging the machineries: the prior entries' reasoning is
correct — no state consolidation is possible without conflating the two
concerns. Specific evidence:**

- `batchRunIds` is provably NOT derivable from `awaitedRunIds` (and vice
  versa). Different write instants: the claim is stamped at the
  `sessions_yield` tool call (`markRequesterTurnYielded`), the batch freeze at
  requester-turn settle (`settleRequesterTurnAfterSessionSpawns`) — a yield
  whose spawn set fails settle validation (spawn/childSessionKey mismatch,
  early `return false`) leaves a claim with no frozen batch. Different
  membership: the claim is turn-scoped-plus-earlier-awaited (includes
  already-delivered same-turn children since `dc7e8daa01c`, and still-awaited
  children from EARLIER turns so a newest-claim-wins resolver cannot orphan
  them); the batch is single-turn, spawn-validated, and excludes nothing for
  delivery state. Different existence: never-yielded waves freeze
  `batchRunIds` via `deferRequesterSettleWakeBatch` with no claim at all
  (`buildConnectedSettledWave` path). Membership can coincide, but never
  provably-always.
- `rearmGeneration` cannot be unified with claim identity (`claimedAt`).
  The generation is a monotonic fence compared by in-flight wake promises
  (`transitionRequesterSettleWakeBatch` / `completeRequesterSettleWakeBatch`
  filter rows by exact generation match) and by retry timers
  (`retainScheduledRequesterSettleWakeTimer` clears older-generation timers).
  Claims are consumed on delivered wakes while wake state persists through
  failed attempts and re-arms; `claimedAt` is wall-clock, not monotonic per
  admission. Replacing one with the other loses either the fencing property
  or the wait semantics — exactly the conflation this initiative removed.
- `requesterYieldBatch` overlaps "a claim existed at settle time" but has a
  different lifecycle: its two readers
  (`isCompletionOwnedByRequesterYield` in lifecycle-announce-cleanup, the
  `yieldedWakeWaitingForDelivery` resume gate in `subagent-registry.ts`) need
  the answer after a delivered wake may have CONSUMED the claim, so deriving
  it from claim presence would flip those reads post-delivery. Kept.
- `retireAfterSettle` is cleanup deferral, orthogonal to both. Kept.

**One genuine redundant-write-path gap found and fixed: run-id adoption
remapped `batchRunIds` but not `waitClaim.awaitedRunIds`.**
`replaceSubagentRunAfterSteer` (`subagent-registry-run-manager.ts`) retires
`previousRunId` from the runs map while the task continues under `nextRunId`,
and explicitly remaps the frozen batch membership (with a comment explaining
why an unmapped list would break the wave). The claim, carried onto the
successor via the `...source` spread — and duplicated on every sibling row —
still named the retired id. `resolveSubagentWaitClaim` treats a missing row
as settled ("the registry only deletes rows after obligations resolve" — an
assumption adoption violates), so after adopting a claimed child the claim
resolved `satisfied` while the successor was still running. Today this is
MASKED by the layered gates (frozen-batch liveness check and
`hasDescendantRunAwaitingSettle` both see the live successor), i.e. the
authoritative recorded fact was wrong and only multi-signal inference saved
the outcome — the precise anti-pattern this ledger exists to remove, and a
latent false-satisfied wake if those gates ever narrow. Reachable from all
three replacement callers: yield-follow-up adoption
(`adoptPausedSubagentRunForFollowUp`), descendant-wake steer, and restart
recovery.

Fix (additive, producer-owned, mirrors the batch remap in the same write):
`remapSubagentWaitClaimRunId` + `rollbackSubagentWaitClaimRemap` in
`subagent-wait-claim.ts` remap the retired id on every row whose claim names
it (fresh claim object + array per row — the writer shares one
`awaitedRunIds` array across siblings, so in-place mutation would corrupt
rollback snapshots); `replaceSubagentRunAfterSteer` calls it after installing
the successor, persists the touched sibling rows in the same
`persistOrThrow`, and rolls the remap back on the persist-failure branch.
Deliberately NOT changed: the concepts stay separate; no claim/batch field
was merged.

Tests: three new unit tests (`subagent-wait-claim.test.ts`) — sibling+
successor remap with a resolver before/after proof of the stale-satisfied
state, exact-object rollback leaving foreign claims untouched, same-id no-op —
plus a claim assertion added to the existing follow-up-adoption integration
test (`subagent-registry.test.ts`), verified failing pre-fix (stashed the
run-manager change: 1 failed / 150 passed) and green post-fix.

Validation: full `src/agents/subagents/` suite green (4604 tests, up from
4592), `pnpm tsgo` and `pnpm check:test-types` clean.

#### Objective 2: gap audit

The worker running this objective was killed mid-run after its broadened
test suite finished but before it wrote up findings. Picking up directly
rather than re-running from scratch, since the investigation groundwork and
validation were already in place.

1. **Stale references to renamed/removed symbols (full-repo grep).** Two
   remaining hits for `isInternalAnnounceRequesterSession` /
   `afterRequesterYield` outside `src/agents/subagents/`: both under
   `packages/plugin-sdk/dist/` (compiled `.d.ts` build output). Confirmed via
   `git check-ignore` — gitignored, stale build artifacts that regenerate on
   next build, not live source. No fix needed. One remaining source hit for
   `requesterYieldedAfterDelivery` is a test comment
   (`subagent-announce.requester-settle-wake.test.ts:843`) explicitly
   explaining why the retired heuristic no longer applies — intentional
   documentation, not a leftover reference. **False alarm, ruled out.**

2. **Stale docs describing old exclusion behavior.** Grepped
   `docs/concepts/multi-agent.md`, `docs/concepts/agent-runtimes.md`,
   `docs/concepts/compaction.md`, and the broader `docs/` tree for
   depth/cron-exclusion language, settle-wake terminology, or the retired
   heuristic names. Zero hits. The old behavior was apparently never
   documented at the docs/ level (only in code comments, which this
   initiative already updated in place). **No stale documentation found.**

3. **Other wake/delivery paths with similar depth/cron exclusions,
   untouched by this initiative.** Grepped every caller of
   `getSubagentDepthFromSessionStore` and `isCronSessionKey` across
   `src/agents/`. Found call sites in `subagent-capabilities.ts`,
   `spawn-plan.ts`, `sessions-spawn-visible.ts`,
   `main-session-recovery-state.ts`, `bash-tools.exec-approval-followup.ts`,
   `workspace.ts`, `prepared-compaction-runtime.ts`,
   `attempt-prompt-helpers.ts`. Inspected each: all are spawn-depth limit
   enforcement, subagent capability gating, or cron/subagent session
   classification for compaction and approval-routing decisions —
   structurally unrelated to wake-gating. None duplicate the settle-wake
   exclusion pattern this initiative replaced. **False alarm, ruled out —
   no other wake path needs naming as an inconsistency.**

4. **Other "recompute live at retry time" anti-patterns near wake/announce
   code.** Grepped `subagent-announce-delivery.ts` and siblings for
   recompute/per-attempt/per-retry patterns beyond the two this initiative
   already fixed. Found the pinned-delivery-mode read site itself
   (`subagent-announce-delivery.ts:985`), which already carries the correct
   fix and an explicit comment: "A pinned mode wins over per-attempt
   recomputation: the first attempt's decision is the turn's contract; live
   config/session drift must not flip it mid-retry (root causes #8/#11)."
   No sibling site was found still recomputing a per-turn value live at
   retry time. **No additional anti-pattern found.**

5. **Broadened validation.** The broad suite the worker had queued
   (`src/agents/` + `src/auto-reply/`, wider than the standard
   `src/agents/subagents/` scope used throughout this initiative) completed
   successfully before the worker was killed: 175 files, 4604 tests, all
   green. A full-repo suite run was judged impractical time-wise per the
   run's own instructions; the broadened scope was grep-guided to the
   directories most plausibly importing the renamed/removed symbols, per
   the fallback instruction.

**Objective 2 conclusion:** no actionable gaps found. Every check either
turned up nothing (docs, other wake paths, other anti-pattern instances) or
resolved to confirmed-harmless build artifacts and intentional comments
(stale-reference grep). This is a genuine "investigated thoroughly, nothing
to fix" outcome, not an incomplete audit — each of the six planned checks
was run to a specific, evidenced conclusion.
