export interface FallbackEntry extends Record<string, unknown> {
  provider: string;
  model: string;
}

export function normalizeFallbackEntries(value: unknown): FallbackEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return {
        ...record,
        provider: String(record.provider ?? ""),
        model: String(record.model ?? ""),
      };
    }
    if (typeof item === "string") {
      const trimmed = item.trim();
      const slash = trimmed.indexOf("/");
      return slash > 0
        ? { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) }
        : { provider: "", model: trimmed };
    }
    return { provider: "", model: "" };
  });
}

export function isFallbackEntryComplete(entry: FallbackEntry): boolean {
  return Boolean(entry.provider.trim() && entry.model.trim());
}

export function completeFallbackEntries(rows: readonly FallbackEntry[]): FallbackEntry[] {
  return rows
    .filter(isFallbackEntryComplete)
    .map((entry) => ({ ...entry, provider: entry.provider.trim(), model: entry.model.trim() }));
}

export function fallbackEntriesEqual(a: readonly FallbackEntry[], b: readonly FallbackEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => JSON.stringify(entry) === JSON.stringify(b[index]));
}

export function updateFallbackEntry(
  rows: readonly FallbackEntry[],
  index: number,
  patch: Partial<FallbackEntry>,
): FallbackEntry[] {
  return rows.map((entry, position) => (position === index ? { ...entry, ...patch } : entry));
}

export function removeFallbackEntry(rows: readonly FallbackEntry[], index: number): FallbackEntry[] {
  return rows.filter((_entry, position) => position !== index);
}

export function moveFallbackEntry(
  rows: readonly FallbackEntry[],
  index: number,
  delta: -1 | 1,
): FallbackEntry[] {
  const target = index + delta;
  if (index < 0 || index >= rows.length || target < 0 || target >= rows.length) {
    return [...rows];
  }
  const next = [...rows];
  const [entry] = next.splice(index, 1);
  next.splice(target, 0, entry);
  return next;
}

export function appendFallbackEntry(rows: readonly FallbackEntry[], entry?: Partial<FallbackEntry>): FallbackEntry[] {
  return [...rows, { provider: "", model: "", ...entry }];
}

export function buildFallbackProvidersUpdate(
  config: Record<string, any> | undefined | null,
  rows: readonly FallbackEntry[],
): Record<string, any> {
  const base = config && typeof config === "object" ? config : {};
  return { ...base, fallback_providers: completeFallbackEntries(rows) };
}

export function describeFallbackEntry(entry: FallbackEntry, names: Record<string, string>): string {
  const provider = entry.provider.trim();
  const model = entry.model.trim();
  if (!provider && !model) return "未填写";
  const label = names[provider] ?? provider;
  return model ? `${label} · ${model}` : label;
}
