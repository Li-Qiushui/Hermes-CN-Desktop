/**
 * 内核在「回合被中断后续跑」时，会往会话里补一条 role=user 的行，正文以
 * `[System note: Your previous turn was interrupted mid-run …]` 开头，并打上
 * display_kind="auto_continue"（前缀常量见内核
 * tui_gateway/session_history.py 的 _AUTO_CONTINUE_NOTE_PREFIX）。
 *
 * 那是写给模型看的说明，不是用户发出的消息：展示层必须把它折成与断线/续跑
 * 同一类的中文灰卡，且整条时间线只留一条。
 */

export const AUTO_CONTINUED_NOTICE_TEXT = "内核已自动续跑被中断的本轮，已执行的命令可能重复";

const AUTO_CONTINUE_FRAME_RE =
  /^[ \t]*\[[ \t]*system[ \t]+note[ \t]*:[ \t]*your[ \t]+previous[ \t]+turn[ \t]+was[ \t]+interrupted[ \t]+mid-run/i;

export function isAutoContinueFrame(value: string | null | undefined): boolean {
  const text = (value ?? "").trim();
  if (!text) return false;
  return AUTO_CONTINUE_FRAME_RE.test(text);
}

export function autoContinueFrameNoticeText(value: string | null | undefined): string | null {
  return isAutoContinueFrame(value) ? AUTO_CONTINUED_NOTICE_TEXT : null;
}

export function isAutoContinuedNoticeText(value: string | null | undefined): boolean {
  return (value ?? "").trim() === AUTO_CONTINUED_NOTICE_TEXT;
}
