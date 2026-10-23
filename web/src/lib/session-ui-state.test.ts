import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  filterSessionsByStatusBuckets,
  groupSessionsForSidebar,
  isSessionPinned,
  isSessionUnread,
  markSessionsReadLocally,
  markSessionsUnreadLocally,
  readPinnedSessionIds,
  readSidebarGrouping,
  readSidebarSort,
  readSidebarStatusFilter,
  readUnreadOverrides,
  reconcileUnreadOverrides,
  resolveSessionDotState,
  sessionCostUsd,
  sessionRecencySec,
  sessionStatusBucket,
  sessionStatusRank,
  sessionTokenTotal,
  sortSessionsForSidebar,
  subscribeSessionUiStateChanges,
  togglePinnedSession,
  toggleStatusFilterBucket,
  unpinSessions,
  writePinnedSessionIds,
  writeSidebarGrouping,
  writeSidebarSort,
  writeSidebarStatusFilter,
  writeUnreadOverrides,
  distinctSessionProfiles,
  needsInputCountsByProfile,
  readSidebarProfileScope,
  reorderPinnedSessionIds,
  reorderSessionIds,
  writeSidebarProfileScope,
  type SidebarSortKey,
} from "./session-ui-state";
import { __resetUiStoreForTests } from "./ui-store";

