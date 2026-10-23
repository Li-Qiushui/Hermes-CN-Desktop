// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { HermesUIMessage, MessagesResponse } from "@hermes/protocol";
import { hermesUIMessagesToChatMessages } from "@/components/chat/message-adapter";
import type { ChatMessage } from "@/components/chat/chat-types";
import {
  correctionTruncateRowId,
  locateStoredCorrectionRowId,
  resolveCorrectionRowId,
} from "./detail";

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
