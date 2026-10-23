export const RESUME_MAX_RETRIES = 4;
export const RESUME_RETRY_BASE_MS = 1_000;
export const RESUME_RETRY_MAX_MS = 8_000;

export function resumeRetryDelayMs(attempt: number): number {
  const index = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return Math.min(RESUME_RETRY_MAX_MS, RESUME_RETRY_BASE_MS * 2 ** index);
}

export function resumeRetrySchedule(maxRetries = RESUME_MAX_RETRIES): number[] {
  return Array.from({ length: Math.max(0, maxRetries) }, (_entry, index) => resumeRetryDelayMs(index));
}

export type ResumeErrorKind = "recoverable" | "auth" | "not-found";

const AUTH_PATTERNS = [
  /unauthor/,
  /forbidden/,
  /authenticat/,
  /\b401\b/,
  /\b403\b/,
  /invalid api key/,
  /api key/,
  /token (invalid|expired|missing)/,
  /认证/,
  /鉴权/,
  /未授权/,
];

const NOT_FOUND_PATTERNS = [/not found/, /\b404\b/, /no such session/, /会话不存在/, /不存在/];

const RECOVERABLE_PATTERNS = [
  /network/,
  /websocket/,
  /socket/,
  /econnrefused/,
  /econnreset/,
  /etimedout/,
  /timeout/,
  /timed out/,
  /gateway/,
  /not ready/,
  /not connected/,
  /disconnect/,
  /offline/,
  /\b50[234]\b/,
  /bad gateway/,
  /service unavailable/,
  /网关/,
  /超时/,
  /未就绪/,
  /连接/,
];

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

export function classifyResumeError(error: unknown): ResumeErrorKind {
  const message = errorMessage(error).toLowerCase();
  if (AUTH_PATTERNS.some((pattern) => pattern.test(message))) return "auth";
  if (NOT_FOUND_PATTERNS.some((pattern) => pattern.test(message))) return "not-found";
  if (RECOVERABLE_PATTERNS.some((pattern) => pattern.test(message))) return "recoverable";
  return "recoverable";
}

export function isRecoverableResumeError(error: unknown): boolean {
  return classifyResumeError(error) === "recoverable";
}

export interface ResumeRetryInfo {
  attempt: number;
  delayMs: number;
  error: unknown;
}

export interface ResumeWithRetryOptions {
  maxRetries?: number;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (info: ResumeRetryInfo) => void;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export async function resumeWithRetry<T>(
  run: () => Promise<T>,
  options: ResumeWithRetryOptions = {},
): Promise<T> {
  const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? RESUME_MAX_RETRIES));
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || !isRecoverableResumeError(error)) throw error;
      const delayMs = resumeRetryDelayMs(attempt);
      options.onRetry?.({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

export function resumeFailureMessage(error: unknown): string {
  const kind = classifyResumeError(error);
  if (kind === "auth") return "认证失败，凭据无效或未配置；请先修好 API Key 再重试";
  if (kind === "not-found") return "这个会话在后端已经找不到了";
  return "连接后端失败，已重试 4 次仍未成功";
}
