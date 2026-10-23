import type { SubagentProgress, SubagentStatus } from "@/stores/subagents";

// 对话流内 delegate 运行卡的数据模型（纯函数，便于单测）。
//
// 三个来源合成一行：
//   1. 工具调用本身（args.tasks[].goal）——派发了哪些子任务，历史重载后仍在；
//   2. 子代理 store（subagent.* 原生事件，或 delegate_task 兜底合成行）——
//      子代理此刻在干什么；
//   3. 工具结果（status / error）——结束了没有、成没成。
//
// 对齐官方 apps/desktop/src/components/assistant-ui/tool/delegate-model.ts，
// 差异是 CN 侧拿不到结构化 result 对象（只有展示用 summary 文本），所以结果
// 只按工具 status 判定，不猜子任务级别成败——宁可显示"完成"也不编造哪个子
// 任务失败。

/**
 * `dispatched` 是另外两个来源都说不出话的状态：主代理回合已结束、子代理行
 * 仍未终态，且最近没有任何新事件。它还在跑，但这里没有东西在看着它，
 * 所以不能转 spinner 假装活着。
 */
export type DelegateRunStatus = SubagentStatus | "dispatched";

export interface DelegateRunRow {
  /** 全量进度行（旧→新），卡片只 ticker 尾部几行。 */
  activity: string[];
  /** 子代理自己的会话 id（原生事件 child_session_id），有才能跳转。 */
  childSessionId?: string;
  durationSeconds?: number;
  goal: string;
  id: string;
  model?: string;
  startedAt: number;
  status: DelegateRunStatus;
  /** 内核 subagent_id，有才能真的发 subagent.interrupt。 */
  subagentId?: string;
  taskIndex: number;
}

export interface DelegateCallInput {
  args?: Record<string, unknown>;
  completedAt?: number;
  error?: string;
  /** 主代理回合是否仍在流式输出——存活态的第一判据。 */
  streaming: boolean;
  startedAt: number;
  status: "running" | "done" | "error";
  summary?: string;
  /** 本轮只有这一张 delegate 卡时才允许按时间窗认领无 id 关联的原生行。 */
  claimUnlinked?: boolean;
  now: number;
  toolCallId: string;
}

/** 判定工具名是否为内核 delegate_task（子代理派发）。 */
export const isDelegateToolName = (name: string | undefined): boolean =>
  name === "delegate_task" || name === "delegate";

/** 事件新鲜度：超过这个时间没有任何 subagent.* 事件，就不算"有人在看"。 */
export const DELEGATE_FRESH_MS = 15_000;

const FALLBACK_GOAL = "子代理任务";

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const firstText = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
};

const collectTasks = (args: Record<string, unknown>): Record<string, unknown>[] => {
  const tasks = Array.isArray(args.tasks) ? args.tasks : [];
  if (tasks.length > 0) return tasks.map(asRecord);
  return args.goal ? [args] : [];
};

/** `delegate_task` 派发的子任务目标，按任务顺序。 */
export function delegateGoals(args: Record<string, unknown> | undefined): string[] {
  if (!args) return [];
  return collectTasks(args).map((task, index) => firstText(task.goal, task.title) || `子任务 ${index + 1}`);
}

const isTerminalStatus = (status: DelegateRunStatus): boolean =>
  status === "completed" || status === "failed" || status === "interrupted";

/** 有 subagent_id、且还在跑，才认为后端在册、点得动中断。 */
export const canInterruptRow = (row: DelegateRunRow): boolean =>
  Boolean(row.subagentId) && (row.status === "running" || row.status === "queued");

export const isLiveRow = (row: { status: DelegateRunStatus }): boolean =>
  row.status === "running" || row.status === "queued";

/** ticker 尾部：最近 `depth` 行，旧→新。 */
export function tickerLines(row: DelegateRunRow, depth = 5): string[] {
  return row.activity.filter((line) => line.trim().length > 0).slice(-depth).map(sanitizeActivityLine).filter(Boolean);
}

// ── 日志行清洗 ──────────────────────────────────────────────────────────────
//
// delegate_task 的 summary 是未解析的 JSON（`{"status":"dispatched","count":2,
// "goals":[...]}`），原样铺到卡片上就是上千字的机器噪音，还会把目标原文再
// 打一遍。这里把 JSON 行压成一句人话，超长行截断，长字段一律不落地。

export const ACTIVITY_LINE_MAX = 120;

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function parseJsonLine(line: string): { array: unknown[] } | { object: Record<string, unknown> } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return { array: parsed };
    const object = asObject(parsed);
    return object ? { object } : null;
  } catch {
    return null;
  }
}

