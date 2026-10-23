import { describe, expect, it } from "vitest";
import {
  appendFallbackEntry,
  buildFallbackProvidersUpdate,
  completeFallbackEntries,
  describeFallbackEntry,
  fallbackEntriesEqual,
  moveFallbackEntry,
  normalizeFallbackEntries,
  removeFallbackEntry,
  updateFallbackEntry,
} from "./provider-fallback";

describe("provider-fallback", () => {
  it("normalizes dict entries and keeps hand-written routing keys", () => {
    const rows = normalizeFallbackEntries([
      { provider: "kimi", model: "kimi-k2", base_url: "http://127.0.0.1:8080/v1", key_env: "KIMI_KEY" },
      { provider: "zai", model: 11 },
    ]);

    expect(rows[0]).toEqual({
      provider: "kimi",
      model: "kimi-k2",
      base_url: "http://127.0.0.1:8080/v1",
      key_env: "KIMI_KEY",
    });
    expect(rows[1]).toEqual({ provider: "zai", model: "11" });
  });

  it("accepts legacy string entries and tolerates junk", () => {
    expect(normalizeFallbackEntries(["kimi/kimi-k2", "bare-model", 7, null])).toEqual([
      { provider: "kimi", model: "kimi-k2" },
      { provider: "", model: "bare-model" },
      { provider: "", model: "" },
      { provider: "", model: "" },
    ]);
    expect(normalizeFallbackEntries({ provider: "kimi" })).toEqual([]);
    expect(normalizeFallbackEntries(undefined)).toEqual([]);
  });

  it("drops half-filled rows so a partial pair never reaches config.yaml", () => {
    const rows = normalizeFallbackEntries([
      { provider: "kimi", model: "kimi-k2" },
      { provider: "zai", model: "" },
      { provider: "", model: "glm-5.1" },
    ]);

    expect(completeFallbackEntries(rows)).toEqual([{ provider: "kimi", model: "kimi-k2" }]);
  });

  it("adds, edits, removes and reorders rows", () => {
    const rows = normalizeFallbackEntries([
      { provider: "a", model: "m1" },
      { provider: "b", model: "m2" },
      { provider: "c", model: "m3" },
    ]);

    expect(appendFallbackEntry(rows, { provider: "d" })).toHaveLength(4);
    expect(appendFallbackEntry(rows)).toEqual([...rows, { provider: "", model: "" }]);
    expect(updateFallbackEntry(rows, 1, { model: "m2-new" })[1]).toEqual({
      provider: "b",
      model: "m2-new",
    });
    expect(removeFallbackEntry(rows, 0).map((entry) => entry.provider)).toEqual(["b", "c"]);
    expect(moveFallbackEntry(rows, 2, -1).map((entry) => entry.provider)).toEqual(["a", "c", "b"]);
    expect(moveFallbackEntry(rows, 0, 1).map((entry) => entry.provider)).toEqual(["b", "a", "c"]);
    expect(moveFallbackEntry(rows, 0, -1).map((entry) => entry.provider)).toEqual(["a", "b", "c"]);
    expect(moveFallbackEntry(rows, 2, 1).map((entry) => entry.provider)).toEqual(["a", "b", "c"]);
  });

  it("compares persisted vs draft chains", () => {
    const a = normalizeFallbackEntries([{ provider: "a", model: "m1" }]);
    expect(fallbackEntriesEqual(a, [{ provider: "a", model: "m1" }])).toBe(true);
    expect(fallbackEntriesEqual(a, [{ provider: "a", model: "m2" }])).toBe(false);
    expect(fallbackEntriesEqual(a, [])).toBe(false);
  });

  it("builds the PUT payload in chain order and keeps the rest of the config", () => {
    const config = {
      model: { default: "deepseek-v4-flash" },
      fallback_providers: [{ provider: "old", model: "old-model" }],
      agent: { max_turns: 160 },
    };
    const rows = normalizeFallbackEntries([
      { provider: "c", model: "m3", base_url: "http://c/v1" },
      { provider: "a", model: "m1" },
      { provider: "b", model: "" },
    ]);

    const next = buildFallbackProvidersUpdate(config, moveFallbackEntry(rows, 0, 1));

    expect(next.fallback_providers).toEqual([
      { provider: "a", model: "m1" },
      { provider: "c", model: "m3", base_url: "http://c/v1" },
    ]);
    expect(next.model).toEqual(config.model);
    expect(next.agent).toEqual(config.agent);
    expect(config.fallback_providers).toEqual([{ provider: "old", model: "old-model" }]);
  });

  it("writes an empty list when the chain is cleared", () => {
    expect(buildFallbackProvidersUpdate({ fallback_providers: [{ provider: "a", model: "m" }] }, []))
      .toEqual({ fallback_providers: [] });
    expect(buildFallbackProvidersUpdate(null, [])).toEqual({ fallback_providers: [] });
  });

  it("labels rows for the summary line", () => {
    expect(describeFallbackEntry({ provider: "kimi", model: "kimi-k2" }, { kimi: "Kimi" })).toBe(
      "Kimi · kimi-k2",
    );
    expect(describeFallbackEntry({ provider: "zzz", model: "" }, {})).toBe("zzz");
    expect(describeFallbackEntry({ provider: "", model: "" }, {})).toBe("未填写");
  });
});
