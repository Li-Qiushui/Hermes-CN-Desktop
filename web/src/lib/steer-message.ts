/**
 * 中途插话（/steer）在会话库里是 role=user 的原文，内核给它套了一对自我说明的
 * 边界标记（agent/prompt_builder.py 的 STEER_MARKER_OPEN / CLOSE）：
 *
 *   [OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once
 *    at this position; not tool output and not a new delivery when replayed
 *    from conversation history]
 *   用户写的那句
 *   [/OUT-OF-BAND USER MESSAGE]
 *
 * 标记是给模型看的通道说明，不是用户写的内容，展示与复制都要剥掉。
 */

const STEER_OPEN_RE = /\[[ \t]*OUT-OF-BAND USER MESSAGE\b[^\]\r\n]*\]/gi;
const STEER_CLOSE_RE = /\[[ \t]*\/[ \t]*OUT-OF-BAND USER MESSAGE[ \t]*\]/gi;
const STEER_ANY_RE = /OUT-OF-BAND USER MESSAGE/i;

export interface SteerText {
  text: string;
  steer: boolean;
}

export function stripSteerWrapper(value: string | null | undefined): SteerText {
  const raw = value ?? "";
  if (!STEER_ANY_RE.test(raw)) return { text: raw, steer: false };
  const text = raw
    .replace(STEER_OPEN_RE, "")
    .replace(STEER_CLOSE_RE, "")
    .replace(/[ \t]+\r?\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, steer: true };
}

export function steerMessageBody(value: string | null | undefined): string {
  return stripSteerWrapper(value).text;
}

export function isSteerMessage(value: string | null | undefined): boolean {
  return stripSteerWrapper(value).steer;
}

export const STEER_NOTE = "（你在本轮运行中插话）";
