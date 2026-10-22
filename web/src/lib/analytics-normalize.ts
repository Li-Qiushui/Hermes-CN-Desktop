import { AnalyticsResponse } from "@hermes/protocol";

/**
 * 内核 /api/analytics/usage 的字段会随版本增删（例如 0.22.x 不下发
 * `comparison`、`top_sessions`，`by_model` 里没有 provider / reasoning 等）。
 * 桌面端不该因为少几个可选字段就整页报「合约不匹配」，
 * 因此这里在协议校验前补齐默认值：缺失的数字按 0，缺失的列表按空数组，
 * 缺失的对比周期按「无对比数据」处理（KPI 会显示 — 而不是 0% 变化）。
 */
type Raw = Record<string, unknown>;

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function obj(value: unknown): Raw {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeTotals(value: unknown) {
  const raw = obj(value);
  const totalInput = num(raw.total_input);
  const totalOutput = num(raw.total_output);
  const totalCacheWrite = num(raw.total_cache_write);
  const totalReasoning = num(raw.total_reasoning);
  const totalSessions = num(raw.total_sessions);
  const totalTokens =
    typeof raw.total_tokens === "number"
      ? num(raw.total_tokens)
      // 与逐模型/逐天口径保持一致：tokens = 输入 + 输出，
      // 缓存读写与推理另列（否则模型占比会算出 >100%）。
      : totalInput + totalOutput;
  return {
    total_input: totalInput,
    total_output: totalOutput,
    total_tokens: totalTokens,
    total_cache_read: num(raw.total_cache_read),
    total_cache_write: totalCacheWrite,
    total_reasoning: totalReasoning,
    total_sessions: totalSessions,
    total_api_calls: num(raw.total_api_calls),
    avg_tokens_per_session:
      typeof raw.avg_tokens_per_session === "number"
        ? num(raw.avg_tokens_per_session)
        : totalSessions > 0
          ? totalTokens / totalSessions
          : 0,
  };
}

function normalizeDay(value: unknown) {
  const raw = obj(value);
  return {
    day: str(raw.day),
    input_tokens: num(raw.input_tokens),
    output_tokens: num(raw.output_tokens),
    cache_read_tokens: num(raw.cache_read_tokens),
    cache_write_tokens: num(raw.cache_write_tokens),
    reasoning_tokens: num(raw.reasoning_tokens),
    sessions: num(raw.sessions),
    api_calls: num(raw.api_calls),
  };
}

function normalizeModel(value: unknown) {
  const raw = obj(value);
  return {
    model: str(raw.model) || "未知模型",
    provider: str(raw.provider),
    input_tokens: num(raw.input_tokens),
    output_tokens: num(raw.output_tokens),
    cache_read_tokens: num(raw.cache_read_tokens),
    cache_write_tokens: num(raw.cache_write_tokens),
    reasoning_tokens: num(raw.reasoning_tokens),
    sessions: num(raw.sessions),
    api_calls: num(raw.api_calls),
  };
}

function normalizeTopSession(value: unknown) {
  const raw = obj(value);
  return {
    session_id: str(raw.session_id),
    title: typeof raw.title === "string" ? raw.title : null,
    model: typeof raw.model === "string" ? raw.model : null,
    provider: str(raw.provider),
    started_at: num(raw.started_at),
    ended_at: typeof raw.ended_at === "number" ? raw.ended_at : null,
    input_tokens: num(raw.input_tokens),
    output_tokens: num(raw.output_tokens),
    cache_read_tokens: num(raw.cache_read_tokens),
    cache_write_tokens: num(raw.cache_write_tokens),
    reasoning_tokens: num(raw.reasoning_tokens),
    api_calls: num(raw.api_calls),
  };
}

function normalizeSkills(value: unknown) {
  const raw = obj(value);
  const summary = obj(raw.summary);
  return {
    summary: {
      total_skill_loads: num(summary.total_skill_loads),
      total_skill_edits: num(summary.total_skill_edits),
      total_skill_actions: num(summary.total_skill_actions),
      distinct_skills_used: num(summary.distinct_skills_used),
    },
    top_skills: arr(raw.top_skills)
      .map((item) => {
        const skill = obj(item);
        return {
          skill: str(skill.skill),
          view_count: num(skill.view_count),
          manage_count: num(skill.manage_count),
          total_count: num(skill.total_count),
          percentage: num(skill.percentage),
          last_used_at: typeof skill.last_used_at === "number" ? skill.last_used_at : null,
        };
      })
      .filter((item) => item.skill.length > 0),
  };
}

/** 把任意版本的内核响应补成当前协议要求的形状。 */
export function normalizeAnalyticsPayload(raw: unknown): AnalyticsResponse {
  const data = obj(raw);
  const comparison = obj(data.comparison);
  return AnalyticsResponse.parse({
    daily: arr(data.daily).map(normalizeDay),
    by_model: arr(data.by_model).map(normalizeModel),
    top_sessions: arr(data.top_sessions)
      .map(normalizeTopSession)
      .filter((item) => item.session_id.length > 0),
    totals: normalizeTotals(data.totals),
    comparison: { previous_totals: normalizeTotals(comparison.previous_totals) },
    period_days: typeof data.period_days === "number" ? num(data.period_days) : 30,
    skills: normalizeSkills(data.skills),
  });
}
