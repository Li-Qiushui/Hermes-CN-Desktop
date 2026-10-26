import { ChevronLeft, ChevronRight } from "lucide-react";
import s from "./message-revision-pager.module.css";

export interface MessageRevisionPagerProps {
  index: number;
  count: number;
  disabled?: boolean;
  onSelect: (index: number) => void;
}

export function MessageRevisionPager({ index, count, disabled = false, onSelect }: MessageRevisionPagerProps) {
  if (count < 2) return null;
  const canPrev = !disabled && index > 0;
  const canNext = !disabled && index < count - 1;
  return (
    <div className={s.pager} role="group" aria-label="回答版本" data-message-revision-pager="true">
      <button
        type="button"
        className={s.step}
        onClick={() => onSelect(index - 1)}
        disabled={!canPrev}
        title="看上一版回答"
        aria-label="看上一版回答"
        data-revision-step="prev"
      >
        <ChevronLeft size={13} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <span className={s.counter}>{`${index + 1}/${count}`}</span>
      <button
        type="button"
        className={s.step}
        onClick={() => onSelect(index + 1)}
        disabled={!canNext}
        title="看下一版回答"
        aria-label="看下一版回答"
        data-revision-step="next"
      >
        <ChevronRight size={13} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <span className={s.label}>旧回答还在，可以来回切</span>
    </div>
  );
}
