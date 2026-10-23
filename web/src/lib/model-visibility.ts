import { atom } from "jotai";
import { readUiValue, subscribeUiStore, writeUiValue } from "@/lib/ui-store";

const HIDDEN_STORAGE_KEY = "hermes.model-visibility.hidden";
const FAVORITE_STORAGE_KEY = "hermes.model-visibility.favorites";

export function modelVisibilityKey(provider: string, model: string): string {
  return `${provider.trim()}::${model.trim()}`;
}

export function splitModelVisibilityKey(key: string): { provider: string; model: string } {
  const index = key.indexOf("::");
  if (index < 0) return { provider: "", model: key };
  return { provider: key.slice(0, index), model: key.slice(index + 2) };
}

export function normalizeModelKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const key = item.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

export function toggleModelKey(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key];
}

export function isModelHidden(hidden: readonly string[], provider: string, model: string): boolean {
  return hidden.includes(modelVisibilityKey(provider, model));
}

export function isModelFavorite(favorites: readonly string[], provider: string, model: string): boolean {
  return favorites.includes(modelVisibilityKey(provider, model));
}

export function filterHiddenModels(
  models: readonly string[],
  hidden: readonly string[],
  provider: string,
): string[] {
  if (hidden.length === 0) return [...models];
  return models.filter((model) => !isModelHidden(hidden, provider, model));
}

export function orderModelsByFavorite(
  models: readonly string[],
  favorites: readonly string[],
  provider: string,
): string[] {
  const rest = [...models];
  const pinned: string[] = [];
  for (const key of favorites) {
    const entry = splitModelVisibilityKey(key);
    if (entry.provider !== provider) continue;
    const index = rest.indexOf(entry.model);
    if (index < 0) continue;
    pinned.push(entry.model);
    rest.splice(index, 1);
  }
  return [...pinned, ...rest];
}

export function splitFavoriteModels(
  models: readonly string[],
  favorites: readonly string[],
  provider: string,
): { favorites: string[]; rest: string[] } {
  const ordered = orderModelsByFavorite(models, favorites, provider);
  const favoriteCount = ordered.filter((model) => isModelFavorite(favorites, provider, model)).length;
  return {
    favorites: ordered.slice(0, favoriteCount),
    rest: ordered.slice(favoriteCount),
  };
}

export function visibleModelOptions(
  models: readonly string[],
  hidden: readonly string[],
  favorites: readonly string[],
  provider: string,
): string[] {
  return orderModelsByFavorite(filterHiddenModels(models, hidden, provider), favorites, provider);
}

function persistedKeyListAtom(storageKey: string) {
  const baseAtom = atom<string[]>(normalizeModelKeys(readUiValue<string[]>(storageKey, [])));
  baseAtom.onMount = (setValue) => {
    const sync = () => setValue(normalizeModelKeys(readUiValue<string[]>(storageKey, [])));
    sync();
    return subscribeUiStore(sync);
  };
  return atom(
    (get) => get(baseAtom),
    (_get, set, next: readonly string[]) => {
      const keys = normalizeModelKeys(next);
      set(baseAtom, keys);
      writeUiValue(storageKey, keys);
    },
  );
}

export const hiddenModelsAtom = persistedKeyListAtom(HIDDEN_STORAGE_KEY);
export const favoriteModelsAtom = persistedKeyListAtom(FAVORITE_STORAGE_KEY);

export const MODEL_VISIBILITY_STORAGE_KEYS = {
  hidden: HIDDEN_STORAGE_KEY,
  favorites: FAVORITE_STORAGE_KEY,
} as const;
