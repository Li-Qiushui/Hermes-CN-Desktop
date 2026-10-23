import { useState } from "react";
import { Pause, Play } from "lucide-react";
import { useMcpLogs } from "@/hooks/use-mcp";
import {
  filterLogLines,
  filterLogLinesForServer,
  findLogSource,
  MCP_LOG_POLL_MS,
  MCP_LOG_SOURCES,
  type McpLogSourceId,
} from "@/lib/mcp-logs";
import s from "./mcp.module.css";

export function McpLogPanel({ serverName }: { serverName: string }) {
  const [source, setSource] = useState<McpLogSourceId>("stdio");
  const [search, setSearch] = useState("");
  const [paused, setPaused] = useState(false);
  const state = useMcpLogs({ source, serverName, search, paused });
  const def = findLogSource(source);
  const scoped = filterLogLinesForServer(state.lines, serverName);
  const visible = filterLogLines(scoped, search);

  return (
    <div className={s.logPanel}>
      <div className={s.logBar}>
        <div className={s.logSources}>
          {MCP_LOG_SOURCES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={s.logSourceTab}
              data-active={source === item.id ? "1" : "0"}
              onClick={() => setSource(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <input
          className={s.logSearch}
          value={search}
          placeholder="搜索日志…"
          aria-label="搜索日志"
          onChange={(event) => setSearch(event.target.value)}
        />
        <button
          type="button"
          className={s.logPause}
          data-on={paused ? "1" : "0"}
          onClick={() => setPaused((prev) => !prev)}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
          {paused ? "继续跟随" : "暂停跟随"}
        </button>
      </div>

      <p className={s.logHint}>
        {def.hint}；每 {MCP_LOG_POLL_MS / 1000}s 轮询 /api/logs?file={def.file}
        {def.component ? `&component=${def.component}` : ""}
        {paused ? "（已暂停，显示暂停时那一帧）" : ""}
      </p>

      {state.error ? (
        <p className={s.logError}>{state.error}</p>
      ) : state.loading ? (
        <p className={s.logEmpty}>正在读取日志…</p>
      ) : visible.length === 0 ? (
        <p className={s.logEmpty}>
          {state.lines.length === 0
            ? "该日志源暂无内容（服务还没在这个 home 里跑起来过）"
            : "当前过滤条件没有命中，试试清空搜索或换日志源"}
        </p>
      ) : (
        <pre className={s.logBody}>
          {visible.slice(-400).map((line, index) => (
            <span key={`${index}-${line.slice(0, 24)}`} className={s.logLine}>
              {line}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}
