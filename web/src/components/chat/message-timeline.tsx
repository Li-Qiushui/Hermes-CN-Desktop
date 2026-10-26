import { createContext, Fragment, lazy, memo, Suspense, useCallback, useContext, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAtomValue } from "jotai";
import { AlertTriangle, ArrowDown, Bot, ChevronRight, FileDiff, Info, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { LoadingIndicator } from "@hermes/shared-ui";
import { showReasoningAtom } from "@/stores/ui";
import type { AssistantMessageStats, ChatMessage, ChatToolItem } from "./chat-types";
import { CliDelegationCard, entryFromChatTool } from "./cli-delegation-card";
import { DelegateRunCard } from "./delegate-run-card";
import { isDelegateToolName } from "./delegate-run-model";
import { useInlinePromptAnchor } from "./inline-prompt-flow";
import { cliDelegationsByToolIdAtom } from "@/stores/cli-delegations";
import { MediaBlock } from "./media-block";
import { MessageImage } from "./message-image";
import { MessageSkeleton } from "./message-skeleton";
import { MessageText } from "./message-text";
import { SkillInvocationMessage } from "./skill-invocation-message";
import { CopyButton } from "@/components/ui/copy-button";
import { ToolResultCard } from "./tool-result-card";
import { hasCopyableTools, messageRoundMarkdown, toolsMarkdown } from "./message-copy";
import {
  EMPTY_FIND_RESULT,
  FindBar,
  applyFindHighlight,
  buildFindIndex,
  clearFindHighlights,
  searchFindIndex,
} from "./find-in-conversation";
import { ErrorRecoveryActions, resolveErrorDisplayText } from "./error-recovery-actions";
import { buildToolResultView, isFileChangeToolInput, isKnownFileWriteTool, type FileChangeView } from "@/lib/tool-result-view";
import s from "./message-timeline.module.css";
import { groupElapsedMs, groupStatus } from "./group-tools";
import {
  disclosureKey,
  readDisclosureChoice,
  rememberDisclosureChoice,
} from "./activity-disclosure";
import { cachedGroupConsecutiveTools, cachedToolActivitySummary } from "./tool-cache";
import { resolveActivityAutoOpen, toolDisplayName } from "./tool-activity";
import { truncateMiddle } from "@/lib/truncate-middle";
import { isSkillInvocationText } from "@/lib/skill-invocation";
import { isKernelInjectedNotice, kernelNotice } from "@/lib/kernel-notice";
import { readUiValue } from "@/lib/ui-store";
import { STEER_NOTE, stripSteerWrapper } from "@/lib/steer-message";
import {
  formatDurationMs,
  formatElapsedTimer,
  formatTokPerSec,
  formatTokens,
} from "@/lib/format";
import type { SessionUsageResult } from "@hermes/protocol";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
/** 距底小于此值算「近底」：向下滚动进入这条带就重新贴底。 */
export const TRANSCRIPT_REPIN_THRESHOLD_PX = 48;
/** 非手势滚动的次像素容差；手势位移容差为 0（滚 1px 也算）。 */
export const TRANSCRIPT_SCROLL_ROUNDING_TOLERANCE_PX = 1;
/** 手势窗口：滚动事件落在这个窗口内才算用户操作，窗口外一律按程序/布局噪声处理。 */
export const TRANSCRIPT_SCROLL_GESTURE_WINDOW_MS = 200;
/** 切回会话后阅读位对齐窗口：期间内容高度变化反复重对齐。 */
export const TRANSCRIPT_READING_ALIGNMENT_WINDOW_MS = 1500;
const BOTTOM_FOLLOW_EPSILON_PX = 1;
const VISIBLE_MARGIN_PX = 12;
const LONG_SESSION_RENDER_THRESHOLD = 80;
const LONG_SESSION_INITIAL_WINDOW = 60;
const LONG_SESSION_EARLIER_BATCH = 40;
const EARLIER_AUTO_LOAD_TOP_PX = 240;

interface ToolRevealTarget {
  toolId: string;
  key: string;
}

const ToolRevealContext = createContext<ToolRevealTarget | null>(null);

export function toolRevealApplies(target: ToolRevealTarget | null, toolId: string | undefined): boolean {
  return Boolean(target && toolId && target.toolId === toolId);
}

export type { ToolRevealTarget };

interface MessageTimelineProps {
  messages: ChatMessage[];
  /** 会话 id：阅读位书签按会话记忆。不传则退回到「首条可见消息 id」。 */
  sessionId?: string;
  loading?: boolean;
  statusMessage?: string;
  turnStartedAt?: number;
  sessionUsage?: SessionUsageResult | null;
  progressModel?: string;
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

function distanceFromBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

export interface TranscriptScrollSample {
  scrollTop: number;
  lastScrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  wasPinned: boolean;
  /** 这次滚动是否发生在手势窗口（TRANSCRIPT_SCROLL_GESTURE_WINDOW_MS）内。 */
  gesturing: boolean;
}

export interface TranscriptScrollDecision {
  pinned: boolean;
  releasedFollow: boolean;
  repinned: boolean;
}

/**
 * 贴底跟随只有「真实手势」能解除：窗口外的滚动一律按程序/布局噪声处理，
 * 跟随状态原样保持（pinned 的继续贴底，未 pinned 的保持未 pinned）。
 */
export function reduceTranscriptScroll(sample: TranscriptScrollSample): TranscriptScrollDecision {
  if (!sample.gesturing) {
    return { pinned: sample.wasPinned, releasedFollow: false, repinned: false };
  }
  const distance = distanceFromBottom(sample.scrollTop, sample.scrollHeight, sample.clientHeight);
  const movedUp = sample.scrollTop < sample.lastScrollTop;
  const movedDown = sample.scrollTop > sample.lastScrollTop;
  if (movedUp && distance > 0) {
    return { pinned: false, releasedFollow: true, repinned: false };
  }
  const pinned = sample.wasPinned || (movedDown && distance < TRANSCRIPT_REPIN_THRESHOLD_PX);
  return { pinned, releasedFollow: false, repinned: pinned && !sample.wasPinned };
}

export function shouldAnchorToBottom(pinned: boolean, bottomDistance: number): boolean {
  if (!pinned) return false;
  return bottomDistance > BOTTOM_FOLLOW_EPSILON_PX;
}

const SCROLL_GESTURE_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
  "Spacebar",
]);

