import { describe, expect, it } from "vitest";
import { classifyGatewayError, GatewayRpcError, type GatewayErrorKind } from "@/lib/gateway-result";
import {
  __resetProviderModelsCacheForTests,
  cacheProviderModels,
  classifyProviderModelsError,
  providerModelsErrorText,
  readProviderModelsCache,
  selectProviderModelIds,
  type ProviderModelsErrorKind,
} from "./use-provider-models";

const GATEWAY_KIND_TO_MODELS_KIND: Record<GatewayErrorKind, ProviderModelsErrorKind> = {
  "unsupported-method": "unsupported",
  auth: "auth",
  "not-found": "not_found",
  timeout: "timeout",
  network: "network",
  server: "unknown",
  unknown: "unknown",
};

describe("selectProviderModelIds", () => {
  it("sorts and de-dupes the returned ids", () => {
    const ids = selectProviderModelIds({
      ok: true,
      models: ["qwen2.5-coder:7b", "llama3", "qwen2.5-coder:7b"],
      model_count: 3,
      status_code: 200,
      error: null,
      error_kind: null,
    });
    expect(ids).toEqual(["llama3", "qwen2.5-coder:7b"]);
  });

  it("drops empty ids", () => {
    const ids = selectProviderModelIds({
      ok: true,
      models: ["", "a", ""],
      model_count: 3,
      status_code: 200,
      error: null,
      error_kind: null,
    });
    expect(ids).toEqual(["a"]);
  });

  it("throws the backend error when the probe failed", () => {
    expect(() =>
      selectProviderModelIds({
        ok: false,
        models: [],
        model_count: 0,
        status_code: 401,
        error: "API key rejected (HTTP 401)",
        error_kind: "auth",
      }),
    ).toThrow("API key rejected (HTTP 401)");
  });

  it("falls back to a generic message when ok is false with no error text", () => {
    expect(() =>
      selectProviderModelIds({
        ok: false,
        models: [],
        model_count: 0,
        status_code: null,
        error: null,
        error_kind: null,
      }),
    ).toThrow("模型列表获取失败");
  });
});

describe("providerModelsErrorText", () => {
  it("translates common model discovery failures", () => {
    expect(providerModelsErrorText(new Error("HTTP 404 Not Found"))).toBe(
      "此服务商未提供 /models 端点",
    );
    expect(providerModelsErrorText(new Error("API key rejected (HTTP 401)"))).toBe(
      "API Key 无效或未保存",
    );
  });

  it("keeps an unknown backend error intact", () => {
    expect(providerModelsErrorText(new Error("upstream unavailable"))).toBe("upstream unavailable");
  });

  it("turns a kernel that lacks provider.models into a Chinese fallback notice", () => {
    const kernelError = new Error(
      "unknown method: provider.models. the client and the Hermes backend are out of sync " +
        "(different versions); run 'hermes update' and restart both",
    );
    expect(providerModelsErrorText(kernelError)).toBe("当前内核不支持在线拉取模型列表，已按内置目录展示");
    expect(providerModelsErrorText(kernelError)).not.toContain("out of sync");
    expect(providerModelsErrorText(kernelError)).not.toContain("hermes update");
  });

  it("localizes timeouts instead of reusing the auth or endpoint wording", () => {
    expect(providerModelsErrorText(new Error("RPC timeout: provider.models"))).toContain("超时");
  });
});

describe("classifyProviderModelsError", () => {
  it("separates unsupported methods from upstream endpoint failures", () => {
    expect(classifyProviderModelsError(new Error("unknown method: provider.models"))).toBe("unsupported");
    expect(classifyProviderModelsError(new Error("Method not found (-32601)"))).toBe("unsupported");
    expect(classifyProviderModelsError(new Error("HTTP 404 Not Found"))).toBe("not_found");
    expect(classifyProviderModelsError(new Error("API key rejected (HTTP 401)"))).toBe("auth");
    expect(classifyProviderModelsError(new Error("RPC timeout: provider.models"))).toBe("timeout");
    expect(classifyProviderModelsError(new Error("Failed to fetch"))).toBe("network");
    expect(classifyProviderModelsError(new Error("upstream unavailable"))).toBe("unknown");
  });

  it("derives its kind from the shared gateway classifier for every sample", () => {
    const samples = [
      "unknown method: provider.models",
      "Method not found (-32601)",
      "unsupported method: provider.models",
      "not implemented",
      "当前内核不支持该功能（provider.models），已降级处理",
      "API key rejected (HTTP 401)",
      "HTTP 404 Not Found",
      "RPC timeout: provider.models",
      "Failed to fetch",
      "internal error",
      "upstream unavailable",
    ];
    for (const message of samples) {
      const gatewayKind = classifyGatewayError(new Error(message)).kind;
      expect(classifyProviderModelsError(new Error(message)), message).toBe(
        GATEWAY_KIND_TO_MODELS_KIND[gatewayKind],
      );
    }
  });

  it("does not downgrade the kernel Chinese fallback notice to unknown", () => {
    const cachedCapabilityHit = new GatewayRpcError("当前内核不支持该功能（provider.models），已降级处理", {
      method: "provider.models",
    });
    expect(classifyGatewayError(cachedCapabilityHit).kind).toBe("unsupported-method");
    expect(classifyProviderModelsError(cachedCapabilityHit)).toBe("unsupported");
    expect(providerModelsErrorText(cachedCapabilityHit)).toBe(
      "当前内核不支持在线拉取模型列表，已按内置目录展示",
    );
    expect(classifyProviderModelsError(new Error("当前内核不支持该功能（provider.models），已降级处理"))).toBe(
      "unsupported",
    );
    expect(classifyProviderModelsError(new Error("当前内核不支持该功能，已降级处理"))).toBe("unsupported");
  });
});

describe("provider models cache", () => {
  it("remembers the last list per provider and endpoint so a failed refresh can fall back", () => {
    __resetProviderModelsCacheForTests();
    expect(readProviderModelsCache("deepseek", "https://api.deepseek.com")).toEqual([]);

    cacheProviderModels("deepseek", "https://api.deepseek.com/", ["deepseek-v4-pro"]);
    expect(readProviderModelsCache("deepseek", "https://api.deepseek.com")).toEqual(["deepseek-v4-pro"]);
    expect(readProviderModelsCache("kimi-for-coding", "https://api.deepseek.com")).toEqual([]);
  });

  it("does not overwrite a cached list with an empty one", () => {
    __resetProviderModelsCacheForTests();
    cacheProviderModels("deepseek", "https://api.deepseek.com", ["deepseek-v4-flash"]);
    cacheProviderModels("deepseek", "https://api.deepseek.com", []);
    expect(readProviderModelsCache("deepseek", "https://api.deepseek.com")).toEqual([
      "deepseek-v4-flash",
    ]);
  });
});
