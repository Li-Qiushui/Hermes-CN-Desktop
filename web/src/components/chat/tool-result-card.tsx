import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, FileDiff, Search, Terminal } from "lucide-react";
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

const FOLD_LINE_THRESHOLD = 40;
const FOLD_HEAD_LINES = 20;
const FOLD_TAIL_LINES = 10;
const SEARCH_MATCH_LIMIT = 400;

interface SearchBlock {
  key: string;
  text: string;
}

interface SearchMatch {
  block: number;
  line: number;
  start: number;
  end: number;
}

interface SearchIndex {
  query: string;
  matches: SearchMatch[];
  byBlock: SearchMatch[][];
}

interface CardSearch {
  open: boolean;
  query: string;
  setQuery: (value: string) => void;
  openSearch: () => void;
  closeSearch: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  index: SearchIndex;
  active: number;
  total: number;
  step: (delta: number) => void;
  onCardKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

function splitTextLines(text: string): string[] {
  const cr = String.fromCharCode(13);
  const lf = String.fromCharCode(10);
  const normalized = text.indexOf(cr) >= 0 ? text.split(cr + lf).join(lf).split(cr).join(lf) : text;
  return normalized.split(lf);
}

function buildSearchIndex(blocks: SearchBlock[], query: string): SearchIndex {
  const needle = query.trim().toLowerCase();
  const byBlock: SearchMatch[][] = blocks.map(() => []);
  const matches: SearchMatch[] = [];
  if (!needle) return { query, matches, byBlock };

  blocks.forEach((block, blockIndex) => {
    const lines = splitTextLines(block.text);
    for (let line = 0; line < lines.length; line += 1) {
      const haystack = lines[line].toLowerCase();
      let from = 0;
      while (matches.length < SEARCH_MATCH_LIMIT) {
        const at = haystack.indexOf(needle, from);
        if (at < 0) break;
        const match: SearchMatch = { block: blockIndex, line, start: at, end: at + needle.length };
        matches.push(match);
        byBlock[blockIndex].push(match);
        from = at + Math.max(1, needle.length);
      }
      if (matches.length >= SEARCH_MATCH_LIMIT) break;
    }
  });

  return { query, matches, byBlock };
}

function useCardSearch(blocks: SearchBlock[]): CardSearch {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const index = useMemo(() => buildSearchIndex(blocks, query), [blocks, query]);
  const total = index.matches.length;
  const active = total === 0 ? -1 : Math.min(activeIndex, total - 1);

  useEffect(() => {
    setActiveIndex(0);
  }, [index]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const openSearch = useCallback(() => setOpen(true), []);
  const closeSearch = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  const step = useCallback(
    (delta: number) => {
      setActiveIndex((current) => {
        if (total === 0) return 0;
        const next = (current + delta) % total;
        return next < 0 ? next + total : next;
      });
    },
    [total],
  );

  const onCardKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      setOpen(true);
    }
  }, []);

  return {
    open,
    query,
    setQuery,
    openSearch,
    closeSearch,
    inputRef,
    index,
    active,
    total,
    step,
    onCardKeyDown,
  };
}

function CardSearchBar({ search }: { search: CardSearch }) {
  if (!search.open) return null;
  const counter =
    search.total === 0 ? (search.query.trim() ? "无匹配" : "0 / 0") : `${search.active + 1} / ${search.total}`;
  return (
    <div className={s.searchBar} data-card-search="true">
      <Search size={13} aria-hidden="true" className={s.searchIcon} />
      <input
        ref={search.inputRef}
        className={s.searchInput}
        value={search.query}
        onChange={(event) => search.setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            search.step(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            search.closeSearch();
          }
        }}
        placeholder="在这张卡里查找"
        aria-label="在工具卡内查找"
        type="text"
      />
      <span className={s.searchCounter}>{counter}</span>
      <button
        type="button"
        className={s.searchNav}
        onClick={() => search.step(-1)}
        disabled={search.total === 0}
        aria-label="上一个匹配"
      >
        <ChevronUp size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={s.searchNav}
        onClick={() => search.step(1)}
        disabled={search.total === 0}
        aria-label="下一个匹配"
      >
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <button type="button" className={s.searchNav} onClick={search.closeSearch} aria-label="关闭卡内查找">
        ×
      </button>
    </div>
  );
}

function SearchTrigger({ search }: { search: CardSearch }) {
  return (
    <button
      type="button"
      className={s.headIconButton}
      onClick={search.openSearch}
      aria-label="卡内查找"
      title="卡内查找（Ctrl+F）"
      data-open={search.open}
    >
      <Search size={13} aria-hidden="true" />
    </button>
  );
}

