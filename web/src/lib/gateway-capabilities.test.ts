import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyGatewayError } from "./gateway-result";
import {
  featureStatus,
  forgetGatewayCapabilities,
  gatewayCapabilityVersion,
  isFeatureEntryVisible,
  rememberUnsupportedMethod,
  subscribeGatewayCapabilities,
  unavailableFeatureMethod,
} from "./gateway-capabilities";

function markUnsupported(method: string) {
  rememberUnsupportedMethod(classifyGatewayError(new Error(`当前内核不支持该功能（${method}）`)));
}

beforeEach(() => forgetGatewayCapabilities());

describe("功能能力判定", () => {
  it("没探测过就按可用处理，入口照常出现", () => {
    expect(featureStatus("mcp.reload")).toBe("available");
    expect(featureStatus("session.detail")).toBe("available");
    expect(isFeatureEntryVisible("mcp.reload")).toBe(true);
    expect(unavailableFeatureMethod("mcp.reload")).toBeUndefined();
  });

  it("首次被判不支持后该功能整块不可用，并指出缺哪个方法", () => {
    markUnsupported("reload.mcp");

    expect(featureStatus("mcp.reload")).toBe("unavailable");
    expect(isFeatureEntryVisible("mcp.reload")).toBe(false);
    expect(unavailableFeatureMethod("mcp.reload")).toBe("reload.mcp");
  });

  it("有替代路径的功能只降级，不隐藏入口", () => {
    markUnsupported("provider.models");

    expect(featureStatus("models.catalog")).toBe("degraded");
    expect(isFeatureEntryVisible("models.catalog")).toBe(true);
    expect(featureStatus("mcp.reload")).toBe("available");
  });

  it("一个功能依赖多个方法时，任一缺失即整体不可用", () => {
    markUnsupported("session.resume");

    expect(featureStatus("session.detail")).toBe("unavailable");
    expect(isFeatureEntryVisible("session.detail")).toBe(false);
  });
});

describe("能力缓存订阅", () => {
  it("新方法首次登记时通知一次，重复登记不再通知", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeGatewayCapabilities(listener);

    markUnsupported("reload.mcp");
    expect(listener).toHaveBeenCalledTimes(1);

    markUnsupported("reload.mcp");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    markUnsupported("clarify.respond");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("重连清空缓存也通知，版本号随之变化", () => {
    markUnsupported("reload.mcp");
    const version = gatewayCapabilityVersion();
    const listener = vi.fn();
    const unsubscribe = subscribeGatewayCapabilities(listener);

    forgetGatewayCapabilities();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(gatewayCapabilityVersion()).toBeGreaterThan(version);
    expect(featureStatus("mcp.reload")).toBe("available");
    unsubscribe();
  });

  it("空缓存清空不打扰订阅者", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeGatewayCapabilities(listener);

    forgetGatewayCapabilities();

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
