import { CRON_PRESETS, type CronPresetValue, scheduleSummary } from "@/lib/cron-schedule";
import s from "./cron-editor.module.css";

interface ScheduleFieldProps {
  preset: CronPresetValue;
  expr: string;
  error: string | null;
  onPreset: (value: CronPresetValue) => void;
  onExpr: (value: string) => void;
}

export function ScheduleField({ preset, expr, error, onPreset, onExpr }: ScheduleFieldProps) {
  return (
    <div className={`${s.field} ${s.fieldFull}`}>
      <span className={s.label}>调度</span>
      <div className={s.grid}>
        <label className={s.field}>
          <span className={s.label}>频率</span>
          <select
            aria-label="调度频率"
            className={s.select}
            value={preset}
            onChange={(event) => onPreset(event.target.value as CronPresetValue)}
          >
            {CRON_PRESETS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className={s.field}>
          <span className={s.label}>cron 表达式</span>
          <input
            aria-label="调度表达式"
            className={`${s.input} ${s.mono}`}
            value={expr}
            readOnly={preset !== "custom"}
            placeholder="0 9 * * *"
            onChange={(event) => onExpr(event.target.value)}
          />
        </label>
      </div>
      <div className={`${s.scheduleBox} ${error ? s.scheduleError : ""}`} data-tone={error ? "err" : "ok"}>
        {error ? <span>{error}</span> : <span>{scheduleSummary(expr)}</span>}
        {!error && preset !== "custom" ? <code>{expr}</code> : null}
      </div>
    </div>
  );
}
