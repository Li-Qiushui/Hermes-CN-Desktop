/**
 * Friendly parsing for gateway RPC results.
 *
 * If an RPC result is shaped unexpectedly (runtime version skew, error frame,
 * missing field) the call sites in `use-gateway.ts` used to do a bare
 * `Schema.parse(...)` and the raw `ZodError` — e.g. the infamous
 * `[{"path":["session_id"],"message":"Required"}]` — leaked straight into the
 * chat UI.
 *
 * `parseGatewayResult` keeps the strong typing but converts a parse failure
 * into a user-readable Chinese message while recording a redacted debug summary
 * (method + raw result + zod issues) for diagnostics. `humanizeGatewayError`
 * is the display-boundary fallback so no raw ZodError / English transport error
 * ever reaches the user.
 */
import { debugBus } from "./debug-bus";

/** Error carrying a user-facing (Chinese) message; raw cause is in debugBus. */
export class GatewayResultError extends Error {
  readonly method: string;

  constructor(message: string, method: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "GatewayResultError";
    this.method = method;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

interface ZodLikeError {
  name: string;
  issues: unknown[];
  message: string;
}

function isZodError(error: unknown): error is ZodLikeError {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "ZodError" &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

function genericResultMessage(method: string): string {
  return `内核返回了无法识别的响应（${method}）。可能是版本不一致或连接异常，请重试；若仍失败，请重启 Hermes。`;
}

export type GatewayErrorKind =
  | "unsupported-method"
  | "auth"
  | "not-found"
  | "timeout"
  | "network"
  | "server"
  | "unknown";

/**
 * RPC 失败的统一结构化形态。调用方拿到 error 后调 `classifyGatewayError(error)`
 * 自行决定怎么降级，别只依赖 `humanizeGatewayError` 给的字符串：
 *
 * ```ts
 * const info = classifyGatewayError(error);
 * if (info.kind === "unsupported-method") {
 *   return localFallback;            // 当前内核没这个 RPC，走本地兜底
 * }
 * setErrorText(humanizeGatewayError(error));
 * ```
 */
export interface GatewayErrorInfo {
  kind: GatewayErrorKind;
  method?: string;
  code?: number;
  retryable: boolean;
  message: string;
}

/** 网关回的错误帧；保留 method / code，供分类时精确定位。 */
export class GatewayRpcError extends Error {
  readonly method?: string;
  readonly code?: number;

  constructor(message: string, options?: { method?: string; code?: number; cause?: unknown }) {
    super(message);
    this.name = "GatewayRpcError";
    this.method = options?.method;
    this.code = options?.code;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

const UNSUPPORTED_METHOD_PATTERNS = [
  /unknown method/i,
  /method not found/i,
  /unsupported method/i,
  /not implemented/i,
  /out of sync/i,
  /hermes update/i,
  /当前内核不支持该功能/,
];

const METHOD_IN_MESSAGE =
  /(?:unknown method|method not found|unsupported method|not implemented)[:\s]+([A-Za-z0-9_.:-]+)/i;

function methodFromMessage(message: string): string | undefined {
  const zh = /当前内核不支持该功能（([^）]+)）/.exec(message);
  if (zh && zh[1]) return zh[1];
  const match = METHOD_IN_MESSAGE.exec(message);
  if (!match || !match[1]) return undefined;
  const cleaned = match[1].replace(/[.:]+$/, "");
  return cleaned || undefined;
}

function codeFromMessage(message: string): number | undefined {
  const match = /-32601\b/.exec(message);
  return match ? Number(match[1]) : undefined;
}

/**
 * 内核能力不匹配时的统一人话。壳用户没有 hermes CLI，任何「run 'hermes update'」
 * /「out of sync」/「unknown method」都不能出现在这里。
 */
export function unsupportedMethodMessage(method?: string): string {
  return method
    ? `当前内核不支持该功能（${method}），已降级处理`
    : "当前内核不支持该功能，已降级处理";
}

/**
 * 把任意网关错误归到固定分类。`unsupported-method` 是本次统一降级层关心的那类
 * （方法不存在 / 未实现 / 前后端版本错配，含 JSON-RPC -32601），其余类别只做归类，
 * 文案由 `humanizeGatewayError` 维持原样。
 */
export function classifyGatewayError(error: unknown): GatewayErrorInfo {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const method =
    (error instanceof GatewayRpcError ? error.method : undefined) ?? methodFromMessage(raw);
  const code = (error instanceof GatewayRpcError ? error.code : undefined) ?? codeFromMessage(raw);

  if (code === -32601 || UNSUPPORTED_METHOD_PATTERNS.some((pattern) => pattern.test(raw))) {
    return {
      kind: "unsupported-method",
      method,
      code,
      retryable: false,
      message: unsupportedMethodMessage(method),
    };
  }
  if (code === 401 || code === 403 || /\b401\b|\b403\b|unauthor|forbidden/i.test(raw)) {
    return {
      kind: "auth",
      method,
      code,
      retryable: false,
      message: "登录凭证已失效，请重新登录后再试",
    };
  }
  if (/timeout|超时/i.test(raw)) {
    return {
      kind: "timeout",
      method,
      code,
      retryable: true,
      message:
        "请求超时，请重试。若使用本地模型（如 LM Studio、Ollama），请确认本地服务已启动、模型已加载，且上下文窗口足够大。",
    };
  }
  if (
    /connection closed|connection lost|websocket closed|disconnect|not connected|failed to fetch|networkerror/i.test(
      raw,
    )
  ) {
    return {
      kind: "network",
      method,
      code,
      retryable: true,
      message: "与内核的连接已断开，正在重新连接。",
    };
  }
  if (/\b404\b/i.test(raw)) {
    return {
      kind: "not-found",
      method,
      code,
      retryable: false,
      message: "请求的资源不存在",
    };
  }
  if ((typeof code === "number" && code >= 500) || /internal error|server error/i.test(raw)) {
    return {
      kind: "server",
      method,
      code,
      retryable: true,
      message: "内核服务出错，请稍后重试",
    };
  }
  return { kind: "unknown", method, code, retryable: true, message: raw || "发生错误，请重试。" };
}

/**
 * Validate a gateway RPC result against `schema`. On success returns the parsed
 * value (same type as `schema.parse`). On failure, records a redacted debug
 * summary and throws a friendly {@link GatewayResultError} instead of leaking
 * the raw ZodError to the UI.
 */
export function parseGatewayResult<T>(
  schema: { parse: (value: unknown) => T },
  raw: unknown,
  method: string,
): T {
  try {
    return schema.parse(raw);
  } catch (error) {
    debugBus.push({
      type: "gateway",
      level: "error",
      summary: `RPC ${method} 响应解析失败`,
      payload: {
        method,
        raw,
        issues: isZodError(error) ? error.issues : undefined,
      },
    });
    throw new GatewayResultError(genericResultMessage(method), method, { cause: error });
  }
}

/**
 * Convert any gateway/transport error into a user-facing Chinese string. Used by
 * the chat error display so users never see a raw Zod validation blob or an
 * untranslated transport error. Raw ZodError details are logged to debugBus.
 */
export function humanizeGatewayError(error: unknown): string {
  if (error instanceof GatewayResultError) return error.message;

  const info = classifyGatewayError(error);
  if (info.kind === "unsupported-method") return info.message;

  if (isZodError(error)) {
    debugBus.push({
      type: "gateway",
      level: "error",
      summary: "Gateway 响应解析失败（ZodError）",
      payload: { issues: error.issues },
    });
    return "内核返回了无法识别的响应，请重试；若仍失败，请重启 Hermes。";
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!message) return "发生错误，请重试。";

  const lower = message.toLowerCase();
  if (lower.includes("timeout") || message.includes("超时")) {
    return "请求超时，请重试。若使用本地模型（如 LM Studio、Ollama），请确认本地服务已启动、模型已加载，且上下文窗口足够大。";
  }
  if (
    lower.includes("connection closed") ||
    lower.includes("connection lost") ||
    lower.includes("websocket closed") ||
    lower.includes("disconnect")
  ) {
    return "与内核的连接已断开，正在重新连接。";
  }
  return message;
}
