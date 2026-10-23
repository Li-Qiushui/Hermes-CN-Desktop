import type { BadgeTone } from "@hermes/shared-ui";

export type McpServerStatus = "ok" | "off" | "error" | "needs-auth" | "probing" | "unknown";

export interface McpStatusInput {
  enabled: boolean;
  probing?: boolean;
  tested?: boolean;
  ok?: boolean;
  error?: string | null;
  auth?: string | null;
  hasOauthToken?: boolean | null;
  toolCount?: number;
}

const AUTH_HINTS = /oauth|unauthor|401|403|authentication|token/i;

export function deriveServerStatus(input: McpStatusInput): McpServerStatus {
  if (input.probing) return "probing";
  if (!input.enabled) return "off";
  if (input.auth === "oauth" && input.hasOauthToken === false) return "needs-auth";
  if (input.tested) {
    if (input.ok) return "ok";
    return AUTH_HINTS.test(input.error ?? "") ? "needs-auth" : "error";
  }
  return "unknown";
}

export const MCP_STATUS_META: Record<McpServerStatus, { label: string; tone: BadgeTone }> = {
  ok: { label: "ok", tone: "success" },
  off: { label: "off", tone: "neutral" },
  error: { label: "error", tone: "danger" },
  "needs-auth": { label: "needs-auth", tone: "warning" },
  probing: { label: "probing", tone: "info" },
  unknown: { label: "unknown", tone: "neutral" },
};

export interface McpToolSchemaLike {
  name: string;
  description?: string | null;
  schema_chars?: number | null;
}

const TOKENS_PER_CHAR = 0.25;
const SCHEMA_OVERHEAD_CHARS = 120;

export function estimateToolTokens(tool: McpToolSchemaLike): number {
  const real = typeof tool.schema_chars === "number" && tool.schema_chars > 0 ? tool.schema_chars : 0;
  const chars = real > 0
    ? real
    : tool.name.length + (tool.description ?? "").length + SCHEMA_OVERHEAD_CHARS;
  return Math.max(1, Math.round(chars * TOKENS_PER_CHAR));
}

export interface McpCostEstimate {
  tokens: number;
  toolCount: number;
  measured: boolean;
  label: string;
}

export function estimateContextCost(tools: McpToolSchemaLike[]): McpCostEstimate {
  const measured = tools.length > 0 && tools.every((tool) => typeof tool.schema_chars === "number" && tool.schema_chars > 0);
  const tokens = tools.reduce((sum, tool) => sum + estimateToolTokens(tool), 0);
  const label = measured ? `约 ${tokens} tokens` : `约 ${tokens} tokens（估算）`;
  return { tokens, toolCount: tools.length, measured, label };
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 10000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(2)}k`;
  return String(tokens);
}
