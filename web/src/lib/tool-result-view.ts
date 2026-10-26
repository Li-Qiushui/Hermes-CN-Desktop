export type DiffRowType = "add" | "del" | "ctx" | "gap";

export interface DiffRow {
  type: DiffRowType;
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffFileView {
  path?: string;
  rows: DiffRow[];
  added: number;
  removed: number;
  truncated: boolean;
}

export interface TerminalView {
  kind: "terminal";
  command?: string;
  workdir?: string;
  stdout: string;
  stderr?: string;
  exitCode?: number;
  status?: string;
  errorText?: string;
}

export interface FileChangeView {
  kind: "file";
  path?: string;
  files: DiffFileView[];
  added: number;
  removed: number;
  fallbackText?: string;
  fallbackLabel?: string;
  sideBySide?: { oldText: string; newText: string };
  note?: string;
}

export interface BlocksView {
  kind: "json" | "raw";
  argsText?: string;
  outputText?: string;
  errorText?: string;
}

export type ToolResultView = TerminalView | FileChangeView | BlocksView;

export interface ToolResultInput {
  name: string;
  arguments?: Record<string, unknown> | null;
  summary?: string | null;
  error?: string | null;
}

export const MAX_STRUCTURED_DIFF_LINES = 2000;
export const MAX_RENDERED_DIFF_ROWS = 500;
export const TOOL_OUTPUT_PAGE_LINES = 200;

const TERMINAL_NAMES = new Set([
  "terminal",
  "bash",
  "shell",
  "command",
  "run_command",
  "exec",
  "exec_command",
  "shell_command",
  "powershell",
  "pwsh",
  "cmd",
  "execute_code",
]);

const FILE_NAMES = new Set([
  "patch",
  "write_file",
  "edit",
  "edit_file",
  "apply_patch",
  "create_file",
  "multi_edit",
  "str_replace_editor",
  "replace_in_file",
]);

const COMMAND_KEYS = ["command", "cmd", "script", "code"];
const WORKDIR_KEYS = ["workdir", "cwd", "directory"];
const PATH_KEYS = ["path", "file_path", "filePath", "target"];
const OLD_KEYS = ["old_string", "oldString", "old_text", "oldText"];
const NEW_KEYS = ["new_string", "newString", "new_text", "newText"];
const CONTENT_KEYS = ["content", "new_content", "text"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(source: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function numericField(source: Record<string, unknown> | undefined, keys: readonly string[]): number | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  }
  return undefined;
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function parseRecordObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || trimmed.length > 2_000_000) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function splitDiffLines(value: string): string[] {
  const normalized = value.replace(/\r\n?/g, "\n");
  if (normalized === "") return [];
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lcsRows(
  before: readonly string[],
  after: readonly string[],
  beforeOffset: number,
  afterOffset: number,
): DiffRow[] {
  const beforeLength = before.length;
  const afterLength = after.length;
  const width = afterLength + 1;
  const table = new Uint32Array((beforeLength + 1) * width);

  for (let index = beforeLength - 1; index >= 0; index -= 1) {
    const rowBase = index * width;
    const nextBase = (index + 1) * width;
    for (let cursor = afterLength - 1; cursor >= 0; cursor -= 1) {
      table[rowBase + cursor] =
        before[index] === after[cursor]
          ? table[nextBase + cursor + 1] + 1
          : Math.max(table[nextBase + cursor], table[rowBase + cursor + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let index = 0;
  let cursor = 0;
  while (index < beforeLength && cursor < afterLength) {
    if (before[index] === after[cursor]) {
      rows.push({
        type: "ctx",
        text: before[index],
        oldLine: beforeOffset + index + 1,
        newLine: afterOffset + cursor + 1,
      });
      index += 1;
      cursor += 1;
    } else if (table[(index + 1) * width + cursor] >= table[index * width + cursor + 1]) {
      rows.push({ type: "del", text: before[index], oldLine: beforeOffset + index + 1 });
      index += 1;
    } else {
      rows.push({ type: "add", text: after[cursor], newLine: afterOffset + cursor + 1 });
      cursor += 1;
    }
  }
  while (index < beforeLength) {
    rows.push({ type: "del", text: before[index], oldLine: beforeOffset + index + 1 });
    index += 1;
  }
  while (cursor < afterLength) {
    rows.push({ type: "add", text: after[cursor], newLine: afterOffset + cursor + 1 });
    cursor += 1;
  }
  return rows;
}

export interface LineDiffResult {
  rows: DiffRow[];
  added: number;
  removed: number;
  truncated: boolean;
}

export function diffTextLines(
  beforeText: string,
  afterText: string,
  options: { maxLines?: number } = {},
): LineDiffResult | null {
  const limit = options.maxLines ?? MAX_STRUCTURED_DIFF_LINES;
  const before = splitDiffLines(beforeText);
  const after = splitDiffLines(afterText);
  if (before.length > limit || after.length > limit) return null;

  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const rows: DiffRow[] = [];
  for (let index = 0; index < prefix; index += 1) {
    rows.push({ type: "ctx", text: before[index], oldLine: index + 1, newLine: index + 1 });
  }
  rows.push(
    ...lcsRows(
      before.slice(prefix, before.length - suffix),
      after.slice(prefix, after.length - suffix),
      prefix,
      prefix,
    ),
  );
  for (let index = 0; index < suffix; index += 1) {
    const beforeIndex = before.length - suffix + index;
    const afterIndex = after.length - suffix + index;
    rows.push({
      type: "ctx",
      text: before[beforeIndex],
      oldLine: beforeIndex + 1,
      newLine: afterIndex + 1,
    });
  }

  return { rows, added: countRows(rows, "add"), removed: countRows(rows, "del"), truncated: false };
}

function countRows(rows: readonly DiffRow[], type: DiffRowType): number {
  let total = 0;
  for (const row of rows) {
    if (row.type === type) total += 1;
  }
  return total;
}

function addedLineRows(text: string): LineDiffResult {
  const rows = splitDiffLines(text).map((line, index) => ({
    type: "add" as const,
    text: line,
    newLine: index + 1,
  }));
  return { rows, added: rows.length, removed: 0, truncated: false };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_FILE_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const NOISE_PREFIXES = [
  "index ",
  "new file mode",
  "deleted file mode",
  "old mode",
  "new mode",
  "similarity index",
  "dissimilarity index",
  "rename from",
  "rename to",
  "\\ No newline",
];

function stripDiffPath(raw: string): string {
  const value = raw.trim().split("\t")[0] ?? raw;
  if (value === "/dev/null") return value;
  if (value.startsWith("a/") || value.startsWith("b/")) return value.slice(2);
  return value;
}

function finalizeFile(file: DiffFileView): DiffFileView {
  const truncated = file.rows.length > MAX_RENDERED_DIFF_ROWS;
  return {
    path: file.path,
    rows: truncated ? file.rows.slice(0, MAX_RENDERED_DIFF_ROWS) : file.rows,
    added: file.added,
    removed: file.removed,
    truncated,
  };
}

export function parseUnifiedDiff(text: string): DiffFileView[] {
  const lines = splitDiffLines(text);
  const files: DiffFileView[] = [];
  let current: DiffFileView | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  const ensureFile = (): DiffFileView => {
    if (!current) {
      current = { rows: [], added: 0, removed: 0, truncated: false };
      files.push(current);
    }
    return current;
  };

  for (const line of lines) {
    const fileMatch = DIFF_FILE_RE.exec(line);
    if (fileMatch) {
      current = { path: fileMatch[2], rows: [], added: 0, removed: 0, truncated: false };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      if (line.startsWith("+++ ")) {
        const path = stripDiffPath(line.slice(4));
        const target = ensureFile();
        if (path && path !== "/dev/null") target.path = path;
      }
      continue;
    }
    if (NOISE_PREFIXES.some((prefix) => line.startsWith(prefix))) continue;

    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      inHunk = true;
      const target = ensureFile();
      if (target.rows.length > 0) target.rows.push({ type: "gap", text: "" });
      continue;
    }
    if (!inHunk) continue;

    const target = ensureFile();
    const marker = line[0] ?? " ";
    const content = line.slice(1);
    if (marker === "+") {
      target.rows.push({ type: "add", text: content, newLine });
      target.added += 1;
      newLine += 1;
    } else if (marker === "-") {
      target.rows.push({ type: "del", text: content, oldLine });
      target.removed += 1;
      oldLine += 1;
    } else if (marker === " ") {
      target.rows.push({ type: "ctx", text: content, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  return files.filter((file) => file.rows.length > 0).map(finalizeFile);
}

function looksTerminalRecord(record: Record<string, unknown> | undefined): boolean {
  if (!record) return false;
  if (numericField(record, ["exit_code", "exitCode", "returncode", "return_code"]) !== undefined) return true;
  return typeof record.stdout === "string" || typeof record.stderr === "string";
}

function buildTerminalView(
  args: Record<string, unknown> | undefined,
  record: Record<string, unknown> | undefined,
  body: string,
  errorText: string | undefined,
): TerminalView {
  let stdout = "";
  let stderr: string | undefined;
  let exitCode: number | undefined;
  let status: string | undefined;
  let error = errorText;

  if (record) {
    const rawOutput = record.stdout ?? record.output;
    if (typeof rawOutput === "string") stdout = rawOutput;
    else if (rawOutput !== undefined) stdout = safeJson(rawOutput) ?? String(rawOutput);
    stderr = firstString(record, ["stderr"]);
    exitCode = numericField(record, ["exit_code", "exitCode", "returncode", "return_code"]);
    status = firstString(record, ["status"]);
    error = error ?? firstString(record, ["error"]);
  } else {
    stdout = body;
  }

  return {
    kind: "terminal",
    command: firstString(args, COMMAND_KEYS),
    workdir: firstString(args, WORKDIR_KEYS),
    stdout,
    stderr,
    exitCode,
    status,
    errorText: error,
  };
}

function buildFileChangeView(
  name: string,
  args: Record<string, unknown> | undefined,
  record: Record<string, unknown> | undefined,
  errorText: string | undefined,
): FileChangeView | null {
  const path = firstString(args, PATH_KEYS);
  const recordDiff = firstString(record, ["diff"]);
  const rawPatch = firstString(args, ["patch"]);
  const beforeText = firstString(args, OLD_KEYS);
  const afterText = firstString(args, NEW_KEYS);
  const content = firstString(args, CONTENT_KEYS);
  const fileNamed = FILE_NAMES.has(name);

  if (!recordDiff && !rawPatch && !fileNamed && !(beforeText !== undefined && afterText !== undefined)) {
    return null;
  }

  const note = errorText ?? firstString(record, ["error", "note"]);

  if (recordDiff) {
    const parsed = parseUnifiedDiff(recordDiff);
    if (parsed.length > 0) {
      return {
        kind: "file",
        path,
        files: parsed,
        added: parsed.reduce((total, file) => total + file.added, 0),
        removed: parsed.reduce((total, file) => total + file.removed, 0),
        note,
      };
    }
    return {
      kind: "file",
      path,
      files: [],
      added: 0,
      removed: 0,
      fallbackText: recordDiff,
      fallbackLabel: "diff",
      note,
    };
  }

  if (rawPatch) {
    const parsed = parseUnifiedDiff(rawPatch);
    if (parsed.length > 0) {
      return {
        kind: "file",
        path,
        files: parsed,
        added: parsed.reduce((total, file) => total + file.added, 0),
        removed: parsed.reduce((total, file) => total + file.removed, 0),
        note,
      };
    }
    const filesModified = record?.files_modified;
    const summaryPath = Array.isArray(filesModified) && typeof filesModified[0] === "string"
      ? filesModified[0]
      : path;
    return {
      kind: "file",
      path: summaryPath,
      files: [],
      added: 0,
      removed: 0,
      fallbackText: rawPatch,
      fallbackLabel: "patch",
      note: note ?? "补丁原文（未拆成行级 diff）",
    };
  }

  if (beforeText !== undefined && afterText !== undefined) {
    const diff = diffTextLines(beforeText, afterText);
    if (!diff) {
      return {
        kind: "file",
        path,
        files: [],
        added: 0,
        removed: 0,
        sideBySide: { oldText: beforeText, newText: afterText },
        note: `改动超过 ${MAX_STRUCTURED_DIFF_LINES} 行，已降级为原文对照`,
      };
    }
    return {
      kind: "file",
      path,
      files: [{ path, rows: diff.rows, added: diff.added, removed: diff.removed, truncated: false }],
      added: diff.added,
      removed: diff.removed,
      note,
    };
  }

  if (content !== undefined && fileNamed) {
    const lines = splitDiffLines(content).length;
    if (lines > MAX_STRUCTURED_DIFF_LINES) {
      return {
        kind: "file",
        path,
        files: [],
        added: 0,
        removed: 0,
        sideBySide: { oldText: "", newText: content },
        note: `写入 ${lines} 行，超过 ${MAX_STRUCTURED_DIFF_LINES} 行，已降级为原文对照`,
      };
    }
    const added = addedLineRows(content);
    const truncated = added.rows.length > MAX_RENDERED_DIFF_ROWS;
    return {
      kind: "file",
      path,
      files: [
        {
          path,
          rows: truncated ? added.rows.slice(0, MAX_RENDERED_DIFF_ROWS) : added.rows,
          added: added.added,
          removed: 0,
          truncated,
        },
      ],
      added: added.added,
      removed: 0,
      note: note ?? (lines === 0 ? "写入内容为空" : `全文写入 ${lines} 行`),
    };
  }

  return null;
}

export function buildToolResultView(input: ToolResultInput): ToolResultView {
  const args = isRecord(input.arguments) ? input.arguments : undefined;
  const body = typeof input.summary === "string" ? input.summary : "";
  const record = parseRecordObject(body);
  const name = normalizeToolName(input.name ?? "");
  const errorText = typeof input.error === "string" && input.error.trim() ? input.error : undefined;

  if (TERMINAL_NAMES.has(name) || looksTerminalRecord(record)) {
    return buildTerminalView(args, record, body, errorText);
  }

  const fileView = buildFileChangeView(name, args, record, errorText);
  if (fileView) return fileView;

  const argsText = args && Object.keys(args).length > 0 ? safeJson(args) : undefined;
  const outputText = body.trim() ? body : undefined;
  if (argsText) {
    return { kind: "json", argsText, outputText, errorText };
  }
  if (record) {
    return { kind: "json", outputText: body, errorText };
  }
  return { kind: "raw", outputText, errorText };
}

export function isKnownFileWriteTool(name: string): boolean {
  return FILE_NAMES.has(normalizeToolName(name ?? ""));
}

export function isFileChangeToolInput(input: ToolResultInput): boolean {
  return buildToolResultView(input).kind === "file";
}
