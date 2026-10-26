import { createStore } from "jotai/vanilla";
import { describe, expect, it, vi } from "vitest";
import type { HermesMessagePart, HermesUIMessage } from "@hermes/protocol";
import {
  activateRevisionAtom,
  adoptResumedSessionAtom,
  applyGatewayEventAtom,
  beginRevisionRetryAtom,
  chatRuntimeBySessionAtom,
  createEmptyChatRuntime,
  dismissStreamErrorCardAtom,
  drainLiveMessagesAtom,
  dropWithdrawnTurnMessages,
  finalizeRevisionRetryAtom,
  hydrateSessionTimelineAtom,
  markSessionInterruptedAtom,
  markStreamsReconnectingAtom,
  noteAutoContinuedTurnAtom,
  pendingPromptsAtom,
  promptsOf,
  resolveStopOutcome,
  revisionHiddenMessageIds,
  sanitizeErrorDetail,
  stopTurnAtom,
  recoverCompletedTurnFromStoredMessagesAtom,
  reduceGatewayEvent,
  removePromptAtom,
  resetStreamStateAtom,
  settleRecoveredStreamErrorAtom,
  startPromptAtom,
  terminateAllStreamsAtom,
} from "./chat";

function assistantMessage(runtime: ReturnType<typeof createEmptyChatRuntime>): HermesUIMessage {
  const message = runtime.messages.find((item) => item.role === "assistant");
  expect(message).toBeDefined();
  return message!;
}

function systemMessage(runtime: ReturnType<typeof createEmptyChatRuntime>): HermesUIMessage {
  const message = runtime.messages.find((item) => item.role === "system");
  expect(message).toBeDefined();
  return message!;
}

function textFromParts(parts: HermesMessagePart[]): string {
  return parts
    .filter((part): part is Extract<HermesMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function runtimeMessage(overrides: Partial<HermesUIMessage>): HermesUIMessage {
  return {
    id: "m1",
    sessionId: "s1",
    role: "assistant",
    createdAt: 1,
    status: "complete",
    parts: [{ type: "text", text: "hello" }],
    ...overrides,
  };
}

describe("gwSessionIdAtom (persisted)", () => {
  it("persists writes to the UI store and removes the key when cleared", async () => {
    vi.resetModules();
    const uiStore = await import("@/lib/ui-store");
    uiStore.__resetUiStoreForTests();
    const chat = await import("./chat");
    const store = createStore();
    store.set(chat.gwSessionIdAtom, "gws-live-789");
    expect(uiStore.readUiValue("hermes.gateway-session-id", null)).toBe("gws-live-789");
    store.set(chat.gwSessionIdAtom, null);
    expect(uiStore.readUiValue("hermes.gateway-session-id", "fallback")).toBe("fallback");
  });

  it("restores a persisted gateway session id after a reload (F5)", async () => {
    vi.resetModules();
    const uiStore = await import("@/lib/ui-store");
    uiStore.__resetUiStoreForTests({ "hermes.gateway-session-id": "gws-persisted-456" });
    const chat = await import("./chat");
    expect(createStore().get(chat.gwSessionIdAtom)).toBe("gws-persisted-456");
  });
});

describe("chat runtime reducer", () => {
  it("uses message.complete payload even when no deltas were received", () => {
    const next = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "message.complete",
        session_id: "s1",
        payload: { text: "最终回复", reasoning: "推理", status: "complete" },
      },
      10,
    );

    const message = assistantMessage(next);
    expect(message).toMatchObject({
      role: "assistant",
      status: "complete",
      parts: [
        { type: "text", text: "最终回复" },
        { type: "reasoning", text: "推理" },
      ],
    });
    expect(next.streamStatus).toBe("complete");
  });

  it("replaces a corrupt streamed prefix with the authoritative completion text", () => {
    let runtime = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "reasoning.delta",
        session_id: "s1",
        payload: { text: "同一段推理" },
      },
      10,
    );
    runtime = reduceGatewayEvent(runtime, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "乱序流式前缀" },
    }, 20);
    runtime = reduceGatewayEvent(runtime, {
      type: "message.complete",
      session_id: "s1",
      payload: {
        text: "这是唯一正确的最终回复。",
        reasoning: "同一段推理",
        status: "complete",
      },
    }, 30);

    const message = assistantMessage(runtime);
    expect(textFromParts(message.parts)).toBe("这是唯一正确的最终回复。");
    expect(textFromParts(message.parts)).not.toContain("乱序流式前缀");
    expect(message.parts).toEqual([
      { type: "reasoning", text: "同一段推理" },
      { type: "text", text: "这是唯一正确的最终回复。" },
    ]);
  });

  it("keeps one assistant id from stream start through completion", () => {
    const started = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "message.start", session_id: "s1" },
      10,
    );

    const withText = reduceGatewayEvent(
      started,
      {
        type: "message.delta",
        session_id: "s1",
        payload: { text: "hello" },
      },
      20,
    );

    const complete = reduceGatewayEvent(
      withText,
      {
        type: "message.complete",
        session_id: "s1",
        payload: { status: "complete" },
      },
      30,
    );

    expect(assistantMessage(started).id).toBe("live-assistant-10");
    expect(assistantMessage(complete).id).toBe("live-assistant-10");
    expect(assistantMessage(complete).status).toBe("complete");
    expect(complete.activeAssistantId).toBeUndefined();
  });

  it("preserves the optimistic assistant id created when the prompt was sent", () => {
    const runtime = {
      ...createEmptyChatRuntime(1),
      streamStatus: "streaming" as const,
      activeAssistantId: "live-assistant-5",
      turnStartedAt: 5,
    };

    const started = reduceGatewayEvent(
      runtime,
      { type: "message.start", session_id: "s1" },
      10,
    );

    expect(started.activeAssistantId).toBe("live-assistant-5");
    expect(assistantMessage(started).id).toBe("live-assistant-5");
  });

  it("shows CLI spinner thinking placeholders as progress parts and removes them on completion", () => {
    const placeholder = "ಠ_ಠ deliberating... (⌐■_■) contemplating...";
    const thinking = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "thinking.delta",
        session_id: "s1",
        payload: { text: placeholder },
      },
      10,
    );

    expect(assistantMessage(thinking).parts).toEqual([{ type: "progress", text: placeholder }]);

    const complete = reduceGatewayEvent(
      thinking,
      {
        type: "message.complete",
        session_id: "s1",
        payload: { text: "完成", status: "complete" },
      },
      20,
    );

    expect(assistantMessage(complete).parts).toEqual([{ type: "text", text: "完成" }]);
  });

  it("removes progress when real output resumes", () => {
    const thinking = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "thinking.delta",
        session_id: "s1",
        payload: { text: "ಠ_ಠ deliberating..." },
      },
      10,
    );
    const next = reduceGatewayEvent(
      thinking,
      {
        type: "message.delta",
        session_id: "s1",
        payload: { text: "继续回复。" },
      },
      20,
    );

    expect(assistantMessage(next).parts).toEqual([{ type: "text", text: "继续回复。" }]);
  });

  it("updates the same progress part on repeated placeholder deltas", () => {
    const firstPlaceholder = "ಠ_ಠ deliberating...";
    const secondPlaceholder = "(⌐■_■) contemplating...";
    const thinking = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "thinking.delta",
        session_id: "s1",
        payload: { text: firstPlaceholder },
      },
      10,
    );
    const next = reduceGatewayEvent(
      thinking,
      {
        type: "thinking.delta",
        session_id: "s1",
        payload: { text: secondPlaceholder },
      },
      20,
    );

    expect(assistantMessage(next).parts).toEqual([{ type: "progress", text: secondPlaceholder }]);
  });

  it("keeps live progress stable when tools start", () => {
    const thinking = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "thinking.delta",
        session_id: "s1",
        payload: { text: "ಠ_ಠ deliberating..." },
      },
      10,
    );
    const next = reduceGatewayEvent(
      thinking,
      {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "read-1", name: "read_file", context: "app.tsx" },
      },
      20,
    );

    expect(assistantMessage(next).parts).toEqual([
      expect.objectContaining({ type: "tool", toolCallId: "read-1" }),
      { type: "progress", text: "ಠ_ಠ deliberating..." },
    ]);
  });

  it("keeps real reasoning deltas", () => {
    const next = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "reasoning.delta",
        session_id: "s1",
        payload: { text: "正在分析用户输入和约束。" },
      },
      10,
    );

    expect(assistantMessage(next).parts).toEqual([
      { type: "reasoning", text: "正在分析用户输入和约束。" },
    ]);
  });

  it("updates duplicate tool names by toolCallId when available", () => {
    const first = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "a", name: "shell", context: "first" },
      },
      10,
    );
    const started = reduceGatewayEvent(
      first,
      {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "b", name: "shell", context: "second" },
      },
      20,
    );

    const next = reduceGatewayEvent(
      started,
      {
        type: "tool.complete",
        session_id: "s1",
        payload: { tool_id: "b", name: "shell", summary: "done" },
      },
      30,
    );

    expect(assistantMessage(next).parts).toEqual([
      expect.objectContaining({ type: "tool", toolCallId: "a", state: "running" }),
      expect.objectContaining({ type: "tool", toolCallId: "b", state: "done", output: "done" }),
    ]);
  });

  it("uses gateway tool duration when completing live tools", () => {
    const started = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "read-1", name: "read_file", context: "app.tsx" },
      },
      1000,
    );

    const next = reduceGatewayEvent(
      started,
      {
        type: "tool.complete",
        session_id: "s1",
        payload: { tool_id: "read-1", summary: "done", duration_s: 2.25 },
      },
      9000,
    );

    expect(assistantMessage(next).parts[0]).toEqual(
      expect.objectContaining({
        type: "tool",
        state: "done",
        completedAt: 3250,
      }),
    );
  });

  it("reads the kernel tool.complete result field instead of showing an empty output", () => {
    const started = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "call-1", name: "terminal", context: "ls -la" },
      },
      1000,
    );

    const next = reduceGatewayEvent(
      started,
      {
        type: "tool.complete",
        session_id: "s1",
        payload: { tool_id: "call-1", name: "terminal", args: { command: "ls -la" }, is_error: false, result: "total 8\n-rw-r--r-- a.txt" },
      },
      3000,
    );

    expect(assistantMessage(next).parts[0]).toEqual(
      expect.objectContaining({ type: "tool", state: "done", output: "total 8\n-rw-r--r-- a.txt" }),
    );
  });

  it("marks a failed tool.complete as an error and keeps the result as the message", () => {
    const started = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "call-2", name: "terminal", context: "false" },
      },
      1000,
    );

    const next = reduceGatewayEvent(
      started,
      {
        type: "tool.complete",
        session_id: "s1",
        payload: { tool_id: "call-2", name: "terminal", is_error: true, result: "exit 1: command not found" },
      },
      2000,
    );

    expect(assistantMessage(next).parts[0]).toEqual(
      expect.objectContaining({ type: "tool", state: "error", errorText: "exit 1: command not found" }),
    );
  });

  it("does not let an empty tool.complete result wipe a streamed output", () => {
    const started = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "call-3", name: "terminal", context: "pwd" },
      },
      1000,
    );

    const next = reduceGatewayEvent(
      started,
      {
        type: "tool.complete",
        session_id: "s1",
        payload: { tool_id: "call-3", name: "terminal", summary: "", result: "  ", is_error: false },
      },
      2000,
    );

    expect((assistantMessage(next).parts[0] as { state: string }).state).toBe("done");
  });

  it("appends kernel tool.progress messages to the running tool tail", () => {
    const started = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "call-9", name: "terminal", context: "make" },
      },
      1000,
    );

    const first = reduceGatewayEvent(
      started,
      {
        type: "tool.progress",
        session_id: "s1",
        payload: {
          tool_id: "call-9",
          name: "terminal",
          progress: 1,
          total: 3,
          percent: 33,
          message: "step one",
        },
      },
      1500,
    );
    const next = reduceGatewayEvent(
      first,
      {
        type: "tool.progress",
        session_id: "s1",
        payload: {
          tool_id: "call-9",
          name: "terminal",
          progress: 2,
          total: 3,
          percent: 66,
          message: "step two",
        },
      },
      1600,
    );

    expect((assistantMessage(next).parts[0] as { tail?: string }).tail).toBe(
      "step one\nstep two",
    );
  });

  it("falls back to the last running tool with the same name when progress carries no tool id", () => {
    const started = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "call-10", name: "bash", context: "npm test" },
      },
      1000,
    );

    const next = reduceGatewayEvent(
      started,
      {
        type: "tool.progress",
        session_id: "s1",
        payload: { message_id: "msg_1", tool_name: "bash", delta: "RUNS  api.test.ts" },
      },
      1200,
    );

    expect((assistantMessage(next).parts[0] as { tail?: string }).tail).toBe(
      "RUNS  api.test.ts",
    );
  });

  it("ignores tool.progress for an unknown tool_call_id", () => {
    const started = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "call-11", name: "terminal", context: "ls" },
      },
      1000,
    );

    const next = reduceGatewayEvent(
      started,
      {
        type: "tool.progress",
        session_id: "s1",
        payload: { tool_id: "call-missing", name: "terminal", message: "stray output" },
      },
      1200,
    );

    expect(next).toBe(started);
    expect((assistantMessage(next).parts[0] as { tail?: string }).tail).toBeUndefined();
  });

  it("keeps the streamed tail readable after tool.complete", () => {
    const started = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "call-12", name: "terminal", context: "make" },
      },
      1000,
    );
    const streamed = reduceGatewayEvent(
      started,
      {
        type: "tool.progress",
        session_id: "s1",
        payload: { tool_id: "call-12", name: "terminal", message: "compiling" },
      },
      1500,
    );
    const completed = reduceGatewayEvent(
      streamed,
      {
        type: "tool.complete",
        session_id: "s1",
        payload: { tool_id: "call-12", name: "terminal", is_error: false, result: "done" },
      },
      2000,
    );

    const part = assistantMessage(completed).parts[0] as {
      state: string;
      tail?: string;
      output?: unknown;
    };
    expect(part.state).toBe("done");
    expect(part.tail).toBe("compiling");
    expect(part.output).toBe("done");
  });

  it("keeps only the trailing window of a long tool tail", () => {
    let runtime = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "call-13", name: "terminal", context: "yes" },
      },
      1000,
    );
    const chunk = "x".repeat(1024);
    for (let index = 0; index < 24; index += 1) {
      runtime = reduceGatewayEvent(
        runtime,
        {
          type: "tool.progress",
          session_id: "s1",
          payload: { tool_id: "call-13", name: "terminal", message: `${chunk}${index}` },
        },
        2000 + index,
      );
    }

    const tail = (assistantMessage(runtime).parts[0] as { tail?: string }).tail ?? "";
    expect(tail.length).toBeLessThanOrEqual(16 * 1024);
    expect(tail.endsWith("23")).toBe(true);
    expect(tail.startsWith("x")).toBe(true);
  });

  it("keeps text and tool calls in one ordered assistant turn", () => {
    const started = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "message.delta",
        session_id: "s1",
        payload: { text: "我先检查。" },
      },
      10,
    );
    const toolStarted = reduceGatewayEvent(
      started,
      {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "read-1", name: "read_file", context: "app.tsx" },
      },
      20,
    );
    const toolDone = reduceGatewayEvent(
      toolStarted,
      {
        type: "tool.complete",
        session_id: "s1",
        payload: { tool_id: "read-1", summary: "read ok" },
      },
      30,
    );
    const moreText = reduceGatewayEvent(
      toolDone,
      {
        type: "message.delta",
        session_id: "s1",
        payload: { text: "结论如下。" },
      },
      40,
    );
    const complete = reduceGatewayEvent(
      moreText,
      {
        type: "message.complete",
        session_id: "s1",
        payload: { status: "complete" },
      },
      50,
    );

    const message = assistantMessage(complete);
    expect(message.parts).toEqual([
      { type: "text", text: "我先检查。" },
      expect.objectContaining({
        type: "tool",
        toolCallId: "read-1",
        name: "read_file",
        state: "done",
        output: "read ok",
      }),
      { type: "text", text: "结论如下。" },
    ]);
    expect(textFromParts(message.parts)).toBe("我先检查。结论如下。");
  });

  it("preserves pre-tool commentary while replacing a corrupt final segment", () => {
    let runtime = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "message.delta",
        session_id: "s1",
        payload: { text: "我先检查。" },
      },
      10,
    );
    runtime = reduceGatewayEvent(runtime, {
      type: "tool.start",
      session_id: "s1",
      payload: { tool_id: "read-1", name: "read_file" },
    }, 20);
    runtime = reduceGatewayEvent(runtime, {
      type: "tool.complete",
      session_id: "s1",
      payload: { tool_id: "read-1", summary: "ok" },
    }, 30);
    runtime = reduceGatewayEvent(runtime, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "损坏的尾部" },
    }, 40);
    runtime = reduceGatewayEvent(runtime, {
      type: "message.complete",
      session_id: "s1",
      payload: { text: "最终结论。", status: "complete" },
    }, 50);

    expect(assistantMessage(runtime).parts).toEqual([
      { type: "text", text: "我先检查。" },
      expect.objectContaining({
        type: "tool",
        toolCallId: "read-1",
        state: "done",
      }),
      { type: "text", text: "最终结论。" },
    ]);
  });

  it("records usage and timing metadata on complete", () => {
    let rt = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "message.start", session_id: "s1" },
      100,
    );
    rt = reduceGatewayEvent(rt, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "hello" },
    }, 250);
    rt = reduceGatewayEvent(rt, {
      type: "message.complete",
      session_id: "s1",
      payload: {
        status: "complete",
        usage: {
          input: 10,
          output: 20,
          total: 30,
          model: "gpt-5.4",
          cost_usd: 0.01,
          cost_status: "estimated",
          finish_reason: "stop",
        },
      },
    }, 1100);

    expect(assistantMessage(rt).metadata).toMatchObject({
      usage: { tokensInput: 10, tokensOutput: 20, tokensTotal: 30 },
      timing: { startedAt: 100, firstTokenAt: 250, completedAt: 1100, ttftMs: 150, durationMs: 1000 },
      model: "gpt-5.4",
      costUsd: 0.01,
      costStatus: "estimated",
      finishReason: "stop",
    });
  });

  it("records interrupted completions as finishReason metadata", () => {
    let rt = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "message.delta", session_id: "s1", payload: { text: "处理中" } },
      100,
    );
    rt = reduceGatewayEvent(rt, {
      type: "message.complete",
      session_id: "s1",
      payload: {
        status: "interrupted",
        text: "Operation interrupted: waiting for model response (1.7s elapsed).",
      },
    }, 1_100);

    expect(assistantMessage(rt).status).toBe("complete");
    expect(assistantMessage(rt).metadata?.finishReason).toBe("interrupted");
    expect(rt.streamStatus).toBe("complete");
  });

  it("warning and error completion generate notice messages without replacing assistant content", () => {
    let rt = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "message.delta",
        session_id: "s1",
        payload: { text: "partial" },
      },
      10,
    );
    rt = reduceGatewayEvent(rt, {
      type: "message.complete",
      session_id: "s1",
      payload: { status: "error", warning: "quota low", error: "API key invalid (401)" },
    }, 20);

    expect(assistantMessage(rt).parts).toEqual([{ type: "text", text: "partial" }]);
    expect(rt.messages.filter((message) => message.role === "system")).toEqual([
      expect.objectContaining({ parts: [{ type: "notice", level: "warning", text: "quota low" }] }),
      expect.objectContaining({ parts: [{ type: "notice", level: "error", text: "API key invalid (401)" }] }),
    ]);
  });

  it("keeps multiple pending approvals for one session", () => {
    const first = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "approval.request",
        session_id: "s1",
        payload: { prompt_id: "r1", execution_generation: 1, command: "rm -rf tmp", choices: ["once", "deny"] },
      },
      10,
    );
    const second = reduceGatewayEvent(
      first,
      {
        type: "approval.request",
        session_id: "s1",
        payload: { prompt_id: "r2", execution_generation: 1, command: "git push", choices: ["once", "deny"] },
      },
      20,
    );

    expect(second.pendingApprovals.map((item) => item.requestId)).toEqual(["r1", "r2"]);
    expect(promptsOf(second).map((item) => item.promptId)).toEqual(["r1", "r2"]);
  });

  it("gateway.disconnected resets streaming sessions to error", () => {
    const streaming = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "message.start", session_id: "s1" },
      10,
    );
    expect(streaming.streamStatus).toBe("streaming");

    const disconnected = reduceGatewayEvent(
      streaming,
      { type: "gateway.disconnected", payload: { message: "connection lost" } },
      20,
    );
    expect(disconnected.streamStatus).toBe("error");
    expect(disconnected.statusMessage).toBe("连接已断开");
    expect(assistantMessage(disconnected).status).toBe("error");
  });

  it("gateway.disconnected marks live tool parts as errored", () => {
    let runtime = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "read-1", name: "read_file", context: "app.tsx" },
      },
      10,
    );
    runtime = reduceGatewayEvent(
      runtime,
      {
        type: "thinking.delta",
        session_id: "s1",
        payload: { text: "ಠ_ಠ deliberating..." },
      },
      15,
    );

    const disconnected = reduceGatewayEvent(
      runtime,
      { type: "gateway.disconnected", payload: { message: "connection lost" } },
      20,
    );

    expect(assistantMessage(disconnected).parts).toEqual([
      expect.objectContaining({ type: "tool", toolCallId: "read-1", state: "error" }),
    ]);
  });

  it("gateway.disconnected leaves idle sessions unchanged", () => {
    const idle = createEmptyChatRuntime(1);
    const result = reduceGatewayEvent(
      idle,
      { type: "gateway.disconnected", payload: { message: "connection lost" } },
      10,
    );
    expect(result).toBe(idle);
  });

  it("shows provider wait status and clears it when output arrives", () => {
    let rt = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "message.start", session_id: "s1" },
      10,
    );

    rt = reduceGatewayEvent(rt, {
      type: "status.update",
      session_id: "s1",
      payload: { kind: "provider_wait", text: "仍在等待模型输出" },
    }, 20);

    expect(rt.statusMessage).toBe("仍在等待模型输出");
    expect(rt.statusKind).toBe("provider_wait");
    expect(rt.statusUpdatedAt).toBe(20);

    rt = reduceGatewayEvent(rt, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "hello" },
    }, 30);

    expect(rt.statusMessage).toBe("");
    expect(rt.statusKind).toBeUndefined();
    expect(rt.statusUpdatedAt).toBeUndefined();
    expect(assistantMessage(rt).parts).toEqual([{ type: "text", text: "hello" }]);
  });
});

