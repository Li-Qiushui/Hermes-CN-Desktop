// @vitest-environment jsdom
import { createStore, getDefaultStore, Provider } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.fn(async () => ({ status: "resolved", prompt_id: "p" }));
const respondMock = vi.fn();

vi.mock("@/lib/gateway-client", () => ({
  getGatewayClient: () => ({
    request: requestMock,
    respondToServerRequest: respondMock,
    onServerRequest: () => () => {},
    on: () => () => {},
  }),
}));

vi.mock("@/lib/session-map", () => ({
  resolvePersistentSessionId: (id: string) => id,
}));

import { GlobalPromptLayer } from "./global-prompt-layer";
import { redeliverOpenRequests, serverPromptsAtom } from "@/lib/server-request-bridge";
import { chatRuntimeBySessionAtom, createEmptyChatRuntime, gwSessionIdAtom, reduceGatewayEvent } from "@/stores/chat";
import { activeSessionIdAtom } from "@/stores/ui";

function runtimeWith(event: Record<string, unknown>, sessionId = "s1") {
  return reduceGatewayEvent(
    createEmptyChatRuntime(1),
    { ...event, session_id: sessionId } as never,
    Date.now(),
  );
}

interface LayerOptions {
  serverPrompts?: unknown[];
  activeSessionId?: string | null;
  gwSessionId?: string | null;
}

function renderLayer(runtime: ReturnType<typeof createEmptyChatRuntime>, options: LayerOptions = {}) {
  const store = createStore();
  store.set(chatRuntimeBySessionAtom, { s1: runtime });
  if (options.serverPrompts) store.set(serverPromptsAtom, options.serverPrompts as never);
  if (options.activeSessionId) store.set(activeSessionIdAtom, options.activeSessionId);
  if (options.gwSessionId) store.set(gwSessionIdAtom, options.gwSessionId);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <GlobalPromptLayer />
        </MemoryRouter>
      </QueryClientProvider>
    </Provider>,
  );
  return { ...rendered, store };
}

const approvalRuntime = () =>
  runtimeWith({
    type: "approval.request",
    payload: {
      prompt_id: "p1",
      execution_generation: 7,
      command: "rm -rf build",
      description: "删除构建产物",
      choices: ["once", "session", "always", "deny"],
      timeout_s: 300,
    },
  });

const clarifyRuntime = (payload: Record<string, unknown>) =>
  runtimeWith({
    type: "clarify.request",
    payload: { prompt_id: "q1", execution_generation: 3, ...payload },
  });

beforeEach(() => {
  requestMock.mockClear();
  requestMock.mockResolvedValue({ status: "resolved", prompt_id: "p" });
  respondMock.mockClear();
  respondMock.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
});

