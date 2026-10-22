/**
 * 会话级事件水位（seq）与重连补帧的纯逻辑层。
 *
 * 内核每个会话给事件打单调递增的 `seq`，`session.events.since` 按游标重放。
 * 但 legacy 内核（本机 0.22.2）**不信 `truncated`**：游标超前 head、`epoch`
 * 变了，它照样回事件且 `truncated:false`。所以补帧能不能信，必须由客户端自己
 * 用「本地水位 + epoch + 事件 seq 是否连续」三条判据决定，任一不成立就退化成
 * 一次全量 `session.resume`（拿 `messages` 快照覆盖时间线）。
 *
 * 这里不碰 socket、不碰 jotai：水位记账 + 判定都是纯函数/纯类，方便单测。
 */

export interface SeqEventLike {
  type?: string;
  session_id?: string;
  seq?: number;
  payload?: unknown;
  [key: string]: unknown;
}

/** `session.events.since` 的真实返回形状（legacy 实测 + canonical 源码并集）。 */
export interface SessionEventsSinceAnswer {
  events?: SeqEventLike[] | null;
  latest_seq?: number | null;
  last_sequence?: number | null;
  epoch?: string | null;
  replay_epoch?: string | null;
  truncated?: boolean | null;
  snapshot_required?: boolean | null;
  count?: number | null;
}

export type ReplayDegradeReason = "epoch_changed" | "cursor_ahead" | "seq_gap" | "truncated";

export interface SessionCursor {
  /** 已经投递给上层（或确认无缺口）的最大 seq；0 表示还没见过任何事件。 */
  seq: number;
  /** 这个游标对应的编号身份：优先 session 级 `replay_epoch`，退而用进程级 epoch。 */
  epoch: string | null;
}

export interface ReplayDecision {
  /** 可以按序投递的事件（已剔除 <= 本地水位的重复帧）。 */
  dispatch: SeqEventLike[];
  /** 非 null 表示这次补帧不可信，调用方要退化成全量 resume。 */
  degrade: ReplayDegradeReason | null;
  /** 退化或成功都要把游标推到的位置（退化时由 resume 快照重新建立）。 */
  latestSeq: number;
}

/** 与官方 REPLAY_CURSOR_MAX 对齐：只保留最近的若干会话游标，防止内存无界增长。 */
export const MAX_SESSION_CURSORS = 256;

function isSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 每个会话的「我收到哪儿了」账本。Map 的插入顺序当 LRU 用：命中即删了重插。
 */
export class SessionSeqLedger {
  private readonly cursors = new Map<string, SessionCursor>();
  private processEpoch: string | null = null;

  get epoch(): string | null {
    return this.processEpoch;
  }

  /**
   * 记进程级 epoch（`gateway.ready.replay_epoch`）。变化 = 后端换进程，旧 seq 编号全部作废。
   *
   * `changed` 是「有值且与旧值不同」（首次记录也算），`transitioned` 才是「从旧进程
   * 换到新进程」——只有后者说明正在看的这批会话的水位已经不可信，要拿快照兜住。
   */
  adoptProcessEpoch(epoch: unknown): { changed: boolean; transitioned: boolean; dropped: string[] } {
    const next = nonEmptyString(epoch);
    if (!next) return { changed: false, transitioned: false, dropped: [] };
    if (this.processEpoch === next) return { changed: false, transitioned: false, dropped: [] };
    const transitioned = this.processEpoch !== null;
    this.processEpoch = next;
    if (!transitioned) return { changed: true, transitioned: false, dropped: [] };
    const dropped = [...this.cursors.keys()];
    this.cursors.clear();
    return { changed: true, transitioned: true, dropped };
  }

  /** 订阅一个会话（保持已有水位，重连后靠它继续）。 */
  ensure(key: string, epoch?: string | null): SessionCursor {
    const existing = this.cursors.get(key);
    if (existing) {
      this.cursors.delete(key);
      this.cursors.set(key, existing);
      return existing;
    }
    const created: SessionCursor = { seq: 0, epoch: nonEmptyString(epoch) };
    this.cursors.set(key, created);
    this.evict();
    return created;
  }

  cursor(key: string): SessionCursor | undefined {
    return this.cursors.get(key);
  }

  seqOf(key: string): number {
    return this.cursors.get(key)?.seq ?? 0;
  }

  /** 推进水位；只有真正前进才返回 true（同一 seq 重复到达是 false）。 */
  advance(key: string, seq: number, epoch?: string | null): boolean {
    if (!isSeq(seq)) return false;
    const cursor = this.cursors.get(key) ?? this.ensure(key, epoch);
    if (seq <= cursor.seq) return false;
    cursor.seq = seq;
    const next = nonEmptyString(epoch);
    if (next) cursor.epoch = next;
    this.cursors.delete(key);
    this.cursors.set(key, cursor);
    return true;
  }

