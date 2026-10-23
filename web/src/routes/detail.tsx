import { useEffect, useMemo, useCallback, useRef, useState, type CSSProperties } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Bot, Check, Copy, PanelRight } from "lucide-react";
import {
  activeSessionIdAtom,
  assistantDisplayNameAtom,
  conversationFontSizeAtom,
  conversationFontSizeVars,
  conversationWidthMaxWidth,
  conversationWidthModeAtom,
  rightRailVisibleAtom,
  sessionTipRedirectAtom,
} from "@/stores/ui";
import { pickTipRedirect } from "@/lib/session-tip-redirect";
import {
  appendNoticeAtom,
  recoverCompletedTurnFromStoredMessagesAtom,
} from "@/stores/chat";
import { useSession, useSessionMessages, useSessions } from "@/hooks/use-sessions";
import { useSkills } from "@/hooks/use-skills";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { useGateway } from "@/hooks/use-gateway";
import { useConfig, useModelInfo } from "@/hooks/use-config";
import { useModelOptions } from "@/hooks/use-model-options";
import { useComposerTimer } from "@/hooks/use-composer-timer";
import { useStallWatchdog } from "@/hooks/use-stall-watchdog";
import { useSessionResolution } from "@/hooks/use-session-resolution";
import { useSessionUsagePolling } from "@/hooks/use-session-usage-polling";
import { recordModelUsage } from "@/lib/model-usage-log";
import { readSessionModelOverride } from "@/lib/session-model-override";
import {
  composerDraftStorageKey,
  readComposerDraftByKey,
  writeComposerDraftByKey,
} from "@/lib/composer-drafts";
import { prepareComposerPrompt } from "@/lib/composer-prompt";
import { parseBuiltinComposerCommand } from "@/lib/builtin-commands";
import { resolveComposerSkillCommand } from "@/lib/composer-skills";
import { formatCompressNotice } from "@/lib/compress-feedback";
import { formatElapsedTimer } from "@/lib/format";
import { useSessionTurnStats } from "@/hooks/use-session-turn-stats";
import {
  buildComposerContextUsage,
  estimateRenderedContextTokens,
} from "@/lib/context-usage";
import { resolveModelContextWindow } from "@/lib/model-context";
import { reasoningEffortFromConfig, type ReasoningEffort } from "@/lib/reasoning-effort";
import { sessionDisplayTitle } from "@/lib/session-title";
import {
  readSessionTitleOverrides,
  subscribeSessionUiStateChanges,
} from "@/lib/session-ui-state";
import { isRemoteConnection, readFileDataUrl, readImageBytesFromPath, uploadAttachmentFile } from "@/lib/transport";
import { resumeFailureMessage, resumeWithRetry } from "@/lib/resume-retry";
import { getGatewayClient } from "@/lib/gateway-client";
import { classifyGatewayError } from "@/lib/gateway-result";
import { isMethodKnownUnsupported } from "@/lib/gateway-capabilities";
import { voiceAutoTtsFromConfig } from "@/lib/voice";
import {
  rememberSessionWorkspace,
  rememberWorkspaceProject,
  resolveSessionWorkspace,
  writeWorkspacePath,
} from "@/lib/workspaces";
import { TopBar, TopBarActionButton, TopBarActions } from "@/components/top-bar/top-bar";
import { GooseComposer } from "@/components/chat/goose-composer";
import { QueuePanel } from "@/components/composer/queue-panel";
import {
  enqueueQueuedPrompt,
  removeQueuedPrompt,
  shouldAutoDrainOnSettle,
  useQueuedPrompts,
  type QueuedPromptEntry,
} from "@/stores/composer-queue";
import type {
  ComposerModelSelection,
  ComposerSubmitControls,
  ComposerSubmitPayload,
} from "@/components/chat/composer-types";
import { MessageTimeline } from "@/components/chat/message-timeline";
import { InlinePromptFlow } from "@/components/chat/inline-prompt-flow";
import { StallNotice } from "@/components/chat/stall-notice";
import { ConfirmTruncateDialog, type TruncateDialogMode } from "@/components/chat/confirm-truncate-dialog";
import { EmptyChatGuide } from "@/components/chat/empty-chat-guide";
import { SubagentPanel, useSessionCliDelegations, useSessionSubagents } from "@/components/chat/subagent-panel";
import { SubagentOriginBar, useSubagentSessionOpener } from "@/components/chat/subagent-dialog";
import { PreviewRail } from "@/components/chat/preview-rail/preview-rail";
import { PREVIEW_PANEL_QUERY_KEY } from "@/lib/preview-rail";
import { activeCliDelegationCount, clearFinishedCliDelegationsAtom } from "@/stores/cli-delegations";
import { activeSubagentCount, clearFinishedSubagentsAtom } from "@/stores/subagents";
import {
  hermesUIMessagesToChatMessages,
  attachTurnStatsMetadata,
  mergeHermesUIMessages,
  messagesResponseToHermesUIMessages,
} from "@/components/chat/message-adapter";
import { stabilizeChatMessages } from "@/components/chat/message-stability";
import type { ChatMessage } from "@/components/chat/chat-types";
import type { HermesUIMessage, MessagesResponse } from "@hermes/protocol";

import s from "./detail.module.css";

interface ComposerPrefillState {
  text: string;
  nonce: number;
  sessionId?: string;
}

interface PendingEditTarget {
  rowId: number | null;
  text: string;
}

export function correctionTruncateRowId(messageId: string): number | null {
  const matched = /^stored-(\d+)$/.exec(messageId);
  if (!matched) return null;
  const rowId = Number(matched[1]);
  return Number.isSafeInteger(rowId) && rowId > 0 ? rowId : null;
}

const CORRECTION_TEXT_WHITESPACE = /\s+/g;

function normalizeCorrectionText(value: string | undefined): string {
  return (value ?? "").replace(CORRECTION_TEXT_WHITESPACE, " ").trim();
}

function correctionMessageText(message: HermesUIMessage): string {
  return normalizeCorrectionText(
    message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .filter((text) => text.length > 0)
      .join(" "),
  );
}

export interface CorrectionRowLookup {
  text: string;
  anchorText?: string;
}

