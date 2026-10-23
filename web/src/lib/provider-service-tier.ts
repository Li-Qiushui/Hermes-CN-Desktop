export const SERVICE_TIERS = ["standard", "fast", "ultrafast"] as const;

export type ServiceTier = (typeof SERVICE_TIERS)[number];

export const SERVICE_TIER_LABELS: Record<ServiceTier, string> = {
  standard: "标准",
  fast: "快速",
  ultrafast: "极速",
};

export const SERVICE_TIER_HINTS: Record<ServiceTier, string> = {
  standard: "服务商默认队列，不加价",
  fast: "优先处理（priority），按服务商计费",
  ultrafast: "OpenAI 极速档，仅部分模型支持",
};

const NORMAL_WORDS = new Set(["", "normal", "default", "standard", "off", "none", "auto", "cold"]);

const WORD_TO_TIER: Record<string, ServiceTier> = {
  fast: "fast",
  priority: "fast",
  on: "fast",
  ultrafast: "ultrafast",
  ultra: "ultrafast",
};

export function isServiceTier(value: unknown): value is ServiceTier {
  return typeof value === "string" && (SERVICE_TIERS as readonly string[]).includes(value);
}

export function normalizeServiceTier(value: unknown): ServiceTier {
  if (typeof value !== "string") return "standard";
  const word = value.trim().toLowerCase();
  if (NORMAL_WORDS.has(word)) return "standard";
  return WORD_TO_TIER[word] ?? "standard";
}

export function serviceTierFromConfig(
  config: Record<string, unknown> | undefined | null,
): ServiceTier {
  if (!config || typeof config !== "object") return "standard";
  const agent = (config as Record<string, unknown>)["agent"];
  if (!agent || typeof agent !== "object") return "standard";
  return normalizeServiceTier((agent as Record<string, unknown>)["service_tier"]);
}

export function serviceTierOptionList(): { value: ServiceTier; label: string; hint: string }[] {
  return SERVICE_TIERS.map((value) => ({
    value,
    label: SERVICE_TIER_LABELS[value],
    hint: SERVICE_TIER_HINTS[value],
  }));
}

export function buildServiceTierUpdate(
  config: Record<string, any> | undefined | null,
  tier: ServiceTier,
): Record<string, any> {
  const base = config && typeof config === "object" ? config : {};
  const agent = base.agent && typeof base.agent === "object" ? base.agent : {};
  return {
    ...base,
    agent: {
      ...agent,
      service_tier: isServiceTier(tier) ? tier : "standard",
    },
  };
}
