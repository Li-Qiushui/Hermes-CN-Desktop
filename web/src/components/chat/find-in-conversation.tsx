import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, History, Search, X } from "lucide-react";
import s from "./find-in-conversation.module.css";

const FIND_HIGHLIGHT_NAME = "hermes-find";
const ACTIVE_HIGHLIGHT_NAME = "hermes-find-active";
const SKIP_SELECTOR = "textarea, input, script, style, [contenteditable='true'], [data-find-skip]";
const TEXT_NODE_FALLBACK = 4;
const FILTER_ACCEPT_FALLBACK = 1;
const VISIBLE_MARGIN_PX = 12;

interface HighlightRegistry {
  highlights?: Map<string, unknown>;
  Highlight?: new (...ranges: Range[]) => unknown;
}

export interface FindMatch {
  range: Range;
  node: Text;
}

function highlightRegistry(): HighlightRegistry | null {
  const registry = (globalThis as { CSS?: HighlightRegistry }).CSS;
  return registry && registry.highlights ? registry : null;
}

function textFilter(doc: Document): (node: Node) => number {
  const accept = doc.defaultView?.NodeFilter?.FILTER_ACCEPT ?? FILTER_ACCEPT_FALLBACK;
  const reject = doc.defaultView?.NodeFilter?.FILTER_REJECT ?? 2;
  return (node: Node) => {
    const parent = node.parentElement;
    if (!parent || !node.nodeValue) return reject;
    if (parent.closest(SKIP_SELECTOR)) return reject;
    return accept;
  };
}

export function collectFindMatches(root: HTMLElement | null, query: string): FindMatch[] {
  const needle = query.toLowerCase();
  if (!root || !needle.trim()) return [];
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, doc.defaultView?.NodeFilter?.SHOW_TEXT ?? TEXT_NODE_FALLBACK, {
    acceptNode: textFilter(doc),
  });
  const matches: FindMatch[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const value = text.nodeValue ?? "";
    const haystack = value.toLowerCase();
    let from = 0;
    for (let index = haystack.indexOf(needle, from); index >= 0; index = haystack.indexOf(needle, from)) {
      const range = doc.createRange();
      range.setStart(text, index);
      range.setEnd(text, index + needle.length);
      matches.push({ range, node: text });
      from = index + needle.length;
    }
  }
  return matches;
}

export function highlightFindMatches(matches: readonly FindMatch[], activeIndex: number): void {
  const registry = highlightRegistry();
  if (!registry?.highlights || typeof registry.Highlight !== "function") return;
  const active = matches[activeIndex];
  const rest: Range[] = [];
  matches.forEach((match, index) => {
    if (index !== activeIndex) rest.push(match.range);
  });
  registry.highlights.set(FIND_HIGHLIGHT_NAME, new registry.Highlight(...rest));
  if (active) {
    registry.highlights.set(ACTIVE_HIGHLIGHT_NAME, new registry.Highlight(active.range));
  } else {
    registry.highlights.delete(ACTIVE_HIGHLIGHT_NAME);
  }
}

export function clearFindHighlights(): void {
  const registry = highlightRegistry();
  if (!registry?.highlights) return;
  registry.highlights.delete(FIND_HIGHLIGHT_NAME);
  registry.highlights.delete(ACTIVE_HIGHLIGHT_NAME);
}

export interface FindBarProps {
  query: string;
  activeIndex: number;
  total: number;
  hasEarlier: boolean;
  searchingEarlier: boolean;
  reachedEarliest: boolean;
  onChange: (value: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onSearchEarlier: () => void;
}

export function FindBar({
  query,
  activeIndex,
  total,
  hasEarlier,
  searchingEarlier,
  reachedEarliest,
  onChange,
  onPrev,
  onNext,
  onClose,
  onSearchEarlier,
}: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hasQuery = query.trim().length > 0;
  const exhausted = reachedEarliest || !hasEarlier;
  const noMatch = hasQuery && total === 0;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  return (
    <div className={s.findBar} role="search" aria-label="会话内查找">
      <Search size={13} strokeWidth={1.75} aria-hidden="true" className={s.findIcon} />
      <input
        ref={inputRef}
        className={s.findInput}
        value={query}
        placeholder="在当前会话里查找"
        aria-label="查找关键词"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) {
              onPrev();
            } else {
              onNext();
            }
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <span className={s.findCounter} data-find-counter={total}>
        {noMatch ? "无匹配" : hasQuery ? `第 ${activeIndex + 1} / 共 ${total}` : "0 / 0"}
      </span>
      <button
        type="button"
        className={s.findButton}
        onClick={onPrev}
        disabled={total === 0}
        title="上一个（Shift+Enter）"
        aria-label="上一个匹配"
      >
        <ChevronUp size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={s.findButton}
        onClick={onNext}
        disabled={total === 0}
        title="下一个（Enter）"
        aria-label="下一个匹配"
      >
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={s.findButton}
        onClick={onClose}
        title="关闭（Esc）"
        aria-label="关闭查找"
      >
        <X size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {noMatch ? (
        exhausted ? (
          <span className={s.findStatus} data-find-exhausted="true">
            已到最早
          </span>
        ) : (
          <span className={s.findStatus} data-find-status="earlier">
            <History size={12} strokeWidth={1.75} aria-hidden="true" />
            <button
              type="button"
              className={s.findLink}
              onClick={onSearchEarlier}
              disabled={searchingEarlier}
            >
              {searchingEarlier ? "正在往前搜索…" : "在更早消息中继续搜索"}
            </button>
          </span>
        )
      ) : null}
    </div>
  );
}
