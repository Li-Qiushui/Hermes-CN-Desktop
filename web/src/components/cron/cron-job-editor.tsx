import { useState } from "react";
import type { CronDeliveryTarget } from "@/lib/cron-delivery";
import {
  type CronPresetValue,
  presetExprFor,
  validateCronExpr,
} from "@/lib/cron-schedule";
import { cronEditorIssues, type CronEditorValues } from "@/lib/cron-editor";
import { DeliverCheckboxes } from "./deliver-checkboxes";
import { ScheduleField } from "./schedule-field";
import s from "./cron-editor.module.css";

interface CronJobEditorProps {
  mode: "create" | "edit";
  initial: CronEditorValues;
  initialPreset: CronPresetValue;
  profiles: string[];
  activeProfile: string;
  targets: ReadonlyArray<CronDeliveryTarget>;
  targetsUnavailable: boolean;
  saving: boolean;
  saveError: string | null;
  onSubmit: (values: CronEditorValues) => void;
  onCancel: () => void;
}

type FieldKey = "prompt" | "schedule";

export function CronJobEditor(props: CronJobEditorProps) {
  const { mode, initial, saving } = props;
  const [profile, setProfile] = useState(initial.profile);
  const [name, setName] = useState(initial.name);
  const [prompt, setPrompt] = useState(initial.prompt);
  const [schedule, setSchedule] = useState(initial.schedule);
  const [preset, setPreset] = useState<CronPresetValue>(props.initialPreset);
  const [deliver, setDeliver] = useState(initial.deliver);
  const [model, setModel] = useState(initial.model);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [touched, setTouched] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});

  const profileOptions = props.profiles.length > 0 ? props.profiles : [props.activeProfile || "default"];
  const liveScheduleError = touched || preset === "custom" && schedule.trim() !== ""
    ? validateCronExpr(schedule)
    : null;
  const scheduleError = errors.schedule ?? liveScheduleError;

  const changePreset = (next: CronPresetValue) => {
    setPreset(next);
    const expr = presetExprFor(next);
    if (expr) setSchedule(expr);
    setErrors((prev) => ({ ...prev, schedule: undefined }));
  };

  const changeSchedule = (next: string) => {
    setSchedule(next);
    setTouched(true);
  };

  const submit = () => {
    setTouched(true);
    const values: CronEditorValues = {
      profile: profile || props.activeProfile || "default",
      name,
      prompt,
      schedule,
      deliver,
      model,
      enabled,
    };
    const issues = cronEditorIssues(values, validateCronExpr(schedule));
    const nextErrors: Partial<Record<FieldKey, string>> = {};
    for (const issue of issues) {
      if (issue.field === "prompt" || issue.field === "schedule") nextErrors[issue.field] = issue.message;
    }
    setErrors(nextErrors);
    if (issues.length > 0) return;
    props.onSubmit(values);
  };

  return (
    <section className={s.panel}>
      <div className={s.panelHead}>
        <h1 className={s.panelTitle}>{mode === "edit" ? "编辑定时任务" : "新建定时任务"}</h1>
        <p className={s.panelSub}>
          {mode === "edit"
            ? "修改后立即写入调度器，下一次 tick 按新配置执行。"
            : "任务提示词要自包含；调度器到点会唤起 Agent 执行。"}
        </p>
      </div>

      <div className={s.grid}>
        <label className={s.field}>
          <span className={s.label}>名称</span>
          <input
            aria-label="任务名称"
            className={s.input}
            value={name}
            placeholder="例如：每日 SEO 巡检"
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <label className={s.field}>
          <span className={s.label}>Profile</span>
          {mode === "create" ? (
            <select
              aria-label="Profile"
              className={s.select}
              value={profile || props.activeProfile}
              onChange={(event) => setProfile(event.target.value)}
            >
              {profileOptions.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          ) : (
            <input className={s.input} value={profile} readOnly aria-label="Profile" />
          )}
        </label>

        <ScheduleField
          preset={preset}
          expr={schedule}
          error={scheduleError}
          onPreset={changePreset}
          onExpr={changeSchedule}
        />

        <DeliverCheckboxes
          value={deliver}
          targets={props.targets}
          unavailable={props.targetsUnavailable}
          onChange={setDeliver}
        />

        <label className={s.field}>
          <span className={s.label}>模型（可选，留空用默认）</span>
          <input
            aria-label="模型"
            className={`${s.input} ${s.mono}`}
            value={model}
            placeholder="例如 deepseek-v4.1-flash"
            onChange={(event) => setModel(event.target.value)}
          />
        </label>

        <label className={s.field}>
          <span className={s.label}>启用状态</span>
          <span className={s.switchRow}>
            <input
              type="checkbox"
              aria-label="启用任务"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span>{enabled ? "启用（按调度运行）" : "暂停（保存后不触发）"}</span>
          </span>
        </label>

        <label className={`${s.field} ${s.fieldFull}`}>
          <span className={s.label}>提示词</span>
          <textarea
            aria-label="任务提示词"
            className={s.textarea}
            value={prompt}
            placeholder="描述每次定时执行的目标、边界和输出要求…"
            onChange={(event) => setPrompt(event.target.value)}
          />
          {errors.prompt ? <span className={s.fieldError}>{errors.prompt}</span> : null}
        </label>
      </div>

      {props.saveError ? (
        <div className={s.saveError} role="alert" data-slot="cron-editor-save-error">
          {props.saveError}
        </div>
      ) : null}

      <div className={s.actions}>
        <button type="button" className={s.button} onClick={props.onCancel} disabled={saving}>取消</button>
        <button type="button" className={s.primaryButton} onClick={submit} disabled={saving}>
          {saving ? "保存中…" : mode === "edit" ? "保存修改" : "创建任务"}
        </button>
      </div>
    </section>
  );
}
