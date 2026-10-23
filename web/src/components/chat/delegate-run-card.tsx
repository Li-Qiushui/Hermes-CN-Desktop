import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { LoadingIndicator } from "@hermes/shared-ui";
import type { ChatToolItem } from "./chat-types";
import { getGatewayClient } from "@/lib/gateway-client";
import { classifyGatewayError, humanizeGatewayError } from "@/lib/gateway-result";
import { subagentsBySessionAtom, type SubagentProgress } from "@/stores/subagents";
import {
  SubagentDialog,
  dialogTargetFromRow,
  useSubagentSessionOpener,
  type SubagentDialogTarget,
} from "./subagent-dialog";
import {
  aggregateStatus,
  buildDelegateRows,
  canInterruptRow,
  dedupeRowActivity,
  isLiveRow,
  needsClock,
  sharedActivitySummary,
  type DelegateCallInput,
  type DelegateRunRow,
  type DelegateRunStatus,
} from "./delegate-run-model";
import s from "./delegate-run-card.module.css";

// 对话流内的 delegate 运行卡：一次 delegate_task 派发一张卡，卡里每个子代理
// 一行（标题=子任务、模型、状态、耗时、最近几行进度），可展开完整日志。
// 点开的中断按钮只在「内核在册 + 还在跑」时出现——后端 subagent.interrupt
// 只对当前会话自己派发、且仍存活的对象生效，画一个点了没反应的按钮等于骗人。

const TICKER_DEPTH = 5;
const FALLBACK_SUMMARY_MAX = 400;

const STATUS_TEXT: Record<DelegateRunStatus, string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
  dispatched: "后台运行",
};

function formatDuration(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "";
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const m = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return `${m}分${sec.toString().padStart(2, "0")}秒`;
}

function rowSeconds(row: DelegateRunRow, now: number): number {
  if (typeof row.durationSeconds === "number") return Math.max(0, row.durationSeconds);
  if (!row.startedAt) return 0;
  return Math.max(0, (now - row.startedAt) / 1000);
}

function StatusGlyph({ status, label }: { status: DelegateRunStatus; label: string }) {
  if (isLiveRow({ status })) {
    return (
      <span className={s.glyph} data-tone="run" aria-label={label}>
        <LoadingIndicator size="sm" />
      </span>
    );
  }
  if (status === "failed" || status === "interrupted") {
    return <AlertCircle className={s.glyph} data-tone="err" size={14} aria-label={label} />;
  }
  if (status === "dispatched") {
    // 停过一轮又没人看：静止点，不转。
    return (
      <span className={s.glyph} aria-label={label}>
        <span className={s.parkedDot} aria-hidden="true" />
      </span>
    );
  }
  return <CheckCircle2 className={s.glyph} data-tone="ok" size={14} aria-label={label} />;
}

/** 插话回执：`ok` 为真表示内核已接收（queued），否则保留输入让用户改。 */
export interface DelegateSteerOutcome {
  ok: boolean;
  text: string;
}

export interface DelegateRunCardViewProps {
  rows: DelegateRunRow[];
  now: number;
  /** 行级中断进行中的 row.id。 */
  interruptingId?: string | null;
  /** 行级中断失败的提示。 */
  interruptError?: { rowId: string; text: string } | null;
  /** 默认展开完整日志（历史回看 / 测试用）。 */
  defaultLogOpen?: boolean;
  onInterrupt?: (row: DelegateRunRow) => void;
  /** 行级「插话」：注入测试用；不给就当纯展示。 */
  onSteer?: (row: DelegateRunRow, text: string) => Promise<DelegateSteerOutcome>;
  /** 行级插话结果（提示文案 + 语气）。 */
  steerNotice?: { rowId: string; text: string; tone: "ok" | "err" } | null;
  /** 弹窗里「在页面中打开」：真跳 /tasks/:id。 */
  onOpenInPage?: (childSessionId: string) => void;
  /** 行 id → 工具调用次数（store 里有，行模型没带）。 */
  toolCounts?: Record<string, number>;
  /** 同一次派发的子代理多于一个时才显示分组头。 */
  showGroupHead?: boolean;
}

