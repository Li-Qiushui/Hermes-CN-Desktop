// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { RunClock } from "./run-clock";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_700_000_000_000));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RunClock", () => {
  it("从 current_run_started_at 每秒刷新", () => {
    render(<RunClock startedAt={1_699_999_995} />);
    expect(screen.getByText("00:05")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("00:06")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(screen.getByText("01:05")).toBeTruthy();
  });

  it("没有起点时不渲染", () => {
    const { container } = render(<RunClock startedAt={null} />);
    expect(container.textContent).toBe("");
  });

  it("卸载时清掉 1s timer", () => {
    const clearSpy = vi.spyOn(window, "clearInterval");
    const { unmount } = render(<RunClock startedAt={1_699_999_900} />);
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
