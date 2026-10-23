import { atom } from "jotai";
import type {
  GatewayEvent,
  GatewayMessageUsageT,
  HermesMessageMetadata,
  HermesMessagePart,
  HermesUIMessage,
} from "@hermes/protocol";
import type { ConnectionState } from "@/lib/gateway-client";
import {
  normalizeCliThinkingProgress,
  normalizeReasoningText,
} from "@/lib/reasoning-filter";
import {
  dedupeImageParts,
  imagePartFromSource,
} from "@/lib/message-images";
import { notifyFromGatewayEvent } from "@/lib/notifications";
import { parsePromptEvent, type Prompt } from "@/lib/prompt-contract";
import { resolvePersistentSessionId } from "@/lib/session-map";
import { readUiValue, recordUiTurnStats, removeUiValue, stableTextHash, writeUiValue } from "@/lib/ui-store";
import { routeCliDelegationGatewayEventAtom } from "@/stores/cli-delegations";
import { routeSubagentGatewayEventAtom } from "@/stores/subagents";

export interface ToolEntry {
  tool_id: string;
  name: string;
  context?: string;
  preview?: string;
  summary?: string;
  error?: string;
  status: "running" | "done" | "error";
  startedAt: number;
  completedAt?: number;
}

export interface ImageEntry {
  url?: string;
  alt?: string;
  title?: string;
  name?: string;
  mimeType?: string;
}

export type AssistantTurnBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "progress"; text: string }
  | { type: "image"; image: ImageEntry }
  | { type: "tool"; tool: ToolEntry }
  | { type: "moa_reference"; label: string; text: string; index?: number; count?: number };

export interface PendingApproval {
  requestId: string;
  sessionId: string;
  command: string;
  reason?: string;
}

/**
 * One unanswered gateway prompt (blocking approval or clarify). Mirrors the
 * kernel's `approval.request` / `clarify.request` payload plus the session it
 * belongs to and the time it arrived; `sessionId` is the *live* gateway
 * session id, which is what `approval.respond` / `clarify.respond` take.
 */
export interface PendingPrompt {
  kind: "approval" | "clarify" | "value" | "setup";
  promptId: string;
  generation: number;
  sessionId: string;
  command?: string;
  description?: string;
  question?: string;
  choices: string[];
  multiSelect: boolean;
  timeoutS?: number;
  receivedAt: number;
  /**
   * How the prompt reached us. `"event"` prompts come in as
   * `approval.request` / `clarify.request` notifications and answer through the
   * `*.respond` RPC; `"server-request"` prompts are JSON-RPC requests the
   * backend sends to an attached desktop client (the only channel a local
   * viewer gets) and answer through the response frame.
   */
  transport?: "event" | "server-request";
  /** JSON-RPC id of the blocking server request (`srq-…`). */
  serverRequestId?: string;
  /** `qid` of this question inside a batch clarify server request. */
  questionId?: string;
  /** 单值输入卡要遮蔽输入（sudo 口令 / secret / vault 提示）。 */
  secret?: boolean;
  /** 单值卡的多字段变体（`vault.save_login`：账号 + 密码）。 */
  fields?: PendingPromptField[];
  /** 值卡上的一行说明（`vault.save_login`：保存到哪个站点）。 */
  detail?: string;
  /** `setup_choose` 卡的类型（question / accent / theme / layout / connectors / plugins / tour / fork / machine_use）。 */
  setupKind?: string;
  /** `setup_choose` 卡的候选行；空表示只接受自由输入。 */
  options?: PendingPromptOption[];
  /** `setup_choose` 多选卡预选中的行 id。 */
  preselected?: string[];
}

export interface PendingPromptField {
  key: string;
  label: string;
  secret: boolean;
}

export interface PendingPromptOption {
  id: string;
  label: string;
  detail?: string;
}

export type StreamStatus = "idle" | "connecting" | "streaming" | "complete" | "error";

export interface ChatSessionRuntime {
  messages: HermesUIMessage[];
  streamStatus: StreamStatus;
  /** Derived, backward-compatible projection of `pendingPrompts` (approvals only). */
  pendingApprovals: PendingApproval[];
  /** Unanswered blocking prompts of any kind (approvals + clarify). */
  pendingPrompts?: PendingPrompt[];
  statusMessage: string;
  statusKind?: string;
  statusUpdatedAt?: number;
  updatedAt: number;
  /**
   * Wall-clock ms of the last *backend* event reduced for this session. Unlike
   * {@link updatedAt} (also bumped by local atom mutations like manual
   * interrupt / reset), this only advances when the gateway actually sends
   * something, so the stall watchdog can tell a live turn apart from a wedged
   * one where the backend has gone completely silent. See `session-activity.ts`.
   */
  lastActivityAt?: number;
  turnStartedAt?: number;
  turnFirstTokenAt?: number;
  activeAssistantId?: string;
  interrupted?: boolean;
}

export type ChatRuntimeBySession = Record<string, ChatSessionRuntime>;

type HermesToolPart = Extract<HermesMessagePart, { type: "tool" }>;

export const gwConnectionAtom = atom<ConnectionState>("idle");
const GW_SESSION_ID_KEY = "hermes.gateway-session-id";

const gwSessionIdBaseAtom = atom<string | null>(
  readUiValue<string | null>(GW_SESSION_ID_KEY, null),
);

/**
 * The live gateway session ID assigned by the backend on session.create or
 * session.resume. Persisted to the UI store so an in-flight turn can be
 * reattached after page refresh (F5).
 *
 * Setting to `null` removes the persisted key so a stale gateway session ID
 * doesn't linger after the turn completes or is explicitly closed.
 */
export const gwSessionIdAtom = atom(
  (get) => get(gwSessionIdBaseAtom),
  (_get, set, next: string | null) => {
    set(gwSessionIdBaseAtom, next);
    if (next) {
      writeUiValue(GW_SESSION_ID_KEY, next);
    } else {
      removeUiValue(GW_SESSION_ID_KEY);
    }
  },
);

export const chatRuntimeBySessionAtom = atom<ChatRuntimeBySession>({});

const GENERIC_TURN_FAILURE_TEXT =
  "模型服务调用未成功。常见原因：API Key 失效或不在模型权限范围、网络/服务不可达。请到 设置 → 模型 检查后重试。";
const PROVIDER_STATUS_KINDS = new Set([
  "provider_wait",
  "provider_retry",
  "provider_stalled",
  "tool_generating",
  "moa_reference",
  "moa_aggregating",
]);
const OPTIMISTIC_ASSISTANT_PROGRESS = "正在唤醒Hermes...";

export function createEmptyChatRuntime(now = Date.now()): ChatSessionRuntime {
  return {
    messages: [],
    streamStatus: "idle",
    pendingApprovals: [],
    pendingPrompts: [],
    statusMessage: "",
    updatedAt: now,
  };
}

function promptAsApproval(prompt: PendingPrompt): PendingApproval {
  return {
    requestId: prompt.promptId,
    sessionId: prompt.sessionId,
    command: prompt.command ?? prompt.description ?? "需要确认操作",
    reason: prompt.description,
  };
}

/**
 * Read the prompt list off a runtime, tolerating runtimes built by older code
 * paths or tests that only carry the legacy `pendingApprovals` field.
 */
