import { describe, expect, it } from "vitest";
import {
  extractServersMap,
  formatMcpServersJson,
  positionToLineColumn,
  validateMcpServersJson,
} from "./mcp-json";

describe("positionToLineColumn", () => {
  it("counts 1-based lines and columns", () => {
    expect(positionToLineColumn("abc", 0)).toEqual({ line: 1, column: 1 });
    expect(positionToLineColumn("ab\ncd", 3)).toEqual({ line: 2, column: 1 });
    expect(positionToLineColumn("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
  });

  it("clamps out-of-range positions", () => {
    expect(positionToLineColumn("ab", 99)).toEqual({ line: 1, column: 3 });
  });
});

describe("validateMcpServersJson", () => {
  it("accepts a valid map and normalizes entries", () => {
    const result = validateMcpServersJson(
      JSON.stringify({ filesystem: { command: "npx", args: ["-y", "server-filesystem"] } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.value)).toEqual(["filesystem"]);
  });

  it("rejects empty input", () => {
    const result = validateMcpServersJson("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("为空");
  });

  it("reports a line number for a syntax error", () => {
    const broken = '{\n  "fs": {\n    "command": "npx"\n  ,\n}';
    const result = validateMcpServersJson(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.line).toBeDefined();
      expect(result.line).toBeGreaterThan(1);
      expect(result.message).toContain("第");
      expect(result.message).toContain("行");
    }
  });

  it("rejects a non-object top level", () => {
    const result = validateMcpServersJson("[1,2]");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("顶层必须是对象");
  });

  it("names the offending entry when its value is not an object", () => {
    const result = validateMcpServersJson(JSON.stringify({ filesystem: "npx" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("filesystem");
  });

  it("requires url or command", () => {
    const result = validateMcpServersJson(JSON.stringify({ nothing: { args: [] } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("url 或 command");
  });

  it("requires args to be an array", () => {
    const result = validateMcpServersJson(JSON.stringify({ svc: { url: "https://x", args: "a b" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("args");
  });

  it("accepts an http server and a stdio server side by side", () => {
    const result = validateMcpServersJson(
      JSON.stringify({
        remote: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
        local: { command: "npx", args: ["-y", "x"], env: { K: "${V}" } },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.value).sort()).toEqual(["local", "remote"]);
  });
});

describe("formatting helpers", () => {
  it("pretty prints with two-space indent", () => {
    expect(formatMcpServersJson({ a: { command: "x" } })).toBe(
      '{\n  "a": {\n    "command": "x"\n  }\n}',
    );
  });

  it("prints an empty object for missing input", () => {
    expect(formatMcpServersJson(undefined)).toBe("{}");
  });

  it("extracts the servers map from a config document", () => {
    expect(extractServersMap({ mcp_servers: { a: { command: "x" } }, model: "m" })).toEqual({
      a: { command: "x" },
    });
    expect(extractServersMap({})).toEqual({});
    expect(extractServersMap(null)).toEqual({});
    expect(extractServersMap({ mcp_servers: [] })).toEqual({});
  });
});
