import { useEffect, useRef, useState } from "react";
import { getDefaultStore } from "jotai";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteJSON, fetchJSON, postJSON, putJSON } from "@/lib/transport";
import { getGatewayClient } from "@/lib/gateway-client";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { gwSessionIdAtom } from "@/stores/chat";
import {
  McpCatalogInstallResponse,
  McpCatalogResponse,
  McpEnabledResponse,
  McpServerCreate,
  MutationOkResponse,
} from "@hermes/protocol";
import { buildToolFilterRequest, type McpToolFilter } from "@/lib/mcp-tools";
import { buildLogsPath, mergeLogLines, MCP_LOG_POLL_MS, type McpLogSourceId } from "@/lib/mcp-logs";
import {
  normalizeLogLines,
  normalizeServersPayload,
  normalizeTestResult,
  type McpServerWire,
  type McpTestWire,
} from "@/lib/mcp-wire";
import { extractServersMap } from "@/lib/mcp-json";

// 桌面版的 MCP 管理直接打官方上游接口 /api/mcp/*（增删改 / 启停 / 测试 / 目录），
// 健康面板的只读统计也走 /api/mcp/servers（见 use-mcp-servers.ts）。

const SERVERS_KEY = "mcp-servers-full";
const CATALOG_KEY = "mcp-catalog";
const RAW_KEY = "mcp-raw-servers";

const mcpPath = (name: string, suffix = "") =>
  `/api/mcp/servers/${encodeURIComponent(name)}${suffix}`;

// GET /api/mcp/servers — 完整服务列表（env 已脱敏）。queryKey 含 profile，
// 与 use-mcp-servers / use-profiles 的 profile-aware 失效保持一致。
// tools 在内核里是 {include, exclude} 对象而非协议里写的字符串数组，统一走
// normalizeServersPayload 兼容两种形状，免得 zod 解析把整页打挂。
export function useMcpServersFull() {
  const profile = useActiveProfileName();
  return useQuery<McpServerWire[]>({
    queryKey: [SERVERS_KEY, profile],
    queryFn: async ({ signal }) => {
      const raw = await fetchJSON<unknown>("/api/mcp/servers", { signal });
      return normalizeServersPayload(raw);
    },
    staleTime: 30_000,
  });
}

// GET /api/mcp/catalog — Nous 官方目录 + 诊断。
export function useMcpCatalog() {
  const profile = useActiveProfileName();
  return useQuery<McpCatalogResponse>({
    queryKey: [CATALOG_KEY, profile],
    queryFn: ({ signal }) => fetchJSON("/api/mcp/catalog", { signal }, McpCatalogResponse),
    staleTime: 60_000,
  });
}

export function useAddMcpServer() {
  const qc = useQueryClient();
  return useMutation<McpServerWire | null, Error, McpServerCreate>({
    mutationFn: async (body) => {
      const raw = await postJSON<unknown>("/api/mcp/servers", body);
      return normalizeServersPayload({ servers: [raw] })[0] ?? null;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [SERVERS_KEY] }),
  });
}

export function useRemoveMcpServer() {
  const qc = useQueryClient();
  return useMutation<MutationOkResponse, Error, string>({
    mutationFn: (name) => deleteJSON(mcpPath(name), undefined, MutationOkResponse),
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: [SERVERS_KEY] }),
      qc.invalidateQueries({ queryKey: [CATALOG_KEY] }),
      qc.invalidateQueries({ queryKey: [RAW_KEY] }),
    ]),
  });
}

export interface SetMcpEnabledInput {
  name: string;
  enabled: boolean;
}

export function useSetMcpEnabled() {
  const qc = useQueryClient();
  return useMutation<McpEnabledResponse, Error, SetMcpEnabledInput>({
    mutationFn: ({ name, enabled }) =>
      putJSON(mcpPath(name, "/enabled"), { enabled }, McpEnabledResponse),
    onSuccess: () => qc.invalidateQueries({ queryKey: [SERVERS_KEY] }),
  });
}

// 测试连接：后端连服务、列工具、断开。OAuth 服务会在这里触发浏览器授权。
// 不进 query 缓存——结果由调用方按服务名自行存。schema_chars / prompts / resources
// 只有桌面端用得上，协议 zod 会剥掉，所以不走 parser。
export function useTestMcpServer() {
  return useMutation<McpTestWire, Error, string>({
    mutationFn: async (name) =>
      normalizeTestResult(await postJSON<unknown>(mcpPath(name, "/test"), {})),
  });
}

export interface SaveToolFilterInput {
  name: string;
  filter: McpToolFilter;
}

