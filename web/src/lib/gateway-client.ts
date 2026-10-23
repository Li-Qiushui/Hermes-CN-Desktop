import { parseGatewayEvent, type GatewayEvent } from "@hermes/protocol";
import { debugBus } from "./debug-bus";
import {
  cachedUnsupportedMethod,
  forgetGatewayCapabilities,
  rememberUnsupportedMethod,
} from "./gateway-capabilities";
import { classifyGatewayError, GatewayRpcError } from "./gateway-result";
import { runtime } from "./runtime";
import {
  mergeReplayWindow,
  planReplay,
  SessionSeqLedger,
  type ReplayDegradeReason,
  type SeqEventLike,
  type SessionEventsSinceAnswer,
} from "./session-replay";
import { assertCompatible, resetVersionCheck } from "./version-check";

export type ConnectionState = "idle" | "connecting" | "open" | "closed" | "error";

const DEFAULT_RPC_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/**
 * 只有「当前窗口正在看着这个会话」才答得出的请求（对齐官方
 * `WINDOW_OWNED_REQUESTS`，apps/desktop/src/app/session/hooks/use-message-stream/
 * gateway-event/server-requests.ts）。我们不是那个窗口时按「弃权」应答。
 */
const WINDOW_OWNED_REQUESTS = new Set([
  "preview.read",
  "preview.act",
  "terminal.read",
  "window.read",
  "tour",
]);
/** 内核 `_is_not_shown` 只认这个码：弃权，不结算请求，等宿主窗口回答。 */
const NOT_SHOWN_CODE = 4404;
const NOT_SHOWN_MESSAGE = "No Hermes desktop window is showing this session.";

// 心跳口径对齐官方桌面端：15s 一条 `gateway.ping`，45s 没有任何入站帧判假死。
// 判死刻意不是"pong 有多老"，而是"上一次 ping 之后是否整段静默"——隐藏窗口把
// tick 节流到 60s 也不会误杀（官方 json-rpc-channel.ts:537-588）。
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_DEADLINE_MS = 45_000;
// 一个卡住的后台会话不该拖住整轮补帧：单次重放请求有界（官方 10s）。
const REPLAY_REQUEST_TIMEOUT_MS = 10_000;

// 对齐官方桌面端(apps/desktop use-gateway-boot.ts):min(15s, 1s·2^min(n,4))。
// 上限压在 15s 还有一个服务端原因:WS 断开后空闲会话只有 20s 回收宽限
// (_WS_ORPHAN_REAP_GRACE_S),首批重试必须落在宽限内。
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 15_000;
const RECONNECT_EXP_CAP = 4;
const RECONNECT_MAX_ATTEMPTS = Infinity;

const WAKE_WATCHDOG_INTERVAL_MS = 2_000;
// 比 watchdog 间隔大得多——正常 tick 间隔约 2s，超过这个值基本只有
// 进程被冻结过（macOS 睡眠 / OS 节流 / 标签页 background）才会出现。
const WAKE_GAP_THRESHOLD_MS = 5_000;

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** 出站请求的 method，错误帧分类要靠它认「哪个能力不支持」。 */
  method?: string;
}

export interface GatewayRequestOptions {
  timeoutMs?: number;
  connectTimeoutMs?: number;
}

export interface GatewayConnectOptions {
  timeoutMs?: number;
  /** 拨号前是否重取一次 gateway URL / session token（默认 true，见 connect）。 */
  refresh?: boolean;
}

/**
 * 只有桌面桥能在拨号前拿到新凭证：页面加载时抓到的那份 token 会随内核重启失效
 * （dashboard 每次重启重新生成），缓存 URL 直接拨号就是 401。
 */
function canRefreshCredentials(): boolean {
  if (typeof window === "undefined") return false;
  return typeof window.hermesDesktop?.refreshGatewayUrl === "function";
}

/**
 * 线上事件信封（`tui_gateway/ws.py` / `apps/shared/src/gateway-events.ts`）里我们
 * 额外用到的字段：`seq` 每会话单调、`replay_epoch` canonical 的会话级编号身份。
 * protocol 包的 zod schema 是 passthrough，这些键会原样留下来。
 */
type GatewaySeqEvent = {
  type: string;
  session_id?: string;
  payload?: unknown;
  seq?: number;
  replay_epoch?: string;
  replayed?: boolean;
};

// 与原生 WebSocket 构造签名一致的工厂。默认直接 new WebSocket;打包态 webview
// 开不了 ws://127.0.0.1 时换成 Rust 中继 socket(gateway-relay-socket.ts),
// 两条路径线协议完全相同,客户端其余逻辑无感。
export type GatewaySocketFactory = (url: string) => WebSocket;

export class GatewayClient {
  private readonly socketFactory: GatewaySocketFactory;

  constructor(socketFactory?: GatewaySocketFactory) {
    this.socketFactory = socketFactory ?? ((url) => new WebSocket(url));
  }

  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private _state: ConnectionState = "idle";
  private stateListeners = new Set<(s: ConnectionState) => void>();
  private typedListeners = new Map<string, Set<(ev: GatewayEvent) => void>>();
  private anyListeners = new Set<(ev: GatewayEvent) => void>();
  private pending = new Map<string, PendingRequest>();
  private serverRequestHandlers = new Map<
    string,
    (params: any, requestId: string) => unknown | Promise<unknown>
  >();
  private settledServerRequests = new Set<string>();
  /** 内核是否认 4404 弃权帧（`client.capabilities` 结果里的 `declines_not_shown`）。 */
  private backendCountsDeclines = false;
  private nextId = 1;
  private abortConnect: (() => void) | null = null;

