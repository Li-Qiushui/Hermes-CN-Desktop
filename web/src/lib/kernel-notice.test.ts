import { describe, expect, it } from "vitest";

import {
  isKernelInjectedNotice,
  kernelNotice,
  kernelNoticeBody,
  kernelNoticeDelegationId,
  kernelNoticeKind,
} from "./kernel-notice";

const batchNotice = [
  "[ASYNC DELEGATION BATCH COMPLETE — deleg_9b163957]",
  "A background fan-out unit you dispatched earlier — 1 subagent(s) — has finished.",
  "",
  "Dispatched: 2026-10-23 13:47:50 (2m57s ago)",
  "Role: leaf   Model: deepseek-v4.1-flash   Total duration: 177.53s",
  "",
  "--- ✓ TASK 1/1: 审计改动  (status=completed, api_calls=27, 176.96s) ---",
  "结论：可以提交。",
].join("\n");

const singleNotice = [
  "[ASYNC DELEGATION COMPLETE — deleg_abc123]",
  "A background subagent you dispatched earlier has finished.",
  "--- RESULT ---",
  "done",
].join("\n");

const failedNotice = [
  "[ASYNC DELEGATION TASK FAILED — deleg_zz9, task 2/3]",
  "One subagent in a background fan-out you dispatched has failed.",
].join("\n");

describe("isKernelInjectedNotice", () => {
  it("recognizes the three kernel async-delegation notices", () => {
    expect(isKernelInjectedNotice(batchNotice)).toBe(true);
    expect(isKernelInjectedNotice(singleNotice)).toBe(true);
    expect(isKernelInjectedNotice(failedNotice)).toBe(true);
  });

  it("ignores genuine user prompts and lookalike prose", () => {
    expect(isKernelInjectedNotice("帮我看下这个 [ASYNC DELEGATION BATCH COMPLETE — x]")).toBe(false);
    expect(isKernelInjectedNotice("[ASYNC DELEGATION]")).toBe(false);
    expect(isKernelInjectedNotice("[OUT-OF-BAND USER MESSAGE — hi]")).toBe(false);
    expect(isKernelInjectedNotice("")).toBe(false);
    expect(isKernelInjectedNotice(undefined)).toBe(false);
    expect(isKernelInjectedNotice(null)).toBe(false);
  });
});

describe("kernelNotice", () => {
  it("classifies a batch report as a result notice and keeps the full body", () => {
    const notice = kernelNotice(batchNotice);
    expect(notice?.kind).toBe("async-delegation-result");
    expect(notice?.delegationId).toBe("deleg_9b163957");
    expect(notice?.title).toBe("子代理任务结果");
    expect(notice?.body.startsWith("A background fan-out unit")).toBe(true);
    expect(notice?.body).toContain("--- ✓ TASK 1/1");
    expect(notice?.body).toContain("结论：可以提交。");
    expect(notice?.body).not.toContain("[ASYNC DELEGATION");
  });

  it("classifies a per-task failure notice", () => {
    const notice = kernelNotice(failedNotice);
    expect(notice?.kind).toBe("async-delegation-failure");
    expect(notice?.delegationId).toBe("deleg_zz9");
    expect(notice?.title).toBe("子代理任务失败");
    expect(kernelNoticeKind(failedNotice)).toBe("async-delegation-failure");
  });

  it("returns null for non-notice text", () => {
    expect(kernelNotice("普通用户消息")).toBeNull();
  });
});

describe("kernelNotice helpers", () => {
  it("extracts the delegation id", () => {
    expect(kernelNoticeDelegationId(batchNotice)).toBe("deleg_9b163957");
    expect(kernelNoticeDelegationId("no id here")).toBeUndefined();
  });

  it("strips only the marker line and keeps everything after it", () => {
    const body = kernelNoticeBody("[ASYNC DELEGATION COMPLETE — deleg_1]\nline two\nline three");
    expect(body).toBe("line two\nline three");
  });

  it("handles a marker without a trailing newline", () => {
    expect(kernelNoticeBody("[ASYNC DELEGATION COMPLETE — deleg_1]")).toBe("");
  });
});
