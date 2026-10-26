import { useSyncExternalStore } from "react";
import type { ComposerAttachment } from "@/components/chat/composer-types";

// Per-session send queue. When the agent is busy, composer submissions are
// parked here and drained (automatically on turn-settle, or manually) when it
// frees up. Pure client state, persisted to localStorage; no backend.

export interface QueuedPromptEntry {
  id: string;
  text: string;
  attachments: ComposerAttachment[];
  queuedAt: number;
  /** 重载后被丢掉的附件数（浏览器 File / blob 无法持久化）。>0 时 UI 标红，
   *  避免附件在重启后静默消失。 */
  lostAttachments?: number;
  /** 上一次投递失败的原因。条目留在队列里，UI 行内显示并把按钮变成「重试」。 */
  error?: string;
}

export type QueueState = Record<string, QueuedPromptEntry[]>;

/** 每会话排队上限，对齐 RACP 的 maxQueuedTurnsPerSession。 */
export const MAX_QUEUED_PER_SESSION = 8;

const STORAGE_KEY = "hermes.desktop.composerQueue.v1";
const EMPTY: readonly QueuedPromptEntry[] = [];

// ---- Pure reducers (unit-tested) -------------------------------------------

export function entriesFor(
  state: QueueState,
  key: string | null | undefined,
): QueuedPromptEntry[] {
  return (key && state[key]) || (EMPTY as QueuedPromptEntry[]);
}

export function enqueue(state: QueueState, key: string, entry: QueuedPromptEntry): QueueState {
  return { ...state, [key]: [...(state[key] ?? []), entry] };
}

export function removeEntry(state: QueueState, key: string, id: string): QueueState {
  const queue = state[key];
  if (!queue) return state;
  const next = queue.filter((entry) => entry.id !== id);
  if (next.length === queue.length) return state;
  if (next.length === 0) {
    const { [key]: _drop, ...rest } = state;
    return rest;
  }
  return { ...state, [key]: next };
}

export function updateEntry(
  state: QueueState,
  key: string,
  id: string,
  patch: Partial<Pick<QueuedPromptEntry, "text" | "attachments">>,
): QueueState {
  const queue = state[key];
  if (!queue) return state;
  return {
    ...state,
    [key]: queue.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
  };
}

export function isQueueFull(state: QueueState, key: string | null | undefined): boolean {
  if (!key) return false;
  return (state[key]?.length ?? 0) >= MAX_QUEUED_PER_SESSION;
}

/** 给一条排队消息挂上投递失败原因；条目本身保留，供用户就地重试。 */
export function markEntryFailed(
  state: QueueState,
  key: string,
  id: string,
  message: string,
): QueueState {
  const queue = state[key];
  if (!queue?.some((entry) => entry.id === id)) return state;
  return {
    ...state,
    [key]: queue.map((entry) => (entry.id === id ? { ...entry, error: message } : entry)),
  };
}

export interface AutoDrainSettleInput {
  isBusy: boolean;
  wasBusy: boolean;
  queueLength: number;
  userInterrupted: boolean;
}

/**
 * Decide whether to auto-send the next queued prompt now. Only fires on a
 * busy→idle transition, never when an explicit Stop just interrupted the turn
 * (that suppresses exactly one drain), and only when something is queued.
 */
export function shouldAutoDrainOnSettle(params: AutoDrainSettleInput): boolean {
  if (params.isBusy || !params.wasBusy) return false;
  if (params.userInterrupted) return false;
  return params.queueLength > 0;
}

// ---- Persistence -----------------------------------------------------------

/** Strip transient (non-serializable) attachment fields before persisting. */
function attachmentForStorage(attachment: ComposerAttachment): ComposerAttachment {
  const { file: _file, previewUrl: _previewUrl, ...rest } = attachment;
  return rest;
}

export function serializeQueue(state: QueueState): string {
  const cleaned: QueueState = {};
  for (const [key, entries] of Object.entries(state)) {
    cleaned[key] = entries.map((entry) => {
      const { error: _error, ...rest } = entry;
      return {
        ...rest,
        attachments: rest.attachments.map(attachmentForStorage),
      };
    });
  }
  return JSON.stringify(cleaned);
}

function isQueuedEntry(value: unknown): value is QueuedPromptEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<QueuedPromptEntry>;
  return (
    typeof e.id === "string" &&
    typeof e.text === "string" &&
    typeof e.queuedAt === "number" &&
    Array.isArray(e.attachments) &&
    (e.lostAttachments === undefined || typeof e.lostAttachments === "number") &&
    (e.error === undefined || typeof e.error === "string")
  );
}

/** Drop attachments that can't survive a reload (browser File objects lose
 *  their data); path-based and already-uploaded attachments keep working.
 *  Tolerates malformed elements (null / non-objects) without throwing.
 *  `dropped` counts what was thrown away so the restore path can flag the
 *  entry instead of letting the attachments vanish silently. */
