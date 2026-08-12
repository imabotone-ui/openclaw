import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { appendTranscriptTurn } from "../../system-agent/transcript-store.js";
import {
  captureSystemAgentWizardAction,
  persistSystemAgentEngineHistory,
  systemAgentChatHistoryHandler,
} from "./system-agent-chat-history.js";
import { runSystemAgentGatewayTask } from "./system-agent-gateway-queue.js";
import { getSystemAgentSessionQueue } from "./system-agent-session-queue.js";
import type { GatewayClient } from "./types.js";

const turns = [
  { role: "user" as const, text: "one", at: 1 },
  { role: "assistant" as const, text: "two", at: 2 },
];

const transcriptStoreMocks = vi.hoisted(() => ({
  appendTranscriptTurn: vi.fn(),
  readTranscriptTail: vi.fn(),
}));

vi.mock("../../system-agent/transcript-store.js", () => ({
  appendTranscriptTurn: transcriptStoreMocks.appendTranscriptTurn,
  readTranscriptTail: transcriptStoreMocks.readTranscriptTail,
}));

const ownerClient = {
  connId: "conn-owner",
  connect: { device: { id: "device-owner" } },
} as GatewayClient;

function makeInvocation(params: {
  sessionId?: string;
  client?: GatewayClient;
  activeWizardStep?: ReturnType<typeof vi.fn>;
}) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  const activeWizardStep = params.activeWizardStep ?? vi.fn().mockResolvedValue(undefined);
  const session = {
    ownerKey: "device:device-owner",
    engine: { activeWizardStep },
    lastUsedAt: 1,
    transcriptIncarnationId: "incarnation-owner",
  };
  const context = {
    systemAgentSessions: new Map(params.sessionId ? [[params.sessionId, session]] : []),
  };
  const options = {
    params: params.sessionId ? { sessionId: params.sessionId } : {},
    client: params.client ?? ownerClient,
    context,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      calls.push({ ok, payload, error });
    },
  } as never;
  return { activeWizardStep, calls, context, options, session };
}

