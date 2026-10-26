/**
 * 重连恢复的统一编排。
 *
 * 背景：legacy 内核的 `session_id` 是"这条连接的内存运行 id"，换一条 socket 就
 * 失效，事件也不会再 fanout 给它。所以重连后每个会话都得先 `session.resume`
 * 重新登记订阅、拿到新的运行时 id，再决定断线期间的事件怎么补回来：
 *
 * 1. 水位可信 → `session.events.since` 按本地 seq 补帧（gateway-client.replaySession）；
 * 2. 水位不可信（水位超前 / epoch 变化 / seq 缺口 / truncated）→ 用**这次 resume
 *    返回的 messages 快照**覆盖时间线。
 *
 * 关键约束：两条路共用同一次 `session.resume`。旧实现是 A 先 resume 再补帧、补帧
 * 判退化后由 `session.replay_gap` 事件触发 B 再 resume 一次，内核重启时必然两条都
 * 走；resume 在内核侧可能重建 agent（minutes-scale），叠加会引发会话归属竞态，
 * `open_requests` 也会重投两次。
 *
 * 这个文件只做编排，取数/状态全由调用方注入，方便单测；jotai / 单例都不进来。
 */

import type { GatewayReplayOutcome } from "./gateway-client";
import type { ReplayDegradeReason } from "./session-replay";

export interface TrackedSessionRef {
  /** 业务持久 id（存储 id）；没有映射时就是运行时 id。 */
  sessionId: string;
  /** 本次连接的运行时 id（legacy 换连接就变）。 */
  runtimeSessionId: string;
  /** 本地已投递到的 seq，0 表示从没收到过事件。 */
  lastSeen: number;
}

/** `session.resume` 结果里本层用得到的字段（legacy/canonical 并集）。 */
export interface ResumeSnapshot {
  session_id: string;
  resumed?: string;
  messages?: unknown[];
  running?: boolean;
  /** 内核把被进程死亡打断的回合自动重跑了一遍（resume 的 `auto_continue`）。 */
  autoContinue?: boolean;
  /** 内核自报的当前回合起点（ms）。 */
  turnStartedAt?: number;
}

export interface HydrateSnapshotParams {
  runtimeSessionId: string;
  persistentId: string;
  messages: unknown[];
  running: boolean;
  autoContinue?: boolean;
  turnStartedAt?: number;
}

export interface ReplaySubscribedSessionsDeps {
  trackedSessions(): TrackedSessionRef[];
  /** 当前正在看的会话由调用方自己 resume（要顺带更新 UI 锚点），这里跳过。 */
  isActive(sessionId: string): boolean;
  resume(sessionId: string): Promise<ResumeSnapshot>;
  bind(sessionId: string, runtimeSessionId: string): void;
  /** `onDegraded` 在暂存实时帧放行前回调，用来先拿快照覆盖时间线。 */
  replay(
    sessionId: string,
    runtimeSessionId: string,
    onDegraded?: () => void,
  ): Promise<GatewayReplayOutcome>;
  /** 补帧判不可信时用这次 resume 的 `messages` 覆盖时间线；不给就只记 degraded。 */
  hydrate?(params: HydrateSnapshotParams): void;
  onError?(sessionId: string, error: unknown): void;
}

export interface ReplaySubscribedSessionsSummary {
  resumed: string[];
  replayed: number;
  degraded: string[];
  failed: string[];
  skipped: number;
}

/**
 * 逐个补帧（串行：会话数很少，但每个 resume 都可能在服务端重建 agent，
 * 并发打过去只会互相拖慢）。单个会话失败不影响其它会话。
 */
