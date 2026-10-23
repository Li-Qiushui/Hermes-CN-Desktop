import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Select } from "@hermes/shared-ui";
import {
  appendFallbackEntry,
  completeFallbackEntries,
  fallbackEntriesEqual,
  moveFallbackEntry,
  normalizeFallbackEntries,
  removeFallbackEntry,
  updateFallbackEntry,
  type FallbackEntry,
} from "@/lib/provider-fallback";
import s from "./model-tuning.module.css";

export interface FallbackProviderOption {
  id: string;
  name: string;
}

export interface FallbackModelsEditorProps {
  value: unknown;
  providers: FallbackProviderOption[];
  modelOptionsFor: (provider: string) => string[];
  saving?: boolean;
  error?: string;
  savedHint?: string;
  disabled?: boolean;
  onSave: (entries: FallbackEntry[]) => void | Promise<void>;
}

export function FallbackModelsEditor({
  value,
  providers,
  modelOptionsFor,
  saving = false,
  error,
  savedHint,
  disabled,
  onSave,
}: FallbackModelsEditorProps) {
  const [rows, setRows] = useState<FallbackEntry[]>(() => normalizeFallbackEntries(value));
  const lastEmittedRef = useRef<FallbackEntry[]>(normalizeFallbackEntries(value));
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const persisted = normalizeFallbackEntries(value);
    if (fallbackEntriesEqual(persisted, lastEmittedRef.current)) return;
    lastEmittedRef.current = persisted;
    setRows(persisted);
    setDirty(false);
  }, [value]);

  const providerNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const provider of providers) names[provider.id] = provider.name;
    return names;
  }, [providers]);

  const commit = (next: FallbackEntry[]) => {
    setRows(next);
    setDirty(true);
  };

  const handleSave = async () => {
    const complete = completeFallbackEntries(rows);
    lastEmittedRef.current = complete;
    setDirty(false);
    await onSave(complete);
  };

  return (
    <section className={s.panel} aria-label="备用模型链">
      <div className={s.head}>
        <div className={s.title}>备用模型链</div>
        <div className={s.headHint}>主模型失败时按顺序尝试，写入 fallback_providers</div>
      </div>
      {rows.length === 0 ? (
        <div className={s.empty}>还没有备用模型。主模型不可用时会直接报错。</div>
      ) : (
        <div className={s.entries}>
          {rows.map((entry, index) => {
            const models = modelOptionsFor(entry.provider);
            const modelOptions = models.includes(entry.model) || !entry.model
              ? models
              : [entry.model, ...models];
            return (
              <div className={s.entryRow} key={`${index}-${entry.provider}`}>
                <span className={s.entryIndex}>{index + 1}</span>
                <Select
                  aria-label={`备用提供商 ${index + 1}`}
                  value={entry.provider}
                  disabled={disabled || saving}
                  onChange={(event) =>
                    commit(updateFallbackEntry(rows, index, { provider: event.target.value, model: "" }))
                  }
                >
                  <option value="">选择服务商</option>
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                  {entry.provider && !providerNames[entry.provider] && (
                    <option value={entry.provider}>{entry.provider}</option>
                  )}
                </Select>
                <Select
                  aria-label={`备用模型 ${index + 1}`}
                  value={entry.model}
                  disabled={disabled || saving || !entry.provider}
                  onChange={(event) => commit(updateFallbackEntry(rows, index, { model: event.target.value }))}
                >
                  <option value="">选择模型</option>
                  {modelOptions.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </Select>
                <div className={s.entryActions}>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`上移第 ${index + 1} 条`}
                    disabled={disabled || saving || index === 0}
                    onClick={() => commit(moveFallbackEntry(rows, index, -1))}
                  >
                    上移
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`下移第 ${index + 1} 条`}
                    disabled={disabled || saving || index === rows.length - 1}
                    onClick={() => commit(moveFallbackEntry(rows, index, 1))}
                  >
                    下移
                  </Button>
                  <Button
                    variant="outline"
                    tone="danger"
                    size="sm"
                    aria-label={`删除第 ${index + 1} 条`}
                    disabled={disabled || saving}
                    onClick={() => commit(removeFallbackEntry(rows, index))}
                  >
                    删除
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className={s.footer}>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || saving}
          onClick={() => commit(appendFallbackEntry(rows))}
        >
          添加备用
        </Button>
        <Button
          variant="solid"
          tone="accent"
          loading={saving}
          disabled={disabled || saving || !dirty}
          onClick={() => void handleSave()}
        >
          保存备用链
        </Button>
        {error ? (
          <span className={s.error} role="alert">
            {error}
          </span>
        ) : savedHint ? (
          <span className={s.saved}>{savedHint}</span>
        ) : (
          <span className={s.status}>未填完的行不会写入配置</span>
        )}
      </div>
    </section>
  );
}
