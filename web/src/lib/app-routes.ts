import type { CommandPaletteIconKey } from "@/lib/command-palette";

export interface AppRouteEntry {
  path: string;
  label: string;
  subtitle?: string;
  keywords: string[];
  icon: CommandPaletteIconKey;
}

export interface AppSettingsSection extends AppRouteEntry {
  slug: string;
  shortLabel: string;
}

function route(
  path: string,
  label: string,
  subtitle: string,
  keywords: string[],
  icon: CommandPaletteIconKey,
): AppRouteEntry {
  return { path, label, subtitle, keywords, icon };
}

export const APP_PAGE_ROUTES: readonly AppRouteEntry[] = [
  route("/", "工作台", "/ · 新建对话与最近任务", ["home", "workbench", "panel", "首页", "工作台", "新建"], "new"),
  route("/history", "对话历史", "/history · 搜索、归档和管理会话", ["history", "sessions", "archive", "历史", "会话"], "history"),
  route("/projects", "项目 / 工作空间", "/projects · 查看已登记项目", ["project", "workspace", "folder", "项目", "工作区"], "project"),
  route("/kanban", "看板 Kanban", "/kanban · 原生任务看板", ["kanban", "board", "看板"], "project"),
  route("/capabilities", "能力总览", "/capabilities · 工具集与能力面板", ["capabilities", "toolsets", "tool", "能力", "工具集"], "config"),
  route("/skills", "Skills 管理", "/skills · 启用、禁用和查看 Skill", ["skills", "skill", "技能"], "skill"),
  route("/models", "模型配置", "/models · Provider、模型与上下文", ["models", "provider", "llm", "模型"], "models"),
  route("/voice", "语音", "/voice · 语音输入与发音人", ["voice", "tts", "speech", "语音", "发音"], "config"),
  route("/mcp", "MCP 服务", "/mcp · 管理工具服务", ["mcp", "server", "工具服务"], "mcp"),
  route("/profiles", "档案 Profiles", "/profiles · 切换独立配置环境", ["profiles", "profile", "档案"], "profiles"),
  route("/profiles/new", "新建档案", "/profiles/new · 从模板起一个隔离环境", ["profile", "create", "new", "新建档案", "画像"], "profiles"),
  route("/memory", "内置记忆", "/memory · 管理 MEMORY.md 和 USER.md", ["memory", "MEMORY.md", "USER.md", "记忆"], "memory"),
  route("/memconfig", "外置记忆配置", "/memconfig · OpenViking / Hindsight", ["memory", "openviking", "hindsight", "外置记忆"], "memory"),
  route("/openviking", "OpenViking", "/openviking · 外置记忆后端", ["openviking", "memory", "外置记忆"], "memory"),
  route("/hindsight", "Hindsight", "/hindsight · 外置记忆后端", ["hindsight", "memory", "外置记忆"], "memory"),
  route("/soul", "人格市场与 SOUL.md", "/soul · 选择或编辑智能体人格", ["soul", "persona", "人格"], "soul"),
  route("/cron", "定时任务", "/cron · 查看和管理自动化任务", ["cron", "schedule", "定时"], "cron"),
  route("/im", "消息接入", "/im · 微信、飞书等渠道接入", ["im", "messaging", "weixin", "feishu", "消息接入", "渠道"], "config"),
  route("/console", "Hermes Console", "/console · 运行 Hermes 命令", ["console", "terminal", "终端", "命令行"], "console"),
  route("/coding-agents", "编码代理", "/coding-agents · Claude Code / Codex 委派", ["coding agents", "claude code", "codex", "编码代理"], "console"),
  route("/health", "健康检查", "/health · Dashboard、模型、环境和扩展状态", ["health", "diagnostics", "健康"], "health"),
  route("/analytics", "数据分析", "/analytics · Tokens、模型和会话统计", ["analytics", "usage", "tokens", "统计"], "analytics"),
  route("/logs", "日志", "/logs · 查看运行日志", ["logs", "log", "日志"], "file"),
  route("/debug", "Debug 面板", "/debug · 导出调试包和排查问题", ["debug", "bundle", "调试"], "debug"),
];

export const APP_SETTINGS_SECTIONS: readonly AppSettingsSection[] = [
  {
    slug: "common",
    shortLabel: "常规",
    path: "/common",
    label: "设置 · 常规",
    subtitle: "/settings/common · 启动行为与界面默认项",
    keywords: ["settings", "common", "general", "设置", "常规"],
    icon: "settings",
  },
  {
    slug: "notifications",
    shortLabel: "通知",
    path: "/notifications",
    label: "设置 · 通知",
    subtitle: "/settings/notifications · 完成提醒与声音",
    keywords: ["settings", "notifications", "alert", "通知", "提醒"],
    icon: "settings",
  },
  {
    slug: "theme",
    shortLabel: "主题",
    path: "/theme",
    label: "设置 · 主题外观",
    subtitle: "/settings/theme · 明暗、配色与字体",
    keywords: ["settings", "theme", "appearance", "dark", "主题", "外观", "配色"],
    icon: "settings",
  },
  {
    slug: "config",
    shortLabel: "配置",
    path: "/config",
    label: "设置 · 配置",
    subtitle: "/settings/config · config.yaml 可视化编辑",
    keywords: ["settings", "config", "yaml", "配置"],
    icon: "config",
  },
  {
    slug: "connection",
    shortLabel: "连接",
    path: "/connection",
    label: "设置 · 连接",
    subtitle: "/settings/connection · 内核地址、令牌与远程模式",
    keywords: ["settings", "connection", "gateway", "token", "连接", "令牌"],
    icon: "config",
  },
  {
    slug: "kernel",
    shortLabel: "内核",
    path: "/kernel",
    label: "设置 · 内核",
    subtitle: "/settings/kernel · Hermes 内核版本与重启",
    keywords: ["settings", "kernel", "restart", "内核", "重启"],
    icon: "config",
  },
  {
    slug: "env",
    shortLabel: "环境",
    path: "/env",
    label: "设置 · 环境变量",
    subtitle: "/settings/env · 内核继承的环境变量",
    keywords: ["settings", "env", "environment", "环境变量"],
    icon: "config",
  },
  {
    slug: "about",
    shortLabel: "关于",
    path: "/about",
    label: "设置 · 关于",
    subtitle: "/settings/about · 版本、构建与许可",
    keywords: ["settings", "about", "version", "关于", "版本"],
    icon: "settings",
  },
];

const SETTINGS_DEEP_LINK_PREFIX = "/settings/";

export function settingsDeepLink(slug: string): string {
  const clean = slug.trim().replace(/^\/+/, "").replace(/^settings\//, "");
  const known = APP_SETTINGS_SECTIONS.some((section) => section.slug === clean);
  return `${SETTINGS_DEEP_LINK_PREFIX}${known ? clean : APP_SETTINGS_SECTIONS[0].slug}`;
}

export function settingsSectionForSlug(slug: string | undefined): AppSettingsSection | null {
  const clean = (slug ?? "").trim().replace(/^\/+/, "");
  if (!clean) return null;
  return APP_SETTINGS_SECTIONS.find((section) => section.slug === clean) ?? null;
}

export function settingsRouteForSlug(slug: string | undefined): string {
  return settingsSectionForSlug(slug)?.path ?? APP_SETTINGS_SECTIONS[0].path;
}
