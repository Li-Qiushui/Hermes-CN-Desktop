import { describe, expect, it } from "vitest";
import {
  attachmentDeletePath,
  attachmentLimitLabel,
  attachmentUploadPath,
  buildArchiveBoardPath,
  buildBlockPatch,
  buildCreateBoardBody,
  buildLinkBody,
  buildLinkGroups,
  buildReassignBody,
  buildUnblockPatch,
  canDecompose,
  checkBoardSlug,
  decomposeChildNames,
  diagnosticActions,
  diagnosticCommand,
  diagnosticText,
  formatFileSize,
  groupTasksByAssignee,
  linkCandidates,
  normalizeBoardSlug,
  parseDecomposeOutcome,
  phantomIdsOf,
  profileOptions,
  UNASSIGNED_LANE_KEY,
} from "./kanban-orchestration";
import type { KanbanTask } from "./kanban";

function task(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "t_a",
    title: "样例任务",
    status: "todo",
    assignee: null,
    priority: 0,
    ...overrides,
  };
}

describe("依赖链接体", () => {
  it("正向返回父子 id", () => {
    expect(buildLinkBody("t_parent", "t_child")).toEqual({ parent_id: "t_parent", child_id: "t_child" });
  });

  it("空值或自引用直接拒绝", () => {
    expect(buildLinkBody("", "t_child")).toBeNull();
    expect(buildLinkBody("t_a", "t_a")).toBeNull();
    expect(buildLinkBody(null, undefined)).toBeNull();
  });

  it("按 links + link_tasks 组装并标出角色", () => {
    const groups = buildLinkGroups(
      { parents: ["t_p"], children: ["t_c", "t_missing"] },
      [
        { id: "t_p", title: "父任务标题", status: "done" },
        { id: "t_c", title: "", status: "running" },
      ],
    );
    expect(groups).toEqual([
      { role: "parent", id: "t_p", title: "父任务标题", status: "done" },
      { role: "child", id: "t_c", title: "t_c", status: "running" },
      { role: "child", id: "t_missing", title: "t_missing", status: "unknown" },
    ]);
  });

  it("候选剔除自身与已关联的任务", () => {
    const candidates = linkCandidates(
      [
        { id: "t_a", title: "自己", status: "todo" },
        { id: "t_p", title: "父", status: "done" },
        { id: "t_x", title: "可选", status: "ready" },
        { id: "t_x", title: "重复", status: "ready" },
      ],
      "t_a",
      { parents: ["t_p"], children: [] },
    );
    expect(candidates).toEqual([{ id: "t_x", title: "可选", status: "ready" }]);
  });
});

describe("阻塞补丁", () => {
  it("带原因走 block_reason", () => {
    expect(buildBlockPatch("等 CI 通过")).toEqual({ status: "blocked", block_reason: "等 CI 通过" });
  });

  it("空原因只发状态", () => {
    expect(buildBlockPatch("   ")).toEqual({ status: "blocked" });
  });

  it("解除阻塞回到 ready", () => {
    expect(buildUnblockPatch()).toEqual({ status: "ready" });
  });
});

describe("重派体", () => {
  it("没有 profile 不发请求", () => {
    expect(buildReassignBody({ profile: "  " })).toBeNull();
  });

  it("拼出 reclaim_first 与 reason", () => {
    expect(buildReassignBody({ profile: "writer", reclaimFirst: true, reason: "卡死了" })).toEqual({
      profile: "writer",
      reclaim_first: true,
      reason: "卡死了",
    });
  });

  it("默认不回收", () => {
    expect(buildReassignBody({ profile: "writer" })).toEqual({ profile: "writer", reclaim_first: false });
  });
});

describe("拆解", () => {
  it("只有 triage/todo 可拆", () => {
    expect(canDecompose(task({ status: "triage" }))).toBe(true);
    expect(canDecompose(task({ status: "todo" }))).toBe(true);
    expect(canDecompose(task({ status: "running" }))).toBe(false);
    expect(canDecompose(null)).toBe(false);
  });

  it("成功带子任务", () => {
    const outcome = parseDecomposeOutcome({ ok: true, child_ids: ["t_1", "t_2"], fanout: true });
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toBe("已拆出 2 个子任务");
    expect(outcome.childIds).toEqual(["t_1", "t_2"]);
  });

  it("失败回显后端原文", () => {
    const outcome = parseDecomposeOutcome({ ok: false, reason: "no auxiliary model configured" });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe("no auxiliary model configured");
  });

  it("失败但没原文时不编造", () => {
    const outcome = parseDecomposeOutcome({ ok: false, reason: null });
    expect(outcome.message).toContain("原文为空");
  });

  it("判定不需要拆", () => {
    const outcome = parseDecomposeOutcome({ ok: true, fanout: false, reason: "single-step task" });
    expect(outcome.message).toBe("single-step task");
  });

  it("子任务名为空时返回空串", () => {
    expect(decomposeChildNames(parseDecomposeOutcome({ ok: true, child_ids: [] }))).toBe("");
    expect(decomposeChildNames(parseDecomposeOutcome({ ok: true, child_ids: ["a", "b"] }))).toBe("a、b");
  });
});

