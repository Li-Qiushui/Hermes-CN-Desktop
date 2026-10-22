import { describe, expect, it } from "vitest";
import {
  buildActivityFeed,
  buildBulkPatch,
  blockedBadgeLabel,
  cardSummaryLine,
  formatRunClock,
  kanbanEventsUrl,
  nextReconnectDelayMs,
  parseKanbanEventFrame,
  progressLabel,
  projectBoardCards,
  retainSelectableTasks,
  runClockStartSeconds,
  tailLogLines,
  toggleTaskSelection,
  taskMatchesQuery,
  type KanbanBoardResponse,
  type KanbanTask,
} from "./kanban";

function task(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return { id: "t_1", title: "任务", status: "todo", ...overrides };
}

describe("formatRunClock", () => {
  it("从 current_run_started_at 起算，秒级刷新", () => {
    const start = 1_700_000_000;
    expect(formatRunClock(start, start * 1000)).toBe("00:00");
    expect(formatRunClock(start, start * 1000 + 64_000)).toBe("01:04");
    expect(formatRunClock(start, start * 1000 + 3_600_000 + 61_000)).toBe("1:01:01");
  });

  it("缺值时返回占位符", () => {
    expect(formatRunClock(null, Date.now())).toBe("—");
    expect(formatRunClock(undefined, Date.now())).toBe("—");
    expect(formatRunClock(0, Date.now())).toBe("—");
  });

  it("只看 current_run_started_at，不回退到 started_at", () => {
    expect(runClockStartSeconds(task({ status: "running", started_at: 500 }))).toBeNull();
    expect(runClockStartSeconds(task({ status: "running", current_run_started_at: 900 }))).toBe(900);
  });
});

describe("卡片字段投影", () => {
  it("summary 折叠成一行并截断", () => {
    expect(cardSummaryLine(task({ latest_summary: "第一行\n\n第二行   结束" }))).toBe("第一行 第二行 结束");
    expect(cardSummaryLine(task({ latest_summary: null }))).toBe("");
    const long = "字".repeat(120);
    expect(cardSummaryLine(task({ latest_summary: long })).length).toBe(97);
  });

  it("progress 与 blocked 角标", () => {
    expect(progressLabel({ done: 2, total: 5 })).toBe("2/5");
    expect(progressLabel({ done: 0, total: 0 })).toBeNull();
    expect(progressLabel(null)).toBeNull();
    expect(blockedBadgeLabel(task({ status: "blocked", block_reason: "等待审批" }))).toBe("等待审批");
    expect(blockedBadgeLabel(task({ status: "blocked", block_kind: "dependency" }))).toBe("dependency");
    expect(blockedBadgeLabel(task({ status: "blocked" }))).toBe("阻塞中");
    expect(blockedBadgeLabel(task({ status: "todo" }))).toBeNull();
    expect(blockedBadgeLabel(task({ status: "done", block_kind: "dependency" }))).toBeNull();
  });

  it("搜索覆盖标题、最新进展与正文", () => {
    const item = task({ title: "看板卡片", latest_summary: "已接上事件流", body: null });
    expect(taskMatchesQuery(item, "看板")).toBe(true);
    expect(taskMatchesQuery(item, "事件流")).toBe(true);
    expect(taskMatchesQuery(item, "不存在")).toBe(false);
    expect(taskMatchesQuery(task({ title: "x", body: "正文关键字" }), "关键字")).toBe(true);
  });
});

