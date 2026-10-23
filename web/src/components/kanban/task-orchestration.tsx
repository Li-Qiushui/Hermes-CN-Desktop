import { useState } from "react";
import { Ban, FileUp, Link2, Split, Trash2, UserCog } from "lucide-react";
import { kanbanColumnLabel, type KanbanTask, type KanbanTaskAttachment, type KanbanTaskDetailResponse } from "@/lib/kanban";
import {
  attachmentLimitLabel,
  buildLinkGroups,
  canDecompose,
  decomposeChildNames,
  formatFileSize,
  linkCandidates,
  type DecomposeOutcome,
  type LinkCandidate,
} from "@/lib/kanban-orchestration";
import s from "./task-orchestration.module.css";

export interface TaskOrchestrationProps {
  task: KanbanTask;
  detail: KanbanTaskDetailResponse | null;
  profiles: string[];
  boardTasks: LinkCandidate[];
  busy: string | null;
  error: string | null;
  decompose: DecomposeOutcome | null;
  onAddLink: (role: "parent" | "child", otherId: string) => void;
  onRemoveLink: (role: "parent" | "child", otherId: string) => void;
  onBlock: (reason: string) => void;
  onUnblock: () => void;
  onDecompose: () => void;
  onReassign: (profile: string, reclaimFirst: boolean) => void;
  onUploadAttachment: (file: File) => void;
  onDeleteAttachment: (attachmentId: number) => void;
}

function roleLabel(role: "parent" | "child"): string {
  return role === "parent" ? "父任务" : "子任务";
}

