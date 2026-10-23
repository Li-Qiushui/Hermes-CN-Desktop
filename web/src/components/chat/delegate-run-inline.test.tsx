import ReactDOMServer from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { MessageTimeline } from "./message-timeline";
import type { ChatMessage } from "./chat-types";

// 对话流接入回归：delegate_task 工具块必须升级成运行卡，而不是缩在
// "运行了 N 个工具" 的折叠行里 —— 子代理的 ticker 只能活在卡上。

const renderTimeline = (messages: ChatMessage[], sessionIds: string[] = ["sess-1"]) =>
  ReactDOMServer.renderToStaticMarkup(
    <MemoryRouter>
      <MessageTimeline messages={messages} subagentSessionIds={sessionIds} />
    </MemoryRouter>,
  );

function assistantWithDelegate(): ChatMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    createdAt: Date.now(),
    status: "streaming",
    blocks: [
      {
        type: "tool",
        tool: {
          tool_id: "call_delegate_1",
          name: "delegate_task",
          status: "running",
          startedAt: Date.now() - 5_000,
          arguments: { tasks: [{ goal: "审计 host-hub 接口" }, { goal: "清日志" }] },
        },
      },
      { type: "text", text: "已经派给子代理了。" },
    ],
  } as unknown as ChatMessage;
}

describe("对话流内的 delegate 运行卡", () => {
  it("delegate_task 块渲染成运行卡：子任务标题、按钮都在，且不进工具折叠行", () => {
    const html = renderTimeline([assistantWithDelegate()]);

    expect(html).toContain("data-delegate-card");
    expect(html).toContain("审计 host-hub 接口");
    expect(html).toContain("清日志");
    expect(html).toContain("展开完整日志");
    expect(html).toContain("2 个并行子任务");
    // 卡片自成一等公民：不能再被折成"运行了 N 个工具"。
    expect(html).not.toContain("delegate_task");
  });

  it("没有候选会话 id 时仍出卡（只是没有 live 进度），不崩", () => {
    const html = renderTimeline([assistantWithDelegate()], []);
    expect(html).toContain("data-delegate-card");
    expect(html).toContain("等待子代理输出");
  });
});
