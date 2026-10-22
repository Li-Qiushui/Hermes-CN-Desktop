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

  /** 握手后客户端会自动宣告能力（client.capabilities），断言业务帧时应排除它。 */
  sentRpc(): string[] {
    return this.sent.filter((data) => {
      try {
        return JSON.parse(data).method !== "client.capabilities";
      } catch {
        return true;
      }
    });
  }

  close(code?: number, reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    (this.onclose as ((ev?: { code?: number; reason?: string }) => void) | null)?.(
      code === undefined ? undefined : { code, reason },
    );
  }
}

describe("GatewayClient", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost:9545/tasks/s1",
        protocol: "http:",
      },
      __HERMES_SESSION_TOKEN__: "token with space",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reuses the in-flight connection promise and encodes the token", async () => {
    const client = new GatewayClient();
    const first = client.connect();
    const second = client.connect();

    expect(first).toBe(second);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toContain("token=token+with+space");

    MockWebSocket.instances[0].open();
    await expect(first).resolves.toBeUndefined();
    client.close();
  });

  it("times out a stuck WebSocket handshake", async () => {
    vi.useFakeTimers();
    const client = new GatewayClient();
    const connected = client.connect({ timeoutMs: 25 });

    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(25);

    await expect(connected).rejects.toThrow("WebSocket connection timeout");
    expect(client.state).toBe("error");
    expect(MockWebSocket.instances[0].readyState).toBe(MockWebSocket.CLOSED);
  });

  it("applies request connect timeout before RPC timeout", async () => {
    vi.useFakeTimers();
    const client = new GatewayClient();
    const request = client.request("prompt.submit", { session_id: "s1", text: "hi" }, {
      connectTimeoutMs: 10,
      timeoutMs: 10_000,
    });

    vi.advanceTimersByTime(10);

    await expect(request).rejects.toThrow("WebSocket connection timeout");
    expect(MockWebSocket.instances[0].sent).toHaveLength(0);
  });

  it("rejects all pending requests when the socket closes", async () => {
    const client = new GatewayClient();
    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    const request = client.request("prompt.submit", { session_id: "s1", text: "hi" });
    await Promise.resolve();
    expect(MockWebSocket.instances[0].sentRpc()).toHaveLength(1);

    client.close();
    await expect(request).rejects.toThrow("WebSocket closed");
  });

  it("moves an established connection to closed when the socket closes", async () => {
    const client = new GatewayClient();
    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    MockWebSocket.instances[0].close();

    expect(client.state).toBe("closed");
    client.close();
  });

  it("rejects pending requests and schedules reconnect when an established socket errors", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    const client = new GatewayClient();
    client.enableAutoReconnect();
    const events: string[] = [];
    client.on("gateway.disconnected", () => events.push("disconnected"));

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    const request = client.request("some.method", {});
    await Promise.resolve();

    MockWebSocket.instances[0].fail();

    await expect(request).rejects.toThrow("WebSocket connection failed");
    expect(client.state).toBe("error");
    expect(events).toEqual(["disconnected"]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(MockWebSocket.instances).toHaveLength(2);

    client.close();
  });

  it("announces client.capabilities right after the socket opens", async () => {
    // 内核只在客户端宣告 server_requests 之后才会下发 approval/clarify，
    // 不宣告就会被判成 undelivered，前端永远收不到交互卡片。
    const client = new GatewayClient();
    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    const frames = MockWebSocket.instances[0].sent.map((data) => JSON.parse(data));
    const capabilities = frames.filter((frame) => frame.method === "client.capabilities");
    expect(capabilities).toHaveLength(1);
    expect(capabilities[0].params).toEqual({ server_requests: true });

    client.close();
  });

  it("parses gateway events before notifying listeners", async () => {
    const client = new GatewayClient();
    const seen: unknown[] = [];
    client.onAny((event) => seen.push(event));

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    MockWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: {
          type: "message.complete",
          session_id: "s1",
          payload: { text: "done" },
        },
      }),
    });

    expect(seen).toEqual([
      expect.objectContaining({
        type: "message.complete",
        session_id: "s1",
        payload: { text: "done" },
      }),
    ]);
    client.close();
  });

  it("resolves a pending RPC when the relay delivers a raw response frame", async () => {
    // Wire contract shared by the TCP relay (ws_proxy.rs) and the embedded
    // transport: an RPC response must arrive as a raw `{jsonrpc,id,result}`
    // frame so handleFrame can match the pending request by id.
    const client = new GatewayClient();
    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    const request = client.request("session.create", { cwd: "C:/dev" });
    await Promise.resolve();
    const sent = JSON.parse(MockWebSocket.instances[0].sentRpc()[0]);

    MockWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({
        jsonrpc: "2.0",
        id: sent.id,
        result: { session_id: "s1" },
      }),
    });

    await expect(request).resolves.toEqual({ session_id: "s1" });
    expect(client.state).toBe("open");
    client.close();
  });

  it("keeps a pending RPC pending when the relay delivers an event-wrapped response", async () => {
    // Bug reproduction (embedded transport, pre-fix): responses were emitted
    // as `{method:"event",params:{type:"response",payload:{frame:...}}}`
    // instead of a raw frame, so handleFrame never matched the pending id and
    // 工作台 发送 (session.create) hung until the 120s RPC timeout. The wrapped
    // frame must NOT settle the request — only the raw frame does.
    vi.useFakeTimers();
    const client = new GatewayClient();
    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    const request = client.request("session.create", {}, { timeoutMs: 1_000 });
    await Promise.resolve();
    const sent = JSON.parse(MockWebSocket.instances[0].sentRpc()[0]);

    MockWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({
        method: "event",
        params: {
          type: "response",
          payload: { frame: { jsonrpc: "2.0", id: sent.id, result: { session_id: "s1" } } },
        },
      }),
    });

    // The wrapped response is routed to the event listeners, not to the
    // pending map — the request is still unsettled and only the RPC timeout
    // releases it (the "stuck" symptom on the workbench).
    let settled = false;
    void request.finally(() => { settled = true; }).catch(() => {});
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    await expect(request).rejects.toThrow("RPC timeout: session.create");
    client.close();
  });

  it("emits gateway.disconnected on unexpected close", async () => {
    const client = new GatewayClient();
    const events: string[] = [];
    client.on("gateway.disconnected", () => events.push("disconnected"));

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    MockWebSocket.instances[0].close();

    expect(events).toEqual(["disconnected"]);
    expect(client.state).toBe("closed");
  });

  it("suspends reconnect and emits gateway.auth_required on a 4401 close", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    const client = new GatewayClient();
    client.enableAutoReconnect();
    const events: string[] = [];
    client.on("gateway.auth_required", () => events.push("auth_required"));

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    MockWebSocket.instances[0].close(4401, "unauthenticated");

    expect(events).toContain("auth_required");
    // No new socket even after well past the backoff — blind reconnect is off.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(MockWebSocket.instances).toHaveLength(1);

    // forceReconnect clears the auth-suspend gate and reconnects.
    client.forceReconnect("relogin");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(MockWebSocket.instances.length).toBeGreaterThan(1);
  });

  it("keeps normal backoff on a non-auth (1006-like) close", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    const client = new GatewayClient();
    client.enableAutoReconnect();
    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    MockWebSocket.instances[0].close(1006, "abnormal");
    // A transient close schedules a reconnect (new socket after backoff).
    await vi.advanceTimersByTimeAsync(1_000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("does not emit gateway.disconnected on intentional close", async () => {
    const client = new GatewayClient();
    const events: string[] = [];
    client.on("gateway.disconnected", () => events.push("disconnected"));

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    client.close();

    expect(events).toEqual([]);
    expect(client.state).toBe("idle");
  });

  it("rejects an in-flight connection when closed intentionally", async () => {
    const client = new GatewayClient();
    const events: string[] = [];
    client.on("gateway.disconnected", () => events.push("disconnected"));

    const connecting = client.connect({ timeoutMs: 1_000 });
    expect(client.state).toBe("connecting");

    client.close();

    await expect(connecting).rejects.toThrow("WebSocket closed");
    expect(events).toEqual([]);
    expect(client.state).toBe("idle");
  });

  it("auto-reconnects when enabled", async () => {
    vi.useFakeTimers();
    const client = new GatewayClient();
    client.enableAutoReconnect();

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.instances[0].close();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);

    client.close();
  });

  it("does not auto-reconnect when disabled", async () => {
    vi.useFakeTimers();
    const client = new GatewayClient();

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    MockWebSocket.instances[0].close();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("resets reconnect attempts after successful connection", async () => {
    vi.useFakeTimers();
    const client = new GatewayClient();
    client.enableAutoReconnect();

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    MockWebSocket.instances[0].close();
    await vi.advanceTimersByTimeAsync(2_000);

    const reconnectWs = MockWebSocket.instances[1];
    expect(reconnectWs).toBeDefined();
    reconnectWs.open();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.state).toBe("open");
    client.close();
  });

  describe("reconnect backoff", () => {
    it("uses exponential backoff: 1s, 2s, 4s", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(1);
      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      MockWebSocket.instances[0].close();
      await vi.advanceTimersByTimeAsync(999);
      expect(MockWebSocket.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWebSocket.instances).toHaveLength(2);

      MockWebSocket.instances[1].close();
      await vi.advanceTimersByTimeAsync(1999);
      expect(MockWebSocket.instances).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWebSocket.instances).toHaveLength(3);

      MockWebSocket.instances[2].close();
      await vi.advanceTimersByTimeAsync(3999);
      expect(MockWebSocket.instances).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWebSocket.instances).toHaveLength(4);

      client.close();
    });

    it("caps backoff delay at 15s (official desktop parity)", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(1);
      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      // 1s, 2s, 4s, 8s, then capped: min(1s·2^min(n,4), 15s) = 15s
      for (let i = 0; i < 5; i++) {
        MockWebSocket.instances[i].close();
        await vi.advanceTimersByTimeAsync(Math.min(1000 * Math.pow(2, Math.min(i, 4)), 15_000));
      }
      expect(MockWebSocket.instances).toHaveLength(6);

      MockWebSocket.instances[5].close();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(MockWebSocket.instances).toHaveLength(6);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWebSocket.instances).toHaveLength(7);

      MockWebSocket.instances[6].close();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(MockWebSocket.instances).toHaveLength(7);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWebSocket.instances).toHaveLength(8);

      client.close();
    });

    it("close() cancels pending reconnect", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(1);
      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      MockWebSocket.instances[0].close();
      client.close();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it("disableAutoReconnect cancels pending timer", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(1);
      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      MockWebSocket.instances[0].close();
      client.disableAutoReconnect();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it("connect timeout triggers reconnect when auto-reconnect enabled", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(1);
      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect({ timeoutMs: 50 });
      vi.advanceTimersByTime(50);
      await expect(connected).rejects.toThrow("WebSocket connection timeout");

      await vi.advanceTimersByTimeAsync(1_000);
      expect(MockWebSocket.instances).toHaveLength(2);

      client.close();
    });

    it("concurrent connect() during reconnect reuses in-flight promise", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(1);
      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      MockWebSocket.instances[0].close();
      await vi.advanceTimersByTimeAsync(1_000);

      const p1 = client.connect();
      const p2 = client.connect();
      expect(p1).toBe(p2);

      MockWebSocket.instances[1].open();
      await p1;
      expect(client.state).toBe("open");

      client.close();
    });

    it("successful reconnect resets backoff to 1s", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(1);
      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      MockWebSocket.instances[0].close();
      await vi.advanceTimersByTimeAsync(1_000);
      MockWebSocket.instances[1].close();
      await vi.advanceTimersByTimeAsync(2_000);

      MockWebSocket.instances[2].open();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.state).toBe("open");

      MockWebSocket.instances[2].close();
      await vi.advanceTimersByTimeAsync(999);
      expect(MockWebSocket.instances).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWebSocket.instances).toHaveLength(4);

      client.close();
    });

    it("tracks state transitions through reconnect cycle", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(1);
      const client = new GatewayClient();
      client.enableAutoReconnect();
      const states: string[] = [];
      client.onState((s) => states.push(s));

      expect(states).toEqual(["idle"]);

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;
      expect(states).toEqual(["idle", "connecting", "open"]);

      MockWebSocket.instances[0].close();
      expect(states).toEqual(["idle", "connecting", "open", "closed"]);

      await vi.advanceTimersByTimeAsync(1_000);
      MockWebSocket.instances[1].open();
      await vi.advanceTimersByTimeAsync(0);
      expect(states).toEqual(["idle", "connecting", "open", "closed", "connecting", "open"]);

      client.close();
      expect(states).toEqual(["idle", "connecting", "open", "closed", "connecting", "open", "idle"]);
    });
  });

  describe("stale socket isolation", () => {
    it("keeps the active connection promise when an old socket closes late", async () => {
      const client = new GatewayClient();

      const failed = client.connect();
      const stale = MockWebSocket.instances[0];
      stale.fail();
      await expect(failed).rejects.toThrow("WebSocket connection failed");

      const reconnecting = client.connect();
      const sameReconnect = client.connect();
      expect(sameReconnect).toBe(reconnecting);

      stale.close();

      expect(client.connect()).toBe(reconnecting);
      expect(MockWebSocket.instances).toHaveLength(2);

      MockWebSocket.instances[1].open();
      await expect(reconnecting).resolves.toBeUndefined();
      client.close();
    });

    it("does not let an old socket close reject pending RPC on the active socket", async () => {
      const client = new GatewayClient();

      const failed = client.connect();
      const stale = MockWebSocket.instances[0];
      stale.fail();
      await expect(failed).rejects.toThrow("WebSocket connection failed");

      const connected = client.connect();
      const active = MockWebSocket.instances[1];
      active.open();
      await connected;

      const request = client.request<{ ok: boolean }>("some.method", {});
      await Promise.resolve();
      expect(active.sentRpc()).toHaveLength(1);
      const rid = JSON.parse(active.sentRpc()[0]).id as string;

      stale.close();
      active.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", id: rid, result: { ok: true } }),
      });

      await expect(request).resolves.toEqual({ ok: true });
      expect(client.state).toBe("open");
      client.close();
    });

    it("ignores RPC frames delivered by stale sockets", async () => {
      const client = new GatewayClient();

      const failed = client.connect();
      const stale = MockWebSocket.instances[0];
      stale.fail();
      await expect(failed).rejects.toThrow("WebSocket connection failed");

      const connected = client.connect();
      const active = MockWebSocket.instances[1];
      active.open();
      await connected;

      const request = client.request<{ ok: boolean }>("some.method", {});
      await Promise.resolve();
      const rid = JSON.parse(active.sentRpc()[0]).id as string;

      stale.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", id: rid, result: { ok: false } }),
      });
      active.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", id: rid, result: { ok: true } }),
      });

      await expect(request).resolves.toEqual({ ok: true });
      client.close();
    });
  });

  describe("heartbeat", () => {
    it("sends gateway.ping every 15s on an idle connection", async () => {
      vi.useFakeTimers();
      const client = new GatewayClient();
      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      const ws = MockWebSocket.instances[0];
      expect(ws.sent.filter((d) => d.includes("gateway.ping"))).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(ws.sent.filter((d) => d.includes("gateway.ping"))).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(ws.sent.filter((d) => d.includes("gateway.ping"))).toHaveLength(2);

      // ping 不进 pending map：回包只刷新存活时间，不会被当成 RPC 结果。
      const ping = JSON.parse(ws.sent.filter((d) => d.includes("gateway.ping"))[0]);
      expect(ping.method).toBe("gateway.ping");
      expect(String(ping.id).startsWith("heartbeat-")).toBe(true);

      client.close();
    });

    it("keeps the socket open while any inbound frame arrives", async () => {
      vi.useFakeTimers();
      const client = new GatewayClient();
      const disconnects: string[] = [];
      client.on("gateway.disconnected", () => disconnects.push("d"));

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;
      const ws = MockWebSocket.instances[0];

      // 每 15s 来一条任意入站帧（这里用无 seq 的全局广播）：流式帧本身就是心跳。
      for (let i = 0; i < 8; i++) {
        ws.onmessage?.({ data: JSON.stringify({ method: "event", params: { type: "sessions.changed", payload: {} } }) });
        await vi.advanceTimersByTimeAsync(15_000);
      }

      expect(client.state).toBe("open");
      expect(disconnects).toHaveLength(0);

      client.close();
    });

    it("declares a silent socket dead at 45s and reconnects", async () => {
      vi.useFakeTimers();
      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      // 15s、30s 各一次 ping，没有任何回包
      await vi.advanceTimersByTimeAsync(44_000);
      expect(client.state).toBe("open");

      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.state).toBe("closed");
      expect(MockWebSocket.instances[0].readyState).toBe(MockWebSocket.CLOSED);

      // 按退避重连（random=1 → 1s 上限）
      await vi.advanceTimersByTimeAsync(1_000);
      expect(MockWebSocket.instances).toHaveLength(2);

      client.close();
    });

    it("keeps a slow RPC pending while the link stays alive", async () => {
      vi.useFakeTimers();
      const client = new GatewayClient();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;
      const ws = MockWebSocket.instances[0];

      let settled = false;
      const result = client.request("some.method", {}, { timeoutMs: 120_000 })
        .then(() => null)
        .finally(() => { settled = true; })
        .catch((err: Error) => err);
      await vi.advanceTimersByTimeAsync(0);

      // 慢 RPC 不该被当成掉线：只要 socket 上还有入站帧，就继续等 RPC 超时。
      for (let i = 0; i < 7; i++) {
        await vi.advanceTimersByTimeAsync(15_000);
        ws.onmessage?.({ data: JSON.stringify({ method: "event", params: { type: "sessions.changed", payload: {} } }) });
      }
      expect(settled).toBe(false);
      expect(client.state).toBe("open");

      await vi.advanceTimersByTimeAsync(20_000);
      const error = await result;
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toBe("RPC timeout: some.method");
      client.close();
    });
  });

  describe("wake recovery", () => {
    it("watchdog detects clock skew and force-reconnects", async () => {
      vi.useFakeTimers();
      const baseTime = new Date("2026-05-10T12:00:00Z").getTime();
      vi.setSystemTime(baseTime);

      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;
      expect(client.state).toBe("open");
      expect(MockWebSocket.instances).toHaveLength(1);

      // 正常 watchdog tick——gap ≈ 2000ms，不触发 wake
      await vi.advanceTimersByTimeAsync(2_000);
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(client.state).toBe("open");

      // 模拟 macOS 合盖：墙上时间跳了 60s 但 timer queue 被冻结
      vi.setSystemTime(baseTime + 60_000);
      await vi.advanceTimersByTimeAsync(2_000);

      // watchdog 看到 60s+ 的 gap，强制重连
      expect(MockWebSocket.instances).toHaveLength(2);
      expect(MockWebSocket.instances[0].readyState).toBe(MockWebSocket.CLOSED);

      client.close();
    });

    it("visibilitychange to visible does NOT tear down a healthy WS", async () => {
      // Capture the handler so we can fire the event ourselves regardless of jsdom presence.
      const captured: { handler: (() => void) | null } = { handler: null };
      const fakeDocument = {
        visibilityState: "visible" as DocumentVisibilityState,
        addEventListener: (name: string, handler: () => void) => {
          if (name === "visibilitychange") captured.handler = handler;
        },
        removeEventListener: () => {},
      };
      vi.stubGlobal("document", fakeDocument);
      vi.stubGlobal("window", {
        location: { href: "http://localhost:9545/tasks/s1", protocol: "http:" },
        __HERMES_SESSION_TOKEN__: "token",
        addEventListener: () => {},
        removeEventListener: () => {},
      });

      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;
      expect(client.state).toBe("open");
      expect(MockWebSocket.instances).toHaveLength(1);

      const disconnects: string[] = [];
      client.on("gateway.disconnected", () => disconnects.push("d"));

      // 模拟用户 alt-tab 切回 Electron 窗口——visibilityState 仍是 visible，
      // 健康的 WS 不该被 tear down，UI 不该看到 gateway.disconnected。
      captured.handler?.();
      await Promise.resolve();

      expect(MockWebSocket.instances).toHaveLength(1);
      expect(MockWebSocket.instances[0].readyState).toBe(MockWebSocket.OPEN);
      expect(client.state).toBe("open");
      expect(disconnects).toHaveLength(0);

      client.close();
    });

    it("desktop runtime skips JS watchdog because powerMonitor IPC handles wake", async () => {
      vi.useFakeTimers();
      const baseTime = new Date("2026-05-10T12:00:00Z").getTime();
      vi.setSystemTime(baseTime);

      // Electron preload 注入 hermesDesktop.onSystemResume——表示有真正的
      // OS 唤醒信号源，不需要 setInterval 兜底。
      vi.stubGlobal("window", {
        location: { href: "http://localhost:9545/tasks/s1", protocol: "http:" },
        __HERMES_SESSION_TOKEN__: "token",
        hermesDesktop: { onSystemResume: () => () => {} },
      });

      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;
      expect(MockWebSocket.instances).toHaveLength(1);

      // 即使墙上时间跳了 60s（模拟主线程被长任务/合盖卡住），桌面端也不应
      // 把健康连接 tear down——因为 powerMonitor 才是权威唤醒源。
      vi.setSystemTime(baseTime + 60_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(MockWebSocket.instances).toHaveLength(1);
      expect(client.state).toBe("open");

      client.close();
    });

    it("forceReconnect tears down current socket and reconnects immediately", async () => {
      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;
      expect(MockWebSocket.instances).toHaveLength(1);

      client.forceReconnect("test");

      expect(MockWebSocket.instances[0].readyState).toBe(MockWebSocket.CLOSED);
      expect(MockWebSocket.instances).toHaveLength(2);

      client.close();
    });

    it("wake rejects pending RPCs instead of leaving them to RPC timeout", async () => {
      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      const rpc = client.request("some.method", {});
      await Promise.resolve();
      expect(MockWebSocket.instances[0].sentRpc()).toHaveLength(1);

      client.forceReconnect("test");

      await expect(rpc).rejects.toThrow(/WebSocket connection lost/);
      client.close();
    });

    it("wake resets reconnect backoff so retries don't sit in the 15s ceiling", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(1);
      const baseTime = new Date("2026-05-10T12:00:00Z").getTime();
      vi.setSystemTime(baseTime);

      const client = new GatewayClient();
      client.enableAutoReconnect();

      // 先连开，再让若干次 close 把 backoff 推到 8s+
      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      MockWebSocket.instances[0].close();
      await vi.advanceTimersByTimeAsync(1_000);
      MockWebSocket.instances[1].close();
      await vi.advanceTimersByTimeAsync(2_000);
      MockWebSocket.instances[2].close();
      // 此时 reconnectAttempts = 3，下次 backoff 会是 8s
      const beforeWake = MockWebSocket.instances.length;

      // 模拟睡过觉
      vi.setSystemTime(Date.now() + 60_000);
      await vi.advanceTimersByTimeAsync(2_000);

      // wake 立刻拉一个新连接，不等 backoff
      expect(MockWebSocket.instances.length).toBe(beforeWake + 1);
      const wokenWs = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      wokenWs.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.state).toBe("open");

      // 唤醒后再次断线，下个 backoff 应该回到 1s（attempts 被重置过）
      wokenWs.close();
      await vi.advanceTimersByTimeAsync(999);
      expect(MockWebSocket.instances.length).toBe(beforeWake + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWebSocket.instances.length).toBe(beforeWake + 2);

      client.close();
    });
  });

  describe("listener broadcast", () => {
    it("all onAny listeners receive the same event", async () => {
      const client = new GatewayClient();
      const a: string[] = [];
      const b: string[] = [];
      client.onAny((ev) => a.push(ev.type));
      client.onAny((ev) => b.push(ev.type));

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      MockWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          method: "event",
          params: { type: "message.start", session_id: "s1", payload: {} },
        }),
      });

      expect(a).toEqual(["message.start"]);
      expect(b).toEqual(["message.start"]);
      client.close();
    });

    it("all typed listeners receive matching events", async () => {
      const client = new GatewayClient();
      const a: unknown[] = [];
      const b: unknown[] = [];
      client.on("message.complete", (ev) => a.push(ev));
      client.on("message.complete", (ev) => b.push(ev));

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      MockWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          method: "event",
          params: { type: "message.complete", session_id: "s1", payload: { text: "done" } },
        }),
      });

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(a[0]).toEqual(b[0]);
      client.close();
    });

    it("unsubscribing one listener does not affect others", async () => {
      const client = new GatewayClient();
      const a: string[] = [];
      const b: string[] = [];
      const unsubA = client.onAny((ev) => a.push(ev.type));
      client.onAny((ev) => b.push(ev.type));

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      unsubA();

      MockWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          method: "event",
          params: { type: "message.start", session_id: "s1", payload: {} },
        }),
      });

      expect(a).toEqual([]);
      expect(b).toEqual(["message.start"]);
      client.close();
    });

    it("all onState listeners receive transitions", async () => {
      const client = new GatewayClient();
      const a: string[] = [];
      const b: string[] = [];
      client.onState((s) => a.push(s));
      client.onState((s) => b.push(s));

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      expect(a).toEqual(["idle", "connecting", "open"]);
      expect(b).toEqual(["idle", "connecting", "open"]);
      client.close();
    });

    it("onState fires immediately with current state", () => {
      const client = new GatewayClient();
      const states: string[] = [];
      client.onState((s) => states.push(s));
      expect(states).toEqual(["idle"]);
      client.close();
    });
  });

  describe("server request 弃权（4404 NOT_SHOWN）", () => {
    /** 握手后把 client.capabilities 的应答灌回去，声明内核认弃权帧。 */
    function answerCapabilities(sock: MockWebSocket, declines: boolean) {
      const frame = sock.sent
        .map((data) => JSON.parse(data))
        .find((parsed) => parsed.method === "client.capabilities");
      sock.onmessage?.({
        data: JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: { declines_not_shown: declines },
        }),
      });
    }

    async function incomingRequest(capabilities: boolean | null) {
      const client = new GatewayClient();
      const connected = client.connect();
      const sock = MockWebSocket.instances[0];
      sock.open();
      await connected;
      if (capabilities !== null) answerCapabilities(sock, capabilities);

      sock.onmessage?.({
        data: JSON.stringify({
          jsonrpc: "2.0",
          id: "srq-preview",
          method: "preview.read",
          params: { session_id: "rt-1" },
        }),
      });
      await vi.waitFor(() => {
        const reply = sock.sent
          .map((data) => JSON.parse(data))
          .find((parsed) => parsed.id === "srq-preview");
        expect(reply).toBeDefined();
      });
      const reply = sock.sent
        .map((data) => JSON.parse(data))
        .find((parsed) => parsed.id === "srq-preview");
      client.close();
      return reply;
    }

    it("内核声明 declines_not_shown 时，window-owned 请求回 4404 而不是 -32601", async () => {
      const reply = await incomingRequest(true);
      expect(reply.error.code).toBe(4404);
    });

    it("内核没声明时退回 -32601，避免抢答成弃权", async () => {
      const reply = await incomingRequest(false);
      expect(reply.error.code).toBe(-32601);
    });

    it("没收到 capabilities 应答时也不擅自发 4404", async () => {
      const reply = await incomingRequest(null);
      expect(reply.error.code).toBe(-32601);
    });
  });

  describe("server request 应答（帧发出去才算已答）", () => {
    function frames(ws: MockWebSocket): any[] {
      return ws.sent.map((data) => JSON.parse(data));
    }

    function reply(ws: MockWebSocket, id: string): any[] {
      return frames(ws).filter((frame) => frame.id === id);
    }

    async function openClient(): Promise<{ client: GatewayClient; ws: MockWebSocket }> {
      const client = new GatewayClient();
      const connected = client.connect();
      const ws = MockWebSocket.instances[0];
      ws.open();
      await connected;
      return { client, ws };
    }

    it("应答一次后同一 id 不再重复发帧", async () => {
      const { client, ws } = await openClient();

      expect(client.respondToServerRequest("srq-a", { choice: "yes" })).toBe(true);
      expect(client.respondToServerRequest("srq-a", { choice: "no" })).toBe(false);

      expect(reply(ws, "srq-a")).toEqual([
        { jsonrpc: "2.0", id: "srq-a", result: { choice: "yes" } },
      ]);
      client.close();
    });

    it("socket 不在 OPEN 时不标记已答，重连后同一个 id 还能再答", async () => {
      const { client, ws } = await openClient();

      ws.close();
      expect(client.state).toBe("closed");
      expect(client.respondToServerRequest("srq-b", { choice: "yes" })).toBe(false);
      expect(reply(ws, "srq-b")).toHaveLength(0);

      const reconnected = client.connect();
      const next = MockWebSocket.instances[1];
      next.open();
      await reconnected;

      expect(client.respondToServerRequest("srq-b", { choice: "yes" })).toBe(true);
      expect(reply(next, "srq-b")).toEqual([
        { jsonrpc: "2.0", id: "srq-b", result: { choice: "yes" } },
      ]);
      client.close();
    });

    it("连接重建后清空已答集合，内核重投的同一 id 可以重新应答", async () => {
      const { client, ws } = await openClient();
      expect(client.respondToServerRequest("srq-c", { value: "1" })).toBe(true);

      ws.close();
      const reconnected = client.connect();
      const next = MockWebSocket.instances[1];
      next.open();
      await reconnected;

      expect(client.respondToServerRequest("srq-c", { value: "2" })).toBe(true);
      expect(reply(next, "srq-c")).toEqual([
        { jsonrpc: "2.0", id: "srq-c", result: { value: "2" } },
      ]);
      client.close();
    });

    it("同一连接上重投同一个 id 时允许重新应答", async () => {
      const { client, ws } = await openClient();
      const seen: string[] = [];
      client.onServerRequest("approval", (_params, id) => {
        seen.push(id);
      });

      const deliver = () =>
        ws.onmessage?.({
          data: JSON.stringify({ jsonrpc: "2.0", id: "srq-redo", method: "approval", params: {} }),
        });

      deliver();
      expect(client.respondToServerRequest("srq-redo", { choice: "yes" })).toBe(true);
      expect(client.respondToServerRequest("srq-redo", { choice: "yes" })).toBe(false);

      // 内核又投了一次同一个 id ＝ 上次应答没到，卡片必须还能答
      deliver();
      expect(seen).toEqual(["srq-redo", "srq-redo"]);
      expect(client.respondToServerRequest("srq-redo", { choice: "no" })).toBe(true);
      client.close();
    });

    it("把 handler 的返回值当应答帧", async () => {
      const { client, ws } = await openClient();
      client.onServerRequest("custom.pick", (params: any) => ({ picked: params?.options?.[0] }));

      ws.onmessage?.({
        data: JSON.stringify({
          jsonrpc: "2.0",
          id: "srq-d",
          method: "custom.pick",
          params: { options: ["alpha", "beta"] },
        }),
      });

      await vi.waitFor(() => {
        expect(reply(ws, "srq-d")).toEqual([
          { jsonrpc: "2.0", id: "srq-d", result: { picked: "alpha" } },
        ]);
      });
      client.close();
    });

    it("handler 返回 undefined 时不擅自应答（由 handler 自己发帧）", async () => {
      const { client, ws } = await openClient();
      client.onServerRequest("custom.silent", () => undefined);

      ws.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", id: "srq-e", method: "custom.silent", params: {} }),
      });
      await Promise.resolve();

      expect(reply(ws, "srq-e")).toHaveLength(0);
      client.close();
    });
  });

  describe("拨号前刷新凭证", () => {
    it("桌面桥存在时先刷新 gateway URL / token 再拨号", async () => {
      const refresh = vi.fn().mockResolvedValue({
        gatewayUrl: "ws://fresh/api/ws?token=fresh-token",
        sessionToken: "fresh-token",
      });
      vi.stubGlobal("window", {
        location: { href: "http://localhost:9545/tasks/s1", protocol: "http:" },
        __HERMES_SESSION_TOKEN__: "stale-token",
        __HERMES_RUNTIME__: {
          gatewayUrl: "ws://stale/api/ws?token=stale-token",
          sessionToken: "stale-token",
        },
        hermesDesktop: { refreshGatewayUrl: refresh },
      });

      const client = new GatewayClient();
      const connected = client.connect();
      await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      MockWebSocket.instances[0].open();
      await connected;

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(MockWebSocket.instances[0].url).toBe("ws://fresh/api/ws?token=fresh-token");
      client.close();
    });

    it("重新登录后的 forceReconnect 也走同一条刷新路径", async () => {
      const refresh = vi
        .fn()
        .mockResolvedValueOnce({ gatewayUrl: "ws://first/api/ws?token=t1", sessionToken: "t1" })
        .mockResolvedValueOnce({ gatewayUrl: "ws://after-login/api/ws?token=t2", sessionToken: "t2" });
      vi.stubGlobal("window", {
        location: { href: "http://localhost:9545/tasks/s1", protocol: "http:" },
        __HERMES_SESSION_TOKEN__: "stale-token",
        __HERMES_RUNTIME__: { sessionToken: "stale-token" },
        hermesDesktop: { refreshGatewayUrl: refresh },
      });

      const client = new GatewayClient();
      client.enableAutoReconnect();
      const connected = client.connect();
      await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      MockWebSocket.instances[0].open();
      await connected;

      client.forceReconnect("oauth-relogin");
      await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(2));
      await vi.waitFor(() =>
        expect(MockWebSocket.instances[1].url).toBe("ws://after-login/api/ws?token=t2"),
      );
      expect(refresh).toHaveBeenCalledTimes(2);
      client.close();
    });
  });
});
