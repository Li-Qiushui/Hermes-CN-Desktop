import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, WheelEvent } from "react";
import { useAtomValue } from "jotai";
import { AlertTriangle, ArrowDown, Bot, ChevronRight, FileDiff, Info, Pencil, RotateCcw, Trash2, Volume2, VolumeX } from "lucide-react";
import { LoadingIndicator } from "@hermes/shared-ui";
import { assistantAvatarEffectiveAtom, assistantDisplayNameAtom, showReasoningAtom } from "@/stores/ui";
import type { AssistantMessageStats, ChatMessage, ChatToolItem } from "./chat-types";
import { AssistantProfileCard } from "./assistant-profile-card";
import { CliDelegationCard, entryFromChatTool } from "./cli-delegation-card";
import { DelegateRunCard } from "./delegate-run-card";
import { isDelegateToolName } from "./delegate-run-model";
import { useInlinePromptAnchor } from "./inline-prompt-flow";
import { cliDelegationsByToolIdAtom } from "@/stores/cli-delegations";
import { MessageImage } from "./message-image";
import { MessageSkeleton } from "./message-skeleton";
import { MessageText } from "./message-text";
import { SkillInvocationMessage } from "./skill-invocation-message";
import { CopyButton } from "@/components/ui/copy-button";
import { ToolResultCard } from "./tool-result-card";
import {
  FindBar,
  clearFindHighlights,
  collectFindMatches,
  highlightFindMatches,
  type FindMatch,
} from "./find-in-conversation";
import { ErrorRecoveryActions, resolveErrorDisplayText } from "./error-recovery-actions";
import { buildToolResultView, isFileChangeToolInput, isKnownFileWriteTool, type FileChangeView } from "@/lib/tool-result-view";
import s from "./message-timeline.module.css";
import { groupElapsedMs } from "./group-tools";
import { cachedGroupConsecutiveTools, cachedToolActivitySummary } from "./tool-cache";
import { truncateMiddle } from "@/lib/truncate-middle";
import { sanitizeTextForSpeech, speakText, voiceErrorMessage } from "@/lib/voice";
import { isSkillInvocationText } from "@/lib/skill-invocation";
import { isKernelInjectedNotice, kernelNotice } from "@/lib/kernel-notice";
import {
  formatDurationMs,
  formatElapsedTimer,
  formatTokPerSec,
  formatTokens,
} from "@/lib/format";
import type { SessionUsageResult } from "@hermes/protocol";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const BOTTOM_FOLLOW_THRESHOLD_PX = 120;
const BOTTOM_REATTACH_THRESHOLD_PX = 8;
const BOTTOM_FOLLOW_EPSILON_PX = 1;
const VISIBLE_MARGIN_PX = 12;
const LONG_SESSION_RENDER_THRESHOLD = 80;
const LONG_SESSION_INITIAL_WINDOW = 60;
const LONG_SESSION_EARLIER_BATCH = 40;

interface MessageTimelineProps {
  messages: ChatMessage[];
  loading?: boolean;
  statusMessage?: string;
  turnStartedAt?: number;
  sessionUsage?: SessionUsageResult | null;
  progressModel?: string;
  autoTts?: boolean;
  /** 解析 subagent store 的候选会话 id——对话流内 delegate 运行卡要用。 */
  subagentSessionIds?: readonly (string | undefined)[];
  /** 对话流末尾的插槽（审批堆叠卡），排在消息之后、状态提示之后。 */
  trailing?: ReactNode;
  /** 服务端是否还有更早的消息（useSessionMessages().hasMore）。 */
  hasEarlier?: boolean;
  /** 更早一页正在请求中。 */
  isLoadingEarlier?: boolean;
  /** 更早一页请求失败的错误，取到就要在顶部可见。 */
  loadEarlierError?: Error | null;
  /** 触发服务端向前翻页；不传则只保留本地渲染窗口。 */
  onLoadEarlier?: () => void | Promise<void>;
  /** 纠错闭环：把这条用户消息回填到输入框。不传则不渲染「编辑」。 */
  onEditMessage?: (message: ChatMessage) => void;
  /** 纠错闭环：重发这条回复对应的那条用户消息。不传则不渲染「重试」。 */
  onRetryMessage?: (userMessage: ChatMessage) => void;
  onDeleteMessage?: (userMessage: ChatMessage) => void;
  /** 流式进行中 / 会话忙碌时置 true：编辑与重试都要求会话空闲。 */
  correctionLocked?: boolean;
  /** 锁住的理由，直接进按钮 title。 */
  correctionLockedReason?: string;
  correctionPendingMessageId?: string | null;
  emptyGuide?: ReactNode;
  onOpenSettings?: (path: string) => void;
}

interface TurnAnchor {
  id: string;
  index: number;
  title: string;
}

interface RenderWindowState {
  sessionKey: string | undefined;
  start: number;
}

type SpeechPlaybackStatus = "idle" | "preparing" | "speaking";

interface SpeechPlaybackState {
  messageId: string | null;
  status: SpeechPlaybackStatus;
}

interface SpeechPlaybackError {
  message: string;
  messageId: string;
}

export function resolveBottomFollowState(
  bottomDistance: number,
  userDetachedFromBottom: boolean,
): { nearBottom: boolean; userDetachedFromBottom: boolean } {
  const distance = Math.max(0, bottomDistance);
  if (userDetachedFromBottom) {
    const reattached = distance <= BOTTOM_REATTACH_THRESHOLD_PX;
    return {
      nearBottom: reattached,
      userDetachedFromBottom: !reattached,
    };
  }
  return {
    nearBottom: distance < BOTTOM_FOLLOW_THRESHOLD_PX,
    userDetachedFromBottom: false,
  };
}

function distanceFromBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

export function shouldAnchorToBottom(
  userDetachedFromBottom: boolean,
  nearBottom: boolean,
  autoAnchor: boolean,
  bottomDistance: number,
): boolean {
  if (userDetachedFromBottom) return false;
  if (!nearBottom && !autoAnchor) return false;
  return bottomDistance > BOTTOM_FOLLOW_EPSILON_PX;
}

export function findLastAnchorIndexAtOrAbove(
  count: number,
  isAtOrAbove: (index: number) => boolean,
): number {
  let low = 0;
  let high = count - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (isAtOrAbove(middle)) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

export function shouldShowJumpToBottom(
  userDetachedFromBottom: boolean,
  bottomDistance: number,
): boolean {
  if (userDetachedFromBottom) return true;
  return bottomDistance > BOTTOM_FOLLOW_THRESHOLD_PX;
}

export function countRowsBelowViewport(
  count: number,
  isBelow: (index: number) => boolean,
): number {
  let low = 0;
  let high = count - 1;
  let firstBelow = count;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (isBelow(middle)) {
      firstBelow = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return count - firstBelow;
}

// 只有"用户主动上滑"才应脱离贴底跟随。程序触发的轮次跳转平滑滚动同样会让 scrollTop
// 递减，但绝不能被当成用户手势——否则会把自己的跳转动画硬取消掉。
export function shouldDetachOnScroll(
  scrollTop: number,
  lastScrollTop: number,
  programmaticScroll: boolean,
): boolean {
  if (programmaticScroll) return false;
  return scrollTop < lastScrollTop - 1;
}

export function shouldForceBottomOnMessageChange(
  previousMessageCount: number,
  nextMessageCount: number,
  sessionChanged: boolean,
  previousLastUserMessageId: string | undefined,
  nextLastUserMessageId: string | undefined,
): boolean {
  if (nextMessageCount === 0) return false;
  if (previousMessageCount === 0 || sessionChanged) return true;
  return nextLastUserMessageId !== undefined && nextLastUserMessageId !== previousLastUserMessageId;
}

function formatDay(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (date.toDateString() === now.toDateString()) return "今天";
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return date.toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  });
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

const MESSAGE_TIME_MINUTE_MS = 60_000;
const MESSAGE_TIME_TICK_MS = 30_000;

export function formatMessageTime(timestamp: number, now: number = Date.now()): string {
  const date = new Date(timestamp);
  const nowDate = new Date(now);
  if (date.toDateString() !== nowDate.toDateString()) return formatTime(timestamp);

  const elapsed = now - timestamp;
  if (elapsed < MESSAGE_TIME_MINUTE_MS) return "刚刚";

  const minutes = Math.floor(elapsed / MESSAGE_TIME_MINUTE_MS);
  if (minutes < 60) return `${minutes} 分钟前`;

  return formatTime(timestamp);
}

function MessageTimeLabel({ timestamp }: { timestamp: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), MESSAGE_TIME_TICK_MS);
    return () => window.clearInterval(timer);
  }, [timestamp]);

  return <>{formatMessageTime(timestamp, now)}</>;
}

function turnAnchorTitle(message: ChatMessage, index: number): string {
  const preview = copyableMessageText(message)?.replace(/\s+/g, " ").trim();
  return preview
    ? `第 ${index + 1} 轮：${truncateMiddle(preview, 34)}`
    : `第 ${index + 1} 轮`;
}

const PROGRESS_TRANSLATIONS: Record<string, string> = {
  analyzing: "分析中",
  brainstorming: "头脑风暴中",
  cogitating: "沉思中",
  computing: "计算中",
  contemplating: "推理中",
  deliberating: "思考中",
  decrypting: "解密中",
  forging: "锻造中",
  formulating: "构思中",
  "hammering plans": "敲定方案中",
  "jacking in": "接入中",
  mulling: "琢磨中",
  musing: "遐想中",
  plotting: "谋划中",
  pondering: "斟酌中",
  processing: "处理中",
  reasoning: "推理中",
  reflecting: "反思中",
  ruminating: "深思中",
  synthesizing: "综合分析中",
  uploading: "上传中",
};

function localizeProgressLabel(text?: string): string {
  if (!text) return "思考中";
  const normalized = text.replace(/\s+/g, " ").trim();
  const base = normalized.replace(/\.{2,}|…/g, "").trim();
  if (!base) return "思考中";
  for (const [en, zh] of Object.entries(PROGRESS_TRANSLATIONS)) {
    if (base.toLowerCase().endsWith(en)) {
      return base.slice(0, base.length - en.length) + zh;
    }
  }
  return normalized;
}

const LONG_THINKING_THRESHOLD_S = 120;

interface ProgressBlockProps {
  turnStartedAt?: number;
  sessionUsage?: SessionUsageResult | null;
  progressModel?: string;
  progressText?: string;
}

