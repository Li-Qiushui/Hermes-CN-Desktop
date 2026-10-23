export interface CronDeliveryTarget {
  id: string;
  name: string;
  homeTargetSet: boolean;
  homeEnvVar: string | null;
}

export const FALLBACK_DELIVERY_TARGETS: ReadonlyArray<CronDeliveryTarget> = [
  { id: "local", name: "本地", homeTargetSet: true, homeEnvVar: null },
  { id: "feishu", name: "飞书", homeTargetSet: true, homeEnvVar: null },
  { id: "weixin", name: "微信", homeTargetSet: true, homeEnvVar: null },
  { id: "email", name: "Email", homeTargetSet: true, homeEnvVar: null },
];

const TARGET_LABELS: Record<string, string> = {
  local: "本地（仅保存）",
  feishu: "飞书",
  weixin: "微信",
  email: "Email",
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  dingtalk: "钉钉",
  matrix: "Matrix",
  signal: "Signal",
  whatsapp: "WhatsApp",
  line: "LINE",
};

export function deliveryTargetLabel(id: string): string {
  if (!id) return "本地（仅保存）";
  if (TARGET_LABELS[id]) return TARGET_LABELS[id];
  const botChat = /^bot_chat:(.+)$/.exec(id);
  if (botChat) return `Bot Chat（${botChat[1]}）`;
  return id;
}

export function targetLabel(target: CronDeliveryTarget): string {
  if (target.id === "local") return deliveryTargetLabel("local");
  const base = TARGET_LABELS[target.id] ?? target.name ?? target.id;
  return target.homeTargetSet ? base : `${base} — 需先设置 home 频道`;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function deliveryTargetsFromPayload(payload: unknown): CronDeliveryTarget[] {
  if (!payload || typeof payload !== "object") return [];
  const raw = (payload as { targets?: unknown }).targets;
  if (!Array.isArray(raw)) return [];

  const targets: CronDeliveryTarget[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = asText(record.id);
    if (!id) continue;
    const envVar = asText(record.home_env_var);
    targets.push({
      id,
      name: asText(record.name) || deliveryTargetLabel(id),
      homeTargetSet: record.home_target_set !== false,
      homeEnvVar: envVar || null,
    });
  }
  return targets;
}

export function parseCronDeliveryTargets(value: string | null | undefined): string[] {
  const targets = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return targets.length > 0 ? [...new Set(targets)] : ["local"];
}

export function toggleCronDeliveryTarget(value: string, target: string, checked: boolean): string {
  const targets = parseCronDeliveryTargets(value);
  if (checked) {
    return targets.includes(target) ? targets.join(",") : [...targets, target].join(",");
  }
  if (!targets.includes(target) || targets.length === 1) {
    return targets.join(",");
  }
  return targets.filter((candidate) => candidate !== target).join(",");
}

export function deliverySummary(value: string | null | undefined): string {
  return parseCronDeliveryTargets(value).map(deliveryTargetLabel).join("、");
}

export function deliveryTargetsWithSelection(
  available: ReadonlyArray<CronDeliveryTarget>,
  value: string | null | undefined,
): CronDeliveryTarget[] {
  const known = new Set(available.map((target) => target.id));
  const extras = parseCronDeliveryTargets(value)
    .filter((id) => !known.has(id))
    .map((id) => ({ id, name: deliveryTargetLabel(id), homeTargetSet: true, homeEnvVar: null }));
  return [...available, ...extras];
}