describe("GlobalPromptLayer", () => {
  it("renders nothing without a pending prompt", () => {
    const { container } = renderLayer(createEmptyChatRuntime(1));
    expect(container.querySelector("[role=dialog]")).toBeNull();
  });

  it("renders the approval card with kernel-ordered buttons, deny last", () => {
    renderLayer(approvalRuntime());
    expect(screen.getByText("需要确认执行")).toBeTruthy();
    expect(screen.getByText("rm -rf build")).toBeTruthy();
    expect(screen.getByText("删除构建产物")).toBeTruthy();
    expect(screen.getByText("第 1 / 共 1 条")).toBeTruthy();
    const labels = screen
      .getAllByRole("button")
      .map((node) => node.textContent ?? "")
      .filter((text) => ["允许一次", "本会话内允许", "总是允许", "拒绝"].includes(text));
    expect(labels).toEqual(["允许一次", "本会话内允许", "总是允许", "拒绝"]);
  });

  it("shows the countdown for a prompt with timeout_s", () => {
    renderLayer(approvalRuntime());
    expect(screen.getByText("5:00")).toBeTruthy();
  });

  it("submits approval.respond with the four kernel fields", async () => {
    renderLayer(approvalRuntime());
    fireEvent.click(screen.getByText("允许一次"));
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    const [method, params] = requestMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(method).toBe("approval.respond");
    expect(params).toEqual({
      session_id: "s1",
      execution_generation: 7,
      prompt_id: "p1",
      choice: "once",
    });
    expect(Object.keys(params).sort()).toEqual([
      "choice",
      "execution_generation",
      "prompt_id",
      "session_id",
    ]);
  });

  it("surfaces the raw gateway error text in the card", async () => {
    requestMock.mockRejectedValueOnce(new Error("invalid_params"));
    renderLayer(approvalRuntime());
    fireEvent.click(screen.getByText("允许一次"));
    await waitFor(() => expect(screen.getByText(/invalid_params/)).toBeTruthy());
  });

  it("submits a single-select clarify answer on click", async () => {
    renderLayer(clarifyRuntime({ question: "先做前端还是后端？", choices: ["前端", "后端"] }));
    expect(screen.getByText("需要你回答")).toBeTruthy();
    fireEvent.click(screen.getByText("后端"));
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    const [method, params] = requestMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(method).toBe("clarify.respond");
    expect(params).toEqual({
      session_id: "s1",
      execution_generation: 3,
      prompt_id: "q1",
      answer: "后端",
    });
  });

  it("joins a multi-select answer with 、 after 确认", async () => {
    renderLayer(
      clarifyRuntime({
        question: "先做哪些？",
        choices: ["前端", "后端", "文档"],
        multi_select: true,
      }),
    );
    fireEvent.click(screen.getByText("前端"));
    fireEvent.click(screen.getByText("后端"));
    fireEvent.click(screen.getByText("确认"));
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    const [, params] = requestMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(params.answer).toBe("前端、后端");
  });

  it("submits a typed answer for an open-ended clarify", async () => {
    renderLayer(clarifyRuntime({ question: "说说你的想法" }));
    const input = screen.getByLabelText("回答") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  先做前端  " } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    const [method, params] = requestMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(method).toBe("clarify.respond");
    expect(params.answer).toBe("先做前端");
  });
});

