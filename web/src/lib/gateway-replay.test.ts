import { describe, expect, it, vi } from "vitest";
import {
  createCoalescedTask,
  replaySubscribedSessions,
  type ReplaySubscribedSessionsDeps,
  type TrackedSessionRef,
} from "./gateway-replay";
import type { GatewayReplayOutcome } from "./gateway-client";

function deps(overrides: Partial<ReplaySubscribedSessionsDeps> & {
  tracked?: TrackedSessionRef[];
  outcomes?: Record<string, GatewayReplayOutcome>;
}): ReplaySubscribedSessionsDeps & { resumeCalls: string[]; bindCalls: string[][]; replayCalls: string[][] } {
  const resumeCalls: string[] = [];
  const bindCalls: string[][] = [];
  const replayCalls: string[][] = [];
  const outcomes = overrides.outcomes ?? {};

  return {
    resumeCalls,
    bindCalls,
    replayCalls,
    trackedSessions: () => overrides.tracked ?? [],
    isActive: overrides.isActive ?? (() => false),
    resume: async (sessionId) => {
      resumeCalls.push(sessionId);
      return { session_id: `rt-${sessionId}` };
    },
    bind: (sessionId, runtimeId) => {
      bindCalls.push([sessionId, runtimeId]);
    },
    replay: async (sessionId, runtimeId) => {
      replayCalls.push([sessionId, runtimeId]);
      return outcomes[sessionId] ?? { status: "replayed", dispatched: 2 };
    },
    onError: overrides.onError,
  };
}

describe("replaySubscribedSessions", () => {
  it("resumes and replays every subscribed session except the active one", async () => {
    const d = deps({
      tracked: [
        { sessionId: "p-active", runtimeSessionId: "rt-1", lastSeen: 9 },
        { sessionId: "p-other", runtimeSessionId: "rt-2", lastSeen: 4 },
      ],
      isActive: (sessionId) => sessionId === "p-active",
    });

    const summary = await replaySubscribedSessions(d);

    expect(d.resumeCalls).toEqual(["p-other"]);
    expect(d.bindCalls).toEqual([["p-other", "rt-p-other"]]);
    expect(d.replayCalls).toEqual([["p-other", "rt-p-other"]]);
    expect(summary).toMatchObject({ replayed: 2, skipped: 1, degraded: [] });
  });

  it("skips sessions that never saw an event (nothing provable to fill)", async () => {
    const d = deps({ tracked: [{ sessionId: "p-1", runtimeSessionId: "rt-1", lastSeen: 0 }] });

    const summary = await replaySubscribedSessions(d);

    expect(d.resumeCalls).toEqual([]);
    expect(summary.skipped).toBe(1);
  });

  it("reports degraded sessions so the caller can fall back to a snapshot", async () => {
    const d = deps({
      tracked: [{ sessionId: "p-1", runtimeSessionId: "rt-1", lastSeen: 7 }],
      outcomes: { "p-1": { status: "degraded", dispatched: 0, reason: "seq_gap" as const } },
    });

    const summary = await replaySubscribedSessions(d);

    expect(summary.degraded).toEqual(["p-1"]);
    expect(summary.replayed).toBe(0);
  });

  it("keeps going when one session's resume fails", async () => {
    const onError = vi.fn();
    const d = deps({
      tracked: [
        { sessionId: "p-bad", runtimeSessionId: "rt-1", lastSeen: 3 },
        { sessionId: "p-good", runtimeSessionId: "rt-2", lastSeen: 5 },
      ],
      onError,
    });
    const originalResume = d.resume;
    d.resume = async (sessionId) => {
      if (sessionId === "p-bad") throw new Error("session not found");
      return originalResume(sessionId);
    };

    const summary = await replaySubscribedSessions(d);

    expect(summary.failed).toEqual(["p-bad"]);
    expect(summary.resumed).toEqual(["p-good"]);
    expect(onError).toHaveBeenCalledWith("p-bad", expect.any(Error));
  });

  it("hydrates a degraded non-active session from the resume it already made", async () => {
    const hydrate = vi.fn();
    const d = deps({
      tracked: [{ sessionId: "p-1", runtimeSessionId: "rt-1", lastSeen: 7 }],
      outcomes: { "p-1": { status: "degraded", dispatched: 0, reason: "epoch_changed" as const } },
    });
    const originalResume = d.resume;
    d.resume = async (sessionId) => ({
      ...(await originalResume(sessionId)),
      messages: [{ role: "user", content: "snapshot" }],
      running: false,
    });
    d.hydrate = hydrate;

    const summary = await replaySubscribedSessions(d);

    expect(d.resumeCalls).toEqual(["p-1"]);
    expect(summary.degraded).toEqual(["p-1"]);
    expect(hydrate).toHaveBeenCalledWith({
      runtimeSessionId: "rt-p-1",
      persistentId: "p-1",
      messages: [{ role: "user", content: "snapshot" }],
      running: false,
      autoContinue: false,
    });
  });
});

describe("createCoalescedTask", () => {
  it("跑着的时候再触发不会丢，当前轮结束后补跑一次", async () => {
    const gates: Array<() => void> = [];
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          gates.push(resolve);
        }),
    );
    const run = createCoalescedTask(task);

    const first = run();
    expect(task).toHaveBeenCalledTimes(1);

    // 重连风暴：第一轮还没结束就来了两次触发
    void run();
    void run();
    expect(task).toHaveBeenCalledTimes(1);

    gates[0]();
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2));
    gates[1]();
    await first;

    // 两轮跑完就停，不会无限补跑
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("串行触发时每一轮都执行", async () => {
    const task = vi.fn(async () => {});
    const run = createCoalescedTask(task);

    await run();
    await run();

    expect(task).toHaveBeenCalledTimes(2);
  });

  it("任务抛错时不卡死，下一轮照样能跑", async () => {
    const task = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const run = createCoalescedTask(task);

    await expect(run()).rejects.toThrow("boom");
    await run();

    expect(task).toHaveBeenCalledTimes(2);
  });
});