function ProgressBlock({ turnStartedAt, sessionUsage, progressModel, progressText }: ProgressBlockProps) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!turnStartedAt) return;
    setElapsed(Date.now() - turnStartedAt);
    const timer = window.setInterval(() => {
      setElapsed(Date.now() - turnStartedAt);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [turnStartedAt]);

  const label = localizeProgressLabel(progressText);
  const elapsedSeconds = Math.floor(elapsed / 1000);
  const showLongHint = elapsedSeconds >= LONG_THINKING_THRESHOLD_S;

  const tokenValue =
    typeof sessionUsage?.context_used === "number" &&
    Number.isFinite(sessionUsage.context_used) &&
    sessionUsage.context_used > 0
      ? sessionUsage.context_used
      : undefined;
  const model = progressModel || sessionUsage?.model;

  return (
    <div className={s.progressBlock} role="status" aria-live="polite">
      <span className={s.thinkingDot} />
      <span className={s.thinkingLabel}>
        {label}{showLongHint ? "（耗时较长）" : ""}
      </span>
      {(tokenValue || model) ? (
        <span className={s.thinkingMeta}>
          {tokenValue ? <span>{formatTokens(tokenValue)} tokens</span> : null}
          {tokenValue && model ? <span className={s.thinkingSep}>·</span> : null}
          {model ? <span className={s.thinkingModel}>{truncateMiddle(model, 24)}</span> : null}
        </span>
      ) : null}
      <span className={s.thinkingTimer}>{formatElapsedTimer(elapsed)}</span>
    </div>
  );
}

function ReasoningBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={s.reasoning}>
      <button
        type="button"
        className={s.disclosure}
        onClick={() => setOpen((value) => !value)}
        data-open={open}
      >
        <span className={s.chevron}>›</span>
        <span>{streaming ? "正在思考" : "推理过程"}</span>
      </button>
      {open ? <pre className={s.reasoningBody}>{text}</pre> : null}
    </div>
  );
}

function MoaReferenceBlock({
  label,
  text,
  index,
  count,
}: {
  label: string;
  text: string;
  index?: number;
  count?: number;
}) {
  const [open, setOpen] = useState(false);
  const position = index !== undefined && count !== undefined ? `（${index + 1}/${count}）` : "";

  return (
    <div className={s.reasoning}>
      <button
        type="button"
        className={s.disclosure}
        onClick={() => setOpen((value) => !value)}
        data-open={open}
      >
        <span className={s.chevron}>›</span>
        <span>{`参考模型 ${label}${position}`}</span>
      </button>
      {open ? <pre className={s.reasoningBody}>{text}</pre> : null}
    </div>
  );
}

// 系统通知超过此长度默认折叠——后台进程通知（notify_on_complete）会携带
// 完整命令与输出尾部（stream-json 委派动辄数 KB），对 agent 是必要输入，
// 对人只需首行摘要（"后台进程通知：proc_x completed normally (exit 0)"）。
const SYSTEM_NOTICE_COLLAPSE_THRESHOLD = 280;
const SYSTEM_NOTICE_SUMMARY_MAX = 160;

function formatNoticeLength(length: number): string {
  return length > 1000 ? `${(length / 1000).toFixed(1)}k 字符` : `${length} 字符`;
}

function SystemNoticeText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= SYSTEM_NOTICE_COLLAPSE_THRESHOLD) {
    return <div className={s.systemNoticeText}>{text}</div>;
  }
  const firstLine = text.split("\n")[0] ?? text;
  const summary =
    firstLine.length > SYSTEM_NOTICE_SUMMARY_MAX
      ? `${firstLine.slice(0, SYSTEM_NOTICE_SUMMARY_MAX)}…`
      : firstLine;
  return (
    <>
      <div className={s.systemNoticeText}>{open ? text : summary}</div>
      <button
        type="button"
        className={s.systemNoticeToggle}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "收起" : `展开全文（${formatNoticeLength(text.length)}）`}
      </button>
    </>
  );
}

function formatToolElapsed(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 100) return "<0.1s";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;

  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function sameToolList(
  prev: readonly ChatToolItem[] | undefined,
  next: readonly ChatToolItem[] | undefined,
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return false;
  if (prev.length !== next.length) return false;
  for (let index = 0; index < prev.length; index += 1) {
    if (prev[index] !== next[index]) return false;
  }
  return true;
}

function toolCardPropsEqual(prev: { tool: ChatToolItem }, next: { tool: ChatToolItem }): boolean {
  return prev.tool === next.tool;
}

function toolListPropsEqual(prev: { tools: ChatToolItem[] }, next: { tools: ChatToolItem[] }): boolean {
  return sameToolList(prev.tools, next.tools);
}

function initialRenderWindowStart(total: number): number {
  return total > LONG_SESSION_RENDER_THRESHOLD ? total - LONG_SESSION_INITIAL_WINDOW : 0;
}

function headPrependShift(state: RenderWindowState, messages: ChatMessage[]): number {
  if (state.sessionKey === undefined) return 0;
  const firstId = messages[0]?.id;
  if (firstId === undefined || firstId === state.sessionKey) return 0;
  const index = messages.findIndex((message) => message.id === state.sessionKey);
  return index > 0 ? index : 0;
}

function resolveWindowStart(
  state: RenderWindowState,
  messages: ChatMessage[],
  initial: number,
): number {
  if (state.sessionKey === undefined) return initial;
  if (messages[0]?.id === state.sessionKey) return state.start;
  const shift = headPrependShift(state, messages);
  if (shift > 0) {
    return Math.max(0, state.start + shift - LONG_SESSION_EARLIER_BATCH);
  }
  return initial;
}

function ToolCardBase({ tool }: { tool: ChatToolItem }) {
  const [open, setOpen] = useState(tool.status === "error");
  const [elapsed, setElapsed] = useState(() =>
    tool.status === "running" ? Math.max(0, Date.now() - tool.startedAt) : 0,
  );

  useEffect(() => {
    if (tool.status === "error") setOpen(true);
  }, [tool.status]);

  useEffect(() => {
    if (tool.status !== "running") return;
    setElapsed(Math.max(0, Date.now() - tool.startedAt));
    const timer = window.setInterval(() => {
      setElapsed(Date.now() - tool.startedAt);
    }, 500);
    return () => window.clearInterval(timer);
  }, [tool.startedAt, tool.status]);

  const elapsedLabel = formatToolElapsed(
    tool.status === "running"
      ? elapsed
      : tool.completedAt
        ? Math.max(0, tool.completedAt - tool.startedAt)
        : undefined,
  );
  const body = tool.error ?? tool.summary ?? tool.preview;
  const hasImages = Boolean(tool.images?.length);
  const hasBody = Boolean(body || tool.arguments || hasImages);

  return (
    <div className={s.toolCard} data-status={tool.status}>
      <button
        type="button"
        className={s.toolHeader}
        onClick={() => setOpen((value) => !value)}
        disabled={!hasBody}
        data-open={open}
      >
        <span className={s.toolStatusDot} data-status={tool.status} />
        <span className={s.toolName}>{tool.name}</span>
        {tool.context ? (
          <span className={s.toolContext} title={tool.context}>
            {truncateMiddle(tool.context)}
          </span>
        ) : null}
        {elapsedLabel ? <span className={s.toolElapsed}>{elapsedLabel}</span> : null}
      </button>
      {open && hasBody ? (
        <div className={s.toolBody}>
          {hasImages ? (
            <div className={s.toolImages}>
              {tool.images!.map((image, index) => (
                <MessageImage
                  key={`${image.url ?? image.name ?? image.alt ?? "image"}-${index}`}
                  image={image}
                />
              ))}
            </div>
          ) : null}
          <ToolResultCard tool={tool} body={body} />
        </div>
      ) : null}
    </div>
  );
}

const ToolCard = memo(ToolCardBase, toolCardPropsEqual);