describe("full conversation lifecycle", () => {
  it("recovers from mid-stream disconnect and processes new message with a new assistant id", () => {
    let rt = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "message.start", session_id: "s1" },
      10,
    );
    const firstAssistantId = assistantMessage(rt).id;

    rt = reduceGatewayEvent(rt, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "开始" },
    }, 20);

    rt = reduceGatewayEvent(rt, {
      type: "gateway.disconnected",
      payload: { message: "connection lost" },
    }, 30);
    expect(rt.streamStatus).toBe("error");
    expect(assistantMessage(rt).status).toBe("error");

    rt = reduceGatewayEvent(rt, { type: "message.start", session_id: "s1" }, 40);
    expect(rt.streamStatus).toBe("streaming");
    expect(rt.activeAssistantId).toBe("live-assistant-40");

    rt = reduceGatewayEvent(rt, {
      type: "message.complete",
      session_id: "s1",
      payload: { text: "恢复后的回复", status: "complete" },
    }, 50);
    expect(rt.streamStatus).toBe("complete");
    expect(rt.messages.map((message) => message.id)).toContain(firstAssistantId);
    expect(assistantMessage({ ...rt, messages: rt.messages.slice(1) }).parts).toEqual([
      { type: "text", text: "恢复后的回复" },
    ]);
  });

  it("handles reasoning followed by tools and text", () => {
    let rt = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "message.start", session_id: "s1" },
      10,
    );

    rt = reduceGatewayEvent(rt, {
      type: "reasoning.delta",
      session_id: "s1",
      payload: { text: "需要读取文件。" },
    }, 20);

    rt = reduceGatewayEvent(rt, {
      type: "tool.start",
      session_id: "s1",
      payload: { tool_id: "read-1", name: "read_file", context: "config.ts" },
    }, 30);

    rt = reduceGatewayEvent(rt, {
      type: "tool.complete",
      session_id: "s1",
      payload: { tool_id: "read-1", summary: "读取完成" },
    }, 40);

    rt = reduceGatewayEvent(rt, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "根据文件内容，" },
    }, 50);

    rt = reduceGatewayEvent(rt, {
      type: "message.complete",
      session_id: "s1",
      payload: { status: "complete" },
    }, 60);

    expect(assistantMessage(rt).parts.map((part) => part.type)).toEqual([
      "reasoning",
      "tool",
      "text",
    ]);
    expect(assistantMessage(rt).parts[1]).toEqual(
      expect.objectContaining({ type: "tool", state: "done" }),
    );
  });

  it("approval during streaming preserves buffered canonical content", () => {
    let rt = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "message.start", session_id: "s1" },
      10,
    );

    rt = reduceGatewayEvent(rt, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "我需要执行命令。" },
    }, 20);

    rt = reduceGatewayEvent(rt, {
      type: "approval.request",
      session_id: "s1",
      payload: {
        prompt_id: "r1",
        execution_generation: 2,
        command: "rm -rf tmp",
        choices: ["once", "deny"],
      },
    }, 30);

    expect(rt.pendingApprovals).toHaveLength(1);
    expect(assistantMessage(rt).parts).toEqual([{ type: "text", text: "我需要执行命令。" }]);
    expect(rt.streamStatus).toBe("streaming");
  });

  it("error event during streaming errors the row and appends an error card", () => {
    let rt = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "message.start", session_id: "s1" },
      10,
    );

    rt = reduceGatewayEvent(rt, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "partial" },
    }, 20);

    rt = reduceGatewayEvent(rt, {
      type: "error",
      session_id: "s1",
      payload: { message: "rate limit exceeded" },
    }, 30);

    expect(rt.streamStatus).toBe("error");
    expect(rt.statusMessage).toBe("rate limit exceeded");
    expect(assistantMessage(rt).status).toBe("error");
    expect(rt.streamErrorCard).toMatchObject({
      title: "响应失败",
      detail: "rate limit exceeded",
      kind: "other",
    });
    // 真错误不再追加 notice 行：卡片本身就是那张错误卡，避免同一错误两张脸。
    expect(rt.messages.some((message) => message.role === "system")).toBe(false);
  });
});

