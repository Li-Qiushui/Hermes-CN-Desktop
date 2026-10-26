export type PreviewSegment =
  | { kind: "prose"; text: string }
  | { kind: "preview"; file: string };

export const PREVIEW_MAX_TEXT = 4800;
export const PREVIEW_MAX_ATTRS = 2048;

const DIRECTIVE_RE = /(?<=^|\s)::preview\{([^{}]{0,2048})\}/gm;
const ATTR_RE = /([a-z][\w-]{0,63})\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const PURE_RUN_RE = /^(?:::preview\s*\{[^{}]{0,2048}\}\s*)+$/;
const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/;
const INFO_STRING_RE = /^[A-Za-z0-9_+.-]{1,24}$/;
const HTML_FILE_RE = /\.html?$/i;
const MAX_INLINE_SCAN = 4096;

const MISSING_FILE_RE = /(?:^|\D)404(?:\D|$)|file not found|not found|no such file|ENOENT|not exist|不存在|找不到/i;

export type PreviewErrorKind = "missing" | "failed";

export interface PreviewErrorCopy {
  hint?: string;
  kind: PreviewErrorKind;
  title: string;
}

export function isHtmlPreviewFile(file: string): boolean {
  return HTML_FILE_RE.test(file.trim());
}

export function describePreviewError(error: unknown): PreviewErrorCopy {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (MISSING_FILE_RE.test(raw)) {
    return { kind: "missing", title: "文件不存在，可能已被删除或移动" };
  }
  return { kind: "failed", title: "预览加载失败", hint: "读取文件时出错，请稍后重试" };
}

interface CodeRegion {
  end: number;
  innerEnd: number;
  innerStart: number;
  pure: boolean;
  start: number;
}

function isPureDirectiveRun(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && PURE_RUN_RE.test(trimmed);
}

function isPureFenceBody(body: string): boolean {
  if (isPureDirectiveRun(body)) return true;
  const breakIndex = body.indexOf("\n");
  if (breakIndex === -1) return false;
  if (!INFO_STRING_RE.test(body.slice(0, breakIndex).trim())) return false;
  return isPureDirectiveRun(body.slice(breakIndex + 1));
}

function lineBounds(text: string): Array<{ end: number; start: number }> {
  const bounds: Array<{ end: number; start: number }> = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index < text.length && text[index] !== "\n") continue;
    const end = index > start && text[index - 1] === "\r" ? index - 1 : index;
    bounds.push({ end, start });
    start = index + 1;
  }
  return bounds;
}

function inlineRegions(text: string, from: number, to: number): CodeRegion[] {
  const regions: CodeRegion[] = [];
  let index = from;
  while (index < to) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    let run = 0;
    while (text[index + run] === "`") run += 1;
    const innerStart = index + run;
    let scan = innerStart;
    let close = -1;
    while (scan < to && scan - innerStart <= MAX_INLINE_SCAN) {
      if (text[scan] === "`") {
        let length = 0;
        while (text[scan + length] === "`") length += 1;
        if (length === run) {
          close = scan;
          break;
        }
        scan += length;
        continue;
      }
      scan += 1;
    }
    if (close === -1) {
      index = innerStart;
      continue;
    }
    regions.push({
      start: index,
      end: close + run,
      innerStart,
      innerEnd: close,
      pure: isPureDirectiveRun(text.slice(innerStart, close)),
    });
    index = close + run;
  }
  return regions;
}

function findCodeRegions(text: string): CodeRegion[] {
  const lines = lineBounds(text);
  const regions: CodeRegion[] = [];
  const gaps: Array<[number, number]> = [];
  let cursor = 0;

  for (let line = 0; line < lines.length; line += 1) {
    const opened = FENCE_OPEN_RE.exec(text.slice(lines[line].start, lines[line].end));
    if (!opened) continue;
    const marker = opened[1][0];
    const length = opened[1].length;
    let closeLine = -1;
    for (let next = line + 1; next < lines.length; next += 1) {
      const candidate = FENCE_CLOSE_RE.exec(text.slice(lines[next].start, lines[next].end));
      if (candidate && candidate[1][0] === marker && candidate[1].length >= length) {
        closeLine = next;
        break;
      }
    }

    const start = lines[line].start;
    const innerStart = line + 1 < lines.length ? lines[line + 1].start : text.length;
    const innerEnd = closeLine === -1 ? text.length : lines[closeLine].start;
    const end = closeLine === -1 ? text.length : lines[closeLine].end;

    if (start > cursor) gaps.push([cursor, start]);
    if (end > cursor) cursor = end;
    regions.push({
      start,
      end,
      innerStart,
      innerEnd,
      pure: isPureFenceBody(text.slice(innerStart, innerEnd)),
    });
    line = closeLine === -1 ? lines.length : closeLine;
  }

  if (cursor < text.length) gaps.push([cursor, text.length]);
  for (const [from, to] of gaps) regions.push(...inlineRegions(text, from, to));

  return regions.sort((left, right) => left.start - right.start);
}

function blankRange(chars: string[], from: number, to: number): void {
  for (let index = from; index < to; index += 1) {
    if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
  }
}

function stripWrappers(text: string, regions: CodeRegion[]): { blocked: CodeRegion[]; scan: string } {
  const blocked: CodeRegion[] = [];
  let chars: string[] | null = null;

  for (const region of regions) {
    if (!region.pure) {
      blocked.push(region);
      continue;
    }
    chars ??= text.split("");
    blankRange(chars, region.start, region.innerStart);
    blankRange(chars, region.innerEnd, region.end);
    const firstDirective = text.indexOf("::preview", region.innerStart);
    if (firstDirective > region.innerStart && firstDirective < region.innerEnd) {
      blankRange(chars, region.innerStart, firstDirective);
    }
  }

  return { blocked, scan: chars === null ? text : chars.join("") };
}

function parseFileAttr(body: string): string | null {
  for (const pair of body.matchAll(ATTR_RE)) {
    if (pair[1].toLowerCase() !== "file") continue;
    const value = (pair[2] ?? pair[3] ?? "").trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

function overlapsRegion(start: number, end: number, regions: CodeRegion[]): boolean {
  return regions.some((region) => start < region.end && end > region.start);
}

export function splitPreviewDirectives(text: string): PreviewSegment[] {
  const proseOnly: PreviewSegment[] = [{ kind: "prose", text }];
  if (!text || text.length > PREVIEW_MAX_TEXT || !text.includes("::preview")) {
    return proseOnly;
  }

  const { blocked, scan } = stripWrappers(text, findCodeRegions(text));
  const segments: PreviewSegment[] = [];
  let cursor = 0;

  for (const match of scan.matchAll(DIRECTIVE_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (overlapsRegion(start, end, blocked)) continue;
    const file = parseFileAttr(match[1] ?? "");
    if (!file) continue;
    if (start > cursor) segments.push({ kind: "prose", text: scan.slice(cursor, start) });
    segments.push({ kind: "preview", file });
    cursor = end;
  }

  if (segments.length === 0) return proseOnly;
  if (cursor < scan.length) segments.push({ kind: "prose", text: scan.slice(cursor) });

  const cleaned = segments.filter((segment) => segment.kind === "preview" || segment.text.trim().length > 0);
  return cleaned.length > 0 ? cleaned : proseOnly;
}
