import { describe, expect, it } from "vitest";
import {
  enabledToolsetCount,
  filterToolsets,
  groupToolsets,
  isToolsetVisible,
  normalizeToolsets,
  patchToolsetEnabled,
  shouldPromptKanbanToolset,
  toolCountLabel,
  toolsetThemeId,
  visibleToolsetCount,
  type ToolsetInfo,
} from "./toolsets";

function makeToolset(partial: Partial<ToolsetInfo> & { name: string }): ToolsetInfo {
  return {
    label: partial.name,
    description: "",
    platform: "cli",
    platform_label: "CLI",
    enabled: false,
    available: false,
    configured: true,
    tools: [],
    ...partial,
  };
}

const SAMPLE: ToolsetInfo[] = [
  makeToolset({ name: "web", label: "Web Search", enabled: true, tools: ["web_search", "web_extract"] }),
  makeToolset({ name: "kanban", label: "Kanban", description: "opt-in task board tools" }),
  makeToolset({ name: "vision", label: "Vision", tools: ["vision_analyze"] }),
  makeToolset({ name: "memory", label: "Memory", tools: ["memory"] }),
  makeToolset({ name: "spotify", label: "Spotify", tools: ["spotify_play"] }),
  makeToolset({ name: "soul", label: "Soul", tools: ["soul_read"] }),
  makeToolset({ name: "discord", label: "Discord" }),
  makeToolset({ name: "discord_admin", label: "Discord Admin" }),
  makeToolset({ name: "yuanbao", label: "Yuanbao" }),
  makeToolset({ name: "context_engine", label: "Context Engine" }),
  makeToolset({ name: "moa", label: "MoA" }),
];

describe("normalizeToolsets", () => {
  it("keeps the kernel shape and drops rows without a name", () => {
    const rows = normalizeToolsets([
      {
        name: "browser",
        label: "Browser Automation",
        description: "navigate, click",
        platform: "cli",
        platform_label: "CLI",
        enabled: true,
        available: true,
        configured: false,
        tools: ["browser_navigate", 42, null],
      },
      { label: "no name" },
      "junk",
      null,
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      name: "browser",
      label: "Browser Automation",
      description: "navigate, click",
      platform: "cli",
      platform_label: "CLI",
      enabled: true,
      available: true,
      configured: false,
      tools: ["browser_navigate"],
    });
  });

  it("returns an empty list for non-array payloads", () => {
    expect(normalizeToolsets(null)).toEqual([]);
    expect(normalizeToolsets({ toolsets: [] })).toEqual([]);
  });

  it("falls back to the name when the label is missing", () => {
    const rows = normalizeToolsets([{ name: "todo" }]);
    expect(rows[0].label).toBe("todo");
    expect(rows[0].enabled).toBe(false);
    expect(rows[0].tools).toEqual([]);
  });
});

describe("groupToolsets", () => {
  it("puts known toolsets in their theme and unknown ones in 更多", () => {
    const groups = groupToolsets(filterToolsets(SAMPLE, ""));
    const byId = Object.fromEntries(groups.map((group) => [group.id, group.items.map((item) => item.name)]));

    expect(byId.work).toEqual(expect.arrayContaining(["web", "kanban"]));
    expect(byId.create).toContain("vision");
    expect(byId.recall).toContain("memory");
    expect(byId.connect).toContain("spotify");
    expect(byId.more).toEqual(["soul"]);
  });

  it("drops empty groups instead of rendering bare headers", () => {
    const groups = groupToolsets(filterToolsets([makeToolset({ name: "vision" })], ""));
    expect(groups.map((group) => group.id)).toEqual(["create"]);
  });

  it("maps every non-listed toolset to the more theme", () => {
    expect(toolsetThemeId("some_future_toolset")).toBe("more");
    expect(toolsetThemeId("moa")).toBe("more");
  });
});

describe("hidden toolsets", () => {
  it("hides platform-coupled and internal toolsets from the list", () => {
    const visible = filterToolsets(SAMPLE, "").map((toolset) => toolset.name);

    expect(visible).not.toContain("discord");
    expect(visible).not.toContain("discord_admin");
    expect(visible).not.toContain("yuanbao");
    expect(visible).not.toContain("context_engine");
    expect(visible).not.toContain("moa");
    expect(isToolsetVisible("discord")).toBe(false);
    expect(isToolsetVisible("kanban")).toBe(true);
  });

  it("counts and search both ignore hidden rows", () => {
    expect(visibleToolsetCount(SAMPLE)).toBe(6);
    expect(enabledToolsetCount(SAMPLE)).toBe(1);
    expect(filterToolsets(SAMPLE, "discord")).toHaveLength(0);
  });
});

describe("toolset search", () => {
  it("matches tool names, not just labels", () => {
    const byTool = filterToolsets(SAMPLE, "web_extract").map((toolset) => toolset.name);
    expect(byTool).toEqual(["web"]);
  });

  it("matches name, label and description case-insensitively", () => {
    expect(filterToolsets(SAMPLE, "KANBAN").map((toolset) => toolset.name)).toEqual(["kanban"]);
    expect(filterToolsets(SAMPLE, "task board").map((toolset) => toolset.name)).toEqual(["kanban"]);
    expect(filterToolsets(SAMPLE, "spotify").map((toolset) => toolset.name)).toEqual(["spotify"]);
  });

  it("returns every visible toolset for a blank query", () => {
    expect(filterToolsets(SAMPLE, "   ")).toHaveLength(6);
  });
});

describe("patchToolsetEnabled", () => {
  it("flips enabled together with available, and only for the target row", () => {
    const next = patchToolsetEnabled(SAMPLE, "kanban", true);
    const kanban = next?.find((toolset) => toolset.name === "kanban");

    expect(kanban?.enabled).toBe(true);
    expect(kanban?.available).toBe(true);
    expect(next?.find((toolset) => toolset.name === "web")?.enabled).toBe(true);
    expect(next).toHaveLength(SAMPLE.length);
  });

  it("can be reverted to the exact previous state", () => {
    const optimistic = patchToolsetEnabled(SAMPLE, "kanban", true);
    const rolledBack = patchToolsetEnabled(optimistic, "kanban", false);
    const before = SAMPLE.find((toolset) => toolset.name === "kanban");
    const after = rolledBack?.find((toolset) => toolset.name === "kanban");

    expect(after).toEqual(before);
  });

  it("passes undefined through untouched", () => {
    expect(patchToolsetEnabled(undefined, "kanban", true)).toBeUndefined();
  });
});

describe("shouldPromptKanbanToolset", () => {
  it("prompts only while the kanban toolset exists and is off", () => {
    expect(shouldPromptKanbanToolset(SAMPLE, false)).toBe(true);
    expect(shouldPromptKanbanToolset(SAMPLE, true)).toBe(false);
    expect(
      shouldPromptKanbanToolset(patchToolsetEnabled(SAMPLE, "kanban", true) ?? [], false),
    ).toBe(false);
    expect(shouldPromptKanbanToolset([], false)).toBe(false);
  });
});

describe("toolCountLabel", () => {
  it("reads as a Chinese count", () => {
    expect(toolCountLabel(15)).toBe("15 个工具");
    expect(toolCountLabel(0)).toBe("无工具");
  });
});
