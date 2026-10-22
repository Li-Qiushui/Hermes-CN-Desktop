import type { SessionSummary } from "@hermes/protocol";

export const RECENT_SESSION_PAGE_SIZE = 20;

export function lastActivitySec(session: SessionSummary): number {
  return session.ended_at ?? session.started_at;
}

export type SessionDayGroupKey = "today" | "yesterday" | "earlier";

export interface SessionDayGroup {
  key: SessionDayGroupKey;
  label: string;
  items: SessionSummary[];
}

const DAY_GROUP_LABELS: Record<SessionDayGroupKey, string> = {
  today: "今天",
  yesterday: "昨天",
  earlier: "更早",
};

const DAY_GROUP_ORDER: SessionDayGroupKey[] = ["today", "yesterday", "earlier"];

function startOfDayMs(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function sessionDayGroupKey(unixSec: number, now: Date): SessionDayGroupKey {
  const dayStart = startOfDayMs(new Date(unixSec * 1000));
  if (dayStart === startOfDayMs(now)) return "today";
  const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  if (dayStart === yesterdayStart) return "yesterday";
  return "earlier";
}

export function sortSessionsByLastActivity(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => lastActivitySec(b) - lastActivitySec(a));
}

export function groupSessionsByDay(sessions: SessionSummary[], now: Date): SessionDayGroup[] {
  const buckets: Record<SessionDayGroupKey, SessionSummary[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  };
  for (const session of sessions) {
    buckets[sessionDayGroupKey(lastActivitySec(session), now)].push(session);
  }
  return DAY_GROUP_ORDER.flatMap((key) =>
    buckets[key].length > 0
      ? [{ key, label: DAY_GROUP_LABELS[key], items: sortSessionsByLastActivity(buckets[key]) }]
      : [],
  );
}

export function toggleSelectedSessionId(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

export function selectSessionsById(
  sessions: SessionSummary[],
  selected: ReadonlySet<string>,
): SessionSummary[] {
  return sessions.filter((session) => selected.has(session.id));
}

export function filterSessionsByQuery(sessions: SessionSummary[], query: string): SessionSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return sessions;
  return sessions.filter((session) => {
    if (session.id.toLowerCase().includes(needle)) return true;
    const title = typeof session.title === "string" ? session.title.toLowerCase() : "";
    if (title.includes(needle)) return true;
    const preview = typeof session.preview === "string" ? session.preview.toLowerCase() : "";
    return preview.includes(needle);
  });
}

export interface SessionPageLike {
  sessions: SessionSummary[];
  total: number;
}

export function mergeSessionPages(pages: SessionPageLike[]): SessionSummary[] {
  const seen = new Set<string>();
  const merged: SessionSummary[] = [];
  for (const page of pages) {
    for (const session of page.sessions) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      merged.push(session);
    }
  }
  return merged;
}

export function sessionPagesTotal(pages: SessionPageLike[]): number {
  if (pages.length === 0) return 0;
  return pages[pages.length - 1].total;
}

/** 已消费的 raw 行数（不去重）：offset 必须按它前进，否则重叠页会让分页原地打转。 */
export function sessionPageRowsFetched(pages: SessionPageLike[]): number {
  return pages.reduce((sum, page) => sum + page.sessions.length, 0);
}

export function allSessionPagesLoaded(pages: SessionPageLike[]): boolean {
  if (pages.length === 0) return false;
  // 末页返回 0 行 ＝ 服务端说到头了，不能再把它当「继续」信号。
  if (pages[pages.length - 1].sessions.length === 0) return true;
  return sessionPageRowsFetched(pages) >= sessionPagesTotal(pages);
}

export function nextSessionPageOffset(pages: SessionPageLike[]): number | null {
  if (pages.length === 0) return 0;
  const fetched = sessionPageRowsFetched(pages);
  if (fetched === 0) return null;
  if (allSessionPagesLoaded(pages)) return null;
  return fetched;
}

export interface SidebarWorkspaceEntry {
  path: string;
  name: string;
  sessionCount: number;
}

export function normalizeWorkspaceKey(path: string | null | undefined): string {
  if (typeof path !== "string") return "";
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function cleanWorkspacePath(path: string | null | undefined): string {
  if (typeof path !== "string") return "";
  return path.trim().replace(/[\\/]+$/, "");
}

function workspaceOwnsSession(cwd: string, workspacePath: string): boolean {
  return cwd === workspacePath || cwd.startsWith(`${workspacePath}/`);
}

export function deriveSidebarWorkspaces(
  sessions: SessionSummary[],
  projects: Array<{ path: string; name?: string }>,
  nameFromPath: (path: string) => string,
): SidebarWorkspaceEntry[] {
  const cwds = sessions.flatMap((session) => {
    const cwd = cleanWorkspacePath(session.cwd);
    return cwd ? [cwd] : [];
  });
  const rawByKey = new Map<string, string>();
  for (const cwd of cwds) {
    const key = normalizeWorkspaceKey(cwd);
    if (key && !rawByKey.has(key)) rawByKey.set(key, cwd);
  }
  const seen = new Set<string>();
  const entries: SidebarWorkspaceEntry[] = [];

  const push = (rawPath: string, name?: string) => {
    const clean = cleanWorkspacePath(rawPath);
    const key = normalizeWorkspaceKey(clean);
    if (!clean || seen.has(key)) return;
    seen.add(key);
    const path = rawByKey.get(key) ?? clean;
    entries.push({
      path,
      name: (typeof name === "string" && name.trim()) || nameFromPath(clean),
      sessionCount: cwds.filter((cwd) => workspaceOwnsSession(normalizeWorkspaceKey(cwd), key)).length,
    });
  };

  for (const project of projects) push(project.path, project.name);
  for (const cwd of Array.from(rawByKey.values()).sort((a, b) => a.localeCompare(b))) {
    const key = normalizeWorkspaceKey(cwd);
    if (entries.some((entry) => workspaceOwnsSession(key, normalizeWorkspaceKey(entry.path)))) continue;
    push(cwd);
  }

  return entries;
}
