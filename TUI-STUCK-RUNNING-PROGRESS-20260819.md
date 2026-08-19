# TUI "stuck running" — root cause, fix, validation (2026-08-19)

Brief: `TUI-STUCK-RUNNING-BRIEF-20260819.md`.

## Symptom

After sending a message in the TUI, the assistant block keeps its streaming
presentation (spinner, elapsed timer) forever. The reply never appears, even
though the run completed server-side and the message is in the transcript.
Ctrl-C and re-entering the TUI shows the reply, because the fresh session load
rebuilds the transcript from the server.

## Is it new?

**Pre-existing, not caused by this morning's work.** Two candidates were ruled
out explicitly:

- **The session-projection WIP fix (`a4ac7e79a1f`) is not the cause.** Its
  multi-match same-content skip only ever _drops a local live entry that the
  snapshot already represents_; it cannot suppress a snapshot entry, and it does
  not touch run status, activity state, or the chat log. The reported symptom is
  a chat-log/run-lifecycle failure, not a projection-entry failure.
- **The rebase onto upstream/main is not the cause.** The defective condition
  dates to upstream `a62abee4271` ("fix(tui): prevent cross-session leaks and
  lost streamed replies", 2026-07-27) and was unchanged by the rebase. The
  rebase is a plausible _trigger_ only in the sense that it changed run/reload
  timing; the latent race was already there.

## Root cause

`src/tui/tui-session-run-coordinator.ts`. A chat event that arrives while a
history reload is in flight for its run is parked on the reload record
(`deferHistoryRunEvent`) and replayed when the reload finishes. `finishReload`
decided whether to replay by _inferring_ coverage from reload ownership:

```ts
if (deferred && (!result.loaded || historyOwned || restoredInFlight)) {
  this.context.replayHistoryRunEvent(deferred);
}
```

A loaded history plus a run the reload did not own was treated as "history
already displays this run", so the deferred event was discarded.

That inference is wrong for exactly the run that matters. `handleSessionsChangedEvent`
reloads with `queueHistoryReload(reloadingRunIds, finalizedRunIds, ...)`, where
`reloadingRunIds` includes the _still-running_ turn but `finalizedRunIds` cannot
— it has not finalized yet. So the active run is queued **unowned**, and that
reload reads history _before_ the reply persists. History therefore renders no
reply for the run, nothing finalizes it, and the only remaining carrier of the
reply — its deferred `final` — is thrown away.

Nothing calls `chatLog.finalizeAssistant`, so `run.streaming` in
`src/tui/components/chat-log.ts` is never retired and the block stays in its
streaming presentation indefinitely. That is the spinner the user sees.

This is the doctrine-class failure: an action ends with no visible outcome and
no recorded reason, and the decision was made by inferring a fact from indirect
signals rather than reading a recorded one.

## Fix

Record the fact at its producer instead of inferring it downstream.

- `src/tui/tui-session-actions.ts` — the history rebuild now collects the
  assistant run IDs it actually rendered and returns them.
- `src/tui/tui-types.ts` — `TuiHistoryLoadResult`'s `loaded: true` variant
  carries `displayedAssistantRunIds`.
- `src/tui/tui-session-run-coordinator.ts` — replay a deferred event unless that
  record names its run:

```ts
if (deferred && !(result.loaded && result.displayedAssistantRunIds.includes(runId))) {
```

The new condition **subsumes** the previous three-flag proxy rather than adding
to it: an unloaded history, a history-owned run, and a run history restored as
still in flight each fail the "already displayed" test on their own. Where the
run ID is absent from a transcript row the check fails open toward showing the
reply, which is the safe direction — the duplicate-suppression path in
`tui-event-handlers.ts` (`finalizedRuns` + `hasSessionProjectionAcceptedFinal`)
still guards the replay.

## Opportunistic fixes in the same change (Pathfinder)

- **`packages/gateway-client/src/session-projection.ts` contained three raw NUL
  bytes**, embedded by the WIP commit as literal separators inside template
  strings. They made the file _binary_ to `grep`/`rg` — every content search over
  it silently returned nothing. Replaced with `\0` escapes; byte-for-byte
  identical runtime behavior, file is greppable again.
- **The WIP commit pushed that file over the `max-lines` limit** (740 > 700), so
  the branch was failing lint. Per repo policy the file was split rather than
  suppressed: the pure per-message readers moved to a new
  `packages/gateway-client/src/session-message-facts.ts` (identity, sequence,
  run-ID normalization, comparable/displayable content, final-message identity),
  leaving `session-projection.ts` at 643 lines. Public API is unchanged —
  `session-projection.ts` re-exports every previously exported symbol.

## Validation

- **Regression coverage fails on pre-fix code for the intended reason.**
  Reverting only the coordinator condition:
  `AssertionError: expected "vi.fn()" to be called with arguments: [ 'the answer', 'run-A' ]`.
- New tests:
  - `tui-event-handlers.test.ts` — reply whose final arrived during an unowned
    reload is rendered and the run clears.
  - `tui-event-handlers.test.ts` — deferred final the reload _did_ display is
    still dropped (no duplicate).
  - `tui-session-actions.test.ts` — the rebuild reports the runs it displayed.
- `src/tui` + `packages/gateway-client`: 65 files / 1450 tests green
  (baseline before this work: 65 files / 1447 tests).
- Post-split, including the web Control UI consumer of the same projection:
  **207 files / 4300 tests passed, 3 files / 95 tests skipped**.
- `npx tsgo --noEmit -p tsconfig.json` clean for `src/tui` and
  `packages/gateway-client`. The remaining `scripts/*.mjs` TS7016 errors are
  pre-existing and reproduce identically on a stashed clean tree.
- `node scripts/run-oxlint.mjs src/tui` and `... packages/gateway-client` both
  exit 0.

## Production LOC

`tui-session-actions.ts` +4, `tui-session-run-coordinator.ts` +4 (3 comment),
`tui-types.ts` +3 (3 comment) — roughly +5 real lines, spent on the recorded
fact that replaces the wrong inference. `session-projection.ts` net 0 for the
NUL fix; the split moves lines without adding behavior.

## Not addressed

The `queueHistoryReload(reloadingRunIds, finalizedRunIds, ...)` call site still
queues a running turn into a reload it cannot own. That is now harmless — the
deferred event survives it — but the underlying asymmetry (a reload whose run
set is wider than its ownership set) is worth revisiting if more reload-ordering
bugs surface.
