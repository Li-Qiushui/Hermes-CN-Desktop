import type { HermesMessagePart, HermesUIMessage } from "@hermes/protocol";

export const INTERRUPTED_TOOL_ERROR_TEXT = "已中断，未拿到执行结果";

type HermesToolPart = Extract<HermesMessagePart, { type: "tool" }>;

export interface TurnScope {
  /** 当前回合是否在跑；false / 缺省表示没有活动回合，任何 running 工具都等不到结果。 */
  turnActive?: boolean;
  /** 当前回合的起点（ms）。比它更早起跑的工具属于上一回合。 */
  turnStartedAt?: number;
}

function toolStartedAt(part: HermesToolPart, message: HermesUIMessage): number {
  return typeof part.startedAt === "number" ? part.startedAt : message.createdAt;
}

function latestUserMessageAt(messages: HermesUIMessage[]): number | undefined {
  let latest: number | undefined;
  messages.forEach((message) => {
    if (message.role !== "user") return;
    if (latest === undefined || message.createdAt > latest) latest = message.createdAt;
  });
  return latest;
}

function latestActivityAt(messages: HermesUIMessage[]): number | undefined {
  let latest: number | undefined;
  const bump = (value: number | undefined) => {
    if (typeof value !== "number") return;
    if (latest === undefined || value > latest) latest = value;
  };
  messages.forEach((message) => {
    bump(message.createdAt);
    message.parts.forEach((part) => {
      if (part.type !== "tool") return;
      bump(part.startedAt);
      bump(part.completedAt);
    });
  });
  return latest;
}

/**
 * 一条工具卡只能属于当前活动回合。回合边界取 `turnStartedAt` 与时间线上最后一条用户消息的
 * 较大值：内核续跑会在会话里补一条 role=user 的续跑帧，它就是新回合的起点。比边界更早起跑、
 * 又拿不到结果的 running 工具永远等不到 tool.complete，就地收敛成现有的中断语义
 * （state=error + 固定文案 + 冻结的 completedAt），迟到/补发的 tool.complete 仍按
 * toolCallId 覆盖回完成态。
 */
export function settleStaleRunningToolParts(
  messages: HermesUIMessage[],
  scope: TurnScope = {},
): HermesUIMessage[] {
  const turnActive = scope.turnActive === true;
  const boundary = turnActive
    ? Math.max(
      scope.turnStartedAt ?? Number.NEGATIVE_INFINITY,
      latestUserMessageAt(messages) ?? Number.NEGATIVE_INFINITY,
    )
    : Number.POSITIVE_INFINITY;
  const frozenAt = Number.isFinite(boundary)
    ? boundary
    : latestUserMessageAt(messages) ?? latestActivityAt(messages) ?? Number.NEGATIVE_INFINITY;

  let changed = false;
  const settled = messages.map((message) => {
    if (message.role !== "assistant") return message;
    let touched = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool" || part.state !== "running") return part;
      const startedAt = toolStartedAt(part, message);
      if (startedAt >= boundary) return part;
      touched = true;
      return {
        ...part,
        state: "error" as const,
        errorText: part.errorText ?? INTERRUPTED_TOOL_ERROR_TEXT,
        completedAt: Number.isFinite(frozenAt) ? Math.max(startedAt, frozenAt) : startedAt,
      };
    });
    if (!touched) return message;
    changed = true;
    return { ...message, parts };
  });

  return changed ? settled : messages;
}
