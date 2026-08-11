// Feishu delivery trace goldens: replayable wire-level lifecycle recordings.
//
// IN events are fed straight into the reply-dispatcher plan (dispatcher,
// delivery, and replyOptions callbacks); OUT
// events are recorded at the mocked Lark SDK client and the mocked CardKit
// HTTP fetch, so streaming-card entity calls are captured at the wire seam.
// Refresh goldens with OPENCLAW_TRACE_UPDATE=1 (see delivery-trace harness docs).
import {
  deliveryTraceScenarios,
  expectDeliveryTraceMatchesGolden,
  runDeliveryTraceScenario,
  type DeliveryTraceInStep,
  type DeliveryTraceScenarioName,
  type WireRecorder,
} from "openclaw/plugin-sdk/channel-contract-testing";
import {
  dispatchChannelInboundReply,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FeishuConfigSchema } from "./config-schema.js";
import { sendReplyOrFallbackDirect } from "./send.js";
import type { ResolvedFeishuAccount } from "./types.js";

const settlePendingFinalDeliveryMock = vi.hoisted(() =>
  vi.fn(async (_completion: unknown, state: string) => ({ state })),
);

vi.mock("../../../src/infra/outbound/delivery-completion.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/infra/outbound/delivery-completion.js")>();
  return { ...actual, settlePendingFinalDelivery: settlePendingFinalDeliveryMock };
});

type RecordedWireCall = Parameters<WireRecorder["recordWireCall"]>[0];
type CreateFeishuReplyDispatcher =
  typeof import("./reply-dispatcher.js").createFeishuReplyDispatcher;
type StreamingStartBackoffMap =
  typeof import("./reply-dispatcher-state.js").streamingStartBackoffUntilByAccount;

type FeishuTraceState = {
  recordWireCall: (call: RecordedWireCall) => void;
  account: ResolvedFeishuAccount | null;
  larkClient: unknown;
  cardKitFetch: typeof fetch | null;
  messageCount: number;
  reactionCount: number;
  cardCount: number;
  setupCount: number;
  wireFaults: Array<{ fault: "rate-limit"; retryAfterMs: number }>;
  messageResult: "identified" | "no-id";
  failNextReplace: boolean;
};

const traceState = vi.hoisted(
  (): FeishuTraceState => ({
    recordWireCall: () => {},
    account: null,
    larkClient: null,
    cardKitFetch: null,
    messageCount: 0,
    reactionCount: 0,
    cardCount: 0,
    setupCount: 0,
    wireFaults: [],
    messageResult: "identified",
    failNextReplace: false,
  }),
);

vi.mock("./accounts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./accounts.js")>();
  const resolveTraceAccount = () => {
    if (!traceState.account) {
      throw new Error("trace account not initialized");
    }
    return traceState.account;
  };
  return {
    ...actual,
    resolveFeishuAccount: resolveTraceAccount,
    resolveFeishuRuntimeAccount: resolveTraceAccount,
  };
});

vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>();
  return {
    ...actual,
    createFeishuClient: () => {
      if (!traceState.larkClient) {
        throw new Error("trace Lark client not initialized");
      }
      return traceState.larkClient;
    },
  };
});

// Module-scoped runtime stub (not the shared global runtime slot) so
// isolate=false workers never leak this stub into other feishu test files.
// channel.text uses the real chunking/table helpers because overflow
// pagination behavior is part of the recorded lifecycle.
vi.mock("./runtime.js", async () => {
  const replyChunking = await import("openclaw/plugin-sdk/reply-chunking");
  const textChunking = await import("openclaw/plugin-sdk/text-chunking");
  const markdownTables = await import("openclaw/plugin-sdk/markdown-table-runtime");
  const runtime = {
    channel: {
      text: {
        resolveTextChunkLimit: replyChunking.resolveTextChunkLimit,
        resolveChunkMode: replyChunking.resolveChunkMode,
        chunkTextWithMode: replyChunking.chunkTextWithMode,
        chunkMarkdownTextWithMode: replyChunking.chunkMarkdownTextWithMode,
        convertMarkdownTables: textChunking.convertMarkdownTables,
        resolveMarkdownTableMode: markdownTables.resolveMarkdownTableMode,
      },
    },
    logging: { shouldLogVerbose: () => false },
  };
  return {
    getFeishuRuntime: () => runtime,
    setFeishuRuntime: () => {},
  };
});