export function isScrollGestureKeystroke(key: string): boolean {
  return SCROLL_GESTURE_KEYS.has(key);
}

const INTERACTIVE_GESTURE_TAGS = new Set(["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT", "LABEL"]);

export function isInteractiveGestureTarget(
  target: { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown } | null,
): boolean {
  if (!target) return false;
  if (target.isContentEditable === true) return true;
  const tag = target.tagName?.toUpperCase();
  if (tag && INTERACTIVE_GESTURE_TAGS.has(tag)) return true;
  if (typeof target.closest === "function") {
    return target.closest("button, a, input, textarea, select, [contenteditable='true']") !== null;
  }
  return false;
}

export interface TranscriptReadingBookmark {
  /** 贴底时不记锚点行，回到该会话直接贴底。 */
  pinned: boolean;
  /** 视口顶部所在消息行（不是绝对 scrollTop，重排后仍能落回同一行）。 */
  messageId?: string;
  /** 行顶到视口顶的像素偏移。 */
  offset: number;
  scrollTop: number;
}

const readingBookmarks = new Map<string, TranscriptReadingBookmark>();

export function rememberTranscriptReadingBookmark(
  key: string | undefined,
  bookmark: TranscriptReadingBookmark,
): void {
  if (!key) return;
  readingBookmarks.set(key, bookmark);
}

export function readTranscriptReadingBookmark(
  key: string | undefined,
): TranscriptReadingBookmark | undefined {
  if (!key) return undefined;
  return readingBookmarks.get(key);
}

export function clearTranscriptReadingBookmarks(): void {
  readingBookmarks.clear();
}

export function transcriptRevealOwnership(
  bookmark: TranscriptReadingBookmark | undefined,
): "reading-position" | "pinned" {
  return bookmark && bookmark.pinned === false ? "reading-position" : "pinned";
}

const SHOW_REASONING_STORAGE_KEY = "hermes.show-reasoning";

/** 用户没动过「显示推理过程」开关时按默认开处理：有思考就显示（PI 的默认行为）。 */
export function resolveShowReasoning(setting: boolean, explicitlyStored: boolean): boolean {
  return explicitlyStored ? setting : true;
}

