import { describe, expect, it } from "vitest";
import {
  deriveServerStatus,
  estimateContextCost,
  estimateToolTokens,
  formatTokenCount,
  MCP_STATUS_META,
} from "./mcp-status";

describe("deriveServerStatus", () => {
  it("marks a disabled server off regardless of past results", () => {
    expect(deriveServerStatus({ enabled: false, tested: true, ok: true })).toBe("off");
  });

  it("marks an in-flight probe probing", () => {
    expect(deriveServerStatus({ enabled: true, probing: true, tested: true, ok: true })).toBe("probing");
  });

  it("marks a successful probe ok", () => {
    expect(deriveServerStatus({ enabled: true, tested: true, ok: true })).toBe("ok");
  });

  it("marks an untested enabled server unknown", () => {
    expect(deriveServerStatus({ enabled: true })).toBe("unknown");
  });

  it("classifies auth-shaped failures as needs-auth", () => {
    expect(
      deriveServerStatus({ enabled: true, tested: true, ok: false, error: "HTTP 401 Unauthorized" }),
    ).toBe("needs-auth");
    expect(
      deriveServerStatus({ enabled: true, tested: true, ok: false, error: "OAuth authentication required" }),
    ).toBe("needs-auth");
    expect(
      deriveServerStatus({ enabled: true, tested: true, ok: false, error: "connection refused" }),
    ).toBe("error");
  });

  it("honours the oauth-without-token signal before probing results", () => {
    expect(
      deriveServerStatus({ enabled: true, auth: "oauth", hasOauthToken: false }),
    ).toBe("needs-auth");
    expect(
      deriveServerStatus({ enabled: true, auth: "oauth", hasOauthToken: true, tested: true, ok: true }),
    ).toBe("ok");
  });

  it("exposes a label and badge tone for every status", () => {
    for (const status of ["ok", "off", "error", "needs-auth", "probing", "unknown"] as const) {
      expect(MCP_STATUS_META[status].label).toBe(status);
      expect(MCP_STATUS_META[status].tone).toBeTruthy();
    }
  });
});

describe("token cost estimate", () => {
  it("prefers the kernel-reported schema size", () => {
    expect(estimateToolTokens({ name: "read_file", description: "read", schema_chars: 800 })).toBe(200);
  });

  it("falls back to name + description + schema overhead", () => {
    expect(estimateToolTokens({ name: "abc", description: "defgh" })).toBe(32);
  });

  it("never reports zero tokens", () => {
    expect(estimateToolTokens({ name: "", description: "" })).toBeGreaterThan(0);
  });

  it("sums the tool costs and flags measured vs estimated", () => {
    const measured = estimateContextCost([
      { name: "a", schema_chars: 400 },
      { name: "b", schema_chars: 400 },
    ]);
    expect(measured.tokens).toBe(200);
    expect(measured.toolCount).toBe(2);
    expect(measured.measured).toBe(true);
    expect(measured.label).toBe("约 200 tokens");

    const estimated = estimateContextCost([{ name: "a", description: "bb" }]);
    expect(estimated.measured).toBe(false);
    expect(estimated.label).toContain("估算");
  });

  it("handles an empty tool list", () => {
    expect(estimateContextCost([])).toEqual({ tokens: 0, toolCount: 0, measured: false, label: "约 0 tokens（估算）" });
  });

  it("formats large counts compactly", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1500)).toBe("1.50k");
    expect(formatTokenCount(12500)).toBe("12.5k");
  });
});
