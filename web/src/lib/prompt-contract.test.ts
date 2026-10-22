import { describe, expect, it } from "vitest";
import {
  approvalChoices,
  buildApprovalRespondParams,
  buildClarifyRespondParams,
  clarifyAnswer,
  parsePromptEvent,
  type Prompt,
} from "./prompt-contract";

const approvalPayload = {
  kind: "approval",
  prompt_id: "p-1",
  execution_generation: 7,
  command: "rm -rf build",
  description: "删除构建产物",
  choices: ["once", "deny", "session", "always"],
  timeout_s: 300,
};

const clarifyPayload = {
  kind: "clarify",
  prompt_id: "c-1",
  execution_generation: 3,
  question: "先做前端还是后端？",
  choices: ["前端", "后端"],
  multi_select: false,
  timeout_s: 3600,
};

describe("parsePromptEvent", () => {
  it("parses an approval request", () => {
    const prompt = parsePromptEvent("approval", approvalPayload);
    expect(prompt).toMatchObject({
      kind: "approval",
      promptId: "p-1",
      generation: 7,
      command: "rm -rf build",
      description: "删除构建产物",
      choices: ["once", "deny", "session", "always"],
      timeoutS: 300,
      multiSelect: false,
    });
  });

  it("parses a clarify request with choices and multi_select", () => {
    const prompt = parsePromptEvent("clarify", { ...clarifyPayload, multi_select: true });
    expect(prompt).toMatchObject({
      kind: "clarify",
      promptId: "c-1",
      generation: 3,
      question: "先做前端还是后端？",
      choices: ["前端", "后端"],
      multiSelect: true,
      timeoutS: 3600,
    });
  });

  it("accepts a clarify request without choices (open ended)", () => {
    const prompt = parsePromptEvent("clarify", {
      prompt_id: "c-2",
      execution_generation: 1,
      question: "说说你的想法",
    });
    expect(prompt?.choices).toEqual([]);
    expect(prompt?.timeoutS).toBeUndefined();
  });

  it("rejects a payload without prompt_id", () => {
    expect(parsePromptEvent("approval", { ...approvalPayload, prompt_id: undefined })).toBeNull();
  });

  it("rejects an empty or blank prompt_id", () => {
    expect(parsePromptEvent("approval", { ...approvalPayload, prompt_id: "" })).toBeNull();
    expect(parsePromptEvent("approval", { ...approvalPayload, prompt_id: "   " })).toBeNull();
  });

  it("rejects a payload without a numeric execution_generation", () => {
    expect(
      parsePromptEvent("approval", { ...approvalPayload, execution_generation: undefined }),
    ).toBeNull();
    expect(
      parsePromptEvent("approval", { ...approvalPayload, execution_generation: "7" }),
    ).toBeNull();
  });

  it("rejects a non-numeric timeout_s", () => {
    expect(parsePromptEvent("approval", { ...approvalPayload, timeout_s: "300" })).toBeNull();
  });

  it("rejects an unknown prompt kind and a non-object payload", () => {
    expect(parsePromptEvent("permission", approvalPayload)).toBeNull();
    expect(parsePromptEvent("approval", null)).toBeNull();
    expect(parsePromptEvent("approval", "rm -rf")).toBeNull();
  });

  it("drops unknown approval choices but keeps the kernel order", () => {
    const prompt = parsePromptEvent("approval", {
      ...approvalPayload,
      choices: ["once", "bogus", "deny"],
    });
    expect(prompt?.choices).toEqual(["once", "deny"]);
  });

  it("rejects an approval request with no known choice", () => {
    expect(parsePromptEvent("approval", { ...approvalPayload, choices: ["bogus"] })).toBeNull();
  });
});

