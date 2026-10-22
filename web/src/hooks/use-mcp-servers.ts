import { useQuery } from "@tanstack/react-query";
import { fetchJSON } from "@/lib/transport";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { McpServersFullResponse, McpServersResponse } from "@hermes/protocol";

/**
 * 健康面板只需要「总数 / 启用数」。走官方端点 `/api/mcp/servers`：0.22 起
 * fork 的只读端点 `/api/mcp-servers` 已不存在，继续调用只会拿到 404，把健康
 * 检查里本该属于「零配置正常」的 MCP 项误判成异常。summary 在前端按列表算出。
 */
export function useMcpServers() {
  const profile = useActiveProfileName();
  return useQuery<McpServersResponse>({
    queryKey: ["mcp-servers", profile],
    queryFn: async ({ signal }) => {
      const r = await fetchJSON("/api/mcp/servers", { signal }, McpServersFullResponse);
      return {
        summary: {
          total: r.servers.length,
          enabled: r.servers.filter((server) => server.enabled).length,
        },
        servers: r.servers.map((server) => ({ name: server.name, enabled: server.enabled })),
      };
    },
    staleTime: 60_000,
  });
}
