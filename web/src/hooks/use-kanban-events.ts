import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { debugBus } from "@/lib/debug-bus";
import { runtime } from "@/lib/runtime";
import {
  KANBAN_EVENTS_HEARTBEAT_MS,
  KANBAN_EVENTS_STALE_MS,
  kanbanEventsUrl,
  nextReconnectDelayMs,
  parseKanbanEventFrame,
} from "@/lib/kanban";
import { kanbanKeys } from "@/hooks/use-kanban";

export type KanbanEventStreamStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface UseKanbanEventsOptions {
  slug: string;
  since?: number | null;
  enabled?: boolean;
}

export interface KanbanEventStreamState {
  status: KanbanEventStreamStatus;
  cursor: number | null;
  reconnects: number;
}

export function kanbanEventsEndpoint(): string | null {
  try {
    const endpoint = runtime.getApiUrl("/api/plugins/kanban/events");
    if (endpoint) return endpoint;
  } catch {
    return null;
  }
  if (typeof window === "undefined" || !window.location?.origin) return null;
  return "/api/plugins/kanban/events";
}

function logEventFrame(message: string, payload: Record<string, unknown>): void {
  debugBus.push({ type: "console", level: "info", summary: message, payload });
  if (typeof console !== "undefined" && typeof console.info === "function") {
    console.info(`[kanban-events] ${message}`, payload);
  }
}

export function useKanbanEvents({ slug, since, enabled = true }: UseKanbanEventsOptions): KanbanEventStreamState {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<KanbanEventStreamStatus>(enabled ? "connecting" : "idle");
  const [cursor, setCursor] = useState<number | null>(since ?? null);
  const [reconnects, setReconnects] = useState(0);
  const cursorRef = useRef<number | null>(typeof since === "number" ? since : null);
  const resyncRef = useRef<((reason: string) => void) | null>(null);

  useEffect(() => {
    if (cursorRef.current != null) return;
    if (typeof since === "number" && Number.isFinite(since) && since >= 0) {
      cursorRef.current = since;
      setCursor(since);
      resyncRef.current?.("首帧 board 数据到达，补上 since");
    }
  }, [since]);

  useEffect(() => {
    if (!enabled || typeof WebSocket === "undefined") {
      setStatus(enabled ? "closed" : "idle");
      return;
    }

    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let attempt = 0;
    let lastActivityAt = Date.now();
    let idleNudged = false;

    const clearReconnect = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };

    const invalidateBoard = (reason: string) => {
      queryClient.invalidateQueries({ queryKey: kanbanKeys.boardAll(slug) });
      queryClient.invalidateQueries({ queryKey: kanbanKeys.boards });
      logEventFrame(`看板失效（${reason}）`, { board: slug, cursor: cursorRef.current });
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      const delay = nextReconnectDelayMs(attempt);
      attempt += 1;
      setReconnects(attempt);
      setStatus("reconnecting");
      logEventFrame(`事件流断开，${delay}ms 后重连`, { board: slug, attempt, delay, cursor: cursorRef.current });
      clearReconnect();
      reconnectTimer = setTimeout(() => {
        if (!disposed) connect();
      }, delay);
    };

    const handleFrame = (data: unknown) => {
      const frame = parseKanbanEventFrame(data);
      if (!frame) return;
      lastActivityAt = Date.now();
      idleNudged = false;
      cursorRef.current = frame.cursor;
      setCursor(frame.cursor);
      for (const taskId of frame.taskIds) {
        queryClient.invalidateQueries({ queryKey: kanbanKeys.task(slug, taskId) });
      }
      queryClient.invalidateQueries({ queryKey: kanbanKeys.boardAll(slug) });
      logEventFrame(
        `收到事件帧 · cursor ${frame.cursor} · ${frame.eventCount} 条 · 失效 ${frame.taskIds.length} 个任务 query`,
        { board: slug, cursor: frame.cursor, events: frame.eventCount, taskIds: frame.taskIds },
      );
    };

    const connect = () => {
      if (disposed) return;
      clearReconnect();
      setStatus("connecting");
      const url = kanbanEventsUrl({
        board: slug,
        since: cursorRef.current,
        token: runtime.getSessionToken() ?? null,
        endpoint: kanbanEventsEndpoint(),
      });
      logEventFrame("连接事件流", { board: slug, since: cursorRef.current });
      let next: WebSocket;
      try {
        next = new WebSocket(url);
      } catch (error) {
        logEventFrame(`事件流建立失败：${error instanceof Error ? error.message : String(error)}`, { board: slug });
        scheduleReconnect();
        return;
      }
      socket = next;
      next.onopen = () => {
        if (disposed) return;
        attempt = 0;
        lastActivityAt = Date.now();
        setStatus("open");
        logEventFrame("事件流已连接", { board: slug, since: cursorRef.current });
      };
      next.onmessage = (event: MessageEvent) => {
        if (disposed) return;
        handleFrame(event.data);
      };
      next.onerror = () => {
        if (disposed) return;
        logEventFrame("事件流错误", { board: slug });
      };
      next.onclose = () => {
        if (disposed) return;
        socket = null;
        scheduleReconnect();
      };
    };

    const restart = (reason: string, invalidate: boolean) => {
      if (disposed) return;
      if (invalidate) invalidateBoard(reason);
      else logEventFrame(reason, { board: slug, cursor: cursorRef.current });
      lastActivityAt = Date.now();
      idleNudged = false;
      attempt = 0;
      const stale = socket;
      socket = null;
      if (stale) {
        stale.onopen = null;
        stale.onmessage = null;
        stale.onerror = null;
        stale.onclose = null;
        try {
          stale.close();
        } catch {}
      }
      scheduleReconnect();
    };

    resyncRef.current = () => restart("首帧 board 数据到达，补上 since 后重连", false);

    heartbeatTimer = setInterval(() => {
      if (disposed) return;
      const idle = Date.now() - lastActivityAt;
      if (idle < KANBAN_EVENTS_HEARTBEAT_MS) return;
      if (idle >= KANBAN_EVENTS_STALE_MS) {
        restart("心跳发现事件流空闲过久（疑似半开），重建", true);
        return;
      }
      if (socket && socket.readyState === WebSocket.OPEN) {
        if (idleNudged) return;
        idleNudged = true;
        invalidateBoard("心跳发现事件流空闲 60s，先失效看板");
        return;
      }
      restart("心跳发现事件流不在 OPEN，重建", true);
    }, KANBAN_EVENTS_HEARTBEAT_MS);

    connect();

    return () => {
      disposed = true;
      resyncRef.current = null;
      clearReconnect();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      const open = socket;
      socket = null;
      if (open) {
        open.onopen = null;
        open.onmessage = null;
        open.onerror = null;
        open.onclose = null;
        try {
          open.close();
        } catch {
          return;
        }
      }
    };
  }, [enabled, queryClient, slug]);

  return { status, cursor, reconnects };
}