// Keep the real streaming-card behavior (throttle, CardKit sequences, close
// settings) and inject only a hermetic recording fetch for its HTTP calls.
vi.mock("./streaming-card.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./streaming-card.js")>();
  class RecordingFeishuStreamingSession extends actual.FeishuStreamingSession {
    constructor(
      client: ConstructorParameters<typeof actual.FeishuStreamingSession>[0],
      creds: ConstructorParameters<typeof actual.FeishuStreamingSession>[1],
      log?: ConstructorParameters<typeof actual.FeishuStreamingSession>[2],
    ) {
      if (!traceState.cardKitFetch) {
        throw new Error("trace CardKit fetch not initialized");
      }
      super(client, creds, log, { fetchImpl: traceState.cardKitFetch });
    }
  }
  return { ...actual, FeishuStreamingSession: RecordingFeishuStreamingSession };
});

let createFeishuReplyDispatcher: CreateFeishuReplyDispatcher;
let streamingStartBackoffUntilByAccount: StreamingStartBackoffMap;

beforeAll(async () => {
  // Collection can share a worker with suites that mock the same Feishu modules.
  // Reload only after this file's hoisted mocks are registered.
  vi.resetModules();
  ({ createFeishuReplyDispatcher } = await import("./reply-dispatcher.js"));
  ({ streamingStartBackoffUntilByAccount } = await import("./reply-dispatcher-state.js"));
});

beforeEach(() => {
  settlePendingFinalDeliveryMock.mockClear();
});

afterAll(() => {
  vi.doUnmock("./accounts.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./runtime.js");
  vi.doUnmock("./streaming-card.js");
  vi.resetModules();
});

afterEach(() => {
  traceState.account = null;
  traceState.larkClient = null;
  traceState.cardKitFetch = null;
  traceState.wireFaults = [];
  streamingStartBackoffUntilByAccount.clear();
});

function jsonResponse(payload: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    throw new Error("expected JSON string body");
  }
  return JSON.parse(value) as Record<string, unknown>;
}

function nextMessageId(): string {
  traceState.messageCount += 1;
  return `om-${traceState.messageCount}`;
}

function createRecordingLarkClient() {
  const messageSendResult = (messageId: string) =>
    traceState.messageResult === "identified"
      ? { code: 0, msg: "ok", data: { message_id: messageId } }
      : { code: 0, msg: "ok", data: {} };
  return {
    im: {
      message: {
        create: (args: {
          params: { receive_id_type: string };
          data: { receive_id: string; msg_type: string; content: string; root_id?: string };
        }) => {
          const messageId = nextMessageId();
          traceState.recordWireCall({
            method: "im.message.create",
            target: args.data.receive_id,
            payload: {
              receive_id_type: args.params.receive_id_type,
              msg_type: args.data.msg_type,
              content: parseJsonRecord(args.data.content),
              ...(args.data.root_id ? { root_id: args.data.root_id } : {}),
            },
            result: { message_id: messageId },
          });
          return Promise.resolve(messageSendResult(messageId));
        },
        reply: (args: {
          path: { message_id: string };
          data: { msg_type: string; content: string; reply_in_thread?: boolean };
        }) => {
          const messageId = nextMessageId();
          traceState.recordWireCall({
            method: "im.message.reply",
            target: args.path.message_id,
            payload: {
              msg_type: args.data.msg_type,
              content: parseJsonRecord(args.data.content),
              ...(args.data.reply_in_thread ? { reply_in_thread: true } : {}),
            },
            result: { message_id: messageId },
          });
          return Promise.resolve(messageSendResult(messageId));
        },
        delete: (args: { path: { message_id: string } }) => {
          traceState.recordWireCall({
            method: "im.message.delete",
            target: args.path.message_id,
            result: { code: 0 },
          });
          return Promise.resolve({ code: 0, msg: "ok" });
        },
      },
      messageReaction: {
        create: (args: {
          path: { message_id: string };
          data: { reaction_type: { emoji_type: string } };
        }) => {
          traceState.reactionCount += 1;
          const reactionId = `reaction-${traceState.reactionCount}`;
          traceState.recordWireCall({
            method: "im.messageReaction.create",
            target: args.path.message_id,
            payload: { emoji_type: args.data.reaction_type.emoji_type },
            result: { reaction_id: reactionId },
          });
          return Promise.resolve({ code: 0, msg: "ok", data: { reaction_id: reactionId } });
        },
        delete: (args: { path: { message_id: string; reaction_id: string } }) => {
          traceState.recordWireCall({
            method: "im.messageReaction.delete",
            target: args.path.message_id,
            payload: { reaction_id: args.path.reaction_id },
            result: { code: 0 },
          });
          return Promise.resolve({ code: 0, msg: "ok", data: {} });
        },
      },
    },
  };
}

