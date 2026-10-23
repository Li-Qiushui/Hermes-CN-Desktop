import { describe, expect, it } from "vitest";
import {
  SERVICE_TIERS,
  SERVICE_TIER_LABELS,
  buildServiceTierUpdate,
  isServiceTier,
  normalizeServiceTier,
  serviceTierFromConfig,
  serviceTierOptionList,
} from "./provider-service-tier";

describe("provider-service-tier", () => {
  it("exposes exactly the three kernel-accepted picker tiers", () => {
    expect(SERVICE_TIERS).toEqual(["standard", "fast", "ultrafast"]);
    expect(serviceTierOptionList().map((option) => option.value)).toEqual([
      "standard",
      "fast",
      "ultrafast",
    ]);
    expect(serviceTierOptionList().map((option) => option.label)).toEqual(["标准", "快速", "极速"]);
    for (const tier of SERVICE_TIERS) {
      expect(SERVICE_TIER_LABELS[tier]).toBeTruthy();
      expect(isServiceTier(tier)).toBe(true);
    }
  });

  it("normalizes every word the kernel accepts for agent.service_tier", () => {
    expect(normalizeServiceTier("")).toBe("standard");
    expect(normalizeServiceTier("standard")).toBe("standard");
    expect(normalizeServiceTier("normal")).toBe("standard");
    expect(normalizeServiceTier("default")).toBe("standard");
    expect(normalizeServiceTier("auto")).toBe("standard");
    expect(normalizeServiceTier("cold")).toBe("standard");
    expect(normalizeServiceTier(" FAST ")).toBe("fast");
    expect(normalizeServiceTier("priority")).toBe("fast");
    expect(normalizeServiceTier("on")).toBe("fast");
    expect(normalizeServiceTier("UltraFast")).toBe("ultrafast");
    expect(normalizeServiceTier("ultra")).toBe("ultrafast");
    expect(normalizeServiceTier("flex")).toBe("standard");
    expect(normalizeServiceTier(undefined)).toBe("standard");
    expect(normalizeServiceTier(3)).toBe("standard");
  });

  it("reads agent.service_tier out of the config document", () => {
    expect(serviceTierFromConfig({ agent: { service_tier: "ultrafast" } })).toBe("ultrafast");
    expect(serviceTierFromConfig({ agent: { service_tier: "priority" } })).toBe("fast");
    expect(serviceTierFromConfig({ agent: { service_tier: "" } })).toBe("standard");
    expect(serviceTierFromConfig({ agent: {} })).toBe("standard");
    expect(serviceTierFromConfig({})).toBe("standard");
    expect(serviceTierFromConfig(undefined)).toBe("standard");
  });

  it("writes only agent.service_tier and keeps the rest of the config intact", () => {
    const config = {
      model: { default: "deepseek-v4-flash", provider: "deepseek" },
      agent: { max_turns: 160, service_tier: "" },
      fallback_providers: [{ provider: "kimi", model: "kimi-k2" }],
    };
    const next = buildServiceTierUpdate(config, "fast");

    expect(next.agent).toEqual({ max_turns: 160, service_tier: "fast" });
    expect(next.model).toEqual(config.model);
    expect(next.fallback_providers).toEqual(config.fallback_providers);
    expect(config.agent.service_tier).toBe("");
  });

  it("creates agent when the config has none and rejects unknown tiers", () => {
    expect(buildServiceTierUpdate({}, "ultrafast")).toEqual({ agent: { service_tier: "ultrafast" } });
    expect(buildServiceTierUpdate({ agent: "nope" }, "fast")).toEqual({
      agent: { service_tier: "fast" },
    });
    expect(buildServiceTierUpdate(null, "bogus" as never)).toEqual({
      agent: { service_tier: "standard" },
    });
  });

  it("produces the exact PUT /api/config body the kernel accepts", () => {
    const body = { config: buildServiceTierUpdate({ agent: { max_turns: 160 } }, "ultrafast") };
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      config: { agent: { max_turns: 160, service_tier: "ultrafast" } },
    });
  });
});
