import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { getGatewayClient } from "@/lib/gateway-client";
import { buildApprovalRespondParams } from "@/lib/prompt-contract";
import type { ApprovalChoice } from "@/lib/prompt-contract";
import {
  answerServerPrompt,
  serverPromptsAtom,
  submitClarifyBatchAnswers,
} from "@/lib/server-request-bridge";
import {
  buildQaEntries,
  findRunningToolId,
  groupClarifyBatches,
  latestQaRecord,
  promptBelongsToSessions,
} from "@/lib/inline-prompts";
import { gwSessionIdAtom, pendingPromptsAtom, type PendingPrompt } from "@/stores/chat";
import { clarifyQaLogAtom, inlinePromptClaimsAtom, recordClarifyQaAtom } from "@/stores/inline-prompts";
import type { ChatMessage } from "./chat-types";
import { ApprovalInlineStack, ClarifyInlineCard, ClarifyQaCard } from "./inline-prompt-card";

const SEND_FAILED_NOTICE = "发送失败，正在重连，可重试";

export interface InlinePromptAnchor {
  toolId: string;
  node: ReactNode;
}

const InlinePromptAnchorContext = createContext<InlinePromptAnchor | null>(null);

export function useInlinePromptAnchor(): InlinePromptAnchor | null {
  return useContext(InlinePromptAnchorContext);
}

export interface InlinePromptFlowProps {
  messages: ChatMessage[];
  sessionIds: (string | null | undefined)[];
  children: (trailing: ReactNode) => ReactNode;
}

export function InlinePromptFlow({ messages, sessionIds, children }: InlinePromptFlowProps) {
  const eventPrompts = useAtomValue(pendingPromptsAtom);
  const serverPrompts = useAtomValue(serverPromptsAtom);
  const gwSessionId = useAtomValue(gwSessionIdAtom);
  const qaLog = useAtomValue(clarifyQaLogAtom);
  const setClaims = useSetAtom(inlinePromptClaimsAtom);
  const recordQa = useSetAtom(recordClarifyQaAtom);

  const [clarifySubmitting, setClarifySubmitting] = useState(false);
  const [clarifyError, setClarifyError] = useState<string | null>(null);
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const sessionKey = [...sessionIds, gwSessionId].filter(Boolean).join("\u0001");
  const wantedIds = useMemo(() => (sessionKey ? sessionKey.split("\u0001") : []), [sessionKey]);

  const prompts = useMemo(
    () =>
      [...eventPrompts, ...serverPrompts]
        .filter((prompt) => promptBelongsToSessions(prompt, wantedIds))
        .sort((a, b) => a.receivedAt - b.receivedAt),
    [eventPrompts, serverPrompts, wantedIds],
  );

  const batch = useMemo(() => groupClarifyBatches(prompts)[0] ?? null, [prompts]);
  const approvals = useMemo(
    () => prompts.filter((prompt) => prompt.kind === "approval"),
    [prompts],
  );
  const anchorToolId = useMemo(
    () => (batch ? findRunningToolId(messages) : null),
    [batch, messages],
  );
  const qaRecord = useMemo(
    () => (batch ? null : latestQaRecord(qaLog, wantedIds, messages)),
    [batch, messages, qaLog, wantedIds],
  );

  const claimIds = useMemo(() => {
    const ids: string[] = [];
    if (batch && anchorToolId) ids.push(...batch.prompts.map((prompt) => prompt.promptId));
    ids.push(...approvals.map((prompt) => prompt.promptId));
    return ids;
  }, [anchorToolId, approvals, batch]);

  useEffect(() => {
    setClaims(claimIds);
    return () => setClaims([]);
  }, [claimIds, setClaims]);

  const submitClarify = useCallback(
    async (answers: Record<string, string | null>) => {
      if (!batch || !anchorToolId || clarifySubmitting) return;
      const promptsOfBatch = batch.prompts;
      setClarifySubmitting(true);
      setClarifyError(null);
      const sent = await submitClarifyBatchAnswers(promptsOfBatch, answers);
      setClarifySubmitting(false);
      if (!sent) {
        setClarifyError(SEND_FAILED_NOTICE);
        return;
      }
      recordQa({
        requestId: batch.requestId,
        sessionId: promptsOfBatch[0]?.sessionId ?? "",
        toolId: anchorToolId,
        entries: buildQaEntries(promptsOfBatch, answers),
        at: Date.now(),
      });
    },
    [anchorToolId, batch, clarifySubmitting, recordQa],
  );

  const skipClarify = useCallback(() => {
    if (!batch) return;
    const answers: Record<string, string | null> = {};
    for (const prompt of batch.prompts) answers[prompt.questionId ?? prompt.promptId] = null;
    void submitClarify(answers);
  }, [batch, submitClarify]);

  const answerApprovalPrompt = useCallback(
    async (prompt: PendingPrompt, choice: ApprovalChoice) => {
      if (approvalBusyId) return;
      setApprovalBusyId(prompt.promptId);
      setApprovalError(null);
      try {
        if (prompt.transport === "server-request") {
          const sent = answerServerPrompt(prompt, choice);
          if (sent === false) setApprovalError(SEND_FAILED_NOTICE);
          return;
        }
        await getGatewayClient().request("approval.respond", {
          ...buildApprovalRespondParams({ sessionId: prompt.sessionId, prompt, choice }),
        });
      } catch (err) {
        setApprovalError(`提交失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setApprovalBusyId(null);
      }
    },
    [approvalBusyId],
  );

  const anchor = useMemo<InlinePromptAnchor | null>(() => {
    if (batch && anchorToolId) {
      return {
        toolId: anchorToolId,
        node: (
          <ClarifyInlineCard
            key={batch.requestId}
            prompts={batch.prompts}
            submitting={clarifySubmitting}
            error={clarifyError}
            onSubmit={(answers) => {
              void submitClarify(answers);
            }}
            onSkip={skipClarify}
          />
        ),
      };
    }
    if (qaRecord) {
      return {
        toolId: qaRecord.toolId,
        node: <ClarifyQaCard key={qaRecord.requestId} entries={qaRecord.entries} />,
      };
    }
    return null;
  }, [anchorToolId, batch, clarifyError, clarifySubmitting, qaRecord, skipClarify, submitClarify]);

  const trailing =
    approvals.length > 0 ? (
      <ApprovalInlineStack
        prompts={approvals}
        busyId={approvalBusyId}
        error={approvalError}
        onAnswer={(prompt, choice) => {
          void answerApprovalPrompt(prompt, choice);
        }}
      />
    ) : null;

  return (
    <InlinePromptAnchorContext.Provider value={anchor}>{children(trailing)}</InlinePromptAnchorContext.Provider>
  );
}
