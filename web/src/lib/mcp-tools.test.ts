import { describe, expect, it } from "vitest";
import {
  buildToolFilterConfig,
  buildToolFilterRequest,
  disabledTools,
  enabledToolCount,
  hasWhitelist,
  isToolEnabled,
  readToolFilter,
  setDisabledTools,
  toggleToolInFilter,
  toolFilterWritable,
} from "./mcp-tools";

const AVAILABLE = ["read_file", "write_file", "list_dir"];

describe("readToolFilter", () => {
  it("treats a missing filter as all tools enabled", () => {
    const filter = readToolFilter(undefined);
    expect(filter).toEqual({ include: null, exclude: [] });
    expect(hasWhitelist(filter)).toBe(false);
    expect(enabledToolCount(AVAILABLE, filter)).toBe(3);
  });

  it("accepts the core object shape and ignores non-string members", () => {
    const filter = readToolFilter({ include: ["read_file", 7], exclude: ["list_dir"] });
    expect(filter.include).toEqual(["read_file"]);
    expect(filter.exclude).toEqual(["list_dir"]);
  });

  it("tolerates the legacy flat array shape without inventing a whitelist", () => {
    expect(readToolFilter(["read_file"])).toEqual({ include: null, exclude: [] });
    expect(readToolFilter("read_file")).toEqual({ include: null, exclude: [] });
  });
});

describe("isToolEnabled", () => {
  it("uses exclude as a blacklist", () => {
    const filter = readToolFilter({ exclude: ["write_file"] });
    expect(isToolEnabled("read_file", filter)).toBe(true);
    expect(isToolEnabled("write_file", filter)).toBe(false);
  });

  it("lets include win over exclude, matching the kernel predicate", () => {
    const filter = readToolFilter({ include: ["read_file"], exclude: ["read_file"] });
    expect(isToolEnabled("read_file", filter)).toBe(true);
    expect(isToolEnabled("list_dir", filter)).toBe(false);
  });

  it("treats an explicit empty include as block-all", () => {
    const filter = readToolFilter({ include: [] });
    expect(enabledToolCount(AVAILABLE, filter)).toBe(0);
  });
});

describe("toggleToolInFilter", () => {
  it("adds the disabled tool to exclude", () => {
    const next = toggleToolInFilter(readToolFilter(undefined), AVAILABLE, "write_file", false);
    expect(next).toEqual({ include: null, exclude: ["write_file"] });
  });

  it("removes the tool from exclude when re-enabled", () => {
    const start = readToolFilter({ exclude: ["write_file", "list_dir"] });
    const next = toggleToolInFilter(start, AVAILABLE, "write_file", true);
    expect(next.exclude).toEqual(["list_dir"]);
  });

  it("keeps stale disabled names that the server no longer advertises", () => {
    const start = readToolFilter({ exclude: ["gone_tool"] });
    const next = toggleToolInFilter(start, AVAILABLE, "read_file", false);
    expect(next.exclude).toEqual(["gone_tool", "read_file"]);
  });

  it("rebuilds the whitelist when include is present", () => {
    const start = readToolFilter({ include: ["read_file", "list_dir"] });
    const next = toggleToolInFilter(start, AVAILABLE, "list_dir", false);
    expect(next.include).toEqual(["read_file"]);
    expect(hasWhitelist(next)).toBe(true);
  });

  it("keeps toggles idempotent", () => {
    const start = toggleToolInFilter(readToolFilter(undefined), AVAILABLE, "read_file", false);
    const again = toggleToolInFilter(start, AVAILABLE, "read_file", false);
    expect(again.exclude).toEqual(["read_file"]);
    const back = toggleToolInFilter(again, AVAILABLE, "read_file", true);
    expect(back.exclude).toEqual([]);
  });
});

describe("disabledTools", () => {
  it("reports only advertised names for the blacklist shape", () => {
    expect(disabledTools(readToolFilter({ exclude: ["write_file", "gone"] }), AVAILABLE)).toEqual([
      "write_file",
    ]);
  });

  it("derives the complement for the whitelist shape", () => {
    expect(disabledTools(readToolFilter({ include: ["read_file"] }), AVAILABLE)).toEqual([
      "write_file",
      "list_dir",
    ]);
  });

  it("round-trips through setDisabledTools", () => {
    const filter = setDisabledTools(readToolFilter(undefined), AVAILABLE, ["list_dir"]);
    expect(disabledTools(filter, AVAILABLE)).toEqual(["list_dir"]);
  });
});

describe("write payload", () => {
  it("sends only the exclude list under the real config path", () => {
    const filter = toggleToolInFilter(readToolFilter(undefined), AVAILABLE, "write_file", false);
    expect(buildToolFilterConfig("filesystem", filter)).toEqual({
      mcp_servers: { filesystem: { tools: { exclude: ["write_file"] } } },
    });
    expect(buildToolFilterRequest("filesystem", filter)).toEqual({
      config: { mcp_servers: { filesystem: { tools: { exclude: ["write_file"] } } } },
    });
  });

  it("round-trips a written payload back into an equivalent filter", () => {
    const filter = setDisabledTools(readToolFilter(undefined), AVAILABLE, ["read_file", "list_dir"]);
    const payload = buildToolFilterConfig("fs", filter);
    const back = readToolFilter((payload.mcp_servers as Record<string, { tools: unknown }>).fs.tools);
    expect(back).toEqual(filter);
  });

  it("marks the whitelist shape as not writable by the exclude path", () => {
    expect(toolFilterWritable(readToolFilter(undefined))).toBe(true);
    expect(toolFilterWritable(readToolFilter({ exclude: ["a"] }))).toBe(true);
    expect(toolFilterWritable(readToolFilter({ include: ["a"] }))).toBe(false);
  });
});
