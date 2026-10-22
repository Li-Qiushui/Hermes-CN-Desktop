import { describe, it, expect, vi } from "vitest";
import { isDefinitiveMissingSessionError } from "./gateway-reconnect";
import {
  createReconnectRecovery,
  recoverAfterReconnect,
  type HydrateSnapshotParams,
  type ReconnectRecoveryDeps,
  type ResumeSnapshot,
} from "./gateway-replay";
import type { GatewayReplayOutcome } from "./gateway-client";
import type { ReplayDegradeReason } from "./session-replay";

interface Recorder {
  resumeCalls: string[];
  bindCalls: string[][];
  replayCalls: string[][];
  hydrateCalls: HydrateSnapshotParams[];
  resumedCalls: string[][];
  resumeFailed: unknown[];
  errors: unknown[];
  openRequests: unknown[][];
}

const SNAPSHOT_MESSAGES = [{ role: "user", content: "hi" }];

function makeDeps(overrides: Partial<ReconnectRecoveryDeps> = {}): {
  deps: ReconnectRecoveryDeps;
  recorded: Recorder;
} {
  const recorded: Recorder = {
    resumeCalls: [],
    bindCalls: [],
    replayCalls: [],
    hydrateCalls: [],
    resumedCalls: [],
    resumeFailed: [],
    errors: [],
    openRequests: [],
  };

  const deps: ReconnectRecoveryDeps = {
    getActiveSessionId: () => "gw-old",
    resolvePersistentId: (id) => (id === "gw-old" ? "sess-1" : id),
    resume: async (persistentId: string): Promise<ResumeSnapshot> => {
      recorded.resumeCalls.push(persistentId);
      const openRequests = [{ id: "srq-1", method: "clarify" }];
      recorded.openRequests.push(openRequests);
      return {
        session_id: `gw-${persistentId}`,
        resumed: persistentId,
        messages: SNAPSHOT_MESSAGES,
        running: true,
        open_requests: openRequests,
      } as ResumeSnapshot;
    },
    bind: (persistentId, runtimeSessionId) => {
      recorded.bindCalls.push([persistentId, runtimeSessionId]);
    },
    replay: async (persistentId, runtimeSessionId) => {
      recorded.replayCalls.push([persistentId, runtimeSessionId]);
      return { status: "replayed", dispatched: 3 } satisfies GatewayReplayOutcome;
    },
    hydrate: (params) => {
      recorded.hydrateCalls.push(params);
    },
    onResumed: (runtimeSessionId, persistentId) => {
      recorded.resumedCalls.push([runtimeSessionId, persistentId]);
    },
    onResumeFailed: (error) => {
      recorded.resumeFailed.push(error);
    },
    onError: (persistentId, error) => {
      recorded.errors.push([persistentId, error]);
    },
    ...overrides,
  };

  return { deps, recorded };
}

function degradedReplay(reason: ReplayDegradeReason) {
  return vi.fn(
    async (
      _persistentId: string,
      _runtimeSessionId: string,
      onDegraded?: (reason: ReplayDegradeReason) => void,
    ) => {
      onDegraded?.(reason);
      return { status: "degraded" as const, dispatched: 0, reason };
    },
  );
}

