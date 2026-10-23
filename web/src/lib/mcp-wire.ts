import type { McpServer } from "@hermes/protocol";
import type { McpToolSchemaLike } from "./mcp-status";

export type McpServerWire = Omit<McpServer, "tools"> & {
  tools?: unknown;
  source?: string;
  plugin?: string | null;
};

export interface McpToolWire extends McpToolSchemaLike {
  description: string;
}

export interface McpTestWire {
  ok: boolean;
  error?: string | null;
  tools: McpToolWire[];
  prompts?: number;
  resources?: number;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function normalizeServer(raw: unknown): McpServerWire | null {
  if (!raw || typeof raw !== "object") return null;
  const cfg = raw as Record<string, unknown>;
  const name = str(cfg.name);
  if (!name) return null;
  const transport = str(cfg.transport) ?? (cfg.url ? "http" : cfg.command ? "stdio" : "unknown");
  const env = cfg.env && typeof cfg.env === "object" && !Array.isArray(cfg.env)
    ? Object.fromEntries(
      Object.entries(cfg.env as Record<string, unknown>).map(([key, value]) => [key, String(value ?? "")]),
    )
    : {};
  return {
    name,
    transport,
    url: typeof cfg.url === "string" ? cfg.url : null,
    command: typeof cfg.command === "string" ? cfg.command : null,
    args: Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === "string") : [],
    env,
    auth: typeof cfg.auth === "string" ? cfg.auth : null,
    enabled: cfg.enabled !== false,
    tools: cfg.tools,
    source: str(cfg.source),
    plugin: typeof cfg.plugin === "string" ? cfg.plugin : null,
  };
}

export function normalizeServersPayload(raw: unknown): McpServerWire[] {
  const list = raw && typeof raw === "object" ? (raw as Record<string, unknown>).servers : undefined;
  if (!Array.isArray(list)) return [];
  return list.map(normalizeServer).filter((item): item is McpServerWire => item !== null);
}

export function normalizeTool(raw: unknown): McpToolWire | null {
  if (!raw || typeof raw !== "object") return null;
  const cfg = raw as Record<string, unknown>;
  const name = str(cfg.name);
  if (!name) return null;
  const schemaChars = typeof cfg.schema_chars === "number" ? cfg.schema_chars : undefined;
  return {
    name,
    description: str(cfg.description) ?? "",
    schema_chars: schemaChars,
  };
}

export function normalizeTestResult(raw: unknown): McpTestWire {
  if (!raw || typeof raw !== "object") return { ok: false, error: "响应无法解析", tools: [] };
  const cfg = raw as Record<string, unknown>;
  const tools = Array.isArray(cfg.tools)
    ? cfg.tools.map(normalizeTool).filter((tool): tool is McpToolWire => tool !== null)
    : [];
  return {
    ok: cfg.ok === true,
    error: typeof cfg.error === "string" ? cfg.error : null,
    tools,
    prompts: typeof cfg.prompts === "number" ? cfg.prompts : undefined,
    resources: typeof cfg.resources === "number" ? cfg.resources : undefined,
  };
}

export function normalizeLogLines(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const lines = (raw as Record<string, unknown>).lines;
  if (!Array.isArray(lines)) return [];
  return lines.filter((line): line is string => typeof line === "string");
}
