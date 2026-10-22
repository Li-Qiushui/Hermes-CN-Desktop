import type { MoaConfigResponse, MoaPresetConfig } from "@hermes/protocol";

function translateIssue(issue: string): string {
  if (/must be an object with 'provider' and 'model'/.test(issue)) return "槽位格式不对（需要服务商 + 模型）";
  if (/^provider and model are required$/.test(issue)) return "服务商和模型都不能空";
  if (/^provider is required$/.test(issue)) return "缺少服务商";
  const missingModel = /^model is required \(provider '([^']*)' has no model selected\)$/.exec(issue);
  if (missingModel) return `服务商「${missingModel[1]}」还没选模型`;
  if (/recursive MoA/.test(issue)) return "MoA 服务商不能嵌套在预设里（会递归）";
  return issue;
}

function translateProblem(problem: string): string {
  const reference = /^preset '([^']*)' reference (\d+): ([\s\S]*)$/.exec(problem);
  if (reference) return `预设「${reference[1]}」的参考模型 ${reference[2]}：${translateIssue(reference[3])}`;
  const aggregator = /^preset '([^']*)' aggregator: ([\s\S]*)$/.exec(problem);
  if (aggregator) return `预设「${aggregator[1]}」的聚合器：${translateIssue(aggregator[2])}`;
  const needReference = /^preset '([^']*)': needs at least one complete reference model$/.exec(problem);
  if (needReference) return `预设「${needReference[1]}」至少要有一个填完整的参考模型`;
  const notObject = /^preset '([^']*)': must be an object$/.exec(problem);
  if (notObject) return `预设「${notObject[1]}」格式不对（应该是对象）`;
  if (/^MoA config must be an object$/.test(problem)) return "MoA 配置格式不对（应该是对象）";
  return translateIssue(problem);
}

export function translateMoaDetail(detail: string): string {
  const body = detail.replace(/^Invalid MoA config:\s*/, "").trim();
  if (!body) return "";
  return body.split(/\s*;\s*/).map(translateProblem).join("；");
}

function slotProblem(slot: { provider?: string; model?: string }, label: string): string | null {
  const provider = (slot.provider ?? "").trim();
  const model = (slot.model ?? "").trim();
  if (!provider && !model) return `${label}：还没选服务商和模型`;
  if (!provider) return `${label}：还没选服务商`;
  if (!model) return `${label}：还没选模型（服务商「${provider}」）`;
  if (provider.toLowerCase() === "moa") return `${label}：不能用 MoA 服务商（会递归）`;
  return null;
}

export function moaPresetProblems(preset: MoaPresetConfig, presetName: string): string[] {
  const problems: string[] = [];
  preset.reference_models.forEach((slot, index) => {
    const problem = slotProblem(slot, `预设「${presetName}」的参考模型 ${index + 1}`);
    if (problem) problems.push(problem);
  });
  const aggregatorProblem = slotProblem(preset.aggregator, `预设「${presetName}」的聚合器`);
  if (aggregatorProblem) problems.push(aggregatorProblem);
  return problems;
}

export function moaConfigProblems(config: MoaConfigResponse): string[] {
  return Object.entries(config.presets).flatMap(([name, preset]) => moaPresetProblems(preset, name));
}

function errorBodyDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; error?: unknown } | null;
    if (typeof parsed?.detail === "string") return parsed.detail;
    if (Array.isArray(parsed?.detail)) {
      return parsed.detail
        .map((item) => (typeof item === "object" && item && "msg" in item ? String((item as { msg: unknown }).msg) : ""))
        .filter(Boolean)
        .join("；");
    }
    const error = parsed?.error;
    if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  } catch {
    return "";
  }
  return "";
}

export function moaSaveErrorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const http = /^HTTP (\d+): ([\s\S]*)$/.exec(message);
  if (!http) return `保存失败：${message}`;

  const status = Number(http[1]);
  const detail = errorBodyDetail(http[2]);
  const translated = detail ? translateMoaDetail(detail) : "";

  if (status === 401 || status === 403) {
    return `没有权限保存 MoA 配置（HTTP ${status}），请检查会话令牌后重试`;
  }
  if (status === 422) {
    return `内核拒绝了这份配置：${translated || detail || "配置里有填不完整的槽位"}`;
  }
  if (status === 404) {
    return "当前内核没有 MoA 接口，无法保存（需要较新的 Hermes 内核）";
  }
  return `保存失败（HTTP ${status}）：${translated || detail || http[2].slice(0, 120) || "内核没有返回原因"}`;
}
