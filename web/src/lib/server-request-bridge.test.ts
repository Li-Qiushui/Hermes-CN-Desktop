import { describe, expect, it, vi, beforeEach } from "vitest";
import { getDefaultStore } from "jotai";

const requestMock = vi.fn();
const respondMock = vi.fn();
const onServerRequestMock = vi.fn(() => () => {});
const onMock = vi.fn(() => () => {});

vi.mock("@/lib/gateway-client", () => ({
  getGatewayClient: () => ({
    request: requestMock,
    respondToServerRequest: respondMock,
    onServerRequest: onServerRequestMock,
    on: onMock,
  }),
}));

const {
  answerServerPrompt,
  answerSetupChoose,
  answerSetupSaid,
  cancelServerBatch,
  redeliverOpenRequests,
  serverPromptsAtom,
  skipServerPrompt,
} = await import("./server-request-bridge");

type Prompt = {
  serverRequestId?: string;
  questionId?: string;
  question: string;
};

const store = getDefaultStore();
const prompts = () => store.get(serverPromptsAtom) as unknown as Prompt[];

function clarifyRequest(id: string, qids: string[], answers?: Record<string, string>) {
  return {
    id,
    method: "clarify",
    params: {
      session_id: "rt-1",
      questions: qids.map((qid) => ({
        qid,
        question: `问题 ${qid}`,
        choices: null,
        multi_select: false,
      })),
      ...(answers ? { answers } : {}),
    },
  };
}

beforeEach(() => {
  store.set(serverPromptsAtom, []);
  requestMock.mockReset();
  respondMock.mockReset();
  respondMock.mockReturnValue(true);
});

describe("server-request-bridge · 批量问答锁定", () => {
  it("重投时跳过内核已经锁定的问题", () => {
    redeliverOpenRequests([clarifyRequest("srq-a", ["q0", "q1", "q2"], { q0: "已答" })]);
    expect(prompts().map((p) => p.questionId)).toEqual(["q1", "q2"]);
  });

  it("答一题就落锁，并把这张卡摘掉", async () => {
    redeliverOpenRequests([clarifyRequest("srq-b", ["q0", "q1"])]);
    requestMock.mockResolvedValue({ status: "ok", remaining: ["q1"] });

    answerServerPrompt(prompts()[0] as never, "蓝色");
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));

    expect(requestMock).toHaveBeenCalledWith("clarify.lock", {
      request_id: "srq-b",
      question_id: "q0",
      answer: "蓝色",
    });
    await vi.waitFor(() => expect(prompts().map((p) => p.questionId)).toEqual(["q1"]));
    expect(respondMock).not.toHaveBeenCalled();
  });

  it("最后一条锁定后整批收尾，不再发 closing frame", async () => {
    redeliverOpenRequests([clarifyRequest("srq-c", ["q0"])]);
    requestMock.mockResolvedValue({ status: "ok", remaining: [] });

    answerServerPrompt(prompts()[0] as never, "红色");
    await vi.waitFor(() => expect(prompts()).toHaveLength(0));
    expect(respondMock).not.toHaveBeenCalled();
  });

  it("status=expired 时把残留卡片一起收掉", async () => {
    redeliverOpenRequests([clarifyRequest("srq-d", ["q0", "q1"])]);
    requestMock.mockResolvedValue({ status: "expired", remaining: null });

    answerServerPrompt(prompts()[0] as never, "随便");
    await vi.waitFor(() => expect(prompts()).toHaveLength(0));
  });

  it("内核没有 clarify.lock 时回退成本地累积 + 一次性 closing frame", async () => {
    redeliverOpenRequests([clarifyRequest("srq-e", ["q0", "q1"])]);
    requestMock.mockRejectedValue(new Error("method not found"));

    answerServerPrompt(prompts()[0] as never, "甲");
    await vi.waitFor(() => expect(prompts().map((p) => p.questionId)).toEqual(["q1"]));
    expect(respondMock).not.toHaveBeenCalled();

    answerServerPrompt(prompts()[0] as never, "乙");
    await vi.waitFor(() => expect(respondMock).toHaveBeenCalledTimes(1));
    expect(respondMock).toHaveBeenCalledWith("srq-e", {
      answers: { q0: "甲", q1: "乙" },
      outcome: "submitted",
    });
  });

  it("锁帧发不出去时卡片保留，socket 恢复后可重试", async () => {
    redeliverOpenRequests([clarifyRequest("srq-offline", ["q0", "q1"])]);
    requestMock.mockRejectedValueOnce(new Error("WebSocket not connected"));
    const settled: boolean[] = [];

    expect(
      answerServerPrompt(prompts()[0] as never, "蓝色", (sent) => settled.push(sent)),
    ).toBe("pending");
    await vi.waitFor(() => expect(settled).toEqual([false]));
    expect(prompts().map((p) => p.questionId)).toEqual(["q0", "q1"]);

    requestMock.mockResolvedValue({ status: "ok", remaining: ["q1"] });
    expect(answerServerPrompt(prompts()[0] as never, "蓝色")).toBe("pending");
    await vi.waitFor(() => expect(prompts().map((p) => p.questionId)).toEqual(["q1"]));
  });

  it("题目全已锁但收尾帧发不出去：放掉 batch，内核重投时能再补一次", () => {
    respondMock.mockReturnValueOnce(false);
    const request = clarifyRequest("srq-close", ["q0"], { q0: "甲" });
    redeliverOpenRequests([request]);

    expect(respondMock).toHaveBeenCalledWith("srq-close", {
      answers: { q0: "甲" },
      outcome: "submitted",
    });
    expect(prompts()).toHaveLength(0);

    redeliverOpenRequests([request]);
    expect(respondMock).toHaveBeenCalledTimes(2);
  });

  it("跳过 clarify 发 {answer: null}，不是正文占位", async () => {
    redeliverOpenRequests([clarifyRequest("srq-skip", ["q0", "q1"])]);
    requestMock.mockResolvedValue({ status: "ok", remaining: ["q1"] });

    skipServerPrompt(prompts()[0] as never);
    await vi.waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("clarify.lock", {
        request_id: "srq-skip",
        question_id: "q0",
        answer: null,
      }),
    );
    await vi.waitFor(() => expect(prompts().map((p) => p.questionId)).toEqual(["q1"]));
    expect(respondMock).not.toHaveBeenCalled();
  });

  it("中止整批只发 notice，不带 answers（带 answers 会被内核改成 submitted）", () => {
    redeliverOpenRequests([clarifyRequest("srq-f", ["q0", "q1"], { q0: "甲" })]);
    cancelServerBatch("srq-f", "用户中止");
    expect(respondMock).toHaveBeenCalledWith("srq-f", { notice: "用户中止" });
    const payload = respondMock.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("answers");
    expect(payload).not.toHaveProperty("outcome");
    expect(prompts()).toHaveLength(0);
  });
});

