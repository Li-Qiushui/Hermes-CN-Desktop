/**
 * Reconnect-driven session re-attach helpers.
 *
 * The desktop gateway (Hermes dashboard) has NO socket-level replay/resume and
 * NO server-side event buffer: when the event stream drops (laptop sleep/wake,
 * dashboard restart, flaky network) the backend session keeps running but is
 * orphaned from the dead transport and gets reaped after a grace window.
 *
 * The re-attach itself (single `session.resume` + one replay/snapshot decision)
 * lives in lib/gateway-replay.ts (`recoverAfterReconnect`). What stays here is
 * the error taxonomy the caller needs to tell "the session is gone" (terminal)
 * from "the backend was slow" (recoverable on the next reconnect).
 */
/** Only explicit server-side absence is terminal; timeouts are recoverable. */
export function isDefinitiveMissingSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /(?:session|conversation).*(?:not found|does not exist|unknown|gone|reaped)/i.test(message)
    || /(?:not found|does not exist|unknown|gone|reaped).*(?:session|conversation)/i.test(message);
}
