import { useEffect, useState } from "react";
import { FileCode2, FileText, Film, Music4, TriangleAlert } from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { readLocalDataUrl } from "@/lib/local-file-read";
import { fetchMediaDataUrl } from "@/lib/transport";
import type { ChatMediaItem } from "./chat-types";
import { MessageImage } from "./message-image";
import s from "./media-block.module.css";

interface MediaBlockProps {
  items: readonly ChatMediaItem[];
}

interface MediaDataUrlState {
  path: string;
  src?: string;
  failed?: boolean;
}

type MediaReader = (path: string) => Promise<string>;

const SVG_DATA_URL_RE = /^data:image\/svg\+xml/i;

function useMediaDataUrl(path: string, read: MediaReader): MediaDataUrlState {
  const [state, setState] = useState<MediaDataUrlState>({ path });

  useEffect(() => {
    let active = true;
    setState({ path });
    void read(path)
      .then((src) => {
        if (active) setState({ path, src: src || undefined, failed: src ? undefined : true });
      })
      .catch(() => {
        if (active) setState({ path, failed: true });
      });
    return () => {
      active = false;
    };
  }, [path, read]);

  return state.path === path ? state : { path };
}

function extensionLabel(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return name.slice(dot + 1).toUpperCase();
}

function ExtensionBadge({ name }: { name: string }) {
  const label = extensionLabel(name);
  if (!label) return null;
  return <span className={s.extension}>{label}</span>;
}

function CopyPathButton({ path }: { path: string }) {
  return (
    <CopyButton className={s.copyPath} text={path} showStatusIcon={false}>
      复制路径
    </CopyButton>
  );
}

function MediaFallback({ item, reason }: { item: ChatMediaItem; reason: string }) {
  return (
    <div className={s.fallback} role="alert">
      <TriangleAlert className={s.fallbackIcon} size={16} strokeWidth={1.8} aria-hidden="true" />
      <div className={s.fallbackBody}>
        <span className={s.fallbackTitle}>{reason}</span>
        <span className={s.fileName} title={item.path}>
          {item.name}
        </span>
        <span className={s.filePath} title={item.path}>
          {item.path}
        </span>
        <CopyPathButton path={item.path} />
      </div>
    </div>
  );
}

function PlayerSkeleton({ item }: { item: ChatMediaItem }) {
  return (
    <div className={s.skeleton} role="status" aria-label={`正在加载 ${item.name}`}>
      <span className={s.skeletonLine} />
      <span className={s.skeletonLine} data-short="true" />
    </div>
  );
}

function AudioEntry({ item }: { item: ChatMediaItem }) {
  const state = useMediaDataUrl(item.path, readLocalDataUrl);
  if (state.failed) return <MediaFallback item={item} reason="音频加载失败" />;

  return (
    <div className={s.playerCard}>
      <div className={s.playerHead}>
        <Music4 className={s.kindIcon} size={16} strokeWidth={1.8} aria-hidden="true" />
        <span className={s.fileName} title={item.path}>
          {item.name}
        </span>
        <ExtensionBadge name={item.name} />
      </div>
      {state.src ? (
        <audio className={s.audio} src={state.src} controls preload="metadata" aria-label={item.name} />
      ) : (
        <PlayerSkeleton item={item} />
      )}
    </div>
  );
}

function VideoEntry({ item }: { item: ChatMediaItem }) {
  const state = useMediaDataUrl(item.path, readLocalDataUrl);
  if (state.failed) return <MediaFallback item={item} reason="视频加载失败" />;

  return (
    <div className={s.playerCard}>
      <div className={s.playerHead}>
        <Film className={s.kindIcon} size={16} strokeWidth={1.8} aria-hidden="true" />
        <span className={s.fileName} title={item.path}>
          {item.name}
        </span>
        <ExtensionBadge name={item.name} />
      </div>
      {state.src ? (
        <video
          className={s.video}
          src={state.src}
          controls
          playsInline
          preload="metadata"
          aria-label={item.name}
        />
      ) : (
        <PlayerSkeleton item={item} />
      )}
    </div>
  );
}

function FileCard({ item }: { item: ChatMediaItem }) {
  const Icon = item.kind === "html" ? FileCode2 : FileText;
  return (
    <div className={s.fileCard}>
      <Icon className={s.kindIcon} size={18} strokeWidth={1.8} aria-hidden="true" />
      <div className={s.fileBody}>
        <span className={s.fileName} title={item.path}>
          {item.name}
        </span>
        <span className={s.fileMeta}>
          <ExtensionBadge name={item.name} />
          <span className={s.fileKind}>{item.kind === "html" ? "HTML 文件" : "文件"}</span>
        </span>
      </div>
      <CopyPathButton path={item.path} />
    </div>
  );
}

function ImageEntry({ item }: { item: ChatMediaItem }) {
  const state = useMediaDataUrl(item.path, fetchMediaDataUrl);
  const [brokenSrc, setBrokenSrc] = useState<string>();

  if (state.failed) return <MediaFallback item={item} reason="图片加载失败" />;
  if (!state.src) return <PlayerSkeleton item={item} />;

  if (SVG_DATA_URL_RE.test(state.src)) {
    if (brokenSrc === state.src) return <MediaFallback item={item} reason="图片加载失败" />;
    // SVG 走 <img> 内联：img 上下文是替代文档，不执行脚本、不加载外部子资源，
    // 安全性与普通位图一致；不能改 safeImageSrc 的全局策略（别的路径靠它挡 XSS）。
    return (
      <img
        className={s.inlineImage}
        src={state.src}
        alt={item.name}
        title={item.name}
        onError={() => setBrokenSrc(state.src)}
      />
    );
  }

  return (
    <MessageImage
      image={{ url: state.src, name: item.name, alt: item.name, title: item.name }}
    />
  );
}

function MediaEntry({ item }: { item: ChatMediaItem }) {
  if (item.kind === "image") return <ImageEntry item={item} />;
  if (item.kind === "audio") return <AudioEntry item={item} />;
  if (item.kind === "video") return <VideoEntry item={item} />;
  return <FileCard item={item} />;
}

export function MediaBlock({ items }: MediaBlockProps) {
  if (!items.length) return null;
  return (
    <div className={s.mediaList} data-media-channel="true">
      {items.map((item, index) => (
        <div key={`${item.path}-${index}`} className={s.mediaItem}>
          <MediaEntry item={item} />
        </div>
      ))}
    </div>
  );
}
