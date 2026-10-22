import { useQuery } from "@tanstack/react-query";
import { fetchJSON } from "@/lib/transport";
import { useActiveProfileName } from "@/hooks/use-profiles";
import type { AnalyticsResponse } from "@hermes/protocol";
import { normalizeAnalyticsPayload } from "@/lib/analytics-normalize";

export function analyticsPath(days: number, profileOverride?: string | null): string {
  const params = new URLSearchParams({ days: String(days) });
  if (profileOverride) params.set("profile", profileOverride);
  return `/api/analytics/usage?${params.toString()}`;
}

export function useAnalytics(days = 30, profileOverride?: string | null) {
  const activeProfile = useActiveProfileName();
  const profile = profileOverride || activeProfile;
  return useQuery<AnalyticsResponse>({
    queryKey: ["analytics", profile, days],
    queryFn: async ({ signal }) => {
      // 不直接用 schema 校验原始响应：内核版本差异会缺字段，
      // 先补默认值再交给协议校验，避免整页报「合约不匹配」。
      const raw = await fetchJSON<unknown>(analyticsPath(days, profileOverride), { signal });
      return normalizeAnalyticsPayload(raw);
    },
    staleTime: 60_000,
  });
}
