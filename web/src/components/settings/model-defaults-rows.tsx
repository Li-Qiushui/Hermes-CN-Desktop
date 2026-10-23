import { Button, Select } from "@hermes/shared-ui";
import {
  SERVICE_TIER_HINTS,
  SERVICE_TIER_LABELS,
  SERVICE_TIERS,
  type ServiceTier,
} from "@/lib/provider-service-tier";
import { reasoningEffortSettingOptions, type ReasoningEffort } from "@/lib/reasoning-effort";
import s from "./model-tuning.module.css";

export interface ModelDefaultsRowsProps {
  serviceTier: ServiceTier;
  reasoningEffort: ReasoningEffort | null;
  saving?: boolean;
  dirty?: boolean;
  error?: string;
  savedHint?: string;
  disabled?: boolean;
  onServiceTierChange: (tier: ServiceTier) => void;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  onSave: () => void;
}

export function ModelDefaultsRows({
  serviceTier,
  reasoningEffort,
  saving = false,
  dirty = false,
  error,
  savedHint,
  disabled,
  onServiceTierChange,
  onReasoningEffortChange,
  onSave,
}: ModelDefaultsRowsProps) {
  const effort = reasoningEffort ?? "medium";
  const effortOptions = reasoningEffortSettingOptions(reasoningEffort);

  return (
    <section className={s.panel} aria-label="默认参数">
      <div className={s.head}>
        <div className={s.title}>默认参数</div>
        <div className={s.headHint}>写入全局配置，对新建会话生效</div>
      </div>
      <div className={s.rows}>
        <div className={s.row}>
          <label className={s.label} htmlFor="model-service-tier">
            速度档
          </label>
          <div className={s.control}>
            <Select
              id="model-service-tier"
              aria-label="速度档"
              value={serviceTier}
              disabled={disabled || saving}
              onChange={(event) => onServiceTierChange(event.target.value as ServiceTier)}
            >
              {SERVICE_TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {SERVICE_TIER_LABELS[tier]}
                </option>
              ))}
            </Select>
            <div className={s.hint}>{SERVICE_TIER_HINTS[serviceTier]}</div>
          </div>
          <div className={s.rowSpacer} />
        </div>
        <div className={s.row}>
          <label className={s.label} htmlFor="model-reasoning-effort">
            推理等级
          </label>
          <div className={s.control}>
            <Select
              id="model-reasoning-effort"
              aria-label="推理等级"
              value={effort}
              disabled={disabled || saving}
              onChange={(event) => onReasoningEffortChange(event.target.value as ReasoningEffort)}
            >
              {effortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            <div className={s.hint}>
              {reasoningEffort ? "已显式设置" : "未设置，后端按 medium 处理"}
            </div>
          </div>
          <div className={s.rowSpacer} />
        </div>
      </div>
      <div className={s.footer}>
        <Button
          variant="solid"
          tone="accent"
          loading={saving}
          disabled={disabled || saving || !dirty}
          onClick={onSave}
        >
          保存默认参数
        </Button>
        {error ? (
          <span className={s.error} role="alert">
            {error}
          </span>
        ) : savedHint ? (
          <span className={s.saved}>{savedHint}</span>
        ) : (
          <span className={s.status}>速度档与推理等级各自独立保存到 agent.*</span>
        )}
      </div>
    </section>
  );
}
