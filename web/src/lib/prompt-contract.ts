// `value` 是单值输入卡（sudo / secret / vault 提示），只从 server-request 通道来：
// 应答形状是 `{value}` 而不是 `{choice}` / `{answers}`。
export type PromptKind = "approval" | "clarify" | "value";

export type ApprovalChoice = "once" | "session" | "always" | "deny";

const APPROVAL_CHOICES: readonly ApprovalChoice[] = ["once", "session", "always", "deny"];

export const APPROVAL_CHOICE_LABELS: Record<ApprovalChoice, string> = {
  once: "允许一次",
  session: "本会话内允许",
  always: "总是允许",
  deny: "拒绝",
};

export const MAX_CLARIFY_ANSWER_CHARS = 16384;

export interface Prompt {
  kind: PromptKind;
  promptId: string;
  generation: number;
  command?: string;
  description?: string;
  question?: string;
  choices: string[];
  multiSelect: boolean;
  timeoutS?: number;
}

export interface ApprovalChoiceButton {
  choice: ApprovalChoice;
  label: string;
}

function asRecord(payload: unknown): Record<string, unknown> | null {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isApprovalChoice(value: string): value is ApprovalChoice {
  return (APPROVAL_CHOICES as readonly string[]).includes(value);
}

export function parsePromptEvent(kind: string, payload: unknown): Prompt | null {
  if (kind !== "approval" && kind !== "clarify") return null;
  const record = asRecord(payload);
  if (!record) return null;
  const promptId = record.prompt_id;
  if (typeof promptId !== "string" || promptId.trim().length === 0) return null;
  const generation = record.execution_generation;
  if (typeof generation !== "number" || !Number.isFinite(generation)) return null;
  const timeoutS = record.timeout_s;
  if (timeoutS !== undefined && timeoutS !== null) {
    if (typeof timeoutS !== "number" || !Number.isFinite(timeoutS)) return null;
  }
  const rawChoices = Array.isArray(record.choices) ? record.choices : [];
  const choices = rawChoices.filter((item): item is string => typeof item === "string");

  const base = {
    promptId,
    generation,
    multiSelect: record.multi_select === true,
    timeoutS: typeof timeoutS === "number" ? timeoutS : undefined,
  };

  if (kind === "approval") {
    const command = optionalText(record.command);
    const description = optionalText(record.description);
    if (!command && !description) return null;
    const approvalChoicesGiven = choices.filter(isApprovalChoice);
    if (approvalChoicesGiven.length === 0) return null;
    return {
      ...base,
      kind: "approval",
      command,
      description,
      choices: approvalChoicesGiven,
      multiSelect: false,
    };
  }

  const question = optionalText(record.question);
  if (!question) return null;
  return {
    ...base,
    kind: "clarify",
    question,
    choices: choices.map((item) => item.trim()).filter((item) => item.length > 0),
  };
}

export function approvalChoices(prompt: Pick<Prompt, "choices">): ApprovalChoiceButton[] {
  const allowed = prompt.choices.filter(isApprovalChoice);
  const ordered: ApprovalChoice[] = [];
  for (const choice of allowed) {
    if (choice !== "deny" && !ordered.includes(choice)) ordered.push(choice);
  }
  if (allowed.includes("deny")) ordered.push("deny");
  return ordered.map((choice) => ({ choice, label: APPROVAL_CHOICE_LABELS[choice] }));
}

export function clarifyAnswer(selected: string[], multiSelect: boolean): string {
  const picked = selected.map((item) => item.trim()).filter((item) => item.length > 0);
  if (picked.length === 0) return "";
  if (!multiSelect) return picked[0];
  return picked.join("、");
}

export interface ApprovalRespondParams {
  session_id: string;
  execution_generation: number;
  prompt_id: string;
  choice: ApprovalChoice;
}

export interface ClarifyRespondParams {
  session_id: string;
  execution_generation: number;
  prompt_id: string;
  answer: string | null;
}

export function buildApprovalRespondParams(input: {
  sessionId: string;
  prompt: Pick<Prompt, "generation" | "promptId" | "choices">;
  choice: string;
}): ApprovalRespondParams {
  if (!isApprovalChoice(input.choice) || !input.prompt.choices.includes(input.choice)) {
    throw new Error(`不支持的审批选项：${input.choice}`);
  }
  return {
    session_id: input.sessionId,
    execution_generation: input.prompt.generation,
    prompt_id: input.prompt.promptId,
    choice: input.choice,
  };
}

export function buildClarifyRespondParams(input: {
  sessionId: string;
  prompt: Pick<Prompt, "generation" | "promptId">;
  answer: string | null;
}): ClarifyRespondParams {
  const trimmed = input.answer === null ? "" : input.answer.trim();
  if (trimmed.length > MAX_CLARIFY_ANSWER_CHARS) {
    throw new Error(`回答超出 ${MAX_CLARIFY_ANSWER_CHARS} 字符上限`);
  }
  return {
    session_id: input.sessionId,
    execution_generation: input.prompt.generation,
    prompt_id: input.prompt.promptId,
    answer: trimmed.length === 0 ? null : trimmed,
  };
}
