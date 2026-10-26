import type { ChatToolItem } from "./chat-types";
import { toolInterrupted } from "./tool-interruption";

export type ToolActivityStatus = ChatToolItem["status"];

export interface ToolActivitySummary {
  status: ToolActivityStatus;
  label: string;
  meta?: string;
  error?: string;
  elapsedMs?: number;
  interrupted?: boolean;
}

const TERMINAL_TOOL_NAMES = new Set(["bash", "command", "shell", "terminal"]);

const PLACEHOLDER_TOOL_NAMES = new Set(["tool", "unknown", "undefined", "null", "none"]);

const SETTLED_INTERRUPTED_RE = /已中断|command interrupted/i;

export const UNKNOWN_TOOL_LABEL = "工具";

function resolveToolName(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "";
  return PLACEHOLDER_TOOL_NAMES.has(trimmed.toLowerCase()) ? "" : trimmed;
}

function displayName(name: string | undefined): string {
  return resolveToolName(name).replace(/[_-]+/g, " ");
}

export function toolDisplayName(name: string | undefined): string {
  return displayName(name) || UNKNOWN_TOOL_LABEL;
}

function isTerminalTool(name: string | undefined): boolean {
  const resolved = resolveToolName(name);
  return resolved ? TERMINAL_TOOL_NAMES.has(resolved.toLowerCase()) : false;
}

function interruptedCount(tools: readonly ChatToolItem[]): number {
  return tools.filter(
    (tool) =>
      toolInterrupted(tool) ||
      (tool.status === "error" && SETTLED_INTERRUPTED_RE.test(tool.error ?? "")),
  ).length;
}

function summarizeCounts(tools: readonly ChatToolItem[]): string | undefined {
  const counts = new Map<string, number>();
  tools.forEach((tool) => {
    const name = resolveToolName(tool.name);
    if (!name) return;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  });

  const parts = Array.from(counts.entries())
    .sort(([leftName, leftCount], [rightName, rightCount]) => {
      if (leftCount !== rightCount) return rightCount - leftCount;
      return leftName.localeCompare(rightName);
    })
    .slice(0, 3)
    .map(([name, count]) => `${name} x${count}`);

  if (parts.length === 0) return undefined;
  const remaining = counts.size - parts.length;
  return remaining > 0 ? `${parts.join(", ")} +${remaining}` : parts.join(", ");
}

function activityStatus(tools: readonly ChatToolItem[]): ToolActivityStatus {
  if (tools.some((tool) => tool.status === "error")) return "error";
  if (tools.some((tool) => tool.status === "running")) return "running";
  return "done";
}

function activityElapsedMs(
  tools: readonly ChatToolItem[],
  status: ToolActivityStatus,
  now: number,
): number | undefined {
  const startedAt = tools
    .map((tool) => tool.startedAt)
    .filter((value) => Number.isFinite(value));
  if (startedAt.length === 0) return undefined;

  const firstStart = Math.min(...startedAt);
  const lastEnd = Math.max(
    ...tools.map((tool) => {
      if (status === "running" && tool.status === "running") return now;
      return tool.completedAt ?? tool.startedAt;
    }),
  );

  return Math.max(0, lastEnd - firstStart);
}

function activityLabel(
  tools: readonly ChatToolItem[],
  status: ToolActivityStatus,
  errorCount: number,
): string {
  const count = tools.length;
  const terminalOnly = tools.length > 0 && tools.every((tool) => isTerminalTool(tool.name));
  const interrupted = status === "running" ? 0 : interruptedCount(tools);

  if (interrupted > 0) {
    if (status === "error" && interrupted < count) {
      return count === 1 ? "已中断（命令失败）" : `已中断 · ${interrupted} / ${count} 失败`;
    }
    return count === 1 ? "已中断" : `已中断 · ${interrupted} / ${count}`;
  }

  // 中文 UI：状态词本地化，工具原始名称（displayName）保留以便识别。
  if (terminalOnly) {
    if (status === "running") return "正在运行终端命令";
    if (status === "error") {
      if (count === 1) return "终端命令失败";
      return `运行了 ${count} 条终端命令，${errorCount} 条失败`;
    }
    return count === 1 ? "运行了终端命令" : `运行了 ${count} 条终端命令`;
  }

  if (count === 1) {
    const name = displayName(tools[0]?.name);
    if (!name) {
      if (status === "running") return `正在使用${UNKNOWN_TOOL_LABEL}`;
      if (status === "error") return `${UNKNOWN_TOOL_LABEL}执行失败`;
      return `使用了${UNKNOWN_TOOL_LABEL}`;
    }
    if (status === "running") return `正在运行 ${name}`;
    if (status === "error") return `${name} 失败`;
    return `使用了 ${name}`;
  }

  if (status === "running") return `正在使用 ${count} 个工具`;
  if (status === "error") return `使用了 ${count} 个工具，${errorCount} 个失败`;
  return `使用了 ${count} 个工具`;
}

export const AUTOMATIC_OPEN_MAX_ITEMS = 4;

export interface ActivityGroupDisclosureInput {
  /** 该活动组所在的回合是否仍在跑（含组内仍有 running 项）。 */
  live: boolean;
  /** 组内可见活动项数（工具 + 思考）。 */
  itemCount: number;
  /** 组内含 Task 子代理拓扑：卡片本身要显示名册，永远展开。 */
  hasSubagentTopology?: boolean;
}

export function resolveActivityAutoOpen(input: ActivityGroupDisclosureInput): boolean {
  if (input.hasSubagentTopology === true) return true;
  if (input.live) return true;
  return input.itemCount <= AUTOMATIC_OPEN_MAX_ITEMS;
}

export function summarizeToolActivity(
  tools: readonly ChatToolItem[],
  now = Date.now(),
): ToolActivitySummary {
  const status = activityStatus(tools);
  const failedTool = tools.find((tool) => tool.status === "error");
  const errorCount = tools.filter((tool) => tool.status === "error").length;
  const terminalOnly = tools.length > 0 && tools.every((tool) => isTerminalTool(tool.name));
  const singleTool = tools.length === 1 ? tools[0] : undefined;
  const interrupted = status !== "running" && interruptedCount(tools) > 0;

  return {
    status,
    label: activityLabel(tools, status, errorCount),
    meta: singleTool?.context?.trim() || (terminalOnly ? undefined : summarizeCounts(tools)),
    error: failedTool?.error,
    elapsedMs: activityElapsedMs(tools, status, now),
    interrupted: interrupted || undefined,
  };
}
