export type SourceGroup = "builtin" | "im" | "webhook";

export interface SourceMeta {
  key: string;
  label: string;
  group: SourceGroup;
  tone: string;
}

const KNOWN: Record<string, Omit<SourceMeta, "key">> = {
  web: { label: "网页", group: "builtin", tone: "web" },
  cli: { label: "CLI", group: "builtin", tone: "cli" },
  tui: { label: "TUI", group: "builtin", tone: "tui" },
  dashboard: { label: "Dashboard 嵌入", group: "builtin", tone: "dashboard" },
  api: { label: "API", group: "builtin", tone: "cli" },
  desktop: { label: "桌面端", group: "builtin", tone: "dashboard" },
  kanban: { label: "看板", group: "builtin", tone: "tui" },
  wechat: { label: "微信", group: "im", tone: "wechat" },
  weixin: { label: "微信", group: "im", tone: "wechat" },
  feishu: { label: "飞书", group: "im", tone: "feishu" },
  lark: { label: "Lark", group: "im", tone: "feishu" },
  telegram: { label: "电报", group: "im", tone: "tg" },
  slack: { label: "Slack", group: "im", tone: "slack" },
  discord: { label: "Discord", group: "im", tone: "discord" },
  whatsapp: { label: "WhatsApp", group: "im", tone: "whatsapp" },
  dingtalk: { label: "钉钉", group: "im", tone: "dingtalk" },
};

export function getSourceMeta(source: string | undefined | null): SourceMeta {
  const key = (source ?? "").trim().toLowerCase();
  if (!key) return { key: "unknown", label: "未知", group: "builtin", tone: "unknown" };
  const known = KNOWN[key];
  if (known) return { key, ...known };
  return { key, label: source ?? key, group: "webhook", tone: "custom" };
}

export function groupSourcesByCategory(
  sources: ReadonlyArray<{ key: string; count: number }>,
): Array<{ group: SourceGroup; label: string; items: SourceMeta[] }> {
  const groupOrder: SourceGroup[] = ["builtin", "im", "webhook"];
  const groupLabels: Record<SourceGroup, string> = {
    builtin: "内置",
    im: "即时通讯",
    webhook: "自定义 Webhook",
  };
  const buckets: Record<SourceGroup, SourceMeta[]> = {
    builtin: [],
    im: [],
    webhook: [],
  };
  for (const { key } of sources) {
    const meta = getSourceMeta(key);
    buckets[meta.group].push(meta);
  }
  return groupOrder
    .filter((g) => buckets[g].length > 0)
    .map((g) => ({ group: g, label: groupLabels[g], items: buckets[g] }));
}
