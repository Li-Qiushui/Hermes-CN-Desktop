import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { AlertCircle, Bot, CheckCircle2, ChevronRight, Copy, SquareTerminal, X } from "lucide-react";
import { LoadingIndicator } from "@hermes/shared-ui";
import { CopyButton } from "@/components/ui/copy-button";
import { formatTokens } from "@/lib/format";
import {
  activeCliDelegationCount,
  cliDelegationsBySessionAtom,
  type CliDelegationEntry,
} from "@/stores/cli-delegations";
import {
  activeSubagentCount,
  buildSubagentTree,
  compareSubagentPanelOrder,
  countSubagentOutcomes,
  lastSubagentOutput,
  subagentOutcome,
  subagentsBySessionAtom,
  type SubagentNode,
  type SubagentOutcome,
  type SubagentProgress,
  type SubagentStatus,
  type SubagentStreamEntry,
} from "@/stores/subagents";
import { canInterruptRow, type DelegateRunRow } from "./delegate-run-model";
import {
  SubagentDialog,
  dialogTargetFromProgress,
  formatSubagentDuration,
  subagentStatusTone,
  type SubagentDialogTarget,
} from "./subagent-dialog";
import { PanelResizeHandle, usePanelWidth } from "./panel-resize";
import s from "./subagent-panel.module.css";