function createRecordingCardKitFetch(): typeof fetch {
  return withFetchPreconnect(
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const method = init?.method ?? "GET";
      const wirePath = url.pathname.replace(/^\/open-apis/, "");
      const record = (payload: unknown, result: unknown) => {
        traceState.recordWireCall({ method: `${method} ${wirePath}`, payload, result });
      };
      if (wirePath === "/auth/v3/tenant_access_token/internal") {
        // Recorded without the request body: credentials and token values never
        // belong in committed goldens, and the run-scoped app id must not leak
        // into byte-stable fixtures.
        record(undefined, { code: 0 });
        return jsonResponse({
          code: 0,
          msg: "ok",
          // Short dummy value: autoreview's secret scanner rejects longer
          // token-keyed strings even in fixtures.
          tenant_access_token: "tat-dummy",
          expire: 7200,
        });
      }
      if (wirePath === "/cardkit/v1/cards") {
        traceState.cardCount += 1;
        const cardId = `card-${traceState.cardCount}`;
        const body = parseJsonRecord(init?.body);
        record({ type: body.type, card: parseJsonRecord(body.data) }, { code: 0, card_id: cardId });
        return jsonResponse({ code: 0, msg: "ok", data: { card_id: cardId } });
      }
      if (wirePath.endsWith("/elements/content/content")) {
        const body = parseJsonRecord(init?.body);
        const fault = traceState.wireFaults.shift();
        if (fault) {
          record(body, { status: 429, retryAfterMs: fault.retryAfterMs });
          return jsonResponse({ code: 99991400, msg: "rate limited" }, 429, {
            "retry-after": String(Math.ceil(fault.retryAfterMs / 1000)),
          });
        }
        record(body, { code: 0 });
        return jsonResponse({ code: 0, msg: "ok" });
      }
      if (wirePath.endsWith("/elements/content")) {
        const body = parseJsonRecord(init?.body);
        if (traceState.failNextReplace) {
          traceState.failNextReplace = false;
          record(
            { element: parseJsonRecord(body.element), sequence: body.sequence, uuid: body.uuid },
            { status: 500 },
          );
          return jsonResponse({ code: 230099, msg: "replace rejected" }, 500);
        }
        record(
          { element: parseJsonRecord(body.element), sequence: body.sequence, uuid: body.uuid },
          { code: 0 },
        );
        return jsonResponse({ code: 0, msg: "ok" });
      }
      if (wirePath.endsWith("/elements/note/content")) {
        record(parseJsonRecord(init?.body), { code: 0 });
        return jsonResponse({ code: 0, msg: "ok" });
      }
      if (wirePath.endsWith("/settings")) {
        const body = parseJsonRecord(init?.body);
        record(
          { settings: parseJsonRecord(body.settings), sequence: body.sequence, uuid: body.uuid },
          { code: 0 },
        );
        return jsonResponse({ code: 0, msg: "ok" });
      }
      throw new Error(`Unexpected CardKit request: ${method} ${url.pathname}`);
    }),
  ) as typeof fetch;
}

function makeTraceAccount(scenario: DeliveryTraceScenarioName): ResolvedFeishuAccount {
  traceState.setupCount += 1;
  return {
    accountId: "main",
    selectionSource: "fallback",
    enabled: true,
    configured: true,
    // Run-unique app id busts the module-level CardKit token cache so every
    // scenario (and any same-worker re-run) records exactly one token fetch.
    appId: `app-${scenario}-${traceState.setupCount}`,
    appSecret: "test-secret",
    domain: "feishu",
    // Nested streaming.mode "partial" matches the retired `streaming: true`
    // boolean, so the recorded wire goldens stay byte-identical.
    config: FeishuConfigSchema.parse({ renderMode: "auto", streaming: { mode: "partial" } }),
  };
}

