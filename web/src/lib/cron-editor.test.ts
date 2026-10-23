import { describe, expect, it } from "vitest";
import { createPayload, cronEditorIssues, enabledAction, updatePayload, type CronEditorValues } from "./cron-editor";

function values(partial: Partial<CronEditorValues> = {}): CronEditorValues {
  return {
    profile: "default",
    name: " 每日巡检 ",
    prompt: "  跑一次健康检查  ",
    schedule: "0  9 * * 1-5",
    deliver: "local,feishu",
    model: "",
    enabled: true,
    ...partial,
  };
}

describe("创建任务载荷", () => {
  it("多选投递拼成逗号串，名称与提示词去空白", () => {
    const payload = createPayload(values());
    expect(payload).toEqual({
      schedule: "0 9 * * 1-5",
      prompt: "跑一次健康检查",
      deliver: "local,feishu",
      name: "每日巡检",
    });
  });

  it("模型留空不写、填了才写；关闭启用带 paused", () => {
    expect(createPayload(values({ model: "  deepseek-v4-flash " })).model).toBe("deepseek-v4-flash");
    expect(createPayload(values()).model).toBeUndefined();
    expect(createPayload(values({ enabled: false })).paused).toBe(true);
    expect(createPayload(values())).not.toHaveProperty("paused");
  });

  it("空名称不写字段", () => {
    expect(createPayload(values({ name: "   " }))).not.toHaveProperty("name");
  });

  it("投递为空时回落本地", () => {
    expect(createPayload(values({ deliver: "" })).deliver).toBe("local");
  });
});

describe("编辑任务载荷", () => {
  it("六个字段都带上，模型清空写 null", () => {
    const updates = updatePayload(values());
    expect(updates).toEqual({
      name: "每日巡检",
      prompt: "跑一次健康检查",
      schedule: "0 9 * * 1-5",
      deliver: "local,feishu",
      model: null,
    });
  });

  it("模型填了就写进去", () => {
    expect(updatePayload(values({ model: " deepseek-v4-flash " })).model).toBe("deepseek-v4-flash");
  });

  it("启用状态变化走 pause/resume 接口而不是 updates 字段", () => {
    const updates = updatePayload(values({ enabled: false }));
    expect(updates).not.toHaveProperty("enabled");
    expect(updates).not.toHaveProperty("state");
    expect(updates).not.toHaveProperty("paused_at");
    expect(enabledAction(values({ enabled: false }), { enabled: true })).toBe("pause");
    expect(enabledAction(values({ enabled: true }), { enabled: false })).toBe("resume");
    expect(enabledAction(values({ enabled: true }), { enabled: true })).toBeNull();
  });
});

describe("编辑表单校验", () => {
  it("提示词为空与调度非法都要报", () => {
    const issues = cronEditorIssues(values({ prompt: "   " }), "分钟字段取值「70」超出 0-59 范围");
    expect(issues).toEqual([
      { field: "prompt", message: "请填写任务提示词，定时执行时会原样发给 Agent" },
      { field: "schedule", message: "分钟字段取值「70」超出 0-59 范围" },
    ]);
  });

  it("合法表单没有 issue", () => {
    expect(cronEditorIssues(values(), null)).toEqual([]);
  });
});
