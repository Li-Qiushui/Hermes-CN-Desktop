// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelVisibilityPanel } from "./model-visibility-panel";

afterEach(cleanup);

const MODELS = ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-lite"];

function renderPanel(overrides: Partial<Parameters<typeof ModelVisibilityPanel>[0]> = {}) {
  const props = {
    provider: "deepseek",
    providerName: "DeepSeek",
    models: MODELS,
    hidden: [] as string[],
    favorites: [] as string[],
    onToggleHidden: vi.fn(),
    onToggleFavorite: vi.fn(),
    onShowAll: vi.fn(),
    ...overrides,
  };
  render(<ModelVisibilityPanel {...props} />);
  return props;
}

describe("ModelVisibilityPanel", () => {
  it("defaults to showing every model", () => {
    renderPanel();

    for (const model of MODELS) expect(screen.getByText(model)).toBeTruthy();
    expect(screen.getByText("DeepSeek · 共 3 个模型 · 收藏 0 · 隐藏 0")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "全部显示" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("emits a provider::model key when hiding a model", () => {
    const props = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "隐藏 deepseek-v4-pro" }));

    expect(props.onToggleHidden).toHaveBeenCalledWith("deepseek::deepseek-v4-pro");
  });

  it("marks hidden models and lets them be restored", () => {
    const props = renderPanel({ hidden: ["deepseek::deepseek-v4-pro"] });

    expect(screen.getByText("已隐藏")).toBeTruthy();
    expect(screen.getByText("DeepSeek · 共 3 个模型 · 收藏 0 · 隐藏 1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "显示 deepseek-v4-pro" }));
    expect(props.onToggleHidden).toHaveBeenCalledWith("deepseek::deepseek-v4-pro");

    fireEvent.click(screen.getByRole("button", { name: "全部显示" }));
    expect(props.onShowAll).toHaveBeenCalledTimes(1);
  });

  it("toggles favorites and counts them in the header", () => {
    const props = renderPanel({ favorites: ["deepseek::deepseek-v4-flash"] });

    expect(screen.getByText("DeepSeek · 共 3 个模型 · 收藏 1 · 隐藏 0")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "取消收藏 deepseek-v4-flash" }));
    expect(props.onToggleFavorite).toHaveBeenCalledWith("deepseek::deepseek-v4-flash");

    fireEvent.click(screen.getByRole("button", { name: "收藏 deepseek-v4-lite" }));
    expect(props.onToggleFavorite).toHaveBeenCalledWith("deepseek::deepseek-v4-lite");
  });

  it("filters the catalog by substring and reports an empty result", () => {
    renderPanel();

    fireEvent.change(screen.getByLabelText("筛选模型"), { target: { value: "pro" } });
    expect(screen.getByText("deepseek-v4-pro")).toBeTruthy();
    expect(screen.queryByText("deepseek-v4-flash")).toBeNull();

    fireEvent.change(screen.getByLabelText("筛选模型"), { target: { value: "glm" } });
    expect(screen.getByText("没有匹配「glm」的模型")).toBeTruthy();
  });

  it("explains an empty catalog instead of rendering nothing", () => {
    renderPanel({ models: [] });
    expect(
      screen.getByText("这个服务商还没有可用模型。先在上面保存密钥并刷新模型列表。"),
    ).toBeTruthy();
  });
});