export function TaskOrchestration({
  task,
  detail,
  profiles,
  boardTasks,
  busy,
  error,
  decompose,
  onAddLink,
  onRemoveLink,
  onBlock,
  onUnblock,
  onDecompose,
  onReassign,
  onUploadAttachment,
  onDeleteAttachment,
}: TaskOrchestrationProps) {
  const [linkTarget, setLinkTarget] = useState("");
  const [blockReason, setBlockReason] = useState("");
  const [reassignProfile, setReassignProfile] = useState("");
  const [reclaimFirst, setReclaimFirst] = useState(false);

  const links = detail?.links ?? null;
  const linkRows = buildLinkGroups(links, detail?.link_tasks);
  const candidates = linkCandidates(boardTasks, task.id, links);
  const attachments: KanbanTaskAttachment[] = detail?.attachments ?? [];
  const blocked = task.status === "blocked";
  const decomposable = canDecompose(task);

  return (
    <section className={s.wrap} aria-label="编排">
      <div className={s.block} aria-label="依赖与父子">
        <h3>
          <Link2 size={14} aria-hidden="true" /> 依赖与父子 · {linkRows.length} 条
        </h3>
        {linkRows.length === 0 ? (
          <p className={s.hint}>这个任务还没有父任务或子任务。</p>
        ) : (
          <ul className={s.rows}>
            {linkRows.map((row) => (
              <li key={`${row.role}-${row.id}`} className={s.row}>
                <span className={s.role} data-role={row.role}>
                  {roleLabel(row.role)}
                </span>
                <span className={s.rowTitle} title={`${row.id} · ${row.title}`}>
                  {row.title}
                </span>
                <span className={s.rowStatus}>{kanbanColumnLabel(row.status)}</span>
                <button
                  type="button"
                  className={s.rowAction}
                  onClick={() => onRemoveLink(row.role, row.id)}
                  disabled={Boolean(busy)}
                  aria-label={`移除${roleLabel(row.role)} ${row.title}`}
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {candidates.length > 0 ? (
          <div className={s.form}>
            <select
              className={s.select}
              value={linkTarget}
              onChange={(event) => setLinkTarget(event.target.value)}
              aria-label="选择要关联的任务"
            >
              <option value="">选择看板上的其他任务…</option>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.title} · {kanbanColumnLabel(candidate.status)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={s.button}
              disabled={!linkTarget || Boolean(busy)}
              onClick={() => {
                if (!linkTarget) return;
                onAddLink("parent", linkTarget);
                setLinkTarget("");
              }}
            >
              加为父任务
            </button>
            <button
              type="button"
              className={s.button}
              disabled={!linkTarget || Boolean(busy)}
              onClick={() => {
                if (!linkTarget) return;
                onAddLink("child", linkTarget);
                setLinkTarget("");
              }}
            >
              加为子任务
            </button>
          </div>
        ) : (
          <p className={s.hint}>看板上没有可关联的其他任务。</p>
        )}
      </div>

      <div className={s.block} aria-label="阻塞">
        <h3>
          <Ban size={14} aria-hidden="true" /> 阻塞
        </h3>
        {blocked ? (
          <div className={s.blockedBox}>
            <p className={s.blockedReason}>{task.block_reason || task.block_kind || "阻塞中（未记录原因）"}</p>
            <button type="button" className={s.button} onClick={onUnblock} disabled={Boolean(busy)}>
              解除阻塞
            </button>
          </div>
        ) : (
          <div className={s.form}>
            <input
              className={s.input}
              value={blockReason}
              onChange={(event) => setBlockReason(event.target.value)}
              placeholder="阻塞原因（可留空）"
              aria-label="阻塞原因"
              spellCheck={false}
            />
            <button
              type="button"
              className={s.button}
              disabled={Boolean(busy)}
              onClick={() => {
                onBlock(blockReason);
                setBlockReason("");
              }}
            >
              标记阻塞
            </button>
          </div>
        )}
      </div>

      {decomposable ? (
        <div className={s.block} aria-label="拆解">
          <h3>
            <Split size={14} aria-hidden="true" /> 拆解
          </h3>
          <div className={s.form}>
            <button type="button" className={s.button} onClick={onDecompose} disabled={Boolean(busy)}>
              {busy === "decompose" ? "拆解中…" : "拆成子任务"}
            </button>
          </div>
          {decompose ? (
            <div className={s.result} data-tone={decompose.ok ? "ok" : "err"} role="status">
              <p className={s.resultText}>{decompose.message}</p>
              {decompose.childIds.length > 0 ? (
                <p className={s.resultMeta}>子任务：{decomposeChildNames(decompose)}</p>
              ) : null}
              {decompose.newTitle ? <p className={s.resultMeta}>标题：{decompose.newTitle}</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={s.block} aria-label="重派">
        <h3>
          <UserCog size={14} aria-hidden="true" /> 重派
        </h3>
        {profiles.length === 0 ? (
          <p className={s.hint}>内核没有返回 profile 列表，暂时不能重派。</p>
        ) : (
          <div className={s.form}>
            <select
              className={s.select}
              value={reassignProfile}
              onChange={(event) => setReassignProfile(event.target.value)}
              aria-label="选择目标 profile"
            >
              <option value="">选择 profile…</option>
              {profiles.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <label className={s.check}>
              <input
                type="checkbox"
                checked={reclaimFirst}
                onChange={(event) => setReclaimFirst(event.target.checked)}
              />
              先回收占用
            </label>
            <button
              type="button"
              className={s.button}
              disabled={!reassignProfile || Boolean(busy)}
              onClick={() => {
                if (!reassignProfile) return;
                onReassign(reassignProfile, reclaimFirst);
              }}
            >
              重派
            </button>
          </div>
        )}
        {error ? (
          <p className={s.error} role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className={s.block} aria-label="附件">
        <h3>
          <FileUp size={14} aria-hidden="true" /> 附件 · {attachments.length} 个
        </h3>
        {attachments.length === 0 ? (
          <p className={s.hint}>还没有附件。</p>
        ) : (
          <ul className={s.rows}>
            {attachments.map((item) => (
              <li key={item.id} className={s.row}>
                <span className={s.rowTitle} title={item.filename}>
                  {item.filename}
                </span>
                <span className={s.rowStatus}>{formatFileSize(item.size)}</span>
                <button
                  type="button"
                  className={s.rowAction}
                  onClick={() => onDeleteAttachment(item.id)}
                  disabled={Boolean(busy)}
                  aria-label={`删除附件 ${item.filename}`}
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <label className={s.upload}>
          <FileUp size={14} aria-hidden="true" />
          上传附件
          <input
            type="file"
            className={s.fileInput}
            aria-label="上传附件"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              onUploadAttachment(file);
            }}
          />
        </label>
        <p className={s.hint}>单个附件上限 {attachmentLimitLabel()}。</p>
      </div>
    </section>
  );
}
