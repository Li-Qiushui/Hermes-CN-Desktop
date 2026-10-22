export type WanderMemoryListPhase = "offline" | "failed" | "empty" | "results";

export interface WanderMemoryListPhaseInput {
  offline: boolean;
  hasError: boolean;
  resultCount: number;
}

export function isWanderMemoryOffline(error: { code?: string } | null | undefined): boolean {
  return error?.code === "network_failure";
}

export function wanderMemoryListPhase({
  offline,
  hasError,
  resultCount,
}: WanderMemoryListPhaseInput): WanderMemoryListPhase {
  if (offline) return "offline";
  if (hasError) return "failed";
  return resultCount === 0 ? "empty" : "results";
}
