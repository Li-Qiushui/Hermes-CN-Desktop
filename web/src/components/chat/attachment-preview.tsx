import { File, FileText, Folder, Image as ImageIcon, X } from "lucide-react";
import type { ComposerAttachment } from "./composer-types";
import { formatPasteCharCount, isAttachmentBusy } from "./goose-composer-attachments";
import { ZoomableImage } from "./zoomable-image";
import s from "./goose-composer.module.css";

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
  if (attachment.pasteChars) return `粘贴内容 ${formatPasteCharCount(attachment.pasteChars)}`;
  if (attachment.status === "done") return "已添加";
  const size = formatAttachmentSize(attachment.size);
  if (size) return size;
  if (attachment.kind === "image") return "图片";
  if (attachment.kind === "directory") return "文件夹";
  return "文件";
}

function AttachmentGlyph({ attachment }: { attachment: ComposerAttachment }) {
  if (attachment.kind === "directory") return <Folder aria-hidden="true" />;
  if (attachment.kind === "image") return <ImageIcon aria-hidden="true" />;
  if (attachment.pasteChars || attachment.mimeType?.startsWith("text/")) {
    return <FileText aria-hidden="true" />;
  }
  return <File aria-hidden="true" />;
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
      {attachments.map((attachment) => {
        const showThumb = attachment.kind === "image" && Boolean(attachment.previewUrl);
        return (
          <div
            key={attachment.id}
            className={s.attachmentChip}
            data-kind={attachment.kind}
            data-status={attachment.status}
            title={attachment.error || attachment.path || attachment.name}
          >
            {showThumb ? (
              <ZoomableImage
                src={attachment.previewUrl!}
                alt={attachment.name}
                title={`查看大图：${attachment.name}`}
                frameClassName={s.attachmentThumb}
              />
            ) : (
              <span className={s.attachmentGlyph} aria-hidden="true">
                <AttachmentGlyph attachment={attachment} />
              </span>
            )}
            {showThumb ? null : (
              <span className={s.attachmentMeta}>
                <span className={s.attachmentName}>{attachment.name}</span>
                <span className={s.attachmentDetail}>{attachmentDetail(attachment)}</span>
                {attachment.status === "uploading" ? (
                  <span className={s.attachmentProgress} aria-hidden="true">
                    <span style={{ width: `${attachment.progress ?? 0}%` }} />
                  </span>
                ) : null}
              </span>
            )}
            <button
              type="button"
              className={s.attachmentRemove}
              onClick={() => onRemove(attachment.id)}
              disabled={isAttachmentBusy(attachment)}
              aria-label={`移除 ${attachment.name}`}
              title={`移除 ${attachment.name}`}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
