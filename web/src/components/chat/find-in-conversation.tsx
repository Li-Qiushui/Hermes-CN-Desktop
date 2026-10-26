import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, History, Info, Search, X } from "lucide-react";
import type { ChatMessage, ChatToolItem } from "./chat-types";
import { stripSteerWrapper } from "@/lib/steer-message";
import { buildToolResultView } from "@/lib/tool-result-view";
import { readUiValue } from "@/lib/ui-store";
import s from "./find-in-conversation.module.css";

const FIND_HIGHLIGHT_NAME = "hermes-find";
const ACTIVE_HIGHLIGHT_NAME = "hermes-find-active";
export const FIND_HIT_ATTRIBUTE = "data-find-hit";
export const FIND_HIT_LEAF_ATTRIBUTE = "data-find-hit-leaf";
const SKIP_SELECTOR = "textarea, input, script, style, [contenteditable='true'], [data-find-skip]";
const TEXT_NODE_FALLBACK = 4;
const FILTER_ACCEPT_FALLBACK = 1;
const VISIBLE_MARGIN_PX = 12;
const SNIPPET_RADIUS = 24;

export const FIND_HIT_LIMIT = 2000;
export const FIND_INPUT_DEBOUNCE_MS = 150;
export const FIND_ALIGN_MAX_TOP_PX = 160;
export const FIND_ALIGN_TOP_RATIO = 1 / 3;
const SHOW_REASONING_STORAGE_KEY = "hermes.show-reasoning";

interface HighlightRegistry {
  highlights?: Map<string, unknown>;
  Highlight?: new (...ranges: Range[]) => unknown;
}

export interface FindMatch {
  range: Range;
  node: Text;
}

export type FindHitField =
  | "text"
  | "reasoning"
  | "tool-name"
  | "tool-context"
  | "tool-preview"
  | "tool-summary"
  | "tool-error"
  | "tool-arguments";

export interface FindHit {
  messageIndex: number;
  messageId: string;
  field: FindHitField;
  toolId?: string;
  ordinal: number;
  snippet: string;
}

interface FindIndexField {
  field: FindHitField;
  toolId?: string;
  text: string;
  haystack: string;
}

interface FindIndexEntry {
  messageIndex: number;
  messageId: string;
  fields: FindIndexField[];
}

export interface FindIndex {
  entries: FindIndexEntry[];
}

export interface FindSearchResult {
  hits: FindHit[];
  truncated: boolean;
}

export const EMPTY_FIND_RESULT: FindSearchResult = { hits: [], truncated: false };

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

export function pickFindMatch(
  matches: readonly FindMatch[],
  target: { messageId: string; toolId?: string } | undefined,
  ordinal = 0,
): number {
  if (!target) return matches.length > 0 ? 0 : -1;
  let seen = 0;
  for (let index = 0; index < matches.length; index += 1) {
    const element = matches[index].node.parentElement;
    if (!element) continue;
    const owner = element.closest("[data-message-id]");
    if (!owner || owner.getAttribute("data-message-id") !== target.messageId) continue;
    if (target.toolId) {
      const card = element.closest("[data-tool-id]");
      if (!card || card.getAttribute("data-tool-id") !== target.toolId) continue;
    }
    if (seen === ordinal) return index;
    seen += 1;
  }
  return matches.length > 0 ? 0 : -1;
}

function snippetAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + length + SNIPPET_RADIUS);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

export function toolRenderBody(tool: ChatToolItem): string | undefined {
  return tool.error ?? tool.summary ?? tool.preview;
}

