import { useCallback, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, Search, SlidersHorizontal } from "lucide-react";
import { useToggleToolset, useToolsets } from "@/hooks/use-toolsets";
import {
  enabledToolsetCount,
  filterToolsets,
  groupToolsets,
  toolCountLabel,
  toolsetLabel,
  visibleToolsetCount,
  type ToolsetInfo,
} from "@/lib/toolsets";
import { SectionShell } from "./section-shell";
import s from "./capabilities.module.css";

interface RowError {
  name: string;
  message: string;
}

function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={s.switch}
      data-on={checked ? "true" : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className={s.switchThumb} aria-hidden="true" />
    </button>
  );
}

export function CapabilitiesRoute() {
  const toolsetsQuery = useToolsets();
  const toggle = useToggleToolset();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<RowError | null>(null);

  const toolsets = toolsetsQuery.data ?? [];
  const total = visibleToolsetCount(toolsets);
  const enabled = enabledToolsetCount(toolsets);
  const groups = useMemo(() => groupToolsets(filterToolsets(toolsets, query)), [toolsets, query]);
  const matched = groups.reduce((sum, group) => sum + group.items.length, 0);

  const handleToggle = useCallback(
    (toolset: ToolsetInfo, next: boolean) => {
      setRowError(null);
      toggle.mutate(
        { name: toolset.name, enabled: next },
        {
          onError: (error) =>
            setRowError({ name: toolsetLabel(toolset), message: error.message || "未知错误" }),
        },
      );
    },
    [toggle],
  );

  const sub = toolsetsQuery.isError
    ? "未接入"
    : toolsetsQuery.data
      ? `${enabled} / ${total} 已启用`
      : "加载中…";

  const right = (
    <button
      type="button"
      className={s.refreshButton}
      onClick={() => void toolsetsQuery.refetch()}
      disabled={toolsetsQuery.isFetching}
    >
      <RefreshCw size={13} />
      刷新
    </button>
  );

  const searchRow = (
    <div className={s.searchRow}>
      <Search size={14} className={s.searchIcon} aria-hidden="true" />
      <input
        type="search"
        className={s.searchInput}
        value={query}
        placeholder="搜索工具集 / 工具名"
        aria-label="搜索工具集"
        onChange={(event) => setQuery(event.target.value)}
      />
      <span className={s.searchCount}>
        {query.trim() ? `${matched} / ${total}` : `${total} 组`}
      </span>
    </div>
  );

  return (
    <SectionShell title="能力与工具集" sub={sub} right={right}>
      <div className={s.page}>
        {searchRow}

        <p className={s.hint}>
          <SlidersHorizontal size={13} aria-hidden="true" />
          开关直接写入内核配置（platform_toolsets），保存后下一轮对话生效；未启用的工具集不会向 Agent 注册任何工具。
        </p>

        {rowError ? (
          <div className={s.alert} role="alert">
            <span>
              切换「{rowError.name}」失败：{rowError.message}
            </span>
            <button type="button" className={s.alertClose} onClick={() => setRowError(null)}>
              关闭
            </button>
          </div>
        ) : null}

        {toolsetsQuery.isLoading && toolsets.length === 0 ? (
          <div className={s.skeleton} role="status">
            <span>正在读取工具集…</span>
            <span className={s.skeletonRow} aria-hidden="true" />
            <span className={s.skeletonRow} aria-hidden="true" />
            <span className={s.skeletonRow} aria-hidden="true" />
          </div>
        ) : toolsetsQuery.isError && toolsets.length === 0 ? (
          <div className={s.alert} role="alert">
            <span>工具集列表加载失败</span>
            <button type="button" className={s.alertClose} onClick={() => void toolsetsQuery.refetch()}>
              重试
            </button>
          </div>
        ) : groups.length === 0 ? (
          <div className={s.empty}>没有匹配的工具集</div>
        ) : (
          groups.map((group) => (
            <section className={s.group} key={group.id} data-group={group.id}>
              <header className={s.groupHeader}>
                <span className={s.groupLabel}>{group.label}</span>
                <span className={s.groupCount}>{group.items.length}</span>
              </header>
              <ul className={s.list}>
                {group.items.map((toolset) => {
                  const open = expanded[toolset.name] === true;
                  const busy = toggle.isPending && toggle.variables?.name === toolset.name;
                  return (
                    <li className={s.row} key={toolset.name} data-enabled={toolset.enabled ? "true" : undefined}>
                      <button
                        type="button"
                        className={s.rowMain}
                        aria-expanded={open}
                        onClick={() =>
                          setExpanded((current) => ({ ...current, [toolset.name]: !open }))
                        }
                      >
                        <span className={s.rowHead}>
                          <span className={s.rowChevron} aria-hidden="true">
                            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          </span>
                          <span className={s.rowName}>{toolsetLabel(toolset)}</span>
                          <code className={s.rowSlug}>{toolset.name}</code>
                          <span
                            className={s.rowTag}
                            data-variant={toolset.configured ? "ok" : "warn"}
                            title={toolset.configured ? "凭证/依赖已就绪" : "需要填密钥或装依赖后才能用"}
                          >
                            {toolset.configured ? "已配置" : "未配置"}
                          </span>
                        </span>
                        {toolset.description ? <span className={s.rowDesc}>{toolset.description}</span> : null}
                        {open ? (
                          <span className={s.toolNames}>
                            {toolset.tools.length > 0 ? toolset.tools.join(" · ") : "该工具集当前没有注册工具"}
                          </span>
                        ) : null}
                      </button>
                      <span className={s.rowMeta} title={toolset.tools.join(", ")}>
                        {toolCountLabel(toolset.tools.length)}
                      </span>
                      <Switch
                        checked={toolset.enabled}
                        disabled={busy}
                        label={`${toolset.enabled ? "停用" : "启用"}${toolsetLabel(toolset)}`}
                        onChange={(next) => handleToggle(toolset, next)}
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </SectionShell>
  );
}
