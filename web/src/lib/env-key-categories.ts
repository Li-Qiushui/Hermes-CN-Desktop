export type EnvKeyCategory = "tool" | "gateway";

export interface EnvKeyClassifiable {
  category?: string;
  provider?: string | null;
  channel_managed?: boolean;
}

export interface EnvKeyEntry<T> {
  key: string;
  info: T;
}

const GATEWAY_KEY_PREFIX = /^(HERMES_|GATEWAY_|DESKTOP_|MCP_|SERVER_|WEBHOOK_)/;
const GATEWAY_KEY_SUFFIX = /_(BASE_URL|ENDPOINT|HOST|PORT|URL)$/;

export function classifyEnvKey(key: string, info: EnvKeyClassifiable): EnvKeyCategory | null {
  const upper = key.toUpperCase();
  const category = (info.category ?? "").toLowerCase();
  if (info.channel_managed) return "gateway";
  if (category === "tool") return "tool";
  if (GATEWAY_KEY_PREFIX.test(upper) || GATEWAY_KEY_SUFFIX.test(upper)) return "gateway";
  if (category === "service" || category === "server" || category === "gateway") return "gateway";
  return null;
}

export function groupEnvKeys<T extends EnvKeyClassifiable>(
  vars: Record<string, T>,
): { tool: EnvKeyEntry<T>[]; gateway: EnvKeyEntry<T>[] } {
  const tool: EnvKeyEntry<T>[] = [];
  const gateway: EnvKeyEntry<T>[] = [];
  for (const key of Object.keys(vars).sort((a, b) => a.localeCompare(b))) {
    const info = vars[key];
    const bucket = classifyEnvKey(key, info);
    if (bucket === "tool") tool.push({ key, info });
    else if (bucket === "gateway") gateway.push({ key, info });
  }
  return { tool, gateway };
}

export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "•".repeat(trimmed.length);
  return `${trimmed.slice(0, 4)}${"•".repeat(Math.min(12, trimmed.length - 8))}${trimmed.slice(-4)}`;
}