export async function replaySubscribedSessions(
  deps: ReplaySubscribedSessionsDeps,
): Promise<ReplaySubscribedSessionsSummary> {
  const summary: ReplaySubscribedSessionsSummary = {
    resumed: [],
    replayed: 0,
    degraded: [],
    failed: [],
    skipped: 0,
  };

  for (const session of deps.trackedSessions()) {
    if (deps.isActive(session.sessionId)) {
      summary.skipped += 1;
      continue;
    }
    if (session.lastSeen <= 0) {
      // 从没见过事件：没有可证明的缺口，重放只会和 REST 历史打架。
      summary.skipped += 1;
      continue;
    }

    try {
      const resumed = await deps.resume(session.sessionId);
      if (!resumed?.session_id) {
        summary.failed.push(session.sessionId);
        continue;
      }
      summary.resumed.push(session.sessionId);
      deps.bind(session.sessionId, resumed.session_id);
      let hydrated = false;
      const hydrateSnapshot = () => {
        if (hydrated) return;
        hydrated = true;
        deps.hydrate?.({
          runtimeSessionId: resumed.session_id,
          persistentId: session.sessionId,
          messages: Array.isArray(resumed.messages) ? resumed.messages : [],
          running: resumed.running === true,
          autoContinue: resumed.autoContinue === true,
          turnStartedAt: resumed.turnStartedAt,
        });
      };
      const outcome = await deps.replay(session.sessionId, resumed.session_id, hydrateSnapshot);
      if (outcome.status === "degraded") {
        summary.degraded.push(session.sessionId);
        hydrateSnapshot();
      }
      summary.replayed += outcome.dispatched;
    } catch (error) {
      summary.failed.push(session.sessionId);
      deps.onError?.(session.sessionId, error);
    }
  }

  return summary;
}

export interface ReconnectRecoveryDeps {
  /** 当前活跃会话的（可能已失效的）运行时 id；没有活跃会话就返回空。 */
  getActiveSessionId(): string | null | undefined;
  resolvePersistentId(sessionId: string): string;
  /** 发一次 `session.resume`，并顺手重投结果里的 `open_requests`。 */
  resume(persistentId: string): Promise<ResumeSnapshot>;
  bind(persistentId: string, runtimeSessionId: string): void;
  /**
   * 走一次 `session.events.since`。`onDegraded` 在判定不可信、replayHold 还没放行
   * 时回调，调用方在这里用快照覆盖时间线（否则放行完再覆盖会丢帧）。
   */
  replay(
    persistentId: string,
    runtimeSessionId: string,
    onDegraded?: (reason: ReplayDegradeReason) => void,
  ): Promise<GatewayReplayOutcome>;
  /** 用 resume 返回的 `messages` 快照覆盖时间线。 */
  hydrate(params: HydrateSnapshotParams): void;
  /** 后端换进程的代数（见 gateway-client.epochGeneration）；变了就说明水位作废。 */
  epochGeneration?(): number;
  /** 取走「该会话水位已作废」标记（内核换进程时由 gateway.ready 记下）。 */
  consumeSnapshotRequest?(persistentId: string): boolean;
  /** resume 成功、映射已写好之后回调（更新 UI 锚点）。 */
  onResumed?(runtimeSessionId: string, persistentId: string): void;
  onResumeFailed?(error: unknown): void;
  onError?(persistentId: string, error: unknown): void;
}

export type ReconnectRecoveryStatus = "idle" | "superseded" | "resumed" | "snapshot" | "failed";

export interface ReconnectRecoveryResult {
  status: ReconnectRecoveryStatus;
  persistentId?: string;
  runtimeSessionId?: string;
  /** 走快照覆盖的原因（`epoch_changed` 表示这次 resume 期间内核换了进程）。 */
  reason?: ReplayDegradeReason | "epoch_changed" | "resume_failed";
}

/**
 * 一次重连 = 一次 resume + 一次判定。
 *
 * 顺序是硬要求：resume →（依赖里重投 open_requests）→ bind → 判定；判定不可信就
 * 用这次 resume 的快照覆盖，绝不再发第二次 resume。
 */
