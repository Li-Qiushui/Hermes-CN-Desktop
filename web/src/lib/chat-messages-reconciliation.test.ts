import { describe, expect, it } from "vitest";
import type { HermesMessagePart, HermesMessageTiming, HermesUIMessage } from "@hermes/protocol";
import { mergeHermesUIMessages } from "@/components/chat/message-adapter";
import { reconcileAssistantTimeline } from "./chat-messages-reconciliation";

const textPart = (text: string): HermesMessagePart => ({ type: "text", text });

const toolPart = (
  toolCallId: string,
  startedAt?: number,
  completedAt?: number,
): HermesMessagePart => ({
  type: "tool",
  toolCallId,
  name: "read_file",
  state: "done",
  ...(startedAt !== undefined ? { startedAt } : {}),
  ...(completedAt !== undefined ? { completedAt } : {}),
});

type RowInput = {
  id: string;
  role: HermesUIMessage["role"];
  text?: string;
  parts?: HermesMessagePart[];
  timing?: HermesMessageTiming;
  persistedId?: string | number;
};

const row = ({ id, role, text, parts, timing, persistedId }: RowInput): HermesUIMessage => ({
  id,
  sessionId: "s",
  role,
  createdAt: 1_000,
  status: "complete",
  parts: parts ?? [textPart(text ?? "")],
  ...(timing || persistedId !== undefined
    ? {
        metadata: {
          ...(timing ? { timing } : {}),
          ...(persistedId !== undefined ? { persistedId } : {}),
        },
      }
    : {}),
});

