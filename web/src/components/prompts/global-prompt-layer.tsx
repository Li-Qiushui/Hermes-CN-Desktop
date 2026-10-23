import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Clock3, Inbox, ListChecks, MessageCircleQuestion, ShieldAlert } from "lucide-react";
import type { SessionsResponse } from "@hermes/protocol";
import { Button } from "@hermes/shared-ui";
import { getGatewayClient } from "@/lib/gateway-client";
import { useFeatureStatus } from "@/lib/gateway-capabilities";
import {
  approvalChoices,
  buildApprovalRespondParams,
  buildClarifyRespondParams,
  clarifyAnswer,
} from "@/lib/prompt-contract";
import {
  answerApproval,
  answerServerPrompt,
  answerSetupChoose,
  answerSetupSaid,
  cancelServerBatch,
  dismissServerPrompt,
  serverClarifyAnswer,
  serverPromptsAtom,
  skipServerPrompt,
} from "@/lib/server-request-bridge";
import { resolvePersistentSessionId } from "@/lib/session-map";
import {
  gwSessionIdAtom,
  pendingPromptsAtom,
  removePromptAtom,
  type PendingPrompt,
} from "@/stores/chat";
import { activeSessionIdAtom } from "@/stores/ui";
import { inlinePromptClaimsAtom } from "@/stores/inline-prompts";
import s from "./global-prompt-layer.module.css";

const EXPIRY_NOTICE_MS = 6_000;
const SEND_FAILED_NOTICE = "发送失败，正在重连，可重试";

function shortId(id: string): string {
  return id.length > 8 ? id.slice(-6) : id;
}