describe("approvalChoices", () => {
  const prompt = parsePromptEvent("approval", approvalPayload) as Prompt;

  it("maps kernel choices to Chinese labels in kernel order with deny last", () => {
    expect(approvalChoices(prompt)).toEqual([
      { choice: "once", label: "允许一次" },
      { choice: "session", label: "本会话内允许" },
      { choice: "always", label: "总是允许" },
      { choice: "deny", label: "拒绝" },
    ]);
  });

  it("never invents a choice the kernel did not send", () => {
    const minimal = parsePromptEvent("approval", {
      ...approvalPayload,
      choices: ["once", "deny"],
    }) as Prompt;
    expect(approvalChoices(minimal).map((item) => item.choice)).toEqual(["once", "deny"]);
  });

  it("moves deny to the end even when the kernel lists it first", () => {
    const denyFirst = parsePromptEvent("approval", {
      ...approvalPayload,
      choices: ["deny", "once"],
    }) as Prompt;
    expect(approvalChoices(denyFirst).map((item) => item.choice)).toEqual(["once", "deny"]);
  });
});

describe("clarifyAnswer", () => {
  it("returns the single pick as-is", () => {
    expect(clarifyAnswer(["前端"], false)).toBe("前端");
  });

  it("joins multi-select picks with 、 and drops blanks", () => {
    expect(clarifyAnswer(["前端", " ", "后端"], true)).toBe("前端、后端");
  });

  it("returns an empty string when nothing is picked", () => {
    expect(clarifyAnswer([], true)).toBe("");
  });
});

describe("respond params", () => {
  const approval = parsePromptEvent("approval", approvalPayload) as Prompt;
  const clarify = parsePromptEvent("clarify", clarifyPayload) as Prompt;

  it("builds approval.respond with exactly the four kernel fields", () => {
    const params = buildApprovalRespondParams({ sessionId: "s-1", prompt: approval, choice: "once" });
    expect(Object.keys(params).sort()).toEqual([
      "choice",
      "execution_generation",
      "prompt_id",
      "session_id",
    ]);
    expect(params).toEqual({
      session_id: "s-1",
      execution_generation: 7,
      prompt_id: "p-1",
      choice: "once",
    });
  });

  it("builds clarify.respond with exactly the four kernel fields", () => {
    const params = buildClarifyRespondParams({ sessionId: "s-1", prompt: clarify, answer: "前端" });
    expect(Object.keys(params).sort()).toEqual([
      "answer",
      "execution_generation",
      "prompt_id",
      "session_id",
    ]);
    expect(params).toEqual({
      session_id: "s-1",
      execution_generation: 3,
      prompt_id: "c-1",
      answer: "前端",
    });
  });

  it("refuses a choice the kernel did not offer", () => {
    expect(() =>
      buildApprovalRespondParams({ sessionId: "s-1", prompt: approval, choice: "always" }),
    ).not.toThrow();
    const minimal = parsePromptEvent("approval", {
      ...approvalPayload,
      choices: ["once", "deny"],
    }) as Prompt;
    expect(() =>
      buildApprovalRespondParams({ sessionId: "s-1", prompt: minimal, choice: "always" }),
    ).toThrow();
  });

  it("trims the answer and sends a skip as null", () => {
    expect(
      buildClarifyRespondParams({ sessionId: "s-1", prompt: clarify, answer: "  前端  " }).answer,
    ).toBe("前端");
    expect(
      buildClarifyRespondParams({ sessionId: "s-1", prompt: clarify, answer: "   " }).answer,
    ).toBeNull();
  });

  it("passes a null answer straight through", () => {
    expect(
      buildClarifyRespondParams({ sessionId: "s-1", prompt: clarify, answer: null }),
    ).toEqual({
      session_id: "s-1",
      execution_generation: 3,
      prompt_id: "c-1",
      answer: null,
    });
  });

  it("refuses an answer past the kernel's 16384 character cap", () => {
    expect(() =>
      buildClarifyRespondParams({
        sessionId: "s-1",
        prompt: clarify,
        answer: "x".repeat(16385),
      }),
    ).toThrow();
  });
});
