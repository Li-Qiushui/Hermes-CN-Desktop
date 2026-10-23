import type { ConnectionConfigInput } from "@hermes/protocol";
import { readUiValue, removeUiValue, writeUiValue } from "@/lib/ui-store";

export type ConnectionKind = "local" | "remote" | "cloud" | "ssh";
export type GatewayMode = ConnectionKind;

export interface SavedSshTarget {
  host: string;
  user: string;
  port: number;
  keyPath: string;
  remoteHermesPath: string;
  remoteProfile: string;
  remotePort: number;
}

export interface SavedConnection {
  id: string;
  kind: ConnectionKind;
  name: string;
  url: string;
  tokenRef: string | null;
  ssh: SavedSshTarget | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export const CONNECTION_REGISTRY_KEY = "connection.registry.v1";
export const ACTIVE_CONNECTION_KEY = "connection.registry.active.v1";
export const CONNECTION_TOKEN_SECRET_PREFIX = "connection.secret.";

export const CONNECTION_KIND_LABELS: Record<ConnectionKind, string> = {
  local: "本机内核",
  remote: "远程 Hermes",
  cloud: "云端实例",
  ssh: "SSH 远端",
};

export const DEFAULT_SSH_TARGET: SavedSshTarget = {
  host: "",
  user: "",
  port: 22,
  keyPath: "",
  remoteHermesPath: "",
  remoteProfile: "",
  remotePort: 9119,
};

export const DEFAULT_CLOUD_URL = "https://cloud.nousresearch.com";

const MAX_PORT = 65535;
const MAX_ENTRIES = 32;

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function isConnectionKind(value: unknown): value is ConnectionKind {
  return value === "local" || value === "remote" || value === "cloud" || value === "ssh";
}

export function normalizeSshTarget(raw: unknown): SavedSshTarget {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SSH_TARGET };
  const record = raw as Record<string, unknown>;
  const port = asNumber(record.port, DEFAULT_SSH_TARGET.port);
  const remotePort = asNumber(record.remotePort, DEFAULT_SSH_TARGET.remotePort);
  return {
    host: asString(record.host).trim(),
    user: asString(record.user).trim(),
    port: Number.isInteger(port) && port > 0 && port <= MAX_PORT ? port : DEFAULT_SSH_TARGET.port,
    keyPath: asString(record.keyPath).trim(),
    remoteHermesPath: asString(record.remoteHermesPath).trim(),
    remoteProfile: asString(record.remoteProfile).trim(),
    remotePort:
      Number.isInteger(remotePort) && remotePort > 0 && remotePort <= MAX_PORT
        ? remotePort
        : DEFAULT_SSH_TARGET.remotePort,
  };
}

export function normalizeConnection(raw: unknown): SavedConnection | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const kind = record.kind;
  if (!isConnectionKind(kind)) return null;
  const id = asString(record.id).trim();
  if (!id) return null;
  const tokenRef = asString(record.tokenRef).trim();
  return {
    id,
    kind,
    name: asString(record.name).trim() || CONNECTION_KIND_LABELS[kind],
    url: asString(record.url).trim(),
    tokenRef: tokenRef || null,
    ssh: kind === "ssh" ? normalizeSshTarget(record.ssh) : null,
    createdAt: asNumber(record.createdAt, 0),
    lastUsedAt: typeof record.lastUsedAt === "number" ? record.lastUsedAt : null,
  };
}

export function normalizeRegistry(raw: unknown): SavedConnection[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const list: SavedConnection[] = [];
  for (const entry of raw) {
    const normalized = normalizeConnection(entry);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    list.push(normalized);
    if (list.length >= MAX_ENTRIES) break;
  }
  return list;
}

let idCounter = 0;

export function createConnectionId(kind: ConnectionKind, now: number = Date.now()): string {
  idCounter = (idCounter + 1) % 10_000;
  const random = Math.random().toString(36).slice(2, 8);
  return `${kind}-${now.toString(36)}-${idCounter.toString(36)}-${random}`;
}

export function tokenRefFor(id: string): string {
  return `${id}-token`;
}

