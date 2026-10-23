import { useQuery } from "@tanstack/react-query";
import { ProviderModelsListResult } from "@hermes/protocol";
import { classifyGatewayError, type GatewayErrorKind } from "@/lib/gateway-result";

export interface UseProviderModelsResult {
  models: string[];
  fetchedAt: number;
}

export type ListProviderModelsFn = (params: {
  provider: string;
  base_url?: string;
  api_key?: string;
  /** "anthropic_messages" 让后端用 Anthropic 协议（x-api-key）列模型。 */
  api_mode?: string;
}) => Promise<ProviderModelsListResult>;

export type ProviderModelsErrorKind =
  | "unsupported"
  | "auth"
  | "not_found"
  | "timeout"
  | "network"
  | "unknown";

const GATEWAY_KIND_TO_PROVIDER_MODELS_KIND: Record<GatewayErrorKind, ProviderModelsErrorKind> = {
  "unsupported-method": "unsupported",
  auth: "auth",
  "not-found": "not_found",
  timeout: "timeout",
  network: "network",
  server: "unknown",
  unknown: "unknown",
};

export function classifyProviderModelsError(error: unknown): ProviderModelsErrorKind {
  return GATEWAY_KIND_TO_PROVIDER_MODELS_KIND[classifyGatewayError(error).kind] ?? "unknown";
}

const providerModelsCache = new Map<string, string[]>();

function providerModelsCacheKey(provider: string, baseUrl: string | undefined): string {
  return `${provider}::${(baseUrl ?? "").trim().toLowerCase().replace(/\/+$/, "")}`;
}

export function readProviderModelsCache(provider: string, baseUrl?: string): string[] {
  return providerModelsCache.get(providerModelsCacheKey(provider, baseUrl)) ?? [];
}

export function cacheProviderModels(
  provider: string,
  baseUrl: string | undefined,
  models: string[],
): void {
  if (models.length === 0) return;
  providerModelsCache.set(providerModelsCacheKey(provider, baseUrl), models);
}

export function __resetProviderModelsCacheForTests(): void {
  providerModelsCache.clear();
}

/**
 * Normalize a `provider.models` RPC result into a sorted, de-duped id list,
 * throwing the backend's error so TanStack Query surfaces it as a failure.
 * Pure (no React) so it stays unit-testable without rendering the hook.
 */
export function selectProviderModelIds(result: ProviderModelsListResult): string[] {
  if (!result.ok) {
    throw new Error(result.error ?? "模型列表获取失败");
  }
  const ids = result.models.filter((id) => id.length > 0);
  return Array.from(new Set(ids)).sort();
}

export function providerModelsErrorText(error: unknown): string {
  switch (classifyProviderModelsError(error)) {
    case "unsupported":
      return "当前内核不支持在线拉取模型列表，已按内置目录展示";
    case "auth":
      return "API Key 无效或未保存";
    case "timeout":
      return "请求超时，没拿到模型列表；本地服务请确认已启动并加载模型";
    case "not_found":
      return "此服务商未提供 /models 端点";
    case "network":
      return "无法连接，可能被浏览器跨域策略拦截；桌面端可正常使用";
    default:
      return error instanceof Error ? error.message : String(error ?? "模型列表获取失败");
  }
}

/**
 * Fetch a provider's model list through the gateway `provider.models` RPC
 * rather than the desktop `external_request` proxy. The backend has no
 * external-request SSRF guard, so a self-hosted provider on a LAN IP (e.g.
 * http://192.168.x.x:11434/v1) is reachable, and the web shell sidesteps the
 * browser CORS that blocked a direct fetch.
 */
export function useProviderModels(
  provider: string,
  baseUrl: string,
  apiKey: string | undefined,
  listModels: ListProviderModelsFn,
  apiMode?: string,
) {
  return useQuery<UseProviderModelsResult>({
    queryKey: ["provider-models", provider, baseUrl, apiMode ?? ""],
    queryFn: async () => {
      const result = await listModels({ provider, base_url: baseUrl, api_key: apiKey, api_mode: apiMode });
      const models = selectProviderModelIds(result);
      cacheProviderModels(provider, baseUrl, models);
      return { models, fetchedAt: Date.now() };
    },
    enabled: false,
    staleTime: 15 * 60 * 1000,
    retry: false,
  });
}