describe("markStreamsReconnectingAtom", () => {
  it("keeps the in-flight turn alive (transient) instead of erroring it", () => {
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "hi", now: 5 });

    store.set(markStreamsReconnectingAtom);

    const runtime = store.get(chatRuntimeBySessionAtom).s1;
    // status is transient, not terminal
    expect(runtime.streamStatus).toBe("connecting");
    expect(runtime.statusMessage).toBe("连接中断，正在重连…");
    expect(runtime.statusKind).toBe("info");
    // the in-flight message + activeAssistantId survive (not cleared / not error)
    expect(runtime.activeAssistantId).toBe("live-assistant-5");
    expect(assistantMessage(runtime).status).not.toBe("error");
  });

  it("lets a post-reconnect delta resume onto the SAME assistant message", () => {
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "hi", now: 5 });
    store.set(markStreamsReconnectingAtom);

    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      s1: reduceGatewayEvent(
        state.s1,
        { type: "message.delta", session_id: "s1", payload: { text: "world" } },
        10,
      ),
    }));

    const runtime = store.get(chatRuntimeBySessionAtom).s1;
    expect(runtime.activeAssistantId).toBe("live-assistant-5");
    expect(runtime.streamStatus).toBe("streaming");
    expect(textFromParts(assistantMessage(runtime).parts)).toContain("world");
  });

  it("does not touch sessions that are not actively streaming", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      done: { ...createEmptyChatRuntime(), streamStatus: "complete" },
    }));

    store.set(markStreamsReconnectingAtom);

    expect(store.get(chatRuntimeBySessionAtom).done.streamStatus).toBe("complete");
  });
});

describe("startPromptAtom", () => {
  it("adds optimistic user and assistant messages", () => {
    const store = createStore();

    store.set(startPromptAtom, { sessionId: "s1", text: "hello", now: 5 });

    const runtime = store.get(chatRuntimeBySessionAtom).s1;
    expect(runtime.messages).toEqual([
      expect.objectContaining({
        id: "live-user-5",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      }),
      expect.objectContaining({
        id: "live-assistant-5",
        role: "assistant",
        status: "streaming",
        parts: [{ type: "progress", text: "正在唤醒Hermes..." }],
      }),
    ]);
    expect(runtime.activeAssistantId).toBe("live-assistant-5");
    expect(runtime.streamStatus).toBe("streaming");
  });

  it("keeps optimistic progress until the backend emits turn events", () => {
    // The chat store is driven only by gateway events, so an acknowledged
    // prompt without message.* events remains in its optimistic state.
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "hello", now: 5 });

    // The gateway RPC response (raw frame) resolves `prompt.submit`, but no
    // message.start / message.complete events arrive. Nothing in the store
    // clears the optimistic progress.
    const runtime = store.get(chatRuntimeBySessionAtom).s1;
    expect(runtime.streamStatus).toBe("streaming");
    expect(runtime.activeAssistantId).toBe("live-assistant-5");
    expect(assistantMessage(runtime).parts).toEqual([
      { type: "progress", text: "正在唤醒Hermes..." },
    ]);
  });

  it("resolves optimistic progress when Core streams message.start + message.complete", () => {
    // Real Core owns the streamed turn. Applying its events must replace the
    // optimistic progress with the final assistant reply.
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "hello", now: 5 });

    store.set(chatRuntimeBySessionAtom, (state) => {
      let rt = state.s1;
      rt = reduceGatewayEvent(rt, {
        type: "message.start",
        session_id: "s1",
        payload: {},
      }, 6);
      rt = reduceGatewayEvent(rt, {
        type: "message.complete",
        session_id: "s1",
        payload: { text: "真实回复：hello", status: "complete" },
      }, 7);
      return { ...state, s1: rt };
    });

    const runtime = store.get(chatRuntimeBySessionAtom).s1;
    expect(runtime.streamStatus).toBe("complete");
    expect(runtime.activeAssistantId).toBeUndefined();
    expect(runtime.turnStartedAt).toBeUndefined();
    expect(assistantMessage(runtime).status).toBe("complete");
    expect(assistantMessage(runtime).parts).toEqual([
      { type: "text", text: "真实回复：hello" },
    ]);
    expect(assistantMessage(runtime).parts.some((p) => p.type === "progress")).toBe(false);
  });


  it("does not recover from stored reasoning/tools when the stored final text is still missing", () => {
    const store = createStore();

    store.set(startPromptAtom, { sessionId: "s1", text: "总结", now: 1_000 });
    store.set(chatRuntimeBySessionAtom, (state) => {
      let rt = state.s1;
      rt = reduceGatewayEvent(rt, {
        type: "reasoning.delta",
        session_id: "s1",
        payload: { text: "先检查。" },
      }, 1_500);
      rt = reduceGatewayEvent(rt, {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "t1", name: "read", context: "a.txt" },
      }, 1_600);
      rt = reduceGatewayEvent(rt, {
        type: "tool.complete",
        session_id: "s1",
        payload: { tool_id: "t1", summary: "ok" },
      }, 1_700);
      rt = reduceGatewayEvent(rt, {
        type: "message.delta",
        session_id: "s1",
        payload: { text: "最终回答不要消失。" },
      }, 1_800);
      return { ...state, s1: rt };
    });

    store.set(recoverCompletedTurnFromStoredMessagesAtom, {
      sessionId: "s1",
      now: 2_000,
      storedMessages: [
        runtimeMessage({
          id: "stored-no-final-text-yet",
          sessionId: "s1",
          role: "assistant",
          status: "complete",
          createdAt: 1_900,
          parts: [
            { type: "reasoning", text: "先检查。" },
            { type: "tool", toolCallId: "t1", name: "read", state: "done", output: "ok", startedAt: 1_600, completedAt: 1_700 },
          ],
        }),
      ],
    });

    const runtime = store.get(chatRuntimeBySessionAtom).s1;
    expect(runtime.streamStatus).toBe("streaming");
    expect(textFromParts(assistantMessage(runtime).parts)).toBe("最终回答不要消失。");
  });

  it("recovers a stale streaming assistant when stored messages already completed the turn", () => {
    const store = createStore();

    store.set(startPromptAtom, { sessionId: "s1", text: "你是什么模型?", now: 1_000 });
    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      s1: reduceGatewayEvent(
        state.s1,
        {
          type: "message.delta",
          session_id: "s1",
          payload: { text: "我是 MiniMax-M2.7" },
        },
        2_000,
      ),
    }));

    store.set(recoverCompletedTurnFromStoredMessagesAtom, {
      sessionId: "s1",
      now: 3_000,
      storedMessages: [
        runtimeMessage({
          id: "stored-1",
          sessionId: "s1",
          role: "assistant",
          status: "complete",
          createdAt: 2_500,
          parts: [
            {
              type: "text",
              text: "我是 **MiniMax-M2.7**，通过 **minimax-cn** provider 运行的。",
            },
          ],
        }),
      ],
    });

    const runtime = store.get(chatRuntimeBySessionAtom).s1;
    expect(runtime.streamStatus).toBe("complete");
    expect(runtime.activeAssistantId).toBeUndefined();
    expect(runtime.turnStartedAt).toBeUndefined();
    expect(runtime.messages.map((message) => message.id)).toEqual(["live-user-1000"]);
  });
});

describe("terminateAllStreamsAtom", () => {
  it("terminates all streaming and connecting sessions", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, {
      s1: { ...createEmptyChatRuntime(1), streamStatus: "streaming" },
      s2: { ...createEmptyChatRuntime(1), streamStatus: "connecting" },
      s3: createEmptyChatRuntime(1),
      s4: { ...createEmptyChatRuntime(1), streamStatus: "complete" },
      s5: { ...createEmptyChatRuntime(1), streamStatus: "error", statusMessage: "原始错误" },
    });

    store.set(terminateAllStreamsAtom);

    const result = store.get(chatRuntimeBySessionAtom);
    expect(result.s1.streamStatus).toBe("error");
    expect(result.s1.statusMessage).toBe("连接已断开");
    expect(result.s2.streamStatus).toBe("error");
    expect(result.s2.statusMessage).toBe("连接已断开");
    expect(result.s3.streamStatus).toBe("idle");
    expect(result.s4.streamStatus).toBe("complete");
    expect(result.s5.streamStatus).toBe("error");
    expect(result.s5.statusMessage).toBe("原始错误");
  });

  it("returns same reference when nothing to terminate", () => {
    const store = createStore();
    const state = {
      s1: createEmptyChatRuntime(1),
      s2: { ...createEmptyChatRuntime(1), streamStatus: "complete" as const },
    };
    store.set(chatRuntimeBySessionAtom, state);

    store.set(terminateAllStreamsAtom);

    expect(store.get(chatRuntimeBySessionAtom)).toBe(state);
  });
});

describe("drainLiveMessagesAtom", () => {
  it("returns and clears canonical runtime messages from session", () => {
    const store = createStore();
    const messages = [
      runtimeMessage({ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }),
      runtimeMessage({ id: "a1", role: "assistant", parts: [{ type: "text", text: "hello" }] }),
    ];
    store.set(chatRuntimeBySessionAtom, {
      s1: { ...createEmptyChatRuntime(1), messages },
    });

    const drained = store.set(drainLiveMessagesAtom, "s1");
    expect(drained).toEqual(messages);
    expect(store.get(chatRuntimeBySessionAtom).s1.messages).toEqual([]);
  });

  it("returns empty array for unknown session", () => {
    const store = createStore();
    const drained = store.set(drainLiveMessagesAtom, "nonexistent");
    expect(drained).toEqual([]);
  });

  it("retains error notice rows and drops the rest", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, {
      s1: {
        ...createEmptyChatRuntime(1),
        messages: [
          runtimeMessage({ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }),
          runtimeMessage({ id: "a1", role: "assistant", parts: [{ type: "text", text: "hello" }] }),
          runtimeMessage({
            id: "e1",
            role: "system",
            status: "error",
            parts: [{ type: "notice", level: "error", text: "请求失败" }],
          }),
        ],
      },
    });

    const drained = store.set(drainLiveMessagesAtom, "s1");
    expect(drained.map((message) => message.role)).toEqual(["user", "assistant"]);

    const remaining = store.get(chatRuntimeBySessionAtom).s1.messages;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ role: "system", status: "error" });
  });
});

