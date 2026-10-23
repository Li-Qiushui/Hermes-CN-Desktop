import { describe, expect, it } from "vitest";
import {
  buildLogsPath,
  filterLogLines,
  filterLogLinesForServer,
  findLogSource,
  MCP_LOG_POLL_MS,
  MCP_LOG_SOURCES,
  mentionsServer,
  mergeLogLines,
} from "./mcp-logs";

describe("log sources", () => {
  it("exposes the stdio and agent channels with their real /api/logs keys", () => {
    expect(MCP_LOG_SOURCES.map((source) => source.id)).toEqual(["stdio", "agent"]);
    expect(findLogSource("stdio")).toMatchObject({ file: "mcp" });
    expect(findLogSource("agent")).toMatchObject({ file: "agent", component: "tools" });
  });

  it("polls every 2s", () => {
    expect(MCP_LOG_POLL_MS).toBe(2000);
  });

  it("falls back to the first source for an unknown id", () => {
    expect(findLogSource("bogus" as never).id).toBe("stdio");
  });
});

describe("buildLogsPath", () => {
  it("builds the stdio query without a component filter", () => {
    expect(buildLogsPath({ source: "stdio" })).toBe("/api/logs?file=mcp&lines=200");
  });

  it("carries the component and search filters", () => {
    const path = buildLogsPath({ source: "agent", lines: 50, search: "filesystem" });
    const params = new URLSearchParams(path.split("?")[1]);
    expect(params.get("file")).toBe("agent");
    expect(params.get("component")).toBe("tools");
    expect(params.get("lines")).toBe("50");
    expect(params.get("search")).toBe("filesystem");
  });

  it("drops blank searches and the ALL level", () => {
    const path = buildLogsPath({ source: "stdio", search: "   ", level: "ALL" });
    expect(path).not.toContain("search=");
    expect(path).not.toContain("level=");
  });

  it("keeps a real level filter", () => {
    expect(buildLogsPath({ source: "stdio", level: "ERROR" })).toContain("level=ERROR");
  });
});

describe("log filtering", () => {
  const lines = [
    "2026-10-23 11:00:00 INFO tools.mcp filesystem: connect",
    "2026-10-23 11:00:01 ERROR tools.mcp filesystem: boom",
    "2026-10-23 11:00:02 INFO tools.mcp github: connect",
  ];

  it("filters case-insensitively", () => {
    expect(filterLogLines(lines, "error")).toHaveLength(1);
    expect(filterLogLines(lines, "FILESYSTEM")).toHaveLength(2);
  });

  it("returns everything for an empty term", () => {
    expect(filterLogLines(lines, "   ")).toHaveLength(3);
  });

  it("scopes lines to one server", () => {
    expect(mentionsServer(lines[2], "github")).toBe(true);
    expect(filterLogLinesForServer(lines, "github")).toHaveLength(1);
    expect(filterLogLinesForServer(lines, "")).toHaveLength(3);
  });
});

describe("mergeLogLines (follow vs pause)", () => {
  it("appends only the new tail when windows overlap", () => {
    const previous = ["a", "b", "c"];
    const incoming = ["b", "c", "d"];
    expect(mergeLogLines(previous, incoming)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps the previous frame when nothing new arrived", () => {
    expect(mergeLogLines(["a", "b"], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("replaces the history when the window slid past the overlap", () => {
    expect(mergeLogLines(["a", "b"], ["x", "y"])).toEqual(["x", "y"]);
  });

  it("starts from the incoming window on the first tick", () => {
    expect(mergeLogLines([], ["a"])).toEqual(["a"]);
    expect(mergeLogLines(["a"], [])).toEqual(["a"]);
  });

  it("does not duplicate a fully overlapping window", () => {
    const merged = mergeLogLines(["a", "b", "c"], ["b", "c"]);
    expect(merged).toEqual(["a", "b", "c"]);
  });
});
