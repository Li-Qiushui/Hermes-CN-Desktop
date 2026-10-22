import { describe, expect, it } from "vitest";
import type { MoaConfigResponse, MoaPresetConfig } from "@hermes/protocol";
import {
  moaConfigProblems,
  moaPresetProblems,
  moaSaveErrorText,
  translateMoaDetail,
} from "./moa-save-error";

function preset(overrides: Partial<MoaPresetConfig> = {}): MoaPresetConfig {
  return {
    enabled: true,
    reference_models: [{ provider: "openrouter", model: "deepseek/deepseek-v4-pro" }],
    aggregator: { provider: "openrouter", model: "anthropic/claude-opus-4.8" },
    ...overrides,
  };
}

describe("moaSaveErrorText", () => {
  it("translates a 422 reference-slot rejection from the kernel", () => {
    const err = new Error(
      "HTTP 422: " +
        JSON.stringify({
          detail:
            "Invalid MoA config: preset 'default' reference 2: model is required (provider 'openrouter' has no model selected)",
        }),
    );
    expect(moaSaveErrorText(err)).toBe(
      "内核拒绝了这份配置：预设「default」的参考模型 2：服务商「openrouter」还没选模型",
    );
  });

  it("translates a 422 aggregator rejection", () => {
    const err = new Error(
      "HTTP 422: " +
        JSON.stringify({
          detail:
            "Invalid MoA config: preset 'review' aggregator: the Mixture of Agents provider cannot be used inside a preset (recursive MoA)",
        }),
    );
    expect(moaSaveErrorText(err)).toBe("内核拒绝了这份配置：预设「review」的聚合器：MoA 服务商不能嵌套在预设里（会递归）");
  });

  it("falls back to a Chinese reason when a 422 carries no detail", () => {
    expect(moaSaveErrorText(new Error("HTTP 422: "))).toBe("内核拒绝了这份配置：配置里有填不完整的槽位");
  });

  it("explains 401 as a token problem instead of echoing the raw body", () => {
    const err = new Error("HTTP 401: {\"detail\":\"Unauthorized\"}");
    expect(moaSaveErrorText(err)).toContain("没有权限保存 MoA 配置");
    expect(moaSaveErrorText(err)).toContain("会话令牌");
    expect(moaSaveErrorText(err)).not.toContain("Unauthorized");
  });

  it("keeps non-HTTP failures readable", () => {
    expect(moaSaveErrorText(new Error("Failed to fetch"))).toBe("保存失败：Failed to fetch");
    expect(moaSaveErrorText("boom")).toBe("保存失败：boom");
  });
});

describe("translateMoaDetail", () => {
  it("joins several problems into one Chinese sentence", () => {
    const detail =
      "Invalid MoA config: preset 'default' reference 1: provider is required; preset 'default': needs at least one complete reference model";
    expect(translateMoaDetail(detail)).toBe(
      "预设「default」的参考模型 1：缺少服务商；预设「default」至少要有一个填完整的参考模型",
    );
  });

  it("passes unknown problem text through so diagnostics stay truthful", () => {
    expect(translateMoaDetail("something new happened")).toBe("something new happened");
    expect(translateMoaDetail("")).toBe("");
  });
});

describe("moaConfigProblems", () => {
  it("accepts a fully filled config", () => {
    const config: MoaConfigResponse = {
      default_preset: "default",
      active_preset: "",
      presets: { default: preset() },
    };
    expect(moaConfigProblems(config)).toEqual([]);
  });

  it("flags the empty model a provider switch leaves behind", () => {
    const config: MoaConfigResponse = {
      default_preset: "default",
      active_preset: "",
      presets: {
        default: preset({
          reference_models: [{ provider: "openrouter", model: "" }],
          aggregator: { provider: "", model: "" },
        }),
      },
    };
    expect(moaConfigProblems(config)).toEqual([
      "预设「default」的参考模型 1：还没选模型（服务商「openrouter」）",
      "预设「default」的聚合器：还没选服务商和模型",
    ]);
  });

  it("names every preset that needs work", () => {
    expect(
      moaPresetProblems(preset({ aggregator: { provider: "moa", model: "default" } }), "fast"),
    ).toEqual(["预设「fast」的聚合器：不能用 MoA 服务商（会递归）"]);
  });
});
