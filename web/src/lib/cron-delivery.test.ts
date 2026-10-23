import { describe, expect, it } from "vitest";
import {
  FALLBACK_DELIVERY_TARGETS,
  deliverySummary,
  deliveryTargetLabel,
  deliveryTargetsFromPayload,
  deliveryTargetsWithSelection,
  parseCronDeliveryTargets,
  targetLabel,
  toggleCronDeliveryTarget,
} from "./cron-delivery";

describe("投递目标解析", () => {
  it("解析后端 /api/cron/delivery-targets 真实返回", () => {
    const targets = deliveryTargetsFromPayload({
      targets: [
        { id: "local", name: "Local (save only)", home_target_set: true, home_env_var: null },
        { id: "feishu", name: "Feishu", home_target_set: false, home_env_var: "FEISHU_HOME_CHAT_ID" },
        { id: "bot_chat:work", name: "Bot Chat (work)", home_target_set: true, home_env_var: null },
      ],
    });
    expect(targets).toEqual([
      { id: "local", name: "Local (save only)", homeTargetSet: true, homeEnvVar: null },
      { id: "feishu", name: "Feishu", homeTargetSet: false, homeEnvVar: "FEISHU_HOME_CHAT_ID" },
      { id: "bot_chat:work", name: "Bot Chat (work)", homeTargetSet: true, homeEnvVar: null },
    ]);
  });

  it("脏数据只丢弃坏条目，不炸整张列表", () => {
    expect(deliveryTargetsFromPayload(null)).toEqual([]);
    expect(deliveryTargetsFromPayload({})).toEqual([]);
    expect(deliveryTargetsFromPayload({ targets: "nope" })).toEqual([]);
    expect(
      deliveryTargetsFromPayload({ targets: [null, 3, { id: "" }, { id: "email" }] }),
    ).toEqual([{ id: "email", name: "Email", homeTargetSet: true, homeEnvVar: null }]);
  });

  it("降级兜底仍是原来的 4 项", () => {
    expect(FALLBACK_DELIVERY_TARGETS.map((target) => target.id)).toEqual(["local", "feishu", "weixin", "email"]);
  });
});

describe("多选投递", () => {
  it("逗号拆分并默认本地", () => {
    expect(parseCronDeliveryTargets("local, feishu,feishu")).toEqual(["local", "feishu"]);
    expect(parseCronDeliveryTargets("")).toEqual(["local"]);
    expect(parseCronDeliveryTargets(null)).toEqual(["local"]);
  });

  it("勾选与取消勾选", () => {
    expect(toggleCronDeliveryTarget("local", "feishu", true)).toBe("local,feishu");
    expect(toggleCronDeliveryTarget("local,feishu", "feishu", false)).toBe("local");
    expect(toggleCronDeliveryTarget("local,feishu", "feishu", true)).toBe("local,feishu");
  });

  it("至少保留一个目标，取消最后一个不生效", () => {
    expect(toggleCronDeliveryTarget("local", "local", false)).toBe("local");
    expect(toggleCronDeliveryTarget("feishu", "feishu", false)).toBe("feishu");
  });

  it("已保存但后端未探测到的目标也要留在选项里", () => {
    const options = deliveryTargetsWithSelection(FALLBACK_DELIVERY_TARGETS, "local,legacy-platform");
    expect(options.map((target) => target.id)).toEqual(["local", "feishu", "weixin", "email", "legacy-platform"]);
  });

  it("标签与摘要", () => {
    expect(deliveryTargetLabel("local")).toBe("本地（仅保存）");
    expect(deliveryTargetLabel("bot_chat:work")).toBe("Bot Chat（work）");
    expect(deliveryTargetLabel("unknown-platform")).toBe("unknown-platform");
    expect(deliverySummary("local,feishu,weixin")).toBe("本地（仅保存）、飞书、微信");
    expect(targetLabel({ id: "feishu", name: "Feishu", homeTargetSet: false, homeEnvVar: null }))
      .toBe("飞书 — 需先设置 home 频道");
    expect(targetLabel({ id: "local", name: "Local", homeTargetSet: true, homeEnvVar: null }))
      .toBe("本地（仅保存）");
  });
});