export async function recoverAfterReconnect(
  deps: ReconnectRecoveryDeps,
): Promise<ReconnectRecoveryResult> {
  const activeSessionId = deps.getActiveSessionId();
  if (!activeSessionId) return { status: "idle" };

  const requestedPersistentId = deps.resolvePersistentId(activeSessionId);
  const epochBefore = deps.epochGeneration?.() ?? 0;

  let resumed: ResumeSnapshot;
  try {
    resumed = await deps.resume(requestedPersistentId);
  } catch (error) {
    if (deps.getActiveSessionId() !== activeSessionId) return { status: "superseded" };
    deps.onResumeFailed?.(error);
    return { status: "failed", persistentId: requestedPersistentId, reason: "resume_failed" };
  }

  // resume 可能在飞几十秒：期间用户换了会话，就不要把旧会话的运行时 id 写回去。
  if (deps.getActiveSessionId() !== activeSessionId) return { status: "superseded" };
  if (!resumed?.session_id) {
    deps.onResumeFailed?.(new Error("session.resume returned no session_id"));
    return { status: "failed", persistentId: requestedPersistentId, reason: "resume_failed" };
  }

  const persistentId = resumed.resumed ?? requestedPersistentId;
  const runtimeSessionId = resumed.session_id;
  const messages = Array.isArray(resumed.messages) ? resumed.messages : [];
  const running = resumed.running === true;

  deps.bind(persistentId, runtimeSessionId);
  deps.onResumed?.(runtimeSessionId, persistentId);

  let snapshotReason: ReconnectRecoveryResult["reason"] | null = null;
  const takeSnapshot = (reason: ReconnectRecoveryResult["reason"] | null) => {
    if (snapshotReason) return;
    snapshotReason = reason ?? null;
    deps.hydrate({
      runtimeSessionId,
      persistentId,
      messages,
      running,
      autoContinue: resumed.autoContinue === true,
      turnStartedAt: resumed.turnStartedAt,
    });
  };

  const epochChanged = () => (deps.epochGeneration?.() ?? 0) !== epochBefore;
  // 无论这次用不用，都要把标记取走：留着会让下一次重连误判。
  const watermarkVoided = deps.consumeSnapshotRequest?.(persistentId) ?? false;

  if (watermarkVoided || epochChanged()) {
    takeSnapshot("epoch_changed");
    return { status: "snapshot", persistentId, runtimeSessionId, reason: "epoch_changed" };
  }

  let outcome: GatewayReplayOutcome | null = null;
  try {
    outcome = await deps.replay(persistentId, runtimeSessionId, (reason) => takeSnapshot(reason));
  } catch (error) {
    deps.onError?.(persistentId, error);
  }

  // replay 实现可能没回调 onDegraded（别的客户端实现），按返回值再兜一次。
  if (outcome?.status === "degraded") takeSnapshot(outcome.reason ?? null);
  // 补帧在飞期间内核换了进程：这一窗同样不可信。
  if (epochChanged()) takeSnapshot("epoch_changed");

  if (snapshotReason) {
    return { status: "snapshot", persistentId, runtimeSessionId, reason: snapshotReason };
  }
  return { status: "resumed", persistentId, runtimeSessionId };
}

/**
 * 同一时刻只允许一轮在跑：跑的过程中再来的触发**不丢弃**，合并成「这一轮结束后
 * 再补跑一次」。重连风暴里 onState(open) 会连着触发，静默丢掉第二次就会漏掉那
 * 一轮刚建立的新连接（订阅/水位全是旧的）。
 */
export function createCoalescedTask(task: () => Promise<void>): () => Promise<void> {
  let running = false;
  let pending = false;

  return async () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      do {
        pending = false;
        await task();
      } while (pending);
    } finally {
      running = false;
    }
  };
}

/**
 * 同一时刻只允许一个恢复流程在飞：重连风暴（连续 close/connect）不该打出多次
 * resume。并发调用共享同一个 promise 的结果。
 */
export function createReconnectRecovery(): (
  deps: ReconnectRecoveryDeps,
) => Promise<ReconnectRecoveryResult> {
  let inFlight: Promise<ReconnectRecoveryResult> | null = null;

  return (deps: ReconnectRecoveryDeps) => {
    if (inFlight) return inFlight;

    let pending: Promise<ReconnectRecoveryResult>;
    const release = () => {
      if (inFlight === pending) inFlight = null;
    };
    pending = recoverAfterReconnect(deps).then(
      (result) => {
        release();
        return result;
      },
      (error: unknown) => {
        release();
        deps.onError?.("", error);
        return { status: "failed" as const, reason: "resume_failed" as const };
      },
    );
    inFlight = pending;
    return pending;
  };
}