function hasStoredShowReasoningPreference(): boolean {
  return readUiValue<unknown>(SHOW_REASONING_STORAGE_KEY, undefined) !== undefined;
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

export function shouldShowJumpToBottom(pinned: boolean): boolean {
  return !pinned;
}

export function countUnreadSinceBaseline(visibleCount: number, baseline: number): number {
  return Math.max(0, visibleCount - baseline);
}

// 只有"用户主动上滑"才应脱离贴底跟随。程序触发的轮次跳转平滑滚动同样会让 scrollTop
// 递减，但绝不能被当成用户手势——否则会把自己的跳转动画硬取消掉。
export function shouldDetachOnScroll(
  scrollTop: number,
  lastScrollTop: number,
  programmaticScroll: boolean,
): boolean {
  if (programmaticScroll) return false;
  return scrollTop < lastScrollTop - TRANSCRIPT_SCROLL_ROUNDING_TOLERANCE_PX;
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

const ReasoningMarkdown = lazy(() =>
  import("./markdown-renderer").then((module) => ({ default: module.MarkdownText })),
);

function ReasoningBody({ text }: { text: string }) {
  const deferred = useDeferredValue(text);
  return (
    <div className={s.reasoningBody}>
      <Suspense fallback={null}>
        <ReasoningMarkdown text={deferred} streaming={false} />
      </Suspense>
    </div>
  );
}

function ReasoningBlock({
  text,
  streaming,
  choiceKey,
}: {
  text: string;
  streaming?: boolean;
  choiceKey?: string;
}) {
  const [choice, setChoice] = useState<boolean | undefined>(() => readDisclosureChoice(choiceKey));
  const open = choice ?? true;

  return (
    <div className={s.reasoning}>
      <button
        type="button"
        className={s.disclosure}
        onClick={() => {
          const next = !open;
          rememberDisclosureChoice(choiceKey, next);
          setChoice(next);
        }}
        data-open={open}
      >
        <ChevronRight className={s.chevron} size={14} strokeWidth={2} aria-hidden="true" />
        <span>{streaming ? "正在思考" : "推理过程"}</span>
      </button>
      {open ? <ReasoningBody text={text} /> : null}
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
        <ChevronRight className={s.chevron} size={14} strokeWidth={2} aria-hidden="true" />
        <span>{`参考模型 ${label}${position}`}</span>
      </button>
      {open ? <ReasoningBody text={text} /> : null}
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

function findMessageRow(root: HTMLElement | null, messageId: string): HTMLElement | null {
  if (!root) return null;
  return Array.from(root.querySelectorAll<HTMLElement>("[data-message-id]")).find(
    (row) => row.dataset.messageId === messageId,
  ) ?? null;
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
  const reveal = useContext(ToolRevealContext);
  const choiceKey = disclosureKey("tool", tool.tool_id);
  const [choice, setChoice] = useState<boolean | undefined>(() => readDisclosureChoice(choiceKey));
  const dismissedRevealRef = useRef<string | null>(null);
  const forced = toolRevealApplies(reveal, tool.tool_id) && dismissedRevealRef.current !== reveal?.key;
  const shown = (choice ?? false) || forced;
  const [elapsed, setElapsed] = useState(() =>
    tool.status === "running" ? Math.max(0, Date.now() - tool.startedAt) : 0,
  );

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
    <div className={s.toolCard} data-status={tool.status} data-tool-id={tool.tool_id}>
      <button
        type="button"
        className={s.toolHeader}
        onClick={() => {
          if (forced && shown) dismissedRevealRef.current = reveal?.key ?? null;
          const next = !shown;
          rememberDisclosureChoice(choiceKey, next);
          setChoice(next);
        }}
        aria-expanded={hasBody ? shown : undefined}
        data-open={shown}
        data-expandable={hasBody ? "true" : "false"}
      >
        <span className={s.toolStatusDot} data-status={tool.status} />
        <span className={s.toolName}>{toolDisplayName(tool.name)}</span>
        {tool.context ? (
          <span className={s.toolContext} title={tool.context}>
            {truncateMiddle(tool.context)}
          </span>
        ) : null}
        {elapsedLabel ? <span className={s.toolElapsed}>{elapsedLabel}</span> : null}
      </button>
      {tool.status === "error" && !shown && tool.error ? (
        <div className={s.toolActivityError}>{tool.error}</div>
      ) : null}
      {shown && hasBody ? (
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
  const reveal = useContext(ToolRevealContext);
  const head = tools[0];
  const status = groupStatus(tools);
  const choiceKey = disclosureKey("group", head?.tool_id);
  const [choice, setChoice] = useState<boolean | undefined>(() => readDisclosureChoice(choiceKey));
  const forced = tools.some((tool) => toolRevealApplies(reveal, tool.tool_id));
  const shown = (choice ?? false) || forced;
  const elapsedLabel = formatToolElapsed(groupElapsedMs(tools));

  return (
    <div className={s.toolCard} data-status={status}>
      <div className={s.toolHeadRow}>
        <button
          type="button"
          className={s.toolHeader}
          onClick={() => {
            const next = !shown;
            rememberDisclosureChoice(choiceKey, next);
            setChoice(next);
          }}
          aria-expanded={shown}
          data-open={shown}
        >
          <ChevronRight className={s.toolChevron} size={14} strokeWidth={2} aria-hidden="true" />
          <span className={s.toolStatusDot} data-status={status} />
          <span className={s.toolName}>{toolDisplayName(head.name)}</span>
          {head.context ? (
            <span className={s.toolContext} title={head.context}>
              {truncateMiddle(head.context)}
            </span>
          ) : null}
          <span className={s.toolBadge}>×{tools.length}</span>
          {elapsedLabel ? <span className={s.toolElapsed}>{elapsedLabel}</span> : null}
        </button>
        <CopyButton
          className={s.toolCopy}
          text={() => toolsMarkdown(tools)}
          copiedLabel="已复制"
          showStatusIcon={false}
        >
          复制组
        </CopyButton>
      </div>
      {shown ? (
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
  const reveal = useContext(ToolRevealContext);
  const hasRunning = tools.some((tool) => tool.status === "running");
  const forced = tools.some((tool) => toolRevealApplies(reveal, tool.tool_id));
  const choiceKey = disclosureKey("activity", tools[0]?.tool_id);
  const [choice, setChoice] = useState<boolean | undefined>(() => readDisclosureChoice(choiceKey));
  const [now, setNow] = useState(() => Date.now());
  const automatic = resolveActivityAutoOpen({ live: hasRunning, itemCount: tools.length });
  const shown = (choice ?? automatic) || forced;

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
    <div className={s.toolActivity} data-status={summary.status} data-interrupted={summary.interrupted ? "true" : undefined}>
      <button
        type="button"
        className={s.toolActivitySummary}
        onClick={() => {
          const next = !shown;
          rememberDisclosureChoice(choiceKey, next);
          setChoice(next);
        }}
        aria-expanded={shown}
        data-open={shown}
      >
        <ChevronRight
          className={s.toolActivityChevron}
          size={16}
          strokeWidth={2.25}
          aria-hidden="true"
        />
        <span className={s.toolStatusDot} data-status={summary.status} />
        <span
          className={s.toolActivityLabel}
          data-interrupted={summary.interrupted ? "true" : undefined}
        >
          {summary.label}
        </span>
        {summary.meta ? <span className={s.toolActivityMeta}>{summary.meta}</span> : null}
        {elapsedLabel ? (
          <span className={s.toolElapsed}>
            {summary.interrupted ? `· ${elapsedLabel}` : elapsedLabel}
          </span>
        ) : null}
      </button>
      {summary.error && !shown ? (
        <div className={s.toolActivityError}>{summary.error}</div>
      ) : null}
      {shown ? (
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
  const showReasoningSetting = useAtomValue(showReasoningAtom);
  const showReasoning = resolveShowReasoning(showReasoningSetting, hasStoredShowReasoningPreference());
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

    if (block.type === "media") {
      items.push(
        <div key={`media-${index}`} className={s.mediaBlock}>
          <MediaBlock items={block.items} />
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
    if (!block.text.trim()) return;

    items.push(
      <ReasoningBlock
        key={`reasoning-${index}`}
        text={block.text}
        streaming={streaming && index === blocks.length - 1}
        choiceKey={disclosureKey("thinking", message.id, index)}
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
  return stripSteerWrapper(message.text).text.trim() || undefined;
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
    const steer = stripSteerWrapper(candidate.text);
    return steer.steer ? { ...candidate, text: steer.text } : candidate;
  }
  return null;
}

interface MessageBubbleProps {
  message: ChatMessage;
  turnStartedAt?: number;
  sessionUsage?: SessionUsageResult | null;
  progressModel?: string;
  subagentSessionIds?: readonly (string | undefined)[];
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
  retrySource,
  onEditMessage,
  onRetryMessage,
  onDeleteMessage,
  correctionLocked = false,
  correctionLockedReason,
  correctionPendingMessageId = null,
  onOpenSettings,
}: MessageBubbleProps) {
  const showReasoningSetting = useAtomValue(showReasoningAtom);
  const showReasoning = resolveShowReasoning(showReasoningSetting, hasStoredShowReasoningPreference());
  const isUser = message.role === "user";
  const isToolOnly = message.role === "tool";
  const isSystem = message.role === "system";
  const streaming = message.status === "streaming";
  const copyable = copyableMessageText(message);
  const roundCopyable = hasCopyableTools(message);
  const hasBlocks = !isUser && Boolean(message.blocks?.length);
  const hasSkillInvocation = isSkillInvocationText(message.text);
  const kernel = kernelNotice(message.text);
  const steer = isUser ? stripSteerWrapper(message.text) : null;
  const displayMessage = steer?.steer ? { ...message, text: steer.text } : message;
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
    <div className={s.messageRow} data-role={isUser ? "user" : "assistant"} data-steer={steer?.steer ? "true" : undefined}>
      <div className={s.messageContent}>
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
              {steer?.steer ? (
                <div className={s.steerNote} data-steer-note="true">
                  {STEER_NOTE}
                </div>
              ) : null}
              {displayMessage.text ? <MessageText text={displayMessage.text} streaming={streaming} /> : null}
              {message.media?.length ? (
                <div className={s.mediaBlock}>
                  <MediaBlock items={message.media} />
                </div>
              ) : null}
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
              {showReasoning && message.reasoning?.trim() ? (
                <ReasoningBlock
                  text={message.reasoning}
                  streaming={streaming && !message.text}
                  choiceKey={disclosureKey("thinking", message.id)}
                />
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
            {roundCopyable ? (
              <CopyButton
                className={s.messageAction}
                text={() => messageRoundMarkdown(displayMessage)}
                showStatusIcon={false}
                title="复制这一轮的全部内容（含工具摘要）"
              >
                复制整轮
              </CopyButton>
            ) : null}
            {canEdit ? (
              <button
                type="button"
                className={`${s.messageAction} ${s.messageCorrectAction}`}
                onClick={() => onEditMessage?.(displayMessage)}
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
  sessionId,
}: MessageTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const turnAnchorRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pinnedRef = useRef(true);
  const lastGestureAtRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const alignTargetRef = useRef<{ messageId: string; offset: number } | null>(null);
  const alignUntilRef = useRef(0);
  const restorePendingRef = useRef(true);
  const visibleCountRef = useRef(0);
  const unreadBaselineRef = useRef(0);
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
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [jumpButton, setJumpButton] = useState<{ visible: boolean; unread: number }>({
    visible: false,
    unread: 0,
  });
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (message) =>
          message.text ||
          message.reasoning ||
          message.images?.length ||
          message.media?.length ||
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
  const bookmarkKey = sessionId ?? visibleMessages[0]?.id;

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
  const autoEarlierKeyRef = useRef("");

  const loadEarlierMessages = useCallback(() => {
    if (!onLoadEarlier || isLoadingEarlier || !hasEarlier) return;
    const node = firstRenderedRow();
    revealEarlierRef.current = node ? { node, top: node.getBoundingClientRect().top } : null;
    setEarlierRequested(true);
    void onLoadEarlier();
  }, [firstRenderedRow, hasEarlier, isLoadingEarlier, onLoadEarlier]);

  const requestEarlier = useCallback(
    (source: "auto" | "button") => {
      if (hiddenMessageCount > 0) {
        if (source === "auto") {
          const key = `local:${hiddenMessageCount}:${visibleMessages.length}`;
          if (autoEarlierKeyRef.current === key) return;
          autoEarlierKeyRef.current = key;
        }
        revealEarlierMessages();
        return;
      }
      if (!hasEarlier) return;
      if (source === "auto") {
        const key = `page:${visibleMessages.length}`;
        if (autoEarlierKeyRef.current === key) return;
        autoEarlierKeyRef.current = key;
      }
      loadEarlierMessages();
    },
    [hasEarlier, hiddenMessageCount, loadEarlierMessages, revealEarlierMessages, visibleMessages.length],
  );

  useIsomorphicLayoutEffect(() => {
    const pending = revealEarlierRef.current;
    const container = containerRef.current;
    if (!pending || !container) return;
    revealEarlierRef.current = null;
    const shift = pending.node.getBoundingClientRect().top - pending.top;
    if (shift === 0) return;
    container.scrollTop += shift;
    lastScrollTopRef.current = container.scrollTop;
  }, [windowStart, visibleMessages.length]);

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

    alignTargetRef.current = null;
    alignUntilRef.current = 0;

    const containerRect = container.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const top = container.scrollTop + nodeRect.top - containerRect.top - 12;
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const targetTop = Math.min(Math.max(0, top), maxTop);
    pinnedRef.current = container.scrollHeight - targetTop - container.clientHeight < TRANSCRIPT_REPIN_THRESHOLD_PX;
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
    }
    if (!pinnedRef.current && !force) return;
    pinnedRef.current = true;
    alignTargetRef.current = null;
    alignUntilRef.current = 0;
    const targetTop = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTo({
      top: targetTop,
      behavior,
    });
    if (behavior === "auto") {
      lastScrollTopRef.current = targetTop;
    }
  }, []);

  const detachFromBottomFollow = useCallback(() => {
    const container = containerRef.current;
    // 用户的显式手势（滚轮/拖动）应能中断进行中的轮次跳转并夺回滚动控制。
    programmaticScrollRef.current = false;
    if (programmaticTimerRef.current !== null) {
      window.clearTimeout(programmaticTimerRef.current);
      programmaticTimerRef.current = null;
    }
    jumpInFlightRef.current = false;
    pinnedRef.current = false;
    alignTargetRef.current = null;
    alignUntilRef.current = 0;
    unreadBaselineRef.current = visibleCountRef.current;
    if (container) {
      // Cancel any in-flight smooth/initial auto scroll so an explicit user
      // upward gesture cannot be pulled back to the bottom by a later layout
      // settle, ResizeObserver tick, or timer from the initial history render.
      container.scrollTo({ top: container.scrollTop, behavior: "auto" });
      lastScrollTopRef.current = container.scrollTop;
    }
  }, []);

  const publishJumpButton = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (jumpInFlightRef.current) {
      setJumpButton((previous) => (previous.visible ? { visible: false, unread: 0 } : previous));
      return;
    }
    const visible = shouldShowJumpToBottom(pinnedRef.current);
    const unread = visible ? countUnreadSinceBaseline(visibleCountRef.current, unreadBaselineRef.current) : 0;
    setJumpButton((previous) =>
      previous.visible === visible && previous.unread === unread
        ? previous
        : { visible, unread },
    );
  }, []);

  const scheduleJumpButtonUpdate = useCallback(() => {
    if (jumpFrameRef.current !== 0) return;
    jumpFrameRef.current = window.requestAnimationFrame(() => {
      jumpFrameRef.current = 0;
      publishJumpButton();
    });
  }, [publishJumpButton]);

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
    unreadBaselineRef.current = visibleCountRef.current;
    scheduleActiveTurnUpdate();
    setJumpButton({ visible: false, unread: 0 });
  }, [scheduleActiveTurnUpdate, scrollToBottom]);

  const applyReadingPosition = useCallback((): boolean => {
    const container = containerRef.current;
    const target = alignTargetRef.current;
    if (!container || !target) return false;
    const row = findMessageRow(messagesRef.current, target.messageId);
    if (!row) return false;
    const delta = row.getBoundingClientRect().top - container.getBoundingClientRect().top - target.offset;
    if (Math.abs(delta) > 0.5) container.scrollTop += delta;
    lastScrollTopRef.current = container.scrollTop;
    return true;
  }, []);

  const restoreReadingPosition = useCallback((): boolean => {
    const bookmark = readTranscriptReadingBookmark(bookmarkKey);
    if (transcriptRevealOwnership(bookmark) !== "reading-position" || !bookmark) return false;
    const container = containerRef.current;
    pinnedRef.current = false;
    alignTargetRef.current = bookmark.messageId
      ? { messageId: bookmark.messageId, offset: bookmark.offset }
      : null;
    alignUntilRef.current = performance.now() + TRANSCRIPT_READING_ALIGNMENT_WINDOW_MS;
    if (applyReadingPosition()) {
      scheduleJumpButtonUpdate();
      return true;
    }
    // 行还没挂上：退回绝对 scrollTop，连它都不可用时交给贴底。
    alignTargetRef.current = null;
    alignUntilRef.current = 0;
    if (!container || !Number.isFinite(bookmark.scrollTop) || bookmark.scrollTop <= 0) return false;
    container.scrollTop = bookmark.scrollTop;
    lastScrollTopRef.current = container.scrollTop;
    scheduleJumpButtonUpdate();
    return true;
  }, [applyReadingPosition, bookmarkKey, scheduleJumpButtonUpdate]);

  const captureReadingBookmark = useCallback(() => {
    const container = containerRef.current;
    const root = messagesRef.current;
    if (!container || !root || container.scrollHeight === 0) return;
    if (pinnedRef.current) {
      rememberTranscriptReadingBookmark(bookmarkKey, {
        pinned: true,
        offset: 0,
        scrollTop: container.scrollTop,
      });
      return;
    }
    const containerTop = container.getBoundingClientRect().top;
    for (const row of Array.from(root.querySelectorAll<HTMLElement>("[data-message-id]"))) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= containerTop + 0.5) continue;
      const messageId = row.dataset.messageId;
      if (!messageId) continue;
      rememberTranscriptReadingBookmark(bookmarkKey, {
        pinned: false,
        messageId,
        offset: rect.top - containerTop,
        scrollTop: container.scrollTop,
      });
      return;
    }
    rememberTranscriptReadingBookmark(bookmarkKey, {
      pinned: false,
      offset: 0,
      scrollTop: container.scrollTop,
    });
  }, [bookmarkKey]);

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
    if (hasActive && !pinnedRef.current) return;

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
    visibleCountRef.current = visibleMessages.length;
    firstMessageIdRef.current = nextFirstMessageId;
    lastUserMessageIdRef.current = nextLastUserMessageId;

    if (prependedEarlier) return;

    if (visibleMessages.length === 0) {
      pinnedRef.current = true;
      restorePendingRef.current = true;
      lastScrollTopRef.current = 0;
      return;
    }

    if (sessionChanged) restorePendingRef.current = true;

    if (restorePendingRef.current) {
      restorePendingRef.current = false;
      if (restoreReadingPosition()) return;
      pinnedRef.current = true;
    }

    const container = containerRef.current;
    if (!container || (!forceBottom && !pinnedRef.current)) return;
    const firstCommit = previousMessageCount === 0;
    // Bottom-follow must move synchronously. A smooth scroll targets the current
    // scrollHeight, but streaming can grow the message again before the animation
    // arrives; the intermediate scroll event then looks far from the bottom and
    // disables its own ResizeObserver follow-up even though the user never scrolled.
    scrollToBottom("auto", forceBottom);

    // 长会话里 Markdown、表格、代码块等内容会在本次提交后继续改变实际高度。
    // 首次提交后再补两帧贴底（每一帧都先看 pinned：用户在这两帧里上滚了就尊重他），
    // 不再用固定毫秒窗口兜底，避免把用户的上滑顶回去。
    if (firstCommit) {
      window.requestAnimationFrame(() => {
        if (!pinnedRef.current) return;
        scrollToBottom("auto");
        window.requestAnimationFrame(() => {
          if (pinnedRef.current) scrollToBottom("auto");
        });
      });
    }
  }, [restoreReadingPosition, scrollToBottom, statusMessage, turnAnchors, visibleMessages]);

  useEffect(() => {
    const container = containerRef.current;
    const messagesElement = messagesRef.current;
    if (!container || !messagesElement || typeof ResizeObserver === "undefined") return;

    let frame = 0;
    let lastContentHeight = -1;
    let lastViewportHeight = -1;
    const anchorToBottom = () => {
      frame = 0;
      // 阅读位对齐窗口内：内容还在长（图片/代码块迟到），反复把锚点行顶回去，
      // 而不是贴底——否则切回会话时用户正读的那一行会被新内容挤走。
      if (alignTargetRef.current && performance.now() < alignUntilRef.current && applyReadingPosition()) {
        scheduleJumpButtonUpdate();
        return;
      }
      scheduleJumpButtonUpdate();
      const scrollHeight = container.scrollHeight;
      const clientHeight = container.clientHeight;
      const bottomDistance = distanceFromBottom(container.scrollTop, scrollHeight, clientHeight);
      if (!shouldAnchorToBottom(pinnedRef.current, bottomDistance)) return;
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
  }, [applyReadingPosition, scheduleJumpButtonUpdate]);

  useEffect(() => {
    return () => {
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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // 只认「真能滚这个容器」的输入：滚轮有纵向位移、指针落在滚动面上而不是
    // 按钮/输入框、键盘是滚动键且焦点不在可编辑元素里。命中即刷新手势时间戳。
    const markGesture = () => {
      lastGestureAtRef.current = performance.now();
      if (alignTargetRef.current) {
        alignTargetRef.current = null;
        alignUntilRef.current = 0;
      }
    };
    const onWheel = (event: globalThis.WheelEvent) => {
      if (event.deltaY !== 0) markGesture();
    };
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (!isInteractiveGestureTarget(event.target as HTMLElement | null)) markGesture();
    };
    const onTouchStart = () => markGesture();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!isScrollGestureKeystroke(event.key)) return;
      if (isInteractiveGestureTarget(event.target as HTMLElement | null)) return;
      markGesture();
    };
    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("pointerdown", onPointerDown, { passive: true });
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchStart, { passive: true });
    document.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchStart);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

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

    const now = performance.now();
    const gesturing = now - lastGestureAtRef.current <= TRANSCRIPT_SCROLL_GESTURE_WINDOW_MS;
    const decision = reduceTranscriptScroll({
      scrollTop,
      lastScrollTop: lastScrollTopRef.current,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      wasPinned: pinnedRef.current,
      gesturing,
    });

    if (decision.releasedFollow) {
      detachFromBottomFollow();
    } else {
      pinnedRef.current = decision.pinned;
    }
    lastScrollTopRef.current = scrollTop;
    captureReadingBookmark();
    scheduleActiveTurnUpdate();
    scheduleJumpButtonUpdate();
    if (
      scrollTop <= EARLIER_AUTO_LOAD_TOP_PX &&
      !pinnedRef.current &&
      !jumpInFlightRef.current
    ) {
      requestEarlier("auto");
    }
  };

  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findActive, setFindActive] = useState(0);
  const [findSearchingEarlier, setFindSearchingEarlier] = useState(false);
  const [findReachedEarliest, setFindReachedEarliest] = useState(false);
  const findReturnFocusRef = useRef<HTMLElement | null>(null);
  const findIndex = useMemo(
    () => (findOpen ? buildFindIndex(visibleMessages) : null),
    [findOpen, visibleMessages],
  );
  const findResult = useMemo(
    () => (findIndex ? searchFindIndex(findIndex, findQuery) : EMPTY_FIND_RESULT),
    [findIndex, findQuery],
  );
  const findHits = findResult.hits;
  const findTotal = findHits.length;
  const activeHit = findActive >= 0 && findActive < findTotal ? findHits[findActive] : undefined;
  const findRevealKey = activeHit
    ? `${activeHit.messageId}:${activeHit.toolId ?? ""}:${activeHit.field}:${activeHit.ordinal}`
    : "";
  const toolReveal = useMemo<ToolRevealTarget | null>(
    () => (activeHit?.toolId ? { toolId: activeHit.toolId, key: findRevealKey } : null),
    [activeHit, findRevealKey],
  );

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
    setFindActive(0);
    setFindSearchingEarlier(false);
    setFindReachedEarliest(false);
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

  const stepFind = useCallback(
    (delta: number) => {
      if (findTotal === 0) return;
      setFindActive((current) => (((current + delta) % findTotal) + findTotal) % findTotal);
    },
    [findTotal],
  );

  const searchEarlierForFind = useCallback(() => {
    setFindSearchingEarlier(true);
  }, []);

  const revealFindNode = useCallback(
    (node: HTMLElement) => {
      const container = containerRef.current;
      if (!container) return;
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
      pinnedRef.current =
        container.scrollHeight - targetTop - container.clientHeight < TRANSCRIPT_REPIN_THRESHOLD_PX;
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
    },
    [scheduleJumpButtonUpdate],
  );

  const revealMessageNode = useCallback(
    (messageId: string) => {
      const root = messagesRef.current;
      if (!root) return;
      const node = Array.from(root.querySelectorAll<HTMLElement>("[data-message-id]")).find(
        (element) => element.getAttribute("data-message-id") === messageId,
      );
      if (node) revealFindNode(node);
    },
    [revealFindNode],
  );

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
    if (findActive < findTotal) return;
    setFindActive(findTotal === 0 ? 0 : findTotal - 1);
  }, [findActive, findTotal]);

  useIsomorphicLayoutEffect(() => {
    if (!findOpen || !activeHit) return;
    if (activeHit.messageIndex >= windowStart) return;
    setRenderWindow({
      sessionKey,
      start: Math.max(0, activeHit.messageIndex - LONG_SESSION_EARLIER_BATCH),
    });
  }, [activeHit, findOpen, sessionKey, windowStart]);

  useIsomorphicLayoutEffect(() => {
    if (!findOpen || !activeHit) {
      clearFindHighlights();
      return;
    }
    if (activeHit.messageIndex < windowStart) return;
    const root = messagesRef.current;
    if (!root) return;
    let ordinal = 0;
    for (let index = 0; index < findActive; index += 1) {
      const hit = findHits[index];
      if (hit.messageId !== activeHit.messageId) continue;
      if (activeHit.toolId && hit.toolId !== activeHit.toolId) continue;
      ordinal += 1;
    }
    const target = { messageId: activeHit.messageId, toolId: activeHit.toolId, ordinal };
    const apply = (reveal: boolean) => {
      const match = applyFindHighlight(root, findQuery, target);
      if (!reveal) return;
      if (match?.node.parentElement) {
        revealFindNode(match.node.parentElement);
        return;
      }
      revealMessageNode(activeHit.messageId);
    };
    apply(true);
    // 工具卡展开、代码高亮、markdown 重渲染都会换掉文本节点，上一次算出来的
    // Range 随之失效（界面上就是“命中但没高亮”）。跟着 DOM 变化再落一次。
    let timer: number | null = null;
    const reschedule = () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        apply(false);
      }, 0);
    };
    const Observer = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
    const observer = Observer ? new Observer(reschedule) : null;
    observer?.observe(root, { childList: true, characterData: true, subtree: true });
    return () => {
      observer?.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [
    activeHit,
    findActive,
    findHits,
    findOpen,
    findQuery,
    revealFindNode,
    revealMessageNode,
    windowStart,
  ]);

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

  const jumpLabel = jumpButton.unread > 0
    ? `跳到最新 · ${jumpButton.unread} 条新消息`
    : "跳到最新";

  return (
    <ToolRevealContext.Provider value={toolReveal}>
      <div className={s.timelineRoot}>
        {findOpen ? (
          <FindBar
            query={findQuery}
            activeIndex={findTotal === 0 ? 0 : findActive}
            total={findTotal}
            truncated={findResult.truncated}
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

            {hiddenMessageCount > 0 || hasEarlier || isLoadingEarlier || earlierRequested || loadEarlierError ? (
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
                {hiddenMessageCount > 0 || hasEarlier || isLoadingEarlier ? (
                  <button
                    type="button"
                    className={s.systemNoticeToggle}
                    data-earlier-mode={hiddenMessageCount > 0 ? "local" : "server"}
                    onClick={() => requestEarlier("button")}
                    disabled={hiddenMessageCount === 0 && isLoadingEarlier}
                  >
                    {hiddenMessageCount > 0
                      ? `显示更早的 ${Math.min(LONG_SESSION_EARLIER_BATCH, hiddenMessageCount)} 条消息`
                      : isLoadingEarlier
                        ? "加载中…"
                        : "加载更早的消息"}
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
                  data-message-id={message.id}
                  data-message-index={index}
                >
                  {showDate ? <div className={s.dateSeparator}>{formatDay(message.createdAt)}</div> : null}
                  <MessageBubble
                    message={message}
                    turnStartedAt={isLast ? turnStartedAt : undefined}
                    sessionUsage={isLast ? sessionUsage : undefined}
                    progressModel={isLast ? progressModel : undefined}
                    subagentSessionIds={subagentSessionIds}
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
            <ArrowDown size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>{jumpLabel}</span>
          </button>
        ) : null}
      </div>
    </ToolRevealContext.Provider>
  );
}
