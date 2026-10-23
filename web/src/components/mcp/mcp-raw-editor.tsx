import { useEffect, useMemo, useState } from "react";
import { Button } from "@hermes/shared-ui";
import { formatMcpServersJson, validateMcpServersJson } from "@/lib/mcp-json";
import s from "./mcp.module.css";

export function McpRawEditor({
  servers,
  saving,
  onSave,
}: {
  servers: unknown;
  saving: boolean;
  onSave: (value: Record<string, Record<string, unknown>>) => void;
}) {
  const initial = useMemo(() => formatMcpServersJson(servers), [servers]);
  const [text, setText] = useState(initial);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setText(initial);
  }, [initial, dirty]);

  const parsed = validateMcpServersJson(text);

  return (
    <div className={s.rawPanel}>
      <div className={s.rawBar}>
        <span className={s.rawTitle}>mcpServers（整块编辑）</span>
        <span className={s.rawState} data-ok={parsed.ok ? "1" : "0"}>
          {parsed.ok ? `${Object.keys(parsed.value).length} 个服务 · JSON 校验通过` : "JSON 有误"}
        </span>
        <span className={s.rawActions}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setText(formatMcpServersJson(servers));
              setDirty(false);
            }}
          >
            放弃修改
          </Button>
          <Button
            variant="solid"
            tone="accent"
            size="sm"
            disabled={saving || !parsed.ok}
            loading={saving}
            onClick={() => {
              if (parsed.ok) onSave(parsed.value);
            }}
          >
            保存 JSON
          </Button>
        </span>
      </div>

      <textarea
        className={s.rawArea}
        spellCheck={false}
        aria-label="mcpServers JSON"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setDirty(true);
        }}
      />

      {!parsed.ok && <p className={s.rawError}>{parsed.message}</p>}
      <p className={s.rawHint}>
        保存走 PUT /api/mcp/servers：整块替换 mcp_servers，删掉的条目会真的消失；
        密钥请保留 {"${环境变量}"} 形式，粘贴明文会直接落到 config.yaml。
      </p>
    </div>
  );
}
