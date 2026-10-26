// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HermesUIMessage, MessagesResponse } from "@hermes/protocol";
import { hermesUIMessagesToChatMessages } from "@/components/chat/message-adapter";
import type { ChatMessage } from "@/components/chat/chat-types";
import {
  GATEWAY_OFFLINE_NOTICE_DELAY_MS,
  GatewayOfflineBanner,
  correctionTruncateRowId,
  gatewayOfflineNotice,
  locateStoredCorrectionRowId,
  resolveCorrectionRowId,
  steerRunningSession,
  stopShouldApply,
} from "./detail";
import { GatewayRpcError } from "@/lib/gateway-result";

function uiMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
  createdAt: number,
): HermesUIMessage {
  return {
    id,
    sessionId: "session-1",
    role,
    createdAt,
    status: "complete",
    parts: [{ type: "text", text }],
  };
}

function messagesResponse(uiMessages: HermesUIMessage[]): MessagesResponse {
  return { session_id: "session-1", messages: [], ui_messages: uiMessages };
}

const optimisticUser: ChatMessage = {
  id: "live-user-1750000000000",
  role: "user",
  createdAt: 1,
  status: "complete",
  text: "帮我看下日志",
};

describe("correction row id resolution", () => {
  it("shows the two id shapes: optimistic turn ids carry no row, stored rows do", () => {
    expect(optimisticUser.id.startsWith("live-user-")).toBe(true);
    expect(correctionTruncateRowId(optimisticUser.id)).toBeNull();

    const stored = hermesUIMessagesToChatMessages([
      uiMessage("stored-47", "user", "帮我看下日志", 1),
    ]);
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe("stored-47");
    expect(correctionTruncateRowId(stored[0].id)).toBe(47);
  });

  it("reloads the session once and locates the real stored row for an optimistic id", async () => {
    const reload = vi.fn().mockResolvedValue(
      messagesResponse([
        uiMessage("stored-40", "user", "帮我看下日志", 100),
        uiMessage("stored-41", "assistant", "日志没问题", 200),
        uiMessage("stored-46", "user", "帮我看下日志", 300),
        uiMessage("stored-47", "assistant", "这次日志也没问题", 400),
      ]),
    );

    const result = await resolveCorrectionRowId({
      messageId: optimisticUser.id,
      text: optimisticUser.text ?? "",
      anchorText: "这次日志也没问题",
      reload,
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ rowId: 46, reloaded: true });
  });

  it("keeps the stored id path offline: no reload, no extra request", async () => {
    const reload = vi.fn().mockResolvedValue(messagesResponse([]));

    const result = await resolveCorrectionRowId({
      messageId: "stored-46",
      text: "帮我看下日志",
      reload,
    });

    expect(result).toEqual({ rowId: 46, reloaded: false });
    expect(reload).not.toHaveBeenCalled();
  });

  it("picks the user row that sits before the anchored assistant reply", () => {
    const messages = [
      uiMessage("stored-1", "user", "跑一下测试", 1),
      uiMessage("stored-2", "assistant", "第一轮通过", 2),
      uiMessage("stored-3", "user", "跑一下测试", 3),
      uiMessage("stored-4", "assistant", "第二轮通过", 4),
    ];

    expect(locateStoredCorrectionRowId(messages, { text: "跑一下测试", anchorText: "第一轮通过" })).toBe(1);
    expect(locateStoredCorrectionRowId(messages, { text: "跑一下测试", anchorText: "第二轮通过" })).toBe(3);
    expect(locateStoredCorrectionRowId(messages, { text: "跑一下测试" })).toBe(3);
  });

  it("refuses to guess when the duplicated text has no matching anchor", () => {
    const messages = [
      uiMessage("stored-1", "user", "跑一下测试", 1),
      uiMessage("stored-2", "assistant", "第一轮通过", 2),
      uiMessage("stored-3", "user", "跑一下测试", 3),
      uiMessage("stored-4", "assistant", "第二轮通过", 4),
    ];

    expect(locateStoredCorrectionRowId(messages, { text: "跑一下测试", anchorText: "尚未落库的回答" })).toBeNull();
  });

  it("reports null after the reload when the stored turn is still missing", async () => {
    const reload = vi.fn().mockResolvedValue(
      messagesResponse([uiMessage("stored-41", "assistant", "日志没问题", 200)]),
    );

    const result = await resolveCorrectionRowId({
      messageId: optimisticUser.id,
      text: optimisticUser.text ?? "",
      reload,
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ rowId: null, reloaded: true });
  });

  it("survives a failed reload and reports it as unresolved", async () => {
    const reload = vi.fn().mockRejectedValue(new Error("network down"));

    const result = await resolveCorrectionRowId({
      messageId: optimisticUser.id,
      text: optimisticUser.text ?? "",
      reload,
    });

    expect(result).toEqual({ rowId: null, reloaded: true });
  });
});

