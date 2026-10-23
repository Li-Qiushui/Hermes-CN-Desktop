import {
  enabledToolCount,
  isToolEnabled,
  toolFilterWritable,
  type McpToolFilter,
} from "@/lib/mcp-tools";
import { estimateToolTokens, formatTokenCount } from "@/lib/mcp-status";
import type { McpToolWire } from "@/lib/mcp-wire";
import s from "./mcp.module.css";

export function McpToolList({
  tools,
  filter,
  busy,
  onToggle,
}: {
  tools: McpToolWire[];
  filter: McpToolFilter;
  busy: boolean;
  onToggle: (name: string, enabled: boolean) => void;
}) {
  const names = tools.map((tool) => tool.name);
  const enabled = enabledToolCount(names, filter);
  const writable = toolFilterWritable(filter);

  return (
    <div className={s.toolPanel}>
      <div className={s.toolPanelHead}>
        <span className={s.toolPanelTitle}>
          工具 {enabled} / {tools.length} 启用
        </span>
        <span className={s.toolPanelHint}>禁用项写回 mcp_servers.&lt;名称&gt;.tools.exclude</span>
      </div>

      {!writable && (
        <p className={s.toolReadonly}>
          该服务用的是 tools.include 白名单（内核里白名单优先于黑名单），逐行开关不改动它；
          需要调整请走「原始 JSON」页。
        </p>
      )}

      <div className={s.toolRows}>
        {tools.map((tool) => {
          const on = isToolEnabled(tool.name, filter);
          const tokens = estimateToolTokens(tool);
          return (
            <div key={tool.name} className={s.toolRow} data-enabled={on ? "1" : "0"}>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={`${on ? "禁用" : "启用"}工具 ${tool.name}`}
                className={s.toolSwitch}
                data-on={on ? "1" : "0"}
                disabled={busy || !writable}
                onClick={() => onToggle(tool.name, !on)}
              >
                <span className={s.toolSwitchKnob} />
              </button>
              <div className={s.toolMeta}>
                <span className={s.toolName}>{tool.name}</span>
                {tool.description && <span className={s.toolDesc}>{tool.description}</span>}
              </div>
              <span className={s.toolCost} title={tool.schema_chars ? "按内核回传的 schema 字符数折算" : "按名称+描述长度估算"}>
                ~{formatTokenCount(tokens)}
              </span>
            </div>
          );
        })}
      </div>

      <p className={s.toolFootnote}>
        token 为估算：优先用测试返回的 schema 字符数 ÷ 4，缺省按名称与描述长度折算，仅供对比取舍。
      </p>
    </div>
  );
}
