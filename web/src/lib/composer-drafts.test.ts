import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composerDraftStorageKey,
  composerHistoryStorageKey,
  forgetComposerHistory,
  pushComposerHistory,
  readComposerDraft,
  readComposerHistory,
  recallComposerHistory,
  writeComposerDraft,
} from "./composer-drafts";
import { __resetUiStoreForTests } from "./ui-store";

function setRuntime(input: Partial<NonNullable<Window["__HERMES_RUNTIME__"]>> = {}) {
  (globalThis as any).window = (globalThis as any).window ?? {};
  window.__HERMES_RUNTIME__ = {
    connectionMode: "managed",
    apiBaseUrl: "http://127.0.0.1:9120",
    currentProfile: "default",
    ...input,
  };
}

beforeEach(() => {
  __resetUiStoreForTests();
  setRuntime();
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("composer draft storage", () => {
  it("keeps the new-task draft separate from session drafts", () => {
    writeComposerDraft({ kind: "new", profile: "default" }, "new task draft");
    writeComposerDraft({ kind: "session", sessionId: "s1", profile: "default" }, "session draft");

    expect(readComposerDraft({ kind: "new", profile: "default" })).toBe("new task draft");
    expect(readComposerDraft({ kind: "session", sessionId: "s1", profile: "default" })).toBe("session draft");
    expect(readComposerDraft({ kind: "session", sessionId: "s2", profile: "default" })).toBe("");
  });

  it("isolates drafts by profile and runtime target", () => {
    writeComposerDraft({ kind: "session", sessionId: "s1", profile: "default" }, "managed default");
    writeComposerDraft({ kind: "session", sessionId: "s1", profile: "work" }, "managed work");

    expect(readComposerDraft({ kind: "session", sessionId: "s1", profile: "default" })).toBe("managed default");
    expect(readComposerDraft({ kind: "session", sessionId: "s1", profile: "work" })).toBe("managed work");

    setRuntime({ connectionMode: "remote", apiBaseUrl: "https://remote.example/hermes" });
    expect(readComposerDraft({ kind: "session", sessionId: "s1", profile: "default" })).toBe("");
    writeComposerDraft({ kind: "session", sessionId: "s1", profile: "default" }, "remote default");
    expect(readComposerDraft({ kind: "session", sessionId: "s1", profile: "default" })).toBe("remote default");

    setRuntime();
    expect(readComposerDraft({ kind: "session", sessionId: "s1", profile: "default" })).toBe("managed default");
  });

  it("removes a draft when the text is blank", () => {
    const target = { kind: "new", profile: "default" } as const;
    writeComposerDraft(target, "  keep spacing  ");
    expect(readComposerDraft(target)).toBe("  keep spacing  ");

    writeComposerDraft(target, "   ");
    expect(readComposerDraft(target)).toBe("");
  });

  it("does not create a key for an empty session id", () => {
    expect(composerDraftStorageKey({ kind: "session", sessionId: "  ", profile: "default" })).toBeNull();
  });
});

describe("composer sent history", () => {
  const slot = "history-slot-a";

  afterEach(() => {
    forgetComposerHistory(slot);
    forgetComposerHistory("history-slot-b");
  });

  it("appends, de-duplicates and caps the list", () => {
    expect(composerHistoryStorageKey("")).toBeNull();
    expect(readComposerHistory(slot)).toEqual([]);

    pushComposerHistory(slot, "第一句");
    pushComposerHistory(slot, "第二句");
    pushComposerHistory(slot, "第一句");

    expect(readComposerHistory(slot)).toEqual(["第二句", "第一句"]);
    expect(pushComposerHistory(slot, "   ")).toEqual(["第二句", "第一句"]);
  });

  it("persists per draft slot and drops the oldest beyond the cap", () => {
    for (let index = 0; index < 40; index += 1) {
      pushComposerHistory(slot, `消息 ${index}`);
    }
    pushComposerHistory("history-slot-b", "另一个会话");

    const history = readComposerHistory(slot);
    expect(history).toHaveLength(30);
    expect(history[0]).toBe("消息 10");
    expect(history[29]).toBe("消息 39");
    expect(readComposerHistory("history-slot-b")).toEqual(["另一个会话"]);
  });
});

describe("recallComposerHistory", () => {
  const history = ["一", "二", "三"];

  it("walks back from the newest entry and stops at the oldest", () => {
    expect(recallComposerHistory({
      direction: "prev",
      history,
      index: -1,
      value: "",
      selectionStart: 0,
      selectionEnd: 0,
    })).toEqual({ text: "三", index: 2, caret: 0 });

    expect(recallComposerHistory({
      direction: "prev",
      history,
      index: 0,
      value: "一",
      selectionStart: 0,
      selectionEnd: 0,
    })).toBeNull();
  });

  it("ignores ArrowUp while a draft exists or the caret left the first line", () => {
    expect(recallComposerHistory({
      direction: "prev",
      history,
      index: -1,
      value: "草稿",
      selectionStart: 0,
      selectionEnd: 0,
    })).toBeNull();

    expect(recallComposerHistory({
      direction: "prev",
      history,
      index: -1,
      value: "",
      selectionStart: 0,
      selectionEnd: 3,
    })).toBeNull();

    expect(recallComposerHistory({
      direction: "prev",
      history,
      index: 1,
      value: "第一行\n第二行",
      selectionStart: 8,
      selectionEnd: 8,
    })).toBeNull();
  });

  it("returns to an empty input after the newest entry", () => {
    expect(recallComposerHistory({
      direction: "next",
      history,
      index: 2,
      value: "三",
      selectionStart: 1,
      selectionEnd: 1,
    })).toEqual({ text: "", index: -1, caret: 0 });

    expect(recallComposerHistory({
      direction: "next",
      history,
      index: 0,
      value: "一",
      selectionStart: 0,
      selectionEnd: 0,
    })).toEqual({ text: "二", index: 1, caret: 1 });

    expect(recallComposerHistory({
      direction: "next",
      history,
      index: -1,
      value: "",
      selectionStart: 0,
      selectionEnd: 0,
    })).toBeNull();
  });
});
