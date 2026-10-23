// MCP 单工具粒度过滤：内核真实字段是 mcp_servers.<name>.tools.include / exclude
// （见 Hermes-CN-Core hermes_cli/mcp_config.py:222-231 的 _tool_filters、以及
// tools/mcp_tool_registration.py:219-236 的 _make_tool_filter：include 是白名单
// 且优先于 exclude，exclude 是黑名单，[] 表示不过滤）。
// 没有 per-tool 的 PATCH 端点，写回走 PUT /api/config 深合并（config_env.py:122-154）。

export interface McpToolFilter {
  include: string[] | null;
  exclude: string[];
}

const EMPTY_FILTER: McpToolFilter = { include: null, exclude: [] };

function nameList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter((v): v is string => typeof v === "string");
}

export function readToolFilter(raw: unknown): McpToolFilter {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY_FILTER };
  const cfg = raw as Record<string, unknown>;
  return {
    include: nameList(cfg.include),
    exclude: nameList(cfg.exclude) ?? [],
  };
}

export function hasWhitelist(filter: McpToolFilter): boolean {
  return filter.include !== null;
}

export function isToolEnabled(name: string, filter: McpToolFilter): boolean {
  if (filter.include !== null) return filter.include.includes(name);
  return !filter.exclude.includes(name);
}

export function enabledToolCount(available: string[], filter: McpToolFilter): number {
  return available.filter((name) => isToolEnabled(name, filter)).length;
}

export function disabledTools(filter: McpToolFilter, available: string[]): string[] {
  const known = new Set(available);
  const fromList = filter.include !== null
    ? available.filter((name) => !filter.include!.includes(name))
    : filter.exclude.filter((name) => known.has(name));
  return Array.from(new Set(fromList));
}

export function setDisabledTools(filter: McpToolFilter, available: string[], disabled: string[]): McpToolFilter {
  const off = new Set(disabled);
  if (filter.include !== null) {
    const include = available.filter((name) => !off.has(name));
    return { include, exclude: [...filter.exclude] };
  }
  const exclude = available.filter((name) => off.has(name));
  const extra = filter.exclude.filter((name) => !available.includes(name));
  return { include: null, exclude: Array.from(new Set([...extra, ...exclude])) };
}

export function toggleToolInFilter(
  filter: McpToolFilter,
  available: string[],
  name: string,
  enabled: boolean,
): McpToolFilter {
  const off = new Set(disabledTools(filter, available));
  if (enabled) off.delete(name);
  else off.add(name);
  return setDisabledTools(filter, available, Array.from(off));
}

// 深合并无法删除 include 键，所以只有纯黑名单形态能无损写回；
// 已存在 include 白名单时由调用方降级为只读并提示改原始 JSON。
export function toolFilterWritable(filter: McpToolFilter): boolean {
  return filter.include === null;
}

export function buildToolFilterConfig(serverName: string, filter: McpToolFilter): Record<string, unknown> {
  return {
    mcp_servers: {
      [serverName]: {
        tools: { exclude: [...filter.exclude] },
      },
    },
  };
}

export function buildToolFilterRequest(serverName: string, filter: McpToolFilter): { config: Record<string, unknown> } {
  return { config: buildToolFilterConfig(serverName, filter) };
}
