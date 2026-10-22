import { describe, expect, it } from "vitest";
import {
  ALL_ASSIGNEES,
  ALL_PRIORITIES,
  DONE_PREVIEW_LIMIT,
  allowedDropTargets,
  allowedStatusOptions,
  applyOverrides,
  applyTaskStatus,
  buildColumnViews,
  buildStatusPatch,
  buildTaskUpdatePatch,
  canDropTask,
  collectAssigneeNames,
  collectWorkspaceOptions,
  deleteTasksSequentially,
  columnCollapseStorageKey,
  dragTargetKeys,
  filterTasks,
  findTask,
  hasActiveFilters,
  humanizeAge,
  kanbanColumnLabel,
  kanbanEventKindLabel,
  manualTransitions,
  parseCollapseMarks,
  priorityLabel,
  projectColumnViews,
  resolveColumnCollapse,
  serializeCollapseMarks,
  setCollapseMark,
  sortDoneTasks,
  taskMatchesQuery,
  type KanbanBoardColumn,
  type KanbanBoardResponse,
  type KanbanTask,
  type KanbanWorkflowColumn,
} from "./kanban";

const WORKFLOW: KanbanWorkflowColumn[] = [
  { key: "triage", label: "Triage", drag_target: true },
  { key: "todo", label: "Todo", drag_target: true },
  { key: "scheduled", label: "Scheduled", drag_target: false },
  { key: "ready", label: "Ready", drag_target: true },
  { key: "running", label: "Running", drag_target: false },
  { key: "blocked", label: "Blocked", drag_target: true },
  { key: "review", label: "Review", drag_target: false },
  { key: "done", label: "Done", drag_target: true },
];

function task(overrides: Partial<KanbanTask> & { id: string }): KanbanTask {
  return {
    title: `任务 ${overrides.id}`,
    status: "todo",
    assignee: "default",
    priority: 0,
    created_at: 1_700_000_000,
    completed_at: null,
    comment_count: 0,
    link_counts: { parents: 0, children: 0 },
    age: { created_age_seconds: 120 },
    ...overrides,
  };
}

function boardOf(groups: Record<string, KanbanTask[]>): KanbanBoardColumn[] {
  return Object.entries(groups).map(([name, tasks]) => ({ name, tasks }));
}

describe("humanizeAge", () => {
  it("把秒数换成中文停留时长", () => {
    expect(humanizeAge(180)).toBe("3 分钟");
    expect(humanizeAge(7200)).toBe("2 小时");
    expect(humanizeAge(259200)).toBe("3 天");
    expect(humanizeAge(5)).toBe("刚刚");
  });

  it("空值与非法值给占位符", () => {
    expect(humanizeAge(null)).toBe("—");
    expect(humanizeAge(undefined)).toBe("—");
    expect(humanizeAge(-1)).toBe("—");
    expect(humanizeAge(Number.NaN)).toBe("—");
  });
});

describe("buildColumnViews 列分组", () => {
  it("按 workflow 顺序输出 8 列，计数取过滤后的数量", () => {
    const columns = boardOf({
      triage: [],
      todo: [task({ id: "a" }), task({ id: "b" })],
      ready: [task({ id: "c", status: "ready" })],
      done: [task({ id: "d", status: "done", completed_at: 10 })],
    });
    const views = buildColumnViews(WORKFLOW, columns, { showDone: true });
    expect(views.map((view) => view.key)).toEqual(WORKFLOW.map((column) => column.key));
    expect(views.find((view) => view.key === "todo")?.total).toBe(2);
    expect(views.find((view) => view.key === "ready")?.total).toBe(1);
    expect(views.find((view) => view.key === "done")?.total).toBe(1);
    expect(views.find((view) => view.key === "scheduled")?.tasks).toEqual([]);
  });

  it("忽略 board 里 workflow 没有的列（如 archived）", () => {
    const columns = boardOf({ archived: [task({ id: "x", status: "archived" })], todo: [] });
    const views = buildColumnViews(WORKFLOW, columns, {});
    expect(views.some((view) => view.key === "archived")).toBe(false);
  });
});

