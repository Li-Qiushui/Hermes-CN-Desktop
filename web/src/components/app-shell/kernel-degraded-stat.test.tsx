// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelDegradedStat } from "./kernel-degraded-stat";

const degraded = {
  mode: "degraded" as const,
  baseUrl: "http://127.0.0.1:9119",
  lastError: "spawn hermes serve 失败：找不到可执行文件",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("KernelDegradedStat", () => {
  it("底栏显示「内核异常」并带警告图标与错误预览", () => {
    render(<KernelDegradedStat status={degraded} />);

    const stat = screen.getByTestId("kernel-degraded-stat");
    expect(stat.textContent).toContain("内核异常");
    expect(stat.textContent).toContain("spawn hermes serve 失败");
    expect(stat.querySelector("svg")).not.toBeNull();
    expect(stat.getAttribute("aria-expanded")).toBe("false");
    expect(stat.getAttribute("title")).toBe(degraded.lastError);
  });

  it("点开后展示完整 lastError 并能复制", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const longError = `${"spawn failed ".repeat(20)}tail-end`;

    render(<KernelDegradedStat status={{ ...degraded, lastError: longError }} />);

    expect(screen.queryByRole("group", { name: "内核错误详情" })).toBeNull();
    fireEvent.click(screen.getByTestId("kernel-degraded-stat"));

    const detail = screen.getByRole("group", { name: "内核错误详情" });
    expect(detail.textContent).toContain("tail-end");
    expect(detail.textContent).not.toContain("…");

    fireEvent.click(screen.getByTestId("kernel-degraded-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(longError));
    await waitFor(() => expect(screen.getByTestId("kernel-degraded-copy").textContent).toContain("已复制"));
  });

  it("内核恢复正常时不渲染任何东西", () => {
    const { container } = render(<KernelDegradedStat status={{ mode: "attached" }} />);
    expect(container.firstChild).toBeNull();
  });
});
