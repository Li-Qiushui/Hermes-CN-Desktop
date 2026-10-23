import {
  type CronDeliveryTarget,
  deliveryTargetsWithSelection,
  parseCronDeliveryTargets,
  targetLabel,
  toggleCronDeliveryTarget,
} from "@/lib/cron-delivery";
import s from "./cron-editor.module.css";

interface DeliverCheckboxesProps {
  value: string;
  targets: ReadonlyArray<CronDeliveryTarget>;
  unavailable: boolean;
  onChange: (next: string) => void;
}

export function DeliverCheckboxes({ value, targets, unavailable, onChange }: DeliverCheckboxesProps) {
  const selected = parseCronDeliveryTargets(value);
  const options = deliveryTargetsWithSelection(targets, value);

  return (
    <div className={s.field}>
      <span className={s.label}>投递目标（可多选）</span>
      <div className={s.targets} role="group" aria-label="投递目标">
        {options.map((target) => (
          <label className={s.targetRow} key={target.id} htmlFor={`cron-deliver-${target.id}`}>
            <input
              type="checkbox"
              id={`cron-deliver-${target.id}`}
              checked={selected.includes(target.id)}
              onChange={(event) => onChange(toggleCronDeliveryTarget(value, target.id, event.target.checked))}
            />
            <span>{targetLabel(target)}</span>
          </label>
        ))}
      </div>
      {unavailable ? (
        <span className={s.targetsNote} data-slot="cron-delivery-targets-fallback">
          未探测到后端目标，以上为内置兜底选项（保存后由后端校验）
        </span>
      ) : null}
    </div>
  );
}
