export type CronPresetValue =
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "hourly"
  | "every-15-minutes"
  | "custom";

export interface CronPreset {
  value: CronPresetValue;
  label: string;
  expr: string | null;
}

export const CRON_PRESETS: ReadonlyArray<CronPreset> = [
  { value: "daily", label: "每天", expr: "0 9 * * *" },
  { value: "weekdays", label: "工作日", expr: "0 9 * * 1-5" },
  { value: "weekly", label: "每周", expr: "0 9 * * 1" },
  { value: "monthly", label: "每月", expr: "0 9 1 * *" },
  { value: "hourly", label: "每小时", expr: "0 * * * *" },
  { value: "every-15-minutes", label: "每 15 分钟", expr: "*/15 * * * *" },
  { value: "custom", label: "自定义", expr: null },
];

export const CUSTOM_PRESET: CronPreset = CRON_PRESETS[CRON_PRESETS.length - 1]!;
export const DEFAULT_SCHEDULE_EXPR = "0 9 * * *";

const WEEKDAY_LABELS: Record<string, string> = {
  "0": "周日",
  "1": "周一",
  "2": "周二",
  "3": "周三",
  "4": "周四",
  "5": "周五",
  "6": "周六",
  "7": "周日",
};

interface FieldSpec {
  label: string;
  min: number;
  max: number;
}

const FIELD_SPECS: ReadonlyArray<FieldSpec> = [
  { label: "分钟", min: 0, max: 59 },
  { label: "小时", min: 0, max: 23 },
  { label: "日", min: 1, max: 31 },
  { label: "月", min: 1, max: 12 },
  { label: "星期", min: 0, max: 7 },
];

export function normalizeExpr(expr: string): string {
  return (expr ?? "").trim().replace(/\s+/g, " ");
}

export function cronParts(expr: string): string[] | null {
  const parts = normalizeExpr(expr).split(" ").filter(Boolean);
  return parts.length === 5 ? parts : null;
}

export function isIntegerToken(value: string): boolean {
  return /^\d+$/.test(value);
}

function stepValue(token: string): number | null {
  const match = /^\*\/(\d+)$/.exec(token.trim());
  if (!match) return null;
  const step = Number(match[1]);
  return Number.isInteger(step) && step > 0 ? step : null;
}

function pad2(value: string): string {
  return value.padStart(2, "0");
}

export function formatCronTime(minute: string, hour: string): string {
  if (isIntegerToken(minute) && isIntegerToken(hour)) {
    return `${pad2(hour)}:${pad2(minute)}`;
  }
  return `${hour}:${minute}`;
}

function weekdayLabel(token: string): string {
  const range = /^(\d)-(\d)$/.exec(token);
  if (range) {
    return `${WEEKDAY_LABELS[range[1]] ?? range[1]}至${WEEKDAY_LABELS[range[2]] ?? range[2]}`;
  }
  return WEEKDAY_LABELS[token] ?? `周${token}`;
}

function weekdayList(token: string): string {
  return token
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(weekdayLabel)
    .join("、");
}

export function presetExprFor(value: CronPresetValue): string | null {
  return CRON_PRESETS.find((preset) => preset.value === value)?.expr ?? null;
}

export function presetForExpr(expr: string): CronPreset {
  const normalized = normalizeExpr(expr);
  const exact = CRON_PRESETS.find((preset) => preset.expr === normalized);
  if (exact) return exact;

  const parts = cronParts(normalized);
  if (!parts) return CUSTOM_PRESET;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const steadyTime = isIntegerToken(minute) && isIntegerToken(hour);

  if (steadyTime && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return CRON_PRESETS.find((preset) => preset.value === "daily") ?? CUSTOM_PRESET;
  }
  if (steadyTime && dayOfMonth === "*" && month === "*" && dayOfWeek === "1-5") {
    return CRON_PRESETS.find((preset) => preset.value === "weekdays") ?? CUSTOM_PRESET;
  }
  if (steadyTime && dayOfMonth === "*" && month === "*" && isIntegerToken(dayOfWeek)) {
    return CRON_PRESETS.find((preset) => preset.value === "weekly") ?? CUSTOM_PRESET;
  }
  if (steadyTime && dayOfWeek === "*" && month === "*" && isIntegerToken(dayOfMonth)) {
    return CRON_PRESETS.find((preset) => preset.value === "monthly") ?? CUSTOM_PRESET;
  }
  if (hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*" && isIntegerToken(minute)) {
    return CRON_PRESETS.find((preset) => preset.value === "hourly") ?? CUSTOM_PRESET;
  }

  return CUSTOM_PRESET;
}

