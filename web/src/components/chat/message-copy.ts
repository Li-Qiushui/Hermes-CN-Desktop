import type { ChatMessage, ChatToolItem } from "./chat-types";
import { TOOL_OUTPUT_SUMMARY_LIMIT } from "./message-adapter";

const ROLE_HEADINGS: Record<string, string> = {
  user: "用户",
  assistant: "Hermes",
  system: "系统",
  tool: "工具",
};

function clipBlock(text: string): string {
  if (text.length <= TOOL_OUTPUT_SUMMARY_LIMIT) return text;
  return `${text.slice(0, TOOL_OUTPUT_SUMMARY_LIMIT)}\n…（已截断，共 ${text.length} 字符）`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function pushFence(lines: string[], language: string | undefined, text: string): void {
  const fence = text.includes("```") ? "````" : "```";
  lines.push(`${fence}${language ?? ""}`, clipBlock(text), fence);
}

export function toolMarkdown(tool: ChatToolItem): string {
  const lines: string[] = [`### ${tool.name?.trim() || "工具"}`];
  if (tool.context?.trim()) lines.push(`> ${tool.context.trim()}`);
  if (tool.status === "error") lines.push("状态：失败");

  const args = tool.arguments;
  if (args && typeof args === "object" && Object.keys(args).length > 0) {
    lines.push("参数：");
    pushFence(lines, "json", safeJson(args));
  }

  const output = (tool.summary ?? tool.preview ?? tool.error ?? "").trim();
  if (output) {
    lines.push("输出：");
    pushFence(lines, undefined, output);
  }

  return lines.join("\n");
}

export function toolsMarkdown(tools: readonly ChatToolItem[]): string {
  return tools.map(toolMarkdown).filter(Boolean).join("\n\n");
}

export function messageRoundMarkdown(message: ChatMessage): string {
  const parts: string[] = [];
  const heading = ROLE_HEADINGS[message.role] ?? message.role;
  const blocks = message.blocks ?? [];
  const toolBlocks = blocks.filter((block) => block.type === "tool");

  if (toolBlocks.length > 0 || blocks.some((block) => block.type === "text")) {
    for (const block of blocks) {
      if (block.type === "text") {
        const text = block.text.trim();
        if (text) parts.push(text);
        continue;
      }
      if (block.type === "tool") parts.push(toolMarkdown(block.tool));
    }
  } else {
    const text = message.text?.trim();
    if (text) parts.push(text);
  }

  if (toolBlocks.length === 0 && message.tools?.length) {
    parts.push(toolsMarkdown(message.tools));
  }

  const body = parts.filter(Boolean).join("\n\n");
  return body ? `## ${heading}\n\n${body}` : "";
}

export function hasCopyableTools(message: ChatMessage): boolean {
  return Boolean(message.tools?.length || message.blocks?.some((block) => block.type === "tool"));
}
