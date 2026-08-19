# Task: Root-cause and fix internal-runtime-context leak on Matrix channel

## Context

Branch: wait-claim-ledger (this repo, already checked out, current HEAD a4ac7e79a1f - may have
moved if other background workers committed since; check git log first)
This branch was rebased onto upstream/main this morning (2026-08-19). It also carries a WIP
duplication fix in packages/gateway-client/src/session-projection.ts. There is likely a SEPARATE
background Claude Code worker running concurrently on a TUI "stuck running" bug - check git log
for any new commits from that effort before you start, and do not conflict with in-flight work
there (different area of the codebase, but be aware).

## Bug being reported

On the Matrix channel specifically, incoming user messages are being stored/rendered with a
leaked internal runtime-context block attached - literally showing text like:

<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>
... (runtime context body, e.g. inbound_meta JSON, timestamps, etc.) ...
<<<END_OPENCLAW_INTERNAL_CONTEXT>>>

appended directly after the user's real message text, WITH embedded instructions like "don't
describe this," "don't reply to this," "just continue" - because this is the actual literal
content of OPENCLAW_RUNTIME_CONTEXT_NOTICE / the runtime-context wrapper, which is designed to
instruct THE MODEL on how to treat the block, not designed to ever be user-visible.

Confirmed via sessions_history on session
"agent:ima:matrix:channel:!yIELlGhURRpPicqSOR:ddrpi-1.elk-exponential.ts.net" - this happened
FOUR separate times across one conversation, every time James (the workspace owner) sent a
message via Matrix. James reports this happens "every time" he messages via Matrix, and that
something like this has happened before with at least one other agent/channel (see below - this
matches a documented precedent).

## Known precedent (found during initial triage, in this exact codebase)

src/agents/embedded-agent-runner/run/runtime-context-prompt.ts, function
buildRuntimeContextMessageContent(), has this exact comment:

// Wrap the runtime context body in delimited internal-context markers so
// stripInternalRuntimeContext can fully remove the block when it leaks
// into user-visible surfaces (e.g. Feishu streaming cards, #92589).

This confirms: this exact class of bug (runtime-context leaking into a channel's visible
surface) has happened before on a DIFFERENT channel (Feishu), tracked as upstream issue #92589.
The runtime-context transcript entry is built as { role: "custom", customType:
OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE, display: false, ... } - explicitly marked non-displayed.
The recurring bug pattern across channels is: some channel's own message-rendering/relay path
doesn't correctly respect the display:false flag (or doesn't correctly filter role:"custom"
entries) and shows the block as if it were a normal chat message.

## Your task

1. Find the Feishu fix for #92589 in git history (search git log --all --grep or similar for
   "92589" or "Feishu" + "streaming card" + "internal context") to understand exactly how that
   was fixed - this is likely the exact pattern to replicate for Matrix.
2. Investigate the Matrix channel plugin's inbound/outbound message handling in
   extensions/matrix/src/ - specifically wherever it decides what to render/relay for a message,
   and whether it correctly filters on display:false / role:"custom" / customType, matching
   whatever mechanism the Feishu fix established (or should have established, if Feishu's fix
   was itself channel-specific rather than a shared core fix - if so, consider whether a SHARED
   core-level fix would be more robust than another one-off per-channel patch).
3. Determine whether this leak is happening on the INBOUND side (the user's message somehow
   getting the runtime-context block concatenated into its stored/displayed content) or on some
   other path (e.g., a streaming/echo mechanism unique to Matrix). The observed transcript
   pattern shows the block appearing to be PART OF the user's message text in sessions_history,
   which is unusual - dig into exactly where that concatenation happens.
4. Also verify: as a defense in depth, does stripInternalRuntimeContext /
   stripInternalRuntimeScaffolding (src/infra/outbound/protocol-scaffolding.ts) get applied to
   whatever Matrix does with this content? If the leak is inbound-side, that outbound stripper
   won't help - you likely need either an inbound-side fix, or to ensure Matrix's rendering path
   filters on the display/customType flags before ever constructing what gets shown/stored.
5. Write a minimal, reliable repro test demonstrating the leak (simulate a Matrix inbound
   message + a runtime-context custom transcript entry, confirm it currently renders/leaks, then
   confirm your fix suppresses it) following existing patterns in this codebase for channel/
   transcript tests.
6. Root-cause it, fix it minimally, and confirm the repro test passes plus the FULL existing
   test suite still passes.
7. Commit your work with clear commit messages, following this branch's existing commit style.
   Push to origin/wait-claim-ledger.
8. Write a dated progress entry summarizing what you found, why it happens, what you changed,
   and how you validated it.
9. IMPORTANT: verify your own work by checking git log + test output directly before finishing,
   rather than self-reporting completion - commit+push must happen before you're done.

## Constraints

- Do not touch anything outside this repo (no gateway restarts, no config changes - pure source
  investigation/fix on the fork branch, validated via the test suite, not against the live
  running gateway).
- Do not revert or undo any other in-flight work on this branch (the session-projection.ts
  duplication fix, or any TUI-streaming-bug work another worker may be doing concurrently) unless
  you have clear evidence it's the direct cause - if so, document your reasoning clearly.
- If stuck or the root cause isn't clear after reasonable investigation, document your best
  hypothesis and what you ruled out, rather than guessing at a fix that might mask the symptom.
- This has security-adjacent implications (the leaked block contains embedded instructions that
  look like prompt-injection attempts to a downstream reader) - be precise about what actually
  happens and don't understate the severity in your progress notes, even though the root cause
  is very likely an accidental rendering bug rather than an actual attack.