export function DelegateRunCardView({
  rows,
  now,
  interruptingId,
  interruptError,
  defaultLogOpen = false,
  onInterrupt,
  onSteer,
  steerNotice,
  onOpenInPage,
  toolCounts,
  showGroupHead,
}: DelegateRunCardViewProps) {
  const [openLog, setOpenLog] = useState<Record<string, boolean>>(() =>
    defaultLogOpen ? Object.fromEntries(rows.map((row) => [row.id, true])) : {},
  );
  // 「打开子会话」不再直接跳页：先在这里看运行情况，跳页降级成弹窗里的次要动作。
  const [dialog, setDialog] = useState<SubagentDialogTarget | null>(null);
  // 「插话」一次只开一行：子代理已经跑过最后一个批次时内核会拒，提示里说清楚。
  const [steerRowId, setSteerRowId] = useState<string | null>(null);
  const [steerDraft, setSteerDraft] = useState("");
  const [steerSending, setSteerSending] = useState(false);

  if (rows.length === 0) return null;

  const submitSteer = async (row: DelegateRunRow) => {
    const text = steerDraft.trim();
    if (!text || !onSteer) return;
    setSteerSending(true);
    try {
      const result = await onSteer(row, text);
      if (result?.ok) {
        setSteerDraft("");
        setSteerRowId(null);
      }
    } finally {
      setSteerSending(false);
    }
  };

  const showHead = showGroupHead ?? rows.length > 1;
  const status = aggregateStatus(rows);
  // 派发结果的原始 JSON 已经被清洗成一句话；多个子任务行复读同一句时提到组头说一次。
  const rowLines = dedupeRowActivity(rows);
  const hoisted = showHead ? sharedActivitySummary(rows) : null;

  return (
    <div className={s.card} data-delegate-card="" data-status={status} data-count={rows.length}>
      {showHead ? (
        <div className={s.groupHead}>
          <span className={s.groupKind}>子代理</span>
          <span>
            {rows.length} 个并行子任务 · 按派发顺序
            {rows.some((row) => isLiveRow(row)) ? " · 运行中" : ""}
          </span>
          {hoisted ? (
            <span className={s.groupSummary} data-delegate-summary="">
              {hoisted}
            </span>
          ) : null}
        </div>
      ) : null}

      {rows.map((row, index) => {
        const own = rowLines[index] ?? [];
        const lines = hoisted ? [] : own.slice(-TICKER_DEPTH);
        const open = openLog[row.id] ?? false;
        const seconds = rowSeconds(row, now);
        const duration = formatDuration(seconds);
        const label = STATUS_TEXT[row.status];
        const pending = interruptingId === row.id;
        const rowError = interruptError?.rowId === row.id ? interruptError.text : undefined;
        const logText = (hoisted ? [] : own).join("\n");

        return (
          <section
            className={s.agent}
            key={row.id}
            data-status={row.status}
            data-delegate-row={row.id}
            data-first={index === 0 ? "true" : undefined}
          >
            <div className={s.hd}>
              <StatusGlyph status={row.status} label={label} />
              {showHead ? null : <span className={s.kind}>子代理</span>}
              <span className={s.nm} title={row.goal}>
                {row.goal}
              </span>
              {row.model ? (
                <span className={s.mdl} title={row.model}>
                  {row.model}
                </span>
              ) : null}
              <span className={s.st}>
                {label}
                {duration ? ` ${duration}` : ""}
              </span>
            </div>

            {hoisted ? null : (
              <div className={s.bd} data-empty={lines.length === 0 ? "true" : undefined}>
                {lines.length === 0 ? (
                  <div className={s.line} data-empty="true">
                    等待子代理输出…
                  </div>
                ) : (
                  lines.map((line, lineIndex) => (
                    <div
                      className={s.line}
                      key={`${row.id}:${lineIndex}:${line}`}
                      data-live={isLiveRow(row) && lineIndex === lines.length - 1 ? "true" : undefined}
                    >
                      <span className={s.caret} aria-hidden="true">
                        ›
                      </span>
                      {line}
                    </div>
                  ))
                )}
              </div>
            )}

            <div className={s.ft}>
              <button
                className={s.btn}
                type="button"
                aria-expanded={open}
                onClick={() => setOpenLog((prev) => ({ ...prev, [row.id]: !open }))}
              >
                {open ? "收起日志" : "展开完整日志"}
              </button>
              <button
                className={s.btn}
                type="button"
                onClick={() => setDialog(dialogTargetFromRow(row, toolCounts?.[row.id]))}
                title="查看这个子代理的运行情况"
              >
                查看运行情况
              </button>
              {onInterrupt && canInterruptRow(row) ? (
                <button
                  className={s.btn}
                  type="button"
                  data-danger="true"
                  disabled={pending}
                  onClick={() => onInterrupt(row)}
                >
                  {pending ? "中断中…" : "中断"}
                </button>
              ) : null}
              {onSteer && row.subagentId && isLiveRow(row) ? (
                <button
                  className={s.btn}
                  type="button"
                  data-active={steerRowId === row.id ? "true" : undefined}
                  aria-expanded={steerRowId === row.id}
                  title="给这个子代理插一句，下个批次生效"
                  onClick={() => {
                    setSteerDraft("");
                    setSteerRowId(steerRowId === row.id ? null : row.id);
                  }}
                >
                  插话
                </button>
              ) : null}
            </div>

            {onSteer && steerRowId === row.id ? (
              <form
                className={s.steerRow}
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitSteer(row);
                }}
              >
                <input
                  className={s.steerInput}
                  value={steerDraft}
                  placeholder="给子代理补一句，不会打断它"
                  aria-label={`给 ${row.goal} 插话`}
                  onChange={(event) => setSteerDraft(event.target.value)}
                />
                <button
                  className={s.btn}
                  type="submit"
                  disabled={!steerDraft.trim() || steerSending}
                >
                  {steerSending ? "发送中…" : "发送"}
                </button>
              </form>
            ) : null}

            {row.status === "dispatched" ? (
              <p className={s.note}>回合已结束，子代理仍在后台运行；这边没有事件在跟进它的进度。</p>
            ) : null}

            {rowError ? <p className={s.err}>{rowError}</p> : null}

            {steerNotice?.rowId === row.id ? (
              <p className={s.steerNote} data-tone={steerNotice.tone} role="status">
                {steerNotice.text}
              </p>
            ) : null}

            {open ? (
              <pre className={s.log} data-delegate-log="">
                {logText ? logText : <span className={s.logEmpty}>暂无日志行（内核没有回传子代理的工具/进度事件）</span>}
              </pre>
            ) : null}
          </section>
        );
      })}

      {dialog ? (
        <SubagentDialog
          target={dialog}
          onClose={() => setDialog(null)}
          onOpenInPage={onOpenInPage}
          now={now}
        />
      ) : null}
    </div>
  );
}