describe("manual interrupt (markSessionInterruptedAtom)", () => {
  function storeWithStreamingTurn() {
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "你好", now: 1_000 });
    store.set(applyGatewayEventAtom, { type: "message.start", session_id: "s1", payload: {} });
    store.set(applyGatewayEventAtom, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "部分回复" },
    });
    return store;
  }

  function runtimeOf(store: ReturnType<typeof createStore>) {
    return store.get(chatRuntimeBySessionAtom).s1;
  }

  it("marks the session idle so the composer can send again", () => {
    const store = storeWithStreamingTurn();

    store.set(markSessionInterruptedAtom, "s1");

    const runtime = runtimeOf(store);
    expect(runtime.streamStatus).toBe("idle");
    expect(runtime.interrupted).toBe(true);
    expect(runtime.activeAssistantId).toBeDefined();
  });

  it("drops late stream events from the interrupted turn", () => {
    const store = storeWithStreamingTurn();
    store.set(markSessionInterruptedAtom, "s1");

    store.set(applyGatewayEventAtom, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "迟到的输出" },
    });
    store.set(applyGatewayEventAtom, {
      type: "tool.start",
      session_id: "s1",
      payload: { id: "t1", name: "shell" },
    });
    store.set(applyGatewayEventAtom, {
      type: "status.update",
      session_id: "s1",
      payload: { text: "处理中" },
    });

    const runtime = runtimeOf(store);
    expect(runtime.streamStatus).toBe("idle");
    expect(runtime.statusMessage).toBe("");
    expect(textFromParts(assistantMessage(runtime).parts)).not.toContain("迟到的输出");
    expect(assistantMessage(runtime).parts.some((part) => part.type === "tool")).toBe(false);
  });

  it("still finalizes the interrupted turn on message.complete", () => {
    const store = storeWithStreamingTurn();
    store.set(markSessionInterruptedAtom, "s1");

    store.set(applyGatewayEventAtom, {
      type: "message.complete",
      session_id: "s1",
      payload: { status: "interrupted", text: "部分回复" },
    });

    const runtime = runtimeOf(store);
    expect(assistantMessage(runtime).status).toBe("complete");
    expect(assistantMessage(runtime).metadata?.finishReason).toBe("interrupted");
    expect(runtime.interrupted).toBeUndefined();
  });

  it("resumes rendering when the next turn starts without a local prompt", () => {
    const store = storeWithStreamingTurn();
    store.set(markSessionInterruptedAtom, "s1");

    store.set(applyGatewayEventAtom, { type: "message.start", session_id: "s1", payload: {} });
    store.set(applyGatewayEventAtom, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "新回合" },
    });

    const runtime = runtimeOf(store);
    expect(runtime.interrupted).toBeUndefined();
    expect(runtime.streamStatus).toBe("streaming");
  });

  it("clears the interrupt gate when the user sends the next prompt", () => {
    const store = storeWithStreamingTurn();
    store.set(markSessionInterruptedAtom, "s1");

    store.set(startPromptAtom, { sessionId: "s1", text: "再来", now: 2_000 });

    expect(runtimeOf(store).interrupted).toBeUndefined();
  });

  it("keeps resetStreamStateAtom free of interrupt semantics (sendPrompt busy-retry path)", () => {
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "你好", now: 1_000 });

    store.set(resetStreamStateAtom, "s1");
    store.set(applyGatewayEventAtom, { type: "message.start", session_id: "s1", payload: {} });
    store.set(applyGatewayEventAtom, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "重试回合" },
    });

    const runtime = runtimeOf(store);
    expect(runtime.streamStatus).toBe("streaming");
    const assistants = runtime.messages.filter((message) => message.role === "assistant");
    expect(textFromParts(assistants[assistants.length - 1].parts)).toContain("重试回合");
  });
});

describe("lastActivityAt (stall watchdog source)", () => {
  it("stamps lastActivityAt with the event time for applied backend events", () => {
    const base = createEmptyChatRuntime(0);
    const started = reduceGatewayEvent(base, { type: "message.start", session_id: "s1" }, 1_000);
    expect(started.lastActivityAt).toBe(1_000);

    const delta = reduceGatewayEvent(
      started,
      { type: "message.delta", session_id: "s1", payload: { text: "hi" } },
      2_500,
    );
    expect(delta.lastActivityAt).toBe(2_500);
  });

  it("does not advance lastActivityAt for dropped late events on an interrupted turn", () => {
    const interrupted = {
      ...createEmptyChatRuntime(0),
      streamStatus: "streaming" as const,
      interrupted: true,
      lastActivityAt: 1_000,
    };
    // A late stream delta from the interrupted turn is dropped (no-op) — it must
    // not count as activity, otherwise an interrupted-but-noisy turn would keep
    // resetting the watchdog.
    const next = reduceGatewayEvent(
      interrupted,
      { type: "message.delta", session_id: "s1", payload: { text: "late" } },
      9_000,
    );
    expect(next).toBe(interrupted);
    expect(next.lastActivityAt).toBe(1_000);
  });

  it("appends moa.reference blocks and keeps them ordered before the aggregator text", () => {
    const ref1 = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "moa.reference",
        session_id: "s1",
        payload: { label: "gpt-5", text: "GPT 的分析", index: 0, count: 2 },
      },
      10,
    );
    expect(ref1.statusKind).toBe("moa_reference");
    expect(ref1.statusMessage).toContain("gpt-5");
    expect(ref1.statusMessage).toContain("1/2");

    const ref2 = reduceGatewayEvent(
      ref1,
      {
        type: "moa.reference",
        session_id: "s1",
        payload: { label: "claude", text: "Claude 的分析", index: 1, count: 2 },
      },
      20,
    );

    const aggregating = reduceGatewayEvent(
      ref2,
      { type: "moa.aggregating", session_id: "s1", payload: { aggregator: "grok-4" } },
      30,
    );
    expect(aggregating.statusKind).toBe("moa_aggregating");
    expect(aggregating.statusMessage).toContain("grok-4");

    const answered = reduceGatewayEvent(
      aggregating,
      { type: "message.delta", session_id: "s1", payload: { text: "综合结论" } },
      40,
    );
    // 聚合器开始输出后，MoA 状态提示被 provider-status 清除逻辑收走。
    expect(answered.statusKind).toBeUndefined();
    expect(assistantMessage(answered).parts).toEqual([
      { type: "moa_reference", label: "gpt-5", text: "GPT 的分析", index: 0, count: 2 },
      { type: "moa_reference", label: "claude", text: "Claude 的分析", index: 1, count: 2 },
      { type: "text", text: "综合结论" },
    ]);
  });

  it("ignores empty moa.reference payloads and keeps thinking placeholders working", () => {
    const noop = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "moa.reference", session_id: "s1", payload: {} },
      10,
    );
    expect(noop.messages).toHaveLength(0);

    // 回归守卫：thinking.delta 仍走 reasoning.delta 的 fallthrough（历史上
    // 在两者之间插分支会截胡 fallthrough）。
    const placeholder = "ಠ_ಠ deliberating...";
    const thinking = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "thinking.delta", session_id: "s1", payload: { text: placeholder } },
      10,
    );
    expect(assistantMessage(thinking).parts).toEqual([{ type: "progress", text: placeholder }]);
  });

  describe("empty message.delta should not create messages", () => {
    it("message.delta with empty text should NOT create a new assistant message when no turn is active", () => {
      // Simulate the real bug: backend emits empty-string deltas during
      // reasoning-to-content transitions, WITHOUT a preceding message.start.
      const now = 1000;
      let runtime = createEmptyChatRuntime(now);
      const messageCountBefore = runtime.messages.length;

      // Send an empty delta — this should be a no-op
      runtime = reduceGatewayEvent(
        runtime,
        {
          type: "message.delta",
          session_id: "s1",
          payload: { text: "" },
        },
        now + 1,
      );

      const messageCountAfter = runtime.messages.length;

      // without the fix, empty delta creates an assistant message with parts: []
      expect(messageCountAfter).toBe(messageCountBefore);
    });

    it("message.delta with real text should create an assistant message normally", () => {
      const now = 1000;
      let runtime = createEmptyChatRuntime(now);

      runtime = reduceGatewayEvent(
        runtime,
        {
          type: "message.delta",
          session_id: "s1",
          payload: { text: "Hello, world!" },
        },
        now + 1,
      );

      const assistant = runtime.messages.find((m) => m.role === "assistant");
      expect(assistant).toBeDefined();
      expect(assistant!.parts.length).toBeGreaterThan(0);
      const text = textFromParts(assistant!.parts);
      expect(text).toBe("Hello, world!");
    });

    it("message.complete removes empty assistant message (existing safety)", () => {
      const now = 1000;
      let runtime = createEmptyChatRuntime(now);
      runtime = reduceGatewayEvent(
        runtime,
        {
          type: "message.start",
          session_id: "s1",
        },
        now,
      );
      // Complete with empty text and no reasoning — parts.length === 0 → removed
      runtime = reduceGatewayEvent(
        runtime,
        {
          type: "message.complete",
          session_id: "s1",
          payload: { text: "" },
        },
        now + 1,
      );

      // Should have no assistant message after complete with empty parts
      const assistants = runtime.messages.filter((m) => m.role === "assistant");
      expect(assistants).toHaveLength(0);
    });
  });
});

describe("global prompts", () => {
  const approvalEvent = (promptId: string, generation = 1) => ({
    type: "approval.request",
    session_id: "s1",
    payload: {
      kind: "approval",
      prompt_id: promptId,
      execution_generation: generation,
      command: "rm -rf build",
      description: "删除构建产物",
      choices: ["once", "deny"],
    },
  });

  const clarifyEvent = (promptId: string, generation = 1) => ({
    type: "clarify.request",
    session_id: "s1",
    payload: {
      kind: "clarify",
      prompt_id: promptId,
      execution_generation: generation,
      question: "先做前端还是后端？",
      choices: ["前端", "后端"],
      multi_select: false,
    },
  });

  it("reduces an approval.request into pendingPrompts and the legacy projection", () => {
    const rt = reduceGatewayEvent(createEmptyChatRuntime(1), approvalEvent("p1") as any, 10);
    expect(promptsOf(rt)).toEqual([
      expect.objectContaining({
        kind: "approval",
        promptId: "p1",
        generation: 1,
        sessionId: "s1",
        command: "rm -rf build",
        description: "删除构建产物",
        choices: ["once", "deny"],
        receivedAt: 10,
      }),
    ]);
    expect(rt.pendingApprovals).toEqual([
      { requestId: "p1", sessionId: "s1", command: "rm -rf build", reason: "删除构建产物" },
    ]);
  });

  it("reduces a clarify.request without polluting the approval projection", () => {
    const rt = reduceGatewayEvent(createEmptyChatRuntime(1), clarifyEvent("q1") as any, 10);
    expect(promptsOf(rt)).toEqual([
      expect.objectContaining({
        kind: "clarify",
        promptId: "q1",
        question: "先做前端还是后端？",
        choices: ["前端", "后端"],
        multiSelect: false,
      }),
    ]);
    expect(rt.pendingApprovals).toEqual([]);
  });

  it("ignores a prompt event whose payload has no prompt_id", () => {
    const rt = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "approval.request", session_id: "s1", payload: { request_id: "legacy" } } as any,
      10,
    );
    expect(promptsOf(rt)).toEqual([]);
  });

  it("removes a prompt on approval.settled / clarify.settled by prompt_id", () => {
    let rt = reduceGatewayEvent(createEmptyChatRuntime(1), approvalEvent("p1") as any, 10);
    rt = reduceGatewayEvent(rt, clarifyEvent("q1") as any, 20);
    expect(promptsOf(rt)).toHaveLength(2);

    rt = reduceGatewayEvent(
      rt,
      { type: "approval.settled", session_id: "s1", payload: { prompt_id: "p1", execution_generation: 1 } } as any,
      30,
    );
    expect(promptsOf(rt).map((item) => item.promptId)).toEqual(["q1"]);

    rt = reduceGatewayEvent(
      rt,
      { type: "clarify.settled", session_id: "s1", payload: { prompt_id: "q1", execution_generation: 1 } } as any,
      40,
    );
    expect(promptsOf(rt)).toEqual([]);
  });

  it("does not replace a newer prompt with the same id twice", () => {
    let rt = reduceGatewayEvent(createEmptyChatRuntime(1), approvalEvent("p1") as any, 10);
    rt = reduceGatewayEvent(rt, approvalEvent("p1") as any, 20);
    expect(promptsOf(rt)).toHaveLength(1);
    expect(promptsOf(rt)[0].receivedAt).toBe(20);
  });

  it("aggregates pendingPromptsAtom across sessions oldest first", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, {
      s2: reduceGatewayEvent(createEmptyChatRuntime(1), {
        ...clarifyEvent("q2"),
        session_id: "s2",
      } as any, 50),
      s1: reduceGatewayEvent(createEmptyChatRuntime(1), approvalEvent("p1") as any, 10),
    });
    expect(store.get(pendingPromptsAtom).map((item) => item.promptId)).toEqual(["p1", "q2"]);
  });

  it("drops a prompt with removePromptAtom and keeps the compat projection in sync", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, {
      s1: reduceGatewayEvent(createEmptyChatRuntime(1), approvalEvent("p1") as any, 10),
    });
    store.set(removePromptAtom, { sessionId: "s1", promptId: "p1" });
    expect(store.get(pendingPromptsAtom)).toEqual([]);
    expect(store.get(chatRuntimeBySessionAtom).s1.pendingApprovals).toEqual([]);
  });
});

function snapshotTurnMessages(assistantText: string, assistantCreatedAt = 1_000): HermesUIMessage[] {
  return [
    runtimeMessage({
      id: "stored-user-1",
      role: "user",
      createdAt: assistantCreatedAt - 100,
      parts: [{ type: "text", text: "读一下配置" }],
    }),
    runtimeMessage({
      id: "stored-assistant-2",
      createdAt: assistantCreatedAt,
      parts: [
        {
          type: "tool",
          toolCallId: "t1",
          name: "read",
          state: "done",
          output: "ok",
          startedAt: 1_100,
          completedAt: 1_200,
        },
        { type: "text", text: assistantText },
      ],
    }),
  ];
}

function assistantMessages(runtime: ReturnType<typeof createEmptyChatRuntime>): HermesUIMessage[] {
  return runtime.messages.filter((message) => message.role === "assistant");
}

