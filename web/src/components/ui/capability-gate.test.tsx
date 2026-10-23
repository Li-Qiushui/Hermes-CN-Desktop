// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapabilityGate } from "./capability-gate";
import { classifyGatewayError } from "@/lib/gateway-result";
import {
  forgetGatewayCapabilities,
  rememberUnsupportedMethod,
} from "@/lib/gateway-capabilities";

function markUnsupported(method: string) {
  rememberUnsupportedMethod(classifyGatewayError(new Error(`当前内核不支持该功能（${method}）`)));
}

beforeEach(() => forgetGatewayCapabilities());
afterEach(() => cleanup());

describe("CapabilityGate", () => {
  it("能力未知时照常渲染入口", () => {
    render(
      <CapabilityGate feature="mcp.reload">
        <button type="button">重新载入</button>
      </CapabilityGate>,
    );

    expect(screen.getByText("重新载入")).toBeTruthy();
  });

  it("内核报不支持后入口直接不渲染，并显示兜底内容", () => {
    markUnsupported("reload.mcp");

    render(
      <CapabilityGate feature="mcp.reload" fallback={<span>内核不支持即时重载</span>}>
        <button type="button">重新载入</button>
      </CapabilityGate>,
    );

    expect(screen.queryByText("重新载入")).toBeNull();
    expect(screen.getByText("内核不支持即时重载")).toBeTruthy();
  });

  it("首次失败写缓存后正在显示的入口会立刻消失", () => {
    render(
      <CapabilityGate feature="mcp.reload">
        <button type="button">重新载入</button>
      </CapabilityGate>,
    );
    expect(screen.getByText("重新载入")).toBeTruthy();

    act(() => markUnsupported("reload.mcp"));

    expect(screen.queryByText("重新载入")).toBeNull();
  });

  it("有替代路径的功能即使降级也保留入口", () => {
    markUnsupported("provider.models");

    render(
      <CapabilityGate feature="models.catalog">
        <span>模型目录</span>
      </CapabilityGate>,
    );

    expect(screen.getByText("模型目录")).toBeTruthy();
  });
});
