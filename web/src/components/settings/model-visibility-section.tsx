import { useMemo, useState } from "react";
import { useAtom } from "jotai";
import { Select } from "@hermes/shared-ui";
import { useConfig, useModelInfo } from "@/hooks/use-config";
import { BUILTIN_PROVIDER_CATALOG } from "@/lib/provider-catalog";
import {
  favoriteModelsAtom,
  hiddenModelsAtom,
  toggleModelKey,
} from "@/lib/model-visibility";
import { ModelVisibilityPanel } from "./model-visibility-panel";
import s from "./model-visibility.module.css";

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? (value as Record<string, any>) : {};
}

function configuredProviderIds(config: Record<string, any> | undefined): string[] {
  const providers = asRecord(config?.providers);
  return Object.keys(providers).filter((id) => {
    const entry = asRecord(providers[id]);
    return Boolean(entry.model || entry.base_url || entry.api_key || entry.api_key_env);
  });
}

function providerModels(
  providerId: string,
  config: Record<string, any> | undefined,
  currentModel: string,
): string[] {
  const models = new Set<string>();
  const preset = BUILTIN_PROVIDER_CATALOG.providers.find((entry) => entry.id === providerId);
  for (const model of preset?.models ?? []) models.add(model.id);
  if (preset?.defaultModel) models.add(preset.defaultModel);
  const entry = asRecord(asRecord(config?.providers)[providerId]);
  if (typeof entry.model === "string" && entry.model.trim()) models.add(entry.model.trim());
  if (Array.isArray(entry.models)) {
    for (const model of entry.models) {
      if (typeof model === "string" && model.trim()) models.add(model.trim());
    }
  }
  if (currentModel) models.add(currentModel);
  return [...models];
}

export function ModelVisibilitySection() {
  const { data: config } = useConfig();
  const { data: modelInfo } = useModelInfo();
  const [hidden, setHidden] = useAtom(hiddenModelsAtom);
  const [favorites, setFavorites] = useAtom(favoriteModelsAtom);

  const providerOptions = useMemo(() => {
    const ids = configuredProviderIds(config);
    if (modelInfo?.provider && !ids.includes(modelInfo.provider)) ids.unshift(modelInfo.provider);
    return ids.map((id) => ({
      id,
      name: BUILTIN_PROVIDER_CATALOG.providers.find((entry) => entry.id === id)?.name ?? id,
    }));
  }, [config, modelInfo?.provider]);

  const [pickedProvider, setPickedProvider] = useState("");
  const provider = pickedProvider || providerOptions[0]?.id || "";
  const providerName = providerOptions.find((entry) => entry.id === provider)?.name ?? provider;

  const models = useMemo(
    () =>
      providerModels(
        provider,
        config,
        modelInfo?.provider === provider ? modelInfo?.model ?? "" : "",
      ),
    [provider, config, modelInfo?.model, modelInfo?.provider],
  );

  const hiddenForProvider = useMemo(
    () => hidden.filter((key) => key.startsWith(`${provider}::`)),
    [hidden, provider],
  );

  const showAll = () => {
    setHidden(hidden.filter((key) => !key.startsWith(`${provider}::`)));
  };
  return (
    <section className={s.section} aria-label="模型可见性">
      <div className={s.sectionHead}>
        <div className={s.title}>模型可见性</div>
        <div className={s.headTools}>
          <Select
            aria-label="选择服务商"
            value={provider}
            onChange={(event) => setPickedProvider(event.target.value)}
          >
            {providerOptions.length === 0 && <option value="">还没有已配置的服务商</option>}
            {providerOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className={s.hint}>
        收藏的模型在选择器里排在最前；隐藏后不再出现在模型选择器里（这里仍可恢复）。
      </div>
      <ModelVisibilityPanel
        provider={provider}
        providerName={providerName}
        models={models}
        hidden={hiddenForProvider}
        favorites={favorites}
        onToggleHidden={(key) => setHidden(toggleModelKey(hidden, key))}
        onToggleFavorite={(key) => setFavorites(toggleModelKey(favorites, key))}
        onShowAll={showAll}
      />
    </section>
  );
}

export const __testables = { providerModels, configuredProviderIds };
