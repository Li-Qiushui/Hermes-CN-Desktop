import { useActiveTopTab } from "./use-active-top-tab";
import { WorkbenchSidebar } from "./workbench-sidebar";
import { CapabilitySidebar } from "./capability-sidebar";
import { ExternalMemorySidebar } from "./external-memory-sidebar";
import { AdvancedSidebar } from "./advanced-sidebar";
import { PlaceholderSidebar } from "./placeholder-sidebar";

export function AppSidebar() {
  const tab = useActiveTopTab();
  if (tab === "workbench") return <WorkbenchSidebar />;
  if (tab === "skills") return <CapabilitySidebar />;
  if (tab === "hermesMemory") return <ExternalMemorySidebar />;
  // 消息接入与 Wander 记忆已并入高级，侧栏统一由高级侧栏呈现（各自成块）
  if (tab === "advanced") return <AdvancedSidebar />;
  return <PlaceholderSidebar tab={tab} />;
}