describe("recoverAfterReconnect", () => {
  it("no-ops when there is no active session", async () => {
    const { deps, recorded } = makeDeps({ getActiveSessionId: () => null });

    const result = await recoverAfterReconnect(deps);

    expect(result).toEqual({ status: "idle" });
    expect(recorded.resumeCalls).toEqual([]);
    expect(recorded.resumedCalls).toEqual([]);
  });

  it("resumes the resolved persistent id once and republishes the new runtime id", async () => {
    const { deps, recorded } = makeDeps();

    const result = await recoverAfterReconnect(deps);

    expect(recorded.resumeCalls).toEqual(["sess-1"]);
    expect(recorded.bindCalls).toEqual([["sess-1", "gw-sess-1"]]);
    expect(recorded.resumedCalls).toEqual([["gw-sess-1", "sess-1"]]);
    expect(result).toEqual({ status: "resumed", persistentId: "sess-1", runtimeSessionId: "gw-sess-1" });
  });

  it("prefers the server-reported resumed persistent id when present", async () => {
    const { deps, recorded } = makeDeps({
      resume: async () => ({ session_id: "gw-new", resumed: "sess-canonical" }),
    });

    await recoverAfterReconnect(deps);

    expect(recorded.resumedCalls).toEqual([["gw-new", "sess-canonical"]]);
    expect(recorded.bindCalls).toEqual([["sess-canonical", "gw-new"]]);
  });

  it("keeps filling frames from session.events.since when the watermark is trustworthy", async () => {
    const replay = vi.fn(async () => ({ status: "replayed" as const, dispatched: 4 }));
    const { deps, recorded } = makeDeps({ replay });

    const result = await recoverAfterReconnect(deps);

    expect(recorded.resumeCalls).toEqual(["sess-1"]);
    expect(replay).toHaveBeenCalledTimes(1);
    expect(recorded.hydrateCalls).toEqual([]);
    expect(result.status).toBe("resumed");
  });

  it("calls session.resume exactly once when the backend epoch changed (resume-time race)", async () => {
    let epoch = 0;
    const replay = degradedReplay("epoch_changed");
    const { deps, recorded } = makeDeps({
      epochGeneration: () => epoch,
      replay,
      resume: async (persistentId: string) => {
        recorded.resumeCalls.push(persistentId);
        epoch = 1;
        return { session_id: "gw-new", resumed: persistentId, messages: SNAPSHOT_MESSAGES, running: false };
      },
    });

    const result = await recoverAfterReconnect(deps);

    expect(recorded.resumeCalls).toEqual(["sess-1"]);
    expect(recorded.resumeCalls).toHaveLength(1);
    expect(replay).not.toHaveBeenCalled();
    expect(recorded.hydrateCalls).toEqual([
      {
        runtimeSessionId: "gw-new",
        persistentId: "sess-1",
        messages: SNAPSHOT_MESSAGES,
        running: false,
      },
    ]);
    expect(result).toMatchObject({ status: "snapshot", reason: "epoch_changed" });
  });

  it("overwrites the timeline from the same resume snapshot when the cursor is ahead", async () => {
    const { deps, recorded } = makeDeps({ replay: degradedReplay("cursor_ahead") });

    const result = await recoverAfterReconnect(deps);

    expect(recorded.resumeCalls).toHaveLength(1);
    expect(recorded.hydrateCalls).toHaveLength(1);
    expect(recorded.hydrateCalls[0]).toMatchObject({ messages: SNAPSHOT_MESSAGES, persistentId: "sess-1" });
    expect(result).toMatchObject({ status: "snapshot", reason: "cursor_ahead" });
  });

  it("overwrites the timeline from the same resume snapshot when a replayed seq is missing", async () => {
    const { deps, recorded } = makeDeps({ replay: degradedReplay("seq_gap") });

    const result = await recoverAfterReconnect(deps);

    expect(recorded.resumeCalls).toHaveLength(1);
    expect(recorded.hydrateCalls).toHaveLength(1);
    expect(result).toMatchObject({ status: "snapshot", reason: "seq_gap" });
  });

  it("takes the snapshot when the epoch flips while the replay request is in flight", async () => {
    let epoch = 0;
    const replay = vi.fn(async () => {
      epoch = 1;
      return { status: "skipped" as const, dispatched: 0 };
    });
    const { deps, recorded } = makeDeps({ epochGeneration: () => epoch, replay });

    const result = await recoverAfterReconnect(deps);

    expect(recorded.resumeCalls).toHaveLength(1);
    expect(recorded.hydrateCalls).toHaveLength(1);
    expect(result).toMatchObject({ status: "snapshot", reason: "epoch_changed" });
  });

  it("takes the snapshot when the kernel flagged the session after a process restart", async () => {
    const replay = vi.fn(async () => ({ status: "skipped" as const, dispatched: 0 }));
    const { deps, recorded } = makeDeps({ consumeSnapshotRequest: () => true, replay });

    const result = await recoverAfterReconnect(deps);

    expect(recorded.resumeCalls).toHaveLength(1);
    expect(replay).not.toHaveBeenCalled();
    expect(recorded.hydrateCalls).toHaveLength(1);
    expect(result).toMatchObject({ status: "snapshot", reason: "epoch_changed" });
  });

  it("consumes the snapshot flag once, so the next reconnect replays again", async () => {
    let flagged = true;
    const { deps, recorded } = makeDeps({
      consumeSnapshotRequest: () => {
        const value = flagged;
        flagged = false;
        return value;
      },
    });

    await recoverAfterReconnect(deps);
    await recoverAfterReconnect(deps);

    expect(recorded.resumeCalls).toHaveLength(2);
    expect(recorded.hydrateCalls).toHaveLength(1);
    expect(recorded.replayCalls).toHaveLength(1);
  });

  it("reports a failed resume without a second attempt", async () => {
    const { deps, recorded } = makeDeps({
      resume: async (persistentId: string) => {
        recorded.resumeCalls.push(persistentId);
        throw new Error("Session not found");
      },
    });

    const result = await recoverAfterReconnect(deps);

    expect(recorded.resumeCalls).toHaveLength(1);
    expect(recorded.resumedCalls).toEqual([]);
    expect(recorded.resumeFailed).toHaveLength(1);
    expect(result).toMatchObject({ status: "failed", reason: "resume_failed" });
  });

  it("reports a resume that yields no session_id", async () => {
    const { deps, recorded } = makeDeps({ resume: async () => ({ session_id: "" }) });

    const result = await recoverAfterReconnect(deps);

    expect(recorded.resumeFailed).toHaveLength(1);
    expect(recorded.resumedCalls).toEqual([]);
    expect(result.status).toBe("failed");
  });

  it("survives a replay request that throws (best effort, no snapshot)", async () => {
    const { deps, recorded } = makeDeps({
      replay: async () => {
        throw new Error("session.events.since timeout");
      },
    });

    const result = await recoverAfterReconnect(deps);

    expect(recorded.errors).toHaveLength(1);
    expect(recorded.hydrateCalls).toEqual([]);
    expect(result.status).toBe("resumed");
  });

  it("redelivers open_requests only once per reconnect", async () => {
    const { deps, recorded } = makeDeps({ replay: degradedReplay("cursor_ahead") });

    await recoverAfterReconnect(deps);

    expect(recorded.openRequests).toHaveLength(1);
    expect(recorded.openRequests[0]).toEqual([{ id: "srq-1", method: "clarify" }]);
  });

  it.each([false, true])(
    "does not overwrite a newly activated session when the old resume settles (failure=%s)",
    async (fails) => {
      let activeSessionId = "gw-old";
      let finish!: () => void;
      const waiting = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const { deps, recorded } = makeDeps({
        getActiveSessionId: () => activeSessionId,
        resume: async () => {
          await waiting;
          if (fails) throw new Error("Session not found");
          return { session_id: "gw-resumed" };
        },
      });

      const recovering = recoverAfterReconnect(deps);
      activeSessionId = "gw-new-conversation";
      finish();
      const result = await recovering;

      expect(result.status).toBe("superseded");
      expect(recorded.resumedCalls).toEqual([]);
      expect(recorded.resumeFailed).toEqual([]);
      expect(recorded.replayCalls).toEqual([]);
    },
  );
});

