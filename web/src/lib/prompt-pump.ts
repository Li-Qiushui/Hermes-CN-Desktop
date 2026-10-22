import { getDefaultStore } from "jotai";
import type { GatewayEvent } from "@hermes/protocol";
import { ensureGatewayBridge, subscribeSessionQuietly } from "@/hooks/use-gateway";
import { getGatewayClient } from "@/lib/gateway-client";
import { startServerRequestBridge } from "@/lib/server-request-bridge";
import {
  applyGatewayEventAtom,
  chatRuntimeBySessionAtom,
  gwSessionIdAtom,
  promptsOf,
} from "@/stores/chat";

const PROMPT_EVENT_TYPES = [
  "approval.request",
  "clarify.request",
  "approval.settled",
  "clarify.settled",
] as const;

// `session.active_list` statuses that can still raise a blocking prompt.
const RUNNING_STATUSES = new Set(["working", "waiting", "starting"]);

const ACTIVE_LIST_TIMEOUT_MS = 15_000;
const RESCAN_INTERVAL_MS = 300_000;

interface ActiveSessionRow {
  id?: unknown;
  session_key?: unknown;
  status?: unknown;
}

function promptIdOf(event: GatewayEvent): string | null {
  const payload = event.payload;
  if (!payload || typeof payload !== "object") return null;
  const promptId = (payload as Record<string, unknown>).prompt_id;
  return typeof promptId === "string" && promptId ? promptId : null;
}

/**
 * Reduce a prompt event into the chat store exactly once. When a chat page is
 * mounted the gateway bridge's own subscriber usually got there first, so the
 * store already knows this prompt id and re-applying is skipped.
 */
function applyPromptEvent(event: GatewayEvent): void {
  const sessionId = event.session_id;
  if (!sessionId) return;
  const store = getDefaultStore();
  const promptId = promptIdOf(event);
  if (promptId) {
    const runtime = store.get(chatRuntimeBySessionAtom)[sessionId];
    if (runtime && promptsOf(runtime).some((prompt) => prompt.promptId === promptId)) return;
  }
  store.set(applyGatewayEventAtom, event);
}

function activeSessionIds(result: unknown): string[] {
  const rows = (result as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(rows)) return [];
  const ids: string[] = [];
  for (const row of rows as ActiveSessionRow[]) {
    const status = typeof row.status === "string" ? row.status : "";
    if (!RUNNING_STATUSES.has(status)) continue;
    const id =
      typeof row.id === "string" && row.id
        ? row.id
        : typeof row.session_key === "string" && row.session_key
          ? row.session_key
          : "";
    if (id) ids.push(id);
  }
  return ids;
}

const subscribed = new Set<string>();

async function syncActiveSessions(): Promise<void> {
  let ids: string[];
  try {
    ids = activeSessionIds(
      await getGatewayClient().request("session.active_list", {}, { timeoutMs: ACTIVE_LIST_TIMEOUT_MS }),
    );
  } catch {
    return;
  }
  const current = getDefaultStore().get(gwSessionIdAtom);
  for (const id of ids) {
    if (id === current || subscribed.has(id)) continue;
    subscribed.add(id);
    try {
      await subscribeSessionQuietly(id);
    } catch {
      // A profile mismatch / vanished session is not actionable here; drop the
      // memo so a later scan can retry.
      subscribed.delete(id);
    }
  }
}

let started = false;

/**
 * Start the app-wide prompt pump: attach to every live session (so prompts from
 * turns started outside this window still arrive) and reduce the four prompt
 * events into the chat store even when no chat page is mounted.
 */
export function startGlobalPromptPump(): () => void {
  if (started) return () => {};
  started = true;

  const client = getGatewayClient();
  const bridge = ensureGatewayBridge();
  void bridge;

  const stopServerRequests = startServerRequestBridge();

  const offEvents = PROMPT_EVENT_TYPES.map((type) => client.on(type, applyPromptEvent));
  const offState = client.onState((state) => {
    if (state !== "open") return;
    // A reconnect gets a fresh socket with no attachments; re-attach so prompts
    // raised while we were offline still reach us.
    subscribed.clear();
    void syncActiveSessions();
  });
  const onVisibility = () => {
    if (document.visibilityState === "visible") void syncActiveSessions();
  };
  document.addEventListener("visibilitychange", onVisibility);
  const timer = window.setInterval(() => void syncActiveSessions(), RESCAN_INTERVAL_MS);

  void syncActiveSessions();

  return () => {
    started = false;
    for (const off of offEvents) off();
    offState();
    stopServerRequests();
    document.removeEventListener("visibilitychange", onVisibility);
    window.clearInterval(timer);
    subscribed.clear();
  };
}
