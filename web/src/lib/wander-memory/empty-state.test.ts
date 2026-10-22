import { describe, expect, it } from "vitest";
import {
  isWanderMemoryOffline,
  wanderMemoryListPhase,
} from "./empty-state";

describe("isWanderMemoryOffline", () => {
  it("只有 network_failure 视为未连接", () => {
    expect(isWanderMemoryOffline({ code: "network_failure" })).toBe(true);
    expect(isWanderMemoryOffline({ code: "internal" })).toBe(false);
    expect(isWanderMemoryOffline(null)).toBe(false);
    expect(isWanderMemoryOffline(undefined)).toBe(false);
  });
});

describe("wanderMemoryListPhase", () => {
  it("后端未连接优先于空结果", () => {
    expect(wanderMemoryListPhase({ offline: true, hasError: false, resultCount: 0 })).toBe("offline");
    expect(wanderMemoryListPhase({ offline: true, hasError: true, resultCount: 5 })).toBe("offline");
  });

  it("请求失败与真的没有数据分开", () => {
    expect(wanderMemoryListPhase({ offline: false, hasError: true, resultCount: 0 })).toBe("failed");
    expect(wanderMemoryListPhase({ offline: false, hasError: false, resultCount: 0 })).toBe("empty");
  });

  it("有结果时正常展示列表", () => {
    expect(wanderMemoryListPhase({ offline: false, hasError: false, resultCount: 3 })).toBe("results");
  });
});
