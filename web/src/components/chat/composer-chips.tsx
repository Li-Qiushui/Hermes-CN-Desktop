import { AtSign, FileText, Folder, GitBranch, Globe, MessageSquare, X } from "lucide-react";
import type { MentionKind } from "@/lib/composer-mentions";
import s from "./goose-composer.module.css";

export interface ComposerMentionRef {
  start: number;
  end: number;
  text: string;
  kind: MentionKind;
  label: string;
  kindLabel: string;
}

const MENTION_REF_RE = /(?:^|\s)(@(?:file|folder|url|image|git|session):\S+|@(?:diff|staged)(?=\s|$))/gi;

const KIND_LABELS: Record<MentionKind, string> = {
  file: "文件",
  folder: "文件夹",
  url: "网页",
  git: "git",
  session: "会话",
  simple: "引用",
};

function lastSegment(value: string): string {
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] || value;
}

export function parseComposerMentions(text: string): ComposerMentionRef[] {
  const refs: ComposerMentionRef[] = [];
  MENTION_REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null = MENTION_REF_RE.exec(text);
  while (match) {
    const token = match[1] ?? "";
    const start = match.index + match[0].length - token.length;
    const body = token.slice(1);
    const separator = body.indexOf(":");
    const prefix = separator >= 0 ? body.slice(0, separator).toLowerCase() : "";
    const value = separator >= 0 ? body.slice(separator + 1) : body;
    const known = separator >= 0 && prefix in KIND_LABELS;
    const kind: MentionKind = known ? (prefix as MentionKind) : "simple";
    refs.push({
      start,
      end: start + token.length,
      text: token,
      kind,
      label: known && prefix !== "git" ? lastSegment(value) : body,
      kindLabel: known ? KIND_LABELS[kind] : "引用",
    });
    match = MENTION_REF_RE.exec(text);
  }
  return refs;
}

export function removeComposerMention(text: string, ref: ComposerMentionRef): { text: string; cursor: number } {
  const before = text.slice(0, ref.start);
  const after = text.slice(ref.end).replace(/^\s+/, "");
  const left = before.replace(/\s+$/, "");
  const joiner = left && after ? " " : "";
  const next = `${left}${joiner}${after}`;
  return { text: next, cursor: (left + joiner).length };
}

function MentionKindIcon({ kind }: { kind: MentionKind }) {
  switch (kind) {
    case "folder":
      return <Folder aria-hidden="true" />;
    case "url":
      return <Globe aria-hidden="true" />;
    case "git":
    case "simple":
      return <GitBranch aria-hidden="true" />;
    case "session":
      return <MessageSquare aria-hidden="true" />;
    case "file":
      return <FileText aria-hidden="true" />;
    default:
      return <AtSign aria-hidden="true" />;
  }
}

export function MentionChipRow({
  mentions,
  onRemove,
  disabled = false,
}: {
  mentions: ComposerMentionRef[];
  onRemove: (ref: ComposerMentionRef) => void;
  disabled?: boolean;
}) {
  if (!mentions.length) return null;

  return (
    <div className={s.mentionRow} role="list" aria-label="已引用">
      <span className={s.mentionRowLabel} aria-hidden="true">
        已引用
      </span>
      {mentions.map((mention, index) => (
        <span
          key={`${mention.start}-${mention.text}-${index}`}
          className={s.mentionChip}
          role="listitem"
          title={mention.text}
        >
          <span className={s.mentionChipIcon}>
            <MentionKindIcon kind={mention.kind} />
          </span>
          <span className={s.mentionChipKind}>{mention.kindLabel}</span>
          <span className={s.mentionChipValue}>{mention.label}</span>
          <button
            type="button"
            className={s.mentionChipRemove}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onRemove(mention)}
            disabled={disabled}
            aria-label={`移除引用 ${mention.text}`}
            title={`移除引用 ${mention.text}`}
          >
            <X aria-hidden="true" />
          </button>
        </span>
      ))}
    </div>
  );
}