function sanitizeAttachments(attachments: ComposerAttachment[]): {
  kept: ComposerAttachment[];
  dropped: number;
} {
  const kept = attachments.filter(
    (a): a is ComposerAttachment =>
      Boolean(a) && typeof a === "object" && (
        (a.source === "path" && Boolean(a.path)) ||
        (a.source === "uploaded" && Boolean(a.uploadedPath))
      ),
  );
  return { kept, dropped: Math.max(0, attachments.length - kept.length) };
}

/**
 * Check whether any queued entry has attachments that cannot survive a page
 * refresh (browser File / blob URLs). Callers can use this to warn the user
 * before unload — see the `beforeunload` listener in this module.
 */
export function hasNonSerializableAttachments(state: QueueState): boolean {
  for (const entries of Object.values(state)) {
    for (const entry of entries) {
      if (entryHasVolatileAttachments(entry)) return true;
    }
  }
  return false;
}

/** 这条排队消息的附件是否有丢的风险：还在内存里的浏览器附件，或重载时
 *  已经被丢掉、只剩计数的那种。UI 用它决定标不标红。 */
export function entryHasVolatileAttachments(entry: QueuedPromptEntry): boolean {
  if (typeof entry.lostAttachments === "number" && entry.lostAttachments > 0) return true;
  for (const att of entry.attachments) {
    if (att && typeof att === "object" && att.source !== "path" && att.source !== "uploaded") {
      return true;
    }
  }
  return false;
}

export function deserializeQueue(raw: string | null): QueueState {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Persisted state outlives the code that wrote it: it survives app updates
    // and reinstalls — only deleting app data clears it. A single malformed
    // entry (e.g. a `text` that deserializes to an object) would otherwise be
    // restored verbatim, render as "[object Object]" under the composer, and
    // wedge send/drain until the user wipes app data — the disaster reported in
    // issue #224's comments. Validate every entry and drop anything malformed
    // instead of trusting the persisted shape.
    const clean: QueueState = {};
    for (const [key, entries] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      const valid = entries
        .filter(isQueuedEntry)
        .map((entry) => {
          const { kept, dropped } = sanitizeAttachments(entry.attachments);
          const lost = dropped + (entry.lostAttachments ?? 0);
          const restored: QueuedPromptEntry = { ...entry, attachments: kept };
          if (lost > 0) restored.lostAttachments = lost;
          else delete restored.lostAttachments;
          return restored;
        });
      if (valid.length > 0) clean[key] = valid;
    }
    return clean;
  } catch {
    return {};
  }
}

// ---- Live store (useSyncExternalStore) -------------------------------------

function readStorage(): QueueState {
  if (typeof window === "undefined") return {};
  try {
    return deserializeQueue(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

let liveState: QueueState = readStorage();
let idCounter = 0;
const listeners = new Set<() => void>();

function commit(next: QueueState) {
  liveState = next;
  if (typeof window !== "undefined") {
    try {
      if (Object.keys(next).length === 0) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, serializeQueue(next));
    } catch {
      // best-effort; queue still works in-memory
    }
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): QueueState {
  return liveState;
}

// Warn before page refresh when queued prompts have non-serializable
// attachments (browser File objects / blob URLs that would be lost).
function installBeforeUnloadWarning() {
  if (typeof window === "undefined") return;
  const handler = (event: BeforeUnloadEvent) => {
    if (hasNonSerializableAttachments(liveState)) {
      event.preventDefault();
      event.returnValue = "有暂存的附件可能丢失";
    }
  };
  window.addEventListener("beforeunload", handler);
}
installBeforeUnloadWarning();

export function enqueueQueuedPrompt(
  key: string | null | undefined,
  input: { text: string; attachments: ComposerAttachment[] },
  now: number,
): QueuedPromptEntry | null {
  if (!key) return null;
  if (!input.text.trim() && input.attachments.length === 0) return null;
  if (isQueueFull(liveState, key)) return null;
  const entry: QueuedPromptEntry = {
    id: `queued-${now}-${(idCounter += 1)}`,
    text: input.text,
    attachments: input.attachments,
    queuedAt: now,
  };
  commit(enqueue(liveState, key, entry));
  return entry;
}

/** 投递失败：条目留在队列里，挂上原因让 UI 行内提示并给重试入口。 */
export function markQueuedPromptFailed(
  key: string | null | undefined,
  id: string,
  message: string,
): void {
  if (!key) return;
  commit(markEntryFailed(liveState, key, id, message));
}

export function removeQueuedPrompt(key: string | null | undefined, id: string): void {
  if (!key) return;
  commit(removeEntry(liveState, key, id));
}

export function updateQueuedPrompt(
  key: string | null | undefined,
  id: string,
  patch: Partial<Pick<QueuedPromptEntry, "text" | "attachments">>,
): void {
  if (!key) return;
  commit(updateEntry(liveState, key, id, patch));
}

/** Subscribe a component to the queued entries for one session. */
export function useQueuedPrompts(key: string | null | undefined): QueuedPromptEntry[] {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return entriesFor(snapshot, key);
}