/** 按候选会话 id 取子代理行与其 store key（中断 RPC 需要父会话 id）。 */
function resolveLiveRows(
  bySession: Record<string, SubagentProgress[]>,
  candidates: readonly (string | undefined)[],
): { rows: SubagentProgress[]; sessionId?: string } {
  for (const id of candidates) {
    if (id && bySession[id]?.length) return { rows: bySession[id]!, sessionId: id };
  }
  return { rows: [], sessionId: candidates.find(Boolean) };
}

export interface DelegateRunCardProps {
  tool: ChatToolItem;
  /** 解析 subagent store 的候选会话 id（与侧栏面板同一套）。 */
  sessionIds?: readonly (string | undefined)[];
  /** 主代理回合是否仍在流式输出。 */
  streaming?: boolean;
  /** 本轮只有这一张 delegate 卡时，才允许按时间窗认领无关联的原生行。 */
  claimUnlinked?: boolean;
  /** 测试注入：固定"现在"。 */
  now?: number;
  /** 测试注入：替换中断 RPC 与跳转。 */
  onInterrupt?: (row: DelegateRunRow) => Promise<unknown> | unknown;
  /** 测试注入：替换子代理插话 RPC。 */
  onSteer?: (row: DelegateRunRow, text: string) => Promise<unknown>;
  onOpenSession?: (sessionId: string) => void;
}

