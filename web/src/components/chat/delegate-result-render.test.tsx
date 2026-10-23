// @vitest-environment jsdom
import ReactDOMServer from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { MessageTimeline } from "./message-timeline";
import type { ChatMessage, ChatToolItem } from "./chat-types";

// 回归：delegate_task 的回报正文只允许出现在子代理运行卡里。任何把它当普通
// 工具输出再渲染一遍的路径（通用工具卡的 <pre>、折叠行里的 JSON 大块）都算
// 重复展示。

const REPORT_MARKER = "子代理回报 9f2c3d";
const DELEGATE_OUTPUT = `${REPORT_MARKER} — {"status":"dispatched","goals":["审计 host-hub 接口"]}`;

const renderTimeline = (messages: ChatMessage[]) =>
  ReactDOMServer.renderToStaticMarkup(
    <MemoryRouter>
      <MessageTimeline messages={messages} subagentSessionIds={["sess-1"]} />
    </MemoryRouter>,
  );

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function markerHosts(doc: Document, marker: string): Element[] {
  const hits: Element[] = [];
  doc.querySelectorAll("body *").forEach((element) => {
    if (!element.textContent?.includes(marker)) return;
    const childHits = Array.from(element.children).some((child) =>
      child.textContent?.includes(marker),
    );
    if (!childHits) hits.push(element);
  });
  return hits;
}

function delegateTool(overrides: Partial<ChatToolItem> = {}): ChatToolItem {
  return {
    tool_id: "call_delegate_1",
    name: "delegate_task",
    status: "done",
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_012_000,
    summary: DELEGATE_OUTPUT,
    arguments: { tasks: [{ goal: "审计 host-hub 接口" }] },
    ...overrides,
  };
}

function expectOnlyInsideDelegateCard(html: string) {
  const doc = parse(html);
  const hosts = markerHosts(doc, REPORT_MARKER);
  expect(hosts.length).toBeGreaterThan(0);
  for (const host of hosts) {
    expect(host.closest("[data-delegate-card]")).not.toBeNull();
  }
  const strayPres = Array.from(doc.querySelectorAll("pre")).filter(
    (pre) =>
      pre.textContent?.includes(REPORT_MARKER) && pre.closest("[data-delegate-card]") === null,
  );
  expect(strayPres).toEqual([]);
}

describe("delegate 回报不在卡片外重复渲染", () => {
  it("blocks 路径：delegate 结果只出现在运行卡内", () => {
    const html = renderTimeline([
      {
        id: "assistant-1",
        role: "assistant",
        createdAt: 1_700_000_000_000,
        status: "complete",
        blocks: [
          { type: "tool", tool: delegateTool() },
          { type: "text", text: "子代理回报如下。" },
        ],
      } as unknown as ChatMessage,
    ]);

    expect(html).toContain("data-delegate-card");
    expectOnlyInsideDelegateCard(html);
  });

  it("只有 tools、没有 blocks 的兜底消息：delegate 结果仍走运行卡", () => {
    const html = renderTimeline([
      {
        id: "assistant-2",
        role: "assistant",
        createdAt: 1_700_000_000_000,
        status: "complete",
        text: "子代理回报如下。",
        tools: [delegateTool({ tool_id: "call_delegate_2" })],
      } as unknown as ChatMessage,
    ]);

    expect(html).toContain("data-delegate-card");
    expectOnlyInsideDelegateCard(html);
  });

  it("role=tool 的工具行消息：delegate 结果仍走运行卡", () => {
    const html = renderTimeline([
      {
        id: "tool-1",
        role: "tool",
        createdAt: 1_700_000_000_000,
        status: "complete",
        tools: [delegateTool({ tool_id: "call_delegate_3" })],
      } as unknown as ChatMessage,
    ]);

    expect(html).toContain("data-delegate-card");
    expectOnlyInsideDelegateCard(html);
  });

  it("非 delegate 工具不受影响：输出仍进通用工具卡", () => {
    const html = renderTimeline([
      {
        id: "assistant-3",
        role: "assistant",
        createdAt: 1_700_000_000_000,
        status: "complete",
        blocks: [
          {
            type: "tool",
            tool: {
              tool_id: "call_read_1",
              name: "read_file",
              status: "error",
              startedAt: 1_700_000_000_000,
              completedAt: 1_700_000_001_000,
              error: "读取失败 7b1e",
            },
          },
        ],
      } as unknown as ChatMessage,
    ]);

    const doc = parse(html);
    expect(doc.querySelector("[data-delegate-card]")).toBeNull();
    const hosts = markerHosts(doc, "读取失败 7b1e");
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) {
      expect(host.closest("[data-delegate-card]")).toBeNull();
    }
  });
});
