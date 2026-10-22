import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClient } from "./gateway-client";

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

  fail() {
    this.onerror?.();
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

  lastFrame(method: string): any | undefined {
    return this.frames().filter((frame) => frame.method === method).pop();
  }
}

const feed = (ws: MockWebSocket, type: string, sessionId: string | undefined, seq: number | undefined, payload: unknown = {}) => {
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitForFrame(ws: MockWebSocket, method: string): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const frame = ws.lastFrame(method);
    if (frame) return frame;
    await tick();
  }
  throw new Error(`no ${method} frame was sent`);
}

async function openClient(): Promise<{ client: GatewayClient; ws: MockWebSocket }> {
  const client = new GatewayClient();
  const connected = client.connect();
  const ws = MockWebSocket.instances[0];
  ws.open();
  await connected;
  return { client, ws };
}

function collect(client: GatewayClient) {
  const seen: Array<{ type: string; seq?: number; sessionId?: string }> = [];
  const gaps: any[] = [];
  client.onAny((event) => {
    const ev = event as unknown as { type: string; seq?: number; session_id?: string };
    if (ev.type === "session.replay_gap") {
      gaps.push(ev);
      return;
    }
    if (ev.type.startsWith("gateway.")) return;
    seen.push({ type: ev.type, seq: ev.seq, sessionId: ev.session_id });
  });
  return { seen, gaps };
}

