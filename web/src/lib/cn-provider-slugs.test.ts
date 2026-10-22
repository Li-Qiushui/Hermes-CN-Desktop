import { describe, expect, it } from "vitest";
import { CN_BACKEND_PROVIDER_SLUGS, filterCnProviders } from "./cn-provider-slugs";

describe("CN backend provider slug filter", () => {
  it("keeps official direct providers and excludes deprecated or relay-only defaults", () => {
    expect(CN_BACKEND_PROVIDER_SLUGS).toContain("stepfun");
    expect(CN_BACKEND_PROVIDER_SLUGS).toContain("xiaomi");
    expect(CN_BACKEND_PROVIDER_SLUGS).toContain("openai-codex");
    expect(CN_BACKEND_PROVIDER_SLUGS).toContain("openrouter");
    expect(CN_BACKEND_PROVIDER_SLUGS).not.toContain("qwen-oauth");
    expect(CN_BACKEND_PROVIDER_SLUGS).not.toContain("tencent-tokenhub");
  });

  it("本地过滤：保留 CN 内置、用户自定义与当前 provider，滤掉无关内置项", () => {
    const filtered = filterCnProviders([
      { slug: "deepseek", models: ["deepseek-v4-flash"] },
      { slug: "xiaomi" },
      { slug: "workbuddy", is_user_defined: true },
      { slug: "bedrock" },
      { slug: "lmstudio" },
      { slug: "azure" },
      { slug: "copilot", is_current: true },
      { slug: "moonshot", warning: "缺少 API Key" },
    ]);

    expect(filtered.map((p) => p.slug)).toEqual([
      "deepseek",
      "xiaomi",
      "workbuddy",
      "copilot",
      "moonshot",
    ]);
  });
});
