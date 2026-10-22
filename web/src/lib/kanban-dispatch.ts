import { fetchJSON } from "@/lib/transport";

export const KANBAN_DISPATCH_DEBOUNCE_MS = 400;

type DispatchTimer = { timer: ReturnType<typeof setTimeout> | null };

const pending = new Map<string, DispatchTimer>();

export function kanbanDispatchPath(slug: string): string {
  return `/api/plugins/kanban/dispatch?board=${encodeURIComponent(slug || "default")}`;
}

export function flushKanbanDispatch(slug: string): Promise<void> {
  const key = slug || "default";
  const entry = pending.get(key);
  if (entry?.timer) clearTimeout(entry.timer);
  pending.delete(key);
  return sendDispatch(key);
}

function sendDispatch(key: string): Promise<void> {
  try {
    return fetchJSON<unknown>(kanbanDispatchPath(key), { method: "POST" })
      .then(() => undefined)
      .catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

export function requestKanbanDispatch(slug: string): void {
  const key = slug || "default";
  const existing = pending.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  const entry: DispatchTimer = { timer: null };
  entry.timer = setTimeout(() => {
    pending.delete(key);
    void sendDispatch(key);
  }, KANBAN_DISPATCH_DEBOUNCE_MS);
  pending.set(key, entry);
}

export function cancelKanbanDispatch(slug?: string): void {
  const keys = slug ? [slug || "default"] : Array.from(pending.keys());
  for (const key of keys) {
    const entry = pending.get(key);
    if (entry?.timer) clearTimeout(entry.timer);
    pending.delete(key);
  }
}

export function pendingKanbanDispatchCount(): number {
  return pending.size;
}
