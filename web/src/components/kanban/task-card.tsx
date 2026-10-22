import { memo, useCallback, type CSSProperties, type MouseEvent } from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { AlertTriangle, GitBranch, ListChecks, MessageSquare } from "lucide-react";
import {
  blockedBadgeLabel,
  cardSummaryLine,
  humanizeAge,
  priorityLabel,
  progressLabel,
  runClockStartSeconds,
  type KanbanTask,
} from "@/lib/kanban";
import { RunClock } from "./run-clock";
import s from "./task-card.module.css";

export interface TaskCardProps {
  task: KanbanTask;
  selected: boolean;
  draggable: boolean;
  bulkSelected?: boolean;
  onOpen: (taskId: string) => void;
  onToggleSelect?: (taskId: string) => void;
}

function TaskCardInner({
  task,
  selected,
  draggable,
  bulkSelected = false,
  onOpen,
  onToggleSelect,
}: TaskCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    data: { status: task.status },
    disabled: !draggable,
  });

  const open = useCallback(() => onOpen(task.id), [onOpen, task.id]);
  const priority = priorityLabel(task.priority);
  const comments = task.comment_count ?? 0;
  const children = task.link_counts?.children ?? 0;
  const summary = cardSummaryLine(task);
  const progress = progressLabel(task.progress);
  const blocked = blockedBadgeLabel(task);
  const runStarted = task.status === "running" ? runClockStartSeconds(task) : null;
  const unassigned = !task.assignee;

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();
      onToggleSelect?.(task.id);
      return;
    }
    open();
  };

  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.45 : undefined,
    zIndex: isDragging ? 2 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={s.card}
      data-selected={selected ? "true" : undefined}
      data-bulk={bulkSelected ? "true" : undefined}
      data-dragging={isDragging ? "true" : undefined}
      aria-label={`${task.title}，状态 ${task.status}`}
      {...attributes}
      {...listeners}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
    >
      <div className={s.title}>{task.title || "未命名任务"}</div>
      {summary ? (
        <div className={s.summary} title={summary}>
          {summary}
        </div>
      ) : null}
      <div className={s.meta}>
        <span className={s.assignee} data-unassigned={unassigned ? "true" : undefined}>
          {task.assignee || "未指派"}
        </span>
        {priority ? <span className={s.priority}>{priority}</span> : null}
        <span className={s.age}>{humanizeAge(task.age?.created_age_seconds)}</span>
        {comments > 0 ? (
          <span className={s.stat}>
            <MessageSquare size={13} aria-hidden="true" />
            {comments}
          </span>
        ) : null}
        {children > 0 ? (
          <span className={s.stat}>
            <GitBranch size={13} aria-hidden="true" />
            {children}
          </span>
        ) : null}
        {progress ? (
          <span className={s.stat} title="子任务完成进度">
            <ListChecks size={13} aria-hidden="true" />
            {progress}
          </span>
        ) : null}
        {runStarted ? <RunClock startedAt={runStarted} className={s.clock} /> : null}
      </div>
      {blocked ? (
        <div className={s.blocked} title={blocked}>
          <AlertTriangle size={13} aria-hidden="true" />
          {blocked}
        </div>
      ) : null}
    </div>
  );
}

function propsEqual(prev: TaskCardProps, next: TaskCardProps): boolean {
  return (
    prev.selected === next.selected &&
    prev.draggable === next.draggable &&
    prev.bulkSelected === next.bulkSelected &&
    prev.onOpen === next.onOpen &&
    prev.onToggleSelect === next.onToggleSelect &&
    prev.task.id === next.task.id &&
    prev.task.status === next.task.status &&
    prev.task.title === next.task.title &&
    prev.task.assignee === next.task.assignee &&
    prev.task.priority === next.task.priority &&
    prev.task.comment_count === next.task.comment_count &&
    prev.task.latest_summary === next.task.latest_summary &&
    prev.task.block_kind === next.task.block_kind &&
    prev.task.block_reason === next.task.block_reason &&
    prev.task.current_run_started_at === next.task.current_run_started_at &&
    prev.task.progress?.done === next.task.progress?.done &&
    prev.task.progress?.total === next.task.progress?.total &&
    prev.task.age?.created_age_seconds === next.task.age?.created_age_seconds &&
    prev.task.link_counts?.children === next.task.link_counts?.children
  );
}

export const TaskCard = memo(TaskCardInner, propsEqual);