describe("hydrateSessionTimelineAtom vs late stream frames", () => {
  it("keeps one assistant bubble when a delta lands after the resume snapshot replaced the timeline", () => {
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "读一下配置", now: 1_000 });
    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      s1: reduceGatewayEvent(
        state.s1,
        { type: "message.delta", session_id: "s1", payload: { text: "我先读文件" } },
        1_300,
      ),
    }));

    store.set(hydrateSessionTimelineAtom, {
      sessionId: "s1",
      messages: snapshotTurnMessages("我先读文件"),
      running: true,
    });
    expect(store.get(chatRuntimeBySessionAtom).s1.activeAssistantId).toBe("live-assistant-1000");
    expect(
      store.get(chatRuntimeBySessionAtom).s1.messages.map((message) => message.id),
    ).toEqual(["stored-user-1", "live-assistant-1000"]);

    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      s1: reduceGatewayEvent(
        state.s1,
        { type: "message.delta", session_id: "s1", payload: { text: "，再看结论" } },
        2_000,
      ),
    }));

    const runtime = store.get(chatRuntimeBySessionAtom).s1;
    expect(assistantMessages(runtime)).toHaveLength(1);
    expect(textFromParts(assistantMessages(runtime)[0].parts)).toBe("我先读文件，再看结论");
    expect(runtime.streamStatus).toBe("streaming");
  });

  it("does not spawn a second assistant when message.complete arrives after the snapshot already holds the turn", () => {
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "读一下配置", now: 1_000 });
    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      s1: reduceGatewayEvent(
        state.s1,
        { type: "message.delta", session_id: "s1", payload: { text: "我先读文件" } },
        1_300,
      ),
    }));

    store.set(hydrateSessionTimelineAtom, {
      sessionId: "s1",
      messages: snapshotTurnMessages("我先读文件，再看结论"),
      running: true,
    });

    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      s1: reduceGatewayEvent(
        state.s1,
        {
          type: "message.complete",
          session_id: "s1",
          payload: { text: "我先读文件，再看结论" },
        },
        2_000,
      ),
    }));

    const runtime = store.get(chatRuntimeBySessionAtom).s1;
    expect(assistantMessages(runtime)).toHaveLength(1);
    expect(assistantMessages(runtime)[0].status).toBe("complete");
    expect(textFromParts(assistantMessages(runtime)[0].parts)).toBe("我先读文件，再看结论");
    expect(runtime.streamStatus).toBe("complete");
  });

  it("does not fold a completed snapshot row into a live turn that has no text yet", () => {
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "读一下配置", now: 100_000 });

    store.set(hydrateSessionTimelineAtom, {
      sessionId: "s1",
      messages: snapshotTurnMessages("上一回合的完整回答"),
      running: true,
    });

    const runtime = store.get(chatRuntimeBySessionAtom).s1;
    expect(assistantMessages(runtime).map((message) => message.id)).toEqual(["stored-assistant-2"]);
    expect(assistantMessages(runtime)[0].status).toBe("complete");
    expect(runtime.activeAssistantId).toBeUndefined();
  });

  it("keeps a completed assistant row from the previous turn untouched when the next turn streams", () => {
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "第一问", now: 1_000 });
    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      s1: reduceGatewayEvent(
        state.s1,
        { type: "message.delta", session_id: "s1", payload: { text: "第一答" } },
        1_200,
      ),
    }));
    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      s1: reduceGatewayEvent(
        state.s1,
        { type: "message.complete", session_id: "s1", payload: { text: "第一答" } },
        1_400,
      ),
    }));

    store.set(startPromptAtom, { sessionId: "s1", text: "第二问", now: 9_000 });
    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      s1: reduceGatewayEvent(
        state.s1,
        { type: "message.delta", session_id: "s1", payload: { text: "第二答" } },
        9_200,
      ),
    }));

    const runtime = store.get(chatRuntimeBySessionAtom).s1;
    const assistants = assistantMessages(runtime);
    expect(assistants).toHaveLength(2);
    expect(assistants[0].id).toBe("live-assistant-1000");
    expect(assistants[0].status).toBe("complete");
    expect(textFromParts(assistants[0].parts)).toBe("第一答");
    expect(assistants[1].id).toBe("live-assistant-9000");
    expect(textFromParts(assistants[1].parts)).toBe("第二答");
  });

  it("collapses streamed reasoning segments instead of writing the whole reasoning into the first part", () => {
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "想一想", now: 1_000 });
    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      s1: reduceGatewayEvent(
        state.s1,
        { type: "message.start", session_id: "s1", payload: {} },
        1_050,
      ),
    }));
    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      s1: reduceGatewayEvent(
        state.s1,
        { type: "reasoning.delta", session_id: "s1", payload: { text: "第一段。" } },
        1_100,
      ),
    }));
    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      s1: reduceGatewayEvent(
        state.s1,
        { type: "message.delta", session_id: "s1", payload: { text: "看下工具" } },
        1_200,
      ),
    }));
    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      s1: reduceGatewayEvent(
        state.s1,
        { type: "reasoning.delta", session_id: "s1", payload: { text: "第二段。" } },
        1_300,
      ),
    }));
    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      s1: reduceGatewayEvent(
        state.s1,
        {
          type: "message.complete",
          session_id: "s1",
          payload: { text: "看下工具最终答案", reasoning: "第一段。第二段。" },
        },
        1_400,
      ),
    }));

    const parts = assistantMessages(store.get(chatRuntimeBySessionAtom).s1)[0].parts;
    const reasoningParts = parts.filter((part) => part.type === "reasoning");
    expect(reasoningParts).toHaveLength(1);
    const reasoningText = reasoningParts
      .map((part) => (part.type === "reasoning" ? part.text : ""))
      .join("");
    expect(reasoningText).toBe("第一段。第二段。");
  });

  it("still renders a single assistant bubble for a normal turn with no reconnect", () => {
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "读一下配置", now: 1_000 });
    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      s1: reduceGatewayEvent(
        state.s1,
        { type: "message.start", session_id: "s1", payload: {} },
        1_100,
      ),
    }));
    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      s1: reduceGatewayEvent(
        state.s1,
        { type: "message.delta", session_id: "s1", payload: { text: "先读文件" } },
        1_200,
      ),
    }));
    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      s1: reduceGatewayEvent(
        state.s1,
        { type: "message.delta", session_id: "s1", payload: { text: "，再看结论" } },
        1_300,
      ),
    }));
    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      s1: reduceGatewayEvent(
        state.s1,
        { type: "message.complete", session_id: "s1", payload: { text: "先读文件，再看结论" } },
        1_400,
      ),
    }));

    const runtime = store.get(chatRuntimeBySessionAtom).s1;
    expect(assistantMessages(runtime)).toHaveLength(1);
    expect(textFromParts(assistantMessages(runtime)[0].parts)).toBe("先读文件，再看结论");
    expect(runtime.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });
});

describe("断流错误的自动撤回", () => {
  type Runtime = ReturnType<typeof createEmptyChatRuntime>;

  function noticeMessages(runtime: Runtime): HermesUIMessage[] {
    return runtime.messages.filter(
      (message) =>
        message.role === "system" &&
        message.parts.some((part) => part.type === "notice"),
    );
  }

  function streamingTurnWithError(store: ReturnType<typeof createStore>, reconnecting: boolean) {
    store.set(chatRuntimeBySessionAtom, { s1: createEmptyChatRuntime(1) });
    store.set(applyGatewayEventAtom, { type: "message.start", session_id: "s1" });
    store.set(applyGatewayEventAtom, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "先给一半" },
    });
    if (reconnecting) store.set(markStreamsReconnectingAtom);
    store.set(applyGatewayEventAtom, {
      type: "error",
      session_id: "s1",
      payload: { message: "网关连接中断" },
    });
  }

  it("断流打出的错误提示在同回合 delta 到达时降级为「已自动恢复」", () => {
    const store = createStore();
    streamingTurnWithError(store, true);

    const errored = store.get(chatRuntimeBySessionAtom).s1;
    expect(errored.streamStatus).toBe("error");
    expect(noticeMessages(errored)).toEqual([
      expect.objectContaining({
        status: "error",
        parts: [{ type: "notice", level: "error", text: "网关连接中断" }],
      }),
    ]);

    store.set(applyGatewayEventAtom, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "，接着说完" },
    });

    const recovered = store.get(chatRuntimeBySessionAtom).s1;
    expect(noticeMessages(recovered)).toEqual([
      expect.objectContaining({
        status: "complete",
        parts: [{ type: "notice", level: "info", text: "连接中断，已自动恢复，本轮输出继续" }],
      }),
    ]);
    expect(recovered.streamStatus).toBe("streaming");
    expect(recovered.recoverableErrorNoticeId).toBeUndefined();
  });

  it("非断流的真错误不会被随后的 delta 吞掉", () => {
    const store = createStore();
    streamingTurnWithError(store, false);

    store.set(applyGatewayEventAtom, {
      type: "error",
      session_id: "s1",
      payload: { message: "API key invalid (401)" },
    });
    store.set(applyGatewayEventAtom, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "重试之后又出来的内容" },
    });

    const runtime = store.get(chatRuntimeBySessionAtom).s1;
    expect(runtime.streamErrorCard?.detail).toBe("API key invalid (401)");
    expect(noticeMessages(runtime).filter((message) => message.status === "error")).toEqual([]);
  });

  it("session.resume 成功（settle atom）同样撤回断流提示", () => {
    const store = createStore();
    streamingTurnWithError(store, true);

    store.set(settleRecoveredStreamErrorAtom, "s1");

    const runtime = store.get(chatRuntimeBySessionAtom).s1;
    expect(noticeMessages(runtime)).toEqual([
      expect.objectContaining({
        status: "complete",
        parts: [{ type: "notice", level: "info", text: "连接中断，已自动恢复，本轮输出继续" }],
      }),
    ]);
  });

  it("新回合的 delta 不会替上一轮的断流错误洗白", () => {
    const store = createStore();
    streamingTurnWithError(store, true);

    store.set(startPromptAtom, { sessionId: "s1", text: "换个问法再试" });
    store.set(applyGatewayEventAtom, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "新回合的回答" },
    });

    const runtime = store.get(chatRuntimeBySessionAtom).s1;
    expect(
      noticeMessages(runtime).filter((message) => message.status === "error"),
    ).toHaveLength(1);
  });
});

