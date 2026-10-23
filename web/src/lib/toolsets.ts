export interface ToolsetInfo {
  name: string;
  label: string;
  description: string;
  platform: string;
  platform_label: string;
  enabled: boolean;
  available: boolean;
  configured: boolean;
  tools: string[];
}

export type ToolsetThemeId = "work" | "create" | "recall" | "connect" | "more";

export interface ToolsetTheme {
  id: ToolsetThemeId;
  label: string;
  names: readonly string[];
}

// 与官方 desktop 的 lib/desktop-toolsets.ts 同一份隐藏名单：平台耦合项（discord /
// yuanbao 只在那条适配器下有意义）与内部管线项（context_engine / moa）不该出现在
// 面向用户的工具集列表里。只影响显示，不改任何启用状态。
export const HIDDEN_TOOLSETS: ReadonlySet<string> = new Set([
  "discord",
  "discord_admin",
  "yuanbao",
  "context_engine",
  "moa",
]);

export function isToolsetVisible(name: string): boolean {
  return !HIDDEN_TOOLSETS.has(name);
}

// 按「这个工具集让 Agent 能做什么」分组，未命中任何组的落「更多」。
export const TOOLSET_THEMES: readonly ToolsetTheme[] = [
  {
    id: "work",
    label: "工作",
    names: [
      "browser",
      "computer_use",
      "web",
      "terminal",
      "file",
      "code_execution",
      "cronjob",
      "kanban",
      "delegation",
      "todo",
      "clarify",
    ],
  },
  {
    id: "create",
    label: "创作",
    names: ["vision", "video", "stt", "tts", "image_gen", "video_gen"],
  },
  {
    id: "recall",
    label: "记忆与检索",
    names: ["memory", "session_search", "skills"],
  },
  {
    id: "connect",
    label: "连接",
    names: ["connections", "homeassistant", "spotify", "a2a", "x_search", "messaging"],
  },
  {
    id: "more",
    label: "更多",
    names: [],
  },
];

export const TOOLSET_MORE_THEME_ID: ToolsetThemeId = "more";

export function toolsetThemeId(name: string): ToolsetThemeId {
  const theme = TOOLSET_THEMES.find(
    (candidate) => candidate.id !== TOOLSET_MORE_THEME_ID && candidate.names.includes(name),
  );
  return theme?.id ?? TOOLSET_MORE_THEME_ID;
}

export const TOOLSET_PLUGIN_MAP: Readonly<Record<string, string>> = { kanban: "kanban" };

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

// 内核返回的字段可能随版本增删，这里逐项兜底，避免一行缺字段把整页渲染打空。
export function normalizeToolsets(raw: unknown): ToolsetInfo[] {
  if (!Array.isArray(raw)) return [];
  const result: ToolsetInfo[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const name = asString(row.name);
    if (!name) continue;
    const tools = Array.isArray(row.tools) ? row.tools.filter((t): t is string => typeof t === "string") : [];
    result.push({
      name,
      label: asString(row.label) || name,
      description: asString(row.description),
      platform: asString(row.platform),
      platform_label: asString(row.platform_label),
      enabled: asBoolean(row.enabled),
      available: asBoolean(row.available),
      configured: asBoolean(row.configured),
      tools,
    });
  }
  return result;
}

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function toolsetMatches(toolset: ToolsetInfo, query: string): boolean {
  const q = normalizeQuery(query);
  if (!q) return true;
  const haystack = [toolset.name, toolset.label, toolset.description];
  if (haystack.some((value) => value.toLowerCase().includes(q))) return true;
  return toolset.tools.some((tool) => tool.toLowerCase().includes(q));
}

export function filterToolsets(toolsets: ToolsetInfo[], query: string): ToolsetInfo[] {
  return toolsets.filter((toolset) => isToolsetVisible(toolset.name) && toolsetMatches(toolset, query));
}

function compareToolsets(a: ToolsetInfo, b: ToolsetInfo): number {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  return a.label.localeCompare(b.label, "zh-Hans-CN");
}

export interface ToolsetGroup {
  id: ToolsetThemeId;
  label: string;
  items: ToolsetInfo[];
}

// 空分组不占位：搜索命中少时不该留一串光秃秃的组标题。
export function groupToolsets(toolsets: ToolsetInfo[]): ToolsetGroup[] {
  return TOOLSET_THEMES.map((theme) => ({
    id: theme.id,
    label: theme.label,
    items: toolsets
      .filter((toolset) => toolsetThemeId(toolset.name) === theme.id)
      .slice()
      .sort(compareToolsets),
  })).filter((group) => group.items.length > 0);
}

export function patchToolsetEnabled(
  toolsets: ToolsetInfo[] | undefined,
  name: string,
  enabled: boolean,
): ToolsetInfo[] | undefined {
  if (!toolsets) return toolsets;
  return toolsets.map((toolset) =>
    toolset.name === name ? { ...toolset, enabled, available: enabled } : toolset,
  );
}

export function visibleToolsetCount(toolsets: ToolsetInfo[]): number {
  return toolsets.filter((toolset) => isToolsetVisible(toolset.name)).length;
}

export function enabledToolsetCount(toolsets: ToolsetInfo[]): number {
  return toolsets.filter((toolset) => isToolsetVisible(toolset.name) && toolset.enabled).length;
}

export function findToolset(toolsets: ToolsetInfo[], name: string): ToolsetInfo | undefined {
  return toolsets.find((toolset) => toolset.name === name);
}

export function linkedToolsetName(pluginId: string): string | null {
  return TOOLSET_PLUGIN_MAP[pluginId] ?? null;
}

export function toolsetLabel(toolset: ToolsetInfo): string {
  return toolset.label || toolset.name;
}

// 看板面板与 kanban 工具集联动：只有面板开着、工具集却没启用时才提示（官方叫
// DESKTOP_PLUGIN_TOOLSETS）。提示只出现一次，用户点了「稍后」就不再打扰。
export function shouldPromptKanbanToolset(toolsets: ToolsetInfo[], dismissed: boolean): boolean {
  if (dismissed) return false;
  const kanban = findToolset(toolsets, "kanban");
  return kanban !== undefined && !kanban.enabled;
}

export function toolCountLabel(count: number): string {
  return count > 0 ? `${count} 个工具` : "无工具";
}

export function toolsPreview(tools: string[], limit = 6): { shown: string[]; rest: number } {
  const shown = tools.slice(0, limit);
  return { shown, rest: Math.max(0, tools.length - shown.length) };
}
