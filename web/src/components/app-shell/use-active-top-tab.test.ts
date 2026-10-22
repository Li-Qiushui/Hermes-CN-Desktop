import { describe, expect, it } from "vitest";
import { CONFIG_ITEMS } from "./capability-sidebar";
import { TOP_TABS } from "./use-active-top-tab";

function tabFor(path: string) {
  return TOP_TABS.find((tab) => tab.matches(path))?.id;
}

describe("TOP_TABS", () => {
  it("keeps IM routes under the 03 message gateway tab", () => {
    expect(tabFor("/im/feishu")).toBe("advanced");
    expect(tabFor("/im/weixin")).toBe("advanced");
  });

  it("keeps kanban under the 01 workbench tab", () => {
    expect(tabFor("/kanban")).toBe("workbench");
  });

  it("keeps canonical advanced pages under the 06 advanced tab", () => {
    expect(tabFor("/common")).toBe("advanced");
    expect(tabFor("/notifications")).toBe("advanced");
    expect(tabFor("/config")).toBe("advanced");
    expect(tabFor("/connection")).toBe("advanced");
    expect(tabFor("/env")).toBe("advanced");
    expect(tabFor("/about")).toBe("advanced");
  });

  it("keeps voice setup under the 02 config tab and sidebar section", () => {
    expect(tabFor("/voice")).toBe("skills");
    expect(CONFIG_ITEMS.some((item) => item.label === "语音" && item.path === "/voice")).toBe(true);
  });

  it("keeps soul under the 02 config tab and sidebar section", () => {
    expect(tabFor("/soul")).toBe("skills");
    expect(tabFor("/soul/edit")).toBe("skills");
    expect(CONFIG_ITEMS.some((item) => item.label === "人格" && item.path === "/soul")).toBe(true);
  });

  it("keeps built-in and external memory together under 05 hermes memory", () => {
    expect(tabFor("/memory")).toBe("hermesMemory");
    expect(tabFor("/memconfig")).toBe("hermesMemory");
    expect(tabFor("/openviking")).toBe("hermesMemory");
    expect(tabFor("/hindsight")).toBe("hermesMemory");
    expect(CONFIG_ITEMS.some((item) => item.path === "/memory")).toBe(false);
    expect(CONFIG_ITEMS.some((item) => item.label === "外置记忆")).toBe(false);
  });

  it("keeps the Wander memory workbench under the 04 tab", () => {
    expect(tabFor("/wander-memory")).toBe("advanced");
    expect(tabFor("/wander-memory/memories")).toBe("advanced");
    expect(tabFor("/wander-memory/files")).toBe("advanced");
    expect(tabFor("/wander-memory/dialogue")).toBe("advanced");
    expect(tabFor("/wander-memory/chat")).toBe("advanced");
    expect(tabFor("/wander-memory/context")).toBe("advanced");
    expect(tabFor("/wander-memory/status")).toBe("advanced");
    expect(tabFor("/wander-memory/api")).toBe("advanced");
  });

  it("keeps four top tabs after IM and Wander memory moved into 高级", () => {
    expect(TOP_TABS.map((tab) => [tab.num, tab.label])).toEqual([
      ["01", "工作台"],
      ["02", "配置"],
      ["03", "Hermes 记忆"],
      ["04", "高级"],
    ]);
  });
});
