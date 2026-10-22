import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClient } from "./gateway-client";
import { recoverAfterReconnect, type HydrateSnapshotParams } from "./gateway-replay";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    (this.onclose as ((ev?: { code?: number; reason?: string }) => void) | null)?.(
      code === undefined ? undefined : { code, reason },
    );
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

const feed = (
  ws: MockWebSocket,
  type: string,
  sessionId: string | undefined,
  seq: number | undefined,
  payload: unknown = {},
) => {
  ws.onmessage?.({
    data: JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type,
        ...(sessionId === undefined ? {} : { session_id: sessionId }),
        ...(seq === undefined ? {} : { seq }),
        payload,
      },
    }),
  });
};

const respond = (ws: MockWebSocket, id: string, result: unknown) => {
  ws.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, result }) });
};

async function waitForFrame(ws: MockWebSocket, method: string): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const [frame] = ws.framesOf(method);
    if (frame) return frame;
    await tick();
  }
  throw new Error(`no ${method} frame was sent`);
}

function resumeFramesEverywhere(): any[] {
  return MockWebSocket.instances.flatMap((ws) => ws.framesOf("session.resume"));
}

interface Wiring {
  client: GatewayClient;
  hydrated: HydrateSnapshotParams[];
  resumed: string[][];
}

function wire(client: GatewayClient): Wiring {
  return { client, hydrated: [], resumed: [] };
}

describe("one reconnect cycle issues exactly one session.resume", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("window", {
      location: { href: "http://localhost:9545/tasks/s1", protocol: "http:" },
      __HERMES_SESSION_TOKEN__: "token",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("applies the resume snapshot and never asks for a second resume when the epoch changed", async () => {
    const client = new GatewayClient();
    const connected = client.connect();
    const first = MockWebSocket.instances[0];
    first.open();
    await connected;

    feed(first, "gateway.ready", undefined, undefined, { heartbeat: true, replay_epoch: "E1" });
    client.bindSession("p-1", "rt-1");
    for (let seq = 1; seq <= 3; seq++) feed(first, "message.delta", "rt-1", seq);
    expect(client.trackedSessions()).toEqual([
      { sessionId: "p-1", runtimeSessionId: "rt-1", lastSeen: 3 },
    ]);

    // 内核被杀：socket 断掉，运行时 session_id 作废
    first.close();
    const reconnected = client.connect();
    const second = MockWebSocket.instances[1];
    second.open();
    await reconnected;

    // 计划任务拉起新进程：epoch 换了
    feed(second, "gateway.ready", undefined, undefined, { heartbeat: true, replay_epoch: "E2" });

    const { hydrated, resumed } = wire(client);
    const recovering = recoverAfterReconnect({
      getActiveSessionId: () => "rt-1",
      resolvePersistentId: (id) => (id === "rt-1" ? "p-1" : id),
      resume: async (persistentId) => {
        const parsed = await client.request<{
          session_id: string;
          resumed?: string;
          messages?: unknown[];
          running?: boolean;
        }>("session.resume", { session_id: persistentId }, { timeoutMs: 300_000 });
        return parsed;
      },
      bind: (persistentId, runtimeSessionId) => client.bindSession(persistentId, runtimeSessionId),
      replay: (persistentId, runtimeSessionId, onDegraded) =>
        client.replaySession(persistentId, runtimeSessionId, { onDegraded }),
      hydrate: (params) => {
        hydrated.push(params);
      },
      epochGeneration: () => client.epochGeneration(),
      consumeSnapshotRequest: (persistentId) => client.consumeSnapshotRequest(persistentId),
      onResumed: (runtimeSessionId, persistentId) => {
        resumed.push([runtimeSessionId, persistentId]);
      },
    });

    const resumeFrame = await waitForFrame(second, "session.resume");
    expect(resumeFrame.params).toEqual({ session_id: "p-1" });
    respond(second, resumeFrame.id, {
      session_id: "rt-new",
      resumed: "p-1",
      message_count: 2,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      running: false,
      open_requests: [],
    });

    const result = await recovering;

    expect(result).toMatchObject({ status: "snapshot", reason: "epoch_changed", runtimeSessionId: "rt-new" });
    expect(resumeFramesEverywhere()).toHaveLength(1);
    expect(second.framesOf("session.events.since")).toHaveLength(0);
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]).toMatchObject({ runtimeSessionId: "rt-new", persistentId: "p-1", running: false });
    expect(hydrated[0].messages).toHaveLength(2);
    expect(resumed).toEqual([["rt-new", "p-1"]]);
    client.close();
  });

  it("fills the missed window with session.events.since and no snapshot when the epoch survived", async () => {
    const client = new GatewayClient();
    const connected = client.connect();
    const first = MockWebSocket.instances[0];
    first.open();
    await connected;

    feed(first, "gateway.ready", undefined, undefined, { heartbeat: true, replay_epoch: "E1" });
    const seen: Array<{ type: string; seq?: number }> = [];
    client.onAny((event) => {
      const ev = event as unknown as { type: string; seq?: number };
      if (ev.type.startsWith("gateway.")) return;
      seen.push({ type: ev.type, seq: ev.seq });
    });
    client.bindSession("p-1", "rt-1");
    for (let seq = 1; seq <= 3; seq++) feed(first, "message.delta", "rt-1", seq);

    // 只是链路抖动：同一个进程，epoch 不变
    first.close();
    const reconnected = client.connect();
    const second = MockWebSocket.instances[1];
    second.open();
    await reconnected;
    feed(second, "gateway.ready", undefined, undefined, { heartbeat: true, replay_epoch: "E1" });
    expect(client.epochGeneration()).toBe(0);

    const { hydrated } = wire(client);
    const recovering = recoverAfterReconnect({
      getActiveSessionId: () => "rt-1",
      resolvePersistentId: (id) => (id === "rt-1" ? "p-1" : id),
      resume: async (persistentId) =>
        client.request<{ session_id: string; resumed?: string; messages?: unknown[]; running?: boolean }>(
          "session.resume",
          { session_id: persistentId },
          { timeoutMs: 300_000 },
        ),
      bind: (persistentId, runtimeSessionId) => client.bindSession(persistentId, runtimeSessionId),
      replay: (persistentId, runtimeSessionId, onDegraded) =>
        client.replaySession(persistentId, runtimeSessionId, { onDegraded }),
      hydrate: (params) => {
        hydrated.push(params);
      },
      epochGeneration: () => client.epochGeneration(),
      consumeSnapshotRequest: (persistentId) => client.consumeSnapshotRequest(persistentId),
    });

    const resumeFrame = await waitForFrame(second, "session.resume");
    respond(second, resumeFrame.id, {
      session_id: "rt-new",
      resumed: "p-1",
      messages: [],
      running: true,
      open_requests: [],
    });

    const sinceFrame = await waitForFrame(second, "session.events.since");
    expect(sinceFrame.params).toEqual({ session_id: "rt-new", last_seen: 3 });
    respond(second, sinceFrame.id, {
      events: [4, 5].map((seq) => ({ type: "message.delta", session_id: "rt-new", seq, payload: {} })),
      latest_seq: 5,
      truncated: false,
      epoch: "E1",
    });

    const result = await recovering;

    expect(result).toMatchObject({ status: "resumed", runtimeSessionId: "rt-new" });
    expect(resumeFramesEverywhere()).toHaveLength(1);
    expect(hydrated).toEqual([]);
    expect(seen.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
    client.close();
  });
});
