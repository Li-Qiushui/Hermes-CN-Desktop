import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, CheckCircle2, Square } from "lucide-react";
import { LoadingIndicator } from "@hermes/shared-ui";
import type { SubagentProgress, SubagentStatus } from "@/stores/subagents";
import type { DelegateRunRow, DelegateRunStatus } from "./delegate-run-model";
import s from "./subagent-dialog.module.css";

// 子代理运行情况弹窗：对话流的「查看运行情况」和右侧监视面板共用同一个弹窗，
// 免得用户点一下就整页跳到子会话、还得想办法回来。真正跳页降级成弹窗里的
// 次要动作，并且只在拿得到子会话 id 时可用。

export interface SubagentDialogTarget {
  id: string;
  goal: string;
  model?: string;
  status: DelegateRunStatus;
  startedAt: number;
  durationSeconds?: number;
  toolCount?: number;
  /** 完整日志行（旧→新），弹窗只做尾部滚动，不截断数据。 */
  lines: string[];
  childSessionId?: string;
}

const STATUS_TEXT: Record<DelegateRunStatus, string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
  dispatched: "后台运行",
};

const isLiveStatus = (status: DelegateRunStatus): boolean =>
  status === "running" || status === "queued" || status === "dispatched";

export function formatSubagentDuration(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "";
  if (seconds < 60) {
    return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
  }
  const m = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return `${m}分${sec.toString().padStart(2, "0")}秒`;
}

export function dialogTargetFromRow(row: DelegateRunRow, toolCount?: number): SubagentDialogTarget {
  return {
    childSessionId: row.childSessionId,
    durationSeconds: row.durationSeconds,
    goal: row.goal,
    id: row.id,
    lines: row.activity,
    model: row.model,
    startedAt: row.startedAt,
    status: row.status,
    toolCount,
  };
}

export function dialogTargetFromProgress(item: SubagentProgress): SubagentDialogTarget {
  const status: DelegateRunStatus = item.status;
  return {
    childSessionId: item.childSessionId,
    durationSeconds: item.durationSeconds,
    goal: item.goal,
    id: item.id,
    lines: item.stream.map((entry) => entry.text).filter(Boolean),
    model: item.model,
    startedAt: item.startedAt,
    status,
    toolCount: item.toolCount,
  };
}

// ── 子会话来源（返回父会话用） ──────────────────────────────────────────────

export const SUBAGENT_ORIGIN_KEY = "hermes.subagent-origin";

export interface SubagentOrigin {
  childSessionId: string;
  parentSessionId: string;
  parentTitle?: string;
}

export function readSubagentOrigin(): SubagentOrigin | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(SUBAGENT_ORIGIN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SubagentOrigin>;
    if (!parsed || typeof parsed.childSessionId !== "string" || typeof parsed.parentSessionId !== "string") {
      return null;
    }
    if (!parsed.childSessionId || !parsed.parentSessionId) return null;
    return {
      childSessionId: parsed.childSessionId,
      parentSessionId: parsed.parentSessionId,
      parentTitle: typeof parsed.parentTitle === "string" ? parsed.parentTitle : undefined,
    };
  } catch {
    return null;
  }
}

export function writeSubagentOrigin(origin: SubagentOrigin): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SUBAGENT_ORIGIN_KEY, JSON.stringify(origin));
  } catch {
    // 隐私模式下 sessionStorage 会抛，返回条降级为不出现，不影响跳页本身。
  }
}

export function clearSubagentOrigin(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SUBAGENT_ORIGIN_KEY);
  } catch {
    // 同上：清不掉也不该让跳页失败。
  }
}

/** 跳子会话：先记来源，再从别处跳过去的页面上渲染返回条。 */
export function useSubagentSessionOpener(parentSessionId?: string, parentTitle?: string) {
  const navigate = useNavigate();
  return useCallback(
    (childSessionId: string) => {
      if (!childSessionId) return;
      writeSubagentOrigin({
        childSessionId,
        parentSessionId: parentSessionId ?? "",
        parentTitle,
      });
      navigate(`/tasks/${childSessionId}`);
    },
    [navigate, parentSessionId, parentTitle],
  );
}

/** 子会话页顶部的返回条：只有当前会话正是记录里的子会话时才出现。 */
export function SubagentOriginBar({ currentSessionId }: { currentSessionId?: string }) {
  const navigate = useNavigate();
  const [origin, setOrigin] = useState<SubagentOrigin | null>(readSubagentOrigin);

  useEffect(() => {
    setOrigin(readSubagentOrigin());
  }, [currentSessionId]);

  if (!origin || !currentSessionId || origin.childSessionId !== currentSessionId) return null;

  const label = origin.parentTitle?.trim();
  return (
    <div className={s.originBar} data-subagent-origin-bar="">
      <button
        className={s.originBtn}
        type="button"
        onClick={() => {
          clearSubagentOrigin();
          navigate(`/tasks/${origin.parentSessionId}`);
        }}
        title={`返回父会话 ${origin.parentSessionId}`}
      >
        ← 返回父会话{label ? ` ${label}` : ""}
      </button>
    </div>
  );
}

