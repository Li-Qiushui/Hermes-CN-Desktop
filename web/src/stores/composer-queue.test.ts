import { describe, expect, it } from "vitest";
import type { ComposerAttachment } from "@/components/chat/composer-types";
import {
  MAX_QUEUED_PER_SESSION,
  deserializeQueue,
  enqueue,
  enqueueQueuedPrompt,
  entriesFor,
  entryHasVolatileAttachments,
  hasNonSerializableAttachments,
  isQueueFull,
  markEntryFailed,
  removeEntry,
  serializeQueue,
  shouldAutoDrainOnSettle,
  updateEntry,
  type QueueState,
  type QueuedPromptEntry,
} from "./composer-queue";

function entry(overrides: Partial<QueuedPromptEntry>): QueuedPromptEntry {
  return { id: "e1", text: "hi", attachments: [], queuedAt: 1, ...overrides };
}

describe("queue reducers", () => {
  it("enqueues per session and lists in order", () => {
    let state = {};
    state = enqueue(state, "s1", entry({ id: "a" }));
    state = enqueue(state, "s1", entry({ id: "b" }));
    state = enqueue(state, "s2", entry({ id: "c" }));
    expect(entriesFor(state, "s1").map((e) => e.id)).toEqual(["a", "b"]);
    expect(entriesFor(state, "s2").map((e) => e.id)).toEqual(["c"]);
    expect(entriesFor(state, "missing")).toEqual([]);
  });

  it("removes an entry and drops empty session keys", () => {
    let state = enqueue({}, "s1", entry({ id: "a" }));
    state = removeEntry(state, "s1", "a");
    expect(state).toEqual({});
  });

  it("updates an entry's text in place", () => {
    let state = enqueue({}, "s1", entry({ id: "a", text: "old" }));
    state = updateEntry(state, "s1", "a", { text: "new" });
    expect(entriesFor(state, "s1")[0]!.text).toBe("new");
  });
});

describe("shouldAutoDrainOnSettle", () => {
  it("fires only on a busy→idle transition with a non-empty queue", () => {
    expect(shouldAutoDrainOnSettle({ isBusy: false, wasBusy: true, queueLength: 1, userInterrupted: false })).toBe(true);
    expect(shouldAutoDrainOnSettle({ isBusy: true, wasBusy: true, queueLength: 1, userInterrupted: false })).toBe(false);
    expect(shouldAutoDrainOnSettle({ isBusy: false, wasBusy: false, queueLength: 1, userInterrupted: false })).toBe(false);
    expect(shouldAutoDrainOnSettle({ isBusy: false, wasBusy: true, queueLength: 0, userInterrupted: false })).toBe(false);
  });

  it("suppresses one drain after an explicit Stop", () => {
    expect(shouldAutoDrainOnSettle({ isBusy: false, wasBusy: true, queueLength: 2, userInterrupted: true })).toBe(false);
  });
});

