import type { ChatToolItem } from "./chat-types";
import { groupConsecutiveTools } from "./group-tools";
import type { ToolDisplayEntry } from "./group-tools";
import { summarizeToolActivity } from "./tool-activity";
import type { ToolActivitySummary } from "./tool-activity";

const groupCache = new WeakMap<readonly ChatToolItem[], ToolDisplayEntry[]>();
const summaryCache = new WeakMap<readonly ChatToolItem[], ToolActivitySummary>();

export function cachedGroupConsecutiveTools(tools: readonly ChatToolItem[]): ToolDisplayEntry[] {
  const cached = groupCache.get(tools);
  if (cached) return cached;
  const entries = groupConsecutiveTools(tools);
  groupCache.set(tools, entries);
  return entries;
}

export function cachedToolActivitySummary(
  tools: readonly ChatToolItem[],
  now: number,
): ToolActivitySummary {
  const cached = summaryCache.get(tools);
  if (cached) return cached;
  const summary = summarizeToolActivity(tools, now);
  if (summary.status !== "running") summaryCache.set(tools, summary);
  return summary;
}
