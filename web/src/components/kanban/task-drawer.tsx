import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Send, X } from "lucide-react";
import { MarkdownText } from "@/components/chat/markdown-renderer";
import {
  buildActivityFeed,
  formatEpochSeconds,
  humanizeAge,
  kanbanColumnLabel,
  kanbanEventKindLabel,
  tailLogLines,
  type KanbanDiagnostic,
  type KanbanTask,
  type KanbanTaskDetailResponse,
  type KanbanTaskLogResponse,
  type KanbanWorkflowColumn,
} from "@/lib/kanban";
import s from "./task-drawer.module.css";

const ACTIVITY_PAGE_SIZE = 20;

export interface TaskDrawerProps {
  open: boolean;
  task: KanbanTask | null;
  detail: KanbanTaskDetailResponse | null;
  diagnostics?: KanbanDiagnostic[] | null;
  log?: KanbanTaskLogResponse | null;
  logLoading?: boolean;
  loading: boolean;
  error: string | null;
  commentError?: string | null;
  commenting?: boolean;
  columns: KanbanWorkflowColumn[];
  assignees: string[];
  saving: boolean;
  onClose: () => void;
  onSave: (patch: { status?: string; assignee?: string; title?: string }) => void;
  onAddComment?: (body: string) => boolean | void | Promise<boolean | void>;
}

function severityLabel(severity: string | null | undefined): string {
  if (severity === "critical") return "严重";
  if (severity === "error") return "错误";
  if (severity === "warning") return "警告";
  return severity || "提示";
}

function diagnosticText(item: KanbanDiagnostic): string {
  const message = (item.message ?? item.detail ?? "").trim();
  if (message) return message;
  return item.kind;
}

function diagnosticAdvice(item: KanbanDiagnostic): string | null {
  const advice = (item.suggestion ?? item.action ?? "").trim();
  return advice || null;
}