// ── 弹窗本体 ────────────────────────────────────────────────────────────────

export interface SubagentDialogProps {
  target: SubagentDialogTarget;
  onClose: () => void;
  /** 「在页面中打开」：真正跳 /tasks/:id 的次要动作。 */
  onOpenInPage?: (childSessionId: string) => void;
  /** 测试注入：固定「现在」。 */
  now?: number;
}

function StatusGlyph({ status }: { status: DelegateRunStatus }) {
  if (status === "running" || status === "queued") {
    return (
      <span className={s.glyph} data-tone="run" aria-label={STATUS_TEXT[status]}>
        <LoadingIndicator size="sm" />
      </span>
    );
  }
  if (status === "failed" || status === "interrupted") {
    return <AlertCircle className={s.glyph} data-tone="err" size={14} aria-label={STATUS_TEXT[status]} />;
  }
  if (status === "dispatched") {
    return (
      <span className={s.glyph} data-tone="park" aria-label={STATUS_TEXT[status]}>
        <Square size={9} aria-hidden />
      </span>
    );
  }
  return <CheckCircle2 className={s.glyph} data-tone="ok" size={14} aria-label={STATUS_TEXT[status]} />;
}

export function SubagentDialog({ target, onClose, onOpenInPage, now: fixedNow }: SubagentDialogProps) {
  const logRef = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);
  const [clock, setClock] = useState(() => Date.now());
  const live = isLiveStatus(target.status);

  useEffect(() => {
    if (!live || fixedNow !== undefined) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live, fixedNow]);

  const now = fixedNow ?? clock;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!follow) return;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [follow, target.lines.length]);

  const seconds =
    target.durationSeconds ?? (live ? Math.max(0, (now - target.startedAt) / 1000) : 0);
  const duration = formatSubagentDuration(seconds);
  const tools = target.toolCount ?? 0;
  const jumpEnabled = Boolean(target.childSessionId) && Boolean(onOpenInPage);

  return (
    <div className={s.overlay} data-subagent-dialog-overlay="" onClick={onClose}>
      <div
        className={s.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={`子代理运行情况：${target.goal}`}
        data-subagent-dialog={target.id}
        data-status={target.status}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={s.head}>
          <StatusGlyph status={target.status} />
          <h2 className={s.title} title={target.goal}>
            {target.goal}
          </h2>
          <button className={s.close} type="button" onClick={onClose} aria-label="关闭运行情况弹窗">
            ✕
          </button>
        </header>

        <div className={s.meta}>
          <span className={s.metaItem} data-key="status" data-status={target.status}>
            {STATUS_TEXT[target.status]}
          </span>
          {target.model ? (
            <span className={s.metaItem} data-key="model" title={target.model}>
              {target.model}
            </span>
          ) : null}
          <span className={s.metaItem} data-key="duration">
            {live ? "已运行" : "耗时"} {duration || "0s"}
          </span>
          <span className={s.metaItem} data-key="tools">
            {tools} 次工具调用
          </span>
        </div>

        <div className={s.logHead}>
          <span className={s.logLabel}>日志尾部</span>
          <button
            className={s.followBtn}
            type="button"
            aria-pressed={follow}
            onClick={() => setFollow((prev) => !prev)}
          >
            {follow ? "暂停跟随" : "继续跟随"}
          </button>
        </div>

        <div
          className={s.log}
          ref={logRef}
          data-follow={follow ? "true" : "false"}
          onScroll={(event) => {
            const el = event.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 12;
            if (atBottom !== follow) setFollow(atBottom);
          }}
        >
          {target.lines.length === 0 ? (
            <p className={s.logEmpty}>暂无日志行（内核没有回传子代理的工具/进度事件）</p>
          ) : (
            target.lines.map((line, index) => (
              <div className={s.logLine} key={`${target.id}:${index}:${line}`}>
                <span className={s.caret} aria-hidden="true">
                  ›
                </span>
                {line}
              </div>
            ))
          )}
        </div>

        <footer className={s.foot}>
          <button
            className={s.btn}
            type="button"
            data-variant="ghost"
            disabled={!jumpEnabled}
            title={
              target.childSessionId
                ? `在页面中打开子会话 ${target.childSessionId}`
                : "内核没有回传子会话 id，只能在这里看运行情况"
            }
            onClick={() => {
              if (target.childSessionId && onOpenInPage) onOpenInPage(target.childSessionId);
            }}
          >
            在页面中打开
          </button>
          <button className={s.btn} type="button" data-variant="primary" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}

/** 小组件：给定节点状态给面板上色用的 tone 名。 */
export const subagentStatusTone = (status: SubagentStatus | DelegateRunStatus): string => {
  if (status === "running" || status === "queued") return "run";
  if (status === "failed" || status === "interrupted") return "err";
  return "ok";
};