describe("createReconnectRecovery", () => {
  it("collapses two overlapping reconnects into a single session.resume", async () => {
    let finish!: (snapshot: ResumeSnapshot) => void;
    const waiting = new Promise<ResumeSnapshot>((resolve) => {
      finish = resolve;
    });
    const { deps, recorded } = makeDeps({
      resume: async (persistentId: string) => {
        recorded.resumeCalls.push(persistentId);
        return waiting;
      },
    });

    const recover = createReconnectRecovery();
    const first = recover(deps);
    const second = recover(deps);
    expect(second).toBe(first);

    finish({ session_id: "gw-sess-1", resumed: "sess-1", messages: SNAPSHOT_MESSAGES });
    const [a, b] = await Promise.all([first, second]);

    expect(recorded.resumeCalls).toEqual(["sess-1"]);
    expect(a).toMatchObject({ status: "resumed" });
    expect(b).toMatchObject({ status: "resumed" });
    expect(recorded.replayCalls).toHaveLength(1);
  });

  it("allows a fresh recovery after the previous one settled", async () => {
    const { deps, recorded } = makeDeps();

    const recover = createReconnectRecovery();
    await recover(deps);
    await recover(deps);

    expect(recorded.resumeCalls).toEqual(["sess-1", "sess-1"]);
  });
});

describe("isDefinitiveMissingSessionError", () => {
  it.each([
    new Error("Session not found"),
    new Error("unknown conversation id"),
    "conversation was reaped",
  ])("accepts explicit missing-session failures", (error) => {
    expect(isDefinitiveMissingSessionError(error)).toBe(true);
  });

  it.each([
    new Error("Request timed out after 300000ms"),
    new Error("WebSocket disconnected"),
    new Error("HTTP 503 Service Unavailable"),
  ])("keeps transient resume failures recoverable", (error) => {
    expect(isDefinitiveMissingSessionError(error)).toBe(false);
  });
});
