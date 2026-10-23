import type {
  HermesMessagePart,
  HermesMessageTiming,
  HermesUIMessage,
} from "@hermes/protocol";

type HermesToolPart = Extract<HermesMessagePart, { type: "tool" }>;
type HermesTextPart = Extract<HermesMessagePart, { type: "text" }>;
type HermesReasoningPart = Extract<HermesMessagePart, { type: "reasoning" }>;

const validBoundary = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const earliestBoundary = (...values: (number | undefined)[]): number | undefined => {
  const valid = values.filter(validBoundary);
  return valid.length ? Math.min(...valid) : undefined;
};

const latestBoundary = (...values: (number | undefined)[]): number | undefined => {
  const valid = values.filter(validBoundary);
  return valid.length ? Math.max(...valid) : undefined;
};

export const normalizedTimelineText = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const isHiddenRow = (message: HermesUIMessage): boolean =>
  (message as { hidden?: unknown }).hidden === true;

export const isVisibleAssistantTimelineRow = (message: HermesUIMessage): boolean =>
  message.role === "assistant" && !isHiddenRow(message);

const messageText = (message: HermesUIMessage): string =>
  message.parts
    .filter((part): part is HermesTextPart => part.type === "text")
    .map((part) => part.text)
    .join("");

const toolCallIdSet = (message: HermesUIMessage): Set<string> =>
  new Set(
    message.parts
      .filter((part): part is HermesToolPart => part.type === "tool")
      .map((part) => part.toolCallId),
  );

const textPartsSignature = (parts: HermesMessagePart[]): string => {
  let signature = "";
  for (const part of parts) {
    if (part.type === "text") {
      signature += `${part.text.length},`;
    }
  }
  return signature;
};

const normalizedTextByMessage = new WeakMap<
  HermesUIMessage,
  { signature: string; text: string }
>();

const normalizedTextByPart = new WeakMap<
  HermesMessagePart,
  { type: string; length: number; text: string }
>();

const normalizedMessageText = (message: HermesUIMessage): string => {
  const signature = textPartsSignature(message.parts);
  const cached = normalizedTextByMessage.get(message);

  if (cached !== undefined && cached.signature === signature) {
    return cached.text;
  }

  const text = normalizedTimelineText(messageText(message));
  normalizedTextByMessage.set(message, { signature, text });
  return text;
};

const normalizedPartText = (part: HermesTextPart | HermesReasoningPart): string => {
  const cached = normalizedTextByPart.get(part);

  if (
    cached !== undefined &&
    cached.type === part.type &&
    cached.length === part.text.length
  ) {
    return cached.text;
  }

  const text = normalizedTimelineText(part.text);
  normalizedTextByPart.set(part, { type: part.type, length: part.text.length, text });
  return text;
};

const samePersistedId = (stored: HermesUIMessage, local: HermesUIMessage): boolean => {
  const storedId = stored.metadata?.persistedId;
  const localId = local.metadata?.persistedId;
  return storedId !== undefined && localId !== undefined && storedId === localId;
};

// 与官方一致：渲染 id 相同、工具调用 id 有交集、或空白归一化后正文相同，即同一行。
// CN 的 id 是位置派生的，重拉后同一持久化行会换 id，因此额外认 metadata.persistedId。
const assistantTimelineMatch = (stored: HermesUIMessage, local: HermesUIMessage): boolean => {
  if (stored.id === local.id) {
    return true;
  }

  if (samePersistedId(stored, local)) {
    return true;
  }

  const localToolIds = toolCallIdSet(local);

  if (
    localToolIds.size > 0 &&
    stored.parts.some((part) => part.type === "tool" && localToolIds.has(part.toolCallId))
  ) {
    return true;
  }

  const storedText = normalizedMessageText(stored);

  return Boolean(storedText) && storedText === normalizedMessageText(local);
};

const timelinePartMatch = (stored: HermesMessagePart, local: HermesMessagePart): boolean => {
  if (stored.type !== local.type) {
    return false;
  }

  if (stored.type === "tool") {
    return stored.toolCallId === (local as HermesToolPart).toolCallId;
  }

  if (stored.type === "text") {
    return normalizedPartText(stored) === normalizedPartText(local as HermesTextPart);
  }

  if (stored.type === "reasoning") {
    return normalizedPartText(stored) === normalizedPartText(local as HermesReasoningPart);
  }

  return false;
};

// 官方把 part 的 timestamp 取最早、completedAt 取最晚挂回 stored。CN 只有 tool part
// 带 startedAt/completedAt，text/reasoning part 没有时间字段可挂（见上报差异清单）。
const graftToolPartTiming = (part: HermesToolPart, local: HermesToolPart): HermesToolPart => ({
  ...part,
  startedAt: earliestBoundary(part.startedAt, local.startedAt),
  completedAt: latestBoundary(part.completedAt, local.completedAt),
});