describe("server-request-bridge · 审批与单值输入", () => {
  const approvalRequest = (id: string) => ({
    id,
    method: "approval",
    params: {
      request_id: `apr-${id}`,
      session_id: "rt-1",
      command: "rm -rf build",
      choices: ["once", "session", "always", "deny"],
    },
  });

  it("审批卡上屏后回执 approval.received，并把 all 一起回传", async () => {
    requestMock.mockResolvedValue({ ok: true });
    redeliverOpenRequests([approvalRequest("srq-appr")]);

    await vi.waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("approval.received", {
        session_id: "rt-1",
        request_id: "srq-appr",
      }),
    );

    const { answerApproval } = await import("./server-request-bridge");
    answerApproval(prompts()[0] as never, "always", true);
    expect(respondMock).toHaveBeenCalledWith("srq-appr", { choice: "always", all: true });
    expect(prompts()).toHaveLength(0);
  });

  it("普通允许不发 all，保持单次语义", async () => {
    requestMock.mockResolvedValue({ ok: true });
    redeliverOpenRequests([approvalRequest("srq-once")]);
    const { answerApproval } = await import("./server-request-bridge");
    answerApproval(prompts()[0] as never, "once", false);
    expect(respondMock).toHaveBeenCalledWith("srq-once", { choice: "once" });
  });

  it("应答帧发不出去时卡片保留、batch 不关，可以重试", async () => {
    requestMock.mockResolvedValue({ ok: true });
    redeliverOpenRequests([approvalRequest("srq-retry")]);
    const { answerApproval } = await import("./server-request-bridge");

    respondMock.mockReturnValueOnce(false);
    expect(answerApproval(prompts()[0] as never, "once", false)).toBe(false);
    expect(prompts()).toHaveLength(1);

    expect(answerApproval(prompts()[0] as never, "once", false)).toBe(true);
    expect(prompts()).toHaveLength(0);
    expect(respondMock).toHaveBeenCalledTimes(2);
  });

  it("sudo 请求变成遮蔽输入卡，应答形状是 {value}", async () => {
    redeliverOpenRequests([
      { id: "srq-sudo", method: "sudo", params: { session_id: "rt-1", command: "sudo apt install x" } },
    ]);
    const card = prompts()[0] as unknown as { kind: string; secret?: boolean };
    expect(card.kind).toBe("value");
    expect(card.secret).toBe(true);

    answerServerPrompt(prompts()[0] as never, "hunter2");
    expect(respondMock).toHaveBeenCalledWith("srq-sudo", { value: "hunter2" });
    expect(prompts()).toHaveLength(0);
  });

  it("单值卡跳过发空串（内核口径：空串＝跳过）", async () => {
    redeliverOpenRequests([
      { id: "srq-secret", method: "secret", params: { session_id: "rt-1", prompt: "API key" } },
    ]);
    answerServerPrompt(prompts()[0] as never, "");
    expect(respondMock).toHaveBeenCalledWith("srq-secret", { value: "" });
  });
});