function toolArgumentText(tool: ChatToolItem): string | undefined {
  const view = buildToolResultView({
    name: tool.name,
    arguments: tool.arguments,
    summary: tool.summary,
    error: tool.error,
  });
  if (view.kind === "terminal") {
    const parts = [view.command, view.workdir].filter(
      (value): value is string => Boolean(value && value.trim()),
    );
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  if (view.kind === "file") {
    const parts: string[] = [];
    if (view.path) parts.push(view.path);
    for (const file of view.files) {
      for (const row of file.rows) {
        if (row.type !== "gap" && row.text) parts.push(row.text);
      }
    }
    if (view.fallbackText) parts.push(view.fallbackText);
    if (view.sideBySide) parts.push(view.sideBySide.oldText, view.sideBySide.newText);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return view.argsText;
}

export function findIndexesReasoning(): boolean {
  return readUiValue<boolean>(SHOW_REASONING_STORAGE_KEY, false) === true;
}

function pushField(fields: FindIndexField[], field: FindHitField, text: string | undefined, toolId?: string): void {
  if (!text || !text.trim()) return;
  fields.push({ field, toolId, text, haystack: text.toLowerCase() });
}

function pushToolFields(fields: FindIndexField[], tool: ChatToolItem): void {
  const toolId = tool.tool_id;
  pushField(fields, "tool-name", tool.name, toolId);
  pushField(fields, "tool-context", tool.context, toolId);
  const body = toolRenderBody(tool);
  const bodyField: FindHitField = tool.error
    ? "tool-error"
    : tool.summary
      ? "tool-summary"
      : "tool-preview";
  pushField(fields, bodyField, body, toolId);
  pushField(fields, "tool-arguments", toolArgumentText(tool), toolId);
}

export interface FindIndexOptions {
  includeReasoning?: boolean;
}

export function buildFindIndex(
  messages: readonly ChatMessage[],
  options: FindIndexOptions = {},
): FindIndex {
  const includeReasoning = options.includeReasoning ?? findIndexesReasoning();
  const entries: FindIndexEntry[] = [];
  messages.forEach((message, messageIndex) => {
    const fields: FindIndexField[] = [];
    pushField(fields, "text", stripSteerWrapper(message.text).text);
    if (includeReasoning) pushField(fields, "reasoning", message.reasoning);
    for (const tool of message.tools ?? []) {
      pushToolFields(fields, tool);
    }
    if (fields.length === 0) return;
    entries.push({ messageIndex, messageId: message.id, fields });
  });
  return { entries };
}

export function searchFindIndex(index: FindIndex, query: string, limit = FIND_HIT_LIMIT): FindSearchResult {
  const needle = query.trim().toLowerCase();
  if (!needle) return EMPTY_FIND_RESULT;

  const hits: FindHit[] = [];
  let truncated = false;
  for (const entry of index.entries) {
    for (const field of entry.fields) {
      const haystack = field.haystack;
      let from = 0;
      let ordinal = 0;
      for (let at = haystack.indexOf(needle, from); at >= 0; at = haystack.indexOf(needle, from)) {
        if (hits.length >= limit) {
          truncated = true;
          break;
        }
        hits.push({
          messageIndex: entry.messageIndex,
          messageId: entry.messageId,
          field: field.field,
          toolId: field.toolId,
          ordinal,
          snippet: snippetAround(field.text, at, needle.length),
        });
        ordinal += 1;
        from = at + Math.max(1, needle.length);
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  return { hits, truncated };
}

export function searchConversation(
  messages: readonly ChatMessage[],
  query: string,
  limit = FIND_HIT_LIMIT,
  options: FindIndexOptions = {},
): FindSearchResult {
  return searchFindIndex(buildFindIndex(messages, options), query, limit);
}

export function highlightFindMatches(matches: readonly FindMatch[], activeIndex: number): void {
  markFindHitNodes(matches, activeIndex);
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

let markedFindNodes: HTMLElement[] = [];

function markFindHitNodes(matches: readonly FindMatch[], activeIndex: number): void {
  for (const node of markedFindNodes) {
    if (node.isConnected) {
      node.removeAttribute(FIND_HIT_ATTRIBUTE);
      node.removeAttribute(FIND_HIT_LEAF_ATTRIBUTE);
    }
  }
  markedFindNodes = [];
  const activeElements = new Set<Element>();
  matches.forEach((match, index) => {
    const element = match.node.parentElement;
    if (!element) return;
    const active = index === activeIndex;
    if (active) activeElements.add(element);
    if (element.getAttribute(FIND_HIT_ATTRIBUTE) === "active") return;
    element.setAttribute(FIND_HIT_ATTRIBUTE, active ? "active" : "match");
    if (element.childElementCount === 0) element.setAttribute(FIND_HIT_LEAF_ATTRIBUTE, "true");
    markedFindNodes.push(element);
  });
  for (const element of activeElements) {
    element.setAttribute(FIND_HIT_ATTRIBUTE, "active");
  }
}

export function clearFindHighlights(): void {
  for (const node of markedFindNodes) {
    if (!node.isConnected) continue;
    node.removeAttribute(FIND_HIT_ATTRIBUTE);
    node.removeAttribute(FIND_HIT_LEAF_ATTRIBUTE);
  }
  markedFindNodes = [];
  alignedFindKey = null;
  const registry = highlightRegistry();
  if (!registry?.highlights) return;
  registry.highlights.delete(FIND_HIGHLIGHT_NAME);
  registry.highlights.delete(ACTIVE_HIGHLIGHT_NAME);
}

export interface FindDomTarget {
  messageId: string;
  toolId?: string;
  ordinal?: number;
}

export interface FindAlignGeometry {
  nodeTop: number;
  containerTop: number;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export function findAlignScrollTop(geometry: FindAlignGeometry): number {
  const offset = Math.min(
    FIND_ALIGN_MAX_TOP_PX,
    Math.max(0, geometry.clientHeight * FIND_ALIGN_TOP_RATIO),
  );
  const desired = geometry.scrollTop + (geometry.nodeTop - geometry.containerTop) - offset;
  const maxTop = Math.max(0, geometry.scrollHeight - geometry.clientHeight);
  return Math.min(Math.max(0, desired), maxTop);
}

function scrollContainerFor(node: HTMLElement): HTMLElement | null {
  const doc = node.ownerDocument;
  const view = doc.defaultView;
  for (let element = node.parentElement; element; element = element.parentElement) {
    const overflow = view?.getComputedStyle(element).overflowY ?? "";
    const scrollable = overflow === "auto" || overflow === "scroll" || overflow === "overlay";
    if (scrollable && element.scrollHeight > element.clientHeight) return element;
  }
  const scrolling = doc.scrollingElement;
  return scrolling instanceof HTMLElement ? scrolling : null;
}

export function alignFindMatch(match: FindMatch, container?: HTMLElement | null): boolean {
  const node = match.node.parentElement;
  if (!node) return false;
  const scroller = container ?? scrollContainerFor(node);
  if (!scroller) return false;
  const top = findAlignScrollTop({
    nodeTop: node.getBoundingClientRect().top,
    containerTop: scroller.getBoundingClientRect().top,
    scrollTop: scroller.scrollTop,
    clientHeight: scroller.clientHeight,
    scrollHeight: scroller.scrollHeight,
  });
  if (typeof scroller.scrollTo === "function") {
    scroller.scrollTo({ top, behavior: "smooth" });
  } else {
    scroller.scrollTop = top;
  }
  return true;
}

let alignedFindKey: string | null = null;

function findTargetKey(query: string, target: FindDomTarget | undefined): string {
  return [target?.messageId ?? "", target?.toolId ?? "", String(target?.ordinal ?? 0), query].join("\u0000");
}

export interface FindHighlightOptions {
  align?: boolean;
  container?: HTMLElement | null;
}

/**
 * 在已渲染的 DOM 上重新定位并高亮当前命中。展开工具卡、markdown/代码高亮替换文本
 * 节点都会让上一次的 Range 失效，所以这里做成可重复调用的。
 */
export function applyFindHighlight(
  root: HTMLElement | null,
  query: string,
  target: FindDomTarget | undefined,
  options: FindHighlightOptions = {},
): FindMatch | undefined {
  if (!root) return undefined;
  const matches = collectFindMatches(root, query);
  const index = pickFindMatch(matches, target, target?.ordinal ?? 0);
  highlightFindMatches(matches, index);
  const match = index >= 0 ? matches[index] : undefined;
  if (!match) return undefined;
  const key = findTargetKey(query, target);
  if ((options.align ?? true) && key !== alignedFindKey) {
    alignedFindKey = key;
    alignFindMatch(match, options.container);
  }
  return match;
}

export interface FindBarProps {
  query: string;
  activeIndex: number;
  total: number;
  truncated?: boolean;
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
  truncated = false,
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
  const [draft, setDraft] = useState(query);
  const draftRef = useRef(query);
  const pushedRef = useRef(query);
  const timerRef = useRef<number | null>(null);
  const hasQuery = draft.trim().length > 0;
  const exhausted = reachedEarliest || !hasEarlier;
  const noMatch = hasQuery && total === 0;

  const cancelPending = useCallback(() => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const publish = useCallback(() => {
    const next = draftRef.current;
    if (next === pushedRef.current) return;
    pushedRef.current = next;
    onChange(next);
  }, [onChange]);

  const flush = useCallback(() => {
    cancelPending();
    publish();
  }, [cancelPending, publish]);

  const changeDraft = useCallback(
    (value: string) => {
      draftRef.current = value;
      setDraft(value);
      cancelPending();
      if (!pushedRef.current.trim()) {
        publish();
        return;
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        publish();
      }, FIND_INPUT_DEBOUNCE_MS);
    },
    [cancelPending, publish],
  );

  useEffect(() => {
    draftRef.current = query;
    pushedRef.current = query;
    setDraft(query);
  }, [query]);

  useEffect(() => cancelPending, [cancelPending]);

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
        value={draft}
        placeholder="在当前会话里查找"
        aria-label="查找关键词"
        onChange={(event) => changeDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            flush();
            if (event.shiftKey) {
              onPrev();
            } else {
              onNext();
            }
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            flush();
            onNext();
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            flush();
            onPrev();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            cancelPending();
            onClose();
          }
        }}
      />
      <span className={s.findCounter} data-find-counter={total} data-find-truncated={truncated ? "true" : undefined}>
        {noMatch ? "无匹配" : hasQuery ? `第 ${activeIndex + 1} 处 / 共 ${total} 处` : "0 / 0"}
      </span>
      <button
        type="button"
        className={s.findButton}
        onClick={onPrev}
        disabled={total === 0}
        title="上一个（Shift+Enter / ↑）"
        aria-label="上一个匹配"
      >
        <ChevronUp size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={s.findButton}
        onClick={onNext}
        disabled={total === 0}
        title="下一个（Enter / ↓）"
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
      {truncated ? (
        <span className={s.findHint} data-find-truncated-hint="true">
          <Info size={12} strokeWidth={1.75} aria-hidden="true" />
          命中超过 {FIND_HIT_LIMIT} 处，只列出前面的结果，换个更精确的词
        </span>
      ) : null}
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