describe("serialization", () => {
  it("round-trips path attachments and drops transient browser files", () => {
    const pathAttachment = { id: "p", source: "path", path: "/a/b.txt", name: "b.txt", kind: "file", status: "ready" } as ComposerAttachment;
    const browserAttachment = { id: "f", source: "browser", name: "x.png", kind: "image", status: "ready", file: {} as File, previewUrl: "blob:x" } as ComposerAttachment;
    const state = enqueue({}, "s1", entry({ attachments: [pathAttachment, browserAttachment] }));
    const restored = deserializeQueue(serializeQueue(state));
    expect(entriesFor(restored, "s1")[0]!.attachments).toEqual([
      { id: "p", source: "path", path: "/a/b.txt", name: "b.txt", kind: "file", status: "ready" },
    ]);
  });

  it("tolerates malformed JSON", () => {
    expect(deserializeQueue("not json")).toEqual({});
    expect(deserializeQueue(null)).toEqual({});
  });

  // Persisted state survives app reinstalls; a corrupt entry must never be
  // restored into app state, or it renders as "[object Object]" under the
  // composer and wedges send until the user wipes app data (issue #224).
  it("drops entries whose text is not a string", () => {
    const raw = JSON.stringify({
      s1: [
        { id: "bad", text: {}, attachments: [], queuedAt: 1 },
        { id: "ok", text: "hello", attachments: [], queuedAt: 2 },
      ],
    });
    const restored = deserializeQueue(raw);
    expect(entriesFor(restored, "s1").map((e) => e.id)).toEqual(["ok"]);
  });

  it("drops malformed entries, keys, and attachments without throwing", () => {
    const raw = JSON.stringify({
      s1: "not-an-array",
      s2: [
        null,
        { id: 5, text: "wrong id type", attachments: [], queuedAt: 1 },
        { id: "missing-fields" },
        {
          id: "good",
          text: "ok",
          queuedAt: 3,
          attachments: [null, "x", { source: "path", path: "/a", id: "p", name: "a", kind: "file", status: "ready" }],
        },
      ],
    });
    const restored = deserializeQueue(raw);
    expect(Object.keys(restored)).toEqual(["s2"]);
    const entries = entriesFor(restored, "s2");
    expect(entries.map((e) => e.id)).toEqual(["good"]);
    expect(entries[0]!.attachments.map((a) => a.id)).toEqual(["p"]);
  });

  it("returns {} when the top-level value is an array or primitive", () => {
    expect(deserializeQueue("[]")).toEqual({});
    expect(deserializeQueue("42")).toEqual({});
    expect(deserializeQueue('"str"')).toEqual({});
  });

  it("preserves already-uploaded attachments through serialization round-trip", () => {
    const uploadedAttachment = { id: "u1", source: "uploaded", uploadedPath: "/tmp/x.pdf", uploadedName: "x.pdf", name: "x.pdf", kind: "file", status: "done" } as ComposerAttachment;
    const state = enqueue({}, "s1", entry({ attachments: [uploadedAttachment] }));
    const restored = deserializeQueue(serializeQueue(state));
    expect(entriesFor(restored, "s1")[0]!.attachments).toHaveLength(1);
    expect(entriesFor(restored, "s1")[0]!.attachments[0]!.source).toBe("uploaded");
    expect(entriesFor(restored, "s1")[0]!.attachments[0]!.uploadedPath).toBe("/tmp/x.pdf");
  });

  it("strips browser attachments without uploadedPath during deserialization", () => {
    const browserAttachment = { id: "b1", source: "browser", name: "img.png", kind: "image", status: "ready", file: {} as File } as ComposerAttachment;
    const pathAttachment = { id: "p1", source: "path", path: "/a/b.txt", name: "b.txt", kind: "file", status: "ready" } as ComposerAttachment;
    const state = enqueue({}, "s1", entry({ attachments: [browserAttachment, pathAttachment] }));
    const restored = deserializeQueue(serializeQueue(state));
    // Browser attachments still dropped (no way to recover the File data),
    // but path attachments survive.
    expect(entriesFor(restored, "s1")[0]!.attachments).toHaveLength(1);
    expect(entriesFor(restored, "s1")[0]!.attachments[0]!.source).toBe("path");
  });
});

describe("hasNonSerializableAttachments", () => {
  it("returns false for empty state", () => {
    expect(hasNonSerializableAttachments({})).toBe(false);
  });

  it("returns false when all attachments are path or uploaded", () => {
    const state = enqueue({}, "s1", {
      id: "q1", text: "hi", attachments: [
        { source: "path", path: "/a/b.txt", name: "b.txt", kind: "file", status: "ready" } as ComposerAttachment,
        { source: "uploaded", uploadedPath: "/tmp/x.pdf", name: "x.pdf", kind: "file", status: "done" } as ComposerAttachment,
      ], queuedAt: 1,
    });
    expect(hasNonSerializableAttachments(state)).toBe(false);
  });

  it("returns true when any attachment is browser-sourced", () => {
    const state = enqueue({}, "s1", {
      id: "q1", text: "hi", attachments: [
        { source: "browser", name: "img.png", kind: "image", status: "ready" } as ComposerAttachment,
      ], queuedAt: 1,
    });
    expect(hasNonSerializableAttachments(state)).toBe(true);
  });

  it("returns false for null / malformed attachments (tolerated)", () => {
    // hasNonSerializableAttachments iterates safely and doesn't throw
    const state = { s1: [{ id: "q1", text: "hi", attachments: [null, undefined, "x" as any], queuedAt: 1 }] };
    expect(() => hasNonSerializableAttachments(state)).not.toThrow();
    expect(hasNonSerializableAttachments(state)).toBe(false);
  });
});