describe("断线恢复后的状态收敛", () => {
  type Runtime = ReturnType<typeof createEmptyChatRuntime>;

  function killedTurnSnapshot(): HermesUIMessage[] {
    return [
      runtimeMessage({
        id: "stored-user-kill",
        role: "user",
        createdAt: 900,
        parts: [{ type: "text", text: "跑 sleep 90; echo alive" }],
      }),
      runtimeMessage({
        id: "stored-assistant-kill",
        createdAt: 1_000,
        status: "complete",
        parts: [
          {
            type: "tool",
            toolCallId: "call-sleep-90",
            name: "terminal",
            state: "running",
            input: { command: "sleep 90; echo alive" },
            startedAt: 1_050,
          },
        ],
      }),
    ];
  }

  function toolPartsOf(runtime: Runtime): Extract<HermesMessagePart, { type: "tool" }>[] {
    return runtime.messages.flatMap((message) =>
      message.parts.filter(
        (part): part is Extract<HermesMessagePart, { type: "tool" }> => part.type === "tool",
      ),
    );
  }

  function notices(runtime: Runtime): Extract<HermesMessagePart, { type: "notice" }>[] {
    return runtime.messages.flatMap((message) =>
      message.parts.filter(
        (part): part is Extract<HermesMessagePart, { type: "notice" }> => part.type === "notice",
      ),
    );
  }

  function liveTurnWithRunningTool(store: ReturnType<typeof createStore>) {
    store.set(chatRuntimeBySessionAtom, { s1: createEmptyChatRuntime(1) });
    store.set(applyGatewayEventAtom, { type: "message.start", session_id: "s1" });
    store.set(applyGatewayEventAtom, {
      type: "tool.start",
      session_id: "s1",
      payload: { tool_id: "call-sleep-90", name: "terminal", context: "sleep 90" },
    });
    store.set(applyGatewayEventAtom, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "我先跑这条命令" },
    });
  }

  it("内核被杀只有 TCP 断开时，断线事件仍留下可收敛的标记（不再依赖 error 帧）", () => {
    const store = createStore();
    liveTurnWithRunningTool(store);

    store.set(markStreamsReconnectingAtom);

    const runtime = store.get(chatRuntimeBySessionAtom).s1!;
    expect(runtime.pendingDisconnectNotice).toBe(true);
    expect(runtime.streamStatus).toBe("connecting");
    expect(runtime.statusMessage).toBe("连接中断，正在重连…");
    expect(runtime.activeAssistantId).toBeDefined();
    expect(notices(runtime)).toHaveLength(0);
  });

  it("重连后 running=false：幽灵运行卡收敛成中断态，活跃回合与计时器一起清空", () => {
    const store = createStore();
    liveTurnWithRunningTool(store);
    store.set(markStreamsReconnectingAtom);

    store.set(hydrateSessionTimelineAtom, {
      sessionId: "s1",
      messages: killedTurnSnapshot(),
      running: false,
    });

    const runtime = store.get(chatRuntimeBySessionAtom).s1!;
    expect(toolPartsOf(runtime)).toEqual([
      expect.objectContaining({ toolCallId: "call-sleep-90", state: "error" }),
    ]);
    expect(runtime.activeAssistantId).toBeUndefined();
    expect(runtime.turnStartedAt).toBeUndefined();
    expect(runtime.turnFirstTokenAt).toBeUndefined();
    expect(runtime.streamStatus).toBe("idle");
    expect(runtime.pendingDisconnectNotice).toBeUndefined();
  });

  it("重连且这一轮已经断了：补一张灰色「已中断」卡，不冒充红色错误", () => {
    const store = createStore();
    liveTurnWithRunningTool(store);
    store.set(markStreamsReconnectingAtom);

    store.set(hydrateSessionTimelineAtom, {
      sessionId: "s1",
      messages: killedTurnSnapshot(),
      running: false,
    });

    const runtime = store.get(chatRuntimeBySessionAtom).s1!;
    expect(notices(runtime)).toEqual([
      { type: "notice", level: "info", text: "连接已恢复，但上一轮已被中断，输出可能不完整" },
    ]);
    expect(
      runtime.messages.filter((message) => message.role === "system" && message.status === "error"),
    ).toHaveLength(0);
  });

  it("重连且这一轮还活着：保留回合与工具，灰卡说明输出继续", () => {
    const store = createStore();
    liveTurnWithRunningTool(store);
    store.set(markStreamsReconnectingAtom);

    store.set(hydrateSessionTimelineAtom, {
      sessionId: "s1",
      messages: snapshotTurnMessages("我先跑这条命令"),
      running: true,
    });

    const runtime = store.get(chatRuntimeBySessionAtom).s1!;
    expect(notices(runtime)).toEqual([
      { type: "notice", level: "info", text: "连接中断，已自动恢复，本轮输出继续" },
    ]);
    expect(runtime.streamStatus).toBe("streaming");
    expect(runtime.activeAssistantId).toBeDefined();
    expect(toolPartsOf(runtime).filter((part) => part.state === "error")).toHaveLength(0);
  });

  it("收敛之后迟到的 tool.complete 仍把那张卡覆盖回完成态，且不新增气泡", () => {
    const store = createStore();
    liveTurnWithRunningTool(store);
    store.set(markStreamsReconnectingAtom);
    store.set(hydrateSessionTimelineAtom, {
      sessionId: "s1",
      messages: killedTurnSnapshot(),
      running: false,
    });
    const before = store.get(chatRuntimeBySessionAtom).s1!;
    expect(assistantMessages(before)).toHaveLength(1);

    store.set(applyGatewayEventAtom, {
      type: "tool.complete",
      session_id: "s1",
      payload: {
        tool_id: "call-sleep-90",
        name: "terminal",
        result: { output: "alive", exit_code: 0 },
        duration_s: 90,
      },
    });

    const runtime = store.get(chatRuntimeBySessionAtom).s1!;
    expect(assistantMessages(runtime)).toHaveLength(1);
    expect(toolPartsOf(runtime)).toEqual([
      expect.objectContaining({ toolCallId: "call-sleep-90", state: "done" }),
    ]);
  });

  it("真实的 error 帧不会被灰卡洗白（没有断线标记就不降级）", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, { s1: createEmptyChatRuntime(1) });
    store.set(applyGatewayEventAtom, { type: "message.start", session_id: "s1" });
    store.set(applyGatewayEventAtom, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "先说一半" },
    });
    store.set(applyGatewayEventAtom, {
      type: "error",
      session_id: "s1",
      payload: { message: "API key invalid (401)" },
    });

    store.set(hydrateSessionTimelineAtom, {
      sessionId: "s1",
      messages: snapshotTurnMessages("先说一半"),
      running: false,
    });

    const runtime = store.get(chatRuntimeBySessionAtom).s1!;
    expect(notices(runtime).filter((part) => part.level === "info")).toHaveLength(0);
    expect(runtime.recoverableErrorNoticeId).toBeUndefined();
    expect(runtime.settledDisconnectNotice).toBeUndefined();
  });

  it("同一次断线只补一张灰卡：重复 hydrate 不再追加提示", () => {
    const store = createStore();
    liveTurnWithRunningTool(store);
    store.set(markStreamsReconnectingAtom);
    store.set(hydrateSessionTimelineAtom, {
      sessionId: "s1",
      messages: killedTurnSnapshot(),
      running: false,
    });
    store.set(hydrateSessionTimelineAtom, {
      sessionId: "s1",
      messages: killedTurnSnapshot(),
      running: false,
    });

    expect(notices(store.get(chatRuntimeBySessionAtom).s1!)).toHaveLength(1);
  });
});

describe("内核自动续跑的提示", () => {
  const AUTO_CONTINUED_TEXT = "内核已自动续跑被中断的本轮，已执行的命令可能重复";

  function killedTurnSnapshot(): HermesUIMessage[] {
    return [
      runtimeMessage({
        id: "stored-user-kill",
        role: "user",
        createdAt: 900,
        parts: [{ type: "text", text: "跑 sleep 90; echo alive" }],
      }),
      runtimeMessage({
        id: "stored-assistant-kill",
        createdAt: 1_000,
        parts: [
          {
            type: "tool",
            toolCallId: "call-sleep-90",
            name: "terminal",
            state: "running",
            input: { command: "sleep 90; echo alive" },
            startedAt: 1_050,
          },
        ],
      }),
    ];
  }

  function autoContinuedNotices(runtime: ReturnType<typeof createEmptyChatRuntime>) {
    return runtime.messages.flatMap((message) =>
      message.parts.filter(
        (part): part is Extract<HermesMessagePart, { type: "notice" }> =>
          part.type === "notice" && part.text === AUTO_CONTINUED_TEXT,
      ),
    );
  }

  it("resume 带 auto_continue：补一条中性提示，重复 hydrate 也只有一条", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, { s1: createEmptyChatRuntime(1) });

    store.set(hydrateSessionTimelineAtom, {
      sessionId: "s1",
      messages: killedTurnSnapshot(),
      running: false,
      autoContinue: true,
    });
    store.set(hydrateSessionTimelineAtom, {
      sessionId: "s1",
      messages: killedTurnSnapshot(),
      running: false,
      autoContinue: true,
    });

    const runtime = store.get(chatRuntimeBySessionAtom).s1!;
    expect(autoContinuedNotices(runtime)).toEqual([
      { type: "notice", level: "info", text: AUTO_CONTINUED_TEXT },
    ]);
    expect(
      runtime.messages.filter((message) => message.role === "system" && message.status === "error"),
    ).toHaveLength(0);
  });

  it("resume 没带 auto_continue：时间线零变化", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, { s1: createEmptyChatRuntime(1) });

    store.set(hydrateSessionTimelineAtom, {
      sessionId: "s1",
      messages: killedTurnSnapshot(),
      running: false,
    });

    const runtime = store.get(chatRuntimeBySessionAtom).s1!;
    expect(autoContinuedNotices(runtime)).toHaveLength(0);
    expect(runtime.messages.filter((message) => message.role === "system")).toHaveLength(0);

    store.set(noteAutoContinuedTurnAtom, { sessionId: "s1", autoContinue: false });
    expect(store.get(chatRuntimeBySessionAtom).s1!.messages).toHaveLength(
      runtime.messages.length,
    );
  });

  it("新回合不残留：上一轮的续跑提示不会在新回合里再插一条", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, { s1: createEmptyChatRuntime(1) });
    store.set(hydrateSessionTimelineAtom, {
      sessionId: "s1",
      messages: killedTurnSnapshot(),
      running: false,
      autoContinue: true,
    });

    store.set(startPromptAtom, { sessionId: "s1", text: "换个问法" });
    store.set(noteAutoContinuedTurnAtom, { sessionId: "s1", autoContinue: true });
    store.set(hydrateSessionTimelineAtom, {
      sessionId: "s1",
      messages: killedTurnSnapshot(),
      running: false,
      autoContinue: true,
    });

    const runtime = store.get(chatRuntimeBySessionAtom).s1!;
    expect(autoContinuedNotices(runtime)).toHaveLength(1);
    expect(
      runtime.messages.filter((message) => message.role === "system" && message.status === "error"),
    ).toHaveLength(0);
  });

  it("noteAutoContinuedTurnAtom 直接调用：带 autoContinue 才出提示", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, { s1: createEmptyChatRuntime(1) });

    store.set(noteAutoContinuedTurnAtom, { sessionId: "s1" });
    expect(store.get(chatRuntimeBySessionAtom).s1!.messages).toHaveLength(0);

    store.set(noteAutoContinuedTurnAtom, { sessionId: "s1", autoContinue: true });
    store.set(noteAutoContinuedTurnAtom, { sessionId: "s1", autoContinue: true });
    const runtime = store.get(chatRuntimeBySessionAtom).s1!;
    expect(autoContinuedNotices(runtime)).toHaveLength(1);
  });
});

