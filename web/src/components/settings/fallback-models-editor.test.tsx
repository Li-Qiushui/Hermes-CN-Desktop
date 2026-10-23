// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FallbackModelsEditor } from "./fallback-models-editor";

afterEach(cleanup);

const PROVIDERS = [
  { id: "deepseek", name: "DeepSeek" },
  { id: "kimi", name: "Kimi" },
  { id: "zai", name: "GLM / Z.AI" },
];

const MODELS: Record<string, string[]> = {
  deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"],
  kimi: ["kimi-k2", "kimi-k2-thinking"],
  zai: ["glm-5.1"],
};

function renderEditor(value: unknown, onSave = vi.fn()) {
  render(
    <FallbackModelsEditor
      value={value}
      providers={PROVIDERS}
      modelOptionsFor={(provider) => MODELS[provider] ?? []}
      onSave={onSave}
    />,
  );
  return onSave;
}

describe("FallbackModelsEditor", () => {
  it("renders the persisted chain in order", () => {
    renderEditor([
      { provider: "kimi", model: "kimi-k2" },
      { provider: "zai", model: "glm-5.1" },
    ]);

    expect((screen.getByLabelText("备用提供商 1") as HTMLSelectElement).value).toBe("kimi");
    expect((screen.getByLabelText("备用模型 1") as HTMLSelectElement).value).toBe("kimi-k2");
    expect((screen.getByLabelText("备用提供商 2") as HTMLSelectElement).value).toBe("zai");
    expect(screen.queryByText("还没有备用模型。主模型不可用时会直接报错。")).toBeNull();
  });

  it("reorders the chain and writes the new order on save", async () => {
    const onSave = renderEditor([
      { provider: "deepseek", model: "deepseek-v4-pro" },
      { provider: "kimi", model: "kimi-k2" },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "下移第 1 条" }));
    fireEvent.click(screen.getByRole("button", { name: "保存备用链" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toEqual([
      { provider: "kimi", model: "kimi-k2" },
      { provider: "deepseek", model: "deepseek-v4-pro" },
    ]);
  });

  it("appends a new row, fills it, and saves it last", async () => {
    const onSave = renderEditor([{ provider: "kimi", model: "kimi-k2" }]);

    fireEvent.click(screen.getByRole("button", { name: "添加备用" }));
    fireEvent.change(screen.getByLabelText("备用提供商 2"), { target: { value: "deepseek" } });
    fireEvent.change(screen.getByLabelText("备用模型 2"), {
      target: { value: "deepseek-v4-flash" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存备用链" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toEqual([
      { provider: "kimi", model: "kimi-k2" },
      { provider: "deepseek", model: "deepseek-v4-flash" },
    ]);
  });

  it("removes a row and never persists half-filled pairs", async () => {
    const onSave = renderEditor([
      { provider: "kimi", model: "kimi-k2" },
      { provider: "zai", model: "glm-5.1" },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "删除第 1 条" }));
    fireEvent.click(screen.getByRole("button", { name: "添加备用" }));
    fireEvent.change(screen.getByLabelText("备用提供商 2"), { target: { value: "deepseek" } });
    fireEvent.click(screen.getByRole("button", { name: "保存备用链" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toEqual([{ provider: "zai", model: "glm-5.1" }]);
  });

  it("clears the model whenever the provider changes", () => {
    renderEditor([{ provider: "kimi", model: "kimi-k2" }]);

    fireEvent.change(screen.getByLabelText("备用提供商 1"), { target: { value: "zai" } });

    expect((screen.getByLabelText("备用模型 1") as HTMLSelectElement).value).toBe("");
    expect([...(screen.getByLabelText("备用模型 1") as HTMLSelectElement).options].map(
      (option) => option.value,
    )).toEqual(["", "glm-5.1"]);
  });

  it("saves an empty list when every row is deleted", async () => {
    const onSave = renderEditor([{ provider: "kimi", model: "kimi-k2" }]);

    fireEvent.click(screen.getByRole("button", { name: "删除第 1 条" }));
    fireEvent.click(screen.getByRole("button", { name: "保存备用链" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toEqual([]);
    expect(screen.getByText("还没有备用模型。主模型不可用时会直接报错。")).toBeTruthy();
  });
});
