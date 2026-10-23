import { useMemo, useState } from "react";
import { Button, Input } from "@hermes/shared-ui";
import { isModelFavorite, isModelHidden, modelVisibilityKey } from "@/lib/model-visibility";
import s from "./model-visibility.module.css";

export interface ModelVisibilityPanelProps {
  provider: string;
  providerName?: string;
  models: string[];
  hidden: string[];
  favorites: string[];
  onToggleHidden: (key: string) => void;
  onToggleFavorite: (key: string) => void;
  onShowAll: () => void;
  loading?: boolean;
}

export function ModelVisibilityPanel({
  provider,
  providerName,
  models,
  hidden,
  favorites,
  onToggleHidden,
  onToggleFavorite,
  onShowAll,
  loading,
}: ModelVisibilityPanelProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((model) => model.toLowerCase().includes(q));
  }, [models, query]);

  const hiddenCount = models.filter((model) => isModelHidden(hidden, provider, model)).length;
  const favoriteCount = models.filter((model) => isModelFavorite(favorites, provider, model)).length;

  return (
    <section className={s.panel} aria-label="模型收藏与隐藏">
      <div className={s.head}>
        <div>
          <div className={s.title}>模型收藏与隐藏</div>
          <div className={s.hint}>
            {`${providerName ?? provider} · 共 ${models.length} 个模型 · 收藏 ${favoriteCount} · 隐藏 ${hiddenCount}`}
          </div>
        </div>
        <div className={s.headTools}>
          <Input
            aria-label="筛选模型"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="筛选模型..."
          />
          <Button variant="outline" size="sm" disabled={hiddenCount === 0} onClick={onShowAll}>
            全部显示
          </Button>
        </div>
      </div>
      {loading ? (
        <div className={s.empty}>正在读取模型列表…</div>
      ) : models.length === 0 ? (
        <div className={s.empty}>这个服务商还没有可用模型。先在上面保存密钥并刷新模型列表。</div>
      ) : filtered.length === 0 ? (
        <div className={s.empty}>没有匹配「{query.trim()}」的模型</div>
      ) : (
        <div className={s.list}>
          {filtered.map((model) => {
            const key = modelVisibilityKey(provider, model);
            const isHidden = isModelHidden(hidden, provider, model);
            const favorite = isModelFavorite(favorites, provider, model);
            return (
              <div className={s.row} key={key} data-hidden={isHidden}>
                <span className={s.modelName}>{model}</span>
                {isHidden && <span className={s.badge}>已隐藏</span>}
                {favorite && <span className={s.badgeAccent}>已收藏</span>}
                <div className={s.rowActions}>
                  <Button
                    variant={favorite ? "solid" : "outline"}
                    tone={favorite ? "accent" : "neutral"}
                    size="sm"
                    aria-label={`${favorite ? "取消收藏" : "收藏"} ${model}`}
                    onClick={() => onToggleFavorite(key)}
                  >
                    {favorite ? "已收藏" : "收藏"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`${isHidden ? "显示" : "隐藏"} ${model}`}
                    onClick={() => onToggleHidden(key)}
                  >
                    {isHidden ? "显示" : "隐藏"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
