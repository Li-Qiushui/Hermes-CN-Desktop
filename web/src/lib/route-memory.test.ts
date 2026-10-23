import { beforeEach, describe, expect, it } from "vitest";
import {
  LAST_ROUTE_STORAGE_KEY,
  clearLastRoute,
  defaultNewSessionHref,
  isRestorableRoute,
  readLastRoute,
  rememberLastRoute,
  resolveRestoreTarget,
  sessionIdFromRoute,
  shouldValidateRestoredSession,
} from "./route-memory";
import { __resetUiStoreForTests, readUiValue } from "./ui-store";

beforeEach(() => {
  __resetUiStoreForTests();
});

describe("启动恢复上次位置", () => {
  it("记住会话路由与页面路由，跳过的瞬态路由不记", () => {
    rememberLastRoute("/tasks/sess-1");
    expect(readLastRoute()).toBe("/tasks/sess-1");

    rememberLastRoute("/history");
    expect(readLastRoute()).toBe("/history");

    rememberLastRoute("/");
    rememberLastRoute("/new");
    rememberLastRoute("/guide");
    expect(readLastRoute()).toBe("/history");
  });

  it("写入 ui-store 的键名固定，便于跨版本读回", () => {
    rememberLastRoute("/analytics");
    expect(readUiValue(LAST_ROUTE_STORAGE_KEY, null)).toBe("/analytics");
    clearLastRoute();
    expect(readLastRoute()).toBeNull();
  });

  it("会话 id 从 /tasks/:id 解出来", () => {
    expect(sessionIdFromRoute("/tasks/abc")).toBe("abc");
    expect(sessionIdFromRoute("/tasks/a%2Fb")).toBe("a/b");
    expect(sessionIdFromRoute("/history")).toBeNull();
    expect(isRestorableRoute("/")).toBe(false);
  });

  it("不在首页时不抢路由", () => {
    expect(resolveRestoreTarget({ stored: "/tasks/s1", currentPathname: "/history" })).toBeNull();
  });

  it("会话还在就回会话，删了就回首页", () => {
    expect(
      resolveRestoreTarget({ stored: "/tasks/s1", currentPathname: "/", sessionExists: true }),
    ).toBe("/tasks/s1");
    expect(
      resolveRestoreTarget({ stored: "/tasks/s1", currentPathname: "/", sessionExists: false }),
    ).toBeNull();
    expect(
      resolveRestoreTarget({ stored: "/tasks/s1", currentPathname: "/", sessionExists: null }),
    ).toBeNull();
  });

  it("普通页面路由不需要校验会话", () => {
    expect(resolveRestoreTarget({ stored: "/models", currentPathname: "/" })).toBe("/models");
    expect(shouldValidateRestoredSession("/models", "/")).toBeNull();
    expect(shouldValidateRestoredSession("/tasks/s9", "/")).toBe("s9");
  });
});

describe("新建会话默认工作区", () => {
  it("首页且没有 workspace 参数时补上上次的 cwd", () => {
    expect(defaultNewSessionHref("/", "", "/repo/demo")).toBe("/?workspace=%2Frepo%2Fdemo");
    expect(defaultNewSessionHref("/", "?workspace=%2Frepo%2Fother", "/repo/demo")).toBeNull();
    expect(defaultNewSessionHref("/", "", "  ")).toBeNull();
    expect(defaultNewSessionHref("/history", "", "/repo/demo")).toBeNull();
  });
});
