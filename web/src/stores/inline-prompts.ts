import { atom } from "jotai";
import type { ClarifyQaRecord } from "@/lib/inline-prompts";

const QA_LOG_LIMIT = 40;

/** 正在对话流里内联渲染的 prompt id；浮层据此让位，未认领的请求照旧弹浮层。 */
export const inlinePromptClaimsAtom = atom<string[]>([]);

/** 已作答的 clarify 批次，用于把同一位置换成只读 Q&A（切会话回来还在）。 */
export const clarifyQaLogAtom = atom<ClarifyQaRecord[]>([]);

export const recordClarifyQaAtom = atom(null, (get, set, record: ClarifyQaRecord) => {
  const kept = get(clarifyQaLogAtom).filter((item) => item.requestId !== record.requestId);
  set(clarifyQaLogAtom, [...kept, record].slice(-QA_LOG_LIMIT));
});