function setupFeishuTrace(recorder: WireRecorder, scenario: DeliveryTraceScenarioName) {
  traceState.recordWireCall = recorder.recordWireCall;
  traceState.messageCount = 0;
  traceState.reactionCount = 0;
  traceState.cardCount = 0;
  traceState.wireFaults = [];
  traceState.messageResult = "identified";
  traceState.failNextReplace = false;
  traceState.account = makeTraceAccount(scenario);
  traceState.larkClient = createRecordingLarkClient();
  traceState.cardKitFetch = createRecordingCardKitFetch();

  const created = createFeishuReplyDispatcher({
    cfg: {} as never,
    agentId: "agent",
    runtime: { log: () => {}, error: () => {} } as never,
    chatId: "oc-trace-chat",
    sendTarget: "oc-trace-chat",
    replyToMessageId: "om-inbound",
  });
  const options = created.dispatcherOptions;

  return async (step: DeliveryTraceInStep) => {
    switch (step.kind) {
      case "reply-start":
        await options.onReplyStart?.();
        break;
      case "partial":
        created.replyOptions.onPartialReply?.({ text: step.text });
        break;
      case "block-final":
        await created.delivery.deliver({ text: step.text }, { kind: "block" });
        break;
      case "tool-progress":
        created.replyOptions.onToolStart?.({ name: step.name, phase: step.phase });
        break;
      case "final":
        await created.delivery.deliver(
          {
            ...(step.text !== undefined ? { text: step.text } : {}),
            ...(step.mediaUrls ? { mediaUrls: step.mediaUrls } : {}),
            ...(step.isError ? { isError: true } : {}),
          },
          { kind: "final" },
        );
        break;
      case "cancel":
        // An aborted run stops emitting payloads; closeout happens on idle.
        break;
      case "idle":
        await options.onIdle?.();
        options.onCleanup?.();
        break;
      case "wire-fault":
        if (step.fault !== "rate-limit") {
          throw new Error("feishu trace scenarios script only rate-limit wire faults");
        }
        traceState.wireFaults.push({ fault: step.fault, retryAfterMs: step.retryAfterMs });
        break;
    }
  };
}

const FEISHU_TRACE_SCENARIOS: readonly DeliveryTraceScenarioName[] = [
  "streaming-happy",
  "final-only",
  "cancel-mid-stream",
  "rate-limit-during-preview",
  "overflow-pagination",
];

const pendingFinalCompletion = {
  deliveryId: "delivery-feishu-custody",
  intentId: "intent-feishu-custody",
  sessionId: "session-feishu-custody",
  sessionKey: "agent:agent:feishu:direct:oc-trace-chat",
  storePath: "/tmp/feishu-custody-sessions.json",
};

function createTraceContext() {
  return {
    Body: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    CommandAuthorized: false,
    From: "ou-sender",
    To: "oc-trace-chat",
    SessionKey: pendingFinalCompletion.sessionKey,
    Provider: "feishu",
    Surface: "feishu",
  };
}

function expectDeliveredCustody() {
  expect(settlePendingFinalDeliveryMock).toHaveBeenNthCalledWith(
    1,
    { kind: "pending-final", ...pendingFinalCompletion },
    "unknown",
    ["prepared", "queued"],
  );
  expect(settlePendingFinalDeliveryMock).toHaveBeenNthCalledWith(
    2,
    { kind: "pending-final", ...pendingFinalCompletion },
    "delivered",
    ["queued", "unknown"],
  );
}

describe("feishu delivery trace goldens", () => {
  for (const scenarioName of FEISHU_TRACE_SCENARIOS) {
    it(`records ${scenarioName}`, async () => {
      const events = await runDeliveryTraceScenario({
        scenario: deliveryTraceScenarios[scenarioName],
        setup: (recorder) => setupFeishuTrace(recorder, scenarioName),
      });
      expectDeliveryTraceMatchesGolden({
        goldenUrl: new URL(`./__traces__/${scenarioName}.trace.jsonl`, import.meta.url),
        events,
      });
    });
  }
});

