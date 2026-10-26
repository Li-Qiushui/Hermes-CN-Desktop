import { useLocation } from "react-router-dom";

export type TopTab =
  | "workbench"
  | "skills"
  | "hermesMemory"
  | "advanced";

export interface TopTabDef {
  id: TopTab;
  num: string;
  label: string;
  href: string;
  matches: (path: string) => boolean;
}

const isRoute = (path: string, route: string) => path === route || path.startsWith(`${route}/`);

const ADVANCED_ROUTES = [
  "/common",
  "/notifications",
  "/config",
  "/connection",
  "/kernel",
  "/env",
  "/about",
  "/advanced",
  "/settings",
] as const;

export const TOP_TABS: readonly TopTabDef[] = [
  {
    id: "workbench",
    num: "01",
    label: "工作台",
    href: "/",
    matches: (path) =>
      path === "/" ||
      path.startsWith("/new") ||
      path.startsWith("/tasks/") ||
      path.startsWith("/history") ||
      path.startsWith("/projects") ||
      path.startsWith("/kanban"),
  },
  {
    id: "skills",
    num: "02",
    label: "配置",
    href: "/models",
    matches: (path) =>
      path.startsWith("/capabilities") ||
      path.startsWith("/skills") ||
      path.startsWith("/mcp") ||
      path.startsWith("/profiles") ||
      path.startsWith("/models") ||
      path.startsWith("/soul") ||
      path.startsWith("/cron") ||
      path.startsWith("/console") ||
      path.startsWith("/coding-agents"),
  },
  {
    id: "hermesMemory",
    num: "03",
    label: "Hermes 记忆",
    href: "/memory",
    matches: (path) => ["/memory", "/memconfig", "/openviking", "/hindsight"].some((route) => isRoute(path, route)),
  },
  {
    id: "advanced",
    num: "04",
    label: "高级",
    href: "/health",
    matches: (path) =>
      path.startsWith("/health") ||
      path.startsWith("/analytics") ||
      path.startsWith("/logs") ||
      path.startsWith("/debug") ||
      path.startsWith("/theme") ||
      // 消息接入与 Wander 记忆已并入高级，顶栏不再单独占用 tab
      path.startsWith("/im") ||
      path.startsWith("/wander-memory") ||
      ADVANCED_ROUTES.some((route) => isRoute(path, route)),
  },
];

export function useActiveTopTab(): TopTab | null {
  const { pathname } = useLocation();
  const match = TOP_TABS.find((tab) => tab.matches(pathname));
  return match?.id ?? null;
}
