import { describe, expect, it } from "vitest";
import type { HermesUIMessage, SessionMessage } from "@hermes/protocol";

import {
  hermesUIMessagesToChatMessages,
  legacySessionMessagesToHermesUIMessages,
  mergeHermesUIMessages,
} from "./message-adapter";

function uiMessage(overrides: Partial<HermesUIMessage> = {}): HermesUIMessage {
  return {
    id: "m1",
    sessionId: "s1",
    role: "assistant",
    createdAt: 100,
    status: "complete",
    parts: [],
    ...overrides,
  } as HermesUIMessage;
}

function storedRow(overrides: Partial<SessionMessage>): SessionMessage {
  return {
    id: 1,
    session_id: "s1",
    role: "assistant",
    content: null,
    tool_call_id: null,
    tool_calls: null,
    tool_name: null,
    timestamp: 100,
    token_count: null,
    finish_reason: null,
    reasoning: null,
    reasoning_details: null,
    codex_reasoning_items: null,
    reasoning_content: null,
    ...overrides,
  } as SessionMessage;
}

const WAV = "C:/Users/LiQiushui/Desktop/hermes-render-spec/samples/demo.wav";

describe("带 MEDIA 标记的助手消息只渲染一份", () => {
  it("只有 MEDIA 的 live 与 stored 副本合并成一条，不出现两个头像头", () => {
    const stored = mergeHermesUIMessages(
      [uiMessage({ id: "stored-1", parts: [{ type: "text", text: `MEDIA:${WAV}` }] })],
      [uiMessage({ id: "live-assistant-1", parts: [{ type: "text", text: `MEDIA:${WAV}` }] })],
    );

    expect(stored).toHaveLength(1);
    const [chat] = hermesUIMessagesToChatMessages(stored);
    expect(chat?.media).toEqual([{ path: WAV, kind: "audio", name: "demo.wav" }]);
  });

  it("一条消息带 2 个 MEDIA 标记时合并不重复：一块 media 块、两项", () => {
    const text = `MEDIA:${WAV}\nMEDIA:/tmp/plot.png`;
    const merged = mergeHermesUIMessages(
      [uiMessage({ id: "stored-1", parts: [{ type: "text", text }] })],
      [uiMessage({ id: "live-assistant-1", parts: [{ type: "text", text }] })],
    );

    expect(merged).toHaveLength(1);
    const [chat] = hermesUIMessagesToChatMessages(merged);
    const mediaBlocks = chat?.blocks?.filter((block) => block.type === "media") ?? [];
    expect(mediaBlocks).toHaveLength(1);
    expect(mediaBlocks[0]?.type === "media" ? mediaBlocks[0].items : []).toHaveLength(2);
    expect(chat?.media).toHaveLength(2);
  });

  it("live 副本的标记有空白差异也能合并（不靠原文逐字相等）", () => {
    const merged = mergeHermesUIMessages(
      [uiMessage({ id: "stored-1", parts: [{ type: "text", text: `MEDIA:${WAV}` }] })],
      [uiMessage({ id: "live-assistant-1", parts: [{ type: "text", text: `\nMEDIA:${WAV}\n` }] })],
    );

    expect(merged).toHaveLength(1);
  });

  it("正文夹 MEDIA 时文本仍按正文去重", () => {
    const merged = mergeHermesUIMessages(
      [uiMessage({ id: "stored-1", parts: [{ type: "text", text: `录好了\nMEDIA:${WAV}` }] })],
      [uiMessage({ id: "live-assistant-1", parts: [{ type: "text", text: `录好了\nMEDIA:${WAV}` }] })],
    );

    expect(merged).toHaveLength(1);
    const [chat] = hermesUIMessagesToChatMessages(merged);
    expect(chat?.text).toBe("录好了");
  });

  it("两个不同 MEDIA 的回合不会被误合并", () => {
    const merged = mergeHermesUIMessages(
      [uiMessage({ id: "stored-1", parts: [{ type: "text", text: `MEDIA:${WAV}` }] })],
      [uiMessage({ id: "live-assistant-1", parts: [{ type: "text", text: "MEDIA:/tmp/other.mp3" }] })],
    );

    expect(merged).toHaveLength(2);
  });

  it("stored 行与 live 副本的 MEDIA 数量不同不合并（不同产出）", () => {
    const merged = mergeHermesUIMessages(
      [uiMessage({ id: "stored-1", parts: [{ type: "text", text: `MEDIA:${WAV}` }] })],
      [
        uiMessage({
          id: "live-assistant-1",
          parts: [{ type: "text", text: `MEDIA:${WAV}\nMEDIA:/tmp/plot.png` }],
        }),
      ],
    );

    expect(merged).toHaveLength(2);
  });

  it("纯 MEDIA 的单条消息仍然渲染一块 media 块（不丢内容）", () => {
    const [chat] = hermesUIMessagesToChatMessages([
      uiMessage({ id: "stored-1", parts: [{ type: "text", text: `MEDIA:${WAV}` }] }),
    ]);
    expect(chat?.media).toHaveLength(1);
    expect(chat?.blocks?.filter((block) => block.type === "media")).toHaveLength(1);
  });

  it("legacy 持久化行（content 是 MEDIA 原文）也能与 live 副本合并", () => {
    const stored = legacySessionMessagesToHermesUIMessages([
      storedRow({ id: 11, content: `MEDIA:${WAV}` }),
    ]);
    const merged = mergeHermesUIMessages(stored, [
      uiMessage({ id: "live-assistant-1", parts: [{ type: "text", text: `MEDIA:${WAV}` }] }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("live-assistant-1");
  });
});
