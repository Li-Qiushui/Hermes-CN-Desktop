import type { ChatToolItem } from "./chat-types";

export type ToolDisplayEntry =
  | { kind: "single"; tool: ChatToolItem }
  | { kind: "group"; key: string; tools: ChatToolItem[] };

export type ToolGroupStatus = ChatToolItem["status"];

function normalizeContext(context: string | undefined): string {
  return (context ?? "").replace(/\s+/g, " ").trim();
}

function sameSignature(left: ChatToolItem, right: ChatToolItem): boolean {
  return left.name === right.name && normalizeContext(left.context) === normalizeContext(right.context);
}

export function groupConsecutiveTools(
  tools: readonly ChatToolItem[],
): ToolDisplayEntry[] {
  const result: ToolDisplayEntry[] = [];
  let i = 0;
  while (i < tools.length) {
    const head = tools[i];
    const run: ChatToolItem[] = [head];
    let j = i + 1;
    while (j < tools.length && sameSignature(head, tools[j])) {
      run.push(tools[j]);
      j += 1;
    }

    if (run.length >= 2) {
      result.push({
        kind: "group",
        key: `${head.name}|${normalizeContext(head.context)}|${head.tool_id}|${run.length}`,
        tools: run,
      });
    } else {
      result.push({ kind: "single", tool: head });
    }
    i = j;
  }
  return result;
}

export function groupStatus(tools: readonly ChatToolItem[]): ToolGroupStatus {
  if (tools.some((tool) => tool.status === "error")) return "error";
  if (tools.some((tool) => tool.status === "running")) return "running";
  return "done";
}

export function groupElapsedMs(tools: readonly ChatToolItem[]): number | undefined {
  if (tools.length === 0) return undefined;
  let total = 0;
  let saw = false;
  for (const tool of tools) {
    if (typeof tool.completedAt === "number") {
      total += Math.max(0, tool.completedAt - tool.startedAt);
      saw = true;
    }
  }
  return saw ? total : undefined;
}
