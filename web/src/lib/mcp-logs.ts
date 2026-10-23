export type McpLogSourceId = "stdio" | "agent";

export interface McpLogSource {
  id: McpLogSourceId;
  file: string;
  component?: string;
  label: string;
  hint: string;
}

export const MCP_LOG_SOURCES: McpLogSource[] = [
  {
    id: "stdio",
    file: "mcp",
    label: "stdio 子进程",
    hint: "内核把每个 stdio MCP 子进程的 stderr 重定向到 mcp-stderr.log，按 server 会话分段",
  },
  {
    id: "agent",
    file: "agent",
    component: "tools",
    label: "Agent 侧",
    hint: "Agent 工具层（tools/*）记录的工具发现与调用日志",
  },
];

export const MCP_LOG_POLL_MS = 2000;

export function findLogSource(id: McpLogSourceId): McpLogSource {
  return MCP_LOG_SOURCES.find((source) => source.id === id) ?? MCP_LOG_SOURCES[0];
}

export interface McpLogQueryInput {
  source: McpLogSourceId;
  lines?: number;
  level?: string;
  search?: string;
}

export function buildLogsPath({ source, lines = 200, level, search }: McpLogQueryInput): string {
  const def = findLogSource(source);
  const params = new URLSearchParams({ file: def.file, lines: String(lines) });
  if (def.component) params.set("component", def.component);
  if (level && level !== "ALL") params.set("level", level);
  const needle = search?.trim();
  if (needle) params.set("search", needle);
  return `/api/logs?${params.toString()}`;
}

export function filterLogLines(lines: string[], term: string): string[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return lines;
  return lines.filter((line) => line.toLowerCase().includes(needle));
}

export function mentionsServer(line: string, serverName: string): boolean {
  if (!serverName) return true;
  return line.toLowerCase().includes(serverName.toLowerCase());
}

export function filterLogLinesForServer(lines: string[], serverName: string): string[] {
  if (!serverName.trim()) return lines;
  return lines.filter((line) => mentionsServer(line, serverName));
}

export function mergeLogLines(previous: string[], incoming: string[]): string[] {
  if (previous.length === 0) return incoming;
  if (incoming.length === 0) return previous;
  const maxOverlap = Math.min(previous.length, incoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    let matched = true;
    for (let i = 0; i < overlap; i += 1) {
      if (previous[previous.length - overlap + i] !== incoming[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return [...previous, ...incoming.slice(overlap)];
  }
  if (previous[previous.length - 1] === incoming[incoming.length - 1]) return previous;
  return incoming;
}
