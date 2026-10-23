import type { CodeHighlighterPlugin, HighlightResult } from "@streamdown/code";
import { cjk } from "@streamdown/cjk";
import { createMathPlugin } from "@streamdown/math";
import {
  createContext,
  memo,
  useContext,
  useMemo,
  type CSSProperties,
  type ComponentProps,
  type MouseEvent,
} from "react";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import { harden } from "rehype-harden";
import { Streamdown, parseMarkdownIntoBlocks, type DiagramPlugin } from "streamdown";
import type { MermaidConfig } from "mermaid";
import "katex/dist/katex.min.css";
import { MessageImage } from "./message-image";
import { isImageReference } from "@/lib/message-images";
import s from "./markdown-renderer.module.css";

interface MarkdownTextProps {
  text: string;
  streaming?: boolean;
}

type RichInlineProps<T extends "span" | "small" | "time" | "mark"> = Omit<
  ComponentProps<T>,
  "className" | "style"
> & {
  className?: string;
  node?: unknown;
  style?: unknown;
};

const ALLOWED_LINK_PROTOCOLS = ["http", "https", "irc", "ircs", "mailto", "xmpp", "tel", "obsidian"];
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:", "obsidian:"]);
const BLOCKED_EXTERNAL_PROTOCOLS = /^(?:javascript|data|file|vbscript|tauri):/i;
const KatexSpanContext = createContext(false);

type StreamdownPluginConfig = NonNullable<ComponentProps<typeof Streamdown>["plugins"]>;
type StreamdownMathPlugin = NonNullable<StreamdownPluginConfig["math"]>;
type CodeHighlightOptions = Parameters<CodeHighlighterPlugin["highlight"]>[0];
type CodeThemePair = CodeHighlightOptions["themes"];

const CODE_THEMES = ["github-light", "github-dark"] as unknown as CodeThemePair;
const CODE_THROTTLE_MS = 120;
const CODE_BLOCK_KEY_CHARS = 64;
const CODE_MAX_HIGHLIGHT_CHARS = 120_000;
const CODE_CACHE_MAX_ENTRIES = 192;
const CODE_CACHE_MAX_CHARS = 3 * 1024 * 1024;
const CODE_BLOCK_STATE_MAX_ENTRIES = 64;

interface CachedCodeHighlight {
  result: HighlightResult;
  chars: number;
}