// One persistent session id can surface under several gateway-session ids across
// resume/reconnect. The subagent store is keyed by the live event session_id, so
// we probe the candidate ids detail resolves and take the first non-empty hit.
export function useSessionSubagents(candidates: (string | undefined)[]): SubagentProgress[] {
  const bySession = useAtomValue(subagentsBySessionAtom);
  const key = candidates.filter(Boolean).join("|");
  return useMemo(() => {
    for (const id of candidates) {
      if (id && bySession[id]?.length) return bySession[id]!;
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bySession, key]);
}

/** 同 useSessionSubagents：按候选会话 id 读取外部 CLI 委派（P-047）。 */
export function useSessionCliDelegations(candidates: (string | undefined)[]): CliDelegationEntry[] {
  const bySession = useAtomValue(cliDelegationsBySessionAtom);
  const key = candidates.filter(Boolean).join("|");
  return useMemo(() => {
    for (const id of candidates) {
      if (id && bySession[id]?.length) return bySession[id]!;
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bySession, key]);
}

const fmtDuration = (seconds: number | undefined): string => {
  if (!seconds || seconds <= 0) return "";
  return formatSubagentDuration(seconds);
};

function fmtAge(updatedAt: number, now: number): string {
  const sec = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (sec < 2) return "刚刚";
  if (sec < 60) return `${sec}秒前`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}分前`;
  return `${Math.floor(m / 60)}时前`;
}

function StatusIcon({ status }: { status: SubagentStatus }) {
  if (status === "running" || status === "queued") {
    return <span className={s.statusIcon} data-tone="run" aria-label="运行中"><LoadingIndicator size="sm" /></span>;
  }
  if (status === "failed" || status === "interrupted") {
    return <AlertCircle className={s.statusIcon} data-tone="err" size={16} aria-label="失败" />;
  }
  return <CheckCircle2 className={s.statusIcon} data-tone="ok" size={16} aria-label="已完成" />;
}

function streamGlyph(entry: SubagentStreamEntry): ReactNode {
  if (entry.isError) return <AlertCircle className={s.streamGlyph} data-tone="err" size={12} aria-hidden />;
  if (entry.kind === "summary") {
    return <CheckCircle2 className={s.streamGlyph} data-tone="ok" size={12} aria-hidden />;
  }
  return <span className={s.streamDot} data-kind={entry.kind} aria-hidden />;
}

function StreamLine({ entry, active }: { entry: SubagentStreamEntry; active: boolean }) {
  return (
    <div className={s.streamLine} data-error={entry.isError ? "true" : undefined}>
      <span className={s.streamGlyphWrap}>{streamGlyph(entry)}</span>
      <span className={s.streamText} data-kind={entry.kind}>
        {entry.text}
        {active ? <LoadingIndicator className={s.inlineSpin} size="xs" /> : null}
      </span>
    </div>
  );
}

interface FlatEntry {
  depth: number;
  node: SubagentNode;
}

/** 树 → 带缩进的平铺列表；同级按「运行中 → 失败 → 已完成」排。 */
function flattenForPanel(nodes: readonly SubagentNode[], depth = 0, out: FlatEntry[] = []): FlatEntry[] {
  const ordered = [...nodes].sort(compareSubagentPanelOrder);
  for (const node of ordered) {
    out.push({ depth, node });
    flattenForPanel(node.children, depth + 1, out);
  }
  return out;
}

function canInterruptNode(node: SubagentProgress): boolean {
  return canInterruptRow({ status: node.status, subagentId: node.subagentId } as DelegateRunRow);
}

/** 面板一行：状态点 + 目标（截断）+ 模型/耗时/工具数 + 最后一行输出。 */
function SubagentItem({
  entry,
  now,
  onOpen,
  onInterrupt,
}: {
  entry: FlatEntry;
  now: number;
  onOpen: (target: SubagentDialogTarget) => void;
  onInterrupt?: (item: SubagentProgress) => void;
}) {
  const { node, depth } = entry;
  const live = node.status === "running" || node.status === "queued";
  const seconds =
    typeof node.durationSeconds === "number"
      ? Math.max(0, node.durationSeconds)
      : Math.max(0, (now - node.startedAt) / 1000);
  const duration = fmtDuration(seconds) || "0s";
  const tools = node.toolCount ?? 0;
  const last = lastSubagentOutput(node);
  const meta = [
    node.model,
    live ? `已运行 ${duration}` : `耗时 ${duration}`,
    `${tools} 次工具`,
    live ? "" : `更新于 ${fmtAge(node.updatedAt, now)}`,
  ].filter(Boolean);

  return (
    <div
      className={s.item}
      data-subagent-row={node.id}
      data-status={node.status}
      data-depth={depth}
      style={depth > 0 ? { paddingLeft: 12 + depth * 12 } : undefined}
    >
      <button
        className={s.itemHead}
        type="button"
        title="查看这个子代理的运行情况"
        onClick={() => onOpen(dialogTargetFromProgress(node))}
      >
        <span className={s.dot} data-tone={subagentStatusTone(node.status)} aria-hidden="true" />
        <span className={s.itemMain}>
          <span className={s.itemGoal}>{node.goal}</span>
          <span className={s.itemMeta}>{meta.join(" · ")}</span>
          <span className={s.itemLast} data-empty={last ? undefined : "true"}>
            {last || "等待子代理输出…"}
          </span>
        </span>
      </button>
      {onInterrupt && canInterruptNode(node) ? (
        <button
          className={s.itemInterrupt}
          type="button"
          onClick={() => onInterrupt(node)}
          title="中断这个子代理"
        >
          中断
        </button>
      ) : null}
    </div>
  );
}

// ── 外部 CLI 委派（Claude Code / Codex，P-047）────────────────────────────

const CLI_AGENT_LABELS: Record<CliDelegationEntry["agent"], string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

const CLI_MODE_LABELS: Record<string, string> = {
  print: "单次任务",
  exec: "执行任务",
  review: "代码评审",
  resume: "续写会话",
  interactive: "交互会话",
};

// 只给异常/特殊态配文字——completed/running 由状态图标表达，副标题不再
// 重复「已完成」字样（用户反馈：信息堆叠混乱）。
const CLI_ABNORMAL_STATUS_LABELS: Partial<Record<CliDelegationEntry["status"], string>> = {
  failed: "失败",
  killed: "已终止",
  lost: "状态丢失",
  detached: "结果未跟踪",
};

const cliOutcome = (entry: CliDelegationEntry): SubagentOutcome =>
  entry.status === "running" || entry.status === "detached"
    ? "running"
    : entry.status === "completed"
      ? "completed"
      : "failed";

function cliTokenTotal(entry: Pick<CliDelegationEntry, "result">): number {
  const result = entry.result;
  if (!result) return 0;
  if (result.totalTokens !== undefined) return result.totalTokens;
  return (
    (result.inputTokens ?? 0) +
    (result.outputTokens ?? 0) +
    (result.cacheCreationInputTokens ?? 0) +
    (result.cacheReadInputTokens ?? 0)
  );
}

function CliDetailRow({
  label,
  value,
  placeholder,
}: {
  label: string;
  value?: string;
  placeholder: string;
}) {
  const content = (
    <>
      <span className={s.cliDetailLabel}>{label}</span>
      <span className={s.cliDetailValue}>{value ?? placeholder}</span>
    </>
  );

  if (!value) {
    return (
      <span className={s.cliDetailRow} data-cli-detail-row={label} data-copyable="false">
        {content}
      </span>
    );
  }

  return (
    <CopyButton
      className={s.cliDetailRow}
      text={value}
      showStatusIcon={false}
      copiedLabel={(
        <>
          <span className={s.cliDetailLabel}>{label}</span>
          <span className={s.cliDetailValue}>已复制</span>
          <CheckCircle2 className={s.cliDetailAction} size={12} aria-hidden />
        </>
      )}
      errorLabel={(
        <>
          <span className={s.cliDetailLabel}>{label}</span>
          <span className={s.cliDetailValue}>复制失败</span>
          <AlertCircle className={s.cliDetailAction} size={12} aria-hidden />
        </>
      )}
      title={`点击复制${label}：${value}`}
      aria-label={`复制${label}：${value}`}
      data-cli-detail-row={label}
      data-copyable="true"
    >
      {content}
      <Copy className={s.cliDetailAction} size={12} aria-hidden />
    </CopyButton>
  );
}

/** Codex / Claude Code 委派详情：固定三行，长值单行省略，可用整行复制。 */
export function CliDelegationDetails({
  entry,
  running,
}: {
  entry: CliDelegationEntry;
  running: boolean;
}) {
  const tokens = cliTokenTotal(entry);
  const sessionId = entry.result?.sessionId;
  const workdir = entry.result?.workdir ?? entry.workdir ?? undefined;
  const tokenLabel = tokens > 0 ? formatTokens(tokens) : undefined;

  return (
    <div className={s.cliDetailList}>
      <CliDetailRow label="会话" value={sessionId} placeholder={running ? "获取中" : "未提供"} />
      <CliDetailRow label="目录" value={workdir} placeholder={running ? "获取中" : "未提供"} />
      <CliDetailRow label="Token" value={tokenLabel} placeholder={running ? "统计中" : "未提供"} />
    </div>
  );
}

function CliStatusIcon({ status }: { status: CliDelegationEntry["status"] }) {
  if (status === "running") {
    return <span className={s.statusIcon} data-tone="run" aria-label="执行中"><LoadingIndicator size="sm" /></span>;
  }
  if (status === "failed" || status === "killed" || status === "lost") {
    return <AlertCircle className={s.statusIcon} data-tone="err" size={16} aria-label="失败" />;
  }
  if (status === "detached") {
    return <SquareTerminal className={s.statusIcon} size={16} aria-label="后台运行" />;
  }
  return <CheckCircle2 className={s.statusIcon} data-tone="ok" size={16} aria-label="已完成" />;
}

function cliStreamEntries(entry: CliDelegationEntry): SubagentStreamEntry[] {
  const out: SubagentStreamEntry[] = [];
  entry.timeline.forEach((event, index) => {
    let text = "";
    let kind: SubagentStreamEntry["kind"] = "progress";
    if (event.kind === "tool_use") {
      kind = "tool";
      const snippet = event.text ? `("${event.text.slice(0, 96)}")` : "";
      text = `${event.toolName ?? "工具"}${snippet}`;
    } else if (event.kind === "result") {
      kind = "summary";
      const eventTokens =
        event.totalTokens ??
        ((event.inputTokens ?? 0) +
          (event.outputTokens ?? 0) +
          (event.cacheCreationInputTokens ?? 0) +
          (event.cacheReadInputTokens ?? 0));
      text = [
        event.isError ? "子任务出错" : "子任务完成",
        event.numTurns !== undefined ? `${event.numTurns} 轮` : "",
        eventTokens > 0 ? `${formatTokens(eventTokens)} tok` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    } else if (event.kind === "init") {
      text = [
        "已连接",
        event.model ?? "",
        event.workdir ? `目录 ${event.workdir}` : "",
      ].filter(Boolean).join(" · ");
    } else {
      text = event.text ?? "";
    }
    if (text) out.push({ at: index, isError: event.isError, kind, text });
  });
  return out;
}

function CliDelegationRow({ entry, now }: { entry: CliDelegationEntry; now: number }) {
  const running = entry.status === "running";
  const [open, setOpen] = useState(running);

  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);

  const durationSeconds =
    typeof entry.durationS === "number"
      ? Math.max(0, Math.round(entry.durationS))
      : entry.startedAt > 0
        ? Math.max(0, Math.round((now - entry.startedAt) / 1000))
        : 0;

  // 一行只说必要的话：代理名 ·（后台）·（异常态说明）。completed/running
  // 由左侧图标表达；时长右置常显；会话 id 等细节收进展开态。
  const abnormal = CLI_ABNORMAL_STATUS_LABELS[entry.status];
  const tokens = cliTokenTotal(entry);
  const model =
    entry.result?.model ??
    (typeof entry.flags?.model === "string" ? entry.flags.model : "");
  const subtitle = [
    CLI_AGENT_LABELS[entry.agent],
    model,
    entry.execution === "background" ? "后台" : "",
    tokens > 0 ? `${formatTokens(tokens)} tok` : "",
    abnormal ?? "",
  ].filter(Boolean);

  const stream = cliStreamEntries(entry);
  const visibleRows = open ? stream.slice(-10) : stream.slice(-2);
  const metaParts = open
    ? [
        entry.mode ? (CLI_MODE_LABELS[entry.mode] ?? "") : "",
        entry.result?.numTurns !== undefined ? `${entry.result.numTurns} 轮` : "",
        entry.exitCode !== undefined && entry.exitCode !== null && entry.exitCode !== 0
          ? `退出码 ${entry.exitCode}`
          : "",
      ].filter(Boolean)
    : [];

  return (
    <div className={s.row} data-running={running ? "true" : undefined} data-cli-row={entry.id}>
      <button className={s.rowHead} type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronRight className={s.chevron} data-open={open ? "true" : undefined} size={12} aria-hidden />
        <CliStatusIcon status={entry.status} />
        <span className={s.rowMain}>
          <span className={s.goal} data-running={running ? "true" : undefined}>
            {entry.promptExcerpt || CLI_AGENT_LABELS[entry.agent]}
          </span>
          {subtitle.length > 0 ? <span className={s.subtitle}>{subtitle.join(" · ")}</span> : null}
        </span>
        <span className={s.timer}>{fmtDuration(durationSeconds) || (running ? "0s" : "")}</span>
      </button>

      {visibleRows.length > 0 ? (
        <div className={s.stream}>
          {visibleRows.map((line, i) => (
            <StreamLine key={`${line.kind}:${line.at}:${i}`} entry={line} active={running && i === visibleRows.length - 1} />
          ))}
        </div>
      ) : null}

      {open ? (
        <div className={s.files}>
          <span className={s.filesLabel}>
            详情{metaParts.length > 0 ? ` · ${metaParts.join(" · ")}` : ""}
          </span>
          <CliDelegationDetails entry={entry} running={running} />
        </div>
      ) : null}
    </div>
  );
}

// ── 汇总条 ──────────────────────────────────────────────────────────────────

const FILTERS: { key: SubagentOutcome; label: string }[] = [
  { key: "running", label: "运行中" },
  { key: "completed", label: "完成" },
  { key: "failed", label: "失败" },
];

export function SubagentPanel({
  subagents,
  cliDelegations = [],
  onClose,
  onClearFinished,
  onOpenSession,
  onInterrupt,
}: {
  subagents: SubagentProgress[];
  cliDelegations?: CliDelegationEntry[];
  onClose: () => void;
  onClearFinished?: () => void;
  /** 「在页面中打开」：跳子会话（detail 会写来源，返回条才出得来）。 */
  onOpenSession?: (childSessionId: string) => void;
  onInterrupt?: (item: SubagentProgress) => void;
}) {
  const tree = useMemo(() => buildSubagentTree(subagents), [subagents]);
  const entries = useMemo(() => flattenForPanel(tree), [tree]);

  const [filter, setFilter] = useState<SubagentOutcome | "all">("all");
  const [dialog, setDialog] = useState<SubagentDialogTarget | null>(null);

  const internalCounts = useMemo(
    () => countSubagentOutcomes(entries.map((entry) => entry.node)),
    [entries],
  );
  const counts = useMemo(() => {
    const total = { ...internalCounts };
    for (const entry of cliDelegations) total[cliOutcome(entry)] += 1;
    return total;
  }, [cliDelegations, internalCounts]);

  const active =
    activeSubagentCount(entries.map((entry) => entry.node)) + activeCliDelegationCount(cliDelegations);
  const finishedCount =
    entries.filter((entry) => subagentOutcome(entry.node.status) !== "running").length +
    cliDelegations.filter((entry) => cliOutcome(entry) !== "running").length;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (active <= 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [active]);

  const visibleEntries = useMemo(
    () => (filter === "all" ? entries : entries.filter((entry) => subagentOutcome(entry.node.status) === filter)),
    [entries, filter],
  );
  const visibleCli = useMemo(
    () => (filter === "all" ? cliDelegations : cliDelegations.filter((entry) => cliOutcome(entry) === filter)),
    [cliDelegations, filter],
  );

  const total = entries.length + cliDelegations.length;
  const empty = total === 0;
  const tools = entries.reduce((sum, entry) => sum + (entry.node.toolCount ?? 0), 0);
  const tokens =
    entries.reduce(
      (sum, entry) => sum + (entry.node.inputTokens ?? 0) + (entry.node.outputTokens ?? 0),
      0,
    ) + cliDelegations.reduce((sum, entry) => sum + cliTokenTotal(entry), 0);

  const { width, onResizeStart } = usePanelWidth(360, 280, 640);

  const toggleFilter = (key: SubagentOutcome) =>
    setFilter((prev) => (prev === key ? "all" : key));

  return (
    <aside className={s.panel} aria-label="子Agent 监视" style={{ width, flexBasis: width }}>
      <PanelResizeHandle ariaLabel="调整子Agent 面板宽度" onPointerDown={onResizeStart} />
      <header className={s.header}>
        <span className={s.headerTitle}>
          <Bot size={16} aria-hidden />
          子Agent 监视
        </span>
        {onClearFinished && finishedCount > 0 ? (
          <button
            className={s.clearFinished}
            type="button"
            onClick={onClearFinished}
            title="移除已结束的子Agent 与委派记录"
          >
            清空已结束
          </button>
        ) : null}
        <button className={s.close} type="button" onClick={onClose} aria-label="关闭子Agent 监视">
          <X size={16} aria-hidden />
        </button>
      </header>

      {empty ? (
        <div className={s.empty}>
          <Bot size={28} className={s.emptyIcon} aria-hidden />
          <p className={s.emptyTitle}>当前会话没有子代理</p>
          <p className={s.emptyDesc}>
            让主代理用 <code className={s.emptyCode}>delegate_task</code> 派发并行子任务，
            或委派 Claude Code / Codex 等外部 CLI，这里会实时显示它们的运行情况。
          </p>
        </div>
      ) : (
        <>
          <div className={s.summaryBar} role="group" aria-label="子代理状态筛选">
            <button
              className={s.summaryChip}
              type="button"
              data-tone="run"
              data-active={filter === "running" ? "true" : undefined}
              aria-pressed={filter === "running"}
              onClick={() => toggleFilter("running")}
            >
              运行中 {counts.running}
            </button>
            <button
              className={s.summaryChip}
              type="button"
              data-tone="ok"
              data-active={filter === "completed" ? "true" : undefined}
              aria-pressed={filter === "completed"}
              onClick={() => toggleFilter("completed")}
            >
              完成 {counts.completed}
            </button>
            <button
              className={s.summaryChip}
              type="button"
              data-tone="err"
              data-active={filter === "failed" ? "true" : undefined}
              aria-pressed={filter === "failed"}
              onClick={() => toggleFilter("failed")}
            >
              失败 {counts.failed}
            </button>
            {tools > 0 || tokens > 0 ? (
              <span className={s.summaryNote}>
                {[tools > 0 ? `${tools} 工具` : "", tokens > 0 ? `${formatTokens(tokens)} tok` : ""]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            ) : null}
          </div>

          <div className={s.scroll}>
            {visibleCli.length > 0 ? (
              <section className={s.group}>
                <p className={s.groupLabel}>
                  外部 CLI 委派 · {visibleCli.length} 个
                  {visibleCli.filter((entry) => cliOutcome(entry) === "running").length > 0 ? (
                    <span className={s.groupActive}>
                      {" · "}
                      {visibleCli.filter((entry) => cliOutcome(entry) === "running").length} 个运行中
                    </span>
                  ) : null}
                </p>
                <div className={s.groupBody}>
                  {visibleCli.map((entry) => (
                    <CliDelegationRow key={entry.id} entry={entry} now={now} />
                  ))}
                </div>
              </section>
            ) : null}

            {visibleEntries.length > 0 ? (
              <section className={s.group}>
                <p className={s.groupLabel}>
                  子代理 · {visibleEntries.length} 个
                  {visibleEntries.filter((entry) => subagentOutcome(entry.node.status) === "running").length > 0 ? (
                    <span className={s.groupActive}>
                      {" · "}
                      {visibleEntries.filter((entry) => subagentOutcome(entry.node.status) === "running").length} 个运行中
                    </span>
                  ) : null}
                </p>
                <div className={s.list}>
                  {visibleEntries.map((entry) => (
                    <SubagentItem
                      key={entry.node.id}
                      entry={entry}
                      now={now}
                      onOpen={setDialog}
                      onInterrupt={onInterrupt}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {visibleEntries.length === 0 && visibleCli.length === 0 ? (
              <div className={s.filteredEmpty}>
                <p className={s.emptyTitle}>没有符合筛选的子代理</p>
                <button className={s.filteredEmptyBtn} type="button" onClick={() => setFilter("all")}>
                  清除筛选
                </button>
              </div>
            ) : null}
          </div>
        </>
      )}

      {dialog ? (
        <SubagentDialog
          target={dialog}
          onClose={() => setDialog(null)}
          onOpenInPage={onOpenSession}
          now={now}
        />
      ) : null}
    </aside>
  );
}
