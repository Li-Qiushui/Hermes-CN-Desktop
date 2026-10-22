import { atom, getDefaultStore } from "jotai";
import { getGatewayClient } from "@/lib/gateway-client";
import type { PendingPrompt, PendingPromptOption } from "@/stores/chat";

/**
 * Blocking prompts the kernel delivers as JSON-RPC **server→client requests**
 * (`id: "srq-…"`, `method: "approval" | "clarify"`).
 *
 * A local viewer answers through the response frame carrying the same id —
 * there is no `clarify.respond` / `approval.respond` RPC on that channel.
 * Canonical kernels publish `approval.request` / `clarify.request`
 * notifications instead; those land in the chat store and answer over RPC.
 * Both shapes are supported, this module owns the former.
 */
export const serverPromptsAtom = atom<PendingPrompt[]>([]);

export interface ValueField {
  key: string;
  label: string;
  secret: boolean;
}

interface ValueRequestSpec {
  label: string;
  secret: boolean;
  fields?: ValueField[];
  detail?: (params: Record<string, unknown>) => string | undefined;
}

interface BatchState {
  requestId: string;
  method: "approval" | "clarify" | "value" | "setup";
  questions: { qid: string }[];
  answers: Record<string, string | null>;
  open: boolean;
}

const batches = new Map<string, BatchState>();

function setPrompts(update: (prompts: PendingPrompt[]) => PendingPrompt[]): void {
  const store = getDefaultStore();
  store.set(serverPromptsAtom, update(store.get(serverPromptsAtom)));
}

/** 发结算帧；只有真的发出去才关 batch、收卡片，否则卡片留着可重试。 */
function settleWithFrame(requestId: string, batch: BatchState, result: unknown): boolean {
  if (!getGatewayClient().respondToServerRequest(requestId, result)) return false;
  batch.open = false;
  dropRequest(requestId);
  return true;
}

function dropRequest(requestId: string): void {
  batches.delete(requestId);
  setPrompts((prompts) => prompts.filter((prompt) => prompt.serverRequestId !== requestId));
}

