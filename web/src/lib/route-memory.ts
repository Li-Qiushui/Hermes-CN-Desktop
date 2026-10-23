import { readUiValue, removeUiValue, writeUiValue } from "@/lib/ui-store";

export const LAST_ROUTE_STORAGE_KEY = "hermes-cn-ui.lastRoute";

const NON_RESTORABLE_ROUTES = new Set(["/", "/new", "/guide"]);

export function isSessionRoute(pathname: string): boolean {
  return pathname.startsWith("/tasks/");
}

export function sessionIdFromRoute(pathname: string): string | null {
  if (!isSessionRoute(pathname)) return null;
  const raw = pathname.slice("/tasks/".length);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw) || null;
  } catch {
    return raw;
  }
}

export function isRestorableRoute(pathname: string): boolean {
  const clean = pathname.trim();
  if (!clean || !clean.startsWith("/")) return false;
  if (NON_RESTORABLE_ROUTES.has(clean)) return false;
  return true;
}

export function readLastRoute(): string | null {
  const value = readUiValue<unknown>(LAST_ROUTE_STORAGE_KEY, null);
  return typeof value === "string" && isRestorableRoute(value) ? value : null;
}

export function rememberLastRoute(pathname: string): void {
  const clean = pathname.trim();
  if (!isRestorableRoute(clean)) return;
  if (readLastRoute() === clean) return;
  writeUiValue(LAST_ROUTE_STORAGE_KEY, clean);
}

export function clearLastRoute(): void {
  removeUiValue(LAST_ROUTE_STORAGE_KEY);
}

export interface RestoreTargetInput {
  stored: string | null;
  currentPathname: string;
  sessionExists?: boolean | null;
}

export function resolveRestoreTarget({
  stored,
  currentPathname,
  sessionExists = null,
}: RestoreTargetInput): string | null {
  if (!stored || !isRestorableRoute(stored)) return null;
  if (currentPathname !== "/") return null;
  if (!isSessionRoute(stored)) return stored;
  return sessionExists === true ? stored : null;
}

export function shouldValidateRestoredSession(stored: string | null, currentPathname: string): string | null {
  if (!stored || currentPathname !== "/") return null;
  return sessionIdFromRoute(stored);
}

export function defaultNewSessionHref(
  pathname: string,
  search: string,
  lastWorkspace: string,
): string | null {
  if (pathname !== "/") return null;
  const params = new URLSearchParams(search);
  if (params.get("workspace")) return null;
  const clean = lastWorkspace.trim();
  if (!clean) return null;
  return `/?workspace=${encodeURIComponent(clean)}`;
}
