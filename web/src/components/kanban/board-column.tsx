import { memo, type ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { kanbanColumnLabel, type ColumnCollapseState, type ColumnView } from "@/lib/kanban";
import { groupTasksByAssignee, type Swimlane } from "@/lib/kanban-orchestration";
import { TaskCard } from "./task-card";
import s from "./board-column.module.css";

interface BoardColumnProps {
  view: ColumnView;
  icon: ReactNode;
  selectedId: string | null;
  canDrag: boolean;
  collapse: ColumnCollapseState;
  filtersActive: boolean;
  bulkSelectedIds?: readonly string[];
  swimlanes?: boolean;
  onOpenTask: (taskId: string) => void;
  onToggleSelectTask?: (taskId: string) => void;
  onExpandDone: () => void;
  onShowAllDone: () => void;
  onToggleCollapse: () => void;
}

function BoardColumnInner({
  view,
  icon,
  selectedId,
  canDrag,
  collapse,
  filtersActive,
  bulkSelectedIds,
  swimlanes = false,
  onOpenTask,
  onToggleSelectTask,
  onExpandDone,
  onShowAllDone,
  onToggleCollapse,
}: BoardColumnProps) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: `col:${view.key}`,
    data: { column: view.key },
  });
  const dragging = Boolean(active);
  const dropState = dragging ? (view.dragTarget ? "allowed" : "forbidden") : undefined;
  const narrow = collapse.collapsed && !(dragging && isOver);
  const columnLabel = kanbanColumnLabel(view.label);
  const lanes: Swimlane[] | null = swimlanes ? groupTasksByAssignee(view.tasks) : null;

  const renderCard = (task: (typeof view.tasks)[number]) => (
    <TaskCard
      key={task.id}
      task={task}
      selected={selectedId === task.id}
      bulkSelected={bulkSelectedIds ? bulkSelectedIds.includes(task.id) : false}
      draggable={canDrag}
      onOpen={onOpenTask}
      onToggleSelect={onToggleSelectTask}
    />
  );

  return (
    <section
      ref={setNodeRef}
      className={s.column}
      data-narrow={narrow ? "true" : undefined}
      data-reason={narrow ? (collapse.reason ?? undefined) : undefined}
      data-dragging={dragging ? "true" : undefined}
      data-over={isOver && view.dragTarget ? "true" : undefined}
      data-drop={dropState}
      aria-label={`${columnLabel} 列，${view.total} 个任务`}
    >
      {narrow ? (
        <button
          type="button"
          className={s.narrow}
          onClick={onToggleCollapse}
          title={`${columnLabel} · ${view.total} 个任务${filtersActive ? ` · 已筛选 ${view.total}/${view.unfilteredTotal}` : ""}（点击展开）`}
          aria-label={`展开「${columnLabel}」列`}
        >
          <ChevronRight size={14} className={s.narrowChevron} aria-hidden="true" />
          <span className={s.narrowTitle}>{columnLabel}</span>
          <span className={s.narrowCount}>{view.total}</span>
          {collapse.reason === "auto" ? <span className={s.narrowEmpty}>空</span> : null}
        </button>
      ) : (
        <>
          <header className={s.head}>
            <span className={s.headIcon} aria-hidden="true">
              {icon}
            </span>
            <span className={s.headLabel}>{columnLabel}</span>
            {filtersActive ? (
              <span className={s.headFilter}>
                已筛选 {view.total}/{view.unfilteredTotal}
              </span>
            ) : null}
            <span className={s.headCount}>{view.total}</span>
            <button
              type="button"
              className={s.collapseToggle}
              onClick={onToggleCollapse}
              aria-label={`收起「${columnLabel}」列`}
              title="收起这一列"
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
          </header>

          {view.collapsed ? (
            <button type="button" className={s.collapsedRow} onClick={onExpandDone}>
              <span>已完成 {view.total} · 展开</span>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          ) : (
            <div className={s.cards}>
              {view.tasks.length === 0 ? (
                <p className={s.empty}>
                  {view.unfilteredTotal > 0 ? "没有符合筛选的任务" : "这一列还没有任务"}
                </p>
              ) : lanes ? (
                lanes.map((lane) => (
                  <div key={lane.key} className={s.lane} data-lane={lane.key}>
                    <div className={s.laneHead}>
                      <span className={s.laneLabel}>{lane.label}</span>
                      <span className={s.laneCount}>{lane.tasks.length}</span>
                    </div>
                    {lane.tasks.map(renderCard)}
                  </div>
                ))
              ) : (
                view.tasks.map(renderCard)
              )}
              {view.hiddenCount > 0 ? (
                <button type="button" className={s.moreRow} onClick={onShowAllDone}>
                  显示全部 {view.total} 条
                </button>
              ) : null}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export const BoardColumn = memo(BoardColumnInner);