/** 摘掉一条已作答的问题卡片，但保留同批次里还没答的那些。 */
function dropAnsweredPrompt(requestId: string, questionId: string): void {
  setPrompts((prompts) =>
    prompts.filter(
      (prompt) =>
        !(prompt.serverRequestId === requestId && prompt.questionId === questionId),
    ),
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function registerApproval(requestId: string, params: Record<string, unknown>): void {
  const prompt: PendingPrompt = {
    kind: "approval",
    promptId: text(params.request_id) || requestId,
    generation: 0,
    sessionId: text(params.session_id),
    command: text(params.command) || undefined,
    description: text(params.description) || undefined,
    choices: strings(params.choices),
    multiSelect: false,
    receivedAt: Date.now(),
    transport: "server-request",
    serverRequestId: requestId,
  };
  batches.set(requestId, {
    requestId,
    method: "approval",
    questions: [],
    answers: {},
    open: true,
  });
  setPrompts((prompts) => [
    ...prompts.filter((item) => item.serverRequestId !== requestId),
    prompt,
  ]);
  // 卡片上屏后告诉内核「我看到了」——官方的 approval.received，超时时钟从这里起算。
  if (prompt.sessionId) {
    void getGatewayClient()
      .request("approval.received", { session_id: prompt.sessionId, request_id: requestId })
      .catch(() => {});
  }
}

/** 单值输入的请求（sudo / secret / vault 提示）：应答形状是 `{value}`。 */
function registerValue(
  requestId: string,
  params: Record<string, unknown>,
  spec: ValueRequestSpec,
): void {
  const detail = spec.detail?.(params);
  const prompt: PendingPrompt = {
    kind: "value",
    promptId: text(params.request_id) || requestId,
    generation: 0,
    sessionId: text(params.session_id),
    command: text(params.command) || undefined,
    description: text(params.description) || text(params.prompt) || undefined,
    question: spec.label,
    choices: [],
    multiSelect: false,
    receivedAt: Date.now(),
    transport: "server-request",
    serverRequestId: requestId,
    secret: spec.secret,
    ...(detail ? { detail } : {}),
    ...(spec.fields ? { fields: spec.fields.map((field) => ({ ...field })) } : {}),
  };
  batches.set(requestId, {
    requestId,
    method: "value",
    questions: [],
    answers: {},
    open: true,
  });
  setPrompts((prompts) => [
    ...prompts.filter((item) => item.serverRequestId !== requestId),
    prompt,
  ]);
}

/**
 * 「本次全部允许」：审批结果里带 `all: true`，内核据此把同类请求一次性放行。
 * 帧真的发出去（返回 true）才收卡片；false ＝ socket 未就绪，卡片留在原地可重试。
 */
export function answerApproval(prompt: PendingPrompt, choice: string, all: boolean): boolean {
  const requestId = prompt.serverRequestId;
  if (!requestId) return false;
  const batch = batches.get(requestId);
  if (!batch || !batch.open) return false;
  if (!getGatewayClient().respondToServerRequest(requestId, all ? { choice, all: true } : { choice })) {
    return false;
  }
  batch.open = false;
  dropRequest(requestId);
  return true;
}

function registerClarify(requestId: string, params: Record<string, unknown>): void {
  const questions = Array.isArray(params.questions)
    ? (params.questions as Record<string, unknown>[])
    : [];
  // 重连后内核把「已经锁定的答案」一起带回来（open_requests → params.answers），
  // 用来恢复 ✓ 状态；已经答过的问题不再弹第二次。
  const locked =
    params.answers && typeof params.answers === "object"
      ? (params.answers as Record<string, unknown>)
      : {};
  batches.set(requestId, {
    requestId,
    method: "clarify",
    questions: questions.map((question) => ({ qid: text(question.qid) })),
    answers: { ...(locked as Record<string, string | null>) },
    open: true,
  });
  const sessionId = text(params.session_id);
  const receivedAt = Date.now();
  const prompts = questions
    .filter((question) => !(text(question.qid) in locked))
    .map((question, index): PendingPrompt => {
      const qid = text(question.qid);
      return {
        kind: "clarify",
        promptId: `${requestId}:${qid}`,
        generation: 0,
        sessionId,
        question: text(question.question),
        choices: strings(question.choices),
        multiSelect: question.multi_select === true,
        receivedAt: receivedAt + index,
        transport: "server-request",
        serverRequestId: requestId,
        questionId: qid,
      };
    });
  if (prompts.length === 0) {
    // 全部题目早就答完了，内核还在等收尾帧：补一次 closing response。
    // 帧发不出去就先放掉 batch，让内核重投时能重新register并再补一次。
    const closingBatch = batches.get(requestId);
    if (!closingBatch) return;
    const sent = settleWithFrame(requestId, closingBatch, {
      answers: { ...(locked as Record<string, string>) },
      outcome: "submitted",
    });
    if (!sent) batches.delete(requestId);
    return;
  }
  setPrompts((current) => [
    ...current.filter((item) => item.serverRequestId !== requestId),
    ...prompts,
  ]);
}

/**
 * Multi-select answers travel as a JSON array string: the clarify tool's own
 * `_clean_answer` parses that back into a real list, while a joined string
 * would reach the model as a single item.
 */
export function serverClarifyAnswer(selected: string[], multiSelect: boolean): string {
  const picked = selected.map((item) => item.trim()).filter(Boolean);
  if (picked.length === 0) return "";
  if (!multiSelect) return picked[0];
  return JSON.stringify(picked);
}

/** Abandon a whole prompt batch.
 *
 * A batch only settles in the kernel once *every* question has an answer, so a
 * card the user cannot or will not finish would park the turn forever. The
 * frame must **not** carry `answers`: the kernel forces `outcome: "submitted"`
 * whenever answers are present, which turned "abort this turn" into a partial
 * submission. Without them the kernel keeps the already-locked answers and
 * settles the wait as `cancelled`.
 */
export function cancelServerBatch(requestId: string, notice?: string): boolean {
  const batch = batches.get(requestId);
  if (!batch) return false;
  if (batch.open) {
    if (!getGatewayClient().respondToServerRequest(requestId, notice ? { notice } : {})) return false;
    batch.open = false;
  }
  dropRequest(requestId);
  return true;
}

function isMissingLockMethod(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /method not found|-32601/i.test(message);
}

/** 一条答案落锁：成功就把这张卡从队列里摘掉（内核记住了），`remaining` 空即整批结算。
 *  返回 false ＝ 锁帧没送到内核（socket 未就绪），卡片必须留在原地可重试。
 */
async function lockClarifyAnswer(
  prompt: PendingPrompt,
  questionId: string,
  value: string | null,
  batch: BatchState,
): Promise<boolean> {
  const requestId = prompt.serverRequestId;
  if (!requestId) return false;
  try {
    const result = await getGatewayClient().request<{
      status?: string;
      remaining?: string[] | null;
    }>("clarify.lock", { request_id: requestId, question_id: questionId, answer: value });
    const status = result?.status ?? "ok";
    dropAnsweredPrompt(requestId, questionId);
    if (status !== "ok") {
      // expired：这一问已经结束（超时/取消），把残留卡片一起收掉。
      dropRequest(requestId);
      return true;
    }
    const remaining = Array.isArray(result?.remaining) ? result.remaining : [];
    if (remaining.length === 0) dropRequest(requestId);
    return true;
  } catch (error) {
    if (!isMissingLockMethod(error)) return false;
    // 内核太旧、没有 clarify.lock：退回本地累积，全部答完再发一次 closing response。
    batch.answers[questionId] = value;
    if (batch.questions.every((question) => question.qid in batch.answers)) {
      // 发不出去就保持 batch 打开：下一次应答会把同一批 answers 再补一次。
      if (
        !getGatewayClient().respondToServerRequest(requestId, {
          answers: { ...batch.answers },
          outcome: "submitted",
        })
      ) {
        return false;
      }
      batch.open = false;
      dropRequest(requestId);
      return true;
    }
    dropAnsweredPrompt(requestId, questionId);
    return true;
  }
}

/**
 * Answer a pending server-request prompt; the response frame goes out here.
 * 返回 false ＝ 应答帧没发出去（socket 未 OPEN），调用方必须保留卡片让用户重试；
 * 返回 "pending" ＝ clarify 锁帧异步在飞，结果由 onSettled 回调告知，移除卡片由落锁成功后负责。
 */
export function answerServerPrompt(
  prompt: PendingPrompt,
  value: string | null,
  onSettled?: (sent: boolean) => void,
): boolean | "pending" {
  const requestId = prompt.serverRequestId;
  if (!requestId) return false;
  const batch = batches.get(requestId);
  if (!batch || !batch.open) return false;

  if (batch.method === "approval") {
    if (value === null) return false;
    return settleWithFrame(requestId, batch, { choice: value });
  }

  // 单值输入（sudo 口令 / secret / vault 提示）：内核要 `{value}`，空串＝跳过。
  if (batch.method === "value") {
    return settleWithFrame(requestId, batch, { value: value ?? "" });
  }

  if (batch.method === "setup") {
    return answerSetupChoose(prompt, value === null ? null : value);
  }

  // 批量问答按官方协议「答一题锁一题」（clarify.lock）。锁存在内核侧，答题进度
  // 不会因为重连/刷新丢掉，最后一条锁定即结算整批。
  if (prompt.questionId) {
    void lockClarifyAnswer(prompt, prompt.questionId, value, batch).then((sent) => {
      onSettled?.(sent);
    });
    return "pending";
  }

  batch.answers[prompt.questionId ?? ""] = value;
  if (batch.questions.every((question) => question.qid in batch.answers)) {
    return settleWithFrame(requestId, batch, {
      answers: { ...batch.answers },
      outcome: "submitted",
    });
  }
  setPrompts((prompts) =>
    prompts.filter(
      (item) => !(item.serverRequestId === requestId && item.questionId === prompt.questionId),
    ),
  );
  return true;
}

/** setup_choose 的选项行：内核给 `{id, label, detail?}`，字符串按 label=id 兜底。 */
function setupOptions(raw: unknown): PendingPromptOption[] {
  if (!Array.isArray(raw)) return [];
  const options: PendingPromptOption[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item === "string") {
      const label = item.trim();
      if (!label || seen.has(label)) continue;
      seen.add(label);
      options.push({ id: label, label });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const label = text(record.label).trim();
    const id = text(record.id).trim() || label;
    if (!label || !id || seen.has(id)) continue;
    seen.add(id);
    const detail = text(record.detail).trim();
    options.push(detail ? { id, label, detail } : { id, label });
  }
  return options;
}

function registerSetup(requestId: string, params: Record<string, unknown>): void {
  const options = setupOptions(params.options);
  const preselected = strings(params.preselected);
  const prompt: PendingPrompt = {
    kind: "setup",
    promptId: text(params.request_id) || requestId,
    generation: 0,
    sessionId: text(params.session_id),
    question: text(params.question),
    choices: [],
    multiSelect: params.multi_select === true,
    receivedAt: Date.now(),
    transport: "server-request",
    serverRequestId: requestId,
    setupKind: text(params.kind) || "question",
    ...(options.length > 0 ? { options } : {}),
    ...(preselected.length > 0 ? { preselected } : {}),
  };
  batches.set(requestId, {
    requestId,
    method: "setup",
    questions: [],
    answers: {},
    open: true,
  });
  setPrompts((prompts) => [
    ...prompts.filter((item) => item.serverRequestId !== requestId),
    prompt,
  ]);
}

/** 选一行：单选发 id，多选发 id 数组；`null` 是「关闭这张卡」。 */
export function answerSetupChoose(prompt: PendingPrompt, picked: string | string[] | null): boolean {
  const requestId = prompt.serverRequestId;
  if (!requestId) return false;
  const batch = batches.get(requestId);
  if (!batch || !batch.open) return false;
  return settleWithFrame(requestId, batch, { picked });
}

/** 自由输入：内核只认 `said`（typed），不会被当成一次选择。 */
export function answerSetupSaid(prompt: PendingPrompt, said: string): boolean {
  const requestId = prompt.serverRequestId;
  if (!requestId) return false;
  const batch = batches.get(requestId);
  if (!batch || !batch.open) return false;
  const trimmed = said.trim();
  if (!trimmed) return answerSetupChoose(prompt, null);
  return settleWithFrame(requestId, batch, { said: trimmed });
}

/**
 * 「跳过这条」：clarify 发 `{answer: null}`（内核 `raw in (None, "")` 判 skipped），
 * 单值卡发空串（内核口径 `''` = declined），setup 卡发 `{picked: null}`。
 * 审批卡没有「跳过」语义，保持原地不动。
 */
export function skipServerPrompt(
  prompt: PendingPrompt,
  onSettled?: (sent: boolean) => void,
): boolean | "pending" {
  const requestId = prompt.serverRequestId;
  if (!requestId) return false;
  const batch = batches.get(requestId);
  if (!batch || !batch.open) return false;

  if (batch.method === "clarify") {
    if (!prompt.questionId) return false;
    void lockClarifyAnswer(prompt, prompt.questionId, null, batch).then((sent) => {
      onSettled?.(sent);
    });
    return "pending";
  }

  if (batch.method === "value") return settleWithFrame(requestId, batch, { value: "" });

  if (batch.method === "setup") return answerSetupChoose(prompt, null);
  return false;
}

const SAVE_LOGIN_FIELDS: ValueField[] = [
  { key: "identifier", label: "账号", secret: false },
  { key: "password", label: "密码", secret: true },
];

function saveLoginDetail(params: Record<string, unknown>): string | undefined {
  const site = text(params.site).trim();
  const origin = text(params.origin).trim();
  if (site && origin && site !== origin) return `保存到 ${site}（${origin}）?`;
  const target = site || origin;
  return target ? `保存到 ${target}?` : undefined;
}

const VALUE_REQUESTS: Record<string, ValueRequestSpec> = {
  sudo: { label: "需要 sudo 口令", secret: true },
  secret: { label: "需要一个凭据", secret: true },
  "display.install.sudo": { label: "安装 Bot Screen 需要口令", secret: true },
  "vault.code": { label: "输入两步验证码", secret: true },
  "vault.unlock_prompt": { label: "解锁密码库", secret: true },
  "vault.save_login": {
    label: "保存登录",
    secret: false,
    fields: SAVE_LOGIN_FIELDS,
    detail: saveLoginDetail,
  },
};

/** Local dismissal: answered on another surface, or withdrawn by the kernel. */
export function dismissServerPrompt(prompt: PendingPrompt): void {
  const requestId = prompt.serverRequestId;
  if (!requestId) return;
  const batch = batches.get(requestId);
  const perQuestion = Boolean(prompt.questionId) && (batch?.questions.length ?? 0) > 1;
  if (batch && !perQuestion) {
    batch.open = false;
    batches.delete(requestId);
  }
  setPrompts((prompts) =>
    prompts.filter(
      (item) =>
        !(
          item.serverRequestId === requestId &&
          (prompt.questionId === undefined || item.questionId === prompt.questionId)
        ),
    ),
  );
}

interface OpenRequest {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/**
 * Re-deliver requests the backend still waits on. `session.resume` returns them
 * as `open_requests` under the id they were originally sent with, so a card
 * comes back after a reconnect and answers on that same id.
 */
export function redeliverOpenRequests(requests: unknown): void {
  if (!Array.isArray(requests)) return;
  for (const entry of requests as OpenRequest[]) {
    const id = text(entry?.id);
    const method = text(entry?.method);
    if (!id || !method || batches.has(id)) continue;
    // 重投 ＝ 上次应答没到内核，允许同一个 id 重新应答。
    getGatewayClient().reopenServerRequest?.(id);
    const params =
      entry?.params && typeof entry.params === "object"
        ? (entry.params as Record<string, unknown>)
        : {};
    if (method === "approval") registerApproval(id, params);
    else if (method === "clarify") registerClarify(id, params);
    else if (method === "setup_choose") registerSetup(id, params);
    else if (VALUE_REQUESTS[method]) registerValue(id, params, VALUE_REQUESTS[method]);
  }
}

let started = false;

/**
 * Register the server→client prompt handlers plus the `request.cancel`
 * teardown. An unanswered request parks the agent until its own deadline, so
 * unmapped methods are refused at once (-32601) by the client itself.
 */
export function startServerRequestBridge(): () => void {
  if (started) return () => {};
  started = true;
  const client = getGatewayClient();
  const offs: (() => void)[] = [];

  offs.push(
    client.onServerRequest("approval", (params, id) => {
      registerApproval(id, (params ?? {}) as Record<string, unknown>);
    }),
  );
  offs.push(
    client.onServerRequest("clarify", (params, id) => {
      registerClarify(id, (params ?? {}) as Record<string, unknown>);
    }),
  );
  offs.push(
    client.onServerRequest("setup_choose", (params, id) => {
      registerSetup(id, (params ?? {}) as Record<string, unknown>);
    }),
  );

  // sudo / secret / vault 提示：内核问的是一段文本，应答 `{value}`，空串＝跳过。
  for (const [method, spec] of Object.entries(VALUE_REQUESTS)) {
    offs.push(
      client.onServerRequest(method, (params, id) => {
        registerValue(id, (params ?? {}) as Record<string, unknown>, spec);
      }),
    );
  }

  offs.push(
    client.on("request.cancel", (event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const id = text(payload.id);
      if (id) dropRequest(id);
    }),
  );

  return () => {
    started = false;
    for (const off of offs) off();
    batches.clear();
    setPrompts(() => []);
  };
}