interface PendingCodeHighlight {
  at: number;
  code: string;
  options: CodeHighlightOptions;
  callback?: (result: HighlightResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const codeHighlightCache = new Map<string, CachedCodeHighlight>();
const pendingCodeHighlights = new Map<string, PendingCodeHighlight>();
let codeHighlightCacheChars = 0;
let codePluginPromise: Promise<CodeHighlighterPlugin | null> | null = null;
let loadedCodePlugin: CodeHighlighterPlugin | null = null;
let codePluginUnavailable = false;

function codeCacheKey(language: string, code: string, themes: CodeHighlightOptions["themes"]): string {
  const themeKey = themes
    .map((theme) => (typeof theme === "string" ? theme : ((theme as { name?: string }).name ?? "")))
    .join("/");
  return `${themeKey}\u0000${language}\u0000${code}`;
}

function readCodeHighlight(key: string): HighlightResult | undefined {
  const hit = codeHighlightCache.get(key);
  if (!hit) return undefined;
  codeHighlightCache.delete(key);
  codeHighlightCache.set(key, hit);
  return hit.result;
}

function writeCodeHighlight(key: string, result: HighlightResult, chars: number): void {
  const previous = codeHighlightCache.get(key);
  if (previous) {
    codeHighlightCacheChars -= previous.chars;
    codeHighlightCache.delete(key);
  }
  codeHighlightCache.set(key, { result, chars });
  codeHighlightCacheChars += chars;
  while (
    codeHighlightCache.size > 1 &&
    (codeHighlightCache.size > CODE_CACHE_MAX_ENTRIES || codeHighlightCacheChars > CODE_CACHE_MAX_CHARS)
  ) {
    const oldest = codeHighlightCache.keys().next().value;
    if (oldest === undefined) break;
    codeHighlightCacheChars -= codeHighlightCache.get(oldest)?.chars ?? 0;
    codeHighlightCache.delete(oldest);
  }
}

function codeBlockKey(options: CodeHighlightOptions): string {
  return `${options.language}\u0000${options.code.slice(0, CODE_BLOCK_KEY_CHARS)}`;
}

function loadCodePlugin(): Promise<CodeHighlighterPlugin | null> {
  codePluginPromise ??= import("@streamdown/code")
    .then((module) => {
      loadedCodePlugin = module.createCodePlugin({ themes: CODE_THEMES });
      return loadedCodePlugin;
    })
    .catch(() => {
      codePluginUnavailable = true;
      return null;
    });
  return codePluginPromise;
}

function runCodeHighlight(
  plugin: CodeHighlighterPlugin,
  key: string,
  options: CodeHighlightOptions,
  callback?: (result: HighlightResult) => void,
): void {
  const previous = pendingCodeHighlights.get(key);
  if (previous?.timer) clearTimeout(previous.timer);
  const pending: PendingCodeHighlight = {
    at: Date.now(),
    code: options.code,
    options,
    callback,
    timer: null,
  };
  pendingCodeHighlights.set(key, pending);
  while (pendingCodeHighlights.size > CODE_BLOCK_STATE_MAX_ENTRIES) {
    const oldest = pendingCodeHighlights.keys().next().value;
    if (oldest === undefined) break;
    pendingCodeHighlights.delete(oldest);
  }
  const settle = (result: HighlightResult) => {
    writeCodeHighlight(codeCacheKey(options.language, options.code, options.themes), result, options.code.length);
    if (pendingCodeHighlights.get(key) === pending) pending.callback?.(result);
  };
  try {
    const immediate = plugin.highlight(options, settle);
    if (immediate) settle(immediate);
  } catch {
    if (pendingCodeHighlights.get(key) === pending) pendingCodeHighlights.delete(key);
  }
}

function flushPendingCodeHighlight(key: string): void {
  const pending = pendingCodeHighlights.get(key);
  const plugin = loadedCodePlugin;
  if (!pending || !plugin) return;
  pending.timer = null;
  runCodeHighlight(plugin, key, pending.options, pending.callback);
}

const codeHighlightPlugin: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  getThemes: () => loadedCodePlugin?.getThemes() ?? CODE_THEMES,
  getSupportedLanguages: () => loadedCodePlugin?.getSupportedLanguages() ?? [],
  supportsLanguage: (language) => loadedCodePlugin?.supportsLanguage(language) ?? false,
  highlight(options, callback) {
    if (codePluginUnavailable) return null;
    const { code, language } = options;
    if (!code.trim() || code.length > CODE_MAX_HIGHLIGHT_CHARS) return null;

    const cached = readCodeHighlight(codeCacheKey(language, code, options.themes));
    if (cached) {
      callback?.(cached);
      return cached;
    }

    const plugin = loadedCodePlugin;
    if (!plugin) {
      void loadCodePlugin().then((loaded) => {
        if (loaded) codeHighlightPlugin.highlight(options, callback);
      });
      return null;
    }

    if (!plugin.supportsLanguage(language)) return null;

    const key = codeBlockKey(options);
    const pending = pendingCodeHighlights.get(key);
    if (pending && code.startsWith(pending.code) && Date.now() - pending.at < CODE_THROTTLE_MS) {
      pending.code = code;
      pending.options = options;
      pending.callback = callback;
      pending.timer ??= setTimeout(() => flushPendingCodeHighlight(key), CODE_THROTTLE_MS);
      return null;
    }

    runCodeHighlight(plugin, key, options, callback);
    return null;
  },
};

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

type MathRehypeTransform = (tree: HastNode, file: unknown) => void;

interface MathTarget {
  scope: HastNode;
  display: boolean;
}

const MATH_CACHE_MAX_ENTRIES = 256;
const mathHtmlCache = new Map<string, HastNode[]>();

function cloneHastNode(node: HastNode): HastNode {
  const clone: HastNode = { type: node.type };
  if (node.tagName !== undefined) clone.tagName = node.tagName;
  if (node.value !== undefined) clone.value = node.value;
  if (node.properties) clone.properties = { ...node.properties };
  if (node.children) clone.children = node.children.map(cloneHastNode);
  return clone;
}

function hastText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  if (!node.children) return "";
  let text = "";
  for (const child of node.children) text += hastText(child);
  return text;
}

