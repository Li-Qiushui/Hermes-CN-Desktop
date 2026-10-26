import { atom } from "jotai";
import type {
  GatewayEvent,
  GatewayMessageUsageT,
  HermesMessageMetadata,
  HermesMessagePart,
  HermesUIMessage,
} from "@hermes/protocol";
import type { ConnectionState } from "@/lib/gateway-client";
import { classifyGatewayError } from "@/lib/gateway-result";
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
import { INTERRUPTED_TOOL_ERROR_TEXT, settleStaleRunningToolParts } from "@/lib/stale-tool-parts";
import { isKernelSystemMessageText, translateKernelSystemMessage } from "@/lib/system-message-i18n";
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
  // 当前内核 terminal 工具不产生 progress 帧，tail 暂为预留字段。
  tail?: string;
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
  /**
   * 断流产生的 error notice 及其所属回合（`turnStartedAt` 快照）。只有连接中断
   * 打出来的错误提示会填这两个字段；重连后同一回合的 delta 或 session.resume
   * 成功时，它会被降级成「已自动恢复」的普通提示。真错误（模型/权限/参数）不填，
   * 因此永远不会被吞掉。见 `downgradeRecoveredErrorNotice`。
   */
  recoverableErrorNoticeId?: string;
  recoverableErrorTurnAt?: number;
  /**
   * 连接在回合进行中断掉、但还没有任何终态信号（内核被杀时客户端只会看到 TCP
   * 断开，不会有 error 帧）。这里只做标记，不立刻往时间线塞错误卡：重连成功、
   * resume 告诉我们这一轮到底活没活下来之后，再按结果显示灰卡
   * 「已自动恢复」或「上一轮被中断」。见 `settleDisconnectedTurn`。
   */
  pendingDisconnectNotice?: boolean;
  /** 断线恢复后补过的那张灰卡文案：快照覆盖时间线时会连同它一起被替换掉，
   *  留一份文案让后续 hydrate 能把它补回来（只在同一段视图生命周期内有效，
   *  新回合开始时清空）。 */
  settledDisconnectNotice?: string;
  /**
   * 「重新生成」留下的旧答案：非破坏重试不删旧回答，而是把它登记成同一提问下的
   * 一个旧版本，`activeAssistantId` 指向当前展示的那一版。旧版本行保留在时间线
   * 里（不删数据），渲染时只露出 active 那一版，`‹ N/M ›` 用来切换。
   */
  revisionFamilies?: Record<string, RetryRevisionFamily>;
  /** 重发旧提问时补进来的用户行 id：只作为版本家族的回放，不重复渲染气泡。 */
  replayUserMessageIds?: string[];
  /** 流式错误卡：错误事件把行状态改成 error 之后追加的这张卡（可关、不给重试）。 */
  streamErrorCard?: StreamErrorCard;
  /**
   * 被 Stop 撤回的那些回合：提问原文与撤回时刻。时间线是「已落库的行 + 本地实时行」
   * 合并出来的，本地撤回删掉的只是实时行，库里那条提问（以及内核随后补的英文占位回答）
   * 还在；渲染时按这份记录把它们一起隐藏，直到会话结束。
   */
  withdrawnTurns?: WithdrawnTurn[];
}

/** Stop 撤回的回合记账：按提问原文 + 撤回时刻定位（本地 id 与库里的行 id 不同）。 */
export interface WithdrawnTurn {
  userMessageId: string;
  text: string;
  at: number;
}

/** 一个提问下的一族回答版本；`assistantIds` 按产生顺序排列。 */
export interface RetryRevisionFamily {
  userMessageId: string;
  assistantIds: string[];
  activeAssistantId: string;
}

export type StreamErrorCardKind = "config" | "auth" | "network" | "timeout" | "other";

/** 错误事件追加的那张卡：标题、错误码、已清洗的详情、够不够格跳设置。 */
export interface StreamErrorCard {
  id: string;
  title: string;
  code?: string;
  detail: string;
  kind: StreamErrorCardKind;
  createdAt: number;
}

/** 用户按停止后的两种结局：撤回问题（restore）或保留半截回答（settle）。 */
export type StopOutcome =
  | { kind: "settle" }
  | { kind: "restore"; userMessageId: string; draftText: string };

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

function lastUserMessageIndex(messages: HermesUIMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return index;
  }
  return -1;
}

/** 一条助手消息里有没有"用户能看见的东西"：文本、推理、工具调用、图片。 */
function assistantProducedContent(message: HermesUIMessage): boolean {
  return message.parts.some((part) => {
    if (part.type === "tool") return true;
    if (part.type === "image") return true;
    if (part.type === "text" || part.type === "reasoning") {
      if (isKernelSystemMessageText(part.text)) return false;
      return part.text.trim().length > 0;
    }
    return false;
  });
}

function normalizeTurnText(value: string): string {
  return value.replace(/\s+/g, "");
}

const WITHDRAWN_TURN_LIMIT = 5;
const WITHDRAWN_MATCH_WINDOW_MS = 5_000;

function isWithdrawnReply(message: HermesUIMessage): boolean {
  if (message.role !== "assistant") return false;
  if (message.parts.some((part) => part.type === "tool" || part.type === "image")) return false;
  const text = textFromParts(message.parts) ?? "";
  if (!text.trim()) return true;
  return isKernelSystemMessageText(text);
}

/**
 * 把已落库的消息里属于「被撤回那些回合」的部分剔掉：撤回的那条提问，以及它后面
 * 内核补的空回答 / 英文系统文案。只认撤回时刻附近的同文提问，之后重发的同文提问
 * 不受影响。
 */
