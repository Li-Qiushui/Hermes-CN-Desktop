// Backend CANONICAL_PROVIDERS slugs that the CN edition cares about. Sent
// to model.options as slug_filter so the gateway returns only these (the
// canonical list has 35+ entries including LM Studio, Bedrock, Azure,
// Copilot, etc. that CN users don't configure).
//
// Custom user-defined providers are always returned by the gateway, so
// this filter only restricts the canonical/built-in list. Catalog Top 5
// already comes from the local provider-catalog regardless of what the
// gateway returns.

export const CN_BACKEND_PROVIDER_SLUGS = [
  "alibaba",
  "deepseek",
  "zai",
  "kimi-coding",
  "kimi-coding-cn",
  "minimax",
  "minimax-cn",
  "minimax-oauth",
  "stepfun",
  "xiaomi",
  "anthropic",   // ANTHROPIC_API_KEY widely used even in CN edition
  "openai-codex",
  "openrouter",  // kept as an explicit user-requested fallback aggregator
  // v0.18.0：MoA（Mixture of Agents）虚拟 provider。仅当用户配置了 MoA
  // preset 时网关才返回该行（models = preset 名列表），选中即把整个混合
  // 集合当作一个模型使用。
  "moa",
] as const;

export type CnBackendProviderSlug = (typeof CN_BACKEND_PROVIDER_SLUGS)[number];

const CN_SLUG_SET = new Set<string>(CN_BACKEND_PROVIDER_SLUGS);

/**
 * 内核 0.22.x 的 `model.options` 不接受 `slug_filter` 参数（严格校验，多传字段整条报错），
 * 因此 CN 版改为拿到完整结果后本地过滤：
 *   - 保留 CN 关心的内置 provider
 *   - 保留用户自定义 provider（is_user_defined）
 *   - 保留当前正在使用的 provider（is_current），避免头部显示不一致
 *   - 另外保留带 warning 的条目（通常是「已配置但缺凭证」，用户需要看到才能修）
 */
export function filterCnProviders<T extends {
  slug: string;
  is_user_defined?: boolean;
  is_current?: boolean;
  warning?: string;
}>(providers: readonly T[]): T[] {
  return providers.filter(
    (provider) =>
      CN_SLUG_SET.has(provider.slug) ||
      provider.is_user_defined === true ||
      provider.is_current === true ||
      Boolean(provider.warning),
  );
}
