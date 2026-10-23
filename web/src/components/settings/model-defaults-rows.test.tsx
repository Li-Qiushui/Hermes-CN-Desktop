// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelDefaultsRows } from "./model-defaults-rows";

afterEach(cleanup);

function renderRows(overrides: Partial<Parameters<typeof ModelDefaultsRows>[0]> = {}) {
  const props = {
    serviceTier: "standard" as const,
    reasoningEffort: null,
    onServiceTierChange: vi.fn(),
    onReasoningEffortChange: vi.fn(),
    onSave: vi.fn(),
    ...overrides,
  };
  render(<ModelDefaultsRows {...props} />);
  return props;
}

describe("ModelDefaultsRows", () => {
  it("offers exactly standard / fast / ultrafast for agent.service_tier", () => {
    renderRows();

    const select = screen.getByLabelText("速度档") as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      "standard",
      "fast",
      "ultrafast",
    ]);
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "标准",
      "快速",
      "极速",
    ]);
    expect(select.value).toBe("standard");
    expect(screen.getByText("服务商默认队列，不加价")).toBeTruthy();
  });

  it("emits the picked tier for the config write", () => {
    const props = renderRows({ serviceTier: "ultrafast" });

    fireEvent.change(screen.getByLabelText("速度档"), { target: { value: "fast" } });

    expect(props.onServiceTierChange).toHaveBeenCalledWith("fast");
    expect(screen.getByText("OpenAI 极速档，仅部分模型支持")).toBeTruthy();
  });

  it("renders the reasoning row with none labelled 关闭", () => {
    const props = renderRows({ reasoningEffort: "low" });

    const select = screen.getByLabelText("推理等级") as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "关闭",
      "最小",
      "低",
      "中",
      "高",
    ]);
    expect(select.value).toBe("low");

    fireEvent.change(select, { target: { value: "none" } });
    expect(props.onReasoningEffortChange).toHaveBeenCalledWith("none");
  });

  it("falls back to medium when the config has no explicit effort", () => {
    renderRows();
    expect((screen.getByLabelText("推理等级") as HTMLSelectElement).value).toBe("medium");
    expect(screen.getByText("未设置，后端按 medium 处理")).toBeTruthy();
  });

  it("only enables the save button when something actually changed", () => {
    renderRows();
    expect((screen.getByRole("button", { name: "保存默认参数" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    cleanup();
    const props = renderRows({ dirty: true });
    const button = screen.getByRole("button", { name: "保存默认参数" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(props.onSave).toHaveBeenCalledTimes(1);
  });

  it("surfaces save failures instead of a success hint", () => {
    renderRows({ dirty: true, error: "HTTP 400: invalid config", savedHint: "已保存" });
    expect(screen.getByRole("alert").textContent).toBe("HTTP 400: invalid config");
    expect(screen.queryByText("已保存")).toBeNull();
  });
});
