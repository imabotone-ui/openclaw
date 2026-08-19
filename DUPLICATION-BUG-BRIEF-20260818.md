# Task: Root-cause and fix duplicate message delivery in wait-claim-ledger branch

## Context

Branch: wait-claim-ledger (this repo, already checked out, HEAD d084b7ee4b0)
This branch closed 11 root causes of subagent/requester completion-wake failures via a
durable wait-claim ledger (see BRIEF-wait-claim-ledger.md and the "wait-claim ledger" progress
doc commits in git log for full background). It was deployed to a live local gateway today
(2026-08-18) replacing the published npm openclaw@2026.7.1-2.

## Bug being reported

Since deployment, the live gateway is exhibiting DUPLICATE MESSAGE DELIVERY on a webchat
session (agent:ima:tui-40885a12-ba0f-4be7-a01c-55c5f534eb82). Confirmed via sessions_history:
the underlying transcript has exactly N unique assistant messages, but the actual delivered
output to the user showed several of those same messages repeated - in one observed case,
messages #1, #3, and #4 of a 4-message run were each delivered TWICE, replayed as a block
right after message #4, in original order, with message #2 skipped. This is REPLAY of prior
completed turns, not model regeneration (confirmed: no duplicate assistant messages exist in
the actual stored transcript - the store has one canonical copy of each).

Observed characteristics:

- Occurred multiple times across a single evening session, correlated with gateway restarts
  in most (but possibly not all) observed instances - at least one occurrence appeared without
  an obvious restart in between, though this is less certain and could have been an invisible/
  fast restart.
- User is on webchat channel, "direct" chat type.
- The bug reproduces reliably enough that James (the user) confirmed it recurred multiple
  times independently over ~1 hour of use tonight.

## Your task

1. Do NOT trust that this is one of the 11 previously-closed root causes recurring - assume
   it's either a NEW regression introduced by this branch's changes, or a 12th root cause not
   previously identified. Investigate from first principles.
2. Focus your investigation on the completion-delivery / retry-marker / delivery-mode-pinning
   code paths this branch touched, per the commit log (particularly):
   - Turn-scoped wait claims (dc7e8daa01c)
   - Persisted completion-wait retry markers + sweeper re-fires (8a6166fab11,
     74ab3911205)
   - Delivery mode pinned per-turn, no per-retry recomputation (8b157cd606a)
   - Restart-recovery wedge state surfacing (191a7bc2a37)
   - Ordinary (ordinary/non-cron/non-nested) requester cutover (0b5a2d77cf1 era)
   - rearmGeneration/batchRunIds vs wait-claim distinction and the run-id adoption remap fix
     (953e39b0c35)
3. Hypothesis to test first (not confirmed, just a lead): a retry marker or delivery-mode
   pin might not be getting cleared/consumed after a turn is successfully delivered, causing
   a sweeper or restart-recovery path to re-fire delivery for turns that were already sent.
   The "skip one message, replay the rest as a block" pattern suggests something is re-walking
   a RANGE of prior turns rather than just the single most-recent one, possibly using stale
   sequence/range bounds.
4. Write a minimal, reliable repro test (integration-level, using the existing test harness/
   mocks in this codebase - look at how other subagent/requester wake tests are structured)
   that demonstrates the duplicate delivery before you fix it.
5. Root-cause it, fix it minimally, and confirm the repro test passes plus the FULL existing
   test suite still passes (this branch's baseline was 175 test files / 4604 tests passing,
   pnpm tsgo and pnpm check:test-types clean - do not regress this).
6. Commit your work with clear commit messages, following this branch's existing commit style
   (see git log for tone/format). Push to origin/wait-claim-ledger.
7. Write a dated progress entry (following the style of the existing "docs: record wait-claim
   ledger step N" commits in git log) summarizing: what you found, why it happens, what you
   changed, and how you validated it.
8. IMPORTANT: before you finish, verify your own work by checking git log + test output
   directly rather than just self-reporting completion - a known failure mode in this project
   is background workers getting killed by their own tool-runtime before writing a final
   progress-log entry or completion notification. Make sure your commit+push happens BEFORE
   you consider yourself done, not as a final "nice to have" step that might get cut off.

## Constraints

- Do not touch anything outside this repo (no gateway restarts, no config changes - this is
  pure source investigation/fix on the fork branch, validated via the test suite, not against
  the live running gateway).
- Do not revert or undo any of the 11 previously-fixed root causes - if your fix requires
  touching code from an earlier step, be surgical and explain why in your commit message.
- If you get stuck or the root cause isn't clear after reasonable investigation, document your
  best hypothesis and what you ruled out, rather than guessing at a fix that might mask the
  symptom without addressing the cause.