function hastClassName(node: HastNode): string[] {
  const value = node.properties?.className;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function mathTargetOf(node: HastNode): MathTarget | null {
  const classes = hastClassName(node);
  if (classes.includes("math-inline")) return { scope: node, display: false };
  if (classes.includes("math-display")) return { scope: node, display: true };
  if (classes.includes("language-math")) return { scope: node, display: true };
  if (node.tagName !== "pre") return null;
  const only = node.children?.length === 1 ? node.children[0] : undefined;
  if (only && only.type === "element" && hastClassName(only).includes("language-math")) {
    return { scope: node, display: true };
  }
  return null;
}

function renderMathTarget(transform: MathRehypeTransform, file: unknown, target: MathTarget): HastNode[] | null {
  const key = `${target.display ? "d" : "i"}\u0000${hastText(target.scope)}`;
  let rendered = mathHtmlCache.get(key);
  if (!rendered) {
    const isolated: HastNode = { type: "root", children: [cloneHastNode(target.scope)] };
    try {
      transform(isolated, file);
    } catch {
      return null;
    }
    rendered = isolated.children ?? [];
    if (rendered.length === 0) return null;
    mathHtmlCache.set(key, rendered);
    while (mathHtmlCache.size > MATH_CACHE_MAX_ENTRIES) {
      const oldest = mathHtmlCache.keys().next().value;
      if (oldest === undefined) break;
      mathHtmlCache.delete(oldest);
    }
  }
  return rendered.map(cloneHastNode);
}

function applyMemoizedMath(transform: MathRehypeTransform, file: unknown, node: HastNode): void {
  const children = node.children;
  if (!children?.length) return;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    const target = mathTargetOf(child);
    if (target) {
      const replacement = renderMathTarget(transform, file, target);
      if (replacement) {
        children.splice(index, 1, ...replacement);
        index += replacement.length - 1;
        continue;
      }
    }
    applyMemoizedMath(transform, file, child);
  }
}

function toRehypeTransform(plugin: StreamdownMathPlugin["rehypePlugin"]): MathRehypeTransform | null {
  const [factory, options] = (Array.isArray(plugin) ? plugin : [plugin, undefined]) as [unknown, unknown];
  if (typeof factory !== "function") return null;
  try {
    const transform = (factory as (options?: unknown) => unknown)(options);
    return typeof transform === "function" ? (transform as MathRehypeTransform) : null;
  } catch {
    return null;
  }
}

function createMemoizedMathPlugin(): StreamdownMathPlugin {
  const base = createMathPlugin({ singleDollarTextMath: true });
  const transform = toRehypeTransform(base.rehypePlugin);
  if (!transform) return base;
  const rehypePlugin = () => (tree: unknown, file: unknown) => {
    applyMemoizedMath(transform, file, tree as HastNode);
  };
  return { ...base, rehypePlugin: rehypePlugin as unknown as StreamdownMathPlugin["rehypePlugin"] };
}

const PARSE_CACHE_MAX_ENTRIES = 4;
const parsedBlockCache = new Map<string, string[]>();

function parseMarkdownBlocks(markdown: string): string[] {
  const cached = parsedBlockCache.get(markdown);
  if (cached) {
    parsedBlockCache.delete(markdown);
    parsedBlockCache.set(markdown, cached);
    return cached;
  }
  const blocks = parseMarkdownIntoBlocks(markdown);
  parsedBlockCache.set(markdown, blocks);
  while (parsedBlockCache.size > PARSE_CACHE_MAX_ENTRIES) {
    const oldest = parsedBlockCache.keys().next().value;
    if (oldest === undefined) break;
    parsedBlockCache.delete(oldest);
  }
  return blocks;
}

// Structural match for streamdown's (non-exported) MermaidInstance interface.
interface LazyMermaidInstance {
  initialize(config?: MermaidConfig): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}

// The mermaid diagram plugin is a lazy proxy: ``@streamdown/mermaid`` eagerly
// imports the full ``mermaid`` library (~2.8 MB minified), so importing it here
// would drag ~2.8 MB into every chat render — even for messages with no
// diagrams. The proxy registers the same DiagramPlugin shape; streamdown only
// calls ``getMermaid()`` when a mermaid code fence actually renders, which
// triggers the dynamic import at that moment (the diagram then appears after a
// short load — streamdown shows a "Loading diagram…" skeleton meanwhile).
const lazyMermaidPlugin: DiagramPlugin = (() => {
  let loading: Promise<typeof import("@streamdown/mermaid")> | null = null;
  const load = () => (loading ??= import("@streamdown/mermaid"));
  return {
    name: "mermaid",
    type: "diagram",
    language: "mermaid",
    getMermaid(config?: MermaidConfig) {
      let real: LazyMermaidInstance | null = null;
      const ensure = async () => {
        const mod = await load();
        real = mod.mermaid.getMermaid(config);
        return real;
      };
      void ensure();
      return {
        initialize(cfg?: MermaidConfig) {
          void load().then((mod) => {
            const inst = mod.mermaid.getMermaid(cfg);
            if (cfg) inst.initialize(cfg);
          });
        },
        async render(id: string, source: string) {
          const inst = real ?? (await ensure());
          return inst.render(id, source);
        },
      };
    },
  };
})();

