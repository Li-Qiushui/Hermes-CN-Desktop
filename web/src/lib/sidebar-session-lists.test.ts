import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@hermes/protocol";
import {
  allSessionPagesLoaded,
  deriveSidebarWorkspaces,
  filterSessionsByQuery,
  groupSessionsByDay,
  mergeSessionPages,
  nextSessionPageOffset,
  selectSessionsById,
  sessionDayGroupKey,
  sessionPagesTotal,
  toggleSelectedSessionId,
  type SessionPageLike,
} from "./sidebar-session-lists";

function session(id: string, startedAt: number, endedAt: number | null = startedAt + 10): SessionSummary {
  return {
    id,
    model: "model",
    title: id,
    started_at: startedAt,
    ended_at: endedAt,
    message_count: 1,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: null,
  };
}

function at(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return Math.floor(new Date(year, month - 1, day, hour, minute).getTime() / 1000);
}

describe("groupSessionsByDay", () => {
  const now = new Date(2026, 2, 1, 9, 0);

  it("orders rows inside a bucket by last activity instead of input order", () => {
    const groups = groupSessionsByDay(
      [
        session("stale-created-today", at(2026, 3, 1, 0, 20)),
        session("resumed-today", at(2026, 3, 1, 8, 40)),
      ],
      now,
    );

    expect(groups[0]?.key).toBe("today");
    expect(groups[0]?.items.map((item) => item.id)).toEqual([
      "resumed-today",
      "stale-created-today",
    ]);
  });

  it("splits sessions into today / yesterday / earlier and drops empty groups", () => {
    const groups = groupSessionsByDay(
      [
        session("t1", at(2026, 3, 1, 8, 30)),
        session("t2", at(2026, 3, 1, 0, 5)),
        session("y1", at(2026, 2, 28, 23, 59)),
        session("e1", at(2026, 2, 27, 12, 0)),
      ],
      now,
    );

    expect(groups.map((group) => group.key)).toEqual(["today", "yesterday", "earlier"]);
    expect(groups.map((group) => group.label)).toEqual(["今天", "昨天", "更早"]);
    expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([
      ["t1", "t2"],
      ["y1"],
      ["e1"],
    ]);
  });

  it("omits empty buckets instead of rendering blank sections", () => {
    const groups = groupSessionsByDay([session("t1", at(2026, 3, 1, 8, 0))], now);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("today");
  });

  it("treats 23:59 of the previous day as yesterday at the midnight boundary", () => {
    expect(sessionDayGroupKey(at(2026, 2, 28, 23, 59), now)).toBe("yesterday");
    expect(sessionDayGroupKey(at(2026, 3, 1, 0, 0), now)).toBe("today");
  });

  it("crosses the month boundary without arithmetic drift", () => {
    const marchFirst = new Date(2026, 2, 1, 0, 10);
    const groups = groupSessionsByDay(
      [session("lastOfFeb", at(2026, 2, 28, 23, 59)), session("older", at(2026, 2, 26, 9, 0))],
      marchFirst,
    );

    expect(groups.map((group) => group.key)).toEqual(["yesterday", "earlier"]);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(["lastOfFeb"]);
  });

  it("falls back to started_at when ended_at is null", () => {
    const groups = groupSessionsByDay(
      [session("open", at(2026, 2, 28, 22, 0), null)],
      now,
    );

    expect(groups[0]?.key).toBe("yesterday");
    expect(groups[0]?.items.map((item) => item.id)).toEqual(["open"]);
  });
});

describe("session page offsets", () => {
  function page(count: number, total: number, prefix = "s"): SessionPageLike {
    return {
      sessions: Array.from({ length: count }, (_, index) => session(`${prefix}${index}`, index + 1)),
      total,
    };
  }

  it("starts at offset 0 and advances by the fetched row count", () => {
    expect(nextSessionPageOffset([])).toBe(0);
    expect(nextSessionPageOffset([page(20, 45)])).toBe(20);
    expect(nextSessionPageOffset([page(20, 45), page(20, 45)])).toBe(40);
  });

  it("stops paging once every row has been loaded", () => {
    expect(nextSessionPageOffset([page(20, 45, "a"), page(20, 45, "b"), page(5, 45, "c")])).toBeNull();
    expect(nextSessionPageOffset([page(3, 3)])).toBeNull();
  });

  it("末页返回空行时不再请求同一个 offset", () => {
    const pages = [page(20, 45), { sessions: [], total: 45 }];
    expect(nextSessionPageOffset(pages)).toBeNull();
    expect(allSessionPagesLoaded(pages)).toBe(true);
  });

  it("重叠页按 raw 行数前进，不会原地打转", () => {
    const first = page(20, 45);
    const overlapping: SessionPageLike = {
      sessions: [session("s18", 18), session("s19", 19), session("s20", 20)],
      total: 45,
    };
    expect(nextSessionPageOffset([first, overlapping])).toBe(23);
  });

  it("dedupes rows that shift between pages", () => {
    const first = page(3, 5);
    const second: SessionPageLike = {
      sessions: [session("s2", 2), session("s3", 3), session("n1", 4)],
      total: 5,
    };

    expect(mergeSessionPages([first, second]).map((item) => item.id)).toEqual([
      "s0",
      "s1",
      "s2",
      "s3",
      "n1",
    ]);
    expect(allSessionPagesLoaded([first, second])).toBe(true);
    expect(sessionPagesTotal([first, second])).toBe(5);
  });
});

