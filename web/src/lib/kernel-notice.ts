/**
 * 内核把「异步派发的子代理批次完成」回报以 role=user 注入会话，正文首行是
 * `[ASYNC DELEGATION BATCH COMPLETE — deleg_xxx]` 这类标记。它不是用户发的
 * 聊天消息，展示模型要把它归到系统侧。
 *
 * 标记由 Core 的 tools/process_registry_notifications.py 产生，共三种：
 *   [ASYNC DELEGATION BATCH COMPLETE — deleg_x]      扇出批次合并回报
 *   [ASYNC DELEGATION COMPLETE — deleg_x]            单个子代理完成
 *   [ASYNC DELEGATION TASK FAILED — deleg_x, task 2/3]  批次中某个子任务失败
 */

const ASYNC_DELEGATION_NOTICE_RE =
  /^[ \t]*\[ASYNC DELEGATION (?:BATCH COMPLETE|TASK FAILED|COMPLETE)\b[^\]\r\n]*\]/;

const ASYNC_DELEGATION_MARKER_RE =
  /^[ \t]*\[ASYNC DELEGATION [^\]\r\n]*\]\r?\n?/;

const DELEGATION_ID_RE = /\bdeleg_[A-Za-z0-9_-]+/;

export type KernelNoticeKind = "async-delegation-result" | "async-delegation-failure";

export interface KernelNotice {
  kind: KernelNoticeKind;
  delegationId?: string;
  title: string;
  body: string;
}

/** 首行标记是否属于内核注入的异步子代理回报族。 */
export function isKernelInjectedNotice(text: string | null | undefined): boolean {
  return ASYNC_DELEGATION_NOTICE_RE.test(text ?? "");
}

export function kernelNoticeKind(text: string | null | undefined): KernelNoticeKind | null {
  const value = text ?? "";
  if (!ASYNC_DELEGATION_NOTICE_RE.test(value)) return null;
  return /^[ \t]*\[ASYNC DELEGATION TASK FAILED\b/.test(value)
    ? "async-delegation-failure"
    : "async-delegation-result";
}

/** 去掉标记行后的正文（标记里的委派 id 由调用方单独展示，不重复）。 */
export function kernelNoticeBody(text: string): string {
  return text.replace(ASYNC_DELEGATION_MARKER_RE, "").trimStart();
}

export function kernelNoticeDelegationId(text: string): string | undefined {
  return text.match(DELEGATION_ID_RE)?.[0];
}

export function kernelNotice(text: string | null | undefined): KernelNotice | null {
  const value = text ?? "";
  const kind = kernelNoticeKind(value);
  if (!kind) return null;
  return {
    kind,
    delegationId: kernelNoticeDelegationId(value),
    title: kind === "async-delegation-failure" ? "子代理任务失败" : "子代理任务结果",
    body: kernelNoticeBody(value),
  };
}
