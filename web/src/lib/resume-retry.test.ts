import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RESUME_MAX_RETRIES,
  classifyResumeError,
  isRecoverableResumeError,
  resumeFailureMessage,
  resumeRetryDelayMs,
  resumeRetrySchedule,
  resumeWithRetry,
} from "./resume-retry";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("resume 退避序列", () => {
  it("1s / 2s / 4s / 8s，封顶 8s", () => {
    expect(resumeRetrySchedule()).toEqual([1000, 2000, 4000, 8000]);
    expect(RESUME_MAX_RETRIES).toBe(4);
    expect(resumeRetryDelayMs(0)).toBe(1000);
    expect(resumeRetryDelayMs(1)).toBe(2000);
    expect(resumeRetryDelayMs(2)).toBe(4000);
    expect(resumeRetryDelayMs(3)).toBe(8000);
    expect(resumeRetryDelayMs(9)).toBe(8000);
  });
});

describe("resumeWithRetry", () => {
  it("一路失败时按 1/2/4/8 退避，第 5 次后抛出原始错误", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockRejectedValue(new Error("gateway not ready"));
    const onRetry = vi.fn();

    await expect(resumeWithRetry(run, { sleep, onRetry })).rejects.toThrow("gateway not ready");

    expect(run).toHaveBeenCalledTimes(5);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000, 8000]);
    expect(onRetry.mock.calls.map(([info]) => info.delayMs)).toEqual([1000, 2000, 4000, 8000]);
  });

  it("中途恢复就停止重试并返回结果", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue("gw-1");

    await expect(resumeWithRetry(run, { sleep })).resolves.toBe("gw-1");

    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
  });

  it("认证失败不重试", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockRejectedValue(new Error("HTTP 401 unauthorized"));

    await expect(resumeWithRetry(run, { sleep })).rejects.toThrow("401");

    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("用假定时器验证真实等待时长累计 15s", async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockRejectedValue(new Error("websocket closed"));
    const pending = resumeWithRetry(run).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(run).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(8000);
    expect(run).toHaveBeenCalledTimes(5);

    const error = await pending;
    expect(error).toBeInstanceOf(Error);
  });
});

describe("resume 错误分类", () => {
  it("网络 / 网关未就绪算可恢复", () => {
    expect(classifyResumeError(new Error("WebSocket is not connected"))).toBe("recoverable");
    expect(classifyResumeError(new Error("HTTP 502 Bad Gateway"))).toBe("recoverable");
    expect(classifyResumeError("gateway not ready")).toBe("recoverable");
    expect(isRecoverableResumeError(new Error("ETIMEDOUT"))).toBe(true);
  });

  it("认证失败与找回不到的会话不重试", () => {
    expect(classifyResumeError(new Error("HTTP 401 unauthorized"))).toBe("auth");
    expect(classifyResumeError(new Error("invalid api key"))).toBe("auth");
    expect(classifyResumeError(new Error("HTTP 404 not found"))).toBe("not-found");
    expect(isRecoverableResumeError(new Error("forbidden"))).toBe(false);
  });

  it("失败文案区分三类原因", () => {
    expect(resumeFailureMessage(new Error("HTTP 403 forbidden"))).toContain("认证失败");
    expect(resumeFailureMessage(new Error("no such session"))).toContain("找不到了");
    expect(resumeFailureMessage(new Error("HTTP 503"))).toContain("重试 4 次");
  });
});
