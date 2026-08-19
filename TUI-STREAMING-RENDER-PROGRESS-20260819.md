# TUI live streaming render — investigation (2026-08-19)

Brief: `TUI-STREAMING-RENDER-BRIEF-20260819.md`.

## Reported symptom

While the assistant is generating, the TUI shows no incremental text — only a
status indicator. The whole reply appears at once when the run completes. The
separate "stuck running forever" defect (fixed in `df1d9a8312d`) is confirmed
gone; this is a distinct report.

## Verdict

**No defect reproduced in the streaming display chain.** Each of the three legs
was proven to work, including the exact payload shape the Gateway sends. The
leading hypothesis in the brief (unforced `tui.requestRender()` being dropped)
is **refuted by the renderer source**. I did not change behavior, because every
candidate fix would have masked a symptom I cannot reproduce. Two real,
code-level suppression mechanisms that produce this exact symptom under specific
configurations are recorded below as follow-ups; neither is active in the
operator's current config.

## Refuted: render throttling

`node_modules/@earendil-works/pi-tui/dist/tui.js:502-548`.

`requestRender(force = false)` differs from `requestRender(true)` only in that
`force` discards the previous frame cache (`previousLines`, `previousWidth/Height`
= -1, cursor/viewport reset) and paints on `process.nextTick`. The unforced path
still always paints: it sets `renderRequested`, then `scheduleRender()` paints
after at most `MIN_RENDER_INTERVAL_MS` (16, line 123) since the last frame, and
re-schedules if another request arrived during the paint. Unforced renders are
coalesced to ~60fps; they are never skipped or coalesced away entirely. So
`tui.requestRender()` at the end of `handleChatEvent`
(`src/tui/tui-event-handlers.ts:376`) does repaint after every delta batch, and
`force` would only add full-screen clears.

## What was proven to work

1. **Runner leg — incremental assistant events.** Drove the real message-update
   handler (`src/agents/embedded-agent-subscribe.handlers.messages.update.ts`)
   with an Anthropic-shaped three-chunk text stream through
   `embedded-agent-subscribe.handlers.messages.test-helpers.ts`. It emitted one
   `stream: "assistant"` event per chunk with growing cumulative `text` plus the
   incremental `delta` (`Hello` / `Hello there` / `Hello there, world`), before
   `text_end`. (Throwaway probe; not committed.)
2. **Gateway leg — chat deltas per assistant event.**
   `src/gateway/server-chat.ts:961-1073` broadcasts `state: "delta"` chat
   payloads, paced at `LIVE_TEXT_PACING_MS = 75` (line 223), with the full
   snapshot in `message.content[0].text`. Existing coverage asserts this
   (`src/gateway/server-chat.agent-events.test.ts:4267`, `:4394`, `:4581`).
