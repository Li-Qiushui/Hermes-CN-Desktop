import { normalizeExpr } from "./cron-schedule";
import { parseCronDeliveryTargets } from "./cron-delivery";

export interface CronEditorValues {
  profile: string;
  name: string;
  prompt: string;
  schedule: string;
  deliver: string;
  model: string;
  enabled: boolean;
}

export interface CronEditorIssue {
  field: "name" | "prompt" | "schedule" | "deliver" | "model";
  message: string;
}

export function createPayload(values: CronEditorValues): { prompt: string; schedule: string } & Record<string, unknown> {
  const payload: { prompt: string; schedule: string } & Record<string, unknown> = {
    schedule: normalizeExpr(values.schedule),
    prompt: values.prompt.trim(),
    deliver: parseCronDeliveryTargets(values.deliver).join(","),
  };
  const name = values.name.trim();
  if (name) payload.name = name;
  const model = values.model.trim();
  if (model) payload.model = model;
  if (!values.enabled) payload.paused = true;
  return payload;
}

export function updatePayload(values: CronEditorValues): Record<string, unknown> {
  return {
    name: values.name.trim(),
    prompt: values.prompt.trim(),
    schedule: normalizeExpr(values.schedule),
    deliver: parseCronDeliveryTargets(values.deliver).join(","),
    model: values.model.trim() || null,
  };
}

export function enabledAction(values: CronEditorValues, initial: { enabled: boolean }): "pause" | "resume" | null {
  if (values.enabled === initial.enabled) return null;
  return values.enabled ? "resume" : "pause";
}

export function cronEditorIssues(values: CronEditorValues, scheduleError: string | null): CronEditorIssue[] {
  const issues: CronEditorIssue[] = [];
  if (!values.prompt.trim()) {
    issues.push({ field: "prompt", message: "请填写任务提示词，定时执行时会原样发给 Agent" });
  }
  if (scheduleError) {
    issues.push({ field: "schedule", message: scheduleError });
  }
  return issues;
}
