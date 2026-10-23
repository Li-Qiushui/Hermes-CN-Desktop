import { describe, expect, it } from "vitest";
import {
  filterHiddenModels,
  isModelFavorite,
  isModelHidden,
  modelVisibilityKey,
  normalizeModelKeys,
  orderModelsByFavorite,
  splitFavoriteModels,
  splitModelVisibilityKey,
  toggleModelKey,
  visibleModelOptions,
} from "./model-visibility";

const MODELS = ["qwen3-max", "glm-5.1", "deepseek-v4-pro", "kimi-k2"];

describe("model-visibility", () => {
  it("keys a provider/model pair without colliding on colons inside model ids", () => {
    expect(modelVisibilityKey("deepseek", "deepseek-v4-pro")).toBe("deepseek::deepseek-v4-pro");
    expect(modelVisibilityKey("ollama", "qwen2.5:7b")).toBe("ollama::qwen2.5:7b");
    expect(splitModelVisibilityKey("ollama::qwen2.5:7b")).toEqual({
      provider: "ollama",
      model: "qwen2.5:7b",
    });
    expect(splitModelVisibilityKey("bare-model")).toEqual({ provider: "", model: "bare-model" });
  });

  it("dedupes and drops non-string storage junk", () => {
    expect(normalizeModelKeys(["a::m", " a::m ", "b::n", 5, null, ""])).toEqual(["a::m", "b::n"]);
    expect(normalizeModelKeys(undefined)).toEqual([]);
    expect(normalizeModelKeys("a::m")).toEqual([]);
  });

  it("toggles a key on and off, keeping insertion order", () => {
    expect(toggleModelKey([], "a::m")).toEqual(["a::m"]);
    expect(toggleModelKey(["a::m"], "b::n")).toEqual(["a::m", "b::n"]);
    expect(toggleModelKey(["a::m", "b::n"], "a::m")).toEqual(["b::n"]);
  });

  it("hides only the selected provider's models", () => {
    const hidden = [modelVisibilityKey("deepseek", "qwen3-max"), modelVisibilityKey("zai", "glm-5.1")];

    expect(filterHiddenModels(MODELS, hidden, "deepseek")).toEqual([
      "glm-5.1",
      "deepseek-v4-pro",
      "kimi-k2",
    ]);
    expect(filterHiddenModels(MODELS, hidden, "zai")).toEqual([
      "qwen3-max",
      "deepseek-v4-pro",
      "kimi-k2",
    ]);
    expect(filterHiddenModels(MODELS, [], "deepseek")).toEqual(MODELS);
    expect(isModelHidden(hidden, "deepseek", "qwen3-max")).toBe(true);
    expect(isModelHidden(hidden, "deepseek", "glm-5.1")).toBe(false);
  });

  it("pins favorites to the front in favorite order", () => {
    const favorites = [
      modelVisibilityKey("deepseek", "kimi-k2"),
      modelVisibilityKey("deepseek", "glm-5.1"),
      modelVisibilityKey("other", "qwen3-max"),
    ];

    expect(orderModelsByFavorite(MODELS, favorites, "deepseek")).toEqual([
      "kimi-k2",
      "glm-5.1",
      "qwen3-max",
      "deepseek-v4-pro",
    ]);
    expect(isModelFavorite(favorites, "deepseek", "kimi-k2")).toBe(true);
    expect(isModelFavorite(favorites, "deepseek", "qwen3-max")).toBe(false);
    expect(splitFavoriteModels(MODELS, favorites, "deepseek")).toEqual({
      favorites: ["kimi-k2", "glm-5.1"],
      rest: ["qwen3-max", "deepseek-v4-pro"],
    });
  });

  it("combines hidden filtering with favorite ordering for the picker", () => {
    const hidden = [modelVisibilityKey("deepseek", "deepseek-v4-pro")];
    const favorites = [modelVisibilityKey("deepseek", "kimi-k2")];

    expect(visibleModelOptions(MODELS, hidden, favorites, "deepseek")).toEqual([
      "kimi-k2",
      "qwen3-max",
      "glm-5.1",
    ]);
  });

  it("keeps favorites that the catalog no longer carries", () => {
    const favorites = [modelVisibilityKey("deepseek", "removed-model")];
    expect(orderModelsByFavorite(MODELS, favorites, "deepseek")).toEqual(MODELS);
    expect(splitFavoriteModels(MODELS, favorites, "deepseek")).toEqual({
      favorites: [],
      rest: MODELS,
    });
  });
});