beforeEach(() => {
  __resetUiStoreForTests();
  vi.stubGlobal("window", {
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("pinned session UI state", () => {
  it("persists clean pinned session ids with de-duplication", () => {
    writePinnedSessionIds([" s1 ", "", "s2", "s1", "   ", "s3"]);

    expect(Array.from(readPinnedSessionIds())).toEqual(["s1", "s2", "s3"]);
    expect(isSessionPinned("s2")).toBe(true);
    expect(isSessionPinned("missing")).toBe(false);
  });

  it("toggles pin and unpin for one session", () => {
    expect(Array.from(togglePinnedSession("s1"))).toEqual(["s1"]);
    expect(isSessionPinned("s1")).toBe(true);

    expect(Array.from(togglePinnedSession("s1"))).toEqual([]);
    expect(isSessionPinned("s1")).toBe(false);
  });

  it("ignores empty session ids", () => {
    writePinnedSessionIds(["s1"]);

    expect(Array.from(togglePinnedSession("   "))).toEqual(["s1"]);
    expect(Array.from(readPinnedSessionIds())).toEqual(["s1"]);
  });

  it("unpinned multiple sessions without touching others", () => {
    writePinnedSessionIds(["s1", "s2", "s3"]);

    expect(Array.from(unpinSessions(["s2", "missing", "s1"]))).toEqual(["s3"]);
    expect(Array.from(readPinnedSessionIds())).toEqual(["s3"]);
  });

  it("notifies subscribers when pinned state changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionUiStateChanges(listener);

    writePinnedSessionIds(["s1"]);
    unsubscribe();
    writePinnedSessionIds(["s2"]);

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("session dot state priority", () => {
  it("needs-input outranks every other signal", () => {
    expect(
      resolveSessionDotState({
        needsInput: true,
        working: true,
        stalled: true,
        background: true,
        unread: true,
        draft: true,
      }),
    ).toBe("needs-input");
  });

  it("stalled refines working instead of inventing a running session", () => {
    expect(resolveSessionDotState({ working: true, stalled: true })).toBe("stalled");
    expect(resolveSessionDotState({ stalled: true })).toBe("idle");
    expect(resolveSessionDotState({ working: true })).toBe("working");
  });

  it("ranks background over unread over draft over idle", () => {
    expect(resolveSessionDotState({ background: true, unread: true, draft: true })).toBe("background");
    expect(resolveSessionDotState({ unread: true, draft: true })).toBe("unread");
    expect(resolveSessionDotState({ draft: true })).toBe("draft");
    expect(resolveSessionDotState({})).toBe("idle");
  });

  it("folds stalled and background into the working filter bucket", () => {
    expect(sessionStatusBucket("stalled")).toBe("working");
    expect(sessionStatusBucket("background")).toBe("working");
    expect(sessionStatusBucket("needs-input")).toBe("needs-input");
    expect(sessionStatusBucket()).toBe("idle");
  });

  it("ranks buckets loudest first", () => {
    expect(sessionStatusRank("needs-input")).toBeLessThan(sessionStatusRank("working"));
    expect(sessionStatusRank("working")).toBeLessThan(sessionStatusRank("unread"));
    expect(sessionStatusRank("unread")).toBeLessThan(sessionStatusRank("draft"));
    expect(sessionStatusRank("background")).toBe(sessionStatusRank("working"));
    expect(sessionStatusRank()).toBe(4);
  });
});

function sessionFixture(overrides: Record<string, unknown> & { id: string }) {
  return {
    started_at: 1_000,
    ended_at: 2_000,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: null as number | null,
    ...overrides,
  };
}

describe("sidebar sorting", () => {
  const list = [
    sessionFixture({ id: "old", started_at: 100, ended_at: 200, input_tokens: 5, estimated_cost_usd: 0.1 }),
    sessionFixture({ id: "new", started_at: 900, ended_at: 950, input_tokens: 50, estimated_cost_usd: 2 }),
    sessionFixture({ id: "mid", started_at: 500, ended_at: 400, input_tokens: 500, estimated_cost_usd: 1 }),
  ];
  const idle = () => undefined;

  it("keeps the incoming order for the default recency sort", () => {
    expect(sortSessionsForSidebar(list, "updated", idle).map((s) => s.id)).toEqual([
      "old",
      "new",
      "mid",
    ]);
  });

  it("sorts by creation time, tokens and cost when those keys are chosen", () => {
    expect(sortSessionsForSidebar(list, "created", idle).map((s) => s.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
    expect(sortSessionsForSidebar(list, "tokens", idle).map((s) => s.id)).toEqual([
      "mid",
      "new",
      "old",
    ]);
    expect(sortSessionsForSidebar(list, "cost", idle).map((s) => s.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });

  it("sorts by status rank and falls back to recency inside a rank", () => {
    const states: Record<string, "needs-input" | "working" | "idle"> = {
      old: "idle",
      new: "working",
      mid: "needs-input",
    };
    expect(
      sortSessionsForSidebar(list, "status", (s) => states[s.id]).map((s) => s.id),
    ).toEqual(["mid", "new", "old"]);
  });

  it("prefers last_active and actual cost when the kernel supplies them", () => {
    expect(sessionRecencySec(sessionFixture({ id: "x", last_active: 5_000 }))).toBe(5_000);
    expect(
      sessionCostUsd(sessionFixture({ id: "x", estimated_cost_usd: 1, actual_cost_usd: 3 })),
    ).toBe(3);
    expect(sessionTokenTotal(sessionFixture({ id: "x", input_tokens: 2, output_tokens: 3 }))).toBe(5);
  });

  it("persists the chosen sort key", () => {
    expect(readSidebarSort()).toBe("updated");
    writeSidebarSort("tokens");
    expect(readSidebarSort()).toBe("tokens");
    writeSidebarSort("nope" as SidebarSortKey);
    expect(readSidebarSort()).toBe("updated");
  });
});

describe("sidebar grouping and status filter", () => {
  const now = new Date(2026, 9, 23, 12, 0, 0);
  const nowSec = Math.floor(now.getTime() / 1000);
  const list = [
    sessionFixture({ id: "a", started_at: nowSec - 60, ended_at: nowSec - 60 }),
    sessionFixture({ id: "b", started_at: nowSec - 86_400, ended_at: nowSec - 86_400 }),
    sessionFixture({ id: "c", started_at: nowSec - 86_400 * 5, ended_at: nowSec - 86_400 * 5 }),
  ];
  const stateOf = () => "idle" as const;

  it("keeps the day buckets by default", () => {
    const groups = groupSessionsForSidebar(list, "day", { now, stateOf });
    expect(groups.map((group) => group.label)).toEqual(["今天", "昨天", "更早"]);
    expect(groups.map((group) => group.items.length)).toEqual([1, 1, 1]);
  });

  it("groups by project name and by profile", () => {
    const byProject = groupSessionsForSidebar(list, "project", {
      now,
      stateOf,
      projectOf: (session) => (session.id === "a" ? "host-hub" : undefined),
    });
    expect(byProject.map((group) => group.label)).toEqual(["未关联项目", "host-hub"]);

    const byProfile = groupSessionsForSidebar(list, "profile", {
      now,
      stateOf,
      profileOf: (session) => (session.id === "c" ? "work" : "default"),
    });
    expect(byProfile.map((group) => group.label).sort()).toEqual(["default", "work"]);
  });

  it("groups by status bucket", () => {
    const states: Record<string, "needs-input" | "unread" | "idle"> = {
      a: "needs-input",
      b: "unread",
      c: "idle",
    };
    const groups = groupSessionsForSidebar(list, "status", {
      now,
      stateOf: (session) => states[session.id],
    });
    expect(groups.map((group) => group.key)).toEqual(["needs-input", "unread", "idle"]);
  });

  it("filters by one or more status buckets and keeps everything when empty", () => {
    const states: Record<string, "needs-input" | "idle"> = { a: "needs-input", b: "idle", c: "idle" };
    const lookup = (session: { id: string }) => states[session.id] ?? "idle";
    expect(filterSessionsByStatusBuckets(list, [], lookup).map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(filterSessionsByStatusBuckets(list, ["needs-input"], lookup).map((s) => s.id)).toEqual(["a"]);
    expect(filterSessionsByStatusBuckets(list, ["needs-input", "idle"], lookup)).toHaveLength(3);
  });

  it("persists grouping and the status filter set", () => {
    expect(readSidebarGrouping()).toBe("day");
    writeSidebarGrouping("status");
    expect(readSidebarGrouping()).toBe("status");

    expect(readSidebarStatusFilter()).toEqual([]);
    toggleStatusFilterBucket([], "unread");
    toggleStatusFilterBucket(readSidebarStatusFilter(), "needs-input");
    expect(readSidebarStatusFilter()).toEqual(["needs-input", "unread"]);
    writeSidebarStatusFilter([]);
    expect(readSidebarStatusFilter()).toEqual([]);
  });
});

describe("unread state", () => {
  it("marks sessions read and unread locally", () => {
    expect(readUnreadOverrides()).toEqual({});

    markSessionsUnreadLocally(["s1", " "]);
    expect(readUnreadOverrides()).toEqual({ s1: "unread" });
    expect(isSessionUnread({ id: "s1" }, readUnreadOverrides())).toBe(true);

    markSessionsReadLocally(["s1"]);
    expect(readUnreadOverrides()).toEqual({ s1: "read" });
    expect(isSessionUnread({ id: "s1", unread: true }, readUnreadOverrides())).toBe(false);
  });

  it("falls back to the backend watermark when no override exists", () => {
    expect(isSessionUnread({ id: "s2", unread: true }, {})).toBe(true);
    expect(isSessionUnread({ id: "s2", unread: false }, {})).toBe(false);
    expect(isSessionUnread({ id: "s2" }, {})).toBe(false);
  });

  it("drops overrides once the server agrees", () => {
    const overrides = { s1: "read" as const, s2: "unread" as const };
    const reconciled = reconcileUnreadOverrides(overrides, [
      { id: "s1", unread: false },
      { id: "s2", unread: false },
    ]);
    expect(reconciled).toEqual({ s2: "unread" });
    expect(
      reconcileUnreadOverrides(overrides, [{ id: "s1", unread: true }, { id: "s2", unread: true }]),
    ).toEqual({ s1: "read" });
  });

  it("keeps overrides for sessions no longer in the list", () => {
    expect(reconcileUnreadOverrides({ gone: "read" }, [{ id: "other", unread: false }])).toEqual({
      gone: "read",
    });
  });

  it("round-trips through the ui store", () => {
    writeUnreadOverrides({ s1: "read", s2: "unread" });
    expect(readUnreadOverrides()).toEqual({ s1: "read", s2: "unread" });
  });
});

describe("置顶顺序", () => {
  it("按目标位置重排数组，越界或原地不动时原样返回", () => {
    expect(reorderSessionIds(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(reorderSessionIds(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(reorderSessionIds(["a", "b"], "a", "a")).toEqual(["a", "b"]);
    expect(reorderSessionIds(["a", "b"], "a", "nope")).toEqual(["a", "b"]);
  });

  it("换序只改本地顺序，不碰后端置顶标记（保留 15s 写栅栏）", () => {
    writePinnedSessionIds(["a", "b", "c"]);
    const next = reorderPinnedSessionIds("a", "c");

    expect(Array.from(next)).toEqual(["b", "c", "a"]);
    expect(Array.from(readPinnedSessionIds())).toEqual(["b", "c", "a"]);
  });

  it("拖到不存在的会话时不写", () => {
    writePinnedSessionIds(["a", "b"]);
    expect(Array.from(reorderPinnedSessionIds("a", "ghost"))).toEqual(["a", "b"]);
    expect(Array.from(readPinnedSessionIds())).toEqual(["a", "b"]);
  });
});

describe("画像范围", () => {
  it("默认只显示当前画像，可切到全部画像并持久化", () => {
    expect(readSidebarProfileScope()).toBe("active");
    expect(writeSidebarProfileScope("all")).toBe("all");
    expect(readSidebarProfileScope()).toBe("all");
    expect(writeSidebarProfileScope("active")).toBe("active");
    expect(readSidebarProfileScope()).toBe("active");
  });

  it("列出数据里出现过的画像，按名字排序并去重", () => {
    const sessions = [
      { id: "1", profile: "beta" },
      { id: "2", profile: "alpha" },
      { id: "3", profile: "beta" },
      { id: "4", profile: undefined },
    ];

    expect(distinctSessionProfiles(sessions, (session) => session.profile)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("needs-input 计数按画像拆分", () => {
    const sessions = [
      { id: "1", profile: "alpha", state: "needs-input" as const },
      { id: "2", profile: "alpha", state: "idle" as const },
      { id: "3", profile: "beta", state: "needs-input" as const },
      { id: "4", profile: "beta", state: "needs-input" as const },
      { id: "5", profile: undefined, state: "needs-input" as const },
    ];

    expect(
      needsInputCountsByProfile(
        sessions,
        (session) => session.profile,
        (session) => session.state,
      ),
    ).toEqual({ alpha: 1, beta: 2 });
  });
});
