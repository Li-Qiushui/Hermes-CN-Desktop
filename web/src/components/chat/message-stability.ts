import type { ChatMessage } from "@/components/chat/chat-types";

/**
 * 流式输出时 adapter 每个 token 都会重建整份 ChatMessage 数组，导致
 * `MessageBubble` 的 memo（按 message 引用比较）全部 miss，一条长会话
 * 每帧都要重新渲染几十个气泡。
 *
 * 这里按「内容没变就复用旧对象」的规则做一次引用稳定化：只让真正变化的
 * 那条消息（通常是正在流式输出的最后一条）拿到新引用，其余保持原样。
 */

const SCALAR_KEYS = [
  "id",
  "role",
  "createdAt",
  "text",
  "reasoning",
  "status",
  "title",
  "error",
] as const;

const LIST_KEYS = ["images", "media", "tools", "blocks"] as const;

function statsEqual(
  a: ChatMessage["stats"],
  b: ChatMessage["stats"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a) as (keyof NonNullable<ChatMessage["stats"]>)[];
  const keysB = Object.keys(b) as (keyof NonNullable<ChatMessage["stats"]>)[];
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

/** 两条消息渲染结果是否等价：标量逐字段比，列表比引用+长度，统计比字段。 */
export function chatMessagesEqual(a: ChatMessage, b: ChatMessage): boolean {
  if (a === b) return true;

  for (const key of SCALAR_KEYS) {
    if (!Object.is(a[key], b[key])) return false;
  }

  for (const key of LIST_KEYS) {
    const listA = a[key];
    const listB = b[key];
    if (listA === listB) continue;
    if (!listA || !listB) return false;
    if (listA.length !== listB.length) return false;
    // 引用不同但长度相同：保守起见认为变了（列表内容通常整体重建）。
    return false;
  }

  return statsEqual(a.stats, b.stats);
}

/**
 * 返回一份新数组，但尽量复用 `previous` 里内容未变的元素引用。
 * id 顺序变化（分支、重排）时直接返回 `next`，避免错位复用。
 */
export function stabilizeChatMessages(
  previous: ChatMessage[] | undefined,
  next: ChatMessage[],
): ChatMessage[] {
  if (!previous || previous.length === 0) return next;
  if (previous.length === next.length) {
    let sameOrder = true;
    for (let i = 0; i < next.length; i += 1) {
      if (previous[i].id !== next[i].id) {
        sameOrder = false;
        break;
      }
    }
    if (sameOrder) {
      let changed = false;
      const merged = next.map((message, index) => {
        const before = previous[index];
        if (chatMessagesEqual(before, message)) {
          if (before !== message) changed = true;
          return before;
        }
        changed = true;
        return message;
      });
      return changed ? merged : previous;
    }
  }

  // 长度或顺序变化：按 id 建索引尽量复用，新消息保持新引用。
  const byId = new Map(previous.map((message) => [message.id, message]));
  return next.map((message) => {
    const before = byId.get(message.id);
    return before && chatMessagesEqual(before, message) ? before : message;
  });
}