export function locateStoredCorrectionRowId(
  messages: readonly HermesUIMessage[],
  lookup: CorrectionRowLookup,
): number | null {
  const target = normalizeCorrectionText(lookup.text);
  if (!target) return null;
  const matches: number[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "user") return;
    if (correctionMessageText(message) !== target) return;
    if (correctionTruncateRowId(message.id) === null) return;
    matches.push(index);
  });
  if (matches.length === 0) return null;
  const anchor = normalizeCorrectionText(lookup.anchorText);
  const rowIdAt = (index: number): number | null => correctionTruncateRowId(messages[index].id);
  if (!anchor) return rowIdAt(matches[matches.length - 1]);
  let anchorIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    if (correctionMessageText(message) !== anchor) continue;
    anchorIndex = index;
    break;
  }
  if (anchorIndex < 0) return matches.length === 1 ? rowIdAt(matches[0]) : null;
  let picked = -1;
  for (const index of matches) {
    if (index < anchorIndex) picked = index;
  }
  return picked < 0 ? null : rowIdAt(picked);
}

export interface CorrectionRowResolution {
  rowId: number | null;
  reloaded: boolean;
}

export async function resolveCorrectionRowId(params: {
  messageId: string;
  text: string;
  anchorText?: string;
  reload: () => Promise<MessagesResponse | undefined>;
}): Promise<CorrectionRowResolution> {
  const direct = correctionTruncateRowId(params.messageId);
  if (direct !== null) return { rowId: direct, reloaded: false };
  let response: MessagesResponse | undefined;
  try {
    response = await params.reload();
  } catch {
    response = undefined;
  }
  return {
    rowId: locateStoredCorrectionRowId(messagesResponseToHermesUIMessages(response), {
      text: params.text,
      anchorText: params.anchorText,
    }),
    reloaded: true,
  };
}

export type SubmitCorrectionOutcome = "sent" | "fallback" | "cancelled";