  private autoReconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  /** Set when the gateway closed with an auth code (4401/4403): the session is
   * dead, so blind reconnecting is pointless. Cleared by an explicit
   * forceReconnect (issued after the user re-logs in). */
  private authSuspended = false;

  private wakeWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastWakeTickAt = 0;
  private boundOnlineHandler: (() => void) | null = null;
  private boundVisibilityHandler: (() => void) | null = null;
  private unsubscribeSystemResume: (() => void) | null = null;
  private wakeListenersInstalled = false;

  /** 每会话 seq 水位 + 进程 epoch（见 lib/session-replay.ts）。 */
  private readonly seqLedger = new SessionSeqLedger();
  /** 正在为该会话补帧（实时帧跳号触发），期间不再叠第二轮。 */
  private readonly seqResyncInFlight = new Set<string>();
  /** 业务持久 id ↔ 本次连接的运行时 session_id。legacy 的运行时 id 换连接就失效。 */
  private readonly runtimeByKey = new Map<string, string>();
  private readonly keyByRuntime = new Map<string, string>();
  /** 补帧请求在飞时，该会话的实时帧先停在这里，等重放窗口投递完再按 seq 放行。 */
  private replayHold: Map<string, SeqEventLike[]> | null = null;
  private replayGeneration = 0;
  /** 后端换进程的次数。重连恢复拿它判断「这次 resume 期间内核是不是重启过」。 */
  private epochTransitions = 0;
  /** 内核换进程后水位作废的会话：重连恢复取走标记，用快照覆盖时间线。 */
  private snapshotRequiredKeys = new Set<string>();

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatSeq = 0;
  private lastInboundAt = 0;
  private lastPingAt = 0;

  get state() { return this._state; }

  private setState(s: ConnectionState) {
    if (this._state === s) return;
    this._state = s;
    if (s !== "open") this.stopHeartbeat();
    this.stateListeners.forEach((cb) => cb(s));
  }

  enableAutoReconnect() {
    this.autoReconnect = true;
    this.installWakeListeners();
  }

  disableAutoReconnect() {
    this.autoReconnect = false;
    this.cancelReconnect();
    this.removeWakeListeners();
  }

  connect(options?: GatewayConnectOptions | number): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.intentionalClose = false;

    const connectTimeoutMs =
      typeof options === "number"
        ? options
        : options?.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    // 所有拨号点（connect / request / wake / 退避重连 / 重新登录）都收敛到这一个入口：
    // 桌面桥在就先换凭证再拨，避免拿页面加载时那份已失效的 token 去撞 401。
    const refresh =
      (typeof options === "number" || options?.refresh !== false) && canRefreshCredentials();

