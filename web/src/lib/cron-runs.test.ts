import { describe, expect, it } from "vitest";
import {
  PENDING_RUN_TIMEOUT_MS,
  backendErrorMessage,
  formatElapsed,
  parseCronRunSessions,
  pendingRunElapsedSeconds,
  pendingRunExpired,
  pendingRunSettled,
  runStartedMs,
  sessionIdForRun,
} from "./cron-runs";

const START = Date.parse("2026-10-23T09:00:00+08:00");

describe("运行会话反解", () => {
  it("解析内核 /api/cron/jobs/{id}/runs 的 session 行", () => {
    const rows = parseCronRunSessions({
      runs: [
        { id: "cron_job1_20261023_090000", title: "巡检", source: "cron", started_at: 1761181200, last_active: 1761181500, ended_at: 1761181600 },
        { id: "cron_output:job1:2026-10-22_09-00-00", title: "脚本", started_at: 1761094800 },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: "cron_job1_20261023_090000",
      title: "巡检",
      source: "cron",
      startedAtMs: 1761181200000,
      lastActiveMs: 1761181500000,
      endedAtMs: 1761181600000,
    });
  });

  it("后端结构不认识时返回空数组", () => {
    expect(parseCronRunSessions(null)).toEqual([]);
    expect(parseCronRunSessions({ runs: "x" })).toEqual([]);
    expect(parseCronRunSessions({ runs: [{ id: "" }, null] })).toEqual([]);
  });

  it("输出文档时间戳落在会话区间内才算同一次运行", () => {
    const sessions = parseCronRunSessions({
      runs: [{ id: "cron_job1_20261023_090000", source: "cron", started_at: START / 1000, last_active: START / 1000 + 400 }],
    });
    expect(sessionIdForRun(START + 30_000, sessions)).toBe("cron_job1_20261023_090000");
    expect(sessionIdForRun(START + 60 * 60_000, sessions)).toBeNull();
    expect(sessionIdForRun(null, sessions)).toBeNull();
  });

  it("非 cron 来源的会话不参与匹配", () => {
    const sessions = parseCronRunSessions({
      runs: [{ id: "local-abc", source: "chat", started_at: START / 1000 }],
    });
    expect(sessionIdForRun(START, sessions)).toBeNull();
  });

  it("run.started_at 兼容 ISO 与秒级时间戳", () => {
    expect(runStartedMs({ started_at: "2026-10-23T09:00:00+08:00" })).toBe(START);
    expect(runStartedMs({ started_at: "1761181200" })).toBe(1761181200000);
    expect(runStartedMs({ started_at: "不是时间" })).toBeNull();
    expect(runStartedMs(null)).toBeNull();
  });
});

describe("排队中伪行", () => {
  it("上限 90 秒", () => {
    expect(PENDING_RUN_TIMEOUT_MS).toBe(90_000);
    expect(pendingRunExpired(START, START + 89_000)).toBe(false);
    expect(pendingRunExpired(START, START + 90_000)).toBe(true);
  });

  it("已等待秒数与展示文案", () => {
    expect(pendingRunElapsedSeconds(START, START + 12_400)).toBe(12);
    expect(pendingRunElapsedSeconds(START, START - 5_000)).toBe(0);
    expect(formatElapsed(9)).toBe("9 秒");
    expect(formatElapsed(60)).toBe("1 分");
    expect(formatElapsed(95)).toBe("1 分 35 秒");
  });

  it("出现新 run 就算落地，旧 run 不会误判", () => {
    const requestedAt = START;
    expect(pendingRunSettled([{ started_at: new Date(START + 1_000).toISOString() }], requestedAt)).toBe(true);
    expect(pendingRunSettled([{ started_at: new Date(START - 60_000).toISOString() }], requestedAt)).toBe(false);
    expect(pendingRunSettled([], requestedAt)).toBe(false);
  });

  it("时钟略早的 run 也在容差内", () => {
    const requestedAt = START;
    expect(pendingRunSettled([{ started_at: new Date(START - 1_500).toISOString() }], requestedAt)).toBe(true);
    expect(pendingRunSettled([{ started_at: new Date(START - 5_000).toISOString() }], requestedAt)).toBe(false);
  });
});

describe("后端错误原文", () => {
  it("拆出 detail 原文", () => {
    expect(backendErrorMessage(new Error('HTTP 400: {"detail":"schedule 无法解析"}')))
      .toBe("schedule 无法解析");
    expect(backendErrorMessage(new Error('HTTP 409: {"message":"任务正在运行"}')))
      .toBe("任务正在运行");
  });

  it("FastAPI 校验错误数组拼起来", () => {
    expect(
      backendErrorMessage(new Error('HTTP 422: {"detail":[{"msg":"field required"},{"msg":"bad value"}]}')),
    ).toBe("field required；bad value");
  });

  it("不是 JSON 就原样返回，空错误给兜底文案", () => {
    expect(backendErrorMessage(new Error("网络断了"))).toBe("网络断了");
    expect(backendErrorMessage(new Error(""))).toBe("后端没有返回错误信息");
    expect(backendErrorMessage("纯字符串错误")).toBe("纯字符串错误");
  });
});