function formatRemaining(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function labelForSession(
  queryClient: ReturnType<typeof useQueryClient>,
  persistentId: string,
): string {
  try {
    for (const [, data] of queryClient.getQueriesData<SessionsResponse>({ queryKey: ["sessions"] })) {
      const match = data?.sessions.find((item) => item.id === persistentId);
      if (match?.title) return match.title;
    }
  } catch {
    // 标题只是辅助信息，查不到就退回短 id。
  }
  return shortId(persistentId);
}

interface PromptCardProps {
  prompt: PendingPrompt;
  index: number;
  total: number;
  onResolved: (promptId: string) => void;
  onExpired: (promptId: string) => void;
}

function ApprovalBody({ prompt }: { prompt: PendingPrompt }) {
  return (
    <>
      {prompt.command ? <pre className={s.command}>{prompt.command}</pre> : null}
      {prompt.description ? <p className={s.description}>{prompt.description}</p> : null}
    </>
  );
}

function PromptCard({ prompt, index, total, onResolved, onExpired }: PromptCardProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());
  const expiredRef = useRef<string | null>(null);

  const persistentId = resolvePersistentSessionId(prompt.sessionId) ?? prompt.sessionId;
  const label = labelForSession(queryClient, persistentId);

  useEffect(() => {
    setSubmitting(false);
    setError(null);
    setSelected(prompt.preselected ?? []);
    setText("");
    setFieldValues({});
    expiredRef.current = null;
  }, [prompt.promptId, prompt.preselected]);

  useEffect(() => {
    if (!prompt.timeoutS) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [prompt.promptId, prompt.timeoutS]);

  const remaining = prompt.timeoutS
    ? Math.max(0, (prompt.receivedAt + prompt.timeoutS * 1000 - now) / 1000)
    : null;

  useEffect(() => {
    if (remaining === null || remaining > 0) return;
    if (expiredRef.current === prompt.promptId) return;
    expiredRef.current = prompt.promptId;
    onExpired(prompt.promptId);
  }, [remaining, prompt.promptId, onExpired]);

  const finishServer = useCallback(
    (submit: () => boolean | "pending" | void) => {
      const outcome = submit();
      if (outcome === false) {
        setError(SEND_FAILED_NOTICE);
        return;
      }
      setError(null);
      if (outcome === "pending") return;
      onResolved(prompt.promptId);
    },
    [onResolved, prompt.promptId],
  );

  const sendEvent = useCallback(
    async (value: string) => {
      let params: Record<string, unknown>;
      try {
        params =
          prompt.kind === "approval"
            ? { ...buildApprovalRespondParams({ sessionId: prompt.sessionId, prompt, choice: value }) }
            : { ...buildClarifyRespondParams({ sessionId: prompt.sessionId, prompt, answer: value }) };
      } catch (err) {
        setError(`提交失败：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        await getGatewayClient().request(
          prompt.kind === "approval" ? "approval.respond" : "clarify.respond",
          params,
          { timeoutMs: 30_000 },
        );
        onResolved(prompt.promptId);
      } catch (err) {
        setError(`提交失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setSubmitting(false);
      }
    },
    [onResolved, prompt],
  );

  const submitAnswer = (selected: string[]) => {
    if (prompt.transport === "server-request") {
      finishServer(() =>
        answerServerPrompt(
          prompt,
          serverClarifyAnswer(selected, prompt.multiSelect),
          (sent) => {
            if (!sent) setError(SEND_FAILED_NOTICE);
          },
        ),
      );
      return;
    }
    void sendEvent(clarifyAnswer(selected, prompt.multiSelect));
  };

  const toggleSelected = (choice: string) => {
    setSelected((prev) =>
      prev.includes(choice) ? prev.filter((item) => item !== choice) : [...prev, choice],
    );
  };

  const isApproval = prompt.kind === "approval";
  const isValue = prompt.kind === "value";
  const isSetup = prompt.kind === "setup";
  const fields = prompt.fields ?? [];
  const usesFields = isValue && fields.length > 0;
  const options = prompt.options ?? [];
  const fieldsFilled = fields.every((field) => (fieldValues[field.key] ?? "").trim().length > 0);
  const title = isApproval ? "需要确认执行" : isSetup ? "需要你选一个" : "需要你回答";
  const clarifyStatus = useFeatureStatus("prompt.clarify");
  const clarifyAnswerUnavailable = clarifyStatus === "unavailable";
  const eventAnswerOnly = !isApproval && prompt.transport !== "server-request";
  const body = isApproval ? (
    <ApprovalBody prompt={prompt} />
  ) : (
    <>
      <p className={s.question}>{prompt.question}</p>
      {isValue && prompt.detail ? <p className={s.description}>{prompt.detail}</p> : null}
      {isValue && prompt.description ? (
        <p className={s.description}>{prompt.description}</p>
      ) : null}
    </>
  );

  const submitFields = () => {
    if (!fieldsFilled) return;
    const payload: Record<string, string> = {};
    for (const field of fields) {
      const raw = fieldValues[field.key] ?? "";
      payload[field.key] = field.secret ? raw : raw.trim();
    }
    finishServer(() => answerServerPrompt(prompt, JSON.stringify(payload)));
  };

  const decline = () => finishServer(() => skipServerPrompt(prompt));

  const answerApprovalChoice = (choice: string) => {
    if (prompt.transport === "server-request") {
      finishServer(() => answerServerPrompt(prompt, choice));
      return;
    }
    void sendEvent(choice);
  };

  return (
    <section
      className={s.card}
      role="dialog"
      aria-label={title}
      data-kind={prompt.kind}
    >
      <header className={s.header}>
        <span className={s.headIcon} data-kind={prompt.kind}>
          {isApproval ? (
            <ShieldAlert size={14} aria-hidden="true" />
          ) : isSetup ? (
            <ListChecks size={14} aria-hidden="true" />
          ) : (
            <MessageCircleQuestion size={14} aria-hidden="true" />
          )}
        </span>
        <span className={s.title}>{title}</span>
        <span className={s.spacer} />
        {remaining !== null ? (
          <span className={s.timer} data-low={remaining <= 30 ? "true" : undefined}>
            <Clock3 size={12} aria-hidden="true" />
            {formatRemaining(remaining)}
          </span>
        ) : null}
        <span className={s.counter}>
          第 {index} / 共 {total} 条
        </span>
      </header>

      <div className={s.sessionRow}>
        <span className={s.sessionLabel} title={persistentId}>
          {label}
        </span>
        <button
          type="button"
          className={s.sessionLink}
          onClick={() => navigate(`/tasks/${encodeURIComponent(persistentId)}`)}
        >
          打开会话
          <ArrowUpRight size={12} aria-hidden="true" />
        </button>
      </div>

      <div className={s.body}>{body}</div>

      {error ? <div className={s.error}>{error}</div> : null}

      {clarifyAnswerUnavailable && eventAnswerOnly ? (
        <p className={s.error}>
          当前内核不支持该功能（clarify.respond），这条提问请在终端回答
        </p>
      ) : isApproval ? (
        <div className={s.actions}>
          {approvalChoices(prompt).map(({ choice, label: choiceLabel }) => (
            <Button
              key={choice}
              size="sm"
              variant={choice === "deny" ? "ghost" : "outline"}
              tone={choice === "deny" ? "danger" : "neutral"}
              disabled={submitting}
              onClick={() => answerApprovalChoice(choice)}
            >
              {choiceLabel}
            </Button>
          ))}
          {prompt.transport === "server-request" && prompt.choices.includes("always") ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={submitting}
              onClick={() => finishServer(() => answerApproval(prompt, "always", true))}
            >
              全部允许
            </Button>
          ) : null}
        </div>
      ) : isSetup ? (
        <>
          {options.length > 0 ? (
            <div className={s.actions}>
              {options.map((option) => (
                <Button
                  key={option.id}
                  size="sm"
                  variant={prompt.multiSelect && selected.includes(option.id) ? "solid" : "outline"}
                  disabled={submitting}
                  aria-pressed={prompt.multiSelect ? selected.includes(option.id) : undefined}
                  title={option.detail}
                  onClick={() =>
                    prompt.multiSelect
                      ? toggleSelected(option.id)
                      : finishServer(() => answerSetupChoose(prompt, option.id))
                  }
                >
                  {option.label}
                </Button>
              ))}
              {prompt.multiSelect ? (
                <Button
                  size="sm"
                  variant="solid"
                  disabled={submitting || selected.length === 0}
                  onClick={() => finishServer(() => answerSetupChoose(prompt, selected))}
                >
                  确认
                </Button>
              ) : null}
            </div>
          ) : null}
          <form
            className={s.answerForm}
            onSubmit={(event) => {
              event.preventDefault();
              if (!text.trim()) return;
              finishServer(() => answerSetupSaid(prompt, text));
            }}
          >
            <input
              className={s.input}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="或直接输入你的想法，回车发送"
              aria-label="回答"
              autoComplete="off"
              disabled={submitting}
            />
            <Button type="submit" size="sm" variant="solid" disabled={submitting || !text.trim()}>
              发送
            </Button>
          </form>
        </>
      ) : prompt.choices.length > 0 ? (
        <div className={s.actions}>
          {prompt.choices.map((choice) => (
            <Button
              key={choice}
              size="sm"
              variant={prompt.multiSelect && selected.includes(choice) ? "solid" : "outline"}
              disabled={submitting}
              aria-pressed={prompt.multiSelect ? selected.includes(choice) : undefined}
              onClick={() => (prompt.multiSelect ? toggleSelected(choice) : submitAnswer([choice]))}
            >
              {choice}
            </Button>
          ))}
          {prompt.multiSelect ? (
            <Button
              size="sm"
              variant="solid"
              disabled={submitting || selected.length === 0}
              onClick={() => submitAnswer(selected)}
            >
              确认
            </Button>
          ) : null}
        </div>
      ) : usesFields ? (
        <form
          className={s.fields}
          onSubmit={(event) => {
            event.preventDefault();
            submitFields();
          }}
        >
          {fields.map((field) => (
            <label key={field.key} className={s.fieldRow}>
              <span className={s.fieldLabel}>{field.label}</span>
              <input
                className={s.fieldInput}
                type={field.secret ? "password" : "text"}
                value={fieldValues[field.key] ?? ""}
                onChange={(event) =>
                  setFieldValues((prev) => ({ ...prev, [field.key]: event.target.value }))
                }
                aria-label={field.label}
                autoComplete="off"
                disabled={submitting}
              />
            </label>
          ))}
          <div className={s.actions}>
            <Button type="submit" size="sm" variant="solid" disabled={submitting || !fieldsFilled}>
              保存
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={submitting} onClick={decline}>
              跳过
            </Button>
          </div>
        </form>
      ) : (
        <form
          className={s.answerForm}
          onSubmit={(event) => {
            event.preventDefault();
            if (!text.trim()) return;
            submitAnswer([text]);
          }}
        >
          <input
            className={s.input}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={prompt.secret ? "输入后回车提交" : "输入你的回答，回车提交"}
            aria-label="回答"
            type={prompt.secret ? "password" : "text"}
            autoComplete="off"
            disabled={submitting}
          />
          <Button
            type="submit"
            size="sm"
            variant="solid"
            disabled={submitting || !text.trim()}
          >
            提交
          </Button>
          {isValue ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={submitting}
              onClick={decline}
            >
              跳过
            </Button>
          ) : null}
        </form>
      )}

      {!isApproval && prompt.serverRequestId ? (
        <div className={s.actions}>
          <Button
            size="sm"
            variant="ghost"
            disabled={submitting}
            onClick={decline}
          >
            跳过这条
          </Button>
          {prompt.kind === "clarify" ? (
            <Button
              size="sm"
              variant="ghost"
              tone="danger"
              disabled={submitting}
              onClick={() =>
                finishServer(() => cancelServerBatch(prompt.serverRequestId!, "用户中止本轮提问"))
              }
            >
              中止本轮
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function GlobalPromptLayer() {
  const eventPrompts = useAtomValue(pendingPromptsAtom);
  const serverPrompts = useAtomValue(serverPromptsAtom);
  const removePrompt = useSetAtom(removePromptAtom);
  const activeSessionId = useAtomValue(activeSessionIdAtom);
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);
  const inlineClaimed = useAtomValue(inlinePromptClaimsAtom);
  const gwSessionId = useAtomValue(gwSessionIdAtom);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const baseline = useRef(0);

  const prompts = useMemo(() => {
    const claimed = new Set(inlineClaimed);
    return [...eventPrompts, ...serverPrompts]
      .filter((prompt) => !claimed.has(prompt.promptId))
      .sort((a, b) => a.receivedAt - b.receivedAt);
  }, [eventPrompts, serverPrompts, inlineClaimed]);

  if (prompts.length > baseline.current) baseline.current = prompts.length;
  if (prompts.length === 0) baseline.current = 0;
  const position = baseline.current - prompts.length + 1;

  const activePersistentId = useMemo(
    () => (activeSessionId ? resolvePersistentSessionId(activeSessionId) ?? activeSessionId : ""),
    [activeSessionId],
  );

  const isCurrentPrompt = useCallback(
    (candidate: PendingPrompt) => {
      if (!activePersistentId || !candidate.sessionId) return true;
      const persistent =
        resolvePersistentSessionId(candidate.sessionId) ?? candidate.sessionId;
      if (persistent === activePersistentId) return true;
      return Boolean(gwSessionId) && candidate.sessionId === gwSessionId;
    },
    [activePersistentId, gwSessionId],
  );

  const backgroundSessions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of prompts) {
      if (isCurrentPrompt(item)) continue;
      const id = resolvePersistentSessionId(item.sessionId) ?? item.sessionId;
      if (!id || seen.has(id)) continue;
      seen.set(id, labelForSession(queryClient, id));
    }
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }, [prompts, isCurrentPrompt, queryClient]);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), EXPIRY_NOTICE_MS);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  const focusSession = useCallback(
    (persistentId: string) => {
      setActiveSessionId(persistentId);
      navigate(`/tasks/${encodeURIComponent(persistentId)}`);
    },
    [navigate, setActiveSessionId],
  );

  const prompt = prompts.find(isCurrentPrompt) ?? null;

  const onResolved = useCallback(
    (promptId: string) => {
      if (!prompt) return;
      if (prompt.transport === "server-request") {
        dismissServerPrompt(prompt);
        return;
      }
      removePrompt({ sessionId: prompt.sessionId, promptId });
    },
    [prompt, removePrompt],
  );

  const onExpired = useCallback(
    (promptId: string) => {
      if (!prompt) return;
      if (prompt.transport === "server-request") {
        // 卡片超时也要把结果告诉内核，否则这一轮会永远停在原地。clarify 走「中止整批」，
        // 值卡/setup 卡走各自的「跳过」形状（内核按结果类型校验，发错形状等于没答）。
        if (prompt.kind === "clarify" && prompt.serverRequestId) {
          cancelServerBatch(prompt.serverRequestId, "卡片超时未作答");
        } else {
          skipServerPrompt(prompt);
        }
      } else {
        removePrompt({ sessionId: prompt.sessionId, promptId });
      }
      showNotice("已超时");
    },
    [prompt, removePrompt, showNotice],
  );

  const backlog =
    backgroundSessions.length > 0 ? (
      <div className={s.backlog}>
        <Inbox size={14} aria-hidden="true" className={s.backlogIcon} />
        <button
          type="button"
          className={s.backlogButton}
          title={backgroundSessions.map((item) => item.label).join("、")}
          onClick={() => focusSession(backgroundSessions[0].id)}
        >
          {backgroundSessions.length} 个会话待处理
        </button>
      </div>
    ) : null;

  if (!prompt && !notice && !backlog) return null;

  return (
    <div className={s.layer} aria-live="polite">
      {notice ? <div className={s.notice}>{notice}</div> : null}
      {prompt ? (
        <PromptCard
          key={prompt.promptId}
          prompt={prompt}
          index={position}
          total={baseline.current}
          onResolved={onResolved}
          onExpired={onExpired}
        />
      ) : null}
      {backlog}
    </div>
  );
}