const graftMessageTiming = (
  message: HermesUIMessage,
  local: HermesUIMessage,
  parts: HermesMessagePart[],
): HermesUIMessage => {
  const storedTiming = message.metadata?.timing ?? {};
  const localTiming = local.metadata?.timing ?? {};
  const partStarts = parts.flatMap((part) => (part.type === "tool" ? [part.startedAt] : []));
  const partEnds = parts.flatMap((part) => (part.type === "tool" ? [part.completedAt] : []));

  const timing: HermesMessageTiming = { ...storedTiming };

  const startedAt = earliestBoundary(
    storedTiming.startedAt,
    localTiming.startedAt,
    ...partStarts,
  );
  if (startedAt !== undefined) {
    timing.startedAt = startedAt;
  }

  const firstTokenAt = earliestBoundary(storedTiming.firstTokenAt, localTiming.firstTokenAt);
  if (firstTokenAt !== undefined) {
    timing.firstTokenAt = firstTokenAt;
  }

  const completedAt = latestBoundary(
    storedTiming.completedAt,
    localTiming.completedAt,
    ...partEnds,
  );
  if (completedAt !== undefined) {
    timing.completedAt = completedAt;
  }

  const ttftMs = storedTiming.ttftMs ?? localTiming.ttftMs;
  if (ttftMs !== undefined) {
    timing.ttftMs = ttftMs;
  }

  const durationMs = storedTiming.durationMs ?? localTiming.durationMs;
  if (durationMs !== undefined) {
    timing.durationMs = durationMs;
  }

  if (Object.keys(timing).length === 0) {
    return { ...message, parts };
  }

  return {
    ...message,
    metadata: { ...(message.metadata ?? {}), timing },
    parts,
  };
};

const graftedTimelineByStored = new WeakMap<
  HermesUIMessage,
  WeakMap<HermesUIMessage, HermesUIMessage>
>();

const graftTimelineMessage = (
  message: HermesUIMessage,
  local: HermesUIMessage,
): HermesUIMessage => {
  const cached = graftedTimelineByStored.get(message)?.get(local);

  if (cached !== undefined) {
    return cached;
  }

  const unusedLocalParts = new Set(local.parts.map((_, index) => index));

  const parts = message.parts.map((part) => {
    const localIndex = local.parts.findIndex(
      (candidate, index) => unusedLocalParts.has(index) && timelinePartMatch(part, candidate),
    );

    if (localIndex === -1) {
      return part;
    }

    unusedLocalParts.delete(localIndex);
    const localPart = local.parts[localIndex]!;

    return part.type === "tool" && localPart.type === "tool"
      ? graftToolPartTiming(part, localPart)
      : part;
  });

  const grafted = graftMessageTiming({ ...message, parts }, local, parts);
  const byLocal = graftedTimelineByStored.get(message);

  if (byLocal === undefined) {
    graftedTimelineByStored.set(message, new WeakMap([[local, grafted]]));
  } else {
    byLocal.set(local, grafted);
  }

  return grafted;
};

let lastTimelineReconcile:
  | { next: HermesUIMessage[]; current: HermesUIMessage[]; result: HermesUIMessage[] }
  | undefined;

/**
 * 官方 reconciliation 的合流规则，落到 CN 的消息类型上：
 * - 只有 role === "assistant" 且非 hidden 的行参与；
 * - stored 行是从尾部向前与本地 live 行一一对应的基准（游标只前移）；
 * - 命中后内容与 id 一律用 stored 行，只把本地 live 行存在的时间挂回去；
 * - 不做增删：未命中的 live 行（含尾部 in-flight 行）不在这里处理，
 *   仍由调用方的合流逻辑决定去留（与官方 reconcileLocalAssistantTimeline 一致）。
 */
export function reconcileAssistantTimeline(
  nextMessages: HermesUIMessage[],
  currentMessages: HermesUIMessage[],
): HermesUIMessage[] {
  if (nextMessages.length === 0 || currentMessages.length === 0) {
    return nextMessages;
  }

  if (
    lastTimelineReconcile !== undefined &&
    lastTimelineReconcile.next === nextMessages &&
    lastTimelineReconcile.current === currentMessages
  ) {
    return lastTimelineReconcile.result;
  }

  const result = reconcileTimelinePass(nextMessages, currentMessages);
  lastTimelineReconcile = { next: nextMessages, current: currentMessages, result };
  return result;
}

function reconcileTimelinePass(
  nextMessages: HermesUIMessage[],
  currentMessages: HermesUIMessage[],
): HermesUIMessage[] {
  const localAssistants = currentMessages.filter(isVisibleAssistantTimelineRow);

  if (localAssistants.length === 0) {
    return nextMessages;
  }

  const matches = new Map<number, HermesUIMessage>();
  let localCursor = localAssistants.length - 1;

  for (let nextIndex = nextMessages.length - 1; nextIndex >= 0; nextIndex -= 1) {
    const message = nextMessages[nextIndex]!;

    if (!isVisibleAssistantTimelineRow(message)) {
      continue;
    }

    for (let localIndex = localCursor; localIndex >= 0; localIndex -= 1) {
      const local = localAssistants[localIndex]!;

      if (assistantTimelineMatch(message, local)) {
        matches.set(nextIndex, local);
        localCursor = localIndex - 1;

        break;
      }
    }
  }

  if (matches.size === 0) {
    return nextMessages;
  }

  return nextMessages.map((message, messageIndex) => {
    const local = matches.get(messageIndex);

    if (!local) {
      return message;
    }

    return graftTimelineMessage(message, local);
  });
}