function ToolGroupCardBase({ tools }: { tools: ChatToolItem[] }) {
  const [open, setOpen] = useState(false);
  const head = tools[0];
  const elapsedLabel = formatToolElapsed(groupElapsedMs(tools));

  return (
    <div className={s.toolCard} data-status="done">
      <button
        type="button"
        className={s.toolHeader}
        onClick={() => setOpen((value) => !value)}
        data-open={open}
      >
        <span className={s.toolStatusDot} data-status="done" />
        <span className={s.toolName}>{head.name}</span>
        {head.context ? (
          <span className={s.toolContext} title={head.context}>
            {truncateMiddle(head.context)}
          </span>
        ) : null}
        <span className={s.toolBadge}>×{tools.length}</span>
        {elapsedLabel ? <span className={s.toolElapsed}>{elapsedLabel}</span> : null}
      </button>
      {open ? (
        <div className={s.toolGroupBody}>
          {tools.map((tool, index) => (
            <ToolCard key={`${tool.tool_id}-${index}`} tool={tool} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const ToolGroupCard = memo(ToolGroupCardBase, toolListPropsEqual);

function ToolActivityBase({ tools }: { tools: ChatToolItem[] }) {
  const hasError = tools.some((tool) => tool.status === "error");
  const hasRunning = tools.some((tool) => tool.status === "running");
  const [open, setOpen] = useState(hasError);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (hasError) setOpen(true);
  }, [hasError]);

  useEffect(() => {
    if (!hasRunning) return;
    setNow(Date.now());
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 500);
    return () => window.clearInterval(timer);
  }, [hasRunning]);

  const summary = cachedToolActivitySummary(tools, now);
  const elapsedLabel = formatToolElapsed(summary.elapsedMs);

  return (
    <div className={s.toolActivity} data-status={summary.status}>
      <button
        type="button"
        className={s.toolActivitySummary}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        data-open={open}
      >
        <ChevronRight
          className={s.toolActivityChevron}
          size={16}
          strokeWidth={2.25}
          aria-hidden="true"
        />
        <span className={s.toolStatusDot} data-status={summary.status} />
        <span className={s.toolActivityLabel}>{summary.label}</span>
        {summary.meta ? <span className={s.toolActivityMeta}>{summary.meta}</span> : null}
        {elapsedLabel ? <span className={s.toolElapsed}>{elapsedLabel}</span> : null}
      </button>
      {summary.error && !open ? (
        <div className={s.toolActivityError}>{summary.error}</div>
      ) : null}
      {open ? (
        <div className={s.toolActivityDetails}>
          {cachedGroupConsecutiveTools(tools).map((entry, index) =>
            entry.kind === "group" ? (
              <ToolGroupCard key={entry.key} tools={entry.tools} />
            ) : (
              <ToolCard key={`${entry.tool.tool_id}-${index}`} tool={entry.tool} />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

const ToolActivity = memo(ToolActivityBase, toolListPropsEqual);

function ToolChainBase({ tools }: { tools: ChatToolItem[] }) {
  if (tools.length === 0) return null;
  return (
    <div className={s.toolChain}>
      <ToolActivity tools={tools} />
    </div>
  );
}

const ToolChain = memo(ToolChainBase, toolListPropsEqual);

const FILE_WRITE_PATH_KEYS = ["path", "file_path", "filePath", "target"] as const;
const FILE_WRITE_VISIBLE_LIMIT = 5;

function toolBodyText(tool: ChatToolItem): string | undefined {
  return tool.error ?? tool.summary ?? tool.preview;
}

const fileWriteProbeCache = new WeakMap<ChatToolItem, boolean>();

function isFileWriteTool(tool: ChatToolItem): boolean {
  const cached = fileWriteProbeCache.get(tool);
  if (cached !== undefined) return cached;
  const result =
    isKnownFileWriteTool(tool.name) &&
    isFileChangeToolInput({
      name: tool.name,
      arguments: tool.arguments,
      summary: toolBodyText(tool),
      error: tool.error,
    });
  fileWriteProbeCache.set(tool, result);
  return result;
}

function resolveFileWritePath(tool: ChatToolItem, view: FileChangeView): string | undefined {
  const args = tool.arguments;
  if (args) {
    for (const key of FILE_WRITE_PATH_KEYS) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return view.path ?? view.files.find((file) => Boolean(file.path))?.path;
}

function fileWriteStatusLabel(status: ChatToolItem["status"]): string {
  if (status === "running") return "运行中";
  if (status === "error") return "失败";
  return "完成";
}

function FileWriteCardBase({ tool }: { tool: ChatToolItem }) {
  const [open, setOpen] = useState(true);
  const body = toolBodyText(tool);
  const view = useMemo<FileChangeView>(() => {
    const built = buildToolResultView({
      name: tool.name,
      arguments: tool.arguments,
      summary: body,
      error: tool.error,
    });
    return built.kind === "file" ? built : { kind: "file", files: [], added: 0, removed: 0 };
  }, [tool.name, tool.arguments, body, tool.error]);
  const path = resolveFileWritePath(tool, view);

  return (
    <div className={s.fileWriteCard} data-file-write="true" data-status={tool.status}>
      <button
        type="button"
        className={s.fileWriteHeader}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        data-open={open}
      >
        <ChevronRight className={s.fileWriteChevron} size={14} strokeWidth={2.25} aria-hidden="true" />
        <FileDiff className={s.fileWriteIcon} size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className={s.fileWriteName} title={path ?? tool.name}>
          {path ? truncateMiddle(path) : tool.name}
        </span>
        <span className={s.fileWriteStats}>
          <span data-kind="add">+{view.added}</span>
          <span data-kind="del">−{view.removed}</span>
        </span>
        <span className={s.fileWriteStatus} data-status={tool.status}>
          {fileWriteStatusLabel(tool.status)}
        </span>
      </button>
      {open ? (
        <div className={s.fileWriteBody}>
          <ToolResultCard tool={tool} body={body} />
        </div>
      ) : null}
    </div>
  );
}

const FileWriteCard = memo(FileWriteCardBase, toolCardPropsEqual);

function MessageToolList({
  tools,
  streaming,
  subagentSessionIds,
}: {
  tools: ChatToolItem[];
  streaming: boolean;
  subagentSessionIds?: readonly (string | undefined)[];
}) {
  const [showAllFileWrites, setShowAllFileWrites] = useState(false);
  const delegates: ChatToolItem[] = [];
  const fileWrites: ChatToolItem[] = [];
  const others: ChatToolItem[] = [];
  for (const tool of tools) {
    if (isDelegateToolName(tool.name)) delegates.push(tool);
    else if (isFileWriteTool(tool)) fileWrites.push(tool);
    else others.push(tool);
  }
  const visibleFileWrites = showAllFileWrites ? fileWrites : fileWrites.slice(0, FILE_WRITE_VISIBLE_LIMIT);
  const foldedFileWrites = fileWrites.length - visibleFileWrites.length;

  return (
    <>
      {others.length > 0 ? <ToolChain tools={others} /> : null}
      {visibleFileWrites.map((tool, index) => (
        <FileWriteCard key={`file-write-${tool.tool_id || index}-${index}`} tool={tool} />
      ))}
      {fileWrites.length > FILE_WRITE_VISIBLE_LIMIT ? (
        showAllFileWrites ? (
          <button
            type="button"
            className={s.fileWriteMore}
            onClick={() => setShowAllFileWrites(false)}
            aria-expanded
          >
            收起文件变更
          </button>
        ) : (
          <button
            type="button"
            className={s.fileWriteMore}
            onClick={() => setShowAllFileWrites(true)}
            aria-expanded={false}
            data-file-write-more={foldedFileWrites}
          >
            还有 {foldedFileWrites} 个文件变更
          </button>
        )
      ) : null}
      {delegates.map((tool) => (
        <DelegateRunCard
          key={`delegate-run-${tool.tool_id}`}
          tool={tool}
          sessionIds={subagentSessionIds}
          streaming={streaming}
          claimUnlinked={delegates.length === 1}
        />
      ))}
    </>
  );
}

interface MessageBlocksProps {
  message: ChatMessage;
  streaming: boolean;
  turnStartedAt?: number;
  sessionUsage?: SessionUsageResult | null;
  progressModel?: string;
  subagentSessionIds?: readonly (string | undefined)[];
}

function messageBlocksPropsEqual(prev: MessageBlocksProps, next: MessageBlocksProps): boolean {
  return (
    prev.message === next.message &&
    prev.streaming === next.streaming &&
    prev.turnStartedAt === next.turnStartedAt &&
    prev.sessionUsage === next.sessionUsage &&
    prev.progressModel === next.progressModel &&
    prev.subagentSessionIds === next.subagentSessionIds
  );
}

function MessageBlocksBase({ message, streaming, turnStartedAt, sessionUsage, progressModel, subagentSessionIds }: MessageBlocksProps) {
  const showReasoning = useAtomValue(showReasoningAtom);
  const cliDelegations = useAtomValue(cliDelegationsByToolIdAtom);
  const inlineAnchor = useInlinePromptAnchor();
  const blocks = message.blocks ?? [];
  const items: ReactNode[] = [];
  let pendingTools: ChatToolItem[] = [];
  // 同一条消息里可能有多次 delegate_task；只有唯一一张卡时才允许它按时间窗
  // 认领没有工具 id 关联的原生 subagent 行，否则第二张会抢第一张的工人。
  const delegateCardCount = blocks.filter(
    (block) => block.type === "tool" && isDelegateToolName(block.tool.name),
  ).length;

  const flushTools = (key: string) => {
    if (pendingTools.length === 0) return;
    const anchorHere = Boolean(inlineAnchor) && pendingTools.some((tool) => tool.tool_id === inlineAnchor?.toolId);
    items.push(<ToolChain key={key} tools={pendingTools} />);
    if (anchorHere) items.push(<Fragment key="inline-prompt">{inlineAnchor?.node}</Fragment>);
    pendingTools = [];
  };

  blocks.forEach((block, index) => {
    if (block.type === "tool") {
      // 内核 delegate_task：子代理协作的一等公民，出专用运行卡（ticker/模型/
      // 状态/日志/中断），不进 ToolChain 聚合，也不吃通用工具行的 JSON 大块。
      if (isDelegateToolName(block.tool.name)) {
        flushTools(`tools-${index}`);
        items.push(
          <DelegateRunCard
            key={`delegate-run-${block.tool.tool_id || index}`}
            tool={block.tool}
            sessionIds={subagentSessionIds}
            streaming={streaming}
            claimUnlinked={delegateCardCount === 1}
          />,
        );
        return;
      }
      // CLI 委派（Claude Code / Codex）升级为品牌化卡片：live store 命中
      // 优先（P-047 事件或旧内核回退），历史重载走渲染时按需重建。委派卡
      // 不进 ToolChain 聚合——它是多 Agent 协作的一等公民，不该被折叠进
      // "运行了 N 个工具"。
      const delegation = cliDelegations.get(block.tool.tool_id) ?? entryFromChatTool(block.tool);
      if (delegation) {
        flushTools(`tools-${index}`);
        items.push(<CliDelegationCard key={`cli-delegation-${index}`} entry={delegation} />);
        return;
      }
      pendingTools.push(block.tool);
      return;
    }

    flushTools(`tools-${index}`);

    if (block.type === "progress") {
      return;
    }

    if (block.type === "text") {
      items.push(
        <div key={`text-${index}`} className={s.turnText}>
          <MessageText text={block.text} streaming={streaming && index === blocks.length - 1} />
        </div>,
      );
      return;
    }

    if (block.type === "image") {
      items.push(
        <div key={`image-${index}`} className={s.imageBlock}>
          <MessageImage image={block.image} />
        </div>,
      );
      return;
    }

    if (block.type === "moa_reference") {
      // MoA 参考模型输出块——不受 showReasoning 门控：它是委员会成员的
      // 实际回答（MoA 的核心卖点），不是模型的内心独白；默认折叠不扰。
      items.push(
        <MoaReferenceBlock
          key={`moa-ref-${index}`}
          label={block.label}
          text={block.text}
          index={block.index}
          count={block.count}
        />,
      );
      return;
    }

    if (!showReasoning) return;

    items.push(
      <ReasoningBlock
        key={`reasoning-${index}`}
        text={block.text}
        streaming={streaming && index === blocks.length - 1}
      />,
    );
  });

  flushTools("tools-last");

  if (streaming) {
    const progressPart = blocks?.find((b) => b.type === "progress");
    items.push(
      <ProgressBlock
        key="tail-progress"
        turnStartedAt={turnStartedAt}
        sessionUsage={sessionUsage}
        progressModel={progressModel}
        progressText={progressPart?.type === "progress" ? progressPart.text : undefined}
      />,
    );
  }

  return <>{items}</>;
}

const MessageBlocks = memo(MessageBlocksBase, messageBlocksPropsEqual);

export function copyableMessageText(message: ChatMessage): string | undefined {
  if (message.blocks?.length) {
    const text = message.blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n\n")
      .trim();
    if (text) return text;
  }
  return message.text?.trim() || undefined;
}

function getReadableText(message: ChatMessage): string | undefined {
  if (message.blocks?.length) {
    const text = message.blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n\n")
      .trim();
    return text || undefined;
  }
  return message.text?.trim() || undefined;
}

const FINISH_REASON_LABEL: Record<string, string> = {
  stop: "正常",
  end_turn: "正常",
  length: "上下文截断",
  tool_use: "调用工具",
  tool_calls: "调用工具",
  error: "错误",
  interrupted: "中断",
  content_filter: "内容过滤",
};

function finishReasonRisk(reason: string | undefined): "warn" | "err" | undefined {
  if (!reason) return undefined;
  if (reason === "length" || reason === "content_filter") return "warn";
  if (reason === "error") return "err";
  return undefined;
}

function sessionUsageFallbackStats(
  message: ChatMessage,
  sessionUsage: SessionUsageResult | null | undefined,
): AssistantMessageStats | undefined {
  if (message.role !== "assistant" || message.status === "streaming" || message.status === "error") return undefined;
  if (!sessionUsage) return undefined;

  const stats: AssistantMessageStats = {};
  const tokensInput = sessionUsage.input ?? sessionUsage.prompt;
  const tokensOutput = sessionUsage.output ?? sessionUsage.completion;
  const tokensTotal = sessionUsage.total ?? (
    typeof tokensInput === "number" || typeof tokensOutput === "number"
      ? (tokensInput ?? 0) + (tokensOutput ?? 0)
      : undefined
  );

  if (typeof tokensInput === "number") stats.tokensInput = tokensInput;
  if (typeof tokensOutput === "number") stats.tokensOutput = tokensOutput;
  if (typeof tokensTotal === "number") stats.tokensTotal = tokensTotal;
  if (typeof sessionUsage.cache_read === "number") stats.cacheRead = sessionUsage.cache_read;
  if (typeof sessionUsage.cache_write === "number") stats.cacheWrite = sessionUsage.cache_write;
  if (typeof sessionUsage.calls === "number") stats.apiCalls = sessionUsage.calls;
  if (typeof sessionUsage.model === "string" && sessionUsage.model) stats.model = sessionUsage.model;

  const costStatus = typeof sessionUsage.cost_status === "string"
    ? sessionUsage.cost_status.toLowerCase()
    : undefined;
  if (
    typeof sessionUsage.cost_usd === "number" &&
    Number.isFinite(sessionUsage.cost_usd) &&
    costStatus !== "stale_pricing" &&
    costStatus !== "unknown"
  ) {
    stats.costUsd = sessionUsage.cost_usd;
  }

  return Object.keys(stats).length > 0 ? stats : undefined;
}

function MessageStatsFooter({ stats }: { stats: AssistantMessageStats }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (!wrapRef.current) return;
      if (wrapRef.current.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const inlineParts: string[] = [];
  if (stats.ttftMs !== undefined) inlineParts.push(`TTFT ${formatDurationMs(stats.ttftMs)}`);
  if (stats.durationMs !== undefined) inlineParts.push(formatDurationMs(stats.durationMs));
  if (stats.tokensTotal !== undefined) inlineParts.push(formatTokens(stats.tokensTotal));
  if (stats.tokPerSec !== undefined) inlineParts.push(`${formatTokPerSec(stats.tokPerSec)} tok/s`);

  if (inlineParts.length === 0) return null;

  const risk = finishReasonRisk(stats.finishReason);

  return (
    <span ref={wrapRef} className={s.messageStats} data-risk={risk}>
      <span className={s.messageStatsInline}>
        {inlineParts.map((part, idx) => (
          <span key={idx}>{part}</span>
        ))}
      </span>
      <button
        type="button"
        className={s.messageStatsToggle}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="查看详细统计"
        title="详细统计"
      >
        <Info size={12} strokeWidth={2} aria-hidden="true" />
      </button>
      {open ? (
        <div className={s.messageStatsPopover} role="dialog">
          <dl>
            {stats.model ? (
              <>
                <dt>模型</dt>
                <dd className={s.messageStatsModel}>{stats.model}</dd>
              </>
            ) : null}
            {stats.tokensInput !== undefined ? (
              <>
                <dt>输入</dt>
                <dd>{formatTokens(stats.tokensInput)}</dd>
              </>
            ) : null}
            {stats.tokensOutput !== undefined ? (
              <>
                <dt>输出</dt>
                <dd>{formatTokens(stats.tokensOutput)}</dd>
              </>
            ) : null}
            {stats.cacheRead !== undefined || stats.cacheWrite !== undefined ? (
              <>
                <dt>缓存</dt>
                <dd>
                  {formatTokens(stats.cacheRead)} 读 / {formatTokens(stats.cacheWrite)} 写
                </dd>
              </>
            ) : null}
            {stats.apiCalls !== undefined ? (
              <>
                <dt>API</dt>
                <dd>{stats.apiCalls} 次调用</dd>
              </>
            ) : null}
            {stats.finishReason ? (
              <>
                <dt>结束</dt>
                <dd data-risk={risk}>
                  {FINISH_REASON_LABEL[stats.finishReason] ?? stats.finishReason}
                </dd>
              </>
            ) : null}
          </dl>
        </div>
      ) : null}
    </span>
  );
}

function precedingUserAsk(messages: readonly ChatMessage[], index: number): ChatMessage | null {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = messages[cursor];
    if (!candidate || candidate.role !== "user") continue;
    if (isSkillInvocationText(candidate.text) || isKernelInjectedNotice(candidate.text)) continue;
    return candidate;
  }
  return null;
}

interface MessageBubbleProps {
  message: ChatMessage;
  turnStartedAt?: number;
  sessionUsage?: SessionUsageResult | null;
  progressModel?: string;
  subagentSessionIds?: readonly (string | undefined)[];
  speechStatus: SpeechPlaybackStatus;
  speechError: string | null;
  onSpeak: (messageId: string, text: string) => void;
  onStop: () => void;
  retrySource?: ChatMessage | null;
  onEditMessage?: (message: ChatMessage) => void;
  onRetryMessage?: (userMessage: ChatMessage) => void;
  onDeleteMessage?: (userMessage: ChatMessage) => void;
  correctionLocked?: boolean;
  correctionLockedReason?: string;
  correctionPendingMessageId?: string | null;
  onOpenSettings?: (path: string) => void;
}

function messageBubblePropsEqual(prev: MessageBubbleProps, next: MessageBubbleProps): boolean {
  return (
    prev.message === next.message &&
    prev.turnStartedAt === next.turnStartedAt &&
    prev.sessionUsage === next.sessionUsage &&
    prev.progressModel === next.progressModel &&
    prev.subagentSessionIds === next.subagentSessionIds &&
    prev.speechStatus === next.speechStatus &&
    prev.speechError === next.speechError &&
    prev.onSpeak === next.onSpeak &&
    prev.onStop === next.onStop &&
    prev.retrySource === next.retrySource &&
    prev.onEditMessage === next.onEditMessage &&
    prev.onRetryMessage === next.onRetryMessage &&
    prev.onDeleteMessage === next.onDeleteMessage &&
    prev.correctionLocked === next.correctionLocked &&
    prev.correctionLockedReason === next.correctionLockedReason &&
    prev.correctionPendingMessageId === next.correctionPendingMessageId &&
    prev.onOpenSettings === next.onOpenSettings
  );
}

function MessageBubbleBase({
  message,
  turnStartedAt,
  sessionUsage,
  progressModel,
  subagentSessionIds,
  speechStatus,
  speechError,
  onSpeak,
  onStop,
  retrySource,
  onEditMessage,
  onRetryMessage,
  onDeleteMessage,
  correctionLocked = false,
  correctionLockedReason,
  correctionPendingMessageId = null,
  onOpenSettings,
}: MessageBubbleProps) {
  const showReasoning = useAtomValue(showReasoningAtom);
  const assistantDisplayName = useAtomValue(assistantDisplayNameAtom);
  const assistantAvatarDataUrl = useAtomValue(assistantAvatarEffectiveAtom);
  const isUser = message.role === "user";
  const isToolOnly = message.role === "tool";
  const isSystem = message.role === "system";
  const streaming = message.status === "streaming";
  const copyable = copyableMessageText(message);
  const readable = !isUser && !isSystem && !isToolOnly && !streaming && message.status !== "error"
    ? getReadableText(message)
    : undefined;
  const speechBusy = speechStatus === "preparing" || speechStatus === "speaking";
  const hasBlocks = !isUser && Boolean(message.blocks?.length);
  const hasSkillInvocation = isSkillInvocationText(message.text);
  const kernel = kernelNotice(message.text);
  const messageStats = message.stats ?? sessionUsageFallbackStats(message, sessionUsage);
  const canEdit = isUser && !isSystem && !isToolOnly && !hasSkillInvocation && Boolean(onEditMessage);
  const canRetry =
    !isUser && !isSystem && !isToolOnly && !streaming && Boolean(onRetryMessage) && Boolean(retrySource);
  const canDelete = isUser && !hasSkillInvocation && Boolean(onDeleteMessage);
  const editTitle = correctionLocked
    ? (correctionLockedReason ?? "正在生成回复，等这轮结束再编辑")
    : message.images?.length
      ? "编辑并重发：附件不会被带回输入框"
      : "编辑并重发";
  const retryTitle = correctionLocked
    ? (correctionLockedReason ?? "正在生成回复，等这轮结束再重试")
    : retrySource?.images?.length
      ? "重试这条回复：原消息的附件不会重新发送"
      : "重试这条回复（重发对应的提问）";
  const editResolving = Boolean(correctionPendingMessageId) && message.id === correctionPendingMessageId;
  const deleteResolving = editResolving && Boolean(onDeleteMessage);
  const deleteTitle = correctionLocked
    ? (correctionLockedReason ?? "正在生成回复，等这轮结束再删除")
    : "删除这条提问及之后的全部消息";
  const retryResolving =
    Boolean(correctionPendingMessageId) && retrySource?.id === correctionPendingMessageId;
  const resolvingTitle = "正在重载会话记录，定位这条提问在内核里的位置";

  if (kernel) {
    return (
      <div className={s.messageRow} data-role="system" data-system-kind="kernel-notice">
        <div className={s.systemNotice} data-kind="kernel-notice" role="status">
          <Bot
            className={s.systemNoticeIcon}
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <div className={s.systemNoticeBody}>
            <div className={s.systemNoticeTitle}>
              <span>{kernel.title}</span>
              {kernel.delegationId ? (
                <span className={s.kernelNoticeId}>{kernel.delegationId}</span>
              ) : null}
            </div>
            <div className={s.kernelNoticeBody}>
              <MessageText text={kernel.body} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (hasSkillInvocation) {
    return (
      <div className={s.messageRow} data-role="system" data-system-kind="skill-invocation">
        <div
          className={s.systemNotice}
          data-kind="skill-invocation"
          role="status"
        >
          <Info
            className={s.systemNoticeIcon}
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <div className={s.systemNoticeBody}>
            <div className={s.systemNoticeTitle}>Skill 指令已加载</div>
            <SkillInvocationMessage text={message.text ?? ""} />
          </div>
        </div>
      </div>
    );
  }

  if (isToolOnly) {
    const tools = message.tools ?? [];
    return (
      <div className={s.messageRow} data-role="assistant">
        {/* 与带头像的行保持左缘对齐的占位列。 */}
        <div className={s.avatarCol} aria-hidden />
        <div className={s.messageContent}>
          <MessageToolList
            tools={tools}
            streaming={streaming}
            subagentSessionIds={subagentSessionIds}
          />
        </div>
      </div>
    );
  }

  if (isSystem) {
    const text = message.text || message.reasoning || "";
    return (
      <div className={s.messageRow} data-role="system">
        <div
          className={s.systemNotice}
          data-error={message.error ? "true" : undefined}
          role={message.error ? "alert" : "status"}
        >
          <AlertTriangle
            className={s.systemNoticeIcon}
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <div className={s.systemNoticeBody}>
            {message.error ? <div className={s.systemNoticeTitle}>请求失败</div> : null}
            {message.error ? (
              <div className={s.systemNoticeText}>{resolveErrorDisplayText(text)}</div>
            ) : (
              <SystemNoticeText text={text} />
            )}
            {message.error ? (
              <ErrorRecoveryActions
                text={text}
                retrySource={retrySource ?? null}
                onRetry={onRetryMessage}
                locked={correctionLocked}
                lockedReason={correctionLockedReason}
                onOpenSettings={onOpenSettings}
              />
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={s.messageRow} data-role={isUser ? "user" : "assistant"}>
      {/* IM 式布局：Hermes 头像独立于气泡左侧一列（点击弹资料卡）；用户侧
          不显示头像与昵称，气泡右贴。 */}
      {!isUser ? (
        <div className={s.avatarCol}>
          <AssistantProfileCard
            model={progressModel || sessionUsage?.model}
            trigger={
              <button type="button" className={s.avatarButton} title={`查看 ${assistantDisplayName} 资料`}>
                <img
                  className={s.rowAvatar}
                  src={assistantAvatarDataUrl}
                  alt={`${assistantDisplayName} 头像`}
                />
              </button>
            }
          />
        </div>
      ) : null}
      <div className={s.messageContent}>
        {!isUser ? (
          <div className={s.assistantName}>
            <span>{assistantDisplayName}</span>
          </div>
        ) : null}
        <div className={s.bubble} data-role={isUser ? "user" : "assistant"}>
          {hasBlocks ? (
            <MessageBlocks
              message={message}
              streaming={streaming}
              turnStartedAt={turnStartedAt}
              sessionUsage={sessionUsage}
              progressModel={progressModel}
              subagentSessionIds={subagentSessionIds}
            />
          ) : (
            <>
              {message.text ? <MessageText text={message.text} streaming={streaming} /> : null}
              {message.images?.length ? (
                <div className={s.messageImages}>
                  {message.images.map((image, index) => (
                    <MessageImage
                      key={`${image.url ?? image.name ?? image.alt ?? "image"}-${index}`}
                      image={image}
                    />
                  ))}
                </div>
              ) : null}
              {showReasoning && message.reasoning ? (
                <ReasoningBlock text={message.reasoning} streaming={streaming && !message.text} />
              ) : null}
              {message.tools?.length ? (
                <MessageToolList
                  tools={message.tools}
                  streaming={streaming}
                  subagentSessionIds={subagentSessionIds}
                />
              ) : null}
              {streaming ? <ProgressBlock progressModel={progressModel} /> : null}
            </>
          )}
        </div>
        <div className={s.messageActions}>
          <span className={s.messageTime}>
            <MessageTimeLabel timestamp={message.createdAt} />
          </span>
          <span className={s.messageActionGroup}>
            {copyable ? (
              <CopyButton className={s.messageAction} text={copyable} showStatusIcon={false}>
                复制
              </CopyButton>
            ) : null}
            {readable ? (
              <button
                type="button"
                className={s.messageAction}
                onClick={() => {
                  if (speechBusy) {
                    onStop();
                  } else {
                    onSpeak(message.id, readable);
                  }
                }}
                data-speech-state={speechStatus}
                aria-pressed={speechBusy}
                title={speechBusy ? "停止朗读" : "朗读回复"}
              >
                {speechStatus === "preparing" ? (
                  <LoadingIndicator size="xs" />
                ) : speechStatus === "speaking" ? (
                  <VolumeX size={14} strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <Volume2 size={14} strokeWidth={1.75} aria-hidden="true" />
                )}
                <span>{speechBusy ? "停止" : "朗读"}</span>
              </button>
            ) : null}
            {canEdit ? (
              <button
                type="button"
                className={`${s.messageAction} ${s.messageCorrectAction}`}
                onClick={() => onEditMessage?.(message)}
                disabled={correctionLocked || editResolving}
                title={editResolving ? resolvingTitle : editTitle}
                data-correction-pending={editResolving ? "true" : undefined}
              >
                {editResolving ? (
                  <LoadingIndicator size="xs" />
                ) : (
                  <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
                )}
                <span>{editResolving ? "定位中" : "编辑"}</span>
              </button>
            ) : null}
            {canRetry ? (
              <button
                type="button"
                className={`${s.messageAction} ${s.messageCorrectAction}`}
                onClick={() => {
                  if (retrySource) onRetryMessage?.(retrySource);
                }}
                disabled={correctionLocked || retryResolving}
                title={retryResolving ? resolvingTitle : retryTitle}
                data-correction-pending={retryResolving ? "true" : undefined}
              >
                {retryResolving ? (
                  <LoadingIndicator size="xs" />
                ) : (
                  <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />
                )}
                <span>{retryResolving ? "定位中" : "重试"}</span>
              </button>
            ) : null}
            {canDelete ? (
              <button
                type="button"
                className={`${s.messageAction} ${s.messageDeleteAction}`}
                onClick={() => onDeleteMessage?.(message)}
                disabled={correctionLocked || deleteResolving}
                title={deleteResolving ? resolvingTitle : deleteTitle}
                data-delete-pending={deleteResolving ? "true" : undefined}
              >
                {deleteResolving ? (
                  <LoadingIndicator size="xs" />
                ) : (
                  <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
                )}
                <span>{deleteResolving ? "定位中" : "删除"}</span>
              </button>
            ) : null}
          </span>
          {speechError ? <span className={s.messageSpeechError}>{speechError}</span> : null}
          {messageStats ? <MessageStatsFooter stats={messageStats} /> : null}
        </div>
      </div>
    </div>
  );
}

const MessageBubble = memo(MessageBubbleBase, messageBubblePropsEqual);

export function MessageTimeline({
  messages,
  loading = false,
  statusMessage,
  turnStartedAt,
  sessionUsage,
  progressModel,
  autoTts = false,
  subagentSessionIds,
  trailing,
  hasEarlier = false,
  isLoadingEarlier = false,
  loadEarlierError = null,
  onLoadEarlier,
  onEditMessage,
  onRetryMessage,
  onDeleteMessage,
  correctionLocked = false,
  correctionLockedReason,
  correctionPendingMessageId = null,
  emptyGuide,
  onOpenSettings,
}: MessageTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const turnAnchorRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const nearBottomRef = useRef(true);
  const userDetachedFromBottomRef = useRef(false);
  const autoAnchorRef = useRef(false);
  const autoAnchorTimerRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  const turnUpdateFrameRef = useRef(0);
  const lastTurnUpdateScrollTopRef = useRef(-1);
  // 程序触发的轮次跳转（平滑滚动）守卫：跳转动画期间 onScroll 会被误判为用户上滑而
  // 触发 detachFromBottomAutoFollow 硬取消滚动，这里用标记把跳转滚动与用户手势区分开。
  const programmaticScrollRef = useRef(false);
  const programmaticTargetRef = useRef(0);
  const programmaticTimerRef = useRef<number | null>(null);
  const messageCountRef = useRef(0);
  const jumpFrameRef = useRef(0);
  const jumpInFlightRef = useRef(false);
  const firstMessageIdRef = useRef<string | undefined>(undefined);
  const lastUserMessageIdRef = useRef<string | undefined>(undefined);
  const speechAudioRef = useRef<HTMLAudioElement | null>(null);
  const speechStopRef = useRef<(() => void) | null>(null);
  const speechSequenceRef = useRef(0);
  const autoTtsSeenRef = useRef<Set<string>>(new Set());
  const autoTtsSessionKeyRef = useRef<string | undefined>(undefined);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [jumpButton, setJumpButton] = useState<{ visible: boolean; count: number }>({
    visible: false,
    count: 0,
  });
  const [speechState, setSpeechState] = useState<SpeechPlaybackState>({
    messageId: null,
    status: "idle",
  });
  const [speechError, setSpeechError] = useState<SpeechPlaybackError | null>(null);
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (message) =>
          message.text ||
          message.reasoning ||
          message.images?.length ||
          message.tools?.length ||
          message.blocks?.length,
      ),
    [messages],
  );
  const turnAnchors = useMemo<TurnAnchor[]>(() => {
    const anchors: TurnAnchor[] = [];
    for (const message of visibleMessages) {
      if (message.role !== "user" || isSkillInvocationText(message.text) || isKernelInjectedNotice(message.text)) continue;
      const index = anchors.length;
      anchors.push({
        id: message.id,
        index,
        title: turnAnchorTitle(message, index),
      });
    }
    return anchors;
  }, [visibleMessages]);
  const showTurnRail = turnAnchors.length > 1;

  const sessionKey = visibleMessages[0]?.id;
  const [renderWindow, setRenderWindow] = useState<RenderWindowState>({
    sessionKey: undefined,
    start: 0,
  });
  const initialWindowStart = initialRenderWindowStart(visibleMessages.length);
  const prependShift = headPrependShift(renderWindow, visibleMessages);
  if (renderWindow.sessionKey !== sessionKey && prependShift === 0) {
    setRenderWindow({ sessionKey, start: initialWindowStart });
  }
  const windowStart =
    renderWindow.sessionKey === sessionKey ? renderWindow.start : resolveWindowStart(renderWindow, visibleMessages, initialWindowStart);
  const windowedMessages = windowStart > 0 ? visibleMessages.slice(windowStart) : visibleMessages;
  const hiddenMessageCount = windowStart;

  const stopSpeech = useCallback(() => {
    speechSequenceRef.current += 1;
    speechStopRef.current?.();
    speechStopRef.current = null;
    if (speechAudioRef.current) {
      speechAudioRef.current.pause();
      speechAudioRef.current.src = "";
      speechAudioRef.current.load();
      speechAudioRef.current = null;
    }
    setSpeechState({ messageId: null, status: "idle" });
  }, []);

  const playSpeech = useCallback(async (messageId: string, text: string) => {
    const speakableText = sanitizeTextForSpeech(text);
    if (!speakableText) {
      setSpeechError({ messageId, message: "没有可朗读的文本。" });
      return;
    }

    stopSpeech();
    const ownSequence = speechSequenceRef.current;
    setSpeechError(null);
    setSpeechState({ messageId, status: "preparing" });

    try {
      const response = await speakText(speakableText);
      if (speechSequenceRef.current !== ownSequence) return;

      const audio = new Audio(response.data_url);
      speechAudioRef.current = audio;
      setSpeechState({ messageId, status: "speaking" });

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          audio.removeEventListener("ended", onEnded);
          audio.removeEventListener("error", onError);
          if (speechStopRef.current === onStop) speechStopRef.current = null;
        };
        const onEnded = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error("音频播放失败"));
        };
        const onStop = () => {
          cleanup();
          resolve();
        };
        speechStopRef.current = onStop;
        audio.addEventListener("ended", onEnded, { once: true });
        audio.addEventListener("error", onError, { once: true });
        void audio.play().catch(reject);
      });

      if (speechSequenceRef.current !== ownSequence) return;
      speechAudioRef.current = null;
      setSpeechState({ messageId: null, status: "idle" });
    } catch (error) {
      if (speechSequenceRef.current !== ownSequence) return;
      speechAudioRef.current = null;
      speechStopRef.current = null;
      setSpeechState({ messageId: null, status: "idle" });
      setSpeechError({ messageId, message: voiceErrorMessage(error, "朗读失败") });
    }
  }, [stopSpeech]);

  useEffect(() => () => {
    speechSequenceRef.current += 1;
    speechStopRef.current?.();
    speechStopRef.current = null;
    if (speechAudioRef.current) {
      speechAudioRef.current.pause();
      speechAudioRef.current.src = "";
      speechAudioRef.current.load();
      speechAudioRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!autoTts) return;

    const completed: ChatMessage[] = [];
    for (const message of messages) {
      if (message.role !== "assistant" || message.status !== "complete") continue;
      if (!getReadableText(message)) continue;
      completed.push(message);
    }
    const sessionKey = messages[0]?.id;
    if (autoTtsSessionKeyRef.current !== sessionKey) {
      autoTtsSessionKeyRef.current = sessionKey;
      autoTtsSeenRef.current = new Set(completed.map((message) => message.id));
      return;
    }

    let fresh: ChatMessage | undefined;
    for (const message of completed) {
      if (!autoTtsSeenRef.current.has(message.id)) fresh = message;
      autoTtsSeenRef.current.add(message.id);
    }
    if (!fresh) return;

    const text = getReadableText(fresh);
    if (text) void playSpeech(fresh.id, text);
  }, [autoTts, messages, playSpeech]);

  const handleSpeak = useCallback((messageId: string, text: string) => {
    void playSpeech(messageId, text);
  }, [playSpeech]);

  const revealEarlierRef = useRef<{ node: HTMLElement; top: number } | null>(null);

  const firstRenderedRow = useCallback((): HTMLElement | null => {
    const root = messagesRef.current;
    if (!root) return null;
    for (const child of Array.from(root.children)) {
      if (child instanceof HTMLElement && child.querySelector("[data-role]")) return child;
    }
    return null;
  }, []);

  const revealEarlierMessages = useCallback(() => {
    const node = firstRenderedRow();
    revealEarlierRef.current = node ? { node, top: node.getBoundingClientRect().top } : null;
    setRenderWindow((previous) => ({
      sessionKey,
      start: Math.max(
        0,
        (previous.sessionKey === sessionKey ? previous.start : windowStart) -
          LONG_SESSION_EARLIER_BATCH,
      ),
    }));
  }, [firstRenderedRow, sessionKey, windowStart]);

  const [earlierRequested, setEarlierRequested] = useState(false);

  const loadEarlierMessages = useCallback(() => {
    if (!onLoadEarlier || isLoadingEarlier || !hasEarlier) return;
    const node = firstRenderedRow();
    revealEarlierRef.current = node ? { node, top: node.getBoundingClientRect().top } : null;
    setEarlierRequested(true);
    void onLoadEarlier();
  }, [firstRenderedRow, hasEarlier, isLoadingEarlier, onLoadEarlier]);

  useIsomorphicLayoutEffect(() => {
    const pending = revealEarlierRef.current;
    const container = containerRef.current;
    if (!pending || !container) return;
    revealEarlierRef.current = null;
    const shift = pending.node.getBoundingClientRect().top - pending.top;
    if (shift === 0) return;
    container.scrollTop += shift;
    lastScrollTopRef.current = container.scrollTop;
  }, [windowStart]);

  const setTurnAnchorNode = useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) {
      turnAnchorRefs.current.set(id, node);
    } else {
      turnAnchorRefs.current.delete(id);
    }
  }, []);

  const updateActiveTurnFromScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container || turnAnchors.length < 2) return;

    const containerRect = container.getBoundingClientRect();
    const thresholdY = containerRect.top + Math.min(container.clientHeight * 0.35, 180);
    const present: number[] = [];
    for (let index = 0; index < turnAnchors.length; index += 1) {
      if (turnAnchorRefs.current.has(turnAnchors[index].id)) present.push(index);
    }
    if (present.length === 0) return;

    // 锚点在文档流里从上到下排列，矩形 top 单调递增，可以直接二分定位"最后一个越过
    // 激活线的轮次"，不再对每一轮都做 getBoundingClientRect（长会话里是 O(轮次)/帧）。
    const hit = findLastAnchorIndexAtOrAbove(present.length, (position) => {
      const node = turnAnchorRefs.current.get(turnAnchors[present[position]].id);
      return node ? node.getBoundingClientRect().top <= thresholdY : false;
    });
    const currentId = turnAnchors[hit >= 0 ? present[hit] : 0]?.id ?? null;

    if (currentId) {
      setActiveTurnId((previous) => previous === currentId ? previous : currentId);
    }
  }, [turnAnchors]);

  const scheduleActiveTurnUpdate = useCallback(() => {
    if (turnUpdateFrameRef.current !== 0) return;
    turnUpdateFrameRef.current = window.requestAnimationFrame(() => {
      turnUpdateFrameRef.current = 0;
      const container = containerRef.current;
      if (!container) return;
      const scrollTop = container.scrollTop;
      if (scrollTop === lastTurnUpdateScrollTopRef.current) return;
      lastTurnUpdateScrollTopRef.current = scrollTop;
      updateActiveTurnFromScroll();
    });
  }, [updateActiveTurnFromScroll]);

  const scrollToTurn = useCallback((id: string) => {
    const container = containerRef.current;
    const node = turnAnchorRefs.current.get(id);
    if (!container || !node) return;

    if (autoAnchorTimerRef.current !== null) {
      window.clearTimeout(autoAnchorTimerRef.current);
      autoAnchorTimerRef.current = null;
    }
    autoAnchorRef.current = false;

    const containerRect = container.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const top = container.scrollTop + nodeRect.top - containerRect.top - 12;
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const targetTop = Math.min(Math.max(0, top), maxTop);
    nearBottomRef.current = container.scrollHeight - targetTop - container.clientHeight < BOTTOM_FOLLOW_THRESHOLD_PX;
    userDetachedFromBottomRef.current = !nearBottomRef.current;
    // 标记这是一次程序跳转：handleScroll 在到达目标前不得把它当成用户上滑。
    // 兜底定时器防止动画因目标 clamp / 内容重排始终差几像素而无法清除标记。
    programmaticScrollRef.current = true;
    programmaticTargetRef.current = targetTop;
    if (programmaticTimerRef.current !== null) {
      window.clearTimeout(programmaticTimerRef.current);
    }
    programmaticTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticTimerRef.current = null;
    }, 700);
    container.scrollTo({ top: targetTop, behavior: "smooth" });
    lastScrollTopRef.current = container.scrollTop;
    setActiveTurnId(id);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto", force = false) => {
    const container = containerRef.current;
    if (!container) return;
    if (force) {
      programmaticScrollRef.current = false;
      if (programmaticTimerRef.current !== null) {
        window.clearTimeout(programmaticTimerRef.current);
        programmaticTimerRef.current = null;
      }
      nearBottomRef.current = true;
      userDetachedFromBottomRef.current = false;
    }
    if (userDetachedFromBottomRef.current) return;
    userDetachedFromBottomRef.current = false;
    nearBottomRef.current = true;
    const targetTop = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTo({
      top: targetTop,
      behavior,
    });
    if (behavior === "auto") {
      lastScrollTopRef.current = targetTop;
    }
  }, []);

  const clearAutoAnchor = useCallback(() => {
    if (autoAnchorTimerRef.current !== null) {
      window.clearTimeout(autoAnchorTimerRef.current);
      autoAnchorTimerRef.current = null;
    }
    autoAnchorRef.current = false;
  }, []);

  const detachFromBottomAutoFollow = useCallback(() => {
    const container = containerRef.current;
    // 用户的显式手势（滚轮/拖动）应能中断进行中的轮次跳转并夺回滚动控制。
    programmaticScrollRef.current = false;
    if (programmaticTimerRef.current !== null) {
      window.clearTimeout(programmaticTimerRef.current);
      programmaticTimerRef.current = null;
    }
    clearAutoAnchor();
    jumpInFlightRef.current = false;
    userDetachedFromBottomRef.current = true;
    nearBottomRef.current = false;
    if (container) {
      // Cancel any in-flight smooth/initial auto scroll so an explicit user
      // upward gesture cannot be pulled back to the bottom by a later layout
      // settle, ResizeObserver tick, or timeout from the initial history render.
      container.scrollTo({ top: container.scrollTop, behavior: "auto" });
      lastScrollTopRef.current = container.scrollTop;
    }
  }, [clearAutoAnchor]);

  const measureMessagesBelowViewport = useCallback((): number => {
    const container = containerRef.current;
    const messagesElement = messagesRef.current;
    if (!container || !messagesElement) return 0;

    const rows = messagesElement.children;
    if (rows.length === 0) return 0;

    const viewportBottom = container.getBoundingClientRect().top + container.clientHeight;
    const belowCount = countRowsBelowViewport(
      rows.length,
      (index) => rows[index].getBoundingClientRect().top >= viewportBottom,
    );
    const firstBelow = rows.length - belowCount;
    let count = 0;
    for (let index = firstBelow; index < rows.length; index += 1) {
      if (rows[index].hasAttribute("data-message-index")) count += 1;
    }
    return count;
  }, []);

  const scheduleJumpButtonUpdate = useCallback(() => {
    if (jumpFrameRef.current !== 0) return;
    jumpFrameRef.current = window.requestAnimationFrame(() => {
      jumpFrameRef.current = 0;
      const container = containerRef.current;
      if (!container) return;
      const bottomDistance = distanceFromBottom(
        container.scrollTop,
        container.scrollHeight,
        container.clientHeight,
      );
      if (jumpInFlightRef.current) {
        setJumpButton((previous) => (previous.visible ? { visible: false, count: 0 } : previous));
        return;
      }
      const visible = shouldShowJumpToBottom(
        userDetachedFromBottomRef.current,
        bottomDistance,
      );
      const count = visible ? measureMessagesBelowViewport() : 0;
      setJumpButton((previous) =>
        previous.visible === visible && previous.count === count
          ? previous
          : { visible, count },
      );
    });
  }, [measureMessagesBelowViewport]);

  const jumpToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const targetTop = Math.max(0, container.scrollHeight - container.clientHeight);
    scrollToBottom("smooth", true);
    jumpInFlightRef.current = true;
    programmaticScrollRef.current = true;
    programmaticTargetRef.current = targetTop;
    if (programmaticTimerRef.current !== null) {
      window.clearTimeout(programmaticTimerRef.current);
    }
    programmaticTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticTimerRef.current = null;
      jumpInFlightRef.current = false;
    }, 700);
    lastScrollTopRef.current = container.scrollTop;
    scheduleActiveTurnUpdate();
    setJumpButton({ visible: false, count: 0 });
  }, [scheduleActiveTurnUpdate, scrollToBottom]);

  useIsomorphicLayoutEffect(() => {
    scheduleJumpButtonUpdate();
  }, [scheduleJumpButtonUpdate, statusMessage, visibleMessages]);

  useEffect(() => {
    const knownIds = new Set(turnAnchors.map((turn) => turn.id));
    for (const id of Array.from(turnAnchorRefs.current.keys())) {
      if (!knownIds.has(id)) turnAnchorRefs.current.delete(id);
    }
  }, [turnAnchors]);

  useEffect(() => {
    if (turnAnchors.length < 2) {
      setActiveTurnId((previous) => previous === null ? previous : null);
      return;
    }

    const hasActive = activeTurnId != null && turnAnchors.some((turn) => turn.id === activeTurnId);
    if (hasActive && !nearBottomRef.current) return;

    const lastId = turnAnchors[turnAnchors.length - 1]?.id ?? null;
    setActiveTurnId((previous) => previous === lastId ? previous : lastId);
  }, [activeTurnId, turnAnchors]);

  useIsomorphicLayoutEffect(() => {
    const previousMessageCount = messageCountRef.current;
    const previousFirstMessageId = firstMessageIdRef.current;
    const previousLastUserMessageId = lastUserMessageIdRef.current;
    const nextFirstMessageId = visibleMessages[0]?.id;
    const nextLastUserMessageId = turnAnchors[turnAnchors.length - 1]?.id;
    const prependedEarlier =
      previousFirstMessageId !== undefined &&
      nextFirstMessageId !== undefined &&
      previousFirstMessageId !== nextFirstMessageId &&
      visibleMessages.some((message) => message.id === previousFirstMessageId);
    const sessionChanged =
      previousFirstMessageId !== undefined &&
      nextFirstMessageId !== undefined &&
      previousFirstMessageId !== nextFirstMessageId &&
      !prependedEarlier;
    const forceBottom = shouldForceBottomOnMessageChange(
      previousMessageCount,
      visibleMessages.length,
      sessionChanged,
      previousLastUserMessageId,
      nextLastUserMessageId,
    );

    messageCountRef.current = visibleMessages.length;
    firstMessageIdRef.current = nextFirstMessageId;
    lastUserMessageIdRef.current = nextLastUserMessageId;

    if (prependedEarlier) return;

    if (visibleMessages.length === 0) {
      nearBottomRef.current = true;
      userDetachedFromBottomRef.current = false;
      lastScrollTopRef.current = 0;
      return;
    }

    if (sessionChanged) {
      nearBottomRef.current = true;
      userDetachedFromBottomRef.current = false;
      lastScrollTopRef.current = 0;
    }

    const container = containerRef.current;
    if (!container || (!forceBottom && !nearBottomRef.current)) return;
    const initialHistoryRender = previousMessageCount === 0 || sessionChanged;
    // Bottom-follow must move synchronously. A smooth scroll targets the current
    // scrollHeight, but streaming can grow the message again before the animation
    // arrives; the intermediate scroll event then looks far from the bottom and
    // disables its own ResizeObserver follow-up even though the user never scrolled.
    scrollToBottom("auto", forceBottom);

    // 长会话里 Markdown、表格、代码块等内容会在本次提交后继续改变实际高度。
    // 初次进入历史会话时不要依赖一次平滑滚动，否则 WebKit/Tauri 里可能先滚到
    // 一个尚未稳定的中间位置，用户看到空白，手动滚动后才触发重绘。
    if (initialHistoryRender) {
      clearAutoAnchor();
      autoAnchorRef.current = true;
      window.requestAnimationFrame(() => {
        scrollToBottom("auto");
        window.requestAnimationFrame(() => scrollToBottom("auto"));
      });
      autoAnchorTimerRef.current = window.setTimeout(() => {
        if (userDetachedFromBottomRef.current) {
          autoAnchorRef.current = false;
          autoAnchorTimerRef.current = null;
          return;
        }
        scrollToBottom("auto");
        nearBottomRef.current = true;
        userDetachedFromBottomRef.current = false;
        autoAnchorRef.current = false;
        autoAnchorTimerRef.current = null;
      }, 650);
    }
  }, [clearAutoAnchor, scrollToBottom, statusMessage, turnAnchors, visibleMessages]);

  useEffect(() => {
    const container = containerRef.current;
    const messagesElement = messagesRef.current;
    if (!container || !messagesElement || typeof ResizeObserver === "undefined") return;

    let frame = 0;
    let lastContentHeight = -1;
    let lastViewportHeight = -1;
    const anchorToBottom = () => {
      frame = 0;
      scheduleJumpButtonUpdate();
      const scrollHeight = container.scrollHeight;
      const clientHeight = container.clientHeight;
      const bottomDistance = distanceFromBottom(container.scrollTop, scrollHeight, clientHeight);
      if (!shouldAnchorToBottom(
        userDetachedFromBottomRef.current,
        nearBottomRef.current,
        autoAnchorRef.current,
        bottomDistance,
      )) return;
      // 一次读（scrollHeight/clientHeight 已在上方读好）→ 一次写，写完后不再回读
      // scrollTop，避免每帧读-写-读交替触发强制布局。
      const targetTop = Math.max(0, scrollHeight - clientHeight);
      container.scrollTop = targetTop;
      lastScrollTopRef.current = targetTop;
    };
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const height = entry.contentRect.height;
        if (entry.target === messagesElement) {
          if (Math.abs(height - lastContentHeight) < BOTTOM_FOLLOW_EPSILON_PX) continue;
          lastContentHeight = height;
          changed = true;
        } else {
          if (Math.abs(height - lastViewportHeight) < BOTTOM_FOLLOW_EPSILON_PX) continue;
          lastViewportHeight = height;
          changed = true;
        }
      }
      if (!changed || frame !== 0) return;
      frame = window.requestAnimationFrame(anchorToBottom);
    });
    observer.observe(messagesElement);
    // composer 增高（多行输入 / 技能面板 / 附件托盘 / 上下文告警 / 队列面板等）会让滚动视口
    // 从底部变矮，但 .messages 内容高度不变、上面这个 observer 不会触发，导致最新内容被挤到
    // 视口下沿之外（看起来"藏在输入框后面"）。一并观察滚动容器自身：视口高度变化时也走
    // anchorToBottom 重新贴底——其守卫（userDetached / nearBottom）保证不会把已上滑的用户拽回。
    observer.observe(container);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [scheduleJumpButtonUpdate]);

  useEffect(() => {
    return () => {
      if (autoAnchorTimerRef.current !== null) {
        window.clearTimeout(autoAnchorTimerRef.current);
      }
      if (programmaticTimerRef.current !== null) {
        window.clearTimeout(programmaticTimerRef.current);
      }
      if (turnUpdateFrameRef.current !== 0) {
        window.cancelAnimationFrame(turnUpdateFrameRef.current);
        turnUpdateFrameRef.current = 0;
      }
      if (jumpFrameRef.current !== 0) {
        window.cancelAnimationFrame(jumpFrameRef.current);
        jumpFrameRef.current = 0;
      }
    };
  }, []);

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) {
      detachFromBottomAutoFollow();
    }
  };

  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;

    const scrollTop = container.scrollTop;

    // 轮次跳转动画进行中：不要把它当成用户上滑（否则会自取消）。到达目标后解除守卫。
    if (programmaticScrollRef.current) {
      lastScrollTopRef.current = scrollTop;
      if (Math.abs(scrollTop - programmaticTargetRef.current) <= 2) {
        programmaticScrollRef.current = false;
        jumpInFlightRef.current = false;
        if (programmaticTimerRef.current !== null) {
          window.clearTimeout(programmaticTimerRef.current);
          programmaticTimerRef.current = null;
        }
      }
      scheduleActiveTurnUpdate();
      scheduleJumpButtonUpdate();
      return;
    }

    const bottomDistance = distanceFromBottom(
      scrollTop,
      container.scrollHeight,
      container.clientHeight,
    );
    const scrollingUp = shouldDetachOnScroll(
      scrollTop,
      lastScrollTopRef.current,
      programmaticScrollRef.current,
    );

    if (scrollingUp) {
      detachFromBottomAutoFollow();
    } else if (autoAnchorRef.current && !userDetachedFromBottomRef.current) {
      nearBottomRef.current = true;
    } else {
      const next = resolveBottomFollowState(
        bottomDistance,
        userDetachedFromBottomRef.current,
      );
      nearBottomRef.current = next.nearBottom;
      userDetachedFromBottomRef.current = next.userDetachedFromBottom;
    }
    lastScrollTopRef.current = scrollTop;
    scheduleActiveTurnUpdate();
    scheduleJumpButtonUpdate();
  };

  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findActive, setFindActive] = useState(0);
  const [findTotal, setFindTotal] = useState(0);
  const [findSearchingEarlier, setFindSearchingEarlier] = useState(false);
  const [findReachedEarliest, setFindReachedEarliest] = useState(false);
  const findMatchesRef = useRef<FindMatch[]>([]);
  const findReturnFocusRef = useRef<HTMLElement | null>(null);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
    setFindActive(0);
    setFindTotal(0);
    setFindSearchingEarlier(false);
    setFindReachedEarliest(false);
    findMatchesRef.current = [];
    clearFindHighlights();
    const target = findReturnFocusRef.current;
    findReturnFocusRef.current = null;
    if (target && target.isConnected) target.focus({ preventScroll: true });
  }, []);

  const openFind = useCallback(() => {
    const active = document.activeElement;
    findReturnFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    setFindOpen(true);
  }, []);

  const changeFindQuery = useCallback((value: string) => {
    setFindQuery(value);
    setFindActive(0);
    setFindReachedEarliest(false);
    setFindSearchingEarlier(false);
  }, []);

  const stepFind = useCallback((delta: number) => {
    const total = findMatchesRef.current.length;
    if (total === 0) return;
    setFindActive((current) => (((current + delta) % total) + total) % total);
  }, []);

  const searchEarlierForFind = useCallback(() => {
    setFindSearchingEarlier(true);
  }, []);

  const revealFindMatch = useCallback((match: FindMatch) => {
    const container = containerRef.current;
    const node = match.node.parentElement;
    if (!container || !node) return;
    const containerRect = container.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    if (
      nodeRect.top >= containerRect.top + VISIBLE_MARGIN_PX &&
      nodeRect.bottom <= containerRect.bottom - VISIBLE_MARGIN_PX
    ) {
      return;
    }
    const offset =
      nodeRect.top - containerRect.top + nodeRect.height / 2 - container.clientHeight / 2;
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const targetTop = Math.min(Math.max(0, container.scrollTop + offset), maxTop);
    nearBottomRef.current =
      container.scrollHeight - targetTop - container.clientHeight < BOTTOM_FOLLOW_THRESHOLD_PX;
    userDetachedFromBottomRef.current = !nearBottomRef.current;
    programmaticScrollRef.current = true;
    programmaticTargetRef.current = targetTop;
    if (programmaticTimerRef.current !== null) {
      window.clearTimeout(programmaticTimerRef.current);
    }
    programmaticTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticTimerRef.current = null;
    }, 700);
    container.scrollTo({ top: targetTop, behavior: "smooth" });
    lastScrollTopRef.current = container.scrollTop;
    scheduleJumpButtonUpdate();
  }, [scheduleJumpButtonUpdate]);

  const handleFindShortcut = useCallback((event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    if (event.key.toLowerCase() !== "f") return;
    if (event.defaultPrevented) return;
    event.preventDefault();
    openFind();
  }, [openFind]);

  useEffect(() => {
    window.addEventListener("keydown", handleFindShortcut);
    return () => window.removeEventListener("keydown", handleFindShortcut);
  }, [handleFindShortcut]);

  useEffect(() => {
    if (!findOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeFind();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeFind, findOpen]);

  useIsomorphicLayoutEffect(() => {
    if (!findOpen) return;
    const matches = collectFindMatches(messagesRef.current, findQuery);
    findMatchesRef.current = matches;
    setFindTotal(matches.length);
    setFindActive((current) => (matches.length === 0 ? 0 : Math.min(current, matches.length - 1)));
  }, [findOpen, findQuery, visibleMessages]);

  useIsomorphicLayoutEffect(() => {
    if (!findOpen) {
      clearFindHighlights();
      return;
    }
    const matches = findMatchesRef.current;
    highlightFindMatches(matches, findActive);
    const activeMatch = matches[findActive];
    if (activeMatch) revealFindMatch(activeMatch);
  }, [findActive, findOpen, findQuery, findTotal, revealFindMatch, visibleMessages]);

  useEffect(() => {
    if (!findSearchingEarlier) return;
    if (findTotal > 0) {
      setFindSearchingEarlier(false);
      return;
    }
    if (!hasEarlier) {
      setFindSearchingEarlier(false);
      setFindReachedEarliest(true);
      return;
    }
    if (isLoadingEarlier || !onLoadEarlier) return;
    void onLoadEarlier();
  }, [findSearchingEarlier, findTotal, hasEarlier, isLoadingEarlier, onLoadEarlier]);

  useEffect(() => {
    if (!findOpen || hasEarlier) return;
    setFindReachedEarliest(true);
  }, [findOpen, hasEarlier]);

  const jumpLabel = jumpButton.count > 0
    ? `回到底部 · 下面还有 ${jumpButton.count} 条`
    : "回到底部";

  return (
    <div className={s.timelineRoot}>
      {findOpen ? (
        <FindBar
          query={findQuery}
          activeIndex={findActive}
          total={findTotal}
          hasEarlier={hasEarlier}
          searchingEarlier={findSearchingEarlier}
          reachedEarliest={findReachedEarliest}
          onChange={changeFindQuery}
          onPrev={() => stepFind(-1)}
          onNext={() => stepFind(1)}
          onClose={closeFind}
          onSearchEarlier={searchEarlierForFind}
        />
      ) : null}
      <div
        ref={containerRef}
        className={s.scroll}
        onWheel={handleWheel}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
      >
        {showTurnRail ? (
          <div className={s.turnRailWrap}>
            <nav className={s.turnRail} aria-label="对话轮次定位">
              {turnAnchors.map((turn) => {
                const active = turn.id === activeTurnId;
                return (
                  <button
                    key={turn.id}
                    type="button"
                    className={s.turnDot}
                    data-active={active ? "true" : undefined}
                    aria-current={active ? "step" : undefined}
                    aria-label={`定位到第 ${turn.index + 1} 轮对话`}
                    title={turn.title}
                    onClick={() => scrollToTurn(turn.id)}
                  />
                );
              })}
            </nav>
          </div>
        ) : null}
        <div ref={messagesRef} className={s.messages}>
          {loading ? <MessageSkeleton /> : null}
          {!loading && visibleMessages.length === 0 && !statusMessage ? (
            emptyGuide ? (
              <div className={s.empty}>{emptyGuide}</div>
            ) : (
              <div className={s.empty}>
                <div className={s.emptyTitle}>暂无对话记录</div>
                <div className={s.emptySub}>发送一条消息开始继续这个任务。</div>
              </div>
            )
          ) : null}

          {hiddenMessageCount > 0 || hasEarlier || isLoadingEarlier || loadEarlierError ? (
            <div className={s.earlierBar}>
              {loadEarlierError ? (
                <div className={s.earlierError} role="alert">
                  <span className={s.earlierErrorText}>加载更早的消息失败：{loadEarlierError.message}</span>
                  <button
                    type="button"
                    className={s.earlierAction}
                    onClick={loadEarlierMessages}
                    disabled={isLoadingEarlier}
                  >
                    重试
                  </button>
                </div>
              ) : null}
              {hiddenMessageCount > 0 ? (
                <button type="button" className={s.systemNoticeToggle} onClick={revealEarlierMessages}>
                  显示更早的 {Math.min(LONG_SESSION_EARLIER_BATCH, hiddenMessageCount)} 条消息
                  {onLoadEarlier ? "（已加载）" : ""}
                </button>
              ) : null}
              {hasEarlier ? (
                <button
                  type="button"
                  className={s.systemNoticeToggle}
                  onClick={loadEarlierMessages}
                  disabled={isLoadingEarlier}
                >
                  {isLoadingEarlier ? "加载中…" : "加载更早的消息"}
                </button>
              ) : earlierRequested ? (
                <span className={s.earlierEnd}>已到最早</span>
              ) : null}
            </div>
          ) : null}

          {windowedMessages.map((message, offset) => {
            const index = windowStart + offset;
            const previous = visibleMessages[index - 1];
            const showDate = !previous || formatDay(previous.createdAt) !== formatDay(message.createdAt);
            const isLast = index === visibleMessages.length - 1;
            const isUserTurn =
              message.role === "user" &&
              !isSkillInvocationText(message.text) &&
              !isKernelInjectedNotice(message.text);
            return (
              <div
                key={message.id}
                ref={isUserTurn ? (node) => setTurnAnchorNode(message.id, node) : undefined}
                data-turn-anchor={isUserTurn ? "true" : undefined}
                data-message-index={index}
              >
                {showDate ? <div className={s.dateSeparator}>{formatDay(message.createdAt)}</div> : null}
                <MessageBubble
                  message={message}
                  turnStartedAt={isLast ? turnStartedAt : undefined}
                  sessionUsage={isLast ? sessionUsage : undefined}
                  progressModel={isLast ? progressModel : undefined}
                  subagentSessionIds={subagentSessionIds}
                  speechStatus={speechState.messageId === message.id ? speechState.status : "idle"}
                  speechError={speechError?.messageId === message.id ? speechError.message : null}
                  onSpeak={handleSpeak}
                  onStop={stopSpeech}
                  retrySource={
                    message.role === "assistant" || (message.role === "system" && message.error)
                      ? precedingUserAsk(visibleMessages, index)
                      : null
                  }
                  onEditMessage={onEditMessage}
                  onRetryMessage={onRetryMessage}
                  onDeleteMessage={onDeleteMessage}
                  correctionLocked={correctionLocked}
                  correctionLockedReason={correctionLockedReason}
                  correctionPendingMessageId={correctionPendingMessageId}
                  onOpenSettings={onOpenSettings}
                />
              </div>
            );
          })}

          {statusMessage ? <div className={s.statusMessage}>{statusMessage}</div> : null}
          {trailing ? <div className={s.trailingSlot}>{trailing}</div> : null}
        </div>
      </div>
      {jumpButton.visible ? (
        <button
          type="button"
          className={s.jumpToBottom}
          onClick={jumpToBottom}
          aria-label={jumpLabel}
          title={jumpLabel}
        >
          <ArrowDown size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>{jumpLabel}</span>
        </button>
      ) : null}
    </div>
  );
}