  noteEpoch(key: string, epoch: unknown): boolean {
    const next = nonEmptyString(epoch);
    if (!next) return false;
    const cursor = this.cursors.get(key) ?? this.ensure(key);
    if (cursor.epoch === next) return false;
    const changed = cursor.epoch !== null;
    cursor.epoch = next;
    if (changed) cursor.seq = 0;
    return changed;
  }

  drop(key: string): void {
    this.cursors.delete(key);
  }

  /** 已订阅会话的快照，按最近推进排序（最久没动的排前面）。 */
  snapshot(): Array<{ key: string; seq: number; epoch: string | null }> {
    return [...this.cursors.entries()].map(([key, cursor]) => ({ key, seq: cursor.seq, epoch: cursor.epoch }));
  }

  private evict(): void {
    while (this.cursors.size > MAX_SESSION_CURSORS) {
      const oldest = this.cursors.keys().next().value;
      if (oldest === undefined) return;
      this.cursors.delete(oldest);
    }
  }
}

/**
 * 判一次 `session.events.since` 的回答可不可信。
 *
 * 三种退化条件（spec 要求逐条覆盖）：
 * 1. 本地水位 > 返回的 `latest_seq` —— 游标超前，说明内核那边的编号已经重来；
 * 2. `epoch` 与本地记录不一致 —— 后端重启过，旧 seq 不再指同一批事件；
 * 3. 返回事件 seq 出现缺口 —— 环形缓存淘汰过中间段。
 * 另外 canonical 的 `snapshot_required` / legacy 的 `truncated` 一律不投递。
 */
export function planReplay(input: {
  cursor: SessionCursor | undefined;
  processEpoch: string | null;
  answer: SessionEventsSinceAnswer | null | undefined;
}): ReplayDecision {
  const { cursor, processEpoch, answer } = input;
  const localSeq = cursor?.seq ?? 0;
  if (!answer) return { dispatch: [], degrade: null, latestSeq: localSeq };

  const latestSeq = isSeq(answer.latest_seq)
    ? answer.latest_seq
    : isSeq(answer.last_sequence)
      ? answer.last_sequence
      : localSeq;

  if (answer.snapshot_required === true) {
    return { dispatch: [], degrade: "truncated", latestSeq };
  }

  const answerEpoch = nonEmptyString(answer.replay_epoch) ?? nonEmptyString(answer.epoch);
  const knownEpoch = cursor?.epoch ?? processEpoch;
  if (answerEpoch && knownEpoch && answerEpoch !== knownEpoch) {
    return { dispatch: [], degrade: "epoch_changed", latestSeq };
  }

  if (localSeq > latestSeq) {
    return { dispatch: [], degrade: "cursor_ahead", latestSeq };
  }

  if (answer.truncated === true) {
    return { dispatch: [], degrade: "truncated", latestSeq };
  }

  const events = Array.isArray(answer.events) ? answer.events : [];
  const fresh: SeqEventLike[] = [];
  let expected = localSeq + 1;

  for (const event of events) {
    if (!isSeq(event?.seq)) {
      return { dispatch: [], degrade: "seq_gap", latestSeq };
    }
    if (event.seq <= localSeq) continue;
    if (event.seq !== expected) {
      return { dispatch: [], degrade: "seq_gap", latestSeq };
    }
    fresh.push(event);
    expected += 1;
  }

  return { dispatch: fresh, degrade: null, latestSeq: Math.max(latestSeq, expected - 1) };
}

/** 补帧后按 seq 升序合并实时帧与重放帧，seq 相同只留一份。 */
export function mergeReplayWindow(replayed: SeqEventLike[], parked: SeqEventLike[]): SeqEventLike[] {
  const merged = [...replayed, ...parked];
  const ordered = merged
    .map((event, index) => ({ event, index, seq: isSeq(event?.seq) ? event.seq : null }))
    .sort((a, b) => {
      if (a.seq === null || b.seq === null) return a.index - b.index;
      if (a.seq === b.seq) return a.index - b.index;
      return a.seq - b.seq;
    })
    .map((entry) => entry.event);

  const seen = new Set<number>();
  const deduped: SeqEventLike[] = [];
  for (const event of ordered) {
    if (isSeq(event?.seq)) {
      if (seen.has(event.seq)) continue;
      seen.add(event.seq);
    }
    deduped.push(event);
  }
  return deduped;
}
