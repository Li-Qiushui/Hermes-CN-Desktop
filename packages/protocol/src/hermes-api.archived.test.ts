import { describe, expect, it } from "vitest";
import { SessionDetail, SessionSummary, SearchResponse } from "./hermes-api";
import summaryFixture from "./fixtures/session-summary.json";

/**
 * 回归：内核不同端点的布尔字段编码不一致。
 * - GET /api/sessions        → archived: false（布尔）
 * - GET /api/sessions/{id}   → archived: 0（SQLite 整数）
 * 后者曾让 SessionDetail 解析失败，前端表现为「删除失败：
 * expected boolean, received number, path ["archived"]」。
 */
describe("SessionSummary.archived 容忍 0/1", () => {
  it("列表返回布尔时解析通过", () => {
    const parsed = SessionSummary.parse(summaryFixture);
    expect(parsed.archived).toBe(false);
  });

  it("详情返回 0/1 时归一成布尔", () => {
    expect(SessionSummary.parse({ ...summaryFixture, archived: 0 }).archived).toBe(false);
    expect(SessionSummary.parse({ ...summaryFixture, archived: 1 }).archived).toBe(true);
  });

  it("SessionDetail 能解析带整数 archived 的详情响应", () => {
    const parsed = SessionDetail.parse({
      ...summaryFixture,
      archived: 0,
      last_active: 1761180000,
      messages: [],
    });
    expect(parsed.archived).toBe(false);
  });

  it("搜索结果里的 archived 同样容忍 0/1", () => {
    const parsed = SearchResponse.parse({
      results: [
        {
          session_id: (summaryFixture as { id: string }).id,
          snippet: "命中片段",
          role: null,
          source: null,
          model: null,
          session_started: null,
          archived: 1,
        },
      ],
    });
    expect(parsed.results[0]?.archived).toBe(true);
  });

  it("archived 缺省时不报错", () => {
    const { archived: _omit, ...withoutArchived } = summaryFixture as Record<string, unknown>;
    expect(SessionSummary.parse(withoutArchived).archived).toBeUndefined();
  });
});