const DISPATCH_STATUS_TEXT: Record<string, string> = {
  dispatched: "已派发",
  queued: "已排队",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
};

/** 派发结果 → 一句摘要。只取 status / count / delegation_id，长字段（goals、
 *  prompt、tasks…）一个都不文本化。 */
function summarizeJsonLine(parsed: { array: unknown[] } | { object: Record<string, unknown> }): string {
  if ("array" in parsed) {
    return `${parsed.array.length} 项结果`;
  }
  const obj = parsed.object;
  const status = typeof obj.status === "string" ? (DISPATCH_STATUS_TEXT[obj.status] ?? obj.status) : "";
  const rawCount =
    typeof obj.count === "number"
      ? obj.count
      : Array.isArray(obj.goals)
        ? obj.goals.length
        : Array.isArray(obj.tasks)
          ? obj.tasks.length
          : undefined;
  const count = typeof rawCount === "number" && Number.isFinite(rawCount) ? rawCount : undefined;
  const delegationId = typeof obj.delegation_id === "string" ? obj.delegation_id : "";

  const head = [status, count !== undefined ? `${count} 个子任务` : ""].filter(Boolean).join(" ");
  if (!head && !delegationId) return `${Object.keys(obj).length} 个字段的结果`;
  if (!head && delegationId) return delegationId;
  return [head, delegationId].filter(Boolean).join(" · ");
}

const truncateLine = (text: string, max = ACTIVITY_LINE_MAX): string =>
  text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;

/** JSON 被上游截断（卡片只带 summary 前 400 字符）时按 key 兜底取摘要，
 *  比整段原文好，也绝不把 goals 原文带出来。 */
function summarizeJsonPrefix(text: string): string | null {
  const status = /"status"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  const countRaw = /"count"\s*:\s*(\d+)/.exec(text)?.[1];
  const delegationId = /"delegation_id"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  if (!status && !countRaw && !delegationId) return null;
  const head = [
    status ? (DISPATCH_STATUS_TEXT[status] ?? status) : "",
    countRaw ? `${countRaw} 个子任务` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return [head, delegationId ?? ""].filter(Boolean).join(" · ");
}

const JSON_FRAGMENT_LINE = /^"[A-Za-z_][A-Za-z0-9_]*"\s*:/;

/** 单行清洗：JSON 压成摘要，其余保留但截断到 120 字符。 */
export function sanitizeActivityLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  const parsed = parseJsonLine(trimmed);
  if (parsed) return truncateLine(summarizeJsonLine(parsed));
  const head = trimmed[0]!;
  const jsonish = head === "{" || head === "[" || head === "}" || head === "]";
  if (jsonish || JSON_FRAGMENT_LINE.test(trimmed)) {
    return truncateLine(summarizeJsonPrefix(trimmed) ?? "");
  }
  return truncateLine(trimmed);
}

/** 一行的完整日志（旧→新，已清洗，相邻重复行只留一条）。 */
export function sanitizedActivity(row: DelegateRunRow): string[] {
  const out: string[] = [];
  for (const raw of row.activity) {
    const line = sanitizeActivityLine(raw);
    if (!line || out.at(-1) === line) continue;
    out.push(line);
  }
  return out;
}

/** 整卡重复行合并：同一句摘要在多行出现时只保留第一次，后来的行不再重复。 */
export function dedupeRowActivity(rows: readonly DelegateRunRow[]): string[][] {
  const seen = new Set<string>();
  return rows.map((row) =>
    sanitizedActivity(row).filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    }),
  );
}

/** 所有行都只有同一句派发摘要 → 返回它，让组头说一次、行内不再复读。 */
export function sharedActivitySummary(rows: readonly DelegateRunRow[]): string | null {
  if (rows.length < 2) return null;
  const all = rows.map(sanitizedActivity);
  const first = all[0];
  if (!first || first.length !== 1) return null;
  return all.every((lines) => lines.length === 1 && lines[0] === first[0]) ? first[0]! : null;
}

function liveWatching(call: DelegateCallInput, live: SubagentProgress): boolean {
  if (call.streaming) return true;
  return call.now - live.updatedAt <= DELEGATE_FRESH_MS;
}

function liveRowStatus(call: DelegateCallInput, live: SubagentProgress): DelegateRunStatus {
  const status: DelegateRunStatus = live.status;
  if (isTerminalStatus(status)) return status;
  // 非终态但没人看着：挂成后台存活，不转 spinner。
  return liveWatching(call, live) ? status : "dispatched";
}