describe("resume 接管：内核重启换了运行时 session_id", () => {
  const INTERRUPTED_TEXT = "连接已恢复，但上一轮已被中断，输出可能不完整";
  const AUTO_CONTINUED_TEXT = "内核已自动续跑被中断的本轮，已执行的命令可能重复";

  function streamingRuntime() {
    return {
      ...createEmptyChatRuntime(1),
      streamStatus: "streaming" as const,
      pendingDisconnectNotice: true,
      messages: [
        runtimeMessage({
          id: "live-assistant",
          createdAt: 1_000,
          status: "streaming",
          parts: [{ type: "text" as const, text: "开始跑命令" }],
        }),
      ],
    };
  }

  function noticesOf(runtime: ReturnType<typeof createEmptyChatRuntime>) {
    return runtime.messages.flatMap((message) =>
      message.parts.filter(
        (part): part is Extract<HermesMessagePart, { type: "notice" }> => part.type === "notice",
      ),
    );
  }

  it("断线标记从旧 id 搬到新 id，并在新 id 上补出灰卡", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, { "rt-old": streamingRuntime() });

    store.set(adoptResumedSessionAtom, {
      fromSessionId: "rt-old",
      toSessionId: "rt-new",
      running: false,
    });

    const state = store.get(chatRuntimeBySessionAtom);
    expect(state["rt-old"]?.pendingDisconnectNotice).toBeUndefined();
    expect(state["rt-new"]?.pendingDisconnectNotice).toBeUndefined();
    expect(noticesOf(state["rt-new"]!)).toEqual([
      { type: "notice", level: "info", text: INTERRUPTED_TEXT },
    ]);
    expect(state["rt-new"]?.streamStatus).toBe("idle");
  });

  it("带 auto_continue 时不重复提示：只留一条续跑提示", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, { "rt-old": streamingRuntime() });

    store.set(adoptResumedSessionAtom, {
      fromSessionId: "rt-old",
      toSessionId: "rt-new",
      running: false,
      autoContinue: true,
    });
    store.set(adoptResumedSessionAtom, {
      fromSessionId: "rt-new",
      toSessionId: "rt-new",
      running: false,
      autoContinue: true,
    });

    const runtime = store.get(chatRuntimeBySessionAtom)["rt-new"]!;
    expect(noticesOf(runtime)).toEqual([
      { type: "notice", level: "info", text: AUTO_CONTINUED_TEXT },
    ]);
  });

  it("没有断线标记时接管不动时间线", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, { "rt-old": createEmptyChatRuntime(1) });

    store.set(adoptResumedSessionAtom, {
      fromSessionId: "rt-old",
      toSessionId: "rt-new",
      running: false,
    });

    const state = store.get(chatRuntimeBySessionAtom);
    expect(noticesOf(state["rt-new"]!)).toHaveLength(0);
  });
});
describe("回合不变式：只有当前回合的工具卡可以保持 running", () => {
  const INTERRUPTED_TOOL_TEXT = "已中断，未拿到执行结果";
  const OLD_COMMAND = "sleep 60 && echo cont4-done";
  const NEW_COMMAND = "sleep 60; echo cont4-done";
  const OLD_CALL = "call_00_mAFaqGTmOCrBQVmH2ieq1706";
  const NEW_CALL = "call_00_iPd5rAaBDoPG1BQdYIkQ5271";

  const TURN_AT = 1_792_834_548_249;
  const OLD_TOOL_AT = TURN_AT + 6_665;
  const RESUMED_AT = TURN_AT + 52_000;
  const FRAME_AT = TURN_AT + 58_081;
  const NEW_TOOL_AT = TURN_AT + 61_431;
  const LATER_PROMPT_AT = TURN_AT + 240_000;

  function userRow(id: string, createdAt: number, text: string): HermesUIMessage {
    return runtimeMessage({
      id,
      role: "user",
      createdAt,
      parts: [{ type: "text", text }],
    });
  }

  function toolRow(
    id: string,
    createdAt: number,
    toolCallId: string,
    command: string,
    state: "running" | "done" = "running",
  ): HermesUIMessage {
    return runtimeMessage({
      id,
      createdAt,
      status: state === "running" ? "streaming" : "complete",
      parts: [
        {
          type: "tool",
          toolCallId,
          name: "terminal",
          state,
          input: { command },
          startedAt: createdAt,
          ...(state === "done" ? { output: "cont4-done", completedAt: createdAt + 1_000 } : {}),
        },
      ],
    });
  }

  function legacyTurnRuntime(): ReturnType<typeof createEmptyChatRuntime> {
    return {
      ...createEmptyChatRuntime(TURN_AT),
      streamStatus: "streaming" as const,
      pendingDisconnectNotice: true,
      turnStartedAt: TURN_AT,
      activeAssistantId: "live-assistant",
      messages: [
        userRow("stored-user", TURN_AT, "用 terminal 跑 sleep 60"),
        toolRow("live-assistant", OLD_TOOL_AT, OLD_CALL, OLD_COMMAND),
      ],
    };
  }

  function killedTurnSnapshot(): HermesUIMessage[] {
    return [
      userRow("stored-user", TURN_AT, "用 terminal 跑 sleep 60"),
      toolRow("stored-assistant-kill", OLD_TOOL_AT, OLD_CALL, OLD_COMMAND),
    ];
  }

  function toolParts(runtime: ReturnType<typeof createEmptyChatRuntime>) {
    return runtime.messages.flatMap((message) =>
      message.parts.filter(
        (part): part is Extract<HermesMessagePart, { type: "tool" }> => part.type === "tool",
      ),
    );
  }

  function partOf(runtime: ReturnType<typeof createEmptyChatRuntime>, toolCallId: string) {
    const part = toolParts(runtime).find((item) => item.toolCallId === toolCallId);
    expect(part).toBeDefined();
    return part!;
  }

  function resumedStore(snapshot: HermesUIMessage[]) {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, { "rt-old": legacyTurnRuntime() });
    store.set(adoptResumedSessionAtom, {
      fromSessionId: "rt-old",
      toSessionId: "rt-new",
      running: true,
      autoContinue: true,
      resumedAt: RESUMED_AT,
    });
    store.set(hydrateSessionTimelineAtom, {
      sessionId: "rt-new",
      messages: snapshot,
      running: true,
      autoContinue: true,
    });
    return store;
  }

  it("断线→resume(auto_continue, running:true)→hydrate 快照：旧 call 收敛成中断态且计时冻结", () => {
    const store = resumedStore(killedTurnSnapshot());

    const runtime = store.get(chatRuntimeBySessionAtom)["rt-new"]!;
    const part = partOf(runtime, OLD_CALL);
    expect(part).toMatchObject({
      state: "error",
      errorText: INTERRUPTED_TOOL_TEXT,
    });
    expect(part.completedAt).toBe(RESUMED_AT);
    expect(runtime.streamStatus).toBe("streaming");

    store.set(hydrateSessionTimelineAtom, {
      sessionId: "rt-new",
      messages: killedTurnSnapshot(),
      running: true,
      autoContinue: true,
    });
    expect(partOf(store.get(chatRuntimeBySessionAtom)["rt-new"]!, OLD_CALL).completedAt).toBe(
      RESUMED_AT,
    );
  });

  it("续跑新回合刚开始就 hydrate：新 call 不在旧回合里，必须保持 running", () => {
    const store = resumedStore([
      userRow("stored-user", TURN_AT, "用 terminal 跑 sleep 60"),
      toolRow("stored-assistant-kill", OLD_TOOL_AT, OLD_CALL, OLD_COMMAND),
      userRow("stored-auto-continue", FRAME_AT, "[System note: Your previous turn was interrupted mid-run]"),
      toolRow("stored-assistant-rerun", NEW_TOOL_AT, NEW_CALL, NEW_COMMAND),
    ]);

    const runtime = store.get(chatRuntimeBySessionAtom)["rt-new"]!;
    expect(partOf(runtime, OLD_CALL)).toMatchObject({ state: "error", errorText: INTERRUPTED_TOOL_TEXT });
    expect(partOf(runtime, NEW_CALL)).toMatchObject({ state: "running" });
    expect(partOf(runtime, NEW_CALL).completedAt).toBeUndefined();
  });

  it("切走再切回（纯 hydrate，无 resume、无 auto_continue）同样收敛旧回合", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, {
      "rt-new": {
        ...createEmptyChatRuntime(TURN_AT),
        streamStatus: "streaming" as const,
        messages: [],
      },
    });
    store.set(hydrateSessionTimelineAtom, {
      sessionId: "rt-new",
      messages: [
        userRow("stored-user", TURN_AT, "用 terminal 跑 sleep 60"),
        toolRow("stored-assistant-kill", OLD_TOOL_AT, OLD_CALL, OLD_COMMAND),
        userRow("stored-auto-continue", FRAME_AT, "[System note: Your previous turn was interrupted mid-run]"),
        toolRow("stored-assistant-rerun", NEW_TOOL_AT, NEW_CALL, NEW_COMMAND),
      ],
      running: true,
    });

    const runtime = store.get(chatRuntimeBySessionAtom)["rt-new"]!;
    expect(partOf(runtime, OLD_CALL)).toMatchObject({ state: "error", errorText: INTERRUPTED_TOOL_TEXT });
    expect(partOf(runtime, NEW_CALL)).toMatchObject({ state: "running" });
  });

  it("用户已经发下一轮：新回合只有自己的工具保持 running", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, { "rt-old": createEmptyChatRuntime(TURN_AT) });
    store.set(hydrateSessionTimelineAtom, {
      sessionId: "rt-new",
      messages: [
        userRow("stored-user", TURN_AT, "用 terminal 跑 sleep 60"),
        toolRow("stored-assistant-kill", OLD_TOOL_AT, OLD_CALL, OLD_COMMAND),
        userRow("stored-next-prompt", LATER_PROMPT_AT, "再跑一次"),
        toolRow("stored-assistant-next", LATER_PROMPT_AT + 4_000, NEW_CALL, NEW_COMMAND),
      ],
      running: true,
    });

    const runtime = store.get(chatRuntimeBySessionAtom)["rt-new"]!;
    expect(partOf(runtime, OLD_CALL)).toMatchObject({ state: "error", errorText: INTERRUPTED_TOOL_TEXT });
    expect(partOf(runtime, NEW_CALL)).toMatchObject({ state: "running" });
  });

  it("收敛之后迟到的 complete 仍按 tool id 覆盖回完成态", () => {
    const store = resumedStore(killedTurnSnapshot());

    store.set(applyGatewayEventAtom, {
      type: "tool.start",
      session_id: "rt-new",
      payload: { tool_id: NEW_CALL, name: "terminal", context: NEW_COMMAND },
    });
    store.set(applyGatewayEventAtom, {
      type: "tool.complete",
      session_id: "rt-new",
      payload: {
        tool_id: OLD_CALL,
        name: "terminal",
        result: { output: "cont4-done", exit_code: 0 },
        duration_s: 61,
      },
    });

    const runtime = store.get(chatRuntimeBySessionAtom)["rt-new"]!;
    expect(partOf(runtime, OLD_CALL)).toMatchObject({ state: "done", completedAt: expect.any(Number) });
    expect(partOf(runtime, OLD_CALL).errorText).toBeUndefined();
    expect(partOf(runtime, NEW_CALL)).toMatchObject({ state: "running" });
  });

  it("running:false 时一次性收敛全部 running（不依赖 auto_continue 字段）", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, { "rt-old": legacyTurnRuntime() });
    store.set(adoptResumedSessionAtom, {
      fromSessionId: "rt-old",
      toSessionId: "rt-new",
      running: false,
    });
    store.set(hydrateSessionTimelineAtom, {
      sessionId: "rt-new",
      messages: killedTurnSnapshot(),
      running: false,
    });

    const runtime = store.get(chatRuntimeBySessionAtom)["rt-new"]!;
    expect(partOf(runtime, OLD_CALL)).toMatchObject({
      state: "error",
      errorText: INTERRUPTED_TOOL_TEXT,
    });
    expect(runtime.streamStatus).toBe("idle");
    expect(runtime.activeAssistantId).toBeUndefined();
  });
});

describe("工具名解析：缺 name 时不再把字面量 tool 渲染给用户", () => {
  function toolParts(runtime: ReturnType<typeof createEmptyChatRuntime>) {
    return runtime.messages.flatMap((message) =>
      message.parts.filter(
        (part): part is Extract<HermesMessagePart, { type: "tool" }> => part.type === "tool",
      ),
    );
  }

  it("tool.start 只带 tool_name 时也认（内核生命周期 payload 同时带两种字段名）", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, { s1: createEmptyChatRuntime(1) });
    store.set(applyGatewayEventAtom, { type: "message.start", session_id: "s1" });
    store.set(applyGatewayEventAtom, {
      type: "tool.start",
      session_id: "s1",
      payload: { tool_id: "call-1", tool_name: "terminal", context: "sleep 5" },
    });

    expect(toolParts(store.get(chatRuntimeBySessionAtom).s1!)).toEqual([
      expect.objectContaining({ toolCallId: "call-1", name: "terminal" }),
    ]);
  });

  it("命名全缺时不留 tool 占位：tool.complete 到了再回填真实名字", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, { s1: createEmptyChatRuntime(1) });
    store.set(applyGatewayEventAtom, { type: "message.start", session_id: "s1" });
    store.set(applyGatewayEventAtom, {
      type: "tool.start",
      session_id: "s1",
      payload: { tool_id: "call-2" },
    });

    const started = toolParts(store.get(chatRuntimeBySessionAtom).s1!);
    expect(started[0]!.name).toBe("");
    expect(started[0]!.name).not.toBe("tool");

    store.set(applyGatewayEventAtom, {
      type: "tool.complete",
      session_id: "s1",
      payload: { tool_id: "call-2", name: "file_read", result: "ok" },
    });

    expect(toolParts(store.get(chatRuntimeBySessionAtom).s1!)[0]!.name).toBe("file_read");
  });
});

describe("Stop 的两种结局", () => {
  it("已经流出内容：保留半截回答，消息离开 streaming、计时停住、工具卡标已中断", () => {
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "解释一下这个报错", now: 5 });
    store.set(applyGatewayEventAtom, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "这个报错的意思是" },
    });
    store.set(applyGatewayEventAtom, {
      type: "tool.start",
      session_id: "s1",
      payload: { tool_id: "call-1", name: "terminal" },
    });

    const before = store.get(chatRuntimeBySessionAtom).s1!;
    expect(resolveStopOutcome(before)).toEqual({ kind: "settle" });

    store.set(stopTurnAtom, { sessionId: "s1", outcome: resolveStopOutcome(before) });

    const after = store.get(chatRuntimeBySessionAtom).s1!;
    expect(after.streamStatus).toBe("idle");
    expect(after.turnStartedAt).toBeUndefined();
    const assistant = assistantMessage(after);
    expect(assistant.status).not.toBe("streaming");
    expect(assistant.parts.some((part) => part.type === "progress")).toBe(false);
    expect(assistant.parts).toContainEqual(
      expect.objectContaining({ type: "text", text: "这个报错的意思是" }),
    );
    expect(assistant.parts).toContainEqual(
      expect.objectContaining({
        type: "tool",
        state: "error",
        errorText: "已中断，未拿到执行结果",
      }),
    );
  });

  it("保留结局自己收尾：迟到的 message.complete 不会把消息重新变回 streaming", () => {
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "解释一下这个报错", now: 5 });
    store.set(applyGatewayEventAtom, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "半截答案" },
    });
    store.set(stopTurnAtom, {
      sessionId: "s1",
      outcome: resolveStopOutcome(store.get(chatRuntimeBySessionAtom).s1!),
    });

    store.set(applyGatewayEventAtom, { type: "message.complete", session_id: "s1", payload: {} });

    const runtime = store.get(chatRuntimeBySessionAtom).s1!;
    expect(runtime.streamStatus).not.toBe("streaming");
    expect(assistantMessage(runtime).status).not.toBe("streaming");
    expect(
      runtime.messages.filter((message) => message.role === "assistant"),
    ).toHaveLength(1);
  });

  it("还没产出任何可见内容：撤回提问，草稿退回输入框", () => {
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "这个先别跑", now: 5 });

    const before = store.get(chatRuntimeBySessionAtom).s1!;
    const outcome = resolveStopOutcome(before);
    expect(outcome).toEqual({
      kind: "restore",
      userMessageId: "live-user-5",
      draftText: "这个先别跑",
    });

    store.set(stopTurnAtom, { sessionId: "s1", outcome });

    const after = store.get(chatRuntimeBySessionAtom).s1!;
    expect(after.messages).toEqual([]);
    expect(after.streamStatus).toBe("idle");
    expect(after.activeAssistantId).toBeUndefined();
    expect(after.turnStartedAt).toBeUndefined();
  });

  it("只有思考内容也算「已经出过东西」，按保留结局收尾", () => {
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "想一下", now: 5 });
    store.set(applyGatewayEventAtom, {
      type: "reasoning.delta",
      session_id: "s1",
      payload: { text: "先分析一下" },
    });

    expect(resolveStopOutcome(store.get(chatRuntimeBySessionAtom).s1!)).toEqual({ kind: "settle" });
  });
});