function highlightLine(
  line: string,
  ranges: SearchMatch[] | undefined,
  activeMatch: SearchMatch | undefined,
): ReactNode {
  if (!ranges || ranges.length === 0) return line;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) nodes.push(line.slice(cursor, range.start));
    const isActive =
      activeMatch !== undefined && activeMatch.start === range.start && activeMatch.line === range.line;
    nodes.push(
      <mark key={`hit-${index}`} className={s.match} data-active={isActive ? "true" : undefined}>
        {line.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  if (cursor < line.length) nodes.push(line.slice(cursor));
  return nodes;
}

function TextSurface({
  text,
  blockIndex,
  search,
  className,
  dataStream,
  dataError,
}: {
  text: string;
  blockIndex: number;
  search: CardSearch;
  className: string;
  dataStream?: string;
  dataError?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => splitTextLines(text), [text]);
  const byBlock = search.index.byBlock[blockIndex];
  const activeMatch = search.active >= 0 ? search.index.matches[search.active] : undefined;

  const rangesByLine = useMemo(() => {
    const map: SearchMatch[][] = [];
    for (const match of byBlock ?? []) {
      (map[match.line] ??= []).push(match);
    }
    return map;
  }, [byBlock]);

  const foldable = lines.length > FOLD_LINE_THRESHOLD;
  const hiddenLines = Math.max(0, lines.length - FOLD_HEAD_LINES - FOLD_TAIL_LINES);
  const tailStart = lines.length - FOLD_TAIL_LINES;

  useEffect(() => {
    if (!foldable || expanded) return;
    if (!activeMatch || activeMatch.block !== blockIndex) return;
    if (activeMatch.line >= FOLD_HEAD_LINES && activeMatch.line < tailStart) setExpanded(true);
  }, [activeMatch, blockIndex, expanded, foldable, tailStart]);

  const renderLines = (from: number, to: number): ReactNode[] => {
    const nodes: ReactNode[] = [];
    for (let index = from; index <= to; index += 1) {
      if (index > from) nodes.push("\n");
      nodes.push(
        <Fragment key={`line-${index}`}>
          {highlightLine(lines[index] ?? "", rangesByLine[index], activeMatch)}
        </Fragment>,
      );
    }
    return nodes;
  };

  const preProps = { className, "data-stream": dataStream, "data-error": dataError };

  if (!foldable || expanded) {
    return (
      <>
        <pre {...preProps}>{renderLines(0, lines.length - 1)}</pre>
        {foldable ? (
          <button type="button" className={s.foldToggle} onClick={() => setExpanded(false)}>
            收起，只看头尾
          </button>
        ) : null}
      </>
    );
  }

  return (
    <pre {...preProps}>
      {renderLines(0, FOLD_HEAD_LINES - 1)}
      {"\n"}
      <button type="button" className={s.foldToggle} onClick={() => setExpanded(true)} data-folded-lines={hiddenLines}>
        … 省略 {hiddenLines} 行，点击展开
      </button>
      {"\n"}
      {renderLines(tailStart, lines.length - 1)}
    </pre>
  );
}

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
  const blocks = useMemo<SearchBlock[]>(() => {
    const list: SearchBlock[] = [];
    if (stdout) list.push({ key: "stdout", text: stdout });
    if (stderr) list.push({ key: "stderr", text: stderr });
    return list;
  }, [stdout, stderr]);
  const search = useCardSearch(blocks);

  return (
    <div className={s.card} data-kind="terminal" onKeyDown={search.onCardKeyDown}>
      <div className={s.head}>
        <Terminal size={13} aria-hidden="true" className={s.icon} />
        <span className={s.label}>终端</span>
        <code className={s.command}>{view.command ?? "输出"}</code>
        <ExitBadge exitCode={view.exitCode} status={view.status} />
        <span className={s.headAction}>
          <SearchTrigger search={search} />
          {copyText ? (
            <CopyButton text={copyText} showStatusIcon={false}>
              复制
            </CopyButton>
          ) : null}
        </span>
      </div>
      <CardSearchBar search={search} />
      {view.workdir ? <div className={s.meta}>cwd {view.workdir}</div> : null}
      {view.errorText ? (
        <div className={s.errorLine}>
          <AlertTriangle size={12} aria-hidden="true" />
          <span>{view.errorText}</span>
        </div>
      ) : null}
      {stdout ? <TextSurface text={stdout} blockIndex={0} search={search} className={s.stream} /> : null}
      {stderr ? (
        <>
          <div className={s.streamLabel}>stderr</div>
          <TextSurface
            text={stderr}
            blockIndex={stdout ? 1 : 0}
            search={search}
            className={s.stream}
            dataStream="stderr"
          />
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

function DiffRows({
  rows,
  search,
  blockIndex,
}: {
  rows: DiffRow[];
  search: CardSearch;
  blockIndex: number;
}) {
  const byBlock = useMemo(() => search.index.byBlock[blockIndex] ?? [], [search.index, blockIndex]);
  const rangesByLine = useMemo(() => {
    const map: SearchMatch[][] = [];
    for (const match of byBlock) {
      (map[match.line] ??= []).push(match);
    }
    return map;
  }, [byBlock]);
  const activeMatch = search.active >= 0 ? search.index.matches[search.active] : undefined;
  const activeHere = activeMatch && activeMatch.block === blockIndex ? activeMatch : undefined;

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
            <span className={s.diffText}>
              {row.text === "" ? " " : highlightLine(row.text, rangesByLine[index], activeHere)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function DiffFileBlock({
  file,
  blockIndex,
  search,
}: {
  file: DiffFileView;
  blockIndex: number;
  search: CardSearch;
}) {
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
      <DiffRows rows={file.rows} search={search} blockIndex={blockIndex} />
      {file.truncated ? <div className={s.note}>行数过多，仅显示前 500 行</div> : null}
    </div>
  );
}

function FileChangeCard({ view }: { view: FileChangeView }) {
  const showHeadPath = !view.files.some((file) => Boolean(file.path));
  const showHeadStats = view.files.length > 1;
  const blocks = useMemo<SearchBlock[]>(() => {
    const list: SearchBlock[] = view.files.map((file, index) => ({
      key: `file-${file.path ?? index}`,
      text: file.rows.map((row) => row.text).join("\n"),
    }));
    if (view.fallbackText) list.push({ key: "fallback", text: view.fallbackText });
    if (view.sideBySide) {
      list.push({ key: "before", text: view.sideBySide.oldText });
      list.push({ key: "after", text: view.sideBySide.newText });
    }
    return list;
  }, [view]);
  const search = useCardSearch(blocks);
  const fallbackIndex = view.files.length;
  const beforeIndex = fallbackIndex + (view.fallbackText ? 1 : 0);
  const afterIndex = beforeIndex + 1;

  return (
    <div className={s.card} data-kind="file" onKeyDown={search.onCardKeyDown}>
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
        <span className={s.headAction}>
          <SearchTrigger search={search} />
        </span>
      </div>
      <CardSearchBar search={search} />
      {view.files.map((file, index) => (
        <DiffFileBlock key={`${file.path ?? "file"}-${index}`} file={file} blockIndex={index} search={search} />
      ))}
      {view.sideBySide ? (
        <div className={s.sideBySide}>
          <div className={s.sidePane}>
            <div className={s.streamLabel}>改动前</div>
            <TextSurface
              text={view.sideBySide.oldText || "（无旧内容）"}
              blockIndex={beforeIndex}
              search={search}
              className={s.stream}
              dataStream="before"
            />
          </div>
          <div className={s.sidePane}>
            <div className={s.streamLabel}>改动后</div>
            <TextSurface
              text={view.sideBySide.newText || "（无新内容）"}
              blockIndex={afterIndex}
              search={search}
              className={s.stream}
              dataStream="after"
            />
          </div>
        </div>
      ) : null}
      {view.fallbackText ? (
        <>
          <div className={s.streamLabel}>{view.fallbackLabel ?? "原文"}</div>
          <TextSurface
            text={view.fallbackText}
            blockIndex={fallbackIndex}
            search={search}
            className={s.stream}
          />
        </>
      ) : null}
      {view.note ? <div className={s.note}>{view.note}</div> : null}
    </div>
  );
}

function BlocksCard({ view, status }: { view: Extract<ToolResultView, { kind: "json" | "raw" }>; status: ChatToolItem["status"] }) {
  const showExtraError = Boolean(view.errorText && view.errorText !== view.outputText);
  const blocks = useMemo<SearchBlock[]>(() => {
    const list: SearchBlock[] = [];
    if (view.argsText) list.push({ key: "args", text: view.argsText });
    if (view.outputText) list.push({ key: "output", text: view.outputText });
    if (showExtraError && view.errorText) list.push({ key: "error", text: view.errorText });
    return list;
  }, [view.argsText, view.outputText, view.errorText, showExtraError]);
  const search = useCardSearch(blocks);
  const outputIndex = view.argsText ? 1 : 0;
  const errorIndex = outputIndex + (view.outputText ? 1 : 0);

  return (
    <div className={s.blocks} onKeyDown={search.onCardKeyDown}>
      <CardSearchBar search={search} />
      {view.argsText ? (
        <div className={s.blockRow}>
          <div className={s.blockBar}>
            <span className={s.streamLabel}>参数</span>
            <span className={s.blockBarActions}>
              <SearchTrigger search={search} />
              <CopyButton text={view.argsText} showStatusIcon={false}>
                复制
              </CopyButton>
            </span>
          </div>
          <TextSurface text={view.argsText} blockIndex={0} search={search} className={s.rawBlock} />
        </div>
      ) : null}
      {view.outputText ? (
        <div className={s.blockRow}>
          <div className={s.blockBar}>
            <span className={s.streamLabel}>输出</span>
            <span className={s.blockBarActions}>
              <SearchTrigger search={search} />
              <CopyButton text={view.outputText} showStatusIcon={false}>
                复制
              </CopyButton>
            </span>
          </div>
          <TextSurface
            text={view.outputText}
            blockIndex={outputIndex}
            search={search}
            className={s.rawBlock}
            dataError={status === "error"}
          />
        </div>
      ) : null}
      {showExtraError && view.errorText ? (
        <TextSurface
          text={view.errorText}
          blockIndex={errorIndex}
          search={search}
          className={s.rawBlock}
          dataError
        />
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