export function nextConnectionName(list: SavedConnection[], kind: ConnectionKind): string {
  const base = CONNECTION_KIND_LABELS[kind];
  const used = new Set(list.filter((entry) => entry.kind === kind).map((entry) => entry.name));
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

export function upsertConnection(list: SavedConnection[], entry: SavedConnection): SavedConnection[] {
  const index = list.findIndex((item) => item.id === entry.id);
  if (index === -1) return [...list, entry];
  const next = [...list];
  next[index] = entry;
  return next;
}

export function removeConnection(list: SavedConnection[], id: string): SavedConnection[] {
  return list.filter((item) => item.id !== id);
}

export function findConnectionByUrl(list: SavedConnection[], kind: ConnectionKind, url: string): SavedConnection | undefined {
  const needle = url.trim().replace(/\/+$/, "").toLowerCase();
  if (!needle) return undefined;
  return list.find(
    (entry) => entry.kind === kind && entry.url.trim().replace(/\/+$/, "").toLowerCase() === needle,
  );
}

export interface SshValidationErrors {
  host?: string;
  user?: string;
  port?: string;
  keyPath?: string;
  remoteHermesPath?: string;
  remoteProfile?: string;
  remotePort?: string;
}

const PROFILE_PATTERN = /^[A-Za-z0-9._-]+$/;
const HOST_PATTERN = /^[A-Za-z0-9._:@[\]-]+$/;

export function validateSshTarget(target: SavedSshTarget): SshValidationErrors {
  const errors: SshValidationErrors = {};
  const host = target.host.trim();
  if (!host) errors.host = "SSH 主机不能为空";
  else if (/\s/.test(host) || !HOST_PATTERN.test(host)) errors.host = "主机名不能包含空格或非法字符";

  const user = target.user.trim();
  if (user && (/\s/.test(user) || /[@\\/]/.test(user))) errors.user = "用户名不能包含空格、@ 或斜杠";

  if (!Number.isInteger(target.port) || target.port <= 0 || target.port > MAX_PORT) {
    errors.port = "端口需为 1-65535 的整数";
  }

  const keyPath = target.keyPath.trim();
  if (keyPath && !(keyPath.startsWith("~") || /^([A-Za-z]:[\\/]|\/)/.test(keyPath))) {
    errors.keyPath = "私钥路径需为绝对路径或以 ~ 开头";
  }

  const remoteHermesPath = target.remoteHermesPath.trim();
  if (remoteHermesPath && /\s/.test(remoteHermesPath)) errors.remoteHermesPath = "远端 hermes 路径不能包含空格";

  const remoteProfile = target.remoteProfile.trim();
  if (remoteProfile && !PROFILE_PATTERN.test(remoteProfile)) {
    errors.remoteProfile = "profile 只能包含字母、数字、点、下划线和短横线";
  }

  if (!Number.isInteger(target.remotePort) || target.remotePort <= 0 || target.remotePort > MAX_PORT) {
    errors.remotePort = "远端内核端口需为 1-65535 的整数";
  }

  return errors;
}

export function hasSshErrors(errors: SshValidationErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function sshTargetSummary(target: SavedSshTarget): string {
  const host = target.host.trim();
  if (!host) return "未填写主机";
  const login = target.user.trim() ? `${target.user.trim()}@${host}` : host;
  return `${login}:${target.port}`;
}

export function connectionToConfigInput(connection: SavedConnection, token?: string): ConnectionConfigInput {
  if (connection.kind === "local") {
    return { mode: "local", localUrl: connection.url || undefined };
  }
  return {
    mode: "remote",
    remoteUrl: connection.url,
    remoteToken: token || undefined,
    remoteAuthMode: "token",
  };
}

export function readConnectionRegistry(): SavedConnection[] {
  return normalizeRegistry(readUiValue<unknown>(CONNECTION_REGISTRY_KEY, []));
}

export function writeConnectionRegistry(list: SavedConnection[]): void {
  writeUiValue(CONNECTION_REGISTRY_KEY, normalizeRegistry(list));
}

export function readActiveConnectionId(): string | null {
  const value = readUiValue<unknown>(ACTIVE_CONNECTION_KEY, null);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function writeActiveConnectionId(id: string | null): void {
  if (id) writeUiValue(ACTIVE_CONNECTION_KEY, id);
  else removeUiValue(ACTIVE_CONNECTION_KEY);
}

export function upsertAndPersist(entry: SavedConnection): SavedConnection[] {
  const next = upsertConnection(readConnectionRegistry(), entry);
  writeConnectionRegistry(next);
  return next;
}

export function removeAndPersist(id: string): SavedConnection[] {
  const next = removeConnection(readConnectionRegistry(), id);
  writeConnectionRegistry(next);
  if (readActiveConnectionId() === id) writeActiveConnectionId(null);
  removeUiValue(`${CONNECTION_TOKEN_SECRET_PREFIX}${tokenRefFor(id)}`);
  return next;
}
