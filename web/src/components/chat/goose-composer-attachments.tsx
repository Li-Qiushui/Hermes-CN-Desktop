import { fileNameFromPath, isImagePath } from "@/lib/composer-prompt";
import type { ComposerAttachment } from "./composer-types";
import s from "./goose-composer.module.css";

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export const LARGE_PASTE_ATTACHMENT_THRESHOLD = 3_000;

export function shouldConvertPasteToAttachment(text: string): boolean {
  return typeof text === "string" && text.length > LARGE_PASTE_ATTACHMENT_THRESHOLD;
}

export function pasteCharLabel(text: string): string {
  const chars = text.length;
  if (chars >= 10_000) return `${(chars / 10_000).toFixed(1)} 万字`;
  return `${chars} 字`;
}

export function largePasteNotice(text: string): string {
  return `已粘入的 ${pasteCharLabel(text)}已转为附件`;
}

function normalizeDroppedPath(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  if (text.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(text).pathname);
    } catch {
      return text;
    }
  }
  if (text.startsWith("/") || text.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(text)) {
    return text;
  }
  return null;
}

export function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of paths) {
    const path = normalizeDroppedPath(raw);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

function createAttachmentId(index: number): string {
  return `att-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || isImagePath(file.name);
}

export function createPathAttachment(path: string, index: number): ComposerAttachment {
  return {
    id: createAttachmentId(index),
    source: "path",
    path,
    name: fileNameFromPath(path),
    kind: isImagePath(path) ? "image" : "file",
    status: "ready",
  };
}

function pastedTextFileName(): string {
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
  const salt = Math.random().toString(16).slice(2, 6);
  return `pasted-content-${stamp}-${salt}.txt`;
}

export function createPastedTextAttachment(text: string, index = 0): ComposerAttachment {
  const file = new File([text], pastedTextFileName(), { type: "text/plain" });
  return {
    id: createAttachmentId(index),
    source: "browser",
    file,
    name: file.name,
    kind: "file",
    status: "ready",
    size: file.size,
    mimeType: "text/plain",
  };
}

export function createFileAttachment(file: File, index: number): ComposerAttachment {
  const image = isImageFile(file);
  return {
    id: createAttachmentId(index),
    source: "browser",
    file,
    name: file.name || `attachment-${index + 1}`,
    kind: image ? "image" : "file",
    status: "ready",
    size: file.size,
    mimeType: file.type || undefined,
    previewUrl: image && typeof URL !== "undefined" ? URL.createObjectURL(file) : undefined,
  };
}

export function attachmentIdentity(attachment: ComposerAttachment): string {
  if (attachment.path) return `path:${attachment.path}`;
  if (attachment.file) {
    return `file:${attachment.file.name}:${attachment.file.size}:${attachment.file.lastModified}`;
  }
  return `name:${attachment.name}:${attachment.size ?? ""}`;
}

export function revokeAttachmentPreview(attachment: ComposerAttachment) {
  if (attachment.previewUrl?.startsWith("blob:")) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

export function isAttachmentBusy(attachment: ComposerAttachment): boolean {
  return attachment.status === "uploading" || attachment.status === "processing";
}

function formatAttachmentSize(size?: number): string {
  if (!Number.isFinite(size)) return "";
  const value = Number(size);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(value >= 100 * 1024 ? 0 : 1)} KB`;
  return `${Math.max(0, Math.round(value))} B`;
}

function attachmentDetail(attachment: ComposerAttachment): string {
  if (attachment.error) return attachment.error;
  if (attachment.status === "uploading") return `上传中 ${attachment.progress ?? 0}%`;
  if (attachment.status === "processing") return "处理中";
  if (attachment.status === "done") return "已添加";
  const size = formatAttachmentSize(attachment.size);
  if (size) return size;
  if (attachment.kind === "image") return "图片";
  if (attachment.kind === "directory") return "文件夹";
  return "文件";
}

export function AttachmentTray({
  attachments,
  onRemove,
}: {
  attachments: ComposerAttachment[];
  onRemove: (id: string) => void;
}) {
  if (!attachments.length) return null;

  return (
    <div className={s.attachmentTray}>
      {attachments.map((attachment) => (
        <span
          key={attachment.id}
          className={s.attachmentChip}
          data-kind={attachment.kind}
          data-status={attachment.status}
          title={attachment.error || attachment.path || attachment.name}
        >
          {attachment.kind === "image" && attachment.previewUrl ? (
            <span className={s.attachmentPreview}>
              <img src={attachment.previewUrl} alt="" />
            </span>
          ) : (
            <span className={s.attachmentIcon} aria-hidden="true">
              {attachment.kind === "directory" ? "□" : attachment.kind === "image" ? "▧" : "▤"}
            </span>
          )}
          <span className={s.attachmentMeta}>
            <span className={s.attachmentName}>{attachment.name}</span>
            <span className={s.attachmentDetail}>{attachmentDetail(attachment)}</span>
            {attachment.status === "uploading" ? (
              <span className={s.attachmentProgress} aria-hidden="true">
                <span style={{ width: `${attachment.progress ?? 0}%` }} />
              </span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            disabled={isAttachmentBusy(attachment)}
            aria-label={`移除 ${attachment.name}`}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
