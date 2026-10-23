import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJSON, putJSON } from "@/lib/transport";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { normalizeToolsets, patchToolsetEnabled, type ToolsetInfo } from "@/lib/toolsets";

export const TOOLSETS_QUERY_KEY = "toolsets-list";

export interface ToolsetToggleResponse {
  ok: boolean;
  name: string;
  platform: string;
  enabled: boolean;
  post_setup_started: string | null;
}

interface ToolsetToggleVars {
  name: string;
  enabled: boolean;
}

interface ToolsetToggleContext {
  previous: ToolsetInfo[] | undefined;
}

function scopedPath(path: string, profile: string): string {
  if (!profile || profile === "default") return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}profile=${encodeURIComponent(profile)}`;
}

export function toolsetsQueryKey(profile: string) {
  return [TOOLSETS_QUERY_KEY, profile] as const;
}

// GET /api/tools/toolsets 直接回数组（已实测），字段为 name/label/description/
// platform/platform_label/enabled/available/configured/tools。
export function useToolsets() {
  const profile = useActiveProfileName();
  return useQuery<ToolsetInfo[]>({
    queryKey: toolsetsQueryKey(profile),
    queryFn: async ({ signal }) => {
      const raw = await fetchJSON<unknown>(scopedPath("/api/tools/toolsets", profile), { signal });
      return normalizeToolsets(raw);
    },
    staleTime: 30_000,
  });
}

// 开关写回内核：乐观改缓存（行立即重绘），失败按 context 回滚并把错误抛给调用方，
// 成功不弹提示（连续拨开关时逐条 toast 太吵）。
export function useToggleToolset() {
  const qc = useQueryClient();
  const profile = useActiveProfileName();
  return useMutation<ToolsetToggleResponse, Error, ToolsetToggleVars, ToolsetToggleContext>({
    mutationFn: ({ name, enabled }) =>
      putJSON<ToolsetToggleResponse>(scopedPath(`/api/tools/toolsets/${encodeURIComponent(name)}`, profile), {
        enabled,
        ...(profile && profile !== "default" ? { profile } : {}),
      }),
    onMutate: async ({ name, enabled }) => {
      const key = toolsetsQueryKey(profile);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ToolsetInfo[]>(key);
      qc.setQueryData<ToolsetInfo[] | undefined>(key, (current) => patchToolsetEnabled(current, name, enabled));
      return { previous };
    },
    onError: (_error, _vars, context) => {
      const key = toolsetsQueryKey(profile);
      if (context?.previous) qc.setQueryData(key, context.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [TOOLSETS_QUERY_KEY] }),
  });
}
