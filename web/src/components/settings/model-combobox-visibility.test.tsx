// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readUiValue } from "@/lib/ui-store";
import { favoriteModelsAtom, hiddenModelsAtom } from "@/lib/model-visibility";
import { ModelCombobox } from "./model-combobox";

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
});

const store = getDefaultStore();

beforeEach(() => {
  store.set(hiddenModelsAtom, []);
  store.set(favoriteModelsAtom, []);
});

afterEach(cleanup);

const MODELS = ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-lite"];

async function openPicker() {
  render(
    <ModelCombobox
      label="模型"
      provider="deepseek"
      value=""
      onChange={() => undefined}
      options={MODELS}
    />,
  );
  const combobox = screen.getByRole("combobox", { name: "模型" });
  fireEvent.click(combobox);
  await waitFor(() => expect(combobox.getAttribute("aria-expanded")).toBe("true"));
  return [...document.querySelectorAll("[cmdk-item]")].map((node) =>
    (node.textContent ?? "").replace("★", "").trim(),
  );
}

describe("ModelCombobox 收藏 / 隐藏", () => {
  it("lists every model when nothing is hidden", async () => {
    expect(await openPicker()).toEqual(MODELS);
    expect(screen.getByRole("button", { name: "收藏 deepseek-v4-flash" })).toBeTruthy();
  });

  it("drops hidden models from the picker and says how many are hidden", async () => {
    store.set(hiddenModelsAtom, ["deepseek::deepseek-v4-pro"]);

    const items = await openPicker();

    expect(items).toEqual(["deepseek-v4-flash", "deepseek-v4-lite"]);
    expect(screen.getByText("已隐藏 1 个模型，到「模型」页的模型可见性里恢复")).toBeTruthy();
  });

  it("pins favorites first in favorite order", async () => {
    store.set(favoriteModelsAtom, [
      "deepseek::deepseek-v4-lite",
      "deepseek::deepseek-v4-pro",
    ]);

    expect(await openPicker()).toEqual([
      "deepseek-v4-lite",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
    ]);
  });

  it("ignores hidden / favorite keys that belong to another provider", async () => {
    store.set(hiddenModelsAtom, ["zai::deepseek-v4-pro"]);
    store.set(favoriteModelsAtom, ["zai::deepseek-v4-lite"]);

    expect(await openPicker()).toEqual(MODELS);
    expect(screen.getByRole("button", { name: "收藏 deepseek-v4-lite" })).toBeTruthy();
  });

  it("stars a model from the picker and persists it to the ui-store", async () => {
    await openPicker();

    fireEvent.click(screen.getByRole("button", { name: "收藏 deepseek-v4-pro" }));

    expect(store.get(favoriteModelsAtom)).toEqual(["deepseek::deepseek-v4-pro"]);
    expect(readUiValue("hermes.model-visibility.favorites", [])).toEqual([
      "deepseek::deepseek-v4-pro",
    ]);
    expect(screen.getByRole("button", { name: "取消收藏 deepseek-v4-pro" })).toBeTruthy();
  });

  it("leaves the picker untouched when no provider is passed", async () => {
    store.set(hiddenModelsAtom, ["deepseek::deepseek-v4-pro"]);
    render(
      <ModelCombobox label="模型" value="" onChange={() => undefined} options={MODELS} />,
    );
    const combobox = screen.getByRole("combobox", { name: "模型" });
    fireEvent.click(combobox);
    await waitFor(() => expect(combobox.getAttribute("aria-expanded")).toBe("true"));

    expect(document.querySelectorAll("[cmdk-item]")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "收藏 deepseek-v4-flash" })).toBeNull();
  });
});