export function TaskDrawer({
  open,
  task,
  detail,
  diagnostics,
  log,
  logLoading = false,
  loading,
  error,
  commentError,
  commenting = false,
  columns,
  assignees,
  saving,
  onClose,
  onSave,
  onAddComment,
}: TaskDrawerProps) {
  const current = detail?.task ?? task;
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState("");
  const [assignee, setAssignee] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!current) return;
    setTitle(current.title ?? "");
    setStatus(current.status ?? "");
    setAssignee(current.assignee ?? "");
  }, [current?.id, current?.title, current?.status, current?.assignee]);

  useEffect(() => {
    setCommentDraft("");
    setActivityExpanded(false);
    setLogOpen(false);
  }, [task?.id]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const comments = detail?.comments ?? [];
  const runs = detail?.runs ?? [];
  const activity = useMemo(() => buildActivityFeed(detail?.events, detail?.runs), [detail?.events, detail?.runs]);
  const visibleActivity = activityExpanded ? activity : activity.slice(0, ACTIVITY_PAGE_SIZE);
  const logTail = useMemo(() => tailLogLines(log?.content), [log?.content]);
  const taskDiagnostics = useMemo(() => {
    const fromDetail = current?.diagnostics ?? null;
    if (fromDetail && fromDetail.length > 0) return fromDetail;
    if (diagnostics && diagnostics.length > 0) return diagnostics;
    return [];
  }, [current?.diagnostics, diagnostics]);

  const dirty = useMemo(() => {
    if (!current) return false;
    return (
      title.trim() !== (current.title ?? "").trim() ||
      status !== (current.status ?? "") ||
      assignee !== (current.assignee ?? "")
    );
  }, [assignee, current, status, title]);

  if (!open || !current || typeof document === "undefined") return null;

  const body = detail?.task?.body ?? current.body;
  const failure = current.last_failure_error;
  const hasLog = runs.length > 0 || Boolean(log?.exists);

  const submit = () => {
    const patch: { status?: string; assignee?: string; title?: string } = {};
    if (title.trim() && title.trim() !== (current.title ?? "").trim()) patch.title = title.trim();
    if (status && status !== current.status) patch.status = status;
    if (assignee && assignee !== (current.assignee ?? "")) patch.assignee = assignee;
    if (Object.keys(patch).length === 0) return;
    onSave(patch);
  };

  const submitComment = async () => {
    const text = commentDraft.trim();
    if (!text || !onAddComment || commenting) return;
    const accepted = await onAddComment(text);
    if (accepted !== false) setCommentDraft("");
  };

  return createPortal(
    <div className={s.backdrop} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside
        className={s.drawer}
        role="dialog"
        aria-modal="true"
        aria-label={`任务详情 ${current.title}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={s.head}>
          <span className={s.taskId}>{current.id}</span>
          <button type="button" className={s.close} onClick={onClose} aria-label="关闭详情">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className={s.body}>
          {taskDiagnostics.length > 0 ? (
            <section className={s.callout} data-tone={taskDiagnostics[0]?.severity ?? "warning"} aria-label="诊断">
              <div className={s.calloutHead}>
                <AlertTriangle size={14} aria-hidden="true" />
                诊断 · {taskDiagnostics.length} 条
              </div>
              <ul className={s.calloutList}>
                {taskDiagnostics.map((item, index) => (
                  <li key={`${item.kind}-${index}`}>
                    <span className={s.calloutSeverity}>{severityLabel(item.severity)}</span>
                    <span className={s.calloutText}>{diagnosticText(item)}</span>
                    {diagnosticAdvice(item) ? (
                      <span className={s.calloutAdvice}>建议：{diagnosticAdvice(item)}（需手动处理）</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <input
            ref={titleRef}
            className={s.titleInput}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label="任务标题"
            spellCheck={false}
          />

          <div className={s.fieldGrid}>
            <label className={s.field}>
              <span>状态</span>
              <select value={status} onChange={(event) => setStatus(event.target.value)}>
                {columns.map((column) => (
                  <option key={column.key} value={column.key}>
                    {kanbanColumnLabel(column.label)}
                  </option>
                ))}
              </select>
            </label>
            <label className={s.field}>
              <span>负责人</span>
              <select value={assignee} onChange={(event) => setAssignee(event.target.value)}>
                {assignee && !assignees.includes(assignee) ? <option value={assignee}>{assignee}</option> : null}
                {assignees.length === 0 ? <option value="">未指派</option> : null}
                {assignees.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className={s.meta}>
            <span>停留 {humanizeAge(current.age?.created_age_seconds)}</span>
            <span>创建 {formatEpochSeconds(current.created_at)}</span>
            <span>开始 {formatEpochSeconds(current.started_at)}</span>
            <span>完成 {formatEpochSeconds(current.completed_at)}</span>
            <span>优先级 {current.priority && current.priority > 0 ? `P${current.priority}` : "无"}</span>
            <span>工作区 {current.workspace_kind || "—"}</span>
            {current.branch_name ? <span>分支 {current.branch_name}</span> : null}
            {current.block_kind ? <span>阻塞类型 {current.block_kind}</span> : null}
          </div>

          {loading ? <p className={s.hint}>正在加载任务详情…</p> : null}
          {error ? <p className={s.error}>详情加载失败：{error}</p> : null}

          {body ? (
            <section className={s.section}>
              <h3>任务描述</h3>
              <div className={s.markdown}>
                <MarkdownText text={body} />
              </div>
            </section>
          ) : (
            <p className={s.hint}>这个任务没有描述。</p>
          )}

          {current.latest_summary ? (
            <section className={s.section}>
              <h3>最新进展</h3>
              <div className={s.markdown}>
                <MarkdownText text={current.latest_summary} />
              </div>
            </section>
          ) : null}

          {current.result ? (
            <section className={s.section}>
              <h3>执行结果</h3>
              <div className={s.markdown}>
                <MarkdownText text={current.result} />
              </div>
            </section>
          ) : null}

          {failure ? (
            <section className={s.section}>
              <h3>
                <AlertTriangle size={14} aria-hidden="true" /> 失败信息
              </h3>
              <pre className={s.pre}>{failure}</pre>
            </section>
          ) : null}

          <section className={s.section} aria-label="评论">
            <h3>评论 · {comments.length} 条</h3>
            {comments.length === 0 ? (
              <p className={s.hint}>还没有评论</p>
            ) : (
              <ul className={s.comments}>
                {comments.map((comment) => (
                  <li key={comment.id} className={s.comment}>
                    <div className={s.commentHead}>
                      <span className={s.commentAuthor}>{comment.author || "匿名"}</span>
                      <span className={s.commentTime}>{formatEpochSeconds(comment.created_at)}</span>
                    </div>
                    <p className={s.commentBody}>{comment.body}</p>
                  </li>
                ))}
              </ul>
            )}
            {onAddComment ? (
              <div className={s.commentForm}>
                <textarea
                  className={s.commentInput}
                  value={commentDraft}
                  onChange={(event) => setCommentDraft(event.target.value)}
                  placeholder="写一条评论…"
                  aria-label="评论内容"
                  rows={3}
                  spellCheck={false}
                />
                {commentError ? <p className={s.error}>评论发送失败：{commentError}</p> : null}
                <button
                  type="button"
                  className={s.save}
                  onClick={() => void submitComment()}
                  disabled={!commentDraft.trim() || commenting}
                >
                  <Send size={14} aria-hidden="true" />
                  {commenting ? "发送中…" : "发表评论"}
                </button>
              </div>
            ) : null}
          </section>

          <section className={s.section} aria-label="活动与运行">
            <h3>活动与运行 · {activity.length} 条</h3>
            {activity.length === 0 ? (
              <p className={s.hint}>还没有活动记录</p>
            ) : (
              <>
                <ul className={s.activity}>
                  {visibleActivity.map((item) => (
                    <li key={item.key} className={s.activityItem}>
                      <span className={s.activityTime}>{formatEpochSeconds(item.at)}</span>
                      <span className={s.activityKind} data-kind={item.kind}>
                        {item.kind === "run" ? "运行" : "事件"}
                      </span>
                      <span className={s.activityLabel}>
                        {item.kind === "run" ? item.label : kanbanEventKindLabel(item.label)}
                      </span>
                      {item.detail ? <span className={s.activityDetail}>{item.detail}</span> : null}
                    </li>
                  ))}
                </ul>
                {activity.length > ACTIVITY_PAGE_SIZE ? (
                  <button
                    type="button"
                    className={s.inlineToggle}
                    onClick={() => setActivityExpanded((previous) => !previous)}
                    aria-expanded={activityExpanded}
                  >
                    {activityExpanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                    {activityExpanded ? "只看最近 20 条" : `展开全部 ${activity.length} 条`}
                  </button>
                ) : null}
              </>
            )}
          </section>

          {hasLog ? (
            <section className={s.section} aria-label="日志尾">
              <h3>
                <button
                  type="button"
                  className={s.inlineToggle}
                  onClick={() => setLogOpen((previous) => !previous)}
                  aria-expanded={logOpen}
                >
                  {logOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                  日志尾
                </button>
                <span className={s.hint}>
                  {log?.size_bytes ? `${log.size_bytes} 字节` : ""}
                  {log?.truncated ? " · 已截断" : ""}
                </span>
              </h3>
              {logOpen ? (
                logLoading ? (
                  <p className={s.hint}>正在读取日志…</p>
                ) : logTail.text ? (
                  <>
                    {logTail.hiddenLines > 0 ? (
                      <p className={s.hint}>仅显示末尾 200 行（隐藏 {logTail.hiddenLines} 行）</p>
                    ) : null}
                    <pre className={s.log}>{logTail.text}</pre>
                  </>
                ) : (
                  <p className={s.hint}>这个任务还没有日志输出</p>
                )
              ) : null}
            </section>
          ) : null}
        </div>

        <footer className={s.foot}>
          {dirty ? <span className={s.dirtyHint}>有未保存的修改</span> : <span className={s.hint}>改动会立即提交到内核</span>}
          <button type="button" className={s.save} onClick={submit} disabled={!dirty || saving}>
            <Check size={15} aria-hidden="true" />
            {saving ? "保存中…" : "保存修改"}
          </button>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}
