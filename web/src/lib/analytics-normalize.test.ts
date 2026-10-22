import { describe, expect, it } from "vitest";
import { normalizeAnalyticsPayload } from "./analytics-normalize";

// 0.22.x 内核真实响应的裁剪样本：没有 comparison / top_sessions，
// by_model 缺 provider / reasoning，daily 缺 cache_write。
const kernelPayload = {
  daily: [
    {
      day: "2026-10-20",
      input_tokens: 1577245,
      output_tokens: 485997,
      cache_read_tokens: 93748898,
      reasoning_tokens: 194102,
      estimated_cost: 0,
      actual_cost: 0,
      sessions: 23,
      api_calls: 1002,
    },
  ],
  by_model: [
    { model: "deepseek-v4.1-flash", input_tokens: 10, output_tokens: 5, estimated_cost: 0, sessions: 2, api_calls: 30 },
  ],
  by_task: [{ task: "default", api_calls: 3 }],
  totals: {
    total_input: 100,
    total_output: 40,
    total_cache_read: 900,
    total_reasoning: 10,
    total_estimated_cost: 0,
    total_actual_cost: 0,
    total_sessions: 2,
    total_api_calls: 12,
  },
  period_days: 30,
  skills: { summary: { total_skill_loads: 42, total_skill_edits: 0, total_skill_actions: 42, distinct_skills_used: 19 }, top_skills: [] },
  tools: [{ tool: "terminal", count: 3, percentage: 50 }],
};

describe("normalizeAnalyticsPayload", () => {
  it("补全 0.22.x 内核缺的字段而不是报合约不匹配", () => {
    const data = normalizeAnalyticsPayload(kernelPayload);
    expect(data.top_sessions).toEqual([]);
    expect(data.comparison.previous_totals.total_tokens).toBe(0);
    expect(data.daily[0].cache_write_tokens).toBe(0);
    expect(data.by_model[0].provider).toBe("");
    expect(data.by_model[0].reasoning_tokens).toBe(0);
    expect(data.period_days).toBe(30);
  });

  it("total_tokens 缺失时按 input+output 求和", () => {
    const data = normalizeAnalyticsPayload(kernelPayload);
    expect(data.totals.total_tokens).toBe(100 + 40);
    expect(data.totals.avg_tokens_per_session).toBeCloseTo(140 / 2);
  });

  it("空响应也能通过协议校验", () => {
    const data = normalizeAnalyticsPayload({});
    expect(data.totals.total_tokens).toBe(0);
    expect(data.daily).toEqual([]);
    expect(data.skills.top_skills).toEqual([]);
  });

  it("完整响应原样保留 top_sessions 与对比周期", () => {
    const full = {
      ...kernelPayload,
      totals: { ...kernelPayload.totals, total_tokens: 140 },
      top_sessions: [
        {
          session_id: "abc",
          title: "巡检",
          model: "m",
          provider: "p",
          started_at: 1,
          ended_at: null,
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: 1,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          api_calls: 2,
        },
      ],
      comparison: { previous_totals: { ...kernelPayload.totals, total_tokens: 70 } },
    };
    const data = normalizeAnalyticsPayload(full);
    expect(data.totals.total_tokens).toBe(140);
    expect(data.top_sessions).toHaveLength(1);
    expect(data.comparison.previous_totals.total_tokens).toBe(70);
  });
});
