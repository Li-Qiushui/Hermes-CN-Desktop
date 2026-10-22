// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useKanbanEvents } from "./use-kanban-events";
import { kanbanKeys } from "./use-kanban";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  message(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }

  serverClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
}

function wrapper(queryClient: QueryClient) {
  return function Provider({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

function seed(client: QueryClient): void {
  client.setQueryData(kanbanKeys.task("default", "t_a"), { task: { id: "t_a", title: "A", status: "todo" } });
  client.setQueryData(kanbanKeys.task("default", "t_b"), { task: { id: "t_b", title: "B", status: "todo" } });
  client.setQueryData(kanbanKeys.task("default", "t_other"), {
    task: { id: "t_other", title: "C", status: "todo" },
  });
  client.setQueryData(kanbanKeys.boardAll("default"), { columns: [] });
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
  window.__HERMES_RUNTIME__ = { platform: "web", sessionToken: "tok" };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window.__HERMES_RUNTIME__;
});

describe("useKanbanEvents", () => {
  it("用 since 建连，收到帧后精确失效 task query 与 board query", async () => {
    const client = makeClient();
    seed(client);
    const { result } = renderHook(() => useKanbanEvents({ slug: "default", since: 42 }), {
      wrapper: wrapper(client),
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    const socket = MockWebSocket.instances[0];
    expect(socket.url).toContain("/api/plugins/kanban/events");
    expect(socket.url).toContain("board=default");
    expect(socket.url).toContain("since=42");
    expect(socket.url).toContain("token=tok");

    act(() => socket.open());
    expect(result.current.status).toBe("open");

    await act(async () => {
      socket.message({
        cursor: 45,
        events: [
          { id: 43, task_id: "t_a", kind: "status" },
          { id: 44, task_id: "t_a", kind: "comment" },
          { id: 45, task_id: "t_b", kind: "run" },
        ],
      });
      await Promise.resolve();
    });

    expect(client.getQueryState(kanbanKeys.task("default", "t_a"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(kanbanKeys.task("default", "t_b"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(kanbanKeys.task("default", "t_other"))?.isInvalidated).toBe(false);
    expect(client.getQueryState(kanbanKeys.boardAll("default"))?.isInvalidated).toBe(true);
    expect(result.current.cursor).toBe(45);
  });

  it("断线后 1s、2s 指数退避，并用最新 cursor 续传", async () => {
    const client = makeClient();
    seed(client);
    renderHook(() => useKanbanEvents({ slug: "default", since: 10 }), { wrapper: wrapper(client) });

    const first = MockWebSocket.instances[0];
    act(() => first.serverClose());
    expect(MockWebSocket.instances).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(MockWebSocket.instances).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(MockWebSocket.instances).toHaveLength(2);

    const second = MockWebSocket.instances[1];
    act(() => second.open());
    await act(async () => {
      second.message({ cursor: 77, events: [] });
      await Promise.resolve();
    });

    act(() => second.serverClose());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(MockWebSocket.instances).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(MockWebSocket.instances).toHaveLength(3);
    expect(MockWebSocket.instances[2].url).toContain("since=77");
  });

  it("连续失败时退避 1s → 2s → 4s", async () => {
    const client = makeClient();
    seed(client);
    renderHook(() => useKanbanEvents({ slug: "default", since: 1 }), { wrapper: wrapper(client) });

    act(() => MockWebSocket.instances[0].serverClose());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(MockWebSocket.instances).toHaveLength(2);

    act(() => MockWebSocket.instances[1].serverClose());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(MockWebSocket.instances).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(MockWebSocket.instances).toHaveLength(3);

    act(() => MockWebSocket.instances[2].serverClose());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3999);
    });
    expect(MockWebSocket.instances).toHaveLength(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(MockWebSocket.instances).toHaveLength(4);
  });

  it("静止 60s 且仍在 OPEN：只失效看板，不重建连接", async () => {
    const client = makeClient();
    seed(client);
    const { result } = renderHook(() => useKanbanEvents({ slug: "default", since: 5 }), {
      wrapper: wrapper(client),
    });
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket.closed).toBe(false);
    expect(result.current.status).toBe("open");
    expect(client.getQueryState(kanbanKeys.boardAll("default"))?.isInvalidated).toBe(true);
  });

  it("半开连接静止 180s：重建事件流并用最新 cursor 续传", async () => {
    const client = makeClient();
    seed(client);
    const { result } = renderHook(() => useKanbanEvents({ slug: "default", since: 5 }), {
      wrapper: wrapper(client),
    });
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(179_000);
    });
    expect(socket.closed).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(socket.closed).toBe(true);
    expect(result.current.status).toBe("reconnecting");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toContain("since=5");
  });

  it("连接不在 OPEN 时心跳才重建事件流，并用最新 cursor 续传", async () => {
    const client = makeClient();
    seed(client);
    const { result } = renderHook(() => useKanbanEvents({ slug: "default", since: 5 }), {
      wrapper: wrapper(client),
    });
    const first = MockWebSocket.instances[0];
    act(() => first.open());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    // 连接掉出 OPEN（半死连接）：这才该重建
    first.readyState = 2;
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(first.closed).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(first.closed).toBe(true);
    expect(result.current.status).toBe("reconnecting");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toContain("since=5");
    act(() => MockWebSocket.instances[1].open());
    expect(result.current.status).toBe("open");
  });

  it("远程带路径前缀时事件流 URL 保留前缀", () => {
    const client = makeClient();
    window.__HERMES_RUNTIME__ = {
      platform: "web",
      sessionToken: "tok",
      apiBaseUrl: "https://gw.example.com/hermes",
    };
    renderHook(() => useKanbanEvents({ slug: "default", since: 3 }), { wrapper: wrapper(client) });

    const url = MockWebSocket.instances[0].url;
    expect(url.startsWith("wss://gw.example.com/hermes/api/plugins/kanban/events")).toBe(true);
    expect(url).toContain("since=3");
  });

  it("board 数据晚到时带上 since 重建事件流", async () => {
    const client = makeClient();
    seed(client);
    const { rerender } = renderHook(
      ({ since }: { since: number | null }) => useKanbanEvents({ slug: "default", since }),
      { wrapper: wrapper(client), initialProps: { since: null as number | null } },
    );
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).not.toContain("since=");
    const first = MockWebSocket.instances[0];
    act(() => first.open());

    await act(async () => {
      rerender({ since: 42 });
    });
    expect(first.closed).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toContain("since=42");
  });

  it("卸载时关闭 socket 且不再重连", async () => {
    const client = makeClient();
    const { unmount } = renderHook(() => useKanbanEvents({ slug: "default", since: 1 }), {
      wrapper: wrapper(client),
    });
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    unmount();
    expect(socket.closed).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("enabled=false 时不建连", () => {
    const client = makeClient();
    renderHook(() => useKanbanEvents({ slug: "default", since: 1, enabled: false }), {
      wrapper: wrapper(client),
    });
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});