export function promptsOf(runtime: ChatSessionRuntime): PendingPrompt[] {
  const prompts = runtime.pendingPrompts;
  if (Array.isArray(prompts) && prompts.length > 0) return prompts;
  const legacy = runtime.pendingApprovals ?? [];
  if (legacy.length === 0) return Array.isArray(prompts) ? prompts : [];
  return legacy.map((approval) => ({
    kind: "approval" as const,
    promptId: approval.requestId,
    generation: 0,
    sessionId: approval.sessionId,
    command: approval.command,
    description: approval.reason,
    choices: ["once", "deny"],
    multiSelect: false,
    receivedAt: 0,
  }));
}

function replacePrompts(
  runtime: ChatSessionRuntime,
  prompts: PendingPrompt[],
): ChatSessionRuntime {
  return {
    ...runtime,
    pendingPrompts: prompts,
    pendingApprovals: prompts.filter((prompt) => prompt.kind === "approval").map(promptAsApproval),
  };
}

function promptFromPayload(
  kind: "approval" | "clarify",
  payload: Record<string, any>,
  sessionId: string,
  now: number,
): PendingPrompt | null {
  const parsed: Prompt | null = parsePromptEvent(kind, payload);
  if (!parsed) return null;
  return { ...parsed, sessionId, receivedAt: now };
}

function assistantClientId(now: number): string {
  return `live-assistant-${now}`;
}

function userClientId(now: number): string {
  return `live-user-${now}`;
}

function systemClientId(now: number): string {
  return `live-system-${now}`;
}

function payloadOf(event: GatewayEvent): Record<string, any> {
  return event.payload && typeof event.payload === "object"
    ? event.payload as Record<string, any>
    : {};
}