describe("server-request-bridge · vault.save_login 双字段", () => {
  const saveLogin = (id: string) => ({
    id,
    method: "vault.save_login",
    params: { session_id: "rt-1", origin: "https://github.com", site: "github.com" },
  });

  it("注册成带两个字段的值卡，并把站点写进说明行", () => {
    redeliverOpenRequests([saveLogin("srq-vault")]);
    const card = prompts()[0] as unknown as {
      kind: string;
      question?: string;
      detail?: string;
      fields?: { key: string; label: string; secret: boolean }[];
    };
    expect(card.kind).toBe("value");
    expect(card.question).toBe("保存登录");
    expect(card.fields?.map((field) => field.key)).toEqual(["identifier", "password"]);
    expect(card.fields?.find((field) => field.key === "password")?.secret).toBe(true);
    expect(card.detail).toBe("保存到 github.com（https://github.com）?");
  });

  it("提交时答案是 JSON {identifier, password}", () => {
    redeliverOpenRequests([saveLogin("srq-vault-json")]);
    answerServerPrompt(
      prompts()[0] as never,
      JSON.stringify({ identifier: "me@x.dev", password: "pw123" }),
    );
    expect(respondMock).toHaveBeenCalledWith("srq-vault-json", {
      value: '{"identifier":"me@x.dev","password":"pw123"}',
    });
    expect(prompts()).toHaveLength(0);
  });

  it("点跳过发空串（内核口径：空串＝declined）", () => {
    redeliverOpenRequests([saveLogin("srq-vault-skip")]);
    skipServerPrompt(prompts()[0] as never);
    expect(respondMock).toHaveBeenCalledWith("srq-vault-skip", { value: "" });
    expect(prompts()).toHaveLength(0);
  });
});

describe("server-request-bridge · setup_choose 卡", () => {
  const setupRequest = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    method: "setup_choose",
    params: {
      session_id: "rt-1",
      kind: "theme",
      question: "选个主题",
      options: [
        { id: "dark", label: "深色" },
        { id: "light", label: "浅色" },
      ],
      multi_select: false,
      preselected: null,
      ...extra,
    },
  });

  it("九种 kind 都注册成 setup 卡，选项按 id/label 映射", () => {
    redeliverOpenRequests([setupRequest("srq-setup")]);
    const card = prompts()[0] as unknown as {
      kind: string;
      setupKind?: string;
      options?: { id: string; label: string }[];
    };
    expect(card.kind).toBe("setup");
    expect(card.setupKind).toBe("theme");
    expect(card.options?.map((option) => option.id)).toEqual(["dark", "light"]);
  });

  it("单选发 {picked: id}", () => {
    redeliverOpenRequests([setupRequest("srq-setup-one")]);
    answerSetupChoose(prompts()[0] as never, "dark");
    expect(respondMock).toHaveBeenCalledWith("srq-setup-one", { picked: "dark" });
    expect(prompts()).toHaveLength(0);
  });

  it("多选发 id 数组，并带上预选行", () => {
    redeliverOpenRequests([
      setupRequest("srq-setup-many", {
        kind: "plugins",
        multi_select: true,
        preselected: ["dark"],
      }),
    ]);
    const card = prompts()[0] as unknown as { multiSelect: boolean; preselected?: string[] };
    expect(card.multiSelect).toBe(true);
    expect(card.preselected).toEqual(["dark"]);

    answerSetupChoose(prompts()[0] as never, ["dark", "light"]);
    expect(respondMock).toHaveBeenCalledWith("srq-setup-many", { picked: ["dark", "light"] });
  });

  it("自由输入发 {said}", () => {
    redeliverOpenRequests([setupRequest("srq-setup-said", { options: [] })]);
    answerSetupSaid(prompts()[0] as never, "  我自己写一个  ");
    expect(respondMock).toHaveBeenCalledWith("srq-setup-said", { said: "我自己写一个" });
  });

  it("跳过/关闭发 {picked: null}", () => {
    redeliverOpenRequests([setupRequest("srq-setup-skip")]);
    skipServerPrompt(prompts()[0] as never);
    expect(respondMock).toHaveBeenCalledWith("srq-setup-skip", { picked: null });
  });

  it("字符串选项也能映射成行", () => {
    redeliverOpenRequests([
      setupRequest("srq-setup-str", { options: ["就这个", "那个"] }),
    ]);
    const card = prompts()[0] as unknown as { options?: { id: string; label: string }[] };
    expect(card.options).toEqual([
      { id: "就这个", label: "就这个" },
      { id: "那个", label: "那个" },
    ]);
  });
});