describe("done 列折叠与分页", () => {
  const doneTasks = Array.from({ length: 213 }, (_, index) =>
    task({
      id: `t_${index}`,
      status: "done",
      completed_at: 1_700_000_000 + index,
      created_at: 1_600_000_000 + index,
    }),
  );

  it("显示已完成关闭时整列折叠并给总数", () => {
    const views = buildColumnViews(WORKFLOW, boardOf({ done: doneTasks }), { showDone: false });
    const done = views.find((view) => view.key === "done");
    expect(done?.collapsed).toBe(true);
    expect(done?.tasks).toHaveLength(0);
    expect(done?.total).toBe(213);
    expect(done?.hiddenCount).toBe(213);
  });

  it("展开后只渲染最近 10 条，并给出剩余数量", () => {
    const views = buildColumnViews(WORKFLOW, boardOf({ done: doneTasks }), {
      showDone: true,
      doneExpanded: false,
    });
    const done = views.find((view) => view.key === "done");
    expect(done?.collapsed).toBe(false);
    expect(done?.tasks).toHaveLength(DONE_PREVIEW_LIMIT);
    expect(done?.hiddenCount).toBe(213 - DONE_PREVIEW_LIMIT);
    expect(done?.tasks[0].id).toBe("t_212");
  });

  it("显示全部后返回完整列表", () => {
    const views = buildColumnViews(WORKFLOW, boardOf({ done: doneTasks }), {
      showDone: true,
      doneExpanded: true,
    });
    const done = views.find((view) => view.key === "done");
    expect(done?.tasks).toHaveLength(213);
    expect(done?.hiddenCount).toBe(0);
  });

  it("sortDoneTasks 按完成时间倒序", () => {
    const sorted = sortDoneTasks([
      task({ id: "old", status: "done", completed_at: 100 }),
      task({ id: "new", status: "done", completed_at: 300 }),
      task({ id: "mid", status: "done", completed_at: 200 }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["new", "mid", "old"]);
  });
});

describe("搜索与负责人过滤", () => {
  const columns = boardOf({
    todo: [
      task({ id: "a", title: "修登录页样式", body: "CSS 变量对齐" }),
      task({ id: "b", title: "写文档", body: "Kanban 看板说明", assignee: "writer" }),
    ],
    done: [task({ id: "c", status: "done", title: "旧任务", completed_at: 5 })],
  });

  it("title 命中", () => {
    const views = buildColumnViews(WORKFLOW, columns, { query: "登录", showDone: true });
    expect(views.find((view) => view.key === "todo")?.tasks.map((item) => item.id)).toEqual(["a"]);
  });

  it("body 命中且大小写不敏感", () => {
    const views = buildColumnViews(WORKFLOW, columns, { query: "kanban", showDone: true });
    expect(views.find((view) => view.key === "todo")?.tasks.map((item) => item.id)).toEqual(["b"]);
  });

  it("无匹配时全部列清空", () => {
    const views = buildColumnViews(WORKFLOW, columns, { query: "不存在的词", showDone: true });
    expect(views.every((view) => view.total === 0)).toBe(true);
  });

  it("负责人过滤 + ALL 通配", () => {
    expect(
      buildColumnViews(WORKFLOW, columns, { assignee: "writer", showDone: true })
        .find((view) => view.key === "todo")
        ?.tasks.map((item) => item.id),
    ).toEqual(["b"]);
    expect(
      buildColumnViews(WORKFLOW, columns, { assignee: "all", showDone: true })
        .find((view) => view.key === "todo")?.total,
    ).toBe(2);
  });

  it("taskMatchesQuery 对空查询放行", () => {
    expect(taskMatchesQuery(task({ id: "a" }), "")).toBe(true);
    expect(taskMatchesQuery(task({ id: "a", body: null }), "zzz")).toBe(false);
  });
});

describe("拖拽目标白名单", () => {
  const targets = dragTargetKeys(WORKFLOW);

  it("只允许 drag_target:true 的列", () => {
    expect(Array.from(targets).sort()).toEqual(["blocked", "done", "ready", "todo", "triage"]);
    expect(canDropTask(task({ id: "a", status: "ready" }), "todo", targets)).toBe(true);
    expect(canDropTask(task({ id: "a", status: "ready" }), "running", targets)).toBe(false);
    expect(canDropTask(task({ id: "a", status: "ready" }), "review", targets)).toBe(false);
    expect(canDropTask(task({ id: "a", status: "ready" }), "scheduled", targets)).toBe(false);
  });

  it("同列拖放与无效目标被拒绝", () => {
    expect(canDropTask(task({ id: "a", status: "todo" }), "todo", targets)).toBe(false);
    expect(canDropTask(task({ id: "a" }), null, targets)).toBe(false);
    expect(canDropTask(null, "todo", targets)).toBe(false);
  });

  it("也接受数组形式的目标白名单", () => {
    expect(canDropTask(task({ id: "a", status: "ready" }), "todo", ["todo"])).toBe(true);
  });
});

describe("内核手工迁移白名单", () => {
  const workflow = {
    columns: WORKFLOW,
    manual: {
      triage: ["ready", "todo"],
      done: ["ready", "todo", "triage"],
      ready: ["blocked", "done", "review", "scheduled", "todo", "triage"],
    },
  };

  it("按 manual 表收紧可拖放目标（done 不能拖到 blocked）", () => {
    expect(Array.from(allowedDropTargets(workflow, "done")).sort()).toEqual(["ready", "todo", "triage"]);
    expect(Array.from(allowedDropTargets(workflow, "triage")).sort()).toEqual(["ready", "todo"]);
    expect(allowedDropTargets(workflow, "done").has("blocked")).toBe(false);
  });

  it("没有 manual 信息时退回 drag_target 白名单", () => {
    expect(Array.from(allowedDropTargets({ columns: WORKFLOW }, "done")).sort()).toEqual([
      "blocked",
      "done",
      "ready",
      "todo",
      "triage",
    ]);
    expect(manualTransitions({ columns: WORKFLOW }, "done")).toBeNull();
  });

  it("抽屉状态选项只给当前状态 + 合法迁移", () => {
    const options = allowedStatusOptions(workflow, "done", WORKFLOW).map((column) => column.key);
    expect(options).toEqual(["triage", "todo", "ready", "done"]);
    expect(options).not.toContain("blocked");
  });

  it("没有 manual 时抽屉给全部列", () => {
    expect(allowedStatusOptions({ columns: WORKFLOW }, "done", WORKFLOW)).toHaveLength(WORKFLOW.length);
  });
});

describe("PATCH body 构造", () => {
  it("拖拽改状态只发 status", () => {
    expect(buildStatusPatch("todo")).toEqual({ status: "todo" });
    expect(buildTaskUpdatePatch({ status: "todo" })).toEqual({ status: "todo" });
  });

  it("空字符串字段被丢弃，body 允许清空", () => {
    expect(buildTaskUpdatePatch({ title: "   ", status: "done" })).toEqual({ status: "done" });
    expect(buildTaskUpdatePatch({ title: "新标题", assignee: "default" })).toEqual({
      title: "新标题",
      assignee: "default",
    });
    expect(buildTaskUpdatePatch({ body: "" })).toEqual({ body: "" });
  });

  it("priority 只接受数字", () => {
    expect(buildTaskUpdatePatch({ priority: 1 })).toEqual({ priority: 1 });
    expect(buildTaskUpdatePatch({ priority: Number.NaN })).toEqual({});
  });
});

describe("乐观更新与回滚", () => {
  const board: KanbanBoardResponse = {
    columns: boardOf({
      todo: [task({ id: "a", status: "todo" })],
      ready: [task({ id: "b", status: "ready" })],
    }),
  };

  it("applyTaskStatus 把任务挪到目标列", () => {
    const next = applyTaskStatus(board, "a", "ready");
    expect(next.columns.find((column) => column.name === "todo")?.tasks).toHaveLength(0);
    expect(next.columns.find((column) => column.name === "ready")?.tasks[0]).toMatchObject({
      id: "a",
      status: "ready",
    });
    expect(findTask(next, "a")?.status).toBe("ready");
  });

  it("applyOverrides 逐个套用覆盖，且不改动原对象", () => {
    const next = applyOverrides(board, { a: "ready", b: "todo" });
    expect(findTask(next, "a")?.status).toBe("ready");
    expect(findTask(next, "b")?.status).toBe("todo");
    expect(findTask(board, "a")?.status).toBe("todo");
  });
});

describe("展示辅助", () => {
  it("priority<=0 不显示优先级", () => {
    expect(priorityLabel(0)).toBeNull();
    expect(priorityLabel(undefined)).toBeNull();
    expect(priorityLabel(2)).toBe("P2");
  });

  it("负责人下拉合并 assignees 与看板里出现的名字", () => {
    const names = collectAssigneeNames(
      [{ name: "default" }, { name: "writer" }],
      { columns: boardOf({ todo: [task({ id: "a", assignee: "reviewer" })] }) },
    );
    expect(names).toEqual(["default", "reviewer", "writer"]);
  });
});

describe("filterTasks 纯函数筛选", () => {
  const tasks = [
    task({ id: "p1a", priority: 1, assignee: "alice", workspace_path: "D:/Project/alpha" }),
    task({ id: "p2b", priority: 2, assignee: "bob", workspace_path: "D:/Project/beta" }),
    task({ id: "p2c", priority: 2, assignee: "alice", workspace_path: "D:/Project/alpha/" }),
    task({ id: "p0d", priority: 0, assignee: "bob", workspace_path: null }),
  ];

  it("无筛选条件时原样返回", () => {
    expect(filterTasks(tasks, {}).map((item) => item.id)).toEqual(["p1a", "p2b", "p2c", "p0d"]);
    expect(hasActiveFilters({})).toBe(false);
    expect(hasActiveFilters({ query: "   ", assignee: ALL_ASSIGNEES })).toBe(false);
  });

  it("按优先级筛选，0 与 all 分开", () => {
    expect(filterTasks(tasks, { priority: "2" }).map((item) => item.id)).toEqual(["p2b", "p2c"]);
    expect(filterTasks(tasks, { priority: 1 }).map((item) => item.id)).toEqual(["p1a"]);
    expect(filterTasks(tasks, { priority: ALL_PRIORITIES })).toHaveLength(4);
    expect(hasActiveFilters({ priority: "2" })).toBe(true);
  });

  it("按工作区筛选时忽略结尾斜杠差异", () => {
    const filtered = filterTasks(tasks, { workspace: "D:/Project/alpha" });
    expect(filtered.map((item) => item.id)).toEqual(["p1a", "p2c"]);
    expect(hasActiveFilters({ workspace: "D:/Project/alpha" })).toBe(true);
  });

  it("多个条件取交集", () => {
    expect(filterTasks(tasks, { priority: "2", assignee: "alice" }).map((item) => item.id)).toEqual(["p2c"]);
    expect(filterTasks(tasks, { priority: "3", assignee: "alice" })).toEqual([]);
  });

  it("collectWorkspaceOptions 去重、给 basename", () => {
    const options = collectWorkspaceOptions(boardOf({ todo: tasks }));
    expect(options.map((option) => option.label)).toEqual(["alpha", "beta"]);
    expect(options[0].path).toBe("D:/Project/alpha");
  });

  it("buildColumnViews 同时给出 total 与 unfilteredTotal", () => {
    const views = buildColumnViews(WORKFLOW, boardOf({ todo: tasks }), { priority: "2" });
    const todo = views.find((view) => view.key === "todo");
    expect(todo?.total).toBe(2);
    expect(todo?.unfilteredTotal).toBe(4);
  });
});

describe("列折叠状态", () => {
  const views = [
    { key: "triage", total: 0 },
    { key: "todo", total: 3 },
    { key: "review", total: 0 },
  ];

  it("空列默认自动折叠，非空列不折叠", () => {
    const states = resolveColumnCollapse(views, {});
    expect(states.triage).toEqual({ collapsed: true, reason: "auto" });
    expect(states.review).toEqual({ collapsed: true, reason: "auto" });
    expect(states.todo).toEqual({ collapsed: false, reason: null });
  });

  it("关掉自动折叠后空列全部展开", () => {
    const states = resolveColumnCollapse(views, { autoCollapseEmpty: false });
    expect(states.triage.collapsed).toBe(false);
    expect(states.review.collapsed).toBe(false);
  });

  it("手动折叠非空列，手动标记优先于自动判定", () => {
    const states = resolveColumnCollapse(views, {
      marks: { todo: "collapsed" },
      autoCollapseEmpty: false,
    });
    expect(states.todo).toEqual({ collapsed: true, reason: "manual" });
    expect(states.triage.collapsed).toBe(false);
  });

  it("手动展开过的空列不再自动折叠", () => {
    const states = resolveColumnCollapse(views, { marks: { triage: "expanded" } });
    expect(states.triage.collapsed).toBe(false);
    expect(states.review.collapsed).toBe(true);
  });

  it("被筛掉的列（原本有任务）不自动折叠，好让列头继续显示已筛选计数", () => {
    const filtered = [
      { key: "todo", total: 0, unfilteredTotal: 12 },
      { key: "ready", total: 0, unfilteredTotal: 0 },
    ];
    const states = resolveColumnCollapse(filtered, {});
    expect(states.todo).toEqual({ collapsed: false, reason: null });
    expect(states.ready).toEqual({ collapsed: true, reason: "auto" });
  });

  it("拖拽悬停时临时展开折叠列，结束后恢复", () => {
    const hovering = resolveColumnCollapse(views, { dragging: true, hoveredKey: "review" });
    expect(hovering.review).toEqual({ collapsed: false, reason: "auto" });
    const idle = resolveColumnCollapse(views, { dragging: false, hoveredKey: "review" });
    expect(idle.review.collapsed).toBe(true);
    const other = resolveColumnCollapse(views, { dragging: true, hoveredKey: "todo" });
    expect(other.review.collapsed).toBe(true);
  });

  it("storage key 按 board slug 隔开", () => {
    expect(columnCollapseStorageKey("default")).toBe("kanban:collapsed:default");
    expect(columnCollapseStorageKey("feature-x")).toBe("kanban:collapsed:feature-x");
    expect(columnCollapseStorageKey("")).toBe("kanban:collapsed:default");
  });

  it("解析 localStorage：对象、旧数组、脏数据", () => {
    expect(parseCollapseMarks('{"todo":"collapsed","review":"expanded"}')).toEqual({
      todo: "collapsed",
      review: "expanded",
    });
    expect(parseCollapseMarks('["todo","review"]')).toEqual({ todo: "collapsed", review: "collapsed" });
    expect(parseCollapseMarks("not json")).toEqual({});
    expect(parseCollapseMarks(null)).toEqual({});
    expect(parseCollapseMarks('{"todo":"weird"}')).toEqual({});
  });

  it("序列化后可以原样往返", () => {
    const marks = { review: "expanded", todo: "collapsed" } as const;
    const raw = serializeCollapseMarks({ ...marks });
    expect(raw).toBe('{"review":"expanded","todo":"collapsed"}');
    expect(parseCollapseMarks(raw)).toEqual(marks);
  });

  it("setCollapseMark 设置与清除", () => {
    const marks = setCollapseMark({}, "todo", "collapsed");
    expect(marks).toEqual({ todo: "collapsed" });
    expect(setCollapseMark(marks, "todo", "expanded")).toEqual({ todo: "expanded" });
    expect(setCollapseMark(marks, "todo", null)).toEqual({});
  });
});

describe("正文搜索走完整 board", () => {
  const BODY = "把部署脚本改成并行";
  const columns = boardOf({
    todo: [
      task({ id: "t_body", title: "重构登录", body: BODY, latest_summary: "等 CI 结果" }),
      task({ id: "t_summary", title: "修 CI", latest_summary: "等待评审通过" }),
      task({ id: "t_none", title: "无关任务" }),
    ],
  });

  it("未投影的 board 上按正文命中", () => {
    const views = buildColumnViews(WORKFLOW, columns, { query: "部署脚本", showDone: true });
    const todo = views.find((view) => view.key === "todo");
    expect(todo?.tasks.map((entry) => entry.id)).toEqual(["t_body"]);
  });

  it("按 latest_summary 命中", () => {
    const views = buildColumnViews(WORKFLOW, columns, { query: "等待评审", showDone: true });
    const todo = views.find((view) => view.key === "todo");
    expect(todo?.tasks.map((entry) => entry.id)).toEqual(["t_summary"]);
  });

  it("先过滤后投影：命中数不变，卡片仍不带 body", () => {
    const views = projectColumnViews(buildColumnViews(WORKFLOW, columns, { query: "部署脚本" }));
    const todo = views.find((view) => view.key === "todo");
    expect(todo?.tasks).toHaveLength(1);
    expect(todo?.tasks[0].body).toBeNull();
    expect(todo?.tasks[0].body_chars).toBe(BODY.length);
    expect(todo?.total).toBe(1);
  });
});

describe("deleteTasksSequentially", () => {
  it("逐条删除，收集失败项并保持顺序", async () => {
    const calls: string[] = [];
    const failed = await deleteTasksSequentially(["a", "b", "c"], async (id) => {
      calls.push(id);
      if (id === "b") throw new Error("boom");
      return undefined;
    });
    expect(calls).toEqual(["a", "b", "c"]);
    expect(failed).toEqual(["b"]);
  });

  it("全部成功时返回空数组", async () => {
    expect(await deleteTasksSequentially(["a"], async () => undefined)).toEqual([]);
    expect(await deleteTasksSequentially([], async () => undefined)).toEqual([]);
  });
});

describe("kanbanColumnLabel", () => {
  it("把已知工作流状态映射成中文", () => {
    expect(kanbanColumnLabel("Triage")).toBe("待分类");
    expect(kanbanColumnLabel("Todo")).toBe("待办");
    expect(kanbanColumnLabel("Scheduled")).toBe("已排期");
    expect(kanbanColumnLabel("Ready")).toBe("待执行");
    expect(kanbanColumnLabel("Running")).toBe("运行中");
    expect(kanbanColumnLabel("Blocked")).toBe("已阻塞");
    expect(kanbanColumnLabel("Review")).toBe("待审阅");
    expect(kanbanColumnLabel("Done")).toBe("已完成");
  });

  it("接受小写状态键", () => {
    expect(kanbanColumnLabel("done")).toBe("已完成");
  });

  it("未知状态与自定义列名原样返回", () => {
    expect(kanbanColumnLabel("质量检查")).toBe("质量检查");
    expect(kanbanColumnLabel("QA")).toBe("QA");
    expect(kanbanColumnLabel("")).toBe("");
  });
});

describe("kanbanEventKindLabel", () => {
  it("把已知事件类型映射成中文", () => {
    expect(kanbanEventKindLabel("worker_result")).toBe("工作结果");
    expect(kanbanEventKindLabel("completed")).toBe("完成");
    expect(kanbanEventKindLabel("heartbeat")).toBe("心跳");
    expect(kanbanEventKindLabel("owner_admitted")).toBe("已接管");
  });

  it("未知事件类型原样返回", () => {
    expect(kanbanEventKindLabel("some_new_kind")).toBe("some_new_kind");
    expect(kanbanEventKindLabel("")).toBe("");
  });
});