3. **TUI leg — intermediate text really reaches the screen.**
   `src/tui/tui-pty-harness.e2e.test.ts:834` ("authenticates a streamed prefix
   before the complete ordered final frame") drives the TUI in a real PTY with
   the same chat payload shape the Gateway emits, and asserts on the terminal
   frame that exactly the first 64 streamed tokens are visible while the run is
   still streaming, before the final event is released
   (`src/tui/tui-pty-rendering-test-support.ts:14-70`). Ran green on this HEAD:

   ```
   ✓ |tui-pty| src/tui/tui-pty-harness.e2e.test.ts > TUI PTY harness >
     authenticates a streamed prefix before the complete ordered final frame 1928ms
   Test Files 1 passed (1) | Tests 1 passed | 62 skipped
   ```

## Also ruled out

- **`df1d9a8312d` (stuck-running fix) is not the cause.** It only widens replay
  of _deferred terminal_ events (`displayedAssistantRunIds`); it touches neither
  the delta branch nor render scheduling.
- **The rebase and the other two fixes today.** `git diff 7f60af7f8bf HEAD`
  touches no delta-path or render-path production line: TUI changes are the
  coordinator replay condition, `TuiHistoryLoadResult`, and the history rebuild's
  run-id record; the rest is subagent wait-claim work, `inbound-meta`, and the
  runtime-context carrier.
- **`streamAssembler.ingestDelta` gating.** It returns text whenever the
  composed display text changed; with `showThinking` off it still returns
  content text, and the Gateway's delta payload carries only a text block
  (never thinking), so the `if (!displayText) return` guard at
  `src/tui/tui-event-handlers.ts:281` cannot swallow a normal reply.
- **`chatLog.updateAssistant` needing a pre-existing component.** It calls
  `startAssistant` when no streaming component exists
  (`src/tui/components/chat-log.ts:471-484`), and `clearAll` clears
  `assistantRuns` too, so a mid-run history rebuild costs a flicker, not
  permanent invisibility.
- **Delivery filtering / slow-consumer drops.** Deltas and finals resolve the
  same delivery keys through `sendChatPayload`; `dropIfSlow` keys off live
  `socket.bufferedAmount` (`src/gateway/server-broadcast.ts:317-333`), is not
  sticky, and logs when it trips.
- **Control-token suppression.** `isSuppressedControlReplyLeadFragment`
  (`src/gateway/control-reply-text.ts:57-80`) holds only short all-caps prefixes
  of `ANNOUNCE_SKIP` / `REPLY_SKIP` / the silent token; it releases as soon as
  the text diverges.

## Leading hypotheses (config-dependent, both real code paths)

- **A `before_agent_finalize` hook disables live streaming for every surface.**
  `deferBlockReplyDelivery` is set purely from
  `typeof params.onBeforeTerminalDelivery === "function"`
  (`src/agents/embedded-agent-subscribe.run-state.ts:103`,
  `embedded-agent-subscribe.ts:440`), and that callback exists only when the run's
  hook runner has `before_agent_finalize` hooks
  (`src/agents/embedded-agent-runner/run/attempt-stream-prepare.ts:107-110`).
  With it set, `emitAssistantStreamData` parks _every_ assistant stream event
  (`reply-delivery.ts:68-78`) until `deliverTerminal()` flushes them
  (`handlers.lifecycle.ts:325`) — no Gateway chat deltas, then the entire reply
  at once. Not active here: no bundled hook and none of the operator's loaded
  plugins (`brave`, `matrix`, `anthropic`, `google`, `llama-cpp`, `memory-core`)
  register that event.
- **`openai-responses` transport streams no live text mid-block.** Unphased
  Responses text items return early before emission until `text_end`
  (`embedded-agent-subscribe.handlers.messages.update.ts:197-201`, `:275`). Not
  active here either: the primary model is `anthropic/claude-sonnet-5`, whose
  unphased text only gates _block-reply_ buffering, not live emission.

## Follow-ups (named, not done here)

1. A finalize-time hook silently deleting the live-streaming capability for all
   surfaces is a doctrine-class product bug (capability removed invisibly, no
   recorded reason). The deferral should scope to durable block replies, not to
   diagnostic live stream events — or state the tradeoff at the boundary.
2. `openai-responses` sessions have no live text within a text block. If that is
   intentional, it belongs in `docs/concepts/streaming.md`; if not, it is a
   parity gap against the Anthropic path.

## What would settle the report

The chain is healthy in test, so the next step needs a capture from the failing
terminal rather than more source reading:

- A prompt with a long, definitely-visible answer (e.g. "count from 1 to 200,
  one per line"), to separate "no streaming" from "thinking-heavy run whose short
  answer lands in one 75ms pace window" — with extended thinking and
  `showThinking` off, most of the wall clock legitimately shows only the status
  indicator.
- The TUI's current `/verbose` and `/reasoning` settings.
- Whether the session's runs show live text in the Control UI at the same time
  (same Gateway chat deltas, different renderer) — that isolates TUI vs Gateway.
- A debug-level Gateway log for one run, checking for `state: "delta"` chat
  frames on the outbound WS.

## Validation

`src/tui/tui-pty-harness.e2e.test.ts -t "authenticates a streamed prefix"`:
1 passed. No production or test files were changed by this investigation, so no
broader suite run was warranted.
