export const PENDING_RUN_TIMEOUT_MS = 90_000;
export const PENDING_RUN_START_SLACK_MS = 2_000;
export const RUN_SESSION_MATCH_WINDOW_MS = 300_000;

export interface CronRunSession {
  id: string;
  title: string;
  source: string;
  startedAtMs: number | null;
  endedAtMs: number | null;
  lastActiveMs: number | null;
}

export interface CronRunStartLike {
  started_at?: string | null;
}

function toEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseCronRunSessions(payload: unknown): CronRunSession[] {
  if (!payload || typeof payload !== "object") return [];
  const raw = (payload as { runs?: unknown }).runs;
  if (!Array.isArray(raw)) return [];

  const sessions: CronRunSession[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = asText(record.id);
    if (!id || id.startsWith("cron_output:")) continue;
    sessions.push({
      id,
      title: asText(record.title),
      source: asText(record.source),
      startedAtMs: toEpochMs(record.started_at),
      endedAtMs: toEpochMs(record.ended_at),
      lastActiveMs: toEpochMs(record.last_active),
    });
  }
  return sessions;
}

export function runStartedMs(run: CronRunStartLike | null | undefined): number | null {
  return toEpochMs(run?.started_at ?? null);
}

export function sessionIdForRun(docMs: number | null, sessions: ReadonlyArray<CronRunSession>): string | null {
  if (docMs === null) return null;
  const window = RUN_SESSION_MATCH_WINDOW_MS;
  for (const session of sessions) {
    if (session.source !== "cron") continue;
    const start = session.startedAtMs ?? 0;
    const end = session.endedAtMs ?? session.lastActiveMs ?? start;
    if (start - window <= docMs && docMs <= end + window) {
      return session.id;
    }
  }
  return null;
}

export function pendingRunSettled(runs: ReadonlyArray<CronRunStartLike>, requestedAt: number): boolean {
  return runs.some((run) => {
    const startedAt = runStartedMs(run);
    return startedAt !== null && startedAt >= requestedAt - PENDING_RUN_START_SLACK_MS;
  });
}

export function pendingRunElapsedSeconds(requestedAt: number, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - requestedAt) / 1000));
}

export function pendingRunExpired(requestedAt: number, now: number = Date.now()): boolean {
  return now - requestedAt >= PENDING_RUN_TIMEOUT_MS;
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

export function backendErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const trimmed = raw.trim();
  if (!trimmed) return "后端没有返回错误信息";
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const payload = JSON.parse(trimmed.slice(jsonStart)) as Record<string, unknown>;
      for (const key of ["detail", "message", "error"]) {
        const value = payload[key];
        if (typeof value === "string" && value.trim()) return value.trim();
        if (Array.isArray(value)) {
          const joined = value
            .map((entry) => {
              if (entry && typeof entry === "object") {
                const record = entry as Record<string, unknown>;
                return asText(record.msg) || asText(record.message) || JSON.stringify(entry);
              }
              return String(entry);
            })
            .filter(Boolean)
            .join("；");
          if (joined) return joined;
        }
      }
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}
