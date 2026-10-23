import { useState } from "react";
import { Info } from "lucide-react";
import { useToggleToolset, useToolsets } from "@/hooks/use-toolsets";
import { shouldPromptKanbanToolset } from "@/lib/toolsets";
import s from "./toolset-notice.module.css";

const DISMISS_KEY = "kanban:toolset-notice-dismissed";

function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // 存储不可用就当没记住，下次再提示一次，不影响功能
  }
}

// 看板面板与内核 kanban 工具集联动：面板能用不代表 Agent 有 kanban_* 工具。
// 这里只提示 + 一键开启，绝不静默改配置。
export function KanbanToolsetNotice() {
  const toolsetsQuery = useToolsets();
  const toggle = useToggleToolset();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [error, setError] = useState<string | null>(null);

  if (!toolsetsQuery.data) return null;
  if (!shouldPromptKanbanToolset(toolsetsQuery.data, dismissed)) return null;

  const enable = () => {
    setError(null);
    toggle.mutate(
      { name: "kanban", enabled: true },
      { onError: (err) => setError(err.message || "未知错误") },
    );
  };

  const dismiss = () => {
    writeDismissed();
    setDismissed(true);
  };

  return (
    <div className={s.notice} role="status">
      <span className={s.icon} aria-hidden="true">
        <Info size={14} />
      </span>
      <div className={s.body}>
        <span className={s.title}>看板工具未开启</span>
        <span className={s.text}>
          看板面板可用，但 Agent 拿不到 kanban_* 工具。开启后写入内核 platform_toolsets，下一轮对话生效。
        </span>
        {error ? (
          <span className={s.error} role="alert">
            开启失败：{error}
          </span>
        ) : null}
      </div>
      <div className={s.actions}>
        <button type="button" className={s.primary} onClick={enable} disabled={toggle.isPending}>
          {toggle.isPending ? "开启中…" : "开启"}
        </button>
        <button type="button" className={s.ghost} onClick={dismiss}>
          稍后
        </button>
      </div>
    </div>
  );
}
