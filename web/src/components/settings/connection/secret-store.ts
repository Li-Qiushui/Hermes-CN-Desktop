import { CONNECTION_TOKEN_SECRET_PREFIX } from "@/lib/connection-registry";
import { readUiValue, removeUiValue, writeUiValue } from "@/lib/ui-store";

export type SecretScheme = "dpapi" | "none";

export interface SecretStorageStatus {
  available: boolean;
  scheme: SecretScheme;
  source: "native" | "unavailable";
}

interface StoredSecret {
  scheme: SecretScheme;
  payload: string;
}

interface NativeBridge {
  secretsStatus?: () => Promise<{ available: boolean; scheme: string }>;
  secretsProtect?: (input: { value: string }) => Promise<{ payload: string; scheme: string }>;
  secretsUnprotect?: (input: { payload: string }) => Promise<{ value: string }>;
}

const UNAVAILABLE: SecretStorageStatus = { available: false, scheme: "none", source: "unavailable" };

let statusPromise: Promise<SecretStorageStatus> | null = null;

function bridge(): NativeBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return window.hermesDesktop as unknown as NativeBridge | undefined;
}

function nativeRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return window.__HERMES_RUNTIME__?.platform === "tauri" || window.hermesDesktop?.windowType === "tauri";
}

async function callNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import("@tauri-apps/api/core");
  return mod.invoke<T>(command, args);
}

async function nativeStatus(): Promise<{ available: boolean; scheme: string } | null> {
  const native = bridge();
  if (native?.secretsStatus) return native.secretsStatus();
  if (!nativeRuntime()) return null;
  try {
    return await callNative<{ available: boolean; scheme: string }>("secrets_status");
  } catch {
    return null;
  }
}

export async function getSecretStorageStatus(): Promise<SecretStorageStatus> {
  if (statusPromise) return statusPromise;
  statusPromise = (async () => {
    try {
      const status = await nativeStatus();
      if (!status) return UNAVAILABLE;
      const scheme: SecretScheme = status.scheme === "dpapi" && status.available ? "dpapi" : "none";
      return { available: status.available && scheme === "dpapi", scheme, source: "native" as const };
    } catch {
      return UNAVAILABLE;
    }
  })();
  return statusPromise;
}

export function __resetSecretStorageStatusForTests(): void {
  statusPromise = null;
}

async function protect(value: string): Promise<string | null> {
  const native = bridge();
  try {
    if (native?.secretsProtect) {
      const result = await native.secretsProtect({ value });
      return result?.payload ?? null;
    }
    if (!nativeRuntime()) return null;
    const result = await callNative<{ payload: string }>("secrets_protect", { value });
    return result?.payload ?? null;
  } catch {
    return null;
  }
}

async function unprotect(payload: string): Promise<string | null> {
  const native = bridge();
  try {
    if (native?.secretsUnprotect) {
      const result = await native.secretsUnprotect({ payload });
      return result?.value ?? null;
    }
    if (!nativeRuntime()) return null;
    const result = await callNative<{ value: string }>("secrets_unprotect", { payload });
    return result?.value ?? null;
  } catch {
    return null;
  }
}

function secretKey(tokenRef: string): string {
  return `${CONNECTION_TOKEN_SECRET_PREFIX}${tokenRef}`;
}

function isStoredSecret(value: unknown): value is StoredSecret {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.payload === "string" && record.payload.length > 0;
}

export interface TokenSaveResult {
  ok: boolean;
  reason?: "unsupported" | "encrypt-failed";
}

export async function saveConnectionToken(tokenRef: string, token: string): Promise<TokenSaveResult> {
  const status = await getSecretStorageStatus();
  if (!status.available) return { ok: false, reason: "unsupported" };
  const payload = await protect(token);
  if (!payload) return { ok: false, reason: "encrypt-failed" };
  writeUiValue(secretKey(tokenRef), { scheme: status.scheme, payload } satisfies StoredSecret);
  return { ok: true };
}

export async function readConnectionToken(tokenRef: string): Promise<string | null> {
  const stored = readUiValue<unknown>(secretKey(tokenRef), null);
  if (!isStoredSecret(stored)) return null;
  return unprotect(stored.payload);
}

export function hasEncryptedToken(tokenRef: string): boolean {
  return isStoredSecret(readUiValue<unknown>(secretKey(tokenRef), null));
}

export function clearConnectionToken(tokenRef: string): void {
  removeUiValue(secretKey(tokenRef));
}
