export interface SshHostEntry {
  host: string;
  aliases: string[];
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

const WILDCARD = /[*?]/;
const MAX_PORT = 65535;

function stripComment(line: string): string {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return "";
  const hashIndex = trimmed.search(/\s#/);
  return hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex).trim();
}

function splitDirective(line: string): { key: string; value: string } | null {
  const equalsIndex = line.indexOf("=");
  if (equalsIndex > 0) {
    const head = line.slice(0, equalsIndex).trim();
    if (head && !/\s/.test(head)) {
      return { key: head.toLowerCase(), value: line.slice(equalsIndex + 1).trim() };
    }
  }
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(line);
  if (!match) return null;
  return { key: match[1].toLowerCase(), value: (match[2] ?? "").trim() };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parsePort(value: string): number | undefined {
  const parsed = Number.parseInt(unquote(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_PORT) return undefined;
  return parsed;
}

function pushEntry(entries: SshHostEntry[], current: SshHostEntry | null): void {
  if (!current) return;
  const usable = current.aliases.filter((alias) => !WILDCARD.test(alias));
  if (usable.length === 0) return;
  entries.push({ ...current, host: usable[0], aliases: usable });
}

export function parseSshConfig(text: string): SshHostEntry[] {
  const entries: SshHostEntry[] = [];
  let current: SshHostEntry | null = null;
  let skipping = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line) continue;
    const directive = splitDirective(line);
    if (!directive) continue;
    const { key, value } = directive;

    if (key === "host") {
      pushEntry(entries, current);
      const aliases = value.split(/\s+/).map(unquote).filter(Boolean);
      const named = aliases.filter((alias) => !alias.startsWith("!"));
      current = named.length ? { host: named[0], aliases: named } : null;
      skipping = false;
      continue;
    }

    if (key === "match") {
      pushEntry(entries, current);
      current = null;
      skipping = true;
      continue;
    }

    if (skipping || !current) continue;

    if (key === "hostname") {
      const hostName = unquote(value);
      if (hostName) current.hostName = hostName;
      continue;
    }
    if (key === "user") {
      const user = unquote(value);
      if (user) current.user = user;
      continue;
    }
    if (key === "port") {
      const port = parsePort(value);
      if (port !== undefined) current.port = port;
      continue;
    }
    if (key === "identityfile") {
      const identityFile = unquote(value);
      if (identityFile && !current.identityFile) current.identityFile = identityFile;
    }
  }

  pushEntry(entries, current);

  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.host)) return false;
    seen.add(entry.host);
    return true;
  });
}

export function findSshHost(entries: SshHostEntry[], host: string): SshHostEntry | undefined {
  const needle = host.trim();
  if (!needle) return undefined;
  return entries.find((entry) => entry.aliases.includes(needle));
}

export function sshHostSuggestions(entries: SshHostEntry[], query: string, limit = 8): SshHostEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries.slice(0, limit);
  return entries
    .filter((entry) =>
      entry.aliases.some((alias) => alias.toLowerCase().includes(needle)) ||
      (entry.hostName ?? "").toLowerCase().includes(needle),
    )
    .slice(0, limit);
}

export function sshConfigPath(homeDir: string): string {
  const separator = homeDir.includes("\\") ? "\\" : "/";
  const trimmed = homeDir.replace(/[\\/]+$/, "");
  return `${trimmed}${separator}.ssh${separator}config`;
}

export function homeDirFromConfigDir(configDir: string | undefined): string | null {
  const value = (configDir ?? "").trim().replace(/[\\/]+$/, "");
  const match = /^(.*)[\\/]\.(?:claude|codex|hermes)$/i.exec(value);
  if (!match) return null;
  return match[1] || null;
}

export function decodeDataUrlText(dataUrl: string): string {
  const marker = ";base64,";
  const index = dataUrl.indexOf(marker);
  if (index === -1) return "";
  const base64 = dataUrl.slice(index + marker.length);
  if (typeof atob === "function") {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(base64, "base64").toString("utf8");
}

export interface SshConfigLoadResult {
  hosts: SshHostEntry[];
  configPath: string | null;
  error?: string;
}

export interface SshConfigDeps {
  readConfigText: () => Promise<{ path: string; content: string } | null>;
}

export function isNativeDesktop(): boolean {
  if (typeof window === "undefined") return false;
  return window.__HERMES_RUNTIME__?.platform === "tauri" || window.hermesDesktop?.windowType === "tauri";
}

export function defaultSshConfigDeps(): SshConfigDeps {
  return {
    readConfigText: async () => {
      if (!isNativeDesktop()) return null;
      const mod = await import("@tauri-apps/api/core");
      const result = await mod.invoke<{ path: string; content: string }>("ssh_config_text");
      if (!result || typeof result.content !== "string") return null;
      return { path: result.path ?? "", content: result.content };
    },
  };
}

export async function loadSshHosts(deps: SshConfigDeps = defaultSshConfigDeps()): Promise<SshConfigLoadResult> {
  try {
    const file = await deps.readConfigText();
    if (!file) return { hosts: [], configPath: null, error: "本机未暴露 ssh 配置读取接口" };
    const hosts = parseSshConfig(file.content);
    return { hosts, configPath: file.path || null };
  } catch (error) {
    return {
      hosts: [],
      configPath: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