describe("事件流工具", () => {
  it("构造握手 URL：board + since + token，http 升级成 ws", () => {
    const url = new URL(
      kanbanEventsUrl({ board: "default", since: 42, token: "abc", origin: "http://localhost:54120" }),
    );
    expect(url.protocol).toBe("ws:");
    expect(url.pathname).toBe("/api/plugins/kanban/events");
    expect(url.searchParams.get("board")).toBe("default");
    expect(url.searchParams.get("since")).toBe("42");
    expect(url.searchParams.get("token")).toBe("abc");
  });

  it("没有 cursor 时不带 since，https 升级成 wss", () => {
    const url = new URL(kanbanEventsUrl({ board: "b1", origin: "https://example.com" }));
    expect(url.protocol).toBe("wss:");
    expect(url.searchParams.get("since")).toBeNull();
    expect(url.searchParams.get("board")).toBe("b1");
  });

  it("远程带路径前缀时原样保留，只把协议换成 ws/wss", () => {
    const url = new URL(
      kanbanEventsUrl({
        board: "default",
        endpoint: "https://gw.example.com/hermes/api/plugins/kanban/events",
      }),
    );
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("gw.example.com");
    expect(url.pathname).toBe("/hermes/api/plugins/kanban/events");
    expect(url.searchParams.get("board")).toBe("default");
  });

  it("解析帧：去重 task_id 并推进 cursor", () => {
    const frame = parseKanbanEventFrame(
      JSON.stringify({
        cursor: 12,
        events: [
          { id: 10, task_id: "t_a", kind: "status" },
          { id: 11, task_id: "t_a", kind: "comment" },
          { id: 12, task_id: "t_b", kind: "run" },
        ],
      }),
    );
    expect(frame).toEqual({ cursor: 12, taskIds: ["t_a", "t_b"], eventCount: 3 });
  });

  it("坏帧返回 null 而不是抛错", () => {
    expect(parseKanbanEventFrame("not json")).toBeNull();
    expect(parseKanbanEventFrame(JSON.stringify({ cursor: 3 }))).toBeNull();
    expect(parseKanbanEventFrame(null)).toBeNull();
  });

  it("退避 1/2/4/8/16/30s 封顶", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((attempt) => nextReconnectDelayMs(attempt))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });
});

describe("列表投影", () => {
  it("把 body 从卡片上剔除并记住长度", () => {
    const board: KanbanBoardResponse = {
      columns: [
        { name: "todo", tasks: [task({ id: "t_1", body: "正文".repeat(10) }), task({ id: "t_2", body: null })] },
      ],
      latest_event_id: 7,
    };
    const projected = projectBoardCards(board);
    expect(projected.columns[0].tasks[0].body).toBeNull();
    expect(projected.columns[0].tasks[0].body_chars).toBe(20);
    expect(projected.columns[0].tasks[1].body).toBeNull();
    expect(projected.latest_event_id).toBe(7);
    expect(projected).not.toBe(board);
    expect(board.columns[0].tasks[0].body).toBe("正文".repeat(10));
  });

  it("没有 body 时原样返回同一引用", () => {
    const board: KanbanBoardResponse = { columns: [{ name: "todo", tasks: [task()] }] };
    expect(projectBoardCards(board)).toBe(board);
  });
});

describe("批量选择", () => {
  it("toggle 增删且保序", () => {
    expect(toggleTaskSelection([], "a")).toEqual(["a"]);
    expect(toggleTaskSelection(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleTaskSelection(["a", "b"], "a")).toEqual(["b"]);
  });

  it("board 刷新后丢弃已不存在的任务", () => {
    const board: KanbanBoardResponse = { columns: [{ name: "todo", tasks: [task({ id: "a" })] }] };
    expect(retainSelectableTasks(["a", "gone"], board)).toEqual(["a"]);
    expect(retainSelectableTasks(["a"], undefined)).toEqual([]);
  });

  it("bulk patch 只带有效字段", () => {
    expect(buildBulkPatch({ status: " ready " })).toEqual({ status: "ready" });
    expect(buildBulkPatch({ priority: 2 })).toEqual({ priority: 2 });
    expect(buildBulkPatch({ archive: true })).toEqual({ archive: true });
    expect(buildBulkPatch({ status: "  ", priority: Number.NaN })).toEqual({});
  });
});

describe("抽屉活动与日志", () => {
  it("事件与运行合并后按时间倒序", () => {
    const feed = buildActivityFeed(
      [
        { id: 1, task_id: "t", kind: "created", created_at: 100, payload: { status: "ready" } },
        { id: 2, task_id: "t", kind: "comment", created_at: 300 },
      ],
      [{ id: 9, task_id: "t", status: "done", outcome: "completed", started_at: 200, summary: "跑完了" }],
    );
    expect(feed.map((item) => item.key)).toEqual(["event-2", "run-9", "event-1"]);
    expect(feed[1].label).toBe("运行 #9 · completed");
    expect(feed[1].detail).toBe("跑完了");
    expect(feed[2].detail).toBe("ready");
    expect(feed[0].detail).toBeNull();
  });

  it("日志尾超过 200 行只保留末尾", () => {
    const content = Array.from({ length: 250 }, (_, index) => `line-${index}`).join("\n");
    const tail = tailLogLines(content);
    expect(tail.hiddenLines).toBe(50);
    expect(tail.text.startsWith("line-50\n")).toBe(true);
    expect(tail.text.endsWith("line-249")).toBe(true);
    expect(tailLogLines("").hiddenLines).toBe(0);
    expect(tailLogLines(null).text).toBe("");
  });
});
