import { describe, expect, it } from "vitest";
import { CAPABILITY_SECTIONS } from "./capability-sidebar";
import { GATEWAY_SECTIONS } from "./gateway-sidebar";
import { EXTERNAL_MEMORY_ITEMS } from "./external-memory-sidebar";
import { TOP_TABS } from "./use-active-top-tab";

describe("configuration navigation", () => {
  it("moves IM onboarding under the 03 message gateway sidebar", () => {
      const im = GATEWAY_SECTIONS.find((section) => section.label === "消息平台接入");
    expect(im?.items.map((item) => [item.label, item.path])).toEqual([
      ["飞书", "/im/feishu"],
      ["微信", "/im/weixin"],
    ]);
  });

  it("moves IM routes under the 高级 top tab", () => {
    const advancedTab = TOP_TABS.find((tab) => tab.label === "高级");
    expect(advancedTab?.matches("/im/feishu")).toBe(true);
    expect(advancedTab?.matches("/im/weixin")).toBe(true);
    expect(TOP_TABS.some((tab) => tab.label === "消息接入")).toBe(false);
  });

  it("drops the built-in-runtime-only backup and migration entries", () => {
    const backup = CAPABILITY_SECTIONS.find((section) => section.label === "备份与恢复");
    expect(backup).toBeUndefined();
  });

  it("removes memory from configuration", () => {
    const config = CAPABILITY_SECTIONS.find((section) => section.label === "配置");
    expect(config?.items.some((item) => item.path === "/memory")).toBe(false);
    expect(config?.items.some((item) => item.label === "外置记忆")).toBe(false);
  });

  it("places built-in memory first in the memory sidebar", () => {
    expect(EXTERNAL_MEMORY_ITEMS.map((item) => [item.label, item.path])).toEqual([
      ["内置记忆", "/memory"],
      ["配置", "/memconfig"],
      ["OpenViking", "/openviking"],
      ["Hindsight", "/hindsight"],
    ]);
  });
});