export function DetailRoute() {
  // URL drives the *initial* selection (deep links, browser back/forward),
  // but `activeSessionIdAtom` is the runtime source of truth. This lets
  // sidebar / history / panel clicks update the atom synchronously and
  // keeps async work (resumeSession, RPCs) from racing the route.
  // See issue #53.
  const { taskId: urlTaskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const [activeSessionId, setActiveId] = useAtom(activeSessionIdAtom);
  const [conversationWidthMode, setConversationWidthMode] = useAtom(conversationWidthModeAtom);
  const conversationFontSizeMode = useAtomValue(conversationFontSizeAtom);
  const assistantDisplayName = useAtomValue(assistantDisplayNameAtom);
  const [rightRailVisible, setRightRailVisible] = useAtom(rightRailVisibleAtom);
  const [searchParams] = useSearchParams();
  const taskId = activeSessionId ?? urlTaskId;
  const turnStats = useSessionTurnStats(taskId);

  const {
    resumeSession,
    sendPrompt,
    interruptSession,
    getSessionUsage,
    compressSession,
    getModelOptions,
    setSessionModel,
    setSessionReasoningEffort,
    dispatchCommand,
    completePath,
    attachImage,
    attachImageBytes,
    attachFile,
    detectDroppedPath,
  } = useGateway();
  const { data: config } = useConfig();
  const { data: modelInfo } = useModelInfo();
  const { data: modelOptionsCache } = useModelOptions();
  const skillsQuery = useSkills();
  const activeProfile = useActiveProfileName();
  const enabledSkills = useMemo(
    () => (skillsQuery.data ?? []).filter((skill) => skill.enabled),
    [skillsQuery.data],
  );
  const [selectedModel, setSelectedModel] = useState<ComposerModelSelection | null>(null);
  // 思考强度是全局配置（agent.reasoning_effort），不分会话；本地态仅用于
  // 选中后即时反馈，等 config 重新拉到后两者一致。null 表示尚未本地改过，
  // 以配置里的值为准（再读不到则回落到后端默认）。
  const [reasoningEffortOverride, setReasoningEffortOverride] = useState<ReasoningEffort | null>(null);
  const [sessionIdCopyState, setSessionIdCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [resumeFailure, setResumeFailure] = useState<{ message: string; sessionId: string } | null>(null);
  const [sessionTitleOverrides, setSessionTitleOverrides] = useState(readSessionTitleOverrides);
  const sessionIdCopyTimer = useRef<number | null>(null);
  const recoverCompletedTurnFromStoredMessages = useSetAtom(recoverCompletedTurnFromStoredMessagesAtom);
  const appendNotice = useSetAtom(appendNoticeAtom);

  const {
    restSessionId,
    activeMappedGatewaySessionId,
    runtimeSessionId,
    usageGatewaySessionId,
    runtime,
    runtimeIsBusy,
    isLiveSession,
  } = useSessionResolution(taskId);
  const [sessionUsage, setSessionUsage] = useSessionUsagePolling({
    gatewaySessionId: usageGatewaySessionId,
    restSessionId,
    runtimeIsBusy,
    getSessionUsage,
  });

  // 子代理监视（issue #238）：面板按会话 id 读取 subagent 树。store 按事件 session_id
  // (网关会话 id) keyed，故按 detail 解析出的多个候选 id 取首个命中（覆盖 resume 后
  // 持久 id / 网关 id 的形态差异）。
  const [subagentPanelOpen, setSubagentPanelOpen] = useState(false);
  // 候选 id 数组给「对话流内的 delegate 运行卡」当稳定引用用：每帧新建数组会
  // 让时间线里所有消息行的 memo 全部失效。
  const subagentSessionIds = useMemo(
    () => [runtimeSessionId, activeMappedGatewaySessionId, usageGatewaySessionId, taskId],
    [runtimeSessionId, activeMappedGatewaySessionId, usageGatewaySessionId, taskId],
  );
  const subagents = useSessionSubagents(subagentSessionIds);
  // 外部 CLI 委派（Claude Code / Codex，P-047）与内部子代理同面板展示。
  const cliDelegations = useSessionCliDelegations([
    runtimeSessionId,
    activeMappedGatewaySessionId,
    usageGatewaySessionId,
    taskId,
  ]);
  const subagentActive = activeSubagentCount(subagents) + activeCliDelegationCount(cliDelegations);
  const subagentTotal = subagents.length + cliDelegations.length;
  const clearFinishedSubagents = useSetAtom(clearFinishedSubagentsAtom);
  const clearFinishedCliDelegations = useSetAtom(clearFinishedCliDelegationsAtom);
  const clearFinishedDelegationRows = useCallback(() => {
    const candidates = [runtimeSessionId, activeMappedGatewaySessionId, usageGatewaySessionId, taskId];
    clearFinishedSubagents(candidates);
    clearFinishedCliDelegations(candidates);
  }, [
    activeMappedGatewaySessionId,
    clearFinishedCliDelegations,
    clearFinishedSubagents,
    runtimeSessionId,
    taskId,
    usageGatewaySessionId,
  ]);
  const { data: session } = useSession(restSessionId);
  const messagesQuery = useSessionMessages(restSessionId);
  const { data: messagesData, isLoading } = messagesQuery;
  const {
    hasMore: hasEarlierMessages,
    isLoadingEarlier: isLoadingEarlierMessages,
    loadEarlier: loadEarlierMessages,
    loadEarlierError: loadEarlierMessagesError,
  } = messagesQuery;
  const { data: sessionsData } = useSessions();
  const sessionData = session;
  const sessionSummary = sessionsData?.sessions.find(
    (item) => item.id === restSessionId || item.id === taskId,
  );
  const copyableSessionId = sessionData?.id ?? sessionSummary?.id ?? restSessionId ?? taskId ?? "";

  // Workspace bound to *this* session (#216): prefer the backend's stored cwd
  // (source of truth), then the client-side session→workspace map. Empty string
  // lets the composer fall back to its own default (last-used global workspace).
  const sessionWorkspace = useMemo(
    () => resolveSessionWorkspace(sessionData?.cwd ?? sessionSummary?.cwd, [restSessionId, taskId]),
    [sessionData?.cwd, sessionSummary?.cwd, restSessionId, taskId],
  );
  const composerDraftKey = useMemo(
    () => composerDraftStorageKey({
      kind: "session",
      sessionId: restSessionId ?? taskId,
      profile: activeProfile,
    }),
    [activeProfile, restSessionId, taskId],
  );
  const storedComposerDraft = useMemo(
    () => readComposerDraftByKey(composerDraftKey),
    [composerDraftKey],
  );
  const onComposerDraftChange = useCallback((text: string) => {
    writeComposerDraftByKey(composerDraftKey, text);
  }, [composerDraftKey]);

  // Sync URL → atom on mount and whenever URL changes (browser back/forward
  // or a deep-link entry). Sidebar / history clicks already update the atom
  // synchronously *before* navigating, so this only matters for the cases
  // where atom was empty/stale when this component mounted.
  useEffect(() => {
    if (urlTaskId && urlTaskId !== activeSessionId) setActiveId(urlTaskId);
  }, [urlTaskId, activeSessionId, setActiveId]);

  // ⌘B / Ctrl+B toggles the rich-preview right rail (issue #233). A ref holds
  // the latest visibility so the listener stays attached once.
  const railVisibleRef = useRef(rightRailVisible);
  railVisibleRef.current = rightRailVisible;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setRightRailVisible(!railVisibleRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setRightRailVisible]);

  // Deep link: arriving with ?panel=… opens the rail to that tab. Runs once so
  // a later manual close isn't fought by this effect.
  const didAutoOpenRail = useRef(false);
  useEffect(() => {
    if (didAutoOpenRail.current) return;
    didAutoOpenRail.current = true;
    if (searchParams.has(PREVIEW_PANEL_QUERY_KEY) && !railVisibleRef.current) {
      setRightRailVisible(true);
    }
  }, [searchParams, setRightRailVisible]);


  // Reset the user-selected model whenever the route changes to a different
  // session — otherwise the composer chip would carry over the previous
  // session's choice (or the global last-used model) instead of reflecting
  // this session's own model.
  //
  // Prefer a renderer-memory session-model override when present: that's
  // the path panel-composer uses to hand off the just-picked
  // model so detail doesn't briefly show the global default before the
  // backend round-trips back with the real session model.
  //
  // Don't delete the renderer-memory override here — StrictMode runs effects twice
  // (mount → unmount → mount) in dev, and an eager delete on the first run
  // means the second run reads nothing and clobbers selectedModel back to
  // null. The override map dies with the window; per-session-id keys never
  // collide, so leaving stale entries is safe.
  useEffect(() => {
    const override = taskId ? readSessionModelOverride(taskId) : null;
    setSelectedModel(override);
    setSessionUsage(null);
  }, [setSessionUsage, taskId]);

  useEffect(() => {
    return subscribeSessionUiStateChanges(() => {
      setSessionTitleOverrides(readSessionTitleOverrides());
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionIdCopyTimer.current !== null) {
        window.clearTimeout(sessionIdCopyTimer.current);
      }
    };
  }, []);

  const markSessionIdCopyState = useCallback((state: "copied" | "error") => {
    setSessionIdCopyState(state);
    if (sessionIdCopyTimer.current !== null) {
      window.clearTimeout(sessionIdCopyTimer.current);
    }
    sessionIdCopyTimer.current = window.setTimeout(() => {
      setSessionIdCopyState("idle");
      sessionIdCopyTimer.current = null;
    }, 2200);
  }, []);

  const copySessionId = useCallback(async () => {
    if (!copyableSessionId) return;
    try {
      await navigator.clipboard.writeText(copyableSessionId);
      markSessionIdCopyState("copied");
    } catch {
      markSessionIdCopyState("error");
    }
  }, [copyableSessionId, markSessionIdCopyState]);

  const ensureGatewaySession = useCallback(async (): Promise<string> => {
    if (!taskId) throw new Error("缺少会话 ID");
    if (restSessionId && !activeMappedGatewaySessionId) {
      // Old deep links can still use a gateway ID from a previous process.
      // Resolve that alias to its persistent ID before resuming, too.
      // No URL navigate after the resume — atom + gwSessionIdAtom hold
      // the authoritative state; downstream callers go through
      // resolveGatewaySessionId / resolvePersistentSessionId helpers
      // which understand both id shapes. The async navigate that used
      // to live here was the source of #52 (closure-stale replace
      // yanking the URL back to the previous session after rapid
      // switches). See #53 for the broader rework.
      setResumeFailure(null);
      try {
        return await resumeWithRetry(() => resumeSession(restSessionId));
      } catch (error) {
        setResumeFailure({ message: resumeFailureMessage(error), sessionId: restSessionId });
        throw error;
      }
    }
    return activeMappedGatewaySessionId ?? taskId;
  }, [activeMappedGatewaySessionId, restSessionId, resumeSession, taskId]);

  const retryResume = useCallback(async () => {
    try {
      await ensureGatewaySession();
    } catch {
      // 失败信息已经落在 resumeFailure，重试按钮保持可见
    }
  }, [ensureGatewaySession]);

  const editTargetRef = useRef<PendingEditTarget | null>(null);
  const chatMessagesRef = useRef<ChatMessage[]>([]);
  const [correctionResolvingId, setCorrectionResolvingId] = useState<string | null>(null);
  const correctionResolvingRef = useRef<string | null>(null);
  const [truncateConfirm, setTruncateConfirm] = useState<{
    removedCount: number | null;
    mode: TruncateDialogMode;
  } | null>(null);
  const truncateConfirmResolverRef = useRef<((confirmed: boolean) => void) | null>(null);

  const confirmTruncate = useCallback(
    (removedCount: number | null, mode: TruncateDialogMode = "resend") =>
      new Promise<boolean>((resolve) => {
        truncateConfirmResolverRef.current = resolve;
        setTruncateConfirm({ removedCount, mode });
      }),
    [],
  );

  const settleTruncateConfirm = useCallback((confirmed: boolean) => {
    const resolve = truncateConfirmResolverRef.current;
    truncateConfirmResolverRef.current = null;
    setTruncateConfirm(null);
    resolve?.(confirmed);
  }, []);

  useEffect(
    () => () => {
      truncateConfirmResolverRef.current?.(false);
      truncateConfirmResolverRef.current = null;
    },
    [],
  );

  const countRemovedAfterRow = useCallback((rowId: number): number | null => {
    const index = chatMessagesRef.current.findIndex((message) => message.id === `stored-${rowId}`);
    if (index < 0) return null;
    return chatMessagesRef.current
      .slice(index + 1)
      .filter((message) => message.role === "user" || message.role === "assistant").length;
  }, []);

  const refetchMessagesRef = useRef(messagesQuery.refetch);
  useEffect(() => {
    refetchMessagesRef.current = messagesQuery.refetch;
  }, [messagesQuery.refetch]);

  const reloadStoredMessages = useCallback(async (): Promise<MessagesResponse | undefined> => {
    const result = await refetchMessagesRef.current();
    return result.data;
  }, []);

  const assistantReplyTextFor = useCallback((userMessage: ChatMessage): string | undefined => {
    const list = chatMessagesRef.current;
    const index = list.findIndex((message) => message.id === userMessage.id);
    if (index < 0) return undefined;
    for (let cursor = index + 1; cursor < list.length; cursor += 1) {
      const message = list[cursor];
      if (message.role === "user") return undefined;
      if (message.role === "assistant" && message.text?.trim()) return message.text;
    }
    return undefined;
  }, []);

  const submitCorrection = useCallback(
    async (rowId: number | null, text: string): Promise<SubmitCorrectionOutcome> => {
      const trimmed = text.trim();
      if (!taskId || !trimmed) return "fallback";
      if (rowId === null) return "fallback";
      const removedCount = countRemovedAfterRow(rowId);
      const destructive = removedCount === null || removedCount > 0;
      if (destructive && !isMethodKnownUnsupported("prompt.submit")) {
        const confirmed = await confirmTruncate(removedCount);
        if (!confirmed) return "cancelled";
      }
      let sessionId: string;
      try {
        sessionId = await ensureGatewaySession();
      } catch (error) {
        appendNotice({
          sessionId: taskId,
          text: `纠错失败：${classifyGatewayError(error).message}`,
          level: "error",
        });
        return "sent";
      }
      try {
        await getGatewayClient().request("prompt.submit", {
          session_id: sessionId,
          text: trimmed,
          truncate_before_row_id: rowId,
          confirm_truncate: true,
        });
        appendNotice({
          sessionId,
          text: "已从这条消息重新发送，它后面的话已被内核截断。",
          level: "info",
        });
        void refetchMessagesRef.current();
        return "sent";
      } catch (error) {
        const info = classifyGatewayError(error);
        if (info.kind === "unsupported-method") return "fallback";
        appendNotice({ sessionId, text: `纠错失败：${info.message}`, level: "error" });
        return "sent";
      }
    },
    [appendNotice, confirmTruncate, countRemovedAfterRow, ensureGatewaySession, taskId],
  );

  const handleEditMessage = useCallback(
    (message: ChatMessage) => {
      if (!taskId || runtimeIsBusy) return;
      if (correctionResolvingRef.current) return;
      const text = message.text ?? "";
      if (!text.trim()) {
        appendNotice({
          sessionId: taskId,
          text: "这条消息只有附件、没有文字，暂不支持编辑重发。",
          level: "warning",
        });
        return;
      }
      const anchorText = assistantReplyTextFor(message);
      correctionResolvingRef.current = message.id;
      setCorrectionResolvingId(message.id);
      void (async () => {
        try {
          const { rowId } = await resolveCorrectionRowId({
            messageId: message.id,
            text,
            anchorText,
            reload: reloadStoredMessages,
          });
          editTargetRef.current = { rowId, text };
          setComposerPrefill({ sessionId: taskId, text, nonce: Date.now() });
        } finally {
          correctionResolvingRef.current = null;
          setCorrectionResolvingId(null);
        }
      })();
    },
    [appendNotice, assistantReplyTextFor, reloadStoredMessages, runtimeIsBusy, taskId],
  );

  const handleRetryMessage = useCallback(
    (userMessage: ChatMessage) => {
      if (!taskId || runtimeIsBusy) return;
      if (correctionResolvingRef.current) return;
      const text = userMessage.text ?? "";
      if (!text.trim()) {
        appendNotice({
          sessionId: taskId,
          text: "这条提问只有附件、没有文字，暂不支持重试。",
          level: "warning",
        });
        return;
      }
      const anchorText = assistantReplyTextFor(userMessage);
      correctionResolvingRef.current = userMessage.id;
      setCorrectionResolvingId(userMessage.id);
      void (async () => {
        try {
          const { rowId, reloaded } = await resolveCorrectionRowId({
            messageId: userMessage.id,
            text,
            anchorText,
            reload: reloadStoredMessages,
          });
          const outcome = await submitCorrection(rowId, text);
          if (outcome === "sent" || outcome === "cancelled") return;
          try {
            const sessionId = await ensureGatewaySession();
            appendNotice({
              sessionId,
              text:
                rowId === null && reloaded
                  ? "已重载会话记录仍未找到这条提问的内核定位，本次作为新消息发送，后续消息不会删除。"
                  : "当前内核不支持消息回溯，本次作为新消息发送，后续消息不会删除。",
              level: "warning",
            });
            await sendPrompt(sessionId, text);
          } catch (error) {
            appendNotice({
              sessionId: taskId,
              text: `重试失败：${classifyGatewayError(error).message}`,
              level: "error",
            });
          }
        } finally {
          correctionResolvingRef.current = null;
          setCorrectionResolvingId(null);
        }
      })();
    },
    [
      appendNotice,
      assistantReplyTextFor,
      ensureGatewaySession,
      reloadStoredMessages,
      runtimeIsBusy,
      sendPrompt,
      submitCorrection,
      taskId,
    ],
  );

  const handleDeleteMessage = useCallback(
    (userMessage: ChatMessage) => {
      if (!taskId || runtimeIsBusy) return;
      if (correctionResolvingRef.current) return;
      const text = userMessage.text ?? "";
      if (!text.trim()) {
        appendNotice({
          sessionId: taskId,
          text: "这条提问只有附件、没有文字，暂不支持删除。",
          level: "warning",
        });
        return;
      }
      const anchorText = assistantReplyTextFor(userMessage);
      correctionResolvingRef.current = userMessage.id;
      setCorrectionResolvingId(userMessage.id);
      void (async () => {
        try {
          const { rowId } = await resolveCorrectionRowId({
            messageId: userMessage.id,
            text,
            anchorText,
            reload: reloadStoredMessages,
          });
          if (rowId === null) {
            appendNotice({
              sessionId: taskId,
              text: "已重载仍未找到这条提问的内核定位，无法删除。",
              level: "warning",
            });
            return;
          }
          const removedCount = countRemovedAfterRow(rowId);
          const confirmed = await confirmTruncate(removedCount, "delete");
          if (!confirmed) return;
          const sessionId = await ensureGatewaySession();
          await getGatewayClient().request("prompt.submit", {
            session_id: sessionId,
            text: "",
            truncate_before_row_id: rowId,
            confirm_truncate: true,
          });
          appendNotice({
            sessionId,
            text: "已删除这条提问及其之后的全部消息。",
            level: "info",
          });
          await refetchMessagesRef.current();
        } catch (error) {
          appendNotice({
            sessionId: taskId,
            text: `删除失败：${classifyGatewayError(error).message}`,
            level: "error",
          });
        } finally {
          correctionResolvingRef.current = null;
          setCorrectionResolvingId(null);
        }
      })();
    },
    [
      appendNotice,
      assistantReplyTextFor,
      confirmTruncate,
      countRemovedAfterRow,
      ensureGatewaySession,
      reloadStoredMessages,
      runtimeIsBusy,
      taskId,
    ],
  );

  // Follow the backend's compression tip (issue #305). When a session.resume is
  // redirected to a live continuation (recorded in sessionTipRedirectAtom), the
  // detail route is still pinned to the pre-compression id whose messages have
  // moved — so the conversation looks like it vanished while a #2/#3 duplicate
  // surfaces in the sidebar. Re-project onto the tip here, at the route layer
  // (not inside the async ensureGatewaySession closure, which was the #52
  // closure-stale hazard): a synchronous effect reacting to atom state, with a
  // replace navigate. pickTipRedirect never returns the current id, so once the
  // route reaches the tip this is a no-op (no navigation loop).
  const tipRedirects = useAtomValue(sessionTipRedirectAtom);
  useEffect(() => {
    const tip = pickTipRedirect(tipRedirects, { taskId, restSessionId, activeSessionId });
    if (!tip) return;
    setActiveId(tip);
    navigate(`/tasks/${tip}`, { replace: true });
  }, [tipRedirects, taskId, restSessionId, activeSessionId, setActiveId, navigate]);

  const storedMessages = useMemo(
    () => attachTurnStatsMetadata(messagesResponseToHermesUIMessages(messagesData), turnStats),
    [messagesData, turnStats],
  );

  useEffect(() => {
    const sessionId = runtimeSessionId ?? taskId;
    if (!sessionId || !runtimeIsBusy || storedMessages.length === 0) return;
    recoverCompletedTurnFromStoredMessages({
      sessionId,
      storedMessages,
    });
  }, [
    recoverCompletedTurnFromStoredMessages,
    runtimeIsBusy,
    runtimeSessionId,
    storedMessages,
    taskId,
  ]);

  const stableMessagesRef = useRef<ChatMessage[] | undefined>(undefined);
  const canonicalMessagesRef = useRef<HermesUIMessage[] | undefined>(undefined);
  const chatMessages = useMemo(() => {
    const canonical = mergeHermesUIMessages(
      storedMessages,
      isLiveSession ? runtime.messages : [],
    );
    // 流式 delta 里绝大多数帧合并结果逐条同引用（只有正在变的那条是新对象），
    // 这种帧直接复用上次的 ChatMessage 数组。
    const previousCanonical = canonicalMessagesRef.current;
    const previousStable = stableMessagesRef.current;
    if (
      previousCanonical !== undefined &&
      previousStable !== undefined &&
      previousCanonical.length === canonical.length &&
      canonical.every((message, index) => message === previousCanonical[index])
    ) {
      return previousStable;
    }
    const next = hermesUIMessagesToChatMessages(canonical);
    // 流式输出每个 token 都会重建全部消息对象；内容没变的复用旧引用，
    // 否则 MessageBubble 的 memo 全部失效，一帧要重渲染几十个气泡。
    const stable = stabilizeChatMessages(stableMessagesRef.current, next);
    canonicalMessagesRef.current = canonical;
    stableMessagesRef.current = stable;
    return stable;
  }, [
    isLiveSession,
    runtime.messages,
    storedMessages,
  ]);

  useEffect(() => {
    chatMessagesRef.current = chatMessages;
  }, [chatMessages]);

  // Manual context compaction (/compress). Fire-and-forget so the composer
  // clears immediately; the backend pins a "正在压缩上下文…" status while it
  // works and we surface the before/after result as a system notice.
  const runManualCompress = useCallback(async (sessionId: string, focus: string) => {
    try {
      const result = await compressSession(sessionId, focus);
      appendNotice({ sessionId, text: formatCompressNotice(result, focus), level: "system" });
      // session.compress also emits session.info, but the composer indicator
      // reads polled session.usage — refresh it so the bar/count update now.
      await getSessionUsage(sessionId).then(setSessionUsage).catch(() => {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const busy = message.toLowerCase().includes("session busy");
      appendNotice({
        sessionId,
        text: busy
          ? "当前回合正在进行，请先停止后再压缩上下文。"
          : `压缩上下文失败：${message}`,
        level: busy ? "info" : "error",
      });
    }
  }, [appendNotice, compressSession, getSessionUsage, setSessionUsage]);

  // The actual send. Shared by direct submits and by draining the queue.
  const submitPayload = useCallback(async (
    payload: ComposerSubmitPayload,
    updateAttachment: ComposerSubmitControls["updateAttachment"] = () => {},
  ) => {
    if (!taskId) return;
    const gatewaySessionId = await ensureGatewaySession();
    if (payload.workspacePath) {
      rememberWorkspaceProject(payload.workspacePath);
      rememberSessionWorkspace(taskId, payload.workspacePath);
      rememberSessionWorkspace(gatewaySessionId, payload.workspacePath);
      rememberSessionWorkspace(restSessionId, payload.workspacePath);
      writeWorkspacePath(payload.workspacePath);
    }
    // A `/skill <name>` invocation dispatches to the backend skill registry; the
    // returned payload becomes the transport text while the composer still shows
    // the literal command. Mirrors the new-task path in use-create-and-send-session.
    let transportText: string | undefined;
    const skillCommand = resolveComposerSkillCommand(payload.text, payload.skillCommandNames);
    if (skillCommand) {
      const dispatched = await dispatchCommand(
        gatewaySessionId,
        skillCommand.name,
        skillCommand.arg,
      );
      if (dispatched.type === "skill" && dispatched.message?.trim()) {
        transportText = dispatched.message;
      }
    }
    const prepared = await prepareComposerPrompt(gatewaySessionId, payload, {
      attachImage,
      attachImageBytes,
      attachFile,
      remote: isRemoteConnection(),
      readImageBytes: readImageBytesFromPath,
      readFileDataUrl,
      detectDroppedPath,
      uploadFile: uploadAttachmentFile,
      onAttachmentUpdate: updateAttachment,
    }, { transportText });
    await sendPrompt(gatewaySessionId, prepared.promptText, {
      displayText: prepared.displayText,
      displayImages: prepared.displayImages,
    });
  }, [attachFile, attachImage, attachImageBytes, detectDroppedPath, dispatchCommand, ensureGatewaySession, restSessionId, sendPrompt, taskId]);

  const onSend = useCallback(async (
    payload: ComposerSubmitPayload,
    controls: ComposerSubmitControls,
  ) => {
    if (!taskId) return;
    const builtin = parseBuiltinComposerCommand(payload.text);
    if (builtin?.name === "compress") {
      const sessionId = await ensureGatewaySession();
      void runManualCompress(sessionId, builtin.arg);
      return;
    }
    const pendingEdit = editTargetRef.current;
    if (pendingEdit) {
      editTargetRef.current = null;
      const canTruncate = !runtimeIsBusy && payload.attachments.length === 0;
      if (canTruncate) {
        const outcome = await submitCorrection(pendingEdit.rowId, payload.text);
        if (outcome === "sent") return;
        if (outcome === "cancelled") {
          editTargetRef.current = pendingEdit;
          return;
        }
      }
      appendNotice({
        sessionId: taskId,
        text:
          pendingEdit.rowId === null
            ? "已重载会话记录仍未找到这条提问的内核定位，本次作为新消息发送，原消息与它后面的话都不会删除。"
            : payload.attachments.length > 0 || runtimeIsBusy
              ? "本次作为新消息发送，原消息与它后面的话都不会删除。"
              : "当前内核不支持消息回溯，本次作为新消息发送，后续消息不会删除。",
        level: "warning",
      });
    }
    // Park the submission while the agent is busy; the composer clears on resolve
    // and the queue drains (auto on settle, or manually) when it frees up.
    if (runtimeIsBusy) {
      enqueueQueuedPrompt(taskId, { text: payload.text, attachments: payload.attachments }, Date.now());
      return;
    }
    await submitPayload(payload, controls.updateAttachment);
  }, [
    appendNotice,
    ensureGatewaySession,
    runManualCompress,
    runtimeIsBusy,
    submitCorrection,
    submitPayload,
    taskId,
  ]);

  // ---- Send queue (drain on settle, send-now / edit / delete) --------------
  const queuedPrompts = useQueuedPrompts(taskId);
  const [composerPrefill, setComposerPrefill] = useState<ComposerPrefillState>({ text: "", nonce: 0 });
  const handleGuidePick = useCallback((text: string) => {
    setComposerPrefill({ text, nonce: Date.now(), sessionId: taskId });
  }, [taskId]);
  const drainingRef = useRef(false);
  const previousBusyRef = useRef(runtimeIsBusy);
  const userInterruptedRef = useRef(false);

  const drainEntry = useCallback(async (entry: QueuedPromptEntry) => {
    if (!taskId || drainingRef.current) return;
    drainingRef.current = true;
    try {
      await submitPayload({
        text: entry.text,
        attachments: entry.attachments,
        skillCommandNames: enabledSkills.map((skill) => skill.name),
      });
      removeQueuedPrompt(taskId, entry.id);
    } catch (error) {
      console.error("Failed to drain queued prompt:", error);
    } finally {
      drainingRef.current = false;
    }
  }, [enabledSkills, submitPayload, taskId]);

  // Auto-drain the next queued prompt when the agent settles (busy → idle),
  // unless an explicit Stop just interrupted the turn.
  useEffect(() => {
    const wasBusy = previousBusyRef.current;
    previousBusyRef.current = runtimeIsBusy;
    if (runtimeIsBusy && !wasBusy) {
      userInterruptedRef.current = false;
      return;
    }
    const interrupted = userInterruptedRef.current;
    if (!runtimeIsBusy && wasBusy && interrupted) {
      userInterruptedRef.current = false;
    }
    if (shouldAutoDrainOnSettle({
      isBusy: runtimeIsBusy,
      wasBusy,
      queueLength: queuedPrompts.length,
      userInterrupted: interrupted,
    })) {
      void drainEntry(queuedPrompts[0]!);
    }
  }, [drainEntry, queuedPrompts, runtimeIsBusy]);

  const onQueueSendNow = useCallback((id: string) => {
    const entry = queuedPrompts.find((item) => item.id === id);
    if (entry) void drainEntry(entry);
  }, [drainEntry, queuedPrompts]);

  const onQueueEdit = useCallback((entry: QueuedPromptEntry) => {
    setComposerPrefill((prefill) => ({ text: entry.text, nonce: prefill.nonce + 1, sessionId: taskId }));
    removeQueuedPrompt(taskId, entry.id);
  }, [taskId]);

  const onQueueDelete = useCallback((id: string) => {
    removeQueuedPrompt(taskId, id);
  }, [taskId]);

  // Switching sessions must not leak one task's edit draft / busy-transition
  // bookkeeping into another.
  useEffect(() => {
    setComposerPrefill({ text: "", nonce: 0 });
    previousBusyRef.current = false;
    userInterruptedRef.current = false;
  }, [taskId]);

  // Capability discovery is server-global — don't piggy-back on
  // ensureGatewaySession here. That helper can trigger session.resume, which
  // the backend categorises as a slow handler (tui_gateway/server.py:139,
  // "可达几分钟"). When the underlying agent has crashed or the gateway is
  // mid-reconnect, the resume call hangs and the picker spinner hangs with
  // it. The session_id was only used by the backend to highlight "current
  // model" — useModelInfo gives us that without needing a live session.
  const loadModelOptions = useCallback(
    () => getModelOptions(),
    [getModelOptions],
  );

  const onModelSelect = useCallback(async (selection: ComposerModelSelection) => {
    const gatewaySessionId = await ensureGatewaySession();
    await setSessionModel(gatewaySessionId, selection.model, selection.provider);
    setSelectedModel({
      ...selection,
      contextWindow: resolveModelContextWindow(config, selection),
    });
    recordModelUsage(selection);
    await getSessionUsage(gatewaySessionId)
      .then(setSessionUsage)
      .catch(() => {});
  }, [config, ensureGatewaySession, getSessionUsage, setSessionModel, setSessionUsage]);

  const onConfigureProvider = useCallback((providerId: string) => {
    navigate(`/models#provider-${providerId}`);
  }, [navigate]);

  const configReasoningEffort = useMemo(() => reasoningEffortFromConfig(config), [config]);
  const reasoningEffort = reasoningEffortOverride ?? configReasoningEffort;

  const onReasoningEffortSelect = useCallback(async (effort: ReasoningEffort) => {
    setReasoningEffortOverride(effort); // 立即反馈，等 config 重新拉到后一致
    try {
      const gatewaySessionId = await ensureGatewaySession();
      await setSessionReasoningEffort(gatewaySessionId, effort);
    } catch (error) {
      // 失败则回退到配置里的实际值（override 置空 → 用 configReasoningEffort）
      setReasoningEffortOverride(null);
      console.error("设置思考强度失败：", error);
    }
  }, [ensureGatewaySession, setSessionReasoningEffort]);

  const onStop = useCallback(async () => {
    const sessionId = runtimeSessionId ?? taskId;
    if (!sessionId || !runtimeIsBusy) return;
    // A deliberate Stop suppresses exactly one auto-drain so the queue doesn't
    // immediately re-fire the turn the user just halted.
    userInterruptedRef.current = true;
    await interruptSession(sessionId);
  }, [interruptSession, runtimeIsBusy, runtimeSessionId, taskId]);

  const title = sessionData || sessionSummary
    ? sessionDisplayTitle({
        id: sessionData?.id ?? sessionSummary?.id ?? taskId ?? "",
        title:
          sessionTitleOverrides[sessionData?.id ?? ""] ??
          sessionTitleOverrides[sessionSummary?.id ?? ""] ??
          sessionTitleOverrides[restSessionId ?? ""] ??
          sessionData?.title ??
          sessionSummary?.title,
        preview: sessionData?.preview ?? sessionSummary?.preview,
      })
    : "会话详情";
  const model = selectedModel?.model ?? sessionUsage?.model ?? sessionData?.model ?? "";
  // 跳子会话要记来源，子会话页顶部才出得来「返回父会话」。
  const openSubagentSession = useSubagentSessionOpener(taskId, title);
  const contextSelection = useMemo<ComposerModelSelection | null>(() => {
    if (selectedModel) return selectedModel;
    if (!model) return null;
    return {
      model,
      provider: modelInfo?.provider,
    };
  }, [model, modelInfo?.provider, selectedModel]);
  const selectedContextMax = useMemo(
    () => resolveModelContextWindow(config, contextSelection),
    [config, contextSelection],
  );
  const composerTick = useComposerTimer(runtimeIsBusy, runtime.turnStartedAt);
  // Task-level stall watchdog: detects a turn wedged on a dead provider call
  // (the connection heartbeat can't — the gateway keeps answering pings).
  const stall = useStallWatchdog(runtime);

  const composerLoadingPlaceholder = runtimeIsBusy && runtime.turnStartedAt
    ? `${assistantDisplayName} 思考中 · ${formatElapsedTimer(composerTick)}`
    : undefined;

  const timelineStatus =
    runtime.statusMessage ||
    (runtimeIsBusy && chatMessages.length === 0 ? "任务运行中，等待输出…" : undefined);
  // `session.usage.context_used` 是运行时回报的当前上下文窗口用量，最准确。
  // 刚 resume 的 gw session 可能暂时返回 0，此时只能用当前已渲染消息做近似估算。
  // 不要再回退到 REST `input_tokens + output_tokens`：那是会话累计账单用量，
  // 多轮对话会重复计算历史 prompt，30K 级别上下文很容易被显示成 1M+。
  const estimatedContextUsed = useMemo(
    () => estimateRenderedContextTokens(chatMessages),
    [chatMessages],
  );
  const contextUsage = buildComposerContextUsage({
    live: sessionUsage,
    modelInfo,
    session: sessionData,
    selectedModel,
    selectedContextMax,
    estimatedUsed: estimatedContextUsed,
  });
  const autoTts = voiceAutoTtsFromConfig(config);
  const hasActiveComposerPrefill = composerPrefill.sessionId === taskId && composerPrefill.nonce > 0;
  const composerInitial = hasActiveComposerPrefill ? composerPrefill.text : storedComposerDraft;
  const composerInitialNonce = hasActiveComposerPrefill ? composerPrefill.nonce : 0;
  const pageRef = useRef<HTMLDivElement>(null);

  const pageStyle = useMemo(
    () => {
      const font = conversationFontSizeVars(conversationFontSizeMode);
      return {
        // min(档位, 100% - 64px)：窗口不够宽（或"满"档）时整条会话列（时间线 +
        // composer + stall-notice 共用此变量）两侧各让出 32px，给右侧轮次定位条
        // (turnRail) 一条不压内容的专属出血带；余量充足时与档位宽完全一致。
        "--conversation-max-width": `min(${conversationWidthMaxWidth(conversationWidthMode)}, 100% - 64px)`,
        "--conversation-font-size": font.fontSize,
        "--conversation-line-height": font.lineHeight,
      } as CSSProperties;
    },
    [conversationFontSizeMode, conversationWidthMode],
  );

  return (
    <div
      ref={pageRef}
      className={s.page}
      data-conversation-width={conversationWidthMode}
      style={pageStyle}
    >
      <TopBar
        title={title}
        sub={model ? `本会话 ${model}` : undefined}
        right={
          <>
            {copyableSessionId ? (
              <TopBarActionButton
                onClick={copySessionId}
                title={`复制会话 ID：${copyableSessionId}`}
                aria-label={`复制会话 ID ${copyableSessionId}`}
              >
                {sessionIdCopyState === "copied" ? (
                  <Check size={12} aria-hidden="true" />
                ) : (
                  <Copy size={12} aria-hidden="true" />
                )}
                <span>
                  {sessionIdCopyState === "copied"
                    ? "已复制"
                    : sessionIdCopyState === "error"
                      ? "复制失败"
                      : "复制会话 ID"}
                </span>
              </TopBarActionButton>
            ) : null}
            <TopBarActionButton
              onClick={() => setSubagentPanelOpen((v) => !v)}
              data-active={subagentPanelOpen ? "true" : undefined}
              title="子Agent 监视"
              aria-label="子Agent 监视"
              aria-pressed={subagentPanelOpen}
            >
              <Bot size={12} aria-hidden="true" />
              <span>子Agent</span>
              {subagentTotal > 0 ? (
                <span className={s.subagentBadge} data-active={subagentActive > 0 ? "true" : undefined}>
                  {subagentActive > 0 ? subagentActive : subagentTotal}
                </span>
              ) : null}
            </TopBarActionButton>
            <TopBarActionButton
              onClick={() => setRightRailVisible(!rightRailVisible)}
              data-active={rightRailVisible ? "true" : undefined}
              title="预览面板（⌘B）"
              aria-label="预览面板"
              aria-pressed={rightRailVisible}
            >
              <PanelRight size={12} aria-hidden="true" />
              <span>预览</span>
            </TopBarActionButton>
            <TopBarActions />
          </>
        }
      />
      <div className={s.workArea}>
        <div className={s.chatColumn}>
          <SubagentOriginBar currentSessionId={taskId} />
          {resumeFailure ? (
            <div
              role="alert"
              data-state="resume-failed"
              data-action="resume-failure"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                margin: "8px 12px 0",
                padding: "6px 10px",
                border: "1px solid var(--h-line)",
                borderLeft: "2px solid var(--h-err)",
                borderRadius: 0,
                background: "var(--h-bg-soft)",
                color: "var(--h-text-2)",
                fontFamily: "var(--h-font-cn)",
                fontSize: 12.5,
                lineHeight: 1.4,
              }}
            >
              <span style={{ flex: "1 1 auto", minWidth: 0 }}>{resumeFailure.message}</span>
              <button
                type="button"
                data-action="retry-resume"
                onClick={() => void retryResume()}
                style={{
                  flex: "0 0 auto",
                  height: 24,
                  padding: "0 10px",
                  border: "1px solid var(--h-line)",
                  borderRadius: 0,
                  background: "transparent",
                  color: "var(--h-text)",
                  fontFamily: "var(--h-font-cn)",
                  fontSize: 12.5,
                  lineHeight: 1,
                  cursor: "pointer",
                }}
              >
                重试
              </button>
            </div>
          ) : null}
          {/* key={taskId}：切会话强制重挂载时间线。layout effect 在首帧绘制前就
              把滚动定位到底部，避免新会话内容先以上一个会话的滚动位置绘制、再
              在 650ms 的滚动校正窗口里反复跳动（用户感知为"闪烁两下"）。 */}
          <InlinePromptFlow messages={chatMessages} sessionIds={[runtimeSessionId, taskId]}>
            {(trailingPrompts) => (
              <MessageTimeline
                key={taskId}
                messages={chatMessages}
                loading={isLoading && runtime.messages.length === 0}
                statusMessage={timelineStatus}
                turnStartedAt={runtimeIsBusy ? runtime.turnStartedAt : undefined}
                sessionUsage={runtimeIsBusy ? sessionUsage : undefined}
                progressModel={runtimeIsBusy ? model || undefined : undefined}
                autoTts={autoTts}
                subagentSessionIds={subagentSessionIds}
                trailing={trailingPrompts}
                hasEarlier={hasEarlierMessages}
                isLoadingEarlier={isLoadingEarlierMessages}
                onLoadEarlier={loadEarlierMessages}
                loadEarlierError={loadEarlierMessagesError}
                onEditMessage={handleEditMessage}
                onRetryMessage={handleRetryMessage}
                onDeleteMessage={handleDeleteMessage}
                correctionLocked={runtimeIsBusy}
                correctionLockedReason="正在生成回复，等这轮结束再纠正"
                correctionPendingMessageId={correctionResolvingId}
                emptyGuide={
                  chatMessages.length === 0 && !runtimeIsBusy ? (
                    <EmptyChatGuide onPick={handleGuidePick} />
                  ) : undefined
                }
                onOpenSettings={(path) => navigate(path)}
              />
            )}
          </InlinePromptFlow>
          <div className={s.composerArea}>
            {runtimeIsBusy && stall.isStalled ? (
              <StallNotice silenceMs={stall.silenceMs} onInterrupt={onStop} />
            ) : null}
            <QueuePanel
              entries={queuedPrompts}
              busy={runtimeIsBusy}
              editingId={null}
              onSendNow={onQueueSendNow}
              onEdit={onQueueEdit}
              onDelete={onQueueDelete}
            />
            <GooseComposer
              key={`${taskId}:${composerDraftKey ?? "draft"}`}
              flushBottom
              initialWorkspacePath={sessionWorkspace}
              initial={composerInitial}
              initialNonce={composerInitialNonce}
              onDraftChange={onComposerDraftChange}
              onSend={onSend}
              queuedCount={queuedPrompts.length}
              loadingPlaceholder={composerLoadingPlaceholder}
              showMeta={false}
              loading={runtimeIsBusy}
              onStop={onStop}
              modelPicker={{
                selected: contextSelection,
                label: model || modelInfo?.model,
                loadOptions: loadModelOptions,
                initialOptions: modelOptionsCache ?? null,
                onSelect: onModelSelect,
                onConfigureProvider,
                disabled: runtimeIsBusy,
              }}
              reasoningPicker={{
                value: reasoningEffort,
                onSelect: onReasoningEffortSelect,
                disabled: runtimeIsBusy,
              }}
              skillPicker={{
                skills: enabledSkills,
                loading: skillsQuery.isLoading || skillsQuery.isFetching,
                error: skillsQuery.isError
                  ? (skillsQuery.error instanceof Error ? skillsQuery.error.message : "Skill 加载失败")
                  : undefined,
                disabled: runtimeIsBusy,
              }}
              mentionPicker={{
                completePath: (word) =>
                  completePath(word, {
                    sessionId: runtimeSessionId ?? undefined,
                    cwd: sessionWorkspace || undefined,
                  }),
                sessions: sessionsData?.sessions,
                profile: activeProfile,
                disabled: runtimeIsBusy,
              }}
              contextUsage={contextUsage}
            />
          </div>
        </div>
        {rightRailVisible && taskId ? (
          <PreviewRail
            sessionId={taskId}
            workspaceRoot={sessionWorkspace}
            onClose={() => setRightRailVisible(false)}
          />
        ) : null}
        {subagentPanelOpen ? (
          <SubagentPanel
            subagents={subagents}
            cliDelegations={cliDelegations}
            onClose={() => setSubagentPanelOpen(false)}
            onClearFinished={clearFinishedDelegationRows}
            onOpenSession={openSubagentSession}
          />
        ) : null}

        <ConfirmTruncateDialog
          open={truncateConfirm !== null}
          removedCount={truncateConfirm?.removedCount ?? null}
          mode={truncateConfirm?.mode ?? "resend"}
          onCancel={() => settleTruncateConfirm(false)}
          onConfirm={() => settleTruncateConfirm(true)}
        />
      </div>
    </div>
  );
}
