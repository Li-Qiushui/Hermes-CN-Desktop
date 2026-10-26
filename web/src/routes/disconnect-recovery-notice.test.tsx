// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider, getDefaultStore, useAtomValue } from "jotai";
import { useMemo } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hermesUIMessagesToChatMessages, mergeHermesUIMessages } from "@/components/chat/message-adapter";
import { MessageTimeline } from "@/components/chat/message-timeline";
import { useGateway } from "@/hooks/use-gateway";
import {
  chatRuntimeBySessionAtom,
  ensureChatSessionAtom,
  gwConnectionAtom,
  gwSessionIdAtom,
  startPromptAtom,
} from "@/stores/chat";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener() {}
  removeEventListener() {}

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  close(code?: number) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(code === undefined ? undefined : { code });
  }

  send(data: string) {
    this.sent.push(data);
  }

  frames(): any[] {
    return this.sent
      .map((data) => {
        try {
          return JSON.parse(data);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  framesOf(method: string): any[] {
    return this.frames().filter((frame) => frame.method === method);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitForFrame(ws: MockWebSocket, method: string): Promise<any> {
  for (let index = 0; index < 200; index += 1) {
    const [frame] = ws.framesOf(method);
    if (frame) return frame;
    await tick();
  }
  throw new Error(`no ${method} frame was sent`);
}

const feed = (ws: MockWebSocket, type: string, sessionId: string, payload: unknown = {}) => {
  ws.onmessage?.({
    data: JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: { type, session_id: sessionId, payload },
    }),
  });
};

const respond = (ws: MockWebSocket, id: string, result: unknown) => {
  ws.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, result }) });
};

function Probe() {
  useGateway();
  const connection = useAtomValue(gwConnectionAtom);
  const sessionId = useAtomValue(gwSessionIdAtom);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const messages = useMemo(
    () =>
      hermesUIMessagesToChatMessages(
        mergeHermesUIMessages([], sessionId ? (runtimeBySession[sessionId]?.messages ?? []) : []),
      ),
    [runtimeBySession, sessionId],
  );
  return (
    <div>
      <span data-testid="connection">{connection}</span>
      <MessageTimeline messages={messages} />
    </div>
  );
}

async function boot() {
  const store = getDefaultStore();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <MemoryRouter initialEntries={["/tasks/p-1"]}>
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={store}>
          <Probe />
        </JotaiProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  const { getGatewayClient } = await import("@/lib/gateway-client");
  const client = getGatewayClient();
  const connecting = client.connect();
  const first = MockWebSocket.instances[0]!;
  await act(async () => {
    first.open();
    await connecting;
    await tick();
  });
  return { store, client, view, first };
}

describe("断线灰卡（真实连接态驱动）", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    (HTMLElement.prototype as unknown as { scrollTo: unknown }).scrollTo = vi.fn();
    (window as unknown as { __HERMES_SESSION_TOKEN__?: string }).__HERMES_SESSION_TOKEN__ =
      "token";
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("杀内核 → 连接态掉线置断线标记 → resume(running:false) 后时间线渲染出灰卡", async () => {
    const { store, client, first } = await boot();
    expect(store.get(gwConnectionAtom)).toBe("open");

    act(() => {
      store.set(ensureChatSessionAtom, "rt-1");
      store.set(gwSessionIdAtom, "rt-1");
      store.set(startPromptAtom, { sessionId: "rt-1", text: "跑 sleep 90; echo alive" });
    });
    act(() => {
      feed(first, "message.start", "rt-1");
      feed(first, "message.delta", "rt-1", { text: "开始跑命令" });
    });
    expect(store.get(chatRuntimeBySessionAtom)["rt-1"]?.streamStatus).toBe("streaming");

    const killedAt = Date.now();
    await act(async () => {
      first.close();
      await tick();
    });

    const connectionAfterClose = store.get(gwConnectionAtom);
    const runtimeAfterClose = store.get(chatRuntimeBySessionAtom)["rt-1"];
    expect(connectionAfterClose).not.toBe("open");
    expect(runtimeAfterClose?.pendingDisconnectNotice).toBe(true);
    expect(runtimeAfterClose?.streamStatus).toBe("connecting");
    expect(Date.now() - killedAt).toBeLessThan(100);

    const { getGatewayClient } = await import("@/lib/gateway-client");
    const reconnected = getGatewayClient().connect();
    const second = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    expect(second).not.toBe(first);
    await act(async () => {
      second.open();
      await reconnected;
      await tick();
    });

    const resumeFrame = await waitForFrame(second, "session.resume");
    await act(async () => {
      respond(second, resumeFrame.id, {
        session_id: "rt-2",
        resumed: "p-1",
        message_count: 1,
        messages: [
          { role: "user", content: "跑 sleep 90; echo alive", created_at: killedAt - 2_000 },
        ],
        running: false,
        status: "idle",
        open_requests: [],
      });
      await tick();
    });

    expect(store.get(gwSessionIdAtom)).toBe("rt-2");
    expect(screen.getByTestId("connection").textContent).toBe("open");
    expect(
      screen.getByText("连接已恢复，但上一轮已被中断，输出可能不完整"),
    ).toBeTruthy();
  });
});