describe("gateway client seq watermark + replay", () => {
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

  it("dispatches a given seq only once", async () => {
    const { client, ws } = await openClient();
    const { seen } = collect(client);

    feed(ws, "message.delta", "rt-1", 1);
    feed(ws, "message.delta", "rt-1", 1);
    feed(ws, "message.complete", "rt-1", 2);
    feed(ws, "message.complete", "rt-1", 2);

    expect(seen.map((e) => e.seq)).toEqual([1, 2]);
    client.close();
  });

  it("fills the missed seq window from the watermark after a reconnect", async () => {
    const { client, ws } = await openClient();
    const { seen } = collect(client);

    for (let seq = 1; seq <= 5; seq++) feed(ws, "message.delta", "rt-1", seq);
    client.bindSession("p-1", "rt-1");
    expect(client.trackedSessions()).toEqual([
      { sessionId: "p-1", runtimeSessionId: "rt-1", lastSeen: 5 },
    ]);

    const replayed = client.replaySession("p-1", "rt-1");
    const frame = await waitForFrame(ws, "session.events.since");
    expect(frame.params).toEqual({ session_id: "rt-1", last_seen: 5 });
    respond(ws, frame.id, {
      events: [6, 7, 8, 9, 10, 11].map((seq) => ({ type: "message.delta", session_id: "rt-1", seq, payload: {} })),
      latest_seq: 11,
      truncated: false,
      epoch: null,
    });

    await expect(replayed).resolves.toEqual({ status: "replayed", dispatched: 6 });
    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    client.close();
  });

  it("falls back to a full resume when the local cursor is ahead of the server", async () => {
    const { client, ws } = await openClient();
    const { seen, gaps } = collect(client);

    client.bindSession("p-1", "rt-1");
    feed(ws, "message.delta", "rt-1", 12);

    const replayed = client.replaySession("p-1", "rt-1");
    const frame = await waitForFrame(ws, "session.events.since");
    respond(ws, frame.id, { events: [], latest_seq: 11, truncated: false });

    await expect(replayed).resolves.toEqual({ status: "degraded", dispatched: 0, reason: "cursor_ahead" });
    expect(gaps).toHaveLength(1);
    expect(gaps[0].payload).toMatchObject({ session_id: "p-1", reason: "cursor_ahead", latest_seq: 11 });
    expect(seen.map((e) => e.seq)).toEqual([12]);
    // 水位已丢弃：没有可证明的缺口，下次不会再拿旧游标去要
    expect(client.trackedSessions()[0].lastSeen).toBe(0);
    client.close();
  });

  it("falls back to a full resume when the epoch changed", async () => {
    const { client, ws } = await openClient();
    const { gaps } = collect(client);

    // 后端进程 epoch 是 E1，本地游标也有 E1
    feed(ws, "gateway.ready", undefined, undefined, { heartbeat: true, replay_epoch: "E1" });
    client.bindSession("p-1", "rt-1");
    for (let seq = 1; seq <= 3; seq++) feed(ws, "message.delta", "rt-1", seq);

    const replayed = client.replaySession("p-1", "rt-1");
    const frame = await waitForFrame(ws, "session.events.since");
    // 内核重启过：答案里的 epoch 换了
    respond(ws, frame.id, {
      events: [{ type: "message.delta", session_id: "rt-1", seq: 4, payload: {} }],
      latest_seq: 4,
      truncated: false,
      epoch: "E2",
    });

    await expect(replayed).resolves.toEqual({ status: "degraded", dispatched: 0, reason: "epoch_changed" });
    expect(gaps[0].payload.reason).toBe("epoch_changed");
    client.close();
  });

  it("falls back to a full resume when the replayed seq has a hole", async () => {
    const { client, ws } = await openClient();
    const { seen, gaps } = collect(client);

    client.bindSession("p-1", "rt-1");
    for (let seq = 1; seq <= 5; seq++) feed(ws, "message.delta", "rt-1", seq);

    const replayed = client.replaySession("p-1", "rt-1");
    const frame = await waitForFrame(ws, "session.events.since");
    respond(ws, frame.id, {
      events: [6, 8].map((seq) => ({ type: "message.delta", session_id: "rt-1", seq, payload: {} })),
      latest_seq: 8,
      truncated: false,
    });

    await expect(replayed).resolves.toEqual({ status: "degraded", dispatched: 0, reason: "seq_gap" });
    expect(gaps[0].payload.reason).toBe("seq_gap");
    // 缺口窗口一条都不投，避免半截时间线
    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    client.close();
  });

  it("does not duplicate a live frame that the replay window also returns", async () => {
    const { client, ws } = await openClient();
    const { seen } = collect(client);

    client.bindSession("p-1", "rt-1");
    for (let seq = 1; seq <= 5; seq++) feed(ws, "message.delta", "rt-1", seq);

    const replayed = client.replaySession("p-1", "rt-1");
    const frame = await waitForFrame(ws, "session.events.since");

    // 补帧请求在飞：实时帧先到（6 与重放窗口重叠，12 在窗口之后）
    feed(ws, "message.delta", "rt-1", 6);
    feed(ws, "message.delta", "rt-1", 12);
    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);

    respond(ws, frame.id, {
      events: [6, 7, 8].map((seq) => ({ type: "message.delta", session_id: "rt-1", seq, payload: {} })),
      latest_seq: 8,
      truncated: false,
    });
    await replayed;

    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 12]);
    client.close();
  });

  it("orders parked live frames behind the replayed window", async () => {
    const { client, ws } = await openClient();
    const { seen } = collect(client);

    client.bindSession("p-1", "rt-1");
    for (let seq = 1; seq <= 3; seq++) feed(ws, "message.delta", "rt-1", seq);

    const replayed = client.replaySession("p-1", "rt-1");
    const frame = await waitForFrame(ws, "session.events.since");

    // 乱序到达的实时帧（9 先到、4 后到）都要排进重放窗口之后的正确位置
    feed(ws, "message.delta", "rt-1", 9);
    feed(ws, "message.delta", "rt-1", 4);
    respond(ws, frame.id, {
      events: [4, 5, 6].map((seq) => ({ type: "message.delta", session_id: "rt-1", seq, payload: {} })),
      latest_seq: 6,
      truncated: false,
    });
    await replayed;

    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 9]);
    client.close();
  });

  it("drops watermarks and asks for a snapshot when gateway.ready reports a new epoch", async () => {
    const { client, ws } = await openClient();
    const { gaps } = collect(client);

    feed(ws, "gateway.ready", undefined, undefined, { heartbeat: true, replay_epoch: "E1" });
    client.bindSession("p-1", "rt-1");
    for (let seq = 1; seq <= 4; seq++) feed(ws, "message.delta", "rt-1", seq);

    // 内核换进程后重连：ready 带来新 epoch
    feed(ws, "gateway.ready", undefined, undefined, { heartbeat: true, replay_epoch: "E2" });

    expect(gaps).toHaveLength(1);
    expect(gaps[0].payload).toMatchObject({ session_id: "p-1", reason: "epoch_changed" });
    expect(client.trackedSessions()).toEqual([
      { sessionId: "p-1", runtimeSessionId: "rt-1", lastSeen: 0 },
    ]);

    // 水位既已丢弃，这条会话不再拿旧游标去要，直接等上层 resume 快照
    await expect(client.replaySession("p-1", "rt-1")).resolves.toEqual({ status: "skipped", dispatched: 0 });
    client.close();
  });

  it("ignores session-less broadcasts (no seq contract)", async () => {
    const { client, ws } = await openClient();
    const { seen } = collect(client);

    feed(ws, "sessions.changed", undefined, undefined, {});
    feed(ws, "sessions.changed", undefined, undefined, {});
    expect(seen).toHaveLength(2);
    client.close();
  });

  it("退化后快照已包含的帧不重复、快照之后到达的帧不丢", async () => {
    const { client, ws } = await openClient();
    const { seen, gaps } = collect(client);
    const order: Array<number | string> = [];
    client.onAny((event) => {
      const ev = event as unknown as { type: string; seq?: number };
      if (ev.type === "message.delta" && typeof ev.seq === "number") order.push(ev.seq);
    });

    client.bindSession("p-1", "rt-1");
    for (let seq = 1; seq <= 5; seq++) feed(ws, "message.delta", "rt-1", seq);
    order.length = 0;

    const degraded: string[] = [];
    const replayed = client.replaySession("p-1", "rt-1", {
      onDegraded: (reason) => {
        degraded.push(reason);
        order.push("snapshot");
      },
    });
    const frame = await waitForFrame(ws, "session.events.since");

    // 补帧在飞：3 是内核补投的旧帧（快照里已有），6、7 是快照之后才发生的新帧
    feed(ws, "message.delta", "rt-1", 3);
    feed(ws, "message.delta", "rt-1", 6);
    feed(ws, "message.delta", "rt-1", 7);
    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);

    // 游标超前 → 退化，上层拿 resume 的 messages 快照覆盖时间线
    respond(ws, frame.id, { events: [], latest_seq: 4, truncated: false });

    await expect(replayed).resolves.toEqual({ status: "degraded", dispatched: 0, reason: "cursor_ahead" });
    expect(degraded).toEqual(["cursor_ahead"]);
    expect(gaps).toHaveLength(1);
    // 快照先覆盖，之后才放行新帧：旧帧 3 不重复，6/7 不丢
    expect(order).toEqual(["snapshot", 6, 7]);
    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    client.close();
  });

  it("resyncs once from the watermark when a live frame skips a seq", async () => {
    const { client, ws } = await openClient();
    const { seen, gaps } = collect(client);

    client.bindSession("p-1", "rt-1");
    for (let seq = 1; seq <= 3; seq++) feed(ws, "message.delta", "rt-1", seq);

    // 6 到得太早：中间 4、5 丢了
    feed(ws, "message.delta", "rt-1", 6);
    const frame = await waitForFrame(ws, "session.events.since");
    expect(frame.params).toEqual({ session_id: "rt-1", last_seen: 3 });
    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3]);

    respond(ws, frame.id, {
      events: [4, 5, 6].map((seq) => ({ type: "message.delta", session_id: "rt-1", seq, payload: {} })),
      latest_seq: 6,
      truncated: false,
    });

    await vi.waitFor(() => expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]));
    // 补帧是「按水位补齐」，不是退化：不该抛 replay_gap
    expect(gaps).toHaveLength(0);
    expect(ws.frames().filter((f) => f.method === "session.events.since")).toHaveLength(1);
    client.close();
  });

  it("does not resync while the live frames stay contiguous", async () => {
    const { client, ws } = await openClient();
    const { seen } = collect(client);

    client.bindSession("p-1", "rt-1");
    for (let seq = 1; seq <= 5; seq++) feed(ws, "message.delta", "rt-1", seq);
    await tick();

    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(ws.frames().filter((f) => f.method === "session.events.since")).toHaveLength(0);
    client.close();
  });
});

