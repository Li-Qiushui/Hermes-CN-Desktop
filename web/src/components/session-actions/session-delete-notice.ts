import s from "./session-actions.module.css";

const NOTICE_ID = "hermes-session-delete-notice";
const NOTICE_TTL_MS = 6000;
let hideTimer: number | null = null;

export function clearSessionDeleteNotice(): void {
  if (typeof document === "undefined") return;
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
  document.getElementById(NOTICE_ID)?.remove();
}

export function showSessionDeleteNotice(message: string): void {
  if (typeof document === "undefined") return;
  const text = message.trim();
  if (!text) return;
  let host = document.getElementById(NOTICE_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = NOTICE_ID;
    host.className = s.deleteNotice;
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
  }
  host.textContent = text;
  if (hideTimer !== null) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    hideTimer = null;
    document.getElementById(NOTICE_ID)?.remove();
  }, NOTICE_TTL_MS);
}
