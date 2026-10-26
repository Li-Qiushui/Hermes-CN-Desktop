import { AlertTriangle, Check, Copy, FileCode2, Maximize2, Minimize2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { describePreviewError, isHtmlPreviewFile, type PreviewErrorCopy } from "@/lib/preview-directive";
import { readLocalTextFile } from "@/lib/local-file-read";
import s from "./preview-directive.module.css";

const DEFAULT_HEIGHT = 360;
const EXPANDED_HEIGHT = "70vh";

interface PreviewDirectiveProps {
  file: string;
  streaming?: boolean;
}

type PreviewState =
  | { status: "pending" }
  | { status: "ready"; html: string }
  | { status: "card"; note?: string }
  | { status: "error"; copy: PreviewErrorCopy };

function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function frameHeight(expanded: boolean): number | string {
  return expanded ? EXPANDED_HEIGHT : DEFAULT_HEIGHT;
}

function CopyPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(() => {
    const pending = navigator.clipboard?.writeText?.(path);
    if (!pending) {
      setCopied(false);
      return;
    }
    void pending.then(() => setCopied(true)).catch(() => setCopied(false));
  }, [path]);

  return (
    <button className={s.iconButton} onClick={copy} title="复制路径" type="button">
      {copied ? <Check size={14} /> : <Copy size={14} />}
      <span>{copied ? "已复制" : "复制路径"}</span>
    </button>
  );
}

function FileCard({ file, note }: { file: string; note?: string }) {
  return (
    <div className={s.card} data-preview="card">
      <FileCode2 className={s.cardIcon} size={16} />
      <div className={s.cardBody}>
        <span className={s.cardName}>{fileNameOf(file)}</span>
        <span className={s.cardPath}>{file}</span>
        {note ? <span className={s.cardNote}>{note}</span> : null}
      </div>
      <CopyPathButton path={file} />
    </div>
  );
}

function Skeleton({ height }: { height: number | string }) {
  return <div className={s.skeleton} data-preview="skeleton" style={{ height }} aria-label="正在加载预览" />;
}

function ErrorCard({ copy, onRetry }: { copy: PreviewErrorCopy; onRetry: () => void }) {
  return (
    <div className={s.card} data-preview="error">
      <AlertTriangle className={s.errorIcon} size={16} />
      <div className={s.cardBody}>
        <span className={s.cardName}>{copy.title}</span>
        {copy.hint ? <span className={s.cardNote}>{copy.hint}</span> : null}
      </div>
      <button className={s.iconButton} onClick={onRetry} type="button">
        <RotateCcw size={14} />
        <span>重试</span>
      </button>
    </div>
  );
}

export function PreviewDirective({ file, streaming = false }: PreviewDirectiveProps) {
  const previewable = isHtmlPreviewFile(file);
  const [state, setState] = useState<PreviewState>({ status: "pending" });
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!previewable || streaming) return undefined;

    let alive = true;
    setState({ status: "pending" });

    void readLocalTextFile(file)
      .then((result) => {
        if (!alive) return;
        if (result.binary) {
          setState({ status: "card", note: "该文件是二进制内容，不能内联预览" });
          return;
        }
        if (!result.text) {
          setState({ status: "card", note: "文件内容为空" });
          return;
        }
        setState({ status: "ready", html: result.text });
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setState({ status: "error", copy: describePreviewError(error) });
      });

    return () => {
      alive = false;
    };
  }, [file, previewable, streaming, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  if (!previewable) {
    return <FileCard file={file} note="仅 .html / .htm 支持内联预览" />;
  }

  if (state.status === "error") {
    return <ErrorCard copy={state.copy} onRetry={retry} />;
  }

  if (state.status === "card") {
    return <FileCard file={file} note={state.note} />;
  }

  const height = frameHeight(expanded);

  if (state.status === "pending") {
    return <Skeleton height={height} />;
  }

  return (
    <div className={s.frame} data-preview="frame" style={{ height }}>
      <iframe
        className={s.iframe}
        loading="lazy"
        sandbox="allow-scripts"
        srcDoc={state.html}
        title={fileNameOf(file)}
      />
      <div className={s.toolbar}>
        <button
          className={s.iconButton}
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          <span>{expanded ? "收起" : "展开"}</span>
        </button>
      </div>
    </div>
  );
}