function pickErrorText(payload: Record<string, any>, fallback = GENERIC_TURN_FAILURE_TEXT): string {
  for (const key of ["error", "message", "warning", "detail"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return fallback;
}

function resetStream(runtime: ChatSessionRuntime, now: number): ChatSessionRuntime {
  return {
    ...runtime,
    statusMessage: "",
    statusKind: undefined,
    statusUpdatedAt: undefined,
    activeAssistantId: undefined,
    turnStartedAt: undefined,
    turnFirstTokenAt: undefined,
    updatedAt: now,
  };
}

function isProviderStatusKind(kind: string | undefined): boolean {
  return kind !== undefined && PROVIDER_STATUS_KINDS.has(kind);
}

function clearProviderStatus(runtime: ChatSessionRuntime): ChatSessionRuntime {
  if (!isProviderStatusKind(runtime.statusKind)) return runtime;
  return {
    ...runtime,
    statusMessage: "",
    statusKind: undefined,
    statusUpdatedAt: undefined,
  };
}

function sessionIdFor(runtime: ChatSessionRuntime, event: GatewayEvent): string {
  return event.session_id ?? runtime.messages[0]?.sessionId ?? "";
}

function isStreamingStatus(status: StreamStatus): boolean {
  return status === "streaming" || status === "connecting";
}

function textFromParts(parts: HermesMessagePart[]): string {
  return parts
    .filter((part): part is Extract<HermesMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function reasoningFromParts(parts: HermesMessagePart[]): string {
  return parts
    .filter((part): part is Extract<HermesMessagePart, { type: "reasoning" }> => part.type === "reasoning")
    .map((part) => part.text)
    .join("");
}

function looseComparableText(value: string | undefined): string {
  return (value ?? "")
    .replace(/\s+/g, "")
    .replace(/[*_`~]/g, "")
    .replace(/[，。！？、：；,.!?:;"'“”‘’（）()[\]{}<>《》\-—–]/g, "")
    .toLowerCase();
}

function withoutProgressParts(parts: HermesMessagePart[]): HermesMessagePart[] {
  return parts.filter((part) => part.type !== "progress");
}

function imagePartsFromPayload(payload: Record<string, any>): HermesMessagePart[] {
  const sources = Array.isArray(payload.images)
    ? payload.images
    : payload.image !== undefined
      ? [payload.image]
      : payload.image_url !== undefined
        ? [payload.image_url]
        : [];

  return dedupeImageParts(
    sources.flatMap((source: unknown, index: number) => {
      const part = imagePartFromSource(source, `image-${index + 1}`);
      return part ? [part] : [];
    }),
  );
}

function appendImageParts(parts: HermesMessagePart[], images: HermesMessagePart[]): HermesMessagePart[] {
  if (!images.length) return parts;
  const progressIndex = parts.findIndex((part) => part.type === "progress");
  const base = progressIndex === -1
    ? parts
    : [...parts.slice(0, progressIndex), ...parts.slice(progressIndex + 1)];
  const currentImages = base.filter((part): part is Extract<HermesMessagePart, { type: "image" }> =>
    part.type === "image"
  );
  const nextImages = dedupeImageParts([
    ...currentImages,
    ...images.filter((part): part is Extract<HermesMessagePart, { type: "image" }> => part.type === "image"),
  ]);
  const imageKeys = new Set(nextImages.map((part) => part.url || part.path || part.name || part.alt).filter(Boolean));
  const withoutDuplicateImages = base.filter((part) => {
    if (part.type !== "image") return true;
    const key = part.url || part.path || part.name || part.alt;
    return !key || !imageKeys.has(key);
  });
  const merged = [...withoutDuplicateImages, ...nextImages];
  return progressIndex === -1
    ? merged
    : [
      ...merged.slice(0, progressIndex),
      parts[progressIndex]!,
      ...merged.slice(progressIndex),
    ];
}

function terminateRunningTools(parts: HermesMessagePart[]): HermesMessagePart[] {
  let changed = false;
  const next = parts.map((part) => {
    if (part.type === "tool" && part.state === "running") {
      changed = true;
      return { ...part, state: "error" as const };
    }
    return part;
  });
  return changed ? next : parts;
}

function appendTextPart(parts: HermesMessagePart[], text: string): HermesMessagePart[] {
  if (!text) return parts;
  const next = withoutProgressParts(parts);
  const last = next[next.length - 1];
  if (last?.type === "text") {
    next[next.length - 1] = { ...last, text: last.text + text };
  } else {
    next.push({ type: "text", text });
  }
  return next;
}

function appendReasoningPart(parts: HermesMessagePart[], text: string): HermesMessagePart[] {
  if (!text) return parts;
  const next = withoutProgressParts(parts);
  const last = next[next.length - 1];
  if (last?.type === "reasoning") {
    next[next.length - 1] = { ...last, text: last.text + text };
  } else {
    next.push({ type: "reasoning", text });
  }
  return next;
}

// reasoning.available 的 payload 是「这一段思考」的全文，更新最后一段 reasoning，
// 不能回写第一段：回写会让更早的段落变成整段副本。
function upsertReasoningPart(parts: HermesMessagePart[], text: string): HermesMessagePart[] {
  if (!text) return parts;
  const next = withoutProgressParts(parts);
  let index = -1;
  for (let cursor = next.length - 1; cursor >= 0; cursor -= 1) {
    if (next[cursor].type === "reasoning") {
      index = cursor;
      break;
    }
  }
  if (index === -1) return [...next, { type: "reasoning", text }];
  const part = next[index];
  if (part.type !== "reasoning") return next;
  const merged = part.text.startsWith(text)
    ? part.text
    : text.startsWith(part.text)
      ? text
      : part.text + text;
  next[index] = { ...part, text: merged };
  return next;
}

// message.complete 的 reasoning 是整回合全文：把所有 reasoning 段折叠成一段，
// 否则「整段回写第一段 + 其余分段还在」会让同一回合出现多个推理过程块。
function collapseReasoningParts(parts: HermesMessagePart[], text: string): HermesMessagePart[] {
  const next = withoutProgressParts(parts);
  const kept: HermesMessagePart[] = [];
  let inserted = false;
  for (const part of next) {
    if (part.type !== "reasoning") {
      kept.push(part);
      continue;
    }
    if (inserted) continue;
    inserted = true;
    kept.push({ ...part, text });
  }
  if (!inserted) kept.push({ type: "reasoning", text });
  return kept;
}

function upsertProgressPart(parts: HermesMessagePart[], text: string): HermesMessagePart[] {
  if (!text) return parts;
  const index = parts.findIndex((part) => part.type === "progress");
  if (index === -1) return [...parts, { type: "progress", text }];
  return parts.map((part, idx) =>
    idx === index && part.type === "progress" ? { ...part, text } : part,
  );
}

function appendToolPart(parts: HermesMessagePart[], tool: HermesToolPart): HermesMessagePart[] {
  const progressIndex = parts.findIndex((part) => part.type === "progress");
  if (progressIndex === -1) return [...parts, tool];
  return [
    ...parts.slice(0, progressIndex),
    tool,
    ...parts.slice(progressIndex),
  ];
}

function mergeFinalTextPart(parts: HermesMessagePart[], finalText: string): HermesMessagePart[] {
  if (!finalText) return parts;
  const next = withoutProgressParts(parts);
  let lastToolIndex = -1;
  next.forEach((part, index) => {
    if (part.type === "tool") lastToolIndex = index;
  });
  const finalSegmentStart = lastToolIndex + 1;
  const existingFinalSegment = textFromParts(next.slice(finalSegmentStart));

  if (existingFinalSegment === finalText) return next;

  // message.complete.text is the authoritative final assistant response. In a
  // tool-bearing turn it represents only the text after the final tool call;
  // earlier commentary must remain intact. Replace that trailing text segment
  // instead of appending when streamed deltas diverge: an out-of-order WS batch
  // can otherwise produce "corrupt partial + complete final" in one live row.
  let inserted = false;
  const reconciled = next.flatMap((part, index) => {
    if (index < finalSegmentStart || part.type !== "text") return [part];
    if (inserted) return [];
    inserted = true;
    return [{ ...part, text: finalText }];
  });

  return inserted ? reconciled : [...reconciled, { type: "text", text: finalText }];
}

function findToolMatch(tool: HermesToolPart, payload: Record<string, any>): boolean {
  if (payload.tool_id) return tool.toolCallId === payload.tool_id;
  if (!payload.name) return false;
  return tool.state === "running" && tool.name === payload.name;
}

function updateToolParts(
  parts: HermesMessagePart[],
  payload: Record<string, any>,
  updater: (tool: HermesToolPart) => HermesToolPart,
): HermesMessagePart[] {
  return parts.map((part) => {
    if (part.type !== "tool" || !findToolMatch(part, payload)) return part;
    return updater(part);
  });
}

function completeToolPart(tool: HermesToolPart, payload: Record<string, any>, now: number): HermesToolPart {
  const duration = payload.duration_s;
  const completedAt =
    typeof duration === "number" && Number.isFinite(duration) && duration >= 0 && tool.startedAt
      ? tool.startedAt + duration * 1000
      : now;
  const output =
    typeof payload.inline_diff === "string"
      ? payload.inline_diff
      : typeof payload.summary === "string"
        ? payload.summary
        : tool.output;

  return {
    ...tool,
    state: payload.error ? "error" : "done",
    output,
    errorText: typeof payload.error === "string" ? payload.error : undefined,
    completedAt,
  };
}

function updateMessage(
  runtime: ChatSessionRuntime,
  id: string,
  updater: (message: HermesUIMessage) => HermesUIMessage | null,
): ChatSessionRuntime {
  let changed = false;
  const messages = runtime.messages.flatMap((message) => {
    if (message.id !== id) return [message];
    changed = true;
    const next = updater(message);
    return next ? [next] : [];
  });
  return changed ? { ...runtime, messages } : runtime;
}

function ensureAssistantMessage(
  runtime: ChatSessionRuntime,
  sessionId: string,
  id: string,
  now: number,
): ChatSessionRuntime {
  if (runtime.messages.some((message) => message.id === id)) {
    return updateMessage(runtime, id, (message) => ({
      ...message,
      status: message.status === "error" ? "error" : "streaming",
    }));
  }

  const createdAt = runtime.turnStartedAt ?? now;
  return {
    ...runtime,
    messages: [
      ...runtime.messages,
      {
        id,
        sessionId,
        role: "assistant",
        createdAt,
        status: "streaming",
        parts: [],
      },
    ],
  };
}

function activeAssistantId(runtime: ChatSessionRuntime, now: number): string {
  return runtime.activeAssistantId ?? assistantClientId(now);
}

function updateActiveAssistant(
  runtime: ChatSessionRuntime,
  sessionId: string,
  now: number,
  updater: (message: HermesUIMessage) => HermesUIMessage | null,
): ChatSessionRuntime {
  const id = activeAssistantId(runtime, now);
  const ensured = ensureAssistantMessage(
    { ...runtime, activeAssistantId: id },
    sessionId,
    id,
    now,
  );
  return updateMessage(ensured, id, updater);
}

function appendNoticeMessage(
  runtime: ChatSessionRuntime,
  sessionId: string,
  now: number,
  text: string,
  level: "info" | "warning" | "error" | "system",
): ChatSessionRuntime {
  const trimmed = text.trim();
  if (!trimmed) return runtime;
  return {
    ...runtime,
    messages: [
      ...runtime.messages,
      {
        id: systemClientId(now),
        sessionId,
        role: "system",
        createdAt: now,
        status: level === "error" ? "error" : "complete",
        parts: [{ type: "notice", level, text: trimmed }],
      },
    ],
  };
}

// Map backend status.update lifecycle signals to localized, user-facing text.
// Returns "" to clear the status line, undefined to leave it unchanged.
function localizeStatusUpdate(kind: string, text: string): string | undefined {
  if (kind === "compressing") return "正在压缩上下文…";
  // session.compress pins a neutral "ready" status when compaction settles —
  // surface nothing rather than a raw English "ready" string in the timeline.
  if (kind === "ready" || text === "ready") return "";
  return text || undefined;
}

function gatewayUsageMetadata(usage: GatewayMessageUsageT | undefined): HermesMessageMetadata["usage"] | undefined {
  if (!usage) return undefined;
  const next: NonNullable<HermesMessageMetadata["usage"]> = {};
  if (typeof usage.input === "number") next.tokensInput = usage.input;
  if (typeof usage.output === "number") next.tokensOutput = usage.output;
  if (typeof usage.prompt === "number") next.tokensPrompt = usage.prompt;
  if (typeof usage.completion === "number") next.tokensCompletion = usage.completion;
  if (typeof usage.total === "number") next.tokensTotal = usage.total;
  if (typeof usage.cache_read === "number") next.cacheRead = usage.cache_read;
  if (typeof usage.cache_write === "number") next.cacheWrite = usage.cache_write;
  if (typeof usage.calls === "number") next.apiCalls = usage.calls;
  if (typeof usage.context_used === "number") next.contextUsed = usage.context_used;
  if (typeof usage.context_max === "number") next.contextMax = usage.context_max;
  if (typeof usage.context_percent === "number") next.contextPercent = usage.context_percent;
  return Object.keys(next).length > 0 ? next : undefined;
}

function completionMetadata(
  payload: Record<string, any>,
  runtime: ChatSessionRuntime,
  now: number,
): HermesMessageMetadata | undefined {
  const usage =
    payload.usage && typeof payload.usage === "object"
      ? (payload.usage as GatewayMessageUsageT)
      : undefined;
  const startedAt = runtime.turnStartedAt;
  const firstTokenAt = runtime.turnFirstTokenAt;
  const timing: NonNullable<HermesMessageMetadata["timing"]> = {};
  if (typeof startedAt === "number") timing.startedAt = startedAt;
  if (typeof firstTokenAt === "number") timing.firstTokenAt = firstTokenAt;
  timing.completedAt = now;
  if (typeof startedAt === "number" && typeof firstTokenAt === "number" && firstTokenAt >= startedAt) {
    timing.ttftMs = firstTokenAt - startedAt;
  }
  if (typeof startedAt === "number" && now >= startedAt) {
    timing.durationMs = now - startedAt;
  }

  const metadata: HermesMessageMetadata = {};
  const usageMetadata = gatewayUsageMetadata(usage);
  if (usageMetadata) metadata.usage = usageMetadata;
  if (Object.keys(timing).length > 0) metadata.timing = timing;
  if (typeof usage?.model === "string" && usage.model) metadata.model = usage.model;
  const finishReason =
    typeof usage?.finish_reason === "string"
      ? usage.finish_reason
      : typeof payload.finish_reason === "string"
        ? payload.finish_reason
        : typeof payload.status === "string" && payload.status !== "complete"
          ? payload.status
          : undefined;
  if (finishReason) metadata.finishReason = finishReason;
  if (typeof usage?.cost_usd === "number" || usage?.cost_usd === null) {
    metadata.costUsd = usage.cost_usd;
  }
  if (typeof usage?.cost_status === "string") metadata.costStatus = usage.cost_status;

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function finalizeAssistantParts(
  message: HermesUIMessage,
  payload: Record<string, any>,
): HermesMessagePart[] {
  let parts = withoutProgressParts(message.parts);
  const finalText = typeof payload.text === "string" ? payload.text : "";
  const finalReasoning = normalizeReasoningText(
    typeof payload.reasoning === "string" ? payload.reasoning : "",
  );

  parts = mergeFinalTextPart(parts, finalText);
  if (finalReasoning) {
    parts = collapseReasoningParts(parts, finalReasoning);
  }
  parts = appendImageParts(parts, imagePartsFromPayload(payload));

  return parts;
}

export function reduceGatewayEvent(
  runtime: ChatSessionRuntime,
  event: GatewayEvent,
  now = Date.now(),
): ChatSessionRuntime {
  const next = reduceGatewayEventInner(runtime, event, now);
  // Stamp the last time we heard from the backend. `next === runtime` means
  // the event was a no-op (e.g. a late event from an interrupted turn that was
  // dropped) — don't count those as activity. Everything the gateway actually
  // applies resets the stall watchdog's silence timer.
  if (next === runtime) return next;
  return { ...next, lastActivityAt: now };
}

function reduceGatewayEventInner(
  runtime: ChatSessionRuntime,
  event: GatewayEvent,
  now = Date.now(),
): ChatSessionRuntime {
  const payload = payloadOf(event);
  const sessionId = sessionIdFor(runtime, event);

  if (runtime.interrupted) {
    if (event.type === "message.start") {
      // 新回合开始即解除屏蔽，远程发起的回合和 busy 重试都依赖这里恢复渲染
      return reduceGatewayEvent({ ...runtime, interrupted: undefined }, event, now);
    }
    if (event.type !== "message.complete" && event.type !== "error") {
      // 丢弃被中断回合迟到的流式事件；终态事件放行，让半截消息正常收尾
      return runtime;
    }
  }

  switch (event.type) {
    case "message.start": {
      const id =
        isStreamingStatus(runtime.streamStatus) && runtime.activeAssistantId
          ? runtime.activeAssistantId
          : assistantClientId(now);
      return ensureAssistantMessage(
        {
          ...runtime,
          streamStatus: "streaming",
          statusMessage: "",
          statusKind: undefined,
          statusUpdatedAt: undefined,
          activeAssistantId: id,
          turnStartedAt: runtime.turnStartedAt ?? now,
          turnFirstTokenAt: undefined,
          updatedAt: now,
        },
        sessionId,
        id,
        now,
      );
    }

    case "message.delta": {
      const text = typeof payload.text === "string" ? payload.text : "";
      const images = imagePartsFromPayload(payload);
      // Empty delta must not create an assistant message block — it's a
      // no-op that prevents "重复发送3条空消息".  The backend may
      // emit empty-string deltas during reasoning↔content transitions.
      if (!text && images.length === 0) return runtime;
      const id = activeAssistantId(runtime, now);
      const next = updateActiveAssistant(
        clearProviderStatus({
          ...runtime,
          streamStatus: "streaming",
          activeAssistantId: id,
          turnStartedAt: runtime.turnStartedAt ?? now,
          turnFirstTokenAt: runtime.turnFirstTokenAt ?? (text ? now : runtime.turnFirstTokenAt),
          updatedAt: now,
        }),
        sessionId,
        now,
        (message) => ({
          ...message,
          status: "streaming",
          parts: appendImageParts(appendTextPart(message.parts, text), images),
        }),
      );
      return next;
    }

    case "moa.reference": {
      // 一个 reference 模型的完整输出块（label + 全文），在聚合器回答之前
      // 逐个到达。追加为独立的 moa_reference part；同时用 provider-status
      // 通道提示进度（message.delta 到达时自动清除）。
      const label = typeof payload.label === "string" ? payload.label : "";
      const text = typeof payload.text === "string" ? payload.text : "";
      const index = typeof payload.index === "number" ? payload.index : undefined;
      const count = typeof payload.count === "number" ? payload.count : undefined;
      if (!label && !text) return runtime;
      const id = activeAssistantId(runtime, now);
      const progressLabel =
        index !== undefined && count !== undefined
          ? `参考模型 ${label || "?"} 已完成（${index + 1}/${count}）…`
          : `参考模型 ${label || "?"} 已完成…`;
      return updateActiveAssistant(
        {
          ...runtime,
          streamStatus: "streaming",
          activeAssistantId: id,
          turnStartedAt: runtime.turnStartedAt ?? now,
          statusMessage: progressLabel,
          statusKind: "moa_reference",
          statusUpdatedAt: now,
          updatedAt: now,
        },
        sessionId,
        now,
        (message) => ({
          ...message,
          status: "streaming",
          parts: [
            ...message.parts,
            { type: "moa_reference", label: label || "reference", text, index, count },
          ],
        }),
      );
    }

    case "moa.aggregating": {
      // references 齐了，聚合器开始综合；它的回答走普通 message.delta 流，
      // 到达时 clearProviderStatus 会清掉这条状态。
      const aggregator = typeof payload.aggregator === "string" ? payload.aggregator : "";
      return {
        ...runtime,
        statusMessage: aggregator
          ? `聚合器 ${aggregator} 正在综合各模型观点…`
          : "聚合器正在综合各模型观点…",
        statusKind: "moa_aggregating",
        statusUpdatedAt: now,
        updatedAt: now,
      };
    }

    case "thinking.delta":
    case "reasoning.delta": {
      const progress = normalizeCliThinkingProgress(payload.text);
      const id = activeAssistantId(runtime, now);
      if (progress) {
        return updateActiveAssistant(
          clearProviderStatus({
            ...runtime,
            streamStatus: "streaming",
            activeAssistantId: id,
            turnStartedAt: runtime.turnStartedAt ?? now,
            updatedAt: now,
          }),
          sessionId,
          now,
          (message) => ({
            ...message,
            status: "streaming",
            parts: upsertProgressPart(message.parts, progress),
          }),
        );
      }

      const text = normalizeReasoningText(payload.text);
      return updateActiveAssistant(
        clearProviderStatus({
          ...runtime,
          streamStatus: "streaming",
          activeAssistantId: id,
          turnStartedAt: runtime.turnStartedAt ?? now,
          turnFirstTokenAt: runtime.turnFirstTokenAt ?? (text ? now : runtime.turnFirstTokenAt),
          updatedAt: now,
        }),
        sessionId,
        now,
        (message) => ({
          ...message,
          status: "streaming",
          parts: appendReasoningPart(message.parts, text),
        }),
      );
    }

    case "reasoning.available": {
      const progress = normalizeCliThinkingProgress(payload.text);
      const id = activeAssistantId(runtime, now);
      if (progress) {
        return updateActiveAssistant(
          clearProviderStatus({
            ...runtime,
            activeAssistantId: id,
            updatedAt: now,
          }),
          sessionId,
          now,
          (message) => ({
            ...message,
            parts: upsertProgressPart(message.parts, progress),
          }),
        );
      }

      const text = normalizeReasoningText(payload.text);
      return updateActiveAssistant(
        clearProviderStatus({
          ...runtime,
          activeAssistantId: id,
          updatedAt: now,
        }),
        sessionId,
        now,
        (message) => ({
          ...message,
          // 流式供应商已经把思考内容走 reasoning.delta 落进了 reasoning part；
          // 这种情况下 reasoning.available 只是"这一轮思考结束"的信号，payload 里
          // 带的往往是最终答案预览，再追加一次就会让推理块里出现答案副本。
          parts: message.parts.some((part) => part.type === "reasoning")
            ? message.parts
            : upsertReasoningPart(message.parts, text),
        }),
      );
    }

    case "message.complete": {
      const id = activeAssistantId(runtime, now);
      const metadata = completionMetadata(payload, runtime, now);
      const isErrorCompletion = payload.status === "error";
      let next = updateActiveAssistant(
        {
          ...runtime,
          activeAssistantId: id,
          updatedAt: now,
        },
        sessionId,
        now,
        (message) => {
          const finalizedParts = finalizeAssistantParts(message, payload);
          const parts = isErrorCompletion ? terminateRunningTools(finalizedParts) : finalizedParts;
          if (parts.length === 0) return null;
          return {
            ...message,
            status: isErrorCompletion ? "error" : "complete",
            parts,
            metadata: metadata ? { ...message.metadata, ...metadata } : message.metadata,
          };
        },
      );

      const warningText =
        typeof payload.warning === "string" && payload.warning.trim()
          ? payload.warning
          : undefined;
      if (warningText) {
        next = appendNoticeMessage(next, sessionId, now + 1, warningText, "warning");
      }
      if (isErrorCompletion) {
        next = appendNoticeMessage(next, sessionId, now + 2, pickErrorText(payload), "error");
      }

      return {
        ...next,
        streamStatus: isErrorCompletion ? "error" : "complete",
        statusMessage: warningText ?? "",
        statusKind: warningText ? "warn" : undefined,
        statusUpdatedAt: warningText ? now : undefined,
        turnStartedAt: undefined,
        turnFirstTokenAt: undefined,
        activeAssistantId: undefined,
        interrupted: undefined,
        updatedAt: now,
      };
    }

    case "tool.start": {
      const id = activeAssistantId(runtime, now);
      const tool: HermesToolPart = {
        type: "tool",
        toolCallId: String(payload.tool_id ?? `tool-${now}`),
        name: String(payload.name ?? "tool"),
        state: "running",
        input: typeof payload.context === "string" ? { context: payload.context } : undefined,
        startedAt: now,
      };
      return updateActiveAssistant(
        clearProviderStatus({
          ...runtime,
          streamStatus: "streaming",
          activeAssistantId: id,
          turnStartedAt: runtime.turnStartedAt ?? now,
          updatedAt: now,
        }),
        sessionId,
        now,
        (message) => ({
          ...message,
          status: "streaming",
          parts: appendToolPart(message.parts, tool),
        }),
      );
    }

    case "tool.generating": {
      // 模型正在流式生成工具调用参数（先于 tool.start，此刻还没有 tool part）。
      // 走 provider-status 通道展示轻量提示；tool.start/内容事件到达时由
      // clearProviderStatus 自然清除。
      const name = typeof payload.name === "string" ? payload.name : "";
      return {
        ...runtime,
        statusMessage: name ? `正在准备 ${name} 工具调用…` : "正在准备工具调用…",
        statusKind: "tool_generating",
        statusUpdatedAt: now,
        updatedAt: now,
      };
    }

    case "tool.complete": {
      const id = activeAssistantId(runtime, now);
      return updateActiveAssistant(
        clearProviderStatus({
          ...runtime,
          activeAssistantId: id,
          updatedAt: now,
        }),
        sessionId,
        now,
        (message) => ({
          ...message,
          parts: updateToolParts(message.parts, payload, (tool) =>
            completeToolPart(tool, payload, now),
          ),
        }),
      );
    }

    case "approval.request":
    case "clarify.request": {
      const kind = event.type === "clarify.request" ? "clarify" : "approval";
      const prompt = promptFromPayload(kind, payload, sessionId, now);
      if (!prompt) return runtime;
      const prompts = [
        ...promptsOf(runtime).filter((item) => item.promptId !== prompt.promptId),
        prompt,
      ];
      return replacePrompts(
        {
          ...runtime,
          streamStatus: "streaming",
          updatedAt: now,
        },
        prompts,
      );
    }

    case "approval.settled":
    case "clarify.settled": {
      const promptId = typeof payload.prompt_id === "string" ? payload.prompt_id : "";
      if (!promptId) return runtime;
      const current = promptsOf(runtime);
      const prompts = current.filter((item) => item.promptId !== promptId);
      if (prompts.length === current.length) return runtime;
      return replacePrompts({ ...runtime, updatedAt: now }, prompts);
    }

    case "status.update": {
      const kind = typeof payload.kind === "string" ? payload.kind : "status";
      const text = typeof payload.text === "string" ? payload.text : "";
      const localized = localizeStatusUpdate(kind, text);
      return {
        ...runtime,
        statusMessage: localized !== undefined ? localized : runtime.statusMessage,
        statusKind: kind,
        statusUpdatedAt: now,
        updatedAt: now,
      };
    }

    case "error": {
      const text = pickErrorText(payload, "发生错误");
      const erroredActive = runtime.activeAssistantId
        ? updateMessage(runtime, runtime.activeAssistantId, (message) => ({
            ...message,
            status: "error",
            parts: terminateRunningTools(withoutProgressParts(message.parts)),
          }))
        : runtime;
      const next = appendNoticeMessage(erroredActive, sessionId, now, text, "error");
      return {
        ...next,
        streamStatus: "error",
        statusMessage: text,
        statusKind: "error",
        statusUpdatedAt: now,
        activeAssistantId: undefined,
        interrupted: undefined,
        updatedAt: now,
      };
    }

    case "gateway.disconnected": {
      if (!isStreamingStatus(runtime.streamStatus)) return runtime;
      const id = runtime.activeAssistantId;
      const next = id
        ? updateMessage(runtime, id, (message) => ({
            ...message,
            status: "error",
            parts: terminateRunningTools(withoutProgressParts(message.parts)),
          }))
        : runtime;
      return {
        ...next,
        streamStatus: "error",
        statusMessage: "连接已断开",
        statusKind: "error",
        statusUpdatedAt: now,
        activeAssistantId: undefined,
        updatedAt: now,
      };
    }

    default:
      return runtime;
  }
}

function updateSessionRuntime(
  state: ChatRuntimeBySession,
  sessionId: string,
  updater: (runtime: ChatSessionRuntime) => ChatSessionRuntime,
): ChatRuntimeBySession {
  const current = state[sessionId] ?? createEmptyChatRuntime();
  return {
    ...state,
    [sessionId]: updater(current),
  };
}

export const ensureChatSessionAtom = atom(null, (_get, set, sessionId: string) => {
  set(chatRuntimeBySessionAtom, (state) =>
    state[sessionId] ? state : { ...state, [sessionId]: createEmptyChatRuntime() },
  );
});

export const resetChatSessionAtom = atom(null, (_get, set, sessionId: string) => {
  set(chatRuntimeBySessionAtom, (state) => ({
    ...state,
    [sessionId]: createEmptyChatRuntime(),
  }));
});

export const resetStreamStateAtom = atom(null, (_get, set, sessionId: string) => {
  const now = Date.now();
  set(chatRuntimeBySessionAtom, (state) =>
    updateSessionRuntime(state, sessionId, (runtime) => ({
      ...resetStream(runtime, now),
      streamStatus: "idle",
    })),
  );
});

// 全量 resume 拿到的 `messages` 快照覆盖时间线：补帧判定退化（水位超前 /
// epoch 变化 / seq 缺口）时只有这条路径能保证时间线不缺不重。
// 覆盖时不能整段丢掉正在流的那条 live 消息：快照里的同一条回复用的是服务端
// id，而后续实时帧只会更新 live id，丢了就再 append 一条（同一条回复两个气泡）。
// 所以把快照里对应回合的内容并进 live 那条，id 始终以 live 行为准。
export const hydrateSessionTimelineAtom = atom(
  null,
  (_get, set, params: { sessionId: string; messages: HermesUIMessage[]; running?: boolean }) => {
    const now = Date.now();
    const running = params.running === true;
    set(chatRuntimeBySessionAtom, (state) =>
      updateSessionRuntime(state, params.sessionId, (runtime) => {
        const live = running ? liveTurnAssistant(runtime) : undefined;
        const reconciled = live ? foldSnapshotTurnIntoLive(live, params.messages, runtime) : undefined;
        return {
          ...runtime,
          messages: reconciled ? reconciled.messages : params.messages,
          streamStatus: running ? "streaming" : "idle",
          statusMessage: "",
          statusKind: undefined,
          activeAssistantId: reconciled
            ? reconciled.assistantId
            : params.messages.some((message) => message.id === runtime.activeAssistantId)
              ? runtime.activeAssistantId
              : undefined,
          interrupted: false,
          updatedAt: now,
          lastActivityAt: now,
        };
      }),
    );
  },
);

// 手动终止：立即把会话标记为非运行态，并屏蔽旧回合迟到的流式事件。
// 故意保留 activeAssistantId / turnStartedAt，迟到的 message.complete 才能收尾正确的消息。
export const markSessionInterruptedAtom = atom(null, (_get, set, sessionId: string) => {
  const now = Date.now();
  set(chatRuntimeBySessionAtom, (state) =>
    updateSessionRuntime(state, sessionId, (runtime) => ({
      ...runtime,
      interrupted: true,
      streamStatus: "idle",
      statusMessage: "",
      statusKind: undefined,
      statusUpdatedAt: undefined,
      updatedAt: now,
    })),
  );
});

function storedAssistantIsAfterTurn(message: HermesUIMessage, turnStartedAt: number | undefined): boolean {
  if (turnStartedAt === undefined) return true;
  return message.createdAt >= turnStartedAt - 1_000;
}

function liveTurnAssistant(runtime: ChatSessionRuntime): HermesUIMessage | undefined {
  if (runtime.activeAssistantId) {
    const active = runtime.messages.find((message) => message.id === runtime.activeAssistantId);
    if (active) return active;
  }
  return [...runtime.messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.status === "streaming");
}

interface FoldedSnapshotTurn {
  messages: HermesUIMessage[];
  assistantId: string;
}

// 快照覆盖时间线时把 in-flight 回合并进 live 那条：快照里的 assistant 用服务端
// id，后续实时帧只会更新 live id，留着两份就是同一条回复两个气泡。内容以更完整
// 的那份为准，id/定位始终保留 live 的（React key、稳定性层都靠它）。
function foldSnapshotTurnIntoLive(
  live: HermesUIMessage,
  messages: HermesUIMessage[],
  runtime: ChatSessionRuntime,
): FoldedSnapshotTurn | undefined {
  if (messages.some((message) => message.id === live.id)) {
    return { messages, assistantId: live.id };
  }

  let tailIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") {
      tailIndex = index;
      break;
    }
  }
  if (tailIndex === -1) return undefined;

  const tail = messages[tailIndex]!;
  const liveText = looseComparableText(textFromParts(withoutProgressParts(live.parts)));
  const tailText = looseComparableText(textFromParts(withoutProgressParts(tail.parts)));
  const sameTurnText =
    liveText.length > 0 &&
    tailText.length > 0 &&
    (tailText.startsWith(liveText) || liveText.startsWith(tailText));
  const sameTurnIdleStart =
    liveText.length === 0 &&
    runtime.turnStartedAt !== undefined &&
    storedAssistantIsAfterTurn(tail, runtime.turnStartedAt);
  if (!sameTurnText && !sameTurnIdleStart) return undefined;

  const folded: HermesUIMessage = {
    ...tail,
    id: live.id,
    sessionId: live.sessionId,
    createdAt: live.createdAt,
    status: "streaming",
    parts: tailText.length >= liveText.length ? tail.parts : live.parts,
    metadata: tail.metadata ?? live.metadata,
  };

  return {
    messages: messages.map((message, index) => (index === tailIndex ? folded : message)),
    assistantId: live.id,
  };
}

function isRecoverableStoredAssistant(
  liveAssistant: HermesUIMessage,
  storedAssistant: HermesUIMessage,
  turnStartedAt: number | undefined,
): boolean {
  if (liveAssistant.role !== "assistant" || storedAssistant.role !== "assistant") return false;
  if (storedAssistant.status !== "complete") return false;
  if (!storedAssistantIsAfterTurn(storedAssistant, turnStartedAt)) return false;

  const liveText = looseComparableText(textFromParts(withoutProgressParts(liveAssistant.parts)));
  const storedText = looseComparableText(textFromParts(storedAssistant.parts));
  if (liveText && storedText) {
    return liveText === storedText || (liveText.length >= 4 && storedText.includes(liveText));
  }
  if (liveText && !storedText) {
    return false;
  }

  const liveReasoning = looseComparableText(reasoningFromParts(withoutProgressParts(liveAssistant.parts)));
  const storedReasoning = looseComparableText(reasoningFromParts(storedAssistant.parts));
  if (liveReasoning && storedReasoning) {
    return liveReasoning === storedReasoning ||
      (liveReasoning.length >= 4 && storedReasoning.includes(liveReasoning));
  }

  const liveHasOnlyProgress = withoutProgressParts(liveAssistant.parts).length === 0;
  const storedHasContent = storedText.length > 0 ||
    storedReasoning.length > 0 ||
    storedAssistant.parts.some((part) => part.type === "tool");
  return liveHasOnlyProgress && storedHasContent;
}

function recoverableAssistantId(
  runtime: ChatSessionRuntime,
  storedMessages: HermesUIMessage[],
): string | undefined {
  const activeCandidate = runtime.activeAssistantId
    ? runtime.messages.find((message) => message.id === runtime.activeAssistantId)
    : undefined;
  const fallbackCandidate = [...runtime.messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.status === "streaming");
  const liveAssistant = activeCandidate ?? fallbackCandidate;
  if (!liveAssistant) return undefined;

  const matched = storedMessages.some((storedMessage) =>
    isRecoverableStoredAssistant(liveAssistant, storedMessage, runtime.turnStartedAt),
  );
  return matched ? liveAssistant.id : undefined;
}

export const recoverCompletedTurnFromStoredMessagesAtom = atom(
  null,
  (_get, set, params: { sessionId: string; storedMessages: HermesUIMessage[]; now?: number }) => {
    if (params.storedMessages.length === 0) return;
    const now = params.now ?? Date.now();
    set(chatRuntimeBySessionAtom, (state) => {
      const runtime = state[params.sessionId];
      if (!runtime || !isStreamingStatus(runtime.streamStatus)) return state;

      const assistantId = recoverableAssistantId(runtime, params.storedMessages);
      if (!assistantId) return state;

      return {
        ...state,
        [params.sessionId]: {
          ...resetStream(runtime, now),
          messages: runtime.messages.filter((message) => message.id !== assistantId),
          streamStatus: "complete",
          pendingApprovals: [],
          pendingPrompts: [],
          updatedAt: now,
        },
      };
    });
  },
);

export const startPromptAtom = atom(
  null,
  (_get, set, params: { sessionId: string; text: string; images?: ImageEntry[]; now?: number }) => {
    const now = params.now ?? Date.now();
    const assistantId = assistantClientId(now);
    const userParts: HermesMessagePart[] = [];
    if (params.text) userParts.push({ type: "text", text: params.text });
    for (const image of params.images ?? []) {
      const part = imagePartFromSource(image);
      if (part) userParts.push(part);
    }
    set(gwSessionIdAtom, params.sessionId);
    set(chatRuntimeBySessionAtom, (state) =>
      updateSessionRuntime(state, params.sessionId, (runtime) => ({
        ...resetStream(runtime, now),
        interrupted: undefined,
        messages: [
          ...runtime.messages,
          {
            id: userClientId(now),
            sessionId: params.sessionId,
            role: "user",
            createdAt: now,
            status: "complete",
            parts: userParts.length ? userParts : [{ type: "text", text: params.text }],
          },
          {
            id: assistantId,
            sessionId: params.sessionId,
            role: "assistant",
            createdAt: now,
            status: "streaming",
            parts: [{ type: "progress", text: OPTIMISTIC_ASSISTANT_PROGRESS }],
          },
        ],
        streamStatus: "streaming",
        pendingApprovals: [],
        pendingPrompts: [],
        turnStartedAt: now,
        turnFirstTokenAt: undefined,
        activeAssistantId: assistantId,
      })),
    );
  },
);

/** Append a standalone system/notice message to a session — used for client-side
 *  command results (e.g. manual /compress) that aren't part of a model turn. */
export const appendNoticeAtom = atom(
  null,
  (
    _get,
    set,
    params: {
      sessionId: string;
      text: string;
      level?: "info" | "warning" | "error" | "system";
      now?: number;
    },
  ) => {
    const now = params.now ?? Date.now();
    set(chatRuntimeBySessionAtom, (state) =>
      updateSessionRuntime(state, params.sessionId, (runtime) =>
        appendNoticeMessage(runtime, params.sessionId, now, params.text, params.level ?? "system"),
      ),
    );
  },
);

function textForStatsHash(message: HermesUIMessage): string {
  return message.parts
    .flatMap((part) => {
      if (part.type === "text" || part.type === "reasoning") return [part.text];
      if (part.type === "image") return [part.url, part.path, part.name, part.alt].filter(Boolean) as string[];
      if (part.type === "tool") {
        let output = "";
        if (typeof part.output === "string") {
          output = part.output;
        } else if (part.output !== undefined) {
          try {
            output = JSON.stringify(part.output);
          } catch {
            output = String(part.output);
          }
        }
        return [part.name, output];
      }
      return [];
    })
    .join("\n");
}

function latestCompletedAssistant(runtime: ChatSessionRuntime): HermesUIMessage | undefined {
  return [...runtime.messages].reverse().find(
    (message) => message.role === "assistant" && message.status !== "streaming" && message.metadata,
  );
}

function assistantTurnIndex(runtime: ChatSessionRuntime, id: string): number | undefined {
  let index = 0;
  for (const message of runtime.messages) {
    if (message.role !== "assistant") continue;
    index += 1;
    if (message.id === id) return index;
  }
  return undefined;
}

function persistCompletedTurnStats(runtime: ChatSessionRuntime, event: GatewayEvent): void {
  if (event.type !== "message.complete" || !event.session_id) return;
  const message = latestCompletedAssistant(runtime);
  const metadata = message?.metadata;
  if (!message || !metadata) return;

  const persistentSessionId = resolvePersistentSessionId(event.session_id) ?? event.session_id;
  const usage = metadata.usage;
  const timing = metadata.timing;
  const now = Date.now();
  void recordUiTurnStats({
    id: `${persistentSessionId}:${message.id}`,
    sessionId: persistentSessionId,
    gatewaySessionId: event.session_id === persistentSessionId ? undefined : event.session_id,
    clientMessageId: message.id,
    turnIndex: assistantTurnIndex(runtime, message.id),
    contentHash: stableTextHash(textForStatsHash(message)),
    metadata,
    model: metadata.model,
    startedAt: timing?.startedAt,
    firstTokenAt: timing?.firstTokenAt,
    completedAt: timing?.completedAt,
    ttftMs: timing?.ttftMs,
    durationMs: timing?.durationMs,
    tokensInput: usage?.tokensInput,
    tokensOutput: usage?.tokensOutput ?? usage?.tokensCompletion,
    tokensTotal: usage?.tokensTotal,
    cacheRead: usage?.cacheRead,
    cacheWrite: usage?.cacheWrite,
    apiCalls: usage?.apiCalls,
    costUsd: metadata.costUsd ?? undefined,
    costStatus: metadata.costStatus,
    finishReason: metadata.finishReason,
    status: message.status,
    createdAt: now,
  });
}

export const applyGatewayEventAtom = atom(null, (get, set, event: GatewayEvent) => {
  if (!event.session_id) return;
  // 通知决策需要 reduce 前的快照（pendingApprovals / activeAssistantId 是
  // 防重放依据），在 set 之外读取——jotai 不承诺 updater 恰好执行一次。
  // 副作用本身 fire-and-forget，绝不影响 reducer。
  try {
    notifyFromGatewayEvent(event, get(chatRuntimeBySessionAtom)[event.session_id]);
  } catch {}
  set(chatRuntimeBySessionAtom, (state) =>
    updateSessionRuntime(state, event.session_id!, (runtime) => {
      const next = reduceGatewayEvent(runtime, event);
      persistCompletedTurnStats(next, event);
      return next;
    }),
  );
  // Route subagent activity into its own store (issue #238). Self-contained in
  // stores/subagents.ts; chat timeline reduction is untouched.
  set(routeSubagentGatewayEventAtom, event);
  // Route CLI delegation activity (Claude Code / Codex, P-047) the same way.
  set(routeCliDelegationGatewayEventAtom, event);
});

export const setSessionErrorAtom = atom(
  null,
  (_get, set, params: { sessionId: string; message: string }) => {
    const now = Date.now();
    set(chatRuntimeBySessionAtom, (state) =>
      updateSessionRuntime(state, params.sessionId, (runtime) => {
        const erroredActive = runtime.activeAssistantId
          ? updateMessage(runtime, runtime.activeAssistantId, (message) => ({
              ...message,
              status: "error",
              parts: terminateRunningTools(withoutProgressParts(message.parts)),
            }))
          : runtime;
        return {
          ...erroredActive,
          streamStatus: "error",
          statusMessage: params.message,
          statusKind: "error",
          statusUpdatedAt: now,
          activeAssistantId: undefined,
          turnStartedAt: undefined,
          turnFirstTokenAt: undefined,
          updatedAt: now,
        };
      }),
    );
  },
);

function isPersistentErrorNotice(message: HermesUIMessage): boolean {
  return (
    message.role === "system" &&
    message.status === "error" &&
    message.parts.some((part) => part.type === "notice" && part.level === "error")
  );
}

export const drainLiveMessagesAtom = atom(
  null,
  (_get, set, sessionId: string): HermesUIMessage[] => {
    let drained: HermesUIMessage[] = [];
    set(chatRuntimeBySessionAtom, (state) => {
      const rt = state[sessionId];
      if (!rt || rt.messages.length === 0) return state;
      const keep = rt.messages.filter(isPersistentErrorNotice);
      drained = rt.messages.filter((message) => !isPersistentErrorNotice(message));
      if (keep.length === rt.messages.length) return state;
      return {
        ...state,
        [sessionId]: {
          ...rt,
          messages: keep,
        },
      };
    });
    return drained;
  },
);

export const terminateAllStreamsAtom = atom(null, (_get, set) => {
  const now = Date.now();
  set(chatRuntimeBySessionAtom, (state) => {
    let changed = false;
    const next: ChatRuntimeBySession = {};
    for (const [sessionId, rt] of Object.entries(state)) {
      if (rt.streamStatus === "streaming" || rt.streamStatus === "connecting") {
        changed = true;
        const activeId = rt.activeAssistantId;
        const marked = activeId
          ? updateMessage(rt, activeId, (message) => ({
              ...message,
              status: "error",
              parts: terminateRunningTools(withoutProgressParts(message.parts)),
            }))
          : rt;
        next[sessionId] = {
          ...marked,
          streamStatus: "error",
          statusMessage: "连接已断开",
          statusKind: "error",
          statusUpdatedAt: now,
          activeAssistantId: undefined,
          updatedAt: now,
        };
      } else {
        next[sessionId] = rt;
      }
    }
    return changed ? next : state;
  });
});

// Transient counterpart to terminateAllStreamsAtom for a *recoverable* gateway
// drop (sleep/wake, dashboard restart). The backend session survives the socket
// drop, so we must NOT freeze the in-flight turn as a terminal error or clear
// activeAssistantId — otherwise post-reconnect deltas would start a brand-new
// assistant message and the original reply looks lost. Instead we keep the
// message + activeAssistantId intact and show a transient "reconnecting" status;
// once the socket reconnects, session.resume re-pins the live turn and the
// remaining deltas flow onto the SAME message (message.delta flips the status
// back to "streaming"). If the reconnect ultimately fails, the gateway bridge
// calls terminateAllStreams() to surface a real error. See
// docs/gateway-connection-overhaul.md (P0-2).
export const markStreamsReconnectingAtom = atom(null, (_get, set) => {
  const now = Date.now();
  set(chatRuntimeBySessionAtom, (state) => {
    let changed = false;
    const next: ChatRuntimeBySession = {};
    for (const [sessionId, rt] of Object.entries(state)) {
      if (rt.streamStatus === "streaming") {
        changed = true;
        next[sessionId] = {
          ...rt,
          // keep messages + activeAssistantId untouched so the turn can resume
          streamStatus: "connecting",
          statusMessage: "连接中断，正在重连…",
          statusKind: "info",
          statusUpdatedAt: now,
          updatedAt: now,
        };
      } else {
        next[sessionId] = rt;
      }
    }
    return changed ? next : state;
  });
});

export const removeApprovalAtom = atom(
  null,
  (_get, set, params: { sessionId: string; requestId: string }) => {
    set(chatRuntimeBySessionAtom, (state) =>
      updateSessionRuntime(state, params.sessionId, (runtime) =>
        replacePrompts(
          runtime,
          promptsOf(runtime).filter((item) => item.promptId !== params.requestId),
        ),
      ),
    );
  },
);

/**
 * Every unanswered prompt across every session, oldest first. The global
 * prompt layer renders this so a card can pop on any route.
 */
export const pendingPromptsAtom = atom<PendingPrompt[]>((get) => {
  const bySession = get(chatRuntimeBySessionAtom);
  const all: PendingPrompt[] = [];
  for (const runtime of Object.values(bySession)) {
    all.push(...promptsOf(runtime));
  }
  return all.sort((a, b) => a.receivedAt - b.receivedAt);
});

/** Drop a prompt locally (answered elsewhere, timed out, or settled). */
export const removePromptAtom = atom(
  null,
  (_get, set, params: { sessionId: string; promptId: string }) => {
    set(chatRuntimeBySessionAtom, (state) =>
      updateSessionRuntime(state, params.sessionId, (runtime) =>
        replacePrompts(
          runtime,
          promptsOf(runtime).filter((item) => item.promptId !== params.promptId),
        ),
      ),
    );
  },
);

// ── Hydration ────────────────────────────────────────────────────────────────

/**
 * Re-read persisted chat atoms from the UI store's current kvCache.
 *
 * Call this AFTER `initUiStore()` completes to ensure atoms reflect
 * persisted values even if they were created at module-import time
 * before the UI store was initialized.
 *
 * Currently handles:
 * - gwSessionIdAtom: so an in-flight gateway session can be reattached
 *   after page refresh (F5).
 */
export function hydratePersistedChatAtoms(
  store: ReturnType<typeof import("jotai/vanilla")["createStore"]>,
): void {
  // Gateway session ID
  const gwId = readUiValue<string | null | undefined>(GW_SESSION_ID_KEY, undefined);
  if (gwId !== undefined) {
    const current = store.get(gwSessionIdAtom);
    if (current !== gwId) {
      store.set(gwSessionIdAtom, gwId);
    }
  }
}
