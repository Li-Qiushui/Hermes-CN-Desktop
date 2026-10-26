import { describe, expect, it } from "vitest";
import type { HermesUIMessage, SessionMessage } from "@hermes/protocol";

import {
  hermesUIMessagesToChatMessages,
  storedMessagesToChatMessages,
} from "./message-adapter";
import { copyableMessageText } from "./message-timeline";
import { messageRoundMarkdown } from "./message-copy";

function sessionMessage(overrides: Partial<SessionMessage>): SessionMessage {
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

describe("MEDIA 标记进消息模型", () => {
  it("assistant 文本落成 text + media 块，正文不再带标记", () => {
    const [message] = storedMessagesToChatMessages([
      sessionMessage({ content: "产出在这里：\nMEDIA:/tmp/plot.png\n收工" }),
    ]);

    expect(message?.blocks?.map((block) => block.type)).toEqual(["text", "media"]);
    expect(message?.text).toBe("产出在这里：\n收工");
    expect(message?.media).toEqual([{ path: "/tmp/plot.png", kind: "image", name: "plot.png" }]);
  });

  it("多个不同 kind 的标记共用一块 media，图片不进 images 链", () => {
    const [message] = storedMessagesToChatMessages([
      sessionMessage({
        content: "MEDIA:/tmp/a.mp3\nMEDIA:C:\\Users\\Li Qiushui\\b.mp4\nMEDIA:/tmp/plot.png",
      }),
    ]);

    const mediaBlock = message?.blocks?.find((block) => block.type === "media");
    expect(mediaBlock && mediaBlock.type === "media" ? mediaBlock.items.map((i) => i.kind) : []).toEqual([
      "audio",
      "video",
      "image",
    ]);
    expect(message?.text).toBeUndefined();
    expect(message?.images).toBeUndefined();
  });

  it("复制与整轮导出拿到的都是去掉标记的干净文本", () => {
    const [message] = storedMessagesToChatMessages([
      sessionMessage({ content: "看这个 MEDIA:/tmp/shot.png 就懂" }),
    ]);

    expect(message && copyableMessageText(message)).toBe("看这个 就懂");
    expect(message && messageRoundMarkdown(message)).toBe("## Hermes\n\n看这个 就懂");
  });

  it("user 消息同样剥标记，media 挂到消息上（无 blocks）", () => {
    const [message] = hermesUIMessagesToChatMessages([
      uiMessage({
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "MEDIA:'/tmp/我的 录音.m4a'" }],
      }),
    ]);

    expect(message?.blocks).toBeUndefined();
    expect(message?.text).toBeUndefined();
    expect(message?.media).toEqual([{ path: "/tmp/我的 录音.m4a", kind: "audio", name: "我的 录音.m4a" }]);
  });

  it("只有标记没有正文也保留这条消息", () => {
    const [message] = storedMessagesToChatMessages([sessionMessage({ content: "MEDIA:/tmp/only.png" })]);

    expect(message).toBeTruthy();
    expect(message?.text).toBeUndefined();
    expect(message?.media).toHaveLength(1);
  });
});
