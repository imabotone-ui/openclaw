# Task: Root-cause and fix TUI "stuck running" display bug in wait-claim-ledger branch

## Context

Branch: wait-claim-ledger (this repo, already checked out, current HEAD a4ac7e79a1f)
This branch was rebased onto upstream/main this morning (2026-08-19). It also carries a WIP
commit "wip: session projection duplication investigation" at HEAD, fixing a duplicate-message
rendering bug in packages/gateway-client/src/session-projection.ts (reconcileSessionProjectionSnapshot

- multi-match runs weren't being recognized as already-displayed, causing whole runs to be
  re-inserted/replayed). That fix appears to have resolved the duplication symptom as of this
  morning (unconfirmed long-term, no test written for it yet - also worth finishing/hardening if
  you have spare capacity, see "Bonus" section below).

## Bug being reported (separate symptom, this is your primary task)

In the OpenClaw TUI (terminal UI client), after sending a message: the "running"/streaming
indicator shows activity (spinner, elapsed time counting up) but the assistant's response text
never appears on screen, even after the response has actually completed server-side. The user
has to Ctrl-C out of the TUI entirely and re-launch/re-enter it to see the response that was
already generated and is sitting in the session transcript. This has been observed multiple
times this morning (2026-08-19), immediately after this morning's rebase + rebuild deployment.

## Your task

1. Determine whether this is NEW (introduced by this morning's rebase onto upstream/main, or by
   the session-projection.ts WIP fix committed this morning) or PRE-EXISTING (already present
   before yesterday's wait-claim-ledger deploy). Check git blame / bisect candidate commits in
   the TUI streaming/rendering path if helpful.
2. Investigate the TUI's streaming/reconnect and message-rendering path - likely candidates:
   - The TUI client code (search for where the terminal renders streaming/live entries -
     possibly src/tui/ or similar, and packages/gateway-client since that's where
     session-projection.ts / reconcileSessionProjectionSnapshot lives - the SAME reconciliation
     logic touched by this morning's WIP fix might be implicated, given both symptoms appeared
     together this morning).
   - Whether "live"/"pending" entries (see the reconcileSessionProjectionSnapshot code touched
     this morning) ever fail to transition to their final/persisted state in a way that leaves
     the UI showing a stale "still running" view instead of the completed message.
   - Whether the fix to reconcileSessionProjectionSnapshot this morning (the multi-match
     same-content skip logic) could have an unintended side effect: if a "live"/streaming entry
     gets incorrectly matched and skipped/suppressed thinking it's a duplicate of something
     already shown, it might never get displayed at all, and the UI would just sit spinning.
     This is a plausible causal link between this morning's fix and this new symptom worth
     ruling in or out explicitly.
3. Write a minimal, reliable repro test demonstrating the stuck-running/missing-render behavior
   before fixing it, following existing patterns in this codebase for TUI/streaming tests.
4. Root-cause it, fix it minimally, and confirm the repro test passes plus the FULL existing
   test suite still passes. Baseline before your work: check current test count/status first
   (may have changed since the 175 files/4604 tests baseline mentioned in earlier docs, given
   this morning's rebase onto upstream/main likely added/changed tests).
5. Commit your work with clear commit messages, following this branch's existing commit style.
   Push to origin/wait-claim-ledger.
6. Write a dated progress entry summarizing what you found, why it happens, what you changed,
   and how you validated it.
7. IMPORTANT: verify your own work by checking git log + test output directly before finishing,
   rather than self-reporting completion - commit+push must happen before you're done, not as
   a last "nice to have" step that might get cut off if your process is killed early.

## Bonus (only if you have spare time/capacity after the primary task above)

The session-projection.ts WIP fix from this morning (top commit, currently untested) could use:

- A proper repro test demonstrating the original duplicate-block-replay bug and confirming the
  fix resolves it
- A cleaned-up, non-"wip" commit message
- Confirmation the full test suite still passes with it in place
  Do NOT let this bonus work block or delay the primary TUI bug task above.

## Constraints

- Do not touch anything outside this repo (no gateway restarts, no config changes - pure source
  investigation/fix on the fork branch, validated via the test suite, not against the live
  running gateway).
- Do not revert or undo the session-projection.ts WIP fix or any of the wait-claim-ledger work
  unless you have clear evidence it's the direct cause and you're replacing it with something
  better - document your reasoning clearly if you touch that file.
- If stuck or the root cause isn't clear after reasonable investigation, document your best
  hypothesis and what you ruled out, rather than guessing at a fix that might mask the symptom.