export function dropWithdrawnTurnMessages(
  messages: HermesUIMessage[],
  withdrawn: readonly WithdrawnTurn[] | undefined,
): HermesUIMessage[] {
  if (!withdrawn || withdrawn.length === 0) return messages;
  const targets = withdrawn
    .map((entry) => ({ key: normalizeTurnText(entry.text), at: entry.at }))
    .filter((entry) => entry.key.length > 0);
  if (targets.length === 0) return messages;

  const dropped = new Set<number>();
  for (const target of targets) {
    let index = -1;
    for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
      const message = messages[cursor]!;
      if (message.role !== "user") continue;
      if (message.createdAt > target.at + WITHDRAWN_MATCH_WINDOW_MS) continue;
      if (normalizeTurnText(textFromParts(message.parts)) !== target.key) continue;
      index = cursor;
      break;
    }
    if (index < 0) continue;
    dropped.add(index);
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      if (!isWithdrawnReply(messages[cursor]!)) break;
      dropped.add(cursor);
    }
  }
  if (dropped.size === 0) return messages;
  return messages.filter((_, index) => !dropped.has(index));
}

/**
 * Stop 的两结局判定（PI #5 `resolveComposerSmartStop`）：本回合（最后一条用户行之后）
 * 一条可见内容都没产出，就把提问撤回并回填草稿；已经流出来东西就保留并收尾。
 */
export function resolveStopOutcome(runtime: ChatSessionRuntime): StopOutcome {
  const index = lastUserMessageIndex(runtime.messages);
  if (index < 0) return { kind: "settle" };
  const userMessage = runtime.messages[index]!;
  const tail = runtime.messages.slice(index + 1);
  const replyStarted = tail.some(
    (message) => message.role === "assistant" && assistantProducedContent(message),
  );
  if (replyStarted) return { kind: "settle" };
  return {
    kind: "restore",
    userMessageId: userMessage.id,
    draftText: textFromParts(userMessage.parts),
  };
}

/**
 * 保留结局：把正在流的那条就地定格成终态（status 离开 streaming → 气泡尾部的
 * 「思考中」与计时一起消失），running 的工具卡打上「已中断」。
 * 保留 activeAssistantId，迟到的 message.complete 还能富化同一条消息。
 */
function settleStoppedTurn(runtime: ChatSessionRuntime, now: number): ChatSessionRuntime {
  const activeId = runtime.activeAssistantId ??
    [...runtime.messages].reverse().find(
      (message) => message.role === "assistant" && message.status === "streaming",
    )?.id;
  const rooted = activeId
    ? updateMessage(runtime, activeId, (message) => {
      const parts = interruptTurnTools(withoutProgressParts(message.parts), {
        completedAt: now,
      });
      if (parts.length === 0) return null;
      return {
        ...message,
        status: message.status === "streaming" ? "complete" : message.status,
        parts,
      };
    })
    : runtime;
  return {
    ...rooted,
    streamStatus: "idle",
    statusMessage: "",
    statusKind: undefined,
    statusUpdatedAt: undefined,
    activeAssistantId: activeId,
    turnStartedAt: undefined,
    turnFirstTokenAt: undefined,
    interrupted: true,
    updatedAt: now,
  };
}

/** 撤回结局：把这次提问（连同它后面的一切）从时间线里去掉，草稿由调用方回填。 */
function restoreStoppedTurn(
  runtime: ChatSessionRuntime,
  userMessageId: string,
  now: number,
): ChatSessionRuntime {
  const index = runtime.messages.findIndex((message) => message.id === userMessageId);
  const messages = index < 0 ? runtime.messages : runtime.messages.slice(0, index);
  const withdrawnText = index < 0 ? "" : textFromParts(runtime.messages[index]!.parts);
  return {
    ...runtime,
    messages,
    streamStatus: "idle",
    statusMessage: "",
    statusKind: undefined,
    statusUpdatedAt: undefined,
    activeAssistantId: undefined,
    turnStartedAt: undefined,
    turnFirstTokenAt: undefined,
    interrupted: true,
    withdrawnTurns: withdrawnText.trim()
      ? [
        ...(runtime.withdrawnTurns ?? []),
        { userMessageId, text: withdrawnText, at: now },
      ].slice(-WITHDRAWN_TURN_LIMIT)
      : runtime.withdrawnTurns,
    updatedAt: now,
  };
}

const ABORT_ERROR_CODES = new Set([
  "TURN_ABORTED",
  "TURN_ABORT",
  "ABORTED",
  "CANCELLED",
  "CANCELED",
  "INTERRUPTED",
]);

const HTML_BLOCK_PATTERN = /<([a-z]+)[\s\S]{0,8000}?<\/\1>/gi;
const HTTP_BODY_MARKERS = /\b(?:response\s*body|responseBody|raw\s*body|body)\s*[:=]/gi;
const DETAIL_TEXT_LIMIT = 320;
const UNREADABLE_ERROR_DETAIL = "内核返回了无法展示的原始响应，请查看日志或重试。";

function messageFromJsonValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["message", "error_description", "detail", "error", "reason", "msg"]) {
    const nested = record[key];
    if (typeof nested === "string" && nested.trim()) return nested.trim();
    if (nested && typeof nested === "object") {
      const deeper = messageFromJsonValue(nested);
      if (deeper) return deeper;
    }
  }
  return undefined;
}

function stripJsonBlocks(text: string): string {
  let out = "";
  let cursor = 0;
  while (cursor < text.length) {
    const open = text[cursor];
    if (open !== "{" && open !== "[") {
      out += open;
      cursor += 1;
      continue;
    }
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let end = -1;
    for (let index = cursor; index < text.length; index += 1) {
      const ch = text[index];
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end === -1) {
      out += open;
      cursor += 1;
      continue;
    }
    const block = text.slice(cursor, end + 1);
    let readable: string | undefined;
    try {
      readable = messageFromJsonValue(JSON.parse(block));
    } catch {
      readable = undefined;
    }
    out += readable ? ` ${readable} ` : " ";
    cursor = end + 1;
  }
  return out;
}

