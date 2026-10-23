export interface McpJsonOk {
  ok: true;
  value: Record<string, Record<string, unknown>>;
}

export interface McpJsonFail {
  ok: false;
  message: string;
  line?: number;
  column?: number;
  position?: number;
}

export type McpJsonResult = McpJsonOk | McpJsonFail;

export function positionToLineColumn(text: string, position: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(position, text.length));
  let line = 1;
  let column = 1;
  for (let i = 0; i < clamped; i += 1) {
    if (text[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

export function describeJsonError(text: string, raw: string): { message: string; line?: number; column?: number; position?: number } {
  const explicit = raw.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  const posMatch = raw.match(/position\s+(\d+)/i);
  const position = posMatch ? Number(posMatch[1]) : undefined;
  const derived = position !== undefined ? positionToLineColumn(text, position) : null;
  const line = explicit ? Number(explicit[1]) : derived?.line;
  const column = explicit ? Number(explicit[2]) : derived?.column;
  const reason = raw.replace(/^JSON\.parse:\s*/i, "").replace(/\s*in JSON at position \d+.*$/i, "").trim();
  const where = line !== undefined ? `第 ${line} 行${column !== undefined ? ` 第 ${column} 列` : ""}：` : "";
  return {
    message: `${where}${reason || "JSON 语法错误"}`,
    line,
    column,
    position,
  };
}

export function validateMcpServersJson(text: string): McpJsonResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, message: "内容为空" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    return { ok: false, ...describeJsonError(trimmed, raw) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "顶层必须是对象：{ \"服务名\": { ... } }" };
  }
  const value = parsed as Record<string, unknown>;
  const servers: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!name.trim()) return { ok: false, message: "服务名不能为空" };
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, message: `服务「${name}」的值必须是对象` };
    }
    const cfg = entry as Record<string, unknown>;
    const hasUrl = typeof cfg.url === "string" && cfg.url.trim() !== "";
    const hasCommand = typeof cfg.command === "string" && cfg.command.trim() !== "";
    if (!hasUrl && !hasCommand) {
      return { ok: false, message: `服务「${name}」缺少 url 或 command` };
    }
    if (cfg.args !== undefined && !Array.isArray(cfg.args)) {
      return { ok: false, message: `服务「${name}」的 args 必须是数组` };
    }
    servers[name] = cfg;
  }
  return { ok: true, value: servers };
}

export function formatMcpServersJson(servers: unknown): string {
  return JSON.stringify(servers ?? {}, null, 2);
}

export function extractServersMap(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== "object") return {};
  const map = (config as Record<string, unknown>).mcp_servers;
  if (!map || typeof map !== "object" || Array.isArray(map)) return {};
  return map as Record<string, unknown>;
}
