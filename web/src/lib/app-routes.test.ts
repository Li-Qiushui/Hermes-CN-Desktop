import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APP_PAGE_ROUTES,
  APP_SETTINGS_SECTIONS,
  settingsDeepLink,
  settingsRouteForSlug,
  settingsSectionForSlug,
} from "./app-routes";
import {
  buildCommandPaletteItems,
  buildPageRouteItems,
  buildSettingsItems,
  filterCommandPaletteGroups,
} from "./command-palette";

const APP_SOURCE = readFileSync(fileURLToPath(new URL("../app.tsx", import.meta.url)), "utf8");

function declaredRoutePaths(): string[] {
  return Array.from(APP_SOURCE.matchAll(/<Route path="([^"]+)"/g)).map((match) => match[1]);
}

function concreteRoutes(): string[] {
  return declaredRoutePaths().filter(
    (path) => !path.includes(":") && !path.includes("*"),
  );
}

function paletteTargets(): Set<string> {
  return new Set(
    buildCommandPaletteItems({}).flatMap((item) => {
      if (item.action.type === "navigate") return [item.action.to];
      return [item.action.fallbackTo ?? ""];
    }),
  );
}

describe("⌘K 覆盖 app.tsx 路由表", () => {
  it("app.tsx 里每个具体路由都有命令面板条目", () => {
    const targets = paletteTargets();
    const settingsPaths = new Set(
      buildSettingsItems().flatMap((item) => {
        const section = settingsSectionForSlug(
          item.action.type === "navigate" ? item.action.to.replace("/settings/", "") : "",
        );
        return section ? [section.path] : [];
      }),
    );
    const missing = concreteRoutes().filter(
      (path) =>
        !targets.has(path) &&
        !settingsPaths.has(path) &&
        path !== "/wander-memory" &&
        path !== "/new" &&
        path !== "/settings",
    );

    expect(missing).toEqual([]);
  });

  it("页面清单不再出现命令组里已有的路由，避免重复条目", () => {
    const pagePaths = buildPageRouteItems().map((item) =>
      item.action.type === "navigate" ? item.action.to : "",
    );

    expect(pagePaths).not.toContain("/history");
    expect(pagePaths).not.toContain("/models");
    expect(pagePaths).toContain("/profiles/new");
    expect(new Set(pagePaths).size).toBe(pagePaths.length);
  });

  it("清单里的页面路径都真实存在于路由表", () => {
    const declared = declaredRoutePaths();
    const unknown = APP_PAGE_ROUTES.flatMap((entry) =>
      declared.includes(entry.path) || declared.includes(`${entry.path}/*`) ? [] : [entry.path],
    );

    expect(unknown).toEqual([]);
  });

  it("每个设置节都能深链到 /settings/<slug> 并落到真实路由", () => {
    const declared = declaredRoutePaths();
    expect(declared).toContain("/settings/:section");

    for (const section of APP_SETTINGS_SECTIONS) {
      expect(settingsDeepLink(section.slug)).toBe(`/settings/${section.slug}`);
      expect(settingsRouteForSlug(section.slug)).toBe(section.path);
      expect(declared).toContain(section.path);
    }

    expect(settingsSectionForSlug("nope")).toBeNull();
    expect(settingsRouteForSlug("nope")).toBe(APP_SETTINGS_SECTIONS[0].path);
    expect(settingsDeepLink("nope")).toBe(`/settings/${APP_SETTINGS_SECTIONS[0].slug}`);
  });
});

describe("⌘K 设置条目实时搜索", () => {
  it("空查询不把页面/设置塞进首屏", () => {
    const groups = filterCommandPaletteGroups(buildCommandPaletteItems({}), "", { maxPerGroup: 20 });
    expect(groups.some((group) => group.id === "pages")).toBe(false);
    expect(groups.some((group) => group.id === "settings")).toBe(false);
  });

  it("搜「设置」出设置分组，条目深链到 /settings/...", () => {
    const groups = filterCommandPaletteGroups(buildCommandPaletteItems({}), "设置", { maxPerGroup: 20 });
    const settings = groups.find((group) => group.id === "settings");

    expect(settings).toBeTruthy();
    expect(settings!.items.length).toBeGreaterThan(0);
    for (const item of settings!.items) {
      expect(item.action.type).toBe("navigate");
      if (item.action.type === "navigate") expect(item.action.to.startsWith("/settings/")).toBe(true);
    }
    expect(buildSettingsItems()).toHaveLength(APP_SETTINGS_SECTIONS.length);
  });

  it("搜页面名能命中对应页面条目", () => {
    const items = buildCommandPaletteItems({});
    const labels = filterCommandPaletteGroups(items, "看板", { maxPerGroup: 20 }).flatMap((group) =>
      group.items.map((item) => item.label),
    );

    expect(labels).toContain("看板 Kanban");
  });
});