describe("诊断数据", () => {
  it("取 phantom_ids 与 phantom_refs 去重", () => {
    expect(
      phantomIdsOf({ kind: "x", data: { phantom_ids: ["t_a", "t_a"], phantom_refs: ["t_b"] } }),
    ).toEqual(["t_a", "t_b"]);
  });

  it("没有 data 时返回空数组", () => {
    expect(phantomIdsOf({ kind: "x" })).toEqual([]);
    expect(phantomIdsOf({ kind: "x", data: { phantom_ids: "t_a" as unknown as string[] } })).toEqual([]);
  });

  it("过滤脏 action", () => {
    const actions = diagnosticActions({
      kind: "x",
      actions: [
        { kind: "reclaim", label: "回收", payload: { command: "hermes kanban reclaim t_a" } },
        { kind: "", label: "坏的" } as unknown as { kind: string; label: string },
      ],
    });
    expect(actions).toHaveLength(1);
    expect(diagnosticCommand(actions[0])).toBe("hermes kanban reclaim t_a");
  });

  it("合并 title 与 detail", () => {
    expect(diagnosticText({ kind: "x", title: "标题", detail: "细节" })).toBe("标题 · 细节");
    expect(diagnosticText({ kind: "x", message: "只有消息" })).toBe("只有消息");
    expect(diagnosticText({ kind: "stale_run" })).toBe("stale_run");
  });
});

describe("看板创建", () => {
  it("slug 规范化", () => {
    expect(normalizeBoardSlug("  Hermes CN  Desktop ")).toBe("hermes-cn-desktop");
    expect(checkBoardSlug("Hermes CN").slug).toBe("hermes-cn");
  });

  it("拒绝空 slug 与非法字符", () => {
    expect(checkBoardSlug("   ").ok).toBe(false);
    expect(checkBoardSlug("中文").ok).toBe(false);
    expect(checkBoardSlug("-abc").ok).toBe(false);
  });

  it("建板体只带非空字段且默认切换", () => {
    const result = buildCreateBoardBody({ slug: "Hermes CN", name: " 前端 ", icon: "" });
    expect(result.ok).toBe(true);
    expect(result.body).toEqual({ slug: "hermes-cn", name: "前端", switch: true });
  });

  it("非法 slug 不带请求体", () => {
    const result = buildCreateBoardBody({ slug: "" });
    expect(result.ok).toBe(false);
    expect(result.body).toEqual({});
    expect(result.error).toBe("slug 不能为空");
  });

  it("归档路径走 DELETE 默认归档", () => {
    expect(buildArchiveBoardPath("hermes cn")).toBe("/api/plugins/kanban/boards/hermes%20cn");
    expect(buildArchiveBoardPath("")).toBe("/api/plugins/kanban/boards/default");
  });
});

describe("泳道分组", () => {
  it("按负责人分组并把未指派放最后", () => {
    const lanes = groupTasksByAssignee([
      task({ id: "t_1", assignee: null }),
      task({ id: "t_2", assignee: "writer" }),
      task({ id: "t_3", assignee: "reviewer" }),
      task({ id: "t_4", assignee: "writer" }),
    ]);
    expect(lanes.map((lane) => lane.label)).toEqual(["reviewer", "writer", "未指派"]);
    expect(lanes[1].tasks.map((item) => item.id)).toEqual(["t_2", "t_4"]);
    expect(lanes[2].key).toBe(UNASSIGNED_LANE_KEY);
  });

  it("空列表返回空泳道", () => {
    expect(groupTasksByAssignee([])).toEqual([]);
    expect(groupTasksByAssignee(null)).toEqual([]);
  });
});

describe("profile 与附件", () => {
  it("profile 选项带描述作为 hint", () => {
    expect(
      profileOptions([
        { name: "writer", description: "写代码", model: "x" },
        { name: "", description: "坏的" },
      ]),
    ).toEqual([{ value: "writer", label: "writer", hint: "写代码" }]);
  });

  it("文件大小格式化", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(900)).toBe("900 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("附件路径带 board 查询", () => {
    expect(attachmentUploadPath("t_1", "hermes cn")).toBe(
      "/api/plugins/kanban/tasks/t_1/attachments?board=hermes%20cn",
    );
    expect(attachmentDeletePath(7.9)).toBe("/api/plugins/kanban/attachments/7");
  });

  it("上限文案 25 MB", () => {
    expect(attachmentLimitLabel()).toBe("25 MB");
  });
});