describe("GlobalPromptLayer · 按会话停靠", () => {
  const store = getDefaultStore();

  const approvalEvent = {
    type: "approval.request",
    payload: {
      prompt_id: "p-bg",
      execution_generation: 7,
      command: "rm -rf build",
      description: "删除构建产物",
      choices: ["once", "deny"],
    },
  };

  const renderDefault = (options: {
    runtimes?: Record<string, ReturnType<typeof createEmptyChatRuntime>>;
    serverRequests?: unknown[];
    activeSessionId?: string | null;
  }) => {
    store.set(serverPromptsAtom, []);
    store.set(gwSessionIdAtom, null);
    store.set(chatRuntimeBySessionAtom, options.runtimes ?? {});
    if (options.serverRequests) redeliverOpenRequests(options.serverRequests);
    if (options.activeSessionId !== undefined) store.set(activeSessionIdAtom, options.activeSessionId);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <GlobalPromptLayer />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  };

  it("当前会话的卡照常主展示", () => {
    renderDefault({
      runtimes: { s1: runtimeWith(approvalEvent, "s1") },
      activeSessionId: "s1",
    });
    expect(screen.getByText("rm -rf build")).toBeTruthy();
    expect(screen.queryByText(/个会话待处理/)).toBeNull();
  });

  it("后台会话的卡不进主位置，只留一条计数条", () => {
    renderDefault({
      runtimes: { s2: runtimeWith(approvalEvent, "s2") },
      activeSessionId: "s1",
    });
    expect(screen.queryByText("rm -rf build")).toBeNull();
    expect(screen.getByText("1 个会话待处理")).toBeTruthy();
  });

  it("点计数条会切到那个会话", () => {
    renderDefault({
      runtimes: { s2: runtimeWith(approvalEvent, "s2") },
      activeSessionId: "s1",
    });
    fireEvent.click(screen.getByText("1 个会话待处理"));
    expect(store.get(activeSessionIdAtom)).toBe("s2");
  });

  it("vault.save_login 双字段卡拼成 JSON 提交", () => {
    renderDefault({
      activeSessionId: "s1",
      serverRequests: [
        {
          id: "srq-vault",
          method: "vault.save_login",
          params: {
            session_id: "s1",
            origin: "https://github.com",
            site: "github.com",
          },
        },
      ],
    });
    expect(screen.getByText("保存到 github.com（https://github.com）?")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("账号"), { target: { value: "  me@x.dev  " } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "pw123" } });
    fireEvent.click(screen.getByText("保存"));
    expect(respondMock).toHaveBeenCalledWith("srq-vault", {
      value: JSON.stringify({ identifier: "me@x.dev", password: "pw123" }),
    });
  });

  it("双字段卡点跳过发空串", () => {
    renderDefault({
      activeSessionId: "s1",
      serverRequests: [
        {
          id: "srq-vault-skip",
          method: "vault.save_login",
          params: { session_id: "s1", origin: "https://x.dev", site: "x.dev" },
        },
      ],
    });
    fireEvent.click(screen.getByText("跳过"));
    expect(respondMock).toHaveBeenCalledWith("srq-vault-skip", { value: "" });
  });

  it("setup 卡点一行发 {picked: id}", () => {
    renderDefault({
      activeSessionId: "s1",
      serverRequests: [
        {
          id: "srq-setup",
          method: "setup_choose",
          params: {
            session_id: "s1",
            kind: "theme",
            question: "选个主题",
            options: [
              { id: "dark", label: "深色" },
              { id: "light", label: "浅色" },
            ],
          },
        },
      ],
    });
    expect(screen.getByText("选个主题")).toBeTruthy();
    fireEvent.click(screen.getByText("浅色"));
    expect(respondMock).toHaveBeenCalledWith("srq-setup", { picked: "light" });
  });

  it("应答帧没发出去时卡片留在界面上并提示可重试", () => {
    renderDefault({
      activeSessionId: "s1",
      serverRequests: [
        {
          id: "srq-offline",
          method: "approval",
          params: {
            session_id: "s1",
            request_id: "apr-offline",
            command: "rm -rf build",
            choices: ["once", "deny"],
          },
        },
      ],
    });

    respondMock.mockReturnValueOnce(false);
    fireEvent.click(screen.getByText("允许一次"));
    expect(screen.getByText("发送失败，正在重连，可重试")).toBeTruthy();
    expect(screen.getByText("rm -rf build")).toBeTruthy();

    fireEvent.click(screen.getByText("允许一次"));
    expect(screen.queryByText("rm -rf build")).toBeNull();
  });

  it("clarify 锁帧发不出去时卡片保留并提示可重试", async () => {
    renderDefault({
      activeSessionId: "s1",
      serverRequests: [
        {
          id: "srq-clarify-offline",
          method: "clarify",
          params: {
            session_id: "s1",
            questions: [
              { qid: "q0", question: "选个颜色", choices: ["蓝色"], multi_select: false },
            ],
          },
        },
      ],
    });

    requestMock.mockRejectedValueOnce(new Error("WebSocket not connected"));
    fireEvent.click(screen.getByText("蓝色"));
    await waitFor(() => expect(screen.getByText("发送失败，正在重连，可重试")).toBeTruthy());
    expect(screen.getByText("选个颜色")).toBeTruthy();

    requestMock.mockResolvedValueOnce({ status: "ok", remaining: [] } as never);
    fireEvent.click(screen.getByText("蓝色"));
    await waitFor(() => expect(screen.queryByText("选个颜色")).toBeNull());
  });

  it("setup 卡自由输入发 {said}", () => {
    renderDefault({
      activeSessionId: "s1",
      serverRequests: [
        {
          id: "srq-setup-said",
          method: "setup_choose",
          params: {
            session_id: "s1",
            kind: "question",
            question: "想先做点什么？",
            options: [],
          },
        },
      ],
    });
    const input = screen.getByLabelText("回答") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "先做个原型" } });
    fireEvent.submit(input.closest("form")!);
    expect(respondMock).toHaveBeenCalledWith("srq-setup-said", { said: "先做个原型" });
  });
});
