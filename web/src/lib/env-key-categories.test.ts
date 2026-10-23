import { describe, expect, it } from "vitest";

import { classifyEnvKey, groupEnvKeys, maskSecret } from "./env-key-categories";

describe("classifyEnvKey", () => {
  it("buckets tool category keys as tool secrets", () => {
    expect(classifyEnvKey("EXA_API_KEY", { category: "tool" })).toBe("tool");
    expect(classifyEnvKey("FIRECRAWL_API_KEY", { category: "tool" })).toBe("tool");
  });

  it("buckets service and gateway keys as gateway secrets", () => {
    expect(classifyEnvKey("HERMES_GATEWAY_TOKEN", { category: "setting" })).toBe("gateway");
    expect(classifyEnvKey("MCP_SERVER_TOKEN", { category: "other" })).toBe("gateway");
    expect(classifyEnvKey("DASHBOARD_BASE_URL", { category: "other" })).toBe("gateway");
    expect(classifyEnvKey("SOME_KEY", { category: "service" })).toBe("gateway");
  });

  it("treats channel-managed keys as gateway secrets", () => {
    expect(classifyEnvKey("TELEGRAM_TOKEN", { category: "messaging", channel_managed: true })).toBe("gateway");
  });

  it("ignores unrelated keys", () => {
    expect(classifyEnvKey("OPENAI_API_KEY", { category: "provider" })).toBeNull();
    expect(classifyEnvKey("TZ", { category: "setting" })).toBeNull();
  });
});

describe("groupEnvKeys", () => {
  it("splits keys into the two groups sorted by name", () => {
    const groups = groupEnvKeys({
      TAVILY_API_KEY: { category: "tool" },
      EXA_API_KEY: { category: "tool" },
      HERMES_GATEWAY_TOKEN: { category: "setting" },
      OPENAI_API_KEY: { category: "provider" },
    });
    expect(groups.tool.map((item) => item.key)).toEqual(["EXA_API_KEY", "TAVILY_API_KEY"]);
    expect(groups.gateway.map((item) => item.key)).toEqual(["HERMES_GATEWAY_TOKEN"]);
  });

  it("handles an empty payload", () => {
    expect(groupEnvKeys({})).toEqual({ tool: [], gateway: [] });
  });
});

describe("maskSecret", () => {
  it("hides the middle of long values", () => {
    expect(maskSecret("abcdefghijklmnop")).toBe("abcd••••••••mnop");
  });

  it("fully masks short values", () => {
    expect(maskSecret("abcd")).toBe("••••");
  });

  it("returns an empty string for empty input", () => {
    expect(maskSecret("   ")).toBe("");
  });
});
