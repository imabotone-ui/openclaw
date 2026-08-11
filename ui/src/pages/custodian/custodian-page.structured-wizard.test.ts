/* @vitest-environment jsdom */

import { GATEWAY_SERVER_CAPS } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

describe("custodian structured wizard", () => {
  beforeEach(() => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    document.body.replaceChildren();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("keeps a rejected typed answer active without showing a submitted receipt", async () => {
    const step = {
      id: "port",
      type: "text" as const,
      message: "Gateway port",
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "validation-session",
        reply: "Enter a port.",
        action: "none",
        wizardInputPending: true,
        step,
      })
      .mockResolvedValueOnce({
        sessionId: "validation-session",
        reply: "Enter port 18789.",
        action: "none",
        wizardActionAccepted: false,
        wizardInputPending: true,
        step,
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context);

    const input = await waitForFast(() => {
      const element = page.querySelector<HTMLInputElement>(
        '.custodian__wizard-step input[name="wizard-text"]',
      );
      expect(element).not.toBeNull();
      return element!;
    });
    input.value = "banana";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".custodian__wizard-step .btn.primary")!.click();

    await waitForFast(() => expect(page.textContent).toContain("Enter port 18789."));
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      wizardAnswer: { stepId: "port", value: "banana" },
    });
    expect(page.querySelector(".custodian__structured-response")).toBeNull();
    expect(page.querySelector(".custodian__wizard-step")).not.toBeNull();
    expect(page.querySelector(".chat-group.user")).toBeNull();
  });

  it("recovers an uncertain answer from history without replaying it", async () => {
    const step = { id: "port", type: "text" as const, message: "Gateway port" };
    const nextStep = { id: "agent-name", type: "text" as const, message: "Agent name" };
    let historyRequests = 0;
    const request = vi.fn(
      async (
        method: string,
        params: { sessionId?: string; wizardAnswer?: unknown },
        options?: { onSent?: () => void },
      ) => {
        if (method === "openclaw.chat.history") {
          if (params.sessionId !== "recovery-session") {
            return { turns: [] };
          }
          historyRequests += 1;
          if (historyRequests === 1) {
            throw new Error("history temporarily unavailable");
          }
          return {
            turns: [
              { role: "assistant", text: "Gateway port", at: 1, sessionId: "recovery-session" },
              {
                role: "user",
                text: "18789",
                at: 2,
                sessionId: "recovery-session",
                wizardAction: { kind: "answer", step },
              },
              { role: "assistant", text: "Agent name", at: 3, sessionId: "recovery-session" },
            ],
            activeWizard: { sessionId: "recovery-session", step: nextStep },
          };
        }
        if (params.wizardAnswer) {
          options?.onSent?.();
          throw new Error("reply lost after send");
        }
        return {
          sessionId: "recovery-session",
          reply: "Enter a port.",
          action: "none",
          wizardInputPending: true,
          step,
        };
      },
    );
    const { context } = createContext(request, ["openclaw.chat", "openclaw.chat.history"], {
      gatewayCapabilities: [
        GATEWAY_SERVER_CAPS.SYSTEM_AGENT_WIZARD_CANCEL,
        GATEWAY_SERVER_CAPS.SYSTEM_AGENT_CHAT_HISTORY_SESSION_RECOVERY,
      ],
      recoveryScope: "principal-a",
    });
    const { page } = await mountPage(context);

    const input = await waitForFast(() => {
      const element = page.querySelector<HTMLInputElement>(
        '.custodian__wizard-step input[name="wizard-text"]',
      );
      expect(element).not.toBeNull();
      return element!;
    });
    input.value = "18789";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    page.querySelector<HTMLButtonElement>(".custodian__wizard-step .btn.primary")!.click();

    const checkStatus = await waitForFast(() => {
      const button = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === "Check status",
      );
      expect(button).not.toBeUndefined();
      return button!;
    });
    const uncertainStatus = page.querySelector(".custodian__structured-response-status");
    expect(uncertainStatus?.textContent).toBe("Answer sent; confirmation unavailable");
    expect(uncertainStatus?.classList.contains("sr-only")).toBe(false);
    checkStatus.click();

    await waitForFast(() => expect(page.textContent).toContain("Agent name"));
    expect(page.querySelector(".custodian__structured-response")?.textContent).toContain("18789");
    expect(page.querySelector(".custodian__wizard-step")).not.toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "openclaw.chat")).toHaveLength(2);
    expect(
      request.mock.calls.filter(
        ([method, params]) =>
          method === "openclaw.chat.history" && params.sessionId === "recovery-session",
      ),
    ).toHaveLength(2);
  });

  it("offers a fresh setup when the Gateway cannot recover uncertain actions", async () => {
    const step = { id: "port", type: "text" as const, message: "Gateway port" };
    const request = vi.fn(
      async (
        _method: string,
        params: { wizardAnswer?: unknown },
        options?: { onSent?: () => void },
      ) => {
        if (params.wizardAnswer) {
          options?.onSent?.();
          throw new Error("reply lost after send");
        }
        return request.mock.calls.length === 1
          ? {
              sessionId: "legacy-session",
              reply: "Enter a port.",
              action: "none",
              wizardInputPending: true,
              step,
            }
          : { sessionId: "fresh-session", reply: "Fresh setup ready.", action: "none" };
      },
    );
    const { context } = createContext(request);
    const { page } = await mountPage(context);

    const input = await waitForFast(() => {
      const element = page.querySelector<HTMLInputElement>(
        '.custodian__wizard-step input[name="wizard-text"]',
      );
      expect(element).not.toBeNull();
      return element!;
    });
    input.value = "18789";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    page.querySelector<HTMLButtonElement>(".custodian__wizard-step .btn.primary")!.click();

    const restart = await waitForFast(() => {
      const button = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === "Restart setup",
      );
      expect(button).not.toBeUndefined();
      return button!;
    });
    restart.click();

    await waitForFast(() => expect(page.textContent).toContain("Fresh setup ready."));
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("wizardAnswer");
  });

  it("keeps Slack guidance visible in one typed card and formats its manifest", async () => {
    const manifest = JSON.stringify(
      {
        display_information: {
          name: "OpenClaw",
          description: "OpenClaw connector for OpenClaw",
        },
      },
      null,
      2,
    );
    const question = "How do you want to provide this Slack bot token?";
    const request = vi.fn().mockResolvedValue({
      sessionId: "slack-wizard-session",
      reply: [
        [
          "**Slack socket mode tokens**",
          "1) Create the Slack app from the manifest below",
          "2) Enable Socket Mode",
        ].join("\n"),
        manifest,
        [
          question,
          "1. Enter Slack bot token — Stores the credential directly in OpenClaw config",
          "2. Use external secret provider — Stores a reference to an external provider",
          "Reply with a number.",
          "Say `cancel` to stop this setup.",
        ].join("\n"),
      ].join("\n\n"),
      action: "none",
      wizardInputPending: true,
      step: {
        id: "slack-token-source",
        type: "select",
        message: question,
        options: [
          {
            label: "Enter Slack bot token",
            value: "direct",
            hint: "Stores the credential directly in OpenClaw config",
          },
          {
            label: "Use external secret provider",
            value: "secret-ref",
            hint: "Stores a reference to an external provider",
          },
        ],
      },
    });
    const { context } = createContext(request);
    const { page } = await mountPage(context);

    await waitForFast(() =>
      expect(page.querySelector(".custodian__wizard-guidance")).not.toBeNull(),
    );
    expect(page.querySelector(".chat-group.assistant")).toBeNull();
    expect(page.querySelector("details")).toBeNull();
    expect(page.querySelector(".custodian__wizard-guidance ol")).not.toBeNull();
    expect(page.querySelector(".custodian__wizard-guidance .code-block-wrapper")).not.toBeNull();
    const copyButton = page.querySelector<HTMLButtonElement>(
      ".custodian__wizard-guidance .code-block-copy",
    );
    expect(copyButton).not.toBeNull();
    copyButton?.click();
    await waitForFast(() => expect(copyButton?.getAttribute("aria-label")).not.toBe("Copy code"));
    expect(page.querySelector(".custodian__wizard-guidance")?.textContent).toContain(
      "Slack socket mode tokens",
    );
    expect((page.textContent ?? "").split(question)).toHaveLength(2);
    expect(page.textContent).not.toContain("Reply with a number");
    expect(page.textContent).not.toContain("Say cancel");
  });
});
