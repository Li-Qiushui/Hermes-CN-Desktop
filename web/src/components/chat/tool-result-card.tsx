import { memo, useMemo } from "react";
import { AlertTriangle, FileDiff, Terminal } from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import type { ChatToolItem } from "./chat-types";
import {
  buildToolResultView,
  type DiffFileView,
  type DiffRow,
  type FileChangeView,
  type TerminalView,
  type ToolResultView,
} from "@/lib/tool-result-view";
import s from "./tool-result-card.module.css";

function ExitBadge({ exitCode, status }: { exitCode?: number; status?: string }) {
  if (exitCode === undefined && !status) return null;
  const ok = exitCode === undefined || exitCode === 0;
  return (
    <span className={s.exitBadge} data-ok={ok}>
      {exitCode === undefined ? status : `exit ${exitCode}`}
    </span>
  );
}

function copyTextForTerminal(view: TerminalView): string {
  return [view.command, view.stdout, view.stderr].filter((part) => part && part.trim()).join("\n\n");
}

function TerminalCard({ view }: { view: TerminalView }) {
  const stdout = view.stdout.trimEnd();
  const stderr = view.stderr?.trimEnd();
  const copyText = copyTextForTerminal(view);

  return (
    <div className={s.card} data-kind="terminal">
      <div className={s.head}>
        <Terminal size={13} aria-hidden="true" className={s.icon} />
        <span className={s.label}>终端</span>
        <code className={s.command}>{view.command ?? "输出"}</code>
        <ExitBadge exitCode={view.exitCode} status={view.status} />
        {copyText ? (
          <span className={s.headAction}>
            <CopyButton text={copyText} showStatusIcon={false}>
              复制
            </CopyButton>
          </span>
        ) : null}
      </div>
      {view.workdir ? <div className={s.meta}>cwd {view.workdir}</div> : null}
      {view.errorText ? (
        <div className={s.errorLine}>
          <AlertTriangle size={12} aria-hidden="true" />
          <span>{view.errorText}</span>
        </div>
      ) : null}
      {stdout ? <pre className={s.stream}>{stdout}</pre> : null}
      {stderr ? (
        <>
          <div className={s.streamLabel}>stderr</div>
          <pre className={s.stream} data-stream="stderr">
            {stderr}
          </pre>
        </>
      ) : null}
      {!stdout && !stderr ? <div className={s.emptyNote}>无输出</div> : null}
    </div>
  );
}

function diffRowLabel(row: DiffRow): string {
  if (row.type === "add") return "+";
  if (row.type === "del") return "−";
  return " ";
}

function DiffRows({ rows }: { rows: DiffRow[] }) {
  return (
    <div className={s.diffRows}>
      {rows.map((row, index) => {
        if (row.type === "gap") {
          return (
            <div key={`gap-${index}`} className={s.diffGap}>
              …
            </div>
          );
        }
        return (
          <div key={`${row.type}-${row.oldLine ?? ""}-${row.newLine ?? ""}-${index}`} className={s.diffRow} data-kind={row.type}>
            <span className={s.lineNo}>{row.oldLine ?? ""}</span>
            <span className={s.lineNo}>{row.newLine ?? ""}</span>
            <span className={s.sign} data-kind={row.type}>
              {diffRowLabel(row)}
            </span>
            <span className={s.diffText}>{row.text === "" ? " " : row.text}</span>
          </div>
        );
      })}
    </div>
  );
}

function DiffFileBlock({ file }: { file: DiffFileView }) {
  return (
    <div className={s.diffFile}>
      {file.path ? (
        <div className={s.diffFileHead}>
          <span className={s.path}>{file.path}</span>
          <span className={s.stats}>
            <span data-kind="add">+{file.added}</span>
            <span data-kind="del">−{file.removed}</span>
          </span>
        </div>
      ) : null}
      <DiffRows rows={file.rows} />
      {file.truncated ? <div className={s.note}>行数过多，仅显示前 500 行</div> : null}
    </div>
  );
}

function FileChangeCard({ view }: { view: FileChangeView }) {
  const showHeadPath = !view.files.some((file) => Boolean(file.path));
  const showHeadStats = view.files.length > 1;
  return (
    <div className={s.card} data-kind="file">
      <div className={s.head}>
        <FileDiff size={13} aria-hidden="true" className={s.icon} />
        <span className={s.label}>文件变更</span>
        {showHeadPath && view.path ? <code className={s.command}>{view.path}</code> : null}
        {showHeadStats ? (
          <span className={s.stats}>
            <span data-kind="add">+{view.added}</span>
            <span data-kind="del">−{view.removed}</span>
          </span>
        ) : null}
      </div>
      {view.files.map((file, index) => (
        <DiffFileBlock key={`${file.path ?? "file"}-${index}`} file={file} />
      ))}
      {view.sideBySide ? (
        <div className={s.sideBySide}>
          <div className={s.sidePane}>
            <div className={s.streamLabel}>改动前</div>
            <pre className={s.stream} data-stream="before">
              {view.sideBySide.oldText || "（无旧内容）"}
            </pre>
          </div>
          <div className={s.sidePane}>
            <div className={s.streamLabel}>改动后</div>
            <pre className={s.stream} data-stream="after">
              {view.sideBySide.newText || "（无新内容）"}
            </pre>
          </div>
        </div>
      ) : null}
      {view.fallbackText ? (
        <>
          <div className={s.streamLabel}>{view.fallbackLabel ?? "原文"}</div>
          <pre className={s.stream}>{view.fallbackText}</pre>
        </>
      ) : null}
      {view.note ? <div className={s.note}>{view.note}</div> : null}
    </div>
  );
}

function BlocksCard({ view, status }: { view: Extract<ToolResultView, { kind: "json" | "raw" }>; status: ChatToolItem["status"] }) {
  return (
    <div className={s.blocks}>
      {view.argsText ? (
        <div className={s.blockRow}>
          <div className={s.blockBar}>
            <span className={s.streamLabel}>参数</span>
            <CopyButton text={view.argsText} showStatusIcon={false}>
              复制
            </CopyButton>
          </div>
          <pre className={s.rawBlock}>{view.argsText}</pre>
        </div>
      ) : null}
      {view.outputText ? (
        <div className={s.blockRow}>
          <div className={s.blockBar}>
            <span className={s.streamLabel}>输出</span>
            <CopyButton text={view.outputText} showStatusIcon={false}>
              复制
            </CopyButton>
          </div>
          <pre className={s.rawBlock} data-error={status === "error"}>
            {view.outputText}
          </pre>
        </div>
      ) : null}
      {view.errorText && view.errorText !== view.outputText ? (
        <pre className={s.rawBlock} data-error="true">
          {view.errorText}
        </pre>
      ) : null}
    </div>
  );
}

function ToolResultViewBody({ view, status }: { view: ToolResultView; status: ChatToolItem["status"] }) {
  if (view.kind === "terminal") return <TerminalCard view={view} />;
  if (view.kind === "file") return <FileChangeCard view={view} />;
  return <BlocksCard view={view} status={status} />;
}

function ToolResultCardBase({ tool, body }: { tool: ChatToolItem; body?: string }) {
  const view = useMemo(
    () =>
      buildToolResultView({
        name: tool.name,
        arguments: tool.arguments,
        summary: body,
        error: tool.error,
      }),
    [tool.name, tool.arguments, body, tool.error],
  );

  return <ToolResultViewBody view={view} status={tool.status} />;
}

export const ToolResultCard = memo(
  ToolResultCardBase,
  (prev, next) => prev.tool === next.tool && prev.body === next.body,
);