describe("sidebar selection", () => {
  it("toggles ids in and out of the selected set", () => {
    const first = toggleSelectedSessionId(new Set<string>(), "s1");
    const second = toggleSelectedSessionId(first, "s2");
    const third = toggleSelectedSessionId(second, "s1");

    expect(Array.from(second)).toEqual(["s1", "s2"]);
    expect(Array.from(third)).toEqual(["s2"]);
    expect(Array.from(first)).toEqual(["s1"]);
  });

  it("keeps selection order from the session list and ignores unknown ids", () => {
    const sessions = [session("s1", 3), session("s2", 2), session("s3", 1)];
    const selected = selectSessionsById(sessions, new Set(["s3", "missing", "s1"]));

    expect(selected.map((item) => item.id)).toEqual(["s1", "s3"]);
  });
});

describe("filterSessionsByQuery", () => {
  const sessions = [
    { ...session("abc-123", 3), title: "枢纽改造计划" },
    { ...session("def-456", 2), title: "Weekly sync" },
    { ...session("ghi-789", 1), title: null },
  ];

  it("matches title and id without case sensitivity", () => {
    expect(filterSessionsByQuery(sessions, "枢纽").map((item) => item.id)).toEqual(["abc-123"]);
    expect(filterSessionsByQuery(sessions, "weekly").map((item) => item.id)).toEqual(["def-456"]);
    expect(filterSessionsByQuery(sessions, "ghi").map((item) => item.id)).toEqual(["ghi-789"]);
  });

  it("matches the preview shown for untitled sessions", () => {
    const untitled = [
      { ...session("no-title", 2), title: null, preview: "把侧栏加载态补上" },
      { ...session("titled", 1), title: "别的对话", preview: "无关内容" },
    ];

    expect(filterSessionsByQuery(untitled, "侧栏").map((item) => item.id)).toEqual(["no-title"]);
    expect(filterSessionsByQuery(untitled, "无关").map((item) => item.id)).toEqual(["titled"]);
  });

  it("returns the original list for a blank query", () => {
    expect(filterSessionsByQuery(sessions, "   ")).toBe(sessions);
  });
});

describe("deriveSidebarWorkspaces", () => {
  const nameFromPath = (path: string) =>
    path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;

  it("merges remembered projects with cwds seen in sessions", () => {
    const workspaces = deriveSidebarWorkspaces(
      [
        { ...session("s1", 3), cwd: "D:/Project/www-a" },
        { ...session("s2", 2), cwd: "D:/Project/www-a/" },
        { ...session("s3", 1), cwd: "D:\\Project\\www-b" },
        { ...session("s4", 0), cwd: null },
      ],
      [{ path: "D:/Project/remembered", name: "记住的项目" }],
      nameFromPath,
    );

    expect(workspaces.map((workspace) => workspace.path)).toEqual([
      "D:/Project/remembered",
      "D:/Project/www-a",
      "D:\\Project\\www-b",
    ]);
    expect(workspaces.map((workspace) => workspace.name)).toEqual([
      "记住的项目",
      "www-a",
      "www-b",
    ]);
    expect(workspaces.map((workspace) => workspace.sessionCount)).toEqual([0, 2, 1]);
  });

  it("keeps the raw cwd form so the server-side prefix match can hit", () => {
    const workspaces = deriveSidebarWorkspaces(
      [{ ...session("s1", 1), cwd: "C:\\Windows\\system32" }],
      [{ path: "C:/Windows/system32", name: "system32" }],
      nameFromPath,
    );

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.path).toBe("C:\\Windows\\system32");
    expect(workspaces[0]?.sessionCount).toBe(1);
  });

  it("counts sessions nested under a workspace path", () => {
    const workspaces = deriveSidebarWorkspaces(
      [{ ...session("s1", 1), cwd: "D:/Project/www-a/packages/web" }],
      [{ path: "D:/Project/www-a", name: "www-a" }],
      nameFromPath,
    );

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.sessionCount).toBe(1);
  });
});
