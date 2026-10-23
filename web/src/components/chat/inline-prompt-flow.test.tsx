// @vitest-environment jsdom
import type { ReactNode } from "react";
import { createStore, Provider } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.fn();
const respondMock = vi.fn();

vi.mock("@/lib/gateway-client", () => ({
  getGatewayClient: () => ({
    request: requestMock,
    respondToServerRequest: respondMock,
    onServerRequest: () => () => {},
    on: () => () => {},
    reopenServerRequest: () => {},
  }),
}));

import { MessageTimeline } from "./message-timeline";
import { InlinePromptFlow } from "./inline-prompt-flow";
import { GlobalPromptLayer } from "@/components/prompts/global-prompt-layer";
import { redeliverOpenRequests, serverPromptsAtom } from "@/lib/server-request-bridge";
import type { ClarifyQaRecord } from "@/lib/inline-prompts";
import type { PendingPrompt } from "@/stores/chat";
import { clarifyQaLogAtom, inlinePromptClaimsAtom } from "@/stores/inline-prompts";
import type { ChatMessage } from "./chat-types";

let remainingQueue: string[][] = [];

beforeEach(() => {
  Element.prototype.scrollTo = (() => {}) as unknown as typeof Element.prototype.scrollTo;
  remainingQueue = [];
  requestMock.mockReset();
  requestMock.mockImplementation(async () => ({
    status: "ok",
    remaining: remainingQueue.shift() ?? [],
  }));
  respondMock.mockReset();
  respondMock.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
});

function toolMessage(toolId: string, status: "running" | "done"): ChatMessage {
  return {
    id: "m-assistant",
    role: "assistant",
    createdAt: 1,
    blocks: [
      {
        type: "tool",
        tool: { tool_id: toolId, name: "clarify", status, startedAt: 1 },
      },
    ],
  };
}

function clarifyPrompt(
  requestId: string,
  index: number,
  question: string,
  choices: string[],
): PendingPrompt {
  return {
    kind: "clarify",
    promptId: `${requestId}:q${index}`,
    generation: 0,
    sessionId: "gw-s1",
    question,
    choices,
    multiSelect: false,
    receivedAt: 100 + index,
    transport: "server-request",
    serverRequestId: requestId,
    questionId: `q${index}`,
  };
}

function registerBatch(requestId: string, questions: { qid: string; question: string; choices: string[] }[]) {
  redeliverOpenRequests([
    {
      id: requestId,
      method: "clarify",
      params: {
        session_id: "gw-s1",
        questions: questions.map((item) => ({ ...item, multi_select: false })),
      },
    },
  ]);
  return questions.map((item, index) =>
    clarifyPrompt(requestId, index + 1, item.question, item.choices),
  );
}

function renderInline(options: {
  prompts?: PendingPrompt[];
  messages?: ChatMessage[];
  qa?: ClarifyQaRecord[];
}) {
  const store = createStore();
  if (options.prompts) store.set(serverPromptsAtom, options.prompts);
  if (options.qa) store.set(clarifyQaLogAtom, options.qa);
  const messages = options.messages ?? [toolMessage("tool-1", "running")];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <InlinePromptFlow messages={messages} sessionIds={["gw-s1"]}>
            {(trailing: ReactNode) => <MessageTimeline messages={messages} trailing={trailing} />}
          </InlinePromptFlow>
        </MemoryRouter>
      </QueryClientProvider>
    </Provider>,
  );
  return { ...view, store };
}

function lockCalls() {
  return requestMock.mock.calls
    .filter((call) => call[0] === "clarify.lock")
    .map((call) => call[1] as { question_id: string; answer: string | null });
}

