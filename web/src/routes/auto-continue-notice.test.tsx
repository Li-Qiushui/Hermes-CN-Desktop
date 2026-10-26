// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider, getDefaultStore, useAtomValue } from "jotai";
import { useMemo } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hermesUIMessagesToChatMessages,
  mergeHermesUIMessages,
} from "@/components/chat/message-adapter";
import { MessageTimeline } from "@/components/chat/message-timeline";
import { useGateway } from "@/hooks/use-gateway";
import {
  chatRuntimeBySessionAtom,
  ensureChatSessionAtom,
  gwSessionIdAtom,
  startPromptAtom,
} from "@/stores/chat";

const AUTO_CONTINUED_TEXT = "内核已自动续跑被中断的本轮，已执行的命令可能重复";

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

const respond = (ws: MockWebSocket, id: string, result: unknown) => {
  ws.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, result }) });
};

function Probe() {
  useGateway();
  const sessionId = useAtomValue(gwSessionIdAtom);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const messages = useMemo(
    () =>
      hermesUIMessagesToChatMessages(
        mergeHermesUIMessages([], sessionId ? (runtimeBySession[sessionId]?.messages ?? []) : []),
      ),
    [runtimeBySession, sessionId],
  );
  return <MessageTimeline messages={messages} />;
}

describe("resume 带 auto_continue（真实连接态驱动）", () => {
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

  it("内核重启后 resume 返回 auto_continue：时间线出现一条续跑提示，且只有一条", async () => {
    const store = getDefaultStore();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
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

    await act(async () => {
      store.set(ensureChatSessionAtom, "rt-1");
      store.set(gwSessionIdAtom, "rt-1");
      store.set(startPromptAtom, { sessionId: "rt-1", text: "跑 sleep 90; echo alive" });
      await tick();
    });

    await act(async () => {
      first.close();
      await tick();
    });
    expect(store.get(chatRuntimeBySessionAtom)["rt-1"]?.pendingDisconnectNotice).toBe(true);

    const reconnected = getGatewayClient().connect();
    const second = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
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
        messages: [{ role: "user", content: "跑 sleep 90; echo alive" }],
        running: false,
        status: "idle",
        auto_continue: { attempt: 1, interrupted_at: Math.floor(Date.now() / 1000) - 30 },
        open_requests: [],
      });
      await tick();
    });

    expect(screen.getAllByText(AUTO_CONTINUED_TEXT)).toHaveLength(1);
    expect(screen.queryByText("连接已恢复，但上一轮已被中断，输出可能不完整")).toBeNull();
  });
});