const streamdownPlugins = {
  cjk,
  code: codeHighlightPlugin,
  math: createMemoizedMathPlugin(),
  mermaid: lazyMermaidPlugin,
};

const streamdownLinkSafety: ComponentProps<typeof Streamdown>["linkSafety"] = {
  enabled: false,
};

// controls 传对象时，省略的键默认为开启，table/mermaid 必须显式关闭
// 才能保持原 controls={false} 的行为。
const streamdownControls: ComponentProps<typeof Streamdown>["controls"] = {
  code: { copy: true, download: false },
  table: false,
  mermaid: false,
};

const streamdownTranslations: ComponentProps<typeof Streamdown>["translations"] = {
  copyCode: "复制代码",
};

const MARKDOWN_IMAGE_DEST_RE = /!\[([^\]\n]*)\]\(\s*([^<\n)]*?\.(?:apng|avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)(?:[?#][^\n)]*)?)\s*\)/gi;

const markdownSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: Array.from(new Set([...(defaultSchema.protocols?.href ?? []), ...ALLOWED_LINK_PROTOCOLS])),
  },
  tagNames: Array.from(new Set([...(defaultSchema.tagNames ?? []), "small", "time", "mark"])),
  attributes: {
    ...defaultSchema.attributes,
    a: Array.from(new Set([...(defaultSchema.attributes?.a ?? []), "title"])),
    span: ["dataTone", "dataSize", "data-tone", "data-size", "style", "title"],
    small: ["dataTone", "dataSize", "data-tone", "data-size", "style", "title"],
    time: ["dateTime", "datetime", "dataTone", "dataSize", "data-tone", "data-size", "style", "title"],
    mark: ["dataTone", "dataSize", "data-tone", "data-size", "style", "title"],
  },
};

const streamdownRehypePlugins: ComponentProps<typeof Streamdown>["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  [
    harden,
    {
      allowedImagePrefixes: ["*"],
      allowedLinkPrefixes: ["*"],
      allowedProtocols: ["tel:", "obsidian:"],
      allowDataImages: true,
    },
  ],
];

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function linePrefix(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return text.slice(lineStart, index);
}

function fenceAt(text: string, index: number): { marker: "`" | "~"; length: number } | null {
  const prefix = linePrefix(text, index);
  if (!/^[ \t]{0,3}$/.test(prefix)) return null;
  const match = text.slice(index).match(/^(`{3,}|~{3,})/);
  if (!match) return null;
  const marker = match[1][0] as "`" | "~";
  return { marker, length: match[1].length };
}

function closingFenceAt(text: string, index: number, fence: { marker: "`" | "~"; length: number }): boolean {
  const found = fenceAt(text, index);
  return Boolean(found && found.marker === fence.marker && found.length >= fence.length);
}

function tickRunLength(text: string, index: number): number {
  let length = 0;
  while (text[index + length] === "`") length += 1;
  return length;
}

function findUnescaped(text: string, needle: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const found = text.indexOf(needle, index);
    if (found === -1) return -1;
    if (!isEscaped(text, found)) return found;
    index = found + needle.length;
  }
  return -1;
}

function normalizeTexMathDelimiters(text: string): string {
  let result = "";
  let index = 0;
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let inlineTicks = 0;

  while (index < text.length) {
    if (inlineTicks === 0) {
      const currentFence = fenceAt(text, index);
      if (currentFence) {
        if (fence && closingFenceAt(text, index, fence)) {
          fence = null;
        } else if (!fence) {
          fence = currentFence;
        }
        const length = currentFence.length;
        result += text.slice(index, index + length);
        index += length;
        continue;
      }
    }

    if (!fence && text[index] === "`") {
      const length = tickRunLength(text, index);
      if (inlineTicks === 0) {
        inlineTicks = length;
      } else if (length === inlineTicks) {
        inlineTicks = 0;
      }
      result += text.slice(index, index + length);
      index += length;
      continue;
    }

    if (!fence && inlineTicks === 0 && !isEscaped(text, index)) {
      if (text.startsWith("\\(", index)) {
        const close = findUnescaped(text, "\\)", index + 2);
        if (close !== -1) {
          result += `$${text.slice(index + 2, close)}$`;
          index = close + 2;
          continue;
        }
      }

      if (text.startsWith("\\[", index)) {
        const close = findUnescaped(text, "\\]", index + 2);
        if (close !== -1) {
          result += `\n\n$$\n${text.slice(index + 2, close).trim()}\n$$\n\n`;
          index = close + 2;
          continue;
        }
      }
    }

    result += text[index];
    index += 1;
  }

  return result;
}

function toMarkdownSafeImageDestination(url: string): string {
  // Windows absolute paths (D:\foo or D:/foo) parse as an unknown URL scheme
  // ("d:") in rehype-harden and get blocked → "[Image blocked]" before the
  // local-path handling in MessageImage ever runs. Convert them to a
  // POSIX-style /D:/foo so the harden pass keeps them as relative paths;
  // MessageImage maps them back to the real path in normalizeLocalFilePath.
  const drive = url.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!drive) return url;
  return `/${drive[1]}:/${drive[2].replace(/\\/g, "/")}`;
}

