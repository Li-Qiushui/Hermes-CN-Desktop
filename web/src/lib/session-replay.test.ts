import { describe, expect, it } from "vitest";
import {
  MAX_SESSION_CURSORS,
  mergeReplayWindow,
  planReplay,
  SessionSeqLedger,
  type SessionEventsSinceAnswer,
} from "./session-replay";

const events = (...seqs: number[]) => seqs.map((seq) => ({ type: "message.delta", session_id: "s1", seq, payload: {} }));

describe("SessionSeqLedger", () => {
  it("advances a watermark monotonically and refuses duplicates", () => {
    const ledger = new SessionSeqLedger();
    expect(ledger.advance("s1", 3)).toBe(true);
    expect(ledger.seqOf("s1")).toBe(3);
    expect(ledger.advance("s1", 3)).toBe(false);
    expect(ledger.advance("s1", 2)).toBe(false);
    expect(ledger.advance("s1", 4)).toBe(true);
    expect(ledger.seqOf("s1")).toBe(4);
  });

  it("keeps watermarks per session", () => {
    const ledger = new SessionSeqLedger();
    ledger.advance("a", 5);
    ledger.advance("b", 2);
    expect(ledger.seqOf("a")).toBe(5);
    expect(ledger.seqOf("b")).toBe(2);
    expect(ledger.seqOf("c")).toBe(0);
  });

  it("drops every watermark when the process epoch changes", () => {
    const ledger = new SessionSeqLedger();
    ledger.adoptProcessEpoch("e1");
    ledger.advance("a", 7);
    ledger.advance("b", 9);

    const result = ledger.adoptProcessEpoch("e2");
    expect(result.changed).toBe(true);
    expect(result.dropped.sort()).toEqual(["a", "b"]);
    expect(ledger.seqOf("a")).toBe(0);
    expect(ledger.seqOf("b")).toBe(0);
    expect(ledger.epoch).toBe("e2");
  });

  it("caps the number of tracked cursors", () => {
    const ledger = new SessionSeqLedger();
    for (let i = 0; i < MAX_SESSION_CURSORS + 10; i++) ledger.ensure(`s${i}`);
    expect(ledger.snapshot()).toHaveLength(MAX_SESSION_CURSORS);
    expect(ledger.cursor("s0")).toBeUndefined();
  });
});

describe("planReplay", () => {
  const cursor = { seq: 5, epoch: "e1" };

  it("dispatches the contiguous window after the local watermark", () => {
    const answer: SessionEventsSinceAnswer = { events: events(6, 7, 8), latest_seq: 8, epoch: "e1" };
    const decision = planReplay({ cursor, processEpoch: "e1", answer });
    expect(decision.degrade).toBeNull();
    expect(decision.dispatch.map((e) => e.seq)).toEqual([6, 7, 8]);
  });

  it("drops events the local watermark already covered", () => {
    const answer: SessionEventsSinceAnswer = { events: events(4, 5, 6), latest_seq: 6, epoch: "e1" };
    const decision = planReplay({ cursor, processEpoch: "e1", answer });
    expect(decision.degrade).toBeNull();
    expect(decision.dispatch.map((e) => e.seq)).toEqual([6]);
  });

  it("degrades when the local cursor is ahead of the server head", () => {
    const answer: SessionEventsSinceAnswer = { events: [], latest_seq: 4, epoch: "e1", truncated: false };
    const decision = planReplay({ cursor, processEpoch: "e1", answer });
    expect(decision.degrade).toBe("cursor_ahead");
    expect(decision.dispatch).toEqual([]);
  });

  it("degrades when the epoch no longer matches (backend restarted)", () => {
    const answer: SessionEventsSinceAnswer = { events: events(6), latest_seq: 6, epoch: "e2" };
    const decision = planReplay({ cursor, processEpoch: "e1", answer });
    expect(decision.degrade).toBe("epoch_changed");
  });

  it("degrades when the replayed window has a hole in its seq", () => {
    const answer: SessionEventsSinceAnswer = { events: events(6, 8), latest_seq: 8, epoch: "e1" };
    const decision = planReplay({ cursor, processEpoch: "e1", answer });
    expect(decision.degrade).toBe("seq_gap");
  });

  it("degrades when the first replayed seq skips past the watermark", () => {
    const answer: SessionEventsSinceAnswer = { events: events(9), latest_seq: 9, epoch: "e1" };
    expect(planReplay({ cursor, processEpoch: "e1", answer }).degrade).toBe("seq_gap");
  });

  it("never trusts legacy truncated:false over a snapshot_required answer", () => {
    const answer: SessionEventsSinceAnswer = {
      events: events(6, 7),
      latest_seq: 7,
      epoch: "e1",
      snapshot_required: true,
      truncated: false,
    };
    expect(planReplay({ cursor, processEpoch: "e1", answer }).degrade).toBe("truncated");
  });

  it("treats a truncated window as a full-resume case", () => {
    const answer: SessionEventsSinceAnswer = { events: events(6), latest_seq: 90, truncated: true };
    const decision = planReplay({ cursor, processEpoch: "e1", answer });
    expect(decision.degrade).toBe("truncated");
    expect(decision.latestSeq).toBe(90);
  });

  it("has nothing to dispatch for a missing answer", () => {
    expect(planReplay({ cursor, processEpoch: "e1", answer: undefined }).degrade).toBeNull();
  });
});

describe("mergeReplayWindow", () => {
  it("orders by seq and keeps one copy of each seq", () => {
    const merged = mergeReplayWindow(events(6, 7, 8), events(8, 9, 7, 10));
    expect(merged.map((e) => e.seq)).toEqual([6, 7, 8, 9, 10]);
  });

  it("keeps seq-less frames in the merged window without reordering numbered ones", () => {
    const merged = mergeReplayWindow(
      events(6),
      [{ type: "sessions.changed", payload: {} } as never, ...events(7)],
    );
    expect(merged).toHaveLength(3);
    expect(merged.filter((e) => e.seq !== undefined).map((e) => e.seq)).toEqual([6, 7]);
  });
});