function callRowStatus(call: DelegateCallInput): DelegateRunStatus {
  if (call.status === "error" || call.error) return "failed";
  if (call.status === "done") return "completed";
  // 工具没结束但回合已经收尾：事件流没走完，标中断而不是编一个完成。
  return call.streaming ? "running" : "interrupted";
}

function fallbackActivity(call: DelegateCallInput): string[] {
  const lines = firstText(call.summary, call.error);
  return lines ? lines.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

function rowFromLive(
  call: DelegateCallInput,
  live: SubagentProgress,
  goal: string,
  taskIndex: number,
): DelegateRunRow {
  return {
    activity: live.stream.map((entry) => entry.text).filter(Boolean),
    childSessionId: live.childSessionId,
    durationSeconds: live.durationSeconds,
    goal: live.goal || goal,
    id: live.id,
    model: live.model,
    startedAt: live.startedAt,
    status: liveRowStatus(call, live),
    subagentId: live.subagentId,
    taskIndex: live.taskIndex ?? taskIndex,
  };
}

function rowFromCall(
  call: DelegateCallInput,
  goal: string,
  taskIndex: number,
  status: DelegateRunStatus,
  startedAt: number,
): DelegateRunRow {
  const finishedAt = call.completedAt;
  return {
    activity: fallbackActivity(call),
    durationSeconds:
      finishedAt && finishedAt > startedAt ? Math.round((finishedAt - startedAt) / 100) / 10 : undefined,
    goal,
    id: `${call.toolCallId}:${taskIndex}`,
    startedAt,
    status,
    taskIndex,
  };
}

const norm = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * 合成一张卡的行。
 *
 * 认领顺序（窄→宽）：内核回退行按 `delegate-tool:<toolCallId>:` 精确匹配；
 * 原生事件没有工具关联，只带 goal 原文，按目标文本匹配；再不行才按时间窗
 * 认领——仅当本轮只有这一张 delegate 卡（`claimUnlinked`），否则第二次派发
 * 会抢走第一张的工人。
 */
export function buildDelegateRows(
  call: DelegateCallInput,
  live: readonly SubagentProgress[],
): DelegateRunRow[] {
  const goals = delegateGoals(call.args);
  const unclaimed = [...live];

  const claim = (predicate: (candidate: SubagentProgress) => boolean): SubagentProgress | undefined => {
    const index = unclaimed.findIndex(predicate);
    return index >= 0 ? unclaimed.splice(index, 1)[0] : undefined;
  };

  const prefix = `${call.toolCallId}:`;
  const byId = goals.map(() => claim((candidate) => candidate.id.startsWith(`delegate-tool:${prefix}`)));
  const matched = goals.map((goal, index) => byId[index] ?? claim((candidate) => norm(candidate.goal) === norm(goal)));

  if (goals.length === 0) {
    // 没有 args（live tool.start 只带 context 时常见）：退回 store 里的行本身。
    const window = unclaimed.filter((candidate) => {
      if (!call.claimUnlinked) return false;
      if (candidate.startedAt < call.startedAt - 2_000) return false;
      return call.completedAt ? candidate.startedAt <= call.completedAt + 1_000 : true;
    });
    return window
      .map((candidate, index) => rowFromLive(call, candidate, FALLBACK_GOAL, candidate.taskIndex ?? index))
      .sort(compareRows);
  }

  const callStatus = callRowStatus(call);
  const rows = goals.map((goal, index) => {
    const hit = matched[index];
    if (hit) return rowFromLive(call, hit, goal, index);
    return rowFromCall(call, goal, index, callStatus, call.startedAt);
  });

  return rows.sort(compareRows);
}

/** 按派发时间排序，同一时刻按任务序号——多子代理并行时"谁先派发谁在上面"。 */
export function compareRows(a: DelegateRunRow, b: DelegateRunRow): number {
  return a.startedAt - b.startedAt || a.taskIndex - b.taskIndex || a.goal.localeCompare(b.goal);
}

/** 整卡聚合状态：任何一行还在跑 → running，否则全失败 → failed，其余 completed。 */
export function aggregateStatus(rows: readonly DelegateRunRow[]): DelegateRunStatus {
  if (rows.some((row) => isLiveRow(row))) return "running";
  if (rows.some((row) => row.status === "dispatched")) return "dispatched";
  if (rows.every((row) => row.status === "failed")) return "failed";
  if (rows.some((row) => row.status === "failed" || row.status === "interrupted")) return "failed";
  return "completed";
}

/** 卡片是否需要每秒刷新（有活行才转表）。 */
export const needsClock = (rows: readonly DelegateRunRow[]): boolean =>
  rows.some((row) => isLiveRow(row));