function normalizeMarkdownImageDestinations(text: string): string {
  return text.replace(MARKDOWN_IMAGE_DEST_RE, (match, alt: string, rawUrl: string) => {
    const url = rawUrl.trim();
    if (!isImageReference(url)) return match;
    const normalized = toMarkdownSafeImageDestination(url);
    if (normalized !== url) {
      return /\s/.test(normalized) ? `![${alt}](<${normalized}>)` : `![${alt}](${normalized})`;
    }
    if (/\s/.test(url)) return `![${alt}](<${url}>)`;
    return match;
  });
}

function safeHref(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || BLOCKED_EXTERNAL_PROTOCOLS.test(trimmed)) return undefined;

  try {
    const url = new URL(trimmed);
    if (!ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol)) return undefined;
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.hostname) return undefined;
    if (url.protocol === "mailto:" && !url.pathname.trim()) return undefined;
    if (url.protocol === "obsidian:" && !url.hostname) return undefined;
    return url.href;
  } catch {
    if (trimmed.startsWith("#")) return trimmed;
    if ((trimmed.startsWith("/") && !trimmed.startsWith("//")) || trimmed.startsWith("./") || trimmed.startsWith("../")) {
      return trimmed;
    }
    return undefined;
  }
}

function isExternalHref(value: string): boolean {
  try {
    const url = new URL(value);
    return ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

function decodeHashId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function footnoteTargetCandidates(id: string): string[] {
  const decoded = decodeHashId(id);
  const candidates = new Set([id, decoded]);

  for (const candidate of Array.from(candidates)) {
    if (candidate.startsWith("user-content-")) {
      candidates.add(`user-content-${candidate}`);
    } else {
      candidates.add(`user-content-${candidate}`);
    }
  }

  return Array.from(candidates).filter(Boolean);
}

function scrollToHashTarget(hash: string): boolean {
  if (typeof document === "undefined" || !hash.startsWith("#")) return false;
  const id = hash.slice(1);
  if (!id) return false;

  for (const candidate of footnoteTargetCandidates(id)) {
    const target = document.getElementById(candidate);
    if (!target) continue;
    target.scrollIntoView({ block: "start", behavior: "smooth" });
    return true;
  }

  return false;
}

function handleHashAnchorClick(event: MouseEvent<HTMLAnchorElement>, href: string) {
  if (event.defaultPrevented || event.button !== 0) return;
  event.preventDefault();
  scrollToHashTarget(href);
}

function MarkdownAnchor({
  href,
  children,
  node: _node,
  ...props
}: ComponentProps<"a"> & { node?: unknown }) {
  const safe = safeHref(href);
  if (!safe) return <span>{children}</span>;
  const external = isExternalHref(safe);
  const isHashAnchor = safe.startsWith("#");
  return (
    <a
      {...props}
      href={safe}
      onClick={isHashAnchor ? (event) => handleHashAnchorClick(event, safe) : props.onClick}
      rel={external ? "noreferrer" : undefined}
      target={external && /^https?:\/\//i.test(safe) ? "_blank" : undefined}
    >
      {children}
    </a>
  );
}

function MarkdownImage({
  src,
  alt,
  title,
  node: _node,
  ..._props
}: ComponentProps<"img"> & { node?: unknown }) {
  return (
    <MessageImage
      image={{
        url: typeof src === "string" ? src : undefined,
        alt: typeof alt === "string" && alt ? alt : undefined,
        title: typeof title === "string" && title ? title : undefined,
        name: typeof alt === "string" && alt ? alt : undefined,
      }}
    />
  );
}

function classNames(...values: Array<string | false | null | undefined>): string | undefined {
  const joined = values.filter(Boolean).join(" ");
  return joined || undefined;
}

function dataValue(props: Record<string, unknown>, dashed: string, camel: string): string | undefined {
  const value = props[dashed] ?? props[camel];
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function toneClass(tone: string | undefined, fallback?: "muted" | "accent" | "subtle") {
  const value = tone || fallback;
  switch (value) {
    case "muted":
    case "secondary":
      return s.toneMuted;
    case "subtle":
    case "faint":
      return s.toneSubtle;
    case "accent":
    case "primary":
      return s.toneAccent;
    default:
      return undefined;
  }
}

function sizeClass(size: string | undefined, fallback?: "small" | "tiny") {
  const value = size || fallback;
  switch (value) {
    case "small":
    case "sm":
      return s.sizeSmall;
    case "tiny":
    case "xs":
      return s.sizeTiny;
    default:
      return undefined;
  }
}

function sanitizeStyleValue(name: string, value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const raw = String(value).trim();
  if (!raw || /url\s*\(|expression\s*\(|[<>]/i.test(raw)) return undefined;

  switch (name) {
    case "color": {
      if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(raw)) return raw;
      if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(raw)) return raw;
      if (/^hsla?\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(raw)) return raw;
      if (/^var\(--[a-z0-9-]+\)$/i.test(raw)) return raw;
      if (/^(?:currentcolor|inherit|initial|unset)$/i.test(raw)) return raw;
      return undefined;
    }
    case "fontSize": {
      const px = raw.match(/^(\d+(?:\.\d+)?)px$/i);
      if (px) {
        const valuePx = Number(px[1]);
        return valuePx >= 10 && valuePx <= 18 ? raw : undefined;
      }
      const relative = raw.match(/^(\d+(?:\.\d+)?)(em|rem)$/i);
      if (relative) {
        const valueRelative = Number(relative[1]);
        return valueRelative >= 0.65 && valueRelative <= 1.2 ? raw : undefined;
      }
      const percent = raw.match(/^(\d+(?:\.\d+)?)%$/);
      if (percent) {
        const valuePercent = Number(percent[1]);
        return valuePercent >= 65 && valuePercent <= 120 ? raw : undefined;
      }
      return undefined;
    }
    case "opacity": {
      const opacity = Number(raw);
      return Number.isFinite(opacity) && opacity >= 0.35 && opacity <= 1 ? String(opacity) : undefined;
    }
    case "fontWeight": {
      if (/^(?:normal|bold|lighter|bolder)$/i.test(raw)) return raw;
      const weight = Number(raw);
      return Number.isInteger(weight) && weight >= 300 && weight <= 800 ? String(weight) : undefined;
    }
    case "fontStyle": {
      return /^(?:normal|italic)$/i.test(raw) ? raw : undefined;
    }
    case "lineHeight": {
      const lineHeight = Number(raw);
      return Number.isFinite(lineHeight) && lineHeight >= 1 && lineHeight <= 2 ? String(lineHeight) : undefined;
    }
    default:
      return undefined;
  }
}

function toCamelStyleName(name: string): keyof CSSProperties | null {
  switch (name.trim().toLowerCase()) {
    case "color":
      return "color";
    case "font-size":
    case "fontsize":
      return "fontSize";
    case "opacity":
      return "opacity";
    case "font-weight":
    case "fontweight":
      return "fontWeight";
    case "font-style":
    case "fontstyle":
      return "fontStyle";
    case "line-height":
    case "lineheight":
      return "lineHeight";
    default:
      return null;
  }
}

function sanitizeInlineStyle(style: unknown): CSSProperties | undefined {
  const entries: Array<[string, unknown]> = [];

  if (typeof style === "string") {
    for (const declaration of style.split(";")) {
      const separator = declaration.indexOf(":");
      if (separator === -1) continue;
      entries.push([declaration.slice(0, separator), declaration.slice(separator + 1)]);
    }
  } else if (style && typeof style === "object") {
    entries.push(...Object.entries(style as Record<string, unknown>));
  }

  const sanitized: CSSProperties = {};
  for (const [rawName, rawValue] of entries) {
    const name = toCamelStyleName(rawName);
    if (!name) continue;
    const value = sanitizeStyleValue(name, rawValue);
    if (value) {
      (sanitized as Record<string, string>)[name] = value;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function richInlineClassName(
  props: Record<string, unknown>,
  className: string | undefined,
  defaults: { size?: "small" | "tiny"; tone?: "muted" | "accent" | "subtle" } = {},
) {
  return classNames(
    s.richInline,
    toneClass(dataValue(props, "data-tone", "dataTone"), defaults.tone),
    sizeClass(dataValue(props, "data-size", "dataSize"), defaults.size),
    className,
  );
}

function hasRichInlineData(props: Record<string, unknown>): boolean {
  return Boolean(
    dataValue(props, "data-tone", "dataTone") ||
      dataValue(props, "data-size", "dataSize") ||
      props.style ||
      props.title,
  );
}

function MarkdownSpan({ children, className, node: _node, style, ...props }: RichInlineProps<"span">) {
  const insideKatex = useContext(KatexSpanContext);
  const isKatexRoot = typeof className === "string" && /\bkatex\b/.test(className);

  if (insideKatex || isKatexRoot) {
    const span = (
      <span {...props} className={className} style={style as CSSProperties | undefined}>
        {children}
      </span>
    );

    return isKatexRoot ? <KatexSpanContext.Provider value>{span}</KatexSpanContext.Provider> : span;
  }

  const record = props as Record<string, unknown>;
  if (className && !hasRichInlineData(record)) {
    return (
      <span {...props} className={className} style={style as CSSProperties | undefined}>
        {children}
      </span>
    );
  }

  return (
    <span
      {...props}
      className={richInlineClassName(record, className)}
      style={sanitizeInlineStyle(style)}
    >
      {children}
    </span>
  );
}

function MarkdownSmall({ children, className, node: _node, style, ...props }: RichInlineProps<"small">) {
  return (
    <small
      {...props}
      className={richInlineClassName(props as Record<string, unknown>, className, { size: "small", tone: "muted" })}
      style={sanitizeInlineStyle(style)}
    >
      {children}
    </small>
  );
}

function MarkdownTime({ children, className, node: _node, style, ...props }: RichInlineProps<"time">) {
  return (
    <time
      {...props}
      className={richInlineClassName(props as Record<string, unknown>, className, { size: "small", tone: "muted" })}
      style={sanitizeInlineStyle(style)}
    >
      {children}
    </time>
  );
}

function MarkdownMark({ children, className, node: _node, style, ...props }: RichInlineProps<"mark">) {
  return (
    <mark
      {...props}
      className={classNames(s.mark, toneClass(dataValue(props as Record<string, unknown>, "data-tone", "dataTone"), "accent"), className)}
      style={sanitizeInlineStyle(style)}
    >
      {children}
    </mark>
  );
}

const streamdownComponents = {
  a: MarkdownAnchor,
  img: MarkdownImage,
  mark: MarkdownMark,
  small: MarkdownSmall,
  span: MarkdownSpan,
  time: MarkdownTime,
};

// memo：Markdown 解析（streamdown + KaTeX + mermaid）是重量级渲染，父组件
// 与正文无关的 state 变化（编辑器字符计数、保存状态等）不应触发整篇重解析。
export const MarkdownText = memo(function MarkdownText({
  text,
  streaming = false,
}: MarkdownTextProps) {
  const normalizedText = useMemo(
    () => normalizeTexMathDelimiters(normalizeMarkdownImageDestinations(text)),
    [text],
  );

  return (
    <Streamdown
      className={s.markdownRoot}
      components={streamdownComponents}
      controls={streamdownControls}
      dir="auto"
      isAnimating={streaming}
      lineNumbers={false}
      linkSafety={streamdownLinkSafety}
      mode={streaming ? "streaming" : "static"}
      parseMarkdownIntoBlocksFn={parseMarkdownBlocks}
      plugins={streamdownPlugins}
      rehypePlugins={streamdownRehypePlugins}
      translations={streamdownTranslations}
    >
      {normalizedText}
    </Streamdown>
  );
});
