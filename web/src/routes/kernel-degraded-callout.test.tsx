// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelDegradedCallout } from "./settings-connection-section";

const degraded = {
  mode: "degraded" as const,
  baseUrl: "http://127.0.0.1:9119",
  lastError: "spawn 失败：端口 9119 被占用",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("KernelDegradedCallout", () => {
  it("降级时在连接页顶部给出 callout 与最近错误", () => {
    render(<KernelDegradedCallout status={degraded} onRetry={vi.fn()} />);

    const callout = screen.getByTestId("kernel-degraded-callout");
    expect(callout.textContent).toContain("内核未启动 / 启动失败，已降级到手动连接");
    expect(callout.textContent).toContain("127.0.0.1:9119");
    expect(screen.getByTestId("kernel-degraded-error").textContent).toContain("端口 9119 被占用");
    expect(screen.getByTestId("kernel-degraded-retry").textContent).toContain("重新连接内核");
  });

  it("点「重新连接内核」触发回调一次", () => {
    const onRetry = vi.fn();
    render(<KernelDegradedCallout status={degraded} onRetry={onRetry} />);

    fireEvent.click(screen.getByTestId("kernel-degraded-retry"));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("重试进行中时按钮不可再点", () => {
    const onRetry = vi.fn();
    render(<KernelDegradedCallout status={degraded} onRetry={onRetry} retrying />);

    fireEvent.click(screen.getByTestId("kernel-degraded-retry"));

    expect(onRetry).not.toHaveBeenCalled();
  });

  it("内核正常时不渲染 callout", () => {
    const { container } = render(<KernelDegradedCallout status={{ mode: "attached" }} onRetry={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});