describe("gateway client heartbeat", () => {
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

  it("pings every 15s and resets the silence clock on any inbound frame", async () => {
    vi.useFakeTimers();
    const client = new GatewayClient();
    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;
    const ws = MockWebSocket.instances[0];

    await vi.advanceTimersByTimeAsync(15_000);
    expect(ws.frames().filter((f) => f.method === "gateway.ping")).toHaveLength(1);

    // 回包算存活，静默时钟归零
    const ping = ws.lastFrame("gateway.ping");
    respond(ws, ping.id, { ok: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.frames().filter((f) => f.method === "gateway.ping")).toHaveLength(3);
    expect(client.state).toBe("open");

    client.close();
  });

  it("declares the connection dead after 45s of silence and reconnects", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    const client = new GatewayClient();
    client.enableAutoReconnect();
    const disconnects: string[] = [];
    client.on("gateway.disconnected", () => disconnects.push("d"));

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    await vi.advanceTimersByTimeAsync(45_000);
    expect(client.state).toBe("closed");
    expect(disconnects).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.instances[1].open();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.state).toBe("open");

    client.close();
  });

  it("keeps the seq watermark across a heartbeat-driven reconnect", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    const client = new GatewayClient();
    client.enableAutoReconnect();
    const { seen } = collect(client);

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;
    client.bindSession("p-1", "rt-1");
    feed(MockWebSocket.instances[0], "message.delta", "rt-1", 4);

    await vi.advanceTimersByTimeAsync(45_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const ws2 = MockWebSocket.instances[1];
    ws2.open();
    await vi.advanceTimersByTimeAsync(0);

    // 重连后水位还在（补帧靠它），同一 seq 不会重复投
    expect(client.trackedSessions()[0].lastSeen).toBe(4);
    feed(ws2, "message.delta", "rt-1", 4);
    feed(ws2, "message.delta", "rt-1", 5);
    expect(seen.map((e) => e.seq)).toEqual([4, 5]);

    client.close();
  });

  it("migrates a watermark recorded under the runtime id once the persistent id is known", async () => {
    const { client, ws } = await openClient();

    // 创建路径：事件先按运行时 id 记账
    for (let seq = 1; seq <= 3; seq++) feed(ws, "message.delta", "rt-1", seq);
    expect(client.trackedSessions()).toEqual([
      { sessionId: "rt-1", runtimeSessionId: "rt-1", lastSeen: 3 },
    ]);

    // 学到持久 id 后绑定：旧记录并过来并删除，只剩一条（否则重连会各 resume 一次）
    client.bindSession("20261022_205224_57d4a0", "rt-1");
    expect(client.trackedSessions()).toEqual([
      { sessionId: "20261022_205224_57d4a0", runtimeSessionId: "rt-1", lastSeen: 3 },
    ]);

    client.close();
  });
});
