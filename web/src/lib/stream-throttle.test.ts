/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTailThrottle } from "./stream-throttle";

const FRAME_MS = 16;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) =>
    setTimeout(callback, FRAME_MS) as unknown as number,
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createTailThrottle", () => {
  it("合并窗口内的高频调用，只渲染最后一个值", () => {
    const flush = vi.fn();
    const throttle = createTailThrottle<string>(flush, 60);

    throttle.push("a");
    vi.advanceTimersByTime(FRAME_MS);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenLastCalledWith("a");

    throttle.push("b");
    throttle.push("c");
    throttle.push("d");
    vi.advanceTimersByTime(300);

    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenLastCalledWith("d");
  });

  it("没有后续调用时尾随仍然执行", () => {
    const flush = vi.fn();
    const throttle = createTailThrottle<string>(flush, 60);

    throttle.push("tail");
    vi.advanceTimersByTime(500);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenLastCalledWith("tail");

    vi.advanceTimersByTime(500);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("相邻两次渲染至少间隔 intervalMs", () => {
    const flush = vi.fn();
    const throttle = createTailThrottle<string>(flush, 60);

    throttle.push("a");
    vi.advanceTimersByTime(FRAME_MS);
    expect(flush).toHaveBeenCalledTimes(1);

    throttle.push("b");
    vi.advanceTimersByTime(30);
    expect(flush).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenLastCalledWith("b");
  });

  it("cancel 之后不再执行", () => {
    const flush = vi.fn();
    const throttle = createTailThrottle<string>(flush, 60);

    throttle.push("x");
    throttle.cancel();
    vi.advanceTimersByTime(500);

    expect(flush).not.toHaveBeenCalled();
  });

  it("flushNow 立即生效且不重复执行", () => {
    const flush = vi.fn();
    const throttle = createTailThrottle<string>(flush, 60);

    throttle.push("x");
    throttle.flushNow();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenLastCalledWith("x");

    vi.advanceTimersByTime(500);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("没有待渲染内容时 flushNow 不触发渲染", () => {
    const flush = vi.fn();
    const throttle = createTailThrottle<string>(flush, 60);

    throttle.flushNow();
    expect(flush).not.toHaveBeenCalled();
  });
});