describe("openclaw.chat.history wizard recovery", () => {
  beforeEach(() => {
    transcriptStoreMocks.appendTranscriptTurn.mockReset();
    transcriptStoreMocks.readTranscriptTail.mockReset().mockReturnValue(turns);
  });

  it("captures a receipt-safe step projection for a typed answer", async () => {
    const step = {
      id: "slack-mode",
      type: "select" as const,
      message: "How should OpenClaw appear in Slack?",
      options: [{ label: "Slack bot", value: "bot" }],
    };

    await expect(
      captureSystemAgentWizardAction(
        { activeWizardStep: vi.fn().mockResolvedValue(step) },
        { sessionId: "slack-session", wizardAnswer: { stepId: step.id, value: "bot" } },
      ),
    ).resolves.toEqual({
      kind: "answer",
      step: {
        id: "slack-mode",
        type: "select",
        message: "How should OpenClaw appear in Slack?",
      },
    });
  });

  it("omits device authorization material from durable receipt metadata", async () => {
    await expect(
      captureSystemAgentWizardAction(
        {
          activeWizardStep: vi.fn().mockResolvedValue({
            id: "device-auth",
            type: "note",
            title: "Link device",
            message: "Open https://auth.example.test/device and enter ABCD-1234. Never share it.",
            externalUrl: "https://auth.example.test/device?token=secret",
            deviceCode: {
              code: "ABCD-1234",
              expiresInMinutes: 15,
              message: "Never share this code.",
            },
          }),
        },
        { sessionId: "device-session", wizardCancel: { stepId: "device-auth" } },
      ),
    ).resolves.toEqual({
      kind: "cancel",
      step: { id: "device-auth", type: "note" },
    });
  });

  it("persists session scope and action metadata on the matching user turn", () => {
    const wizardAction = {
      kind: "cancel" as const,
      step: { id: "secret", type: "text" as const, message: "Twitch client secret" },
    };
    persistSystemAgentEngineHistory(
      {
        historySince: () => [
          { role: "user", text: "Cancel" },
          { role: "assistant", text: "Twitch setup cancelled." },
        ],
      },
      0,
      {
        sessionId: "twitch-session",
        incarnationId: "twitch-incarnation",
        wizardAction,
        wizardActionAccepted: true,
      },
    );

    expect(vi.mocked(appendTranscriptTurn).mock.calls.map(([turn]) => turn)).toEqual([
      expect.objectContaining({
        role: "user",
        wizardAction,
      }),
      expect.objectContaining({
        role: "assistant",
      }),
    ]);
    for (const [, options] of vi.mocked(appendTranscriptTurn).mock.calls) {
      expect(options).toEqual({
        session: {
          sessionId: "twitch-session",
          incarnationId: "twitch-incarnation",
        },
      });
    }
    expect(vi.mocked(appendTranscriptTurn).mock.calls[1]?.[0]).not.toHaveProperty("wizardAction");
  });

  it("omits action metadata when the engine rejects the typed answer", () => {
    persistSystemAgentEngineHistory(
      {
        historySince: () => [
          { role: "user", text: "Invalid value" },
          { role: "assistant", text: "Choose again." },
        ],
      },
      0,
      {
        sessionId: "validation-session",
        incarnationId: "validation-incarnation",
        wizardAction: {
          kind: "answer",
          step: { id: "port", type: "text", message: "Port" },
        },
        wizardActionAccepted: false,
      },
    );

    expect(vi.mocked(appendTranscriptTurn)).toHaveBeenCalledTimes(2);
    for (const [turn] of vi.mocked(appendTranscriptTurn).mock.calls) {
      expect(turn).not.toHaveProperty("wizardAction");
    }
  });

  it("returns an active wizard only to its bound owner", async () => {
    const activeWizardStep = vi.fn().mockResolvedValue({
      id: "secret",
      type: "text",
      message: "Bot token",
      sensitive: true,
    });
    const owner = makeInvocation({ sessionId: "recover-session", activeWizardStep });

    await systemAgentChatHistoryHandler(owner.options);

    expect(owner.calls).toEqual([
      {
        ok: true,
        payload: {
          turns,
          activeWizard: {
            sessionId: "recover-session",
            step: {
              id: "secret",
              type: "text",
              message: "Bot token",
              sensitive: true,
            },
          },
        },
        error: undefined,
      },
    ]);
    expect(activeWizardStep).toHaveBeenCalledOnce();
    expect(owner.session.lastUsedAt).toBeGreaterThan(1);
    expect(transcriptStoreMocks.readTranscriptTail).toHaveBeenLastCalledWith(100, {
      afterLastReset: true,
      session: {
        sessionId: "recover-session",
        incarnationId: "incarnation-owner",
      },
    });

    const foreign = makeInvocation({
      sessionId: "recover-session",
      client: {
        connId: "conn-foreign",
        connect: { device: { id: "device-foreign" } },
      } as GatewayClient,
      activeWizardStep,
    });

    await systemAgentChatHistoryHandler(foreign.options);

    expect(foreign.calls).toEqual([
      {
        ok: true,
        payload: { turns },
        error: undefined,
      },
    ]);
    expect(activeWizardStep).toHaveBeenCalledOnce();
    expect(foreign.session.lastUsedAt).toBe(1);
  });

  it("waits for the session queue before reading the recovery transcript", async () => {
    const turnStarted = createDeferred();
    const releaseTurn = createDeferred();
    let turnCommitted = false;
    transcriptStoreMocks.readTranscriptTail.mockImplementation(() =>
      turnCommitted
        ? [
            { role: "user", text: "committed question", at: 2 },
            { role: "assistant", text: "committed reply", at: 3 },
          ]
        : [{ role: "assistant", text: "older reply", at: 1 }],
    );
    const invocation = makeInvocation({ sessionId: "recover-session" });
    const turn = getSystemAgentSessionQueue(invocation.context.systemAgentSessions).enqueue(
      "recover-session",
      async () => {
        turnStarted.resolve();
        await releaseTurn.promise;
        turnCommitted = true;
      },
    );
    await turnStarted.promise;

    const history = systemAgentChatHistoryHandler(invocation.options);
    await Promise.resolve();
    const callsBeforeRelease = [...invocation.calls];
    releaseTurn.resolve();
    await Promise.all([turn, history]);

    expect(callsBeforeRelease).toEqual([]);
    expect(invocation.calls).toEqual([
      {
        ok: true,
        payload: {
          turns: [
            { role: "user", text: "committed question", at: 2 },
            { role: "assistant", text: "committed reply", at: 3 },
          ],
        },
        error: undefined,
      },
    ]);
  });

  it("waits for the global Gateway queue before recovering a session", async () => {
    const taskStarted = createDeferred();
    const releaseTask = createDeferred();
    const invocation = makeInvocation({ sessionId: "recover-session" });
    const globalTask = runSystemAgentGatewayTask(async () => {
      taskStarted.resolve();
      await releaseTask.promise;
    });
    await taskStarted.promise;

    const history = systemAgentChatHistoryHandler(invocation.options);
    await Promise.resolve();
    expect(invocation.calls).toEqual([]);

    releaseTask.resolve();
    await Promise.all([globalTask, history]);

    expect(invocation.calls).toEqual([
      {
        ok: true,
        payload: { turns },
        error: undefined,
      },
    ]);
  });
});