// 内核没有 per-tool 的 PATCH：写 mcp_servers.<name>.tools.exclude 走 PUT /api/config
// 的深合并，只发增量，env / headers 这些密钥字段不进请求体。
export function useSaveToolFilter() {
  const qc = useQueryClient();
  return useMutation<MutationOkResponse, Error, SaveToolFilterInput>({
    mutationFn: ({ name, filter }) =>
      putJSON("/api/config", buildToolFilterRequest(name, filter), MutationOkResponse),
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: [SERVERS_KEY] }),
      qc.invalidateQueries({ queryKey: ["config"] }),
      qc.invalidateQueries({ queryKey: [RAW_KEY] }),
    ]),
  });
}

// GET /api/config 的 mcp_servers 是磁盘原样（含 headers / oauth 等摘要接口不给的键），
// 给原始 JSON 编辑器当可回写的数据源。
export function useMcpRawServers(enabled = true) {
  const profile = useActiveProfileName();
  return useQuery<Record<string, unknown>>({
    queryKey: [RAW_KEY, profile],
    queryFn: async ({ signal }) =>
      extractServersMap(await fetchJSON<unknown>("/api/config", { signal })),
    staleTime: 10_000,
    enabled,
  });
}

// 整块替换 mcp_servers：PUT /api/mcp/servers（内核 _replace_mcp_servers 逐条校验后整体写入），
// 删条目也能落盘，深合并的 /api/config 做不到删键。
export function useSaveMcpRawServers() {
  const qc = useQueryClient();
  return useMutation<MutationOkResponse, Error, Record<string, unknown>>({
    mutationFn: (servers) => putJSON("/api/mcp/servers", { servers }, MutationOkResponse),
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: [SERVERS_KEY] }),
      qc.invalidateQueries({ queryKey: [CATALOG_KEY] }),
      qc.invalidateQueries({ queryKey: [RAW_KEY] }),
    ]),
  });
}

export interface InstallCatalogInput {
  name: string;
  env?: Record<string, string>;
  enable?: boolean;
}

export function useInstallCatalogEntry() {
  const qc = useQueryClient();
  return useMutation<McpCatalogInstallResponse, Error, InstallCatalogInput>({
    mutationFn: ({ name, env, enable = true }) =>
      postJSON(
        "/api/mcp/catalog/install",
        { name, env: env ?? {}, enable },
        McpCatalogInstallResponse,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [SERVERS_KEY] });
      qc.invalidateQueries({ queryKey: [CATALOG_KEY] });
    },
  });
}

export interface McpLogsState {
  lines: string[];
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
}

export interface UseMcpLogsInput {
  source: McpLogSourceId;
  serverName?: string;
  lines?: number;
  search?: string;
  paused?: boolean;
}

// /api/logs 只给尾窗口，所以「暂停跟随」= 停轮询并钉住上一帧；恢复后按尾部重叠接着追。
export function useMcpLogs({
  source,
  serverName = "",
  lines = 200,
  search = "",
  paused = false,
}: UseMcpLogsInput) {
  const [state, setState] = useState<McpLogsState>({
    lines: [],
    loading: true,
    error: null,
    updatedAt: null,
  });
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    setState({ lines: [], loading: true, error: null, updatedAt: null });
  }, [source, serverName, search, lines]);

  useEffect(() => {
    if (paused) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const raw = await fetchJSON<unknown>(buildLogsPath({ source, lines, search }), {
          signal: controller.signal,
        });
        if (!aliveRef.current || controller.signal.aborted) return;
        const incoming = normalizeLogLines(raw);
        setState((prev) => ({
          lines: prev.updatedAt === null ? incoming : mergeLogLines(prev.lines, incoming),
          loading: false,
          error: null,
          updatedAt: Date.now(),
        }));
      } catch (error) {
        if (!aliveRef.current || controller.signal.aborted) return;
        setState((prev) => ({
          ...prev,
          loading: false,
          error: error instanceof Error ? error.message : "日志读取失败",
        }));
      } finally {
        if (aliveRef.current && !controller.signal.aborted) {
          timer = setTimeout(tick, MCP_LOG_POLL_MS);
        }
      }
    };

    void tick();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [source, lines, search, paused]);

  return state;
}

export interface ReloadMcpResult {
  status: string;
  message?: string;
}

// 触发官方 reload.mcp（WS JSON-RPC，无 REST 版）。增删改 / 启停后调用即可让改动
// 即时生效：handler 内部全局 shutdown_mcp_servers() + discover_mcp_tools()，再刷新
// 当前会话的工具快照。settings 页通常没有活跃会话，session_id 传空字符串即触发
// 全局重连，下次会话自然用上新配置。confirm:true 跳过会话级确认门。
export async function reloadMcp(): Promise<ReloadMcpResult> {
  const sessionId = getDefaultStore().get(gwSessionIdAtom) ?? "";
  return getGatewayClient().request<ReloadMcpResult>("reload.mcp", {
    session_id: sessionId,
    confirm: true,
  });
}
