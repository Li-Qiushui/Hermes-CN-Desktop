import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, MessageCircleQuestion, ShieldAlert } from "lucide-react";
import { Button } from "@hermes/shared-ui";
import { approvalChoices, type ApprovalChoice } from "@/lib/prompt-contract";
import {
  clarifyAnswerValue,
  clarifyOptions,
  displayClarifyAnswer,
  type ClarifyQaEntry,
} from "@/lib/inline-prompts";
import type { PendingPrompt } from "@/stores/chat";
import s from "./inline-prompt-card.module.css";

interface ClarifyDraft {
  values: string[];
  text: string;
}

const EMPTY_DRAFT: ClarifyDraft = { values: [], text: "" };

function answerValuesOf(draft: ClarifyDraft, multiSelect: boolean): string[] {
  const typed = draft.text.trim();
  if (multiSelect) return typed ? [...draft.values, typed] : draft.values;
  return typed ? [typed] : draft.values;
}

export interface ClarifyInlineCardProps {
  prompts: PendingPrompt[];
  submitting?: boolean;
  error?: string | null;
  onSubmit: (answers: Record<string, string | null>) => void;
  onSkip: () => void;
}

export function ClarifyInlineCard({
  prompts,
  submitting = false,
  error,
  onSubmit,
  onSkip,
}: ClarifyInlineCardProps) {
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, ClarifyDraft>>({});
  const [active, setActive] = useState(0);

  const total = prompts.length;
  const safeIndex = Math.min(index, Math.max(0, total - 1));
  const current = prompts[safeIndex];
  const uid = current ? (current.questionId ?? current.promptId) : "";
  const draft = drafts[uid] ?? EMPTY_DRAFT;
  const options = useMemo(() => (current ? clarifyOptions(current) : []), [current]);
  const selectedValues = answerValuesOf(draft, current?.multiSelect ?? false);
  const isLast = safeIndex >= total - 1;

  const patchDraft = useCallback(
    (next: (prev: ClarifyDraft) => ClarifyDraft) => {
      setDrafts((prev) => ({ ...prev, [uid]: next(prev[uid] ?? EMPTY_DRAFT) }));
    },
    [uid],
  );

  const chooseOption = useCallback(
    (value: string) => {
      if (!current || submitting) return;
      patchDraft((prev) =>
        current.multiSelect
          ? {
              text: prev.text,
              values: prev.values.includes(value)
                ? prev.values.filter((item) => item !== value)
                : [...prev.values, value],
            }
          : { values: [value], text: "" },
      );
    },
    [current, patchDraft, submitting],
  );

  const collectAnswers = useCallback(() => {
    const answers: Record<string, string | null> = {};
    for (const prompt of prompts) {
      const key = prompt.questionId ?? prompt.promptId;
      const entry = drafts[key] ?? EMPTY_DRAFT;
      answers[key] = clarifyAnswerValue(answerValuesOf(entry, prompt.multiSelect), prompt.multiSelect);
    }
    return answers;
  }, [drafts, prompts]);

  const goNext = useCallback(() => {
    if (submitting) return;
    if (safeIndex < total - 1) {
      setIndex(safeIndex + 1);
      setActive(0);
      return;
    }
    onSubmit(collectAnswers());
  }, [collectAnswers, onSubmit, safeIndex, submitting, total]);

  const goPrev = useCallback(() => {
    if (safeIndex === 0) return;
    setIndex(safeIndex - 1);
    setActive(0);
  }, [safeIndex]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (submitting) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onSkip();
        return;
      }
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (typing) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((prev) => Math.min(options.length - 1, prev + 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((prev) => Math.max(0, prev - 1));
        return;
      }
      if (/^[1-9]$/.test(event.key)) {
        const option = options[Number(event.key) - 1];
        if (option) {
          event.preventDefault();
          chooseOption(option.value);
        }
        return;
      }
      if (event.key === "Enter") {
        const option = options[active];
        if (option) {
          event.preventDefault();
          chooseOption(option.value);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, chooseOption, onSkip, options, submitting]);

  if (!current) return null;

  return (
    <section
      className={s.card}
      data-testid="clarify-inline-card"
      data-kind="clarify"
      aria-label="需要你回答"
    >
      <header className={s.header}>
        <span className={s.headIcon} data-kind="clarify">
          <MessageCircleQuestion size={13} aria-hidden="true" />
        </span>
        <span className={s.title}>需要你回答</span>
        <span className={s.spacer} />
        <span className={s.counter} data-testid="clarify-inline-counter">
          {safeIndex + 1} / {total}
        </span>
      </header>

      <p className={s.question}>{current.question}</p>

      {options.length > 0 ? (
        <div className={s.options}>
          {options.map((option, optionIndex) => {
            const picked = selectedValues.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                className={s.option}
                data-selected={picked ? "true" : undefined}
                data-active={optionIndex === active ? "true" : undefined}
                aria-pressed={current.multiSelect ? picked : undefined}
                disabled={submitting}
                onClick={() => chooseOption(option.value)}
              >
                <span className={s.optionIndex}>{optionIndex + 1}</span>
                <span className={s.optionLabel}>{option.label}</span>
                {option.recommended ? <span className={s.recommended}>推荐</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <input
        className={s.input}
        value={draft.text}
        onChange={(event) => {
          const value = event.target.value;
          patchDraft((prev) => ({ values: current.multiSelect ? prev.values : [], text: value }));
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          goNext();
        }}
        placeholder={options.length > 0 ? "或者直接输入你的想法，回车继续" : "输入你的回答，回车继续"}
        aria-label="回答"
        autoComplete="off"
        disabled={submitting}
      />

      {error ? <div className={s.error}>{error}</div> : null}

      <footer className={s.footer}>
        <Button size="sm" variant="ghost" tone="danger" disabled={submitting} onClick={onSkip}>
          跳过这轮
        </Button>
        <span className={s.spacer} />
        <Button size="sm" variant="ghost" disabled={submitting || safeIndex === 0} onClick={goPrev}>
          <ChevronLeft size={12} aria-hidden="true" />
          上一题
        </Button>
        <Button size="sm" variant="solid" disabled={submitting} onClick={goNext}>
          {isLast ? "确认并继续" : "下一题"}
          <ChevronRight size={12} aria-hidden="true" />
        </Button>
      </footer>
    </section>
  );
}

export interface ApprovalInlineStackProps {
  prompts: PendingPrompt[];
  busyId?: string | null;
  error?: string | null;
  onAnswer: (prompt: PendingPrompt, choice: ApprovalChoice) => void;
}

const SWIPE_THRESHOLD = 60;

export function ApprovalInlineStack({
  prompts,
  busyId = null,
  error,
  onAnswer,
}: ApprovalInlineStackProps) {
  const [confirmAlways, setConfirmAlways] = useState(false);
  const [dragX, setDragX] = useState(0);
  const startX = useRef<number | null>(null);
  const top = prompts[0];

  useEffect(() => {
    setConfirmAlways(false);
    setDragX(0);
    startX.current = null;
  }, [top?.promptId]);

  if (!top) return null;

  const choices = approvalChoices(top);
  const busy = busyId === top.promptId;

  const answer = (choice: ApprovalChoice) => {
    if (busy) return;
    if (choice === "always" && !confirmAlways) {
      setConfirmAlways(true);
      return;
    }
    setConfirmAlways(false);
    onAnswer(top, choice);
  };

  return (
    <div className={s.stack} data-testid="approval-inline-stack" aria-label="需要确认执行">
      {prompts
        .slice(1)
        .map((prompt, depth) => (
          <div
            key={prompt.promptId}
            className={s.stackEdge}
            data-depth={Math.min(depth + 1, 3)}
            aria-hidden="true"
          />
        ))
        .reverse()}
      <section
        className={s.card}
        data-testid="approval-inline-card"
        data-kind="approval"
        aria-label="需要确认执行"
        style={dragX ? { transform: `translateX(${dragX}px)` } : undefined}
        onPointerDown={(event) => {
          startX.current = event.clientX;
        }}
        onPointerMove={(event) => {
          if (startX.current === null) return;
          setDragX(event.clientX - startX.current);
        }}
        onPointerUp={() => {
          const delta = dragX;
          startX.current = null;
          setDragX(0);
          if (delta <= -SWIPE_THRESHOLD) answer("deny");
          else if (delta >= SWIPE_THRESHOLD) answer("once");
        }}
        onPointerCancel={() => {
          startX.current = null;
          setDragX(0);
        }}
      >
        <header className={s.header}>
          <span className={s.headIcon} data-kind="approval">
            <ShieldAlert size={13} aria-hidden="true" />
          </span>
          <span className={s.title}>需要确认执行</span>
          <span className={s.spacer} />
          <span className={s.counter} data-testid="approval-inline-counter">
            1 / {prompts.length}
          </span>
        </header>

        {top.command ? <pre className={s.command}>{top.command}</pre> : null}
        {top.description ? <p className={s.description}>{top.description}</p> : null}

        {confirmAlways ? (
          <div className={s.confirmNotice} data-testid="approval-always-confirm">
            再点一次确认：这条会加入 allowlist，写入 ~/.hermes/config.yaml
          </div>
        ) : null}

        {error ? <div className={s.error}>{error}</div> : null}

        <footer className={s.footer}>
          {choices.map(({ choice, label }) => (
            <Button
              key={choice}
              size="sm"
              variant={choice === "deny" ? "ghost" : choice === "always" && confirmAlways ? "solid" : "outline"}
              tone={choice === "deny" ? "danger" : "neutral"}
              disabled={busy}
              onClick={() => answer(choice)}
            >
              {choice === "always" && confirmAlways ? "确认始终允许" : label}
            </Button>
          ))}
        </footer>
        <div className={s.hint}>左右滑动也可处理：左滑拒绝、右滑允许一次</div>
      </section>
    </div>
  );
}

export function ClarifyQaCard({ entries }: { entries: ClarifyQaEntry[] }) {
  return (
    <section className={s.qaCard} data-testid="clarify-qa-card" aria-label="已回答的问题">
      <header className={s.header}>
        <span className={s.headIcon} data-kind="clarify">
          <Check size={13} aria-hidden="true" />
        </span>
        <span className={s.title}>已回答</span>
        <span className={s.spacer} />
        <span className={s.counter}>{entries.length} 题</span>
      </header>
      <div className={s.qaList}>
        {entries.map((entry, index) => (
          <div className={s.qaRow} key={`${index}-${entry.question}`}>
            <p className={s.qaQuestion}>{entry.question}</p>
            <p
              className={s.qaAnswer}
              data-skipped={entry.answer === null || entry.answer.trim() === "" ? "true" : undefined}
            >
              {displayClarifyAnswer(entry.answer)}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
