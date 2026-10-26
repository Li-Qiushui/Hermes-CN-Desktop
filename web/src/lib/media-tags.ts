export type MediaKind = "image" | "audio" | "video" | "html" | "file";

export interface MediaItem {
  path: string;
  kind: MediaKind;
  name: string;
}

export interface MediaExtraction {
  text: string;
  items: MediaItem[];
}

const MARKER = "MEDIA:";

const MEDIA_MARKER_RE = /MEDIA:[ \t]*(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|([^\n]*))/g;

const IMAGE_EXTENSIONS = ["apng", "avif", "bmp", "gif", "heic", "heif", "ico", "jpe", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"];
const AUDIO_EXTENSIONS = ["aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "wma"];
const VIDEO_EXTENSIONS = ["avi", "flv", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "webm", "wmv"];
const HTML_EXTENSIONS = ["htm", "html", "xhtml"];

const EXTENSION_KIND = new Map<string, MediaKind>();
for (const ext of IMAGE_EXTENSIONS) EXTENSION_KIND.set(ext, "image");
for (const ext of AUDIO_EXTENSIONS) EXTENSION_KIND.set(ext, "audio");
for (const ext of VIDEO_EXTENSIONS) EXTENSION_KIND.set(ext, "video");
for (const ext of HTML_EXTENSIONS) EXTENSION_KIND.set(ext, "html");

const MEDIA_EXTENSION_BOUNDARY_RE = new RegExp(
  `\\.(${[...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS, ...HTML_EXTENSIONS].join("|")})(?![A-Za-z0-9])`,
  "i",
);

const TRAILING_PUNCTUATION_RE = /[，。、；：！？,;:.!?)\]}>"'`]+$/u;

const SENTINEL = "\u0000";
const FENCE_LINE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

function extensionOf(path: string): string {
  const withoutQuery = path.split(/[?#]/)[0] ?? "";
  const base = baseName(withoutQuery);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function baseName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

export function mediaKindOfPath(path: string): MediaKind {
  return EXTENSION_KIND.get(extensionOf(path)) ?? "file";
}

function mediaItemOf(path: string): MediaItem {
  const trimmed = path.trim();
  const name = baseName(trimmed) || trimmed;
  return { path: trimmed, kind: mediaKindOfPath(trimmed), name };
}

function dedupeKey(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function trimUnquotedCandidate(raw: string, atEndOfText: boolean): string {
  let candidate = raw;

  const nextMarker = candidate.indexOf(MARKER);
  if (nextMarker >= 0) candidate = candidate.slice(0, nextMarker);
  candidate = candidate.replace(/[ \t]+$/, "").trim();

  const boundary = candidate.match(MEDIA_EXTENSION_BOUNDARY_RE);
  if (boundary && boundary.index !== undefined) {
    candidate = candidate.slice(0, boundary.index + boundary[0].length);
  } else {
    candidate = candidate.replace(TRAILING_PUNCTUATION_RE, "");
  }

  if (atEndOfText && candidate && !baseName(candidate).includes(".")) return "";
  return candidate.trim();
}

function dropBlankedLines(text: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];

  for (const line of lines) {
    if (line.includes(SENTINEL)) {
      const rest = line.split(SENTINEL).join("");
      if (!rest.trim()) continue;
      kept.push(rest);
      continue;
    }
    kept.push(line);
  }

  return dropEmptyFences(kept).join(eol);
}

function dropEmptyFences(lines: string[]): string[] {
  const result: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const fence = lines[index]?.match(FENCE_LINE_RE);
    if (!fence) {
      result.push(lines[index] as string);
      index += 1;
      continue;
    }

    const marker = fence[1] as string;
    let close = index + 1;
    while (close < lines.length) {
      const closing = lines[close]?.match(FENCE_LINE_RE);
      if (closing && closing[1]?.[0] === marker[0] && (closing[1] as string).length >= marker.length) break;
      close += 1;
    }

    const body = lines.slice(index + 1, close);
    if (body.every((line) => !line.trim())) {
      index = close < lines.length ? close + 1 : lines.length;
      continue;
    }

    result.push(...lines.slice(index, close < lines.length ? close + 1 : lines.length));
    index = close < lines.length ? close + 1 : lines.length;
  }

  return result;
}

function collapseBlankRuns(text: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const result: string[] = [];
  let blanks = 0;

  for (const line of lines) {
    if (!line.trim()) {
      blanks += 1;
      if (blanks > 2) continue;
    } else {
      blanks = 0;
    }
    result.push(line);
  }

  return result.join(eol).replace(/^\s+/, "").replace(/\s+$/, "");
}

export function extractMediaTags(text: string): MediaExtraction {
  if (!text || !text.includes(MARKER)) return { text: text ?? "", items: [] };

  const items: MediaItem[] = [];
  const seen = new Set<string>();
  const scanner = new RegExp(MEDIA_MARKER_RE.source, "g");
  let marked = "";
  let cursor = 0;
  let removed = false;
  let match: RegExpExecArray | null;

  while ((match = scanner.exec(text)) !== null) {
    const start = match.index;
    const matchEnd = start + match[0].length;
    const body = match[0].slice(MARKER.length);
    const quoted = match[1] ?? match[2] ?? match[3];
    let path: string;
    let end: number;

    if (quoted !== undefined) {
      path = quoted.trim();
      end = matchEnd;
    } else {
      const spaces = body.length - body.replace(/^[ 	]+/, "").length;
      const atEndOfText = matchEnd >= text.length;
      path = trimUnquotedCandidate(body.slice(spaces), atEndOfText);
      if (!path) continue;
      end = start + MARKER.length + spaces + path.length;
    }

    if (!path) continue;

    while (end < text.length && (text[end] === " " || text[end] === "	")) end += 1;

    marked += text.slice(cursor, start) + SENTINEL;
    cursor = end;
    removed = true;
    if (end < matchEnd) scanner.lastIndex = end;

    const key = dedupeKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(mediaItemOf(path));
  }

  if (!removed) return { text, items: [] };

  marked += text.slice(cursor);
  return { text: collapseBlankRuns(dropBlankedLines(marked)), items };
}

export function stripMediaTags(text: string): string {
  return extractMediaTags(text).text;
}