/**
 * 错误详情只留人能读的那部分：原始 HTTP 响应体、JSON 报文、HTML 都不进气泡。
 * 认不出的就退化成一句固定说明，绝不把内核原文糊到用户脸上。
 */
export function sanitizeErrorDetail(raw: string): string {
  let text = (raw ?? "").replace(/\r\n?/g, " ");
  text = text.replace(HTML_BLOCK_PATTERN, " ");
  text = text.replace(HTTP_BODY_MARKERS, " ");
  text = stripJsonBlocks(text);
  text = text.replace(/<[^<>]{1,400}>/g, " ");
  text = text.replace(/[{}[\]]/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return UNREADABLE_ERROR_DETAIL;
  if (text.length > DETAIL_TEXT_LIMIT) text = `${text.slice(0, DETAIL_TEXT_LIMIT)}…`;
  return text;
}

export function isAbortErrorPayload(payload: Record<string, any>): boolean {
  for (const key of ["code", "error_code", "reason", "status", "type"] as const) {
    const value = payload[key];
    if (typeof value === "string" && ABORT_ERROR_CODES.has(value.trim().toUpperCase())) return true;
  }
  const text = pickErrorText(payload, "");
  return /\baborted by (?:the )?user\b|user (?:aborted|cancell?ed)|已(?:被)?(?:用户)?中断/i.test(text);
}

function streamErrorCardKind(text: string, code: string | undefined): StreamErrorCardKind {
  const upper = (code ?? "").toUpperCase();
  if (
    upper === "MODEL_NOT_CONFIGURED" ||
    upper === "PROVIDER_SECRET_MISSING" ||
    upper === "PROVIDER_UNAUTHORIZED"
  ) {
    return "config";
  }
  const info = classifyGatewayError(text);
  if (info.kind === "auth") return "auth";
  if (info.kind === "network") return "network";
  if (info.kind === "timeout") return "timeout";
  if (/未配置|没有配置|not configured|missing (?:api )?key|secret missing|请先配置/i.test(text)) {
    return "config";
  }
  return "other";
}

const STREAM_ERROR_CARD_TITLES: Record<StreamErrorCardKind, string> = {
  config: "模型还没配置好",
  auth: "登录凭证失效",
  network: "与内核的连接断开",
  timeout: "请求超时",
  other: "响应失败",
};

function buildStreamErrorCard(payload: Record<string, any>, now: number): StreamErrorCard {
  const raw = pickErrorText(payload, GENERIC_TURN_FAILURE_TEXT);
  const code = typeof payload.code === "string" && payload.code.trim()
    ? payload.code.trim()
    : typeof payload.error_code === "string" && payload.error_code.trim()
      ? payload.error_code.trim()
      : undefined;
  const kind = streamErrorCardKind(raw, code);
  return {
    id: `live-error-card-${now}`,
    title: STREAM_ERROR_CARD_TITLES[kind],
    ...(code ? { code } : {}),
    detail: sanitizeErrorDetail(raw),
    kind,
    createdAt: now,
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

interface TerminateToolsOptions {
  interrupted?: boolean;
  completedAt?: number;
}

function terminateRunningTools(
  parts: HermesMessagePart[],
  options: TerminateToolsOptions = {},
): HermesMessagePart[] {
  let changed = false;
  const next = parts.map((part) => {
    if (part.type !== "tool" || part.state !== "running") return part;
    changed = true;
    return {
      ...part,
      state: "error" as const,
      errorText: options.interrupted ? part.errorText ?? INTERRUPTED_TOOL_ERROR_TEXT : part.errorText,
      completedAt: options.interrupted ? part.completedAt ?? options.completedAt : part.completedAt,
    };
  });
  return changed ? next : parts;
}

/**
 * 中断收尾用：这一回合被用户掐掉时，**已经跑完的工具**同样属于「被打断的一轮」，
 * 只给 running 打标记会让三张卡看起来都正常收尾。已结束的卡保留结果，只补中断标记。
 */
function interruptTurnTools(
  parts: HermesMessagePart[],
  options: { completedAt?: number } = {},
): HermesMessagePart[] {
  let changed = false;
  const next = parts.map((part) => {
    if (part.type !== "tool") return part;
    if (part.state === "running") {
      changed = true;
      return {
        ...part,
        state: "error" as const,
        errorText: part.errorText ?? INTERRUPTED_TOOL_ERROR_TEXT,
        completedAt: part.completedAt ?? options.completedAt,
      };
    }
    if (part.errorText === INTERRUPTED_TOOL_ERROR_TEXT) return part;
    changed = true;
    return { ...part, state: "error" as const, errorText: INTERRUPTED_TOOL_ERROR_TEXT };
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

const TOOL_TAIL_MAX_CHARS = 16 * 1024;

function toolProgressChunk(payload: Record<string, any>): string | undefined {
  for (const key of ["message", "delta", "text"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function appendToolTail(previous: string | undefined, chunk: string): string {
  const merged = previous ? `${previous}\n${chunk}` : chunk;
  if (merged.length <= TOOL_TAIL_MAX_CHARS) return merged;
  const window = merged.slice(merged.length - TOOL_TAIL_MAX_CHARS);
  const lineStart = window.indexOf("\n");
  return lineStart >= 0 ? window.slice(lineStart + 1) : window;
}

function findToolTailIndex(parts: HermesMessagePart[], payload: Record<string, any>): number {
  const toolId = typeof payload.tool_id === "string" ? payload.tool_id : "";
  if (toolId) {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const part = parts[index]!;
      if (part.type === "tool" && part.toolCallId === toolId) return index;
    }
    return -1;
  }
  const name = [payload.name, payload.tool_name].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (!name) return -1;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]!;
    if (part.type === "tool" && part.state === "running" && part.name === name) return index;
  }
  return -1;
}

function assistantOwningToolPart(
  runtime: ChatSessionRuntime,
  payload: Record<string, any>,
): string | undefined {
  const toolId = typeof payload.tool_id === "string" ? payload.tool_id : "";
  if (!toolId) return undefined;
  for (let index = runtime.messages.length - 1; index >= 0; index -= 1) {
    const message = runtime.messages[index]!;
    if (message.role !== "assistant") continue;
    if (message.parts.some((part) => part.type === "tool" && part.toolCallId === toolId)) {
      return message.id;
    }
  }
  return undefined;
}

function payloadToolName(payload: Record<string, any>): string {
  for (const key of ["name", "tool_name", "tool"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function findToolMatch(tool: HermesToolPart, payload: Record<string, any>): boolean {
  if (payload.tool_id) return tool.toolCallId === payload.tool_id;
  const name = payloadToolName(payload);
  if (!name) return false;
  return tool.state === "running" && tool.name === name;
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

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (value && typeof value === "object") {
    try {
      const encoded = JSON.stringify(value);
      return encoded && encoded !== "{}" ? encoded : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// 内核 tool.complete 的 payload 是 { tool_id, name, context, args, is_error, result }
// （gateway/run_turn_progress.py 的 _tool_complete_payload），没有 summary/output 这种字段；
// 早期 CN 内核才发 summary。只认 summary 会把所有工具结果读成空，卡片全部显示「无输出」。
function toolCompleteOutput(payload: Record<string, any>, previous: unknown): unknown {
  const diff = nonEmptyString(payload.inline_diff);
  if (diff) return diff;
  return (
    nonEmptyString(payload.result_text) ??
    nonEmptyString(payload.result) ??
    nonEmptyString(payload.summary) ??
    nonEmptyString(payload.output) ??
    previous
  );
}

function completeToolPart(tool: HermesToolPart, payload: Record<string, any>, now: number): HermesToolPart {
  const duration = payload.duration_s;
  const completedAt =
    typeof duration === "number" && Number.isFinite(duration) && duration >= 0 && tool.startedAt
      ? tool.startedAt + duration * 1000
      : now;
  const output = toolCompleteOutput(payload, tool.output);
  const isError = payload.is_error === true || Boolean(payload.error);
  const errorText = isError
    ? nonEmptyString(payload.error) ?? nonEmptyString(payload.result) ?? nonEmptyString(payload.summary)
    : undefined;
  const name = tool.name || payloadToolName(payload);

  return {
    ...tool,
    name,
    state: isError ? "error" : "done",
    output,
    tail: tool.tail,
    errorText,
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

const AUTO_RECOVERED_NOTICE_TEXT = "连接中断，已自动恢复，本轮输出继续";
const INTERRUPTED_RECOVERED_NOTICE_TEXT = "连接已恢复，但上一轮已被中断，输出可能不完整";
const AUTO_CONTINUED_NOTICE_TEXT = "内核已自动续跑被中断的本轮，已执行的命令可能重复";
const DISCONNECTED_STATUS_TEXT = "连接中断，正在重连…";

function markActiveTurnFailed(
  runtime: ChatSessionRuntime,
  now: number,
  aborted = false,
): ChatSessionRuntime {
  const id = runtime.activeAssistantId;
  if (!id) return runtime;
  return updateMessage(runtime, id, (message) => {
    const parts = terminateRunningTools(withoutProgressParts(message.parts), {
      interrupted: aborted,
      completedAt: now,
    });
    if (aborted && parts.length === 0) return null;
    return {
      ...message,
      status: aborted ? "complete" : "error",
      parts,
    };
  });
}

interface CloseTurnWithErrorOptions {
  statusMessage?: string;
  notice?: string;
  /** 断流错误：记下提示 id + 回合，等恢复信号把它降级。 */
  recoverable?: boolean;
  /** 用户主动中断（TURN_ABORTED）：半截回答保留，别打成「请求失败」。 */
  aborted?: boolean;
}

function closeTurnWithError(
  runtime: ChatSessionRuntime,
  sessionId: string,
  now: number,
  options: CloseTurnWithErrorOptions = {},
): ChatSessionRuntime {
  const failed = markActiveTurnFailed(runtime, now, options.aborted === true);
  const noticed = options.notice
    ? appendNoticeMessage(failed, sessionId, now, options.notice, "error")
    : failed;
  const recoverable = options.recoverable === true && runtime.turnStartedAt !== undefined;
  return {
    ...noticed,
    streamStatus: "error",
    statusMessage: options.statusMessage ?? runtime.statusMessage,
    statusKind: "error",
    statusUpdatedAt: now,
    activeAssistantId: undefined,
    recoverableErrorNoticeId: recoverable ? systemClientId(now) : undefined,
    recoverableErrorTurnAt: recoverable ? runtime.turnStartedAt : undefined,
    pendingDisconnectNotice: undefined,
    settledDisconnectNotice: undefined,
    updatedAt: now,
  };
}

// 断流提示的撤回：把那条 error notice 换成同一位置的灰色说明，而不是直接删掉。
// 保留一条「已自动恢复」既解释了回答中途停顿的原因，又因为不再是 error notice
// 而自动掉出 drainLiveMessages 的持久错误集合，重载后不会阴魂不散。
function downgradeRecoveredErrorNotice(
  runtime: ChatSessionRuntime,
  now: number,
  text: string = AUTO_RECOVERED_NOTICE_TEXT,
): ChatSessionRuntime {
  const noticeId = runtime.recoverableErrorNoticeId;
  if (!noticeId) return runtime;
  return {
    ...runtime,
    messages: runtime.messages.map((message) =>
      message.id === noticeId
        ? {
            ...message,
            status: "complete",
            parts: message.parts.map((part) =>
              part.type === "notice"
                ? { ...part, level: "info" as const, text }
                : part,
            ),
          }
        : message,
    ),
    recoverableErrorNoticeId: undefined,
    recoverableErrorTurnAt: undefined,
    updatedAt: now,
  };
}

function settleRunningToolsOutsideTurn(runtime: ChatSessionRuntime): ChatSessionRuntime {
  const messages = settleStaleRunningToolParts(runtime.messages, {
    turnActive: true,
    turnStartedAt: runtime.turnStartedAt,
  });
  return messages === runtime.messages ? runtime : { ...runtime, messages };
}

/**
 * 回合已经不在跑了（resume 的 `running === false`）：快照里那些没有 tool 结果、
 * 还挂在 running 的 part 再也等不到 tool.complete，就地标成中断（复用现有的
 * error 态，与 Esc 停止一致），并清掉活跃回合指针 —— 计时器随之停摆。
 * part 仍保留 toolCallId，迟到/补发的 tool.complete 照旧能按 id 覆盖回完成态。
 */
function convergeInterruptedTurn(
  runtime: ChatSessionRuntime,
  now: number,
): ChatSessionRuntime {
  return {
    ...runtime,
    messages: settleStaleRunningToolParts(runtime.messages, { turnActive: false }),
    streamStatus: "idle",
    statusMessage: "",
    statusKind: undefined,
    statusUpdatedAt: undefined,
    activeAssistantId: undefined,
    turnStartedAt: undefined,
    turnFirstTokenAt: undefined,
    interrupted: undefined,
    updatedAt: now,
  };
}

/**
 * 断线标记的收尾：内核被杀时客户端只拿到 TCP 断开，泳道里既没有 `error` 帧也
 * 没有 `gateway.disconnected` 帧（后者是本端合成的），所以提示只能在重连成功、
 * 知道这一轮活没活下来之后再补。resumed=true 说明回合还在跑（同一个气泡继续接
 * 输出），false 说明回合已经断了，两张都是灰卡，不再冒充错误。
 */
function settleDisconnectedTurn(
  runtime: ChatSessionRuntime,
  sessionId: string,
  now: number,
  resumed: boolean,
): ChatSessionRuntime {
  const knowsNotice = runtime.pendingDisconnectNotice || runtime.settledDisconnectNotice !== undefined;
  if (!knowsNotice) return runtime;
  const text = runtime.settledDisconnectNotice ??
    (resumed ? AUTO_RECOVERED_NOTICE_TEXT : INTERRUPTED_RECOVERED_NOTICE_TEXT);
  const cleared: ChatSessionRuntime = {
    ...runtime,
    pendingDisconnectNotice: undefined,
    settledDisconnectNotice: text,
    updatedAt: now,
  };
  if (hasNoticeText(cleared.messages, text)) return cleared;
  if (cleared.recoverableErrorNoticeId) {
    return downgradeRecoveredErrorNotice(cleared, now, text);
  }
  return appendNoticeMessage(cleared, sessionId, now, text, "info");
}

function hasNoticeText(messages: HermesUIMessage[], text: string): boolean {
  return messages.some((message) =>
    message.parts.some((part) => part.type === "notice" && part.text === text),
  );
}

// 内核在 session.resume 的冷路径上会把被进程死亡打断的回合自动重跑一遍
// （`auto_continue` 字段），重跑会连同已经执行过的工具调用一起再做一次。客户端
// 拦不住这个行为，只能留一条中性灰卡说明风险。提示按文案在整条时间线上去重：
// 快照覆盖、重连风暴、用户已经发出下一轮这几种时序下都只会有一条。
function hasAutoContinuedNotice(messages: HermesUIMessage[]): boolean {
  return hasNoticeText(messages, AUTO_CONTINUED_NOTICE_TEXT);
}

function noteAutoContinuedTurn(
  runtime: ChatSessionRuntime,
  sessionId: string,
  now: number,
): ChatSessionRuntime {
  if (hasAutoContinuedNotice(runtime.messages)) return runtime;
  return appendNoticeMessage(runtime, sessionId, now, AUTO_CONTINUED_NOTICE_TEXT, "info");
}

/**
 * resume 返回了 `auto_continue`：内核已经/即将重跑被打断的这一轮，补一张灰卡。
 * `autoContinue` 不是 `true` 时整个 atom 是空操作，重连路径之外没人调它。
 */
export const noteAutoContinuedTurnAtom = atom(
  null,
  (_get, set, params: { sessionId: string; autoContinue?: boolean }) => {
    if (params.autoContinue !== true) return;
    const now = Date.now();
    set(chatRuntimeBySessionAtom, (state) =>
      updateSessionRuntime(state, params.sessionId, (runtime) =>
        noteAutoContinuedTurn(runtime, params.sessionId, now),
      ),
    );
  },
);

/**
 * resume 成功后的接管：内核重启会给同一个持久会话发**新的运行时 session_id**，
 * 断线时打在旧 id 名下的 `pendingDisconnectNotice` 就此失联（UI 只看新 id 的
 * runtime，hydrate 又在空 runtime 上 settle，于是灰卡永远不出现）。这里把断线
 * 状态搬到新 id 名下，就地收尾（补灰卡 / 收敛幽灵工具），顺带补自动续跑提示。
 *
 * 收尾不能只挂在 hydrate 上：补帧成功（replay "skipped"）时根本不会 hydrate。
 */
export const adoptResumedSessionAtom = atom(
  null,
  (
    _get,
    set,
    params: {
      toSessionId: string;
      fromSessionId?: string;
      running?: boolean;
      autoContinue?: boolean;
      resumedAt?: number;
    },
  ) => {
    const now = Date.now();
    const running = params.running === true;
    set(chatRuntimeBySessionAtom, (state) => {
      const source =
        params.fromSessionId && params.fromSessionId !== params.toSessionId
          ? state[params.fromSessionId]
          : undefined;
      const carriesDisconnectState =
        source !== undefined &&
        (source.pendingDisconnectNotice === true ||
          source.settledDisconnectNotice !== undefined);
      const next: ChatRuntimeBySession = { ...state };
      let target = state[params.toSessionId] ?? createEmptyChatRuntime();
      if (carriesDisconnectState && source && params.fromSessionId) {
        next[params.fromSessionId] = {
          ...source,
          pendingDisconnectNotice: undefined,
          settledDisconnectNotice: undefined,
        };
        target = {
          ...target,
          pendingDisconnectNotice: source.pendingDisconnectNotice,
          settledDisconnectNotice: source.settledDisconnectNotice,
        };
      }
      const restarted =
        params.autoContinue === true ||
        (source !== undefined &&
          source.pendingDisconnectNotice === true &&
          params.fromSessionId !== params.toSessionId);
      if (restarted) target = { ...target, turnStartedAt: params.resumedAt ?? now };
      const settled =
        params.autoContinue === true
          ? { ...target, pendingDisconnectNotice: undefined }
          : settleDisconnectedTurn(target, params.toSessionId, now, running);
      const noted =
        params.autoContinue === true
          ? noteAutoContinuedTurn(settled, params.toSessionId, now)
          : settled;
      next[params.toSessionId] = running
        ? settleRunningToolsOutsideTurn(noted)
        : convergeInterruptedTurn(noted, now);
      return next;
    });
  },
);

function hasRecoverableNoticeOfCurrentTurn(runtime: ChatSessionRuntime): boolean {
  return (
    runtime.recoverableErrorNoticeId !== undefined &&
    runtime.recoverableErrorTurnAt !== undefined &&
    runtime.recoverableErrorTurnAt === runtime.turnStartedAt
  );
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
  const parts = withoutProgressParts(message.parts);
  const finalText = typeof payload.text === "string" ? payload.text : "";
  const finalReasoning = normalizeReasoningText(
    typeof payload.reasoning === "string" ? payload.reasoning : "",
  );

  // 内核把「这一轮被掐断」写成英文系统文案塞进 final_response。它不是模型正文：
  // 有正文就留着正文、只在末尾补一句中文；没正文时原样留在 store 里 —— 「这一轮有没有
  // 产出」的判定要靠它认出空回合，展示层（message-adapter）再统一换成中文短句。
  const systemCopy = finalText ? translateKernelSystemMessage(finalText) : null;
  if (systemCopy) {
    const visible = parts.some(
      (part) =>
        (part.type === "text" && !isKernelSystemMessageText(part.text) && part.text.trim().length > 0) ||
        part.type === "reasoning" ||
        part.type === "tool",
    );
    return visible ? appendTextPart(parts, `\n\n${systemCopy.text}`) : [{ type: "text", text: finalText }];
  }

  let merged = mergeFinalTextPart(parts, finalText);
  if (finalReasoning) {
    merged = collapseReasoningParts(merged, finalReasoning);
  }
  return appendImageParts(merged, imagePartsFromPayload(payload));
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
    if (
      event.type === "message.complete" &&
      !runtime.messages.some(
        (message) => message.id === runtime.activeAssistantId || message.status === "streaming",
      )
    ) {
      // 撤回结局之后已经没有可收尾的气泡了：迟到的 message.complete 不能凭空
      // 造出新的回答行（内核会给空回合补一句英文「请求未被执行」，那条也不该回来）。
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
      // 同一回合的输出又流起来了：断流时打的那条「请求失败」不再是事实。
      const base = hasRecoverableNoticeOfCurrentTurn(runtime)
        ? downgradeRecoveredErrorNotice(runtime, now)
        : runtime;
      const id = activeAssistantId(base, now);
      const next = updateActiveAssistant(
        clearProviderStatus({
          ...base,
          streamStatus: "streaming",
          activeAssistantId: id,
          turnStartedAt: base.turnStartedAt ?? now,
          turnFirstTokenAt: base.turnFirstTokenAt ?? (text ? now : base.turnFirstTokenAt),
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
        name: payloadToolName(payload),
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

    case "tool.progress": {
      // 当前内核 terminal 工具不产生 progress 帧，这里仅做预留累积，UI 不再展示。
      const chunk = toolProgressChunk(payload);
      const id = runtime.activeAssistantId;
      if (!chunk || !id) return runtime;
      const message = runtime.messages.find((item) => item.id === id);
      if (!message) return runtime;
      const index = findToolTailIndex(message.parts, payload);
      if (index === -1) return runtime;
      const part = message.parts[index]!;
      if (part.type !== "tool") return runtime;
      const parts = message.parts.slice();
      parts[index] = { ...part, tail: appendToolTail(part.tail, chunk) };
      return {
        ...runtime,
        messages: runtime.messages.map((item) => (item.id === id ? { ...message, parts } : item)),
        updatedAt: now,
      };
    }

    case "tool.complete": {
      // 回合已经收敛成非活跃态（例如断线被标为中断）后，迟到/补发的完整
      // tool.complete 仍然要能落回原来那张卡：按 tool_id 找到持有它的消息就地
      // 更新，不新建气泡、也不把已完成的气泡改回 streaming。
      const ownerId = assistantOwningToolPart(runtime, payload);
      if (ownerId && ownerId !== runtime.activeAssistantId) {
        return {
          ...clearProviderStatus({ ...runtime, updatedAt: now }),
          messages: runtime.messages.map((message) =>
            message.id === ownerId
              ? {
                  ...message,
                  parts: updateToolParts(message.parts, payload, (tool) =>
                    completeToolPart(tool, payload, now),
                  ),
                }
              : message,
          ),
        };
      }
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
      const aborted = isAbortErrorPayload(payload);
      // 「连接中断」过程中内核报的错是可以自愈的：markStreamsReconnecting 已把
      // streamStatus 压成 connecting，此时到达的 error 属于断流，重连成功后
      // 出的 delta 会把它降级成普通提示。其余错误原样保留。
      const recoverable = runtime.streamStatus === "connecting";
      const closed = closeTurnWithError(runtime, sessionId, now, {
        statusMessage: sanitizeErrorDetail(text),
        notice: recoverable ? text : undefined,
        recoverable,
        aborted,
      });
      // 真错误才补卡片：断流（可自愈）与用户中断都不该多一张卡。卡片只放在
      // runtime 里，由详情页渲染（详情默认展开、可关、不给重试）。
      const alreadyNoticed = closed.messages.some(
        (message) => message.role === "system" && message.status === "error",
      );
      const card = aborted || recoverable || alreadyNoticed
        ? undefined
        : buildStreamErrorCard(payload, now);
      return {
        ...closed,
        interrupted: undefined,
        streamErrorCard: card ?? closed.streamErrorCard,
      };
    }

    case "gateway.disconnected": {
      if (!isStreamingStatus(runtime.streamStatus)) return runtime;
      return closeTurnWithError(runtime, sessionId, now, {
        statusMessage: "连接已断开",
      });
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
  (
    _get,
    set,
    params: {
      sessionId: string;
      messages: HermesUIMessage[];
      running?: boolean;
      autoContinue?: boolean;
      turnStartedAt?: number;
    },
  ) => {
    const now = Date.now();
    const running = params.running === true;
    set(chatRuntimeBySessionAtom, (state) =>
      updateSessionRuntime(state, params.sessionId, (runtime) => {
        const live = running ? liveTurnAssistant(runtime) : undefined;
        const reconciled = live ? foldSnapshotTurnIntoLive(live, params.messages, runtime) : undefined;
        const turnStart = running
          ? Math.max(
            params.turnStartedAt ?? Number.NEGATIVE_INFINITY,
            runtime.turnStartedAt ?? Number.NEGATIVE_INFINITY,
          )
          : Number.NEGATIVE_INFINITY;
        const hydrated: ChatSessionRuntime = {
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
          turnStartedAt: Number.isFinite(turnStart) ? turnStart : undefined,
          interrupted: false,
          updatedAt: now,
          lastActivityAt: now,
        };
        // 断线恢复的收尾放在同一次 hydrate 里：先按「这一轮活没活下来」补灰卡，
        // 再把已经不可能收到 tool.complete 的 running part 收敛成中断态。
        const settled = settleDisconnectedTurn(hydrated, params.sessionId, now, running);
        // 快照覆盖会把上一轮补的提示一起换掉，所以 auto_continue 在这里也要补一次
        // （同一回合按文案去重，重连风暴里不会叠成两条）。
        const noted =
          params.autoContinue === true
            ? noteAutoContinuedTurn(settled, params.sessionId, now)
            : settled;
        return running
          ? settleRunningToolsOutsideTurn(noted)
          : convergeInterruptedTurn(noted, now);
      }),
    );
  },
);

// 手动终止的「保留」结局：当场定格正在流的那条（status 离开 streaming，气泡尾部的
// 「思考中」和计时一起消失），running 的工具卡打上「已中断」，同一帧内收尾 —— 不再
// 等迟到的 message.complete。保留 activeAssistantId，迟到的 message.complete 只会
// 富化同一条消息，不会再造一个新气泡。
export const markSessionInterruptedAtom = atom(null, (_get, set, sessionId: string) => {
  const now = Date.now();
  set(chatRuntimeBySessionAtom, (state) =>
    updateSessionRuntime(state, sessionId, (runtime) => settleStoppedTurn(runtime, now)),
  );
});

/**
 * Stop 的落地入口：`restore` 把这次提问（以及它后面的一切）从时间线里去掉，
 * 草稿由调用方回填输入框；`settle` 走 {@link markSessionInterruptedAtom} 的同一套收尾。
 */
export const stopTurnAtom = atom(
  null,
  (
    _get,
    set,
    params: { sessionId: string; outcome: StopOutcome; now?: number },
  ) => {
    const now = params.now ?? Date.now();
    set(chatRuntimeBySessionAtom, (state) =>
      updateSessionRuntime(state, params.sessionId, (runtime) =>
        params.outcome.kind === "restore"
          ? restoreStoppedTurn(runtime, params.outcome.userMessageId, now)
          : settleStoppedTurn(runtime, now),
      ),
    );
  },
);

/**
 * 「重新生成」的第一步：把这条回答登记成所属提问的一个版本（旧版本不删），
 * 随后的重发会补进新版本。
 */
export const beginRevisionRetryAtom = atom(
  null,
  (
    _get,
    set,
    params: { sessionId: string; userMessageId: string; previousAssistantId?: string },
  ) => {
    const now = Date.now();
    set(chatRuntimeBySessionAtom, (state) =>
      updateSessionRuntime(state, params.sessionId, (runtime) => {
        const families = { ...(runtime.revisionFamilies ?? {}) };
        const previous = families[params.userMessageId];
        const base: RetryRevisionFamily = previous ?? {
          userMessageId: params.userMessageId,
          assistantIds: [],
          activeAssistantId: "",
        };
        const assistantIds =
          params.previousAssistantId && !base.assistantIds.includes(params.previousAssistantId)
            ? [...base.assistantIds, params.previousAssistantId]
            : base.assistantIds;
        families[params.userMessageId] = {
          ...base,
          assistantIds,
          activeAssistantId: base.activeAssistantId || params.previousAssistantId || "",
        };
        return { ...runtime, revisionFamilies: families, updatedAt: now };
      }),
    );
  },
);

/**
 * 「重新生成」的第二步（重发成功后）：把刚落地的重发用户行标成回放（不再重复
 * 渲染气泡），并把新回答挂成这一族的最新版本。
 */
export const finalizeRevisionRetryAtom = atom(
  null,
  (_get, set, params: { sessionId: string; userMessageId: string }) => {
    const now = Date.now();
    set(chatRuntimeBySessionAtom, (state) =>
      updateSessionRuntime(state, params.sessionId, (runtime) => {
        const family = runtime.revisionFamilies?.[params.userMessageId];
        if (!family) return runtime;
        let replayUserId: string | undefined;
        for (let index = runtime.messages.length - 1; index >= 0; index -= 1) {
          const message = runtime.messages[index]!;
          if (message.role === "user" && message.id !== params.userMessageId) {
            replayUserId = message.id;
            break;
          }
        }
        if (!replayUserId) return runtime;
        const replayIndex = runtime.messages.findIndex((message) => message.id === replayUserId);
        const nextAssistant = runtime.messages
          .slice(replayIndex + 1)
          .find((message) => message.role === "assistant");
        const assistantId = runtime.activeAssistantId ?? nextAssistant?.id;
        if (!assistantId) return runtime;
        const assistantIds = family.assistantIds.includes(assistantId)
          ? family.assistantIds
          : [...family.assistantIds, assistantId];
        const replayIds = runtime.replayUserMessageIds ?? [];
        return {
          ...runtime,
          revisionFamilies: {
            ...runtime.revisionFamilies,
            [params.userMessageId]: { ...family, assistantIds, activeAssistantId: assistantId },
          },
          replayUserMessageIds: replayIds.includes(replayUserId)
            ? replayIds
            : [...replayIds, replayUserId],
          updatedAt: now,
        };
      }),
    );
  },
);

/** 版本翻页：只切展示，不动任何数据。 */
export const activateRevisionAtom = atom(
  null,
  (
    _get,
    set,
    params: { sessionId: string; userMessageId: string; assistantMessageId: string },
  ) => {
    const now = Date.now();
    set(chatRuntimeBySessionAtom, (state) =>
      updateSessionRuntime(state, params.sessionId, (runtime) => {
        const family = runtime.revisionFamilies?.[params.userMessageId];
        if (!family || !family.assistantIds.includes(params.assistantMessageId)) return runtime;
        return {
          ...runtime,
          revisionFamilies: {
            ...runtime.revisionFamilies,
            [params.userMessageId]: { ...family, activeAssistantId: params.assistantMessageId },
          },
          updatedAt: now,
        };
      }),
    );
  },
);

/** 关掉错误卡（卡上只有关闭，没有重试）。 */
export const dismissStreamErrorCardAtom = atom(null, (_get, set, sessionId: string) => {
  const now = Date.now();
  set(chatRuntimeBySessionAtom, (state) => {
    const runtime = state[sessionId];
    if (!runtime?.streamErrorCard) return state;
    return {
      ...state,
      [sessionId]: { ...runtime, streamErrorCard: undefined, updatedAt: now },
    };
  });
});

/** 渲染用：被版本家族隐藏的行（非 active 的旧答案 + 回放用户行）。 */
export function revisionHiddenMessageIds(runtime: ChatSessionRuntime): Set<string> {
  const hidden = new Set<string>(runtime.replayUserMessageIds ?? []);
  for (const family of Object.values(runtime.revisionFamilies ?? {})) {
    for (const id of family.assistantIds) {
      if (id !== family.activeAssistantId) hidden.add(id);
    }
  }
  return hidden;
}

/** 最近一次「重新生成」的那一族（翻页器只挂在它上面）。 */
export function latestRevisionFamily(runtime: ChatSessionRuntime): RetryRevisionFamily | undefined {
  const families = Object.values(runtime.revisionFamilies ?? {});
  if (families.length === 0) return undefined;
  return families.reduce((latest, family) =>
    family.assistantIds.length >= latest.assistantIds.length ? family : latest,
  );
}

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
        // 新回合开始：上一轮断流提示不再可能被「恢复」，撤回指针就地作废，
        // 它保持 error 原样留在时间线里。
        recoverableErrorNoticeId: undefined,
        recoverableErrorTurnAt: undefined,
        pendingDisconnectNotice: undefined,
        settledDisconnectNotice: undefined,
        streamErrorCard: undefined,
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
      updateSessionRuntime(state, params.sessionId, (runtime) => ({
        ...closeTurnWithError(runtime, params.sessionId, now, {
          statusMessage: params.message,
        }),
        turnStartedAt: undefined,
        turnFirstTokenAt: undefined,
      })),
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

/** session.resume 成功后调用：把断流时打的「请求失败」降级成「已自动恢复」。
 *  只有带 recoverable 标记（即断流期间产生的）错误提示会被处理。 */
export const settleRecoveredStreamErrorAtom = atom(null, (_get, set, sessionId: string) => {
  set(chatRuntimeBySessionAtom, (state) => {
    const runtime = state[sessionId];
    if (!runtime || !runtime.recoverableErrorNoticeId) return state;
    return { ...state, [sessionId]: downgradeRecoveredErrorNotice(runtime, Date.now()) };
  });
});

export const terminateAllStreamsAtom = atom(null, (_get, set) => {
  const now = Date.now();
  set(chatRuntimeBySessionAtom, (state) => {
    let changed = false;
    const next: ChatRuntimeBySession = {};
    for (const [sessionId, rt] of Object.entries(state)) {
      if (rt.streamStatus === "streaming" || rt.streamStatus === "connecting") {
        changed = true;
        next[sessionId] = closeTurnWithError(rt, sessionId, now, {
          statusMessage: "连接已断开",
        });
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
      if (rt.streamStatus !== "streaming" && rt.streamStatus !== "connecting") {
        next[sessionId] = rt;
        continue;
      }
      changed = true;
      next[sessionId] = {
        ...rt,
        // keep messages + activeAssistantId untouched so the turn can resume
        streamStatus: "connecting",
        statusMessage: DISCONNECTED_STATUS_TEXT,
        statusKind: "info",
        statusUpdatedAt: now,
        pendingDisconnectNotice: true,
        updatedAt: now,
      };
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
