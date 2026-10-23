import { useState } from "react";
import { Button } from "@hermes/shared-ui";
import { readToolFilter } from "@/lib/mcp-tools";
import { estimateContextCost } from "@/lib/mcp-status";
import type { McpServerWire, McpTestWire } from "@/lib/mcp-wire";
import { McpLogPanel } from "./mcp-log-panel";
import { McpRawEditor } from "./mcp-raw-editor";
import { McpToolList } from "./mcp-tool-list";
import s from "./mcp.module.css";

type Tab = "tools" | "logs" | "raw";

const TABS: { id: Tab; label: string }[] = [
  { id: "tools", label: "工具" },
  { id: "logs", label: "日志" },
  { id: "raw", label: "原始 JSON" },
];

export function McpServerDetail({
  server,
  result,
  testing,
  savingTools,
  rawServers,
  savingRaw,
  onTest,
  onToggleTool,
  onSaveRaw,
}: {
  server: McpServerWire;
  result?: McpTestWire;
  testing: boolean;
  savingTools: boolean;
  rawServers: Record<string, unknown> | undefined;
  savingRaw: boolean;
  onTest: () => void;
  onToggleTool: (name: string, enabled: boolean) => void;
  onSaveRaw: (value: Record<string, Record<string, unknown>>) => void;
}) {
  const [tab, setTab] = useState<Tab>("tools");
  const filter = readToolFilter(server.tools);
  const tools = result?.ok ? result.tools : [];
  const cost = estimateContextCost(tools);

  return (
    <div className={s.detailPanel}>
      <div className={s.detailTabs}>
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={s.detailTab}
            data-active={tab === item.id ? "1" : "0"}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
        <span className={s.detailCost}>
          {tools.length > 0 ? `${tools.length} 个工具 · ${cost.label} 上下文占用` : "尚未测试，成本未知"}
        </span>
      </div>

      {tab === "tools" && (
        result?.ok ? (
          <McpToolList
            tools={tools}
            filter={filter}
            busy={savingTools}
            onToggle={onToggleTool}
          />
        ) : (
          <div className={s.detailEmpty}>
            {result && !result.ok ? (
              <p className={s.testErr}>{result.error ?? "连接失败"}</p>
            ) : (
              <p>先测试连接才能列出该服务的工具，之后可逐行开关。</p>
            )}
            <Button variant="outline" size="sm" loading={testing} onClick={onTest}>
              测试连接并列出工具
            </Button>
          </div>
        )
      )}

      {tab === "logs" && <McpLogPanel serverName={server.name} />}

      {tab === "raw" && (
        rawServers ? (
          <McpRawEditor servers={rawServers} saving={savingRaw} onSave={onSaveRaw} />
        ) : (
          <p className={s.detailEmpty}>读取 mcp_servers 配置中…</p>
        )
      )}
    </div>
  );
}