describe("内联 clarify 卡", () => {
  it("一批 3 题合成一张卡，翻页不丢已选", () => {
    const prompts = registerBatch("srq-a", [
      { qid: "q1", question: "选个颜色", choices: ["红色", "蓝色 (Recommended)"] },
      { qid: "q2", question: "选个尺寸", choices: ["小", "大"] },
      { qid: "q3", question: "确认?", choices: ["是", "否"] },
    ]);
    renderInline({ prompts });

    expect(screen.getAllByTestId("clarify-inline-card")).toHaveLength(1);
    expect(screen.getByTestId("clarify-inline-counter").textContent).toBe("1 / 3");
    expect(screen.getByText("选个颜色")).toBeTruthy();
    expect(screen.queryByText("选个尺寸")).toBeNull();
    expect(screen.getByText("蓝色")).toBeTruthy();
    expect(screen.getByText("推荐")).toBeTruthy();

    fireEvent.click(screen.getByText("红色"));
    fireEvent.click(screen.getByText("下一题"));
    expect(screen.getByTestId("clarify-inline-counter").textContent).toBe("2 / 3");
    expect(screen.getByText("选个尺寸")).toBeTruthy();

    fireEvent.click(screen.getByText("上一题"));
    expect(screen.getByTestId("clarify-inline-counter").textContent).toBe("1 / 3");
    const red = screen.getByText("红色").closest("button");
    expect(red?.getAttribute("data-selected")).toBe("true");

    fireEvent.keyDown(window, { key: "2" });
    expect(screen.getByText("蓝色").closest("button")?.getAttribute("data-selected")).toBe("true");
    expect(screen.getByText("红色").closest("button")?.getAttribute("data-selected")).toBeNull();
  });

  it("最后一题确认后按原顺序逐条发送，且只发一次", async () => {
    const prompts = registerBatch("srq-b", [
      { qid: "q1", question: "选个颜色", choices: ["红色", "蓝色"] },
      { qid: "q2", question: "选个尺寸", choices: ["小", "大"] },
      { qid: "q3", question: "确认?", choices: ["是", "否"] },
    ]);
    remainingQueue = [["q2", "q3"], ["q3"], []];
    renderInline({ prompts });

    fireEvent.click(screen.getByText("红色"));
    fireEvent.click(screen.getByText("下一题"));
    fireEvent.click(screen.getByText("小"));
    fireEvent.click(screen.getByText("下一题"));
    fireEvent.click(screen.getByText("是"));
    fireEvent.click(screen.getByText("确认并继续"));

    await waitFor(() => expect(lockCalls()).toHaveLength(3));
    expect(lockCalls().map((call) => call.question_id)).toEqual(["q1", "q2", "q3"]);
    expect(lockCalls().map((call) => call.answer)).toEqual(["红色", "小", "是"]);

    fireEvent.click(screen.getByText("确认并继续"));
    await waitFor(() => expect(lockCalls()).toHaveLength(3));
  });

  it("跳过这轮发 null，不是空字符串", async () => {
    const prompts = registerBatch("srq-c", [
      { qid: "q1", question: "选个颜色", choices: ["红色", "蓝色"] },
      { qid: "q2", question: "选个尺寸", choices: ["小", "大"] },
      { qid: "q3", question: "确认?", choices: ["是", "否"] },
    ]);
    remainingQueue = [["q2", "q3"], ["q3"], []];
    renderInline({ prompts });

    fireEvent.click(screen.getByText("跳过这轮"));

    await waitFor(() => expect(lockCalls()).toHaveLength(3));
    expect(lockCalls().map((call) => call.answer)).toEqual([null, null, null]);
  });

  it("答完在同一位置换成只读 Q&A，空答案显示已跳过", () => {
    renderInline({
      messages: [toolMessage("tool-1", "done")],
      qa: [
        {
          requestId: "srq-d",
          sessionId: "gw-s1",
          toolId: "tool-1",
          entries: [
            { question: "选个颜色", answer: "红色" },
            { question: "选个尺寸", answer: null },
          ],
          at: 1,
        },
      ],
    });

    const card = screen.getByTestId("clarify-qa-card");
    expect(card).toBeTruthy();
    expect(screen.queryByTestId("clarify-inline-card")).toBeNull();
    expect(screen.getByText("选个颜色")).toBeTruthy();
    expect(screen.getByText("红色")).toBeTruthy();
    expect(screen.getByText("已跳过")).toBeTruthy();
  });
});

describe("内联审批堆叠", () => {
  it("堆叠计数 1 / 2，始终允许要二次确认", async () => {
    redeliverOpenRequests([
      {
        id: "srq-e1",
        method: "approval",
        params: {
          session_id: "gw-s1",
          request_id: "apr-1",
          command: "rm -rf build",
          description: "删除构建产物",
          choices: ["once", "session", "always", "deny"],
        },
      },
      {
        id: "srq-e2",
        method: "approval",
        params: {
          session_id: "gw-s1",
          request_id: "apr-2",
          command: "git push",
          choices: ["once", "deny"],
        },
      },
    ]);

    const approvals: PendingPrompt[] = [
      {
        kind: "approval",
        promptId: "apr-1",
        generation: 0,
        sessionId: "gw-s1",
        command: "rm -rf build",
        description: "删除构建产物",
        choices: ["once", "session", "always", "deny"],
        multiSelect: false,
        receivedAt: 100,
        transport: "server-request",
        serverRequestId: "srq-e1",
      },
      {
        kind: "approval",
        promptId: "apr-2",
        generation: 0,
        sessionId: "gw-s1",
        command: "git push",
        choices: ["once", "deny"],
        multiSelect: false,
        receivedAt: 101,
        transport: "server-request",
        serverRequestId: "srq-e2",
      },
    ];

    renderInline({ prompts: approvals, messages: [toolMessage("tool-1", "running")] });

    expect(screen.getAllByTestId("approval-inline-card")).toHaveLength(1);
    expect(screen.getByTestId("approval-inline-counter").textContent).toBe("1 / 2");
    expect(screen.getByText("rm -rf build")).toBeTruthy();

    fireEvent.click(screen.getByText("总是允许"));
    expect(respondMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("approval-always-confirm")).toBeTruthy();

    fireEvent.click(screen.getByText("确认始终允许"));
    await waitFor(() => expect(respondMock).toHaveBeenCalledTimes(1));
    expect(respondMock).toHaveBeenCalledWith("srq-e1", { choice: "always" });
  });
});

describe("内联认领失败时退回浮层", () => {
  it("没有运行中回合就不认领，请求回到浮层", () => {
    const prompts = registerBatch("srq-f", [
      { qid: "q1", question: "选个颜色", choices: ["红色", "蓝色"] },
      { qid: "q2", question: "选个尺寸", choices: ["小", "大"] },
      { qid: "q3", question: "确认?", choices: ["是", "否"] },
    ]);
    const messages = [toolMessage("tool-1", "done")];
    const store = createStore();
    store.set(serverPromptsAtom, prompts);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <Provider store={store}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <InlinePromptFlow messages={messages} sessionIds={["gw-s1"]}>
              {(trailing: ReactNode) => <MessageTimeline messages={messages} trailing={trailing} />}
            </InlinePromptFlow>
            <GlobalPromptLayer />
          </MemoryRouter>
        </QueryClientProvider>
      </Provider>,
    );

    expect(screen.queryByTestId("clarify-inline-card")).toBeNull();
    expect(store.get(inlinePromptClaimsAtom)).toEqual([]);
    expect(screen.getByText("第 1 / 共 3 条")).toBeTruthy();
  });
});