describe("feishu producer custody boundaries", () => {
  it("settles an actual rejected message producer as permanent suppression", async () => {
    const rejected = Object.assign(new Error("Request failed with status code 400"), {
      response: {
        status: 400,
        data: { code: 230099, msg: "card table number over limit" },
      },
    });
    const sourcePayload = setReplyPayloadMetadata(
      { text: "the final answer" },
      { pendingFinalDeliveryCompletion: pendingFinalCompletion },
    );
    const client = {
      im: {
        message: {
          create: vi.fn(),
          reply: vi.fn().mockRejectedValue(rejected),
        },
      },
    };

    await expect(
      dispatchChannelInboundReply({
        cfg: {},
        channel: "feishu",
        accountId: "main",
        agentId: "agent",
        routeSessionKey: pendingFinalCompletion.sessionKey,
        storePath: pendingFinalCompletion.storePath,
        ctxPayload: createTraceContext(),
        recordInboundSession: async () => undefined,
        dispatchReplyWithBufferedBlockDispatcher: async ({ dispatcherOptions }) => {
          await dispatcherOptions.deliver?.(sourcePayload, { kind: "final" });
          return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
        },
        delivery: {
          deliver: async () =>
            await sendReplyOrFallbackDirect(client, {
              replyToMessageId: "om-inbound",
              content: "{}",
              msgType: "interactive",
              directParams: {
                receiveId: "oc-trace-chat",
                receiveIdType: "chat_id",
                content: "{}",
                msgType: "interactive",
              },
              directErrorPrefix: "Feishu card send failed",
              replyErrorPrefix: "Feishu card reply failed",
            }),
        },
      }),
    ).rejects.toMatchObject({ retryable: false, cause: rejected });

    expect(settlePendingFinalDeliveryMock).toHaveBeenNthCalledWith(
      2,
      { kind: "pending-final", ...pendingFinalCompletion },
      "suppressed",
      ["prepared", "queued", "unknown"],
    );
    expect(client.im.message.reply).toHaveBeenCalledOnce();
    expect(client.im.message.create).not.toHaveBeenCalled();
  });

  it("retains visible custody when no-ID preview disposition fails", async () => {
    const wireCalls: RecordedWireCall[] = [];
    traceState.recordWireCall = (call) => wireCalls.push(call);
    traceState.messageCount = 0;
    traceState.cardCount = 0;
    traceState.messageResult = "no-id";
    traceState.failNextReplace = true;
    traceState.account = {
      ...makeTraceAccount("final-only"),
      config: FeishuConfigSchema.parse({ renderMode: "card", streaming: { mode: "partial" } }),
    };
    traceState.larkClient = createRecordingLarkClient();
    traceState.cardKitFetch = createRecordingCardKitFetch();
    const created = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: () => {}, error: () => {} } as never,
      chatId: "oc-trace-chat",
      sendTarget: "oc-trace-chat",
      replyToMessageId: "om-inbound",
    });
    const sourcePayload = setReplyPayloadMetadata(
      { text: "x".repeat(4001) },
      { pendingFinalDeliveryCompletion: pendingFinalCompletion },
    );

    const error = await dispatchChannelInboundReply({
      cfg: {},
      channel: "feishu",
      accountId: "main",
      agentId: "agent",
      routeSessionKey: pendingFinalCompletion.sessionKey,
      storePath: pendingFinalCompletion.storePath,
      ctxPayload: createTraceContext(),
      recordInboundSession: async () => undefined,
      dispatchReplyWithBufferedBlockDispatcher: async ({ dispatcherOptions }) => {
        await dispatcherOptions.onReplyStart?.();
        created.replyOptions.onPartialReply?.({ text: "accepted preview" });
        await dispatcherOptions.deliver?.(sourcePayload, { kind: "final" });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
      dispatcherOptions: created.dispatcherOptions,
      replyOptions: created.replyOptions,
      delivery: created.delivery,
    }).catch((caught: unknown) => caught);

    expect(isChannelPartialDeliveryError(error)).toBe(true);
    expect(error).toMatchObject({
      deliveryResult: { visibleReplySent: true, content: "accepted preview" },
    });
    expectDeliveredCustody();
    expect(wireCalls.filter((call) => call.method === "im.message.reply")).toHaveLength(1);
    expect(wireCalls.some((call) => call.method === "im.message.delete")).toBe(false);
    expect(wireCalls.filter((call) => call.method.endsWith("/elements/content"))).toHaveLength(1);
  });
});