describe("重新生成（非破坏）", () => {
  function completedTurn(store: ReturnType<typeof createStore>, now: number, text: string) {
    store.set(startPromptAtom, { sessionId: "s1", text: "写个快排", now });
    store.set(applyGatewayEventAtom, {
      type: "message.delta",
      session_id: "s1",
      payload: { text },
    });
    store.set(applyGatewayEventAtom, {
      type: "message.complete",
      session_id: "s1",
      payload: { text },
    });
  }

  it("旧回答不删，只登记成同一提问下的旧版本；新版成为当前版本", () => {
    const store = createStore();
    completedTurn(store, 5, "第一版回答");
    const oldId = assistantMessage(store.get(chatRuntimeBySessionAtom).s1!).id;

    store.set(beginRevisionRetryAtom, {
      sessionId: "s1",
      userMessageId: "live-user-5",
      previousAssistantId: oldId,
    });
    completedTurn(store, 9, "第二版回答");
    store.set(finalizeRevisionRetryAtom, { sessionId: "s1", userMessageId: "live-user-5" });

    const runtime = store.get(chatRuntimeBySessionAtom).s1!;
    // 旧回答的数据一行没删
    expect(runtime.messages.some((message) => message.id === oldId)).toBe(true);
    expect(runtime.messages.some((message) => message.id === "live-assistant-9")).toBe(true);
    const family = runtime.revisionFamilies!["live-user-5"]!;
    expect(family.assistantIds).toEqual([oldId, "live-assistant-9"]);
    expect(family.activeAssistantId).toBe("live-assistant-9");

    // 渲染时只露当前版本 + 提问只出现一次（重发的那条用户行是回放）
    const hidden = revisionHiddenMessageIds(runtime);
    expect(hidden.has(oldId)).toBe(true);
    expect(hidden.has("live-user-9")).toBe(true);
    expect(hidden.has("live-user-5")).toBe(false);
    expect(hidden.has("live-assistant-9")).toBe(false);
  });

  it("切回旧版本只换展示，不改数据", () => {
    const store = createStore();
    completedTurn(store, 5, "第一版回答");
    const oldId = assistantMessage(store.get(chatRuntimeBySessionAtom).s1!).id;
    store.set(beginRevisionRetryAtom, {
      sessionId: "s1",
      userMessageId: "live-user-5",
      previousAssistantId: oldId,
    });
    completedTurn(store, 9, "第二版回答");
    store.set(finalizeRevisionRetryAtom, { sessionId: "s1", userMessageId: "live-user-5" });

    store.set(activateRevisionAtom, {
      sessionId: "s1",
      userMessageId: "live-user-5",
      assistantMessageId: oldId,
    });

    const runtime = store.get(chatRuntimeBySessionAtom).s1!;
    const hidden = revisionHiddenMessageIds(runtime);
    expect(hidden.has("live-assistant-9")).toBe(true);
    expect(hidden.has(oldId)).toBe(false);
    expect(runtime.messages).toHaveLength(4);
  });
});

describe("错误卡的呈现（#26）", () => {
  it("错误详情不带原始 HTTP 响应体或 JSON", () => {
    let rt = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "message.start", session_id: "s1" },
      10,
    );
    rt = reduceGatewayEvent(rt, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "半句" },
    }, 20);
    rt = reduceGatewayEvent(rt, {
      type: "error",
      session_id: "s1",
      payload: {
        message:
          'HTTP 500 <html><body>Internal Server Error</body></html> {"error":{"message":"上游炸了","body":"secret-body"}}',
      },
    }, 30);

    const card = rt.streamErrorCard;
    expect(card).toBeDefined();
    expect(card!.detail).toContain("上游炸了");
    expect(card!.detail).not.toContain("{");
    expect(card!.detail).not.toContain("}");
    expect(card!.detail).not.toContain("secret-body");
    expect(card!.detail).not.toContain("<html");
    expect(rt.statusMessage).not.toContain("{");
    expect(rt.messages.some((message) => message.role === "assistant" && message.status === "error")).toBe(true);
  });

  it("配置类错误判成 config（够格给「打开设置」），TURN_ABORTED 不追加卡片", () => {
    const configured = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "error",
        session_id: "s1",
        payload: { code: "MODEL_NOT_CONFIGURED", message: "model not configured" },
      },
      5,
    );
    expect(configured.streamErrorCard).toMatchObject({
      kind: "config",
      code: "MODEL_NOT_CONFIGURED",
      title: "模型还没配置好",
    });

    const aborted = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "error",
        session_id: "s1",
        payload: { code: "TURN_ABORTED", message: "aborted by user" },
      },
      5,
    );
    expect(aborted.streamErrorCard).toBeUndefined();
  });

  it("卡片可以关掉，关掉就不再渲染", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, { s1: createEmptyChatRuntime(1) });
    store.set(applyGatewayEventAtom, {
      type: "error",
      session_id: "s1",
      payload: { message: "rate limit exceeded" },
    });
    expect(store.get(chatRuntimeBySessionAtom).s1!.streamErrorCard).toBeDefined();

    store.set(dismissStreamErrorCardAtom, "s1");
    expect(store.get(chatRuntimeBySessionAtom).s1!.streamErrorCard).toBeUndefined();
  });

  it("sanitizeErrorDetail：纯 JSON 只留 message，纯响应体退化成固定文案", () => {
    expect(sanitizeErrorDetail('{"error":{"message":"配额用完了"}}')).toBe("配额用完了");
    expect(sanitizeErrorDetail('<html><body>502 Bad Gateway</body></html>')).toBe(
      "内核返回了无法展示的原始响应，请查看日志或重试。",
    );
  });
});

describe("Stop 缺陷回归（真实黑盒路径）", () => {
  const NOT_PROCESSED =
    "Your request was not processed. Send it again if you still want me to carry it out.";
  const INTERRUPT_WAIT = "Operation interrupted: waiting for model response (0.6s elapsed).";

  it("空回合被内核回了一句英文占位：Esc 仍然撤回提问", () => {
    const store = createStore();
    store.set(startPromptAtom, {
      sessionId: "s1",
      text: "请先只思考不输出，比较三种排序算法",
      now: 5,
    });
    store.set(applyGatewayEventAtom, {
      type: "message.complete",
      session_id: "s1",
      payload: { text: NOT_PROCESSED },
    });

    const runtime = store.get(chatRuntimeBySessionAtom).s1!;
    expect(runtime.streamStatus).not.toBe("streaming");

    const outcome = resolveStopOutcome(runtime);
    expect(outcome).toEqual({
      kind: "restore",
      userMessageId: "live-user-5",
      draftText: "请先只思考不输出，比较三种排序算法",
    });

    store.set(stopTurnAtom, { sessionId: "s1", outcome });

    const after = store.get(chatRuntimeBySessionAtom).s1!;
    expect(after.messages).toEqual([]);
    expect(after.withdrawnTurns?.map((turn) => turn.text)).toEqual([
      "请先只思考不输出，比较三种排序算法",
    ]);
  });

  it("撤回之后，已落库的同一句提问和它的英文占位回答一起从渲染里消失", () => {
    const withdrawn = [
      {
        userMessageId: "live-user-5",
        text: "请先只思考不输出，比较三种排序算法",
        at: 4_000,
      },
    ];
    const stored: HermesUIMessage[] = [
      {
        id: "stored-100",
        sessionId: "s1",
        role: "user",
        createdAt: 1,
        status: "complete",
        parts: [{ type: "text", text: "上一轮的问题" }],
      },
      {
        id: "stored-101",
        sessionId: "s1",
        role: "assistant",
        createdAt: 2,
        status: "complete",
        parts: [{ type: "text", text: "上一轮的回答" }],
      },
      {
        id: "stored-107204",
        sessionId: "s1",
        role: "user",
        createdAt: 3,
        status: "complete",
        parts: [{ type: "text", text: "请先只思考不输出，比较三种排序算法" }],
      },
      {
        id: "stored-107206",
        sessionId: "s1",
        role: "assistant",
        createdAt: 4,
        status: "complete",
        parts: [{ type: "text", text: NOT_PROCESSED }],
      },
    ];

    const visible = dropWithdrawnTurnMessages(stored, withdrawn);
    expect(visible.map((message) => message.id)).toEqual(["stored-100", "stored-101"]);
    expect(dropWithdrawnTurnMessages(stored, undefined)).toBe(stored);
  });

  it("撤回之后重发同一条提问：新回合不被连带隐藏", () => {
    const withdrawn = [
      { userMessageId: "live-user-5", text: "跑一下冒烟测试", at: 4_000 },
    ];
    const stored: HermesUIMessage[] = [
      {
        id: "stored-107204",
        sessionId: "s1",
        role: "user",
        createdAt: 3_000,
        status: "complete",
        parts: [{ type: "text", text: "跑一下冒烟测试" }],
      },
      {
        id: "stored-107206",
        sessionId: "s1",
        role: "assistant",
        createdAt: 3_500,
        status: "complete",
        parts: [{ type: "text", text: NOT_PROCESSED }],
      },
      {
        id: "stored-107300",
        sessionId: "s1",
        role: "user",
        createdAt: 60_000,
        status: "complete",
        parts: [{ type: "text", text: "跑一下冒烟测试" }],
      },
      {
        id: "stored-107301",
        sessionId: "s1",
        role: "assistant",
        createdAt: 61_000,
        status: "complete",
        parts: [{ type: "text", text: "冒烟测试全过。" }],
      },
    ];

    const visible = dropWithdrawnTurnMessages(stored, withdrawn);
    expect(visible.map((message) => message.id)).toEqual(["stored-107300", "stored-107301"]);
  });

  it("撤回之后内核迟到的 message.complete 不会再造一条英文回答", () => {
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "请先只思考不输出", now: 5 });
    store.set(applyGatewayEventAtom, {
      type: "message.complete",
      session_id: "s1",
      payload: { text: NOT_PROCESSED },
    });
    store.set(stopTurnAtom, {
      sessionId: "s1",
      outcome: resolveStopOutcome(store.get(chatRuntimeBySessionAtom).s1!),
    });
    expect(store.get(chatRuntimeBySessionAtom).s1!.messages).toEqual([]);

    store.set(applyGatewayEventAtom, {
      type: "message.complete",
      session_id: "s1",
      payload: { text: NOT_PROCESSED },
    });

    expect(store.get(chatRuntimeBySessionAtom).s1!.messages).toEqual([]);
  });

  it("中断回合里已经跑完的工具卡也要打「已中断」", () => {
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "写完再跑一下", now: 5 });
    store.set(applyGatewayEventAtom, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "先写文件" },
    });
    for (const [toolId, name] of [["call-1", "write_file"], ["call-2", "terminal"]] as const) {
      store.set(applyGatewayEventAtom, {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: toolId, name },
      });
      store.set(applyGatewayEventAtom, {
        type: "tool.complete",
        session_id: "s1",
        payload: { tool_id: toolId, name, result: "ok" },
      });
    }

    const before = store.get(chatRuntimeBySessionAtom).s1!;
    expect(resolveStopOutcome(before)).toEqual({ kind: "settle" });
    store.set(stopTurnAtom, { sessionId: "s1", outcome: resolveStopOutcome(before) });

    const tools = assistantMessage(store.get(chatRuntimeBySessionAtom).s1!).parts.filter(
      (part): part is Extract<HermesMessagePart, { type: "tool" }> => part.type === "tool",
    );
    expect(tools).toHaveLength(2);
    for (const tool of tools) {
      expect(tool.state).toBe("error");
      expect(tool.errorText).toBe("已中断，未拿到执行结果");
      expect(tool.output).toBe("ok");
    }
  });

  it("迟到的内核中断句落进 store 时换成中文，不覆盖已经流出的正文", () => {
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "比较三种排序", now: 5 });
    store.set(applyGatewayEventAtom, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "十万条随机数据上快排最快" },
    });
    store.set(applyGatewayEventAtom, {
      type: "message.complete",
      session_id: "s1",
      payload: { text: INTERRUPT_WAIT },
    });

    const text = textFromParts(assistantMessage(store.get(chatRuntimeBySessionAtom).s1!).parts);
    expect(text).toContain("十万条随机数据上快排最快");
    expect(text).toContain("已中断");
    expect(text).not.toContain("Operation interrupted");
  });
});
