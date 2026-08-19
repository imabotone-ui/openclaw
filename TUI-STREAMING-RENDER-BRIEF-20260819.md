# Task: Root-cause and fix missing live-streaming render in TUI

## Context

Branch: wait-claim-ledger (this repo, already checked out, current HEAD 284bb273055 - check
git log first in case it moved further).
This branch was rebased onto upstream/main this morning (2026-08-19), then had three fixes land
today from concurrent background workers: (1) a duplication-rendering fix + test in
packages/gateway-client/src/session-projection.ts, (2) a TUI "stuck running forever" fix in
src/tui/tui-session-run-coordinator.ts (the run's FINAL reply was being dropped during a
history-reload race, requiring a TUI restart to see it - now fixed and validated), and (3) a
security + prompt-contract fix in the runtime-context carrier
(src/agents/embedded-agent-runner/run/runtime-context-prompt.ts,
src/auto-reply/reply/inbound-meta.ts). All three are already committed, tested, and deployed to
the live gateway as of this morning. See git log for full commit history and the docs/progress
entries each worker wrote (search for "TUI stuck-running", "Matrix runtime-context",
"session-projection duplication" in git log commit messages/bodies).

## Bug being reported (NEW, separate from all three fixes above)

James (workspace owner) confirms the "stuck running forever" bug IS fixed - he now sees the
assistant's response once it fully completes, no longer needs to Ctrl-C + restart the TUI to
see it. HOWEVER, he reports a distinct, still-present problem: while the assistant is actively
generating/streaming a response, he sees NO incremental/live text appear on screen at all - the
TUI shows nothing (or just a status indicator) until the response is fully complete, then the
ENTIRE completed block appears at once. He expects to see live, progressive/incremental text as
it's generated (like most modern chat/terminal UIs), not a single "flush at the end."

## Initial triage findings (from this session, not fully verified - your job to confirm/refute)

1. Confirmed streaming IS enabled/active at the protocol level: delta events do fire, and
   src/tui/tui-event-handlers.ts around line 273-283 shows, on evt.state === "delta":
   - setActivityStatus("streaming")
   - armStreamingWatchdog(evt.runId) (if this is the active run)
   - const displayText = streamAssembler.ingestDelta(evt.runId, evt.message, state.showThinking);
   - if (displayText) chatLog.updateAssistant(displayText, evt.runId);
     So the internal text buffer for the chat log DOES appear to get updated live, on every delta
     with real content.
2. STRONG LEAD, not yet confirmed: after the delta branch, execution falls through to a later
   line (this file has "tui.requestRender()" calls at multiple line numbers - 376, 467, 500, 526,
   593, 635, 729 - all WITHOUT the force=true argument) rather than an explicit forced render
   immediately after the delta's chatLog.updateAssistant() call. Compare to the "final" event
   branch, which explicitly calls "tui.requestRender(true)" (forced) in several of its own
   sub-branches (lines 233, 293, 303, 313, 703 with a forceRender variable).
   HYPOTHESIS: if tui.requestRender() WITHOUT force gets throttled, debounced, coalesced, or
   skipped under some condition (a common TUI optimization to avoid repainting on every token),
   that would exactly explain the observed symptom: the text buffer updates continuously but the
   terminal screen never actually repaints until the forced final render fires, so the user sees
   nothing until the very end, then the whole completed response appears at once.
3. This has NOT been verified - you need to actually read what requestRender() (unforced) does
   differently from requestRender(true), trace the render-trigger path fully, and confirm or
   refute this hypothesis before proposing a fix.

## Your task

1. Confirm or refute the render-throttling hypothesis above. If refuted, find the ACTUAL reason
   live delta text isn't reaching the screen (could be elsewhere: streamAssembler.ingestDelta
   logic, showThinking gating, terminal buffer flush timing, a PTY-level buffering issue, etc.)
2. Determine whether this is a NEW regression (introduced by today's rebase or by any of the
   three fixes that landed today - especially check whether the TUI stuck-running fix
   (df1d9a8312d) inadvertently affected render timing/triggering for the delta path while fixing
   the final-event-drop issue) or a PRE-EXISTING behavior that was never actually working as a
   "live streaming" experience, if streaming display was ever fully implemented/enabled for the
   TUI specifically (as opposed to just the underlying event/data plumbing existing).
3. Write a minimal, reliable repro test demonstrating the missing live-render behavior (simulate
   a run emitting several delta events followed by a final event, assert that the render/screen-
   state actually reflects intermediate delta content BEFORE the final event fires - not just
   that the internal buffer holds the right text).
4. Root-cause it, fix it minimally, and confirm the repro test passes plus the FULL existing test
   suite still passes (check current baseline via git log docs from today's TUI worker: it left
   the suite at 207 files/4301 tests passing for the TUI+gateway-client+web-control-ui area, and
   full branch suite at 5931 passed/1 failed - a pre-existing unrelated IPv6 proxy test failure,
   confirmed unrelated, do not worry about that one).
5. Commit your work with clear commit messages, following this branch's existing commit style
   (see recent git log from today's other three fixes for tone/format/level of detail expected -
   they were thorough, precise, and cited exact root causes/line numbers).
6. Push to origin/wait-claim-ledger.
7. Write a dated progress entry (matching today's other three progress docs' style) summarizing
   what you found, why it happens, what you changed, and how you validated it.
8. IMPORTANT: verify your own work by checking git log + test output directly before finishing,
   rather than self-reporting completion - commit+push must happen before you're done, not as a
   last "nice to have" step that might get cut off if your process is killed early.

## Constraints

- Do not touch anything outside this repo (no gateway restarts, no config changes - pure source
  investigation/fix on the fork branch, validated via the test suite, not against the live
  running gateway - James will handle any deploy/restart himself).
- Do not revert or undo any of today's three already-landed fixes unless you have clear evidence
  one of them is the direct cause of THIS bug - if so, be surgical and explain your reasoning
  clearly in the commit message, and prefer a targeted fix over a revert if at all possible.
- If stuck or the root cause isn't clear after reasonable investigation, document your best
  hypothesis and what you ruled out, rather than guessing at a fix that might mask the symptom.
- The gateway is currently deployed running directly from this repo's working tree (systemd
  ExecStart points at this checkout's dist/index.js, not an isolated npm-global package) - this
  was a deliberate choice James made today, not an accident. Be aware a rebuild you trigger
  locally (if you run any build/test commands that touch dist/) could theoretically affect the
  live service if James restarts while your build is mid-flight, but this is his accepted
  tradeoff, not something you need to avoid - just don't restart the gateway yourself.