function customSummary(parts: string[]): string {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const time = formatCronTime(minute, hour);

  if (month === "*" && dayOfMonth === "*" && dayOfWeek === "*") {
    if (hour === "*") {
      const minuteStep = stepValue(minute);
      if (minuteStep !== null) return `每 ${minuteStep} 分钟`;
      if (isIntegerToken(minute)) return `每小时第 ${minute} 分`;
      return `每小时（分 ${minute}）`;
    }
    const hourStep = stepValue(hour);
    if (hourStep !== null) {
      return minute === "0" ? `每 ${hourStep} 小时整点` : `每 ${hourStep} 小时的第 ${minute} 分`;
    }
    if (isIntegerToken(hour) && isIntegerToken(minute)) return `每天 ${time}`;
  }

  if (month === "*" && dayOfMonth === "*" && dayOfWeek !== "*") {
    if (dayOfWeek === "1-5") return `每个工作日 ${time}`;
    return `每${weekdayList(dayOfWeek)} ${time}`;
  }

  if (month === "*" && dayOfWeek === "*" && isIntegerToken(dayOfMonth)) {
    return `每月 ${dayOfMonth} 日 ${time}`;
  }

  if (month !== "*" && dayOfWeek === "*" && isIntegerToken(dayOfMonth)) {
    return `每年 ${month} 月 ${dayOfMonth} 日 ${time}`;
  }

  return `自定义调度（分 ${minute} 时 ${hour} 日 ${dayOfMonth} 月 ${month} 周 ${dayOfWeek}）`;
}

export function scheduleSummary(expr: string): string {
  const normalized = normalizeExpr(expr);
  if (!normalized) return "尚未设置调度";
  const parts = cronParts(normalized);
  if (!parts) return `表达式格式不完整：${normalized}`;

  const preset = presetForExpr(normalized);
  const [minute] = parts;
  const time = formatCronTime(parts[0], parts[1]);

  switch (preset.value) {
    case "daily":
      return `每天 ${time}`;
    case "weekdays":
      return `每个工作日 ${time}`;
    case "weekly":
      return `每${weekdayLabel(parts[4])} ${time}`;
    case "monthly":
      return `每月 ${parts[2]} 日 ${time}`;
    case "hourly":
      return minute === "0" ? "每小时整点" : `每小时第 ${minute} 分`;
    case "every-15-minutes":
      return "每 15 分钟";
    default:
      return customSummary(parts);
  }
}

function validateField(field: string, value: string, spec: FieldSpec): string | null {
  if (!/^[0-9*/,\-]+$/.test(value)) {
    return `${spec.label}字段含非法字符：${value}（只允许数字、* / , -）`;
  }

  for (const chunk of value.split(",")) {
    const piece = chunk.trim();
    if (!piece) {
      return `${spec.label}字段有空的取值：${value}`;
    }

    const [rangePart, stepPart] = piece.split("/");
    if (stepPart !== undefined) {
      const step = Number(stepPart);
      if (!/^\d+$/.test(stepPart) || step < 1) {
        return `${spec.label}字段的步长「${stepPart}」无效，应为大于 0 的整数`;
      }
    }

    if (rangePart === "*") continue;

    const bounds = rangePart.split("-");
    if (bounds.length > 2) {
      return `${spec.label}字段的区间「${rangePart}」格式不对，应为 a-b`;
    }

    for (const bound of bounds) {
      if (!/^\d+$/.test(bound)) {
        return `${spec.label}字段的取值「${bound}」不是数字`;
      }
      const numeric = Number(bound);
      if (numeric < spec.min || numeric > spec.max) {
        return `${spec.label}字段取值「${bound}」超出 ${spec.min}-${spec.max} 范围`;
      }
    }

    if (bounds.length === 2 && Number(bounds[0]) > Number(bounds[1])) {
      return `${spec.label}字段的区间「${rangePart}」起点大于终点`;
    }
  }

  return null;
}

export function validateCronExpr(expr: string): string | null {
  const normalized = normalizeExpr(expr);
  if (!normalized) {
    return "请填写调度表达式，例如 0 9 * * *";
  }

  const parts = cronParts(normalized);
  if (!parts) {
    const count = normalized.split(" ").filter(Boolean).length;
    return `调度表达式需要 5 段（分 时 日 月 周），当前 ${count} 段`;
  }

  for (let index = 0; index < FIELD_SPECS.length; index += 1) {
    const error = validateField(parts[index], parts[index], FIELD_SPECS[index]);
    if (error) return error;
  }

  return null;
}

export function scheduleBadgeText(expr: string): string {
  const normalized = normalizeExpr(expr);
  return normalized ? `${scheduleSummary(normalized)}（${normalized}）` : "尚未设置调度";
}