    if (!refresh) return this.trackConnect(this.openSocket(connectTimeoutMs));
    return this.trackConnect(this.refreshCredentialsThenOpen(connectTimeoutMs));
  }

  private async refreshCredentialsThenOpen(connectTimeoutMs: number): Promise<void> {
    await this.refreshCredentials();
    if (this.intentionalClose) throw new Error("WebSocket closed");
    if (this.ws?.readyState === WebSocket.OPEN) return;
    await this.openSocket(connectTimeoutMs);
  }

  private trackConnect(promise: Promise<void>): Promise<void> {
    this.connectPromise = promise;
    const clear = () => {
      if (this.connectPromise === promise) this.connectPromise = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  private async refreshCredentials(): Promise<void> {
    try {
      await runtime.refreshGatewayUrl();
    } catch (error) {
      // 拿不到新凭证也照原路拨号：这一拨可能 401，但总比永远不重连好。
      debugBus.push({
        type: "gateway",
        level: "warn",
        summary: `gateway credential refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private openSocket(connectTimeoutMs: number): Promise<void> {
    let promise: Promise<void>;
    promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let connectTimer: ReturnType<typeof setTimeout> | null = null;
      let ws: WebSocket;
      const isCurrentSocket = () => this.ws === ws;
      const clearConnectTimer = () => {
        if (!connectTimer) return;
        clearTimeout(connectTimer);
        connectTimer = null;
      };
      const clearConnectState = () => {
        clearConnectTimer();
        if (this.connectPromise === promise) {
          this.connectPromise = null;
        }
        this.abortConnect = null;
      };
      const settleOpen = () => {
        if (!isCurrentSocket()) return;
        if (settled) return;
        settled = true;
        clearConnectState();
        this.reconnectAttempts = 0;
        // 换了一条连接：内核重投的 open_requests 是「同一个 id」，上一条连接里的
        // 「已应答」记录不能跨连接生效，否则重连后的卡片点了也不发帧。
        this.settledServerRequests.clear();
        // 换了连接就可能换了内核：上一轮「不支持某方法」的结论必须作废。
        forgetGatewayCapabilities();
        this.setState("open");
        this.advertiseServerRequests();
        this.startHeartbeat();
        resolve();
      };
      const settleConnectError = (err: Error, state: ConnectionState) => {
        if (settled) return;
        settled = true;
        clearConnectState();
        this.setState(state);
        reject(err);
      };
      const abortConnect = () => {
        settleConnectError(new Error("WebSocket closed"), "idle");
      };
      const rejectPending = (message: string) => {
        this.pending.forEach(({ reject: rej, timer }) => {
          clearTimeout(timer);
          rej(new Error(message));
        });
        this.pending.clear();
      };

      this.setState("connecting");

      // Hard version-compatibility gate: refuse to open a WebSocket against an
      // unchecked or incompatible backend. The cached state is invalidated by
      // runtime reconnect / profile-switch helpers in runtime.ts.
      assertCompatible();

      try {
        ws = this.socketFactory(runtime.getGatewayUrl());
      } catch (e) {
        this.setState("error");
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      this.ws = ws;
      this.abortConnect = abortConnect;

      connectTimer = setTimeout(() => {
        if (!isCurrentSocket()) return;
        if (settled) return;
        this.ws = null;
        try { ws.close(); } catch {}
        settleConnectError(new Error("WebSocket connection timeout"), "error");
        this.scheduleReconnect();
      }, connectTimeoutMs);

      ws.onopen = settleOpen;

      ws.onclose = (ev?: { code?: number; reason?: string }) => {
        if (!isCurrentSocket()) return;

        this.ws = null;

        if (!settled) {
          settleConnectError(new Error("WebSocket closed"), "closed");
        } else {
          this.setState("closed");
        }

        rejectPending("WebSocket closed");

        // 4401 = credentials rejected, 4403 = host/origin rejected. Neither is
        // fixed by reconnecting — suppress the loop and surface an auth event
        // so the UI prompts re-login (4401) or explains the block (4403).
        const code = ev?.code;
        if (code === 4401 || code === 4403) {
          this.authSuspended = true;
          this.cancelReconnect();
          this.emit({
            type: "gateway.auth_required",
            payload: { code, reason: ev?.reason ?? null },
          } as unknown as GatewayEvent);
          this.emitDisconnect();
          return;
        }

        if (!this.intentionalClose) {
          this.emitDisconnect();
          this.scheduleReconnect();
        }
      };

      ws.onerror = () => {
        if (!isCurrentSocket()) return;
        this.ws = null;
        if (!settled) {
          settleConnectError(new Error("WebSocket connection failed"), "error");
        } else {
          this.setState("error");
        }
        rejectPending("WebSocket connection failed");
        try { ws.close(); } catch {}
        if (!this.intentionalClose) {
          this.emitDisconnect();
          this.scheduleReconnect();
        }
      };

      ws.onmessage = (ev) => {
        if (!isCurrentSocket()) return;
        try {
          this.handleFrame(JSON.parse(ev.data));
        } catch {
          this.emit({
            type: "gateway.protocol_error",
            payload: { message: "Malformed gateway frame" },
          });
        }
      };
    });

    return promise;
  }

  private emitDisconnect() {
    this.emit({
      type: "gateway.disconnected",
      payload: { message: "WebSocket connection lost" },
    });
  }

  private scheduleReconnect() {
    if (!this.autoReconnect || this.intentionalClose) return;
    // Auth-suspended: a dead session won't heal by reconnecting. Wait for an
    // explicit forceReconnect after the user re-authenticates.
    if (this.authSuspended) return;
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) return;

    const ceiling = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.min(this.reconnectAttempts, RECONNECT_EXP_CAP)),
      RECONNECT_MAX_DELAY_MS,
    );
    // full jitter：在 [0, ceiling) 里随机，别让一排客户端在后端重启后同一刻醒来
    // 把重连打成风暴（官方 reconnect-backoff.ts:51-57）。
    const delay = Math.random() * ceiling;

    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.intentionalClose || this._state === "open") return;
      // 退避重连本来就是异步的：先把凭证换成真的（web dev 的 /__hermes_token 也在
      // 这一步），拨号时就不再重复刷新。
      await this.refreshCredentials();
      this.connect({ refresh: false }).catch(() => {});
    }, delay);
  }

  private cancelReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private handleFrame(frame: any) {
    // 任何入站帧都算"链路活着"（流式 delta 本身就是心跳），心跳判死靠它。
    this.lastInboundAt = Date.now();

    if (frame.id != null && this.pending.has(String(frame.id))) {
      const p = this.pending.get(String(frame.id))!;
      this.pending.delete(String(frame.id));
      clearTimeout(p.timer);
      if (frame.error) {
        const rawMessage = frame.error.message ?? `RPC error ${frame.error.code}`;
        const code = typeof frame.error.code === "number" ? frame.error.code : undefined;
        const info = classifyGatewayError(
          new GatewayRpcError(rawMessage, { method: p.method, code }),
        );
        if (info.kind === "unsupported-method") {
          // 首次报不支持才落缓存 + 记一条诊断；后续请求在 request() 里快失败。
          const firstTime = !cachedUnsupportedMethod(info.method);
          rememberUnsupportedMethod(info);
          if (firstTime) {
            debugBus.push({
              type: "gateway",
              level: "warn",
              summary: `内核不支持该 RPC（${info.method ?? "未知方法"}），已降级`,
              payload: { method: info.method, code: info.code },
            });
          }
        }
        p.reject(
          info.kind === "unsupported-method"
            ? new GatewayRpcError(info.message, { method: info.method, code: info.code, cause: rawMessage })
            : new GatewayRpcError(rawMessage, { method: p.method, code }),
        );
      } else {
        p.resolve(frame.result);
      }
      return;
    }

    // Server→client request (clarify / approval / sudo / …): the backend asks
    // the renderer a question and waits for a response frame carrying this id.
    if (typeof frame.method === "string" && frame.id != null) {
      void this.handleServerRequest(String(frame.id), frame.method, frame.params);
      return;
    }

    if (frame.method === "event" && frame.params) {
      const params = frame.params;
      const ev = parseGatewayEvent({
        type: params.type,
        session_id: params.session_id,
        payload: params.payload,
        seq: params.seq,
        ...(params.replay_epoch ? { replay_epoch: params.replay_epoch } : {}),
      }) as GatewaySeqEvent;
      // `gateway.ready` means the backend finished handshaking this connection:
      // re-assert the capability here too, so a proxy that reorders frames
      // cannot leave us looking like a client that never advertises.
      if (ev.type === "gateway.ready") {
        this.advertiseServerRequests();
        this.onGatewayReady(params?.payload);
      }
      this.ingestEvent(ev);
    }
  }

  /**
   * 记每个会话的 seq 水位，同一 seq 只投一次。补帧请求在飞时会话的实时帧先
   * 停进 replayHold，等重放窗口投递完再按 seq 放行——否则「实时帧先派发 +
   * 重放又发一遍」就是重复消息，「实时帧先把水位推高」则会把缺口永久跳过。
   */
  private ingestEvent(event: GatewayEvent) {
    const seqEvent = event as unknown as GatewaySeqEvent;
    const sessionId = typeof seqEvent.session_id === "string" ? seqEvent.session_id : "";
    const seq = typeof seqEvent.seq === "number" && Number.isFinite(seqEvent.seq) ? seqEvent.seq : null;

    // session-less 广播（sessions.changed / platforms.changed）没有 seq，
    // 也没有顺序契约，直接投。
    if (!sessionId || seq === null) {
      this.emit(event);
      return;
    }

    const key = this.keyByRuntime.get(sessionId) ?? sessionId;
    const held = this.replayHold?.get(key);
    if (held) {
      held.push(seqEvent);
      return;
    }

    const watermark = this.seqLedger.seqOf(key);
    if (seq <= watermark) return;
    // 实时帧跳号 = 中间那段丢了（legacy 不做重投）。这里不投这条、也不推水位，
    // 直接按本地水位补一次帧；补回来的窗口会按序把缺的补上。
    if (watermark > 0 && seq > watermark + 1) {
      this.requestSeqResync(key, watermark);
      return;
    }
    this.seqLedger.advance(key, seq, seqEvent.replay_epoch);
    this.emit(event);
  }

  /**
   * 实时帧出现 seq 缺口时的补帧。同一会话同时只跑一轮（重连风暴/连续跳号不叠加），
   * 补帧成功就把水位推过缺口，失败则水位不动、等下一帧再判。
   */
  private requestSeqResync(key: string, watermark: number) {
    if (this.seqResyncInFlight.has(key)) return;
    this.seqResyncInFlight.add(key);
    debugBus.push({
      type: "gateway",
      level: "warn",
      summary: `seq gap on session ${key}: expected ${watermark + 1}, resyncing from ${watermark}`,
      payload: { session_id: key, watermark },
    });
    void this.replaySession(key, this.runtimeByKey.get(key) ?? key).finally(() => {
      this.seqResyncInFlight.delete(key);
    });
  }

  /**
   * `gateway.ready` 带着进程级 `replay_epoch`：进程重启会换 epoch，本地 seq 水位
   * 就描述了一套不存在的编号。此时逐会话请上层拿快照（session.replay_gap → 全量
   * resume），并把在飞的补帧作废。
   */
  private onGatewayReady(payload: any) {
    const heartbeat = payload?.heartbeat;
    if (heartbeat === false) this.stopHeartbeat();

    const before = this.seqLedger.snapshot();
    const { changed, transitioned } = this.seqLedger.adoptProcessEpoch(payload?.replay_epoch);
    if (!changed) return;

    if (transitioned) {
      this.epochTransitions += 1;
      for (const entry of before) {
        if (entry.seq > 0) this.snapshotRequiredKeys.add(entry.key);
      }
    }
    this.cancelReplayHold();
    for (const entry of before) {
      if (entry.seq <= 0) continue;
      this.emitReplayGap(entry.key, "epoch_changed", entry.seq);
    }
  }

  /** 后端换进程的代数：重连恢复在 resume 前后各取一次，变了就说明水位不可信。 */
  epochGeneration(): number {
    return this.epochTransitions;
  }

  /**
   * 「这个会话的水位已经作废，重连时要拿快照覆盖」的一次性标记。内核换进程时由
   * `gateway.ready` 记下，重连恢复取走它——比对比代数更稳，不依赖 ready 帧与
   * `open` 状态谁先到。
   */
  consumeSnapshotRequest(key: string): boolean {
    return this.snapshotRequiredKeys.delete(key);
  }

  private cancelReplayHold() {
    this.replayGeneration += 1;
    this.replayHold = null;
  }

  private emitReplayGap(key: string, reason: ReplayDegradeReason, latestSeq: number) {
    debugBus.push({
      type: "gateway",
      level: "warn",
      summary: `session replay degraded (${reason}); falling back to full session.resume`,
      payload: { session_id: key, reason, latest_seq: latestSeq },
    });
    this.emit({
      type: "session.replay_gap",
      session_id: this.runtimeByKey.get(key) ?? key,
      payload: { session_id: key, reason, latest_seq: latestSeq },
    } as unknown as GatewayEvent);
  }

  /**
   * 把业务持久 id 与本次连接的运行时 session_id 绑到一起，水位跟着持久 id 走。
   *
   * 创建路径是先有运行时 id、后从 `session.title` 学到持久 id，所以同一个运行时 id
   * 可能先挂在运行时 id 这个 key 下面。这里把旧 key 的记录并过来再删掉，否则重连时
   * 两条记录会各发一次 `session.resume`（其中一个还拿着失效的运行时 id）。
   */
  bindSession(key: string, runtimeSessionId: string): void {
    const runtimeId = runtimeSessionId || key;

    const staleKeys: string[] = [];
    for (const [staleKey, staleRuntime] of [...this.runtimeByKey.entries()]) {
      if (staleKey !== key && staleRuntime === runtimeId) {
        staleKeys.push(staleKey);
        this.runtimeByKey.delete(staleKey);
      }
    }

    this.runtimeByKey.set(key, runtimeId);
    this.keyByRuntime.set(runtimeId, key);
    const existing = this.seqLedger.ensure(key);
    if (runtimeId !== key) staleKeys.push(runtimeId);

    // 断线期间/恢复前按旧 key 记下的水位要并过来，否则重放会把已投过的帧再投一遍。
    for (const sourceKey of staleKeys) {
      if (sourceKey === key) continue;
      const stray = this.seqLedger.cursor(sourceKey);
      if (!stray) continue;
      if (stray.seq > existing.seq) this.seqLedger.advance(key, stray.seq, stray.epoch);
      this.seqLedger.drop(sourceKey);
    }
  }

  /** 已订阅的会话（key 为持久 id，尽量带上本次连接的运行时 id 与水位）。 */
  trackedSessions(): Array<{ sessionId: string; runtimeSessionId: string; lastSeen: number }> {
    const keys = new Set<string>(this.runtimeByKey.keys());
    for (const entry of this.seqLedger.snapshot()) keys.add(entry.key);
    return [...keys].map((key) => ({
      sessionId: key,
      runtimeSessionId: this.runtimeByKey.get(key) ?? key,
      lastSeen: this.seqLedger.seqOf(key),
    }));
  }

  /**
   * 对一个已订阅会话走一次 `session.events.since` 补帧。三种退化条件（水位超前 /
   * epoch 变化 / seq 缺口）不信 legacy 的 `truncated`，直接丢水位并抛
   * `session.replay_gap`；`onDegraded` 让调用方在原地（replayHold 还没放行时）
   * 用快照覆盖时间线，避免「先放行实时帧、再拿快照盖掉」丢帧。
   */
  async replaySession(
    sessionId: string,
    runtimeSessionId?: string,
    hooks?: { onDegraded?: (reason: ReplayDegradeReason, latestSeq: number) => void },
  ): Promise<{ status: "replayed" | "skipped" | "degraded" | "failed"; dispatched: number; reason?: ReplayDegradeReason }> {
    const key = sessionId;
    this.bindSession(key, runtimeSessionId ?? this.runtimeByKey.get(key) ?? key);
    const runtimeId = this.runtimeByKey.get(key) ?? key;
    const cursor = this.seqLedger.cursor(key);
    const lastSeen = cursor?.seq ?? 0;

    // 还没见过任何事件：没有缺口可言，重放只会和 REST 历史重复。
    if (lastSeen <= 0) return { status: "skipped", dispatched: 0 };
    if (this.replayHold?.has(key)) return { status: "skipped", dispatched: 0 };

    const generation = this.replayGeneration;
    const hold = this.replayHold ?? new Map<string, SeqEventLike[]>();
    hold.set(key, []);
    this.replayHold = hold;

    try {
      const answer = await this.request<SessionEventsSinceAnswer>(
        "session.events.since",
        { session_id: runtimeId, last_seen: lastSeen },
        { timeoutMs: REPLAY_REQUEST_TIMEOUT_MS },
      );
      if (this.replayGeneration !== generation) return { status: "skipped", dispatched: 0 };

      const decision = planReplay({ cursor, processEpoch: this.seqLedger.epoch, answer });
      if (decision.degrade) {
        const watermark = this.seqLedger.seqOf(key);
        this.seqLedger.drop(key);
        // 快照权威：seq 不超过旧水位的暂存帧快照里已经有了，丢掉免得重复气泡；
        // 快照之后才到的实时帧必须留下，等 hydrate 完由 finally 放行（全丢会断一截）。
        this.dropParkedThrough(key, watermark);
        this.emitReplayGap(key, decision.degrade, decision.latestSeq);
        hooks?.onDegraded?.(decision.degrade, decision.latestSeq);
        return { status: "degraded", dispatched: 0, reason: decision.degrade };
      }

      const epoch = answer?.replay_epoch ?? answer?.epoch ?? null;
      let dispatched = 0;
      for (const replayed of decision.dispatch) {
        const seq = replayed.seq!;
        if (!this.seqLedger.advance(key, seq, epoch)) continue;
        dispatched += 1;
        this.emit(
          parseGatewayEvent({
            type: replayed.type,
            session_id: replayed.session_id,
            payload: replayed.payload,
            seq,
            replayed: true,
          }) as GatewaySeqEvent,
        );
      }
      debugBus.push({
        type: "gateway",
        level: "info",
        summary: `replayed ${dispatched} event(s) for session ${key}`,
        payload: { session_id: key, last_seen: lastSeen, latest_seq: decision.latestSeq },
      });
      return { status: "replayed", dispatched };
    } catch (error) {
      // 补帧是"尽力而为"：失败就等下一次重连，绝不影响 socket 本身。
      debugBus.push({
        type: "gateway",
        level: "info",
        summary: `session replay failed: ${error instanceof Error ? error.message : String(error)}`,
        payload: { session_id: key, last_seen: lastSeen },
      });
      return { status: "failed", dispatched: 0 };
    } finally {
      if (this.replayGeneration === generation) this.flushReplayHold(key);
    }
  }

  /** 只丢「快照里已经有」的暂存帧（seq <= 水位）；快照之后的帧留给 finally 放行。 */
  private dropParkedThrough(key: string, watermark: number) {
    const hold = this.replayHold;
    const parked = hold?.get(key);
    if (!hold || !parked) return;
    const kept = parked.filter((event) => typeof event.seq !== "number" || event.seq > watermark);
    if (kept.length > 0) {
      hold.set(key, kept);
      return;
    }
    hold.delete(key);
    if (hold.size === 0) this.replayHold = null;
  }

  /** 放行补帧期间暂存的实时帧，按 seq 排序 + 去重（同 seq 不重复投）。 */
  private flushReplayHold(key: string) {
    const hold = this.replayHold;
    const parked = hold?.get(key);
    if (!hold || !parked) return;
    hold.delete(key);
    if (hold.size === 0) this.replayHold = null;

    for (const event of mergeReplayWindow([], parked)) {
      const seq = typeof event.seq === "number" ? event.seq : null;
      if (seq !== null && seq <= this.seqLedger.seqOf(key)) continue;
      if (seq !== null) this.seqLedger.advance(key, seq);
      this.emit(event as unknown as GatewayEvent);
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.lastInboundAt = Date.now();
    this.lastPingAt = 0;
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private heartbeatTick() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();

    // 判死条件是"上一次 ping 之后整段静默"，不是"pong 有多老"：隐藏窗口把
    // tick 节流到 60s 一次也不会误杀健康连接（官方口径 any-inbound）。
    if (this.lastPingAt > this.lastInboundAt && now - this.lastInboundAt >= HEARTBEAT_DEADLINE_MS) {
      this.handleHeartbeatTimeout(now - this.lastInboundAt);
      return;
    }

    this.lastPingAt = now;
    try {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `heartbeat-${this.nextId++}`,
          method: "gateway.ping",
          params: {},
        }),
      );
    } catch (error) {
      this.handleHeartbeatTimeout(0, error);
    }
  }

  /** 45s 无任何入站帧：socket 大概率是半开的，主动拆掉并按退避重连。 */
  private handleHeartbeatTimeout(silentMs: number, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : "";
    debugBus.push({
      type: "gateway",
      level: "warn",
      summary: `gateway heartbeat timeout: ${silentMs}ms without inbound frames${detail ? ` (${detail})` : ""}`,
    });

    const ws = this.ws;
    this.ws = null;
    this.connectPromise = null;
    this.abortConnect = null;
    this.stopHeartbeat();
    this.cancelReplayHold();
    this.rejectAllPending("WebSocket heartbeat timed out");
    if (ws) {
      try { ws.close(); } catch {}
    }
    this.setState("closed");
    if (this.intentionalClose) return;
    this.emitDisconnect();
    this.scheduleReconnect();
  }

  private rejectAllPending(message: string) {
    this.pending.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(new Error(message));
    });
    this.pending.clear();
  }

  /**
   * Tell the backend this build answers server→client requests. Without it the
   * kernel fails every such request fast ("the attached client predates
   * server→client requests") and clarify/approval prompts never reach the UI.
   */
  private advertiseServerRequests() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const id = `cap-${this.nextId++}`;
    const timer = setTimeout(() => this.pending.delete(id), 5000);
    this.pending.set(id, {
      resolve: (result) => {
        // 内核在结果里告诉自己这版是否认「弃权帧」（4404）：只有认，才敢用 4404 而不是
        // -32601，否则 window-owned 类请求会被我们抢答，宿主窗口的真答案就丢了。
        const caps = result as { declines_not_shown?: unknown } | undefined;
        this.backendCountsDeclines = caps?.declines_not_shown === true;
      },
      reject: () => {},
      timer,
    });
    try {
      this.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "client.capabilities",
          params: { server_requests: true },
        }),
      );
    } catch {
      // A failed advertisement only costs prompt cards; the socket's own state
      // reporting already covers a broken transport.
    }
  }

  private async handleServerRequest(id: string, method: string, params: unknown): Promise<void> {
    // 同一个 id 又被投过来，说明上一次应答没到内核：清掉「已答」标记，卡片还能重试。
    this.reopenServerRequest(id);
    const handler = this.serverRequestHandlers.get(method);
    if (!handler) {
      // window-owned 类（预览/终端/窗口读取/引导）只有「那个窗口在看这个会话」才答得出。
      // 我们不是那个窗口时要「弃权」而不是「报错」：报错会立刻结算请求，把真正的答案挤掉。
      if (WINDOW_OWNED_REQUESTS.has(method) && this.backendCountsDeclines) {
        this.failServerRequest(id, NOT_SHOWN_CODE, NOT_SHOWN_MESSAGE);
        return;
      }
      this.failServerRequest(id, -32601, `Unsupported server request: ${method}`);
      return;
    }
    try {
      // handler 可以自己应答（返回 undefined），也可以把返回值当应答帧。
      const answer = await handler(params, id);
      if (answer !== undefined) this.respondToServerRequest(id, answer);
    } catch (error) {
      this.failServerRequest(id, -32603, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Answer a server→client request (same id, exactly once). 只有帧真的发出去才记
   * 「已应答」：socket 不在 OPEN 时返回 false，卡片留在界面上可以重试（重连后内核
   * 会按同一个 id 重投，届时还能再答）。
   */
  respondToServerRequest(id: string, result: unknown): boolean {
    if (this.settledServerRequests.has(id)) return false;
    if (!this.sendServerResponse(id, result)) return false;
    this.markServerRequestSettled(id);
    return true;
  }

  /** Refuse a server→client request so the backend never waits out its deadline. */
  failServerRequest(id: string, code: number, message: string): boolean {
    if (this.settledServerRequests.has(id)) return false;
    if (!this.sendServerResponse(id, undefined, { code, message })) return false;
    this.markServerRequestSettled(id);
    return true;
  }

  /** 内核重投这个 id ＝ 上次应答没送到，允许重新应答（否则卡片永远点不动）。 */
  reopenServerRequest(id: string): void {
    this.settledServerRequests.delete(id);
  }

  private markServerRequestSettled(id: string): void {
    this.settledServerRequests.add(id);
    if (this.settledServerRequests.size > 200) {
      const oldest = this.settledServerRequests.values().next().value;
      if (oldest !== undefined) this.settledServerRequests.delete(oldest);
    }
  }

  private sendServerResponse(
    id: string,
    result?: unknown,
    error?: { code: number; message: string },
  ): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const frame = error
      ? { jsonrpc: "2.0", id, error }
      : { jsonrpc: "2.0", id, result: result ?? {} };
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  /** Register the handler that answers one server→client request method. */
  onServerRequest(
    method: string,
    handler: (params: any, requestId: string) => unknown | Promise<unknown>,
  ): () => void {
    this.serverRequestHandlers.set(method, handler);
    return () => {
      if (this.serverRequestHandlers.get(method) === handler) {
        this.serverRequestHandlers.delete(method);
      }
    };
  }

  private emit(ev: GatewayEvent) {
    this.typedListeners.get(ev.type)?.forEach((cb) => cb(ev));
    this.anyListeners.forEach((cb) => cb(ev));
  }

  async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: GatewayRequestOptions | number,
  ): Promise<T> {
    const cached = cachedUnsupportedMethod(method);
    if (cached) {
      throw new GatewayRpcError(cached.message, { method, code: cached.code });
    }
    const timeoutMs =
      typeof options === "number"
        ? options
        : options?.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    const connectTimeoutMs =
      typeof options === "number"
        ? undefined
        : options?.connectTimeoutMs;

    await this.connect(connectTimeoutMs === undefined ? undefined : { timeoutMs: connectTimeoutMs });

    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not connected"));
        return;
      }
      const id = `w${this.nextId++}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      try {
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  on(type: string, cb: (ev: GatewayEvent) => void): () => void {
    if (!this.typedListeners.has(type)) this.typedListeners.set(type, new Set());
    const set = this.typedListeners.get(type)!;
    set.add(cb);
    return () => set.delete(cb);
  }

  onAny(cb: (ev: GatewayEvent) => void): () => void {
    this.anyListeners.add(cb);
    return () => this.anyListeners.delete(cb);
  }

  onState(cb: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(cb);
    cb(this._state);
    return () => this.stateListeners.delete(cb);
  }

  // 主动触发一次"假定连接已死"路径：tear down 当前 ws / 在飞 connect，
  // 重置 backoff，立刻重连。给 powerMonitor.on('resume') 这种外部信号用。
  forceReconnect(reason = "manual"): void {
    // An explicit reconnect (e.g. after re-login) clears the auth-suspend gate.
    this.authSuspended = false;
    this.handleWake(reason, true);
  }

  private installWakeListeners(): void {
    if (this.wakeListenersInstalled) return;
    this.wakeListenersInstalled = true;

    // 桌面端有 Electron powerMonitor.on('resume') 走 IPC（preload 注入的
    // onSystemResume），它是 OS 真实唤醒信号，不会被主线程长任务误触发。
    // JS 侧 setInterval watchdog 在桌面端只会成为噪声源——长 markdown / shiki
    // 渲染 block 主线程几秒就会被当作"睡过觉"，把健康连接 tear down。
    const hasNativeResumeSignal =
      typeof window !== "undefined" && typeof window.hermesDesktop?.onSystemResume === "function";

    if (!hasNativeResumeSignal) {
      this.lastWakeTickAt = Date.now();
      this.wakeWatchdogTimer = setInterval(() => {
        const now = Date.now();
        const gap = now - this.lastWakeTickAt;
        this.lastWakeTickAt = now;
        // 进程被 OS 冻结超过阈值——大概率睡过觉，已有 socket 多半是半开。
        if (gap > WAKE_GAP_THRESHOLD_MS) {
          this.handleWake(`clock-skew ${gap}ms`, true);
        }
      }, WAKE_WATCHDOG_INTERVAL_MS);
    }

    // visibility / online 是"提示"级信号——用户 alt-tab 切回前台或网络恢复
    // 时触发，**OS 没睡过觉**，已有 socket 通常仍然健康。强行 tear down 会
    // 在每次窗口切换都向 UI 砸一发 "连接已断开"。这两条只在 ws 当前不是 OPEN
    // 时才走重连路径（forceful=false）。
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      this.boundOnlineHandler = () => this.handleWake("online", false);
      window.addEventListener("online", this.boundOnlineHandler);
    }
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      this.boundVisibilityHandler = () => {
        if (document.visibilityState === "visible") this.handleWake("visible", false);
      };
      document.addEventListener("visibilitychange", this.boundVisibilityHandler);
    }

    // powerMonitor.resume 是 OS 真正从睡眠里醒来——TCP 半开是常态，必须
    // 强行 tear down。
    const desktop = typeof window !== "undefined" ? window.hermesDesktop : undefined;
    if (desktop?.onSystemResume) {
      this.unsubscribeSystemResume = desktop.onSystemResume(() =>
        this.handleWake("powerMonitor", true),
      );
    }
  }

  private removeWakeListeners(): void {
    if (!this.wakeListenersInstalled) return;
    this.wakeListenersInstalled = false;
    if (this.wakeWatchdogTimer) {
      clearInterval(this.wakeWatchdogTimer);
      this.wakeWatchdogTimer = null;
    }
    if (this.boundOnlineHandler && typeof window !== "undefined") {
      window.removeEventListener("online", this.boundOnlineHandler);
      this.boundOnlineHandler = null;
    }
    if (this.boundVisibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.boundVisibilityHandler);
      this.boundVisibilityHandler = null;
    }
    if (this.unsubscribeSystemResume) {
      this.unsubscribeSystemResume();
      this.unsubscribeSystemResume = null;
    }
  }

  private handleWake(_reason: string, forceful: boolean): void {
    if (!this.autoReconnect || this.intentionalClose) return;

    // forceful=false 是 "提示" 路径（visibility/online）——已经 OPEN 的连接
    // 没必要 tear down。对齐官方桌面端，不主动发 synthetic ping；
    // 半开 socket 由下一次 RPC timeout / WebSocket close-error 兜住，
    // 不至于让窗口每次切回前台都闪 "连接已断开"。
    if (!forceful && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    // 强行抛弃当前 socket / 在飞的 connect promise——OS 唤醒后它们都不可信。
    this.cancelReconnect();
    this.reconnectAttempts = 0;

    const ws = this.ws;
    const hadSocket = ws !== null;
    const hadInflight = this.connectPromise !== null;

    if (hadSocket || hadInflight) {
      this.ws = null;
      this.connectPromise = null;
      // 拒绝挂在旧 socket 上的 RPC——不然要等 120s RPC timeout，UI 卡住。
      this.pending.forEach(({ reject, timer }) => {
        clearTimeout(timer);
        reject(new Error("WebSocket connection lost"));
      });
      this.pending.clear();
      if (ws) {
        try { ws.close(); } catch {}
      }
      this.setState("closed");
      this.emitDisconnect();
    }

    // 立即重连——不走 scheduleReconnect 的 backoff（已经被重置但还有 1s base
    // delay），因为唤醒事件就是"现在"。
    this.connect().catch(() => {});
  }

  close() {
    this.intentionalClose = true;
    this.cancelReconnect();
    this.cancelReplayHold();
    this.removeWakeListeners();
    this.abortConnect?.();
    this.pending.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(new Error("WebSocket closed"));
    });
    this.pending.clear();
    const ws = this.ws;
    this.ws = null;
    this.connectPromise = null;
    if (ws) {
      try { ws.close(); } catch {}
    }
    this.setState("idle");
  }
}

// Public client surface used by call sites (use-gateway.ts / detail.tsx /
// debug-install.ts) and by test doubles. The transport is always JSON-RPC
// over WebSocket against the official /api/ws endpoint — only the socket
// implementation may differ (native WebSocket vs Rust relay), behind
// GatewaySocketFactory.
export type GatewayReplayOutcome = {
  status: "replayed" | "skipped" | "degraded" | "failed";
  dispatched: number;
  reason?: ReplayDegradeReason;
};

export interface GatewayClientLike {
  state: ConnectionState;
  connect(options?: GatewayConnectOptions | number): Promise<void>;
  request<T = unknown>(method: string, params?: Record<string, unknown>, options?: GatewayRequestOptions | number): Promise<T>;
  on(type: string, cb: (ev: GatewayEvent) => void): () => void;
  onAny(cb: (ev: GatewayEvent) => void): () => void;
  onState(cb: (s: ConnectionState) => void): () => void;
  onServerRequest(method: string, handler: (params: any, requestId: string) => unknown | Promise<unknown>): () => void;
  respondToServerRequest(id: string, result: unknown): boolean;
  /** 内核重投同 id 时清掉「已答」标记，允许重新应答。 */
  reopenServerRequest(id: string): void;
  failServerRequest(id: string, code: number, message: string): boolean;
  enableAutoReconnect(): void;
  disableAutoReconnect(): void;
  forceReconnect(reason?: string): void;
  /** 记下"这个持久会话我订阅着"，断线重连后按它逐个补帧。 */
  bindSession(key: string, runtimeSessionId: string): void;
  trackedSessions(): Array<{ sessionId: string; runtimeSessionId: string; lastSeen: number }>;
  /** 后端换进程的代数（`gateway.ready.replay_epoch` 变化次数）。 */
  epochGeneration(): number;
  /** 取走「该会话水位已作废、要拿快照」的一次性标记。 */
  consumeSnapshotRequest(key: string): boolean;
  replaySession(
    sessionId: string,
    runtimeSessionId?: string,
    hooks?: { onDegraded?: (reason: ReplayDegradeReason, latestSeq: number) => void },
  ): Promise<GatewayReplayOutcome>;
  close(): void;
}

let instance: GatewayClient | null = null;

// The socket factory picks native webview WebSocket vs Rust relay (and flips
// automatically when a packaged webview blocks ws:// from tauri://); the
// protocol layer above is identical either way. See gateway-socket-path.ts.
import { createGatewaySocket } from "./gateway-socket-path";

export function getGatewayClient(): GatewayClientLike {
  if (instance) return instance;
  instance = new GatewayClient(createGatewaySocket);
  return instance;
}

export function forceExistingGatewayReconnect(reason = "runtime-restart"): void {
  instance?.forceReconnect(reason);
}