describe("reconcileAssistantTimeline", () => {
  it("同文本的 stored 与 live 行合为一条，内容/id 取 stored，耗时时间取 live", () => {
    const stored = row({
      id: "stored-a",
      role: "assistant",
      text: "  Done.  ",
      timing: { startedAt: 200, completedAt: 500 },
    });
    const live = row({
      id: "live-a",
      role: "assistant",
      text: "Done.",
      timing: { startedAt: 100, firstTokenAt: 150, completedAt: 600, ttftMs: 450, durationMs: 4_000 },
    });

    const merged = reconcileAssistantTimeline([stored], [live]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("stored-a");
    expect(merged[0]!.parts).toEqual([textPart("  Done.  ")]);
    expect(merged[0]!.metadata?.timing).toEqual({
      startedAt: 100,
      completedAt: 600,
      firstTokenAt: 150,
      ttftMs: 450,
      durationMs: 4_000,
    });
  });

  it("文本不一致时不合并，两条都留且 stored 行不被改写", () => {
    const stored = row({ id: "stored-a", role: "assistant", text: "Done." });
    const live = row({
      id: "live-a",
      role: "assistant",
      text: "Something else.",
      timing: { startedAt: 100, completedAt: 600 },
    });

    const merged = reconcileAssistantTimeline([stored], [live]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(stored);
    expect(merged[0]!.metadata).toBeUndefined();
  });

  it("非 assistant 行与 hidden 行不参与合流", () => {
    const storedUser = row({ id: "stored-u", role: "user", text: "Done." });
    const liveUser = row({ id: "live-u", role: "user", text: "Done." });
    const storedAssistant = row({ id: "stored-a", role: "assistant", text: "Done." });
    const hiddenLive = {
      ...row({ id: "live-hidden", role: "assistant", text: "Done.", timing: { startedAt: 100 } }),
      hidden: true,
    } as HermesUIMessage;

    expect(reconcileAssistantTimeline([storedUser], [liveUser])).toEqual([storedUser]);
    expect(reconcileAssistantTimeline([storedAssistant], [hiddenLive])).toEqual([storedAssistant]);
    expect(reconcileAssistantTimeline([storedAssistant], [hiddenLive])[0]).toBe(storedAssistant);
  });

  it("多回合尾部对齐：从尾部向前一一对应，每行拿到自己那一轮的 live 时间", () => {
    const stored = [
      row({ id: "s-u1", role: "user", text: "q1" }),
      row({ id: "s-a1", role: "assistant", text: "Done." }),
      row({ id: "s-u2", role: "user", text: "q2" }),
      row({ id: "s-a2", role: "assistant", text: "Done." }),
      row({ id: "s-u3", role: "user", text: "q3" }),
      row({ id: "s-a3", role: "assistant", text: "Done." }),
    ];
    const live = [
      row({ id: "l-u1", role: "user", text: "q1" }),
      row({ id: "l-a1", role: "assistant", text: "Done.", timing: { startedAt: 101, completedAt: 201 } }),
      row({ id: "l-u2", role: "user", text: "q2" }),
      row({ id: "l-a2", role: "assistant", text: "Done.", timing: { startedAt: 102, completedAt: 202 } }),
      row({ id: "l-u3", role: "user", text: "q3" }),
      row({ id: "l-a3", role: "assistant", text: "Done.", timing: { startedAt: 103, completedAt: 203 } }),
    ];

    const merged = reconcileAssistantTimeline(stored, live);

    expect(merged.map((message) => message.id)).toEqual(stored.map((message) => message.id));
    expect(merged.map((message) => message.metadata?.timing?.startedAt)).toEqual([
      undefined,
      101,
      undefined,
      102,
      undefined,
      103,
    ]);
  });

  it("尾部多出同文本的 live 行时，stored 行对上的是最靠后的那一行", () => {
    const stored = row({ id: "stored-a", role: "assistant", text: "Done." });
    const live = [
      row({ id: "live-a0", role: "assistant", text: "Done.", timing: { startedAt: 10, completedAt: 20 } }),
      row({ id: "live-a1", role: "assistant", text: "Done.", timing: { startedAt: 30, completedAt: 40 } }),
    ];

    const [merged] = reconcileAssistantTimeline([stored], live);

    expect(merged!.id).toBe("stored-a");
    expect(merged!.metadata?.timing).toEqual({ startedAt: 30, completedAt: 40 });
  });

  it("工具调用 id 相同即算同一行，并回填工具段落与消息的时间", () => {
    const stored = row({
      id: "stored-tool",
      role: "assistant",
      parts: [toolPart("call-1")],
    });
    const live = row({
      id: "live-tool",
      role: "assistant",
      parts: [toolPart("call-1", 110, 190)],
      timing: { startedAt: 100, completedAt: 200 },
    });

    const [merged] = reconcileAssistantTimeline([stored], [live]);

    expect(merged!.id).toBe("stored-tool");
    expect(merged!.parts[0]).toMatchObject({ toolCallId: "call-1", startedAt: 110, completedAt: 190 });
    expect(merged!.metadata?.timing).toEqual({ startedAt: 100, completedAt: 200 });
  });

  it("空数组或无 live 行时不崩且不改写", () => {
    const stored = row({ id: "stored-a", role: "assistant", text: "Done." });

    expect(reconcileAssistantTimeline([], [])).toEqual([]);
    expect(reconcileAssistantTimeline([], [stored])).toEqual([]);

    const untouched = reconcileAssistantTimeline([stored], []);
    expect(untouched).toEqual([stored]);
    expect(untouched[0]).toBe(stored);
  });

  // 增量/记忆化：同一个 (stored, local) 引用对重复 reconcile 必须复用同一对象，
  // 否则 detail.tsx 里每条命中行每帧都是新对象，下游 memo 与引用稳定化全废。
  it("同一 (stored, local) 引用对重复合流复用同一对象", () => {
    const stored = row({
      id: "stored-a",
      role: "assistant",
      text: "Done.",
      timing: { completedAt: 500 },
    });
    const live = {
      ...row({
        id: "live-a",
        role: "assistant",
        text: "Done.",
        timing: { startedAt: 100, completedAt: 600 },
      }),
      status: "streaming" as const,
    };

    const first = reconcileAssistantTimeline([stored], [live]);
    const second = reconcileAssistantTimeline([stored], [live]);

    expect(first[0]).not.toBe(stored);
    expect(second[0]).toBe(first[0]);
  });

  it("live 行内容变化（同一位置新对象）后重新合流得到更新的耗时", () => {
    const stored = row({
      id: "stored-a",
      role: "assistant",
      text: "Done.",
      timing: { completedAt: 500 },
    });
    const live = {
      ...row({
        id: "live-a",
        role: "assistant",
        text: "Done.",
        timing: { startedAt: 100, completedAt: 600 },
      }),
      status: "streaming" as const,
    };

    const first = reconcileAssistantTimeline([stored], [live]);
    const grown = { ...live, parts: [textPart("Done. 已全部完成")] };
    const second = reconcileAssistantTimeline([stored], [grown]);

    expect(first[0]!.parts).toEqual([textPart("Done.")]);
    expect(second[0]!.parts).toEqual([textPart("Done.")]);
    expect(second[0]).not.toBe(first[0]);
  });

  // 接入点：detail.tsx 重拉持久化消息后走 mergeHermesUIMessages，stored 行赢下内容时
  // 仍要拿到 live 的耗时（不是只在单测里成立）。
  it("接在 mergeHermesUIMessages 的刷新路径上：stored 内容 + live 耗时", () => {
    const stored = row({
      id: "stored-a",
      role: "assistant",
      text: "Done.",
      timing: { completedAt: 500 },
    });
    const live = {
      ...row({
        id: "live-a",
        role: "assistant",
        text: "Done.",
        timing: { startedAt: 100, firstTokenAt: 150, completedAt: 600, ttftMs: 50 },
      }),
      status: "streaming" as const,
    };

    const merged = mergeHermesUIMessages([stored], [live]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("stored-a");
    expect(merged[0]!.metadata?.timing).toMatchObject({
      startedAt: 100,
      firstTokenAt: 150,
      completedAt: 600,
      ttftMs: 50,
    });
  });
});
