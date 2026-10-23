import type { ChatMessage } from "@/components/chat/chat-types";
import type { PendingPrompt } from "@/stores/chat";

const RECOMMENDED_SUFFIX = /\(\s*(?:recommended|推荐)\s*\)\s*$/i;

export interface ClarifyOption {
  value: string;
  label: string;
  recommended: boolean;
}

export function parseClarifyOption(raw: string): ClarifyOption {
  const value = raw.trim();
  const match = RECOMMENDED_SUFFIX.exec(value);
  if (!match) return { value, label: value, recommended: false };
  const label = value.slice(0, match.index).trim();
  return { value, label: label || value, recommended: true };
}

export function clarifyOptions(prompt: Pick<PendingPrompt, "choices">): ClarifyOption[] {
  return prompt.choices.map(parseClarifyOption);
}

export interface ClarifyBatch {
  requestId: string;
  prompts: PendingPrompt[];
}

export function isBatchClarify(prompt: PendingPrompt): boolean {
  return (
    prompt.kind === "clarify" &&
    prompt.transport === "server-request" &&
    Boolean(prompt.serverRequestId) &&
    Boolean(prompt.questionId)
  );
}

export function groupClarifyBatches(prompts: PendingPrompt[]): ClarifyBatch[] {
  const grouped = new Map<string, PendingPrompt[]>();
  for (const prompt of prompts) {
    if (!isBatchClarify(prompt) || !prompt.serverRequestId) continue;
    const list = grouped.get(prompt.serverRequestId) ?? [];
    list.push(prompt);
    grouped.set(prompt.serverRequestId, list);
  }
  return [...grouped.entries()].map(([requestId, list]) => ({
    requestId,
    prompts: [...list].sort((a, b) => a.receivedAt - b.receivedAt),
  }));
}

export function promptBelongsToSessions(
  prompt: PendingPrompt,
  sessionIds: (string | null | undefined)[],
): boolean {
  const wanted = new Set(sessionIds.filter((id): id is string => Boolean(id)));
  if (wanted.size === 0) return false;
  if (!prompt.sessionId) return true;
  return wanted.has(prompt.sessionId);
}

interface ToolRef {
  tool_id: string;
  status: string;
}

export function toolRefsOf(message: ChatMessage): ToolRef[] {
  const refs: ToolRef[] = [];
  for (const block of message.blocks ?? []) {
    if (block.type === "tool") refs.push({ tool_id: block.tool.tool_id, status: block.tool.status });
  }
  if (refs.length === 0 && message.tools?.length) {
    for (const tool of message.tools) refs.push({ tool_id: tool.tool_id, status: tool.status });
  }
  return refs;
}

/**
 * 内核发的 clarify / approval 请求里没有 tool_call_id，只能按客户端启发式锚定：
 * 挂到最后一个 assistant 消息里仍在 running 的工具块（发起提问的那一行）。
 */
export function findRunningToolId(messages: ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const refs = toolRefsOf(message);
    for (let cursor = refs.length - 1; cursor >= 0; cursor -= 1) {
      if (refs[cursor].status === "running") return refs[cursor].tool_id;
    }
    return null;
  }
  return null;
}

export function findToolMessageByToolId(messages: ChatMessage[], toolId: string): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    if (toolRefsOf(message).some((ref) => ref.tool_id === toolId)) return message;
  }
  return null;
}

export interface ClarifyQaEntry {
  question: string;
  answer: string | null;
}

export interface ClarifyQaRecord {
  requestId: string;
  sessionId: string;
  toolId: string;
  entries: ClarifyQaEntry[];
  at: number;
}

export function clarifyAnswerValue(values: string[], multiSelect: boolean): string | null {
  const picked = values.map((item) => item.trim()).filter(Boolean);
  if (picked.length === 0) return null;
  return multiSelect ? JSON.stringify(picked) : picked[0];
}

export function buildQaEntries(
  prompts: PendingPrompt[],
  answers: Record<string, string | null>,
): ClarifyQaEntry[] {
  return prompts.map((prompt) => ({
    question: prompt.question ?? "",
    answer: answers[prompt.questionId ?? prompt.promptId] ?? null,
  }));
}

export function displayClarifyAnswer(answer: string | null | undefined): string {
  if (answer === null || answer === undefined) return "已跳过";
  const trimmed = answer.trim();
  if (!trimmed) return "已跳过";
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const items = parsed.filter((item): item is string => typeof item === "string");
        if (items.length > 0) return items.join("、");
      }
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export function latestQaRecord(
  records: ClarifyQaRecord[],
  sessionIds: (string | null | undefined)[],
  messages: ChatMessage[],
): ClarifyQaRecord | null {
  const wanted = new Set(sessionIds.filter((id): id is string => Boolean(id)));
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (wanted.size > 0 && record.sessionId && !wanted.has(record.sessionId)) continue;
    if (!findToolMessageByToolId(messages, record.toolId)) continue;
    return record;
  }
  return null;
}
