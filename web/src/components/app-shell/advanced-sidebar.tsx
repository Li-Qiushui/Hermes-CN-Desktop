import { useLocation, useNavigate } from "react-router-dom";
import {
  BarChart3,
  Bell,
  Bug,
  Cable,
  FileCog,
  FileText,
  HeartPulse,
  Info,
  MonitorCog,
  Palette,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { IM_ITEMS } from "./gateway-sidebar";
import { WANDER_MEMORY_ITEMS } from "./wander-memory-sidebar";
import s from "./debug-sidebar.module.css";

interface AdvancedItem {
  label: string;
  path: string;
  icon: LucideIcon;
  title?: string;
}

const OBSERVABILITY_ITEMS: readonly AdvancedItem[] = [
  { label: "健康", path: "/health", icon: HeartPulse, title: "健康检查" },
  { label: "分析", path: "/analytics", icon: BarChart3, title: "数据分析" },
  { label: "日志", path: "/logs", icon: FileText, title: "日志" },
  { label: "调试", path: "/debug", icon: Bug, title: "Debug 调试台" },
];

const ADVANCED_ITEMS: readonly AdvancedItem[] = [
  { label: "常规", path: "/common", icon: SlidersHorizontal, title: "常规设置" },
  { label: "通知", path: "/notifications", icon: Bell, title: "通知设置" },
  { label: "主题", path: "/theme", icon: Palette, title: "主题外观" },
  { label: "配置", path: "/config", icon: FileCog, title: "配置" },
  { label: "连接", path: "/connection", icon: Cable, title: "连接" },
  { label: "环境", path: "/env", icon: MonitorCog, title: "环境变量" },
  { label: "关于", path: "/about", icon: Info, title: "关于" },
];

/**
 * 消息接入与 Wander 记忆并入高级后，各自的二级入口仍按原样成块展示，
 * 而不是压成两个单条 —— 侧栏结构要和进入页面后能看到的东西一致。
 */
const SECTIONS: readonly {
  label: string;
  items: readonly AdvancedItem[];
}[] = [
  { label: "可观测", items: OBSERVABILITY_ITEMS },
  { label: "高级", items: ADVANCED_ITEMS },
  { label: "消息接入", items: IM_ITEMS },
  { label: "Wander 记忆", items: WANDER_MEMORY_ITEMS },
];

export function AdvancedSidebar() {
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(`${path}/`);

  return (
    <aside className={s.sidebar} aria-label="高级侧栏">
      <div className={s.scrollY}>
        {SECTIONS.map((section) => (
          <section key={section.label} className={s.section}>
            <div className={s.label}>
              <span>{section.label}</span>
  
            </div>
            {section.items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.path}
                  type="button"
                  className={s.item}
                  data-active={isActive(item.path) ? "true" : undefined}
                  onClick={() => navigate(item.path)}
                  title={item.title ?? item.path}
                >
                  <span className={s.itemIcon}>
                    <Icon size={16} />
                  </span>
                  <span className={s.itemLabel}>{item.label}</span>
                  <span className={s.itemPath}>{item.path}</span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
}