describe("steerRunningSession", () => {
  it("calls the real kernel method with session_id + text", async () => {
    const request = vi.fn().mockResolvedValue({ status: "queued", text: "再想想" });

    const result = await steerRunningSession({ request }, "gw-session-1", "再想想");

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("session.steer", {
      session_id: "gw-session-1",
      text: "再想想",
    });
    expect(result).toEqual({ status: "queued", text: "再想想" });
  });

  it("normalizes an empty reply so callers always get an object", async () => {
    const request = vi.fn().mockResolvedValue(null);

    await expect(steerRunningSession({ request }, "gw-1", "hi")).resolves.toEqual({});
  });

  it("propagates a kernel refusal so the composer can degrade to the queue", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(
        new GatewayRpcError("agent does not support steer", { method: "session.steer", code: 4010 }),
      );

    await expect(steerRunningSession({ request }, "gw-1", "hi")).rejects.toBeInstanceOf(GatewayRpcError);
  });
});

describe("网关掉线横幅", () => {
  afterEach(cleanup);

  it("online 时永不出现，非 online 也要等超过 2 秒阈值", () => {
    expect(gatewayOfflineNotice("open", 60_000)).toBeNull();
    expect(gatewayOfflineNotice("idle", 60_000)).toBeNull();
    expect(gatewayOfflineNotice("closed", GATEWAY_OFFLINE_NOTICE_DELAY_MS - 1)).toBeNull();
    expect(gatewayOfflineNotice("closed", GATEWAY_OFFLINE_NOTICE_DELAY_MS)).toEqual(
      expect.objectContaining({ tone: "offline" }),
    );
  });

  it("三级文案：正在重连 / 已断开 / 重连失败", () => {
    expect(gatewayOfflineNotice("connecting", 2_000)?.title).toBe("正在重连网关…");
    expect(gatewayOfflineNotice("closed", 2_000)?.title).toBe("连接已断开");
    expect(gatewayOfflineNotice("error", 2_000)).toEqual(
      expect.objectContaining({ tone: "failed", title: "重连失败" }),
    );
  });

  it("横幅渲染状态色并让「立即重试」回调一次", () => {
    const onRetry = vi.fn();
    const notice = gatewayOfflineNotice("error", 2_000);
    expect(notice).not.toBeNull();
    render(<GatewayOfflineBanner notice={notice!} onRetry={onRetry} />);

    expect(screen.getByRole("status").getAttribute("data-state")).toBe("failed");
    fireEvent.click(screen.getByRole("button", { name: /立即重试/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("Esc / 中止响应的落地判定", () => {
  it("回合还在跑：两种结局都落地", () => {
    expect(stopShouldApply({ runtimeIsBusy: true, outcome: { kind: "settle" } })).toBe(true);
    expect(
      stopShouldApply({
        runtimeIsBusy: true,
        outcome: { kind: "restore", userMessageId: "live-user-5", draftText: "再说一遍" },
      }),
    ).toBe(true);
  });

  it("空回合已经被内核跑完：Esc 仍然撤回，别把英文占位留在时间线", () => {
    expect(
      stopShouldApply({
        runtimeIsBusy: false,
        outcome: { kind: "restore", userMessageId: "live-user-5", draftText: "再说一遍" },
      }),
    ).toBe(true);
  });

  it("已经答完的那一轮：Esc 不落地，不会把提问撤掉", () => {
    expect(stopShouldApply({ runtimeIsBusy: false, outcome: { kind: "settle" } })).toBe(false);
  });
});