export function DelegateRunCard({
  tool,
  sessionIds,
  streaming = false,
  claimUnlinked = true,
  now: fixedNow,
  onInterrupt,
  onSteer,
  onOpenSession,
}: DelegateRunCardProps) {
  const bySession = useAtomValue(subagentsBySessionAtom);
  const candidates = sessionIds ?? [];
  const key = candidates.filter(Boolean).join("|");
  // 跳子会话要记来源，子会话页顶部才出得来「返回父会话」。
  const openInPage = useSubagentSessionOpener(candidates.find(Boolean));

  const live = useMemo(
    () => resolveLiveRows(bySession, candidates),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bySession, key],
  );

  const [clock, setClock] = useState(() => Date.now());
  const [interruptingId, setInterruptingId] = useState<string | null>(null);
  const [interruptError, setInterruptError] = useState<{ rowId: string; text: string } | null>(null);
  const [steerNotice, setSteerNotice] = useState<
    { rowId: string; text: string; tone: "ok" | "err" } | null
  >(null);

  const call: DelegateCallInput = useMemo(
    () => ({
      args: tool.arguments,
      completedAt: tool.completedAt,
      error: tool.error,
      streaming,
      startedAt: tool.startedAt,
      status: tool.status,
      summary: (tool.summary ?? tool.preview ?? "").slice(0, FALLBACK_SUMMARY_MAX),
      claimUnlinked,
      now: fixedNow ?? clock,
      toolCallId: tool.tool_id,
    }),
    [tool, streaming, claimUnlinked, fixedNow, clock],
  );

  const rows = useMemo(() => buildDelegateRows(call, live.rows), [call, live.rows]);

  const ticking = needsClock(rows) && fixedNow === undefined;
  useEffect(() => {
    if (!ticking) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  const startInterrupt = useCallback(
    async (row: DelegateRunRow) => {
      if (!row.subagentId) return;
      setInterruptingId(row.id);
      setInterruptError(null);
      try {
        const result = onInterrupt
          ? await onInterrupt(row)
          : await getGatewayClient().request("subagent.interrupt", {
              session_id: live.sessionId ?? "",
              subagent_id: row.subagentId,
            });
        const found = (result as { found?: unknown } | undefined)?.found;
        if (found === false) {
          setInterruptError({ rowId: row.id, text: "内核里已经没有这个子代理了，中断没有生效" });
        }
      } catch (error) {
        setInterruptError({
          rowId: row.id,
          text: `中断失败：${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        setInterruptingId(null);
      }
    },
    [live.sessionId, onInterrupt],
  );

  const startSteer = useCallback(
    async (row: DelegateRunRow, text: string): Promise<DelegateSteerOutcome> => {
      const trimmed = text.trim();
      if (!row.subagentId) {
        const message = "内核里还没有这个子代理，无法插话";
        setSteerNotice({ rowId: row.id, text: message, tone: "err" });
        return { ok: false, text: message };
      }
      if (!trimmed) {
        const message = "插话内容不能为空";
        setSteerNotice({ rowId: row.id, text: message, tone: "err" });
        return { ok: false, text: message };
      }
      setSteerNotice(null);
      try {
        const result = onSteer
          ? await onSteer(row, trimmed)
          : await getGatewayClient().request("subagent.steer", {
              session_id: live.sessionId ?? "",
              subagent_id: row.subagentId,
              text: trimmed,
            });
        const status = (result as { status?: unknown } | undefined)?.status;
        if (status === "rejected") {
          const message = "子代理已不接受插话";
          setSteerNotice({ rowId: row.id, text: message, tone: "err" });
          return { ok: false, text: message };
        }
        const message = "已排队，子代理下个批次会看到";
        setSteerNotice({ rowId: row.id, text: message, tone: "ok" });
        return { ok: true, text: message };
      } catch (error) {
        const info = classifyGatewayError(error);
        const message =
          info.kind === "unsupported-method"
            ? "当前内核不支持子代理插话"
            : `插话失败：${humanizeGatewayError(error)}`;
        setSteerNotice({ rowId: row.id, text: message, tone: "err" });
        return { ok: false, text: message };
      }
    },
    [live.sessionId, onSteer],
  );

  const openSession = useCallback(
    (childSessionId: string) => {
      if (onOpenSession) onOpenSession(childSessionId);
      else openInPage(childSessionId);
    },
    [onOpenSession, openInPage],
  );

  const toolCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const item of live.rows) map[item.id] = item.toolCount ?? 0;
    return map;
  }, [live.rows]);

  return (
    <DelegateRunCardView
      rows={rows}
      now={fixedNow ?? clock}
      interruptingId={interruptingId}
      interruptError={interruptError}
      onInterrupt={startInterrupt}
      onSteer={startSteer}
      steerNotice={steerNotice}
      onOpenInPage={openSession}
      toolCounts={toolCounts}
    />
  );
}
