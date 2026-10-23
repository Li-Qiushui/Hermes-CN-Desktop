import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeWorkspacePath,
  readPinnedWorkspaceProjectPaths,
  mirrorSessionWorkspaceMapping,
  readSessionWorkspaceMap,
  readWorkspaceProjects,
  rememberSessionWorkspace,
  rememberWorkspaceProject,
  removeWorkspaceProject,
  resolveSessionWorkspace,
  togglePinnedWorkspaceProject,
  unpinWorkspaceProjects,
  writePinnedWorkspaceProjectPaths,
  workspaceNameFromPath,
  workspaceStorageScope,
  buildSessionWorkspaceOptions,
  filterSessionsByWorkspace,
  newSessionHrefForWorkspace,
  sessionWorkspacePath,
} from "./workspaces";
import { rememberSessionMapping } from "./session-map";
import { __resetUiStoreForTests, writeUiValue } from "./ui-store";

describe("workspace persistence helpers", () => {
  beforeEach(() => {
    __resetUiStoreForTests();
    vi.stubGlobal("window", {
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  it("normalizes paths and derives project names", () => {
    expect(normalizeWorkspacePath(" /Users/claw/Project/ ")).toBe("/Users/claw/Project");
    expect(workspaceNameFromPath("/Users/claw/Project")).toBe("Project");
  });


  it("ignores malformed persisted workspace values from older builds", () => {
    __resetUiStoreForTests({
      "hermes-cn-ui.workspaceProjects": [
        { path: ["/Users/claw/OldA", "/Users/claw/OldB"], name: { label: "old" } },
        { path: "/Users/claw/Project", name: 42, createdAt: "bad", updatedAt: null },
      ],
      "hermes-cn-ui.sessionWorkspaces": {
        "session-1": ["/Users/claw/OldA"],
        "session-2": "/Users/claw/Project",
      },
    });

    expect(normalizeWorkspacePath(["/Users/claw/OldA"])).toBe("");
    expect(readWorkspaceProjects()).toEqual([
      expect.objectContaining({
        path: "/Users/claw/Project",
        name: "Project",
      }),
    ]);
    expect(readSessionWorkspaceMap()).toEqual({
      "session-2": "/Users/claw/Project",
    });
  });

  it("resolveSessionWorkspace prefers the backend cwd over the client map", () => {
    __resetUiStoreForTests({
      "hermes-cn-ui.sessionWorkspaces": { "sess-1": "/Users/claw/from-map" },
    });

    // Backend cwd wins, and is normalized (trailing slash stripped).
    expect(resolveSessionWorkspace("/Users/claw/from-backend/", ["sess-1"])).toBe(
      "/Users/claw/from-backend",
    );
  });

  it("resolveSessionWorkspace falls back to the client map when backend cwd is blank", () => {
    __resetUiStoreForTests({
      "hermes-cn-ui.sessionWorkspaces": { "sess-1": "/Users/claw/from-map" },
    });

    expect(resolveSessionWorkspace(null, ["sess-1"])).toBe("/Users/claw/from-map");
    expect(resolveSessionWorkspace(undefined, ["sess-1"])).toBe("/Users/claw/from-map");
    expect(resolveSessionWorkspace("   ", ["sess-1"])).toBe("/Users/claw/from-map");
  });

  it("resolveSessionWorkspace checks each provided id in order and skips blanks", () => {
    __resetUiStoreForTests({
      "hermes-cn-ui.sessionWorkspaces": { "persistent-id": "/Users/claw/proj" },
    });

    expect(
      resolveSessionWorkspace(null, [null, "  ", "gateway-id", "persistent-id"]),
    ).toBe("/Users/claw/proj");
  });

  it("resolveSessionWorkspace returns empty string when no workspace is known", () => {
    __resetUiStoreForTests();

    expect(resolveSessionWorkspace(null, ["unknown", null])).toBe("");
    expect(resolveSessionWorkspace("", [])).toBe("");
  });

  it("stores workspace projects without duplicating equivalent paths", () => {
    rememberWorkspaceProject("/Users/claw/Project/");
    rememberWorkspaceProject("/Users/claw/Project", "Renamed");

    expect(readWorkspaceProjects()).toEqual([
      expect.objectContaining({
        path: "/Users/claw/Project",
        name: "Renamed",
      }),
    ]);
  });

  it("stores pinned workspace projects without duplicating equivalent paths", () => {
    writePinnedWorkspaceProjectPaths([
      "",
      "/Users/claw/Project/",
      "/Users/claw/Project",
      "/Users/claw/Other",
    ]);

    expect(Array.from(readPinnedWorkspaceProjectPaths())).toEqual([
      "/Users/claw/Project",
      "/Users/claw/Other",
    ]);
  });

  it("toggles and unpins workspace projects", () => {
    expect(Array.from(togglePinnedWorkspaceProject(" /Users/claw/Project/ "))).toEqual([
      "/Users/claw/Project",
    ]);
    expect(Array.from(togglePinnedWorkspaceProject("/Users/claw/Project"))).toEqual([]);

    writePinnedWorkspaceProjectPaths([
      "/Users/claw/Project",
      "/Users/claw/Other",
      "/Users/claw/Third",
    ]);

    expect(Array.from(unpinWorkspaceProjects(["/Users/claw/Other/"]))).toEqual([
      "/Users/claw/Project",
      "/Users/claw/Third",
    ]);
  });

  it("links sessions to workspaces and registers the project", () => {
    rememberSessionWorkspace("session-1", "/Users/claw/Project");

    expect(readSessionWorkspaceMap()).toEqual({
      "session-1": "/Users/claw/Project",
    });
    expect(readWorkspaceProjects()[0]).toMatchObject({
      path: "/Users/claw/Project",
      name: "Project",
    });
  });

  it("resolves workspace links across gateway and persistent session ids", () => {
    rememberSessionMapping("gw-1", "20260426_000000_abcd");
    rememberSessionWorkspace("gw-1", "/Users/claw/Project");

    expect(readSessionWorkspaceMap()).toEqual({
      "gw-1": "/Users/claw/Project",
      "20260426_000000_abcd": "/Users/claw/Project",
    });
  });

  it("keeps historical workspace links after session id mappings become stale", () => {
    writeUiValue("hermes:gateway-session-map", {
      "gw-old": {
        persistentId: "20260426_000000_abcd",
        ts: Date.now() - 25 * 60 * 60 * 1000,
      },
    });
    rememberSessionWorkspace("gw-old", "/Users/claw/Project");

    expect(readSessionWorkspaceMap()).toEqual({
      "gw-old": "/Users/claw/Project",
      "20260426_000000_abcd": "/Users/claw/Project",
    });
  });

  it("mirrors an existing gateway workspace when the persistent id becomes known", () => {
    rememberSessionWorkspace("gw-1", "/Users/claw/Project");
    mirrorSessionWorkspaceMapping("gw-1", "20260426_000000_abcd");

    expect(readSessionWorkspaceMap()).toEqual({
      "gw-1": "/Users/claw/Project",
      "20260426_000000_abcd": "/Users/claw/Project",
    });
  });

  it("removes a workspace project and unlinks its sessions", () => {
    rememberSessionWorkspace("session-1", "/Users/claw/Project");
    rememberSessionWorkspace("session-2", "/Users/claw/Other");
    writePinnedWorkspaceProjectPaths(["/Users/claw/Project", "/Users/claw/Other"]);

    removeWorkspaceProject("/Users/claw/Project/");

    expect(readWorkspaceProjects()).toEqual([
      expect.objectContaining({ path: "/Users/claw/Other" }),
    ]);
    expect(readSessionWorkspaceMap()).toEqual({
      "session-2": "/Users/claw/Other",
    });
    expect(Array.from(readPinnedWorkspaceProjectPaths())).toEqual(["/Users/claw/Other"]);
  });

  it("isolates remote project and workspace records by target address", () => {
    (window as any).__HERMES_RUNTIME__ = {
      connectionMode: "remote",
      dashboardApiBaseUrl: "https://one.example/hermes",
    };
    expect(workspaceStorageScope()).toContain("one.example");
    rememberWorkspaceProject("/srv/one");
    expect(readWorkspaceProjects()).toHaveLength(1);

    (window as any).__HERMES_RUNTIME__.dashboardApiBaseUrl = "https://two.example/hermes";
    expect(readWorkspaceProjects()).toEqual([]);
    rememberWorkspaceProject("/srv/two");
    expect(readWorkspaceProjects()[0]?.path).toBe("/srv/two");

    (window as any).__HERMES_RUNTIME__.dashboardApiBaseUrl = "https://one.example/hermes";
    expect(readWorkspaceProjects()[0]?.path).toBe("/srv/one");
  });
});

describe("会话工作区归属", () => {
  const sessions = [
    { id: "s1", cwd: "/repo/a" },
    { id: "s2", cwd: "/repo/a/sub" },
    { id: "s3", cwd: null },
    { id: "s4", cwd: "/repo/b/" },
    { id: "s5", cwd: "" },
  ];
  const sessionMap = { s3: "/repo/mapped", s5: "/repo/a" };

  it("后端 cwd 优先，缺失时才用本地映射", () => {
    expect(sessionWorkspacePath(sessions[0], sessionMap)).toBe("/repo/a");
    expect(sessionWorkspacePath(sessions[2], sessionMap)).toBe("/repo/mapped");
    expect(sessionWorkspacePath({ id: "nope", cwd: null }, {})).toBe("");
  });

  it("汇总出工作区选项并按会话数排序", () => {
    const options = buildSessionWorkspaceOptions(sessions, sessionMap);

    expect(options.map((option) => [option.name, option.count])).toEqual([
      ["a", 3],
      ["b", 1],
      ["mapped", 1],
    ]);
  });

  it("筛选包含子目录下的会话，空目标返回全部", () => {
    expect(filterSessionsByWorkspace(sessions, sessionMap, "/repo/a").map((s) => s.id)).toEqual([
      "s1",
      "s2",
      "s5",
    ]);
    expect(filterSessionsByWorkspace(sessions, sessionMap, "/repo/b").map((s) => s.id)).toEqual([
      "s4",
    ]);
    expect(filterSessionsByWorkspace(sessions, sessionMap, "")).toHaveLength(sessions.length);
  });

  it("新建会话链接带上工作区参数", () => {
    expect(newSessionHrefForWorkspace("/repo/a/")).toBe("/?workspace=%2Frepo%2Fa");
    expect(newSessionHrefForWorkspace("")).toBe("/");
  });
});