describe("lost attachment bookkeeping", () => {
  const browserAttachment = {
    id: "b1",
    source: "browser",
    name: "img.png",
    kind: "image",
    status: "ready",
  } as ComposerAttachment;

  it("counts what the restore dropped instead of dropping it silently", () => {
    const state = enqueue({}, "s1", entry({ text: "带图", attachments: [browserAttachment] }));

    const restored = deserializeQueue(serializeQueue(state));
    const queued = entriesFor(restored, "s1")[0]!;

    expect(queued.attachments).toHaveLength(0);
    expect(queued.lostAttachments).toBe(1);
    expect(entryHasVolatileAttachments(queued)).toBe(true);
  });

  it("keeps the marker across another restart without double counting", () => {
    const state = enqueue({}, "s1", entry({ text: "带图", attachments: [browserAttachment] }));

    const once = deserializeQueue(serializeQueue(state));
    const twice = deserializeQueue(serializeQueue(once));
    const queued = entriesFor(twice, "s1")[0]!;

    expect(queued.lostAttachments).toBe(1);
  });

  it("leaves path / uploaded attachments unmarked", () => {
    const state = enqueue({}, "s1", entry({
      attachments: [
        { source: "path", path: "/a/b.txt", name: "b.txt", kind: "file", status: "ready" } as ComposerAttachment,
      ],
    }));

    const queued = entriesFor(deserializeQueue(serializeQueue(state)), "s1")[0]!;

    expect(queued.attachments).toHaveLength(1);
    expect(queued.lostAttachments).toBeUndefined();
    expect(entryHasVolatileAttachments(queued)).toBe(false);
  });

  it("flags entries that still hold in-memory browser files", () => {
    expect(entryHasVolatileAttachments(entry({ attachments: [browserAttachment] }))).toBe(true);
    expect(entryHasVolatileAttachments(entry({}))).toBe(false);
  });
});

describe("per-session queue limits", () => {
  it("counts a session as full at MAX_QUEUED_PER_SESSION", () => {
    expect(MAX_QUEUED_PER_SESSION).toBe(8);
    let state: QueueState = {};
    for (let i = 0; i < MAX_QUEUED_PER_SESSION - 1; i += 1) {
      state = enqueue(state, "s1", entry({ id: `e${i}` }));
    }
    expect(isQueueFull(state, "s1")).toBe(false);
    state = enqueue(state, "s1", entry({ id: "last" }));
    expect(isQueueFull(state, "s1")).toBe(true);
    expect(isQueueFull(state, "s2")).toBe(false);
    expect(isQueueFull(state, null)).toBe(false);
  });

  it("refuses the ninth live enqueue instead of dropping the prompt silently", () => {
    const key = "limit-session";
    for (let i = 0; i < MAX_QUEUED_PER_SESSION; i += 1) {
      expect(enqueueQueuedPrompt(key, { text: `p${i}`, attachments: [] }, i)).not.toBeNull();
    }
    expect(enqueueQueuedPrompt(key, { text: "one too many", attachments: [] }, 99)).toBeNull();
    expect(enqueueQueuedPrompt("other-session", { text: "fine", attachments: [] }, 100)).not.toBeNull();
  });
});

describe("delivery failures stay visible", () => {
  it("keeps the entry and attaches the failure reason", () => {
    const state = enqueue({}, "s1", entry({ id: "a" }));
    const next = markEntryFailed(state, "s1", "a", "连接断开了");
    expect(entriesFor(next, "s1")).toHaveLength(1);
    expect(entriesFor(next, "s1")[0]!.error).toBe("连接断开了");
  });

  it("ignores unknown entries and sessions", () => {
    const state = enqueue({}, "s1", entry({ id: "a" }));
    expect(markEntryFailed(state, "s1", "gone", "x")).toBe(state);
    expect(markEntryFailed(state, "s2", "a", "x")).toBe(state);
  });

  it("does not persist the transient error across a reload", () => {
    const failed = markEntryFailed(enqueue({}, "s1", entry({ id: "a" })), "s1", "a", "boom");
    const restored = deserializeQueue(serializeQueue(failed));
    expect(entriesFor(restored, "s1")[0]!.error).toBeUndefined();
  });

  it("drops persisted entries whose error field is not a string", () => {
    const raw = JSON.stringify({
      s1: [
        { id: "bad", text: "x", attachments: [], queuedAt: 1, error: { nope: 1 } },
        { id: "ok", text: "y", attachments: [], queuedAt: 2, error: "kept" },
      ],
    });
    const entries = entriesFor(deserializeQueue(raw), "s1");
    expect(entries.map((e) => e.id)).toEqual(["ok"]);
    expect(entries[0]!.error).toBe("kept");
  });
});
