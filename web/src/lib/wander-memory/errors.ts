// ─────────────────────────────────────────────────────────────────────────────
// wander-memory/errors.ts — ApiError class + the §5.4 code → user-treatment
// table, ported from WanderMemory `web/app/src/api/errors.ts`. Adds `toApiError`
// for coercing arbitrary thrown values (transport errors, unknown payloads)
// into the ApiError contract.
// ─────────────────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  readonly code: string;
  readonly status: number | null; // HTTP status, null for network/WS failures

  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }

  static network(cause: unknown): ApiError {
    const msg = cause instanceof Error ? cause.message : String(cause);
    return new ApiError('network_failure', `服务器无响应 — ${msg}`, null);
  }
}

export type ErrorTreatment =
  | { kind: 'inline'; text: string }
  | { kind: 'toast'; text: string }
  | { kind: 'banner'; text: string }
  | { kind: 'card'; text: string };

/** §5.4 error mapping — every documented code has exactly one treatment. */
export function treatmentFor(err: ApiError): ErrorTreatment {
  switch (err.code) {
    case 'bad_request':
      return { kind: 'inline', text: err.message };
    case 'not_found':
      return { kind: 'toast', text: '找不到该记忆 — 列表可能已过期' };
    case 'unknown_op':
      return { kind: 'toast', text: `客户端缺陷：未知操作（${err.message}）` };
    case 'conflict':
      return { kind: 'toast', text: '记忆系统尚未启动' };
    case 'collision_conflict':
      return { kind: 'toast', text: '并发写入，请重试' };
    case 'llm_unavailable':
    case 'network_failure':
      return { kind: 'banner', text: 'LLM 服务不可用' };
    case 'backend_probe_failed':
      return { kind: 'toast', text: `后端探测失败：${err.message}` };
    case 'collision_parse_failed':
    case 'collision_validation_failed':
      return { kind: 'card', text: `记忆未存储 — ${err.message}` };
    case 'collision_apply_failed':
      return {
        kind: 'card',
        text: `记忆未存储 — 存储已回滚到操作前状态（${err.message}）`,
      };
    case 'internal':
      return { kind: 'toast', text: `内部错误：${err.message}` };
    default:
      return { kind: 'toast', text: wanderErrorLine(err) };
  }
}

const CODE_DESCRIPTIONS: Record<string, string> = {
  network_failure: '连不上记忆服务，请确认 MemOS 已启动、端点设置正确',
  llm_unavailable: 'LLM 服务不可用，请检查模型配置',
  not_found: '找不到这条记忆，列表可能已过期',
  bad_request: '请求参数不合法',
  unknown_op: '客户端与记忆服务版本不匹配',
  conflict: '记忆系统尚未启动',
  collision_conflict: '并发写入，请重试',
  collision_parse_failed: '解析写入内容失败，记忆未存储',
  collision_validation_failed: '写入内容校验失败，记忆未存储',
  collision_apply_failed: '写入失败，已回滚到操作前状态',
  backend_probe_failed: '探测不到后端服务，请确认它已经启动',
  cancelled: '已在客户端取消',
  internal: '记忆服务内部错误',
  unauthorized: '会话未授权，请检查端点令牌',
  forbidden: '没有权限访问记忆服务',
};

/** 上屏用的一行错误：中文说清是什么问题，同时保留 error code 方便排障。 */
export function wanderErrorLine(err: ApiError): string {
  const code = err.code.trim() || 'unknown';
  const hint = CODE_DESCRIPTIONS[code] ?? '未收录的错误码，需要更细的原因请查看日志页';
  return `错误码 ${code}：${hint}`;
}

/** Collision error codes are fail-closed: nothing was stored. */
export const COLLISION_ERROR_CODES = [
  'collision_parse_failed',
  'collision_validation_failed',
  'collision_apply_failed',
] as const;

/**
 * Coerce any thrown value into an ApiError:
 *  - ApiError → passthrough (preserves code/status)
 *  - Error → network failure (no HTTP response was received)
 *  - anything else → "unknown"
 */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof Error) return ApiError.network(err);
  return new ApiError('unknown', `未知错误：${String(err)}`, null);
}
