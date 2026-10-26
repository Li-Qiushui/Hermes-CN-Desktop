import type { ChatToolItem } from "./chat-types";

const INTERRUPTED_RE = /command interrupted/i;

type InterruptProbe = Pick<ChatToolItem, "status" | "error" | "summary" | "preview" | "tail">;

/**
 * 内核被 Esc / 中途停止时，terminal 工具的结果里会带 `[Command interrupted]`
 * （exit_code=130，finish_reason 不是 error），所以 status 仍是 done。
 * 面板要靠这段文本把「被中断」和「正常跑完」区分开。
 */
export function toolInterrupted(tool: InterruptProbe): boolean {
  if (tool.status === "running") return false;
  const haystack = [tool.error, tool.summary, tool.preview, tool.tail]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  return INTERRUPTED_RE.test(haystack);
}

export function countInterruptedTools(tools: readonly InterruptProbe[]): number {
  return tools.filter(toolInterrupted).length;
}
