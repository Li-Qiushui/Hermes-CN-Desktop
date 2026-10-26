import { readUiValue, removeUiValue, writeUiValue } from "@/lib/ui-store";

const STORAGE_KEY_PREFIX = "hermes-cn-ui.composerDraft";

export type ComposerDraftTarget =
  | { kind: "new"; profile?: string | null }
  | { kind: "session"; sessionId?: string | null; profile?: string | null };

function cleanPart(value: string | null | undefined, fallback: string): string {
  const text = (value ?? "").trim();
  return encodeURIComponent(text || fallback);
}

function runtimeScopeParts(): string[] {
  const runtime = typeof window !== "undefined" ? window.__HERMES_RUNTIME__ : undefined;
  const mode = runtime?.connectionMode ?? "managed";
  const baseUrl = runtime?.dashboardApiBaseUrl ?? runtime?.apiBaseUrl ?? "relative";
  return [cleanPart(mode, "managed"), cleanPart(baseUrl, "relative")];
}

export function composerDraftStorageKey(target: ComposerDraftTarget | null | undefined): string | null {
  if (!target) return null;
  const profile = cleanPart(target.profile, "default");
  const [mode, baseUrl] = runtimeScopeParts();
  if (target.kind === "new") {
    return [STORAGE_KEY_PREFIX, mode, baseUrl, profile, "new"].join(":");
  }

  const sessionId = (target.sessionId ?? "").trim();
  if (!sessionId) return null;
  return [
    STORAGE_KEY_PREFIX,
    mode,
    baseUrl,
    profile,
    "session",
    encodeURIComponent(sessionId),
  ].join(":");
}

export function readComposerDraftByKey(key: string | null | undefined): string {
  if (!key) return "";
  const value = readUiValue<unknown>(key, "");
  return typeof value === "string" ? value : "";
}

export function writeComposerDraftByKey(key: string | null | undefined, text: string): void {
  if (!key) return;
  if (!text.trim()) {
    removeUiValue(key);
    return;
  }
  writeUiValue(key, text);
}

export function forgetComposerDraftByKey(key: string | null | undefined): void {
  if (!key) return;
  removeUiValue(key);
}

export function readComposerDraft(target: ComposerDraftTarget | null | undefined): string {
  return readComposerDraftByKey(composerDraftStorageKey(target));
}

export function writeComposerDraft(target: ComposerDraftTarget | null | undefined, text: string): void {
  writeComposerDraftByKey(composerDraftStorageKey(target), text);
}

const HISTORY_KEY_SUFFIX = "history";
const ANONYMOUS_HISTORY_KEY = "__history__";

export const COMPOSER_HISTORY_LIMIT = 30;
export const COMPOSER_HISTORY_MAX_CHARS = 8000;

const historyCache = new Map<string, string[]>();

export function composerHistoryStorageKey(draftKey: string | null | undefined): string | null {
  const key = (draftKey ?? "").trim();
  if (!key) return null;
  return `${STORAGE_KEY_PREFIX}.${HISTORY_KEY_SUFFIX}:${encodeURIComponent(key)}`;
}

function historyCacheKey(storageKey: string | null): string {
  return storageKey ?? ANONYMOUS_HISTORY_KEY;
}

function sanitizeHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(item.slice(0, COMPOSER_HISTORY_MAX_CHARS));
  }
  return out.slice(-COMPOSER_HISTORY_LIMIT);
}

export function readComposerHistory(draftKey: string | null | undefined): string[] {
  const storageKey = composerHistoryStorageKey(draftKey);
  const cacheKey = historyCacheKey(storageKey);
  const cached = historyCache.get(cacheKey);
  if (cached) return cached;
  const stored = storageKey ? sanitizeHistory(readUiValue<unknown>(storageKey, [])) : [];
  historyCache.set(cacheKey, stored);
  return stored;
}

export function pushComposerHistory(
  draftKey: string | null | undefined,
  text: string,
): string[] {
  const entry = (text ?? "").trim();
  if (!entry) return readComposerHistory(draftKey);
  const storageKey = composerHistoryStorageKey(draftKey);
  const cacheKey = historyCacheKey(storageKey);
  const current = readComposerHistory(draftKey);
  const next = [...current.filter((item) => item.trim() !== entry), entry.slice(0, COMPOSER_HISTORY_MAX_CHARS)]
    .slice(-COMPOSER_HISTORY_LIMIT);
  historyCache.set(cacheKey, next);
  if (storageKey) writeUiValue(storageKey, next);
  return next;
}

export function forgetComposerHistory(draftKey: string | null | undefined): void {
  const storageKey = composerHistoryStorageKey(draftKey);
  historyCache.set(historyCacheKey(storageKey), []);
  if (storageKey) removeUiValue(storageKey);
}

export interface ComposerHistoryRecallInput {
  direction: "prev" | "next";
  history: readonly string[];
  index: number;
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export interface ComposerHistoryRecall {
  text: string;
  index: number;
  caret: number;
}

export function recallComposerHistory(
  input: ComposerHistoryRecallInput,
): ComposerHistoryRecall | null {
  const { direction, history, index, value, selectionStart, selectionEnd } = input;
  if (selectionStart !== selectionEnd) return null;
  if (!history.length) return null;

  if (direction === "prev") {
    const browsing = index >= 0;
    if (!browsing && value.trim() !== "") return null;
    if (value.slice(0, selectionStart).includes("\n")) return null;
    const nextIndex = browsing ? index - 1 : history.length - 1;
    if (nextIndex < 0) return null;
    const text = history[nextIndex] ?? "";
    if (!text) return null;
    return { text, index: nextIndex, caret: 0 };
  }

  if (index < 0) return null;
  if (value.slice(selectionStart).includes("\n")) return null;
  const nextIndex = index + 1;
  if (nextIndex >= history.length) return { text: "", index: -1, caret: 0 };
  const text = history[nextIndex] ?? "";
  return { text, index: nextIndex, caret: text.length };
}
